# 考勤 C5 外发通知与负责人 fan-out design-lock

> **版本** 2026-06-11 · docs-only · 新目标起点
> **账本** `attendance-dingtalk-benchmark-target-and-tracker-20260601.md` §0.3
> **基线** origin/main @ `578d4883f`（A2 staging closeout 后）

---

## 0. 一句话

C5 把已经落地的"内部提醒记录 + notifier seam"升级为**可靠外发通知**：未排班提醒、调休到期提醒两类 attendance
scheduler source 都能把待提醒事项写入可重试 outbox，再由 env-gated channel 发送给本人和负责人，并把"已认领"、"已发送"、"失败待重试"分清楚。

这不是新的排班/打卡功能；它是通知可靠性目标。C5 不改变任何已闭环能力的完成口径，也不把 `dispatched_at` 偷换成外部送达成功。

---

## 1. 已有事实（不要重建）

1. **调度基座已在**：`AttendanceScheduler` 已是 composite scheduler，C4 expiry、⑤ 未排班提醒、A2 自动写入共用同一基座。C5 只注册/复用 job，不建第二套 scheduler。
2. **notifier seam 已在**：`AttendanceNotifier` 现在默认 0 channel，`notify()` 不抛错、隔离 channel 失败；`createAttendanceNotifierChannelsFromEnv()` 当前返回 `[]`，这正是 C5 的扩展点。
3. **未排班提醒已有 dedup/intent 表**：`attendance_unscheduled_reminder_dispatch` 以 `UNIQUE(org_id,user_id,target_date,reminder_type)` 保证 at-most-once claim。它的 `dispatched_at` 是 claim 时间，不是外部 delivery-success。
4. **调休过期已有 state-flow，没有提醒 source。** C4 只做 `comp_time` lot 的 `expires_at` 写入、过期状态化、scheduler；到期前提醒仍是 C5 责任。通用假期余额到期提醒不是 C5 v1 范围。
5. **负责人模型已在**：`attendance_group_managers` 已维护 `owner` / `sub_owner` roster。C5 的 owner fan-out 复用它，不新建负责人模型。
6. **DingTalk work notification runtime 已在**：`readDingTalkMessageConfigFromRuntime()` + `sendDingTalkWorkNotification()` 已被 automation person delivery 使用。C5 可复用该 runtime，但必须有自己的 outbox/delivery 状态，不复用 automation delivery 表冒充 attendance 状态。

---

## 2. Owner decisions（本 design-lock 锁定）

1. **C5 的核心是 outbox，不是直接 channel send。** Reminder job 先写可靠 outbox row；delivery worker/job 再 claim pending rows and send。外部发送失败必须可重试。
2. **`attendance_unscheduled_reminder_dispatch.dispatched_at` 仍只表示 intent/claim。** C5 不改写它为 `delivered_at`，也不据此判断外部成功。
3. **v1 source scope = 未排班提醒 + 调休到期前提醒。** 未排班 source 使用已有 dispatch row；调休 source 只扫 `attendance_leave_balances` 中 `leave_type_code='comp_time'` 的即将到期 active lot。只做这两类，不泛化所有 attendance events。
4. **v1 recipient fan-out = 本人 + 考勤组负责人。** 本人是原 dispatch row/lot 的 `user_id`；负责人来自用户当前考勤组成员关系对应的 `attendance_group_managers`，role 包含 `owner` 和 `sub_owner`。现有 membership schema 没有 date-effective/active 维度，所以 v1 不声称历史 target-date ownership。去重后每个 recipient/channel 各一条 delivery。
5. **v1 channel = DingTalk work notification，env/store-gated，默认 OFF。** 没有有效 DingTalk runtime config 时不发送；outbox row 进入 `failed`/`retrying`，不静默成功。Email/短信/站内信作为后续 channel，不混入首版。
6. **失败语义 = at-least-once delivery attempt + idempotent recipient row。** 同一 source/recipient/channel 不重复建 row；失败按 `next_attempt_at` 重试；成功只标一次 `delivered_at`。
7. **C5 staging smoke 分两档。** Fake channel 只能证明 delivery-state/retry/fan-out 机制，不能把 C5 目标翻 ✅；C5 ✅ 必须有真实 DingTalk work-notification channel smoke。若 staging 无真实 DingTalk 收件条件，fake-channel closeout 只能保持 🟡 并记录 residual。
8. **source job 不得直接外发。** 现有 `UnscheduledReminderService` 在 claim 后会调用 `notifier.notify()`；C5-1 必须先把这条路径改成 outbox producer（或保持 0-channel no-op），C5-3 才能启用真 channel。否则会绕过 outbox/retry，或与 outbox worker 双发。

---

## 3. 数据模型：`attendance_notification_deliveries`

