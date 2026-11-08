import { type KeyObject, createPublicKey, verify } from 'node:crypto';
import { ACTIONS, type ActionName, type Capability, CommandPayload, CoreToDevice, type DeviceInfo, type DeviceState, type DeviceToCore, PROTOCOL_VERSION } from '@feroxes/protocol';

/**
 * The device side of protocol v1. Pairs with a one-time code (or reconnects with its token), pins
 * the Core's Ed25519 key, and executes only commands that (1) verify against the pinned key over
 * the exact payload bytes, (2) are addressed to this device, (3) haven't expired, (4) were never
 * seen before, (5) arrive while neither Feroxes nor the owner has stopped this device, and
 * (6) name an action this device advertises with valid parameters.
 */
export interface Credentials {
  deviceId: string;
  token: string;
  coreKey: string;
  coreUrl: string;
}

export interface CredentialStore {
  load(): Promise<Credentials | undefined>;
  save(c: Credentials): Promise<void>;
  clear(): Promise<void>;
}

export interface Executor {
  capabilities(): Capability[];
  run(action: ActionName, params: unknown, signal: AbortSignal): Promise<unknown>;
}

export interface AgentOptions {
  coreUrl: string;
  info: Omit<DeviceInfo, 'capabilities'>;
  executor: Executor;
  credentials: CredentialStore;
  state?: () => Promise<DeviceState>;
  /** Seconds since the owner last used mouse/keyboard; drives the owner-activity pause. */
  idleSeconds?: () => number | undefined;
  heartbeatMs?: number;
  activityPollMs?: number;
  /** Polled every second; true while the owner has paused Feroxes on this device. */
  pausedFlag?: () => boolean;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  WebSocketImpl?: typeof WebSocket;
}

export type AgentStatus = 'idle' | 'pairing' | 'connecting' | 'online' | 'offline' | 'refused';

class RefusedError extends Error {}

const err = (code: string, message: string) => ({ ok: false as const, error: { code: code.slice(0, 60), message: message.slice(0, 2000) } });

export class DeviceAgent {
  status: AgentStatus = 'idle';
  halted = false;
  paused = false;
  lastError?: string;
  private readonly o: Required<Omit<AgentOptions, 'state' | 'idleSeconds' | 'pausedFlag' | 'WebSocketImpl'>> & Pick<AgentOptions, 'state' | 'idleSeconds' | 'pausedFlag' | 'WebSocketImpl'>;
  private ws?: WebSocket;
  private creds?: Credentials;
  private pairCode?: string;
  private coreKey?: KeyObject;
  private skewMs = 0;
  private readonly seen = new Map<string, number>(); // command id -> expiresAt
  private readonly running = new Map<string, AbortController>();
  private timers: NodeJS.Timeout[] = [];
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private backoffMs = 1000;
  private lastActivitySent = 0;
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private frameChain: Promise<void> = Promise.resolve();

  constructor(options: AgentOptions) {
    this.o = { heartbeatMs: 15_000, activityPollMs: 1000, log: () => {}, ...options };
  }

  /** Connects (pairing first if a code is given and no credentials exist); resolves once online. */
  async start(opts: { pairCode?: string } = {}): Promise<void> {
    this.stopped = false;
    this.creds = await this.o.credentials.load();
    if (this.creds && this.creds.coreUrl !== this.o.coreUrl) this.o.log('warn', `Saved pairing is for ${this.creds.coreUrl}; connecting to ${this.o.coreUrl} with it anyway.`);
    if (!this.creds) {
      if (!opts.pairCode) {
        this.status = 'refused';
        throw new RefusedError('This PC is not paired yet. Create a pairing code in Feroxes (Devices → Pair a device) and run: feroxes-agent pair <code>');
      }
      this.pairCode = opts.pairCode;
    }
    const ready = this.ready();
    this.connect();
    return ready;
  }

