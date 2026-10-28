# 宜搭：owner「测试连接」—— 初始化前只换一次令牌、不写表单、不落库的授权边界与开关（ADR 2026-10-28）

> **状态**：草稿 v2（并入备料会话 r1 评审）。owner 2026-10-28 对「先出授权边界 ADR，再出一个由 owner 运行、只换令牌、不写表单的测试连接代码 PR」回复「同意」；本 ADR 即第一步。标「T 层默认」的条目按章程默认前进、owner 24h 内可否决。
> **线别**：属于 R-50 解封的宜搭交付项（#6315）的 owner 批准延伸，不算第三条线。
> **基线**：main `929315933`（`929315933ecef4c815d3d98ce38db2719a204611`）。下文所有 `path:line` 都在这个提交上核过；它与 onprem-r75（`2cda91b17`）在宜搭源码、路由、迁移与前端路径上逐字节一致（两提交之间这些路径的 `git diff --stat` 为空）。新增文件（PR A）只写路径、不写行号。合并前若 main 已前进，按章程 rebase 后重核行号。已 rebase 到 main `5d6eedfd7`：`929315933..5d6eedfd7` 只改 `apps/web` 的多维表与项目同步文件，下文引用的路径都不在其中，行号不变。r1 评审修订新增的引用若不在 `929315933` 上，逐条标 `@提交`（`88cdeb059` = PR A 的评审头，`763a559dc` = onprem-r76）；PR A 正按本版裁决修改，新增的代码性质只引裁决、不引行号。
> **values-free**：不含主机、地址、口令、appKey、appSecret、令牌或任何客户值，只指位置。
> **关联**：R-50（#6315 解封与七条宜搭决策）、R-64（本 ADR 的登记行）、R75 发布说明草稿 §六（「没有测试连接」；R76 = onprem-r76 `763a559dc` 同样未带本切片）、`.github/PULL_REQUEST_TEMPLATE.md:62-68`（新端点与授权边界变更须独立决策文档、独立 PR）。
> **来源**：owner 2026-10-27 问「测试机中可以填写宜搭的信息并可进行连接测试么」；2026-10-28 回复「同意」（ADR 先行 + 只换令牌不写表单的测试连接代码 PR）。设计经两份独立设计、一次裁决与一次反驳评审收敛（反驳评审结论：方案成立、需修订，1 个阻断项已并入 §2 ⑦ 与 §3）；之后备料会话 r1 评审（六个镜头 + 反驳者，结论 OK），次要项与细节项已并入本版。

**裁决记录**

| # | 问题 | 裁决 | 层 | 落在哪里 |
|---|---|---|---|---|
| Q1 | 要不要在初始化之前就能验证 | 是。先做「候选模式」：初始化之前测试本页粘贴的 appKey/appSecret；「已存模式」（测试已封存的第 1 代凭据）作为后续 PR B | owner 批准路径（2026-10-28） | §0、§2、§10 |
| Q2 | 用哪个开关 | 新开关 `INTEGRATION_YIDA_CONNECTION_TEST_ENABLED`，不复用发送开关 `INTEGRATION_YIDA_OWNER_SEND_ENABLED` | owner 批准路径 | §2 ③、§8 |
| Q3 | 落不落库 | 不落库、不加迁移、不写审计行 | T 层默认 | §2 ⑤、§8 |
| Q4 | 「凭据填错后重新初始化」 | 不在本 ADR；另立 ADR | T 层默认 | §9 |
| Q5 | 结果分几类 | 四类（ok / upstream_rejected / unreachable / timeout）；不改换令牌模块 | T 层默认 | §6 |
| Q6 | 限流 | 每进程同时最多 1 次 + 5 秒冷却；只有通过授权的调用者才会碰到在途名额与冷却（授权前的 `MAX_RUNS` 上限沿用既有运行时，见 §2 ⑦） | T 层默认 | §2 ⑦ |
| Q7 | 开关危险等级 | `danger: 'high'`（与发送开关相同） | T 层默认 | §8 |
| Q8 | 测试机上开关怎么开关 | 每次切换都是一次后端重启 / 重建；推荐 (b) 的事件界定变体：随上机安装的重启置 `true`，L4 成功后的第一次重启置回未设，L3 放弃即关，可加日历兜底；备选 (a) 每个验证窗口切两次 | 推荐值；L2 仍是 O 层另批，owner 批 L2 时确认并记入登记册 | §8、§11 |
| Q9 | 起始窗口 | 自 `execute()` 入口起 2 秒内没开始换令牌即 503 UNAVAILABLE、零出网、不盖冷却章（`YIDA_CONNECTION_TEST_START_WINDOW_MS`） | T 层默认 | §2 ⑦ ⑧ |

