# Multitable Global History — 4c-3 Record-Undelete Slice 2b(inbound 边重放)— DESIGN-LOCK(PROPOSED)(2026-07-08)

**状态:PROPOSED,待 owner ratify。** 起草于线级 /goal 授权下(pre-gate 工作,与 4c-1/4c-2 同法:design-lock-first)。**起草 ≠ 开工;impl 仅在 owner 单项签核后排期。**
**前置(已满足):** 4c-2 forward tombstone-capture impl 已落 main(`023385499`)——inbound 边在 `record-service.deleteRecord` 里已被捕获进 `meta_link_tombstones(reason='record_delete')`,但**明确不重放**(4c-2 把重放留给本锁)。

## 0. 一句话与可达边界(诚实收窄)

让 record undelete 在恢复行值与 outbound 边之外,**重建被同一次删除销毁的 inbound 边**(即"别的记录指向我"的那些链接)。

**可达边界(硬性,不得虚构):** 只能为**经 `record-service.deleteRecord` 且捕获 flag 开启期间**删除的记录重建 inbound 边。其余三条记录硬删路径(automation / plugin-SDK / PIT-reset 内联)当前**不产生 tombstone**,详见 `…destruction-path-coverage-gap-audit-20260708.md`。本锁**在 §7 提议把 PIT-reset 路径补进捕获**(D-3);automation / plugin-SDK 属 owner 决策(D-1/D-2),**不在本锁**。
**4d 红线不动摇:** 不恢复任何 flag 开启前销毁的边。

## 1. 现状(primary-source 已核,以 `origin/main` 为准)

| 事实 | 位置 | 后果 |
|---|---|---|
| outbound 边靠 trash 的 `data` 重放(不是靠 tombstone) | `record-service.ts` restore 路径 | 因为写路径把 link id 数组同时写进 `data[fieldId]` 与 `meta_links` |
| mirror 侧结构性跳过(`isFieldAlwaysReadOnly` ⇒ `property.mirrorOf`) | restore 的 `linkFieldIds` 过滤 | 「mirror 永不拥有 `meta_links` 行」是结构不变量,非快照卫生 |
| **`meta_links` 在 `(field_id, record_id, foreign_record_id)` 上无唯一约束** | `zzzz20260404153000_repair_meta_core_schema.ts:32-39` | outbound 重放的 `ON CONFLICT DO NOTHING` **只守随机 PK `id`**,等于没守 |
| outbound 重放之所以不会重,是因为 `record_id REFERENCES meta_records ON DELETE CASCADE` | 同上 `:35` | 记录不存在 ⇒ 其 outbound 边不可能预先存在。**inbound 重放没有这层保护** |
| **`field_id REFERENCES meta_fields(id) ON DELETE CASCADE`** | 同上 `:34` | trash 窗口内若该链接字段被删,**逐字照抄的 inbound INSERT 会抛 23503 并整单回滚** |
| `foreign_record_id` **无 FK** | 同上 `:36` | 所以四条删除路径都必须显式清 inbound 边 |
| **`meta_records_trash` 无 `delete_revision_id`** | `zzzz20260617120000_create_meta_records_trash.ts`(逐列核实) | **硬阻塞**:restore 由 trash 行驱动,却无法命名其 tombstone 的 anchor |
| tombstone 的可用索引 = `(source_revision_id, field_id)` / `(sheet_id, field_id)` / `(created_at)` | `zzzz20260708090000_create_meta_tombstone_tables.ts` | 按 `source_revision_id` 锚定既正确又走索引 |
| **`sheet_id` 在 `reason='record_delete'` 行上是陷阱** | `tombstone-capture.ts` | 它存**被删记录的 sheet**,而 `field_id`/`record_id` 属**源记录的 sheet**(常跨 sheet)。**永不按 `sheet_id` 过滤** |
| `meta_records_trash` **从不被清理**;tombstone 按 keep-days 老化且**无地板** | `record-service.ts:1054`(唯一 DELETE) / `meta-revision-retention.ts` | 老 trash 可恢复但 tombstone 已被清 ⇒ **静默部分恢复** |

