// Minimal, dependency-free PNG decoder (8-bit, color types 0/2/4/6; palette
// type 3 and Adam7 interlace are NOT supported).
// Alibaba/Geetest ship puzzle images as PNG, so this is the one decoder the
// library needs to be usable end-to-end; everything else stays caller-supplied.
// No external deps: PNG scanlines are zlib-deflated and we use node:zlib.

import { inflateSync } from "node:zlib";
import type { RgbaImage } from "./gap.ts";

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function readUint32(buf: Uint8Array, off: number): number {
  return (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
}

/** Decode PNG bytes into an RgbaImage (RGBA, premultiplied-expanded). */
export function decodePng(bytes: Uint8Array): RgbaImage {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error("not a PNG file");
  }
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat: Uint8Array[] = [];
  while (off < bytes.length) {
    const len = readUint32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const start = off + 8;
    if (type === "IHDR") {
      width = readUint32(bytes, start);
      height = readUint32(bytes, start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
    } else if (type === "IDAT") {
      idat.push(bytes.slice(start, start + len));
    } else if (type === "IEND") {
      break;
    }
    off = start + len + 4; // skip + CRC
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = inflateSync(concat(idat));
  const bytesPerPixel = channels;
  const stride = width * bytesPerPixel;
  const out = new Uint8Array(width * height * 4);

  let prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos++];
      const a = x >= bytesPerPixel ? cur[x - bytesPerPixel] : 0;
      const b = prev[x];
      const c = x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
      let val: number;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          val = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = val & 0xff;
    }
    // expand channels -> RGBA
    for (let x = 0; x < width; x++) {
      const si = x * bytesPerPixel;
      const di = (y * width + x) * 4;
      if (colorType === 0 || colorType === 3) { out[di] = out[di + 1] = out[di + 2] = cur[si]; out[di + 3] = 255; }
      else if (colorType === 2) { out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = 255; }
      else if (colorType === 4) { out[di] = out[di + 1] = out[di + 2] = cur[si]; out[di + 3] = cur[si + 1]; }
      else { out[di] = cur[si]; out[di + 1] = cur[si + 1]; out[di + 2] = cur[si + 2]; out[di + 3] = cur[si + 3]; }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
