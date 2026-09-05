# pi-zcode

独立维护的非官方 Pi 扩展，提供 **ZCode 账号浏览器登录**。不是 npm 上的同名 `pi-zcode` 包；请只使用本目录，不要执行 `pi install npm:pi-zcode` 来安装这一版本。`private: true` 防止误发布。

## 安装与登录

从本项目的 GitHub 仓库安装：

```bash
pi install git:github.com/0x1f/pi-zcode
```

重启 Pi 或运行 `/reload` 后登录。仅临时试用时，可以运行：

```bash
pi -e git:github.com/0x1f/pi-zcode
```

在 Pi 中选择一个地区登录：

```text
/login zcode-cn
/login zcode-intl
```

- `zcode-cn`：国内 BigModel 账号。
- `zcode-intl`：国际 Z.ai 账号。

登录步骤：

1. Pi 显示授权链接并尝试打开官方浏览器页面；打不开时，可以手动打开该链接。请勿分享一次性授权链接。
2. 在官方页面登录并授权。密码和验证码只在官方页面处理，不需要向 Pi 粘贴令牌、授权码或 API key。
3. Pi 等待授权结果；有多个可用机构或项目时，通过文字选择列表确认目标。
4. 扩展只复用所选项目中名为 `pi-zcode` 的推理 key，不复制其他 key 的 secret。没有该 key 时，**必须明确选择“允许创建”才会新建长期 key，默认是“取消，不创建”**。
5. 完成后，用 `/model` 选择对应 provider 的模型。

按 Escape 可取消 Pi 中的登录。浏览器授权本身不等于拥有 Coding Plan 权限，最终仍以账号订阅为准。

### 从旧版迁移

v0.3.0 移除了插件的手动 API key 登录和环境变量入口。旧 `api_key` 记录、`ZCODE_SAFE_CN_API_KEY`、`ZCODE_SAFE_INTL_API_KEY` 不再用于本扩展；不会自动转换旧记录或回退到其他 provider 的凭据。

旧版用户可先在 `/logout` 中选择相应 `zcode-*` provider，再重新浏览器登录。已经以此路径加载的会话可以 `/reload`；未加载的扩展不会仅因文件存在就出现在登录菜单中。

只想使用已有 API key 的用户，请使用 Pi 内置的 `zai` / `zai-coding-cn`，不要通过本扩展重复配置。**不要将凭据写进聊天、斜杠命令参数或有历史记录的 shell 命令。**

本地开发可用 `pi -e ./index.ts` 显式加载源码；不要把长期安装指向临时目录。

## 凭据与副作用

- 浏览器授权通过 ZCode CLI OAuth 服务完成；回调由官方服务器接收，不运行本地回调服务器、不读取浏览器 Cookie 或桌面凭据。
- 浏览器登录后，在对应地区的账号业务接口取得推理 key。国内业务接口使用 BigModel 业务令牌，国际账号先进行 Z.ai 业务令牌交换；两区不混用令牌，也不把登录令牌直接当作模型 key。
- Pi 按 `zcode-cn` / `zcode-intl` 保存原生 OAuth 类型记录，其中 `access` 是后台取得的长期模型 key。poll 响应里的 ZCode 会话 JWT 保存在同一凭据的 `env.zcodeJwt`，只供 `plan status` 只读余额查询使用，永远不会被当作模型 key；临时业务令牌不持久化。
- 本地长期 key 记录不安排 OAuth 刷新；没有编造刷新接口、刷新令牌或静默环境变量回退。失效后需要重新浏览器登录，服务器是否接受该 key 仍以实际请求为准。
- **`/logout` 只删除本地记录，不撤销服务器上的 key。** 停用时请到相应官方平台撤销。Pi 凭据文件不是系统密钥链；有宿主权限的扩展仍能读取它。
- 新建 key 只提交一次，不自动重试。即使网络中断或后续步骤失败，服务器也可能已经创建了 key，请到官方平台检查 `pi-zcode`。
- key 列表无效、存在多个同名 key、缺少完整 secret 时直接停止；不把查询失败理解成“没有 key”，不自动建项目或复制其他应用的 key。

## 推理范围

复用 Pi **0.85.0** 的原生 OpenAI Completions 实现，保留系统提示词、思考、多轮工具调用、已知模型的图片输入能力及原生取消行为。无新增运行时依赖、安装脚本、自动更新或后台签到任务。

固定使用付费 Coding Plan 目标：

```text
cn:   https://open.bigmodel.cn/api/coding/paas/v4
intl: https://api.z.ai/api/coding/paas/v4
```

不会自动切换到普通按量计费端点、另一个地区或免费计划。**Pi 显示零 token 成本不代表服务端免费**，请以订阅、官方控制台和账单为准。

免费 Start Plan（体验套餐）的权益和领取只保留**只读查询**，自动领取和推理接入均不实现，详见下节。

## 诊断命令

```text
/zcode-safe cn status
/zcode-safe intl status
/zcode-safe cn refresh
/zcode-safe intl refresh
/zcode-safe cn quota
/zcode-safe intl quota
/zcode-safe plan status
/zcode-safe plan claim
/zcode-safe cancel
```

