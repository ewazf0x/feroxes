import assert from 'node:assert/strict';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import { connect } from 'node:net';
import { test } from 'node:test';
import { InMemorySystemStateStore, SystemControl } from '@feroxes/policy';
import { PROTOCOL_VERSION } from '@feroxes/protocol';
import { DeviceHub, InMemoryDeviceRegistry } from './hub.ts';
import { acceptWebSocket } from './ws.ts';

const INFO = { name: 'Real PC', platform: 'linux', appVersion: '0.1.0-test', capabilities: ['ui.tree', 'system.status'] };

async function setup() {
  const system = new SystemControl({ store: new InMemorySystemStateStore() });
  await system.init();
  const hub = new DeviceHub({ registry: new InMemoryDeviceRegistry(), system });
  await hub.init();
  const server: Server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const link = acceptWebSocket(req, socket, head, { maxPayload: 64 * 1024, pingIntervalMs: 200 });
    if (link) hub.attach(link);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/devices`;
  return { hub, system, server, url, port: (server.address() as { port: number }).port };
}

/** A real WebSocket device (Node's built-in client) that verifies and answers signed commands. */
async function realDevice(url: string, first: Record<string, unknown>) {
  const ws = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  let coreKey = '';
  const welcome = new Promise<Record<string, unknown>>((resolve, reject) => {
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      frames.push(msg);
      if (msg.type === 'paired') coreKey = msg.coreKey;
      if (msg.type === 'welcome') {
        coreKey ||= msg.coreKey;
        resolve(msg);
      }
      if (msg.type === 'error') reject(new Error(msg.code));
      if (msg.type === 'command') {
        const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: coreKey || msg.coreKey }, format: 'jwk' });
        const ok = verify(null, Buffer.from(msg.payload), key, Buffer.from(msg.sig, 'base64url'));
        const cmd = JSON.parse(msg.payload);
        ws.send(JSON.stringify(ok ? { type: 'result', id: cmd.id, ok: true, data: { text: `tree for ${cmd.action} (${cmd.params.maxNodes})` } } : { type: 'result', id: cmd.id, ok: false, error: { code: 'bad_signature', message: 'x' } }));
      }
    });
    ws.addEventListener('error', () => reject(new Error('socket error')));
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify(first));
  return { ws, frames, welcome: await welcome, coreKey: () => coreKey };
}

test('a real WebSocket device pairs, reconnects with its token and runs a signed command', async () => {
  const { hub, server, url } = await setup();
  try {
    const d = await realDevice(url, { type: 'pair', v: PROTOCOL_VERSION, code: hub.createPairingCode().code, device: INFO });
    const paired = d.frames.find((f) => f.type === 'paired') as { deviceId: string; token: string };
    assert.ok(paired.deviceId && paired.token);
    assert.equal(hub.online('desktop').length, 1);
    const data = (await hub.execute({ kind: 'desktop', action: 'ui.tree', params: {} })) as { text: string };
    assert.equal(data.text, 'tree for ui.tree (400)');
    d.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hub.online().length, 0, 'closing the socket marks the device offline');
    const again = await realDevice(url, { type: 'hello', v: PROTOCOL_VERSION, deviceId: paired.deviceId, token: paired.token, device: INFO });
    assert.equal(again.welcome.coreKey, d.welcome.coreKey);
    assert.equal(((await hub.execute({ kind: 'desktop', action: 'ui.tree', params: { maxNodes: 50 } })) as { text: string }).text, 'tree for ui.tree (50)');
    again.ws.close();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

/** Raw TCP client for protocol edge cases the WHATWG client never produces. */
async function rawClient(port: number) {
  const sock = connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET /devices HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let buf = Buffer.alloc(0);
  sock.on('data', (c: Buffer) => (buf = Buffer.concat([buf, c])));
  await new Promise((r) => setTimeout(r, 50));
  const handshake = buf.toString('latin1');
  buf = buf.subarray(buf.indexOf('\r\n\r\n') + 4);
  const frame = (opcode: number, payload: Buffer, opts: { fin?: boolean; masked?: boolean } = {}) => {
    const masked = opts.masked ?? true;
    const len = payload.length;
    const b0 = ((opts.fin ?? true) ? 0x80 : 0) | opcode;
    const m = masked ? 0x80 : 0;
    let head: Buffer;
    if (len < 126) head = Buffer.from([b0, m | len]);
    else if (len < 65536) head = Buffer.from([b0, m | 126, len >> 8, len & 255]);
    else {
      head = Buffer.alloc(10);
      head[0] = b0;
      head[1] = m | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    if (masked) for (let i = 0; i < body.length; i++) body[i]! ^= mask[i & 3]!;
    sock.write(Buffer.concat([head, masked ? mask : Buffer.alloc(0), body]));
  };
  const closed = new Promise<void>((r) => sock.once('close', () => r()));
  return { sock, handshake, frame, read: () => buf, closed };
}

test('protocol edge cases: fragments, ping/pong, unmasked, binary and oversized frames', async () => {
  const { hub, server, port } = await setup();
  try {
    // Fragmented text message is reassembled; a ping is answered with a pong.
    const a = await rawClient(port);
    assert.match(a.handshake, /^HTTP\/1\.1 101 /);
    const pair = Buffer.from(JSON.stringify({ type: 'pair', v: PROTOCOL_VERSION, code: hub.createPairingCode().code, device: INFO }));
    a.frame(0x1, pair.subarray(0, 10), { fin: false });
    a.frame(0x0, pair.subarray(10));
    a.frame(0x9, Buffer.from('hi'));
    await new Promise((r) => setTimeout(r, 80));
    const got = a.read();
    assert.ok(got.includes(Buffer.from('"type":"paired"')), 'pairing over fragmented frames worked');
    assert.ok(got.includes(Buffer.from([0x8a, 0x02, 0x68, 0x69])), 'pong echoes the ping payload');
    a.sock.destroy();

    for (const [name, send, code] of [
      ['unmasked', (c: Awaited<ReturnType<typeof rawClient>>) => c.frame(0x1, Buffer.from('{}'), { masked: false }), 1002],
      ['binary', (c: Awaited<ReturnType<typeof rawClient>>) => c.frame(0x2, Buffer.from([1, 2, 3])), 1003],
      ['oversized', (c: Awaited<ReturnType<typeof rawClient>>) => c.frame(0x1, Buffer.alloc(70_000, 0x61)), 1009],
    ] as const) {
      const c = await rawClient(port);
      send(c);
      await c.closed;
      const out = c.read();
      const closeAt = out.indexOf(0x88);
      assert.ok(closeAt >= 0, `${name}: a close frame was sent`);
      assert.equal(out.readUInt16BE(closeAt + 2), code, `${name}: close code ${code}`);
    }
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a peer that stops answering pings is dropped and its device goes offline', async () => {
  const { hub, server, port } = await setup();
  try {
    const c = await rawClient(port);
    c.frame(0x1, Buffer.from(JSON.stringify({ type: 'pair', v: PROTOCOL_VERSION, code: hub.createPairingCode().code, device: INFO })));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(hub.online().length, 1);
    // The raw client never answers pings. Pings go out every 200 ms; two silent intervals drop it.
    const started = Date.now();
    while (hub.online().length > 0 && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 25));
    assert.equal(hub.online().length, 0, 'the silent peer was dropped');
    assert.ok(Date.now() - started < 1500, `dropped within ~2 ping intervals (took ${Date.now() - started} ms)`);
    c.sock.destroy();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
