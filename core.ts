import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Credential, Model, OAuthCredential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

export const REGIONS = {
  cn: { id: "zcode-cn", name: "ZCode · BigModel 国内 Coding Plan", origin: "https://open.bigmodel.cn", account: "bigmodel", businessOrigin: "https://bigmodel.cn", authorizeUrl: "https://bigmodel.cn/login" },
  intl: { id: "zcode-intl", name: "ZCode · Z.ai 国际 Coding Plan", origin: "https://api.z.ai", account: "zai", businessOrigin: "https://api.z.ai", authorizeUrl: "https://chat.z.ai/api/oauth/authorize" },
} as const;
export type Region = keyof typeof REGIONS;
export const ZCODE_ORIGIN = "https://zcode.z.ai";
export const BROWSER_KEY_NAME = "pi-zcode";
const pathId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const modelKey = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}\.[a-zA-Z0-9_-]{1,512}$/.test(value);

export const codingUrl = (region: Region) => `${REGIONS[region].origin}/api/coding/paas/v4`;
const quotaUrl = (region: Region) => `${REGIONS[region].origin}/api/monitor/usage/quota/limit`;
const safeId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(v);
const validSecret = (v: string) => v.trim().length > 0 && !/[\s\x00-\x1f\x7f]/.test(v) && v.length <= 8192;
export const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export class DiagnosticError extends Error {}
export function errorText(error: unknown): string {
  if (error instanceof DiagnosticError) return error.message;
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return "请求已取消或超时；状态未知。";
  return "请求或本地存储失败；状态未知，未输出服务端正文或凭据。";
}

// Exact origins and method/path pairs; no user-selected hosts, credentials in URLs, or redirects.
const allowed = new Set(Object.keys(REGIONS)
  .flatMap(r => [codingUrl(r as Region) + "/models", quotaUrl(r as Region)]));
const keyPath = /^\/api\/biz\/v1\/organization\/[a-zA-Z0-9_-]{1,128}\/projects\/[a-zA-Z0-9_-]{1,128}\/api_keys$/;
const copyPath = /^\/api\/biz\/v1\/organization\/[a-zA-Z0-9_-]{1,128}\/projects\/[a-zA-Z0-9_-]{1,128}\/api_keys\/copy\/[a-zA-Z0-9_-]{1,128}$/;
function guardUrl(url: string, method: "GET" | "POST"): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new DiagnosticError("URL 无效。"); }
  const diagnostic = method === "GET" && allowed.has(u.origin + u.pathname);
  const oauth = u.origin === ZCODE_ORIGIN && (method === "POST" && u.pathname === "/api/v1/oauth/cli/init" || method === "GET" && /^\/api\/v1\/oauth\/cli\/poll\/[a-zA-Z0-9_-]{1,128}$/.test(u.pathname));
  const business = Object.values(REGIONS).some(r => r.businessOrigin === u.origin) &&
    (keyPath.test(u.pathname) || method === "GET" && (copyPath.test(u.pathname) || u.pathname === "/api/biz/customer/getCustomerInfo"));
  const exchange = method === "POST" && u.href === "https://api.z.ai/api/auth/z/login";
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || (!diagnostic && u.search) || !(diagnostic || oauth || business || exchange)) {
    throw new DiagnosticError("拒绝非预期端点。");
  }
}

const DEADLINE_MS = 15_000;
async function boundedBody(response: Response, signal: AbortSignal): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new DiagnosticError("服务端返回空正文；状态未知。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) throw new DiagnosticError("响应超出 1 MiB 上限；状态未知。");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  try { return object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { throw new DiagnosticError("响应不是有效 JSON；状态未知。"); }
}

