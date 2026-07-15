# W0 C2 — Time-Monotonicity / PIT Time-Anchor — DESIGN LOCK （PROPOSED — owner-gated; C2→C3→C6 之首）

- **Status（2026-07-15）**: **PROPOSED — NOT ratified.** owner 在 W0-1 §6.6（`multitable-global-history-w0-1-history-incomplete-contiguity-trusted-since-design-lock-20260713.md`）明确把 **C2/C3/C6 继续 deferred，执行顺序 C2 → C3 → C6（owner 定序）**。本锁只起草 **C2（时间单调性 / PIT 时间锚）** 的机制供 owner 裁决；**零运行时改动，docs-only**。破坏性恢复路径 + schema/行为变更 ⇒ 按 owner 一贯纪律（D-1c / D-2 / 4c-* / R13-C / W0 首刀）**design-lock first，ratify 后才动**。
- **Provenance**: 全部锚定 `origin/main`（本 worktree 基点 `b5ca08b1b`）。首刀 W0-1 已 SHIPPED（#4269 = `3356a7ed6`）；本锁的缺陷来源与残余 = 首刀 comparator 自带的 C2 docket（`history-integrity-precheck.ts:43-48` 与 `:129-149` 的两条 in-code residue）+ #4252 correctness 条件 C2（`multitable-timemachine-w0-verification-and-w0-1-correctness-conditions-20260713.md` §3 C2 / §6.2）。
- **Scope 边界**: 本锁**只**设计 C2。**不**设计 C3（deleted/tombstoned 多代链枚举）、**不**设计 C6（durable trusted-since 水位 + 滚动上线协议）——两者各自 deferred，本锁只在 §2 / §5 声明 C2↔C6 的**接口**，不越界。C4（fence）/ C5（exact-set）/ C7（marker 词汇）/ C8（same-txn）已随 W0-1 首刀落地或已 docket，非本锁范围。

---

## §0 问题，精确陈述

### §0.1 根因：`created_at` = 事务 START 时间

`meta_record_revisions.created_at`（`zzzz20260430172000_create_meta_record_revisions.ts:18`）与 `meta_record_version_markers.created_at`（`zzzz20260713150000_create_meta_record_version_markers.ts:39`）都是 `timestamptz NOT NULL DEFAULT now()`。写路径（`record-history-service.ts:112` / `:225` / `:271`）**从不显式传 `created_at`**——一律落 DB 默认 `now()`。

在 PostgreSQL 中 `now()` ≡ `transaction_timestamp()` ≡ `CURRENT_TIMESTAMP` = **当前事务 START 的时刻**，在整个事务生命周期内**固定不变**，与 INSERT 语句实际执行的时刻、与事务 COMMIT（对其它事务可见）的时刻**无关**。

因此：**两个并发事务可以按其 START 时间的相反顺序 COMMIT**——START 早的后提交，START 晚的先提交。而 `created_at` 记的是 START，历史真相（谁先成为已提交的最新状态）取决于 COMMIT。**`created_at` 不是 commit-order-faithful 的排序键。**

这个键被两处**载重**使用：
1. **reconstructRecordsAtT**（`record-reconstructor.ts:34-56`）：`WHERE created_at <= $T ... ORDER BY record_id, created_at DESC, version DESC, id DESC`，`DISTINCT ON (record_id)` 取每记录「≤T 的最新 revision」。`created_at` 既是**过滤**（哪些事件 ≤T）又是**主排序**（其中哪个最新）。
2. **generation-aware contiguity comparator**（`history-integrity-precheck.ts:152-158` `chainOrderAfter`）：`orderKey = created_at epoch-ms` 是排序**主腿**（version 次之、delete-last 末），代际边界（`:199-204` 「最后一个 delete」）纯由此腿画出。

### §0.2 失败形态 A —— 单记录 version↑/time↓ 反转 ⇒ reconstruction 选错快照（**fail-OPEN**）

单记录内，`version` 在行锁下 CAS 递增，故 version 顺序 == 该记录的 commit / 序列化顺序。但 `created_at` 是 txn-start，可与 version **反转**。构造（两连接，记录 R 现处 v3）：

| 时刻 | Tx_A（START=100） | Tx_B（START=150） |
|---|---|---|
| 100 | BEGIN（`now()`=100），做无关工作 | — |
| 150 | — | BEGIN（`now()`=150） |
| 155 | — | 写 R：行锁，v3→**v4**，rev v4 `created_at=150` |
| 160 | — | **COMMIT** |
| 180 | 写 R：行锁（B 已释放），v4→**v5**，rev v5 `created_at=100` | — |
| 190 | **COMMIT** | — |

