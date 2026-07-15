# W0-1 (v3.6) — 统一修订锁：seq 主序 + T→seq 边界 + asOf-generation 预检 + L4/L5 硬前置 — DESIGN LOCK（PROPOSED — NOT ratified）

- **Status（2026-07-15）**: **PROPOSED — NOT ratified.** owner 已**两次**对平行 v3.5 弧（#4262 锁 + #4309 Draft impl）作同一裁决（录于 C2 锁 §7，#4325 = `9a6fc71f9`）：**seq 半认可 = strict 模式链内排序原语**；**v3.5 不 ratify 为完整 C2/C3/C6 设计**；两个 High 证伪现有 MERGE_CLEAN 门禁；修订版须补齐 4 项硬要求 + 两把新刀。本文即该**统一修订**：合流 C2 锁（#4320 merged + §7 裁决）与 #4262 v3.5 的仍有效部分，把 owner 4 项要求写成**硬章节**。owner ratify 后才动工。
- **Provenance**: `origin/main`（本 worktree 基点 `bf52b9513`，含 #4320/#4325）；#4262 v3.5 锁读自其分支 `claude/w0-1-corrected-generation-design-lock-20260713`；#4309 Draft diff 读自 `claude/w0-l3-chain-integrity-core-20260715`。**本文不改动 #4262/#4309**（归平行 session）；本文的作用 = 让两条设计线**收敛而非分叉**。
- **Lane 命名（沿用 #4309 口径）**：**L3** = chain-integrity core（seq 迁移 + loud marker + strict generation-aware contiguity；#4309 Draft）；**L4** = 全 writer sheet fence（v3.5 §3）；**L5** = time-anchored baseline checkpoint（v3.5 §6）。本文新增 **L6** = T→seq 边界（跨 writer 时间线性化，刀一）、**L7** = asOf-generation 校验（刀二）。

---

## §0 合流账本 —— 对 v3.5 / C2 锁各保留什么、修正什么

### §0.1 从 #4262 v3.5 **保留**（本文不重造，逐条引用）
- **§0 CONTAINMENT**（两恢复 flag 每个真实环境 off，ops 验证）——原样保留，仍是 standing 前置。
- **§1 P1-1 loud marker + 撤跨代 unique**——已由 #4309 实现（迁移撤 `uq_…_sheet_record_version`；`recordVersionMarker` 去 `ON CONFLICT DO NOTHING`）。保留。
- **§2 单一 seq 域**（一条 PG sequence 横跨 revisions+markers；generation = create-count ordered by seq；代内 +1-dense；within-generation duplicate ⇒ `chain_corrupt`）——**owner 半认可的那一半**，保留为 strict 排序原语。
- **§3 fence 同事务/同连接契约**（显式事务、one client、all-or-nothing、entry matrix、per-family production-wiring mutation proof）——契约**逐字保留**（见 §4；其一处事实前提本文修正，§0.2-i）。
- **§4 C3 deleted/trash 链枚举**、**§5 marker consumer surface**、**§7 non-forgeable `system_kind`**、**§8 golden matrix**（含 anchor-race、cutover executability、autocommit-fence trap）——保留，本文 §1/§4 在其上**增补**两 High 的 golden。
- **§6 checkpoint 状态机**（独立 baseline 表 + partial-unique active + fence-first/anchor-under-fence `clock_timestamp()` + total-order selection + **floor-selected retention** + tombstone 全内联推荐）——保留；本文 §2.4 给它补 owner 点名缺失的 **T→seq 截断契约**。

