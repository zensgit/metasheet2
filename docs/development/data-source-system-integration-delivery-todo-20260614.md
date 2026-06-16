# 数据库连接与系统对接交付收尾 TODO

状态日期: 2026-06-16

本文只跟踪“数据库连接能力接入系统并最终可交付”的剩余开发量。它不替代各功能线自己的设计文档/验证文档；每个 runtime 写能力仍然必须单独 opt-in、单独 PR、单独实体机验证。

## 当前结论

- 只读数据库接入 Data Factory 源系统: 已经基本可用。
- 可交付定义: C6 外部写能力完成并通过实体机验收后，才称为完整交付。
- 下一步建议: C2-close 已通过实体机 smoke；C3 core runtime + CI real-DB wire lock 已落地；
  C4 配置体验和已知 polish 已落地（source/object/schema picker、source-field picker、watermark config、
  read-only/source-only 边界提示、SQL bridge values-free 错误提示）。
  Large-BOM #2425 的 scoped C3/C4 实体机全链路验证已 PASS/CLOSED；Windows 短 TEMP zip 部署 caveat
  另由 #2642 跟踪，不阻塞 runtime gate。
  C5 K3/MSSQL smoke gate #2670 已在 `dea391a1` 包上通过并关闭：operator scope-adjusted rerun
  中 generic SQL Server smoke 和 K3 SQL Server executor smoke 均 PASS，且 evidence values-free、无 K3
  Save/Submit/Audit/BOM、无外部 DB 写、无 raw SQL。#2700 已补 C5 runbook 的 SQL auth/scope triage。
- 下一门: C6-5 entity-machine smoke。C6 是最大风险刀；C6-0 只锁 design contract，
  C6-1 只落地 backend latent writer helper 和 write-gated target adapter 的关闭态合同；
  C6-2 只增加 read-only dry-run route + dry-run token，不授权 apply runtime 或 external write。
  C6-3 增加 token-bound apply route；C6-4 UI dry-run -> review -> apply 已合并并发出实体机
  smoke 包；#2720 已完成 sandbox 配置和核心 dry-run/apply/re-pull/rollback smoke，
  但 read-only 子门仍 HOLD，下一步需确认实体机 read-only 检查命中的是
  C6 专用 `/external-write/dry-run` 路由，而不是普通 write-gated pipeline `/dry-run` 路由。

## 收口顺序

