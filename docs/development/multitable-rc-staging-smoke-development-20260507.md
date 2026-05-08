# Multitable RC Staging Smoke — Remote Verification Harness · Development

> Date: 2026-05-07
> Branch: `codex/multitable-rc-staging-smoke-20260507`
> Base: `origin/main@20fb5270a` (after the autoNumber backfill perf merge)
> Scope: RC validation tooling, not a feature change. Fits the bugfix-only window opened for the RC closeout.

## Background

The local Playwright specs at `packages/core-backend/tests/e2e/multitable-*-smoke.spec.ts` cover the six RC TODO smoke surfaces against a local dev stack and skip when servers are unreachable. They do not run against a deployed staging URL, and the existing `scripts/verify-multitable-live-smoke.mjs` (3 644 lines, Playwright + browser) does not cover the recent RC additions — a grep confirmed zero hits for `send_email`, `autoNumber`, `hierarchy` cycle guard, `dependencyFieldId`, or `publicForm` / `publicToken` / `public-form` in that file.

For the RC closeout we need an automated, browser-free, fail-loud harness against the deployed staging that exercises the RC surfaces and produces a report operators can pin to a release decision. This PR adds it.

## Scope

### In

- New script `scripts/verify-multitable-rc-staging-smoke.mjs` (~510 LOC) covering seven checks against any deployed multitable backend reachable at `${API_BASE}` with an admin Bearer token at `${AUTH_TOKEN}`:
  1. `lifecycle` — base/sheet/field/view/record + GET records readback
  2. `public-form` — admin enables `accessMode: 'public'`, anonymous `POST /views/:viewId/submit` with the issued `publicToken`, admin verifies persisted record; plus a stale-token negative
  3. `hierarchy` — self-table single-value link parent + PATCH self-parent → 400 + `error.code === 'HIERARCHY_CYCLE'`
  4. `gantt-config` — gantt view PATCH with non-link `dependencyFieldId` → 400 + `VALIDATION_ERROR` + message contains `self-table link field`
  5. `formula` — formula field with `={A.id}+{B.id}` expression + GET fields verifies persisted property
  6. `automation-email` — `record.created` → `send_email` rule + creating a record fires the real event chain → poll `/logs?limit=10` (default 12 s timeout, 1 s interval) → assert `execution.status === 'success'`, `step.actionType === 'send_email'`, `step.status === 'success'`, `step.output.recipientCount === 2`, `step.output.notificationStatus === 'sent'`
  7. `autoNumber-backfill` — pre-create 3 records, then add an `autoNumber` field with `start: 1000, prefix: 'INV-', digits: 4` → assert all 3 pre-existing records receive backfilled values, raw client write returns 403 + `FIELD_READONLY`, and a post-backfill record receives `value >= start + 3`