### §0.2 对 v3.5 的**修正/超越**（合流点，须 owner 过目）
- **(i) §3 事实前提在 current main 上为伪（本文实证）**：v3.5 §3 写「advisory fence（`acquireAutoNumberSheetWriteLock`）is held by reset-execute's destructive txn」。**实况**（`bf52b9513`）：reset-execute 持有的是**不相交的另一把锁** `pg_advisory_xact_lock(0x77303104::int, hashtext(sheetId)::int)`（`univer-meta.ts:10481`，`PIT_RECOVERY_LOCK_NS` `:469` 且注释自陈「disjoint from any other advisory lock in the codebase」）；而 create-family 的 fence 是**单参形态** `pg_advisory_xact_lock(hashtext('meta:auto-number:sheet:'||sheetId))`（`auto-number-service.ts:17-22`）。**两把锁互不排斥。** 若照 v3.5 §3 原文把全部 writer 挂到 auto-number fence，reset 的破坏性事务（只持 PIT ns）与 writer **仍然并发**——L4 的全部保证**静默作废**。修正 = §4.1 的**单一 canonical fence 收敛**。另：**revert-execute（`univer-meta.ts:10210`）现无任何 fence、无 in-txn 复检**（v3.5 §3 末句已如实预告，这里核实为现状）。
- **(ii) v3.5 的 C2 = 「代内 seq/version 一致性」预检**——必要但**不充分**：它只让预检 fail-closed，**重建的选择谓词仍是 `created_at <= T`**（`record-reconstructor.ts:53-54`，#4309 未触碰该文件）。这正是 owner **High-1**。修正 = §2 的 T→seq 边界（重建不得单靠 txn-start）。
- **(iii) v3.5/#4309 的 strict 预检只查终末 generation**——owner **High-2**：T 可落旧 generation。修正 = §3。
- **(iv) #4309 的 `seq` 经 `toNumber` = `Number()` 折叠**（其 precheck diff：`toNumber(r.seq)` / `.sort((a,b)=>a.seq-b.seq)`，`seq?: number` 接口）——违反 owner 硬要求 4。修正 = §5。
- **(v) backfill 语义合流**：#4309 实现 = per-table `row_number()` backfill + `NOT NULL`（两表 range 重叠，其 PR body 自陈「NOT causal evidence」）。**保留该实现**，但 C2 锁原「NULL = trusted 接缝」随之**作废**：**唯一信任边界 = L5 checkpoint 的 `trusted_since_seq`，永远不是「seq 非空」也不是「迁移已落」**（owner §7 裁决明令：「任何『迁移落地即 prospectively causal』类断言过强，禁写」）。推论：**L5 之前 strict 不得启用**（owner 硬要求 3 已覆盖）；且旧行两表 seq 碰撞意味着 **checkpoint 截断（§2.4）之前的链段对 strict walk 不可判**——截断契约让它们永不载重。

### §0.3 对 C2 锁（#4320+§7）的**保留/超越**
- 保留：§0 的失败形态 A/B 与两 residue 分析（本文 §1 直接把 High-1 具化为形态 A 的 golden）；§4 验证纪律（constructed race / mutation / zzzz / 两点接线）；OD-C2-3 的 event-ordinal 锚方案（并入 §2 作候选 R1）。
- 超越：OD-C2-1/2 已被 §7 裁决吸收（seq 为原语、fence 后分配）；「chain_seq NULL = C6 接缝」被 §0.2-v 取代；估算被 §6 取代。

---

## §1 两个 High —— fail-first golden 规格（事件序列 + 期望拒绝）

> 两条 golden 都是**先写先红**（对 #4309 L3 分支的语义为红），修复落地后转绿；mutation 退回旧谓词必须复红。真并发用双连接构造，禁顺序论证（[[feedback_toctou_needs_constructed_race]]）。

### §1.1 G-H1 —— 「早启动、晚拿锁」的写被 T-重建选中（High-1）

**前提**：记录 R 健康处于 v3（v1/v2/v3 全捕获）。**双连接构造 txn-start 反转**：

| 步 | 墙钟 | conn A | conn B |
|---|---|---|---|
| 1 | 100 | `BEGIN`（txn-start=100），随后**阻塞在 sheet fence 上**（post-L4 形态）或 sleep | — |
| 2 | 150 | — | `BEGIN`（txn-start=150） |
| 3 | 155 | — | patch R → **v4**：rev v4 `created_at=150`，seq=**s₁**，`effective_at≈155` |
| 4 | 160 | — | **COMMIT** |
| 5 | 180 | patch R → **v5**：rev v5 **`created_at=100`**（=txn-start！），seq=**s₂>s₁**，`effective_at≈180` | — |
| 6 | 190 | **COMMIT** | — |

**关键观察（owner 裁决的原话形状）**：链 v1..v5 密、代内 **seq 序与 version 序完全一致**（s₁<s₂ ⇔ 4<5）⇒ **#4309 的 strict 预检 PASS**。但 `created_at` 序是 150→100 **反转**。

**断言（T=120，即 conn A 启动后、conn B 写入前的墙钟点）**：
- **现状（红）**：`created_at<=120` 只命中 v5（100≤120）⇒ 重建返回 **v5** —— 一个在真实时刻 120 **尚未发生**（180 才写、190 才提交）的写，且跳过 v4。strict 预检绿 ⇒ fail-OPEN 无拒绝。
- **期望（修后绿）**：T→seq 边界 `B(120)` 解析到 v3 事件的 seq（v4/v5 的 `effective_at` 均 >120）⇒ 重建返回 **v3**（data==v3 快照，version==3）。正控腿：T=170 ⇒ v4；T≥185 ⇒ v5。
- **Mutation**：把重建选择退回 `created_at<=T` ⇒ T=120 复返 v5 ⇒ 红。

