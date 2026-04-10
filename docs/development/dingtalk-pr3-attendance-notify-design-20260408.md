# DingTalk PR3 Attendance Hardening and Notification Design

Date: 2026-04-08
Branch: `codex/dingtalk-pr3-attendance-notify-20260408`
Scope: attendance DingTalk sync hardening and DingTalk robot notification channel

## Goal

PR3 closes the most obvious production gaps left after PR1 and PR2:

- make DingTalk attendance sync more resilient to transient API failures
- ensure failed attendance sync attempts leave usable run records
- add a real DingTalk notification channel instead of the existing placeholder

This PR intentionally does not add a new admin page or change workflow designer protocol. It stays on the existing backend notification contract and existing attendance integration UI.

## Why this scope is narrow

There are two separate needs in this phase:

1. attendance sync needs operational hardening
2. platform notifications need a real DingTalk delivery channel

Both can be addressed without reopening the larger auth and directory surfaces from PR1 and PR2.

The minimum production files for this PR are:

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/src/services/NotificationService.ts`
- `packages/core-backend/src/core/plugin-service-factory.ts`
- `packages/openapi/src/paths/attendance.yml`
- `packages/core-backend/tests/unit/notification-service-dingtalk.test.ts`

## Attendance hardening design

### Existing problem

Before PR3, attendance DingTalk sync had three operational weaknesses:

- DingTalk HTTP requests had no timeout
- DingTalk token and attendance fetches had no retry/backoff
- if the sync threw after a run row was created, the run could remain stuck in `running`

Additionally, any single user fetch failure aborted the full sync.

### PR3 changes

`plugins/plugin-attendance/index.cjs` now adds a small DingTalk request wrapper for the attendance integration path.

The wrapper provides:

- request timeout via `AbortSignal.timeout`
- bounded retry with exponential delay and jitter
- retry only for transient failure classes
- safe JSON parsing

PR3 applies this wrapper to:

- DingTalk app token acquisition
- DingTalk attendance column-value fetch

### Token cache

Attendance sync now keeps a small in-memory DingTalk app token cache keyed by:

- `baseUrl`
- `appKey`
- `appSecret`

The cache is process-local and expires before DingTalk token expiry. This avoids unnecessary token churn without introducing a new persistence layer.

### Per-user partial failure handling

The sync loop now isolates user-level DingTalk fetch failures.

Behavior:

- one user fetch failure no longer aborts the whole integration run
- failed users are appended to `partialErrors`
- skipped data also captures those user-level errors for consistency
- run status becomes `partial` when at least one user failed but the sync still produced output

This is additive and preserves the existing response shape while adding a new `partialErrors` field.

### Run record completion

PR3 ensures attendance integration runs are updated on failure as well as success.

On failure:

- `attendance_integrations.last_sync_at` is still updated
- `attendance_integration_runs.status` becomes `failed`
- run `message` stores the error text
- run `meta` stores sync context such as imported count, skipped count, batch id, date range, and partial errors

This prevents stale `running` rows from becoming operational dead ends.

## DingTalk notification design

### Existing problem

`packages/core-backend/src/core/plugin-service-factory.ts` already had a `dingtalk` branch, but it was a no-op placeholder.

The runtime notification service had:

- email
- webhook
- feishu

but no real DingTalk implementation.

### PR3 changes

`packages/core-backend/src/services/NotificationService.ts` now adds `DingTalkNotificationChannel`.

The channel:

- uses the existing `NotificationChannel` abstraction
- accepts webhook/group recipients
- sends DingTalk robot messages as markdown
- supports signed DingTalk robot webhooks via HMAC-SHA256
- reuses the same timeout and retry pattern as other outbound webhooks

The notification service now registers DingTalk by default, and the plugin service factory can override it with configured options.

### Configuration

`PluginServiceFactory` notification options now support DingTalk-specific settings:

- `secret`
- `timeout`
- `maxAttempts`
- `retryDelayMs`

This keeps the DingTalk delivery path aligned with the existing pluggable notification architecture instead of introducing a special one-off sender.

## API change

Attendance sync response in OpenAPI now documents the additive `partialErrors` field:

- `userId`
- `message`

No route path or request schema changed in PR3.

## Non-goals

PR3 does not include:

- DingTalk app message push to individual users
- new workflow designer fields for robot secret/url management
- scheduler-driven attendance sync orchestration
- shared backend DingTalk webhook helper extraction
- live tenant alert routing from all backend services

These are reasonable follow-ups, but they are not required to make the current DingTalk attendance and notification surfaces materially more usable.

## Claude parallel role

Claude CLI was used in PR3 only as a scoped parallel reviewer.

Its review was used to validate:

- the minimum production file set
- the safety of keeping the change backend-heavy
- the value of partial-failure handling in attendance sync

The implementation itself remained local in the current branch.
