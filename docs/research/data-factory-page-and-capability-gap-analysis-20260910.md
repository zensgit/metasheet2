# 数据工厂页面布局与功能差距分析 —— 对标飞书 aPaaS 连接器 / n8n / 数环通 iPaaS（2026-09-10）

> 内部研究，非 committed design。对象是 `/integrations/workbench`（数据工厂）及其周边：`/data-sources`（外接数据源，正由 PR #5587 并入连接管理分区）、`/integrations/k3-wise`（K3 预设页）、`/help/integration`、以及 `/stock-prep`（备料操作员壳，只作对照）。
>
> **产出方式**：5 个只读读图代理（页面结构 / 后端能力 / 对标特性 / 用户旅程 / 已知缺口）→ 9 个视角各自找差距（75 条原始）→ 语义去重合并成 58 条 → 每条一个对抗反驳者（"其实已有？"+"重要吗、对标证据真吗？"）→ 本文综合。反驳者核验因额度中断，**已核验 9 条、待核验 49 条**（表中"核验"列）；待核验条目的 file:line 由查找者给出、未经第二人复核，读者按"待证"看待。对标材料：飞书 aPaaS 帮助中心 7 篇（MySQL/Postgres/SQL Server/TiDB 连接器、MySQL 动态 SQL 操作说明、各类集成凭证的配置说明、第三方集成使用指南，2026-09-01 下载）；n8n / 数环通只有一般知识，条目里标 **[一般知识]**。
>
> 行号取自 2026-09-09 的 `main`（e89f3e15e 前后），与 PR #5587 合并后的行号会有偏移。

## 0. 一句话结论

**后端已经是"受治理的企业级集成"骨架（凭据加密、values-free、租户门、K3 写栅栏、引用守卫、溯源与死信），但页面把这副骨架摆成了一张 5000 行的长卷：能力有一半到不了 UI，到得了的也散在 12 个常驻分区里，术语不收口、失败不可见、触发接不上。** 差距不在"连接器不够多"，在"把已有能力交到实施工程师手里"。

五条要点：

1. **不差的地方**：治理与安全（加密凭据、只读账号 + K3 永久栅栏、租户声明门 W4、删除引用守衛、内容寻址读取源审批、死信 + provenance）在对标里找不到同等深度；2026-07-03 的判断"护城河 = 治理不是连接器广度"仍然成立。
2. **最大单点**：**平台触发器（定时 / webhook / 记录事件）与数据工厂管道之间没有绑定端口**（G04），管道还在 HTTP 请求内同步跑完（G06），失败零告警（G07）。"每天早上从 PLM 拉一遍"在产品内做不到，只能靠客户机计划任务 + 长期 token，而这条旁路本身又没有 SSRF/自环守卫（G05）。
3. **第二单点**：**连接只有 owner 私有一种作用域**（G02）。实施工程师建的源，顾问和一线看不到、选不到；离职后管道仍以其身份读源。这是 minimal-plan PR-2 的正题。
4. **UI 到达率**：转换引擎 8 种、校验 5 种，UI 只露一半（G27）；后端 `GET /runs` 支持筛选分页，前端锁死"最近 5 条"（G34）；模板 CRUD/instantiate 9 条路由前端零调用（G33）；`GET /api/data-sources/health` 零调用（G49）。**这些是 S/M 工作量的"零后端改动"收益**。
5. **页面本身**：长卷 + 左 rail、12 分区常驻、全局状态条不粘不滚（G01）、三套步骤模型互斥（G12）、同一概念 9 种叫法（G41）、主链路 9 个文件零双语（G42）。#5587 已补上 hash/`?section=` 落点，剩下的是"列表-详情"与"分区级折叠"两刀。

## 1. 记分卡（我们 vs 对标最好者，1–10）

