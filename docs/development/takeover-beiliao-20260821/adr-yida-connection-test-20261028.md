# 宜搭：owner「测试连接」—— 初始化前只换一次令牌、不写表单、不落库的授权边界与开关（ADR 2026-10-28）

> **状态**：草稿 v1。owner 2026-10-28 对「先出授权边界 ADR，再出一个由 owner 运行、只换令牌、不写表单的测试连接代码 PR」回复「同意」；本 ADR 即第一步。标「T 层默认」的条目按章程默认前进、owner 24h 内可否决。
> **线别**：属于 R-50 解封的宜搭交付项（#6315）的 owner 批准延伸，不算第三条线。
> **基线**：main `929315933`（`929315933ecef4c815d3d98ce38db2719a204611`）。下文所有 `path:line` 都在这个提交上核过；它与 onprem-r75（`2cda91b17`）在宜搭源码、路由、迁移与前端路径上逐字节一致（两提交之间这些路径的 `git diff --stat` 为空）。新增文件（PR A）只写路径、不写行号。合并前若 main 已前进，按章程 rebase 后重核行号。已 rebase 到 main `5d6eedfd7`：`929315933..5d6eedfd7` 只改 `apps/web` 的多维表与项目同步文件，下文引用的路径都不在其中，行号不变。
> **values-free**：不含主机、地址、口令、appKey、appSecret、令牌或任何客户值，只指位置。
> **关联**：R-50（#6315 解封与七条宜搭决策）、R-64（本 ADR 的登记行）、R75 发布说明草稿 §六（「没有测试连接」）、`.github/PULL_REQUEST_TEMPLATE.md:62-68`（新端点与授权边界变更须独立决策文档、独立 PR）。
> **来源**：owner 2026-10-27 问「测试机中可以填写宜搭的信息并可进行连接测试么」；2026-10-28 回复「同意」（ADR 先行 + 只换令牌不写表单的测试连接代码 PR）。设计经两份独立设计、一次裁决与一次反驳评审收敛（反驳评审结论：方案成立、需修订，1 个阻断项已并入 §2 ⑦ 与 §3）。

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
| Q8 | 测试机上开关怎么开关 | 每次切换都是一次后端重启；owner 二选一：每个验证窗口在非工作时间切两次，或在整个包的生命周期里保持开启（靠锚点 owner + 实时权限 + 限流兜底），所选方案记入登记册 | owner 待定 | §8、§11 |

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
- **部署**：本地部署的后端由 pm2 以单个 fork 运行，启动时一次性读入 `docker/app.env`（`ecosystem.config.cjs:52,57-61`）；宿主注入的是裸 `globalThis.fetch`（`packages/core-backend/src/index.ts:647`），仓库里没有代理派发器。

## 2. 决策清单（锁定）

① **第三个宿主私有运行时** `createYidaConnectionTestRuntime`（新文件 `packages/core-backend/src/integration/yida-connection-test-runtime.ts`）。不改前两个运行时：`yida-initialization-runtime.ts`、`yida-owner-runtime.ts`、`yida-send-approval-service.ts`、令牌客户端、换令牌模块、表单传输模块全部逐字节不动。

② **新路由** `POST /api/integration/yida-owner-send/initialization/connection-test`。PR A 只收 `{commandId, mode: 'candidate', material: {appKey, appSecret}}`；`mode: 'stored'`（PR B）在 PR A 里是 400。appKey/appSecret 与初始化同规则：字符串、1..4096 字符、不能全是空白、**不修剪**、合计 ≤16 KiB。

③ **响应**：200 `{commandId, mode: 'candidate', outcome, tokenIssued, tokenRetained: false, externalWriteAttempted: false, canSend: false}`，`outcome ∈ {ok, upstream_rejected, unreachable, timeout}`，`tokenIssued` 当且仅当 `outcome === 'ok'`。路由与前端都用闭合键集校验，多一个键即 503 / RESPONSE_INVALID。

