# 多维表 历史 / 时光机能力 — 总体开发计划 + 门控 TODO (RECONCILED AS-BUILT 2026-07-09)

> Status: **RECONCILED AS-BUILT 2026-07-09**（原 PROPOSED 2026-06-29）。本文与两份 20260619 草稿曾经
> PR #3381 提交、同日撤回，搁浅于分支提交 `a3286d405`，未上过 main。2026-07-09 owner 指令接续本线，
> 按 #4000（GW 锁 reconcile）同款纪律恢复上 main 并逐行对账：**表格状态列已翻至 2026-07-09 实况**（全部引用
> 均对 origin/main 核验），plan→as-built 偏差与剩余池见新增 **§9**。权威现状图 =
> `multitable-global-history-verified-state-map-and-decision-menu-20260703.md`（#3542）+ R1–R8 轮次记录。
> 正文其余段落（§0 基线叙述、§4 现状列之外的文字）保留 2026-06-29 时点原文。
> 把三条线（记录级收尾 / 全局时光机弧 / schema·快照纵深）合并成一张可跟踪的门控清单。
> 计划文档，**不改任何代码**；每个 🔒 项需单独 owner opt-in，每个 📄 项需 design-lock 先行 + ratify。
> 依赖：`multitable-time-machine-plus-design-lock-20260619.md`（同 PR 一并提交，T0 ratify）、
> `multitable-time-machine-plus-todo-20260619.md`（全局弧逐切片 scope/测试细则）、已 on main 的
> `multitable-record-restore-layer1-design-20260615.md`。外部产品对标基线见内部 research 基准（不在本文展开）。
> 标记：✅ 已完成(on main) · 🟡 部分 · ⬜ 待开发(未门控) · 🔒 owner-gated · 📄 design-lock 先行。

## 0. 目标能力集 与 基线
**目标能力**（完整「时光机」对外能力面）：统一操作历史时间线（**配置 + 数据**，改前/改后 diff）· 时间点只读查看（看成 T 时刻）
· **时间点（整表 / 范围）恢复** · 回收站 / 恢复被删记录 · 可配留存窗口 · 还原回滚数据/配置但**不回滚权限**。

**基线（现状）**：**记录级**修订捕获 + 单记录历史读 + 单记录恢复已扎实落地并 on main（约覆盖目标的 ~40%）；
**整表时光机本体（时间点查看/恢复）尚未建**。`multitable-time-machine-plus-*` 两份为**本地草稿、未提交/未 ratify**——
故 **T0 = 提交并 ratify 这两份**。

## 1. Track R — 记录级收尾（底座已在，低风险，可与 TM 并行）
| ID | 项 | 状态 | 依赖 | 解锁能力 |
|---|---|---|---|---|
| R0 | 记录级修订捕获（create/update/delete 全写路径，snapshot+patch+actor）+ 单记录历史读 + 单记录恢复(Lock A–D, 错误码, Yjs) | ✅ | — | 查看记录历史 / 单条还原到版本 |
| R1 | **Slice 3 FE 收尾**：workbench `onRestoreRecordVersion` 接 API client + 抽屉刷新；**列级(单字段)恢复** UI | ✅（#3542 §1.1 核验：抽屉 + preview-before-execute + 列级恢复防泄漏加固） | R0 | 记录历史抽屉闭环 |
| R2 | **Slice 2 undelete + link 恢复**：记录**软删**(`deleted_at`/trash) + 恢复被删记录并重建 `meta_links`+mirror 扇出；link 字段值恢复 | ✅（trash+restore 早已在；PIT undelete #3307 → 4c-2 捕获 #3901 → 4c-3 inbound replay #3975/#3985，flag 默认关；侧门删除 trash 覆盖=D-2 残留，见 §9.3） | 软删设计锁 | 回收站 / 恢复被删记录 / link 还原 |
| R3 | **留存上线**：开启 `MULTITABLE_META_REVISION_RETENTION_ENABLED` + 选 keep-last-n/keep-days + 接线 `VERSION_EXPIRED` + revision 唯一性加固(partial unique index) | 🟡 机制全建全接线（#3541 一 tick 双 sweep：record+config），**启用=O-2 阶梯（🧭 owner，STOP-SHIP 联动见阶梯文档）** | R0 | 可配留存窗口 |

