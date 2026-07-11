# AI 字段 L0.5 · 租户级 live 闸 + 租户级配额主体 · 设计锁（RATIFIED）

> 状态：**RATIFIED（owner directive 2026-07-11；与 #3796 联批,排序条件满足）**。docs-only；不改 runtime、不发 live 请求、不翻任何生产 env。
> **RATIFIED — owner directive 2026-07-11**（批 12 把 merge-tree-clean 锁,与 #3796 联批）。header 由 owner 决定翻转、Claude 机械执行(非自我批准)。锁内 per-tier owner 子决定(env-cap/权限点亮)仍留待 owner。
> 前置 / 依据：**AI 点亮阶梯锁**（#3796 `multitable-ai-dark-to-ga-lighting-designlock-20260707.md` §3）**点名 L0.5 为"真单租户点亮"的 runtime 前置**。本锁把它展开。
> Ratify 排序：本锁与 #3796（现已 RATIFIED 2026-07-11）**联批完成**;排序条件(不先于 #3796)满足——L0.5 的存在理由定义于该锁 §3，不得先于它单独 ratify。
> 模型分档：设计 = Fable/Opus；runtime = Sonnet；点亮/权限相关 = Opus 对抗审阅。

## 1. 原则（为什么需要 L0.5）

点亮锁核实过的运行时现实（已 cite）：
- **live 闸是进程级全局**：`MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`（E-12）在 `ai-provider-client.ts:190` 做**全局 preflight**——设 1 = 该**部署内所有** caller 可 live，无法"只给一个租户开"。
- **配额主体是 per-caller**：`MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP` 名字含 tenant，但实际 subject = caller/user（inline `resolveRequestUserKey(req)` `routes/multitable-ai.ts:152`；bulk `subjectKey: ctx.userId` `ai-bulk-shared.ts:102`）——每个用户各吃一份，**不是 per-tenant 封顶**。

所以"只给某租户开 live、其它租户仍 DARK + 该租户额度隔离"这件事，**当前 runtime 做不到**。L0.5 就是补这条前置：**tenant-scoped live 闸 + tenant-level 配额主体**。有了它，点亮锁的 L1/L2/GA 才能谈"per-tenant"，否则只能 per-部署/per-caller。

> ⚠ 本锁的实现点需在 impl 时对当前 head 核实：E-12 preflight 的确切调用点与顺序、caller→tenant 的解析来源（**必须 trust-derived：服务端从已认证 principal 的持久化 org/tenant membership 解析，如 sheet→base→tenant 反解；禁止咨询 request 对象携带的 `tenantId`**——见 §3.6）、ledger 的 subject 键结构。本文定形状与不变式，不定实现。

## 2. 边界（L0.5 做什么 / 不做什么）

**做**：
- **tenant-scoped live allowlist/gate**：在进程级 E-12 之上**叠加**（layer on top of, **never replace**——不得替换/绕开 E-12 的消费点，`ai-provider-client.ts:190-195`），加一层**每租户开关/allowlist**——请求 live 前解析 caller 的 tenant，仅当该 tenant 在 allowlist 才放行 live；否则 DARK（走既有 dark/dry 路径）。E-12 仍是**总 kill-switch**（关 = 全体零 live，语义不变）。
- **tenant-level 配额主体（可选叠加）**：让 cap 的 reserve/settle 能以 **tenant** 为 subject（不止 per-caller）——即租户内所有 caller 共吃一份 tenant 日额度 + USD 账户额度。per-caller cap 保留（可与 tenant cap 叠：min(caller, tenant, account)）。
- **fail-closed 默认 DARK**：新租户 / 未 allowlist 的租户 → 默认 DARK，点亮是显式 allowlist 入册（不默认继承）。

**不做（各自 ring / 上层锁）**：
- 不定"点亮节奏 / cap 数值 / 哪个 canary 租户"——那是点亮锁 §6 的 owner 决策。
- 不新增 provider / 不改 provider 白名单 / 不碰输出不可信隔离（正交）。
- 不做跨租户共享额度池（demand-gated）。
- **不改中央 rbac/auth（K3）**：L0.5 只 **consume**（读取）既有认证 principal 与 org/tenant membership 的解析结果，**不 modify** 认证/权限层本身。

## 3. 硬闸门（不变式）