/** One request only; POST is restricted to OAuth initialization/exchange and confirmed key creation. */
async function requestJson(url: string, authorization: string | undefined, signal: AbortSignal | undefined, fetcher: typeof fetch, payload?: unknown): Promise<Record<string, unknown>> {
  const method = payload === undefined ? "GET" : "POST";
  guardUrl(url, method);
  if (authorization !== undefined && !validSecret(authorization.replace(/^Bearer /, ""))) throw new DiagnosticError("凭据格式无效。");
  const deadline = AbortSignal.timeout(DEADLINE_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    combined.throwIfAborted();
    const response = await fetcher(url, {
      method, redirect: "error", credentials: "omit", signal: combined,
      headers: { Accept: "application/json", ...(authorization ? { Authorization: authorization } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DiagnosticError(`HTTP ${response.status}；${response.status === 401 ? "登录失效或接口不接受当前凭据，请重新 /login" : response.status === 403 ? "权限不足或需要官方验证" : response.status === 429 ? "请求受限，请稍后重试" : "接口不可用"}；状态未知。`);
    }
    const body = await boundedBody(response, combined);
    const code = body.code;
    if (/captcha|verification_required|验证码/i.test(String(code ?? "") + String(body.msg ?? "") + String(object(body.error).code ?? ""))) {
      throw new DiagnosticError("需要官方验证。请在官方客户端处理后手动重试；本扩展不提交或绕过验证码。");
    }
    if (body.success === false || body.error || (code !== undefined && code !== 0 && code !== 200 && code !== "0" && code !== "200")) {
      throw new DiagnosticError("服务端返回业务失败；状态未知。");
    }
    return body;
  } catch (error) { throw new DiagnosticError(errorText(error)); }
}

/** Read-only diagnostics; request bodies and arbitrary authorization headers are not exposed. */
export async function readJson(url: string, key?: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (key !== undefined && !validSecret(key)) throw new DiagnosticError("凭据格式无效。");
  return requestJson(url, key === undefined ? undefined : `Bearer ${key}`, signal, fetcher);
}

function secret(value: unknown): string {
  if (typeof value !== "string" || !validSecret(value)) throw new DiagnosticError("服务端未返回有效凭据；未使用其他令牌替代。");
  return value;
}
const label = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 80) : fallback;

/** Public browser flow: the server owns the callback; a fresh random bearer binds each polling session. */
async function loginBrowser(region: Region, interaction: ProviderAuthInteraction, fetcher: typeof fetch = fetch): Promise<OAuthCredential> {
  const config = REGIONS[region], signal = interaction.signal;
  const pollAuthorization = `Bearer ${randomBytes(32).toString("hex")}`;
  interaction.notify({ type: "progress", message: "正在初始化 ZCode 浏览器登录…" });
  const init = await requestJson(`${ZCODE_ORIGIN}/api/v1/oauth/cli/init`, pollAuthorization, signal, fetcher, { provider: config.account });
  const flow = object(init.data);
  if (init.code !== 0 || !pathId(flow.flow_id) || typeof flow.authorize_url !== "string" || flow.authorize_url.length > 8192 || typeof flow.expires_at !== "number" || typeof flow.poll_interval_sec !== "number") {
    throw new DiagnosticError("浏览器授权初始化响应无效。");
  }
  let authorize: URL, redirect: URL;
  try {
    authorize = new URL(flow.authorize_url);
    redirect = new URL(authorize.searchParams.get(region === "cn" ? "redirect" : "redirect_uri") ?? "");
  } catch { throw new DiagnosticError("浏览器授权地址无效。"); }
  const state = authorize.searchParams.getAll("state");
  const redirects = authorize.searchParams.getAll(region === "cn" ? "redirect" : "redirect_uri");
  if (authorize.origin + authorize.pathname !== config.authorizeUrl || authorize.username || authorize.password || authorize.hash || state.length !== 1 || !validSecret(state[0]) || redirects.length !== 1 ||
      redirect.origin !== ZCODE_ORIGIN || redirect.pathname !== `/api/v1/oauth/cli/callback/${config.account}` || redirect.username || redirect.password || redirect.hash) {
    throw new DiagnosticError("拒绝非官方浏览器授权地址。");
  }
  const remaining = Math.min(300_000, flow.expires_at * 1000 - Date.now()), interval = flow.poll_interval_sec * 1000;
  if (!Number.isFinite(remaining) || !Number.isFinite(interval) || remaining <= 0 || interval < 1000 || interval >= remaining) throw new DiagnosticError("浏览器授权期限无效或已过期。");
  const pollingSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.floor(remaining))]);
  interaction.notify({ type: "auth_url", url: authorize.toString(), instructions: "请在官方浏览器页面登录并授权，Pi 会等待结果。无需复制令牌或 API key；验证码由官方页面处理。" });
  let session: Record<string, unknown>;
  while (true) {
    const result = await requestJson(`${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${flow.flow_id}`, pollAuthorization, pollingSignal, fetcher);
    session = object(result.data);
    if (result.code !== 0) throw new DiagnosticError("浏览器授权查询失败。");
    if (session.status === "ready") break;
    if (session.status !== "pending") throw new DiagnosticError("浏览器授权失败、已取消或已过期，请重新 /login。");
    try { await sleep(interval, undefined, { signal: pollingSignal }); }
    catch (error) { throw new DiagnosticError(errorText(error)); }
  }
  secret(session.token);
  secret(object(session.user).user_id);
  const account = object(session[config.account]);
  let businessToken = secret(account.access_token ?? (region === "cn" ? account.accessToken : undefined));
  if (region === "intl") {
    const exchanged = object((await requestJson(`${config.businessOrigin}/api/auth/z/login`, undefined, signal, fetcher, { token: businessToken })).data);
    businessToken = secret(exchanged.access_token ?? exchanged.accessToken);
  }
  // BigModel business APIs take the raw business token; Z.ai uses Bearer. Never cross regions.
  const authorization = region === "cn" ? businessToken : `Bearer ${businessToken}`;
  const customer = object((await requestJson(`${config.businessOrigin}/api/biz/customer/getCustomerInfo`, authorization, signal, fetcher)).data);
  if (!Array.isArray(customer.organizations) || customer.organizations.length > 100) throw new DiagnosticError("账号机构列表无效；未获取或创建 API key。");
  const targets: { organizationId: string; projectId: string; name: string }[] = [];
  for (const value of customer.organizations) {
    const org = object(value);
    if (!pathId(org.organizationId) || !Array.isArray(org.projects) || org.projects.length > 100) throw new DiagnosticError("机构或项目列表无效；未获取或创建 API key。");
    for (const value of org.projects) {
      const project = object(value);
      if (String(project.projectType ?? "").trim() === "2") continue; // Official personal Coding Plan flow excludes type-2 projects.
      if (!pathId(project.projectId)) throw new DiagnosticError("项目 ID 无效；未获取或创建 API key。");
      targets.push({ organizationId: org.organizationId, projectId: project.projectId, name: `${label(org.organizationName ?? org.name, org.organizationId)} / ${label(project.projectName ?? project.name, project.projectId)}` });
    }
  }
  if (!targets.length) throw new DiagnosticError("账号没有可用的个人 Coding Plan 项目；请在官方平台检查，不会自动创建项目。");
  const choice = targets.length === 1 ? "0" : await interaction.prompt({ type: "select", message: "选择用于推理的机构 / 项目：", options: targets.map((t, i) => ({ id: String(i), label: t.name })), signal });
  signal.throwIfAborted();
  const target = targets.find((_t, i) => String(i) === choice);
  if (!target) throw new DiagnosticError("未选择有效项目；已取消。");
  interaction.notify({ type: "info", message: `使用项目：${target.name}。仅复用名为 ${BROWSER_KEY_NAME} 的 key；不复制其他 key 的 secret。` });
  const keysUrl = `${config.businessOrigin}/api/biz/v1/organization/${target.organizationId}/projects/${target.projectId}/api_keys`;
  const keys = (await requestJson(keysUrl, authorization, signal, fetcher)).data;
  if (!Array.isArray(keys) || keys.length > 1000 || !keys.every(k => typeof object(k).name === "string" && pathId(object(k).apiKey))) throw new DiagnosticError("API key 列表无效；不会据此创建新 key。");
  const matches = keys.map(object).filter(k => k.name === BROWSER_KEY_NAME);
  if (matches.length > 1) throw new DiagnosticError("项目中有多个同名 pi-zcode key；请先在官方平台整理，不自动选择。");
  let entry = matches[0];
  if (!entry) {
    const consent = await interaction.prompt({ type: "select", message: `允许在 ${target.name} 创建名为 ${BROWSER_KEY_NAME} 的长期推理 API key 吗？它会保存在 Pi；/logout 不会撤销服务端 key。`, options: [{ id: "cancel", label: "取消，不创建" }, { id: "create", label: "允许创建" }], signal });
    signal.throwIfAborted();
    if (consent !== "create") throw new DiagnosticError("已取消；未创建 API key。");
    interaction.notify({ type: "info", message: "即将提交一次新建请求；如请求中断或后续失败，请到官方平台检查该 key，不会自动重试创建。" });
    entry = object((await requestJson(keysUrl, authorization, signal, fetcher, { name: BROWSER_KEY_NAME })).data);
  }
  if (!pathId(entry.apiKey)) throw new DiagnosticError("未返回有效的推理 key ID；请到官方平台检查。");
  const copied = object((await requestJson(`${keysUrl}/copy/${entry.apiKey}`, authorization, signal, fetcher)).data);
  const access = `${entry.apiKey}.${typeof copied.secretKey === "string" ? copied.secretKey : ""}`;
  if (!modelKey(access)) throw new DiagnosticError("未返回完整推理凭据；请到官方平台检查，不会把登录令牌当作 API key。");
  signal.throwIfAborted();
  interaction.notify({ type: "info", message: "浏览器登录完成。Pi 保存后台取得的长期推理 key；/logout 仅删除本地凭据，停用时请到官方平台撤销 key。" });
  // The stored access value is a long-lived model key, not an OAuth token with a fabricated refresh lifetime.
  return { type: "oauth", access, refresh: "", expires: Number.MAX_SAFE_INTEGER, loginMethod: "zcode-browser", region, organizationId: target.organizationId, projectId: target.projectId };
}