## 2. Track TM — 全局时光机弧（整表时间点查看/恢复本体；逐切片细则见 `...-todo-20260619.md`）
| ID | 项 | 状态 | 依赖 | 解锁能力 |
|---|---|---|---|---|
| T0 | **Design-lock ratify**（提交两份草稿 + 决 open decisions + 数据模型/MVP 边界）；零 runtime diff | ✅ 以「逐切片锁 + ratify」变体达成（pit-restore 锁 20260619 → 4c-1/4c-2 锁 20260707 → 4c-3 锁 20260708；R6 ratification record 20260708）；两份草稿由本 PR 恢复为历史档 | — | 解锁后续全部 |
| T1 | **历史批次投影** `history_batches`/`history_changes`（从 revisions 物化：增删改/restore/字段 set·unset/actor/source/batch 关联） | ✅ as-built 变体：**未建物化表**，读时投影 over `meta_record_revisions.batch_id`（迁移 zzzz20260619120000）+ `meta_config_revisions`（=设计锁 §8 开放决策 1 的「projected on read」选项，见 §9.1） | T0 | 统一历史**数据底座** |
| T4 | **权限安全查询加固**（denied 记录不进 list/total；hidden 字段不进 filter/detail/preview；missing≡denied 形状；admin 旁路显式；flag-off 惰性） | ✅（#3542 §1.4/§1.5；LOCK-3 字段层修复 #2968；masking parity mutation-proven；denied≡missing 同形已 golden 化） | T0（与 T2/T3 同落或更早） | 历史不成 side-channel（硬底线） |
| T2 | **全局历史中心 UI**（入口 + 时间线 + 时间/人/动作/sheet/字段 筛选 + 标题搜索 + 游标分页 + 空/载/错态） | ✅ `HistoryCenterModal`（常开工具栏入口 + 全筛选 + 游标分页；10 FE specs） | T1 + T4 | 统一操作历史时间线 |
| T3 | **批次详情 / diff 钻取**（改前/改后、受影响记录·字段数、按记录分组、回链记录抽屉、restore 批次回链） | ✅ 批次详情路由 `…/history/events/:batchId` + 按记录分组 + 掩码 before/after 内联 diff（#3608 + T1b before-hydration #3626）+ pinned-batch 深链（共享渲染器 `HistoryBatchChangesList`） | T1 + T4 | 改前改后对比 / 单元格级变更(派生) |
| T5 | **恢复预览 dry-run**（批/记录/字段/变更级；报 denied/schema-drift/missing/版本冲突/link·formula 副作用；preview token） | ✅ 各恢复族 preview 端点 + preview-identity（`restore-preview-identity.ts`；#3606 跨族 token 拒绝矩阵 8 族/56 对；as-built 偏差见 §9.1） | T3 + T4 | 还原前预演 |
| T6 | **范围化恢复**（按预览身份：选中记录/字段/变更/权限过滤子集；写 forward revision + `source=restore` 批次 + 回链） | ✅ field-subset + restore-batch preview/execute（PARTIAL 默认 + allOrNothing opt-in）· forward-writing `source:'restore'` · execute 时重跑 per-record deny/version 门 | T5 | 选择性还原 |
| T7 | **时间点只读视图**（重建为 T 时刻、只读；字段掩码 + rule-deny + 删除策略 + 大表分页） | ✅ `reconstructRecordsAtT` 只读重建原语（delete-aware，确定序）+ PIT 预览面；as-built 形态=API/预览而非独立浏览页（§9.1） | T1/T3/T4 成熟 | 看成 T 时刻 |
| T8 | **时间点恢复（核心）**：把 sheet/子集回滚到 T 时刻 | ✅ T8-1 revert-to-T（非破坏，常开）+ T8-2 reset-to-T（破坏，flag，13 条 realdb 测试 +3 inbound-capture + RESET_RETENTION_CONFLICT 护栏）+ PIT undelete（flag）+ D-3 reset 补捕获 + D-1 侧门删除 revision 补齐（#3969/#3992）→ PIT-as-of-T 正确性闭合；FE=`ResetToPointPicker`/`ResetConfirmDialog` + T-source A2 锚定选点（#3749） | T7 + 回滚语义单独 ratify | **整表一键还原到历史版本** |
| T9 | **配置/Schema 历史**：加/删字段、改类型、视图/筛选/权限/自动化 变更 捕获+展示（恢复另设计） | ✅ 捕获+展示（`meta_config_revisions` 4 实体类型；`MetaConfigHistoryModal`）+ 安全子集恢复常开 + 5 个 revert tier（flag）+ 破坏性 tier FE typed-confirm（#3749，硬化 #3857）；恢复与数据恢复分离如设计（LOCK-7） | 数据历史后单独立项 | 配置维度历史（完整对齐的最后一块） |