| 视角 | 我们 | 对标 | 一行理由 |
|---|---|---|---|
| 信息架构与布局 | 4 | 8 | 单页长卷 + 12 分区常驻、状态条不粘（G01/G13/G15）；rail 与分区抽取已做，落点 #5587 已补 |
| 连接器与凭据管理 | 5 | 8 | 加密落库、测试、轮换齐；但 owner 私有（G02）、HTTP 只有 X-API-Key（G16）、无 SSL 项（G17）、测试与保存脱钩（G18） |
| 数据操作能力 | 4 | 8 | 只读源只有"整表 + 等值过滤"（G03）；页预算固定（G21）；增量只在 pipeline 一线（G22）；类型转换矩阵缺（G24） |
| 触发与编排 | 3 | 9 | 触发器到不了管道（G04）、同步运行无取消（G06）、直线管道无条件/串联（G26）；平台 Automation 已有 11 种触发器，缺的是端口 |
| 转换与映射 | 4 | 8 | 引擎能力 UI 只露一半（G27）、目标字段裸文本框（G28）、保存覆盖无 diff（G08） |
| 运行、监控与可观测 | 5 | 8 | run-log/provenance/死信后端强；UI 锁"最近 5 条"（G34）、零告警（G07）、失败原因不可见（G36） |
| 治理、权限与发布 | 6 | 7 | 加密/租户门/写栅栏/引用守卫领先；权限码未种子化（G09）、无 maker-checker（G38）、外部系统零审计（G20）、无环境与导入导出（G39/G40） |
| 上手、文案与帮助 | 3 | 8 | 三套步骤模型（G12）、9 种叫法（G41）、双语两极（G42）、K3 文案与围栏打架（G10） |
| 可扩展与生态 | 3 | 8 | kind 编译期封闭（G45）、113 条路由不在 OpenAPI/token scope（G44）、Bridge 只能 localhost（G46）；对标 SaaS 连接器目录是刻意不追（G58） |

## 2. 差距总表（58 条）

核验列：**✓** = 反驳者核验后成立（括号为修正后的严重度）；**✗** = 被驳回；**待** = 反驳者未跑。工作量 S/M/L 为查找者估计。

### P0（10 条）

| 编号 | 差距 | 工作量 | 核验 | 已知 |
|---|---|---|---|---|
| G01 | 全局状态条钉在页首且不粘：深处分区的保存/运行失败在视口之外，本地不留痕 | S | ✓（→P1） | — |
| G02 | 连接只有 owner 私有一种作用域：无 workspace 共享、无 use/manage/rotate 分权，运行主体永远是创建者 | L | ✓ | minimal-plan PR-2 |
| G03 | SQL 只读源没有参数化/多表/投影查询面：只能"整表或整视图 + 等值过滤"，等值过滤在 UI 也不可达 | L | 待 | — |
| G04 | 定时 / 入站 webhook / 记录事件三类触发器都到不了数据工厂管道：无受治理的绑定端口 | L | 待 | minimal-plan §3.1/§6.1 |
| G05 | Automation `send_webhook` 无 SSRF/自环守卫，是当前唯一的"产品内定时跑管道"旁路，且要把长期 Bearer 明文塞进规则配置 | M | ✓（→P1） | — |
| G06 | 管道在 HTTP 请求内同步跑完：无后台作业、无取消、无进度；卡死 running 只在下次触发按 4h 阈值被动清理 | L | ✓（→P1） | 48h 记录 :50、appendix G3 |
| G07 | 失败零告警：failed/partial、死信产生、无人值守拉取失败都不通知任何人；events.emit 申报了但从未使用 | M | ✓（→P1） | minimal-plan §3.1 |
| G08 | 保存清洗流程会用编辑器里的种子猜测静默覆盖已有 pipeline 的映射；映射无法从已保存 pipeline 回读 | M | ✓（→P1） | — |
| G09 | 数据工厂与外接数据源的六个权限码从未种子化：非管理员要进主旅程必须手写 SQL 建码、绑角色、开命名空间准入 | S | 待 | 记忆"直接授予被过滤成 403" |
| G10 | 主链路文案仍推销"Save-only 写回 K3"，运行时自 2026-08-29 永久禁止；撞上的错误码前端无人话 | M | 待 | 记忆"K3 写边界裁决=A" |

### P1（36 条）