export function browserKey(region: Region, credential: Credential | undefined): string | undefined {
  if (!credential || credential.type !== "oauth") return undefined;
  if (credential.loginMethod !== "zcode-browser" || credential.region !== region || !modelKey(credential.access) || credential.refresh !== "" || credential.expires !== Number.MAX_SAFE_INTEGER || !pathId(credential.organizationId) || !pathId(credential.projectId)) throw new DiagnosticError(`浏览器凭据格式或区域不匹配，请重新 /login ${REGIONS[region].id}。`);
  return credential.access;
}

export function makeProvider(region: Region, fetcher: typeof fetch = fetch) {
  const config = REGIONS[region];
  // The bundled Pi loader exposes providers/all, not individual provider subpaths.
  const candidate = builtinProviders().find(p => p.id === (region === "cn" ? "zai-coding-cn" : "zai"));
  if (!candidate || candidate.getModels().some(m => m.api !== "openai-completions")) throw new DiagnosticError("Pi 内置 Coding Plan provider 不兼容，请检查 Pi 版本。");
  const native = candidate as Provider<"openai-completions">;
  const baseline = native.getModels().map(m => ({ ...m, provider: config.id, baseUrl: codingUrl(region) }));
  const known = new Map(baseline.map(m => [m.id, m]));
  let models: readonly Model<"openai-completions">[] = baseline;
  let status: { source: string; checkedAt?: number; error?: string; unknown?: number } = { source: "Pi 内置目录（未验证当前账号权限）" };
  const provider: Provider<"openai-completions"> = {
    ...native,
    id: config.id, name: config.name, baseUrl: codingUrl(region),
    auth: { oauth: {
      name: config.name, loginLabel: "使用 ZCode 账号在浏览器登录", isSubscription: true,
      async login(interaction) {
        try { return await loginBrowser(region, interaction, fetcher); }
        catch (error) { throw new DiagnosticError(errorText(error)); }
      },
      async refresh(_credential, signal) {
        signal.throwIfAborted();
        throw new DiagnosticError(`当前浏览器流程没有已核实的刷新接口，请重新 /login ${config.id}。`);
      },
      async toAuth(credential) {
        const apiKey = browserKey(region, credential);
        if (!apiKey) throw new DiagnosticError(`请先 /login ${config.id} 完成浏览器授权。`);
        return { apiKey };
      },
    } },
    getModels: () => models,
    async refreshModels(ctx) {
      // Only IDs are trusted from cache/remote; URLs, headers and capabilities come from Pi.
      if (!ctx.allowNetwork) {
        if (ctx.stored && Array.isArray(ctx.stored.models)) {
          const ids = ctx.stored.models.map(m => m.id);
          if (ids.every(safeId)) {
            const restored = [...new Set(ids)].flatMap(id => known.has(id) ? [known.get(id)!] : []);
            await ctx.publish({ update: () => {
              models = restored;
              status = { source: "缓存（不代表当前账号权限）", checkedAt: ctx.stored?.checkedAt };
            } });
          }
        }
        return;
      }
      try {
        const key = browserKey(region, ctx.credential);
        if (!key) return;
        const body = await readJson(codingUrl(region) + "/models", key, ctx.signal, fetcher);
        if (!Array.isArray(body.data) || body.data.length > 1000 || !body.data.every(m => safeId(object(m).id))) {
          throw new DiagnosticError("模型目录格式无效；保留最后成功目录。");
        }
        const ids = [...new Set(body.data.map(m => object(m).id as string))];
        const next = ids.flatMap(id => known.has(id) ? [known.get(id)!] : []);
        const unknown = ids.length - next.length;
        // ponytail: unknown capabilities are not guessed; update Pi's catalog to enable new IDs.
        if (ids.length && !next.length) throw new DiagnosticError("发现的模型均缺少已知参数；保留旧目录，请更新 Pi 后再试。");
        const checkedAt = Date.now();
        await ctx.publish({ persist: { models: next, checkedAt }, update: () => {
          models = next;
          status = { source: "远端目录（不保证订阅授权）", checkedAt, unknown };
        } });
      } catch (error) {
        if (!ctx.signal.aborted) await ctx.publish({ update: () => { status = { ...status, error: errorText(error) }; } });
        throw new DiagnosticError(errorText(error));
      }
    },
  };
  return { provider, status: () => ({ ...status, count: models.length }) };
}