---

## 0. 为什么

1. **R75 只允许填一次凭据。** `integration_yida_initializations.credential_generation` 被 `CHECK (credential_generation = 1)` 锁死（`packages/core-backend/migrations/096_create_integration_yida_initialization.sql:20`），锚点表与初始化表任何 UPDATE/DELETE/TRUNCATE 都被触发器拒绝（同文件 `:25-46`）。
2. **凭据第一次被用，是在打开发送开关后第一条真实新建的提交里。** `submit()` 先提交一次性许可、先落 `prepared` 台账行与新建防重占位，再做任何外部 IO（`packages/core-backend/src/integration/yida-send-approval-service.ts:374-410`；台账 `:386-395`；`reused !== false` 即 CONFLICT `:391`）；防重占位是永久的部分唯一索引（`091_create_integration_yida_create_fence.sql:45-46`）。换令牌唯一的非测试调用点就在这条路径里（`plugins/plugin-integration-core/lib/yida-owner-send-port.mjs:125-135`）。
3. **所以填错 appKey/appSecret = 永久烧掉一条草稿行的新建防重占位**，而且无法改填（见 1）。
4. **今天没有任何路径能在发送前连宜搭/钉钉。** `POST /initialization/connection-test` 今天落到 404（`packages/core-backend/src/routes/integration-yida-owner.ts:290`）；宿主边界真机测试证明初始化与 owner 路径上 fetch 调用次数为 0（`packages/core-backend/tests/integration/yida-host-boundaries-realdb.test.ts:73,140`）。

结论：必须在「封存之前」验证粘贴的那一对，这正是候选模式；只在封存之后验证（已存模式）对「填错」无能为力。

## 1. 现状与约束（读码结论）

- **换令牌模块**：端点写死为钉钉 OAuth（`plugins/plugin-integration-core/lib/yida-token-exchange.cjs:6`）；只收闭合记录 `{appKey, appSecret}` 与 `{signal}`，多键、空白、非原生 AbortSignal 一律 INPUT 且不发请求（`:143-155`）；HTTP 状态码被丢弃，非 200 一律 RESPONSE（`:99`）；fetch 带调用者的 signal、`redirect: 'error'`（`:169-175`）；自身没有计时器，靠 signal（`:164-176`）；错误重建、不带 cause 与正文（`:212-215`）。
- **令牌客户端**：把换令牌的一切失败折成 `YIDA_TOKEN_EXCHANGE_FAILED`（`yida-token-client.cjs:262-264`），且把令牌缓存到 dispose（`:271-272`）。测试连接需要换令牌模块自己的闭集类别、且不能留住令牌，所以走换令牌模块、不走令牌客户端。
- **初始化运行时**的章程是「不读开关、不建发送授权、不发令牌、不 fetch」（`packages/core-backend/src/integration/yida-initialization-runtime.ts:143`），依赖只有 database + security（`:31-34`）。
- **owner 运行时**的每个外部 IO 方法都要求发送开关（`yida-owner-runtime.ts:209,351`），且每次运行都建发送授权（`:256`），而发送授权在没有已批准目标槽时答 NOT_FOUND（`yida-send-approval-service.ts:213-217`）。它不能承载「初始化之前」的探测。
- **审计表**的 CHECK 只允许 `create/rotate/revoke` 三种事件（`092_create_integration_yida_credential_materials.sql:25`），记一条「test」需要迁移。
- **开关清单测试**从 `packages/core-backend/src` 源码推导开关集合，未登记的读取与「登记了却没人读」都会红（`scripts/ops/global-history-flag-manifest.test.mjs:449-475`）。
- **部署**：本地部署的后端由 pm2 以单个 fork 运行，启动时一次性读入 `docker/app.env`（`ecosystem.config.cjs:52,57-61`）；另一种交付形态是 compose 容器，环境在容器创建时注入（§8）；宿主注入的是裸 `globalThis.fetch`（`packages/core-backend/src/index.ts:647`），仓库里没有代理派发器。

## 2. 决策清单（锁定）

① **第三个宿主私有运行时** `createYidaConnectionTestRuntime`（新文件 `packages/core-backend/src/integration/yida-connection-test-runtime.ts`）。不改前两个运行时：`yida-initialization-runtime.ts`、`yida-owner-runtime.ts`、`yida-send-approval-service.ts`、令牌客户端、换令牌模块、表单传输模块全部逐字节不动。

