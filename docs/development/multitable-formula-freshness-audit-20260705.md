# W1-1 formula freshness / live-reactive AUDIT — 2026-07-05

> Grounded on origin/main @ `8fe64904a`;**行锚 2026-07-05 复核并刷新 @ `f06d0eb70`**(逐处重读核对,非机械改号)。Audit-only,零仓库改动。
> 背景事实(已验,不再重复论证):REST 写脊柱 Step 4c 公式重算存在(`record-write-service.ts:1260-1269`,经 `h.recalculateFormulaFields` 物化回写 + 响应/实时刷新);单记录 restore 走 canonical spine 重算(`univer-meta.ts:8903` 注释)。公式 = **写时物化**(Step 4c 注释:"Unlike lookup/rollup (computed-on-read), formula values are materialized")——因此"谁的写路径跳过重算,谁就留下持久 stale 值"是本审计的判定标准。

## Q1 — Yjs bridge 边界 【verdict: GAP(蓄意留置,注释自认 "for now")】★headline

协作编辑路径**结构上走了 patchRecords,但 Step 4c 被存根击穿**:

- bridge 写确实经 `RecordWriteService.patchRecords()`(`collab/yjs-record-bridge.ts:5,44`:"writes via RecordWriteService.patchRecords() — the authoritative write path";实际调用 :226),input 带 `source:'yjs-bridge'`(:2492)、真实 capabilities("Resolve real user capabilities — same path as REST",:2471)、真实 `isFieldAlwaysReadOnly` guard(input 构造回调 `index.ts:2419-2492`)——授权面无缺口。
- 但 bridge 侧的 RecordWriteService 用**存根 helpers** 构造(`index.ts:2384-2414`):`recalculateFormulaFields: async () => []`(:2405),且 `applyLookupRollup`/`computeDependentLookupRollupRecords` 同为空存根(:2400-2401)。注释原话(:2402-2404):**"Yjs-bridge writes intentionally skip computed-field recompute … formula recalc stays scoped to the REST PATCH path for now and is stubbed here for the same reason."**
- 后果:协作编辑一个公式的源字段后,该记录的公式物化值**保持旧值**,直到该记录下一次 REST 写触发 Step 4c;同时(fan-out 存根)跨记录 FOL 传播在协作路径上也完全不发生。lookup/rollup 因是读时计算,协作路径上仅"echo 缺失",不留持久错值——公式是唯一留持久 stale 的类别。
- 缓解现状:无(读路径不重算公式;无定时补算)。

## Q2 — restore/PIT 边缘覆盖 【verdict: PARTIAL(两类机制并存,边界清晰)】

| 路径 | 写机制 | Step 4c? | 证据 |
|---|---|---|---|
| 单记录 restore-execute | canonical spine `patchRecords(source:'restore')` | ✅ | univer-meta.ts:8903-8919 |
| 批量 restore-batch-execute | 真 helpers(`createRecordWriteHelpers(req,pool)`)+ 整 map 单次 patchRecords | ✅ | route :9098;真 helpers :9190 |
| revert-execute(T8-1)已存在记录 | 逐记录 `patchRecords(source:'restore')` | ✅ | :9537-9551 |
| revert 内 **undelete(复活)** | **raw `INSERT INTO meta_records`**(快照整行) | ❌(无重算) | :9514(INSERT … VALUES … snapshot,route :9459) |
| **reset-execute(T8-2 Reset-to-T)** | **raw `UPDATE meta_records`**(as-of-T 重建值整写) | ❌(无重算) | :9688/:9696 |

raw 路径的语义辩护与残留:undelete/reset 写入的是 **T 时刻自洽**的物化值(行内公式与行内依赖同刻一致)——按 PIT 语义这是"正确的旧值"。真正的 stale 边界有二:(a) 公式**表达式配置在 T 之后改过**(config revisions 不随 reset 回滚)→ 物化值反映旧表达式,直到该记录下次写;(b) 公式经 lookup 读**未被 reset 的外表**(跨表 FOL)→ 值反映 T 时刻外表状态而非当前。二者均为 PIT 语义固有张力,非实现 bug,但**当前无任何补算机制兜底**。

