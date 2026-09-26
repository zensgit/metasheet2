# ADR：字段类型转换首批设计锁（文本→单选 / 文本→多选）— 2026-09-26

**状态**：DESIGN-LOCK（首批窄范围），已过两轮评审（处置见 §8）。owner 已于 2026-09-25 在 #5864 拍板五项（权限门 / 前镜像保留 / 往返保真 A / 首批配对 / 选项上限），裁定记录见 PR #6074（`docs/development/takeover-beiliao-20260821/customer-anomaly-triage-20260924.md` §7b 与 §3「owner 拍板」，该文件尚未进 main）。本 ADR 把 #5864 v2 + v2.1 收成一份可开工的锁；**不是上线授权**，不开开关、不碰真实客户数据。
**基线**：`origin/main @ 51acbb18f`（2026-09-26）。复审期间 main 前进到 `3fd352457`，两 sha 间 `git diff --stat` 触及的 20 个文件（待办中心 / 审批徽标）无一在本 ADR 引用集内，行号仍有效；实施前按符号名重定位。TS 迁移在 `packages/core-backend/src/db/migrations/`，SQL 迁移在 `packages/core-backend/migrations/`。
**Refs**：#5864（保持开启）、PR #6074、#3812（4c-1 回滚侧锁，其 §7 把「前向 PATCH 迁值」明列出界——本 ADR 就是那条独立产品决定）。

## 0. 一句话

在**不动** `PATCH /fields/:fieldId` 与 `LOSSLESS_FIELD_RETYPE` 的前提下，新开一条受控路径：只读预览 → 带完整前镜像的执行 → 整列撤销；首批只做 `string → select` 与 `string → multiSelect`，整段文字为一个选项；全部默认 OFF。

## 1. 范围（锁定）

| 项 | 锁定值 | 依据 |
|---|---|---|
| 首批配对 | **仅** `string → select`、`string → multiSelect`。源限 `string`（非 `longText`，无论 rich 与否） | owner 2026-09-25；今日两对都被 `assertLosslessFieldRetype` 拒 400（`field-retype-whitelist.ts:206-221`，路由映射 `univer-meta.ts:14200-14201`），注释里写明「string → select 故意不收」（`:117`） |
| 现有白名单 | `LOSSLESS_FIELD_RETYPE`（`field-retype-whitelist.ts:120-132`）、前端镜像（`apps/web/src/multitable/utils/field-retype.ts:51-65`）、真值表（`tests/fixtures/field-retype-truth-table.json:53-65`）**逐行不变**；PATCH 对新配对仍 400 | L6：narrowing test `:173-175`（表即夹具）与 `:329-443`（PATCH 强制 describe）、integration `multitable-context.api.test.ts:1905` 起的整个 F8A describe 逐用例保持通过，两条路径 `git diff` 为空。**既有用例只钉了 `string→number/person`**（narrowing `:344-354`；integration `:1960-1972`、`:1974`），新配对的 PATCH 400 回归在第 2 刀新文件里补（§6） |
| 新旧分离 | 转换矩阵放**独立新模块**（建议 `multitable/field-retype-convert.ts`），与白名单零 import；加一条断言「首批配对 ∩ LOSSLESS_FIELD_RETYPE = ∅」 | v2 前提 1.3 |
| 排除集 | 任一端 ∈ `FIELD_RETYPE_EXCLUDED_TYPES`（`field-retype-whitelist.ts:102-105`）⇒ 422 | 与 4c-1 §2.1 同口径 |
| **插件写入列 → 托管表整表排除** | 判定是**并集、fail-closed**，任一命中 ⇒ 预览 / 执行 / 撤销 422 `FIELD_RETYPE_CONVERT_NOT_SUPPORTED`，`details.reason` 取首个命中：(a) `plugin_managed_sheet`：`plugin_multitable_object_registry` 有行（`sheet-delete-guard.ts:65-77`，只答是/否、不回插件名）；(b) `system_managed_sheet`（`:83-94`；其注释「never as a trust/exclusion signal」`:80-81` 第 2 刀改成「refuse-only，含 retype」）；(c) `plugin_tagged_fields`：本表任一 `meta_fields.property` 带 `stockPreparation` 或 `stockPreparationMvp` 命名空间；(d) `pipeline_staging_sheet`：`integration_pipelines.staging_sheet_id = sheetId`（`migrations/057_create_integration_core_tables.sql:62`） | owner 补充：托管备料表的插件写入列（确认账本 Status / Conflict Type / 处理动作 / 备注）不在范围。(c) 的写者：目标表 `plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs:193-200`、客户包 `ext_` 列 `stock-preparation-customer-pack-installer.cjs:141-152`/`:175-184`、MVP `stock-preparation-mvp-provisioning.cjs:135-141`；读者 `adapters/multitable-ownership-guard.cjs:18-25, :81-89`。只靠 (a) 不够：插件作用域默认 `observe`，未登记表照常可写（`pluginSheetScopeMode.ts:14-18, :31-32`；`index.ts:2302-2309` 只 warn 不拒），DERIVED 目标无登记行也放行（`stock-preparation-target-provisioning.cjs:1184, :1191`） |

