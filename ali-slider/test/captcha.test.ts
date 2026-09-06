import assert from "node:assert/strict";
import { test } from "node:test";
import { detectGap, reassemble, type RgbaImage } from "../src/gap.ts";
import { decodePng } from "../src/decode.ts";
import { deflateSync } from "node:zlib";
import { generateSlideTrack, trackDuration } from "../src/track.ts";
import { solveWithOfficialSdk, type AliCaptchaSdk } from "../src/client.ts";

const rgba = (w: number, h: number, fill: number[]): RgbaImage => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  return { width: w, height: h, data };
};

// withGap == fullBg except a vertical strip at x in [40,60) that differs.
function puzzlePair(w = 100, h = 50, gapX = 40): { withGap: RgbaImage; full: RgbaImage } {
  const full = rgba(w, h, [10, 20, 30, 255]);
  const withGap = rgba(w, h, [10, 20, 30, 255]);
  for (let x = gapX; x < gapX + 20; x++) {
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      withGap.data[i] = 200; // obvious delta on R
    }
  }
  return { withGap, full };
}

test("detectGap finds the divergent column", () => {
  const { withGap, full } = puzzlePair(100, 50, 40);
  const r = detectGap(withGap, full);
  assert.equal(r.rawX, 40);
  assert.equal(r.distance, 40); // offset 0
  assert.equal(r.width, 100);
});

test("detectGap applies offset compensation", () => {
  const { withGap, full } = puzzlePair(100, 50, 40);
  const r = detectGap(withGap, full, 60, 7);
  assert.equal(r.rawX, 40);
  assert.equal(r.distance, 33);
});

test("detectGap returns -1 when images are identical", () => {
  const img = rgba(40, 30, [5, 5, 5, 255]);
  const r = detectGap(img, rgba(40, 30, [5, 5, 5, 255]));
  assert.equal(r.rawX, -1);
  assert.equal(r.distance, -1);
});

test("detectGap rejects mismatched dimensions", () => {
  assert.throws(() => detectGap(rgba(10, 10, [0, 0, 0, 255]), rgba(11, 10, [0, 0, 0, 255])));
});

test("reassemble restores a simple 2-piece shuffle", () => {
  // Scrambled: piece A at x=10, piece B at x=0; correct order is B then A.
  const w = 20, h = 4, pw = 10;
  const scrambled = rgba(w, h, [0, 0, 0, 0]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < pw; x++) {
      scrambled.data[((y * w + (0 + x)) * 4)] = 1; // B = 1
      scrambled.data[((y * w + (10 + x)) * 4)] = 2; // A = 2
    }
  }
  const out = reassemble(scrambled, [{ sourceX: 10 }, { sourceX: 0 }], pw);
  // First half should now be A (2), second half B (1).
  assert.equal(out.data[0], 2);
  assert.equal(out.data[(0 + pw) * 4], 1);
});

test("generateSlideTrack starts at origin and ends at distance", () => {
  const dist = 137;
  const track = generateSlideTrack(dist);
  assert.ok(track.length > 5);
  assert.deepEqual(track[0], [Math.round(187 / 1.0000401423527645 - 230.65741262170448), Math.round(452.3177185058594 / 1.0000401423527645 - 496.6467504426631), 0]);
  const [lastX] = track[track.length - 1];
  // lastX is the raw offset; the affine inverse maps back near `dist`.
  const recovered = Math.round((lastX + 230.65741262170448) * 1.0000401423527645 - 230.65741262170448);
  assert.ok(Math.abs(recovered - dist) <= 2, `recovered ${recovered} vs ${dist}`);
});

test("generateSlideTrack has monotonically increasing time and jitter", () => {
  const track = generateSlideTrack(200);
  for (let i = 1; i < track.length; i++) {
    assert.ok(track[i][2] >= track[i - 1][2], "time must be non-decreasing");
  }
  assert.ok(trackDuration(track) > 0);
});

test("solveWithOfficialSdk resolves the human-solved result", async () => {
  const sdk: AliCaptchaSdk = {
    init(_opts, onSuccess) {
      onSuccess({ token: "t", sessionId: "s", sig: "g", scene: "scene" });
    },
  };
  const loader = () => sdk;
  const r = await solveWithOfficialSdk(loader, { elementId: "captcha" });
  assert.equal(r.token, "t");
  assert.equal(r.sessionId, "s");
  assert.equal(r.sig, "g");
});

test("solveWithOfficialSdk rejects incomplete callback", async () => {
  const sdk: AliCaptchaSdk = {
    init(_opts, onSuccess) {
      onSuccess({ token: "", sessionId: "", sig: "" });
    },
  };
  await assert.rejects(solveWithOfficialSdk(() => sdk, { elementId: "c" }), /missing/);
});

// Tiny RGBA PNG encoder (stdlib only) so we can round-trip decodePng offline.
function encodePng(w: number, h: number, rgba: Uint8Array): Uint8Array {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw);
  const chunk = (type: string, data: Uint8Array) => {
    const len = data.length;
    const body = new Uint8Array(4 + 4 + len + 4);
    body[0] = (len >>> 24) & 255; body[1] = (len >>> 16) & 255; body[2] = (len >>> 8) & 255; body[3] = len & 255;
    body[4] = type.charCodeAt(0); body[5] = type.charCodeAt(1); body[6] = type.charCodeAt(2); body[7] = type.charCodeAt(3);
    body.set(data, 8);
    return body;
  };
  const ihdr = new Uint8Array(13);
  ihdr[0] = (w >>> 24) & 255; ihdr[1] = (w >>> 16) & 255; ihdr[2] = (w >>> 8) & 255; ihdr[3] = w & 255;
  ihdr[4] = (h >>> 24) & 255; ihdr[5] = (h >>> 16) & 255; ihdr[6] = (h >>> 8) & 255; ihdr[7] = h & 255;
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array([...sig, ...chunk("IHDR", ihdr), ...chunk("IDAT", idat), ...chunk("IEND", new Uint8Array(0))]);
}

test("decodePng round-trips an RGBA image", () => {
  const w = 8, h = 4;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = i; rgba[i * 4 + 1] = 255 - i; rgba[i * 4 + 2] = 128; rgba[i * 4 + 3] = 200;
  }
  const png = encodePng(w, h, rgba);
  const img = decodePng(png);
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  assert.deepEqual(Array.from(img.data), Array.from(rgba));
});

test("decodePng rejects non-PNG input", () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /PNG/);
});