新表作为 C5 的通用 attendance notification outbox。它记录"对某个 recipient 通过某个 channel 发送某个 attendance 提醒"的状态。

锁定字段：

| 列 | 语义 |
|---|---|
| `id` uuid PK | delivery row id |
| `org_id` text | tenant/org |
| `source_type` text | `unscheduled_reminder` / `comp_time_expiry_reminder` / future attendance source |
| `source_id` text | source row id；未排班 = `attendance_unscheduled_reminder_dispatch.id` |
| `source_key` text not null | deterministic idempotency key；如 `unscheduled:{dispatchId}:recipient:{userId}:channel:{channel}` |
| `recipient_user_id` text not null | local user id to notify |
| `recipient_role` text not null | primary role: `subject` / `owner` / `sub_owner` |
| `channel` text not null | v1 `dingtalk_work_notification`; tests may use `fake` |
| `status` text not null | `pending` / `sending` / `sent` / `retrying` / `failed` / `skipped` |
| `attempt_count` int not null default 0 | attempts made |
| `next_attempt_at` timestamptz not null default now() | retry eligibility |
| `last_attempt_at` timestamptz null | |
| `claimed_at` timestamptz null | last worker claim time |
| `claim_expires_at` timestamptz null | stale `sending` reclaim deadline |
| `claim_worker_id` text null | diagnostic worker id, not correctness source |
| `delivered_at` timestamptz null | only set on channel ok |
| `last_error` text null | redacted/truncated channel error |
| `payload` jsonb not null default `{}` | title/body/context snapshot, no secrets; includes `recipientRoles` and source context |
| `created_at`/`updated_at` | |

Constraints:

- `UNIQUE(org_id, source_key)` is the idempotency backstop.
- `CHECK status IN (...)`.
- `CHECK attempt_count >= 0`.
- `CHECK delivered_at IS NULL OR status = 'sent'`.
- Index `(status,next_attempt_at)` for claim.
- Index `(status,claim_expires_at)` for stale `sending` reclaim.
- Index `(org_id,source_type,source_id)` for audit/debug.

Do **not** add mutable aggregate counters to the source tables. Source rows stay intent ledgers; delivery rows are the delivery truth.

---

## 4. Recipient resolution

Owner resolution uses the **current** attendance-group roster because the existing `attendance_group_members`
table has no `active`, `effective_from`, or `effective_to` columns. C5 must not pretend to do historical
target-date ownership until that schema exists. Resolver predicate:

```sql
SELECT DISTINCT gm.user_id, gm.role, gm.group_id
FROM attendance_group_members m
JOIN attendance_groups g ON g.id = m.group_id AND g.org_id = m.org_id
JOIN attendance_group_managers gm ON gm.org_id = m.org_id AND gm.group_id = m.group_id
WHERE m.org_id = $1
  AND m.user_id = $2
  AND gm.role IN ('owner','sub_owner')
```

This intentionally uses attendance-group membership, not `attendance_schedule_group_members`; managers are attached
to attendance groups today.

### 4.1 Unscheduled reminder source

Input source: newly claimed or previously claimed `attendance_unscheduled_reminder_dispatch` row.

C5-1a must change the existing claim path from aggregate-only:

```sql
RETURNING org_id, user_id
```

to identity-bearing:

```sql
RETURNING id, org_id, user_id, target_date, reminder_type
```

and must also provide a reconciliation query for **previously claimed** rows that have no delivery rows yet:

```sql
SELECT d.id, d.org_id, d.user_id, d.target_date, d.reminder_type
FROM attendance_unscheduled_reminder_dispatch d
WHERE NOT EXISTS (
  SELECT 1
  FROM attendance_notification_deliveries nd
  WHERE nd.org_id = d.org_id
    AND nd.source_type = 'unscheduled_reminder'
    AND nd.source_id = d.id::text
)
```

Without this, a row already claimed before C5 (or during a crash between claim and producer) can be stuck forever
as an internal intent with no external outbox record.

Recipients:

1. **Subject**: `dispatch.user_id`.
2. **Owners / sub-owners**: for the same `org_id`, find current attendance groups the subject belongs to, then join `attendance_group_managers` on those groups. Include roles `owner` and `sub_owner`. There is intentionally no `target_date` filter in v1 because the current schema has no historical/effective membership columns.

Rules:

- Deduplicate by `(recipient_user_id, channel)` before creating deliveries. One human should not receive two identical C5 messages for the same source just because they are both the subject and a manager.
- If a user has multiple roles, create one delivery row, set `recipient_role` by precedence `subject > owner > sub_owner`, and preserve the full role/group list in `payload.recipientRoles` / `payload.groupIds`.
- Missing owner roster is not an error; subject delivery can still be created.
- Inactive/missing recipient users are `skipped` delivery rows with `last_error='recipient_inactive_or_missing'` so the gap is visible.