② **新路由** `POST /api/integration/yida-owner-send/initialization/connection-test`。PR A 只收 `{commandId, mode: 'candidate', material: {appKey, appSecret}}`；`mode: 'stored'`（PR B）在 PR A 里是 400。appKey/appSecret 与初始化同规则：字符串、1..4096 字符、不能全是空白、**不修剪**、合计 ≤16 KiB。

③ **响应**：200 `{commandId, mode: 'candidate', outcome, tokenIssued, tokenRetained: false, externalWriteAttempted: false, canSend: false}`，`outcome ∈ {ok, upstream_rejected, unreachable, timeout}`，`tokenIssued` 当且仅当 `outcome === 'ok'`。路由与前端都用闭合键集校验，多一个键即 503 / RESPONSE_INVALID。

④ **令牌在插件探针里当场丢弃**（新文件 `plugins/plugin-integration-core/lib/yida-connection-probe.cjs`：调用换令牌模块一次，解析出的 `{accessToken, expireIn}` 不绑定到任何变量），宿主只收冻结的闭合记录 `{outcome}`；带多余键、Proxy、未冻结或未知取值的回执一律 UNAVAILABLE，其内容不进视图。

⑤ **不落库、不加迁移、不写审计行。** 授权事务只读（实时权限的 FOR SHARE、槽位咨询锁、三条 SELECT）。

⑥ **显示位**：`GET /initialization` 的 200 与 `POST /initialization` 的 201 回复（同一个状态视图）只在开关读到原文 `true` 时带上 `connectionTestEnabled: true`；开关关或读失败时**该键不出现**。它只在已授权的回复里出现，不是授权。前端状态校验接受「既有闭合键集」与「既有键集 + `connectionTestEnabled`」两种形状：缺省即 false，出现则必须是布尔，否则 RESPONSE_INVALID。这样旧缓存的前端包（R75/R76 的严格键集）连新后端时，只要开关关着（默认、以及 L4 之后）就照常工作；新前端连旧后端读到 false。开关开着时旧缓存包会得到 RESPONSE_INVALID，重新加载页面即可（§6 排障）。开关关闭时按钮不渲染。

⑦ **次序（反驳评审阻断项的修订）**：
   捕获输入（同步；起始窗口从这里计时）→ 运行时是否在役 → 开关原文判定（任何 DB 工作之前）→ **一个 RC 授权事务**（实时集成管理员、槽位咨询锁、锚点存在、锚点 owner/租户 = JWT 主体、`commandId` = 锚点命令号、该槽既无初始化行也无已批准目标）→ **COMMIT** → **准入**（每进程同时最多 1 次在途换令牌，否则 409 CONFLICT；冷却 5 秒，否则 429 THROTTLED；冷却只在真正开始换令牌时盖章）→ 开关再判一次 → **起始窗口**（紧接在盖冷却章、占在途名额之前：自 `execute()` 入口起已超过 `YIDA_CONNECTION_TEST_START_WINDOW_MS = 2000` 即 503 UNAVAILABLE，零 fetch、**不盖冷却章**）→ 盖章、占名额 → 探针换令牌。
   **时钟**：冷却与起始窗口要么用单调时钟，要么在用墙钟时把负的经过时间当作「未限流、未超窗」——墙钟回拨永远不会锁死冷却。实现所选的方式写在运行时注释里。
   被拒绝的调用者（DISABLED / DENIED / CONFLICT / UNAVAILABLE）**永远碰不到限流器**：任何持有带租户声明 JWT 的人都到得了这个路由，但只有锚点 owner 才能占用在途名额或盖冷却章。限流器是进程内的、只数已授权调用者。
   **已接受、沿用的性质**：每进程运行上限 `MAX_RUNS = 32` 在开关判定之后、**授权事务之前**检查，与两个既有运行时同形（`yida-initialization-runtime.ts:160`、`yida-owner-runtime.ts:210`）。所以 32 个并发的、注定 DENIED 的调用者在各自短暂的只读授权事务期间占满运行名额时，owner 那一次点击会短暂得到 503 UNAVAILABLE（零出网、不涉及秘密，owner 重试即可）。在途名额与冷却只在 COMMIT 之后才会碰到，不受此影响。记为已接受、沿用。