## 3. Track S — schema-inclusive 快照（Layer 2，可选纵深）
| ID | 项 | 状态 | 依赖 | 备注 |
|---|---|---|---|---|
| S1 | **MetaSnapshotService**：base/sheet 级、含 schema(字段/视图/link) 的检查点 + 治理面(锁/保护级/过期/标签/审计) | 🔒📄 **仍未建**（全计划唯一未开工的整项；单独立项） | 单独立项 | 比点恢复更重；纵深，非对外能力必需 |
| S2 | **type-changed schema-drift 检测**：revision 时存 schema-at-capture，使 Layer 2 识别类型漂移（当前仅靠值校验兜底） | ✅ 变体闭合：`SCHEMA_DRIFT` 恢复错误码 + 4c-1 type-era guard（preview+execute 双侧、in-txn，#3922）；原「revision 存 schema-at-capture」机制未建、不再需要 | S1 或独立 | 关闭 Layer 1 已知残缺 |

## 4. 能力 → 关闭项 矩阵（现状列已翻至 2026-07-09）
| 目标能力 | 现状（2026-07-09） | 关闭于 |
|---|---|---|
| 统一操作历史时间线（配置+数据，改前改后） | ✅ 已闭合 | **T1+T2+T3**（数据）、**T9**（配置） |
| **整表一键还原到任意历史版本** | ✅ 已建，**启用=O-2**（flag 默认关） | **T7→T8** |
| 时间点查看 | ✅ 已闭合（as-built=API/预览面，§9.1） | **T7** |
| 单元格编辑历史 | ✅ 已闭合（批次详情内联 per-field diff） | **T3** 派生呈现 |
| 回收站 / 恢复被删记录 | ✅ 已建（undelete 系 flag 默认关；侧门删除=D-2 残留） | **R2** |
| 可配留存窗口 | 🟡 机制全建，**启用=O-2** | **R3** |
| 还原不回滚权限 | ✅ 已采纳（permission-revert 为独立 gated tier，且 de-escalation-only） | **T8 设计需显式采纳** |
| 配置/schema 历史 | ✅ 已闭合（恢复 tier flag 默认关） | **T9** |

## 5. 推荐顺序 + MVP
1. **read-only 优先 MVP（可见度最大、零回滚风险）**：`T0 → T1 → T4 → T2 → T3 → T5`
   = 历史中心主界面 + 改前改后 + 还原**预演**，全程不改数据。
2. **门控回滚（各自 owner GO，风险递增）**：`T6 → T7 → T8`。
3. **并行低风险**：Track R（R1 收尾、R3 留存）随时可推；R2(undelete) 需软删设计锁先行。
4. **最后/独立**：T9 配置历史、S1 快照。
> 红线：T6 不在 T5 之前；T8 不进 MVP（先证 list/detail/query 安全，再开任何全局回滚面）。

## 6. 验收纪律（每切片必带）
- **real-DB golden 必须进 `plugin-tests.yml` 的 real-DB allowlist，并核到日志「文件真的跑了」**（不是只看 CI 绿——此前已两次踩 describeIfDatabase 静默 skip）。
- 权限断言用 **real-DB**（service mock 不算）；路由契约要 route-level 测试。
- UI 切片要**浏览器证据**（密集时间线截图）。
- session/非 token 路径无回归；每 PR 附「未覆盖」说明。
- 每个 🔒 项 = **单独 owner opt-in**；📄 项 = **design-lock 先行 + ratify**。

## 7. 常驻风险（每切片复审）
count/filter/分页 泄漏 denied 计数 · filter facet 泄漏 hidden 字段名 · 批次 affected 数泄漏 denied 记录 · preview 暴露超出可写范围 · restore 绕过当前字段权限 · 批次分组把一次操作误拆成多次 · 回填 revision 冒充 current-source（provenance 质量未标） · 时间点视图用「今天的 schema」静默重建。

## 8. 结论
能形成完整时光机能力面——但「完成」须指 **Track R（收尾 + undelete + 留存） + TM 的 T0–T8**；配置维度完整对齐再加 **T9**。
底座（不可变全量 snapshot 修订 + 已硬化恢复引擎）是对的，是 **build-out 不是重构**。建议先 ratify **T0**、按 read-only MVP
(`T1/T4/T2/T3/T5`) 落地，回滚面(T6/T7/T8)逐个门控开。**本文与两份草稿一并 PROPOSED；不改代码。**