- `status` 不联网，显示认证是否配置、目录来源、最后成功时间、模型数和端点。“已配置”不代表服务器已验证有效。
- `refresh` 只读查询对应 Coding Plan 的 `/models`。404、权限拒绝或格式错误会保留最后成功目录并显示错误。Pi 自身允许联网的目录刷新也可能触发此请求。
- 目录仅消费模型 ID；端点、头部、能力重新取 Pi 内置目录。未知模型不猜测参数，需更新 Pi。缓存按地区隔离，不是个人订阅授权证明；换账号后应主动刷新。
- `quota` 只读查询 `/api/monitor/usage/quota/limit`；当前推理凭据可能无权访问。失败显示未知，不按零处理。服务端 `percentage` 原样展示，不推断剩余比例；可解析的时间转为 UTC。
- `plan status` 只读查询 ZCode Start Plan 余额。JWT 优先从 `/login zcode-cn` 保存的浏览器凭据读取（服务端 poll 响应同时下发业务 token 与会话 JWT，扩展自 v0.3.1 起把 JWT 存在凭据 `env.zcodeJwt` 里，仅用于本只读查询）；也可用 `ZCODE_JWT` 覆盖。可选 `ZCODE_DEVICE_MID`（本机 UUID，缺失时服务端会返回 400）。JWT 只做结构与签发时间检查，不本地验签。输出带模型 ID、已用/总量和周期，空列表显示“不代表没有套餐”，不按零处理。
- `plan claim` 明确不可用：领取接口未对真实服务端验证，且受阿里云验证码保护。请在官方客户端 <https://zcode.z.ai/> 领取，本扩展不自动签到、不处理验证码。
- `cancel` 取消扩展的诊断或刷新；新诊断会取消旧诊断。登录和推理取消由 Pi 控制。

### Start Plan 额度为什么不能在 Pi 里直接用

实测结论（`zcode.z.ai` 真实响应）：Start Plan 额度**只在官方 ZCode 网关结算**——模型端点 `/api/v1/zcode-plan/anthropic/v1/messages` 要求阿里云验证码（无凭证返回 `3007 captcha verify failed`）并叠加客户端请求签名（`X-Client-Sig` 对 `apiKeyId ts clientVersion sessionId nonce` 签名 + `X-Client-Pow` 工作量证明，私钥由 `/api/paas/c1f3a7e2/v2/client` 下发）。用本扩展的 Coding API key 直连 `glm-5.3` 可正常推理，但**Start Plan 余额不变**（实测 81 tokens 消耗后三条余额均为 0）。这两层是官方的反滥用设计；绕过验证码或复刻客户端签名不在本扩展范围内。想在 Pi 里用 GLM-5.3，请走已授权的 Coding Plan key（按订阅计费）。

自有认证、诊断请求限制 HTTPS 目标及方法/路径，拒绝重定向、使用 15 秒单次超时和 1 MiB 正文上限。登录期间按服务端间隔短暂轮询，最多等待五分钟；没有常驻轮询任务。遇到验证码挑战时仅提示官方处理，不下载脚本、不提交证明、不自动重放受保护请求。

诊断不输出凭据或原始服务端错误正文，也不把查询结果写入模型上下文。Pi 的 `models.json` 和其他扩展仍可能覆盖推理端点或头部；不要配置不可信覆盖。原生推理传输由 Pi 决定，上述请求限制不是整个 Pi 进程的网络沙箱。

## 验证

已在 Node **26.8.1**、Pi **0.85.0** 验证：

```bash
cd pi-zcode
node --test test.ts
node smoke.mjs /absolute/path/to/pi/dist/bundle/cli.js --ui
```

- `test.ts`：14 项离线测试，使用显式模拟传输、内存凭据和目录存储。覆盖双区浏览器流程、轮询绑定、回调约束、取消、创建确认、异常列表/secret、旧凭据拒绝、缓存竞态、额度诊断，以及原生流式协议。
- `smoke.mjs`：使用空 HOME/配置和虚构 OAuth 记录加载实际打包 CLI。`--ui` 额外验证两个原生登录入口、浏览器授权文字、长期 key 确认和默认取消；浏览器启动由无副作用的替身拦截，不保存登录凭据。
- Smoke 需要 Linux `unshare`（允许用户/网络命名空间）；`--ui` 还需要 Python 3。**实际 CLI 在禁网命名空间中运行**，隔离不可用时测试失败，不降级到联网执行。Pi 启动会替换全局 fetch，因此仅靠 preload 禁用 fetch 不可靠；UI mock 在扩展注册时安装，并核对请求记录。
- TypeScript **5.9.3** 的 `--strict --noEmit` 检查通过（`skipLibCheck` 跳过第三方声明检查）。编译器通过隔离的临时工具目录取得，未添加项目依赖或运行安装脚本。

直接用 Node 运行测试时，开发环境需要能解析相同版本的 Pi peer 包。`node_modules` 不应提交到仓库；不要为测试下载 npm 的同名 `pi-zcode`。

Pi 0.85.0 在认证/惰性初始化阶段预取消时返回 `stopReason=error` 及 aborted 信息，但不联网；请求中的取消返回 `aborted`。没有为更改标签而重写流式实现。

**验证限制：** 完整账号授权、真实 key 获取/创建、订阅权限、真实推理和计费均未验证。协议依据官方客户端静态证据及未登录的初始化检查；CLI 回调不同于桌面回调，集成仍依赖服务端行为，接口变化时会报错停止。界面测试通过不等于真实账号登录成功。