④ **令牌在插件探针里当场丢弃**（新文件 `plugins/plugin-integration-core/lib/yida-connection-probe.cjs`：调用换令牌模块一次，解析出的 `{accessToken, expireIn}` 不绑定到任何变量），宿主只收冻结的闭合记录 `{outcome}`；带多余键、Proxy、未冻结或未知取值的回执一律 UNAVAILABLE，其内容不进视图。

⑤ **不落库、不加迁移、不写审计行。** 授权事务只读（实时权限的 FOR SHARE、槽位咨询锁、三条 SELECT）。

⑥ **显示位**：`GET /initialization` 与 `POST /initialization` 的 201 回复新增布尔 `connectionTestEnabled`，只在已授权的回复里出现、只认开关原文 `true`、读失败即 false；它不是授权。开关关闭时按钮不渲染。

⑦ **次序（反驳评审阻断项的修订）**：
   捕获输入（同步）→ 运行时是否在役 → 开关原文判定（任何 DB 工作之前）→ **一个 RC 授权事务**（实时集成管理员、槽位咨询锁、锚点存在、锚点 owner/租户 = JWT 主体、`commandId` = 锚点命令号、该槽既无初始化行也无已批准目标）→ **COMMIT** → **准入**（每进程同时最多 1 次在途换令牌，否则 409 CONFLICT；冷却 5 秒，否则 429 THROTTLED；冷却只在真正开始换令牌时盖章）→ 开关再判一次 → 探针换令牌。
   被拒绝的调用者（DISABLED / DENIED / CONFLICT / UNAVAILABLE）**永远碰不到限流器**：任何持有带租户声明 JWT 的人都到得了这个路由，但只有锚点 owner 才能占用在途名额或盖冷却章。限流器是进程内的、只数已授权调用者。
   **已接受、沿用的性质**：每进程运行上限 `MAX_RUNS = 32` 在开关判定之后、**授权事务之前**检查，与两个既有运行时同形（`yida-initialization-runtime.ts:160`、`yida-owner-runtime.ts:210`）。所以 32 个并发的、注定 DENIED 的调用者在各自短暂的只读授权事务期间占满运行名额时，owner 那一次点击会短暂得到 503 UNAVAILABLE（零出网、不涉及秘密，owner 重试即可）。在途名额与冷却只在 COMMIT 之后才会碰到，不受此影响。记为已接受、沿用。

⑧ **时限（反驳评审修订）**：整次探测的预算是模块常量 12 秒（`YIDA_CONNECTION_TEST_BUDGET_MS`）——低于前端 15 秒的保护（`apps/web/src/services/integration/yidaInitialization.ts:137`），高于 undici 默认 10 秒的连接超时，所以「连不上」稳定落在 unreachable，只有「连上了但没应答」才是 timeout。到点时中止探针的 signal；**视图只在 fetch 依赖真正结束后才给出**（沿用两个既有运行时的骨架：每个依赖都记在本次运行上，运行的 finally 等它们全部结束，`yida-initialization-runtime.ts:169-173,266-275`）。不提前返回，所以不存在无人订阅的迟到 rejection；core-backend 主进程没有 `unhandledRejection` 处理器（`PluginIsolationManager.ts:285-292` 里的只在 worker 模板字符串中），提前返回会让 Node 20 默认行为杀掉后端。忽略 signal 的 fetch 会让本次运行、在途名额与 stop()/drain 一直等到它自己结束——这是有意的，与 owner 运行时相同（`yida-owner-runtime.ts:266-276`）。

## 3. 授权边界与梯子