| 顺序 | 阶段 | 状态 | 目标 | 主要风险 |
| --- | --- | --- | --- | --- |
| P0 | ②b arc 收口权限/契约修复 | done (#2597) | 已排已合并主线风险 | related-echo 跨 base 泄漏 |
| C2-close | 只读数据库链路 smoke 收口 | done (issue #2600) | 证明当前 read-only bridge 可稳定测试 | 实体机配置漂移 |
| C3 | incremental / watermark runtime | core done through CI real-DB lock (#2609/#2619/#2625/#2628/#2631); bind-time/index hardening deferred | 避免每次全量读数据库 | 游标漏读 / 重读 / 过滤条件漂移 |
| C4 | UI / 配置体验统一 | done (#2643/#2646/#2649/#2652/#2655); later UX polish demand-gated | 让用户不手写 JSON | 产品误导 / 凭据边界混乱 |
| C5 | K3 generic MSSQL seam | done (#2670 PASS/CLOSED; #2700 runbook triage) | K3 SQL Server 通道复用 generic MSSQL 能力 | K3 红线被误开 |
| C6 | external write | C6-0 design locked; C6-1 latent helper done; C6-2 dry-run route done; C6-3 apply route done; C6-4 UI done (#2719); C6-5 issue #2720 open | 外部系统写回能力 | 权限、幂等、回滚、部分失败 |
| Release | 总包 + 实体机验收 | C6-5 smoke package published; #2720 core C6 sandbox smoke PASS, read-only subgate HOLD | 交付签收 | 包内容/部署/证据不完整 |

## P0 - ②b Arc 收口 Follow-Up

目标: 在继续新功能前，先修已合并主线上的权限/契约风险。

状态: 已完成，#2597 / squash `29d619289`。

锚点校准:

- ②b arc 已经推进过 #2582 之后的收口 PR: #2585 / #2586 / #2587 / #2588 / #2589。
- 这些 PR 没关闭本段列出的四个剩余项，所以 P0 仍有效。
- 但本段不再叫 "#2582 follow-up"；它是 ②b arc 的收口 follow-up。

严重度:

| 优先级 | 项 | 级别 | 性质 |
| --- | --- | --- | --- |
| P0.1 | `crossSheetRelated` related echo 补 `base-read` gate | 最高 | 真实跨 base 信息泄漏 |
| P0.2 | same-base 预存 `foreignBaseId` claim | 中 | 一致性/潜伏状态加固，不是新增越权 |
| P0.3 | PATCH 只发 `foreignBaseId` 产生孤儿 claim | 中低 | 数据完整性健壮性 |
| P0.4 | 空/非字符串 `foreignBaseId` sanitizer | 低 | 惰性卫生项 |

TODO:

- [x] P0.1: `crossSheetRelated` 写入回显补 cross-base `base-read` gate；仅 sheet-read 不够。
  - [x] 修点落在 shared helper 层，一处覆盖 PATCH 回显和 A2 AI-shortcut 路由。
- [x] P0.2-P0.4 统一成一个 `foreignBaseId` claim 不变式，避免三处散补:
  - [x] claim 有效当且仅当有 `foreignSheetId`，且 claim == foreign base truth。
  - [x] same-base claim 只能缺省或等于自身 base truth；不得预存外部 base claim。
  - [x] PATCH 只发送 `foreignBaseId` 不得把 link property 改成无 `foreignSheetId` 的不可解析状态。
  - [x] 空字符串、空白字符串、非字符串值必须从 link property 中真正剔除。
- [x] 测试覆盖:
  - [x] same-base create + `foreignBaseId` 被拒绝或剔除。
  - [x] same-base create 预存 claim 后 retarget cross-base 不可绕过。
  - [x] empty/null/non-string `foreignBaseId` 不持久化。
  - [x] cross-base related write echo 在无 foreign-base-read 时不返回 related ids/data。
- [x] 子智能体复审通过。
- [x] CI fresh green 后合并。

完成条件:

- `foreignBaseId` 的 opt-in 语义只在“当前 link target 已明确跨 base 且 claim == foreign base truth”时成立。
- 所有 read/echo sink 对 cross-base 外表都经过 base-read 粗粒度 gate 或显式 fail-closed。
- #2/#3/#1 不被放大为越权问题；执行排期仍以 #4 related-echo leak 为最高优先。

## C2-Close - 只读数据库链路 Smoke 收口

目标: 证明当前 `data-source:sql-readonly` 可以作为 Data Factory 源系统稳定使用。

状态: 已完成，issue #2600 实体机 smoke PASS。

验证锚点:

- issue: #2600 `[C2-close] read-only SQL data-source smoke matrix on entity machine`
- package: `metasheet-multitable-onprem-v2.5.0-datasource-c2close-20260614-f483bfdac`
- release: `multitable-onprem-datasource-c2close-20260614-f483bfdac`
- evidence: PostgreSQL / MySQL-MariaDB / SQL Server 全部通过 testConnection / listObjects /
  getSchema / read dry-run；`rowsRead > 0`，`rowsWritten = 0`，`rowsFailed = 0`；Workbench
  只保存 `dataSourceId+object`，凭据仍只在 `/data-sources`。

已完成基线:

- [x] `/data-sources` 管理数据库连接。
- [x] Workbench 通过 `dataSourceId` 引用连接，不复制凭据。
- [x] `data-source:sql-readonly` source adapter / facade / runner / picker 已落地。
- [x] schema/object 加载和 dry-run read 主链路已实体机验证过。
- [x] dangling/stale `dataSourceId` 已返回清晰 4xx；C2-close 不再包含开发项。

完成项:

- [x] 当前 main/package 上再跑实体机 smoke。
- [x] PostgreSQL: testConnection / listObjects / getSchema / read smoke。
- [x] MySQL/MariaDB: testConnection / listObjects / getSchema / read smoke。
- [x] SQL Server: testConnection / listObjects / getSchema / read smoke。
- [x] issue 留 values-free 证据: 不贴连接串、账号、密码、表数据值。

完成条件:

- 操作员可以从 UI 创建/选择只读数据库源，并完成 dry-run read。
- 失败路径可读、不可泄漏、不可误判为系统崩溃。
- C3 watermark、C6 external write、K3 Save/Submit/Audit/BOM 在本 C2 smoke 中均未运行；C5 SQL seam
  也不得新开这些 K3 行为。既有 K3 WebAPI 路径按其自身 gate 管理，不由本文的数据库连接 smoke 放行。

## C3 - Incremental / Watermark Runtime

目标: 从“可读”进入“可处理较大数据量”，避免每次全量读。

设计锁:

- `updated_at` 默认走复合游标 `(updated_at, id) > (lastTs, lastId)`。
- `monotonic_id` 走严格 `field > last`。
- 游标模式必须带 mode tag。
- runner 解析 `watermarkConfig` 后传给 adapter；adapter 不重新猜。
- filters 必须保留，不能因增量读取被丢弃。

TODO:

- [x] C3-1 facade 支持 `orderBy` 并保留 `where`/equality `filters` passthrough。
  - #2609 / squash `1586c3841`.
  - 仍是 host-side seam；未打开 watermark runtime、未改变 adapter cursor、未新增写能力。
- [x] C3-3a runner 透传 resolved `watermarkConfig`，并对 `data-source:sql-readonly`
  的 `updated_at` 增量配置强制声明 tiebreaker。
  - #2619 / squash `7f61709ea`.
  - 目标: adapter 后续实现 keyset 时读取同一个 runner-resolved config，不再自己猜 `type/field/tiebreaker`。
  - 边界: 不生成 watermark `where/orderBy`，不改变 offset cursor，不打开 C3-2/C3-3 runtime。
- [x] C3-2a structured `where` 逻辑分组 + MySQL operator parity。
  - #2625 / squash `c2c59994c`.
  - 目标: 先让 Postgres/MSSQL/MySQL 的 structured read 能表达
    `field > last OR (field = last AND tiebreaker > lastTie)`，为 `updated_at + id`
    复合 keyset 铺底。
  - 边界: 不生成 watermark predicate，不解析/推进 cursor，不改变 offset full-read 行为，不新增写能力。
- [x] C3-2 adapter 实现 watermark keyset runtime + in-run mode-tagged cursor；跨 run 仍复用现有
  watermark store，不改 store schema。
  - #2628 / squash `f587cf122`.
  - 当前实现 slice: `data-source:sql-readonly.read()` 在有 `watermark + watermarkConfig` 时生成
    type-conditional structured `where/orderBy`。
  - `updated_at`: 第一页从 store floor 用 `>=` bounded re-read，后续页用 `(field,tiebreaker)` composite cursor。
  - `monotonic_id`: 严格 `field > last` 单键 cursor；SQL BIGINT 值按 integer string 传递，避免 JS Number
    精度丢失。
  - offset/full-read 无 watermark 时保持原路径；wrong-mode cursor fail-closed；watermark cursor 不原样写入 run
    details，只存 values-free redacted marker。
  - 若读到 `maxPages` cap 仍未完成，run 标记 partial 且不推进 watermark，避免跳过未读行。
- [x] C3-4 filter + watermark composition lock（unit 层）。
  - #2628 / squash `f587cf122`.
  - plugin adapter unit 层已覆盖 equality `filters` 与 watermark predicate 的 structured `$and`
    组合、注入拒绝、以及 maxPages partial/no-watermark-advance。
- [x] C3-5 CI real-DB wire-vs-fixture lock: 跨页同 timestamp 不漏读、不卡住、可 resume。
  - #2631 / squash `834b4e41d`.
  - 新增 Node 20 real-DB integration test，走真实路径:
    `data-source:sql-readonly` adapter -> host facade -> `DataSourceManager` -> `PostgresAdapter` -> Postgres。
  - 锁住 `where`/`orderBy` 穿透、`updated_at + id` 复合 cursor 推进、以及 SQL BIGINT
    monotonic id 字符串保真。
  - 注意: 这关闭 C3 watermark 的 real-DB wire lock；#2425 Large-BOM C3/C4
    实体机 run/plan/checkpoint-apply/re-pull idempotence 是后续独立 gate，已在
    `b6383d4d3` 包上 PASS/CLOSED。

完成条件:

- 同 timestamp 大批量数据不会漏读。
- `>=` 型 stall 和 `>` 型 tie miss 都被测试锁住。
- offset full-read 仍可作为 fallback，不被破坏。
- 当前 equality `filters` 不能因 watermark 模式被旁路；C3 测试必须覆盖 filter + watermark 同时存在。
- watermark cursor 不能原样进入 run details / evidence；只能落 values-free redacted marker。
- `maxPagesReached` 必须使 run 进入 partial 且不推进 watermark，不能把截断读伪装成成功。
- CI real-DB test 必须断言 facade -> manager -> adapter -> DB 路径保留 structured `where/orderBy`。
- watermark 列必须有索引/`EXPLAIN` 验证；否则可能比全量扫描更差。
- 时间戳精度并列风暴必须进入测试。
- 迟到提交漏读属于固有限制: 要么记为限制，要么设计安全重扫窗。
- UUID 非单调 id 不能被当作 monotonic cursor；若参与排序，必须有确定性 tie-break 语义。
- wire-vs-fixture 集成测试必须断言真实请求/响应里的游标字段，而不是只测 fixture。

## C4 - UI / 配置体验统一

目标: 让普通操作员不依赖手写 JSON。

TODO:

- [x] Workbench data-source source picker 完整化: connection / object / schema / table。
  - #2643 / squash `c1ec03fb7`.
  - 结构化 bridge object picker 从 `/api/data-sources` schema 生成 schema/table 选项；保存仍只落
    `config.dataSourceId + object`，不复制凭据。
- [x] column picker: 支持选择 source object 字段。
  - #2646 / squash `c71b7dd12`.
  - mapping editor 的 `sourceField` 在已加载 source schema 时变为字段下拉；保留 stale value 作为显式
    “当前值（未在来源 schema 中）”，不静默清空旧配置。
- [x] watermark 配置 UI: 基于已落地 C3 runtime 补齐配置体验，避免操作员继续依赖内部 JSON。
  - #2649 / squash `34f53a4cc`.
  - incremental 模式保存 `options.watermark`；manual/full 不带 watermark。
  - `data-source:sql-readonly + updated_at` 必须使用当前 source schema 中的 watermark field 和不同的
    tiebreaker；source system/object 切换会清理旧 schema，避免 stale schema 误放行。
- [x] preview 中显示 read-only/source-only 边界。
  - #2652 / squash `828d1356b`.
  - Workbench payload preview 面板在选中 `data-source:sql-readonly` 来源时显示只读边界:
    Payload 预览和 dry-run 只读取数据库源；Save-only 只写目标系统，不会写回该数据库连接。
  - 边界: display-only；不改 backend/runtime/DB/K3/external write。
- [x] 错误提示产品化: auth、owner mismatch、missing object、missing schema、unsupported source。
  - #2655 / squash `2d53bce14`.
  - SQL readonly / data-source bridge 的 schema picker、source object load/test、connection badge 和 async
    delayed error 都走 values-free、可操作错误提示；非 bridge 系统保留 legacy raw status。
  - 测试锁住 dangling/not-found 不泄漏 dataSourceId、owner-principal 权限提示、unknown SQL driver
    error 不回显 password/token/database hints、以及切换 source 后延迟失败仍按请求开始时的 bridge kind 脱敏。
  - 边界: Workbench presentation/status only；不改 backend/runtime/API/logging/K3/external write 合同。
- [x] 凭据边界: UI 只能引用 `dataSourceId`，不得输入或复制 credentials。
  - C2/C4 UI 保存路径只引用 dataSourceId；#2600 实体机 smoke 也验证 Workbench 不复制凭据。

完成条件:

- baseline: 操作员能在 UI 内完成 read-only source/object/schema/column/watermark 配置，不需要知道内部 JSON shape。
- `/data-sources` 仍是唯一凭据管理面。
- 后续 C4 仅保留 demand-gated UX polish；当前交付链路不再依赖手写 JSON，也不再依赖 raw SQL bridge
  错误文本来排障。任何新 polish 不得改变 runtime 合同。

## C5 - K3 Generic MSSQL Seam

目标: 把 K3 SQL Server 相关通道逐步靠近 generic MSSQL 能力，但不打开 K3 禁区。

状态: C5-0 设计切片已写入 `docs/development/data-source-system-integration-c5-k3-generic-mssql-seam-design-20260615.md`；
C5-1 latent helper contract 已落地为 `@metasheet/mssql-readonly-utils`；C5-2 已把 generic `MSSQLAdapter`
的 endpoint/TLS/identifier 稳定面接到 helper；C5-3 已把 K3 default SQL Server executor 的 endpoint/timeout/limit/simple-select
接到 helper，同时保留 K3 strict identifier/read/write guard。C5-4a smoke harness 已落地，#2669 修复了 helper-backed
executor 的 on-prem package/verifier seam。C5-4b 实体机 smoke 已通过 #2670；#2675 修复包内容缺少 runbook /
generic smoke script，#2684 修复 packaged generic smoke 的 deploy `dist` adapter entrypoint。`dea391a1`
包的实体机 scope-adjusted rerun 已 PASS：generic SQL Server smoke 通过 connect/schema/tableInfo/select，
K3 SQL Server executor smoke 通过 testConnection/read，issue #2670 已关闭。#2700 已把本次暴露出的
SQL auth/scope triage 固化进 runbook，后续同类失败先按 operator-side scope 分类，不直接回到代码改动。

边界:

- 不打开 K3 Submit。
- 不打开 K3 Audit。
- 不打开 BOM 写入。
- 不用 generic DB write 绕过 K3 adapter 的安全合同。

TODO:

- [x] C5-0 设计先行: 哪些 MSSQL helper 可复用，哪些 K3 专属逻辑必须保留。
  - 设计锁: 安全 seam 是 read-only MSSQL helper contract，不是 `DataSourceManager`、不是完整
    `MSSQLAdapter`、也不是把 `erp:k3-wise-sqlserver` 改成 `data-source:sql-readonly`。
  - 可复用: server/port parsing、timeout/TLS option building、identifier quoting、bounded structured SELECT、
    metadata query helpers、values-free error normalization。
  - K3-only: object manifests、read/write table allowlists、operation checks、默认 middle-table write guard、
    既有 backend-only direct-table exception、adapter metadata / advanced UI posture。
- [x] C5-1 抽共享只读 helper contract（latent）:
  - 新增 neutral workspace package `@metasheet/mssql-readonly-utils`，CJS runtime + TypeScript declarations。
  - helper exports 只包含 read-only/normalization/building primitives；无 insert/update/delete/upsert/transaction/raw
    execution 面。
  - generic `WhereClause` 保留 `$and`/`$or`/comparison operators；K3 simple-select policy 仍拒绝 unsupported
    operator object；limit/timeout/TLS 均按 consumer policy 锁住。
  - core-backend TS consumer test 和 plugin-integration-core CJS consumer test 均按 package name import/require。
  - `plugin-integration-core` 先以 production workspace dependency 引入 helper；本切片仍无 production call-site，
    但提前验证后续 C5-3 运行时依赖会随插件安装/打包进入解析图。
  - 边界: 不改 `MSSQLAdapter`、不改 `k3-wise-sqlserver-executor.cjs`、不改任何 production call site。
- [x] 结构守卫测试: shared helper 不导出任何写接口，neutral helper 不 import core/plugin internals；
  core-backend 不 import plugin internals，K3 plugin 不 import `DataSourceManager` / `MSSQLAdapter`。
- [x] C5-2: generic `MSSQLAdapter` 最小生产接线到 helper，保持现有 MSSQL adapter tests / smoke harness 行为不漂移。
  - 已迁移: server/port parsing、legacy TLS option building、MSSQL identifier quoting。
  - 未迁移: `WhereClause` builder 仍留在 `BaseAdapter`，避免本刀改变 Postgres/MySQL/MSSQL shared where 语义；
    INFORMATION_SCHEMA schema introspection 仍留在 `MSSQLAdapter`，等 C5-4 smoke 对齐。
  - core-backend 将 helper 从 devDependency 提升为 runtime dependency；generic adapter 生产代码现在按 package name
    import helper。
- [x] C5-3: K3 default SQL Server executor 迁移到 helper 的 test/select 路径，保持 K3 read/write guard 不漂移。
  - 已迁移: endpoint parsing、timeout / limit policy、structured simple SELECT builder、identifier quoting primitive。
  - K3 guard 保留: executor 在调用 helper 前仍先执行 K3 strict identifier policy（最多 schema.table、每段字母/下划线开头）；
    不继承 generic MSSQL helper 的 numeric-leading / 多段 identifier 放宽。
  - built-in `insertMany` 仍抛 `SQLSERVER_WRITE_EXECUTOR_DISABLED`；K3 Submit/Audit/BOM/direct table write scope 不变。
- [x] C5-4a: TLS / read-only smoke harness 准备。
  - K3 default SQL Server executor 支持与 generic MSSQL 同名的 opt-in legacy TLS knobs:
    `legacyTls` / `tlsMinVersion` / `tlsCiphers`。
  - K3 默认 TLS 姿态不变；只有显式 legacy TLS knobs 时才添加 `cryptoCredentialsDetails`，且
    `encrypt=false` + legacy TLS fail-closed。
  - 新增 `pnpm --filter plugin-integration-core smoke:k3-sqlserver-executor`，通过 K3 channel + built-in executor
    跑 values-free `testConnection` + bounded read。
  - 新增 C5 K3/MSSQL smoke runbook，明确 generic `smoke:sqlserver` 负责 schema introspection，K3 smoke 负责
    `erp:k3-wise-sqlserver` test/select。
- [x] C5 package/verifier seam for helper-backed K3 executor。
  - #2669 / squash `8cd6ca7ef`.
  - on-prem package 现在包含 `packages/mssql-readonly-utils` 本体，而不是只留下
    `plugin-integration-core/node_modules/@metasheet/mssql-readonly-utils` workspace symlink。
  - package verifier 锁住 backend/plugin 两侧 runtime dependency、`pnpm-lock.yaml` workspace link、
    helper `package.json` 的 `name/main`、helper bounded `SELECT TOP` builder、以及 K3
    `SQLSERVER_WRITE_EXECUTOR_DISABLED` marker。
  - 这是 C5-4b 发包前置修复；不改变 runtime 行为、不打开任何 K3 写能力。
- [x] C5-4b: 实体机 K3/MSSQL smoke。
  - issue: #2670 `[Data Source] C5 K3/MSSQL entity-machine smoke gate`。
  - first package attempt: `multitable-onprem-datasource-c5-k3-mssql-smoke-20260615-8cd6ca7ef`
    (`metasheet-multitable-onprem-v2.5.0-datasource-c5-k3-mssql-smoke-20260615-8cd6ca7ef`)。
    Entity-machine result: package deploy/health OK, but package omitted the generic SQL smoke script and C5 runbook。
  - [x] #2675 / squash `3d789daef`: package now includes the generic SQL smoke script and C5 K3/MSSQL smoke
    runbook; verifier hard-checks both smoke scripts, runbook commands, legacy TLS knobs, and no-write boundary。
    Entity-machine result: package content fixed, but generic smoke failed before SQL connectivity because packaged
    script imported TS source adapter path absent from deploy root。
  - [x] #2684 / squash `dea391a1`: generic smoke loads the deployable compiled adapter
    `packages/core-backend/dist/src/data-adapters/MSSQLAdapter.js` first; TS source adapter path is local/dev fallback
    only; verifier requires the compiled deployable adapter and dist-first loader markers。
  - active release: `multitable-onprem-datasource-c5-generic-smoke-entry-20260616-dea391a1`。
  - active package: `metasheet-multitable-onprem-v2.5.0-datasource-c5-generic-smoke-entry-20260616-dea391a1`。
  - active release workflow: `https://github.com/zensgit/metasheet2/actions/runs/27590977500`。
  - package verify: assetCount=10；`SHA256SUMS` OK；tgz/zip verify reports published
    with `checksum,required-content,deployability-contract,no-github-links`。
  - [x] 实体机部署 active package 后，在同一批准环境中运行 generic SQL Server smoke + K3 SQL Server executor
    smoke；package fingerprint=`dea391a1`，deploy/health/package-content 均通过。
  - [x] generic smoke 不再以 `script_runtime_import_missing_source_asset` / `MODULE_NOT_FOUND`
    在 SQL connection 前失败；它已到达 compiled deployable `MSSQLAdapter` + SQL Server connection 层。
  - [x] operator-approved SQL 登录、数据库 scope、表权限确认后，重跑 generic SQL Server smoke；
    scope-adjusted entity-machine rerun PASS: `connected=pass`、`schemaIntrospection=pass`、
    `tableInfo=pass`、`select=pass`。
  - [x] K3 SQL Server executor smoke PASS: `testConnection=pass`、bounded read PASS、`rows=1`。
  - [x] output boundary PASS: credentials / connection string / row values not printed；target object/table
    redacted；values-free evidence preserved。
  - [x] #2700 / squash `e1b010ca5`: C5 smoke runbook now includes SQL auth/scope triage for
    `login_failed` / `SQLSERVER_TEST_FAILED`, with least-privilege read-only scope guidance and values-free
    evidence fields.
  - saved MetaSheet SQL Server source `connected` 只是必要条件，不是 C5 PASS；official smoke 更严格，
    会携带明确 read target 并在实体机 runtime adapter path 下验证。
  - 只回传 package fingerprint、status、TLS knob 名称/布尔、operator-configured object/table 名、计数；
    不回传 credentials、connection string、raw SQL、row values、K3 payload。

完成条件:

- K3 路径可复用 generic MSSQL 的稳定能力，但红线不变。
- 任何 K3 写能力仍走自己的显式 gate。
- C5 read-only smoke gate 已在 #2670 关闭；这不授权 C6 external write，也不授权 K3 Save/Submit/Audit/BOM。

## C6 - External Write

目标: 最终交付门槛。外部系统写回能力必须设计优先、分阶段、实体机验证。

设计锚点:

- C6-0 design: `docs/development/data-source-system-integration-c6-external-write-design-20260616.md`。
- 设计结论: C6 写能力必须走显式 write-gated target contract；不能把既有
  `data-source:sql-readonly` source adapter 改成可写。
- C6-0 只锁合同，不引入 runtime、route、UI、package 或 external write。
- C6-1 只引入 backend latent writer helper、host write facade、`data-source:sql-write-gated`
  target adapter metadata/test/schema 面，以及 raw query/delete 绕行封锁；`upsert` 仍不广告、不实现，
  外部写必须等 C6-3 token-bound apply route。

必须设计先行:

- [x] 写入对象和目标系统范围。
- [x] 权限模型: 谁可以 dry-run，谁可以 apply。
- [x] dry-run / apply 双阶段。
- [x] token/revision 绑定，防止“看的是 A，写的是 B”。
- [x] 幂等键和重复写保护。
- [x] 每行失败隔离。
- [x] dead-letter / provenance。
- [x] rollback / re-pull 验证。
- [x] owner-gated + sandbox-first；首次外部写不得直接生产。
- [x] max-in-flight / 熔断 / 外部系统保护。
- [x] values-free 审计轨: 记录谁、何时、用哪个 dry-run token apply；不记录外部系统值。
- [x] revision fencing 是硬围栏，不是提示；目标自 dry-run 后变化时必须拒绝 apply。
- [x] 禁止 batch-abort 后不可恢复的半写状态。
- [x] 禁止自动重试打爆外部系统。
- [x] C6 写目标必须关闭 generic raw query / execute / delete 绕行面；不能只引用普通
  `readOnly:false` data source。

实现切片建议:

- [x] C6-0 design: 写合同、权限、幂等、回滚、证据。
- [x] C6-1 backend latent writer helper: 不接 UI，不自动运行。
  - host `context.api.dataSourceWrites` facade 与 read facade 分离，只暴露 structured
    test/schema/lookup/insert/update 方法；不暴露 raw query/delete/credentials/adapter/transaction。
  - `data-source:sql-write-gated` 注册为 target-only metadata；只支持 test/listObjects/getSchema，
    `upsert` 显式 unsupported，直到 C6-3 token-bound apply route。
  - C6 writable target 必须同时是 `readOnly:false`、`c6WriteTarget:true`、`genericQueryDisabled:true`；
    generic `/api/data-sources/:id/query` 和 `DataSourceManager.query/delete` 对该目标 fail-closed。
  - pipeline target adapter creation 透传 `pipeline.createdBy` 给未来写 facade；缺 principal 不回退系统身份。
  - C6-1 边界: 无 UI、无 dry-run/apply route、无 package、无真实 external write、无 K3。
- [x] C6-2 dry-run route: read-only，values-free evidence。
  - route: `POST /api/integration/pipelines/:id/external-write/dry-run`。
  - read-only user may dry-run; request body only accepts `tenantId` / `workspaceId` / `maxRows`。
  - dry-run reads source rows, performs structured target key lookup, produces counts/evidence, and issues a
    dry-run token only for apply-eligible plans.
  - response/evidence are values-free; token is returned for future C6-3 apply but is not included in evidence.
  - boundary: no apply route, no UI, no insert/update/upsert/delete, no package, no K3。
- [x] C6-3 apply route: token-bound，permission-bound，per-row result。
  - route: `POST /api/integration/pipelines/:id/external-write/apply`。
  - request body only accepts `tenantId` / `workspaceId` / `confirm.dryRunToken`；client-supplied
    `source` / `target` / `plan` / `payload` 等 scope/payload 字段在 pipeline load 前拒绝。
  - apply requires integration write/admin and the same authenticated principal that produced the dry-run token.
  - token is single-use and revision-bound；apply consumes the token, recomputes the same server-side plan,
    and rejects before any write if source/target/capability/mapping/lookup/decision drifted。
  - host durable plugin storage provides atomic token consume (`DELETE ... RETURNING`)；non-durable local/test
    storage is additionally guarded by an in-process per-token lock。
  - writes only apply-eligible `add`/`update` rows through `context.api.dataSourceWrites` structured
    `insertRows` / `updateRows`; `skip` rows are no-write, conflicted/held rows remain blocked by the
    apply-eligible dry-run requirement。
  - row write failures are isolated and returned as values-free counts/error codes; response/evidence never echoes
    the bearer token, row values, credentials, connection strings, raw SQL, target payloads, or dataSourceId secrets。
  - boundary: no UI, no package, no C6 entity-machine smoke yet, no delete/raw SQL/generic query, no K3。
- [x] C6-4 UI: dry-run -> review -> apply。
  - #2719 / squash `9fb34fd91`.
  - pipeline-level UI calls the C6 dry-run/apply routes separately from legacy Save-only and PLM table-action flows.
  - browser request shape remains scope-only for dry-run and scope + `confirm.dryRunToken` for apply;
    no client `source` / `target` / `plan` / `payload` / sheet scope is sent.
  - review renders counts/status/error tokens only; dry-run token is held in memory and never displayed or copied
    into the values-free evidence panel.
  - apply is disabled for read-only users and requires an explicit review checkbox.
  - changing pipeline id or scope clears the pending dry-run token/review.
- [ ] C6-5 entity-machine smoke: apply、re-pull、rollback。
  - issue: #2720 `[Data Source] C6 external-write entity-machine smoke gate`.
  - runbook: `docs/operations/data-source-system-integration-c6-sandbox-smoke-runbook-20260616.md`.
  - release: `multitable-onprem-datasource-c6-ui-20260616-9fb34fd91`.
  - package: `metasheet-multitable-onprem-v2.5.0-datasource-c6-ui-20260616-9fb34fd91`.
  - source commit: `9fb34fd91e4f3bdfa7827d57ca3b362abbcb05bd`.
  - package verify: `.tgz` / `.zip` verify reports published, `SHA256SUMS` present.
  - #2720 initial deploy/preflight HOLD resolved: sandbox write data source, `data-source:sql-write-gated`
    target, and active C6 pipeline were created on the entity machine.
  - #2720 core sandbox smoke PASS: C6 dry-run returned ready without mutating target; token-confirmed
    apply wrote sandbox rows only; re-pull was idempotent (`add=0`, no duplicates); operator-local
    cleanup restored baseline.
  - remaining HOLD: read-only subgate reported `403` for dry-run and apply. Apply `403` is correct,
    but dry-run must be rechecked against the dedicated C6 route
    `POST /api/integration/pipelines/:id/external-write/dry-run`, not ordinary
    `POST /api/integration/pipelines/:id/dry-run` (ordinary pipeline dry-run remains write-gated).
  - C6-5 remains sandbox/entity-machine validation only; no production/batch rollout.

完成条件:

- 外部写入前必须 fresh dry-run。
- apply 只写 operator review 过的 revision。
- re-pull 证明幂等，不重复创建。
- 出错行进入可解释的 row-level failure，不吞、不批量炸。

## Cross-Cutting - 运行账本 / 可观测层 Seam

当前计划主要覆盖 connector/read/write 能力。Release 前的可观测层边界已按 C6 design 固化:
本交付不新增 read-side DF-N 统一账本切片；C2/C3 读路径使用既有 pipeline run/run details 能力，
不承诺 per-row DB-read provenance。C6 apply 因为会写外部目标，仍必须进入 values-free
dead-letter/provenance/run evidence。

决策:

- [x] `data-source:sql-readonly` 读不新增单独 DF-N 统一账本要求；通过既有 pipeline runner 执行时保留
  `integration_runs` run/run details。
- [x] DB source read v1 不产出 per-row source-read provenance；这是后续 DF-N/read-observability track。
- [x] C6 apply per-row failure 进入 values-free dead-letter / provenance（C6-3 route 已接线；C2/C3 read/run
  侧不扩大到 per-row source-read provenance）。
- [x] Release 文档不得把“可读”误描述为“完整 DF-N per-row read lineage”；若后续要接入统一
  run-record / DF-N 监控面，必须另开 opt-in。

完成条件:

- 当前 Release scope 暂不纳入 read-side DF-N 统一账本；这是另一条 track。
- 不得把“可读数据库源”误描述为“已接入完整 DF per-row read lineage”。
- 若未来要求纳入统一 Data Factory 运行账本，C3/C2 read/run 侧仍需补 provenance/dead-letter/run-record
  接线和测试。
- C6 per-row result 字段必须有 wire-vs-fixture 集成测试，断言真实 route body/response，不只测 helper fixture。

## Release - 总包与实体机验收

TODO:

- runbook: `docs/operations/data-source-system-integration-release-smoke-runbook-20260616.md`.
- [x] `git rev-list --count main..origin/main == 0` 后再发 C6-5 smoke 包。
- [x] 从已合并 main 构建 C6-5 on-prem package。
- [x] 生成 `.tgz` / `.zip` / `.sha256` / `SHA256SUMS` / verify reports。
  - release: `multitable-onprem-datasource-c6-ui-20260616-9fb34fd91`.
  - package: `metasheet-multitable-onprem-v2.5.0-datasource-c6-ui-20260616-9fb34fd91`.
  - `.tgz` SHA256: `8659e9bfbad0c51efe55238108dc7b84a72a19478bf0f841cfa26d76e2cd784f`.
  - `.zip` SHA256: `9b771902fca4c607422d6ac30e63bf3fe95b576537fc7b9f6c2f767a25d6ab3c`.
- [x] C6-5 smoke package deployed on entity machine for preflight; full smoke still HOLD.
- [x] C6-5 package deploy preflight: #2720 reports `deploy.applyExit=0`, `health=200`, dry-run/apply
  route presence, token guard, and target-kind requirement present.
- [x] C6-5 sandbox write-gated target + active C6 pipeline configured on entity machine.
- [ ] 干净实体机 / 全新 DB smoke，用来暴露 migration 排序缺口。
- [ ] 部署前跑 pending-migration diff + auth round-trip；静默 401 优先按 schema/migration 缺口排查，不先归咎 JWT secret。
- [ ] C2 read-only smoke。
- [ ] C3 incremental resume smoke。
- [ ] C4 UI config smoke。
- [x] C5 K3 seam smoke。
- [ ] C6 dry-run/apply/re-pull/rollback smoke（#2720）。
  - core sandbox smoke PASS; read-only dedicated dry-run subgate remains HOLD until endpoint-specific
    rerun proves `integration:read` can call `/external-write/dry-run` while apply stays blocked.
- [ ] issue 上贴 values-free 验收证据。

交付判据:

- C6 未完成前: 只能称为“只读数据库接入可用”。
- C6 完成并通过实体机验收后: 才称为“数据库及系统连接能力可交付”。

## 并行策略

可以并行:

- C2 smoke 准备与 C3 设计细化材料。
- C3 runtime 与 C4 UI 设计材料。
- C5 design 与 C3 实体机验证准备。

不建议并行:

- C6 与 C3 runtime 同时写。
- C6 与 C5 K3 seam 同时写。
- 任何 external write 与未验证的权限/echo 修复同时合并。

审阅纪律:

- 每个 PR 至少一个子智能体并行审阅。
- 安全/权限/写入 PR 必须两个视角: runtime 语义 + 测试覆盖。
- 子智能体发现 P1/P2 时，直接修复到复审通过再合。
- 每次合并前确认 `origin/main`、fresh CI、mergeable 状态。
