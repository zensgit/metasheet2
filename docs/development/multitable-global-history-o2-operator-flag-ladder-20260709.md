# Multitable Global History — O-2 Operator Flag Ladder（决策就绪材料，2026-07-09）

> **性质：operator enablement 的决策就绪材料，不是决策。** 开启哪些 flag、何时开、开到哪个环境，
> 均为 owner/operator 决定（O-2）。本文把散落在各设计锁里的 flag、耦合与验证步骤收拢为一份
> 可执行的阶梯清单。代码侧前置已全部落地（见 §4 台账）。

## 1. Flag 清单（本线相关，全部默认 OFF）

| Flag | 激活值 | 作用 | 出处 |
|---|---|---|---|
| `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` | `'true'` | 捕获层：record/field 销毁时写 tombstone（4c-2 + 4c-3 D-3 的 PIT-reset 点） | 4c-2 锁 |
| `MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS` | 数字（默认 50000） | 单次销毁的捕获上限；超限 **fail-closed 拒绝该次销毁**（delete 422 / reset 422） | 4c-2 锁 |
| `MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND` | `'true'` | 4c-3 重放层：restore / PIT-resurrect 重建 inbound 边（Option A 邻居同意） | 4c-3 锁 |
| `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT` | `'true'` | 4c-1 lossy retype revert | 4c-1 锁 |
| `MULTITABLE_ENABLE_PIT_UNDELETE` | `'true'` | T8-1 PIT undelete-execute（resurrect 面；4c-3 的第二重放面挂在它之下） | T8-1 锁 |
| `MULTITABLE_META_REVISION_RETENTION_ENABLED` | **`'1'`**（⚠ 非 `'true'`） | retention janitor：revisions/config-revisions/tombstones 老化 | T9/4c-2 |
| `MULTITABLE_META_REVISION_RETENTION_POLICY / _KEEP_N / _DAYS / _BATCH / _INTERVAL_MS` | 见代码默认 | retention 细节旋钮 | 同上 |

**⚠ 激活值不一致（operator footgun）**：capture/replay 系 flag 用 `'true'`，retention 开关用 `'1'`。
照抄错值 = 静默不生效。核对点：`tombstone-capture.ts:39` vs `meta-revision-retention.ts:60`。

## 2. 耦合与顺序约束（这是本文存在的原因）

1. **capture 先于 replay**：`RECORD_UNDELETE_INBOUND` 只能重放 **capture 开启期间** 删除的记录
   （forward-only 红线，C1）。先开 capture、让 tombstone 积累，replay 才有东西可放。
   **建议间隔**：capture 稳定运行 ≥1 个业务周期后再开 replay。
2. **retention 单旋钮耦合（gap-audit 残差#2）**：`RETENTION_ENABLED` 同时老化
   record-revisions、config-revisions **与 tombstones**。开 retention = 给 4c-1/4c-3 的恢复力
   加了时间上限（keep-days 之外的删除不可再重放）。**地板已内建**：仍被存活 trash 行引用的
   link-tombstone 组永不被清（4c-3 c5），但 field-value tombstones（4c-1 依赖）无此地板。
3. **retention batch 语义已变（review P3-3）**：tombstone 清理的 `_BATCH` 现在按
   **anchor 组/趟** 计，不是行/趟——单趟 DELETE 行数上限 = batch × capture-cap。
   给 `_BATCH` 设值时按组理解；默认值在组语义下依然安全，但监控 janitor 时长时要知道这一点。
4. **cap 是销毁的 fail-closed 闸**：capture 开启后，inbound 边数超过 `_MAX_ROWS` 的记录删除 /
   PIT-reset 会**被拒绝**（422）。大扇入记录（被数万行引用）删除失败属预期行为，不是 bug；
   处置：临时调大 cap 或先摘引用。

## 3. 建议阶梯（staging → prod，每级有验证步骤）

| 级 | 动作 | 验证 |
|---|---|---|
| L1 | staging 开 `TOMBSTONE_CAPTURE_ENABLED='true'` | 删一条被引用记录 → `meta_link_tombstones` 出现 `reason='record_delete'` 组；trash 行带 `delete_revision_id` |
| L2 | staging 开 `RECORD_UNDELETE_INBOUND='true'` | 回收站恢复该记录 → 响应带 `inbound.replayed≥1`；邻居单元格重新显示该记录；trash 列表出现 `inboundEdgesRecoverable:true` |
| L3 | staging 开 `ENABLE_PIT_UNDELETE='true'`（若走 PIT 面） | revert-execute confirm:'undelete' → 响应带 `undeleteInbound`；真库金测同形状（P3-2a/b/c） |
| L4 | （可选）staging 开 retention（值=**'1'**）并设 `_DAYS` | 观察 janitor 日志；确认地板：有存活 trash 引用的组不被清（RB10 同形状） |
| L5 | prod 逐级重复 L1→L3（retention 是否上 prod 独立决定） | 同上 + 观察 cap 拒绝率（若出现 422 频发→调 cap 或审视扇入） |

**回滚**：任意级出问题，关掉对应 flag 即回到关闭前行为（全部 flag-off 路径有金测钉死逐字节不变：RB1、P3-2a）。
tombstone 数据是惰性的——关 flag 不删数据，重开后继续可用（受 retention 影响除外）。

## 4. 代码侧前置台账（O-2 开启前已全部落地）

| 前置 | 状态 |
|---|---|
| 4c-3 实现 + 对抗审 APPROVE（0 P1/P2） | ✅ #3975 merged |
| review P3-1：reset 路径 cap 超限 422（非 500） | ✅ #3975 内修复 |
| review P3-2：resurrect 锚选择 golden（此前可 neuter 而全绿） | ✅ 本 PR：P3-2a/b/c 三金测 + 锚突变精确命中 b/c |
| review P3-3：batch=组/趟语义 operator 文档 | ✅ 本文 §2.3 |
| gap-audit 残差#2：retention 单旋钮耦合入 checklist | ✅ 本文 §2.2 |
| D-1（PIT 谎报存活修复，独立于 flag，已生效） | ✅ #3969 merged |

## 5. 未做/边界（如实）

- field-value tombstones（4c-1 恢复力）**无 retention 地板**（link 侧才有）——若 retention 上线且
  4c-1 恢复窗口重要，需单独补地板（新 rung，不在本文）。
- automation / plugin-SDK 删除仍**无捕获**（不可恢复=D-2，owner-gated）；4c-3 可达边界不含它们。
- 4d 红线不变：已删字段列值的值级恢复永不承诺。