⑧ **时限（反驳评审修订）**：整次探测的预算是模块常量 12 秒（`YIDA_CONNECTION_TEST_BUDGET_MS`）——低于前端 15 秒的保护（`apps/web/src/services/integration/yidaInitialization.ts:137`），高于 undici 默认 10 秒的连接超时，所以「连不上」稳定落在 unreachable，只有「连上了但没应答」才是 timeout。加上 ⑦ 的 2 秒起始窗口，服务器最坏约 2 + 12 = 14 秒，仍低于前端 15 秒的中止，所以浏览器不会在服务器仍在换令牌时显示 CANCELLED（忽略 signal 的 fetch 除外，见本条末）。到点时中止探针的 signal；**视图只在 fetch 依赖真正结束后才给出**（沿用两个既有运行时的骨架：每个依赖都记在本次运行上，运行的 finally 等它们全部结束，`yida-initialization-runtime.ts:169-173,266-275`）。不提前返回，所以不存在无人订阅的迟到 rejection；core-backend 主进程没有 `unhandledRejection` 处理器（`packages/core-backend/src/core/PluginIsolationManager.ts:292` 里的只在 worker 模板字符串中），提前返回会让 Node 20 默认行为杀掉后端。忽略 signal 的 fetch 会让本次运行、在途名额与 stop()/drain 一直等到它自己结束——这是有意的，与 owner 运行时相同（`yida-owner-runtime.ts:266-276`）。

## 3. 授权边界与梯子

- **谁**：锚点 slot=1 的 `owner_id`/`tenant_id` 必须等于 JWT 主体，且在同一 RC 事务里通过 `assertAutomationIntegrationActor`（实时集成管理员）。其他管理员 403 DENIED、零出网。路由只看 `req.user.id` 与 JWT 的租户声明，拒绝任何作用域类请求头（`integration-yida-owner.ts:63-74`）。
- **前置**（梯子 L1.5「引导锚点」）：测试连接须先由服务器操作员执行 `bootstrap-yida-initialization-owner --apply` 建立锚点、owner 在面板上手动 GET 到初始化命令号。这一步永久固定 owner_id/tenant_id（锚点只能 INSERT，`096_create_integration_yida_initialization.sql:35-40`），所以先由 owner 点名身份、再做全库备份。没有锚点时 GET 是 503，按钮不会出现，探测路由答 503 UNAVAILABLE（零出网）。面板文案写明这一点。
- **何时**：开关为原文 `'true'`；任何 DB 读之前判一次，换令牌之前再判一次。
- **出去什么**：恰好一次 POST 到写死的钉钉 OAuth 端点，体为 `{appKey, appSecret}`，`redirect: 'error'`，响应体 ≤16 KiB。不出 systemToken、userId、appType、formUuid。**它是一次携带客户凭据的出站调用，但不是宜搭写入、不是外部回写**（章程「永久禁止」的 K3 写回与宜搭发送都不在此列）。
- **存什么**：什么都不存。
- **测试机的三个前置条件**（上机前由 owner 按「有/无」核对，值不入证据）：① 后端进程的环境与启动参数里没有 `NODE_TLS_REJECT_UNAUTHORIZED`、`NODE_EXTRA_CA_CERTS`、`--use-system-ca`、`--use-openssl-ca`（`NODE_OPTIONS` 里也算）。任何一项都可能让 Node 信任拦截 CA：TLS 终结代理能读到粘贴的 appKey/appSecret；代理拦截页会以 upstream_rejected 回来，被误读为「出网正常」。② 没有全局 undici 派发器（仓库源码与插件库里没有，但 node_modules 未扫，部署机环境不在仓库内）。③ **浏览器→后端这一段**：粘贴的 appKey/appSecret 每次点击都以明文 JSON 随请求体重发一次；既有的 `POST /initialization` 同样以明文 JSON 携带四项材料（R75 起即如此，此前未记录）。所以 L2.5 / L3 / L4 期间，面板须经 HTTPS 访问，或经 owner 明确接受的网段访问。
- **已接受的窗口**：权限行只在 RC 事务内被 FOR SHARE 锁住（`automation-live-authority.ts:90-124`）；COMMIT 之后、换令牌之前若管理员被撤权，仍会发出这一次请求。什么都不落库，与发送路径同性质；COMMIT 之后唯一的门是开关再判。记为已接受。

**梯子**（每一级都要 owner 逐项另批，下一级不因上一级自动成立）：

