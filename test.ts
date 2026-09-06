import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, InMemoryCredentialStore, InMemoryModelsStore, Type, type Context, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import extension from "./index.ts";
import { BROWSER_KEY_NAME, REGIONS, ZCODE_JWT_FIELD, ZCODE_ORIGIN, browserKey, codingUrl, errorText, makeProvider, planJwt, quotaReport, readJson, timeText, type Region } from "./core.ts";

// All requests must use explicit test fetch functions; never load real auth or Pi settings.
const loopbackFetch = globalThis.fetch; // recovered for 127.0.0.1 bridge tests only
globalThis.fetch = async () => { throw new Error("NETWORK DISABLED IN TESTS"); };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = (fn: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  (async (url, init) => fn(String(url), init ?? {})) as typeof fetch;
const oauthCredential = (region: Region): OAuthCredential => ({ type: "oauth", access: `${region}-test-id.${region}-test-secret`, refresh: "", expires: Number.MAX_SAFE_INTEGER, loginMethod: "zcode-browser", region, organizationId: "org", projectId: "project" });
async function runtime(region: Region, fetcher: typeof fetch) {
  const credentials = new InMemoryCredentialStore();
  const modelsStore = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore, authContext: { env: async () => undefined, fileExists: async () => false } });
  const item = makeProvider(region, fetcher);
  models.setProvider(item.provider);
  await credentials.modify(item.provider.id, async () => oauthCredential(region));
  return { ...item, models, credentials, modelsStore };
}

test("OAuth-only providers reject manual, legacy, ambient and cross-region credentials", async () => {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials, modelsStore: new InMemoryModelsStore(), authContext: { env: async () => "ambient-key", fileExists: async () => false } });
  for (const region of ["cn", "intl"] as const) {
    const { provider } = makeProvider(region);
    models.setProvider(provider);
    assert.equal(provider.auth.apiKey, undefined);
    assert.match(provider.auth.oauth!.loginLabel!, /浏览器/);
    assert.equal(provider.baseUrl, codingUrl(region));
    assert.equal(await models.getAuth(provider.id, { apiKey: "manual-key", env: { ZAI_API_KEY: "env-key" } }), undefined);
    await credentials.modify(provider.id, async () => ({ type: "api_key", key: "legacy-key" }));
    assert.equal(await models.getAuth(provider.id), undefined);
    assert.equal(browserKey(region, { type: "api_key", key: "legacy-key" }), undefined);
    await credentials.modify(provider.id, async () => oauthCredential(region));
    assert.equal((await models.getAuth(provider.id))?.auth.apiKey, oauthCredential(region).access);
    for (const patch of [{ region: region === "cn" ? "intl" : "cn" }, { loginMethod: "" }, { access: "masked.***" }, { expires: NaN }, { refresh: "unexpected-token" }, { organizationId: "../x" }]) {
      await assert.rejects(provider.auth.oauth!.toAuth({ ...oauthCredential(region), ...patch }), /凭据/);
    }
    await credentials.modify(provider.id, async () => ({ ...oauthCredential(region), expires: 1 }));
    await assert.rejects(models.getAuth(provider.id), /重新 \/login/);
  }
  assert.notEqual(REGIONS.cn.id, REGIONS.intl.id);
});

