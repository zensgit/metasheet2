# ADR：字段类型转换首批设计锁（文本→单选 / 文本→多选）— 2026-09-26

**状态**：DESIGN-LOCK（首批窄范围）。owner 已于 2026-09-25 在 #5864 拍板五项（权限门 / 前镜像保留 / 往返保真 A / 首批配对 / 选项上限），裁定记录见 PR #6074（`docs/development/takeover-beiliao-20260821/customer-anomaly-triage-20260924.md` §7b 与 §3「owner 拍板」）。本 ADR 把 #5864 v2 + v2.1 收成一份可开工的锁；**不是上线授权**，不开开关、不碰真实客户数据。
**基线**：`origin/main @ 51acbb18f`（2026-09-26）。每条 `path:line` 都在该 sha 上读过；行号漂移快，实施前按符号名重定位。
**Refs**：#5864（保持开启）、PR #6074、#3812（4c-1 回滚侧锁，其 §7 把「前向 PATCH 迁值」明列出界——本 ADR 就是那条独立产品决定）。

## 0. 一句话

在**不动** `PATCH /fields/:fieldId` 与 `LOSSLESS_FIELD_RETYPE` 的前提下，新开一条受控路径：只读预览 → 带完整前镜像的执行 → 整列撤销；首批只做 `string → select` 与 `string → multiSelect`，整段文字为一个选项；全部默认 OFF。

## 1. 范围（锁定）

| 项 | 锁定值 | 依据 |
|---|---|---|
| 首批配对 | **仅** `string → select`、`string → multiSelect`。源限 `string`（非 `longText`，无论 rich 与否） | owner 2026-09-25；今日两对都被 `assertLosslessFieldRetype` 拒 400（`field-retype-whitelist.ts:206-221`，路由映射 `univer-meta.ts:14200-14201`），注释里写明「string → select 故意不收」（`:117`） |
| 现有白名单 | `LOSSLESS_FIELD_RETYPE`（`field-retype-whitelist.ts:120-132`）、前端镜像（`apps/web/src/multitable/utils/field-retype.ts:51-65`）、真值表（`tests/fixtures/field-retype-truth-table.json:53-65`）**逐行不变**；PATCH 对新配对仍 400 | L6：narrowing test `:173-175`（表即夹具）与 `:329-434`（PATCH 强制）、integration `multitable-context.api.test.ts:1905-2015` 逐用例保持通过，两条路径 `git diff` 为空 |
| 新旧分离 | 转换矩阵放**独立新模块**（建议 `multitable/field-retype-convert.ts`），与白名单零 import；加一条断言「首批配对 ∩ LOSSLESS_FIELD_RETYPE = ∅」 | v2 前提 1.3 |
| 排除集 | 任一端 ∈ `FIELD_RETYPE_EXCLUDED_TYPES`（`field-retype-whitelist.ts:102-105`）⇒ 422 | 与 4c-1 §2.1 同口径 |
| **插件写入列** | **整表排除**：`sheetId` 在 `plugin_multitable_object_registry` 有行（`sheet-delete-guard.ts:65-77` `isPluginManagedSheet`，只答是/否、不回插件名）或为系统托管表（`:83-94` `isSystemManagedSheet`）⇒ 预览/执行/撤销一律 422 `FIELD_RETYPE_CONVERT_NOT_SUPPORTED`，`details.reason = 'plugin_managed_sheet' | 'system_managed_sheet'` | owner 补充：托管备料表的插件写入列（确认账本 Status / Conflict Type / 处理动作 / 备注）不在范围。插件写路径按选项表硬校验：`records.ts:138-152`（单选，`''` 放行、其余须在 options 内）、`:154-182`（多选，trim + 校验 + 去重），转成选项型后插件回写必失败 |