### 4.2 Comp-time expiry reminder source

C4 currently does expiry state-flow, not pre-expiry reminders. C5 adds a pre-expiry source before the target can be marked complete:

- scan `attendance_leave_balances` where `leave_type_code='comp_time'`, `status='active'`, `remaining_minutes > 0`, `expires_at IS NOT NULL`, and `expires_at` is within the configured reminder window;
- config v1: `ATTENDANCE_COMP_TIME_EXPIRY_REMINDER_ENABLED=true` plus `ATTENDANCE_COMP_TIME_EXPIRY_REMINDER_LOOKAHEAD_DAYS` clamped `[1,30]`; per-org UI is a follow-up unless explicitly opted in;
- source instance key: `comp_time_expiry_reminder:{balanceId}:{windowDate}` so a lot has one reminder context per configured reminder date/window;
- delivery `source_key`: `comp_time_expiry_reminder:{balanceId}:{windowDate}:recipient:{recipientUserId}:channel:{channel}` after recipient/channel de-dupe, so subject + owner/sub_owner fan-out cannot collide under `UNIQUE(org_id, source_key)`;
- recipients v1 = balance owner (`subject`) plus current attendance group owners/sub-owners for that user, using the same owner resolver as §4.1;
- expiry reminder source does **not** mutate the balance lot. Actual expiry remains C4's state-flow.
- generic non-`comp_time` leave-balance expiry reminders are future scope unless separately opted in.

If C5 starts with unscheduled reminder first, the tracker stays 🟡 until the comp-time expiry reminder source is also code-green and staging-proven or the owner explicitly splits it into a separate target.

---

## 5. Delivery semantics

### 5.1 Claim pending deliveries

Delivery worker query shape:

```sql
WITH claim AS (
  SELECT id
  FROM attendance_notification_deliveries
  WHERE (
      status IN ('pending','retrying')
      AND next_attempt_at <= now()
    )
    OR (
      status = 'sending'
      AND claim_expires_at <= now()
    )
  ORDER BY COALESCE(next_attempt_at, claim_expires_at) ASC, created_at ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED
),
claimed AS (
  UPDATE attendance_notification_deliveries d
     SET status='sending',
         attempt_count=attempt_count+1,
         last_attempt_at=now(),
         claimed_at=now(),
         claim_expires_at=now()+($2::interval),
         claim_worker_id=$3,
         updated_at=now()
    FROM claim
   WHERE d.id=claim.id
   RETURNING d.*
)
SELECT * FROM claimed;
```

The `sending` state is a lease, not a terminal holding pen. A worker crash after claim must become recoverable:

- C5-0 adds `claimed_at`, `claim_expires_at`, and `claim_worker_id`.
- The claim query includes stale `sending` rows whose `claim_expires_at <= now()`.
- Success/failure completion clears `claim_expires_at` / `claim_worker_id` or overwrites them with the next retry state.
- Tests must prove a stale `sending` row is reclaimed and delivered/retried, while a non-expired `sending` row is not double-claimed.

Each claimed row is then sent through exactly one channel adapter. After the adapter returns:

- ok → `status='sent', delivered_at=now(), last_error=NULL`.
- retryable failure → `status='retrying', next_attempt_at=now()+backoff(attempt_count), last_error=...`.
- non-retryable failure or max attempts exceeded → `status='failed', last_error=...`.

No status transition may be inferred from `AttendanceNotifier.notify()` aggregate counters alone; C5 needs per-delivery channel results.

### 5.2 Retry/backoff

- Default max attempts: 5.
- Backoff: bounded exponential, e.g. 1m, 5m, 15m, 1h, 6h, with jitter optional.
- Retry classification:
  - retry: network, 429, 5xx, DingTalk token transient.
  - non-retry: recipient not linked, inactive user, invalid/missing channel config, 4xx business errors that require operator config.
- A failure never deletes or rewrites the source intent row.

### 5.3 Channel factory

The **delivery worker**, not source scanners, owns real channel sends. The channel factory may be implemented by
growing `createAttendanceNotifierChannelsFromEnv()` or by introducing an attendance-delivery-specific factory, but
the invariant is:

- `UnscheduledReminderService` / expiry source producer must not call a real DingTalk channel directly.
- `resolveUnscheduledReminderJob()` must keep source-scan notification as outbox production or 0-channel no-op before any real channel is registered.
- The delivery worker consumes `attendance_notification_deliveries` and is the only caller that turns a row into an external send.

Channel factory requirements:

- `ATTENDANCE_DINGTALK_WORK_NOTIFICATION_ENABLED=true` enables `dingtalk_work_notification`.
- It reuses `readDingTalkMessageConfigFromRuntime()` and `sendDingTalkWorkNotification()`.
- It resolves local `recipient_user_id` to an active DingTalk account through the existing directory link tables, same discipline as automation person delivery.
- No valid config/binding ⇒ delivery row `skipped` or `failed` with explicit reason; not a silent no-op.

