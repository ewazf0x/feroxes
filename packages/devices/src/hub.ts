import { type KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, sign, timingSafeEqual } from 'node:crypto';
import type { SystemControl } from '@feroxes/policy';
import {
  ACTIONS,
  type ActionName,
  type CommandPayload,
  type CoreToDevice,
  type DeviceInfo,
  type DeviceState,
  DeviceToCore,
  type Platform,
  VISIBLE_INPUT,
  deviceKind,
} from '@feroxes/protocol';
import { type Clock, FeroxesError, type Logger, MINUTE, noopLogger, systemClock, uuidv7 } from '@feroxes/shared';

/** Transport-neutral connection: a WebSocket in production, an in-memory pair in tests. */
export interface DeviceLink {
  send(frame: string): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (frame: string) => void): void;
  onClose(cb: () => void): void;
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: Platform;
  appVersion: string;
  capabilities: DeviceInfo['capabilities'];
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface DeviceRegistry {
  put(d: DeviceRecord): Promise<void>;
  list(): Promise<DeviceRecord[]>;
}

export class InMemoryDeviceRegistry implements DeviceRegistry {
  private readonly rows = new Map<string, DeviceRecord>();
  async put(d: DeviceRecord) {
    this.rows.set(d.id, structuredClone(d));
  }
  async list() {
    return [...this.rows.values()].map((d) => structuredClone(d));
  }
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: Platform;
  kind: 'desktop' | 'phone';
  capabilities: DeviceInfo['capabilities'];
  online: boolean;
  lastSeenAt?: number;
  state: DeviceState;
  ownerActive: boolean;
  localStopped: boolean;
}

export type DeviceEvent = { deviceId: string; deviceName: string; event: string; data: Record<string, unknown>; at: number };

export class DeviceError extends FeroxesError {
  constructor(code: string, message: string) {
    super(`device_${code}`, message);
    this.name = 'DeviceError';
  }
}

interface Connection {
  link: DeviceLink;
  record?: DeviceRecord;
  helloTimer?: NodeJS.Timeout;
  state: DeviceState;
  lastSeenAt: number;
  ownerActiveUntil: number;
  localStopped: boolean;
}

interface Pending {
  deviceId: string;
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const normalizeCode = (c: string) => c.toUpperCase().replace(/[^0-9A-Z]/g, '');

export interface DeviceHubOptions {
  registry: DeviceRegistry;
  system: SystemControl;
  clock?: Clock;
  logger?: Logger;
  /** PKCS#8 DER (base64) Ed25519 key. Persist it: devices pin the matching public key at pairing. */
  signingKeyPkcs8?: string;
  helloTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  ownerActiveMs?: number;
  commandTimeoutMs?: number;
}

/**
 * The Core side of device control (architecture §5.10, §10). Apps on the PC and phone dial in,
 * authenticate with a per-device token, and execute commands signed by the Core.
 */
export class DeviceHub {
  private readonly o: Required<Omit<DeviceHubOptions, 'signingKeyPkcs8'>>;
  private readonly key: KeyObject;
  private readonly records = new Map<string, DeviceRecord>();
  private readonly connections = new Map<string, Connection>(); // by device id (authenticated)
  private readonly pending = new Map<string, Pending>();
  private readonly codes = new Map<string, { expiresAt: number }>(); // sha256(code) → expiry
  private failedPairs: number[] = [];
  private readonly listeners = new Set<(e: DeviceEvent) => void>();