**为什么是整表而不是逐列**：`meta_fields` 上**没有**「该列由插件写入」的标记——在 `provisioning.ts`、`plugin-scope.ts`、`field-codecs.ts`、`permission-derivation.ts` 搜 `pluginManaged|managedBy|writtenByPlugin|plugin_managed` 零命中；所有权只在表级登记（`plugin-scope.ts:198-203` 写 `sheet_id/project_id/object_id/plugin_name`）。`plugin_field_policy_registry` 不是候选——网格从不读它（`services/stock-preparation-field-permissions.ts:16-19`）。备料目标表同时有插件列与租户 `ext_` 列（`plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs:312, :343`），要为 `ext_` 列单开必须先有逐列来源标记，列为待办（§7）。**UI 表现**（第 4 刀）：托管表上类型下拉只保留今日无损目标，并显示静态提示「此表由插件托管，字段类型不能转换」，不含插件名。

## 2. 只读预览 `POST /api/multitable/fields/:fieldId/retype-preview`（第 2 刀）

- **请求**：`{ targetType: 'select' | 'multiSelect' }`。不接受 `property`——选项由服务端从单元格推导。
- **门（三段，顺序固定）**：① flag `MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT !== 'true'` ⇒ 403 `FIELD_RETYPE_CONVERT_DISABLED`；② `capabilities.canManageFields`（照抄 PATCH 的 `univer-meta.ts:13868`；表级已含 `&& scope.canWrite`，`permission-service.ts:1493`）⇒ 否则 403；③ `hasFullTableReadAccess`（`univer-meta.ts:7244-7262`，既有用法 `:10837`）⇒ 否则整面 403，**无 scoped 模式、无 undisclosed 标记**（R6 裁决，`docs/development/multitable-global-history-r6-ratification-decision-record-20260708.md` §2；`lossy-retype-oracle.ts:44-48`）。预览签发的是绑定 `actorId` 的执行凭证，故两者都要。
- **范围校验**：源 `type !== 'string'`、目标不在首批、排除集、托管表 ⇒ 422 `FIELD_RETYPE_CONVERT_NOT_SUPPORTED` + `details.reason ∈ {pair_not_in_first_batch, excluded_type, plugin_managed_sheet, system_managed_sheet}`。
- **上限**：记录数 > `resolveSheetRevertMaxRecords()`（默认 5000，`restore-caps.ts:15, :17-20`）⇒ 413 `SHEET_TOO_LARGE`，不截断（照抄 `univer-meta.ts:10847-10849`）。预览扫描数 = 执行可写数 = 撤销可写数，同一常量。
- **零写入**：走 `pool.query`（同 `:10837` 的预览），不开事务、不取栅栏、不写任何表。
- **响应**（values-free：**只有计数与 recordId，永不含单元格值或选项文本**）：

```jsonc
{ "ok": true, "data": {
  "verdict": "ok" | "rejected",
  "sourceType": "string", "targetType": "select",
  "scannedRecordCount": 1234, "recordCap": 5000,
  "cells": { "empty": 100, "converted": 1130, "rejected": 4 },
  "options": { "new": 57, "final": 57, "limit": 5000, "droppedPropertyKeyCount": 1 },
  "rejections": [ { "reason": "leading_trailing_whitespace", "recordCount": 3, "recordIds": ["…"] },
                  { "reason": "whitespace_only",             "recordCount": 1, "recordIds": ["…"] } ],
  "recordIdSampleCap": 200,
  "previewToken": "<仅 verdict=ok 时签发>", "confirm": "convert-field-type"
} }
```

  **为何回 recordId、不回值**：owner 要求「预览里列出这些行」；调用方已过全表读门，行 id 对他不是新信息，而单元格值再回一遍就绕开了记录读面的遮罩口径（`hasFullTableReadAccess` 末段的 mask parity）。每个 reason 最多 200 个 id + 总数。选项文本 = 单元格值，同样不回；它们由计划摘要在服务端绑定。`verdict: 'rejected'` 是报告不是错误，仍 200。