Default remains no external send.

---

## 6. Slice plan（各自独立 opt-in）

| Slice | Scope | Gate |
|---|---|---|
| **C5 design-lock** | 本文 + tracker 回填 | docs-only |
| **C5-0 outbox DDL** | `attendance_notification_deliveries` table + DB CHECKs/indexes; no worker, no channel | migration replay + reverse constraint tests |
| **C5-1a unscheduled fan-out producer** | Refactor claim `RETURNING id,target_date` + reconcile existing dispatch rows; produce delivery rows; subject + owner/sub_owner resolution; idempotent source_key; no real channel | real-DB producer tests: subject-only, owner fan-out, pre-existing dispatch reconcile, no dup, inactive recipient visible |
| **C5-1b comp-time expiry reminder producer** | From active lots approaching `expires_at` to delivery rows; subject + owner/sub_owner resolution; no balance mutation | real-DB producer tests: null/future/out-of-window skipped, in-window claimed once, owner fan-out |
| **C5-2 delivery worker + fake channel** | Claim/send/update status with deterministic fake channel; retry/backoff/max-attempts; no DingTalk network | unit + real-DB state-flow tests; repeat worker no dup |
| **C5-3 DingTalk work-notification channel** | Env/store-gated real channel using existing DingTalk runtime; local user → DingTalk account resolution | mocked channel/client tests + config-missing fail-closed tests |
| **C5-4 admin observability** | Admin read-only delivery view/counts for failed/retrying/sent rows; no manual retry button in v1 unless explicitly added | web/backend tests; no silent caps |
| **C5-5 staging smoke** | Deploy with channel mode chosen for staging; seed unscheduled user + owner roster + expiring lot; run scheduler/worker; assert subject+owner deliveries, retry/idempotency, residue=0 | required before tracker ✅ |

`C5-5` has two possible smoke levels:

- **C5-5a fake-channel smoke**: proves outbox state-flow, retry, fan-out, scheduler coexistence, and cleanup residue. It is useful and can unblock follow-up hardening, but it does **not** flip C5 ✅.
- **C5-5b real DingTalk smoke**: proves the v1 external channel by sending through DingTalk work notification to a synthetic/bound recipient. Only this level can flip C5 from 🟡 to ✅. If real credentials/recipient binding are unavailable, closeout must say "delivery-state proven, real DingTalk send not proven" and keep the tracker partial.

---

## 7. Tests that must exist before implementation is called complete

- DDL rejects impossible delivery rows: invalid status, negative attempts, delivered_at with non-sent status.
- Producer creates subject + owner/sub_owner rows for one unscheduled dispatch and no duplicates on repeat.
- Producer reconciles a pre-existing `attendance_unscheduled_reminder_dispatch` row that has no delivery rows.
- Source scanner with a real channel configured cannot bypass the outbox path.
- Expiry producer creates subject + owner/sub_owner rows for one in-window comp-time lot and no duplicates on repeat.
- Producer does **not** mark the source dispatch as externally delivered.
- Delivery worker:
  - claims pending rows with `FOR UPDATE SKIP LOCKED` and marks `sending`;
  - reclaims stale `sending` rows after `claim_expires_at`, but does not double-claim a live `sending` lease;
  - success → sent + delivered_at;
  - retryable failure → retrying + next_attempt_at;
  - non-retryable failure → failed/skipped, no loop;
  - repeat after sent → no second send.
- DingTalk channel:
  - missing runtime config fails closed and records status;
  - missing recipient binding records skipped/failed per recipient;
  - channel returns ok only when `sendDingTalkWorkNotification()` succeeds.
- Scheduler job isolation: C5 delivery worker failure must not skip C4 expiry, ⑤ unscheduled scan, or A2 auto-write jobs.

---

## 8. Out of scope

- Native app push, SMS, email, enterprise WeChat, phone calls.
- Payroll, anti-cheat, AI/photo verification, device/WiFi/geofence hardware.
- A manual retry UI or bulk replay UI unless separately opted in after C5-4 read-only view.
- Reworking DingTalk automation delivery history tables.
- Changing completed H2/A2 feature semantics.

---

## 9. Graduation

C5 is **not** complete when a table exists or a channel class compiles. It is complete only after:

1. outbox DDL + producer + worker + real DingTalk work-notification channel path are runtime-wired;
2. subject and owner/sub_owner fan-out are proven;
3. retry and failure states are proven;
4. scheduler coexistence is proven;
5. staging smoke records a **real DingTalk** PASS stamp, deploy SHA, channel mode, and cleanup residue=0;
6. tracker flips from 🟡 to ✅ with that evidence.
