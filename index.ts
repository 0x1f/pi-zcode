import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, lazyApi } from "@earendil-works/pi-ai";
import { DiagnosticError, REGIONS, ZCODE_JWT_ENV, codingUrl, errorText, makeProvider, planClaimUnavailable, planJwt, planReport, quotaReport, timeText, type Region } from "./core.ts";
import { CaptchaBridge, PLAN_KEY_MARKER, PLAN_MODEL_ID, applyPlanHeaders, fetchCaptchaConfig, planBaseUrl, planModels } from "./plan.ts";

export default function (pi: ExtensionAPI) {
  const providers = { cn: makeProvider("cn"), intl: makeProvider("intl") };
  for (const { provider } of Object.values(providers)) pi.registerProvider(provider);
  let pending: AbortController | undefined;
  const begin = () => {
    pending?.abort();
    return pending = new AbortController();
  };
  pi.on("session_shutdown", () => pending?.abort());

  // ---------- Free Start Plan (opt-in; local captcha bridge in the user's own browser) ----------
  const bridge = new CaptchaBridge();
  let planState: "off" | "starting" | "on" | "error" = "off";
  let planError = "";
  let planProviderRegistered = false;
  let planJwtValue = "";
  pi.on("session_shutdown", () => bridge.stop());
  // Per-request transport: the plan provider marks its requests via x-api-key; this swaps the
  // marker for the gateway header set plus one fresh single-use captcha parameter per request.
  pi.on("before_provider_headers", async event => {
    if (planState === "on") await applyPlanHeaders(event.headers, bridge);
  });
  /** Plan provider factory: Anthropic protocol against the Start Plan gateway. The x-api-key
   * marker is swapped per request by the before_provider_headers hook in the extension body. */
  function makePlanProvider() {
    return createProvider({
      id: "zcode-plan",
      name: "ZCode Start Plan 🆓",
      baseUrl: planBaseUrl,
      models: planModels(),
      api: lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages") as never) as never,
      fetchModels: async () => [],
      auth: {
        oauth: {
          name: "ZCode Start Plan（免费额度）",
          isSubscription: true,
          loginLabel: "使用已登录的 ZCode 会话（/zcode-safe plan on 启用）",
          async login() { throw new Error("Start Plan 不需要单独登录：先 /login zcode-cn，再 /zcode-safe plan on。"); },
          async refresh() { throw new Error("Start Plan 凭据跟随主登录；请重新 /login zcode-cn。"); },
          async toAuth() {
            if (planState !== "on") throw new Error("Start Plan 未启用：请先运行 /zcode-safe plan on 并在浏览器打开桥接页面。");
            return { apiKey: `${PLAN_KEY_MARKER}${planJwtValue}` };
          },
        },
      },
    });
  }
  const startPlan = async (): Promise<string> => {
    const jwt = planJwt(readStoredCredential("zcode-cn"), process.env[ZCODE_JWT_ENV]);
    if (!jwt) throw new DiagnosticError(`未找到 ZCode 登录令牌；请先 /login zcode-cn，或设置 ${ZCODE_JWT_ENV}。`);
    const config = await fetchCaptchaConfig(jwt, fetch);
    const url = await bridge.start(config);
    planJwtValue = jwt;
    if (!planProviderRegistered) {
      pi.registerProvider(makePlanProvider());
      planProviderRegistered = true;
    }
    planState = "on";
    return `Start Plan 已启用。请在浏览器打开桥接页面：${url}\n模型：/model zcode-plan/${PLAN_MODEL_ID}（🆓 限免额度）。保持页面打开：验证码由你自己的浏览器无感完成，弹挑战时需手动处理一次。`;
  };
  const stopPlan = () => {
    bridge.stop();
    planState = "off";
    return "Start Plan 已停用；桥接服务已关闭。";
  };
  const planStatus = () => [
    `Start Plan：${planState === "on" ? "已启用" : planState === "starting" ? "启动中" : planState === "error" ? `失败：${planError}` : "未启用"}`,
    bridge.status(),
    planState === "on" ? `模型：zcode-plan/${PLAN_MODEL_ID}（🆓）· 每个请求消耗一个一次性验证码参数。` : "运行 /zcode-safe plan on 启用（需要浏览器打开桥接页面）。",
  ].join("\n");
  pi.registerCommand("zcode-safe", {
    description: "浏览器登录的 Coding Plan：cn|intl status|refresh|quota；plan on|off|status|claim（Start Plan 免费额度）；cancel 取消诊断。",
    handler: async (args, ctx) => {
      if (args.trim() === "cancel") { pending?.abort(); ctx.ui.notify("已取消诊断请求。", "info"); return; }
      const [region, action, extra] = args.trim().split(/\s+/);
      if (region === "plan") {
        const controller = begin();
        try {
          if (action === "on" && !extra) {
            planState = "starting";
            ctx.ui.notify(await startPlan(), "info");
          } else if (action === "off" && !extra) {
            ctx.ui.notify(stopPlan(), "info");
          } else if (action === "status" && !extra) {
            ctx.ui.notify(planStatus(), "info");
          } else if (action === "claim" && !extra) {
            planClaimUnavailable();
          } else {
            ctx.ui.notify("用法：/zcode-safe plan on|off|status|claim", "warning");
          }
        } catch (error) {
          planState = "error";
          planError = errorText(error);
          if (!controller.signal.aborted) ctx.ui.notify(planError, "warning");
        }
        return;
      }
      if ((region !== "cn" && region !== "intl") || !["status", "refresh", "quota"].includes(action) || extra) {
        ctx.ui.notify(`用法：/zcode-safe cn|intl status|refresh|quota；/zcode-safe plan on|off|status|claim；/zcode-safe cancel。登录请用 /login zcode-cn 或 /login zcode-intl，在浏览器授权。`, "warning");
        return;
      }
      const controller = begin();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
      const { id } = REGIONS[region as Region];
      try {
        if (action === "refresh") {
          const result = await ctx.modelRegistry.refresh({ providers: [id], allowNetwork: true, force: true, signal });
          if (result.aborted) return;
          const error = result.errors.get(id);
          if (error) throw error;
          if (!controller.signal.aborted) ctx.ui.notify("刷新流程结束；未配置凭据时不会联网。用 status 查看来源及最后成功时间。", "info");
          return;
        }
        if (action === "status") {
          const status = providers[region].status();
          const authStatus = ctx.modelRegistry.getProviderAuthStatus(id);
          const effective = ctx.model?.provider === id ? ctx.model.baseUrl : ctx.modelRegistry.getProvider(id)?.baseUrl;
          ctx.ui.notify([
            `${id}: ${status.source}，${status.count} 个模型；认证状态：${authStatus.configured ? "已配置（未验证）" : "未配置"}`,
            `最后成功查询：${timeText(status.checkedAt)}；未识别模型：${status.unknown ?? "未知"}`,
            `固定付费目标：${codingUrl(region)}；有效端点：${effective ?? "未知"}`,
            `登录方式：/login ${id} 在浏览器授权；不接受手动 API key 或环境变量，国内/国际互不回退。`,
            status.error ?? "缓存/目录不保证账号授权；Pi 显示零成本不代表免费。",
          ].join("\n"), status.error ? "warning" : "info");
          return;
        }
        const resolved = await ctx.modelRegistry.getProviderAuth(id);
        signal.throwIfAborted();
        if (!resolved?.auth.apiKey) { ctx.ui.notify(`未配置浏览器凭据，请 /login ${id} 完成授权。`, "warning"); return; }
        if (resolved.auth.baseUrl && resolved.auth.baseUrl !== codingUrl(region)) {
          ctx.ui.notify("检测到认证端点覆盖；为避免错发凭据，未查询额度。", "warning"); return;
        }
        const report = await quotaReport(region, resolved.auth.apiKey, signal);
        if (!controller.signal.aborted) ctx.ui.notify(report, "info");
      } catch (error) {
        if (!controller.signal.aborted) ctx.ui.notify(errorText(error), "warning");
      }
    },
  });
}