**整表而非逐列，是 T 层保守默认值（§7 可否决），不是被迫**：逐列来源标记**已存在**（上表 (c) 的两个命名空间，`ownership ∈ {plm_system, human_preserved}`；`ext_` 列另带 `extension: true` + `packId`），所以日后按列开放 `ext_` / `human_preserved` 列**不需要新做标记**，只需把 (c) 从「表上有标记即拒」收窄成「仅拒 `ownership='plm_system'` 的列」；首批不做（§7）。`plugin_field_policy_registry` 不是候选——网格从不读它（`services/stock-preparation-field-permissions.ts:16-19`）。转成选项型后插件按选项表硬校验：单选 `records.ts:143-151`（`''` 放行、其余须在 options 内）、多选 `:159-175`（trim + 校验），**写入值不在选项集时失败**（在集内则成功）。**已知缺口**：Data Factory 目标适配器按配置 `objects[*].sheetId` 写任意表（`adapters/metasheet-multitable-target-adapter.cjs:116, :309-313, :325-327`），该配置的持久化位置本轮未读，(d) 只覆盖 staging 表——列入 §7 待问；根治在插件侧 = 登记回填 + `MULTITABLE_PLUGIN_SHEET_SCOPE_MODE=enforce`（owner 侧动作）。**UI 表现**（第 4 刀）：托管表上类型下拉只保留今日无损目标，并显示静态提示「此表由插件托管，字段类型不能转换」，不含插件名。

## 2. 只读预览 `POST /api/multitable/fields/:fieldId/retype-preview`（第 2 刀）

- **请求**：`{ targetType: 'select' | 'multiSelect' }`。不接受 `property`——选项由服务端从单元格推导。
- **门（五段，顺序固定，任一不过即停、不扫描）**：① flag `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT !== 'true'` ⇒ 403 `FIELD_RETYPE_CONVERT_DISABLED`；② `MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA === 'true'` ⇒ 409 `FIELD_RETYPE_TRUST_REQUIRED`，`details.reason='legacy_manage_schema_flag'`（该 flag 让 `multitable:write` 也拿到 `canManageFields`，`manage-schema-permission.ts:33-40`、manifest `:50-59`，低于 owner 批的门；env-only、values-free）；③ `capabilities.canManageFields`（照抄 PATCH `univer-meta.ts:13868`；表级已含 `&& scope.canWrite`，`permission-service.ts:1493`）⇒ 否则 403；④ `sheetLiveness !== 'live'` ⇒ 404 `sendSheetNotLive`（PATCH 下一行 `:13869`；`sheet-refusals.ts:47-51` 给 `SHEET_DELETED` / `NOT_FOUND`；死表不清零能力、调用方必须答 404，`permission-service.ts:1755-1762`；新表级路径须断言存活，`sheet-liveness.ts:20-29`）；⑤ `hasFullTableReadAccess`（`:7244-7262`，既有用法 `:10837`）⇒ 否则整面 403，**无 scoped 模式、无 undisclosed 标记**（R6 裁决，`docs/development/multitable-global-history-r6-ratification-decision-record-20260708.md` §2；`lossy-retype-oracle.ts:44-48`）。**三个端点同五门**。
- **范围校验**：源 `type !== 'string'`、目标不在首批、排除集、§1 并集 ⇒ 422 `FIELD_RETYPE_CONVERT_NOT_SUPPORTED` + `details.reason ∈ {pair_not_in_first_batch, excluded_type, plugin_managed_sheet, system_managed_sheet, plugin_tagged_fields, pipeline_staging_sheet}`。
- **扫描范围与上限**：live `meta_records`（`sheet_id`）+ **本表回收站** `meta_records_trash`（同 `sheet_id`）。`live + trash > resolveSheetRevertMaxRecords()`（默认 5000，`restore-caps.ts:15, :17-20`）⇒ 413 `SHEET_TOO_LARGE`，不截断（照抄 `:10847-10849`）。回收站行恢复时原样 INSERT、`version` 重置 1、无任何类型校验、无 flag 门（`record-service.ts:1140`, `:1233-1238`），不扫就会把未转换的原值带回选项列、绕过 A。规则：回收站行 `data ? F` 且 `data->F` 非 JSON null、非 `''` ⇒ 整次 `rejected`，reason `trashed_rows_with_value`（recordIds = 其 `record_id`）；空形（缺键 / null / `''`）放行——恢复后是读侧容忍的旧空形（`config-restore.ts:63-65`），下一次写入折成规范空值（`field-codecs.ts:1016`；`record-write-service.ts:582`），且恢复本身让撤销 ② 失败（集合多一个），不撕裂前镜像。
- **零写入**：走 `pool.query`（同 `:10837` 的预览），不开事务、不取栅栏、不写任何表。
- **响应**（values-free：**只有计数与 recordId，永不含单元格值或选项文本**）：