R 的链：`v4 @ created_at=150 (commit 160)`、`v5 @ created_at=100 (commit 190)`。**version 升序 4→5，created_at 降序 150→100。**

reconstruct 到用户挑的 wall-clock T：
- **T=120**：`created_at<=120` 只命中 v5（100≤120；150>120 被排除）⇒ 返回 **v5**。但 v5 的写在 t=190 才提交——real-time 120 记录还是 v3。**返回了未来态，且跳过了 v4**。fail-OPEN，无 refusal。
- **T=155**：两者都命中（100≤155、150≤155）⇒ `ORDER BY created_at DESC` 取 **v4**（150>100）。但 real-time 155 时 v4 尚未提交（commit 160），记录仍是 v3。返回 v4，既非 155 的真实态、又与链内在不一致（v5 存在却被排在 v4 之后）。fail-OPEN。

**关键**：contiguity 预检**不**拦此形态——链 `{v4,v5}` 连续（每 version 恰一 occupant），`HISTORY_INCOMPLETE` 通过。**「即便一条完全连续的 v1/v2/v3 链，也能对某个 T 选错快照」**（#4252 C2 原话）。这是 C2 与 C1 的分界：**contiguity 证「链完整」，不证「时间-T 选对」。**

### §0.3 失败形态 B —— cross-ms 代际边界错画 ⇒ 掩盖真实同-version 洞（**fail-OPEN，首刀已 docket 的 residue**）

`chainOrderAfter` 的 `orderKey` epoch 腿非 commit-monotonic，而**代际边界（最后一个 delete）纯由此腿计算**（`:199-204`）。当某 create/update 事件的 txn-start epoch 因反转而**晚于**其本代的 delete，它会被 `inCurrentGen`（`:204`）判进/判出错误的代，事件在代际间**漂移**：既可能把当前代的一个真实同-version 洞**掩盖**（fail-OPEN），也可能把健康链**误拆**。

**Canonical instance（首刀 in-code residue，逐字锚定 `history-integrity-precheck.ts:144-149`）**：

> *Known fail-closed residue (C2 docket, NOT solved here): a restore/resurrect create@v1 landing in the SAME millisecond as the delete it follows is version-below the delete and thus sorts before it — the row refuses (`live_row_after_delete_revision`), it is never mis-reconstructed. The packed-float ordering refused that shape too … so this is no regression; disambiguating same-ms cross-generation order needs the C2 time anchor.*

- **Residue 1（fail-CLOSED）**：同一毫秒的 restore/resurrect `create@v1` 因 version 低于其前驱 `delete` ⇒ 排到 delete **之前** ⇒ 当前代为空 ⇒ `live_row_after_delete_revision` **拒**。安全但**误拒**一个合法的同-ms resurrect。
- **Residue 2（fail-OPEN，cross-ms）**：一个 `created_at`（= txn-start）**晚于**其本代 delete 的事件，可落入**错误的代**并**掩盖**一个真实的同-version 洞（本该 `chain_hole` 拒，却因边界错画而漏）。**#4269 round-4 gate 已实证 pre-fix 编码接受同款形状——pre-existing，非回归**（comparator docstring `:134-136` 记的正是这条 float-collapse 的历史）。

两条 residue 的**共同根因都是 §0.1**：`orderKey` epoch 腿不是 commit-order-faithful，故同-ms / cross-ms 的代际序无法被正确线性化。

### §0.4 两处载重、一个根因

| 面 | 载重键 | 症状 | 方向 |
|---|---|---|---|
| reconstructRecordsAtT `:54` | `created_at` 过滤 + 主排序 | 选错 T-快照（形态 A） | **fail-OPEN** |
| chainOrderAfter `:152` | `orderKey`=`created_at` epoch 腿 | 代际边界错画、掩盖洞（形态 B / residue 2） | **fail-OPEN** |
| 同上，同-ms | 同上 | 误拒合法 resurrect（residue 1） | fail-CLOSED |

**C2 的任务 = 用一个 commit-order-faithful 的排序键，替换这两处的 `created_at` 载重腿。** 只替一处 = 不闭（另一处仍错序）。见 §3。

---

## §1 候选机制分析

评估维度（每候选一致）：**(i) 正确性保证**、**(ii) 迁移/回填现存 revision 的故事（forward-only，禁编造时间戳——owner OD-5 doctrine）**、**(iii) deploy-window 行为（滚动上线）**、**(iv) blast radius on reconstructRecordsAtT / contiguity / History UI 排序**。

### §1.a 行锁内赋值的单调序列列 `chain_seq BIGINT`（per-record / per-sheet）

