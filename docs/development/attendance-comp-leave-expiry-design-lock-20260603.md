# ④ 加班调休 + 假期过期 design-lock（余额账本 + 审批触发入账 + 过期批处理 + 调度基座）

> **版本** 2026-06-03 · owner 决策已拍板锁定 · H2 MUST（假勤闭环）
> **基线** origin/main @ `27841aa35`（证据 `plugins/plugin-attendance/index.cjs:line` / migration 文件；main 会动，实现前 re-grep）
> **账本** 本设计是 `attendance-dingtalk-benchmark-target-and-tracker-20260601.md` ④ 项的 design-lock。
> **前置硬依赖** ④ 代码上 staging **之前**必须先做 staging migration ledger alignment（见 §2）。
> **比 ③ 重一档**：③ 是 config-only 无 DDL；④ = **余额账本（新表/DDL）+ 审批触发入账 + 过期批处理 + 第一个 attendance 调度基座**。DDL + 幂等风险更大，故"一个 design-lock、分子链实现、实现 PR 拆开"。

---

## 0. 一句话

加班审批通过 → 按比例把工时**入账**为调休余额（一个带过期的 grant lot）；员工请调休/假 → 从余额**扣减**；余额到期 → **批处理状态化 + 到期前提醒**。提醒由一个 leader-elected 的 **attendance 调度基座**驱动（首建于 ④，⑤ 未排班提醒复用）。

与已有：`leave_types` / `overtime_rules` 是策略配置，`attendance_requests`（type ∈ leave/overtime）是申请流。④ 新增的是**余额账本**这层之前没有的事实。

---

## 1. owner 决策（2026-06-03 锁定，不再 re-litigate）

1. **一个 design-lock，分子链实现**；实现 PR 拆开（加班调休 与 假期过期 同属 ④ 但分 PR）。**顺序**：staging alignment 前置 → 余额/ledger DDL → OT approved→调休入账 → 假期过期扣减/状态化 → expiry reminder + attendance scheduler base。
2. **余额 = 批次/流水（lot/ledger）模型，不是单个 mutable aggregate row**。语义 = `user × leave/comp type × grant lot/source × amount/remaining × expires_at`。
3. **调休入账挂在 OT request approval transition**，**必须幂等**：仅"状态转为 approved 的那一刻"记账；重复 webhook / 重复保存**不得二次 credit**。撤销/改审策略要写清：**首版可不支持自动反冲，但不得静默错账**。
4. **调度基座在 ④ 建，不 defer**（假期过期提醒 + ⑤ 未排班提醒都复用；手工 endpoint/stub = 第二套临时机制）。首版只接 expiry reminder，但落一个 leader-elected attendance scheduler 基座，**镜像 `ApprovalSlaScheduler` + `ApprovalBreachNotifier`**。

---

## 2. 硬前置：staging migration ledger alignment

④ 引入新表/新列 → 新 migration。staging DB **ledger 落后 main**（自 ~2026-04-09；#2226 的 attendance DB_NOT_READY 已照出此雷）。**④ 代码上 staging 前，先按 `docs/operations/staging-migration-alignment-runbook.md` 做 ledger 对齐**（synthetic catch-up → clean `pnpm migrate`），否则新 DDL 一上 staging smoke 必再碰同类 `DB_NOT_READY`。这是 ④ 子链的**第 0 步**，不是可选项。

---

## 3. 余额账本 = grant-lot ledger（`attendance_leave_balances`）

每行 = **一个授予批次（lot）**，不可变聚合行被禁止。锁定字段：

| 列 | 语义 |
|---|---|
| `id` uuid PK | |
| `org_id` text | |
| `user_id` text | 余额归属人 |
| `leave_type_code` text | 该 lot 的类型（调休 = 一个保留 code，如 `comp_time`；其它 = `leave_types.code`） |
| `amount_minutes` integer | 本批授予总量（分钟） |
| `remaining_minutes` integer | 当前剩余（扣减递减；`0 ≤ remaining ≤ amount`） |
| `source_type` text | `overtime_conversion` \| `manual_grant` \| `policy_accrual`（首版只 overtime_conversion + manual_grant） |
| `source_id` text NULL | 来源实体反链（如 OT request id）；**可空**（manual/accrual 可能无单一实体） |
| `source_key` text **NOT NULL** | **幂等键 + DB 兜底唯一**（见 §4）；确定性构造、内嵌 source_type 跨类型不撞：`overtime_conversion:{requestId}` / `manual_grant:{actionId\|uuid}` / `policy_accrual:{userId}:{periodKey}` |
| `granted_at` timestamptz | |
| `expires_at` timestamptz NULL | 本批过期时点（null = 不过期） |
| `status` text | `active` \| `exhausted` \| `expired` \| `revoked` |
| `created_at`/`updated_at` | |