| 编号 | 差距 | 视角 | 工作量 | 核验 |
|---|---|---|---|---|
| G11 | 分区零深链、零 URL 状态（**#5587 已补 hash/?section 落点；连接/死信级寻址仍无**） | 布局 | M | ✓（→P2） |
| G12 | 零首次上手引导：三套互斥步骤模型、DOM 顺序 ≠ rail 顺序、rail 不标"对 SQL 源不适用"、帮助中心不讲 SQL 源主旅程 | 布局/文案 | M | 待 |
| G14 | 租户/工作区作用域由 localStorage 与连接分区底部两个裸输入框决定：改后半页刷新半页不刷新 | 布局/治理 | M | ✓ |
| G15 | 连接管理是"列表 + 共享草稿"而非"列表-详情"：编辑即覆盖草稿无脏检查，界面看不到引用数（引用数列在 C 分支做） | 布局 | M | 待 |
| G16 | HTTP 凭据只有固定头名 X-API-Key 一种形态：Bearer 被 Zod 静默剥掉、Basic 只在后端、无自定义头/Query | 连接器 | M | 待 |
| G17 | SQL 连接表单无 SSL/证书信任/默认 schema/超时；SQL Server 默认 trustServerCertificate=true 对用户不可见 | 连接器 | S | 待 |
| G18 | 测试与保存脱钩且编辑态不能测；工作台连接草稿区没有测试按钮；列表把"未拨号"渲染成"未连接" | 连接器/文案 | M | 待 |
| G19 | 引用关系不可见、删除拒绝以英文原句回显；外部系统删除只查 pipeline，不查读取源/组合/备料源绑定 | 连接器/治理 | M | 待 |
| G20 | 外部系统、凭据与管道的增删改零审计；管道原地覆盖无版本/无 updated_by | 连接器/治理 | M | 待 |
| G21 | 分页预算固定且 UI 不可调：备料只读源 10 页×1000 行硬顶直接 422；pipeline 100 页后标 partial 且水位不推进 | 数据操作 | S | 待 |
| G22 | 增量/水位线只覆盖 pipeline 一条线：读取源、组合、备料 readonly-source-run 全部全量重读 | 数据操作 | L | 待 |
| G23 | 没有节点级"先跑一遍看结果"：dry-run 必须先保存 pipeline；SQL 预览固定 100 行在另一页；执行过的 SQL 不回吐 | 数据操作/映射 | M | 待 |
| G24 | 没有源类型→JSON→目标类型转换矩阵：二进制列经 JSON 变 `{type:'Buffer'}`，契约无处可查 | 数据操作/映射 | M | 待 |
| G25 | 重试、超时、背压三项无用户面：源读一抖整 run failed 且水位不推进；行写失败只能人工逐条 replay | 数据操作/触发 | M | 待 |
| G26 | 编排原语缺失：管道是单源→单目标直线，无条件/过滤/循环/多目标/串联；组合硬限两跳 | 触发编排 | L | 待 |
| G27 | 转换/校验引擎只有一小半能从 UI 到达：toDate/defaultValue/concat/转换链/pattern/enum 全部不可配 | 映射 | S | 待 |
| G28 | 目标字段是裸文本框、无自动匹配、不校验存在性/类型；目标 schema 只用来种前 8 行 K3 猜测 | 映射 | M | 待 |
| G29 | 映射保存无编辑期硬门：非法转换直到运行期逐行落死信；dictMap 未命中键静默透传原值 | 映射 | S | 待 |
| G30 | 读取源 fieldMap 要手打响应路径，探测证据不回吐字段清单——没有"预览并测试 → 使用输出" | 映射 | M | 待 |
| G31 | 列映射副驾确认后的 preset 只回到浏览器：不落库、不进目录、不可下载 | 映射 | M | 待 |
| G32 | 备料源列→ext_ 字段映射是部署机上的 JSON 文件，没有任何 UI、预览或审计；写错整个插件起不来 | 映射 | L | 待 |
| G33 | 模板目录三套互不相通：后端 CRUD/instantiate 前端零调用；前端 4 条种子全是 HTTP 向导，无 SQL 只读源主链路模板 | 映射/文案/扩展 | M | 待 |
| G34 | 运行监控锁死在"一个 pipeline 的最近 5 条 run + 5 条 open 死信"：无跨管道列表、无分页筛选、无详情、无轮询（后端已支持） | 可观测 | M | 待 |
| G35 | 死信只有单条 replay：无 discard、无批量、无按原因分组；replay 再失败复制出一条新死信 | 可观测 | M | 待 |
| G36 | 失败原因对用户不可见：死信 errorMessage 永不进 DOM 只剩泛化码，run.errorSummary 又原样直出；码表 50 条 vs 后端 86 个码 | 可观测/文案 | M | 待 |
| G37 | 备料真实写路径（表动作 dry-run/apply、大 BOM 作业）不进 integration_runs、不产生 provenance/死信/审计 | 可观测 | L | 待 |
| G38 | 读取源/组合/Bridge 清单的"审批"与"保存"同为 integration:write，同一人自存自批，无 maker-checker | 治理 | M | 待 |
| G39 | 沙箱→生产没有产品化发布通道：靠 env 与服务端配置文件切换，无 UI/API/版本/发布人 | 治理 | L | 待 |
| G40 | 配置不能导出/导入：跨环境复制"连接+读取源版本+组合+映射+管道"要手写 JSON | 治理 | M | 待 |
| G41 | 术语不收口：同一个"外部系统连接"9 种叫法，空选项写"请选择 adapter"，两个同型下拉无区分说明 | 文案 | M | 待 |
| G42 | 双语两极分化 + 默认 locale 为 en：主链路 9 个文件 0 处 bi()，中文用户看到英文枚举 | 文案 | M | 待 |
| G43 | 跨页/跨分区断链（**#5587 已改口三处、向导链接改指连接分区；K3/帮助页仍不在导航，工作台与 /stock-prep 零互指**） | 文案 | S | 待 |
| G44 | 数据工厂 113 条路由不在 OpenAPI、不接受作用域 API token、SDK 不覆盖：无受治理的机器调用面 | 扩展 | M | 待 |
| G45 | 没有自定义连接器扩展面：kind 编译期封闭、无按 kind 的 config/credential schema、HTTP 连接只能手写两段 JSON | 扩展 | L | 待 |
| G46 | Bridge Agent 只能是后端同机 localhost 单库只读旁路，不是客户内网侧的连接器宿主 | 扩展 | L | 待 |