- **凭证**：`previewToken` 沿用 `restore-preview-identity.ts` 的 HS256 + 10 分钟（`:42`, `:274-275`）；claims = `{ type:'field-retype-convert-preview', sheetId, fieldId, actorId, sourceType, targetType, planHash }`。`planHash` 是**服务端密钥 HMAC**（理由同 `hashLossSummary`，`:256-262`：JWT 客户端可解码，明文哈希会变成暴力探针），折入：源 `type`+规范化 `property`；目标 `type`+**完整新选项序列**；`hashScope`（`:129-134`）形状的 `[recordId, cellHash, version]` 排序序列。缺任一轴即 v2 前提 2 的「计数相同、集合互换」反例成立。

## 3. 执行 + 整列撤销（第 3 刀，后做）

**执行** `POST /api/multitable/fields/:fieldId/retype-execute { previewToken, confirm: 'convert-field-type' }`，同一道门 + 以下运行期硬门，一个事务：

1. `confirm` 不符 ⇒ 400 `CONFIRM_REQUIRED`（镜像 `univer-meta.ts:11173-11174`）。
2. **信任门（fail-closed）**：`MULTITABLE_ENABLE_WRITER_FENCE` 未开（`canonical-sheet-fence.ts:160-162`；关时 `fenceWriterEntry` 首行 return，`:209-211`，账本亦惰性 `operation-ledger.ts:142-143`）**或** `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED !== 'true'`（`tombstone-capture.ts:44-46`）⇒ 409 `FIELD_RETYPE_TRUST_REQUIRED`（形状照 `exact-anchor-recovery-route.ts:637-644`；接线点照 `univer-meta.ts:12537-12538`）。**不得**进入「跳过捕获、照常改写」分支。`MULTITABLE_HISTORY_CONTIGUITY_STRICT` 首批**不**要求（撤销锚是前镜像 + 作业行，不走 exact-anchor 重建）。
3. `fenceWriterEntry` → `SheetWriterBlockedError` ⇒ 409 `RECOVERY_IN_PROGRESS`（`univer-meta.ts:14178-14179`）→ 字段行与范围内记录 `FOR UPDATE` → **重算 `planHash`** 比对凭证 ⇒ 不符 409 `PLAN_DRIFT`。
4. 预铸 `convertRevisionId = randomUUID()`（照 `:11176` / `:11238`）；`mintOperation`。
5. **写前镜像（全表每行一条，含空格）**：新捕获函数 `captureRetypeConvertPreImageRows`（`captureLossyRetypePreImageRows` 的兄弟，`tombstone-capture.ts:225-236` 一字不动），`reason = 'retype_convert'`（需一次迁移放宽 CHECK，`zzzz20260708090000:34`），`config_revision_id = convertRevisionId`（索引 `(config_revision_id, field_id)`，`:44-47`）。`value jsonb NOT NULL`（`:33`）装不下缺键/JSON null，故 **value 存信封 `{"k":<hasKey>,"v":<原始 JSON>,"post":<写入值>,"ver":<写后 version>}`**（v2.1 §1 候选 (c)：不改列、不混入 R1 的 `reason='field_delete'` 过滤，`univer-meta.ts:7726`）。捕获失败 ⇒ 整体回滚。捕获自身上限 50000（`tombstone-capture.ts:42, :48-51`）被 5000 支配；若日后调高记录上限须同步调它。
6. `UPDATE meta_fields SET type, property`（目标 property 见 §4）→ **一条**原生 jsonb 批量 `UPDATE meta_records`（形状照 `:7604-7613` 的 `jsonb_set … FROM jsonb_to_recordset`），声明 lock-exempt 并写理由（先例 `:7602`）→ 每格一条 record revision，走 `recordRecordRevisionsBatch`（`:7758`）并传 `ledger`（`record-history-service.ts:55-64`），**`batchId = convertRevisionId`**（`meta_record_revisions.batch_id text`）→ `recordConfigRevision({ id: convertRevisionId, batchId: convertRevisionId, changedKeys:['type','property'] })`（`config-revision-recorder.ts:40, :44`；`meta_config_revisions.batch_id uuid`）→ 写作业行 → `sealOperation` → COMMIT。
7. **局部关联（v2.1 §3 候选 (b)+(c)）**：新表 `meta_field_retype_conversions (convert_revision_id uuid PK, sheet_id, field_id, source_type, source_property jsonb, target_type, target_property jsonb, record_count int, actor_id, operation_id uuid NULL, created_at, undone_at NULL, undo_revision_id NULL)`。一个 id 取回三半：配置半（`meta_config_revisions.id`）、前镜像（`config_revision_id`）、记录半（`batch_id`）。**不**给 `ConfigRevisionInput` 加 `ledger`、不改 endpoint 校验（它只数记录事件，`zzzz20260715210000:167-174`）；空表转换零记录事件 ⇒ `sealOperation` 不写 endpoint（`operation-ledger.ts:158-160`），作业行仍存在、撤销仍可达，**不制造不存在的记录锚点**。通用配置账本扩展 = 另案。