- **谁**：锚点 slot=1 的 `owner_id`/`tenant_id` 必须等于 JWT 主体，且在同一 RC 事务里通过 `assertAutomationIntegrationActor`（实时集成管理员）。其他管理员 403 DENIED、零出网。路由只看 `req.user.id` 与 JWT 的租户声明，拒绝任何作用域类请求头（`integration-yida-owner.ts:63-74`）。
- **前置**：测试连接须先由服务器操作员执行 `bootstrap-yida-initialization-owner --apply` 建立锚点、owner 在面板上手动 GET 到初始化命令号。没有锚点时 GET 是 503，按钮不会出现，探测路由答 503 UNAVAILABLE（零出网）。面板文案写明这一点。
- **何时**：开关为原文 `'true'`；任何 DB 读之前判一次，换令牌之前再判一次。
- **出去什么**：恰好一次 POST 到写死的钉钉 OAuth 端点，体为 `{appKey, appSecret}`，`redirect: 'error'`，响应体 ≤16 KiB。不出 systemToken、userId、appType、formUuid。**它是一次携带客户凭据的出站调用，但不是宜搭写入、不是外部回写**（章程「永久禁止」的 K3 写回与宜搭发送都不在此列）。
- **存什么**：什么都不存。
- **测试机的两个前置条件**（上机前由 owner 按「有/无」核对，值不入证据）：① 环境里没有设置 `NODE_TLS_REJECT_UNAUTHORIZED`（否则中间人代理能读到 appKey/appSecret）；② 没有全局 undici 派发器（仓库源码与插件库里没有，但 node_modules 未扫，部署机环境不在仓库内）。
- **已接受的窗口**：权限行只在 RC 事务内被 FOR SHARE 锁住（`automation-live-authority.ts:90-124`）；COMMIT 之后、换令牌之前若管理员被撤权，仍会发出这一次请求。什么都不落库，与发送路径同性质；COMMIT 之后唯一的门是开关再判。记为已接受。

**梯子**（每一级都要 owner 逐项另批，下一级不因上一级自动成立）：

| 级 | 动作 | 层 |
|---|---|---|
| L0 | 合并休眠代码：开关未设 ⇒ 路由 403 `YIDA_CONNECTION_TEST_DISABLED`、显示位 false、按钮不渲染 | owner 点名合并 |
| L1 | cherry-pick 上测试机，开关仍不设 | O ④ 部署 |
| L2 | 在测试机把开关设为原文 `true`（第一次允许从测试机向钉钉出网）；每次切换 = 一次后端重启，见 §8 | O ④ 对外发送 |
| L2.5 | 先用合成/测试应用凭据点一次（预期 upstream_rejected 或 unreachable；验证接线、出网与 values-free） | O ④ |
| L3 | 用客户真实 appKey/appSecret 点（真实客户数据 + R-50 列明的「真实 token 交换」） | O ① + R-50 |
| L4 | 用验证过的凭据做那一次不可逆的本地初始化（R75 既有流程） | owner |
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
| 503 | `YIDA_CONNECTION_TEST_INACTIVE` / `YIDA_CONNECTION_TEST_UNAVAILABLE` / `YIDA_OWNER_HTTP_UNAVAILABLE` | 能力未在役（插件激活失败软化后）、无锚点、回执不合法、外来错误 |

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
| ok | 钉钉为这对 appKey/appSecret 发了令牌（`yida-token-exchange.cjs:126-131`）；令牌已丢弃 | systemToken、userId、appType、formUuid、字段映射、该应用对这个宜搭应用的权限，都要到首次真实新建才知道；之后钉钉侧重置密钥仍会让槽位停摆 |
| upstream_rejected | 对方应答但没发令牌 | 最常见是凭据不匹配，但限流（429）、5xx、代理拦截页、接口变更都落在这里——状态码在换令牌模块里就被丢弃了（`:99`），系统区分不了 |
| unreachable | DNS / TLS / 连接 / 重定向失败 | 与凭据无关 |
| timeout | 12 秒内无应答 | 与凭据无关 |

