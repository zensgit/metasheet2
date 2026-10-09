# Approval & Process-Automation T1-2 Inbound Webhook — Development & Verification

Date: 2026-07-02
Status: built for review

## Scope

Implements the second-batch default for T1-2: make the existing `webhook.received` automation trigger real through a signed inbound HTTP endpoint.

This is backend/API-first. The rule-editor selector can be exposed in a later UI slice; the runtime no longer remains inert.

## Shipped Behavior

- Endpoint: `POST /api/multitable/automation/webhooks/:ruleId`.
- Signature: `X-MS-Webhook-Signature: sha256=<hex>` over `"${unixSeconds}.${rawBody}"`, with `X-MS-Webhook-Timestamp`.
- Replay window: timestamp must be within +/-300 seconds.
- Secret policy: `webhook.received` rules require a non-empty `trigger_config.secret` at create/update; legacy/direct-DB secret-less rules are blocked on any edit and rejected at ingest.
- Reject posture: unknown rule (`unknown_rule`), wrong trigger type (`wrong_trigger`), disabled rule (`disabled`), missing secret (`missing_secret`), missing or stale timestamp (`missing_timestamp`, `stale_timestamp`), missing or bad signature (`missing_signature`, `bad_signature`), missing body (`missing_body`), and invalid top-level JSON (`invalid_body`) all return `401 { ok:false }`. So does a rule whose sheet is soft-deleted (`sheet_deleted`, added by #5803). That reason is decided only after the signature verifies, so a request whose signature does not verify never triggers the sheet lookup and is never given this reason. The reason label appears only in the metric and the security log, never in the response.
- Observability: rejected attempts increment `automation_webhook_rejected_total{reason}` and write structured security logs; accepted attempts use the existing redacted automation execution log.
- Dispatch: synchronous inline execution; successful verification returns `202` after execution completes.
- Limits: 1 MB JSON body parser on the inbound path; per-rule rate limit 60/minute using the existing rate-limiter store.
- Secret redaction: HTTP rule serialization redacts `triggerConfig.secret`.

## Trust Boundary

The webhook route requires a valid session, but the handler ignores that session. The path is not an exception to the global session gate in `index.ts` (`GLOBAL_GATE_EXCEPTIONS` in `auth/api-path-policy.ts`), and it matches neither of the gate's request-based exceptions (the public-form token and the OAPI `mst_` allowlist). A request without a valid session JWT is therefore refused before it reaches the handler. Once it does reach the handler, the session plays no part. There is no table-permission check, only the per-rule secret (a verified signature) authorizes delivery, and the caller does not become a platform actor. (Correction, #5803: an earlier version of this section said the caller is anonymous.)

The request body is exposed as `recordData` for conditions/templates, but the actual executor context is synthetic:

- `recordId = ''`
- `sheetId = rule.sheet_id`
- `actorId = null`

Therefore body fields named `recordId`, `sheetId`, `actorId`, or similar are data only; they cannot retarget records or impersonate users.

## Verification

- Unit: `tests/unit/automation-inbound-webhook.test.ts`
  - strips `sha256=` before constant-time comparison,
  - rejects stale timestamps and bad signatures,
  - enforces save-boundary secret requirement,
  - redacts webhook secrets on HTTP serialization.
- Real DB / mounted route: `tests/integration/multitable-inbound-webhook-trigger.test.ts`
  - create/update secret gate,
  - mounted route rejects arrays, primitives, and empty body,
  - uniform 401 for unknown/wrong-trigger/disabled/bad-signature/stale/missing-secret,
  - accepted signed request writes a durable execution row,
  - malicious body `recordId` / `sheetId` / `actorId` stays inside `data` and cannot become execution context.
- CI wiring:
  - excluded from the no-DB Vitest run,
  - wired as a whole file into `.github/workflows/plugin-tests.yml` multitable real-DB lane.

Commands run locally:

```bash
pnpm install --frozen-lockfile --prefer-offline
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/core-backend exec vitest --config vitest.config.ts run tests/unit/automation-inbound-webhook.test.ts tests/unit/automation-routes-wiring.test.ts --reporter=dot
DATABASE_URL=${DATABASE_URL:-postgresql://postgres@localhost:5432/metasheet_test} pnpm --filter @metasheet/core-backend migrate
DATABASE_URL=${DATABASE_URL:-postgresql://postgres@localhost:5432/metasheet_test} pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-inbound-webhook-trigger.test.ts tests/integration/multitable-event-dedup-trigger.test.ts tests/integration/multitable-form-submit-trigger.test.ts tests/integration/automation-approval-completed-trigger.test.ts --reporter=dot
```

## Deferred

- Nonce/dedup for in-window replay. Timestamp freshness is v1; residual replay inside the 300 second window is known.
- Secret encryption at rest. V1 keeps plaintext parity with outbound webhook secrets and relies on response/log redaction.
- Rule-editor trigger exposure. This PR makes the backend trigger real; UI affordance can follow.
- Record-target mapping from webhook body. V1 does not let request payload fields retarget records or impersonate actors.