```jsonc
{ "ok": true, "data": {
  "verdict": "ok" | "rejected",
  "sourceType": "string", "targetType": "select",
  "scannedRecordCount": 1234, "trash": { "scanned": 12, "blocking": 0 }, "recordCap": 5000,
  "cells": { "empty": 100, "converted": 1130, "rejected": 4 },
  "options": { "new": 57, "final": 57, "limit": 5000, "droppedValidationRuleCount": 1 },
  "rejections": [ { "reason": "leading_trailing_whitespace", "recordCount": 3, "recordIds": ["…"] },
                  { "reason": "whitespace_only",             "recordCount": 1, "recordIds": ["…"] } ],
  "previewToken": "<仅 verdict=ok 时签发>", "confirm": "convert-field-type"
} }
```

  **回 recordId、不回值，且 id 列全**：owner 要求「预览里列出这些行」，每个 reason 的 `recordIds` **完整**（总量 ≤ recordCap，5000 个 id 约 180 KB；不抽样、不分页）。调用方已过全表读门，值对他不是新信息；不回值是日志 / 证据面卫生（values-free），**不是**遮罩口径——门 ⑤ 已证明无遮罩（`:7260-7261`）。选项文本 = 单元格值同样不回，由 `planHash` 在服务端绑定。`verdict:'rejected'` 是报告不是错误，仍 200。
- **凭证**：`previewToken` 沿用 `restore-preview-identity.ts` 的 HS256 + 10 分钟（`:42`, `:274-275`）；claims = `{ type:'field-retype-convert-preview', sheetId, fieldId, actorId, sourceType, targetType, planHash }`。`planHash` 是**服务端密钥 HMAC**（理由同 `hashLossSummary`，`:256-262`：JWT 客户端可解码，明文哈希会变成暴力探针），折入：源 `type` + 规范化 `property`；目标 `type` + **完整新选项序列** + 目标 property 键集（§4）；live 行 `[recordId, cellHash, version]` 与回收站行 `[record_id, cellHash]` 两组序列，均按 `hashScope`（`:129-134`）的 JS 码元比较器排序、与 DB 排序规则无关。缺任一轴即 v2 前提 2 的「计数相同、集合互换」反例成立。

## 3. 执行 + 整列撤销（第 3 刀，后做）

**执行** `POST /api/multitable/fields/:fieldId/retype-execute { previewToken, confirm: 'convert-field-type' }`，同五门 + 以下硬门，一个事务：

