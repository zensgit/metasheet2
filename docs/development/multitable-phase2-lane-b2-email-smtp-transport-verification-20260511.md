# Multitable Phase 2 Lane B2 Email SMTP Transport - Verification

> Date: 2026-05-11
> Branch: `codex/multitable-phase2-email-smtp-transport-20260511`
> PR: #1462
> Baseline: `origin/main@a6835b1c2`
> Scope: focused verification for SMTP-backed `send_email`

## Source Recon

Starting point:

```bash
rg -n "nodemailer|smtp|SMTP|MULTITABLE_EMAIL" \
  package.json pnpm-lock.yaml packages/core-backend/package.json \
  docs/development packages/core-backend/src packages/core-backend/tests
```

Findings:

- B1 readiness exists and is merged.
- `EmailNotificationChannel` still defaulted to mock.
- No SMTP provider dependency existed before this branch.
- B2 should add provider runtime without changing automation routes, frontend editor, DingTalk, or the flat logs API.

## Tests Run

### SMTP readiness + channel unit tests

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/email-transport-readiness.test.ts --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       13 passed (13)
```

Covered:

- default mock mode remains pass;
- missing SMTP env is blocked;
- invalid SMTP port and optional SMTP transport values are blocked;
- SMTP config resolves host/port/TLS/timeouts;
- real-send smoke still requires `CONFIRM_SEND_EMAIL=1`;
- markdown and runtime redaction strip SMTP secrets and bearer-like tokens;
- mock mode still returns `sent`;
- injected SMTP transport sends expected `from`, `to`, `subject`, `text`, and headers;
- injected SMTP errors return controlled failed results with secrets redacted.

### Automation executor/service regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/automation-v1.test.ts --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       132 passed (132)
```

Purpose:

- Confirms `send_email` transport failure remains a failed automation step.
- Confirms `AutomationService.executeRule()` still records failed `send_email` executions.
- Confirms existing automation action regression suite stays green.

### Combined focused regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/email-transport-readiness.test.ts \
  tests/unit/automation-v1.test.ts --reporter=dot
```

Result:

```text
Test Files  2 passed (2)
Tests       145 passed (145)
```

### Readiness script tests

```bash
node --test scripts/ops/multitable-email-transport-readiness.test.mjs
```

Result:

```text
tests 4
pass 4
fail 0
```

Purpose:

- Confirms package script path still works after readiness shape changes.
- Confirms blocked SMTP config exits `2`.
- Confirms generated stdout/markdown/JSON artifacts do not expose configured secrets.

### Type check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: pass.

### Existing send_email smoke parse

```bash
pnpm --filter @metasheet/core-backend exec playwright test \
  --config tests/e2e/playwright.config.ts \
  tests/e2e/multitable-automation-send-email-smoke.spec.ts --list
```

Result:

```text
Total: 3 tests in 1 file
```

## Non-Verification

- No real SMTP server was contacted.
- No mailbox receipt was produced.
- The local Playwright `multitable-automation-send-email-smoke` was not run against a live dev stack in this branch; it remains a mock-mode smoke by default.
- Staging deployment was not touched.

## Risk Review

| Risk | Verification |
|---|---|
| Installing `nodemailer` changes default behavior | Unit test asserts mock mode is still default and returns `sent`. |
| SMTP mode silently mock-sends | Unit test asserts injected SMTP transport is called in SMTP mode. |
| Bad SMTP config proceeds to runtime | Readiness test blocks invalid port and missing required env. |
| SMTP errors leak credentials | Unit test verifies `failedReason` redacts SMTP user/password/from/host and bearer token values. |
| Automation crashes on provider failure | `automation-v1` regression verifies failed-step path and log recording. |

## Result

B2 is source-verified. Runtime SMTP sending is implemented behind `MULTITABLE_EMAIL_TRANSPORT=smtp`, while default CI/dev behavior remains mock. Real mailbox receipt validation remains an operator/staging action requiring real credentials.