| 级 | 动作 | 层 |
|---|---|---|
| L0 | 合并休眠代码：开关未设 ⇒ 路由 403 `YIDA_CONNECTION_TEST_DISABLED`、显示位 false、按钮不渲染 | owner 点名合并 |
| L1 | cherry-pick 上测试机，开关仍不设 | O ④ 部署 |
| L1.5 | 引导锚点：owner 点名锚点身份（哪个管理员账号 + 租户）→ 全库备份 → 操作员执行 `bootstrap-yida-initialization-owner --apply`（永久固定 owner_id/tenant_id）→ owner 手动 GET 得 200 `ready`。锚点按请求读取、不缓存，所以这一级可在 L2 之前或之后做，不需要重启，但必须在 L2.5 之前 | O（R-50 ② 的真实 owner/租户登记另批） |
| L2 | 在测试机把开关设为原文 `true`（该路径第一次从测试机向钉钉出网；产品里已有其它钉钉出网路径，是否是本机第一次取决于那些开关）；每次切换 = 一次后端重启 / 重建，见 §8 | O ④ 对外发送 |
| L2.5 | 先用合成/测试应用凭据点一次（预期 upstream_rejected，读法见 §6 合成点击结果表；验证接线、出网与 values-free） | O ④ |
| L3 | 用客户真实 appKey/appSecret 点（真实客户数据 + R-50 列明的「真实 token 交换」；§3 前置条件 ③） | O ① + R-50 |
| L4 | 用验证过的凭据做那一次不可逆的本地初始化（R75 既有流程）。**ok 是必要条件、不是充分条件**：探针只走 oauth2 accessToken；发送还要 POST `yida/forms/instances`（`yida-form-transport.cjs:6`，发送侧时限 10 秒，`yida-owner-send-port.mjs:88`@88cdeb059），HTTP 路径过滤的检查代理可能放行前者、拦下后者；systemToken / userId / appType / formUuid 要到首次真实新建才第一次被验证，那次新建的防重占位是永久的（§0） | owner |
| L5/L6 | 打开发送开关、每一条真实发送 | 仍是 R-50 既有门，不在本 ADR |

## 4. 接口与错误码（闭集）

| HTTP | 代码 | 含义 |
|---|---|---|
| 400 | `YIDA_OWNER_HTTP_INPUT` / `YIDA_CONNECTION_TEST_INPUT` | 请求体不闭合、mode 不是 candidate、材料不合规、查询串或作用域头 |
| 401 | `UNAUTHORIZED` | 无 JWT 主体 |
| 403 | `YIDA_CONNECTION_TEST_DISABLED` | 开关不是原文 `true`（任何 DB 工作之前） |
| 403 | `YIDA_CONNECTION_TEST_DENIED` | 不是锚点 owner/租户，或不是实时集成管理员 |
| 409 | `YIDA_CONNECTION_TEST_CONFLICT` | 命令号不等于锚点；该槽已初始化或已有目标；另一次换令牌在途 |
| 409 | `YIDA_CONNECTION_TEST_CANCELLED` | 调用者断开或运行时停止 |
| 429 | `YIDA_CONNECTION_TEST_THROTTLED` | 冷却期内 |
| 503 | `YIDA_CONNECTION_TEST_INACTIVE` / `YIDA_CONNECTION_TEST_UNAVAILABLE` / `YIDA_OWNER_HTTP_UNAVAILABLE` | 能力未在役（插件激活失败软化后）、无锚点、超过 2 秒起始窗口、回执不合法、外来错误、请求体解析器的未知错误 |
| 403 | `YIDA_OWNER_HTTP_DENIED` | owner 子树共用：JWT 没有租户声明（`integration-yida-owner.ts:66`） |
| 413 / 415 | `YIDA_OWNER_HTTP_INPUT` | owner 子树共用：非 JSON 的 POST 为 415（`:202-208`）；请求体过大为 413、字符集或编码不支持为 415（解析错误处理器 `:209-223`） |

**已接受的开关状态泄露**：开关判定在授权之前（零 DB 工作比隐藏开关更有价值），所以任何带租户声明的已登录用户都能从 403 DISABLED 与 403 DENIED 的差别得知开关是否打开。发送开关今天也一样（`yida-owner-runtime.ts:209`）。记为已接受。

## 5. 权限模型与前端可见性

- 入口链不变：宜搭入口只对平台/集成管理员显示，服务器逐次再授权。
- 按钮只在 `state.status === 'ready' && state.connectionTestEnabled === true` 时渲染；appKey/appSecret 非空才可点（systemToken、userId、人工确认不需要）。
- 探测不清空已输入的秘密、不进入「状态未确认」、不消耗 ready（之后仍可用同一命令号初始化）。
- **已测试的那一对（前端，不落盘）**：得到 ok 时，在组件内存里保留一份**非响应式**的 appKey/appSecret 副本（不进模板、不进 Vue 响应式状态，只有一个版本计数是响应式的）；之后输入与它不同即显示「已测试的凭据与当前输入不一致，请重新测试」，并禁用初始化，直到重新测试或 owner 勾选明确的「不重新测试，仍按当前输入初始化」。副本在初始化、卸载、重新 GET、会话变化时清除；非 ok 的结果也清除它。不用 `crypto.subtle` 做摘要：测试机按 IP 走明文 HTTP，那里没有 `crypto.subtle`。
- 固定说明：ok 只证明 appKey/appSecret 是有效应用对；测试通过不等于可以发送。

