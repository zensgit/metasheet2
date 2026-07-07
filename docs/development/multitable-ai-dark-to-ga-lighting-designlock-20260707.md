# 多维表 AI 字段 DARK → GA 点亮阶梯 · 设计锁（PROPOSED）

> 状态：**PROPOSED — 待 owner ratify**。本锁只定「怎么从 DARK 安全地分档点亮到 GA」的阶梯与闸门，**不翻任何生产 env、不发起任何 live 请求**。真正点亮的节奏、金额上限、canary 环境、指定测试 actor(s) 与 cap 由 owner 在每一档显式拍板。
> 前置（均已落 main）：AI provider readiness A1（DARK，无 live 路径）· usage ledger（reserve-then-settle）· S1 写入血缘 + 批次分组 · S2 prompt-config history · AI 输出=不可信写入源 design-lock（`multitable-ai-output-untrusted-write-source-designlock-20260705.md`）· bulk-fill preview→review→commit。
> 模型分档：阶梯/闸门设计 = Fable；每档的观测/回滚/账本核对实现 = Sonnet；点亮前的对抗审阅 = Opus。

## 1. 原则：价值已造好，但还锁在 DARK 里

S1/S2 把 AI 字段的**审计价值**都建齐了——写入血缘、批次分组、prompt-config 历史、成本账本、输出不可信隔离。但这些价值的兑现有一个前提：**AI 字段目前是 DARK 的**——`AI_PROVIDER_READINESS` A1 只搭好了 provider 契约，**没有 live 调用路径**（readiness 报告在 `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`（E-12）设与不设时字节一致）。真正让用户用上 AI（summarize/classify/extract/translate、bulk-fill），需要点亮 M2 的 live 请求路径。

**但"点亮生产 AI"= 花真钱 + 输出可能有害 + 不可逆的外呼**——所以它不能是"翻一个 flag"，必须是**一条可观测、可回滚、逐档放量的阶梯**，每一档由 owner 显式拍板。本锁定义这条阶梯与它的硬闸门。

## 2. 已有的控制底座（不重造，本锁只是把它们编成阶梯）

| 控制 | env / 机制 | 作用 |
|---|---|---|
| master 开关 | `MULTITABLE_AI_ENABLED` | 全局启停 |
| **live 闸（点亮开关）** | `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`（E-12） | **进程级全局** preflight（`ai-provider-client.ts:190`）；设 1 = 该**部署内所有**通过 auth/feature 的 live 请求可 live（**不是**单租户开）；关 = 零 live 调用（= kill-switch，进程级瞬时回 DARK） |
| 账户/实例日 USD 上限 | `MULTITABLE_AI_ACCOUNT_DAILY_USD_CAP`（E-11） | 全账户/实例封顶（进程级） |
| **per-caller** 日 token 上限 | `MULTITABLE_AI_TENANT_DAILY_TOKEN_CAP`（名字含 "tenant" 但**实际是 per-caller**） | quota subject = **caller/user**（inline: `resolveRequestUserKey(req)` `multitable-ai.ts:152`；bulk: `subjectKey: ctx.userId` `ai-bulk-shared.ts:102`）→ 每个用户各吃一份，**非 per-tenant 封顶** |
| provider 白名单 | anthropic / openai（P-1 ratified） | 其余 provider 阻断 |
| 成本账本 | usage ledger（reserve-then-settle） | 成本真相源；先预留、后结算 |
| 输出隔离 | AI 输出 = 不可信写入源 design-lock | 输出永远走不可信写入路径（不绕过校验/权限） |
| 上线人工闸 | bulk-fill preview→review→commit | 批量写入前人工复核 |

### 2.1 运行时现实（更正一个 scoping 假设 — owner review #3796 抓出）
**当前 runtime 没有 tenant-scoped live gate。** E-12 是进程级全局开关，cap 的 subject 是 caller/user——**不是 tenant**。所以：
- **点亮的最小粒度是「部署/环境」，不是「租户」**：在某部署开 E-12，该部署里所有通过 auth/feature 的 caller 都可能 live；无法"只给一个租户开、其它租户仍 DARK"。
- **"per-tenant 隔离/per-tenant cap" 目前不存在**——要做真正的单租户点亮，需要先加 runtime（见下 §3 的 🔒 L0.5）。本锁的 canary/limited 因此以**环境 + 指定 actor + per-caller cap** 为准，不是"单租户"。

## 3. 点亮阶梯（每档独立 gate，owner 逐档拍板）

