# W0-1 — `HISTORY_INCOMPLETE` 可信性纠错：连续性 + trusted-since + 同锁事务 — DESIGN LOCK (PROPOSED)

- **Status**: **PROPOSED — 2026-07-13. NOT ratified. Design-first, ZERO 运行时改动。** owner 复审判 §0.6 现草案(#4235)「**不能安全落地**」——本锁把 §0.6 从 live-vs-latest 升级为**连续性证明**。**破坏性恢复路径 + 需 schema/行为变更**,故按 owner 一贯纪律(D-1c/D-2/4c-*/R13-C)**design-lock first,ratify 后才动**。W0 顺序门的第一刀,gate 一切 revision 5 刀之前。
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
- **零运行时改动**;破坏性路径 + schema/行为变更 ⇒ **ratify + 迁移排序纪律**后才实现。**#4235 在本纠错落地前不合**(现 comparator 漏 healed-gap;owner「不能安全落地」)。
- 本锁是 W0 第一刀;5 刀 revision 写入(form/plugin/automation/approval/attachment)+ OD-6 guard(#4227)排其后。**W0 未成可信闭环前不启用更多恢复 flag。**

**收官口径**:design-only;§0.6 升级为连续性证明的设计已锁,healed-gap 已实证;实现待 owner ratify OD-W0-1..4 + 迁移排序验。这是 owner「先把 W0 做成可信闭环」的第一刀设计。