### P2（12 条）

| 编号 | 差距 | 工作量 | 核验 |
|---|---|---|---|
| G47 | 无页面级加载态：bootstrap 期间空态引导先闪现；映射规则区无空态；多处结果是裸 `<pre>` JSON | S | 待 |
| G48 | 窄屏下 rail 失去 sticky 变页首横排按钮，且两套断点（960/900）不一致 | S | 待 |
| G49 | 连接健康只有手动测试：无后台探测、无失效提醒；`/health` 端点前端不调 | M | 待 |
| G50 | 凭据轮换无时间戳与提醒；加密主密钥无轮换/重加密路径 | M | 待 |
| G51 | 连接器目录元数据薄：plm 后端可用前端不可建；ID 手写无重名预检；无环境维度 | M | 待 |
| G52 | SQL Server 标识符只接受 ASCII：中文表/列名直接 Invalid identifier；字段列表无搜索/复制/类型 | M | 待 |
| G53 | 写操作：对标同节点可跑 INSERT/UPDATE/DELETE；我们只读源不写、K3 永久禁、HTTP 默认拒（**设计裁决，不追**） | L | 待 |
| G54 | 触发身份不可辨：runs 无 actor 列，triggeredBy 恒 'api'，定时脚本与顾问手点在监控里长得一样 | S | 待 |
| G55 | 无统计面板与 SLA：无成功率/耗时/失败趋势；总览五源 JOIN 不含运行健康 | M | 待 |
| G56 | 插件侧连接测试失败原文（含内网拓扑与登录名）持久化到 last_error 并被 read 层回读；core `/api/data-sources` 已在 #5586 收口，插件未对齐 | S | 待 |
| G57 | 转换层封闭 8 个函数：无沙箱表达式、无条件分支、无片段复用 | M | 待 |
| G58 | 与飞书/钉钉/宜搭的数据连接器为零（**有意延期，对外叙事须如实降级**） | L | 待 |

### 被反驳者驳回（1 条）

| 编号 | 原断言 | 驳回理由（摘） |
|---|---|---|
| G13 | "渐进披露只做到字段级，12 分区常驻无折叠" | 抽取后的分区组件已带默认折叠 `<details>`（连接分区高级 JSON、总览技术详情、向导证据、映射卡）；"active-section 只渲染当前组"已在备料壳 `StockPreparationWorkspace.vue` 落地一份；对标"高级配置折叠节"证据是帮助文档章节标题而非产品 UI。**真核**只剩"数据工厂管理员壳内无区块级折叠/切换"，且只对 integration:write 管理员成立——并入 G12/G15 的布局提案，不单列。 |