function browserFixture(region: Region) {
  const config = REGIONS[region], controller = new AbortController();
  const authorize = new URL(config.authorizeUrl);
  authorize.searchParams.set("state", "synthetic-state");
  authorize.searchParams.set(region === "cn" ? "redirect" : "redirect_uri", `${ZCODE_ORIGIN}/api/v1/oauth/cli/callback/${config.account}`);
  const responses: Record<string, any> = {
    init: { code: 0, data: { flow_id: "synthetic-flow", poll_token: "do-not-use-returned-token", authorize_url: authorize.toString(), expires_at: Math.floor(Date.now() / 1000) + 60, poll_interval_sec: 1 } },
    poll: { code: 0, data: { status: "ready", token: "synthetic-zcode-session", user: { user_id: "synthetic-user" }, [config.account]: { access_token: `${region}-synthetic-account` } } },
    exchange: { code: 200, data: { access_token: "synthetic-business-token" } },
    customer: { code: 200, data: { organizations: [{ organizationId: "org", organizationName: "机构", projects: [{ projectId: "project", projectName: "项目" }] }] } },
    keys: { code: 200, data: [{ name: "another-application", apiKey: "other-id" }, { name: BROWSER_KEY_NAME, apiKey: `${region}-test-id` }] },
    create: { code: 200, data: { name: BROWSER_KEY_NAME, apiKey: `${region}-test-id` } },
    copy: { code: 200, data: { secretKey: `${region}-test-secret` } },
  };
  const notices: Parameters<ProviderAuthInteraction["notify"]>[0][] = [];
  const prompts: Parameters<ProviderAuthInteraction["prompt"]>[0][] = [];
  const calls: { slot: string; url: string; method: string }[] = [], answers: string[] = [];
  let pollAuthorization = "", pending = 0;
  const fetcher = fakeFetch((url, init) => {
    const path = new URL(url).pathname, method = init.method!;
    let slot: string;
    if (url === `${ZCODE_ORIGIN}/api/v1/oauth/cli/init` && method === "POST") slot = "init";
    else if (url === `${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/synthetic-flow` && method === "GET") slot = "poll";
    else {
      assert.equal(new URL(url).origin, config.businessOrigin);
      if (path === "/api/auth/z/login" && method === "POST") { assert.equal(region, "intl"); slot = "exchange"; }
      else if (path === "/api/biz/customer/getCustomerInfo" && method === "GET") slot = "customer";
      else if (/^\/api\/biz\/v1\/organization\/org\/projects\/project(?:-b)?\/api_keys$/.test(path)) slot = method === "POST" ? "create" : "keys";
      else if (path.endsWith(`/api_keys/copy/${region}-test-id`) && method === "GET") slot = "copy";
      else throw new Error("unexpected synthetic request");
    }
    calls.push({ slot, url, method });
    assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit"); assert(init.signal);
    const authorization = new Headers(init.headers).get("authorization");
    if (slot === "init") {
      assert.match(authorization!, /^Bearer [a-f0-9]{64}$/);
      pollAuthorization = authorization!;
      assert.deepEqual(JSON.parse(String(init.body)), { provider: config.account });
    } else if (slot === "poll") assert.equal(authorization, pollAuthorization);
    else if (slot === "exchange") {
      assert.equal(authorization, null);
      assert.deepEqual(JSON.parse(String(init.body)), { token: `${region}-synthetic-account` });
    } else assert.equal(authorization, region === "cn" ? "cn-synthetic-account" : "Bearer synthetic-business-token");
    if (slot === "create") assert.deepEqual(JSON.parse(String(init.body)), { name: BROWSER_KEY_NAME });
    if (slot === "poll" && pending-- > 0) return json({ code: 0, data: { status: "pending" } });
    if (responses[slot] instanceof Error) throw responses[slot];
    return responses[slot] instanceof Response ? responses[slot] : json(responses[slot]);
  });
  const interaction: ProviderAuthInteraction = {
    signal: controller.signal, notify: event => { notices.push(event); },
    prompt: async prompt => { prompts.push(prompt); assert.equal(prompt.type, "select"); return answers.shift() ?? "cancel"; },
  };
  const { provider } = makeProvider(region, fetcher);
  return { responses, notices, prompts, calls, answers, interaction, controller, provider, authorization: () => pollAuthorization, waitOnce: () => { pending = 1; }, login: () => provider.auth.oauth!.login(interaction) };
}

test("both browser flows reuse only the dedicated key; polling is bound to fresh client bearers", async () => {
  const authorizations = new Set<string>();
  for (const region of ["cn", "intl", "cn"] as const) {
    const f = browserFixture(region), credential = await f.login();
    authorizations.add(f.authorization());
    // The poll response's session JWT is kept (read-only balance), never substituted for the model key.
    assert.deepEqual(credential, { ...oauthCredential(region), env: { [ZCODE_JWT_FIELD]: "synthetic-zcode-session" } });
    assert.equal(browserKey(region, credential), credential.access);
    assert.equal((await f.provider.auth.oauth!.toAuth(credential)).apiKey, credential.access);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.calls.filter(c => c.slot === "create").length, 0);
    assert.equal(f.calls.filter(c => c.slot === "exchange").length, region === "intl" ? 1 : 0);
    assert(f.notices.some(n => n.type === "auth_url" && n.url.startsWith(REGIONS[region].authorizeUrl)));
    assert(f.notices.some(n => n.type === "info" && n.message.includes("/logout")));
    // Secrets never reach notices; the session JWT is retained in the credential but must not be the model key.
    const output = JSON.stringify(f.notices);
    for (const value of [f.authorization(), "synthetic-zcode-session", "synthetic-business-token", `${region}-synthetic-account`, credential.access, `${region}-test-secret`]) assert(!output.includes(value));
    assert(!credential.access.includes("synthetic-zcode-session"));
  }
  assert.equal(authorizations.size, 3);
});

