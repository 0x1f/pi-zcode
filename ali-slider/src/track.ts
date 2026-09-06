// Human-like drag trajectory generation for slider captchas.
// Ports the bilibili Geetest solver's generate_slide_track() + _replace_y():
// an acceleration / cruise / deceleration profile with sub-pixel y jitter, so a
// robot-detecting backend sees a plausible pointer path rather than a constant
// velocity line. This is purely a motion model — it takes a target distance and
// emits [x, y, t] samples; it contains no vendor protocol or crypto.

export type TrackPoint = [x: number, y: number, t: number];

// Fixed affine constants from the reference implementation (calibrated to look
// like a real pointer captured by the captcha SDK). Tuning them further is the
// known ceiling; the values below match observed human captures closely enough.
const R1 = 230.65741262170448;
const C = 1.0000401423527645;
const R2 = 496.6467504426631;
const U = 187;
const A = 452.3177185058594;

const randInt = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * Replace the y channel of a track with a slowly-drifting value and small
 * downward jitter, mimicking a hand that is not perfectly horizontal.
 */
function replaceY(track: TrackPoint[]): void {
  const n = track.length;
  let count1 = 1;
  let count2 = 1;
  while (true) {
    const size = randInt(1, 6);
    if (count1 + size > n) break;
    if (count2 <= 13) {
      for (let i = count1; i < count1 + size; i++) track[i][1] = count2;
      count2 += 1;
    } else {
      count2 += randInt(-1, 0);
      for (let i = count1; i < count1 + size; i++) track[i][1] = count2;
    }
    count1 += size;
  }
  for (let i = count1; i < n; i++) track[i][1] = count2;
}

/**
 * Build a drag trajectory of `distance` px. The returned array is
 * [x, y, t(ms)] where x/y are offsets from the start and t is cumulative time.
 * Total drag time is ~0.8–2.5s depending on distance and RNG.
 */
export function generateSlideTrack(distance: number): TrackPoint[] {
  const track: TrackPoint[] = [
    [Math.round(U / C - R1), Math.round(A / C - R2), 0],
  ];
  track.push([0, 0, 0]);

  let count = R1;
  let y = 1;
  let t = 0;
  const scale = [0.2, 0.5, randInt(6, 8) / 10];
  const adj = distance + R1;

  while (count < adj) {
    let x: number;
    if (count < adj * scale[0]) x = randInt(1, 2);
    else if (count < adj * scale[1]) x = randInt(3, 4);
    else if (count < adj * scale[2]) x = randInt(5, 6);
    else if (count < adj * 0.9) x = randInt(2, 3);
    else x = 1;
    count += x;
    t += randInt(10, 30);
    const r = count / C - R1;
    y += randInt(0, 1);
    track.push([Math.round(r), y, t]);
  }

  track.push([track[track.length - 1][0], track[track.length - 1][1], t + randInt(90, 300)]);
  replaceY(track);
  return track;
}

/** Total milliseconds spanned by a track (last sample's t). */
export function trackDuration(track: TrackPoint[]): number {
  return track.length ? track[track.length - 1][2] : 0;
}
