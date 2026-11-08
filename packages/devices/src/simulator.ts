import { createPublicKey, verify } from 'node:crypto';
import { type CommandPayload, CoreToDevice, type DeviceInfo, type DeviceState, PROTOCOL_VERSION } from '@feroxes/protocol';
import type { DeviceHub, DeviceLink } from './hub.ts';

/** Two connected in-memory links (core side, device side), asynchronous like a socket. */
export function linkPair(): { core: DeviceLink; device: DeviceLink } {
  const handlers = { core: [] as ((f: string) => void)[], device: [] as ((f: string) => void)[] };
  const closers = { core: [] as (() => void)[], device: [] as (() => void)[] };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    queueMicrotask(() => [...closers.core, ...closers.device].forEach((c) => c()));
  };
  const make = (self: 'core' | 'device', other: 'core' | 'device'): DeviceLink => ({
    send: (f) => {
      if (!closed) queueMicrotask(() => handlers[other].forEach((h) => h(f)));
    },
    close,
    onMessage: (cb) => handlers[self].push(cb),
    onClose: (cb) => closers[self].push(cb),
  });
  return { core: make('core', 'device'), device: make('device', 'core') };
}

export type CommandHandler = (action: string, params: Record<string, unknown>, cmd: CommandPayload) => unknown | Promise<unknown>;

/**
 * A fake Feroxes app that speaks the real device protocol, including signature checks.
 * The Rust and Kotlin apps must behave the same way; tests and the demo use this one.
 */
export class SimulatedDevice {
  readonly info: DeviceInfo;
  deviceId?: string;
  token?: string;
  coreKey?: string;
  halted = false;
  readonly executed: CommandPayload[] = [];
  readonly rejected: string[] = [];
  private link?: DeviceLink;
  private readonly seen = new Set<string>();
  private handler: CommandHandler;
  private ready?: { resolve: () => void; reject: (e: Error) => void };

  constructor(info: DeviceInfo, handler: CommandHandler) {
    this.info = info;
    this.handler = handler;
  }

  setHandler(h: CommandHandler) {
    this.handler = h;
  }

  /** Pairs with a one-time code, or reconnects with the stored token. */
  connect(hub: DeviceHub, opts: { code?: string } = {}): Promise<void> {
    const { core, device } = linkPair();
    this.link = device;
    const done = new Promise<void>((resolve, reject) => (this.ready = { resolve, reject }));
    device.onMessage((f) => void this.onFrame(f));
    hub.attach(core);
    if (opts.code) device.send(JSON.stringify({ type: 'pair', v: PROTOCOL_VERSION, code: opts.code, device: this.info }));
    else device.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, deviceId: this.deviceId, token: this.token, device: this.info }));
    return done;
  }

  disconnect() {
    this.link?.close();
  }

  heartbeat(state: DeviceState) {
    this.link?.send(JSON.stringify({ type: 'heartbeat', state }));
  }

  event(event: 'owner_activity' | 'local_stop' | 'local_resume' | 'notification' | 'foreground_changed' | 'screen_locked' | 'screen_unlocked', data: Record<string, unknown> = {}) {
    this.link?.send(JSON.stringify({ type: 'event', event, data }));
  }

  /** Sends a raw frame, e.g. a forged command result, for security tests. */
  raw(frame: unknown) {
    this.link?.send(JSON.stringify(frame));
  }

  private async onFrame(frame: string) {
    const msg = CoreToDevice.parse(JSON.parse(frame));
    switch (msg.type) {
      case 'paired':
        this.deviceId = msg.deviceId;
        this.token = msg.token;
        this.coreKey = msg.coreKey;
        return;
      case 'welcome':
        if (this.coreKey && this.coreKey !== msg.coreKey) return this.ready?.reject(new Error('core key changed: refusing'));
        this.coreKey = msg.coreKey;
        this.halted = msg.stopped;
        return this.ready?.resolve();
      case 'error':
        return this.ready?.reject(new Error(`${msg.code}: ${msg.message}`));
      case 'halt':
        this.halted = true;
        return;
      case 'resume':
        this.halted = false;
        return;
      case 'cancel':
        return;
      case 'command':
        return this.onCommand(msg.payload, msg.sig);
    }
  }

  private async onCommand(payloadText: string, sig: string) {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: this.coreKey! }, format: 'jwk' });
    const cmd = JSON.parse(payloadText) as CommandPayload;
    const reply = (body: Record<string, unknown>) => this.link?.send(JSON.stringify({ type: 'result', id: cmd.id, ...body }));
    if (!verify(null, Buffer.from(payloadText), key, Buffer.from(sig, 'base64url'))) {
      this.rejected.push('bad signature');
      return reply({ ok: false, error: { code: 'bad_signature', message: 'signature check failed' } });
    }
    if (cmd.deviceId !== this.deviceId || cmd.expiresAt < Date.now() - 60_000 || this.seen.has(cmd.id)) {
      this.rejected.push('stale or foreign');
      return reply({ ok: false, error: { code: 'rejected', message: 'stale, replayed or for another device' } });
    }
    if (this.halted) return reply({ ok: false, error: { code: 'halted', message: 'Feroxes is stopped on this device' } });
    this.seen.add(cmd.id);
    this.executed.push(cmd);
    try {
      reply({ ok: true, data: await this.handler(cmd.action, (cmd.params ?? {}) as Record<string, unknown>, cmd) });
    } catch (error) {
      reply({ ok: false, error: { code: 'failed', message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

/** A tiny fake desktop: a notepad window whose text the agent can read and change. */
export function fakeDesktop(name = 'Studio PC') {
  const state = { text: '', clicks: [] as { x: number; y: number }[] };
  const device = new SimulatedDevice(
    { name, platform: 'windows', appVersion: '0.1.0-sim', capabilities: ['screen.capture', 'ui.tree', 'ui.act', 'input.pointer', 'input.keyboard', 'apps.list', 'apps.launch', 'windows.list', 'system.status', 'kiro.cli', 'shell'] },
    (action, params) => {
      switch (action) {
        case 'ui.tree':
          return { text: `window "Notepad" [w1]\n  edit "Text editor" [e1] value="${state.text}"\n  button "Save" [b1]`, nodes: 3 };
        case 'ui.act':
          if (params.elementId === 'e1' && params.action === 'set_value') state.text = String(params.value ?? '');
          return { ok: true, elementId: params.elementId, action: params.action };
        case 'input.click':
          state.clicks.push({ x: Number(params.x), y: Number(params.y) });
          return { ok: true };
        case 'screen.capture':
          return { mime: 'image/png', dataBase64: 'iVBORw0KGgo=', width: 1280, height: 720 };
        case 'system.status':
          return { cpuPercent: 12, memoryPercent: 41, diskFreeGb: 85, battery: null, network: 'ethernet' };
        case 'apps.launch':
          return { launched: params.app };
        case 'kiro.run':
          return { exitCode: 0, output: `Kiro CLI finished: ${String(params.task).slice(0, 60)}` };
        default:
          return { ok: true };
      }
    },
  );
  return { device, state };
}
