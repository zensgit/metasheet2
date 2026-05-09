# Multitable RC Automation send_email Smoke · Development

> Date: 2026-05-07
> Branch: `codex/multitable-rc-smoke-automation-email-20260507`
> Base: `origin/main@bd3986143` (after the formula smoke + helpers extraction merged)
> Closes RC TODO line `Smoke test automation send_email save/execute path` — the **last** of the six RC smoke items.

## Background

After PR #1424 merged, five of the six RC smoke items were complete (lifecycle, public-form, hierarchy, gantt, formula). The remaining item — `Smoke test automation send_email save/execute path` — was held back pending an email-mock design decision: pure config-validation smoke (weak), end-to-end through the existing default mock email channel (medium), or a new dev-only inspect endpoint (strong but adds a dev attack surface).

After confirming the existing infrastructure already covers what the medium option needs:

- `EmailNotificationChannel` in `packages/core-backend/src/services/NotificationService.ts` is mock-ish: it logs, awaits ~100 ms, and returns `{ status: 'sent', metadata: { channel: 'email', recipientCount } }`. No real SMTP transport is required.
- `automation-executor.ts` `executeSendEmailAction` calls `NotificationService.send({ channel: 'email', ... })` and returns `{ actionType: 'send_email', status: 'success', output: { notificationId, notificationStatus, recipientCount } }`.
- An automation execution log API already exists: `GET /api/multitable/sheets/:sheetId/automations/:ruleId/logs?limit=N` returns a flat `{ executions: AutomationExecution[] }` shape (NOT the standard `{ ok, data }` envelope; documented inline in `routes/automation.ts` at the handler).

Option 2 (medium) was the natural pick: 0 backend changes, exercises the real event chain, and produces specific assertions on each step of the executor's published contract.

## Scope

### In

- New Playwright spec `packages/core-backend/tests/e2e/multitable-automation-send-email-smoke.spec.ts` containing three `test` cases:
  1. **End-to-end**: admin creates a sheet + Title (string) + Owner (string) + grid view, then POSTs a rule with `triggerType: 'record.created'`, `actionType: 'send_email'`, and `actionConfig: { recipients: ['team@test.local', 'lead@test.local'], subjectTemplate, bodyTemplate }`. The templates reference `{{recordId}}` and `{{record.<fieldId>}}` to exercise the same dot-path renderer used by production automation. Because this option intentionally avoids a test-only notification-history endpoint, the smoke asserts the sent-step contract rather than rendered email content. The spec then creates a real record (which fires the actual `record.created` event chain, NOT the `/test` endpoint), polls `GET .../logs?limit=10` for up to 12 s with 1 s interval, and asserts the resulting `AutomationExecution`:
     - `execution.status === 'success'`
     - `execution.steps[0].actionType === 'send_email'`
     - `execution.steps[0].status === 'success'`
     - `execution.steps[0].output.recipientCount === recipients.length`
     - `execution.steps[0].output.notificationStatus === 'sent'`
  2. **`recipients` missing rejection**: POST the rule with `recipients: []` → 400 + `error.code === 'VALIDATION_ERROR'` + `error.message === 'send_email requires at least one recipient'`. Exercises `validateSendEmailConfig` (`packages/core-backend/src/multitable/automation-service.ts`) through the HTTP boundary.
  3. **`subjectTemplate` missing rejection**: POST the rule with `subjectTemplate: ''` → 400 + `error.code === 'VALIDATION_ERROR'` + `error.message === 'send_email subjectTemplate is required'`. Same validator, different field.
- README addition listing the new spec.
- RC TODO line ticked in the same commit with PR / dev MD / verification MD pointers.

### Out

- A backend `GET /api/dev/notification-history` inspect endpoint. The medium option's coverage already validates the `output.notificationStatus === 'sent'` contract, which is the wire-level signal that the channel ran. Adding a dev-only history endpoint just for the smoke would create an attack surface (cross-tenant leakage, env-gate maintenance) without strengthening the contract being tested.
- Triggering through `POST /sheets/:sheetId/automations/:ruleId/test`. The user brief explicitly required the **real event chain**, not the synthetic /test endpoint, so a regression in the eventBus dispatch path would also surface.
- DingTalk action types (`send_dingtalk_group_message`, `send_dingtalk_person_message`). Out of scope — they have separate channels and their own coverage in the dingtalk delivery routes.
- Custom email transport configuration. The default `EmailNotificationChannel` mock is what runs in dev/CI; if a future deployment plugs a real SMTP transport, this smoke would still assert `status: 'sent'` because that is the channel-result contract.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Adds a test harness for already-shipped multitable surface — no new platform capability and no new endpoint.
- Does NOT touch DingTalk / public-form runtime / Gantt / Hierarchy / formula / automation runtime / migration / OpenAPI; only consumes existing endpoints.