**机制**：给每个链事件（create/update/delete revision **以及** lock/unlock marker）赋一个 `chain_seq BIGINT`，**在与 version bump 同一个序列化临界区内**读取并递增（即行锁 / 该写已持有的锁内）。与 version 不同，`chain_seq` **对每个事件都递增、绝不复用**（delete 不复用、跨代不重置）。

**(i) 正确性**：**STRONG（唯一给出持久、commit-order-faithful 全序的候选）**。因为 seq 在**序列化该记录所有写的行锁内**赋值，「较晚获得行锁」⟺「另一写已提交」（互斥强制），故 **seq 大 ⟺ commit 晚**，对该记录的事件是与 commit 顺序一致的全序——跨 delete-reuse、跨代、含 marker 都成立。它同时可替换 `chainOrderAfter` 的 epoch 腿**和** reconstruction 的 `created_at DESC`，把新键**在两处都载重**（§3 硬要求）。
- ⚠️ **counter 源的子设计**（非平凡，见 OD-C2-2）：per-record 计数器若存于 `meta_records`，记录被删→重建（resurrect）时会**重置**⇒ 同代 collapse。故源必须**跨记录删除存活**：要么 **per-sheet 单调计数器/序列（在写的序列化点内递增）**（存活、单一真源；代价=每 sheet 一热行/热锁，高频写 sheet 有争用），要么 **per-record `max(seq)+1`**（在写已持有的锁内读；resurrect 路径以既有 per-sheet advisory fence `PIT_RECOVERY_LOCK_NS` 为 backstop）。⚠️ **裸 `nextval()` 序列不合格**——nextval 按调用序返回，早调用晚提交的事务仍拿低值早序 ⇒ **与 txn-start 同款反转**。单调-with-commit 的性质**只**来自「在序列化临界区内赋值」，不来自序列本身。
**(ii) 迁移/回填**：**forward-only，零编造**。加 `chain_seq BIGINT`（**nullable，无 default 回填**——加常量 default = 伪造一个不存在的 commit 序，违反 OD-5）。现存行 `chain_seq = NULL`，其相对序保持 best-effort `(created_at, version)`。新事件起 seq 递增。列 ADD（nullable、无 default）在 PG 是**瞬时**（无表重写）。**这正是 C2↔C6 的接缝**：NULL = pre-anchor（best-effort，带已知 residue）；非 NULL = anchored（commit-faithful）。C6 后续把这个边界固化为 durable 水位并处理滚动上线。
**(iii) deploy-window**：**复用仓内已验证模式**（`hasRestoredFromVersionColumn` / `hasVersionMarkerTable` 的 txn-safe information_schema 探针 + nullable-column 优雅降级，`record-history-service.ts:245-259`）。滚动期旧实例继续写 `chain_seq=NULL` 的行，与新实例的非 NULL 行交错——读侧排序须定义（非 NULL 按 seq；NULL 回退 created_at）。**跨 regime 边界旧实例仍写 = C6 的两阶段上线职责**，本锁只声明接口、不设计（§2/§5）。
**(iv) blast radius**：reconstruction `ORDER BY` 由 `created_at DESC, version DESC, id DESC` → 以 `chain_seq` 为主（NULL 回退）；**过滤腿是更难的一半**（见 OD-C2-3 —— T 仍是 wall-clock 时，`chain_seq` 只能 tiebreak，过滤仍走 `created_at<=T` ⇒ 反转被重新引入；真正闭合需把 PIT 锚改为 event-ordinal，见 §2）。comparator `orderKey := chain_seq`。History 列表排序（`record-history-service.ts:300` `ORDER BY version DESC, created_at DESC`）需一并对齐（OD-C2-4）。marker 表已可承载该列（新增 nullable 列 + `recordVersionMarker` 赋值）。

### §1.b 提交序 LSN 捕获（`pg_current_wal_lsn()` at insert）

**机制**：INSERT 时捕获 `pg_current_wal_lsn()` 存列，作排序键。
**(i) 正确性**：**不合格——非 commit-order-faithful**。诚实分析可见语义：`pg_current_wal_lsn()` 返回**当前已写 WAL 位置**，但一行的**提交记录**在 COMMIT 时才获得**更晚**的 LSN，而 commit 顺序由**提交记录 LSN**决定，非 insert 时 LSN。两事务可按 insert-LSN 一序、按 commit-LSN 另序。且 in-progress 事务 insert 的 WAL 已写但捕获的 LSN 不反映最终提交位置。真正 commit-faithful 的是**提交 LSN**，而它在 insert 时**不可知**（COMMIT 才赋）。⇒ insert-LSN 更接近「写序」，仍可与 commit 序背离——**narrows，不 close**，且语义不透明、难以对普通开发者解释。**弃。**
**(ii)-(iv)**：（因 (i) 已弃，不展开）迁移同样 forward-only-nullable；blast radius 与 (a) 相当但收益更差、可读性更低。

