# Multitable Global History — 记录销毁路径覆盖 GAP AUDIT + owner 决策菜单(2026-07-08)

**性质:** 审计发现 + 决策菜单。**不授权任何实现。** 本文起因:4c-3 design-lock 起草前的地基调研发现——**C2「flag on ⇒ 凡销毁必已捕获」在文档上看似完备,在代码上只覆盖 4 条记录硬删路径中的 1 条**;其中两条还导致 PIT/as-of-T 状态**长期错误**。全部结论由主会话逐条对 `origin/main` primary-source 核实(非调研代理转述)。

## 1. 事实:四条 `DELETE FROM meta_records` 路径

| # | 路径 | 清 link 双向 | delete revision | trash | tombstone(flag-on) | 可恢复性 | PIT as-of-T 正确性 |
|---|---|---|---|---|---|---|---|
| 1 | `record-service.ts:867` `deleteRecord`(治理路径) | ✓ | ✓ | ✓ | ✓ inbound | 完整(2a;inbound 待 4c-3) | ✅ 正确 |
| 2 | `univer-meta.ts:10066` **PIT-reset 内联删除** | ✓ | ✓(`action:'delete'`) | ✓ | **✗** | 记录可恢复,**inbound 边永久丢失** | ✅ 正确 |
| 3 | `records.ts:565` plugin-SDK `deleteRecord` | ✓ | **✗** | **✗** | ✗ | **不可恢复** | ❌ **错误** |
| 4 | `automation-executor.ts:2269` automation `delete_record` | ✓ | **✗** | **✗** | **✗** | **不可恢复** | ❌ **错误** |

核实点:`meta_links` 的 `record_id` 有 FK(`ON DELETE CASCADE`)、`foreign_record_id` **无 FK**,故四条路径都必须显式 `DELETE FROM meta_links WHERE record_id=$1 OR foreign_record_id=$1`——**四条都清掉了 inbound 边**,只有路径 1 在清之前捕获。

## 2. 【P1 级缺陷】automation / plugin-SDK 删除污染 PIT as-of-T 状态

`reconstructRecordsAtT`(`record-reconstructor.ts`)**纯粹从 `meta_record_revisions` 派生记录存在性**:

```sql
SELECT DISTINCT ON (record_id) record_id, action, snapshot, version
  FROM meta_record_revisions
 WHERE sheet_id = $1 AND created_at <= $2
 ORDER BY record_id, created_at DESC, version DESC, id DESC
```

若某条删除路径**不写 delete revision**,该记录的最后一条 revision 仍是 create/update ⇒ **对任意 T,PIT 都判定它「仍然存在」并把旧快照喂给所有 PIT 消费者**(PIT view / Reset preview / Reset execute / 记录重建)。

- **automation `delete_record` 是已上线、无 flag、有授权 UI 的一等公民动作**(automation action 注册 + 规则编辑器暴露)。用它删掉的记录:① 永久不可恢复(无 trash);② **在 Global History 与 PIT 里永远"活着"**。
- plugin-SDK 删除同理(该路径已在 4c-2 锁 §8 记为出界,但**其 PIT 污染后果此前未被记录**)。
- 设计意图旁证:`record-history-service.ts` 的 `RecordRevisionSource` 明确声明 `'automation' | 'public-form' | 'plugin'` 三个枚举位,**public-form 与 plugin 的发射点为 0**——原设计本就打算覆盖它们,从未落地。

**定性:这不是"缺特性",是本线核心承诺(时点重建正确性)的缺陷。** 它同时**限定了 4c-3 的可达边界**:4c-3 只能为「经 `record-service.deleteRecord` 且捕获 flag 开启期间」删除的记录重建 inbound 边。

## 3. 其余确凿残差