**撤销** `POST /api/multitable/fields/:fieldId/retype-undo { convertRevisionId, confirm: 'undo-field-type-convert' }`，同门同信任门同事务。**先校验三者，任一不符 ⇒ 409 `UNDO_PRECONDITION_FAILED`、零写入**：

| 校验 | 判据 | 说明 |
|---|---|---|
| ① 字段配置未变 | 当前 `{type, property}` 与作业行 `target_*` 逐字节相等 | 含选项集与颜色 |
| ② 记录集未变 | 当前 `meta_records.id`（`sheet_id` 内）集合 == 前镜像 record_id 集合 | 删除是硬删 + 回收站行（`records.ts:1018`；`zzzz20260617120000_create_meta_records_trash.ts:19`；`meta_records` 无 `deleted_at`，迁移全搜无），故删行 = 集合少一个；从回收站恢复回来的行由 ③ 兜住 |
| ③ 写后状态未变 | 每行 `data->field` == 信封 `post` 且 `version` == 信封 `ver` | 折叠用 `hashScope` 形状 |

另：作业行 `undone_at` 非空 ⇒ 409 `ALREADY_UNDONE`；前镜像行数 < `record_count`（被保留期清理）⇒ 409 **`PRE_IMAGE_EXPIRED`，明确报错、不部分恢复**。`details` 只含三类计数 + 受影响 recordId（≤200），不回显值，`message` 不含 id（口径同 narrowing test `:350-352`）。通过后：先恢复 `type/property`、再按信封 `k/v` **四态精确回写**（缺键 ⇒ 删键；JSON null；`[]`；`''`）——必须走原生 jsonb 批量 UPDATE，不得经 `RecordWriteService`（其多选路径先 `normalizeMultiSelectValue`：`field-codecs.ts:1016` 把 null/''/undefined 折成 `[]`，`:1028` trim，`:1033-1036` 去重，四态不可达；单选路径 `record-write-service.ts:577-580` 对非字符串直接抛）。落 record revision（`ledger`、`batchId = 新 undo revision id`）+ config revision（`source:'restore'`, `restoredFromId: convertRevisionId`；CHECK 允许，`zzzz20260624200000:10-11`）+ 作业行 `undone_at`。**首版无强制覆盖、无部分撤销、无撤销的撤销。**

**前镜像保留**：沿用现有 retention，一套旋钮（`MULTITABLE_META_REVISION_RETENTION_ENABLED === '1'`，`meta-revision-retention.ts:65`）；tombstone 表恒按天龄清理、无「保留最新一条」下限（`:219-227`，说明 `:207-217`）；默认 365 天、下限 30 天（`:41-42`）。**开启时 = 365 天可撤销窗口；未开启 = 不清理。** 作业行本身不参与清理，所以过期后仍能给出 `PRE_IMAGE_EXPIRED` 而非 404。

## 4. 往返保真 A 与选项生成（锁定）