1. **E-12 仍是全局 kill-switch**：关 E-12 = 全体零 live（L0.5 不削弱这个；tenant allowlist 只在 E-12 开时再收窄到 allowlist 租户）。
2. **fail-closed**：tenant 解析失败 / 未 allowlist → **DARK**（不放行 live），不"默认放行"。
3. **配额 fail-closed 叠加**：live 前 reserve；超 caller **或** tenant **或** account 任一 cap → 拒（min 语义，不透支）。
4. **provider 白名单 / 输出不可信 / reserve-then-settle 账本** 一律不变（L0.5 只加 tenant 维度,不动这些）。
5. **可观测**：per-tenant + per-caller 双维度用量 + allowlist 状态可查。
6. **tenant 身份必须 trust-derived（HARD）**：live-gate key 与 tenant quota subject 所用的租户身份，必须由服务端从**已认证 principal 的持久化 org/tenant membership** 解析（如 sheet→base→tenant 反解）。`req.user.tenantId` 在 JWT 缺 tenant claim 时由 `x-tenant-id` 请求头回填（`jwt-middleware.ts:112-115`），属客户端可控输入，**禁止用作 live-gate key 或 quota subject**——与既有账本规则一致并扩展之（`ai-usage-ledger.ts:11-14`：header-backfilled tenantId is **FORBIDDEN** as a quota subject；本锁把同一禁令延伸到 live-gate key）。
7. **tenant cap 在锁内 seam 强制**：tenant cap 必须在 `withAiUsageQuotaLock`（`ai-usage-ledger.ts:232-242`）锁内的 `checkAiUsageQuota` seam（`ai-usage-ledger.ts:203`，经 `reserveAiUsage` `ai-usage-ledger.ts:296/309`）强制，**不得**只做锁外 pre-check（bulk 路径的锁外 `sumAiUsageWindows` 预检 `routes/multitable-ai.ts:911` 是 refuse-early 的补充，不是强制点）。无需新增锁：全局 `'__instance__'` advisory lock（`ai-usage-ledger.ts:238`，键定义 `ai-usage-ledger.ts:47`）已序列化跨 caller 的聚合。

## 4. 门禁（TODO-checklist）

- 🔒 **L0.5-1 tenant 解析 + allowlist 闸**（caller→tenant 解析 seam 按 §3.6 trust-derived + tenant allowlist 读；live-preflight 收窄；E-12 关仍全局零 live）+ real-DB golden（allowlist 内→放行 / allowlist 外→DARK / E-12 关→全体零 live 的负向断言 / **§5 的 tenant-header 伪造负向 golden**）— 待本锁 ratify；Sonnet；Opus 审。
- 🔒 **L0.5-2 tenant-level 配额主体**（ledger subject 支持 tenant，subject 解析按 §3.6；min(caller,tenant,account) 叠加 fail-closed；强制点按 §3.7 在锁内 seam）+ golden（tenant cap 触顶→拒；多 caller 共吃 tenant 额度；**并发 tenant-cap golden：并行 reserve 不得越过 tenant cap**）— L0.5-1 后；Sonnet。
- 🔒 **不做**：跨租户共享池 / provider 扩展（各自立项）。

## 5. 验证纪律
每 slice 双 MD；tenant allowlist golden（内/外/E-12-off 三态负向断言）；tenant 配额叠加 golden（min 语义 + fail-closed）；**tenant-header 伪造负向 golden（fail-closed 断言）**：trust-derived 归属为**非 allowlist** 租户的已认证 caller，其请求携带指向 allowlisted/live 租户的 `x-tenant-id` 头 → live 闸**不**放行（仍 DARK）、被指租户的 quota **不**记账——判定与记账均以 §3.6 的服务端 trust-derived 身份为准，header 值不参与；**并发 tenant-cap golden**：并行请求下 tenant cap 不透支（强制点=§3.7 锁内 seam）；证明"点亮锁 L1/L2 的 per-tenant 承诺在 L0.5 落地后才成立"（点亮锁 §2.1/§3 已写"没 L0.5 只能 per-部署"）。

## 6. 一句话
点亮锁点名的前置：现在 live 闸全局、配额 per-caller，做不到"单租户点亮"。L0.5 加 **tenant allowlist 闸**（E-12 开时再收窄到入册租户，E-12 仍是总 kill-switch）+ **tenant 级配额主体**（min(caller,tenant,account) 叠加 fail-closed），默认 DARK、fail-closed、不动 provider/输出隔离。有了它,点亮锁才能真按租户逐个点。
