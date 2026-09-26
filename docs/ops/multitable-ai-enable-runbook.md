# 多维表「AI 自动填写」开通手册（管理员）

> 来源：客户反馈 2026-09-24 #7c（裁定见 PR #6074）。本手册只列环境变量**名称**与判定规则，不含任何主机、地址、模型名或密钥取值。

## 0. 先读：这是 owner 决定

- 为某个客户开通 AI = **owner 决定**：它会把客户记录内容发给一个模型，并改动生产部署配置，不能按 AGENTS.md 的「默认前进」处理。没有 owner 明确同意，不要改下面任何变量。
- 当前接管客户：owner 已决定**不开通**（PR #6074）。界面只显示一行「AI 自动填写未开通…」加「了解更多」，已保存的配置原样保留。

## 1. 什么情况下界面会出现 AI 功能

前端在进入多维表时调用一次 `GET /api/multitable/ai/availability`（任何已登录用户可调，只返回 `{ "available": true|false }`）。只有三个条件**同时**满足才返回 `true`：

1. 就绪（readiness）为 `ready`：开关、provider、模型、内网地址都配对了；
2. `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` 恰好为 `1`；
3. 数据分级路由放行：业务数据只能发往**可证明在内网**的模型。

返回 `false` 时，这些入口全部隐藏：字段设置里的 AI 配置区（收成一行说明）、管理员用量卡、记录详情里的「AI 预览 / AI 运行」、单元格编辑时的「运行 AI」、整列 AI 填充、公式 AI 建议。服务端的每一次 AI 请求仍会独立校验同样的条件，前端隐藏只是界面提示，不是放行。

## 2. 需要设置的环境变量（后端进程）

| 变量名 | 取值规则 |
| --- | --- |
| `MULTITABLE_AI_ENABLED` | 必须恰好是 `1` |
| `MULTITABLE_AI_PROVIDER` | `local-openai-compat`（内网自建的 OpenAI 兼容服务，如 vLLM / Ollama） |
| `MULTITABLE_AI_BASE_URL` | 内网模型服务的根地址（不带 `/v1`，客户端会拼 `/v1/chat/completions`）。主机必须可证明在内网：回环地址、RFC1918 私网地址、`.local` / `.internal` / `.lan` / `.home.arpa` 域名，或列在路由策略的 `localHosts` 里 |
| `MULTITABLE_AI_MODEL` | 内网服务上实际挂载的模型名（只允许 `A-Z a-z 0-9 . _ : / -`，≤200 字符，不能像密钥） |
| `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` | 必须恰好是 `1`（二次确认：只有 ready 不会放行真实调用） |
| `MULTITABLE_AI_API_KEY` | 可选。内网服务要求 token 时才设置，按 Bearer 发送 |
| `MULTITABLE_AI_ROUTING_POLICY` | 可选。路由策略 JSON 文件的路径。仅当模型主机是「看起来像公网」的域名时需要：文件里 `activeProvider.tier` 为 `local`，并在 `localHosts` 里写出该主机（精确主机名，不允许通配）。文件设置了却读不了或格式错误时，AI 一律关闭（fail-closed） |

限额（都有默认值，不设也可以）：

| 变量名 | 默认值 / 范围 |
| --- | --- |
| `MULTITABLE_AI_REQUEST_TIMEOUT_MS` | 15000，范围 1000–60000 |
| `MULTITABLE_AI_MAX_OUTPUT_TOKENS` | 1024，范围 64–4096 |
| `MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP` | 100000，最小 1000 |
| `MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP` | 500000 |
| `MULTITABLE_AI_TENANT_BURST_RPM` | 30（每用户每分钟请求数） |
| `MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP` | 10（内网模型按 0 美元计价，token 仍计量） |

改完变量需重启后端；用户刷新页面后生效（前端每次进入多维表读一次可用性）。

## 3. 按设计禁止：公有云 AI

`anthropic` / `openai` 指向公有云时（未设 `MULTITABLE_AI_BASE_URL` 即走其默认公网端点，或设置的主机不能证明在内网），即使密钥、模型都配好、readiness 显示 `ready`，可用性也**始终是 `false`**：这个功能的提示词由客户记录内容拼成，属于业务数据，路由规则禁止业务数据发往云端模型。路由策略也无法放开：在 `cloudDataClasses` 里写 `business` 会被判为配置错误，整个策略失效并关闭 AI。内网部署请用第 2 节的 `local-openai-compat`。

## 4. 如何验证

在与后端**相同的环境变量**下依次检查：

1. `pnpm verify:multitable-ai:readiness` —— 退出码 `0` 表示 ready，`2` 表示 disabled / blocked（报告写在 `output/multitable-ai-readiness-gate/`，不含密钥与地址取值；本地模型名会原样出现）。这一步只检查就绪，不检查第 1 节的第 2、3 条。
2. 管理员调用 `GET /api/multitable/ai/readiness`：`status` 应为 `ready`，`messages` 会逐条说明缺什么。
3. 任一普通用户调用 `GET /api/multitable/ai/availability`：应返回 `{ "available": true }`。这一步把三个条件一起检查；返回 `false` 时回到第 2 步看 readiness 消息，并核对 `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` 与路由策略。

三步都不会调用模型。

## 5. 关闭

删除 `MULTITABLE_AI_ENABLED` 或 `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`（或改成非 `1`）并重启后端。界面随即收起所有 AI 入口；字段上已保存的 AI 配置不会被删除，重新开通后继续生效。