### §1.2 G-H2 —— T 落旧 generation、预检穿透（High-2）

**构造（单记录 R，seq 单调递增标注）**：
1. **gen-1**：create v1（seq 1，captured）→ **uncaptured 数据写 v2**（version bump、无 revision——洞）→ update v3（seq 2）→ delete（seq 3，复用 v3）。
2. **resurrect**（trash restore）：create v1′（seq 4，新 generation）→ update v2′（seq 5）。R 现活在 v2′。

**关键观察**：终末 generation {v1′@4, v2′@5} 密 ⇒ **#4309 terminal-gen-only strict 预检 PASS**。但 gen-1 有 v2 洞。

**断言（T/anchor 使边界 B 落在 gen-1 内，尤其 B∈[seq1, seq2) 的洞窗）**：
- **现状（红）**：revert-preview/execute 放行；重建对 B∈洞窗取 **v1 快照**，而记录当时实际在 v2 ⇒ **以错误数据复活**。fail-OPEN。
- **期望（修后绿）**：asOf-generation 预检（§3）把 B 解析进 gen-1，对 **gen-1** 跑 contiguity ⇒ 发现 v2 洞 ⇒ **preview 与 execute 双双 409 `HISTORY_INCOMPLETE`，零写**。
- **正控腿**：同一记录、B≥seq 4（T 落 gen-2）⇒ **通过**（gen-2 密）——证明拒绝是 generation-scoped 而非 refuse-everything（[[feedback_positive_control_not_failclosed]]）。
- **Mutation**：退回 terminal-gen-only ⇒ 拒绝腿错误转绿 ⇒ 红。
- **C3 变体**：R 处于「现已删除、T 时存在」态（revert 复活对象）——同构造少最后一代，断言同形（这就是 C3 枚举与 asOf-generation 的交点，两者必须同时成立）。

---

## §2 T→seq 边界设计（owner 硬要求 1 + 刀一「跨 writer 时间线性化」）

### §2.0 统一选择原则（本设计的核心不变量）

> **选择永远是 seq-前缀（`seq <= B`）；墙钟绝不出现在选择谓词里。** 重建与预检共享同一个每操作边界 **B**（bigint）。墙钟只允许出现在「把 T 翻译成 B」的**解析器**里。

这一原则同时闭合两处载重（C2 锁 §3.1 的硬要求）：`chainOrderAfter`/strict walk 已按 seq（#4309 落了一半），`reconstructRecordsAtT` 的过滤+排序换成 `WHERE seq <= B ORDER BY seq DESC`（`DISTINCT ON (record_id)` 保留）。**前缀封闭**保证选出的必是某个**真实存在过**的因果一致状态——这是逐条 `effective_at<=T` 过滤给不出的（见 §2.2 时钟回拨分析）。

### §2.1 候选 R1 —— event/batch-ordinal 锚（C2 锁 OD-C2-3 的肯定半）

- **机制**：PIT 锚不再是墙钟，而是一个**离散历史事件**。已上线的 history-anchored picker（#3749，`ResetToPointPicker.vue`，`mode` 默认 `'history'`）本就让用户选 History **batch**；升级 = picker 把选中 batch 传给服务端，服务端解析 `B = MAX(seq) WHERE batch_id = $anchorBatch`（`batch_id` 已在 revisions 表，#2985/T5 线），操作全程用 B。
- **保证**：**零墙钟参与**——反转在结构上不可能；同-ms 兄弟批次误含（#3749 方向文档 §3 自陈的残余）同步消灭（B 精确到事件）。
- **覆盖不了的**：自由墙钟 T 的入口——「Advanced manual time」兜底、`GET point-in-time` 视图（`univer-meta.ts:8364`）、API `asOf` 合同——这些**没有 batch 可选**，仍需 T→B 翻译 ⇒ 单靠 R1 不完备，除非产品面砍掉自由 T（OD-V36-1 的 fork 之一）。

### §2.2 候选 R2 —— fence 后 `effective_at`（跨 writer 时间线性化）