| 规则 | 值 | 依据 |
|---|---|---|
| 一格一项 | 单元格**完整文本**为一个选项；逗号/顿号/分号/换行一律当普通字符，不切分、不 AI 推断 | owner；v2 §1.2 |
| 多选形状 | `"A,B"` → `["A,B"]`（长度 1） | 同上 |
| **A：首尾空白 / 纯空白 ⇒ 整次拒绝** | `text !== text.trim()` 或 `text.trim()===''`（非空串）⇒ `rejected`，reason `leading_trailing_whitespace` / `whitespace_only`，预览列出 recordId；**两个方向同一口径** | owner 走 A。多选写路径 trim 后校验（`records.ts:171-175`；`field-codecs.ts:1028-1032`），带尾空格的选项写进去后用户再提交即被拒——比静默归一更糟；单选路径不 trim（`record-write-service.ts:577-584`），两条路径天然不对称，A 抹平它 |
| 非字符串非空值 | 数字 / 对象 / 数组（导入或历史数据）⇒ `rejected`，reason `non_string_value` | 转换语义未定，且不可证明往返 |
| 空值 | 缺键 / `null` / `''` ⇒ 目标写规范空值：单选 `''`（`record-write-service.ts:582` 唯一放行的空形），多选 `[]`；**前镜像按信封保留原始四态**，撤销不归一 | owner P1 #1 |
| 去重 | 精确码点相等（大小写敏感、不做 Unicode 归一） | 写路径用 `Set` 精确比对（`record-write-service.ts:581-582`；`records.ts:147-149`） |
| 顺序 | 按 `meta_records.id` 升序扫描的首次出现序；预览与执行同一 `ORDER BY`，否则 `planHash` 不稳 | 确定性 |
| 选项形状 | `{ value }`，不赋 `color`（`extractSelectOptions` 接受缺省，`field-codecs.ts:169-186`） | UI 用默认色 |
| 目标 property | `{ options }` + 仅当 `validation` 只含 `required` 时保留；源 property 其余键（含残留 `options`、文本类 `validation` 规则）全部丢弃并计入 `droppedPropertyKeyCount` | 与前端 `retainedRetypeValidationRules` 同理（`field-retype.ts:135-144`）；`sanitizeFieldPropertyByType` 对 select 只保 options（`field-codecs.ts:288-291`） |
| **选项上限 5000** | `final > 5000` ⇒ `rejected`，reason `option_limit_exceeded`，不取前 N、不截断；新常量 `FIELD_RETYPE_MAX_OPTIONS = 5000`（与记录上限同值但**分立**） | owner；写路径今日对选项数无任何上限（`:288-291` 原样透传） |
| 单项长度 | 首版**不设** | owner |

## 5. 开关（锁定）

新 flag **`MULTITABLE_ENABLE_FIELD_RETYPE_CONVERT`**：默认 OFF；比较 **`=== 'true'` 字节精确**（不 trim、不转小写，与 capture/revert 族一致）；门控预览 / 执行 / 撤销三个端点（预览也门控——一次全表扫描并回 recordId 不该在客户环境无授权可达）。名字在 `packages`/`scripts` 全搜 `FIELD_RETYPE_(FORWARD|CONVERT|MIGRATE|EXECUTE)` 零命中。**第 2 刀就登记**进 `scripts/ops/global-history-flag-manifest.mjs`（数组 `:49`）：`type:'boolean', activationValue:'true', danger:'high', dependsOn:['MULTITABLE_ENABLE_WRITER_FENCE','MULTITABLE_TOMBSTONE_CAPTURE_ENABLED']` + 两条 `requires` 规则（形状照 LOSSY 条目 `:124-145`），purpose 写明「执行/撤销在两者未开时 409 `FIELD_RETYPE_TRUST_REQUIRED`，预览仍可用」。不登记会红：完整性测试从 `packages/core-backend/src` grep `MULTITABLE_[A-Z_0-9]+`（`global-history-flag-manifest.test.mjs:142-156`, `:173-195`）。运行期还要求 fence 与 capture 两个既有 flag（§3.2），部署次序进 runbook：迁移 → 开 fence → 开 capture → 开本 flag。

