/**
 * Free Start Plan inference via the official gateway + a local captcha bridge.
 *
 * Verified against the live service (2026-09-05/06):
 * - Endpoint: POST {ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages, Anthropic protocol.
 * - Auth: the session JWT the browser login already returns, as `Authorization: Bearer`.
 * - Every request must carry a fresh Aliyun captcha parameter (`X-Aliyun-Captcha-Verify-Param`
 *   plus `X-Aliyun-Captcha-Verify-Region: cn`); without it the gateway answers 3007.
 * - The parameter is a base64 JSON `{certifyId, sceneId, isSign, securityToken}` (~280 bytes)
 *   and is single-use: a second request with the same parameter fails 3007.
 * - The parameter is produced by the official AliyunCaptcha SDK (`SceneId`/`prefix` from
 *   `/api/v1/client/configs`) running in a real browser. This module serves a tiny bridge page
 *   on 127.0.0.1: the user opens it once, the SDK verifies in their own browser — tracelessly
 *   whenever the risk engine is satisfied, with a human completing any interactive challenge —
 *   and the page POSTs the parameter back to the local server. Nothing is solved or bypassed
 *   here: a real browser does the verification, exactly like the official desktop client.
 * - With a valid parameter but risk-flagged activity the gateway answers 3012/405; the failure
 *   is surfaced, never retried automatically.
 *
 * Per-request transport: pi's `before_provider_headers` event lets an extension mutate request
 * headers in place. The plan provider's `toAuth` marks requests with a `zcode-plan:` prefixed
 * `x-api-key`; `applyPlanHeaders` swaps that marker for the real headers plus one fresh captcha
 * parameter per request.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { DiagnosticError, ZCODE_ORIGIN, errorText, object } from "./core.ts";

export const PLAN_ANTHROPIC_PATH = "/api/v1/zcode-plan/anthropic";
export const planBaseUrl = `${ZCODE_ORIGIN}${PLAN_ANTHROPIC_PATH}`;
const PLAN_VERSION = "3.11.2";
const CONFIGS_PATH = `/api/v1/client/configs?app_version=${PLAN_VERSION}&platform=linux-x64`;
/** The live gateway serves Start Plan balances under this Free-model capability id. */
export const PLAN_MODEL_ID = "glm-5.3-flash";
/** `x-api-key` prefix marking requests that need the Start Plan header swap. */
export const PLAN_KEY_MARKER = "zcode-plan-jwt:";

/** Start Plan models: the id must match the plan capability reported by billing balances. */
export function planModels(): Model<"anthropic-messages">[] {
  return [{
    id: PLAN_MODEL_ID,
    name: "GLM-5.3 (Start Plan 🆓)",
    api: "anthropic-messages",
    provider: "zcode-plan",
    baseUrl: planBaseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 32_000,
  }];
}

const validToken = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(v);

/** One captcha parameter, its certifyId, and the time it was produced. */
export type CaptchaParam = { raw: string; certifyId: string; producedAt: number };

/** Structural check only; the signature is verified server-side when consumed. */
export function parseCaptchaParam(raw: string): CaptchaParam {
  if (!validToken(raw)) throw new DiagnosticError("验证码参数格式无效。");
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); } catch { throw new DiagnosticError("验证码参数不是有效的 base64 JSON。"); }
  const body = object(decoded);
  const certifyId = body.certifyId;
  if (typeof certifyId !== "string" || !/^[A-Za-z0-9_-]{4,128}$/.test(certifyId)) throw new DiagnosticError("验证码参数缺少有效 certifyId。");
  if (body.isSign !== true) throw new DiagnosticError("验证码参数未签名（isSign != true），服务端会拒绝。");
  if (typeof body.sceneId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.sceneId)) throw new DiagnosticError("验证码参数缺少有效 sceneId。");
  if (typeof body.securityToken !== "string" || body.securityToken.length < 32 || body.securityToken.length > 512) throw new DiagnosticError("验证码参数缺少有效 securityToken。");
  return { raw, certifyId, producedAt: Date.now() };
}