  ready(): Promise<void> {
    if (this.status === 'online') return Promise.resolve();
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  /** The owner pauses Feroxes on this device: in-flight work stops, new commands are refused. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    for (const c of this.running.values()) c.abort();
    this.send({ type: 'event', event: 'local_stop', data: {} });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.send({ type: 'event', event: 'local_resume', data: {} });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.clearTimers();
    for (const c of this.running.values()) c.abort();
    this.ws?.close(1000, 'agent stopped');
  }

  /** Sends an event (e.g. 'notification', 'foreground_changed') if online. */
  event(event: Extract<DeviceToCore, { type: 'event' }>['event'], data: Record<string, unknown> = {}): void {
    this.send({ type: 'event', event, data });
  }

  private connect() {
    if (this.stopped) return;
    const Impl = this.o.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.o.coreUrl);
    this.ws = ws;
    this.status = this.creds ? 'connecting' : 'pairing';
    ws.addEventListener('open', () => {
      const device: DeviceInfo = { ...this.o.info, capabilities: this.o.executor.capabilities() };
      const first: DeviceToCore = this.creds
        ? { type: 'hello', v: PROTOCOL_VERSION, deviceId: this.creds.deviceId, token: this.creds.token, device }
        : { type: 'pair', v: PROTOCOL_VERSION, code: this.pairCode!, device };
      ws.send(JSON.stringify(first));
    });
    // Control frames (paired, welcome, halt, cancel) are handled in order; commands run concurrently
    // once verified, so a long shell command never blocks a cancel or a halt.
    ws.addEventListener('message', (e) => {
      const raw = String(e.data);
      this.frameChain = this.frameChain.then(() => this.onFrame(raw)).catch((error) => this.o.log('error', `frame handling failed: ${String(error)}`));
    });
    ws.addEventListener('close', (e) => this.onClose(ws, e.code, e.reason));
    ws.addEventListener('error', () => {}); // a 'close' event always follows
  }

  private send(frame: DeviceToCore) {
    if (this.status !== 'online' || this.ws?.readyState !== 1) return;
    this.ws.send(JSON.stringify(frame));
  }