1. `confirm` 不符 ⇒ 400 `CONFIRM_REQUIRED`（镜像 `:11173-11174`）。
2. **信任门（fail-closed）**：`!isWriterFenceEnabled()`（`canonical-sheet-fence.ts:160-162`，直接调它、不自写比较；关时 `fenceWriterEntry` 首行 return `:209`，账本惰性 `operation-ledger.ts:142-143`）⇒ 409 `FIELD_RETYPE_TRUST_REQUIRED`（形状照 `exact-anchor-recovery-route.ts:637-644`）。**前镜像捕获在本路径内无条件执行**（自有函数，不受 `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` 门控，也不改变删字段 / 删记录路径的行为）；仍 fail-closed：行数 > `resolveTombstoneCaptureMaxRows()`（`tombstone-capture.ts:48-51`）⇒ 422，捕获失败 ⇒ 整体回滚。**不得**进入「跳过捕获、照常改写」分支。`MULTITABLE_HISTORY_CONTIGUITY_STRICT` 首批**不**要求。
3. **凭证逐 claim 校验**（镜像 `:11267-11275`、`restore-preview-identity.ts:293-303`）：`type`、`fieldId === :fieldId`、`sheetId ===` 字段当前 `sheet_id`（`:13866` 口径）、`actorId ===` 请求者、`sourceType` / `targetType` 任一不符 ⇒ 401 `PREVIEW_IDENTITY_INVALID`；`planHash` 不符 ⇒ 409 `PLAN_DRIFT`。
4. `fenceWriterEntry` → `SheetWriterBlockedError` ⇒ 409 `RECOVERY_IN_PROGRESS`（`:14178-14179`；阻塞态含 `archiving`，`WRITER_BLOCK_STATES` `canonical-sheet-fence.ts:137`）→ 字段行、范围内 live 行、本表回收站行 **`FOR UPDATE`** → **重算 `planHash`** ⇒ 不符 409 `PLAN_DRIFT`。
5. 预铸 `convertRevisionId = randomUUID()`（照 `:11176` / `:11238`）；`mintOperation`。
6. **写前镜像（live 每行一条，含空格、含未变格）**：新函数 `captureRetypeConvertPreImageRows`（`captureLossyRetypePreImageRows` 的兄弟，`tombstone-capture.ts:225-238` 一字不动），`reason = 'retype_convert'`（一次迁移放宽 CHECK，`zzzz20260708090000_create_meta_tombstone_tables.ts:34`），`config_revision_id = convertRevisionId`（索引 `(config_revision_id, field_id)`，`:44-47`），**`operation_id` 恒 NULL**。`value jsonb NOT NULL`（`:33`）装不下缺键 / JSON null，故 value 存信封 **`{"k":<hasKey>,"v":<原始 JSON>,"post":<写入值>}`**（v2.1 §1 候选 (c)；无 version 轴，见撤销 ③；不混入 R1 的 `reason='field_delete'` 过滤 `:7726`）。
7. `UPDATE meta_fields SET type, property`（§4）→ **一条**原生 jsonb 批量 `UPDATE meta_records`，**只碰 `data->F IS DISTINCT FROM post` 的行**（`string→select` 下 `'A'→'A'` 不碰、不 bump、不写 revision——同 4c-1 排除 `unchanged`，`:11230`），形状照 `:7604-7613`，`RETURNING` 计数 == 预期变更行数否则抛（`:7614-7618`），声明 lock-exempt 并写理由（`:7602`）→ 每个被碰行**恰一条** record revision 在新 version 上（连续性要求 `:7703-7707`）：`patch={F:post}`、`snapshot=` 写后整行、`changedFieldIds=[F]`，走 `recordRecordRevisionsBatch`（`:7758`）传 `ledger`（`record-history-service.ts:55-64`），**`batchId = convertRevisionId`**；转换从不删键，故 revision `patch` 的 `null` 删键哨兵（`record-write-service.ts:1067-1075`）在此不出现 → `recordConfigRevision({ id: convertRevisionId, batchId: convertRevisionId, changedKeys:['type','property'], source:'mutation' })`（`config-revision-recorder.ts:40, :44`；`operation_id` NULL）→ 写作业行 → `sealOperation` → COMMIT。
8. **提交后**：`invalidateFieldCache(sheetId)`（先例 `:11244`、`:14120`；`metaFieldCache` 无 TTL，`:656`、`:4538-4552`，漏失效后果见 D-6 注 `:11286-11295`）+ Yjs 失效（同 record restore 装的 post-commit hook，`:11801-11803`）。**不做**（与 PATCH 改类型同口径，§7 告知）：公式物化值重算（PATCH 只在公式表达式变更时重算，`:14132-14135`）、视图 filter / sort / group 迁移、自动化 `record.updated`（原生 UPDATE 绕过 `:1090-1096` 的订阅通知，同 4c-1）、实时推送（PATCH `/fields` 在 `:13870-14175` 内无 publish 调用）。
9. **局部关联（v2.1 §3 候选 (b)+(c)）**：新表 `meta_field_retype_conversions (convert_revision_id uuid PK, sheet_id, field_id, source_type, source_property jsonb, target_type, target_property jsonb, record_count int, actor_id, created_at, undone_at NULL, undo_revision_id uuid NULL)`，**不带 `operation_id`、不建任何 FK**。一个 id 取回三半：配置半（`meta_config_revisions.id`）、前镜像（`config_revision_id`）、记录半（`batch_id`）。record revision 带账本 `operation_id`（它们是记录事件）；前镜像与配置修订**不带**：D2d1 的 `fk_mfvt_operation` / `fk_mcr_operation` 指向 endpoint（`zzzz20260826122500_add_operation_binding_to_nonrecord_history.ts:263-276`），零记录事件时 `sealOperation` 不写 endpoint（`operation-ledger.ts:158-160`），空表转换打了标签会在 COMMIT 违反 FK；且保留期清理只删 `operation_id IS NULL` 组（`meta-revision-retention.ts:254-259`），打标签 = 永不过期，「开启时 365 天」不成立。**不**给 `ConfigRevisionInput` 加 `ledger`、不改 endpoint 校验（`zzzz20260715210000_create_meta_record_history_operations.ts:167-174`）；空表转换作业行仍存在、撤销仍可达、不制造不存在的记录锚点。
10. **封住 Time Machine Tier-2 的「撤销的撤销」**：`source` 只能是 `mutation | restore`（`config-revision-recorder.ts:31`；CHECK `zzzz20260624200000_add_config_revision_source.ts:10-11`），转换修订在历史里与普通 PATCH 改类型分不出来；Tier-2 判定 `isSupportedFieldRetypeRevert`（`config-restore.ts:94-101`）只排 11 个排除类型、不查白名单，`string ↔ select/multiSelect` 都能过，而其前提「forward PATCH 不迁值、schema-only 回滚无损」（`:63-66`）对本路径**不成立**——回滚转换修订会把字段翻回 `string` 而每格仍是 `["A"]`，之后撤销 ① 永远 409、前镜像取不回。锁：config-restore **预览与执行**对 `entity_type='field'` 的修订先查 `meta_field_retype_conversions WHERE convert_revision_id=$1 OR undo_revision_id=$1`，命中 ⇒ 422 `RESTORE_NOT_SUPPORTED`，`details.reason='field_retype_conversion'`，values-free；位置：预览在签发凭证前，执行在事务内 `applyConfigRevert` 之前（`:11277`）与 4c-1 分支之前（`:11225`）。单记录版本恢复走 `RecordWriteService.patchRecords`（`:11806`）自带选项校验，不另加门。
11. **封住真并发写入（不是预览→执行的顺序漂移）**：`RecordWriteService` 在事务外用调用方加载的 `fieldById` 校验（`record-write-service.ts:711`），事务内才取栅栏（`:839`），之后仍用旧 `fieldById` 写（旧类型 `string` 走 `patch[F]=change.value`，`:1000`；`expectedVersion` 可选，`:875-877`、`:918`）；栅栏是独占 `pg_advisory_xact_lock`（`canonical-sheet-fence.ts:81-83`），按 `string` 校验过的写入只是排队等我们提交，然后照写。今日只有 link 写入者复核字段（`link-writer-fence.ts:146-153`、`:190`）。锁：新共享助手 `assertFieldSchemaUnchangedAfterFence(query, sheetId, fieldById, touchedFieldIds)` = `SELECT id, type, property FROM meta_fields WHERE sheet_id=$1 AND id=ANY($2) FOR SHARE`，与调用方守卫比 `type` + 选项集，不符抛 ⇒ 409 `FIELD_SCHEMA_CHANGED`（values-free；客户端重载再试）。接线点 = 每个取栅栏的写入者在 `fenceWriterEntry` 之后：`record-write-service.ts:839`；插件 SDK `records.ts:566`（字段虽在栅栏后 `:570` 加载，但经请求级缓存 `:453, :458`，可能是栅栏前的旧值）；`automation-executor.ts:3217` 的 UPDATE 路径（栅栏缝 `:3574-3580`）。**仅在本 flag `=== 'true'` 时执行**，flag OFF 对既有写入者字节不变。转换 / 撤销持字段行 `FOR UPDATE` + 栅栏，排队写入者在栅栏后必看到已提交的新类型 ⇒ 409；撤销对称。