## 6. 交付分刀

| 刀 | 内容 | 可合并前提 |
|---|---|---|
| 1 | 本 ADR | — |
| 2 | 预览：矩阵模块、`retype-preview` 路由、凭证、flag + manifest 条目；**不接 UI**（前端不挂入口，`MetaFieldManager.vue:1810-1816` 的下拉不变） | §1 L6 五处回归通过；矩阵 ∩ 白名单 = ∅ 断言；单测：A 规则 / 去重 / 顺序 / 5000 上限 / 托管表 422 / 权限门 403 / flag OFF 403 |
| 3 | 执行 + 撤销：迁移（CHECK 放宽 + 作业表）、捕获兄弟函数、两路由、runbook | 四条**真库**验收（模板 `tests/integration/multitable-l6a-sealed-operation-endpoint-realdb.test.ts:57` `describeIfDatabase`、`:182-187` 不许 skip 绿哨兵），均在 fence = ON 下跑，另加 fence/capture OFF ⇒ 409 用例：<br>① `retype-convert-execute-failure-rolls-back-realdb`：改写后注入失败 ⇒ `meta_fields.type/property`、`meta_records.data`、config/record revision、前镜像、作业行、endpoint 全无变化；<br>② `retype-convert-refuses-during-recovery-realdb`：`recovery_writer_state ∈ {fencing, applying, paused_retryable}` ⇒ 409 `RECOVERY_IN_PROGRESS`，零写入；<br>③ `retype-convert-plan-drift-realdb`：预览后改一格 / 加一行 / 删一行 ⇒ 执行 409 `PLAN_DRIFT`，零写入；<br>④ `retype-convert-anchor-resolves-and-undo-exact-realdb`：一个 `convertRevisionId` 取回配置半 + 前镜像 + 记录半，endpoint `event_count`/`MAX(seq)` 与实际一致；撤销后四态精确（`data ? key`、`jsonb_typeof`、值相等 `'""'::jsonb` / `'[]'::jsonb`）；空表转换有作业行、可撤销、无 endpoint；转换后新增 / 删除 / 编辑记录 / 改字段配置各一条 409 + 零写入；`no force-override path exists` |
| 4 | UI：flag 开时下拉加两对、预览面板、确认、撤销入口、托管表提示；面板高度按 7a 单独处理 | 第 3 刀真库四条真跑绿 |

## 7. 非目标与待问

**非目标（首批不做，另案）**：`文本 → 数字/日期/货币/百分比/评分`（v2.1 §4 撤回字面量判据，规则须另写）；`多选 → 单选`（后置，前置三件 = 碰撞规则 / 长度上限 / 撤销域）；`longText → 选项`；`select ↔ multiSelect`；按分隔符拆分；托管表逐列开放；插件 SDK `ensureFields` 改类型口（`provisioning.ts:503, :509-511`，第一刀已明写不收）；两条既有 API 缝（附件 / 系统戳作目标零守卫）；撤销的强制覆盖 / 部分撤销 / 撤销的撤销；记录锁——执行与撤销沿 `:7602` 先例声明 lock-exempt（T 层默认值，owner 可否决）。

**待客户一句话**：① 实际卡住的是不是 `文本→单选/多选`（截图推测），有没有 `文本→数字/日期`；② 涉及的列是否有长文本列；③ 备料托管表上的租户 `ext_` 列要不要转（要 ⇒ 先做来源标记）；④ 带首尾空白的行「整次拒绝、先清洗」是否可接受；⑤ 表是否都在 5000 行内。

**待 owner（默认前进 + 24h 否决）**：预览也受 flag 门控；manifest 用 `dependsOn` + `requires` 规则建模（而非 `:190`/`:212` 的纯 purpose 文本惯例）；记录锁 lock-exempt；`CONTIGUITY_STRICT` 首批不要求。
