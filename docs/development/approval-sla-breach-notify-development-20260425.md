# Approval SLA Breach Notify Development - 2026-04-25

## Context

Wave 2 WP5 shipped the approval SLA observability stack:

- `ApprovalSlaScheduler` periodically scans `approval_metrics` and flips
  `sla_breached = TRUE` for active instances whose `started_at + sla_hours`
  has elapsed.
- Subsequent merges added a Redis leader lock (#1160) and follower-takeover
  hardening (#1163) so a multi-pod deployment elects a single notifier.
- The scheduler exposes an `onBreach(ids)` callback hook that was left
  intentionally unwired so this slice could pick the output channel.

This slice wires `onBreach` to a pluggable notification dispatcher with
DingTalk and email channels.

## Scope

- New `ApprovalBreachNotifier` service that fans `onBreach(ids)` out to a
  list of channels in parallel.
- New channel contract under `services/breach-channels/` with two
  implementations:
  - `ApprovalBreachDingTalkChannel` — reuses
    `integrations/dingtalk/robot.ts` helpers and posts a markdown payload
    via `fetch`.
  - `ApprovalBreachEmailChannel` — logging stub. No SMTP transport exists
    in core-backend (`grep nodemailer|sendgrid|mailgun|transporter` is
    empty) and the task forbids adding new dependencies. The stub observes
    `APPROVAL_BREACH_EMAIL_FROM` / `APPROVAL_BREACH_EMAIL_TO` and logs a
    warn line per dispatch but always reports `ok: false`.
- Wired the notifier into `ApprovalSlaScheduler.onBreach` from
  `MetaSheetServer.start()`. The scheduler's existing try/catch around
  `onBreach` (ApprovalSlaScheduler.ts L138-144) absorbs notifier failures;
  we still wrap the call site for explicit logging.
- Added `ApprovalMetricsService.listBreachContextByIds(ids)` to JOIN
  `approval_metrics` + `approval_instances` + `approval_templates` so the
  notifier composes messages without reaching into pool directly.

## Channel Reuse

The DingTalk channel reuses the leaf helpers from
`packages/core-backend/src/integrations/dingtalk/robot.ts`:

- `normalizeDingTalkRobotWebhookUrl` — validates HTTPS + `oapi.dingtalk.com`
  host + access_token query param. An invalid env value is logged and the
  channel reports `webhook not configured` so a misconfiguration cannot
  crash the scheduler.
- `normalizeDingTalkRobotSecret` — guards on the `SEC` prefix.
- `buildSignedDingTalkWebhookUrl` — appends timestamp/sign when a secret
  exists.
- `buildDingTalkMarkdown` — produces the `{ msgtype: 'markdown', markdown:
  { title, text } }` payload shape.
- `validateDingTalkRobotResponse` — surfaces non-zero `errcode` returns.

The HTTP send mirrors `multitable/automation-executor.ts:1393-1402`: native
`fetch` + an `AbortController` for timeout. We deliberately did **not**
import `postJsonWithRetry` from `NotificationService.ts`. The scheduler
already retries on the next tick (default 15 minutes), so a single attempt
with an explicit `ok: false` return keeps the notifier behavior simple and
the in-memory dedupe set clean (only successful sends mark the instance as
notified).

We did **not** reuse `DingTalkNotificationChannel` itself. Its
`sender(notification, recipients)` signature is the legacy notification
abstraction; making the breach notifier conform to it would force us to
synthesize fake `Notification` / `NotificationRecipient` shapes. The new
`BreachNotificationChannel` interface is shape-aligned with what
`ApprovalBreachNotifier` actually needs (one message in, one ok/error
out).

## Failure Isolation

Three nested layers:

1. **Channel `send()`** — wrapped in try/catch inside
   `ApprovalBreachNotifier.dispatch`. A throw becomes `{ ok: false,
   error }`. A returned `ok: false` is logged but does not propagate.
2. **`notifyBreaches`** — `Promise.all` over channels means one channel
   slow / hanging cannot block others (we do `await`, but each `dispatch`
   already converts errors to non-throwing results).
3. **Scheduler call site** (`index.ts`) — explicit try/catch around
   `notifier.notifyBreaches(ids)`, plus the scheduler's own try/catch
   (`ApprovalSlaScheduler.ts:138-144`). Either layer alone would be enough;
   keeping both is defense in depth.

The notifier itself never throws — `notifyBreaches` always resolves to a
`NotifyResult` even when `metrics.listBreachContextByIds` rejects (the DB
error is logged, all input ids are reported as `skipped`, no channel
dispatch attempt is made).

## Idempotency

In-memory `Set<instanceId>` on the leader process, FIFO-bounded at 5000
entries by default.

Justification (the task spec asked us to pick simpler with a written
rationale):

- The scheduler runs only on the leader, so one process is enough to
  dedupe. Follower failover is rare and re-notification on takeover is an
  acceptable v0 tradeoff (the next 15-minute tick would re-flag the same
  rows anyway since `sla_breached_at` is set once per breach, not per
  notification).
- A persistent `breach_notified_at` column would require:
  - a new Kysely migration in `db/migrations/`,
  - bumping `APPROVAL_SCHEMA_BOOTSTRAP_VERSION` in
    `tests/helpers/approval-schema-bootstrap.ts`, which is shared with
    other in-flight branches and would force re-bootstrap of every
    integration worker,
  - updating `ApprovalMetricsService.listBreachContextByIds` to filter on
    `breach_notified_at IS NULL`,
  - extra UPDATE round-trips per dispatch.
- The set is bounded — `markNotified` evicts the oldest entry once the
  cap is hit, so a long-lived leader cannot grow unbounded memory.
- Only successful dispatches mark an instance as notified. A run where
  every channel fails is retried on the next breach tick.

A persistent column is a follow-up. The dev MD records this so a future
slice can land it without rediscovery.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `APPROVAL_BREACH_DINGTALK_WEBHOOK` | unset | DingTalk robot webhook URL with `access_token=` query string. Must be HTTPS on `oapi.dingtalk.com/robot/send`. Unset → channel reports `webhook not configured` and skips. |
| `APPROVAL_BREACH_DINGTALK_SECRET` | unset | Optional `SEC...` signing secret. When provided, the channel appends `timestamp=` + `sign=` query params. |
| `APPROVAL_BREACH_EMAIL_FROM` | unset | From-address for the email stub. Reserved for the follow-up that wires a real transport. |
| `APPROVAL_BREACH_EMAIL_TO` | unset | Admin recipient for the email stub. |
| `PUBLIC_APP_URL` / `APP_BASE_URL` | unset | Base URL prepended to `/approval/<id>` in the message body. Unset → the notifier still composes a message but the link is omitted. |

Webhook setup steps:

1. Open the DingTalk admin → 群机器人 → 添加自定义机器人.
2. Name it (e.g. `MetaSheet 审批超时告警`) and choose 加签 + a keyword such as
   `审批超时` (DingTalk requires at least one of: keyword / 加签 / IP
   allowlist). Match the keyword to what `composeMessage` puts in the
   title.
3. Copy the webhook URL. If you enabled 加签, also copy the secret (starts
   with `SEC`).
4. Set both env vars on the leader-eligible API replicas and restart.

Local test:

```bash
export APPROVAL_BREACH_DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=<token>"
export APPROVAL_BREACH_DINGTALK_SECRET="SEC<your-secret>"
curl -X POST -H 'Content-Type: application/json' \
  -d '{"msgtype":"markdown","markdown":{"title":"审批超时告警 (test)","text":"### 审批超时告警 (test)\n\n手动验证 webhook 可达"}}' \
  "$APPROVAL_BREACH_DINGTALK_WEBHOOK"
```

If you also want to validate the signed flow without the backend, port the
`buildSignedDingTalkWebhookUrl` snippet from
`packages/core-backend/src/integrations/dingtalk/robot.ts:66-78` into a
short Node script.

## Files

### Backend
- `packages/core-backend/src/services/ApprovalBreachNotifier.ts` — new
  notifier. Composes per-instance Chinese-language messages, dispatches in
  parallel, returns aggregated NotifyResult, dedupes via in-memory FIFO
  set.
- `packages/core-backend/src/services/breach-channels/index.ts` — channel
  contract + barrel export.
- `packages/core-backend/src/services/breach-channels/dingtalk-channel.ts` —
  DingTalk implementation reusing robot helpers + native fetch.
- `packages/core-backend/src/services/breach-channels/email-channel.ts` —
  email logging stub (no transport in repo; new deps forbidden).
- `packages/core-backend/src/services/ApprovalMetricsService.ts` — new
  `ApprovalBreachContext` interface + `listBreachContextByIds(ids)` JOIN
  query.
- `packages/core-backend/src/index.ts` — instantiate
  `ApprovalBreachNotifier`, pass as `onBreach` to
  `startApprovalSlaScheduler`, wrap call in try/catch.

### Tests
- `packages/core-backend/tests/unit/approval-breach-notifier.test.ts` — 8
  cases covering empty input, parallel dispatch, channel-failure
  isolation, ok:false handling, idempotency, retry-after-total-failure,
  zero-channels, and missing-context fallback.
- `packages/core-backend/tests/unit/dingtalk-breach-channel.test.ts` — 6
  cases covering missing webhook, invalid webhook, signed POST shape,
  HTTP errors, errcode handling, and network errors. All use a mocked
  `fetchFn` — no real HTTP calls.

No email channel test was added: the channel has no dispatch logic worth
covering until a real transport lands. Tracked as a follow-up.

## Migration / Schema

None. The slice does not touch the database. The dedupe state is
in-memory by design (see Idempotency section). A persistent
`breach_notified_at` column is recorded as a follow-up.

## Rollback

1. `APPROVAL_BREACH_DINGTALK_WEBHOOK=` (empty) on the leader and restart.
   The DingTalk channel reports `webhook not configured` and the scheduler
   still flips `sla_breached`, just without notifications.
2. To fully disable the notifier wiring, revert this commit. The
   pre-merge `onBreach` hook was a no-op so the scheduler reverts cleanly.
3. `APPROVAL_SLA_SCHEDULER_DISABLED=1` continues to disable the scheduler
   entirely, as documented in the WP5 dev MD.

## Follow-ups

- Persistent `breach_notified_at` column for dedupe across restarts /
  leader takeovers.
- Wire a real email transport (likely SMTP via a vetted dependency
  addition in a separate slice) and replace the email stub.
- Optional: webhook retry with exponential backoff inside the channel,
  rather than relying on the next 15-minute tick.
- Optional: severity escalation (`severity: 'critical'`) once an instance
  has been breached for more than `2 * sla_hours`.