### §1.c `clock_timestamp()` 取代 txn-start `now()`

**机制**：revision INSERT 的 `created_at` 改用 `clock_timestamp()`（语句实际执行时刻，事务内推进），而非 `now()`（txn-start）。
**(i) 正确性**：**narrows，不 close（诚实）**。反转源于 txn-start 与提交的巨大背离；`clock_timestamp()` 把时间戳拉到**接近 INSERT 时刻**。若 revision INSERT **在行锁临界区内**执行，则同一记录的 `clock_timestamp()` 就在行锁获取序内 ⇒ 与 version / commit 序**单调**——形态 A 的同记录反转被消除。**但仍不闭**：(1) 跨**不同记录**（无共享锁）无保证；(2) 仍是 wall-clock —— NTP 校准 / 回拨 / 闰秒下**非单调**（参考 [[feedback_asserted_invariant_is_a_bug]]：时间码只信 epoch 算术，wall-clock 单调是假不变量）；(3) 不产生 comparator tiebreak 用的稳定整数键。
**(ii) 迁移**：现存行的 `created_at` 已是 txn-start，**不可回改**（禁编造）；只能新写用 clock_timestamp——⇒ 混排（老 txn-start 行 + 新 clock 行）本身制造一个跨 regime 的排序不一致，与 (a) 的 NULL 边界一样需要 trusted-since 界。收益却更弱。
**(iii) deploy-window**：改的是 DB 默认表达式 + 写路径，滚动期新旧实例混写两种时间语义——同样需边界。
**(iv) blast radius**：最小（换一个 default 表达式 + 保证 INSERT 在锁内）——**作为廉价 stopgap 有价值**，但不能作为 primary（不闭跨记录 + wall-clock 非单调 + 无整数键）。可作 (a) 未落地前的过渡缓解（OD-C2-1）。

### §1.d 事务提交时间跟踪（`track_commit_timestamp` + `pg_xact_commit_timestamp(xmin)`）

**机制**：开 `track_commit_timestamp=on`，存 `xmin`，日后经 `pg_xact_commit_timestamp(xmin)` 解析**真实提交时间**排序。
**(i) 正确性**：**真 commit-order-faithful**（提交时间在 COMMIT 时赋）——理论最准。
**(ii) 迁移/durability**：**致命缺陷**——提交时间戳**只在 xid 未被 freeze/wraparound-vacuum 前可查**；freeze 后 `pg_xact_commit_timestamp` 返 NULL。Time-Machine 要重建**任意久远**的 T，数月后历史行的提交时间戳**已消失**⇒ 不能作**持久**排序键，除非在 commit 时/后把提交时间**拷进行**（app 层无 commit hook，需 deferred trigger / 两步，复杂）。`xmin` 亦随 wraparound，裸存不持久。
**(iii) deploy-window / 部署蕴含**：**cluster 级 GUC + 需 restart**。metasheet2 自托管 docker（`23.254.236.11`，CI 部署）可行但引入 **ops 依赖 + 一次重启窗口**；managed PG 上须显式开启。
**(iv) blast radius**：读侧要 JOIN commit-timestamp（且要处理已 freeze 的 NULL 回退）——不确定性高。
⇒ **最 commit-faithful 但非持久 + GUC/restart/ops 负担 + freeze 后失效**。**弃为 primary**，仅记为「若某日需要跨节点实时提交序、且能接受在 commit 后落库拷贝，可复议」。

### §1 小结（对照表）

| 候选 | commit-order-faithful？ | 持久（久远 T 可重建）？ | 禁编造回填？ | 部署蕴含 | 判定 |
|---|---|---|---|---|---|
| **(a) chain_seq（锁内赋值）** | **是（同记录/跨代，锁内）** | **是（整数列，永存）** | **是（现存行 NULL，不伪造）** | 列 ADD（瞬时）+ 写路径 | **✅ PRIMARY** |
| (b) insert-LSN | 否（insert-LSN ≠ commit-LSN） | 是 | 是 | 列 ADD | ✖ narrows-not-close |
| (c) clock_timestamp | 部分（同记录锁内；跨记录否） | 是 | 现存行不可回改 | 换 default 表达式 | ◐ 仅 stopgap |
| (d) commit-timestamp | **是** | **否（freeze 后失效）** | 是 | **cluster GUC + restart + ops** | ✖ 非持久 |

---