**timeout 与 unreachable 都指向出网 / DNS / TLS / 代理，二者都不说明凭据对错。** 静默丢包的防火墙通常表现为 timeout；Node 20 的 fetch 不读 `HTTP(S)_PROXY`，需要代理的测试机会一律 unreachable 或 timeout。界面文案（timeout）：「12 秒内无应答：可能是出网被防火墙丢弃或未配置代理，也可能是钉钉慢；与凭据无关」。

## 7. 可观测与 values-free

- 新路径在 owner 子树前缀之内（`yida-owner-http-observation.ts:7-9`）：关联号由服务器生成、忽略客户端的 `X-Correlation-ID`，并打上私有观测面标记（`middleware/correlation.ts:35-47`）；此上下文里所有 Logger 调用只剩 `YIDA_OWNER_HTTP_<LEVEL>` + 关联号，调用者的消息、元数据、错误一律丢弃（`core/logger.ts:98-120`）。
- 错误不带 cause / 正文；响应不含状态码、延迟、令牌或回显；`Cache-Control: no-store` + `nosniff`。
- 测试只用合成字串、注入的 fetch 或进程内的假端点；CI 永远不连钉钉。
- **L2.5 / L3 的证据规则**：只记 owner 的 values-free 陈述（结果类别，例如「upstream_rejected」）；不留 HAR、不截网络面板；验证窗口内关闭开发者工具。

## 8. 开关、迁移与上线

