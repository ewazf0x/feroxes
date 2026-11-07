import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then random bits.
 * Ids sort by creation time, which keeps B-tree indexes compact and makes logs readable.
 * Within one millisecond, a 12-bit counter keeps ids from one process strictly increasing.
 */
let lastMs = -1;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  let ms = now;
  if (ms <= lastMs) {
    ms = lastMs;
    counter = (counter + 1) & 0xfff;
    if (counter === 0) ms = ++lastMs; // counter overflow: borrow the next millisecond
  } else {
    lastMs = ms;
    counter = randomBytes(2).readUInt16BE(0) & 0x3ff; // random start, leaves headroom
  }

  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (counter >> 8); // version 7 + high counter bits
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 4122 variant

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidv7(value: string): boolean {
  return UUID_RE.test(value);
}
