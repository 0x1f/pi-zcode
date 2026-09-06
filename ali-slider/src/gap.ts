// Pixel-difference gap detection for slider / jigsaw captcha puzzles.
// Vendor-neutral: takes two raw RGBA image buffers (the "with-gap" bg and the
// "no-gap" full bg) and finds the first column where they diverge. This is the
// reusable core ported from the bilibili Geetest solver's detect_gap(); it makes
// no assumptions about Alibaba's (or any vendor's) wire protocol.

export interface RgbaImage {
  width: number;
  height: number;
  // Row-major RGBA, length === width * height * 4.
  data: Uint8Array | Uint8ClampedArray;
}

export interface GapResult {
  // X coordinate (px) of the first divergent column in the restored image.
  rawX: number;
  // X after the caller-supplied offset (e.g. slice/block shift compensation).
  distance: number;
  // Width/height actually scanned.
  width: number;
  height: number;
}

/** Per-channel absolute difference threshold that counts as "not matching". */
const DEFAULT_THRESHOLD = 60;

/**
 * Find the gap's left edge by scanning columns for the first pixel that differs
 * enough between `withGap` and `withoutGap`. Both images must share dimensions.
 * Returns rawX = -1 when no gap is found (images identical up to threshold).
 */
export function detectGap(
  withGap: RgbaImage,
  withoutGap: RgbaImage,
  threshold = DEFAULT_THRESHOLD,
  offset = 0,
): GapResult {
  if (withGap.width !== withoutGap.width || withGap.height !== withoutGap.height) {
    throw new Error("gap images must share dimensions");
  }
  const { width: w, height: h, data: a } = withGap;
  const b = withoutGap.data;
  const stride = 4;
  let rawX = -1;
  for (let x = 0; x < w; x++) {
    let found = false;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * stride;
      if (
        Math.abs(a[i] - b[i]) >= threshold ||
        Math.abs(a[i + 1] - b[i + 1]) >= threshold ||
        Math.abs(a[i + 2] - b[i + 2]) >= threshold
      ) {
        found = true;
        break;
      }
    }
    if (found) {
      rawX = x;
      break;
    }
  }
  return {
    rawX,
    distance: rawX < 0 ? -1 : Math.max(0, rawX - offset),
    width: w,
    height: h,
  };
}

/**
 * Reassemble a shuffled captcha image (Alibaba/Geetest-style slice scrambling)
 * into its correct left-to-right order given a piece layout. Each piece is a
 * contiguous horizontal strip `pieceWidth` px wide taken from `sourceX` in the
 * scrambled image, pasted at the next slot in the output.
 *
 * `pieces` must be ordered by final paste position. This is the inverse of the
 * scramble, not a solver — it only restores pixels the server already shipped.
 */
export function reassemble(
  scrambled: RgbaImage,
  pieces: { sourceX: number }[],
  pieceWidth: number,
): RgbaImage {
  const { width: w, height: h, data } = scrambled;
  const out = new Uint8Array(w * h * 4);
  let destX = 0;
  for (const piece of pieces) {
    for (let x = 0; x < pieceWidth; x++) {
      const sx = piece.sourceX + x;
      if (sx >= w || destX >= w) break;
      for (let y = 0; y < h; y++) {
        const si = (y * w + sx) * 4;
        const di = (y * w + destX) * 4;
        out[di] = data[si];
        out[di + 1] = data[si + 1];
        out[di + 2] = data[si + 2];
        out[di + 3] = data[si + 3];
      }
      destX++;
    }
  }
  return { width: w, height: h, data: out };
}