**撤销** `POST /api/multitable/fields/:fieldId/retype-undo { convertRevisionId, confirm: 'undo-field-type-convert' }`，同五门、同信任门、同事务。**判定顺序锁定，任一不过 ⇒ 零写入**：

| 序 | 判据 | 码 / 说明 |
|---|---|---|
| 0 | `fenceWriterEntry` → 作业行 `WHERE convert_revision_id=$1 AND field_id=:fieldId AND sheet_id=<门 ③④ 判定的表> FOR UPDATE`，无行 | **404 `NOT_FOUND`**（与不存在同码、无存在性探针；先例 `:10832`）。绑定 `:fieldId` 与已过门的表，杜绝拿 B 表的 id 改写 B 列 |
| 1 | `undone_at` 非空 | 409 `ALREADY_UNDONE` |
| 2 | 前镜像 `SELECT … WHERE config_revision_id=$1 AND reason='retype_convert' FOR UPDATE`（挡住保留期清理的整组 DELETE，`meta-revision-retention.ts:257-267`），行数 < `record_count` | 409 **`PRE_IMAGE_EXPIRED`**，明确报错、不部分恢复。必须先于 ①②③，否则整组被清后会得到一串「新增」recordId 的 ③ |
| ① | 字段行 `FOR UPDATE`；当前 `{type, property}` 与作业行 `target_*` **jsonb `=`**（键序无关），含选项集与颜色 | 409 `UNDO_PRECONDITION_FAILED` |
| ② | 范围内 live 行 `FOR UPDATE`；`meta_records.id`（`sheet_id` 内）集合 == 前镜像 `record_id` 集合 | 同上。删除 = 硬删 + 回收站行（`record-service.ts:965-968`），恢复 = 重新 INSERT（`:1233-1238`）；`meta_records` 无 `deleted_at`（迁移全搜无）；插件 SDK 删除 `records.ts:1017-1021` 按设计不写回收站（`:1007-1012`）——三者都改变集合 |
| ③ | 每行 `data->F` jsonb `=` 信封 `post`；**不比 `version`** | 同上。撤销只写这一个键，比值即够；后果：转换后改本列任一格 ⇒ 整列撤销不可用（整次拒绝），改其它列不影响——写给 owner / 客户 |