## Implementation notes

### Why the spec uses a direct `request.get` for `/logs`, not the helper module

The shared `AuthClient.get<T>(path)` returns `ApiEnvelope<T>` and assumes the standard `{ ok, data }` wrapper used everywhere else in the multitable router. The automation logs endpoint is documented in `routes/automation.ts:14-17` as returning a flat shape: `logs → { executions: AutomationExecution[] }`. Routing this one call through the envelope-typed helper would either silently produce `data === undefined` or require extending the helper module to ship an envelope-less variant. Inline `request.get` with the auth header is two lines and clarifies the intent at the call site; if a second flat-shape endpoint joins the family, helper extension becomes worth it.

### Why poll for up to 12 s with a 1 s interval

Automation execution is event-driven and asynchronous; the `record.created` event is published, the executor enqueues work, and the channel mock further delays ~100 ms. A fixed `setTimeout(2_000)` would race; an unbounded wait would never time out. 12 s is `>10 s` (the explicit user budget) plus headroom for cold-start dev environments where the first record-create-event after server boot can take a couple of extra seconds. The polling step is 1 s rather than 200 ms because the log endpoint hits a non-trivial query path; the smoke does not need to be fast, it needs to be deterministic.

### Why `templates` reference `{{record.<fieldId>}}` rather than `{{record.title}}`

`renderAutomationTemplate` (`packages/core-backend/src/multitable/automation-executor.ts`) does dot-path lookup against the `templateData` object, where `record` is the persisted record's `data` map. Field values are keyed by field id (`fld_xxx`), not human name. Using `{{record.${title.id}}}` keeps the smoke aligned with the real template shape. This spec does not inspect rendered email content; that stronger assertion would require the explicitly-deferred notification-history endpoint noted under Known limitations.

### Why the negative tests assert exact message strings

`validateSendEmailConfig` returns one of three exact strings: `'send_email requires at least one recipient'` / `'send_email subjectTemplate is required'` / `'send_email bodyTemplate is required'`. Asserting status code + `error.code === 'VALIDATION_ERROR'` alone would let a regression that returned 400 + a generic "validation failed" message pass; matching the exact string keeps the contract pinned. A future reviewer who refactors the message must update the test, which is the desired coupling.

### Why the third "bodyTemplate missing" case is omitted

It would be a third repeat of the same validator, asserting the same code path with a different field's exact-message string. The recipients + subjectTemplate cases together prove the validator wires error path → HTTP 400 → envelope → message; bodyTemplate is mechanically identical. Three near-identical assertions add maintenance load without increasing coverage of distinct invariants.

## Files changed

| File | Lines |
|---|---|
| `packages/core-backend/tests/e2e/multitable-automation-send-email-smoke.spec.ts` | +new (~205) |
| `packages/core-backend/tests/e2e/README.md` | +1 |
| `docs/development/multitable-feishu-rc-todo-20260430.md` | tick send_email line + PR/MD pointers |
| `docs/development/multitable-rc-automation-send-email-smoke-development-20260507.md` | +new |
| `docs/development/multitable-rc-automation-send-email-smoke-verification-20260507.md` | +new |

## Known limitations

1. **CI does not provision the dev stack** — same caveat as the five prior RC smoke specs.
2. **Mock channel covers `status: 'sent'`, not subject/body content** — the `notificationStatus` assertion proves the channel ran; matching the rendered `subject` / `content` strings would require either an env-gated inspect endpoint or threading the in-memory history through a test-only route. Out of scope per the design discussion.
3. **Test data not cleaned up** — `uniqueLabel` prevents collisions; matches the prior smoke policy.
4. **Polling is 12 s deterministic, not flaky-resistant beyond that** — if a heavily loaded dev box delays automation execution past 12 s, the test will fail with the last-seen logs body in the error message, which is the desired loud failure rather than a silent skip.

## Cross-references

- RC TODO master: `docs/development/multitable-feishu-rc-todo-20260430.md`
- Send_email validator: `validateSendEmailConfig` in `packages/core-backend/src/multitable/automation-service.ts`
- Send_email executor: `executeSendEmailAction` in `packages/core-backend/src/multitable/automation-executor.ts`
- Default mock channel: `EmailNotificationChannel` in `packages/core-backend/src/services/NotificationService.ts`
- Automation logs API contract: `packages/core-backend/src/routes/automation.ts` header comment
- Pattern source: PR #1424 — multitable formula smoke + helpers extraction