// ---------- captcha config (scene id / prefix), read-only from the client config endpoint ----------

export type CaptchaConfig = { region: string; prefix: string; sceneId: string };

export async function fetchCaptchaConfig(authorization: string, fetcher: typeof fetch): Promise<CaptchaConfig> {
  const response = await fetcher(`${ZCODE_ORIGIN}${CONFIGS_PATH}`, {
    method: "GET", redirect: "error", credentials: "omit",
    headers: { Accept: "application/json", Authorization: `Bearer ${authorization}`, "User-Agent": `ZCode/${PLAN_VERSION}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new DiagnosticError(`验证码配置查询失败（HTTP ${response.status}）。`); }
  const body = object(await response.json().catch(() => ({})));
  const configs = object(object(body.data).configs ?? object(body).configs);
  const captcha = object(configs.captcha);
  const region = captcha.region, prefix = captcha.prefix, sceneId = captcha.sceneId;
  if (captcha.enabled !== true || !validToken(region) || !validToken(prefix) || !validToken(sceneId) || region.length > 16 || prefix.length > 32 || sceneId.length > 32) {
    throw new DiagnosticError("验证码配置无效或未启用；请确认账号的 Start Plan 可用性。");
  }
  return { region, prefix, sceneId };
}

// ---------- local loopback bridge: serve the SDK page, accept produced parameters ----------

const LOOPBACK = "127.0.0.1";
const page = (config: CaptchaConfig): string => `<!doctype html><html><head><meta charset="utf-8"><title>ZCode Captcha Bridge</title></head>
<body style="font-family:sans-serif;background:#111;color:#ddd;padding:20px">
<h3>ZCode captcha bridge</h3>
<p>让此标签页保持打开。阿里云验证码 SDK 在你自己的浏览器里运行（与官方客户端相同的组件）；通常无感通过，若弹出挑战请手动完成一次。产生的参数只发往本机。</p>
<div id="cap-el"></div><button id="cap-btn">Verify</button><pre id="log" style="color:#8f8"></pre>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
<script>
const log = m => { const el = document.getElementById('log'); el.textContent = (m + "\\n" + el.textContent).split("\\n").slice(0, 14).join("\\n"); };
window.AliyunCaptchaConfig = { region: ${JSON.stringify(config.region)}, prefix: ${JSON.stringify(config.prefix)} };
let instance = null, busy = false, timer = null;
window.initAliyunCaptcha({
  SceneId: ${JSON.stringify(config.sceneId)},
  mode: 'popup', language: 'cn', showErrorTip: false,
  element: '#cap-el', button: '#cap-btn',
  getInstance: i => { instance = i; log('instance ready'); setTimeout(attempt, 500); },
  success: param => {
    clearTimeout(timer); busy = false;
    log('success len=' + (param ? param.length : 0));
    fetch('/param', { method: 'POST', body: param ?? '' }).then(() => setTimeout(attempt, 5000));
  },
  fail: e => { clearTimeout(timer); busy = false; log('fail: ' + JSON.stringify(e).slice(0, 120)); setTimeout(attempt, 15000); },
  onError: e => { clearTimeout(timer); busy = false; log('onError: ' + JSON.stringify(e).slice(0, 120)); setTimeout(attempt, 30000); },
});
function attempt() {
  if (!instance || busy) return;
  busy = true; log('attempt');
  try { instance.startTracelessVerification(); } catch { document.getElementById('cap-btn').click(); return; }
  timer = setTimeout(() => { if (busy) document.getElementById('cap-btn').click(); }, 8000);
}
setInterval(() => fetch('/health').then(r => r.json()).then(h => log('queue=' + h.queue + ' served=' + h.served)).catch(() => {}), 10000);
</script></body></html>`;

export class CaptchaBridge {
  private server: Server | undefined;
  private port = 0;
  private queue: CaptchaParam[] = [];
  private seen = new Set<string>();
  private served = 0;
  private startedAt = 0;
  private config: CaptchaConfig | undefined;

  get url(): string { return `http://${LOOPBACK}:${this.port}/`; }

  /** Idempotent: binds a loopback-only server; the page content follows the latest config. */
  start(config: CaptchaConfig): Promise<string> {
    this.config = config;
    this.startedAt = Date.now();
    if (this.server) return Promise.resolve(this.url);
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => { this.handle(request, response).catch(() => this.reject(response, 500)); });
      server.on("error", error => reject(new DiagnosticError(`本机桥接服务启动失败：${errorText(error)}`)));
      server.listen(0, LOOPBACK, () => {
        this.port = (server.address() as { port: number }).port;
        this.server = server;
        resolve(this.url);
      });
    });
  }

  stop(): void { this.server?.close(); this.server = undefined; }

  status(): string {
    return `桥接 ${this.server ? "运行中" : "未启动"} · 待取参数 ${this.queue.length} · 已取用 ${this.served}`;
  }

  /** Waits up to `timeoutMs` for the browser to produce a fresh parameter. */
  async take(timeoutMs = 60_000): Promise<CaptchaParam> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const param = this.queue.shift();
      if (param) { this.served++; return param; }
      if (Date.now() > deadline) throw new DiagnosticError("等待验证码参数超时：请确认桥接页面已在浏览器打开并保持前台。");
      await sleep(500);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${LOOPBACK}`);
    if (request.method === "GET" && url.pathname === "/") {
      const config = this.config;
      if (!config) { this.reject(response, 503); return; }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(page(config));
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ queue: this.queue.length, served: this.served }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/param") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > 65_536) { this.reject(response, 413); return; }
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      try {
        const param = parseCaptchaParam(raw);
        // Duplicate certifyIds are ignored (the widget repeats itself under load).
        if (!this.seen.has(param.certifyId)) {
          this.seen.add(param.certifyId);
          this.queue.push(param);
          while (this.queue.length > 3) this.queue.shift();
        }
        response.writeHead(204); response.end();
      } catch { this.reject(response, 400); }
      return;
    }
    this.reject(response, 404);
  }

  private reject(response: ServerResponse, status: number): void {
    try { response.writeHead(status, { "Content-Type": "text/plain" }); response.end(); } catch { /* client gone */ }
  }
}

/** True when an `x-api-key` value marks a Start Plan request; returns the session JWT. */
export function planKeyJwt(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(PLAN_KEY_MARKER)) return undefined;
  const jwt = value.slice(PLAN_KEY_MARKER.length);
  return validToken(jwt) ? jwt : undefined;
}

/**
 * Mutates the outgoing request headers in place for a Start Plan call: swaps the marker
 * `x-api-key` for the gateway's header set, including one fresh single-use captcha parameter.
 * Rejects with a DiagnosticError when no parameter is available in time, which surfaces as a
 * normal provider error instead of a malformed request.
 */
export async function applyPlanHeaders(headers: ProviderHeaders, bridge: CaptchaBridge, timeoutMs = 60_000): Promise<void> {
  const jwt = planKeyJwt(headers["x-api-key"]);
  if (jwt === undefined) return;
  const param = await bridge.take(timeoutMs);
  headers["x-api-key"] = null;
  headers["authorization"] = `Bearer ${jwt}`;
  headers["User-Agent"] = `ZCode/${PLAN_VERSION}`;
  headers["X-ZCode-App-Version"] = PLAN_VERSION;
  headers["X-Platform"] = `linux-${process.arch}`;
  headers["X-Title"] = "Z Code@electron";
  headers["HTTP-Referer"] = `${ZCODE_ORIGIN}/`;
  headers["X-Aliyun-Captcha-Verify-Param"] = param.raw;
  headers["X-Aliyun-Captcha-Verify-Region"] = "cn";
}
