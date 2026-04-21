# Yjs After-Sales Role Recipient Fallback Development

Date: 2026-04-19

## Scope

This slice closes the remaining functional CI failure on PR `#918` after replay-only migration exclusions were already aligned.

The failing jobs were:

- `after-sales integration`
- `test (20.x)` via its required after-sales integration sub-step

Both jobs now failed at the same assertion:

- `expected [] to have a length of 2 but got 0`

for the real `service.recorded` notification path in `after-sales-plugin.install.test.ts`.

## Root Cause

The failure was not in Yjs runtime and not in the notification adapter itself.

The actual break was inside `plugins/plugin-after-sales/lib/workflow-adapter.cjs`:

- `resolveRoleRecipients()` always queried `COALESCE(u.is_active, TRUE) = TRUE`
- replay-built / legacy-compatible CI databases can still expose a `users` table shape without `is_active`
- that query therefore throws `42703` (`column ... does not exist`)
- the adapter catches the error and returns `{}` role recipients
- `sendTopicNotification()` then receives no `supervisor` recipients for `after-sales.service.recorded`
- the integration test observes zero notifications instead of the expected two (`feishu` + `email`)

This is why the route still returned `accepted=true`, while notifications silently disappeared.

## Changes

Updated:

- `plugins/plugin-after-sales/lib/workflow-adapter.cjs`
- `packages/core-backend/tests/unit/after-sales-workflow-adapter.test.ts`

### Workflow Adapter

`resolveRoleRecipients()` now uses a two-step query strategy:

1. try the current query with `COALESCE(u.is_active, TRUE) = TRUE`
2. if that query fails because the legacy schema does not expose `users.is_active`, retry the same role-recipient query without the active-user filter

The retry is intentionally narrow:

- only for the missing `is_active` column case
- all other query failures still fall through to the existing warning-and-empty-recipient behavior

This keeps the change scoped to legacy schema compatibility rather than broadening error handling.

### Unit Coverage

Added a focused unit test that proves:

- the adapter first attempts the active-user-filtered query
- falls back when `42703` / `is_active` is missing
- still resolves `supervisor` role recipients into:
  - one `user` recipient
  - one `email` recipient
- still emits `after-sales.service.recorded` notification requests with those recipients

## Outcome

- replay-compatible CI databases without `users.is_active` no longer lose service-record notifications
- the remaining `#918` failures should now stay in the same PR scope: CI/runtime compatibility hardening around the already-validated Yjs rollout path
- no remote deployment changes were required for this slice
