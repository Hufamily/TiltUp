// Generates icons/icon{16,32,48,128}.png (pixel-art bar + ball + lit hole) with no dependencies.
// Usage: node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h, a = 255) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
const BG = hex('#1a1d22'), INK = hex('#e9e4d4'), GOLD = hex('#ffb43b'), HOLE = hex('#07080a'), CLEAR = [0, 0, 0, 0];

// Drawn on a 16x16 grid and scaled up with nearest-neighbor for crisp pixels.
function art(x, y) {
  const inside = x >= 1 && x <= 14 && y >= 1 && y <= 14;
  const corner = (x === 1 || x === 14) && (y === 1 || y === 14);
  if (!inside || corner) return CLEAR;
  const d = (cx, cy) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  if (d(10.5, 5) < 1.6) return HOLE;              // goal hole
  if (d(10.5, 5) < 2.7) return GOLD;              // lit rim
  const barY = Math.round(11.5 - (x - 2) * 0.25); // tilted bar
  if (x >= 2 && x <= 13 && y === barY) return INK;
  if (d(6, barY - 1.5) < 1.7) return INK;         // ball
  return BG;
}

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const s = size / 16;
  writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), png(size, (x, y) => art(Math.floor(x / s), Math.floor(y / s))));
}
console.log('icons written');