## 3. P0 详解（含证据与建议）

**G01 状态条不粘不滚（✓，修正为 P1）**。`IntegrationWorkbenchView.vue:27-29` 状态条、`:1965-1968` `setStatus` 是全页 91 处写入的唯一出口，CSS 无 sticky；`savePipeline`/`executePipeline`/`saveConnectionDraft` 失败只写它（`:3413`、`:3455`、`:2294`）。反驳者修正：分区级错误出口在仓内已有先例（`IntegrationConnectionSection.vue:19`），所以是"保存与运行等 API 失败路径无分区级落点"，不是"全页唯一出口"。**建议**：状态条 sticky；`setStatus` 加 `sectionId` 同时写入发起分区的 status slot；dry-run/保存失败必须写入分区结果区。

**G02 连接只有 owner 私有（✓）**。`routes/data-sources.ts:486` 是全仓唯一 `addDataSource` 调用点，硬编码 `scopeKind:'private'`；`DataSourceManager.ts:593 assertAccess` 只比 owner，注释自认"workspace_id is stored but NOT consulted (phase-2 lever)"；`scope_kind='workspace'` 生产路径零写入。反驳者补充：RBAC 层其实有 read/write/execute 切分（`:324/:451/:1025`），但在 owner 闸门之下形同虚设——非 owner 无论持何码都 404；轮换与改配共用 write。**建议**：按 minimal-plan PR-2：`PUT /:id/scope` 共享到工作区；权限拆 read/use/manage/rotate；facade `assertReferenceable` 与绑定按 use 判定；run 记录 `createdBy + triggeredBy`，创建者停用时预检报 `OWNER_INACTIVE`。

**G03 无参数化/多表查询面（待）**。`data-source-sql-readonly-source-adapter.cjs:284-297` 只允许等值原语、两段 ASCII 对象名、noRawSql；工作台保存 pipeline 不发 `options.source.filters`（`IntegrationWorkbenchView.vue:3225-3236`）；后端 `/query` 前端零调用。对标：`:variable` / `#{}` 绑参、`if/choose/foreach/include` 动态 SQL。用户影响是硬的：PLM 列零语义、含义在三张字典表、数量藏在 `Bom_ExAttr1`，BOM 行必须 JOIN，而只读账号无 DDL 权限建不了视图。**建议**：不做自由 SQL 编辑器，做"受治理的保存查询即对象"：管理员登记 SELECT 模板（复用 SELECT-only 分类器 + 只读账号双保险）、命名占位符声明、审批后作为"虚拟对象"出现在来源数据集下拉。第一刀（S）：把 `options.source.filters` 接到运行与推送表单。

**G04 触发器到不了管道（待）**。Automation 有 11 种触发器（`automation-triggers.ts:6-31`），16 种动作里无"运行集成管道"（`automation-actions.ts:33-50`）；插件 `triggeredBy` 留了 `'cron'` 槽位却无生产者（`pipelines.cjs:28`，路由恒 `'api'`：`http-routes.cjs:5403,5437`）；`integration_schedules` 是死表；`plugin.json` 未申报 scheduler。**建议**（= minimal-plan §6.1）：宿主 `IntegrationRunPort.request()` + `integration_run_requests` 表（唯一键 triggerId+scheduledFor / providerEventId）+ 独立 Integration Worker；Automation 新增 `run_integration_pipeline` 动作（只发请求、不携写授权、默认 dry-run）；`integration_schedules` 要么删要么由 Worker 接活。

**G05 send_webhook 旁路无守卫（✓，修正为 P1）**。规则驱动的 `send_webhook`（`automation-executor.ts:4114-4123`、两阶段 `:4247-4254`）对 `config.url/headers` 零校验直接 fetch；完备的 `webhook-ssrf-guard.ts` 只接在按钮字段路由（`routes/multitable-button.ts:57,358`）。反驳者修正：run 路由的 C6 多表写生命周期门不会被绕过，所以是"凭据暴露 + 触发身份不可辨"而非"绕过写入围栏"。**建议**：规则驱动 `send_webhook` 也走 `checkWebhookTargetUrl`（拒绝 loopback/私网 + 剥离指向本机的 Authorization）；run 路由识别自家 Automation 来源并标 `triggeredBy='automation'` 进审计。

