import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { DeviceLink } from './hub.ts';

/**
 * Server side of RFC 6455 WebSockets, just what the device protocol needs (text frames, ping/pong,
 * close, fragmentation, size limits), with no dependencies. The result is a DeviceLink for
 * DeviceHub.attach(): onClose fires exactly once and asynchronously, frames are strings, and send
 * never throws.
 */
export interface WsOptions {
  /** Largest accepted message (screenshots, fs.read results). Default 32 MiB. */
  maxPayload?: number;
  /** A ping is sent this often; a peer that answers nothing for two intervals is dropped. */
  pingIntervalMs?: number;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** Completes the handshake and returns the link, or answers 400 and returns undefined. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, opts: WsOptions = {}): DeviceLink | undefined {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return undefined;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsLink(socket, head, opts);
}

class WsLink implements DeviceLink {
  private readonly socket: Duplex;
  private readonly maxPayload: number;
  private buffer: Buffer;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private readonly messageListeners: ((frame: string) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];
  private closing = false;
  private ended = false;
  private alive = true;
  private readonly pinger: NodeJS.Timeout;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(socket: Duplex, head: Buffer, opts: WsOptions) {
    this.socket = socket;
    this.maxPayload = opts.maxPayload ?? 32 * 1024 * 1024;
    this.buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
    (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
    socket.on('data', (chunk: Buffer) => {
      this.alive = true;
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.drain();
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.finish());
    const interval = opts.pingIntervalMs ?? 20_000;
    this.pinger = setInterval(() => {
      if (!this.alive) return void socket.destroy(); // two silent intervals: the peer is gone
      this.alive = false;
      this.write(OP.ping, Buffer.alloc(0));
    }, interval);
    this.pinger.unref();
    if (this.buffer.length) queueMicrotask(() => this.drain());
  }

  send(frame: string): void {
    if (!this.closing) this.write(OP.text, Buffer.from(frame, 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.closing) return;
    this.closing = true;
    const r = Buffer.from(reason, 'utf8').subarray(0, 123);
    const body = Buffer.alloc(2 + r.length);
    body.writeUInt16BE(code, 0);
    r.copy(body, 2);
    this.write(OP.close, body, true);
    // Give the peer a moment to answer with its own close frame, then end the TCP stream.
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.socket.end();
  }

  onMessage(cb: (frame: string) => void): void {
    this.messageListeners.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.closing = true;
    clearInterval(this.pinger);
    // 'close' is already asynchronous; keep it so even if a caller closes synchronously.
    queueMicrotask(() => this.closeListeners.forEach((cb) => cb()));
  }

  private write(opcode: number, payload: Buffer, force = false) {
    if ((this.closing && !force) || this.ended || this.socket.destroyed) return;
    const len = payload.length;
    const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode; // FIN + opcode; server frames are never masked
    if (len < 126) header[1] = len;
    else if (len < 65536) {
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.socket.destroy();
    }
  }

  private fail(code: number, reason: string) {
    this.close(code, reason);
    this.buffer = Buffer.alloc(0);
  }

  private drain() {
    while (!this.ended && this.buffer.length >= 2) {
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if (b0 & 0x70) return this.fail(1002, 'reserved bits set'); // no extensions negotiated
      if (!(b1 & 0x80)) return this.fail(1002, 'client frames must be masked');
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.fail(1009, 'message too big');
        len = Number(big);
        offset = 10;
      }
      const isControl = opcode >= 0x8;
      if (isControl && (len > 125 || !fin)) return this.fail(1002, 'bad control frame');
      if (!isControl && this.fragmentBytes + len > this.maxPayload) return this.fail(1009, 'message too big');
      if (this.buffer.length < offset + 4 + len) return; // wait for the rest of the frame
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buffer = this.buffer.subarray(offset + 4 + len);

      switch (opcode) {
        case OP.ping:
          this.write(OP.pong, payload);
          break;
        case OP.pong:
          break;
        case OP.close: {
          if (!this.closing) {
            this.closing = true;
            this.write(OP.close, payload.subarray(0, 2), true); // echo the status code
          }
          this.socket.end();
          return;
        }
        case OP.text:
        case OP.cont: {
          if (opcode === OP.text && this.fragments.length) return this.fail(1002, 'expected a continuation frame');
          if (opcode === OP.cont && !this.fragments.length) return this.fail(1002, 'unexpected continuation frame');
          this.fragments.push(payload);
          this.fragmentBytes += payload.length;
          if (!fin) break;
          const whole = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentBytes = 0;
          let text: string;
          try {
            text = this.decoder.decode(whole);
          } catch {
            return this.fail(1007, 'invalid UTF-8');
          }
          for (const cb of this.messageListeners) cb(text);
          break;
        }
        case OP.binary:
          return this.fail(1003, 'the device protocol uses text frames');
        default:
          return this.fail(1002, 'unknown opcode');
      }
    }
  }
}
