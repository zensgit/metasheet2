# Global History — restore 批次回链（restored-from back-reference）— MINI DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — docs-only；owner ratify 前零实现授权。R10 gate-front 工件（R9 UX-parity 审计 gated 项 (e)）。
- **解锁词**：owner 对本文的明确点头（如「ratify 回链」）。
- **难度/分派建议**：中（一列迁移 + 两处写路径穿线 + 投影面 + FE 渲染）→ Sonnet 5 建 + 对抗审。

## §1 问题（R9 审计原始证据，已对 origin/main 核验）

`source='restore'` 的批次在 History Center 里无法回答「它恢复了什么」：
- `meta_record_revisions` 无承载列（创建迁移 + batch_id 迁移均无此概念）；
- record-restore-execute（univer-meta.ts ~:9596）与 restore-batch-execute（~:9736）调用 `patchRecords({ source: 'restore' })` 时从不把 `targetVersion`（被恢复的源版本）写入新 revision；
- 对照面：config 侧早有 `restoredFromId`（config-revision-recorder.ts ~:33）——记录数据侧缺同款。

## §2 设计（锁定项）

1. **新列** `meta_record_revisions.restored_from_version`（int，nullable，forward-only 迁移；legacy 行恒 NULL——不回填，不启发式）。
2. **写路径穿线**：仅上述两个 restore-execute 路径在生成新 revision 时携带 targetVersion；其它 revision 写入点不触碰（列缺省 NULL）。字段级子集恢复（fieldIds）同样携带——回链语义 = 「本次 restore 以版本 N 为源」。
3. **投影面**：`HistoryChange` / `HistoryBatchDetail` 增加可选 `restoredFromVersion`；LOCK-3 口径：版本号与 `changedFieldIds` 同级=元数据，不含字段值，无掩码增量，但仍走既有投影管道（不得旁路）。
4. **FE**：`HistoryBatchChangesList` 对 `source='restore'` 的变更行渲染「从版本 N 恢复」（typed label，i18n strict-zero 走 meta-record-labels 既有模式）；无版本可回链（NULL）时不渲染该徽标。
5. **不做**（明确出界）：跨批次深链跳转到源批次页（源版本≠源批次 id，本锁只回链版本号）；PIT 族回链（revert/reset 已有各自的 preview-identity 语义）。

## §3 Goldens（实现 PR 必带，mutation-verified）

- G1 execute 写入：record-restore-execute 后新 revision 行携带 `restored_from_version = targetVersion`（真库）；restore-batch 同。
- G2 非 restore 写路径恒 NULL（create/update/delete/automation/plugin 各一抽查）。
- G3 投影携带：批次详情 payload 含 `restoredFromVersion`，且掩码路径不变（LOCK-3 邻测不红）。
- G4 FE 渲染 + NULL 不渲染；两侧 shape-lock wire 测试同步（wire 形状变更=两侧全扫，家规）。
- G5 突变：去掉穿线 ⇒ G1 红；投影漏字段 ⇒ G3 红。

## §4 Owner 决策点

- OD-1：列名/语义确认（`restored_from_version` vs 记源 revision id——推荐版本号：与 restore 请求的 `targetVersion` 同物，无需反查 revision id）。
- OD-2：FE 徽标是否上线即显（推荐：是——只读元数据，无 flag 必要）。