export function timeText(value: unknown): string {
  let millis: number;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) millis = value < 1e12 ? value * 1000 : value;
  else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) millis = Date.parse(value);
  else if (typeof value === "string" && /^\d{10,13}$/.test(value)) return timeText(Number(value));
  else return "未知";
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : "未知";
}

export async function quotaReport(region: Region, key: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const body = await readJson(quotaUrl(region), key, signal, fetcher);
  const limits = object(body.data).limits;
  if (!Array.isArray(limits) || limits.length > 100) throw new DiagnosticError("额度响应格式无效；余额未知，不按零处理。");
  const rows = limits.map(value => {
    const item = object(value);
    if (!safeId(item.type) || typeof item.percentage !== "number" || !Number.isFinite(item.percentage) || item.percentage < 0 || item.percentage > 100) throw new DiagnosticError("额度条目格式无效；状态未知。");
    return `${item.type}: 服务端 percentage=${item.percentage}%，下次重置 ${timeText(item.nextResetTime)}`;
  });
  return [`${REGIONS[region].name} · 查询于 ${new Date().toISOString()}`, ...rows,
    ...(rows.length ? [] : ["服务端未返回额度项目；不代表余额为零。"]),
    "percentage 按服务端原值展示，不推断剩余额度；Pi 的零成本显示不代表服务端免费。"].join("\n");
}