test("pending polling completes or cancels without continuing to account operations", async () => {
  const f = browserFixture("cn"); f.waitOnce();
  assert.equal((await f.login()).access, oauthCredential("cn").access);
  assert.equal(f.calls.filter(c => c.slot === "poll").length, 2);
  const cancelled = browserFixture("intl"); cancelled.waitOnce();
  const promise = cancelled.login();
  const timer = setTimeout(() => cancelled.controller.abort(), 20);
  try { await assert.rejects(promise, /取消或超时/); } finally { clearTimeout(timer); }
  assert(!cancelled.calls.some(c => ["exchange", "customer", "create"].includes(c.slot)));
  const before = browserFixture("cn"); before.controller.abort(new Error("sensitive-cancel-reason"));
  await assert.rejects(before.login(), error => !String(error).includes("sensitive-cancel-reason"));
  assert.equal(before.calls.length, 0);
});

test("authorization URLs, unique state/redirect parameters and flow lifetimes fail closed", async () => {
  for (const region of ["cn", "intl"] as const) {
    for (const mutate of [
      (u: URL) => { u.hostname = "untrusted.invalid"; },
      (u: URL) => { u.protocol = "http:"; },
      (u: URL) => { u.port = "444"; },
      (u: URL) => { u.username = "unexpected"; },
      (u: URL) => { u.hash = "unexpected"; },
      (u: URL) => { u.searchParams.delete("state"); },
      (u: URL) => { u.searchParams.set("state", " "); },
      (u: URL) => { u.searchParams.append("state", "second"); },
      (u: URL) => { u.searchParams.set(region === "cn" ? "redirect" : "redirect_uri", "https://untrusted.invalid/app/oauth/login"); },
      (u: URL) => { u.searchParams.append(region === "cn" ? "redirect" : "redirect_uri", `${ZCODE_ORIGIN}/api/v1/oauth/cli/callback/${REGIONS[region].account}`); },
      (u: URL) => { u.searchParams.set(region === "cn" ? "redirect" : "redirect_uri", `${ZCODE_ORIGIN}/api/v1/oauth/cli/callback/${region === "cn" ? "zai" : "bigmodel"}`); },
      (u: URL) => { u.searchParams.set(region === "cn" ? "redirect" : "redirect_uri", `${ZCODE_ORIGIN}/app/oauth/login`); },
    ]) {
      const f = browserFixture(region), url = new URL(f.responses.init.data.authorize_url); mutate(url);
      f.responses.init.data.authorize_url = url.toString();
      await assert.rejects(f.login(), /授权地址/);
      assert.equal(f.calls.length, 1); assert.equal(f.notices.filter(n => n.type === "auth_url").length, 0);
    }
    for (const patch of [{ flow_id: "../invalid" }, { expires_at: 1 }, { expires_at: "future" }, { poll_interval_sec: 0 }, { poll_interval_sec: 300 }]) {
      const f = browserFixture(region); Object.assign(f.responses.init.data, patch);
      await assert.rejects(f.login(), /初始化|期限/);
      assert.equal(f.calls.length, 1);
    }
  }
});

test("failed or incomplete browser sessions never fall back to another region or token family", async () => {
  for (const region of ["cn", "intl"] as const) {
    for (const patch of [{ status: "failed" }, { status: "expired" }, { token: undefined }, { user: {} }, { [REGIONS[region].account]: {} }]) {
      const f = browserFixture(region); Object.assign(f.responses.poll.data, patch);
      await assert.rejects(f.login(), /授权失败|有效凭据/);
      assert.deepEqual(f.calls.map(c => c.slot), ["init", "poll"]);
    }
  }
  const f = browserFixture("intl"); f.responses.exchange.data = {};
  await assert.rejects(f.login(), /有效凭据/);
  assert(!f.calls.some(c => c.slot === "customer"));
});

test("project selection is explicit when ambiguous and type-2 projects are excluded", async () => {
  const f = browserFixture("cn");
  f.responses.customer.data.organizations[0].projects.push({ projectId: "project-b", projectName: "第二项目" });
  f.answers.push("1");
  assert.equal((await f.login()).projectId, "project-b");
  assert.equal(f.prompts.length, 1);
  assert(f.calls.filter(c => ["keys", "copy"].includes(c.slot)).every(c => c.url.includes("/projects/project-b/")));
  const excluded = browserFixture("cn"); excluded.responses.customer.data.organizations[0].projects[0].projectType = 2;
  await assert.rejects(excluded.login(), /没有可用/);
  assert(!excluded.calls.some(c => c.slot === "keys"));
  const invalid = browserFixture("cn"); invalid.responses.customer.data.organizations[0].organizationId = "../invalid";
  await assert.rejects(invalid.login(), /列表无效/);
  assert(!invalid.calls.some(c => c.slot === "keys"));
});

