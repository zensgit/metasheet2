# Multitable Global History — 4c-2 Forward Tombstone-Capture — DESIGN-LOCK(PROPOSED)(2026-07-07)

**状态:PROPOSED,待 owner ratify。** 本锁在线级全自动授权下起草;forward-plan(#3633)中 4c-2 的解锁词是「owner 单项签核」——**起草 ≠ 开工,impl 仅在 ratify 后排期**。姊妹锁:4c-1 lossy retype revert(同日起草,可并行 ratify;两锁互引见 §4 R2)。

## 0. 一句话与红线

让**未来的**破坏性操作(字段删除 / lossy retype 的 coerce 写 / 记录硬删的入边)在销毁瞬间于同事务内捕获值级 tombstone,使其可恢复。
**红线(4d 边界,全文档一致):只向前生效——flag 开启前已销毁的数据字节不存在,任何路径不得伪装可恢复**(`…verified-state-map-and-decision-menu-20260703.md` §4d;`…gated-remainder-readiness-refresh-20260629.md` §2.5)。

## 1. 现状归零点(primary-source 已核)

| 破坏面 | 销毁语句 | 今日捕获 |
|---|---|---|
| 字段删除:列值 | `packages/core-backend/src/routes/univer-meta.ts:5983` `UPDATE meta_records SET data = data - $1` | **无** |
| 字段删除:link 边 | `:5978` `DELETE FROM meta_links WHERE field_id = $1` | **无** |
| 字段删除:auto-number 序列 | `:5970` | **无** |
| 字段删除:定义 | `:5971-5976` `fieldDeleteDiff`(仅 name/type/property/order) | ✅ config revision |
| lossy retype pre-image | 前向 PATCH 无值迁移(`:10660-10666`);4c-1 落地后其 coerce 写成为新破坏点 | **无** |
| 记录硬删:行值+出边 | `record-service.ts:804` snapshot + `:835-840` trash | ✅ `meta_records_trash` + delete revision |
| 记录硬删:**入边** | `record-service.ts:808` `DELETE FROM meta_links WHERE record_id=$1 OR foreign_record_id=$1` | **无**(4c-3 record-undelete 2b 的阻塞缺口) |

可照抄蓝本 = `meta_records_trash`(migration `zzzz20260617120000_create_meta_records_trash.ts:19-46`):独立表(零热读路径改动)、same-txn INSERT-before-DELETE、`isUndefinedTableError` 兼容守卫、surrogate PK、original timestamps、retention 默认关。

## 2. 捕获模型(锁定)

两张新 append-only 表,镜像 trash 设计原则:

- **`meta_field_value_tombstones`**:`id uuid PK, sheet_id, field_id, record_id, value jsonb, reason ∈ {'field_delete','lossy_retype'}, config_revision_id`(因果锚,回指触发的 `meta_config_revisions` 行)`, created_at`。
- **`meta_link_tombstones`**:`id uuid PK, sheet_id, field_id, record_id, foreign_record_id, reason ∈ {'field_delete','record_delete'}, source_revision_id`(config 或 record revision 锚)`, created_at`。
- auto-number 序列状态:**不建表**——扩展 `fieldDeleteDiff` 的 config revision payload 携带序列 `last_value`(定义级小数据;实现时须做 wire-shape 双侧扫描)。

捕获点(全部 same-txn、置于破坏语句**之前**、单条 `INSERT … SELECT` 批量,不逐行往返):

1. `dropFieldCascade`(`univer-meta.ts:5957-6017`)内:列值(`SELECT … FROM meta_records WHERE sheet_id=$2 AND data ? $fieldId`)、该 field 全部边、序列 `last_value`。
2. `deleteRecord`(`record-service.ts:790-846`)内:**入边**(`foreign_record_id = $1` 的行)。出边已由 trash `data` 覆盖并在 restore 重放(`:1011-1020`),**不重复捕获**。
3. 4c-1 lossy revert 的 coerce 写(若其 ratify):被 coerce/drop 的 cell pre-image → `meta_field_value_tombstones(reason='lossy_retype')`。

## 3. Flag 与 cap(锁定)

- 捕获 flag:`MULTITABLE_TOMBSTONE_CAPTURE_ENABLED`,默认 **off**;off = 今日行为逐字节不变。
- 捕获 cap:`MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS`(默认 50000)。flag on 且待捕获行数超 cap → **拒绝破坏操作本身**(422,提示调高 cap 或关捕获),**绝不静默跳过捕获后照删**——保住「flag on ⇒ 凡销毁必已捕获」。(写对称 cap 纪律;先例 `SHEET_REVERT_MAX_RECORDS` `univer-meta.ts:9276-9277`)
- 捕获 INSERT 失败 = 整事务回滚,破坏操作不发生(fail-closed)。

## 4. 恢复面(本锁只锁两个最小恢复 + 一个显式不做)

- **R1 字段 undelete 升级**:现 definition-only recreate(`recreateFieldFromConfig` `univer-meta.ts:6081-6107`,注释明言 values/links/auto-number NOT recovered)在 tombstone 存在时补水:值批量写回(仅 `data ? $fieldId` 为假的行——不覆盖 recreate 后用户新写的值)、边重建(仅两端记录均存活者)、序列 `last_value` 恢复。tombstone 不存在(前 flag 期数据)→ 保持今日 definition-only + 既有诚实文案。
- **R2 lossy retype revert 的真值恢复**:pre-image 存在时,4c-1 的 revert 优先用真值而非再-coerce——具体契约在 4c-1 锁 §5(pre-image-preference);本锁只保证捕获物与因果锚可用。
- **❌ 不做**:record undelete 2b 的入边重建语义(= 4c-3,独立 owner 签核;本锁只捕边、不重建)。

## 5. 不变量(C1–C7)

- **C1 forward-only**:无 tombstone ⇒ 走今日 definition-only 路径,永不虚构恢复、永不将「无捕获」升格为错误假装可恢复。
- **C2 捕获完备性**:flag on 时,§2 所列每条破坏语句在同事务内先行捕获;以 mutation 测试锁死(neuter 任一捕获 INSERT → 对应 golden 必红)。
- **C3 fail-closed**:捕获失败/超 cap → 破坏操作 422/整体回滚;flag off = 今日行为逐字节一致。
- **C4 masking parity**:一切补水预览/读路径复用 `filterDataByAllowedFields` 同一权限过滤;tombstone 表不新增任何读旁路(参照 #2968 LOCK-3 教训:扩 redaction 面必须带齐全部 perm 层)。
- **C5 原子性**:捕获+销毁单事务;补水单事务。
- **C6 retention 治理**:两张 tombstone 表接入 `meta-revision-retention.ts` 同一 knob/调度(默认 off、`keep-days` 语义(默认 365/地板 30)、bounded batch);**不用** keep-last-n(对 tombstone 无意义)。`meta_records_trash` 的显式-purge 现状不变(出界)。
- **C7 零读路径回归**:新表独立,热路径(record list / history read)零改动。

## 6. Golden 矩阵(fail-first,realdb)

| # | 场景 | 断言 |
|---|---|---|
| G1 | flag-on 字段删除 | 值/边/序列捕获行数与删除前逐一相等,因果锚正确 |
| G2 | flag-off | 行为与今日逐字节一致 + 零 tombstone 行 |
| G3 | 超 cap | 422 且 sheet 完全未变(原子) |
| G4 | 有-tombstone undelete | 值+边+序列回来;权限遮蔽字段按 C4 过滤;recreate 后新写值不被覆盖 |
| G5 | 无-tombstone undelete | definition-only + 诚实文案(前 flag 数据) |
| G6 | lossy_retype pre-image | 捕获行 + `config_revision_id` 锚正确(与 4c-1 G 系互引) |
| G7 | 记录硬删 | 入边捕获、出边不重复;restore 后入边**不**自动重建(4c-3 未授权) |
| G8 | retention sweep | 有界批量 + keep-days 地板 |
| G9 | mutation | neuter 每个捕获 INSERT → 恰好对应 golden 红(C2 证明) |
| G10 | 并发 | 删除与 undelete 竞争走既有 version-CAS / `FOR UPDATE`,无半态 |

## 7. 实施排布(ratify 后才排)

两车道单轮:L1 migration+捕获(Sonnet)∥ L2 补水+goldens(Sonnet),Fable 逐点审(mutation 证据必交);4c-1 若同轮 ratify,其 pre-image 捕获并入 L1。

## 8. 出界(记录在案)

sheet 删除级联(`univer-meta.ts:11548`)、跨 base、任何 FE 面(独立 gated 项)、`meta_records_trash` 的 retention 接入、4d(不可能项,永不承诺)。

**解锁词示例:「ratify 4c-2」(可附修改意见)。**