- **机制**：给两表各加 `effective_at timestamptz`（nullable，forward-only，禁回填——OD-5）。**每个 writer 在已持有 L4 sheet fence 的临界区内**、分配 seq 的同一语句序列里取 `clock_timestamp()` 写入。这是 v3.5 §6.2 checkpoint「fence-first / anchor-under-fence」模式**推广到每一次写**。
- **保证（为何这是线性化）**：fence 是 `pg_advisory_xact_lock`（事务级，commit/rollback 才释放）⇒ 同 sheet 的写**串行化**：后拿到 fence 的写，其 `clock_timestamp()` 必然晚于前一个持有者**提交**之后 ⇒ **effective_at 序 == fence 序 == seq 序 == commit 序**（单 DB 时钟）。txn-start 的病根（拿锁前就定格时间）被结构性移除。
- **T→B 解析**：`B(T) = MAX(seq) WHERE sheet_id=$1 AND effective_at <= $T`（两表取大者；SQL 原生 bigint，精确）。
- **诚实的残余——NTP 回拨**：`clock_timestamp()` 是墙钟，回拨可造 effective_at 相对 seq 局部非单调（writer₁ effective_at=100 提交后时钟回拨，writer₂ effective_at=95、seq 更大）。**契约**：B 仍按上式取 **MAX(seq)**，选择集 = **seq-前缀 `seq<=B`**（哪怕前缀内个别事件 effective_at>T）。前缀封闭 ⇒ 返回的必是真实存在过的状态；墙钟精度在时钟异常下降级为 best-effort，但**绝不构造从未存在的状态**（逐条过滤会：收 writer₂ 排 writer₁ = 洞）。这也是为什么 **effective_at 只能当解析器、不能当选择键**。
- **部署窗口**：nullable 列 + 既有 txn-safe 探针模式（`hasChainSeqColumns` 同款）；**effective_at 只在该写点已被 L4 fence 覆盖时才有线性化意义** ⇒ R2 的保证**硬依赖 L4**（schema 可先落，保证随 L4 激活）。pre-L6 旧行 effective_at=NULL ⇒ 落在 checkpoint 截断之前，不载重（§2.4）。

### §2.3 建议：**分层合一 —— seq-前缀选择 + 双解析器（R1 primary UI，R2 兜底/合同）**

两候选不是二选一，是**同一机制的两个入口**：
- **选择层（唯一）**：seq-前缀 `seq <= B`。
- **解析层**：**R1**（picker 锚 batch → B，主 UI 路径，零墙钟）+ **R2**（自由 T / API asOf / PIT view → `effective_at` → B）。
- **为何不 R2-only**：主路径能拿到精确事件锚时不该绕道墙钟；R1 让 #3749 已上线形态近零 FE 改动地获得精确语义。**为何不 R1-only**：`asOf` 墙钟合同遍布（preview/execute/PIT view/T5 消费者），砍自由 T 是产品裁量（OD-V36-1），设计不应替 owner 砍。
- owner 裁决原文「另设 fence 后的 effective_at/线性化时间**或**等价 T→seq 边界」——本建议 = 两者的合取：**边界统一为 seq，effective_at 只做翻译**。

### §2.4 C6 checkpoint 的 **T→seq 截断契约**（owner 点名缺失件）

v3.5 §6 的 checkpoint 有 `trusted_since_seq` + `trusted_from_at` 字段但**没写它们如何截断链选择**。契约如下（进 spec + golden）：

1. **Cutover 分配（在 §6.2 状态机第 3 步旁增补）**：fence 持有中，`trusted_since_seq := nextval('meta_record_chain_seq')`、`trusted_from_at := clock_timestamp()`，与 baseline 写同一事务。⇒ checkpoint **占据 seq 域中一个真实位置**：一切 post-cutover 写 seq > `trusted_since_seq` 且 effective_at ≥ `trusted_from_at`（fence 序保证）。
2. **查询解析**：给定 T（或锚）——(a) 按 v3.5 §6.3 total order 选 checkpoint C（最新 retained 且 `trusted_from_at <= T`）；(b) 按 §2.3 解析 B；(c) **截断不变量：`B >= C.trusted_since_seq`，否则 fail-closed 拒**（只可能因时钟异常/retention 边缘出现；拒是安全腿）。
3. **重建 = baseline ⊕ 前缀重放**：记录在 T 的状态 = C.baseline(record) 叠加 `C.trusted_since_seq < seq <= B` 的事件重放。**seq ≤ trusted_since_seq 的事件由 baseline 代表，永不重放**——这就是截断。旧行（backfill seq、无 effective_at、含两表 seq 碰撞）全部落在截断线以下 ⇒ **结构性不载重**（§0.2-v 的兑现）。
4. **预检同截断**：contiguity 义务从 `max(baseline version, generation start)` 起算到 B 处 version；pre-checkpoint 洞按设计不可见（baseline 即信任原点）。
5. **Retention**：v3.5 §6.5 floor-selected 规则原样适用；补充：**floor 保护的不只 baseline，还有 `(trusted_since_seq, …]` 区间内被任何合法 T 触达的事件**（floor 事件按 seq 界定，非墙钟界定）。

