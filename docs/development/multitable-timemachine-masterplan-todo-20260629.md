# 多维表 历史 / 时光机能力 — 总体开发计划 + 门控 TODO (PROPOSED)

> Status: **PROPOSED 2026-06-29.** 把三条线（记录级收尾 / 全局时光机弧 / schema·快照纵深）合并成一张可跟踪的门控清单。
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
| R1 | **Slice 3 FE 收尾**：workbench `onRestoreRecordVersion` 接 API client + 抽屉刷新；**列级(单字段)恢复** UI | ⬜ | R0 | 记录历史抽屉闭环 |
| R2 | **Slice 2 undelete + link 恢复**：记录**软删**(`deleted_at`/trash) + 恢复被删记录并重建 `meta_links`+mirror 扇出；link 字段值恢复 | 🔒📄 | 软删设计锁 | 回收站 / 恢复被删记录 / link 还原 |
| R3 | **留存上线**：开启 `MULTITABLE_META_REVISION_RETENTION_ENABLED` + 选 keep-last-n/keep-days + 接线 `VERSION_EXPIRED` + revision 唯一性加固(partial unique index) | ⬜ | R0 | 可配留存窗口 |

## 2. Track TM — 全局时光机弧（整表时间点查看/恢复本体；逐切片细则见 `...-todo-20260619.md`）
| ID | 项 | 状态 | 依赖 | 解锁能力 |
|---|---|---|---|---|
| T0 | **Design-lock ratify**（提交两份草稿 + 决 open decisions + 数据模型/MVP 边界）；零 runtime diff | 🔒📄 | — | 解锁后续全部 |
| T1 | **历史批次投影** `history_batches`/`history_changes`（从 revisions 物化：增删改/restore/字段 set·unset/actor/source/batch 关联） | ⬜ | T0 | 统一历史**数据底座** |
| T4 | **权限安全查询加固**（denied 记录不进 list/total；hidden 字段不进 filter/detail/preview；missing≡denied 形状；admin 旁路显式；flag-off 惰性） | ⬜ | T0（与 T2/T3 同落或更早） | 历史不成 side-channel（硬底线） |
| T2 | **全局历史中心 UI**（入口 + 时间线 + 时间/人/动作/sheet/字段 筛选 + 标题搜索 + 游标分页 + 空/载/错态） | ⬜ | T1 + T4 | 统一操作历史时间线 |
| T3 | **批次详情 / diff 钻取**（改前/改后、受影响记录·字段数、按记录分组、回链记录抽屉、restore 批次回链） | ⬜ | T1 + T4 | 改前改后对比 / 单元格级变更(派生) |
| T5 | **恢复预览 dry-run**（批/记录/字段/变更级；报 denied/schema-drift/missing/版本冲突/link·formula 副作用；preview token） | ⬜ | T3 + T4 | 还原前预演 |
| T6 | **范围化恢复**（按预览身份：选中记录/字段/变更/权限过滤子集；写 forward revision + `source=restore` 批次 + 回链） | 🔒 | T5 | 选择性还原 |
| T7 | **时间点只读视图**（重建为 T 时刻、只读；字段掩码 + rule-deny + 删除策略 + 大表分页） | 🔒 | T1/T3/T4 成熟 | 看成 T 时刻 |
| T8 | **时间点恢复（核心）**：把 sheet/子集回滚到 T 时刻 | 🔒📄 | T7 + 回滚语义单独 ratify | **整表一键还原到历史版本** |
| T9 | **配置/Schema 历史**：加/删字段、改类型、视图/筛选/权限/自动化 变更 捕获+展示（恢复另设计） | 🔒📄 | 数据历史后单独立项 | 配置维度历史（完整对齐的最后一块） |

## 3. Track S — schema-inclusive 快照（Layer 2，可选纵深）
| ID | 项 | 状态 | 依赖 | 备注 |
|---|---|---|---|---|
| S1 | **MetaSnapshotService**：base/sheet 级、含 schema(字段/视图/link) 的检查点 + 治理面(锁/保护级/过期/标签/审计) | 🔒📄 | 单独立项 | 比点恢复更重；纵深，非对外能力必需 |
| S2 | **type-changed schema-drift 检测**：revision 时存 schema-at-capture，使 Layer 2 识别类型漂移（当前仅靠值校验兜底） | ⬜ | S1 或独立 | 关闭 Layer 1 已知残缺 |

## 4. 能力 → 关闭项 矩阵
| 目标能力 | 现状 | 关闭于 |
|---|---|---|
| 统一操作历史时间线（配置+数据，改前改后） | 仅单记录历史 | **T1+T2+T3**（数据）、**T9**（配置） |
| **整表一键还原到任意历史版本** | 仅单记录恢复 | **T7→T8** |
| 时间点查看 | 无 | **T7** |
| 单元格编辑历史 | 记录级(含字段 diff) | **T3** 派生呈现 |
| 回收站 / 恢复被删记录 | 记录硬删 | **R2** |
| 可配留存窗口 | 机制有、默认关 | **R3** |
| 还原不回滚权限 | 表级恢复尚无 | **T8 设计需显式采纳** |
| 配置/schema 历史 | 无 | **T9** |

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
