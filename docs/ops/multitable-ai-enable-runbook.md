# 多维表「AI 自动填写」开通手册（管理员）

> 来源：客户反馈 2026-09-24 #7c（客户反馈分诊，docs PR #6074）。本手册只列环境变量**名称**、判定规则和占位示例，不含任何真实主机、地址、模型名或密钥取值。

## 0. 先读：这是 owner 决定

- 为某个客户开通 AI = **owner 决定**：它会把客户记录内容发给一个模型，并改动生产部署配置，不能按 AGENTS.md 的「默认前进」处理。没有 owner 明确同意，不要改下面任何变量。
- **改路由策略文件（尤其是 `localHosts`）同样是 owner 决定**：它决定记录内容可以发往哪台主机（见第 3 节）。
- 当前接管客户：owner 已决定**不开通**（见客户反馈分诊 docs PR #6074）。界面只显示一行「AI 自动填写未开通…」加「了解更多」。字段上已保存的 AI 配置会保留、不会被删除；但和以往一样，每次保存该字段时配置会按规范形式重写（去掉已删除的来源字段和当前任务类型用不到的参数）。

## 1. 什么情况下界面会出现 AI 功能

前端在进入多维表时调用一次 `GET /api/multitable/ai/availability`（任何已登录用户可调，只返回 `{ "available": true|false }`）。只有三个条件**同时**满足才返回 `true`：

1. 就绪（readiness）为 `ready`：开关、provider、模型、内网地址都配对了；
2. `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` 恰好为 `1`；
3. 数据分级路由放行：业务数据只发往**可证明在内网**的模型（判定规则见第 3 节）。

不是 `true` 时，这些入口全部隐藏：字段设置里的 AI 配置区（收成一行说明）、管理员用量卡、记录详情里的「AI 预览 / AI 运行」、表格单元格编辑时的「运行 AI」、整列 AI 填充、公式 AI 建议。那一行说明的措辞：

- 服务端明确返回 `false` → 「AI 自动填写未开通：…」；
- 请求失败（网络或 5xx 会在短暂等待后重试一次；旧后端 404、登录过期 401 等不重试）→ 同样隐藏，但只显示「AI 状态暂时无法确认…」，不声称未开通。

开通后，写入只来自三种**手动**操作：记录详情里点「AI 运行」、表格单元格编辑时点「运行 AI」、整列 AI 填充预览后确认。「预览」是一次真实的模型调用（消耗配额），但不写入数据。服务端的每一次 AI 请求仍会独立校验同样的条件；前端隐藏只是界面提示，不是放行。

## 2. 需要设置的环境变量（后端进程）

| 变量名 | 取值规则 |
| --- | --- |
| `MULTITABLE_AI_ENABLED` | 必须恰好是 `1` |
| `MULTITABLE_AI_PROVIDER` | `local-openai-compat`（内网自建的 OpenAI 兼容服务，如 vLLM / Ollama） |
| `MULTITABLE_AI_BASE_URL` | 内网模型服务的根地址（不带 `/v1`，客户端会拼 `/v1/chat/completions`）。主机必须可证明在内网：回环地址、私网地址（RFC1918 等不可公网路由的地址）、以 `.local` / `.internal` / `.lan` / `.home.arpa` 结尾的域名；其他主机名只能通过路由策略的 `localHosts` 登记（第 3 节，owner 决定） |
| `MULTITABLE_AI_MODEL` | 内网服务上实际挂载的模型名（只允许 `A-Z a-z 0-9 . _ : / -`，≤200 字符，不能像密钥） |
| `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` | 必须恰好是 `1`（二次确认：只有 ready 不会放行真实调用） |
| `MULTITABLE_AI_API_KEY` | 可选。内网服务要求 token 时才设置，按 Bearer 发送 |
| `MULTITABLE_AI_ROUTING_POLICY` | 可选。路由策略 JSON 文件的路径，格式见第 3 节。设置了却读不了或格式不合法时，AI 一律关闭（fail-closed） |

限额（都有默认值，不设也可以）：