  private async onFrame(raw: string) {
    let msg: CoreToDevice;
    try {
      msg = CoreToDevice.parse(JSON.parse(raw));
    } catch {
      return this.o.log('warn', 'ignored a malformed frame from the Core');
    }
    switch (msg.type) {
      case 'paired': {
        const creds: Credentials = { deviceId: msg.deviceId, token: msg.token, coreKey: msg.coreKey, coreUrl: this.o.coreUrl };
        this.creds = creds; // before the (async) save, so a command right after pairing is accepted
        this.pairCode = undefined;
        await this.o.credentials.save(creds);
        this.o.log('info', 'Paired with Feroxes.');
        return;
      }
      case 'welcome': {
        if (this.creds && msg.coreKey !== this.creds.coreKey) return this.refuse("The Core's signing key changed, so this may not be your Feroxes. Not connecting. If you reinstalled Feroxes on purpose, run `feroxes-agent forget` and pair again.");
        this.coreKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: msg.coreKey }, format: 'jwk' });
        this.skewMs = msg.serverTime - Date.now();
        this.halted = msg.stopped;
        this.status = 'online';
        this.backoffMs = 1000;
        this.lastError = undefined;
        this.startTimers();
        if (this.paused) this.send({ type: 'event', event: 'local_stop', data: {} }); // local pause isn't kept by the Core across connections
        void this.heartbeat();
        for (const w of this.readyWaiters.splice(0)) w.resolve();
        this.o.log('info', `Connected to Feroxes${msg.stopped ? ' (Feroxes is stopped)' : ''}.`);
        return;
      }
      case 'command':
        void this.onCommand(msg.payload, msg.sig);
        return;
      case 'cancel':
        this.running.get(msg.id)?.abort();
        return;
      case 'halt':
        this.halted = true;
        for (const c of this.running.values()) c.abort();
        this.o.log('warn', `Feroxes was stopped: ${msg.reason}`);
        return;
      case 'resume':
        this.halted = false;
        return;
      case 'error':
        if (msg.code === 'unauthorized') {
          await this.o.credentials.clear();
          this.creds = undefined;
          return this.refuse('Feroxes no longer knows this device (it was removed, or the token is wrong). Pair again.');
        }
        if (msg.code === 'bad_code') return this.refuse('That pairing code is wrong or expired. Create a new one in Feroxes.');
        this.o.log('warn', `Core error ${msg.code}: ${msg.message}`);
        return;
    }
  }

  private async onCommand(payloadText: string, sig: string) {
    const reply = (id: string, body: { ok: true; data?: unknown } | ReturnType<typeof err>) => this.send({ type: 'result', id, ...body } as DeviceToCore);
    let cmd: CommandPayload | undefined;
    try {
      cmd = CommandPayload.parse(JSON.parse(payloadText));
    } catch {
      return this.o.log('warn', 'ignored an unreadable command');
    }
    // Verify over the exact bytes received, before trusting anything inside them.
    let valid = false;
    try {
      valid = !!this.coreKey && verify(null, Buffer.from(payloadText, 'utf8'), this.coreKey, Buffer.from(sig, 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) {
      this.o.log('warn', `rejected a command with a bad signature (${cmd.action})`);
      return reply(cmd.id, err('bad_signature', 'Signature check failed; the command was not executed.'));
    }
    const now = Date.now() + this.skewMs;
    for (const [id, exp] of this.seen) if (exp < now - 120_000) this.seen.delete(id);
    if (cmd.deviceId !== this.creds?.deviceId) return reply(cmd.id, err('rejected', 'The command is addressed to another device.'));
    if (cmd.expiresAt < now - 5000) return reply(cmd.id, err('rejected', 'The command expired before it arrived.'));
    if (this.seen.has(cmd.id)) return reply(cmd.id, err('rejected', 'Replayed command ignored.'));
    this.seen.set(cmd.id, cmd.expiresAt);
    if (this.halted) return reply(cmd.id, err('halted', 'Feroxes is stopped on this device.'));
    if (this.paused) return reply(cmd.id, err('locally_stopped', 'The owner paused Feroxes on this device.'));
    if (!Object.hasOwn(ACTIONS, cmd.action)) return reply(cmd.id, err('unsupported', `Unknown action ${cmd.action}.`));
    const action = cmd.action as ActionName;
    const spec = ACTIONS[action];
    if (!this.o.executor.capabilities().includes(spec.capability)) return reply(cmd.id, err('unsupported', `This device can't do ${action}.`));
    const parsed = (spec.params as unknown as { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } }).safeParse(cmd.params);
    if (!parsed.success) return reply(cmd.id, err('bad_params', parsed.error?.issues[0]?.message ?? 'invalid parameters'));

    const ctrl = new AbortController();
    this.running.set(cmd.id, ctrl);
    try {
      const data = await this.o.executor.run(action, parsed.data, ctrl.signal);
      if (ctrl.signal.aborted) return reply(cmd.id, err('cancelled', 'Cancelled.'));
      reply(cmd.id, { ok: true, data });
    } catch (error) {
      const code = ctrl.signal.aborted ? 'cancelled' : typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'failed';
      reply(cmd.id, err(code, error instanceof Error ? error.message : String(error)));
    } finally {
      this.running.delete(cmd.id);
    }
  }

  private startTimers() {
    this.clearTimers();
    this.timers.push(setInterval(() => void this.heartbeat(), this.o.heartbeatMs));
    this.timers.push(
      setInterval(() => {
        const flag = this.o.pausedFlag?.();
        if (flag === true) this.pause();
        else if (flag === false) this.resume();
        const idle = this.o.idleSeconds?.();
        const now = Date.now();
        if (idle !== undefined && idle < 2 && now - this.lastActivitySent >= 1500) {
          this.lastActivitySent = now;
          this.send({ type: 'event', event: 'owner_activity', data: {} });
        }
      }, this.o.activityPollMs),
    );
    for (const t of this.timers) t.unref?.();
  }

  private clearTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async heartbeat() {
    if (this.status !== 'online') return;
    try {
      const state = (await this.o.state?.()) ?? {};
      this.send({ type: 'heartbeat', state });
    } catch (error) {
      this.o.log('warn', `heartbeat failed: ${String(error)}`);
    }
  }

  private refuse(message: string) {
    this.status = 'refused';
    this.lastError = message;
    this.stopped = true;
    this.o.log('error', message);
    for (const w of this.readyWaiters.splice(0)) w.reject(new RefusedError(message));
    this.ws?.close(1000, 'refused');
  }

  private onClose(ws: WebSocket, code: number, reason: string) {
    if (ws !== this.ws) return;
    this.clearTimers();
    for (const c of this.running.values()) c.abort();
    if (this.status === 'refused' || this.stopped) {
      if (this.status !== 'refused') this.status = 'offline';
      return;
    }
    // 4003 = bad code / unauthorized / revoked: retrying would only repeat the refusal.
    if (code === 4003) return this.refuse(reason === 'revoked' ? 'This device was removed in Feroxes. Pair again to reconnect.' : `Feroxes refused this device (${reason || 'unauthorized'}).`);
    this.status = 'offline';
    const delay = Math.min(30_000, this.backoffMs) * (0.8 + Math.random() * 0.4);
    this.backoffMs = Math.min(30_000, this.backoffMs * 2);
    this.o.log('warn', `Disconnected from Feroxes (${code}${reason ? ` ${reason}` : ''}); retrying in ${Math.round(delay / 1000)} s.`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