- **L0 — DARK（现状）**：A1 built，无 live 路径，E-12 报告字节无关。**不需要动作**，这是安全默认。
- 🔒 **L1 — CANARY（隔离环境 + 指定 actor，最小放量）**：在一个**独立的 canary 部署/环境**（不是生产、不是"某个租户"）开 E-12；只让**指定测试 actor(s)** 走 live；设**紧的** per-caller token cap + instance/account USD cap。**验证目标**（这一档的验收）：(a) reserve-then-settle 账本与 provider 实际用量对得上（成本真相无漂移）；(b) cap 触顶 = fail-closed（预留超 cap → 拒绝，绝不透支）；(c) AI 输出走不可信写入路径（不绕权限/校验）；(d) 成本/错误率/延迟 telemetry 有数。**kill-switch 演练**：E-12 关 → 立即回 DARK、零 live 调用。
- 🔒 **L2 — LIMITED（扩到小批指定 actor / beta 队列，仍在隔离环境）**：在同一隔离环境把 live 扩到**一小组指定/opt-in 的 caller**；**cap 触顶告警 + 错误率告警**上线。**注意**：因为闸是进程级、cap 是 per-caller，L2 不能给"per-tenant 隔离"承诺——它是 per-caller 放量、不是多租户隔离。真正的多租户隔离点亮见 L0.5。
- 🔒 **L0.5 —（可选 runtime 前置，仅当你要"单租户点亮"时才做）**：现有 runtime **没有** tenant-scoped live gate，E-12 全局、cap per-caller。若你要"只给某租户开 live、其它租户仍 DARK + per-tenant 额度隔离"，需先加 runtime：**tenant-scoped live allowlist/gate** + **tenant-level quota subject**。这是一条独立的 runtime 切片（Fable 设计 → Sonnet 实现 → Opus 审），**在它落地前，所有档只能 per-部署/per-caller，不能 per-tenant**。
- 🔒 **L3 — GA（生产广泛启用）**：常态 per-caller token cap + instance/account USD cap；对**高成本操作**（大批 bulk-fill）保留 double-confirm UX；kill-switch（E-12 off）作为标准回滚手段常备。（若在此之前做了 L0.5，GA 可带 per-tenant 额度；否则 GA 是全实例 per-caller 封顶。）

## 4. 硬闸门（点亮全程必须成立，任何一条破了就回 DARK）

1. **kill-switch 即时性**：`MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` 关闭 → 下一个请求起零 live 调用（回 DARK）；不缓存"已点亮"状态。
2. **cap fail-closed**：任何 live 调用前先在 ledger reserve；reserve 会让 instance/account 或 **per-caller**（当前 quota subject）当日超 cap → **拒绝该调用**，不透支、不"先花再说"。
3. **provider 白名单**：只 anthropic/openai；配置成其它 = 阻断，不 fallback。
4. **输出不可信**：live 产出永远走不可信写入源路径（字段掩码/权限/校验不被 AI 绕过）——这是既有 lock，本锁只是重申它在 lit 状态下仍成立。
5. **账本 = 成本真相**：所有计费以 usage ledger 为准；reserve-then-settle 不得有"结算丢失"的路径（否则成本不可信 → 不得进下一档）。
6. **DARK 默认**：新环境/新租户默认 E-12 off（DARK）；点亮是显式 opt-in，不是默认继承。

## 5. 观测与回滚（每档前置）

- **观测**：per-caller token/USD 当日用量（当前 quota subject；per-tenant 聚合需 L0.5）、reserve-vs-settle 差、错误率、延迟、cap 触顶次数——L1 起必须有 dashboard/telemetry。
- **回滚**：kill-switch（E-12 off）= 一等回滚，任何一档都能瞬间回 DARK。cap 触顶 = 自动节流（拒绝新 reserve），不需人工。
- **事故**：成本异常/输出有害 → 关 E-12 回 DARK + 查账本 + 复盘，再决定是否回该档。

## 6. 需要 owner 拍板的（这就是 gate）

1. **批准这条阶梯**（L0→L1→L2→L3 的形态与闸门）。
2. **L1 的 canary 环境 + 指定测试 actor(s) + cap 数值**（instance 日 USD、per-caller 日 token）——点亮 L1 的必要输入，只有 owner 能给。（若要"单租户点亮"，先决定是否做 §3 的 🔒 L0.5 runtime 前置——现有 runtime 没有 tenant-scoped gate。）
3. **GA（L3）的 double-confirm UX 范围**（哪些操作要二次确认）。
4. 每一档 → 下一档的**放行**：上一档验收（§3 各档验证目标）全绿 + 无成本/输出事故，owner 显式说进下一档，才动 env。

## 7. 门禁（TODO-checklist）

- 🔒 **L1-canary**：owner 给 canary **环境 + 指定 actor** + cap 后 → 在**隔离环境**开 E-12 + 上 telemetry + 跑 §3-L1 四项验证 + kill-switch 演练 → 交验证 MD。Sonnet 实现观测/账本核对，Opus 点亮前对抗审阅。
- 🔒 **L2-limited**：L1 验收后 → 隔离环境内扩到小批指定/opt-in caller + cap 触顶/错误率告警（per-caller 放量，非 per-tenant 隔离）。
- 🔒 **L0.5（可选 runtime 前置）**：tenant-scoped live allowlist/gate + tenant-level quota subject —— **仅当 owner 要 per-tenant 点亮时才做**，是 L1/L2/GA 的 per-tenant 版前置；在它落地前所有档只能 per-部署/per-caller。
- 🔒 **L3-GA**：L2 稳定后 → 常态 per-caller cap + instance USD cap + 高成本 double-confirm UX + kill-switch 常备（带 per-tenant 额度需先 L0.5）。
- 🔒 **明确不做（本锁外，各自立项）**：新 provider 接入、模型自选、AI agent 编排、跨租户共享额度池。

## 8. 一句话

AI 的审计/成本/血缘价值都造好了，只差**安全地点亮**。本锁不翻任何生产开关，而是把既有的 kill-switch（E-12）+ USD/token 双 cap + provider 白名单 + reserve-then-settle 账本 + 输出不可信隔离，编成一条 **DARK→canary→limited→GA 的逐档放量阶梯**——每一档 owner 拍板、可观测、kill-switch 一键回 DARK。点亮节奏与金额永远在 owner 手里。