**⚠️ 反模式警告(本锁存在的首要理由):** field-undelete 的 R1 链接补水(`recreateFieldFromConfig`)看似是 2b 的蓝本,**照抄即错**。它的 `field_id` 是在同一事务里刚被重建的,所以「字段存在 / 仍是 link / 非 mirror」三项它可以省;inbound 重放的 `field_id` 属于**另一张 sheet**,在 trash 窗口内可能已被删除、retype、或转为 mirror。

## 2. 锚(解除硬阻塞)

**新增 forward-only 列:`meta_records_trash.delete_revision_id text NULL`**(migration,nullable,无回填)。
- 写入点:`deleteRecord` 已在事务内**预生成** `recordDeleteRevisionId` 并用作 tombstone 的 `source_revision_id` —— 同一个 id 一并写进 trash 行。
- **NULL 语义(forward-only 的落点)**:本迁移之前的 trash 行 `delete_revision_id IS NULL` ⇒ **不做 inbound 重放**,并如实置 `inboundEdgesRecoverable=false`。绝不用 `(sheet_id, record_id, action='delete') ORDER BY created_at DESC` 之类的启发式反推——它在 delete→restore→delete 循环下会静默锚到**错误的 vintage**,更会在最后一次删除来自 PIT-reset(无捕获)时静默锚到一个**不存在捕获的 revision**。
- 查询恒为:`WHERE source_revision_id = $1 AND reason = 'record_delete'`(走 `(source_revision_id, field_id)` 索引)。**永不按 `sheet_id` 或 `foreign_record_id` 过滤。**

## 3. 重放的六道前置(全部必须,顺序即事务内顺序)

设被恢复记录 `R`,某条 tombstone 描述边 `(F, N, R)`:`F` = 源记录 `N` 所在 sheet 上的 link 字段。**重放 INSERT 前,以 JOIN/谓词逐条过滤**(不得依赖 FK 抛错,FK 会整单回滚):

1. **`R` 存活** —— 由构造保证:重放排在同事务的 `INSERT INTO meta_records` 之后。
2. **`N` 存活** —— `JOIN meta_records n ON n.id = t.record_id`。
3. **`F` 仍存在** —— `JOIN meta_fields f ON f.id = t.field_id`。**(照抄 R1 模板会漏掉这条 ⇒ 23503 整单回滚)**
4. **`F` 仍是 link 类型** —— `AND f.type = 'link'`。retype 是裸 `UPDATE meta_fields`,行与 FK 都还在,但边已成垃圾。
5. **`F` 非 mirror** —— `AND (f.property->>'mirrorOf') IS NULL`。维持「mirror 永不拥有 `meta_links` 行」的 spine 不变量(与两处 outbound 重放的 `isFieldAlwaysReadOnly` 跳过同源)。
6. **邻居仍然"认"这条边(§4 语义裁决)** —— `AND (n.data->$F) ? R.id`。

再叠加**幂等守卫**(无唯一约束,应用层是唯一防线):

7. `AND NOT EXISTS (SELECT 1 FROM meta_links ml WHERE ml.field_id=t.field_id AND ml.record_id=t.record_id AND ml.foreign_record_id=t.foreign_record_id)`

第 7 条同时消灭 **self-link 重复**:自链(`record_id = foreign_record_id`)既被 inbound 捕获、又存在于 trash `data` 里被 outbound 重放 ⇒ 无第 7 条必重。**重放必须排在 outbound 重放之后**,让 NOT EXISTS 看得见 outbound 刚插入的行。

## 4. 语义裁决:邻居同意(fail-closed,取 Option A)

trash 窗口内,邻居 `N` 可能已把 `R` 从它的链接单元格里移除(`N.data[F]` 不再含 `R`),但 tombstone 仍记着那条边。

- **Option A(本锁所取,fail-closed):** 仅当 `N.data[F]` **仍然列出** `R` 时才重放该边。
- Option B(拒绝):无条件按 tombstone 重放。