`details` 只含三类计数 + 受影响 recordId（**完整**、≤ recordCap），不回显值，`message` 不含 id（口径同 narrowing test `:350-352`）。通过后：恢复 `type/property` → 按信封 `k/v` **四态精确回写**（缺键 ⇒ 删键；JSON null；`[]`；`''`），只碰与当前不同的行，原生 jsonb 批量 UPDATE + `RETURNING` 计数断言，不得经 `RecordWriteService`（其多选路径 `normalizeMultiSelectValue`：`field-codecs.ts:1016` 折空、`:1028` trim、`:1033-1036` 去重，四态不可达；单选路径 `record-write-service.ts:577-580` 对非字符串直接抛）→ 每个被碰行一条 record revision（删键 ⇒ `patch={F:null}` 哨兵 + `snapshot` 无该键，镜像 `:1070-1075`；`batchId = undoRevisionId`、`ledger`）→ config revision（`id = undoRevisionId`, `source:'restore'`, `restoredFromId: convertRevisionId`）→ 作业行 `undone_at`、`undo_revision_id`。**首版无强制覆盖、无部分撤销、无撤销的撤销。**

**前镜像保留**：沿用现有 retention，一套旋钮（`MULTITABLE_META_REVISION_RETENTION_ENABLED === '1'`，`meta-revision-retention.ts:65`）；tombstone 表恒按天龄**整组**清理、无「保留最新一条」下限（`:219-227`，说明 `:207-217`）；窗口 = `retentionDays`（`MULTITABLE_META_REVISION_RETENTION_DAYS`，默认 365、下限 30，`:41-42`、`:75-79`、`:226`）。**开启 = retentionDays 天可撤销窗口；未开启 = 不清理。** 作业行不参与清理，过期后给 `PRE_IMAGE_EXPIRED` 而非 404。Time Machine 归档把每条 tombstone 的 `value` + `reason` 原样导出（`recovery-archive-relational-source.ts:73-78`）：任何归档 / 恢复消费者遇 `reason='retype_convert'` 必须按信封解读 `value`，不得当单元格值。

## 4. 往返保真 A 与选项生成（锁定）

| 规则 | 值 | 依据 |
|---|---|---|
| 一格一项 | 单元格**完整文本**为一个选项；逗号 / 顿号 / 分号 / 换行一律当普通字符，不切分、不 AI 推断 | owner；v2 §1.2 |
| 多选形状 | `"A,B"` → `["A,B"]`（长度 1） | 同上 |
| **A：首尾空白 / 纯空白 ⇒ 整次拒绝** | `text !== text.trim()` 或 `text.trim()===''`（非空串）⇒ `rejected`，reason `leading_trailing_whitespace` / `whitespace_only`，预览列出全部 recordId；**两个方向同一口径** | owner 走 A。多选写路径 trim 后校验（`records.ts:171-175`；`field-codecs.ts:1028-1032`），带尾空格的选项写进去后用户再提交即被拒——比静默归一更糟；单选路径不 trim（`record-write-service.ts:577-584`），两条路径天然不对称，A 抹平它 |
| 非字符串非空值 | 非缺键、非 null 且 `typeof v !== 'string'`（数字 / 布尔 / 对象 / 数组，含 `[]`、`{}`）⇒ `rejected`，reason `non_string_value` | 转换语义未定，不可证明往返；`[]` / `{}` 不算空 |
| 空值 | 缺键 / `null` / `''` ⇒ 目标写规范空值：单选 `''`（`record-write-service.ts:582` 唯一放行的空形），多选 `[]`；**前镜像按信封保留原始四态**，撤销不归一 | owner P1 #1 |
| 去重 | 精确码点相等（大小写敏感、不做 Unicode 归一） | 写路径用 `Set` 精确比对（`record-write-service.ts:581-582`；`records.ts:147-149`） |
| 顺序 | recordId 按 JS 码元比较器（同 `hashScope`，`restore-preview-identity.ts:131`）排序后扫描的首次出现序；预览、执行、测试三处共用该比较器，不依赖 `ORDER BY`（222 PG 中文 locale） | 确定性；`planHash` 稳定 |
| 选项形状 | `{ value }`，不赋 `color`（`extractSelectOptions` 接受缺省，`field-codecs.ts:169-186`） | UI 用默认色 |
| 目标 property | **显式规则**：`{ ...source, options: <新序列> }`，再把 `validation` 过滤为 `type ∈ {required, enum}` 的规则（镜像前端 `VALIDATION_RULES_BY_PANEL_TYPE.select`，`field-retype.ts:115-119`、`:135-144`），滤掉的计入 `droppedValidationRuleCount`；**其余键原样保留**（含 `stockPreparation` 等命名空间——托管表今日整表排除，规则仍须正确）。第 2 刀单测断言目标 property 的精确键集 | `sanitizeFieldPropertyByType` 对 select 返回 `{ ...obj, options }`、保留全部其它键（`field-codecs.ts:288-291`），本规则与之一致 |
| **选项上限 5000** | `final > 5000` ⇒ `rejected`，reason `option_limit_exceeded`，不取前 N、不截断；新常量 `FIELD_RETYPE_MAX_OPTIONS = 5000`（与记录上限同值但**分立**） | owner；写路径今日对选项数无上限（`:288-291` 原样透传）。默认记录上限也是 5000（不同值数 ≤ 行数），默认配置下触发不到——第 2 刀单测对纯函数喂 5001 个不同值，或先调高 `MULTITABLE_SHEET_REVERT_MAX_RECORDS` |
| 单项长度 | 首版**不设** | owner |