- **唯一键防重复入账**：`source_key NOT NULL` + **`UNIQUE (org_id, source_key)`**（同一逻辑入账事件只能产生一个 lot）。**不锁 `source_id`**——manual/accrual 的 `source_id` 可空，而 Postgres 唯一约束允许多个 NULL → 会漏挡重复入账；故幂等兜底锁**非空的 `source_key`**，`source_id` 仅作反链。
- **扣减 = FIFO by `expires_at`**（最先过期的先扣），递减 `remaining_minutes`，扣到 0 → `status='exhausted'`。
- **审计流水（必需，非可选）**：lot 的 `remaining_minutes` 是快读快照，**不能只靠它**——单改 `remaining_minutes` 会丢"哪张请假单从哪个 lot 扣了多少 / 哪次过期 forfeit 了多少"。故**必建第二张表 `attendance_leave_balance_events`**（流水），每次余额变动一条 +/- 条目。锁字段：`id` · `org_id` · `user_id` · `balance_id`（关联 lot）· `event_type`（`grant`/`deduct`/`expire`/`revoke`）· `delta_minutes`（grant 正、deduct/expire 负）· `source_type`/`source_id`（deduct=请假单 id；grant=OT request id；expire=系统）· `occurred_at`。**grant lot 仍是主模型 + 快读，events 是不可省的审计真源**；C2/C3/C4 每次余额变动都必须写一条。
- **DDL**：新 `createTable`（幂等 `IF NOT EXISTS` 风格，参考 `add_attendance_*` 用 `_patterns`）；前缀用当前最高 `zzzz` tier + 2026-06-03+ 时间戳，排在最后。

---

## 4. 加班调休：OT approved → 调休入账（幂等）

- **触发点**：OT request 的审批状态 **transition 到 approved 的那一刻**（不是"处于 approved"——重复保存/重复回调不得再次入账）。挂在 approve 路由的状态迁移处。
- **入账**：credit 一个 lot：`leave_type_code='comp_time'`，`amount_minutes = 审批通过的加班分钟 × 调休比例`（比例可配，默认 1:1；配在 `overtime_rules` 加一列 `comp_time_rate` 或 org 设置——实现期定，design 锁"可配 + 默认 1:1"），`expires_at = granted_at + 调休有效期`（可配，默认值实现期定），`source_type='overtime_conversion'`，`source_id = OT request id`，`source_key = overtime_conversion:{requestId}`。
- **幂等三层**：(a) 只在 pending→approved 迁移触发；(b) 入账以 `source_key='overtime_conversion:{requestId}'` 命中 `UNIQUE(org_id,source_key)`；(c) `INSERT ... ON CONFLICT (org_id, source_key) DO NOTHING` —— 三层任一都能挡住二次 credit，**非空 `source_key` 唯一键是最终兜底**。同一笔 credit 同时写一条 `grant` event（§3）。
- **撤销/改审策略（首版）**：approved → 撤销/驳回/改时长 **不自动反冲** lot，但**不得静默错账**：lot 的 `source_id` 反链 OT request，必须保证可对账（报表/管理员能查到"这个 lot 来自一个已撤销的加班"）。**显式声明**自动反冲 = 后续切片，首版不做但不假装做。（避免 P2 式"静默"——同 ③ 纪律。）

---

## 5. 假期过期：扣减 + 状态化 + 到期前提醒

- **过期批处理**：调度基座周期扫 `status='active' AND expires_at <= now() AND remaining_minutes > 0` 的 lot → 置 `status='expired'`（剩余 forfeit/状态化，不静默清零——记录过期事件/可追溯）。
- **到期前提醒**：扫 `expires_at` 在 `[now, now+N天]` 的 active lot → 经 attendance notifier 提醒余额人（N 可配）。
- **扣减入口**：员工请调休/假（leave request of that type approved）→ 从该 user 该 type 的 active lot 按 FIFO 扣 `remaining_minutes`。余额不足策略实现期定（block / 允许负？默认 block，design 锁"显式策略不静默")。

---

## 6. 调度 + 通知基座（首建于 ④，镜像 approval 域）