- **新开关** `INTEGRATION_YIDA_CONNECTION_TEST_ENABLED`：boolean、只认原文 `true`（不修剪、不忽略大小写）、默认关、`dependsOn: []`、`conflictsWith: []`、`danger: 'high'`；唯一的源码读取点是 `packages/core-backend/src/index.ts` 里新运行时的 `readEnablement`；登记在 `scripts/ops/global-history-flag-manifest.mjs`（发送开关之后）。
- **发送开关** `INTEGRATION_YIDA_OWNER_SEND_ENABLED` 不变、不读；它仍是写表单的唯一路径（`yida-delivery-runner.mjs:229-237`、`yida-form-transport.cjs:178-192` 的原文复核都不动）。
- **开关切换 = 后端重启**：本地部署的后端是 pm2 单 fork、启动时读一次 `docker/app.env`（`ecosystem.config.cjs:52,57-61`），所以每次开或关都要重启后端、所有用户断开一次；浏览器端的按钮也要重新 GET 后才变化。owner 二选一并记入登记册：(a) 每个验证窗口在非工作时间切两次（开、验、关）；(b) 在整个包的生命周期里保持开启，靠锚点 owner + 实时权限 + 限流兜底。
- **无迁移**：发布线止于 096（`git ls-tree 2cda91b17`），main 有 100–103；本切片不带迁移，cherry-pick 不会拖入单向迁移。
- **上线**：先 main，后 `cherry-pick -x` 到 onprem-r75 线做下一个带宜搭的包（R76+宜搭，以 onprem-r* 标签为准）。按 `git merge-tree` 模拟（合并基为本切片的 main 父提交），代码提交（PR A）cherry-pick 到 onprem-r75 时**只有** `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 文本冲突，须按发布线上 `index.cjs` 的字节重算 `pluginIndex` pin；`plugin-tests.yml`、`index.ts`、插件 `index.cjs`、`test-chain.txt`、`scripts/ops/global-history-flag-manifest.test.mjs` 三方自动合并，但合并后的 `index.cjs` 与 main 上的字节不同，所以要在发布线提交上重跑 test-chain 完整性、s6a 来源 pin 测试与开关清单测试。本 ADR 的提交（PR 0）只在 `decision-register.md` 冲突（发布线的登记册缺 main 上较新的登记行）。之后在 tag 上跑完整 CI，按 sha256 核对上机文件。R76 发布说明用「测试连接已存在（开关后）、只验证 appKey/appSecret、仍不支持重新初始化与轮换」替换 R75 §六。
- **插件激活失败软化**：第三个激活块失败时只记一行 values-free 日志（`YIDA_CONNECTION_TEST_RUNTIME_INACTIVE`），该能力保持未在役（路由答 503 `YIDA_CONNECTION_TEST_INACTIVE`），绝不拖垮整个集成插件——发布线漏拷新库文件时，备料功能照常。

## 9. 不在本 ADR 范围内

- **重新初始化 / 凭据接替**：要单向迁移（096:20 与 :25-46、094 的不可变、092 只允许 generation+1 或撤销）、改四处封存读取器、新的运维命令；且已烧掉的新建防重占位无法恢复（R-50 ⑥）。候选模式在封存之前就防住「填错」；对测试机一次性录入，录入前的数据库备份更便宜。只在 owner 明确需要时另立 ADR。
- **持久的探测日志**：审计表 CHECK 不允许 test 事件（092:25），需要迁移；目前以 owner 在登记册的 values-free 陈述为证据。
- **把 429/5xx 从 upstream_rejected 分出来**：要改发送路径共用的封存模块。
- **代理出网**：改变出网姿态会影响发送路径，是基础设施 / owner 决定。
- **systemToken / userId / appType / formUuid 的验证**：没有不需要 instanceId 的只读宜搭接口（`yida-form-readback.cjs:6,93-102`），只读表单定义探测是新的外部端点、新的 owner 决定。
- **浏览器车道新增用例**：PR A 只对两份真库 DTO 断言做「只改断言」的修订（加 `connectionTestEnabled: false`），用例数不变（`EXPECTED_YIDA_CONTRACT_TESTS=80`，5/70/65/5 不变）。

## 10. 切片、测试与变异见证

- **PR 0**：本 ADR + 登记册 R-64。
- **PR A**（候选模式）：插件探针 `lib/yida-connection-probe.cjs` 与其测试（登记进 `test-chain.txt`）；宿主运行时与单元测试；路由与 HTTP 边界单元测试（含经真实关联中间件与真实 Logger 的 values-free 用例）；`index.ts` 接线（构造、第三个参数、能力注入、三处排空、停止与 shutdownTasks）；插件第三个激活块（软失败）与 s6a `pluginIndex` 重 pin；开关清单登记；guarded-paths 与 `integration-guard.yml` 两处同步；EXPECT_DB 车道新增两份真库文件（`plugin-tests.yml`、`yida-host-capability-injection.test.ts`、`yida-delivery-store.test.cjs` 三处镜像 + `vitest.config.ts` 排除）；前端服务与面板与 jsdom spec；两份 owner 真库测试只改断言。
- **PR B**（已存模式，后续）：在已初始化的槽上测试封存的第 1 代 appKey/appSecret（与发送路径同一把锁序与绑定校验）；合并与上机同 PR A。
- **每条守卫先见红再报绿**：变异见证覆盖开关再判、令牌泄露、端点钉死（测试里写死字面量、在临时副本里改换令牌模块的 ENDPOINT 必红）、owner 绑定、准入次序（被拒调用者紧接着 owner ⇒ owner 准入且恰好 1 次 fetch）、并发与冷却、初始化后候选、事务后才 fetch、时限中止、未处理 rejection（M16）、前端可见性与秘密保留、日志（对新路径去掉私有观测面标记必红）、显示位、持久化、分类、治理接线。
- **CI 陷阱清单**：test-chain 完整性、s6a 重 pin、EXPECT_DB 文件清单三处镜像、guarded-paths 与工作流集合相等、开关清单源码推导、web spec 变异锚点唯一性、两份 owner 真库 DTO 断言。

## 11. 待 owner 裁定

1. L1 上机、L2 开开关的时机，以及 §8 开关切换的 (a)/(b) 二选一（记入登记册）。
2. L2.5 合成凭据与 L3 客户真实凭据，各自逐次批准。
3. 是否要持久证据（决定是否另立探测日志 ADR）。
4. 是否需要重新初始化路径（决定是否另立 ADR）。
5. T 层默认可否决：冷却 5 秒、danger high、四类分类、12 秒预算。
