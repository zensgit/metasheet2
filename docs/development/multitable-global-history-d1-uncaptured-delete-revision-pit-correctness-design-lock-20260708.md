# Multitable Global History — D-1 Uncaptured-Delete PIT-Correctness — DESIGN-LOCK(PROPOSED)(2026-07-08)

**状态:PROPOSED,待 owner ratify **且** 路由决定。** 起草于线级 /goal 授权下(pre-gate「推进到闸门前最远点」,与 4c-1/4c-2/4c-3 同法 design-lock-first)。**本文不改任何代码、不授权实现。**
**⚠️ 跨车道声明:** 修复面在 `automation-executor.ts`(自动化线)与 `records.ts`(plugin-SDK)。本锁是**给 owner 的决策-就绪提案**,**不预设由本会话实现**;owner 需二决:(a) ratify 哪档(D-1 revision-only vs D-2 revision+trash);(b) 由本会话还是自动化线会话实现。
**来源:** 销毁路径覆盖 gap-audit(#3921)的 D-1;缺陷由本线 PIT 消费者暴露,逐条 primary-source 核实。

## 0. 一句话与红线

让**automation `delete_record`** 与 **plugin-SDK `deleteRecord`** 这两条今天**不写 delete revision** 的记录硬删路径**发射 delete revision**,使 `reconstructRecordsAtT` 不再把已删记录在任意 T 谎报为「仍存在」。
**红线:D-1 仅修时点重建正确性,不改可恢复性、不加 trash**(可恢复性 = D-2,独立更大决定)。**4d 不动摇。**

## 1. 缺陷(primary-source 已核,`origin/main`)

`reconstructRecordsAtT`(`record-reconstructor.ts`)**纯从 `meta_record_revisions` 派生记录存在性**(`DISTINCT ON (record_id) … WHERE created_at <= T ORDER BY created_at DESC …`;取 ≤T 的最新 revision,若为 `action='delete'` 则该记录在 T 不存在)。因此**任何不写 delete revision 的删除路径,会让被删记录的最后一条 revision 停留在 create/update ⇒ 对任意 T,PIT/Reset-preview/Reset-execute/记录重建都判定它「仍然存在」并喂旧快照。**

| 路径 | 位置 | 今日写 delete revision? | PIT as-of-T |
|---|---|---|---|
| `record-service.deleteRecord`(治理) | `record-service.ts:835`(`action:'delete', source:'rest'`) | ✅ | 正确 |
| `univer-meta.ts:10066` PIT-reset 内联 | `recordRecordRevision(action:'delete', source:'restore')` | ✅ | 正确 |
| **automation `delete_record`** | `automation-executor.ts:2269`(**已上线/无 flag/有授权 UI**) | **✗** | ❌ 谎报存活 |
| **plugin-SDK `deleteRecord`** | `records.ts:565` | **✗** | ❌ 谎报存活 |

旁证:`RecordRevisionSource`(`record-history-service.ts:6`)= `'rest' | 'yjs-bridge' | 'automation' | 'public-form' | 'plugin' | string` —— **`automation` / `public-form` / `plugin` 三个枚举位已声明却从未发射**(`automation` 有 1 处 create/update 侧发射,delete 侧无),说明原设计本就打算覆盖它们。

## 2. 修复面(逐路径,最小)

发射器契约(照抄治理路径 `record-service.ts:835`):`recordRecordRevision(query, { sheetId, recordId, version, action:'delete', source, changedFieldIds:[], patch:{}, snapshot, batchId })`。**snapshot 必须在 `DELETE FROM meta_records` 之前捕获**(删后取不到)。

- **automation(`automation-executor.ts:2269` 附近)**:该处仅 `SELECT locked, locked_by, created_by …`(为 lock 守卫),**不取 `version`/`data`**。D-1 需在 DELETE 前补取 `version, data`(可并入既有 SELECT),然后 `recordRecordRevision(…, source:'automation', snapshot)`。**须在与 DELETE 同一事务内**(核实 `this.deps.queryFn` 的事务边界——gap-audit 标注该点「未追」,impl 前必确认;若非同事务,则 revision 与 DELETE 必须包进一个事务,否则失败态会产生「记了删除却没删/删了没记」的半态)。
- **plugin-SDK(`records.ts:565`)**:`DELETE … RETURNING version` 已回 `version`,但**无 `data` 快照**。D-1 需在 DELETE 前 `SELECT data`(或把 `data` 加进 `RETURNING`——但 RETURNING 在 DELETE 后,snapshot 语义上应是删前值,故用前置 SELECT 更清晰),然后 `recordRecordRevision(…, source:'plugin', snapshot)`,复用 `input.query`(已在事务内)。
- **batchId**:单记录删除 ⇒ 省略(= 该 revision 自身 id 作 batch,LOCK-12 语义)。批量 automation ⇒ 同一 action 共享一个 batchId(镜像 record-write-service 的 bulk 语义)。

## 3. 语义与 flag

- **无 flag(纯正确性修复,同 D-6 先例)。** 现行「不写 revision」本身就是缺陷,不存在一个「默认关」是想要的。发射 delete revision 后,**曾被 automation/plugin 删除的记录会在其删除 T 之后正确地从 PIT 消失**——这是**期望的行为更正**,但确是一处 as-of-T 结果变化,须在 PR 中如实声明(现存的被污染 as-of-T 状态会被纠正)。
- **不加 trash / 不改可恢复性**:D-1 后这些记录在 Global History 里如实记为「已删」,但**仍不可恢复**(无 trash 行、无 tombstone)——与 plugin-SDK 今日"不可恢复"一致,只是不再污染 PIT。可恢复性 = D-2。
- **不碰 4c-2 tombstone 捕获**:D-1 不为这两条路径加 inbound tombstone(那属 D-2 的可恢复性范畴);故 4c-3 的 inbound 重放**仍不覆盖**经这两条路径删除的记录(4c-3 可达边界不变)。

## 4. Golden(realdb,fail-first,mutation-proven)

| # | 场景 | 断言 |
|---|---|---|
| D1-1 | automation `delete_record` 删记录 → `reconstructRecordsAtT(T > 删除)` | 该记录**不在**结果(as-of-T 不存在);meta_record_revisions 有一条 `action='delete', source='automation'` |
| D1-2 | plugin-SDK `deleteRecord` 同上 | 同上,`source='plugin'` |
| D1-3 | 删除前的 T(`T < 删除`) | 该记录**仍在**(delete revision 不影响更早 T) |
| D1-4 | snapshot 完整性 | delete revision 的 snapshot = 删前 `data`(可供 History 展示,非用于恢复) |
| D1-5 | 原子性 | 注入 DELETE 后 revision 写入失败 → 整事务回滚(记录未删、revision 未写),**无半态** |
| D1-6 | mutation | 移除任一路径的 `recordRecordRevision` 调用 → 对应 D1-1/D1-2 变红 |

## 5. 决策分叉(owner 二择;本锁默认 fail-closed 收窄为 D-1)

- **D-1(本锁,推荐先行):** 仅发射 delete revision → 修 PIT 正确性。小、纯正确性、无产品语义变化(除"PIT 不再谎报"这一更正)。
- **D-2(更大,独立签核):** 再补 `meta_records_trash` + inbound tombstone 捕获 → 这两条路径的删除变为**可恢复 + 进回收站 + 4c-3 可重建入边**。**改变产品语义**(automation/plugin 删除从"不可逆"变"可逆")。

## 6. 相邻缺口(记录,不在 D-1 范围)

**`public-form` 枚举位(第三个从未发射者):** 若 public-form 提交**创建**记录而**不发 create revision**,则该记录对 `reconstructRecordsAtT` **完全不可见**(存在性纯由 revision 派生)——即 form-created 记录在 PIT 里"从不存在"。这是**PIT 完备性**的另一面(create 侧),与 D-1(delete 侧污染)对称但独立。**impl 前建议 grep 确认 public-form 创建路径是否发 create revision**;若未发,单列为 D-1b 或并入本锁 §2(同样 source-枚举发射),由 owner 决定。

## 7. 出界

D-2 可恢复性、public-form 创建-revision(§6,待确认)、任何 flag、跨 base 语义扩展、4d(永不承诺)。

## 8. 实施排布(ratify + 路由后才排)

若 owner 点名本会话:强模型/Sonnet 车道(automation-executor 属热核,建议强模型或加严审)+ Opus 对抗审(mutation + 事务边界证明必交)+ auto-merge/keep-sync + wave MD。若路由到自动化线:本锁作为交接规格传递,不自做。

**解锁词示例:「ratify D-1,本会话做」/「ratify D-1,路由自动化线」/「ratify D-1+D-2」。**