test("new keys require affirmative consent, default to cancel and are posted at most once", async () => {
  for (const region of ["cn", "intl"] as const) {
    const denied = browserFixture(region); denied.responses.keys.data = [];
    await assert.rejects(denied.login(), /未创建/);
    assert(denied.prompts[0].type === "select");
    assert.equal(denied.prompts[0].options[0].id, "cancel");
    assert.match(denied.prompts[0].message, /长期.*\/logout/);
    assert(!denied.calls.some(c => ["create", "copy"].includes(c.slot)));
    const allowed = browserFixture(region); allowed.responses.keys.data = []; allowed.answers.push("create");
    assert.equal((await allowed.login()).access, oauthCredential(region).access);
    assert.equal(allowed.calls.filter(c => c.slot === "create").length, 1);
    for (const result of [json({ msg: "synthetic-business-token" }, 503), new Error("synthetic-business-token"), { code: 200, data: {} }]) {
      const failed = browserFixture(region); failed.responses.keys.data = []; failed.answers.push("create"); failed.responses.create = result;
      await assert.rejects(failed.login(), error => !String(error).includes("synthetic-business-token"));
      assert.equal(failed.calls.filter(c => c.slot === "create").length, 1);
      assert(!failed.calls.some(c => c.slot === "copy"));
    }
    const cancelled = browserFixture(region); cancelled.responses.keys.data = [];
    cancelled.interaction.prompt = async () => { cancelled.controller.abort(); return "create"; };
    await assert.rejects(cancelled.login(), /取消/);
    assert(!cancelled.calls.some(c => c.slot === "create"));
  }
});

test("malformed/duplicate key lists, missing secrets and interaction errors never produce credentials", async () => {
  for (const data of [undefined, {}, [{}], [{ name: BROWSER_KEY_NAME, apiKey: "../bad" }], [{ name: BROWSER_KEY_NAME, apiKey: "a" }, { name: BROWSER_KEY_NAME, apiKey: "b" }]]) {
    const f = browserFixture("cn"); f.responses.keys.data = data;
    await assert.rejects(f.login(), /列表无效|多个同名/);
    assert.equal(f.prompts.length, 0);
    assert(!f.calls.some(c => ["create", "copy"].includes(c.slot)));
  }
  for (const region of ["cn", "intl"] as const) for (const secretKey of [undefined, "", "***", "has space"]) {
    const f = browserFixture(region); f.responses.copy.data = { secretKey };
    await assert.rejects(f.login(), /完整推理凭据/);
  }
  const f = browserFixture("cn"); f.responses.keys.data = [];
  f.interaction.prompt = async () => { throw new Error("synthetic-zcode-session"); };
  await assert.rejects(f.login(), error => !String(error).includes("synthetic-zcode-session"));
  assert(!f.calls.some(c => c.slot === "create"));
});

test("catalog refresh uses fixed paid endpoint; failures retain cache; cache cannot inject URLs or headers", async () => {
  let fail = false;
  const r = await runtime("cn", fakeFetch((url, init) => {
    assert.equal(url, codingUrl("cn") + "/models");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer cn-test-id.cn-test-secret");
    return fail ? json({ msg: "cn-test-secret" }, 503) : json({ data: [{ id: "glm-4.7", baseUrl: "https://evil.invalid", headers: { Authorization: "injected" } }, { id: "future-model" }] });
  }));
  assert.equal((await r.models.refresh()).errors.size, 0);
  assert.deepEqual(r.provider.getModels().map(m => m.id), ["glm-4.7"]);
  assert.equal(r.status().unknown, 1);
  assert.equal(r.provider.getModels()[0].baseUrl, codingUrl("cn"));
  fail = true;
  assert.equal((await r.models.refresh()).errors.size, 1);
  assert.deepEqual(r.provider.getModels().map(m => m.id), ["glm-4.7"]);
  assert(!JSON.stringify(r.status()).includes("cn-test-secret"));
  assert.match(r.status().error!, /HTTP 503/);
  const stored = (await r.modelsStore.read(r.provider.id))!;
  await r.modelsStore.write(r.provider.id, { ...stored, models: stored.models.map(m => ({ ...m, baseUrl: "https://evil.invalid", headers: { Authorization: "injected" } })) });
  const restored = makeProvider("cn");
  r.models.setProvider(restored.provider);
  await r.models.refresh({ allowNetwork: false });
  assert.equal(restored.provider.getModels()[0].baseUrl, codingUrl("cn"));
  assert.equal(restored.provider.getModels()[0].headers, undefined);
  assert.match(restored.status().source, /缓存/);
  assert.equal((await r.modelsStore.read(REGIONS.intl.id)), undefined);
});

test("superseded refresh and cancellation never publish a late catalog", async () => {
  let first!: (value: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const r = await runtime("intl", fakeFetch(async () => {
    if (++calls === 1) { entered(); return new Promise<Response>(resolve => { first = resolve; }); }
    return json({ data: [{ id: "glm-4.7" }] });
  }));
  const old = r.models.refresh();
  await started;
  await r.models.refresh();
  first(json({ data: [] }));
  await old;
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(r.provider.getModels().map(m => m.id), ["glm-4.7"]);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await r.models.refresh({ signal: controller.signal })).aborted, true);
});