  constructor(options: DeviceHubOptions) {
    this.o = { clock: systemClock, logger: noopLogger, helloTimeoutMs: 5000, heartbeatTimeoutMs: 45_000, ownerActiveMs: 3000, commandTimeoutMs: 60_000, ...options };
    this.key = options.signingKeyPkcs8 ? createPrivateKey({ key: Buffer.from(options.signingKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' }) : generateKeyPairSync('ed25519').privateKey;
    options.system.onChange((c) => (c.state === 'stopped' ? this.haltAll(c.reason) : this.broadcast({ type: 'resume' })));
  }

  async init(): Promise<void> {
    for (const r of await this.o.registry.list()) this.records.set(r.id, r);
  }

  exportSigningKey(): string {
    return this.key.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  }

  /** Raw Ed25519 public key, base64url; devices verify command signatures with it. */
  publicKey(): string {
    return String((createPublicKey(this.key).export({ format: 'jwk' }) as { x: string }).x);
  }

  onEvent(cb: (e: DeviceEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Owner action (from an already-paired app): a one-time code the new device enters or scans. */
  createPairingCode(ttlMs = 10 * MINUTE): { code: string; expiresAt: number } {
    const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const expiresAt = this.o.clock.now() + ttlMs;
    this.codes.set(sha256(raw), { expiresAt });
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  attach(link: DeviceLink): void {
    const conn: Connection = { link, state: {}, lastSeenAt: this.o.clock.now(), ownerActiveUntil: 0, localStopped: false };
    conn.helloTimer = setTimeout(() => link.close(4001, 'hello timeout'), this.o.helloTimeoutMs);
    link.onMessage((frame) => void this.handle(conn, frame).catch((e) => this.o.logger.warn('device frame failed', { error: String(e) })));
    link.onClose(() => this.disconnected(conn));
  }

  devices(): DeviceSummary[] {
    return [...this.records.values()].filter((r) => !r.revokedAt).map((r) => this.summary(r));
  }

  online(kind?: 'desktop' | 'phone'): DeviceSummary[] {
    return this.devices().filter((d) => d.online && (!kind || d.kind === kind));
  }

  resolve(kind: 'desktop' | 'phone' | undefined, target?: string): DeviceSummary {
    const candidates = this.online(kind);
    if (target) {
      const t = target.toLowerCase();
      const found = candidates.find((d) => d.id === target || d.name.toLowerCase() === t) ?? candidates.find((d) => d.name.toLowerCase().includes(t));
      if (!found) throw new DeviceError('not_found', `No connected ${kind ?? 'device'} called "${target}". Connected: ${candidates.map((d) => d.name).join(', ') || 'none'}.`);
      return found;
    }
    if (candidates.length === 0) throw new DeviceError('offline', `No ${kind ?? 'device'} is connected right now. The Feroxes app must be running on it${kind === 'desktop' ? ' (and the PC awake)' : ''}.`);
    if (candidates.length > 1) throw new DeviceError('ambiguous', `Several ${kind}s are connected (${candidates.map((d) => d.name).join(', ')}); say which one.`);
    return candidates[0]!;
  }

  async execute(input: { kind?: 'desktop' | 'phone'; device?: string; action: ActionName; params: unknown; runId?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    if (this.o.system.stopped) throw new DeviceError('system_stopped', 'Feroxes is stopped.');
    const device = this.resolve(input.kind, input.device);
    const spec = ACTIONS[input.action];
    if (!device.capabilities.includes(spec.capability)) throw new DeviceError('unsupported', `${device.name} can't do ${input.action} (missing capability ${spec.capability}).`);
    if (device.localStopped) throw new DeviceError('locally_stopped', `The owner paused Feroxes on ${device.name}.`);
    if (VISIBLE_INPUT.has(input.action) && device.ownerActive) throw new DeviceError('owner_active', `The owner is using ${device.name} right now. Wait a few seconds, or use a background action (ui.act) that doesn't take over the mouse.`);
    const params = (spec.params as unknown as { parse(v: unknown): unknown }).parse(input.params);
    const conn = this.connections.get(device.id)!;
    const now = this.o.clock.now();
    const timeoutMs = input.timeoutMs ?? (input.action === 'kiro.run' || input.action === 'shell.run' ? Number((params as { timeoutMs?: number }).timeoutMs ?? 60_000) + 5000 : this.o.commandTimeoutMs);
    const payload: CommandPayload = { id: uuidv7(now), deviceId: device.id, action: input.action, params, issuedAt: now, expiresAt: now + Math.max(timeoutMs, 30_000), ...(input.runId ? { runId: input.runId } : {}) };
    const payloadText = JSON.stringify(payload);
    const sig = sign(null, Buffer.from(payloadText), this.key).toString('base64url');

    return new Promise<unknown>((resolve, reject) => {
      const finish = (e?: Error, data?: unknown) => {
        const p = this.pending.get(payload.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(payload.id);
        input.signal?.removeEventListener('abort', onAbort);
        if (e) reject(e);
        else resolve(data);
      };
      const onAbort = () => {
        this.send(conn, { type: 'cancel', id: payload.id });
        finish(new DeviceError('cancelled', 'Cancelled.'));
      };
      if (input.signal?.aborted) return reject(new DeviceError('cancelled', 'Cancelled.'));
      input.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        this.send(conn, { type: 'cancel', id: payload.id });
        finish(new DeviceError('timeout', `${device.name} didn't answer ${input.action} within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(payload.id, { deviceId: device.id, resolve: (d) => finish(undefined, d), reject: (e) => finish(e), timer });
      this.send(conn, { type: 'command', payload: payloadText, sig });
    });
  }

  async revoke(deviceId: string): Promise<void> {
    const r = this.records.get(deviceId);
    if (!r) return;
    r.revokedAt = this.o.clock.now();
    await this.o.registry.put(r);
    this.connections.get(deviceId)?.link.close(4003, 'revoked');
  }

  /** Called every ~15 s: devices that stopped sending heartbeats are treated as offline. */
  sweep(): number {
    let n = 0;
    for (const conn of this.connections.values()) {
      if (this.o.clock.now() - conn.lastSeenAt > this.o.heartbeatTimeoutMs) {
        conn.link.close(4002, 'heartbeat timeout');
        this.disconnected(conn);
        n++;
      }
    }
    return n;
  }

  // ---------------------------------------------------------------------------

  private async handle(conn: Connection, frame: string): Promise<void> {
    let msg: DeviceToCore;
    try {
      const parsed = DeviceToCore.safeParse(JSON.parse(frame));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid frame');
      msg = parsed.data;
    } catch (error) {
      this.send(conn, { type: 'error', code: 'bad_frame', message: String(error instanceof Error ? error.message : error) });
      if (!conn.record) conn.link.close(4000, 'bad frame');
      return;
    }
    conn.lastSeenAt = this.o.clock.now();

    if (!conn.record) {
      if (msg.type === 'pair') return this.pair(conn, msg.code, msg.device);
      if (msg.type === 'hello') return this.hello(conn, msg.deviceId, msg.token, msg.device);
      conn.link.close(4001, 'authenticate first');
      return;
    }

    const record = conn.record;
    switch (msg.type) {
      case 'result': {
        const p = this.pending.get(msg.id);
        if (!p || p.deviceId !== record.id) return; // late or foreign result: ignore
        if (msg.ok) p.resolve(msg.data);
        else p.reject(new DeviceError(msg.error?.code ?? 'failed', msg.error?.message ?? 'The device reported an error.'));
        return;
      }
      case 'heartbeat':
        conn.state = msg.state;
        return;
      case 'event': {
        if (msg.event === 'owner_activity') conn.ownerActiveUntil = this.o.clock.now() + this.o.ownerActiveMs;
        if (msg.event === 'local_stop') {
          conn.localStopped = true;
          this.rejectPending(record.id, new DeviceError('locally_stopped', `The owner paused Feroxes on ${record.name}.`));
        }
        if (msg.event === 'local_resume') conn.localStopped = false;
        if (msg.event === 'screen_locked') conn.state = { ...conn.state, locked: true };
        if (msg.event === 'screen_unlocked') conn.state = { ...conn.state, locked: false };
        const e: DeviceEvent = { deviceId: record.id, deviceName: record.name, event: msg.event, data: msg.data, at: this.o.clock.now() };
        for (const l of this.listeners) l(e);
        return;
      }
      default:
        this.send(conn, { type: 'error', code: 'unexpected', message: `unexpected ${msg.type}` });
    }
  }

  private async pair(conn: Connection, code: string, info: DeviceInfo) {
    const now = this.o.clock.now();
    this.failedPairs = this.failedPairs.filter((t) => t > now - MINUTE);
    if (this.failedPairs.length >= 5) {
      this.send(conn, { type: 'error', code: 'rate_limited', message: 'Too many wrong codes. Wait a minute.' });
      conn.link.close(4029, 'rate limited');
      return;
    }
    const key = sha256(normalizeCode(code));
    const entry = this.codes.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.failedPairs.push(now);
      this.send(conn, { type: 'error', code: 'bad_code', message: 'That pairing code is wrong or expired.' });
      conn.link.close(4003, 'bad code');
      return;
    }
    this.codes.delete(key); // single use
    const token = randomBytes(32).toString('base64url');
    const record: DeviceRecord = { id: uuidv7(now), name: info.name, platform: info.platform, appVersion: info.appVersion, capabilities: info.capabilities, tokenHash: sha256(token), createdAt: now, lastSeenAt: now };
    this.records.set(record.id, record);
    await this.o.registry.put(record);
    this.send(conn, { type: 'paired', deviceId: record.id, token, coreKey: this.publicKey() });
    this.authenticated(conn, record);
  }

  private async hello(conn: Connection, deviceId: string, token: string, info: DeviceInfo) {
    const record = this.records.get(deviceId);
    const given = Buffer.from(sha256(token), 'hex');
    const ok = record && !record.revokedAt && timingSafeEqual(given, Buffer.from(record.tokenHash, 'hex'));
    if (!ok || !record) {
      this.send(conn, { type: 'error', code: 'unauthorized', message: 'Unknown device or wrong token. Pair again.' });
      conn.link.close(4003, 'unauthorized');
      return;
    }
    Object.assign(record, { name: info.name, appVersion: info.appVersion, capabilities: info.capabilities, platform: info.platform, lastSeenAt: this.o.clock.now() });
    await this.o.registry.put(record);
    this.authenticated(conn, record);
  }

  private authenticated(conn: Connection, record: DeviceRecord) {
    clearTimeout(conn.helloTimer);
    const previous = this.connections.get(record.id);
    if (previous && previous !== conn) previous.link.close(4004, 'replaced by a new connection');
    conn.record = record;
    this.connections.set(record.id, conn);
    this.send(conn, { type: 'welcome', deviceId: record.id, serverTime: this.o.clock.now(), coreKey: this.publicKey(), stopped: this.o.system.stopped });
    this.emit(record, 'connected', {});
  }

  private disconnected(conn: Connection) {
    clearTimeout(conn.helloTimer);
    const record = conn.record;
    if (!record || this.connections.get(record.id) !== conn) return;
    this.connections.delete(record.id);
    record.lastSeenAt = conn.lastSeenAt;
    void this.o.registry.put(record);
    this.rejectPending(record.id, new DeviceError('disconnected', `${record.name} disconnected.`));
    this.emit(record, 'disconnected', {});
  }

  private haltAll(reason: string) {
    for (const p of [...this.pending.values()]) p.reject(new DeviceError('system_stopped', 'Feroxes was stopped.'));
    this.broadcast({ type: 'halt', reason });
  }

  private rejectPending(deviceId: string, e: Error) {
    for (const p of [...this.pending.values()]) if (p.deviceId === deviceId) p.reject(e);
  }

  private broadcast(frame: CoreToDevice) {
    for (const conn of this.connections.values()) this.send(conn, frame);
  }

  private send(conn: Connection, frame: CoreToDevice) {
    try {
      conn.link.send(JSON.stringify(frame));
    } catch (error) {
      this.o.logger.warn('device send failed', { error: String(error) });
    }
  }

  private emit(record: DeviceRecord, event: string, data: Record<string, unknown>) {
    const e: DeviceEvent = { deviceId: record.id, deviceName: record.name, event, data, at: this.o.clock.now() };
    for (const l of this.listeners) l(e);
  }

  private summary(r: DeviceRecord): DeviceSummary {
    const conn = this.connections.get(r.id);
    return {
      id: r.id,
      name: r.name,
      platform: r.platform,
      kind: deviceKind(r.platform),
      capabilities: r.capabilities,
      online: !!conn,
      ...(r.lastSeenAt !== undefined ? { lastSeenAt: conn?.lastSeenAt ?? r.lastSeenAt } : {}),
      state: conn?.state ?? {},
      ownerActive: !!conn && conn.ownerActiveUntil > this.o.clock.now(),
      localStopped: conn?.localStopped ?? false,
    };
  }
}

/** Adapts a WebSocket (the `ws` package or the WHATWG API) to a DeviceLink. */
export function fromWebSocket(ws: { send(d: string): void; close(code?: number, reason?: string): void; addEventListener(type: 'message' | 'close', cb: (e: { data?: unknown }) => void): void }): DeviceLink {
  return {
    send: (f) => ws.send(f),
    close: (c, r) => ws.close(c, r),
    onMessage: (cb) => ws.addEventListener('message', (e) => cb(String(e.data))),
    onClose: (cb) => ws.addEventListener('close', () => cb()),
  };
}