> 2026-07-09 对账：上述「完成」定义已达成——Track R + T0–T9 全部落地（破坏性面 behind default-off flags），见 §9。

## 9. 对账（2026-07-09）— 恢复上 main 时的 plan→as-built 核对

> 恢复背景：本文 + 两份 20260619 草稿于 2026-06-29 经 PR #3381 提交、同日撤回，搁浅于分支提交 `a3286d405`，
> 两份草稿在工作树中残留 untracked 六周。2026-07-09 owner 指令接续本线，按 #4000（GW 锁 reconcile）同款纪律
> 恢复上 main 并逐行翻状态。本节记录「计划 → as-built」映射、偏差与剩余池；**全部 PR/SHA 引用均对 origin/main 核验**
> （`023385499`/`b6301f944`/`100b6dd59`/`f4f38bb90`/`5dcea0b6f`/`a1522034d`/`19e467e73`/`dc8c08e03`/`c4533ec9c`/`05a8593aa` 等）。

### 9.1 as-built 偏差（设计允许项内的选择，非缺陷）
- **T1 投影层**：未建 `history_batches`/`history_changes` 物化表（全仓无此物化表/DDL 定义；表名仅见于两份设计文档 prose）；读模型 = **读时投影**，
  锚 = `meta_record_revisions.batch_id`（迁移 `zzzz20260619120000`）+ `meta_config_revisions`。
  这是设计锁 §8 开放决策 1 明列的第三选项（"initially projected from revisions on read"），非偏离。
- **T5 预览**：按恢复族分端点（record / PIT revert / PIT reset / config / restore-batch），未做单一
  `/history/restore-preview` 通用端点；preview-identity 为 **actor-绑定签名身份**（`restore-preview-identity.ts`，
  scope/strategy-bound，execute 时重枚举 → 409/410），非持久行（开放决策 5 的取向）。
- **T7 时间点查看**：as-built 形态 = `reconstructRecordsAtT` 重建原语 + PIT 预览面（operator/API 入口），
  未做独立「浏览 T 时刻」页面；能力等价、入口形态不同。若要面向终端用户的浏览页 = 新产品决策（未立项）。
- **MVP 边界**：base 级历史中心 + all-tables 筛选（开放决策 2 取「base 内全 sheet」）。
- **API 形状**：`GET /bases/:baseId/history/events` + `GET /bases/:baseId/history/events/:batchId`
  与设计锁 §5 几乎逐字一致地落地（LOCK-2 批次为一等 UX 单元成立）。

### 9.2 超出本计划的落地（计划未预见，均 behind default-off flags 或纯正确性修复）
4c-2 forward tombstone-capture #3901（`023385499`）· 4c-1 lossy retype revert #3922（`b6301f944`，type-era guard）·
4c-3 record-undelete inbound-edge replay #3975（`100b6dd59`）+ R8 硬化 #3985（`f4f38bb90`）+ PIT-resurrect 修复 #3983 ·
D-1 侧门删除 revision 补齐 #3969（`a1522034d`）+ 事务化 #3992（`5dcea0b6f`）· D-6 config-restore 后 field-cache
失效修复 #3952 · O-1 三 tier staging 验收 **PASSED**（2026-07-08 正式跑；staging ops 证据，git 外）· i18n strict-zero 收官（R5b/R5c）。

### 9.3 剩余池（2026-07-09 起点；本轮 /goal 的目标池基线）
- 🧭 **O-2 operator flag 阶梯**：前置全清（#3983）；阶梯文档 = `multitable-global-history-o2-operator-flag-ladder-20260709.md`
  （L1–L5 + 验证步骤 + STOP-SHIP/footgun 注记）；现为**纯 owner 开关决策**，无 agent 开发项。
- 🔒📄 **D-2 侧门删除可恢复性**：plugin-SDK / automation 删除不写 `meta_records_trash` 行（D-1 只修 PIT 正确性，
  不改可恢复性）；需 design-lock 先行 + owner ratify。
- 🔒📄 **S1 MetaSnapshotService**：全计划唯一未开工整项；单独立项。
- ❌ **4d**：已删字段列数据的值级恢复 = 不可能（无 tombstone，字节不存在），如实记录，永不假装。
- 小残差（web-guard path-filter 覆盖缺口、tombstone 留存边界等）以当轮实况审计为准，见对应轮次 MD。
