// Thin, official-API-shaped wrapper around Alibaba Cloud's captcha SDK.
//
// IMPORTANT BOUNDARY (see project memory: "3007 captcha 排查方向纠正"):
// this module only *loads the official SDK* and *reads out the result a human
// solved in the official renderer*. It does NOT forge `slideCode`/`sig`/`x5s`,
// does NOT replay a solved session, and has no ZCode / pi-zcode coupling. The
// actual verification must be done server-side via Alibaba's official verify
// API with the `sessionId`/`token`/`sig` the human-produced callback returns.
//
// Use this for legitimate first-party integration or study of the puzzle image;
// do not wire the output into a third-party request to bypass a captcha.

export interface AliCaptchaInit {
  /** Your Alibaba captcha appkey / scene id (V1 appkey+scene, V2 sceneId). */
  appKey?: string;
  scene?: string;
  sceneId?: string;
  /** Element id the official SDK mounts its UI into. */
  elementId: string;
  /** Region endpoint host, if your deployment differs from the default. */
  region?: string;
}

/** What the official captcha callback delivers after a human solves it. */
export interface AliCaptchaResult {
  token: string;
  sessionId: string;
  sig: string;
  /** Scene the result belongs to (V1). */
  scene?: string;
}

/**
 * Shape of the global the Alibaba SDK exposes (subset we depend on). Implement
 * this against the real `window.NVC_Opt` / `AliyunCaptcha` in a browser, or a
 * stub in tests. We never reach into `nc.js` internals here.
 */
export interface AliCaptchaSdk {
  init(opts: AliCaptchaInit, onSuccess: (r: AliCaptchaResult) => void, onError: (e: Error) => void): void;
}

/** Minimal loader contract so this stays testable without a real browser. */
export interface SdkLoader {
  (appKey?: string): Promise<AliCaptchaSdk> | AliCaptchaSdk;
}

/**
 * Render the official captcha UI and resolve once a human completes it.
 * The returned result is meant to be sent to YOUR server, which verifies it
 * through Alibaba's official server-side API. We do not synthesize it.
 */
export function solveWithOfficialSdk(
  loader: SdkLoader,
  init: AliCaptchaInit,
): Promise<AliCaptchaResult> {
  return new Promise((resolve, reject) => {
    Promise.resolve(loader(init.appKey))
      .then((sdk) => {
        sdk.init(
          init,
          (r) => {
            if (!r?.token || !r?.sessionId || !r?.sig) {
              reject(new Error("captcha callback missing token/sessionId/sig"));
              return;
            }
            resolve(r);
          },
          (e) => reject(e ?? new Error("captcha sdk error")),
        );
      })
      .catch(reject);
  });
}
