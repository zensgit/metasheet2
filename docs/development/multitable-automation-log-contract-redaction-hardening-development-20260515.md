# Multitable Automation Log Viewer — Contract + Redaction Hardening (Development)

- Date: 2026-05-15
- Branch: `codex/multitable-automation-log-viewer-hardening-20260515`
- Base: `origin/main` at `dca447981`
- Author: Claude (Opus 4.7, 1M context), interactive harness; operator-supervised
- Scope owner: operator (revised the scope after read-only scouting found
  the underlying log infrastructure already shipped; this is a hardening
  PR, not a from-scratch build).
- Redaction policy: this PR contains no AI provider key, SMTP
  credential, JWT, bearer token, DingTalk webhook URL or robot
  `SEC...`, K3 endpoint password, Agent ID value, recipient user id,
  temporary password, or `.env` content. Test fixtures use
  deliberately leaky sentinel strings (e.g. `raw-leak-token-12345`,
  `qa-private@example.com`) which the production redactor must scrub —
  asserted by the new tests.

## Why this PR exists

Pre-existing shipped infrastructure:

- Persistence: `multitable_automation_executions` migration.
- Service: `packages/core-backend/src/multitable/automation-log-service.ts`
  (`getByRule`, `getStats`, `getById`, `getRecent`, `record`,
  `cleanup`).
- API: `GET /api/multitable/sheets/:sheetId/automations/:ruleId/logs`
  and `/stats`, response shape `{ executions: [...] }` and flat
  `AutomationStats`.
- Frontend: `apps/web/src/multitable/components/MetaAutomationLogViewer.vue`
  + a "View Logs" button on each rule card in
  `MetaAutomationManager.vue`.
- Tests: `packages/core-backend/tests/unit/automation-routes-wiring.test.ts`
  (route shape) plus the send_email e2e smoke covering basic `/logs`
  response.

What the operator's read-only scout surfaced as **broken**:

1. **Frontend / backend contract mismatch.** Backend returns
   `triggeredAt`, `triggeredBy`, `duration` per the
   `automation-routes-wiring.test.ts` fixture (line 42-43). The
   frontend interface declared `startedAt`, `triggerType`, `durationMs`.
   The viewer therefore rendered every log time as `Invalid Date`,
   every trigger column empty, and every duration as `undefined ms`.
2. **Stats field mismatch.** Backend exposes `avgDuration`; frontend
   read `stats.avgDurationMs`. Result: the stats bar always showed
   `undefinedms`.
3. **Step output rendered as `JSON.stringify(step.output)` with no
   redaction.** Automation actions write recipient lists, DingTalk
   `receiverUserIds`, webhook URLs (with `access_token=` query
   parameters), and step error messages that may contain SMTP
   credentials / Bearer tokens / OPENAI_API_KEY values. The previous
   render path leaked any of these directly to the DOM.
4. **Silent catch in `loadData`.** A network failure or stats
   endpoint outage was indistinguishable from an empty rule — the
   panel just showed "No execution logs found."
5. **Limit semantics already correct.** Frontend requests
   `limit=50`, backend clamps to `[1, 200]` per the wiring test, so
   no pagination change is required by this PR.

This PR addresses (1)–(4). It does **not** add cursor pagination,
new endpoints, new action types, executor changes, or anything
outside the multitable automation log viewer surface.

## Files changed

| Path | Change | Note |
| --- | --- | --- |
| `apps/web/src/multitable/types.ts` | modify | Rename `AutomationExecution.startedAt / triggerType / durationMs` to backend-shaped `triggeredAt / triggeredBy / duration`; remove unused `durationMs?` alias. Rename `AutomationStats.avgDurationMs` to `avgDuration`. Add JSDoc explaining each backend column source. |
| `apps/web/src/multitable/utils/automation-log-redact.ts` | new | DOM-safe TypeScript port of the Phase 3 server-side redactor, plus automation-specific structured-field keys: `receiverUserIds`, `receiver_user_ids`, `userIds`, `user_ids`, `cc`, `bcc`, `subject`, `emailSubject`. Exports `redactString`, `redactValue`, `summarizeStepOutput` (280-char cap with `...` suffix), `summarizeStepError`. |
| `apps/web/src/multitable/components/MetaAutomationLogViewer.vue` | modify | Read `triggeredAt / triggeredBy / duration` and `stats.avgDuration`. Render `step.output` via `summarizeStepOutput` and `step.error` via `summarizeStepError`. Replace the silent catch with a visible `loadError` state including a Retry button; the empty-state placeholder is suppressed while the error block is shown. New `loadError` ref, redaction of the error message itself, and `data-` attributes for test selectors. |
| `apps/web/src/multitable/components/MetaAutomationManager.vue` | modify | One small fix to `describeTestRunExecution`: read `execution.duration` directly (previous fallback `durationMs ?? duration` referenced the removed alias). |
| `apps/web/tests/automation-log-redact.spec.ts` | new | 23 unit tests covering the redactor (Bearer / JWT / SEC / sk- / access_token / sign / timestamp / env-style `*_API_KEY|CLIENT_SECRET|TOKEN|PASSWORD` / bare and prefixed `SMTP_*` / `MULTITABLE_EMAIL_SMOKE_*` / postgres / mysql; structured-field masking; summarize / truncate / empty-input cases). |
| `apps/web/tests/MetaAutomationLogViewer.spec.ts` | new | 12 component tests covering: 4 backend-contract normalization assertions (`triggeredAt`, `triggeredBy`, `duration`, `avgDuration`); 3 step output / error redaction assertions using `LEAKY_EXECUTION` fixture; 5 load-failure assertions (logs error, stats error, redacted error message, retry button presence, empty-state suppression while error is shown). |
| `docs/development/multitable-automation-log-contract-redaction-hardening-development-20260515.md` | new | this file |
| `docs/development/multitable-automation-log-contract-redaction-hardening-verification-20260515.md` | new | verification MD |

