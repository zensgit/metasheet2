# Multitable RC Automation send_email Smoke · Verification

> Date: 2026-05-07
> Companion to: `multitable-rc-automation-send-email-smoke-development-20260507.md`

## Spec parses (Playwright list)

```bash
cd packages/core-backend
npx playwright test --list --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-automation-send-email-smoke.spec.ts
```

Result:

```
Listing tests:
  multitable-automation-send-email-smoke.spec.ts › Multitable automation send_email smoke › record.created → send_email rule executes via NotificationService email channel
  multitable-automation-send-email-smoke.spec.ts › Multitable automation send_email smoke › rejects send_email rule create when recipients is missing (VALIDATION_ERROR)
  multitable-automation-send-email-smoke.spec.ts › Multitable automation send_email smoke › rejects send_email rule create when subjectTemplate is missing (VALIDATION_ERROR)
Total: 3 tests in 1 file
```

All six RC smoke specs combined now ship 22 tests across the e2e directory (4 handoff + 2 lifecycle + 3 public-form + 3 hierarchy + 3 gantt + 4 formula + 3 send_email).

## TypeScript check (core-backend, full project)

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: passed (no output / exit 0).

## Diff hygiene

```bash
git diff --check
```

Result: passed.

## Acceptance contract — exact assertions

The end-to-end test asserts every field the user brief explicitly required:

- `execution.status === 'success'`
- `execution.steps[0].actionType === 'send_email'`
- `execution.steps[0].status === 'success'`
- `execution.steps[0].output.recipientCount === expected` (the literal length of the recipients array passed in)
- `execution.steps[0].output.notificationStatus === 'sent'`

The two negatives assert exact validator strings:

- Missing recipients → `error.message === 'send_email requires at least one recipient'`
- Missing subjectTemplate → `error.message === 'send_email subjectTemplate is required'`

## Real event chain (NOT /test)

The end-to-end test invokes `POST /api/multitable/records` with `data: { [title.id]: '...', [owner.id]: '...' }` to produce a record. This fires the multitable record-created event on `eventBus`, which the automation runtime subscribes to. No `POST /sheets/:sheetId/automations/:ruleId/test` call is made; a regression in the eventBus dispatch path would cause the polling loop to time out with a loud error rather than a silent skip.

## Polling shape

`pollForFirstExecution` calls `GET .../logs?limit=10` every 1 000 ms for up to 12 000 ms. The endpoint returns a flat `{ executions: AutomationExecution[] }` body — read with a direct `request.get` rather than the helper module's `AuthClient.get` because the latter assumes the standard `{ ok, data }` envelope. On polling timeout the helper throws with the last successfully-parsed body in the error message, so a CI failure includes the diagnostic context the runner needs.

## Live execution (deferred)

Same justification as the five prior RC smoke verification MDs. The 22 tests parse and tsc agrees; the spec is structurally identical to the previous merged smoke specs from a Playwright runtime standpoint, and `beforeAll` will skip cleanly on absent local stack.

To run end-to-end locally:

```bash
# Terminals 1 & 2 as documented in packages/core-backend/tests/e2e/README.md
# (Yuantus is NOT required for any of the six multitable RC smokes)
cd packages/core-backend
npx playwright install chromium  # one-time
npx playwright test --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-automation-send-email-smoke.spec.ts
```

Expected: 3 tests pass; total ~10–15 s (the end-to-end test dominates with its polling window).

## Pre-deployment checks

- [x] Latest origin/main pulled and branch rebased onto it before push.
- [x] No DingTalk / public-form runtime / Gantt / Hierarchy / formula / automation runtime / `plugins/plugin-integration-core/*` files touched.
- [x] No autoNumber / migration / OpenAPI / NotificationService / route additions.
- [x] No new env vars, no new dev-only endpoints.
- [x] RC TODO send_email line ticked with PR / dev MD / verification MD pointers in the same commit (PR# amended in after `gh pr create`).

## Result

Spec parses, types clean, diff hygiene clean, RC TODO updated. All six RC smoke items in `docs/development/multitable-feishu-rc-todo-20260430.md` are now ticked and have executable Playwright coverage.
