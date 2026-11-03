# 托管表野行读侧打标 — 设计（GOV-05，2026-09-18）

- 上游规格：PR #5647 `docs/development/managed-sheet-import-foreign-rows-design-20260912.md` §6「推荐 (c) 打标识别，第一刀只做读侧、行为零变化」。
- owner 裁决：按 #5647 方案 (c) 实施（裁决转达日期 2026-09-18，本刀撰写 `date` = 2026-09-18 10:46 CST）。
- 基线：`origin/main` @ `62fd24461`。分支 `feat/managed-import-foreign-rows-readside-marking`。
- values-free：全文只有 file:line、冻结 token、计数与合成占位符。

## 1. 做了什么（一句话）

让 conflict-planner 知道 `existing.missing`（既有行里**没有** `idempotencyKey` 的那些）中每一行是插件写的还是人手经通用记录写插进来的，并**分成两个 conflictType、两个计数**。挂起照挂、不写、不删、不停用、不阻断 apply，`buildRevision` 对既有批次逐字节不变。

## 2. 两类 conflictType

冻结在 `plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs:126-129` `EXISTING_MISSING_KEY_CONFLICT_TYPES`：

| key | token | 语义 |
| --- | --- | --- |
| `pluginOrLegacy` | `missing_existing_idempotency_key`（**原 token 原样保留**） | `created_by` 为 NULL：插件 apply 写手写的行，或键机制之前的历史行 |
| `foreign` | `foreign_existing_row_missing_idempotency_key`（新） | `created_by` 非空：经 `POST /api/multitable/records` 家族（批量导入 / 手工新增 / xlsx 导入 / 行复制 / 已登录表单）落进托管表的野行 |

两类都仍是 `manual_confirm`、`source: 'existing_row'`、同一套 `anonymousRowIdentity` 派生身份（`:1501-1507`）。

计数：`plan.summary.existingRowsMissingKey = { pluginOrLegacy, foreign }`（`:1685-1689`），**只在 `existing.missing` 非空时出现**（缺省 = 两个都为 0）；`summarizeConflictPlanForEvidence` 只在 planner 产出时透传（`:1711-1720`），进 dry-run `evidence.plan`。**不进 `plan.counts`**（那是 `buildRevision` 的哈希输入）。

## 3. 为什么是 `created_by`，为什么不是新列 / `property.readonly`

规格 §6.1(c) 已论证：落在 jsonb `data` 里的任何标记都能被同一次导入伪造（记录写守卫只认 hidden/readOnly/computed），而 `property.readonly` 会连插件写路径一起挡掉。`meta_records.created_by` 是**已经存在**、服务端铸造、客户端写不到的判别位：

- 插件 INSERT `packages/core-backend/src/multitable/records.ts:737-741`：`INSERT INTO meta_records (id, sheet_id, data, version)` 不含该列 → NULL。
- REST create `packages/core-backend/src/multitable/record-service.ts:740-743`：`created_by = actorId`。
- 读侧 `packages/core-backend/src/multitable/query-service.ts:276-286` `mapRecordRow` 已把它作为 `record.createdBy` 透出（NULL 时**键缺席**，不是 `null`）。

## 4. 透传路径（file:line）

```
recordsApi.queryRecords  →  { id, sheetId, version, data, createdBy? }        query-service.ts:276
  → readExistingStockPreparationRows                                            table-actions.cjs:978-997
    → unmapRecordFields(record, fieldIdMap)                                     table-actions.cjs:964-975
        out[EXISTING_ROW_CREATED_BY] = record.createdBy   (仅非空 string)      table-actions.cjs:972-973
  → planStockPreparationConflicts({ existingRows })                             table-actions.cjs:1846-1858
    → normalizeRows  `{ ...row }`（对象展开复制自有可枚举 Symbol）             conflict-planner.cjs:174
    → groupByKey → existing.missing                                             conflict-planner.cjs:485
    → isForeignExistingRow(row) → 两类 token + 两个计数                         conflict-planner.cjs:131-134, 1498-1508
```

保留键是 **Symbol**（`Symbol.for('metasheet.stock-preparation.existingRow.createdBy')`，`conflict-planner.cjs:125`），三个理由：

1. 不可能从 jsonb `data` 里伪造（`data` 里的 `createdBy` 单元格只是普通列，测试有正例）；
2. `Object.keys` / `JSON.stringify` / `stableStringify` 都跳过 Symbol，因此**结构性地**留在 `buildRevision` 的 `existingRows` 投影（`table-actions.cjs:1439`）、HTTP 响应、token store 之外——用字符串保留键则要在哈希前手工剥离，且一旦漏剥每个 revision 都漂；
3. 对象展开复制自有可枚举 Symbol，所以 `normalizeRows` 的 `{ ...row }` 不会丢它。

`unmapRecordFields` 只从**记录信封**读 `createdBy`（`data !== record` 守卫），空白字符串不算标记。

## 5. 行为零变化的边界（哪里变了、哪里没变）

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 野行的决策 | `manual_confirm` | `manual_confirm`（同） |
| 写 / 删 / 停用 | 无 | 无 |
| `canApply` | 不看 holds | 不看 holds（同） |
| `plan.counts` 键集 | add/update/skip/inactive/manual_confirm | 同 |
| 无键既有行为空的批次 | — | 整个 plan JSON 逐字节相同（carry 预接线 golden、pack-aware 控制 digest 都过） |
| 无键既有行全是 `created_by NULL` 的批次 | token `missing_existing_idempotency_key` | 同 token；summary 多一个 `existingRowsMissingKey` 段（不哈希）→ **revision 不变** |
| 含野行的批次 | token `missing_existing_idempotency_key` | 野行改为 `foreign_existing_row_missing_idempotency_key` → `summary.conflictTypes` 变 → **该批次 revision 变一次**；带血缘字段的野行在确认账本里会以新 conflictType 开一个新组 |

最后一行是规格 §6.3 明写的「给它一个名字」的直接后果，不是保留键泄进哈希。在飞 dry-run token 里，只有**当下已含野行**的批次会在上线后第一次 apply 时 409 一次，重跑 dry-run 即恢复；其余批次 token 不受影响。

## 6. 不做清单（规格「未穷尽 / 不能顺手做」）

- 不拦插行（方案 b）；不动任何能力位。
- 不改 `active` 缺省（`prep-line-export.cjs:374`、`pull-target-scan.cjs:508`）——规格 §8.6 说无真库实读证据不能顺手做。
- 不动导出 / 交付计数 / 看板 / 刷新四处的行为。
- 不做真库巡检（§8.3 的 `created_by IS NOT NULL` 统计）。
- 不碰 `http-routes.cjs`、`package.json`、`packages/core-backend/src/`。
- 未穷尽 `created_by IS NULL ⇔ 插件写` 的反方向（§8.4）：本刀只把它当「读侧分类名」用，不据此做任何写决策，所以误判的代价是计数错一格，不是数据错。
