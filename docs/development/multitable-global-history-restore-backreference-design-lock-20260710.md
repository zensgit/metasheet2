# Global History — restore 批次回链（restored-from back-reference）— MINI DESIGN LOCK (RATIFIED · AS-BUILT R11)

- **Status**: **RATIFIED 2026-07-11（owner R11 directive: 「实现 restore 回链，OD-0 选 (a) 三路全穿线」）。AS-BUILT**：迁移 `zzzz20260711000000_add_meta_record_revisions_restored_from_version`（Kysely TS，非数字前缀 SQL——见 §2.1 排序注）加 `meta_record_revisions.restored_from_version`（int nullable, forward-only, 无回填）；`restoredFromVersion` 经 `RecordWriteService.patchRecords` → `recordRecordRevision` 单一 seam 穿三条 version-restore 路由（legacy `/restore`、`/restore-execute`、`/restore-batch-execute` 的两处 patchRecords）；投影 `HistoryChange.restoredFromVersion` + FE 「从版本 N 恢复」徽标（仅非 NULL 渲染）。**OD-0=(a)（三路全穿线）· OD-1=版本号 · OD-2=上线即显（只读元数据，无 flag）。**
- **关键契约（审阅 Q2 补入）**：`restored_from_version` 非 NULL **当且仅当** 该写入是携带 `targetVersion` 的 record-version restore（= 上述三路）。其余所有 `source='restore'` 发射点均为 **NULL by design**（见 §2.6），FE 徽标**键于非 NULL，绝不键于 `source='restore'`**——否则会制造 #4074 那类「两类语义不一致」的残迹。
- **部署窗口（txn-safe）**：`recordRecordRevision` 在 `patchRecords` 事务内运行，42703 会毒化事务（try/catch 回退会二次失败）——故用**列存在性 SELECT 探测**（information_schema，只缓存 present 正结果）择 INSERT 形状，而非 catch。投影读侧走非事务 pool query，try/catch 回退安全。二者均在预迁移窗口降级为 base 形状（值静默 NULL），永不失败写入/500 读取。手动核验通过（round MD §Lane3 记录；共享 realdb bundle 的 module 级缓存不可复位，故不加会 order-flaky 的改 schema CI 测试）。
- **难度/分派建议**：中（一列迁移 + 三路穿线 + 投影面 + FE 渲染）→ 本轮 Opus 实现 + 对抗审（Fable 不可用）。

## §1 问题（R9 审计原始证据，已对 origin/main 核验）

`source='restore'` 的批次在 History Center 里无法回答「它恢复了什么」：
- `meta_record_revisions` 无承载列（创建迁移 + batch_id 迁移均无此概念）；
- record-restore-execute（univer-meta.ts ~:9596）与 restore-batch-execute（~:9736）调用 `patchRecords({ source: 'restore' })` 时从不把 `targetVersion`（被恢复的源版本）写入新 revision；
- 对照面：config 侧早有 `restoredFromId`（config-revision-recorder.ts ~:33）——记录数据侧缺同款。

## §2 设计（锁定项）

1. **新列** `meta_record_revisions.restored_from_version`（int，nullable，forward-only 迁移；legacy 行恒 NULL——不回填，不启发式）。**迁移排序（审阅后 CI 修）**：`meta_record_revisions` 表由 **Kysely TS 迁移** `zzzz20260430172000_create_meta_record_revisions` 创建，该 `zzzz` 前缀在合并排序里**晚于所有 `0xx` 数字前缀 SQL 迁移**。故本列**必须**用 `zzzz` 时间戳 TS 迁移（与 `zzzz20260619120000_add_meta_record_revisions_batch_id` 同型），**不可**用数字前缀 `067_*.sql`——后者会在**表创建之前**运行、其 `to_regclass` 守卫见不到表而静默 no-op（"executed successfully" 但列从未加），from-scratch migrate（CI test(20.x) realdb）遂全红。教训见 round MD。
2. **写路径穿线**：restore 语义写路径**共三条**（owner P2 更正——见 §2.5 的处置决策 OD-0），全部或按 OD-0 处置后剩余的路径在生成新 revision 时携带 targetVersion；非 restore 写入点不触碰（列缺省 NULL）。字段级子集恢复（fieldIds）同样携带——回链语义 = 「本次 restore 以版本 N 为源」。
3. **投影面**：`HistoryChange` / `HistoryBatchDetail` 增加可选 `restoredFromVersion`；LOCK-3 口径：版本号与 `changedFieldIds` 同级=元数据，不含字段值，无掩码增量，但仍走既有投影管道（不得旁路）。
4. **FE**：`HistoryBatchChangesList` 对 `source='restore'` 的变更行渲染「从版本 N 恢复」（typed label，i18n strict-zero 走 meta-record-labels 既有模式）；无版本可回链（NULL）时不渲染该徽标。
5. **§2.5 决策记录（legacy `/restore` 路由处置）✅ RESOLVED = (a)——见段末 AS-BUILT；下为决策留痕**（owner P2 更正，取代本文初版的「永久 NULL 出界」处置）：`POST …/records/:recordId/restore`（univer-meta.ts ~:9362）是**仍存活的第三条 restore 写路径**——持有 targetVersion（:9369）、写 `source='restore'`（:9561），client 方法 `restoreRecordVersion`（client.ts ~:2232）与集成测试（multitable-record-restore.test.ts / multitable-record-recycle-bin.test.ts）俱在；「当前 FE 无调用方」是事实但不构成永久写 NULL 的依据——那会制造两类语义不一致的 restore 历史（同为 `source='restore'`，一类可回链一类不可）。**OD-0 二选一**：
   - **(a) 三路全穿线**：legacy 路由同样携带 targetVersion——G1 扩展覆盖它；
   - **(b) 正式废弃 legacy 路由**：独立 deprecation rung（路由移除或 410 + client 方法删除 + 两个集成测试迁移/删除），本锁只穿线两条 preview→execute 路径。
   任一选择下,「NULL 意图 golden」不复存在。其余出界项不变：跨批次深链跳转（源版本≠源批次 id）；PIT 族回链（revert/reset 已有各自的 preview-identity 语义）。
   **AS-BUILT 决策 = (a)**：legacy `/restore` 的 patchRecords（univer-meta.ts:9549）同样携带 `restoredFromVersion: targetVersion`；G1 端到端覆盖它（realdb HTTP）。未废弃 legacy 路由（更兼容、无行为变更）。