---

## §3 asOf-generation 预检设计（owner 硬要求 2 + 刀二）

### §3.1 方案 A —— target-generation（按 B 所落的 generation 查）

- **机制**：预检签名增收边界 B（preview/execute 均已有 asOf，可解析）。strict walk 本就构建全链 timeline（#4309 的 `SeqTimelineItem` sort by seq）；把「取终末 generation」换成「取**包含边界事件**（`MAX(seq)<=B` 的事件）的 generation g_T」，对 g_T 从其 create（或 §2.4 截断点，取大者）到边界处 version 跑同一 +1-dense 检查。live 与 deleted 记录**同一律**（deleted 记录的 g_T 检查即 revert 复活的信任前提——与 C3 枚举同一走查）。
- **成本/复杂度**：walk 复杂度不变（O(链长)，本就全链加载）；新增 = B 的下传（预检签名 + C8 in-txn 复检同 B）≈ 小。**T-依赖**：每操作按其 B 判定 ⇒ 精确、无跨窗误拒。
- **风险**：实现易错点 = 「边界事件的 generation」在边界恰落 delete 上时的归属（delete 是前代终结符：B 恰=delete.seq ⇒ 记录在 T 不存在，无需该记录的重建信任，但 reset 的 delete-set 语义要复核）。golden 必须钉这个边（G-H2 增补一腿：B==seq 3 ⇒ exists:false，预检对该记录免查）。

### §3.2 方案 B —— conservative all-restorable-generations

- **机制**：T-独立。对每记录（live+deleted）检查**checkpoint 之后所有可能被任何合法 T 触达的 generation**（= 一切含 `seq > trusted_since_seq` 事件的 generation）。
- **成本/复杂度**：walk 同 O(链长)；**无需 B 下传**（实现更早可落）。代价 = **过度拒绝**：任一旧（但 post-checkpoint）generation 有洞 ⇒ 整 sheet 一切恢复被拒，哪怕 T 落在健康窗——用户面 409 噪声，且与「精确集非计数」的精神相悖（拒绝应指向可证伪的目标窗口）。
- **合规性**：owner 裁决原文允许（「或保守检查所选 checkpoint 后所有可能被恢复的 generations」）。

### §3.3 建议：**A（target-generation）为终态；B 可作先行台阶**

A 与 B 的 walk 是同一份代码的两个谓词（「B 所在代」⊂「全部 post-checkpoint 代」）；若实现想在 L6 边界解析器落地前先关 High-2，可先落 B（T-独立、无需边界），L6 落地后收敛到 A。**终态必须是 A**：whole-sheet 操作里不同记录各有各的 g_T，A 的 per-record 精确性才与「操作实际读取什么」的信任声明一致。**OD-V36-2** 请 owner 确认 A（或接受 B 为终态换实现简单）。

---

## §4 strict 启用硬前置清单（owner 硬要求 3 —— L4 全 writer fence + L5 active checkpoint）

> **启用语义（in-code 可执行的部分必须 in-code）**：`MULTITABLE_HISTORY_CONTIGUITY_STRICT=true` 时，预检/重建对**无 active checkpoint 的 sheet 一律 fail-closed 拒**（runtime 自查，非 runbook 承诺）。L4 覆盖度无法 runtime 自证 ⇒ 靠**落地顺序 + flag-manifest guard + per-family mutation golden**三腿钉死。

### §4.1 L4-0：**canonical fence 收敛（新增前置，修正 §0.2-i）**

- 指定**唯一** canonical sheet-write fence = `acquireAutoNumberSheetWriteLock` 的锁 key（create-family 已在其上），语义更名为 sheet-write fence（helper 迁至中性模块，key 字符串**不改**——改 key = 部署窗口内新旧实例互不排斥）。
- **reset-execute 与 revert-execute 的破坏性事务必须改为「先取 canonical fence，再取（或保留）PIT_RECOVERY_LOCK_NS」**——PIT ns 锁可留作 recovery-vs-recovery 串行化，但**对 writer 的互斥只能来自 canonical fence**。锁序固定（canonical → PIT ns），全 writer 单锁 ⇒ 无死锁引入。
- Golden：constructed race——reset 破坏性事务持 canonical fence 期间，并发 `patchRecord` 阻塞至 commit（`pg_blocking_pids` 编排）；mutation：reset 只持 PIT ns ⇒ race golden 红。