**Q2-c(配置变更侧,连带发现):公式表达式变更本身不触发存量重算。** `PATCH /fields/:fieldId`(route :10481)改 `property.expression` 只做验证 + 依赖追踪(update 路径 :10615 validateFormulaReferences;:10619-10621 findFormulaReferrers 反向 guard),**无 sheet 级存量记录重算**;全仓 `recalculateFormulaFields` 仅 3 个调用位(def :2766、fan-out 内 :3688、helpers 工厂 :4231-4232),不存在任何 bulk-recompute 入口。因此:改表达式(正向编辑或 config-tier revert 恢复旧表达式)后,所有存量记录的物化值保持旧表达式的结果,逐记录在各自下次写时才刷新。这是与 Q1 同级的**定义性 staleness**。

## Q3 — 跨记录/多跳传播 【verdict: PARTIAL(一跳物化,≥2 跳不级联;环在配置期被禁)】

- (a) **一跳是真物化,不只失效**:Step 4(`record-write-service.ts:1165-1182`,注释明言 "propagates this PATCH **one hop** into the related records' formulas")经 `computeDependentLookupRollupRecords`(univer-meta.ts:3521 起)计算受影响关联记录,并**持久化**:`UPDATE meta_records SET data = data || $1::jsonb …`(:3724,注释 "system relation-aggregation fan-out materialization — derived value, no user actor");随后 FOL-1 失效广播(:1196-1251)让各端重取。taint-skip 先行(:3702 注释)防掩码泄漏。
- (b) **跳数 = 恰好 1**:持久化用 raw UPDATE(非 patchRecords)→ 不re-enter Step 4 → S→R 新鲜,R→T(T 的公式经另一 lookup 读 R 的公式)**不级联**,T 保持 stale 直到 T 或其邻接被写。
- (c) **环 guard 在配置期**:formula→formula 边在字段定义时即被拒(`validateFormulaReferences` + 反向 guard `findFormulaReferrers`,univer-meta.ts:10608-10621 区域)——运行时不会形成公式环;一跳+禁环组合下无失控风险,代价是 ≥2 跳链条的新鲜度无保证。

## Q4 — on-save vs live-reactive 【verdict: NO GAP(现状即口径),产品问题待 owner 表态】

- FE **无任何客户端公式求值**:`apps/web/src` 内 `evaluateFormula|hyperformula|formulajs` 零命中;公式列为服务端物化值的只读渲染。确认"写时新鲜、输入过程无预览"是当前的真实且一致的产品口径,不是实现遗漏。
- 给 owner 的产品问题(本审计不代答):**on-save 新鲜度是否足够?** 若要 typing-time 预览,需引入客户端表达式引擎(许可证注意:HyperFormula 为 GPL/商业双许可,见 2026-05-26 OSS 对比)或服务端 preview 端点——两者都是独立立项级别,不建议捎带。

## 设计锁需要锁什么(仅真开放项)

1. **Yjs 路径公式重算**(Q1,headline):三个候选姿态需 owner 选一——(a) bridge 侧接真 `recalculateFormulaFields`(难点:helpers 需 req 上下文,bridge 无 req;需抽出 req-free 版本);(b) bridge flush 后补一发系统级重算(复用 :3724 的 derived-value UPDATE 姿态);(c) 接受 stale 并在 UI 标注"协作编辑后公式延迟刷新"。锁里必须含 golden:协作写源字段 → 公式物化值刷新(或明确锁定不刷新语义)。
2. **表达式变更的存量重算**(Q2-c):是否提供 bulk-recompute(同步?异步 job?按 sheet 规模分档?)或明确锁定"新表达式只对后续写生效"并在字段编辑 UI 提示。与 config-tier revert 共用同一决定。
3. **多跳链新鲜度**(Q3-b):锁定"一跳物化 + 禁环"为正式合同(推荐,现状已自洽)并写进产品文档,或立项 N 跳传播(不推荐,复杂度/成本高)。
4. PIT 语义注记(Q2):undelete/reset 的 T-自洽值 + 两条固有 stale 边界,建议仅作**文档化锁定**(非代码改动)。

**建议**:Q1 + Q2-c 合并为一个 "formula freshness" design-lock(两者共享"何时重算"的同一决策轴);Q3/Q4/PIT 作为锁内的明示非目标/文档化条款。audit 不支持"无锁直接关闭"——Q1 是真实且蓄意留置的缺口,值得一个 slice。