## §2 建议（primary + 为何其余落选）

**PRIMARY = §1.a：per-record 单调 `chain_seq BIGINT`，在写的序列化临界区（行锁）内对每个链事件（含 delete 与 lock/unlock marker）赋值、绝不复用/重置；此键在 reconstructRecordsAtT 与 contiguity comparator 两处同时载重（§3）。**

**为何 (a) 胜**：它是唯一同时满足〔commit-order-faithful〕+〔持久（整数列，久远 T 仍可用）〕+〔零编造回填（现存行 NULL，best-effort 保序）〕+〔无 GUC/无 restart，仅一次瞬时列 ADD + 写路径接线〕的候选，且**直接复用仓内已验证的 deploy-window 模式**（nullable 列 + txn-safe 探针 + 优雅降级）。

**为何其余落选（一句话）**：
- **(b) insert-LSN**：insert 时 LSN ≠ 提交 LSN，非 commit 序。
- **(c) clock_timestamp**：仍是 wall-clock（NTP 非单调、无整数 tiebreak、跨记录不闭）——只配当 (a) 落地前的过渡缓解。
- **(d) commit-timestamp**：真准但 freeze 后**失效** + cluster GUC + 需 restart——对「重建任意久远 T」的历史特性是持久性硬伤。

**T-锚的关键演进（与已上线现实咬合）**：`chain_seq` 干净替换**排序**腿；但 reconstruction 的**过滤**腿若仍是 wall-clock `created_at<=T`，反转会被重新引入（§1.a-iv）。**已上线的 history-anchored picker（#3749，`ResetToPointPicker.vue`，`mode` 默认 `'history'`，见 `multitable-global-history-t-source-history-anchored-direction-20260707.md`）已让用户挑一个真实存在过的 History **batch**（离散事件），而非自由 wall-clock**——该方向文档 §3 已自陈残余：「同一毫秒存在兄弟批次时，锚定其一会把并列批次一并含入」，**这正是 C2 在 batch 层的同款 residue**。故 C2 最干净的表达 = 把 PIT 锚从「batch 的 `created_at`」升级为「batch/事件的 `chain_seq`」，过滤腿改 `chain_seq <= anchorSeq`：**既彻底闭合过滤反转，又消灭同-ms 兄弟批次误含，且 FE 近零改动**（picker 已选离散 batch，只是改传下去的锚字段）。此为 §5 最大的 owner 决策点（OD-C2-3）。

**C2↔C6 接缝（只声明接口，不在此设计 C6）**：现存行 `chain_seq=NULL` = pre-anchor，保 best-effort `(created_at, version)` 序（带已知 residue）；非 NULL = anchored regime，commit-faithful。**trusted-since 边界 = anchored regime 的起点**（「非 NULL chain_seq」即最小可用界；C6 后续把它固化为 **durable 水位** 并处理**滚动上线时旧实例跨 regime 边界仍在写**的两阶段协议 + 水位须存活记录删除）。**owner 定序 C2→C3→C6**：本锁在 C6 之前落地，故 C2 自身对 **pre-anchor T** 的处置须保守（refuse 或 best-effort-且标记；OD-C2-5），最终由 C6 定。

---

## §3 C2 关闭什么 / 留下什么

### §3.1 必须两处同时载重，否则不闭（硬要求）

**关闭形态 B 的 fail-OPEN 掩盖，当且仅当新序键 `chain_seq` 在下列两处都载重**：
1. **contiguity comparator**（`chainOrderAfter` 的 `orderKey` 由 epoch-ms 换成 `chain_seq`）——代际边界改由 commit-faithful 键画出，形态 B 的漂移消失；
2. **reconstructRecordsAtT 的 T-选择**（排序腿换 `chain_seq`；**且过滤腿按 OD-C2-3 决定是否亦换 `chain_seq<=anchorSeq`**）。

**只替一处 = 不闭**：若只换 comparator，reconstruction 仍按 `created_at` 选错快照（形态 A 仍在）；若只换 reconstruction，comparator 仍错画代际（形态 B 仍在）。**两处必须同一键、同一语义。**

### §3.2 同-ms fail-CLOSED 误拒（residue 1）：(a) **解决**，不 defer

