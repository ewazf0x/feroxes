#!/usr/bin/env node
// Generates the Feroxes app icon (apps/desktop/icon.png, 1024×1024) with no dependencies, so CI
// can turn it into every platform format with `tauri icon`. A rounded "squircle" tile with an
// indigo→violet gradient, a crisp white "F" monogram, and a cyan accent dot.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import zlib from 'node:zlib';

const S = 1024;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Signed distance to a rounded rectangle; <0 inside. ~1px analytic anti-aliasing via coverage().
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;
const coverage = (sd) => clamp(0.5 - sd, 0, 1);

// Alpha-composite src (rgb, a in 0..1) over dst (mutating dst [r,g,b,a 0..255]).
const over = (dst, r, g, b, a) => {
  if (a <= 0) return;
  const da = dst[3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) return;
  for (let i = 0; i < 3; i++) dst[i] = Math.round((([r, g, b][i] * a) + dst[i] * da * (1 - a)) / outA);
  dst[3] = Math.round(outA * 255);
};

const tileA = hex('#5b4ff0'); // indigo
const tileB = hex('#9a66ff'); // violet
const glow = hex('#b9a9ff');
const accent = hex('#4fd1e6'); // cyan

const buf = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const px = [0, 0, 0, 0];

    // Rounded tile with a 135° gradient + a soft top-left highlight.
    const tileSd = sdRoundRect(x, y, S / 2, S / 2, S / 2, S / 2, 224);
    const tileCov = coverage(tileSd);
    if (tileCov > 0) {
      const t = clamp((x + y) / (2 * S), 0, 1);
      let r = tileA[0] + (tileB[0] - tileA[0]) * t;
      let g = tileA[1] + (tileB[1] - tileA[1]) * t;
      let b = tileA[2] + (tileB[2] - tileA[2]) * t;
      const hl = clamp(1 - Math.hypot(x - 300, y - 260) / 760, 0, 1) ** 2 * 0.35;
      r += (glow[0] - r) * hl;
      g += (glow[1] - g) * hl;
      b += (glow[2] - b) * hl;
      over(px, r, g, b, tileCov);
    }

    // "F" monogram (stem + two bars), rounded, soft white.
    const f = Math.min(
      sdRoundRect(x, y, 410, 512, 52, 214, 34), // stem
      sdRoundRect(x, y, 540, 352, 165, 52, 34), // top bar
      sdRoundRect(x, y, 512, 500, 140, 48, 32), // middle bar
    );
    over(px, 255, 255, 255, coverage(f) * 0.96);

    // Cyan accent dot, bottom-right flourish.
    over(px, accent[0], accent[1], accent[2], coverage(sdCircle(x, y, 700, 712, 46)));

    buf.set(px, (y * S + x) * 4);
  }
}

// Minimal PNG encoder (8-bit RGBA).
const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = resolve(import.meta.dirname, '..', 'apps/desktop/icon.png');
writeFileSync(out, png);
console.log('wrote', out, `(${S}×${S}, ${png.length} bytes)`);