6. **§2.6 `source='restore'` 全发射点分类（审阅 Q2 补入，AS-BUILT 核验）**：`recordRecordRevision` 是唯一 revision 写原语；穿线只发生在 `patchRecords` seam（三条 version-restore 路由）。其余 `source='restore'` 直接调用 `recordRecordRevision` 且**不传** `restoredFromVersion` ⇒ 恒 NULL：
   - **PIT-resurrect / undelete**（univer-meta.ts:10164，`action='create' version=1`）——T-快照复活，无源版本 ⇒ NULL；
   - **PIT-reset 存活项**（~:10380，`action='update'`）——按时间重置，无 per-record 源版本 ⇒ NULL；
   - **PIT-reset after-T 删除**（~:10462，`action='delete'`）⇒ NULL；
   - **lossy-retype-revert**（~:6442，`action='update'`）——回滚字段类型，无 record 版本 ⇒ NULL。
   规则：`restored_from_version` 非 NULL ⟺ 携带 `targetVersion` 的 version-restore（= 三路）。**FE 徽标键于非 NULL**，故上述 NULL 项不渲染徽标（无「两类不一致」残迹）。

## §3 Goldens（实现 PR 必带，mutation-verified）

- **三路 end-to-end 覆盖（审阅 P2-1 补齐 · mutation-verified per-site）**：三条 version-restore 路由**各有**一条 HTTP 端到端 golden 断言新 revision 行携带 `restored_from_version = targetVersion`——
  - **G1** legacy `/restore`（路由1，OD-0=(a) 穿线）；
  - **G1b** `recordRecordRevision` 写原语（三路共享的 seam）：`restoredFromVersion=N ⇒ column=N`；
  - **G1c** `restore-execute`（路由2，**FE 实际调用**）preview→execute（穿线点 :9704）；
  - **G1d** `restore-batch-execute` all-or-nothing（路由3a，**FE 实际调用**）preview→execute（:9856）；
  - **G1e** `restore-batch-execute` per-record/PARTIAL（路由3b，**FE 实际调用**）preview→execute（:9884）。
  legacy 无 live FE 调用方，故两条 live 路由**必须**各带自己的 e2e golden（否则其穿线可被静默删除而全绿——审阅实证）。
- G2（AS-BUILT）非 version-restore 写恒 NULL：`recordRecordRevision` 直接调用——① 普通 update（`source='rest'`）② **PIT-resurrect 形状**（`source='restore' action='create'`，无 restoredFromVersion）③ **PIT-reset 形状**（`source='restore' action='delete'`）——三者 `restored_from_version` 均 NULL。**这钉住「badge 键于非 NULL 而非 source='restore'」的核心契约**（§2.6）。
- G3 投影携带：批次详情 payload 含 `restoredFromVersion`，且掩码路径不变（LOCK-3 邻测不红）。
- G4 FE 渲染 + NULL 不渲染；两侧 shape-lock wire 测试同步（wire 形状变更=两侧全扫，家规）。
- G5 突变（per-site，实证）：neuter :9704 ⇒ **仅 G1c 红**；neuter :9856 ⇒ **仅 G1d 红**；neuter :9884 ⇒ **仅 G1e 红**；neuter legacy :9562 ⇒ G1+G3 红；投影漏字段 ⇒ G3 红。每条 golden 精确命中其自身路由的穿线点，无交叉覆盖。

## §4 Owner 决策点

- **OD-0 ✅ RESOLVED = (a)**（owner R11 directive）：三路全穿线（legacy 未废弃）。见 §2.5 AS-BUILT。
- **OD-1 ✅ RESOLVED = 版本号**：`restored_from_version` = restore 请求的 `targetVersion`，无需反查 revision id。
- **OD-2 ✅ RESOLVED = 上线即显**：只读元数据，无 flag（AS-BUILT：徽标随投影下发，键于非 NULL）。
