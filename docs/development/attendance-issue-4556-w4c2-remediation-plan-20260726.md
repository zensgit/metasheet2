# W4C-2 Remediation Plan（PR #4612 门审 findings 的修复设计）

> Status: **PLAN**（docs-only）。**不授予授权、不改任何 runtime、不构成合并请求。**
>
> Date: 2026-07-26 · 对象：PR #4612 @ `b54396b2899c0e188a27916975fb171814c37002` 的门审判定
> （REQUEST_CHANGES，记录 #4612 `c-5082182541`）
>
> **前置**：本计划的**执行**受 #4595 `AUTOMATION HOLD` 约束，需 owner 亲笔恢复授权后方可开工。
> 本文件只做设计与后果分析，使解锁后是「执行」而非「设计」。

## 0. 待修清单与模型分配

| # | Finding | 性质 | 阻塞 | 实现模型 |
| --- | --- | --- | --- | --- |
| P1-2 | scheduled 侧 outbox cutover 缺失 | 功能缺失 | **需 owner 先裁形状（G-2）** | Sonnet（事务/outbox 语义） |
| P1-1 | legacy 响应体字节不变红线只钉顶层 key 名 | 判别力缺失（纯测试） | 无 | Sonnet |
| P1-3 | `legacyArgs` 路由预算穿过事务 | 合同违反 | 无 | Sonnet（身份/事务边界） |
| P1-4 | `admin_run` 冒充内部 scheduler | 授权语义 | 无 | Sonnet（身份授权） |
| P2-1 | scheduler 授权豁免的「窄」零测试 | 判别力缺失（纯测试） | 无 | Fable（fixture） |
| NIT | 呈裁点 20 的错误论断（3 处文本） | 文档 | 无 | Fable |

模型分配按外部复核建议：**canonical boundary / 身份授权 / 事务与 outbox 语义 → Sonnet；collector / fixture / CI 接线 → Fable；独立门审 → Opus。**

---

## 1. G-2（**必须 owner 先裁**）：P1-2 的修法形状

### 1.1 事实基础（读码所得，非推断）

- **live 侧**：每次打卡 = 一个 per-user operation，emit `attendance.punched` 一条 ⇒ **事件与 operation 天然 1:1**，故 `w4c2-live-scheduled-boundary.ts:937` 可以在 seal 前直接 `enqueueAttendanceResultEventOutboxV1(trx, identity, [...])`。
- **scheduled 侧**：`runAutoAbsenceForOrgDate` 一次运行产出 N 条 per-user 缺勤记录，但只 emit **一条 run 级**事件（`index.cjs:21565`，payload = `{orgId, workDate, total: rows.length}`）⇒ **1 事件 : N operation**。
- **outbox API 形状**：`enqueueAttendanceResultEventOutboxV1(trx, identity, events)` 的 `identity` 经 `requireVerifiedAttendanceOperationIdentityV1` 强校验 ⇒ **outbox 行必须挂在某个 verified operation identity 上**；且 `legacy_projection_only` 姿态下调用即 `W4C0_OUTBOX_LEGACY_FORBIDDEN`（fail-closed）。

⇒ 「把 live 的写法照抄到 scheduled」在类型层就不成立。这就是它当初被漏掉的结构性原因，也是必须 owner 裁形状的原因。

### 1.2 三条路与后果（中性陈述）

| 路 | 做法 | 代价 / 后果 |
| --- | --- | --- |
| **(a) per-user outbox** | 每个 per-user operation 各自 enqueue 一条事件 | **改变外部事件语义**：一条 run 级聚合事件 → N 条 per-user 事件。所有 `attendance.absence.generated` 消费者受影响（`total` 字段失去意义）。需要新 event kind 还是复用同名？复用即**破坏 wire 合同**；新建则要进 `ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1` 闭集并同步消费侧。**耐久性最强**（每条结果都有自己的投递保证）。 |
| **(b) run 级 outbox** | 引入一个 run 级锚（run 级 operation 或对 outbox 放宽 identity 约束），挂一条聚合事件 | **保持外部事件语义不变**（消费者零改）。代价：需要一个「run 级 operation」概念——当前 §7.1 的 operation 是 batch/item 二元且绑 per-user target；要么新增第三类 kind（**锁 §7.1 合同变更 ⇒ 可能需 amendment**），要么放宽 outbox 的 identity 校验（**削弱 W4C-0 刚建立的 verified-identity 不变量**，且 K11 类的「窄性」问题会重演）。 |
| **(c) §7.1a 合同豁免** | 明文把 run 级生命周期事件排除在 outbox 耐久合同之外，scheduled 侧保留同步 emit 但**照 live 侧收窄到 legacy 姿态**（或保留全姿态同步 emit 并明文声明其 best-effort） | 改动最小、无 wire 变更。代价：**scheduled 侧的事件不具备 crash-after-commit-before-emit 的投递保证**——这正是 §7.1a 要解决的问题，等于对该面**明文降级**。必须写清「哪些事件是耐久的、哪些是 best-effort」，否则 W4C-5 soak 与后续片会重蹈同一含混。 |

### 1.3 本车道的中立观察（不替 owner 选）

- (a) 是唯一同时满足「耐久」与「不动 §7.1 operation 合同」的路，但**代价落在外部 wire**。
- (b) 语义最保守，但代价落在**刚建立的身份不变量**上，且很可能触发 amendment。
- (c) 代价最小但**把问题从「未实现」转成「明文不保证」**——若选它，锁 §7.1a 文本必须同步修订，否则文档与实现再次背离（本片已经因此吃了一条 P1-3 的注释证伪）。

**裁决产出物**：owner 选定后，本计划 §2.1 才能填实具体落点。