**取 A 的三个理由:**
1. **尊重用户意图**:B 会把用户在窗口内**主动切断**的链接复活。
2. **消除 `data` ↔ `meta_links` 分叉**:读路径从 `meta_links` 取值(`loadLinkValuesByRecord`),B 会让 `N` 的单元格渲染出一个 `N.data` 并不声称的 `R`。A 则是把索引修回与 `N` 自己的记录内容一致——**收敛,而非新建**。
3. **让授权问题自动消失(见 §5)。**

**代价(如实记录):** 若 `N` 在窗口内确实移除了链接,该边永久不再恢复(即便之后 `N` 又改回来也不会追溯)。若 owner 想要 B,需**单独签核**,且必须同时接受 `data`/`meta_links` 分叉与"复活已切断链接"的语义。

## 5. 授权(由 §4 化解,非新增权面)

inbound 边在语义上属于**别的 sheet(乃至别的 base)上的 `N`**;而 restore 的 actor 只针对 `R` 所在 sheet 授权。

因 §4 只重放 **`N` 自己的 `data` 已经声称**的边,重放**不创造任何新信息、不授予任何新访问**——它只是把 `meta_links` 索引修回与 `N` 的记录内容一致(该不一致恰恰是同一次删除造成的)。故:

- 重放为 **system-context 索引收敛**,标注 `// lock-exempt: record-undelete inbound edge replay — index convergence to the neighbour's own data; no new information`(rank-8 结构守卫要求;见 §8)。
- **不**额外要求 actor 对 `N` 的 sheet 有写权;**也不**因缺该写权而静默跳过(那会造成不可解释的部分恢复)。
- 反向保证:任何**未被 `N.data` 声称**的边一律不重放 ⇒ 不存在"借 restore 往别人表里写边"的路径。

## 6. retention 耦合(fail-closed)与信号

**问题:** `meta_records_trash` 永不清理(不朽),tombstone 按 keep-days 老化且无地板 ⇒ 老记录 restore 成功、inbound 边静默消失。

**锁定两条:**
1. **sweep 地板**:tombstone 清理**不得删除** `source_revision_id` 仍被**存活 trash 行**引用的行(`reason='record_delete'` 行按 `delete_revision_id` 反查)。
2. **诚实信号**:trash 列表 / restore preview 暴露 `inboundEdgesRecoverable: boolean`(`delete_revision_id IS NULL` 或对应 tombstone 已不存在 ⇒ `false`),镜像 config-restore 的 `tombstoneAvailable` 先例(omitted-when-false,保形)。restore 结果亦返回实际重放条数。

**顺带修 4c-2 的撕裂集合(结构性):** 现 sweep 内层 `SELECT id … WHERE created_at < cutoff LIMIT batch` **无 `ORDER BY`、不按 anchor 分组**;同一次捕获的行 `created_at` 相同,可被部分裁剪成半个集合。改为**按 anchor(`source_revision_id`)整组裁剪**。

## 7. 捕获面补强(D-3,含在本锁)

`univer-meta.ts:10066` 的 **PIT-reset 内联删除**已写 trash + delete revision,但**不捕获 tombstone**(其 `recordRecordRevision` 未预生成 id,无 anchor 可挂)。本锁把它补齐:预生成 revision id → 写入 trash 的 `delete_revision_id` → 同事务 `assertWithinCaptureCap` + `insertInboundLinkTombstones`。受同一 `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` 与 cap 治理(超 cap ⇒ 拒绝该次 reset,fail-closed)。

**第二个复活面:** PIT resurrect(`univer-meta.ts:9767` 附近)由 revision 快照驱动、同样只重放 outbound。**本锁要求它复用同一个重放函数**——否则将并存两个 inbound 语义分叉的复活面。若 impl 期证明代价过大,允许拆为 4c-3b,但**必须在文档里显式记录分叉**,不得静默。

## 8. 不变量(C1–C8)