test("network boundary, redaction, business errors, CAPTCHA, malformed/oversized data", async () => {
  let calls = 0;
  const noCall = fakeFetch(() => { calls++; throw new Error("should not fetch"); });
  await assert.rejects(readJson("https://evil.invalid/", "secret", undefined, noCall));
  // host+path pairs: a known path on a foreign host must not be accepted
  await assert.rejects(readJson("https://open.bigmodel.cn/api/v1/client/configs", undefined, undefined, noCall));
  await assert.rejects(readJson(codingUrl("cn") + "/models", "bad\nkey", undefined, noCall));
  assert.equal(calls, 0);
  assert(!errorText(new Error("Bearer secret")).includes("secret"));
  for (const body of [{ success: false }, { code: 400 }, { error: { code: "invalid_key" } }]) {
    await assert.rejects(readJson(codingUrl("cn") + "/models", undefined, undefined, fakeFetch(() => json(body))), /业务失败/);
  }
  await assert.rejects(readJson(codingUrl("cn") + "/models", undefined, undefined, fakeFetch(() => json({ code: "captcha_required" }))), /官方验证/);
  await assert.rejects(readJson(codingUrl("cn") + "/models", undefined, undefined, fakeFetch(() => new Response("<html>login</html>"))), /JSON/);
  await assert.rejects(readJson(codingUrl("cn") + "/models", undefined, undefined, fakeFetch(() => new Response("x".repeat(1_048_577)))), /1 MiB/);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(readJson(codingUrl("cn") + "/models", undefined, cancelled.signal, noCall));
});

test("quota reports timestamps without equating unknown with zero or percentage with remaining", async () => {
  const report = await quotaReport("intl", "quota-key", undefined, fakeFetch((url, init) => {
    assert.equal(url, REGIONS.intl.origin + "/api/monitor/usage/quota/limit");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer quota-key");
    return json({ code: 200, success: true, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 25, nextResetTime: 1_800_000_000_000 }] } });
  }));
  assert.match(report, /percentage=25%，/u);
  assert.match(report, /2027-01-15T08:00:00.000Z/);
  assert.match(report, /不推断剩余额度/);
  await assert.rejects(quotaReport("cn", "key", undefined, fakeFetch(() => json({ data: {} }))), /未知/);
  await assert.rejects(quotaReport("cn", "key", undefined, fakeFetch(() => json({ data: { limits: [{ type: "X", percentage: -1 }] } }))), /无效/);
  assert.equal(timeText(1_800_000_000), timeText(1_800_000_000_000));
  assert.equal(timeText("bad"), "未知");
});