### §4.2 L4-1：writer 家族矩阵（对 D-1c 实况站点逐一挂 fence；行号 = `bf52b9513` 实测）

| # | 家族（D-1c 对应） | 入口锚点 | 今日 fence | L4 义务 |
|---|---|---|---|---|
| 1 | REST create | `record-service.ts:518` | ✅ 已挂 | 保持 |
| 2 | REST patch | `record-service.ts:1389` | ❌ | 挂 fence（其事务内最外层） |
| 3 | REST delete（trash 化） | `record-service.ts:894`（trash 写 `:874/:882`） | ❌ | 挂 |
| 4 | trash restore（复活写回） | `record-service.ts:1090`（trash 删 `:1139`） | ❌ | 挂 |
| 5 | bulk patch | `record-write-service.ts:972/:981` | ❌ | 挂（其 `pool.transaction` 内） |
| 6 | plugin create（A5） | `records.ts:587`（INSERT `:600`） | ✅ | 保持 |
| 7 | plugin patch（A2） | `records.ts:508` | ❌ | 挂 |
| 8 | plugin delete | `records.ts:805`（DELETE `:770/:842`） | ❌ | 挂 |
| 9 | automation update（A3） | `automation-executor.ts:2231` | ❌ | 挂 |
| 10 | automation create（A4） | `automation-executor.ts` create 分支（D-1c A4） | ❌ | 挂 |
| 11 | automation lock/unlock（+marker） | `automation-executor.ts:3497/:3514` | ❌ | 挂（marker 写与 bump 同锁同事务） |
| 12 | HTTP lock/unlock（+marker） | `univer-meta.ts:16504/:16525` | ❌ | 挂（同上） |
| 13 | form submit create/edit（A1/A6） | `univer-meta.ts:14526`（事务内已取） | ✅ | 保持 |
| 14 | attachment-delete cell-strip（A8） | `univer-meta.ts:15915` 区 | ❌ | 挂 |
| 15 | approval resultWriteback（A7） | `automation-service.ts` resultWriteback（D-1c A7） | ❌ | 挂 |
| 16 | field-undelete rehydration（OD-6 MUST-WRITE） | `univer-meta.ts:6490`（调用 `:8948`） | ❌（flag HOLD） | 挂；flag 仍 HOLD 不因此松动 |
| 17 | lossy-retype revert（4c-1） | `univer-meta.ts:6260` 区 helpers | ❌ | 挂（若写 `meta_records.data`） |
| 18 | reset-execute 破坏性事务 | `univer-meta.ts:10431`（PIT ns `:10481`） | ⚠️ 错锁 | §4.1 收敛 |
| 19 | revert-execute 复活事务 | `univer-meta.ts:10210` | ❌ 无 fence 无 in-txn 复检 | 挂 + 加同款 in-txn 复检（v3.5 §3 末句兑现） |

（v3.5 §3.4 的行号已漂移：lock 16426→16504、unlock 16441→16525、form 14485→14526、field-undelete 6521→6490——实现前须按当日 main 重扫全矩阵，本表即重扫方法的示范。auto-number 分配 `auto-number-service.ts:82` 已在 fence 语义内。）

- **每家族契约** = v3.5 §3.1-3 逐字（显式事务；fence/seq/effective_at/revision/marker/mutation 全在同一连接同一事务；any-step-fail ⇒ 整体回滚）。
- **每家族 mutation proof** = v3.5 §3.5 逐字（去 fence 或错连接取锁 ⇒ 该家族 constructed-race golden 红；没有能红的 golden = 未验证）。autocommit-fence trap golden（v3.5 §8）保留。

### §4.3 L5：active checkpoint 硬前置

- v3.5 §6 状态机 + 本文 §2.4 的 `trusted_since_seq` 分配与截断契约。
- **启用自查（in-code）**：strict 路径开头查该 sheet `meta_history_trust_checkpoints WHERE state='active'`；无 ⇒ 一切 preview/execute fail-closed（`HISTORY_INCOMPLETE`，值不外漏）。⇒ 「strict 开而 checkpoint 未 cutover」不可能静默放行。
- Cutover 只能在 L4 全量落地并到达所有实例**之后**运行（v3.5 §6.7 两阶段 rollout 保留）。

### §4.4 启用前 checklist（全绿才呈 owner 决定 flag-on）

