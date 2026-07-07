# AI 字段 L0.5 · 租户级 live 闸 + 租户级配额主体 · 设计锁（PROPOSED）

> 状态：**PROPOSED — 待 owner ratify**。docs-only；不改 runtime、不发 live 请求、不翻任何生产 env。
> 前置 / 依据：**AI 点亮阶梯锁**（#3796 `multitable-ai-dark-to-ga-lighting-designlock-20260707.md` §3）**点名 L0.5 为"真单租户点亮"的 runtime 前置**。本锁把它展开。
> 模型分档：设计 = Fable/Opus；runtime = Sonnet；点亮/权限相关 = Opus 对抗审阅。

## 1. 原则（为什么需要 L0.5）

点亮锁核实过的运行时现实（已 cite）：
- **live 闸是进程级全局**：`MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`（E-12）在 `ai-provider-client.ts:190` 做**全局 preflight**——设 1 = 该**部署内所有** caller 可 live，无法"只给一个租户开"。
- **配额主体是 per-caller**：`MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP` 名字含 tenant，但实际 subject = caller/user（inline `resolveRequestUserKey(req)` `routes/multitable-ai.ts:152`；bulk `subjectKey: ctx.userId` `ai-bulk-shared.ts:102`）——每个用户各吃一份，**不是 per-tenant 封顶**。

所以"只给某租户开 live、其它租户仍 DARK + 该租户额度隔离"这件事，**当前 runtime 做不到**。L0.5 就是补这条前置：**tenant-scoped live 闸 + tenant-level 配额主体**。有了它，点亮锁的 L1/L2/GA 才能谈"per-tenant"，否则只能 per-部署/per-caller。

> ⚠ 本锁的实现点需在 impl 时对当前 head 核实：E-12 preflight 的确切调用点与顺序、caller→tenant 的解析来源（req 上是否已有 tenantId / 从 sheet→base→tenant 反解）、ledger 的 subject 键结构。本文定形状与不变式，不定实现。

## 2. 边界（L0.5 做什么 / 不做什么）

**做**：
- **tenant-scoped live allowlist/gate**：在进程级 E-12 之上（或替换其消费点），加一层**每租户开关/allowlist**——请求 live 前解析 caller 的 tenant，仅当该 tenant 在 allowlist 才放行 live；否则 DARK（走既有 dark/dry 路径）。E-12 仍是**总 kill-switch**（关 = 全体零 live，语义不变）。
- **tenant-level 配额主体（可选叠加）**：让 cap 的 reserve/settle 能以 **tenant** 为 subject（不止 per-caller）——即租户内所有 caller 共吃一份 tenant 日额度 + USD 账户额度。per-caller cap 保留（可与 tenant cap 叠：min(caller, tenant, account)）。
- **fail-closed 默认 DARK**：新租户 / 未 allowlist 的租户 → 默认 DARK，点亮是显式 allowlist 入册（不默认继承）。

**不做（各自 ring / 上层锁）**：
- 不定"点亮节奏 / cap 数值 / 哪个 canary 租户"——那是点亮锁 §6 的 owner 决策。
- 不新增 provider / 不改 provider 白名单 / 不碰输出不可信隔离（正交）。
- 不做跨租户共享额度池（demand-gated）。

## 3. 硬闸门（不变式）

1. **E-12 仍是全局 kill-switch**：关 E-12 = 全体零 live（L0.5 不削弱这个；tenant allowlist 只在 E-12 开时再收窄到 allowlist 租户）。
2. **fail-closed**：tenant 解析失败 / 未 allowlist → **DARK**（不放行 live），不"默认放行"。
3. **配额 fail-closed 叠加**：live 前 reserve；超 caller **或** tenant **或** account 任一 cap → 拒（min 语义，不透支）。
4. **provider 白名单 / 输出不可信 / reserve-then-settle 账本** 一律不变（L0.5 只加 tenant 维度,不动这些）。
5. **可观测**：per-tenant + per-caller 双维度用量 + allowlist 状态可查。

## 4. 门禁（TODO-checklist）

- 🔒 **L0.5-1 tenant 解析 + allowlist 闸**（caller→tenant 解析 seam + tenant allowlist 读；live-preflight 收窄；E-12 关仍全局零 live）+ real-DB golden（allowlist 内→放行 / allowlist 外→DARK / E-12 关→全体零 live 的负向断言）— 待本锁 ratify；Sonnet；Opus 审。
- 🔒 **L0.5-2 tenant-level 配额主体**（ledger subject 支持 tenant；min(caller,tenant,account) 叠加 fail-closed）+ golden（tenant cap 触顶→拒；多 caller 共吃 tenant 额度）— L0.5-1 后；Sonnet。
- 🔒 **不做**：跨租户共享池 / provider 扩展（各自立项）。

## 5. 验证纪律
每 slice 双 MD；tenant allowlist golden（内/外/E-12-off 三态负向断言）；tenant 配额叠加 golden（min 语义 + fail-closed）；证明"点亮锁 L1/L2 的 per-tenant 承诺在 L0.5 落地后才成立"（点亮锁 §2.1/§3 已写"没 L0.5 只能 per-部署"）。

## 6. 一句话
点亮锁点名的前置：现在 live 闸全局、配额 per-caller，做不到"单租户点亮"。L0.5 加 **tenant allowlist 闸**（E-12 开时再收窄到入册租户，E-12 仍是总 kill-switch）+ **tenant 级配额主体**（min(caller,tenant,account) 叠加 fail-closed），默认 DARK、fail-closed、不动 provider/输出隔离。有了它,点亮锁才能真按租户逐个点。