**G06 同步运行、无取消（✓，修正为 P1）**。`pipelinesRun` 是 `await runner.runPipeline` 后回 202（`http-routes.cjs:5420`）；runner 同步分页循环（`pipeline-runner.cjs:936`）；状态词表含 `'cancelled'` 但无 cancel 路由、无 `cancel_requested` 列；`abandonStaleRuns` 默认 4h 且唯一调用点在 `runPipeline` 开头。反驳者修正：大 BOM 作业已是持久化存储，不属此差距。**建议**：`runPipeline` 拆 enqueue + worker：run 路由落 pending 立即 202；runs 表加 `cancel_requested` 与 `progress`；补 `POST /runs/:id/cancel` 与 GET 轮询；`abandonStaleRuns` 挂 SchedulerService；与 G04 的 Worker 同一实现。

**G07 失败零告警（✓，修正为 P1）**。runner 依赖清单无 notifier/events（`pipeline-runner.cjs:336-345`），失败路径 `:1200-1212` finishRun 后直接 throw；`plugin.json:15-16` 申报 `events.emit/listen` 但全插件零调用。反驳者修正："通知零件齐全却未接线"——Automation 已有 `send_webhook/send_notification/send_email/send_dingtalk_group_message`，宿主有 dingtalk-group-destination-service 并已按 destination id 注入插件（`http-routes.cjs:3696-3706`）。**建议**：runner 按 `status∈{failed,partial}` 与死信新增数 `context.events.emit('integration.run.finished' / 'integration.dead_letter.created')`（values-free 载荷）；automation-triggers 加这两个触发器，复用现有动作。

**G08 映射静默覆盖（✓，修正为 P1）**。前端对 pipeline 只有 upsert/run 六处调用，无按 id 回读；`mappings` 唯一赋值源是前 8 字段 + K3 硬编码猜测的种子（`IntegrationWorkbenchView.vue:3021-3048`）；带 id 保存携全量 `fieldMappings`，后端 `replaceFieldMappings` 先 DELETE 再 INSERT（`pipelines.cjs:528-531`）；无审计、runs 不快照映射。反驳者修正：触发要用户显式粘贴 ID，8 条种子行保存前可见，所以是"无防护的可逆性缺失"，定 P1。**建议**：服务层补 `getIntegrationPipeline(id)` 回填；种子映射打标，id 非空且全为种子时拒绝保存或弹 diff；"粘贴已有 ID"改下拉选。

**G09 权限码未种子化（待）**。`integration:read/write/admin` 与 `data_sources:read/write/execute` 六码在 migration/seed/插件清单里都不存在（对照 `zzzz20260830100000_add_stock_prep_permissions.ts:33-35` 只种子 stock-prep），而 `role_permissions` 外键到 `permissions(code)`，两个资源都不在免准入名单（`rbac/namespace-admission.ts:11-40`）。**建议**：照 stock-prep 迁移形状种子化六码；`app.manifest.json` 声明；交付说明给"三个角色 = 哪些码"模板。这是 S 工作量却决定非管理员能否进主旅程。

**G10 K3 写回文案与围栏打架（待）**。页头副标题（`IntegrationWorkbenchView.vue:5`）、4 步流程第 4 步（`:642`）、运行与推送标题（`:222`）、K3 预设页 lead 都把 Save-only 推送当终点；后端自 2026-08-29 用 `K3_WISE_PIPELINE_RUN_DISABLED` / `K3_WISE_EXTERNAL_WRITE_DISABLED` 四层拒绝（`k3-external-write-permanent-fence.cjs:3-11`），码表 50 条无此键，`executePipeline` catch 把英文原文塞状态条（`:3455`）；同屏总览卡写"只读·永不写入"。**建议**：两个 DISABLED 码进 `errorCodeLabels` 并复用备料 `plainLanguage.ts:178` 的表述；副标题/流程条/标题改"dry-run 后导出或写入多维表；K3/通用 HTTP 目标只读"；目标命中 `isK3ExternalWriteTargetKind` 时 Save-only 按钮直接不渲染。

## 4. 目标页面布局提案