- [ ] L3 修订：bigint 纪律（§5）+ walk 泛化到 asOf-generation 谓词（§3）落于 #4309 lane。
- [ ] L4-0 canonical fence 收敛（§4.1）+ L4-1 全矩阵挂锁 + per-family race golden 全红能力验证。
- [ ] L6 边界：`effective_at` schema + 双解析器 + `reconstructRecordsAtT` 改 seq-前缀 + #3749 picker 锚下传。
- [ ] L5 checkpoint + §2.4 截断契约 + retention floor golden。
- [ ] L7 asOf-generation 终态 A + G-H2（含 C3 变体、delete-边界腿、正控腿）。
- [ ] G-H1 + v3.5 §8 全矩阵 + §5 量级 golden，全部 real-DB、mutation-proven、**两点接线**（`plugin-tests.yml` 白名单显式加 spec，接线后证明会红——[[feedback_realdb_test_two_point_wiring]] / [[feedback_triggered_is_not_verified]]）。
- [ ] flag-manifest guard（`scripts/ops/global-history-flag-manifest.mjs`，#4309 已挂 strict flag 条目）同步 L4/L5 依赖声明。
- [ ] CONTAINMENT（v3.5 §0）仍成立；staging 全量预演（fresh-DB migrate + cutover 彩排——[[feedback_rehearse_acceptance_locally]]）。

---

## §5 bigint 纪律（owner 硬要求 4 —— 全链精确比较）

### §5.1 双前科（为什么这不是理论洁癖）

1. **#4269 打包浮点**：`epoch*1e6 + version` 在 2026 epoch 量级 ≈1.7e18、ULP≈256 ⇒ version tiebreak 被 float64 静默吞掉、同-ms 事件 collapse——CI 抓获，教训已写进 `chainOrderAfter` docstring（`history-integrity-precheck.ts:132-136`）。
2. **#4309 `Number()` 折叠**：pg 驱动对 `int8` 默认返回 **string**；其 diff 里 `toNumber(r.seq)`（=`Number(v)||0`）+ `seq?: number` 接口 + `.sort((a,b)=>a.seq-b.seq)` ——2^53 以上折叠，同类缺陷第二次出现。owner 裁决原文点名（「float64 吞 tiebreak 同类刚发生过」）。

### §5.2 端到端精确比较 spec

| 层 | 规则 |
|---|---|
| SQL | 一切比较（`ORDER BY seq` / `WHERE seq <= B` / `MAX(seq)`）留在 SQL 原生 bigint 完成——**优先locus**，天然精确。B 以 **string 参数**绑定（`$n::bigint`）。 |
| 驱动边界 | int8 以 string 到达——**保持 string**；禁全局注册 int8→Number parser（会波及全仓其他 bigint）。 |
| TS 层 | `ChainEvent.seq` / `VersionMarker.seq` / `SeqTimelineItem.seq` 类型改 **`string`（opaque）或 `bigint`**；比较用 `BigInt(a) < BigInt(b)`（或长度优先字典序的 padded-string 比较，二选一定死）。**禁** `Number()` / `parseInt` / 一元 `+` / 减法排序比较器。 |
| JSON/API | seq 与 B 出入 API 一律 **string**（JS `JSON.parse` 对数字字面量按 double 解析 ⇒ 大整数进 JSON number = 立即折叠）。 |
| 校验 | 入口正则 `/^[0-9]+$/` fail-closed（非法 ⇒ `comparator_error` 拒，杜绝 `BigInt('abc')` throw 逃逸为 500）。 |

### §5.3 生产量级 golden（mutation-proven）

- **G-BIG-1（2^53 邻差）**：`setval('meta_record_chain_seq', 9007199254740992)`；写两个相邻事件（seq = 2^53、2^53+1）；断言 strict walk 区分先后、`nonmonotonic_history` 判定不误触。**Mutation：恢复 `toNumber(seq)` ⇒ 两值折叠相等 ⇒ 序丢失/duplicate 误判 ⇒ 红。**
- **G-BIG-2（近 int8 上界）**：setval 至 `2^63-16`；同型断言 + B 解析（`MAX(seq)`）经 API string 往返无损。**Mutation：JSON 层按 number 传 B ⇒ 折叠 ⇒ 红。**
- 单元层：比较器对 `('9007199254740992','9007199254740993')` 返回严格序（正控 + 折叠 mutation 腿）。

---

## §6 Slice 计划（诚实 pw；含两把新刀；标注归属 lane）

> 依赖链：L3 修订（可即行）→ **L4**（fence 收敛+全矩阵）→ **L6**（保证依赖 L4）→ **L5**（cutover 需 fence；截断需 seq）→ **L7 终态 A**（需 L6 边界）→ 启用清单（§4.4）。并行：L3-R1 ∥ L4；L5 schema ∥ L6 schema。