- **`AttendanceScheduler`**（镜像 `ApprovalSlaScheduler`，`packages/core-backend/src/services/`）：单进程 interval + 一次性 guard；多实例经 **Redis leader lock** opt-in（env-gated，如 `ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK`，镜像 `ENABLE_APPROVAL_SLA_LEADER_LOCK`）；`unref` 定时器；env 可禁用。
- **首版只接 expiry job**（leave-expiry 扫描 + 状态化 + 到期前提醒）。**⑤ 未排班提醒**后续作为同一 scheduler 的第二个 job 复用——基座一次建好，别建两套。
- **`AttendanceNotifier`**（镜像 `ApprovalBreachNotifier`）：经既有 notification channels 发提醒；**渠道按 env 注册**（无配置不注册，避免 per-tick warn 噪音——见 channel-env-gating 纪律）。
- **leader-elected + at-least-once**：过期状态化必须幂等（重复扫不得重复扣/重复状态化——`status` 迁移天然幂等：已 `expired` 的不再处理）。

---

## 7. 子链顺序（同一 design-lock，实现 PR 拆开；各独立 gated opt-in）

- 🔒 **C0 staging alignment**（§2，前置，ops 非代码）。
- 🔒 **C1 ledger DDL**：`attendance_leave_balances`（lot）**+ `attendance_leave_balance_events`（流水）两表**建表 migration + normalize/映射（latent，无触发——余额读写 API 可后置）。
- 🔒 **C2 OT→调休入账**：approve transition hook + 幂等 credit（lot **+ 一条 `grant` event**）+ `comp_time_rate`/有效期配置 + **幂等反向测试**（重复 approve/重复保存 → 单次 credit + 单条 grant event）。
- 🔒 **C3 余额扣减**：请调休/假 approved → FIFO 扣减 `remaining_minutes` **+ 每笔写 `deduct` event（请假单 id / lot / delta）** + 余额不足策略 + 测试。
- 🔒 **C4 过期状态化 + 调度基座**：`AttendanceScheduler` + expiry job（状态化 **+ 每笔写 `expire` event 记 forfeit 量**）+ 测试。
- 🔒 **C5 到期前提醒 + notifier**：`AttendanceNotifier` + reminder job + env-gated 渠道 + 测试。
- （撤销自动反冲 = §4 声明的后续，独立 opt-in，不在 ④ 首版。）

---

## 8. 完成口径（MUST）+ 纪律

- 每个 C* 切片：**运行时生效 + 可配 + 反向/幂等测试 + 1 条 staging 联调**（staging 已对齐后）才算 ✅。
- **幂等是 ④ 的招牌测试**：重复 OT approval / 重复回调 / scheduler 重复扫 → 余额**只变一次**。真 DB route-level integration 必覆盖（同 ③#2209 纪律：enforcement/记账类合前必有 wire 级反向测试）。
- **不静默错账 / 不静默清零**：撤销→可对账（§4）、过期→记录（§5）、余额不足→显式策略（§5）。任何"少算/多算"都必须可见，不得静默。

---

## 9. DDL / migration 纪律

- 新 migration 用幂等 `_patterns`（`createTable IF NOT EXISTS` / `addColumnIfNotExists`）；前缀匹配当前最高 `zzzz` tier + 2026-06-03+ 时间戳排最后。
- **C* 若都 ALTER 热表**（如 OT/leave 配置加列）尽量成组协调（参考账本 §schema-batch）；`attendance_leave_balances` 是新表，独立迁。
- **staging 对齐（§2）是 staging 联调的前置**——新表上线即触发 staging trailing 雷（#2226 已证）。

---

## 10. 反漂移

- 余额**只**经 lot ledger（`attendance_leave_balances`）读写 + 每次变动**必写** `attendance_leave_balance_events`；禁止单 mutable aggregate row，禁止只改 `remaining_minutes` 不留 event。
- 入账**只**在 approve transition + **非空 `source_key` 唯一键**兜底；任何新入账来源（manual/accrual）都走同一 lot + `source_key` 幂等模型，`source_key` 必非空（不锁可空的 `source_id`）。
- 调度**只**有一个 `AttendanceScheduler` 基座；⑤ 复用，不另起。
- 撤销自动反冲 / 余额不足放行 = 各自独立 opt-in，design 已显式声明"首版不做"，不得静默半做。（**审计 events 表不在此列——它是 C1 必需、非可选切片。**）