1. **retention 不对称 → 静默部分恢复。** `meta_records_trash` **从不被清理**(唯一的 DELETE 在 restore 成功时,`record-service.ts:1054`),而两张 tombstone 表在同一个 `MULTITABLE_META_REVISION_RETENTION_ENABLED` 旋钮下按 keep-days 老化、**无地板**。后果:一条 trash 记录永远可恢复,但其 inbound tombstone 已被清 ⇒ **restore 成功、inbound 边静默缺失、无任何信号**。(4c-3 必须解决:给 sweep 加「不清理仍被 live trash 行引用的 tombstone」地板,或在恢复面显式暴露 `inboundEdgesRecoverable=false`。)
2. **单旋钮耦合。** 开启 retention 会同时老化 4c-1 / 4c-3 恢复力所依赖的 tombstone;operator flag checklist 未列出新 flag 与该耦合。
3. **撕裂的 tombstone 集合(结构性,低可达)。** retention sweep 的内层 `SELECT id … WHERE created_at < cutoff LIMIT batch` 无 `ORDER BY`、不按 anchor 分组;同一次捕获的所有行 `created_at` 相同,理论上可被部分裁剪 ⇒ 半个捕获集。
4. **PIT resurrect 是第二个复活面**(`univer-meta.ts:9767` 附近),同样只重放 outbound。4c-3 若只改 `restoreRecord`,两个复活面语义将分叉。
5. **`meta_records_trash` 无 `delete_revision_id`**(逐列核实),而 tombstone 以 `source_revision_id` 锚定 ⇒ 4c-3 的**硬阻塞**(见 4c-3 锁 §2 的解法)。

## 4. owner 决策菜单(本文不实现任何一项)

- **D-1(推荐,纯缺陷修复):** 让 automation / plugin-SDK 的删除**发射 delete revision**(`source:'automation'` / `'plugin'`,枚举位已存在)。**只修 PIT 正确性,不改可恢复性**(不加 trash)。用户可见行为变化仅为「Global History 如实记录该删除、PIT 不再谎报记录存活」。难度中(automation 走 raw-SQL 车道)。**属跨车道改动**(automation-executor 归自动化线),需路由到该线会话或 owner 点名。
- **D-2(更大,产品决定):** 再给这两条路径补 `meta_records_trash` + tombstone 捕获 ⇒ 删除变为可恢复、并进回收站。**改变产品语义**,需 owner 签核。
- **D-3(4c-3 内解决,已在 4c-3 锁提案):** 给 PIT-reset 内联删除(路径 2)补 tombstone 捕获(它已写 trash+revision,只差 anchor 与捕获调用)。
- **D-4(文档诚实,已随本轮执行):** 4c-2 锁 §1/§8 补齐四条路径实情——**已在同批 PR 落地**,C2 口径明确限定为路径 1(+ 4c-3 后含路径 2)。
- **D-5:** retention 地板 / 恢复面 `inboundEdgesRecoverable` 信号 —— 已写入 4c-3 锁,随 4c-3 impl 落地。
- **D-6(4c-1 审阅期确证的既有 latent bug,已由 R7 #3952 修复):** **Tier-1/2 config-restore execute 的成功路径从不调用 `invalidateFieldCache`**,而 uncreate / undelete / 4c-1 lossy 三条分支都调了。`metaFieldCache`(`univer-meta.ts` 无 TTL、进程内常驻)**只被 `loadSheetFields` 消费**。**机理更正(R7 impl 期逐调用点核实,推翻本文初稿的"喂记录写路径"措辞):** 记录写路径的值 coercion 走的是**另一个未缓存的 loader `loadFieldsForSheet`(`loaders.ts`)**,`record-service` 用的正是它 —— **不受此缓存影响**。真正读陈旧缓存的消费者是 `GET /view` 的字段列表、create/duplicate 回显 mask、以及 `recalcNewRecordFormulas`。因此本缺陷是**读路径 / 公式重算的陈旧**(而非写路径值损坏),严重度低于初稿描述,但仍是真实缓存陈旧缺陷(非 4c-1 引入;4c-1 分支已自行失效)。修法 = 在 Tier-1/2 execute 成功且 `entity_type==='field'` 时补一行 `invalidateFieldCache(sheetId)`,镜像三个兄弟分支;golden mutation-proven。

**未取的默认:** 本文不替 owner 选择 D-1/D-2。在 owner 裁决前,4c-3 的锁文以「可达边界仅路径 1(+D-3 后含路径 2)」如实收窄,不虚构恢复力。

## 5. 4d 红线复核

逐文档 + 代码注释双向核验:**已删字段列值的值级恢复 = 永不承诺**,全仓无任何松动。本审计不改变该边界。