- New package.json script `verify:multitable-rc:staging` that invokes the harness via `node scripts/...mjs`.
- Outputs `report.json` + `report.md` under `${OUTPUT_DIR}` (default `output/multitable-rc-staging-smoke`). Each row records pass/fail/skip + duration; failures include a stack-printable error string. Exit code 0 = all pass, 1 = at least one fail, 2 = env / fatal before any check ran.
- Supports `SKIP=automation-email,autoNumber-backfill` env to skip specific checks (useful when the staging deployment hasn't yet caught up to the latest perf merge).

### Out

- Browser-driven UI clicks. The companion human-smoke pass and Codex's RC checklist exercise the click-driven flows; this harness is the API-layer net.
- Real SMTP delivery validation. The default `EmailNotificationChannel` mocks the send and returns `notificationStatus === 'sent'`; the harness validates the wire, not actual mail receipt.
- DingTalk-protected public form access modes. The lifecycle / public-form smokes already cover the `'public'` access mode; protected modes belong to a separate harness.
- The legacy `verify-multitable-live-smoke.mjs`. That script is a 3 644-line Playwright harness covering different (and earlier) surfaces; this PR does not modify it.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Pure RC validation tooling — no user-facing feature change, no migration, no OpenAPI change. Fits the explicit "bugfix-only window for RC" framing.
- Does NOT touch DingTalk / public-form runtime / Gantt / Hierarchy / formula / automation runtime; only consumes existing public REST endpoints.

## Implementation notes

### Why a dedicated script instead of extending `verify-multitable-live-smoke.mjs`

That script is 3 644 lines of Playwright + browser. Adding seven HTTP-only checks to it means either (a) splitting its top-level runner to support a "no-browser" mode, or (b) leaving the new checks coupled to a Playwright dependency that the harness doesn't need. A clean separate script is small (~510 LOC), independent, and can be invoked from CI or operators without spinning up a browser.

### Why `node:fetch` and not `node-fetch` or axios

Node 18+ ships `fetch` in the global. The repo's CI matrix (per `package.json` engines + the existing 18.x/20.x test matrix) is comfortably above that. No new dep.

### Why each check creates its own base + sheet

Tests must be hermetic against staging fixture drift. Each check uses `uniqueLabel('<surface>')` with a process-wide `stamp` + per-check random suffix; collisions between concurrent runs are negligible. The fixtures persist after the run (matching the existing pilot-smoke convention) — operators can inspect them post-failure.

### Why `automation-email` polls `/logs` rather than calling `/test`

The user brief on the `send_email` smoke explicitly required the real event chain: a `record.created` event must drive the executor, not a synthetic `/test` invocation. The same constraint applies to staging validation. The polling window is configurable via `POLL_TIMEOUT_MS` and `POLL_INTERVAL_MS`; the defaults (12 s / 1 s) match the local Playwright spec.

### Why the `autoNumber-backfill` check pre-creates records

The check value-add is verifying that adding an `autoNumber` field to a sheet that already has data does the backfill. The PR #1431 perf change collapsed the N+1 UPDATE into a single window-function UPDATE; staging validation should confirm the resulting backfill is observable through the public API. Three records is enough to assert "all pre-existing records receive a value" without bloating the smoke.

### Why exit codes 0 / 1 / 2 are distinct

Operators wrap this in deploy gates. Distinguishing "env not configured" (exit 2) from "checks ran and failed" (exit 1) lets the gate either block the rollout (1) or surface a configuration issue (2) with different alert paths.

## Files changed

| File | Lines |
|---|---|
| `scripts/verify-multitable-rc-staging-smoke.mjs` | +new (~510) |
| `package.json` | +1 (script entry `verify:multitable-rc:staging`) |
| `docs/development/multitable-rc-staging-smoke-development-20260507.md` | +new |
| `docs/development/multitable-rc-staging-smoke-verification-20260507.md` | +new |

## Known limitations

1. **Fixtures are not cleaned up** — matches the existing pilot-smoke convention; timestamp + random suffix prevents collisions.
2. **Single-tenant assumption** — the script uses a single AUTH_TOKEN to act as the operator. Multi-tenant scenarios require separate runs with different tokens.
3. **No real SMTP** — `notificationStatus === 'sent'` proves the channel returned, not that an inbox received the message.
4. **Polling deadline of 12 s** — heavy staging load can push automation execution beyond this. The error path includes the last logs body for diagnostic context; raise `POLL_TIMEOUT_MS` if false-fails appear under load.
5. **DingTalk-protected access modes uncovered** — accessMode `'dingtalk'` and `'dingtalk_granted'` need DingTalk corp tenant fixtures; out of scope.

## Cross-references

- RC TODO master: `docs/development/multitable-feishu-rc-todo-20260430.md`
- Companion local Playwright specs: `packages/core-backend/tests/e2e/multitable-*-smoke.spec.ts`
- Existing live-smoke harness (different scope, not modified): `scripts/verify-multitable-live-smoke.mjs`
- Existing pilot-smoke harness (Playwright-based): `scripts/ops/multitable-pilot-staging.sh`