---

## 2. 逐条修复设计（G-2 之外均可立即执行）

### 2.1 P1-2 — scheduled 侧 outbox
**待 G-2 裁决后填实。** 无论哪条路，共同的验收腿：
- scheduled 侧存在与 live 侧**同等强度**的排他腿——删掉 scheduled 的耐久机制必须红（当前删 live 的红 5 条、scheduled 零红，正是缺失的证据）。
- `legacy_projection_only` 下 scheduled 侧仍**零 outbox 行**（对齐 live 侧既有腿）。
- crash-after-commit-before-emit / dispatcher 重启 / 并发 dispatcher 三腿在 scheduled 面各自成立（**真并发双连接**）。

### 2.2 P1-1 — legacy 响应体字节保真
**修法（纯测试，不动实现）**：把 `posture-matrix` 的 `Object.keys().sort()` 顶层断言，升级为**结构 + 值**的双层钉：
1. 对 `legacy_projection_only` 的响应做**递归 key-set 快照**（含嵌套层），而非仅顶层；
2. 对 `workDateResolution` 与 `record` 的每个字段做**显式值断言**（它们目前无任何 DB 侧兜底——这正是 MK-2 能全绿的原因）；
3. **保留** DB 侧正控（MK-3 证明既有 baseline 对 DB 投影有真实保护，不要在升级过程中把它替换掉）。

**验收 mutation（每条须恰红）**：删 `record.status`／新增一个嵌套键／`workDateResolution` 置 null／改一个嵌套值。这四刀正是门审 MK-2 一次性做过且全绿的组合——修复后必须逐刀转红。

### 2.3 P1-3 — `legacyArgs` 出事务边界
**修法（实现 + 测试）**：
1. 删除 `legacyArgs: unknown` 入参（`:286`）；boundary 在**事务内**从 canonical envelope 自行推导所需的 legacy 参数——§4.1「调用方只交规范化 envelope，core 持闭合 private adapters」。
2. 同步修正 `:24-25` 的模块头注释——它当前明文断言「no route-provided … prepared value is accepted」，**被 `:286` 直接证伪**。修实现后该注释才成立；若因故保留任何路由预算值，则必须改注释而不是留着错的。
3. **判别腿**：构造「路由传入一个与事务内推导**不一致**的预算值」⇒ 必须被拒或被忽略；`git grep legacyArgs` 生产面零命中。

> 教训对齐：本仓已有「注释断言不测 = 藏 bug」的固化教训，此处即其实例。

### 2.4 P1-4 — `admin_run` / `cron` 两类 witness
**修法（实现 + 测试）**：
1. 拆分 witness：`cron` 保留 `ATTENDANCE_INTERNAL_SCHEDULER_ACTOR_ID_V1`；**`admin_run` 必须携带 host 签发的 admin/delegated witness**，并在**事务内**重验（不得仅在路由层验一次）。
2. `admin_run` 的 actorId 必须是**真实管理员身份**，进入 operation 的 actor 字段与审计链。
3. **判别腿**：admin-run 携 scheduler identity ⇒ 拒；admin-run 携过期/越权 witness ⇒ 在 source/result DML **之前**拒；cron 携 admin witness ⇒ 拒（双向排他）；事务内重验被移除 ⇒ 红。

### 2.5 P2-1 — scheduler 豁免的窄性
**修法（纯测试，Fable）**：为 `w4c0-authorization.ts:308-320` 的豁免补判别腿——K11 的变异（放宽到任意 actorId）当前 789 全绿，修复后必须恰红。同时按本仓「注释断言 ≠ 不变量」的纪律，把该处自称的不变量落成断言。

### 2.6 NIT — 呈裁点 20 的错误论断
门审已证：preflight 在**同一事务内**已取事务作用域 `pg_advisory_xact_lock_shared` 且事务为 SERIALIZABLE、`acceptedWritePosture === posture.writePosture` ⇒ 后续重读与前次**恒等**，MF3b 的 0 红是**预期冗余**，跨事务窗口不存在。
**须改三处文本**：head commit message 的改判、PR body 呈裁点 20、`HANDOFF-W4C2.md`。**明确不建议**构造 rendezvous 并发腿（窗口不存在，建了即空转）。

### 2.7 `HANDOFF-W4C2.md` 的归宿（owner 裁）
该文件为接力记账，当前随分支进 PR diff 且内容已与进度不符。两条路：**(i)** 合并前从 diff 剔除（接力期用完即弃）；**(ii)** 改造成正式持久文档并修正其错误论断。门审建议列为合并前置。

---

## 3. 执行序（解锁后）

1. owner 裁 G-2 形状 → 填实 §2.1。
2. 并行可做：P1-1 / P1-3 / P1-4 / P2-1 / NIT（互不冲突，但 `w4c2-live-scheduled-boundary.ts` 是单热文件，需串行落 commit）。
3. P1-2 按裁定形状实现。
4. **新 exact-head 独立 Opus 门**——旧判定绑 `b54396b28`，**不延展**。
5. 门过后**停下等 owner 第二次裁合并**，不自行推进 W4C-3a。

## 4. 交叉引用

- 门审判定与刀表：#4612 `c-5082182541`；门审 MD（会话 scratchpad）`pr4612-w4c2-gate-20260725.md`
- 授权 provenance 勘误：`attendance-issue-4556-w4-authorization-provenance-erratum-20260726.md`（PR #4613）
- 开发及验证记录：`attendance-issue-4556-w4-development-verification-20260726.md`（PR #4615）
- 锁：`attendance-issue-4556-w4-segment-calculation-design-lock-20260724.md` §4.1 / §7.1 / §7.1a / §12.3