No change to:

- `packages/core-backend/src/multitable/automation-log-service.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/src/routes/automation.ts` (or wherever the
  `/logs` and `/stats` routes are mounted)
- Any migration
- `plugins/plugin-integration-core/`
- `lib/adapters/k3-wise-*`
- Attendance / Data Factory / DingTalk surfaces (purely multitable
  domain change)

## Backend contract (unchanged)

For reference — this PR reads from but does not modify:

```text
GET /api/multitable/sheets/:sheetId/automations/:ruleId/logs?limit=50
  → 200 OK
  {
    "executions": [
      {
        "id": "...",
        "ruleId": "...",
        "triggeredBy": "event" | "scheduler" | "manual" | "<username>",
        "triggeredAt": "<iso>",
        "status": "success" | "failed" | "skipped",
        "duration": <ms>,
        "steps": [
          { "actionType": "...", "status": "...", "durationMs": <ms>,
            "output": <unknown>, "error": "<string>" }
        ],
        "error": "<string?>"
      }
    ]
  }

GET /api/multitable/sheets/:sheetId/automations/:ruleId/stats
  → 200 OK
  { "total": N, "success": N, "failed": N, "skipped": N, "avgDuration": <ms> }
```

The `/logs` `limit` is server-clamped to `[1, 200]`; frontend default
is `50`.

## Redaction coverage

The new `automation-log-redact.ts` covers 11 string-pattern classes
plus 24 structured-field keys.

String patterns (12 distinct rules, one absorbs SMTP into prefix-aware
form):

1. `Bearer <token>` HTTP auth header
2. JWT (`eyJ...`-prefixed)
3. DingTalk robot `SEC...` secret
4. OpenAI / Anthropic / generic `sk-...` keys
5. `access_token=...` URL query
6. `publicToken=...` URL query
7. `sign=` / `timestamp=` DingTalk signed URL queries
8. Generic env-style `*_API_KEY` / `*_CLIENT_SECRET` / `*_TOKEN` /
   `*_SECRET` / `*_PASSWORD` assignments
9. Prefix-aware `SMTP_USER` / `SMTP_PASS` / `SMTP_PASSWORD` /
   `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` assignments (covers
   bare `SMTP_*` and project-prefixed `MULTITABLE_EMAIL_SMTP_*`)
10. `MULTITABLE_EMAIL_SMOKE_TO` / `_FROM` / `_SUBJECT` envelope env
    names
11. `postgres://user:pass@host` URI credentials
12. `mysql://user:pass@host` URI credentials

Structured-field set (`STRUCTURED_FIELDS_TO_REDACT`):

- Auth / API: `authToken`, `auth_token`, `accessToken`,
  `access_token`, `apiKey`, `api_key`, `clientSecret`,
  `client_secret`, `jwt`, `bearer`
- Passwords: `password`, `smtpPassword`, `smtp_password`,
  `smtpUser`, `smtp_user`, `smtpHost`, `smtp_host`
- Webhooks: `webhook`, `webhookUrl`, `webhook_url`
- Recipients (email + DingTalk): `recipient`, `recipients`, `to`,
  `emailTo`, `email_to`, `cc`, `bcc`, `receiverUserIds`,
  `receiver_user_ids`, `userIds`, `user_ids`
- Subject (may contain customer names / order ids): `subject`,
  `emailSubject`, `email_subject`

## Stage-1 lock compliance

| Check | Result |
| --- | --- |
| No change under `plugins/plugin-integration-core/*` | PASS |
| No change under `lib/adapters/k3-wise-*` | PASS |
| No new product战线 | PASS — hardens an already-shipped feature |
| No schema / migration / route / workflow change | PASS |
| No change to existing automation harness or services | PASS |
| Kernel polish on already-shipped automation logs UI | PASS |

Falls under `project_k3_poc_stage1_lock.md` permitted category:
"Ops/observability打磨 on shipped features (correlation-id, SLA
leader-lock, breach notify channels)".

## Cross-references

- `packages/core-backend/src/multitable/automation-log-service.ts` —
  backend service shape this PR aligns the frontend to.
- `packages/core-backend/tests/unit/automation-routes-wiring.test.ts` —
  authoritative source for the `/logs` response shape (line 60-74)
  and the `triggeredAt / triggeredBy` field names (line 42-43).
- `apps/web/src/multitable/components/MetaAutomationLogViewer.vue` —
  the panel hardened by this PR.
- `apps/web/src/multitable/components/MetaAutomationManager.vue` —
  hosts the "View Logs" button + a minor downstream fix in
  `describeTestRunExecution`.
- `scripts/ops/multitable-phase3-release-gate-redact.mjs` — the
  server-side redactor whose patterns this PR ports to the UI bundle.
- `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md` —
  prior posture on redaction discipline and stage-1 lock framing.

## Follow-ups (not in this PR)

- Bulk Edit Result Detail UI is intentionally deferred (operator's
  priority call).
- Manual rerun / failure retry / conditional branch / cursor
  pagination are downstream lanes that depend on run history being
  trustworthy — that trust is what this PR establishes.