## 6. 失败模式与分类的诚实边界

| outcome | 含义 | 不能说明什么 |
|---|---|---|
| ok | 钉钉为这对 appKey/appSecret 发了令牌（`yida-token-exchange.cjs:126-131`）；令牌已丢弃 | 必要、不充分：只走了 oauth2 accessToken，发送用的 `yida/forms/instances` 路径没走过（§3 L4）；systemToken、userId、appType、formUuid、字段映射、该应用对这个宜搭应用的权限，都要到首次真实新建才知道；之后钉钉侧重置密钥仍会让槽位停摆 |
| upstream_rejected | 对方应答但没发令牌 | 最常见是凭据不匹配，但限流（429）、5xx、代理拦截页、接口变更都落在这里——状态码在换令牌模块里就被丢弃了（`:99`），系统区分不了 |
| unreachable | DNS / TLS / 连接 / 重定向失败，包括静默丢包（约 10 秒处 undici 连接超时） | 与凭据无关 |
| timeout | TCP/TLS 已连上，但 12 秒内没有 HTTP 应答 | 与凭据无关 |

**timeout 与 unreachable 都指向出网 / DNS / TLS / 代理，二者都不说明凭据对错。** 静默丢包的防火墙（SYN 或 TLS 握手没有回应）先撞上 undici 默认 10 秒的连接超时，fetch 拒绝 ⇒ 换令牌 UNAVAILABLE ⇒ unreachable（与 §2 ⑧ 一致）；只有连上之后不应答才是 timeout。Node 20 的 fetch 不读 `HTTP(S)_PROXY`，需要代理的测试机会一律 unreachable 或 timeout。界面文案（timeout）：「已连上但 12 秒内无应答：可能是中间设备不转发或钉钉慢；与凭据无关」。

**L2.5 合成凭据点击的预期结果**

| 结果 | 读法 | 下一步 |
|---|---|---|
| upstream_rejected | 有人在钉钉 OAuth 地址上应答了 ⇒ 出网通（以 §3 前置条件 ① 成立为前提：被信任的拦截 CA 之下，代理拦截页同样落在这里） | 可进 L3 |
| unreachable | DNS / 防火墙 / TLS / 重定向之一，系统区分不了 | 停；在后端进程所在环境里用 values-free 的解析与连通检查定位，不靠再点 |
| timeout | 已连上但不应答 | 停，同上 |
| ok | 合成凭据不可能拿到令牌（`yida-token-exchange.cjs:126-131`） | 视为被拦截或伪造的应答：停止、报 owner，不进 L3 |
| 任何 4xx / 5xx 错误码 | 不是结果类，说明梯子上前一级没满足 | 按下方排障回到对应级 |

**排障速查**

- 按钮可见，但点击得到 503 `YIDA_CONNECTION_TEST_INACTIVE`：探针能力未在役——插件第三个激活块失败（§8 软化，日志 `YIDA_CONNECTION_TEST_RUNTIME_INACTIVE`），或包里缺 `lib/yida-connection-probe.cjs`。按 sha256 核对包内文件。开关本身只读环境变量，没有别的运行时切换面；面板对 INACTIVE 的中文提示写明这两种原因。
- 403 `YIDA_CONNECTION_TEST_DISABLED`：运行中的进程里开关不是原文 `true`，常见是改了 `docker/app.env` 却没重启 / 重建后端（§8）。
- 503 `YIDA_CONNECTION_TEST_UNAVAILABLE`：没有锚点（L1.5 未做）、超过 2 秒起始窗口（后端过载）或回执不合法；重试一次仍如此就停。
- 开关开着、浏览器用的是旧缓存前端包：状态视图多了 `connectionTestEnabled` 键，旧包的严格键集校验给出 RESPONSE_INVALID，重新加载页面即可（开关关时旧包不受影响，§2 ⑥）。
- 代理设置在本版不改变结果：宿主注入裸 `globalThis.fetch`，Node 20 的 fetch 不读 `HTTP(S)_PROXY`，设代理环境变量不会让 unreachable / timeout 变好（代理出网另立 ADR，§9）。

## 7. 可观测与 values-free