## 5. 开关（锁定）

新 flag **`MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT`**：默认 OFF；比较 **`=== 'true'` 字节精确**（不 trim、不转小写，与 capture / revert 族一致）；门控预览 / 执行 / 撤销三个端点（预览也门控——一次全表扫描并回 recordId 不该在客户环境无授权可达）。名字在 `packages` / `scripts` 全搜 `FIELD_RETYPE_(FORWARD|CONVERT|MIGRATE|EXECUTE)` 零命中。**第 2 刀就登记**进 `scripts/ops/global-history-flag-manifest.mjs`（数组 `:49`）：`type:'boolean', activationValue:'true', danger:'high', dependsOn: [], conflictsWith: ['MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA']` + 一条 `conflicts` 规则（该组合在代码里是非法姿态：§2 门 ② 409）。**不用 `dependsOn` / `requires` 建模 fence**——`requires` 违规在默认与 `--strict` 两模式都是无条件 STOP、exit 1（`multitable-global-history-flag-status.mjs:184-192`、`:330`），会把「只开本 flag 跑预览」这一合法阶梯永久打红；沿用 manifest 对进程内 409 的惯例（`:169-172`、`:190`、`:212`），purpose 写明「执行 / 撤销在 fence 未开时 409 `FIELD_RETYPE_TRUST_REQUIRED`，预览仍可用」。不登记会红：完整性测试从 `packages/core-backend/src` grep `MULTITABLE_[A-Z_0-9]+`（`global-history-flag-manifest.test.mjs:142-156`, `:173-195`）。部署次序进 runbook：迁移 → 开 fence → 开本 flag（不再要求 capture flag）。

## 6. 交付分刀

| 刀 | 内容 | 可合并前提 |
|---|---|---|
| 1 | 本 ADR | — |
| 2 | 预览：矩阵模块、`retype-preview` 路由、凭证、flag + manifest 条目、`isSystemManagedSheet` 注释更正；**不接 UI**（前端不挂入口，`MetaFieldManager.vue:1810-1816` 的下拉不变） | §1 L6 五处回归通过；矩阵 ∩ 白名单 = ∅ 断言；单测：A 规则 / `non_string_value` / 去重 / 顺序 / 5000 上限 / 目标 property 键集 / §1 并集四类 422 / 回收站阻断 / 权限门 403 / 死表 404 / flag OFF 403 / legacy flag 409；**新回归**（新文件）：`MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT='true'` 时 PATCH `string→select` 与 `string→multiSelect` 仍 400 `FIELD_RETYPE_NOT_LOSSLESS`、零记录写入 |
| 3 | 执行 + 撤销：迁移（CHECK 放宽 + 作业表）、捕获兄弟函数、两路由、写入者栅栏后复核、Tier-2 拒绝、runbook | **真库**验收（模板 `tests/integration/multitable-l6a-sealed-operation-endpoint-realdb.test.ts:57` `describeIfDatabase`、`:182-187` 不许 skip 绿哨兵），均在 fence = ON：<br>① `retype-convert-execute-failure-rolls-back-realdb`：改写后注入失败 ⇒ `meta_fields.type/property`、`meta_records.data`、config / record revision、前镜像、作业行、endpoint 全无变化；<br>② `retype-convert-refuses-during-recovery-realdb`：`recovery_writer_state ∈ WRITER_BLOCK_STATES`（含 `archiving`）⇒ 409 `RECOVERY_IN_PROGRESS`，零写入；<br>③ `retype-convert-plan-drift-realdb`：预览后改一格 / 加一行 / 删一行 / **回收站增减一行** ⇒ 执行 409 `PLAN_DRIFT`，零写入；<br>④ `retype-convert-anchor-resolves-and-undo-exact-realdb`：一个 `convertRevisionId` 取回配置半 + 前镜像 + 记录半，endpoint `event_count` / `MAX(seq)` 与实际一致；断言 record revision 形状（`patch` / `snapshot`、删键哨兵）与「每 bump 恰一条」；撤销后四态精确（`data ? key`、`jsonb_typeof`、`'""'::jsonb` / `'[]'::jsonb`）；空表转换有作业行、可撤销、无 endpoint；转换后新增 / 删除 / 编辑本列 / 改字段配置各一条 409 + 零写入，编辑他列后撤销仍成功；`no force-override path exists`；<br>⑤ `retype-convert-pre-image-expired-realdb`：真跑保留期清理后撤销 ⇒ 409 `PRE_IMAGE_EXPIRED`，零写入；<br>⑥ `retype-convert-blocks-tier2-config-restore-realdb`：对转换修订与撤销修订各做 config-restore 预览 + 执行 ⇒ 422，零写入；<br>⑦ `retype-convert-concurrent-writer-realdb`：写入者在执行 / 撤销持栅栏期间阻塞 ⇒ 提交后 409 `FIELD_SCHEMA_CHANGED`，零错形单元格；<br>⑧ `retype-convert-foreign-id-realdb`：他表 `convertRevisionId` / 他字段凭证 ⇒ 404 / 401，零写入；<br>⑨ 死表 ⇒ 三端点 404、零读零写；另 fence OFF ⇒ 409、legacy flag ON ⇒ 409 |
| 4 | UI：flag 开时下拉加两对、预览面板、确认、撤销入口、托管表提示；面板高度按 7a 单独处理 | 第 3 刀真库九条真跑绿 |