`chain_seq` 给同-ms 的 `delete` 与其后的 resurrect `create@v1` **各自不同的单调 seq**（delete 先发生 ⇒ seq 小；resurrect 后发生 ⇒ seq 大）⇒ `chainOrderAfter(create, delete)` = true ⇒ create 落**当前（新）代** ⇒ 代际边界画对 ⇒ **不再误拒**。两条 residue 原本被绑在一起，仅因 epoch-ms 把它们 collapse；换 `chain_seq` 后二者**同时**解开。**故 (a) 同时解决 §0.3 的 fail-CLOSED residue 1 与 fail-OPEN residue 2。**
- ⚠️ **前提**：resurrect create 的 seq 必须相对其前驱 delete **单调**——即 counter 须**跨记录删除存活**（OD-C2-2 的 per-sheet / per-record-durable 之争的正是这个）。若 counter 在删除时重置，则 seq collapse、residue 1 复现。**constructed-concurrency golden（§4）是唯一能钉死此前提的证据**，非顺序论证（[[feedback_toctou_needs_constructed_race]]）。

### §3.3 C2 **不**关闭的（明标，禁被守卫绿掩盖）

- **C3**：deleted/tombstoned 多代链的**枚举完整性**（precheck 仍 live-only，`history-integrity-precheck.ts:169-171`）。C2 让**排序**正确，C3 让**枚举**完整——正交，C2 解决同-ms 代际**序**不等于 subsume C3。deferred，owner 定序其在 C2 之后。
- **C6**：durable 水位 + 滚动上线两阶段协议 + 水位存活记录删除。C2 只声明边界接口。
- **跨记录的全序**：C2 保证 **per-record** commit-faithful；跨记录的绝对时序不在 reconstruction/contiguity 的正确性依赖内（两者都是 per-record 判定），故不设计跨记录全序（若未来 base-wide 一次性重建需要，另开）。

---

## §4 验证计划（实现阶段义务，mutation-proven，对齐 #4252 §6.2 golden 矩阵）

> 本节是**实现阶段**的验收义务清单（C2 ratify 后才写代码/测试）；本锁 docs-only，不落任何测试。

### §4.1 constructed-concurrency goldens（真并发，非顺序论证）

**必须用双连接构造 txn-start 反转**（[[feedback_toctou_needs_constructed_race]]：顺序论证对竞态一文不值）：
1. **time-reversal / 形态 A**（对应 #4252 「time-reversal (C2)」行）：连接 A `BEGIN`（txn-start 早）→ 连接 B `BEGIN`（晚）→ **B 写 R 到 v4 并 COMMIT** → **A 写 R 到 v5 并 COMMIT**。断言：链出现 `v4.created_at > v5.created_at`（txn-start 反转已构造）**但** `v4.chain_seq < v5.chain_seq`（**新键按 commit 现实排序**）；reconstruct 到形态 A 的 T ⇒ 返回 commit-真相的快照（或按 OD-C2-3 的 event-anchor 语义命中正确事件）。**mutation：把排序退回 `created_at`（去 chain_seq 载重）⇒ golden 必红。**
2. **同-ms resurrect / residue 1**：同一毫秒 `delete@vk` 然后 `create@v1`（resurrect）。断言：`chain_seq(delete) < chain_seq(create)` ⇒ 代际边界画对 ⇒ **不误拒**（正控）。**mutation：counter 在删除时重置 / comparator 仍用 epoch 腿 ⇒ 误拒复现，golden 红。**
3. **cross-ms 掩盖 / residue 2**：构造一个 create/update 事件其 txn-start epoch 晚于本代 delete、且当前代有真实同-version 洞。断言：**contiguity 拒（`chain_hole`）**（换 chain_seq 后边界画对、洞暴露）。**mutation：orderKey 退回 epoch-ms ⇒ 洞被掩盖、golden 从红变绿 = 证伪。**
4. **正控（防 refuse-everything / 防选错）**：全链健康（chain_seq 密、无洞）⇒ 任意 T reconstruct 命中正确版本、contiguity 通过。**每条「断言不发生」的腿都要配正控腿**（[[feedback_positive_control_not_failclosed]]）。

### §4.2 mutation-proofs（守卫须证明会红）

- 去 comparator 的 `chain_seq` 载重（退 epoch）→ residue 2 golden 红。
- 去 reconstruction 的 `chain_seq` 排序（退 created_at）→ 形态 A golden 红。
- counter 源改为「删除时重置」→ residue 1 golden 红。
- 变异须先证明**自身落地**（[[feedback_mutation_testing_limits]]：失败的替换与健壮守卫从外面看一样）。

### §4.3 迁移纪律（fresh-DB + zzzz）

- `chain_seq` 列 ADD 迁移须 **zzzz-timestamped**（[[feedback_migration_zzzz_ordering]]）——它共享 `meta_records`/`meta_record_revisions`/`meta_record_version_markers` 的 version-space，后三者皆 zzzz 建表。**nullable、无 default 回填**（禁编造 commit 序 = OD-5）。
- **fresh-DB 全量 migrate 验**（非预载 DB）：预载 DB 会掩盖排序陷阱；`up()` 须 idempotent（`ADD COLUMN IF NOT EXISTS`）。
- CI test-DB 迁移排除清单：确认新迁移**不**落入被排除簇（[[feedback_ci_test_db_migration_exclusions]]），否则真库 golden 在无-DB 步 skip-green。

