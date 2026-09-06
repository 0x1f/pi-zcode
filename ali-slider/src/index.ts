export { detectGap, reassemble, type GapResult, type RgbaImage } from "./gap.ts";
export { decodePng } from "./decode.ts";
export { generateSlideTrack, trackDuration, type TrackPoint } from "./track.ts";
export {
  solveWithOfficialSdk,
  type AliCaptchaInit,
  type AliCaptchaResult,
  type AliCaptchaSdk,
  type SdkLoader,
} from "./client.ts";