## 7. 非目标、已知后果与待问

**非目标（首批不做，另案）**：`文本 → 数字/日期/货币/百分比/评分`（v2.1 §4 撤回字面量判据，规则须另写）；`多选 → 单选`（后置，前置三件 = 碰撞规则 / 长度上限 / 撤销域）；`longText → 选项`；`select ↔ multiSelect`；按分隔符拆分；托管表逐列开放；回收站行的转换（首批整次拒绝）；插件 SDK `ensureFields` 改类型口（`provisioning.ts:503, :509-511`，第一刀已明写不收）；两条既有 API 缝（附件 / 系统戳作目标零守卫）；撤销的强制覆盖 / 部分撤销 / 撤销的撤销；记录锁——执行与撤销沿 `:7602` 先例声明 lock-exempt。

**已知后果（转换后，告知客户）**：非插件写入者写纯字符串会被选项校验拒——自动化 `update_record`（`automation-executor.ts:3102`）、OAPI 客户端；公式物化值 / 视图运算符 / 实时推送不迁移（§3.8）；改本列任一格后整列撤销不可用（§3 ③）。

**待客户一句话**：① 实际卡住的是不是 `文本→单选/多选`（截图推测），有没有 `文本→数字/日期`；② 涉及的列是否有长文本列；③ 备料托管表上的租户 `ext_` 列（已带 `extension: true` + `ownership` 标记，无需新做标记）要不要按列开放转换；④ 带首尾空白的行「整次拒绝、先清洗」是否可接受；⑤ 表是否都在 5000 行内（含回收站）；⑥ Data Factory 目标适配器写入的多维表有哪些（§1 缺口）。

**T 层默认值（`Ratified-by-default-2026-09-26`，owner 24h 可否决）**：预览也受 flag 门控；整表排除而非逐列；并集判定含 `plugin_tagged_fields` / `pipeline_staging_sheet`；预览 id 列全不抽样；manifest `dependsOn: []` + 与 legacy flag 的 `conflicts` 规则；legacy flag 开时三端点 409；作业表 `meta_field_retype_conversions`（v2.1 说「不定案」）与信封 `{k,v,post}`；前镜像 / 配置修订 `operation_id` 恒 NULL；源限 `string`（不含 longText）；新增 `non_string_value` / `trashed_rows_with_value` 拒绝；撤销 ③ 比值不比 version；写入者栅栏后复核仅在本 flag 开时启用；捕获不受 capture flag 门控；记录锁 lock-exempt；`CONTIGUITY_STRICT` 首批不要求。

## 8. 评审处置（两轮；仅记未按原建议采纳项，其余已并入正文）

- r1 nit「`ORDER BY … COLLATE "C"`」→ 改为三处共用 JS 码元比较器（§4 顺序）：`hashScope` 本就在 JS 排序（`restore-preview-identity.ts:131`），共用比较器比再引入一个 SQL 排序规则少一个漂移源。
- r1 B2 二选一 → 取「整次拒绝」不取「定义回收站数据如何转换」：后者要改写 `meta_records_trash.data` 并为其捕获前镜像，超出首批；拒绝 + 清理再预览与 A 同口径。
- r1 B3 二选一 → 取「写入者栅栏后复核」不取「表级 schema 纪元」：前者复用 link 写入者先例（`link-writer-fence.ts:146-153`）、不加列，且只在本 flag 开时启用。
- r1 S5 → 作业表直接不设 `operation_id`，比「可空、无 FK」更少歧义。
- r2 S1 二选一 → 保留 manifest 惯例（`dependsOn: []`），不让预览也因 fence 未开而拒绝：预览零写入，无需栅栏。
- r2 B1「检测 Data Factory 目标」→ 部分采纳：`staging_sheet_id` 进并集；`objects[*].sheetId` 的持久化位置本轮未读，列为 §1 缺口 + 客户待问 ⑥，不假装覆盖。
- r2 N6「预览回自动化数量」→ 不做：要解析全部自动化配置里的字段引用，与单元格扫描契约无关；改为 §7 已知后果告知。