### §4.4 CI 两点接线提醒

- core-backend integration golden **只跑 `plugin-tests.yml` 白名单**（[[feedback_realdb_test_two_point_wiring]] / [[feedback_plugin_integration_core_tests_not_in_ci]]）——新 spec 必须显式加入白名单，否则「被触发≠被验证」（[[feedback_triggered_is_not_verified]]）：绿 CI ≠ 那些 real-DB golden 跑过。
- 接线后须**证明会红**（正控腿 + 至少一次故意 mutation 触发红）。

---

## §5 OD-C2-* 开放决策（owner ratify）

- **OD-C2-1 — 机制选定**：primary = **(a) chain_seq（锁内赋值）**。是否直接 ratify (a)？或先上 **(c) clock_timestamp 作过渡缓解**、(a) 随后？（建议：直接 (a)；(c) 仅在 (a) 落地前若需即时缓解才用，且明标 narrows-not-close。）
- **OD-C2-2 — counter 源 / 粒度**：**per-sheet 单调计数器/序列（序列化点内递增）** vs **per-record `max(seq)+1`（写已持有锁内读；resurrect 以既有 per-sheet advisory fence 为 backstop）**。权衡 = 持久性/存活记录删除 **vs** 高频写 sheet 的热行争用。（建议：优先「跨记录删除存活」的源；最终由 §4.1 constructed golden 钉死，不靠顺序论证。）
- **OD-C2-3 — PIT 时间锚语义（最大决策点）**：**保持 wall-clock `asOf` + `created_at<=T` 过滤，chain_seq 仅 tiebreak（narrows-not-close：过滤反转仍在）** vs **把锚升级为 event/batch ordinal，过滤改 `chain_seq<=anchorSeq`（彻底闭合 + 消灭同-ms 兄弟批次误含 + 与已上线 history-anchored picker #3749 咬合、FE 近零改）**。（建议：event-anchored 过滤。）
- **OD-C2-4 — History UI 是否按新键重排**：reconstruction 与 History 列表（`record-history-service.ts:300` 现 `ORDER BY version DESC, created_at DESC`）须对**同一** order 达成一致，否则「列表看到的顺序」与「重建选中的版本」会背离。是否让 History Center 列表亦以 `chain_seq` 排序？（建议：是——保排序真相单一；属 UI 改动，随 C2 落地。）
- **OD-C2-5 — pre-anchor T 处置（C6 接缝）**：对低于 anchored 边界的 T，reconstruction **一律 refuse（fail-closed，最保守）** vs **best-effort `created_at` 排序并标「非 commit-faithful」**。（本锁只声明接口；最终与 **C6** 的 durable 水位 + 滚动上线一并定——owner 定序 C2→C3→C6，故 C2 落地时可先取保守 refuse，C6 再放开。）

---

## §6 Slice 计划（估算）

> 依赖方向（owner 定序）：**C2 → C3 → C6**。C2 使**新写**commit-faithful 并定义 trusted-since 接缝；pre-anchor 窗口的滚动安全属 C6，故 C2 落地时对 pre-anchor T 取保守处置（OD-C2-5），不阻塞 C2 自身。

| Slice | 内容 | Model | 依赖 | 估算 |
|---|---|---|---|---|
| **C2-S1 schema** | `chain_seq BIGINT` nullable 列（revisions + markers），zzzz 迁移、无 default 回填、fresh-DB 全量验 | Opus 设计 / Sonnet impl | ratify(a)+OD-C2-2 | ~0.5 pw |
| **C2-S2 写路径接线** | 所有 revision 写点（`recordRecordRevision` / `...Batch`）+ 4 个 lock/unlock marker 写点，在序列化临界区内赋 `chain_seq`（counter 源按 OD-C2-2） | Opus（并发正确性） | C2-S1 | ~0.5–1 pw |
| **C2-S3 读路径载重** | reconstructRecordsAtT 排序（+按 OD-C2-3 决定过滤腿）与 `chainOrderAfter` orderKey **两处**换 `chain_seq`；History 列表排序（OD-C2-4） | Opus | C2-S2 | ~0.5 pw |
| **C2-S4 goldens** | §4.1 双连接 constructed-concurrency（time-reversal / 同-ms resurrect / cross-ms 掩盖 / 正控）+ mutation-proofs + 两点 CI 接线 | Sonnet（real-DB） | C2-S3 shape | ~0.5–1 pw |
| **C2-S5 C6 接缝 stub** | 声明 trusted-since 边界接口（非 NULL chain_seq = anchored）+ pre-anchor T 保守处置；**不**设计 C6 水位/滚动 | Opus | C2-S3 | ~0.25 pw |

