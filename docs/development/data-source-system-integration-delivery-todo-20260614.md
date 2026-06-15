# 数据库连接与系统对接交付收尾 TODO

状态日期: 2026-06-14

本文只跟踪“数据库连接能力接入系统并最终可交付”的剩余开发量。它不替代各功能线自己的设计文档/验证文档；每个 runtime 写能力仍然必须单独 opt-in、单独 PR、单独实体机验证。

## 当前结论

- 只读数据库接入 Data Factory 源系统: 已经基本可用。
- 可交付定义: C6 外部写能力完成并通过实体机验收后，才称为完整交付。
- 下一步建议: C2-close 已通过实体机 smoke；C3-1 / C3-2a / C3-3a / C3-2 / C3-4(unit)
  已落地；继续 C3-5 real-DB / entity-machine 验证。
- 不建议: 现在直接开 C6。C6 是最大风险刀，必须等只读链路、增量链路、K3 generic seam 都稳定后再开。

## 收口顺序

| 顺序 | 阶段 | 状态 | 目标 | 主要风险 |
| --- | --- | --- | --- | --- |
| P0 | ②b arc 收口权限/契约修复 | done (#2597) | 已排已合并主线风险 | related-echo 跨 base 泄漏 |
| C2-close | 只读数据库链路 smoke 收口 | done (#2600) | 证明当前 read-only bridge 可稳定测试 | 实体机配置漂移 |
| C3 | incremental / watermark runtime | gated; C3-1/#2609, C3-3a/#2619, C3-2a/#2625, C3-2+C3-4(unit)/#2628 done; C3-5 pending | 避免每次全量读数据库 | 游标漏读 / 重读 / 过滤条件漂移 |
| C4 | UI / 配置体验统一 | gated | 让用户不手写 JSON | 产品误导 / 凭据边界混乱 |
| C5 | K3 generic MSSQL seam | gated | K3 SQL Server 通道复用 generic MSSQL 能力 | K3 红线被误开 |
| C6 | external write | gated | 外部系统写回能力 | 权限、幂等、回滚、部分失败 |
| Release | 总包 + 实体机验收 | gated | 交付签收 | 包内容/部署/证据不完整 |

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

状态: 已完成，#2600 实体机 smoke PASS。

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
- C3 watermark、C6 external write、K3 Save/Submit/Audit/BOM 在本 smoke 中均未运行，仍是后续 gated 项。

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
    组合、注入拒绝、以及 maxPages partial/no-watermark-advance；C3-5 仍需真实 DB wire-vs-fixture 验证。
- [ ] C3-5 实体机 real-DB smoke: 跨页同 timestamp 不漏读、不卡住、可 resume。

完成条件:

- 同 timestamp 大批量数据不会漏读。
- `>=` 型 stall 和 `>` 型 tie miss 都被测试锁住。
- offset full-read 仍可作为 fallback，不被破坏。
- 当前 equality `filters` 不能因 watermark 模式被旁路；C3 测试必须覆盖 filter + watermark 同时存在。
- watermark cursor 不能原样进入 run details / evidence；只能落 values-free redacted marker。
- `maxPagesReached` 必须使 run 进入 partial 且不推进 watermark，不能把截断读伪装成成功。
- watermark 列必须有索引/`EXPLAIN` 验证；否则可能比全量扫描更差。
- 时间戳精度并列风暴必须进入测试。
- 迟到提交漏读属于固有限制: 要么记为限制，要么设计安全重扫窗。
- UUID 非单调 id 不能被当作 monotonic cursor；若参与排序，必须有确定性 tie-break 语义。
- wire-vs-fixture 集成测试必须断言真实请求/响应里的游标字段，而不是只测 fixture。

## C4 - UI / 配置体验统一

目标: 让普通操作员不依赖手写 JSON。

TODO:

- [ ] Workbench data-source source picker 完整化: connection / object / schema / table。
- [ ] column picker: 支持选择 source object 字段。
- [ ] watermark 配置 UI: 随 C3 一次纳入，避免先做一版只支持全量读的配置面。
- [ ] preview 中显示 read-only/source-only 边界。
- [ ] 错误提示产品化: auth、owner mismatch、missing object、missing schema、unsupported source。
- [ ] 凭据边界: UI 只能引用 `dataSourceId`，不得输入或复制 credentials。

完成条件:

- 操作员能在 UI 内完成配置，不需要知道内部 JSON shape。
- `/data-sources` 仍是唯一凭据管理面。

## C5 - K3 Generic MSSQL Seam

目标: 把 K3 SQL Server 相关通道逐步靠近 generic MSSQL 能力，但不打开 K3 禁区。

边界:

- 不打开 K3 Submit。
- 不打开 K3 Audit。
- 不打开 BOM 写入。
- 不用 generic DB write 绕过 K3 adapter 的安全合同。

TODO:

- [ ] 设计先行: 哪些 MSSQL helper 可复用，哪些 K3 专属逻辑必须保留。
- [ ] 抽共享只读 helper: TLS + INFORMATION_SCHEMA introspection 等只读能力可共用，由 generic `MSSQLAdapter` 和 K3 路径共同消费。
- [ ] 结构守卫测试: shared helper 不导出任何写接口。
- [ ] TLS / schema introspection / read-only smoke 与 generic MSSQL 对齐。
- [ ] K3 SQL Server executor 只作为 precedent，不成为 generic adapter 的反向依赖。
- [ ] 实体机 K3/MSSQL smoke。

完成条件:

- K3 路径可复用 generic MSSQL 的稳定能力，但红线不变。
- 任何 K3 写能力仍走自己的显式 gate。

## C6 - External Write

目标: 最终交付门槛。外部系统写回能力必须设计优先、分阶段、实体机验证。

必须设计先行:

- [ ] 写入对象和目标系统范围。
- [ ] 权限模型: 谁可以 dry-run，谁可以 apply。
- [ ] dry-run / apply 双阶段。
- [ ] token/revision 绑定，防止“看的是 A，写的是 B”。
- [ ] 幂等键和重复写保护。
- [ ] 每行失败隔离。
- [ ] dead-letter / provenance。
- [ ] rollback / re-pull 验证。
- [ ] owner-gated + sandbox-first；首次外部写不得直接生产。
- [ ] max-in-flight / 熔断 / 外部系统保护。
- [ ] values-free 审计轨: 记录谁、何时、用哪个 dry-run token apply；不记录外部系统值。
- [ ] revision fencing 是硬围栏，不是提示；目标自 dry-run 后变化时必须拒绝 apply。
- [ ] 禁止 batch-abort 后不可恢复的半写状态。
- [ ] 禁止自动重试打爆外部系统。

实现切片建议:

- [ ] C6-0 design: 写合同、权限、幂等、回滚、证据。
- [ ] C6-1 backend latent writer helper: 不接 UI，不自动运行。
- [ ] C6-2 dry-run route: read-only，values-free evidence。
- [ ] C6-3 apply route: token-bound，permission-bound，per-row result。
- [ ] C6-4 UI: dry-run -> review -> apply。
- [ ] C6-5 entity-machine smoke: apply、re-pull、rollback。

完成条件:

- 外部写入前必须 fresh dry-run。
- apply 只写 operator review 过的 revision。
- re-pull 证明幂等，不重复创建。
- 出错行进入可解释的 row-level failure，不吞、不批量炸。

## Cross-Cutting - 运行账本 / 可观测层 Seam

当前计划主要覆盖 connector/read/write 能力，但还必须在 Release 前定清它和既有 Data Factory 可观测层的关系。

待定问题:

- [ ] `data-source:sql-readonly` 读是否必须进入同一运行账本。
- [ ] DB source run 是否产出 provenance。
- [ ] per-row failure 是否进入 dead-letter。
- [ ] 是否接入既有 run-record / DF-N 监控面。

完成条件:

- 如果要求纳入统一 Data Factory 运行账本，C3/C6 必须补 provenance/dead-letter/run-record 接线和测试。
- 如果暂不纳入，Release 文档必须明确这是另一条 track，不得把“可读”误描述为“已接入完整 DF 观测层”。
- C6 per-row result 字段必须有 wire-vs-fixture 集成测试，断言真实 route body/response，不只测 helper fixture。

## Release - 总包与实体机验收

TODO:

- [ ] `git rev-list --count main..origin/main == 0` 后再发包。
- [ ] 从已合并 main 构建 on-prem package。
- [ ] 生成 `.tgz` / `.zip` / `.sha256` / `SHA256SUMS` / verify reports。
- [ ] 实体机部署。
- [ ] 干净实体机 / 全新 DB smoke，用来暴露 migration 排序缺口。
- [ ] 部署前跑 pending-migration diff + auth round-trip；静默 401 优先按 schema/migration 缺口排查，不先归咎 JWT secret。
- [ ] C2 read-only smoke。
- [ ] C3 incremental resume smoke。
- [ ] C4 UI config smoke。
- [ ] C5 K3 seam smoke。
- [ ] C6 dry-run/apply/re-pull/rollback smoke。
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