function sse(chunks: unknown[]): Response {
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}
test("native streaming preserves system, thinking, multi-turn tools, advertised image input, and paid routes", async t => {
  for (const region of ["cn", "intl"] as const) {
    const r = await runtime(region, fakeFetch(() => { throw new Error("no catalog call"); }));
    const model = r.provider.getModels().find(m => m.id === "glm-4.7")!;
    assert(model);
    const requests: Record<string, any>[] = [];
    const fetcher = fakeFetch(async (url, init) => {
      assert.equal(url, codingUrl(region) + "/chat/completions");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${region}-test-id.${region}-test-secret`);
      const body = JSON.parse(String(init.body)); requests.push(body);
      const delta = requests.length === 1
        ? { reasoning_content: "考量", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"x":1}' } }] }
        : { content: "已完成" };
      return sse([{ id: "reply", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason: null }] },
        { id: "reply", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }]);
    });
    const context: Context = { systemPrompt: "保留这个系统提示词", messages: [{ role: "user", content: "调用工具", timestamp: 1 }], tools: [{ name: "lookup", description: "test", parameters: Type.Object({ x: Type.Number() }) }] };
    const first = await r.models.completeSimple(model, context, { fetch: fetcher, reasoning: "high" });
    assert.equal(first.stopReason, "toolUse", first.errorMessage);
    const call = first.content.find(c => c.type === "toolCall"); assert(call && call.type === "toolCall");
    assert.deepEqual(call.arguments, { x: 1 });
    assert(first.content.some(c => c.type === "thinking"));
    context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "result" }], isError: false, timestamp: 2 });
    const second = await r.models.completeSimple(model, context, { fetch: fetcher, reasoning: "high" });
    assert.equal(second.stopReason, "stop", second.errorMessage);
    assert(requests.every(q => q.messages.some((m: any) => ["system", "developer"].includes(m.role) && m.content === context.systemPrompt)));
    assert(requests[1].messages.some((m: any) => m.role === "tool" && m.tool_call_id === call.id));
    assert(requests[1].messages.some((m: any) => m.role === "assistant" && m.tool_calls?.[0].function.name === "lookup"));
    assert.equal(requests[0].tools[0].function.name, "lookup");
    assert.equal(requests[0].thinking.type, "enabled");
    const controller = new AbortController(); controller.abort();
    const aborted = await r.models.completeSimple(model, context, { signal: controller.signal, fetch: fakeFetch(() => { throw new Error("cancelled request should not fetch"); }) });
    // Pi 0.85.0's lazy auth/setup errors use stopReason=error, including pre-abort.
    assert.equal(aborted.stopReason, "error");
    assert.match(aborted.errorMessage!, /aborted/i);
    const active = new AbortController();
    let reachedFetch = false;
    const cancelled = await r.models.completeSimple(model, context, {
      signal: active.signal,
      fetch: fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
        reachedFetch = true;
        init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        active.abort();
      })),
    });
    assert(reachedFetch);
    assert.equal(cancelled.stopReason, "aborted", cancelled.errorMessage);
    const vision = r.provider.getModels().find(m => m.input.includes("image"));
    if (vision) {
      const imageResult = await r.models.completeSimple(vision, { messages: [{ role: "user", timestamp: 1, content: [{ type: "text", text: "image" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHtYAAAAASUVORK5CYII=" }] }] }, { fetch: fetcher });
      assert.equal(imageResult.stopReason, "stop", imageResult.errorMessage);
      assert(requests.at(-1)!.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,iVBOR"))));
    } else t.diagnostic(`${region}: Pi's current catalog has no image-input model; image transport was not exercised.`);
  }
});

test("extension registration/status require no network; command arguments cannot carry credentials", async () => {
  const providers: string[] = [], commands: string[] = [], events: string[] = [];
  const handlers = new Map<string, any>();
  extension({ registerProvider: (p: any) => providers.push(p.id), registerCommand: (n: string, c: any) => { commands.push(n); handlers.set(n, c.handler); }, on: (n: string) => events.push(n) } as any);
  assert.deepEqual(providers, [REGIONS.cn.id, REGIONS.intl.id]);
  assert.deepEqual(commands, ["zcode-safe"]);
  assert.deepEqual([...new Set(events)], ["session_shutdown", "before_provider_headers"]);
  const notices: string[] = [];
  const ctx = { ui: { notify: (text: string) => notices.push(text) }, modelRegistry: {
    getProviderAuthStatus: () => ({ configured: true, label: "DO-NOT-PRINT-SECRET" }),
    getProvider: () => ({ baseUrl: codingUrl("cn") }),
    getProviderAuth: async () => undefined,
  } };
  await handlers.get("zcode-safe")("cn status", ctx);
  assert.match(notices.at(-1)!, /已配置（未验证）/);
  assert(!notices.at(-1)!.includes("DO-NOT-PRINT-SECRET"));
  await handlers.get("zcode-safe")("cn quota", ctx);
  assert.match(notices.at(-1)!, /未配置浏览器凭据/);
});

test("Start Plan reporting is read-only, requires a verifiable JWT and never claims blocked endpoints", async () => {
  const { planReport, planClaimUnavailable, verifiedZCodeJwt, errorText } = await import("./core.ts");
  const claim = "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ user_id: "72661775787316303", iat: Math.floor(Date.now() / 1000) }), "utf8").toString("base64url") + ".sig";
  assert.equal(verifiedZCodeJwt(claim), claim);
  for (const bad of ["short", "a.b", "a.b.c", "eyJhbGciOiJIUzI1NiJ9." + Buffer.from("{}").toString("base64url") + ".sig",
    "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ user_id: "abc", iat: 1 }), "utf8").toString("base64url") + ".sig",
    "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ user_id: "1", iat: Math.floor(Date.now() / 1000) - 40 * 86400 }), "utf8").toString("base64url") + ".sig"]) {
    assert.throws(() => verifiedZCodeJwt(bad), /令牌|JWT/, `accepted ${bad}`);
  }
  await assert.rejects(planReport(undefined), /登录令牌|ZCODE_JWT/);
  // The session JWT saved by browser login is used when no env override is set; anything else is ignored.
  const stored = { type: "oauth", access: "id.secret", refresh: "", expires: Number.MAX_SAFE_INTEGER, loginMethod: "zcode-browser", region: "cn", organizationId: "org", projectId: "proj", env: { [ZCODE_JWT_FIELD]: claim } } as never;
  assert.equal(planJwt(stored, undefined), claim);
  assert.equal(planJwt(stored, "override.jwt.x"), "override.jwt.x", "env override wins");
  assert.equal(planJwt(stored, "   "), claim, "blank override falls back to stored");
  assert.equal(planJwt({ ...stored, env: {} } as never, undefined), undefined);
  assert.equal(planJwt({ ...stored, env: { [ZCODE_JWT_FIELD]: 42 } } as never, undefined), undefined, "non-string ignored");
  assert.equal(planJwt({ ...stored, loginMethod: "other" } as never, undefined), undefined, "only browser-login credentials");
  assert.equal(planJwt({ type: "api_key", key: "k" } as never, undefined), undefined);
  assert.equal(planJwt(undefined, undefined), undefined);
  await assert.rejects(planReport(undefined, undefined, () => { throw new Error("must not fetch"); }), /登录令牌|ZCODE_JWT/);
  const urls: string[] = [], methods: string[] = [], bodies: (string | undefined)[] = [];
  const fetcher = fakeFetch((url, init) => {
    urls.push(url); methods.push(init.method ?? "GET"); bodies.push(init.body as string | undefined);
    return json({ code: 0, data: { balances: [{ show_name: "GLM-5.3", capabilities: ["model:glm-5.3"], total_units: 3_000_000, used_units: 750_000, period: "daily", plan_id: "zcode-v3-start-plan-0817" }] } });
  });
  const report = await planReport(claim, undefined, fetcher);
  assert.match(report, /GLM-5\.3.*glm-5\.3.*750000\/3000000.*75%/);
  assert.match(report, /只读/);
  assert.deepEqual(methods, ["GET"], "no writes: " + methods.join(","));
  assert.deepEqual(bodies, [undefined]);
  assert(urls.every(u => u === `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.11.2`), urls.join(" "));
  for (const shape of [{ code: 0, data: { balances: [{ show_name: "x", total_units: 1, used_units: 5 }] } }, { code: 0, data: { balances: [{ total_units: "3", used_units: 1 }] } }, { code: 1 }, { code: 0, data: { balances: new Array(101).fill({ total_units: 1, used_units: 0 }) } }]) {
    await assert.rejects(planReport(claim, undefined, fakeFetch(() => json(shape))), /格式|失败|过多/);
  }
  // An empty balance list is reported as unknown, never as zero or as "no plan".
  assert.match(await planReport(claim, undefined, fakeFetch(() => json({ code: 0, data: {} }))), /不代表/);
  await assert.rejects(planReport(claim, undefined, fakeFetch(() => new Response("{}", { status: 405 }))), /风控|状态未知/);
  await assert.rejects(planReport(claim, undefined, fakeFetch(() => new Response("<html>", { status: 200 }))), /状态未知/);
  assert.throws(() => planClaimUnavailable(), /尚未对真实服务端验证/);
  // The saved JWT only ever reaches the read-only balance endpoint; it is never used as a model key.
  assert.equal(browserKey("cn", stored), "id.secret");
  assert.match(errorText(new Error("x")), /状态未知/);
});

test("Start Plan bridge: parameter parsing, loopback round-trip, single-use header swap", async () => {
  const { CaptchaBridge, PLAN_KEY_MARKER, applyPlanHeaders, fetchCaptchaConfig, parseCaptchaParam, planBaseUrl, planKeyJwt, planModels } = await import("./plan.ts");
  const config = { region: "cn", prefix: "pfx", sceneId: "scene" };
  // Config parsing fails closed on anything but an enabled, well-shaped captcha config.
  for (const body of [{}, { data: { configs: { captcha: { enabled: false, region: "cn", prefix: "p", sceneId: "s" } } } }, { data: { configs: { captcha: { enabled: true } } } }, { data: { configs: { captcha: { enabled: true, region: 1, prefix: "p", sceneId: "s" } } } }]) {
    await assert.rejects(fetchCaptchaConfig("jwt", fakeFetch(() => json(body))), /配置/);
  }
  await assert.rejects(fetchCaptchaConfig("jwt", fakeFetch(() => new Response("{}", { status: 403 }))), /403/);
  const goodConfig = await fetchCaptchaConfig("jwt", fakeFetch((url, init) => {
    assert.equal(url, "https://zcode.z.ai/api/v1/client/configs?app_version=3.11.2&platform=linux-x64");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer jwt");
    return json({ data: { configs: { captcha: { enabled: true, region: "cn", prefix: "pfx", sceneId: "scene" } } } });
  }));
  assert.deepEqual(goodConfig, config);
  // Parameter structural validation: base64 JSON with certifyId, isSign, securityToken.
  const raw = (body: unknown) => Buffer.from(JSON.stringify(body), "utf8").toString("base64");
  const validParam = { certifyId: "abc12", sceneId: "scene", isSign: true, securityToken: "s".repeat(40) };
  const valid = parseCaptchaParam(raw(validParam));
  assert.equal(valid.certifyId, "abc12");
  for (const bad of ["", "not base64!", raw({ ...validParam, isSign: false }),
    raw({ ...validParam, certifyId: "no" }),
    raw({ certifyId: "abc12", isSign: true, securityToken: "s".repeat(40) }), raw({ ...validParam, sceneId: "" }),
    raw([{ certifyId: "abc12" }]), Buffer.from("plain text body", "utf8").toString("base64")]) {
    assert.throws(() => parseCaptchaParam(bad), /参数|certifyId|签名|sceneId|securityToken/, `accepted ${String(bad).slice(0, 30)}`);
  }
  // Models: anthropic API against the fixed plan gateway, zero cost, image+reasoning.
  const models = planModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].api, "anthropic-messages");
  assert.equal(models[0].baseUrl, planBaseUrl);
  assert.equal(models[0].provider, "zcode-plan");
  assert.deepEqual(models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert(models[0].input.includes("image") && models[0].reasoning);
  // Loopback bridge round-trip: page served, params queued once per certifyId, health reported.
  const bridge = new CaptchaBridge();
  const url = await bridge.start(config);
  const origin = new URL(url).origin;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const pageResponse = await loopbackFetch(url, { headers: { Connection: "close" } });
  assert.match(await pageResponse.text(), /initAliyunCaptcha/);
  assert.equal((await (await loopbackFetch(`${origin}/health`, { headers: { Connection: "close" } })).json()).queue, 0);
  await loopbackFetch(`${origin}/param`, { method: "POST", body: raw(validParam), headers: { Connection: "close" } });
  await loopbackFetch(`${origin}/param`, { method: "POST", body: raw(validParam), headers: { Connection: "close" } });
  assert.equal((await (await loopbackFetch(`${origin}/health`, { headers: { Connection: "close" } })).json()).queue, 1, "duplicate certifyId ignored");
  assert.equal(planKeyJwt(PLAN_KEY_MARKER + "session.jwt"), "session.jwt");
  assert.equal(planKeyJwt("sk-ant-oat-xyz"), undefined);
  assert.equal(planKeyJwt(PLAN_KEY_MARKER + ""), undefined);
  // Header swap consumes exactly one queued parameter and never leaves the marker behind.
  const headers: Record<string, string | null> = { "x-api-key": PLAN_KEY_MARKER + "session.jwt", accept: "application/json" };
  await applyPlanHeaders(headers, bridge);
  assert.equal(headers["x-api-key"], null);
  assert.equal(headers["authorization"], "Bearer session.jwt");
  assert.match(String(headers["X-Aliyun-Captcha-Verify-Param"]), /^eyJ/);
  assert.equal(headers["X-Aliyun-Captcha-Verify-Region"], "cn");
  assert.equal((await (await loopbackFetch(`${origin}/health`, { headers: { Connection: "close" } })).json()).served, 1);
  // Non-plan requests are untouched, and an empty queue times out instead of blocking forever.
  const untouched: Record<string, string | null> = { "x-api-key": "other-key" };
  await applyPlanHeaders(untouched, bridge);
  assert.equal(untouched["x-api-key"], "other-key");
  await assert.rejects(applyPlanHeaders({ "x-api-key": PLAN_KEY_MARKER + "session.jwt" }, bridge, 100), /超时/);
  // A JWT is required before anything starts.
  bridge.stop();
  const blocked = new CaptchaBridge();
  await blocked.take(50).catch(error => assert.match(String(error), /超时/));
});

test("Start Plan extension surface: opt-in commands register no model provider until enabled", async () => {
  const extension = (await import("./index.ts")).default;
  const providers: string[] = [], commands: string[] = [], events: string[] = [];
  const handlers = new Map<string, any>();
  extension({ registerProvider: (p: any) => providers.push(p.id), registerCommand: (n: string, c: any) => { commands.push(n); handlers.set(n, c.handler); }, on: (n: string, h: any) => { events.push(n); if (!handlers.has(`on:${n}`)) handlers.set(`on:${n}`, h); } } as any);
  assert.deepEqual(providers, [REGIONS.cn.id, REGIONS.intl.id], "the plan provider must not exist before /zcode-safe plan on");
  assert(events.includes("before_provider_headers"));
  const notices: string[] = [];
  const ctx = { ui: { notify: (text: string, level?: string) => notices.push(`${level ?? "info"}:${text}`) } };
  await handlers.get("zcode-safe")("plan status", ctx);
  assert.match(notices.at(-1)!, /未启用/);
  await handlers.get("zcode-safe")("plan on", ctx);
  assert.match(notices.at(-1)!, /登录令牌|ZCODE_JWT/);
  await handlers.get("zcode-safe")("plan off", ctx);
  assert.match(notices.at(-1)!, /停用/);
  await handlers.get("zcode-safe")("plan bogus", ctx);
  assert.match(notices.at(-1)!, /用法/);
  // The registered header hook must leave non-plan requests untouched while the plan is off.
  const headers = { "x-api-key": "other-provider-key" };
  await handlers.get("on:before_provider_headers")({ type: "before_provider_headers", headers });
  assert.equal(headers["x-api-key"], "other-provider-key");
});
