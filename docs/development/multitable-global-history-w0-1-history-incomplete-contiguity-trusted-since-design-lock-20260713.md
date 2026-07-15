# W0-1 — `HISTORY_INCOMPLETE` 可信性纠错：连续性 + trusted-since + 同锁事务 — DESIGN LOCK（首刀 SHIPPED；C2/C3/C6 DEFERRED）

- **Status（owner 处置 2026-07-15，§6.6）**: **首刀已授权并 SHIPPED**（#4269=`3356a7ed6`，owner 主线抽查 PASS）；**C2/C3/C6 DEFERRED（序 C2→C3→C6）**；field-undelete flag **HOLD**。整锁不整份翻 RATIFIED。〔Rev 1 历史状态：PROPOSED 2026-07-13，design-first 零运行时——起草时成立，首刀落地后已过期〕owner 当时复审判 §0.6 现草案(#4235)「**不能安全落地**」——本锁把 §0.6 从 live-vs-latest 升级为**连续性证明**。**破坏性恢复路径 + 需 schema/行为变更**,故按 owner 一贯纪律(D-1c/D-2/4c-*/R13-C)**design-lock first,ratify 后才动**。W0 顺序门的第一刀,gate 一切 revision 5 刀之前。
- **Provenance**: primary-source @ origin/main;healed-gap flaw **已实证**(golden `/tmp/r13-w0-healed-gap-golden.txt`,对当前 #4235 **红**)。#4235 impl **faithful to §0.6**(其 gate=APPROVE-with-hardening 0P1/0P2),缺陷在 **§0.6 设计**本身。

## §0 已证缺陷(owner P1,实证)
- **healed-gap**:#4235 comparator = `LEFT JOIN LATERAL … ORDER BY created_at DESC LIMIT 1` = **live vs LATEST**。构造:记录 version=3,revisions 仅 {v1,v3}(v2 是无 revision 的 uncaptured 写),live==v3 snapshot ⇒ 预检**通过**。但 revert/reset 到 T∈[v2,v3) 用 latest≤T=**v1** 重建=错(记录当时是 v2)。**实证**:revert-preview(T1) 返回 **200 非 409**(golden 红)。tail 健康、**中段有洞**,live-vs-latest 结构性看不见。
- **check→write 竞态**(owner P1 + #4235 gate P3-1):execute 预检是破坏性事务**前**的池化 READ COMMITTED 查询 ⇒ check→write 间可落无 revision 写。

## §1 设计:连续性证明(替换 live-vs-latest)
重建到 T 可信 **iff** 该记录 revision 链在 ≤T 范围**连续无洞**。判据不是「live==latest」,而是「**每个 version 都有链上条目**」。

### 1.1 版本连续性 = 完整性的可观测代理
每次写(捕获或否)`version+1`。捕获写另写 revision(该 version)。故:一条记录 version=N,若其 revisions 的 version 集**缺某 k**(1≤k≤N),则 version k 是一次**无 revision 的写** = 潜在 uncaptured 数据写(= 洞)。`count(distinct revision.version) < live.version` ⇒ 有洞。

### 1.2 ⚠️ 关键难点:lock/unlock 合法地跳 version(假阳源)
`univer-meta.ts:16403/16417` lock/unlock `SET locked=…, version = version + 1`,**不写 revision**(设计如此)。故一条**健康**记录经 lock/unlock 也会造 version 洞——**version-contiguity 单独会误拒 lock/unlock**(违反 G-HI-2)。**必须区分「lock/unlock 跳版」与「uncaptured 数据写跳版」**——retroactively 不可区分,故:
- **lock/unlock(及一切合法的无 revision version-bump)必须留链上标记**。三选一(**OD-W0-1**):
  - **(a) 轻量 revision**:lock/unlock 写一条 `action='lock'/'unlock'` 的 revision(snapshot=当前 data,不算数据变更)。链变密:每 version 有 data-revision 或 lock-revision。**简单,复用 revision 表**;代价=History Center 会看到 lock 事件(可过滤)。
  - **(b) 独立 marker 表**:`meta_record_version_markers(record_id, version, kind)`。链外记「此 version 是 lock」。**不污染 revision 表**;代价=新表+双读。
  - **(c) lock/unlock 停止 bump version**:metadata-only,version 只跟数据变更 ⇒ 连续性==数据完整性,无需 marker。**最干净但改并发语义**(lock 的 CAS 依赖 version?须核 `:16403` 的 CAS 用途)——**风险最高,须证不破 lock 并发**。
- **推荐 (a)**(复用现有表 + 密链,History Center 过滤 lock 事件即可);(c) 若能证 lock 不依赖 version-bump 做 CAS 则更优,但须独立证。

### 1.3 派生字段不 bump version ⇒ 自动无洞(G-HI-3 免费绿)
formula/rollup/lookup/auto-number 物化写 `data` **不** bump version(`formula-engine.ts:345` 等)⇒ 不造 version 洞 ⇒ 连续性检查天然不误拒它们。§0.6 item 2 的「投影排派生」仍保留作**内容**比较的第二层(密链证连续 + 投影证内容一致,双层)。

### 1.4 持久化 trusted-since(历史过渡,owner「持久化 trusted-since」)
历史记录(本修复前)的 lock/unlock **无 marker** ⇒ 有真实旧洞,无法 retroactively 补。故:
- durable **`revision_trusted_since_version`**(每记录;或 per-sheet 水位)= 密链 regime 起点。重建到 T 可信 iff latest-rev-≤T 的 version ≥ trusted_since **且** [trusted_since, 该 version] 连续。
- **T 低于 trusted_since ⇒ fail-closed 拒绝**(不可证,宁拒)。**owner 决策 OD-W0-2**:历史区间 (a) 一律拒(最保守) (b) 对**全链连续**(从 v1 起无任何洞)的记录允许(那些从没 lock/uncaptured 过的记录可全程重建)。推荐 (b)——全链连续的记录可信,不必被水位一刀切拒。
- 迁移设置初值:上线时 `trusted_since = current version`(声明「从此密链」);**不追溯信任旧洞**。⚠️ 迁移排序 [[feedback_migration_zzzz_ordering]]:新列/水位迁移须 zzzz TS,fresh-DB 全量 migrate 验。

## §2 同锁事务 execute 复检(owner P1-B + #4235 gate P3-1)
execute 的复检 + 恢复写入须**同一事务 + `FOR UPDATE` scope 行**:进恢复事务 → `SELECT … FOR UPDATE` scope 记录 → **在锁内**跑连续性预检 → 若 incomplete 则 `HISTORY_INCOMPLETE` 回滚 → 否则恢复写。杜绝 check→write 窗口(现 #4235 的 FOR UPDATE + version-mismatch 只**部分**挡,gate P3-1 已指)。

## §3 验证义务(实现阶段,mutation-proven,对齐最终验收 #3)
- **healed-gap golden**(`/tmp/r13-w0-healed-gap-golden.txt`,现红):修后 revert+reset preview+execute 到 gap 窗 T ⇒ 409 + 零写;突变(去连续性检查)→ 红。
- **G-HI-2 lock/unlock 不误拒**(密链后:lock/unlock 有 marker ⇒ 无洞 ⇒ 通过);突变(去 lock-marker)→ G-HI-2 红。
- **G-HI-3 formula 不误拒**(不 bump version);保留。
- **并发竞态 golden**:check→execute-write 间落一次 uncaptured 写 ⇒ 同锁事务复检抓(真并发构造,非顺序论证 [[feedback_toctou_needs_constructed_race]])。
- **trusted-since golden**:T<水位 ⇒ 拒;全链连续记录 T<水位 ⇒(若 OD-W0-2=b)允许。
- 全链健康记录任意 T ⇒ 通过(正控,防 refuse-everything)。

## §4 OD 决策(owner ratify)
- **OD-W0-1**:lock-marker 方案 (a) 轻量 revision / (b) 独立表 / (c) lock 停 bump version。推荐 (a)。
- **OD-W0-2**:trusted-since 历史区间 (a) 一律拒 / (b) 全链连续者允许。推荐 (b)。
- **OD-W0-3**:trusted-since 粒度 per-record 还是 per-sheet 水位。推荐 per-record(精确;per-sheet 会因一条脏记录拒全表)。
- **OD-W0-4**:HISTORY_INCOMPLETE 是否**整操作拒**(现 §0.6 = 是)还是**逐记录跳过脏的**。§0.6/owner=整操作拒(最安全,不产半状态)——保持。

## §5 边界
- **〔Rev 1 边界，已达成〕**破坏性路径 + schema/行为变更按纪律走完:首刀经 5 轮 head-scoped 门禁 + 迁移排序 fresh-DB 验落地(#4269);#4235 已按裁定 CLOSED。**「W0 未成可信闭环前不启用更多恢复 flag」继续有效**(field-undelete flag = HOLD,§6.6)。
- 本锁是 W0 第一刀;5 刀 revision 写入(form/plugin/automation/approval/attachment)+ OD-6 guard(#4227)排其后。**W0 未成可信闭环前不启用更多恢复 flag。**

**收官口径(Rev 2)**:首刀(四件套)已 SHIPPED 于 #4269 并经 owner 复审 PASS;healed-gap 由 fail-first golden 钉死;**剩余 = C2→C3→C6(deferred,owner 定序)与 flag 启用(HOLD)**。

---

## §6 OWNER 裁决(2026-07-14)— 方向校准 + 首刀 scope + 延迟尾

owner 复审本锁 + #4252(C1–C8 验证)后裁决:**「不要做 global version-unique,要做 generation-aware contiguity + site disposition。同意改道。」** 逐字要点:

### §6.1 已裁的设计口径
- **OD-W0-1 = 显式 marker,覆盖 4 个 lock/unlock 站点**(非只 HTTP pair):HTTP `univer-meta.ts:16426`(lock)/`:16441`(unlock)+ **automation** `automation-executor.ts:3493`(lock)/`:3504`(unlock)。四者都是「版本递增但不写 revision」的**合法例外**,**必须显式 marker**——否则守卫会给未来维护者留下「已捕获」的错觉。
- **系统 sheet 排除走统一 predicate**,不散写站点豁免:`isSystemSheet(sheet) = isApprovalProjectionBaseId(base_id) || isSystemPeopleSheetDescription(description)`。**people directory sync 与 approval projection reprojection 是系统再生读模型**,不进用户历史完整性模型(它们合法地非连续)。
- **generation / vintage 模型(必进 spec + golden)**:`generation = count(create revisions at-or-before)`;**但 delete revision 可复用 last live version**,所以**不能用单调 version 唯一性推历史完整性**(C5 的实质)。这点后续实现极易写错,须钉死。
- **`recreateFieldFromConfig`(`:6522`)不得被吞成合法豁免**:它是**内容完整性**缺口,不是 version-contiguity 缺口。保留为 **flagged tail / OD-6 MUST-WRITE**(见 OD-6 守卫 #4251 的 `revision-pending` 具名追踪)。**本轮守卫绿不得掩盖它。**
- **trash-restore `source='rest'` vs 注释写 "restore"**:作**注释/测试口径修正**,勿让 spec 引用错事实。

### §6.2 首刀 scope(owner:「让实现只做这四件事」)
1. **generation-aware contiguity**(替换 #4234 的 live-vs-latest;精确集非 count,C1/C5)。
2. **4 个 lock/unlock markers**(§6.1,HTTP + automation)。
3. **统一 `isSystemSheet` 排除**(§6.1)。
4. **C8 same-txn + C4 fence**(execute 复检移入破坏性事务内、在 fence 后;C4 机制 SERIALIZABLE / sheet-lock / advisory 三选一,实现择安全者并证,若视为真 fork 回报 owner)。

### §6.3 延迟尾(**明标、不得被守卫绿掩盖**,与 recreateFieldFromConfig 同纪律)
owner「只做这四件」⇒ #4252 的以下条件**本刀不做,但显式 docket 为后续**,须在 OD-6/W0-1 报告里钉死:
- **C2 时间单调性**(`created_at`=txn-start,版本升序/时间降序可选错 T-snapshot)——本刀不解,报告标「已知残余:PIT 时间锚未证单调」。
- **C3 已删记录链的 healed-gap**(live-only 枚举漏 tombstoned resurrect)——本刀不解,标后续。
- **C6 trusted-since 锚 + 滚动上线协议**(checkpoint / 水位持久化 / 跨 regime 边界的旧实例写)——本刀不解,标后续。
- **C7 marker 词汇迁移**(`action CHECK` 只收 create/update/delete;若 marker 走轻量 revision 须迁 CHECK + 闭类型 + 同步 History UI/retention/reconstructor)——随本刀 marker 方案定,若采独立 marker 表则规避 C7。

### §6.4 验收锚(fail-first)
#4252 §6.1 的 **healed-gap 反例**(record v3、revisions 仅 {v1,v3}、live==v3 ⇒ revert-preview(T∈(v1,v3)) 必 **409**)= 本刀首个 fail-first golden。live-vs-latest 使其绿=证伪;contiguity 使其红→绿=证成。突变(去 contiguity)必红。

### §6.5 状态与授权
- **本锁仍非全 RATIFIED**——owner 裁的是**方向 + 首刀 4 项 scope 授权**;C2/C3/C6 延迟、其各自设计/机制未裁。
- **首刀实现:AUTHORIZED**(HOT-CORE + schema/txn ⇒ Opus 设计/门禁 + zzzz 迁移排序 fresh-DB 验 + mutation-proven goldens)。
- **#4234(已合的 live-vs-latest §0.6)= 部分守卫**,首刀落地后被 contiguity 取代/升级;在此之前它对 healed-gap **欠检**(如实,不掩盖)。**并行的 #4235(同款 live-vs-latest)按 #4252 建议关闭**(port 其 golden)。

### §6.6 owner 处置(2026-07-15,逐字生效)

- **整锁不整份翻 RATIFIED**。标记为:**首刀已授权并 shipped(#4269=`3356a7ed6`,owner 主线抽查复审 PASS)**;C2/C3/C6 **继续 deferred**,执行顺序 = **C2 → C3 → C6**(owner 定序)。
- **field-undelete flag = HOLD**:先启用并观察 tombstone capture,再做**非生产 flag-on** smoke(真值/链接/autoNumber 三类)。**现有 containment workflow 只核查 sheet-revert 与 PIT-reset,不能作为 config-undelete 的启用证据**。批量 revision 前置(#4299)已落但不改变 HOLD。