**现状**：`PageShell wide` → 4 步流程条 → 操作路径一行 → 全局状态条 → 左 rail（8 组，纯锚点滚动 + IntersectionObserver）+ 12 个常驻分区（含运行与推送里 5 个子面板），DOM 顺序 ≠ rail 顺序（payload 预览属清洗映射组却排在监控后），5210 行单文件、95 个 ref / 124 个 computed；`/data-sources` 独立页（#5587 起并入连接管理分区）；K3 预设页与帮助页是独立路由但不在导航。

**目标信息架构**（改布局 vs 补功能分开标）：

```
数据工厂（一级导航，integration:write）
├─ 总览            [改布局] 保留 hub-overview；卡片加运行健康（G55，补功能）
├─ 连接            [改布局] 列表-详情：行 = 一条外接数据源或外部系统，
│                   列：类型 / 状态(最近测试) / 被引用 N / 凭据更新于；点行进详情抽屉
│                   (基本信息 · 测试 · 凭据 · 引用方 · 审计)；新建 = 选类型→填信息→测试并保存
│                   （G15/G18/G19/G20 补功能；外接数据源面板 #5587 已并入，先作为该列表的一个来源）
├─ 数据集与查询    [改布局] 原「读取源 / 组合 / 选择系统与数据集」三组合一：
│                   按连接分组列出对象；「试读 N 行」（G23）；受治理的保存查询（G03，补功能）
├─ 清洗与映射      [改布局] 原「清洗数据集 / 映射规则 / 样例·目标模板·Payload 预览」合一，
│                   Payload 预览只在 K3 目标时展开；目标字段下拉 + 自动匹配（G28）；
│                   转换/校验 UI 与引擎对齐（G27）；保存前校验（G29）
├─ 运行            [改布局] 原「运行与推送」拆两层：主区 = dry-run / 推送 / 导出；
│                   「高级动作」折叠 = 表动作 / 外部写 / 字段选项同步（admin）
│                   （异步运行 + 取消 + 进度 = G06 补功能；触发绑定 = G04 补功能）
├─ 监控            [改布局] 跨管道运行列表（状态/时间筛选、翻页、详情）+ 死信按原因分组 +
│                   7 天成功率（G34/G35/G55 补功能；告警 G07 补功能）
├─ Bridge Agent    不动（PR-3 之前）
└─ 帮助 / K3 预设  [改布局] 进二级导航；帮助加「SQL 只读源→多维表」端到端案例（G12）
```

**页面级规则**（改布局，全部 S/M）：
- rail 点击 = 路由切换（`?section=` 已由 #5587 支持），**每次只渲染当前组**（其余 `v-show` 保留状态）；分区内再用 `<details>` 做二级折叠。这就是 IU-2b 原计划的 active-section 模式，备料壳已有范本（`StockPreparationWorkspace.vue:66+`）。
- 状态条 sticky + 分区级 status slot（G01）；bootstrap 期间 `v-loading`，空态只在 `!bootstrapping` 后出现（G47）。
- 三套步骤模型收敛为一套，与 rail 组一一对应，每组标"第 N 步 / 适用连接类型"（G12）。
- 术语表进帮助首节：连接 = 外接数据源上的登记；数据集 = 表/视图/对象；清洗表 = staging 多维表（G41）。
- 租户/工作区从页面输入框改为页头作用域徽标，值只从会话取（G14）。

## 5. 三波路线图（与现有计划对齐）

**第一波（进行中，本周）**：#5587 外接数据源并入连接管理 + hash/?section 落点（G11/G43 部分）；#5588 备料错误码补 `SOURCE_UNAVAILABLE`；#5590 G4 M2 去公共投影回退；C 分支「被引用 N」列 + 删除前提示（G19 前端半）；D 分支向导①拆分 + 门对齐；#5576 验收脚本。

**第二波（零/少后端改动的 UI 到达率，S/M，2–3 周）**：
1. G09 六个权限码种子化 + 交付说明角色模板（S）
2. G01 状态条 sticky + 分区级 status（S）
3. G27 转换/校验 UI 对齐引擎全集（S，后端零改动）
4. G29 映射保存门 + dictMap 未命中三选一（S）
5. G34 监控筛选/翻页/详情（M，后端已支持）+ G35 discard/批量（M）
6. G10 K3 文案改口 + 两个 DISABLED 码进码表（M）
7. G36 死信结构化 reason + admin 门后"展开原文"（M）
8. G21 batchSize/maxPages 暴露 + 422 文案进 codeHelp（S）
9. G18 编辑态"用已存凭据测试" + 工作台草稿区测试按钮（M）
10. G17 SQL 高级折叠（SSL/信任证书/超时/默认 schema）（S）
11. G54 runs 加 actor/trigger_source（S）
12. G56 插件测试失败路径对齐 #5586 的分类码（S）
13. G42 主链路 9 个文件补 bi() + CI tripwire（M）
14. 布局第一刀：active-section 模式 + DOM 顺序改成 rail 顺序 + 三套步骤模型收敛（M）