**C2 单线合计 ≈ 2.25–3.25 pw**（落在 #4252 §8 「Phase W0 ~4–6 pw」内、W0.4 lane 的 C2 半）。**Model dispatch**（owner policy）：schema/txn/并发正确性 = **Opus**；locked-spec impl + real-DB golden = **Sonnet**；本锁本身 = design lane，零 impl。

**并行性**：C2-S1 ∥（无）；C2-S2 依赖 S1；C2-S3 依赖 S2；C2-S4 最后。C2 与 C3/C6 **串行**（owner 定序），不并行。

---

## 附：本锁的边界与纪律自检

- **Status = PROPOSED — NOT ratified**；owner 保 C2 独立 gate；本锁只呈**机制**供裁决。
- **零运行时**：docs-only；无 schema/代码改动落地——所有 §4 义务是 **ratify 后**的实现阶段清单。
- **禁编造回填**（OD-5）：现存 revision 的 `chain_seq` 恒 NULL，绝不合成 commit 序。
- **不越界**：C3 / C6 只声明接口，机制留其各自 deferred 的锁。
- **收官口径**：本锁**不**宣称任何东西「做好了」——它是 C2 机制的 design-lock 草案，等 owner 对 OD-C2-1..5（尤其 OD-C2-3 的锚语义）裁决后方可开工。

---

## §7 owner 裁决(2026-07-15 晚,逐字生效;针对本锁与平行纠正锁 #4262 v3.5 / 实现 Draft #4309 的统一口径)

> owner:「认可一半:**seq 应取代 epoch-ms,作为严格模式的链内排序原语**;但**不 ratify 当前 #4262 v3.5 为完整 C2/C3/C6 设计**。#4309 继续保持 Draft/HELD,现有 MERGE_CLEAN 门禁被两个 High 证伪。修订版必须补齐:
> 1. **seq 管顺序,另设 fence 后的 `effective_at`/线性化时间或等价 T→seq 边界,重建不得继续单靠事务开始时间**;
> 2. **预检按目标 asOf generation 检查,或保守检查所选 checkpoint 后所有可能被恢复的 generations**;
> 3. **strict 启用硬依赖 L4 全 writer fence + L5 active checkpoint**;
> 4. **seq 全链使用精确 bigint 比较**(不得经 `Number()` 折叠——float64 吞 tiebreak 同类刚发生过);
> 5. (#4316 归考勤线:compose 验证 cwd 统一后 containment 才算 PASS)。
> 量级:至少还缺一刀**跨 writer 的时间线性化**与一刀 **asOf-generation 校验**。」

**对本锁 OD 的含义(机械标注,不自裁余项)**:
- **OD-C2-1/2(机制/计数器)**:方向已裁——**seq 取代 epoch-ms 为 strict 模式排序原语**;因果性非天然,**必须 fence 后分配**(L4 全 writer 同事务同连接取 sheet fence 再取 seq),启用硬依赖 L4+L5。任何「迁移落地即 prospectively causal」类断言过强,禁写。
- **OD-C2-3(锚语义,本锁最大决策点)**:已裁其否定半——**过滤腿不得单靠 txn-start `created_at<=T`**;肯定半 = 「fence 后 effective_at/线性化时间」或「T→seq 边界」二选一,**留修订版呈案**(本锁 §2 的 event-ordinal 方案是 T→seq 边界的一个候选,与 #3749 picker 咬合)。
- **OD-C2-4(History UI 排序)**:随 seq 主序自然对齐,bigint 精确比较硬性。
- **新增 C3 义务(超出本锁原 scope,并入修订)**:asOf-generation 预检——只查终末 generation 不够(用户可把 T 选在旧 generation ⇒ 不可信历史被恢复而预检仍绿)。
- **owner High-1 的实证意义**:本锁 §1.a-iv/§2 预判的「过滤腿反转」即该 High 的机理;修订版以此为第一优先级。

**两把新增刀(量级修正)**:跨 writer 时间线性化(effective_at/T→seq 边界)· asOf-generation 校验。原 §6 估算相应上调。

**红线不变**:本锁与 #4262 修订版合流后仍 PROPOSED,owner ratify 后才动;平行 session 的 #4309/#4262 归其 session 修订,本文只记录统一口径防止设计分叉。