| 变量名 | 默认值 / 范围 |
| --- | --- |
| `MULTITABLE_AI_REQUEST_TIMEOUT_MS` | 15000，范围 1000–60000 |
| `MULTITABLE_AI_MAX_OUTPUT_TOKENS` | 1024，范围 64–4096 |
| `MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP` | 100000，最小 1000 |
| `MULTITABLE_AI_TENANT_WEEKLY_TOKEN_CAP` | 500000 |
| `MULTITABLE_AI_TENANT_BURST_RPM` | 30（每用户每分钟请求数） |
| `MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP` | 10（内网模型按 0 美元计价，token 仍计量） |

改完变量需重启后端。已打开的页面不会自动变化：前端每次进入多维表只读一次可用性，用户刷新页面后才生效。

## 3. 路由策略文件（可选；改动是 owner 决定）

只有当内网模型服务的主机名不属于第 2 节列出的内网形式（例如一个公网形式的内部域名）时才需要。文件是一个 JSON 对象，**顶层只允许下面五个键**，出现任何其他键（包括拼写错误）整份策略判为无效，AI 随即关闭：

| 键 | 规则 |
| --- | --- |
| `policyId` | 必填，非空字符串 |
| `policyVersion` | 必填，正整数 |
| `activeProvider` | 必填，对象，只允许一个键 `tier`，值为 `"local"` 或 `"cloud"` |
| `localHosts` | 本场景必填。主机名数组：精确匹配（不区分大小写），不允许 `*`、`/`、`://`、`@`，不得重复 |
| `cloudDataClasses` | 可选，只能写 `"non-sensitive"`；写 `"business"` 判为配置错误。本功能的数据恒为业务数据，这个键对它不起作用 |

最小示例（占位主机，替换为实际内网主机名；`MULTITABLE_AI_BASE_URL` 的主机必须与之**完全一致**）：

```json
{
  "policyId": "intranet-llm",
  "policyVersion": 1,
  "activeProvider": { "tier": "local" },
  "localHosts": ["llm.intranet.example"]
}
```

**警告：`localHosts` 里的主机会被直接当作内网，先于其他任何判断。** 只能写客户自己内网的模型服务主机；**绝不能**写第三方或公网主机（例如任何云 AI 厂商的 API 域名）——那样会让第 4 节的云端禁令失效，记录内容会被发送到内网之外。

## 4. 默认禁止：公有云 AI

`anthropic` / `openai` 指向公有云时（未设 `MULTITABLE_AI_BASE_URL` 即走其默认公网端点，或设置的主机不能证明在内网），即使密钥、模型都配好、readiness 显示 `ready`，可用性也是 `false`：这个功能的提示词由客户记录内容拼成，属于业务数据，路由规则禁止业务数据发往云端模型。`cloudDataClasses` 放不开这条禁令（写 `business` 即配置错误，整个策略失效并关闭 AI）。

**唯一的例外就是第 3 节的 `localHosts`**：把某个主机写进去，它就被当作内网。所以这条禁令成立的前提是 `localHosts` 里只有客户自己的内网主机。内网部署请用第 2 节的 `local-openai-compat`。

## 5. 如何验证

在与后端**相同的环境变量**下依次检查：

1. `pnpm verify:multitable-ai:readiness` —— 退出码 `0` 表示 ready，`2` 表示 disabled / blocked（报告写在 `output/multitable-ai-readiness-gate/`，不含密钥与地址取值；本地模型名会原样出现）。这一步只检查就绪，不检查第 1 节的第 2、3 条。
2. 管理员调用 `GET /api/multitable/ai/readiness`：`status` 应为 `ready`，`messages` 会逐条说明缺什么。
3. 任一普通用户调用 `GET /api/multitable/ai/availability`：应返回 `{ "available": true }`。这一步把三个条件一起检查；返回 `false` 时回到第 2 步看 readiness 消息，并核对 `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` 与路由策略。

三步都不会调用模型。

## 6. 关闭

删除 `MULTITABLE_AI_ENABLED` 或 `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`（或改成非 `1`）并重启后端。服务端立即拒绝新的 AI 请求；已打开的页面在用户刷新前仍会显示 AI 入口（点了会提示「AI 能力未启用或未就绪，请联系管理员」），刷新后才收起。字段上已保存的 AI 配置不会被删除，重新开通后继续生效。