- 新路径在 owner 子树前缀之内（`yida-owner-http-observation.ts:7-9`）：关联号由服务器生成、忽略客户端的 `X-Correlation-ID`，并打上私有观测面标记（`middleware/correlation.ts:35-47`）；此上下文里所有 Logger 调用只剩 `YIDA_OWNER_HTTP_<LEVEL>` + 关联号，调用者的消息、元数据、错误一律丢弃（`core/logger.ts:98-120`）。
- 错误不带 cause / 正文；响应不含状态码、延迟、令牌或回显；`Cache-Control: no-store` + `nosniff`。
- 测试只用合成字串、注入的 fetch 或进程内的假端点；CI 永远不连钉钉。
- **L2.5 / L3 的证据规则**：只记 owner 的 values-free 陈述（结果类别，例如「upstream_rejected」）；不留 HAR、不截网络面板；验证窗口内关闭开发者工具。

## 8. 开关、迁移与上线

- **新开关** `INTEGRATION_YIDA_CONNECTION_TEST_ENABLED`：boolean、只认原文 `true`（不修剪、不忽略大小写）、默认关、`dependsOn: []`、`conflictsWith: []`、`danger: 'high'`；唯一的源码读取点是 `packages/core-backend/src/index.ts` 里新运行时的 `readEnablement`；登记在 `scripts/ops/global-history-flag-manifest.mjs`（发送开关之后）。只读环境变量，不新增任何运行时切换面（数据库、管理接口都开不了它）。
- **发送开关** `INTEGRATION_YIDA_OWNER_SEND_ENABLED` 不变、不读；它仍是写表单的唯一路径（`yida-delivery-runner.mjs:229-237`、`yida-form-transport.cjs:178-192` 的原文复核都不动）。
- **开关切换 = 后端重启 / 重建**：代码每次调用都读环境原文（`packages/core-backend/src/index.ts:665`@88cdeb059 的 `readEnablement`），但进程环境在启动时就固定了：pm2 单 fork 启动时读一次 `docker/app.env`（`ecosystem.config.cjs:52,57-61`）；compose 形态的后端容器在创建时由 `env_file: ./docker/app.env` 注入（`docker-compose.app.yml:33-34`@763a559dc，R76 验收机是这种形态）。所以每次开或关都要重启或重建后端、所有用户断开一次；浏览器端的按钮也要重新 GET 后才变化。**推荐 (b) 的事件界定变体**（owner 批 L2 时确认，记入 R-64 ⑨）：随上机安装的那次重启置为 `true`；L4 成功后的第一次重启置回未设；L3 被放弃即关（为此单独重启一次）；可另加日历兜底。理由：开关只在 L1.5 与 L4 之间有实际暴露——之前每次调用都是 503、零出网；之后候选探测是 409、零出网、按钮不渲染。开着期间暴露的只有两样：一个仅锚点 owner 可用的凭据检验器（冷却 5 秒，约每分钟 12 次），和一条任何已登录用户都能触发的只读事务路径（进程内上限 32）；什么都不写。备选 (a)：每个验证窗口在非工作时间切两次（开、验、关）。
- **无迁移**：发布线止于 096（`git ls-tree 2cda91b17`、`git ls-tree 763a559dc`），main 有 100–103；本切片不带迁移，cherry-pick 不会拖入单向迁移。
- **上线**：先 main，后 `cherry-pick -x` 到当前 R 线 tip（onprem-r76 = `763a559dc`；R76 已不带本切片发出），做**下一个带宜搭的 R 线包（R77 起，以 onprem-r* 标签为准）**。对 `763a559dc` 重跑 `git merge-tree --merge-base=5d6eedfd7`（r1 评审），结论与对 onprem-r75 相同：代码提交（PR A）**只有** `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 文本冲突；`plugin-tests.yml`、`index.ts`、插件 `index.cjs`、`test-chain.txt`、`scripts/ops/global-history-flag-manifest.test.mjs` 三方自动合并。本 ADR 的提交（PR 0）只在 `decision-register.md` 冲突。**两处冲突都不能直接取任一边**：① s6a pin——`pluginIndex` 按发布线上合并后 `index.cjs` 的原始字节重算 sha256（与 R76 的值、PR 的值都不同），`pluginHttpRoutes` 保留 R76 的值；直接取任一边都会红。② 登记册——保留 R 线的表，只把 R-64 这一行插到 R 线最后一行之后；取 PR 一侧会把 R 线上不存在的 R-52..R-62 一并带进来。合并后的 `index.ts` 与插件 `index.cjs` 只是文本自动合并、字节与 main 不同，所以要在发布线提交上重跑：test-chain 完整性、s6a 来源 pin、开关清单、**完整的 core-backend 单元套件**（`index.ts` 的 this-census 冻结字面量在里面）与 **web spec**。之后在 tag 上跑完整 CI，按 sha256 核对上机文件。那个包的发布说明用「测试连接已存在（开关后）、只验证 appKey/appSecret、仍不支持重新初始化与轮换」替换此前发布说明（R75 §六）里「没有测试连接」那一条。
- **插件激活失败软化**：第三个激活块失败时只记一行 values-free 日志（`YIDA_CONNECTION_TEST_RUNTIME_INACTIVE`），该能力保持未在役（路由答 503 `YIDA_CONNECTION_TEST_INACTIVE`），绝不拖垮整个集成插件——发布线漏拷新库文件时，备料功能照常。

## 9. 不在本 ADR 范围内

- **重新初始化 / 凭据接替**：要单向迁移（096:20 与 :25-46、094 的不可变、092 只允许 generation+1 或撤销）、改四处封存读取器、新的运维命令；且已烧掉的新建防重占位无法恢复（R-50 ⑥）。候选模式在封存之前就防住「填错」；对测试机一次性录入，录入前的数据库备份更便宜。只在 owner 明确需要时另立 ADR。
- **持久的探测日志**：审计表 CHECK 不允许 test 事件（092:25），需要迁移；目前以 owner 在登记册的 values-free 陈述为证据。
- **把 429/5xx 从 upstream_rejected 分出来**：要改发送路径共用的封存模块。
- **代理出网**：改变出网姿态会影响发送路径，是基础设施 / owner 决定。
- **systemToken / userId / appType / formUuid 的验证**：没有不需要 instanceId 的只读宜搭接口（`yida-form-readback.cjs:6,93-102`），只读表单定义探测是新的外部端点、新的 owner 决定。
- **浏览器车道新增用例**：PR A 对两份真库 DTO 断言至多做「只改断言」的修订（按 §2 ⑥，开关关时状态视图与此前逐键相同，不再加 `connectionTestEnabled: false`），用例数不变（`EXPECTED_YIDA_CONTRACT_TESTS=80`，5/70/65/5 不变）。

## 10. 切片、测试与变异见证

- **PR 0**：本 ADR + 登记册 R-64。
- **PR A**（候选模式）：插件探针 `lib/yida-connection-probe.cjs` 与其测试（登记进 `test-chain.txt`）；宿主运行时与单元测试；路由与 HTTP 边界单元测试（含经真实关联中间件与真实 Logger 的 values-free 用例）；`index.ts` 接线（构造、第三个参数、能力注入、三处排空、停止与 shutdownTasks）；插件第三个激活块（软失败）与 s6a `pluginIndex` 重 pin；开关清单登记；guarded-paths 与 `integration-guard.yml` 两处同步；EXPECT_DB 车道新增两份真库文件（`plugin-tests.yml`、`yida-host-capability-injection.test.ts`、`yida-delivery-store.test.cjs` 三处镜像 + `vitest.config.ts` 排除）；前端服务与面板与 jsdom spec；两份 owner 真库测试只改断言。
- **PR B**（已存模式，后续）：在已初始化的槽上测试封存的第 1 代 appKey/appSecret（与发送路径同一把锁序与绑定校验）；合并与上机同 PR A。
- **每条守卫先见红再报绿**：变异见证覆盖开关再判、令牌泄露、端点钉死（测试里写死字面量、在临时副本里改换令牌模块的 ENDPOINT 必红）、owner 绑定、准入次序（被拒调用者紧接着 owner ⇒ owner 准入且恰好 1 次 fetch）、并发与冷却、初始化后候选、事务后才 fetch、时限中止、未处理 rejection（M16）、前端可见性与秘密保留、日志（对新路径去掉私有观测面标记必红）、显示位、持久化、分类、治理接线。
- **CI 陷阱清单**：test-chain 完整性、s6a 重 pin、EXPECT_DB 文件清单三处镜像、guarded-paths 与工作流集合相等、开关清单源码推导、web spec 变异锚点唯一性、两份 owner 真库 DTO 断言。

## 11. 待 owner 裁定

1. L1 上机、L1.5 锚点身份（哪个管理员账号 + 租户，一经引导不可改）、L2 开开关的时机，以及确认 §8 开关策略（推荐 (b) 的事件界定变体，备选 (a)；记入登记册）。
2. L2.5 合成凭据与 L3 客户真实凭据，各自逐次批准；L2.5 / L3 / L4 期间面板经 HTTPS 或经 owner 明确接受的网段访问（§3 前置条件 ③）。
3. 是否要持久证据（决定是否另立探测日志 ADR）。
4. 是否需要重新初始化路径（决定是否另立 ADR）。
5. T 层默认可否决：冷却 5 秒、danger high、四类分类、12 秒预算、2 秒起始窗口。