- **C1 forward-only**:`delete_revision_id IS NULL` 或 tombstone 不存在 ⇒ 走今日行为(仅 outbound),`inboundEdgesRecoverable=false`,**绝不虚构**。
- **C2 六道前置全满足才重放**(§3);任一不满足 ⇒ 静默跳过**该条边**(非整单失败),但计入返回的跳过原因计数。
- **C3 幂等**:NOT EXISTS 守卫;重放排在 outbound 之后;self-link 不重复。
- **C4 原子性 + 并发**:trash 行读取与重放**全部在同一事务内**,trash 行 `SELECT … FOR UPDATE`(今日 restore 在事务外读 trash,靠 PK 23505 兜底——本锁收紧)。
- **C5 无新权面**:见 §5;不写任何 `N.data` 未声称的边;不改 `N` 的 `data`;**不为 `N` 写 revision**(其 `data` 未变)。
- **C6 retention 地板 + 诚实信号**(§6)。
- **C7 flag 默认 off**:新增 `MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND`(默认 off);且无 `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` 就根本没有 tombstone。off ⇒ 今日行为逐字节不变。
- **C8 写对称**:重放条数 ≤ 捕获条数 ≤ 捕获 cap(捕获时已 fail-closed 拦过);rank-8 lock disposition 按 §5 标注。

## 9. Golden 矩阵(RB1–RB12,fail-first,realdb)

| # | 场景 | 断言 |
|---|---|---|
| RB1 | flag-off(任一 flag) | 行为与今日逐字节一致,零 inbound 重放 |
| RB2 | happy:跨 sheet inbound 边 | 删→restore 后边回来;`N` 的单元格重新渲染出 `R`(**必须跨 sheet,补 4c-2 的未测形状**) |
| RB3 | `delete_revision_id IS NULL`(老 trash) | 仅 outbound;`inboundEdgesRecoverable=false`;无虚构 |
| RB4 | 链接字段在窗口内**被删除** | 不抛 23503、不回滚;该边跳过;其余边正常;记录恢复成功 |
| RB5 | 链接字段在窗口内**retype 走** | `f.type<>'link'` ⇒ 跳过该边 |
| RB6 | 链接字段在窗口内**转 mirror** | 跳过(spine 不变量:mirror 不拥有边) |
| RB7 | 邻居在窗口内**移除了链接**(`N.data[F]` 不含 `R`) | **不重放**(Option A);无 `data`/`meta_links` 分叉 |
| RB8 | self-link | 恰好一条边(outbound 重放 + inbound 捕获不重复) |
| RB9 | delete→restore→delete→restore 循环 | 每次只锚到**本轮**的 tombstone(`source_revision_id` 精确),不串 vintage |
| RB10 | retention 地板 | 存活 trash 行引用的 tombstone 不被 sweep 清;整组裁剪(不撕裂) |
| RB11 | 并发两个 restore | trash 行 `FOR UPDATE` ⇒ 一个成功一个 409,无重复边、无半态 |
| RB12 | **mutation** | neuter 每道前置(字段存在 / type=link / non-mirror / 邻居同意 / NOT EXISTS)→ 恰好对应 golden 变红;neuter 地板 → RB10 红 |

## 10. 实施排布(ratify 后才排)

Sonnet 车道(隔离 worktree)+ Opus 对抗审(mutation 证据必交)。commit 切分:migration(anchor 列)→ 重放 helper + 六道前置 → restore/PIT-resurrect 接线 → PIT-reset 捕获点(§7)→ retention 地板 + 撕裂修复 → RB1-RB12。**flag 全程默认 off;production 启用属独立 O-2 operator 阶梯,不在本锁。**

## 11. 出界(记录在案)

automation / plugin-SDK 删除路径的 trash+revision+capture 对等(= gap-audit 的 D-1/D-2,owner 决策)、跨 base 授权模型扩展、rollup/RELSUMIF 的重放后重算(删除侧本就不重算,重放不重算是**精确对称**;若窗口内有过重算则其持久值已"正确地不含 `R`",本锁记录该有界陈旧窗口而不扩张范围)、Yjs/realtime 对**邻居 sheet** 的失效广播(未调研,impl 期须确认;若需要则单独一条)、hierarchy 自引用字段重放可能重新引入写路径会拒绝的环(impl 期须 grep `hierarchy-cycle-guard`)、4d(永不承诺)。

**解锁词示例:「ratify 4c-3」(可附修改意见;若要 Option B 的邻居语义,请显式写明)。**