| Slice | 内容 | 归属 | Model | 估算 |
|---|---|---|---|---|
| **L3-R1** | bigint 纪律（§5）：接口 string/bigint 化、驱动/JSON 边界、G-BIG-1/2 | **#4309 lane 内修订** | Opus 定 spec / Sonnet impl | ~0.5 pw |
| **L3-R2** | strict walk 谓词泛化：terminal-gen → 「B 所在 gen」（§3 A）/「全 post-checkpoint gens」（§3 B 台阶） | **#4309 lane 内修订** | Opus | ~0.5–1 pw |
| **L4** | canonical fence 收敛（§4.1）+ ~17 writer 家族挂锁（§4.2）+ per-family constructed race goldens | 新 lane | Opus（并发）/ Sonnet（goldens） | ~2.5–3.5 pw |
| **L6（刀一）** | `effective_at` zzzz 迁移（nullable、禁回填）+ fence 内赋值接线 + 双解析器 R1/R2 + `reconstructRecordsAtT` seq-前缀改造 + preview/execute/PIT-view/C8 复检 B 下传 + picker 锚下传（FE 小）+ G-H1/前缀封闭/NTP-step goldens | 新 lane | Opus 设计+读路径 / Sonnet goldens / Fable FE | ~2–3 pw |
| **L5** | checkpoint 状态机（v3.5 §6 保留)+ `trusted_since_seq` 分配 + §2.4 截断契约 + retention floor + v3.5 §8 checkpoint goldens（anchor-race 方向按 v3.5 已纠口径） | 新 lane | Opus / Sonnet | ~2–3 pw |
| **L7（刀二）** | asOf-generation 终态 A：B 进预检签名 + in-txn 复检同 B + G-H2 全腿（C3 变体/delete 边界/正控） | 新 lane（依赖 L6） | Opus / Sonnet | ~1–1.5 pw |
| **L8** | 启用工程：strict 无-checkpoint fail-closed 自查、flag-manifest 依赖声明、staging fresh-DB+cutover 彩排、rollout runbook | 新 lane | Sonnet | ~0.5–1 pw |

**合计（#4269+#4309 Draft 之上的余量）≈ 9–13.5 pw**；其中两把新刀（L6+L7）≈ **3–4.5 pw**——即 owner 「至少还缺两刀」对既有估算的显式增量。v3.5 §10 的「~3–5 pw on top of #4269」在两 High + 两刀后**不再成立**，以本表为准。Model dispatch 按 owner 政策：schema/txn/并发/安全 = Opus；locked-spec impl + real-DB goldens = Sonnet；纯 FE = Fable。

---

## §7 OD-V36-*（保持最小——多数方向已裁）

- **OD-V36-1 — T 输入面**：**(a) 双解析器 R1+R2（推荐）**——保留自由墙钟 asOf（Advanced 兜底 + API 合同 + PIT view），R2 承翻译；**(b) anchored-only**——砍自由 T（#3749 方向文档 §4 的 B2 延伸），R2/`effective_at` 可整体免建（省 ~1 pw），代价 = API asOf 语义变更 + 逃生口消失。产品裁量，须 owner 拍。
- **OD-V36-2 — asOf-generation 终态**：**A target-generation（推荐）** vs B conservative（裁决允许，代价 = 健康窗口的跨代误拒）。若接受「B 台阶 → A 终态」的两步走也请一并确认。
- **OD-V36-3 — fence 收敛形态（§0.2-i 的修正案）**：**(a) canonical = auto-number 锁 key，reset/revert 加持之、PIT ns 保留为 recovery 间串行化（推荐，create-family 零迁移）** vs (b) 定义全新 fence key、所有方迁移（部署窗口内新旧实例互不排斥的风险窗更大）。此项本质是对 v3.5 §3 错误前提的**必要修正**，呈 owner 确认形态而非是否修。

---

## 附：纪律自检

- **PROPOSED — NOT ratified**；本文合流两线设计以响应 owner 两次裁决，**不授权任何实现**；#4262/#4309 归平行 session，本文零改动零评论。
- 4 项硬要求落位：要求 1 → §2；要求 2 → §3；要求 3 → §4；要求 4 → §5。两把新刀 → L6/L7（§6）。
- 禁编造回填（OD-5）：`effective_at` 与既有 seq backfill 均 forward-only；唯一信任边界 = checkpoint（§0.2-v）。
- 一切「不发生」断言配正控腿；一切守卫配 mutation 红证；真并发一律 constructed（双连接），禁顺序论证。
- 收官口径：本文交付的是**统一修订设计**；「已做好」永不宣称——余量 = §6 全表 + owner ratify + flag 决策。
