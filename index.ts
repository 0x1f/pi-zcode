import { readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REGIONS, ZCODE_JWT_ENV, codingUrl, errorText, makeProvider, planClaimUnavailable, planJwt, planReport, quotaReport, timeText, type Region } from "./core.ts";

export default function (pi: ExtensionAPI) {
  const providers = { cn: makeProvider("cn"), intl: makeProvider("intl") };
  for (const { provider } of Object.values(providers)) pi.registerProvider(provider);
  let pending: AbortController | undefined;
  const begin = () => {
    pending?.abort();
    return pending = new AbortController();
  };
  pi.on("session_shutdown", () => pending?.abort());
  pi.registerCommand("zcode-safe", {
    description: "浏览器登录的 Coding Plan：cn|intl status|refresh|quota；plan status|claim（Start Plan 只读）；cancel 取消诊断。",
    handler: async (args, ctx) => {
      if (args.trim() === "cancel") { pending?.abort(); ctx.ui.notify("已取消诊断请求。", "info"); return; }
      const [region, action, extra] = args.trim().split(/\s+/);
      if (region === "plan" && ["status", "claim"].includes(action) && !extra) {
        const controller = begin();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
        try {
          if (action === "claim") planClaimUnavailable();
          const jwt = planJwt(readStoredCredential("zcode-cn"), process.env[ZCODE_JWT_ENV]);
          ctx.ui.notify(await planReport(jwt, signal), "info");
        } catch (error) {
          if (!controller.signal.aborted) ctx.ui.notify(errorText(error), "warning");
        }
        return;
      }
      if ((region !== "cn" && region !== "intl") || !["status", "refresh", "quota"].includes(action) || extra) {
        ctx.ui.notify(`用法：/zcode-safe cn|intl status|refresh|quota；/zcode-safe plan status|claim；/zcode-safe cancel。登录请用 /login zcode-cn 或 /login zcode-intl，在浏览器授权。`, "warning");
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