**第三波（结构性，L，按 minimal-plan 顺序）**：
1. PR-2：G02 工作区共享 + use/manage/rotate 分权；G19 外部系统删除引用扩到读取源/组合/备料绑定；G20 外部系统与管道审计 + `updated_by`
2. G04 + G06 + G07：触发端口 + `integration_run_requests` + Integration Worker + 异步运行/取消 + 失败事件→Automation 通知（同一实现）
3. G03 受治理保存查询即对象；G22 读取源水位；G26 filter / next 串联
4. G39/G40 环境维度 + 发布动作 + 配置包导出/导入
5. G44 OpenAPI 只读契约 + `integration:read/run` token scope；G45 adapter configSchema/credentialSchema 驱动表单
6. PR-3：G46 Bridge 降为 data_sources 的 transport_kind，去 localhost 硬限制

## 6. 明确不追的方向与伪差距

- **连接器广度 / SaaS 目录（G58）**、**通用写回（G53）**、**n8n 式画布（G26 的画布部分）**、**Bridge 远程 fleet（G46 的集群部分）**、**运行时安装第三方连接器（G45 的 SDK 部分）**：维持 2026-07-03 对标结论与 minimal-plan §6.2/§6.3 的延期裁决。对外材料相应降级："支持钉钉/飞书/宜搭对接"不能写；写回边界（只读账号是可证明保证、K3 永久禁、HTTP/DB 写逐目标授权）作为差异化写进帮助与交付说明。
- **移动端适配（G48）**：design-lock §6 已排除，只以"窄桌面窗口"名义做 sticky 横向 rail。
- **伪差距 G13**："渐进披露只到字段级"被驳回，见 §2 末表。
- 反驳者对 6 条 P0 的共同修正：**"其实已有，只是在 API / 别的模块 / 需要配置"** 是本仓最常见的形态（G05 SSRF 守卫、G07 通知动作、G34 runs 筛选、G33 模板 instantiate、G49 health 端点）。这些差距的正确表述是"UI 到达率"，工作量也相应是 S/M，不要按 L 立项。

## 7. 与 2026-07-03 对标相比，两个月变了什么

| 2026-07-03 判断 | 现在 |
|---|---|
| "连接器/适配器：K3、PLM、通用 SQL、Bridge，partial→strong" | 未变；但外接数据源登记表成了唯一连接真源（PR-1 #5452：`connection_id` 绑定、`tenant_id`/`scope_kind`、双读 resolver），G4 M2（#5590）去掉了公共投影回退 |
| "治理 = 护城河" | 加固：W4 租户声明门、作用域洞三象限修复（#5471/#5497/#5581）、503 `SOURCE_UNAVAILABLE` 不回显（#5586）、S6-A 溯源 pin 体系 |
| "可观测 strong（DF-N 运行监控、provenance、死信）" | 后端未变；本次发现 UI 只暴露"最近 5 条"、零告警、备料写路径不进台账（G34/G07/G37）——**后端强、前端弱**是新结论 |
| "UI 未来：IU-2 rail + 分区抽取" | IU-2a/2b/2c 已合（rail、8 组、分区组件化），但 active-section 模式没做；#5587 补了落点与外接数据源并入 |
| 未提及 | 触发端口缺失（G04）与同步运行（G06）在 07-03 文档没有被识别为主线阻塞，本次定为最大单点 |

## 8. 本文的局限

- 49 条未经反驳者核验，file:line 可能有偏差或"其实已有"的漏判；额度恢复后会补跑并更新本文（核验列会改）。
- n8n / 数环通条目全部是一般知识，未核对当前版本。
- 未做真实浏览器走查，布局结论来自代码与 jsdom 结构；分区高度、首屏密度等视觉判断以实际截图为准。
