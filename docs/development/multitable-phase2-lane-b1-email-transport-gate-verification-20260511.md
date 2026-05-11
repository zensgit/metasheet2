# Multitable Phase 2 Lane B1 Email Transport Gate - Verification

> Date: 2026-05-11
> Branch: `codex/multitable-phase2-email-transport-gate-20260511`
> PR: #1461
> Baseline: `origin/main@013797fc3`
> Scope: focused verification for env-gated `send_email` transport readiness

## Source Recon

Confirmed current `send_email` state:

```bash
rg -n "send_email|EmailNotificationChannel|SMTP|notificationStatus" \
  packages/core-backend/src packages/core-backend/tests scripts docs/development
```

Findings:

- `send_email` is wired through automation validation, executor, frontend editor, RC Playwright smoke, and staging API harness.
- `EmailNotificationChannel` was still mock-only.
- There is no SMTP/provider dependency in the workspace.
- Existing RC smoke asserts `notificationStatus === "sent"` from mock delivery, not mailbox receipt.

Confirmed Lane A is already complete:

```bash
rg -n "longText|long text|#1449" \
  docs/development packages/core-backend/src apps/web/src packages/openapi/src/base.yml \
  apps/web/tests packages/core-backend/tests/unit
```

Result: PR #1449 audit coverage is merged, and `longText` is present across backend, frontend, OpenAPI, XLSX, and tests.

## Tests Run

### Readiness resolver + channel gate

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/email-transport-readiness.test.ts --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       8 passed (8)
```

Covered:

- mock mode is default;
- SMTP mode with missing provider env is `blocked`;
- complete SMTP env passes readiness without sending;
- real-send smoke requires `CONFIRM_SEND_EMAIL=1`;
- markdown rendering redacts SMTP secrets and bearer-like values;
- `EmailNotificationChannel` still sends through mock mode by default;
- explicit SMTP mode fails controlled until B2 implements the provider.

### Automation executor regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/automation-v1.test.ts --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       132 passed (132)
```

New assertion:

- `send_email` transport failure becomes a failed automation step with the failed notification result preserved in step output.
- `AutomationService.executeRule()` still records that failed execution through the log service.

### Ops script tests

```bash
node --test scripts/ops/multitable-email-transport-readiness.test.mjs
```

Result:

```text
tests 4
pass 4
fail 0
```

Covered:

- default package/script path passes in mock mode;
- SMTP mode with incomplete env exits `2`;
- generated markdown/JSON/stdout/stderr do not contain raw SMTP URL credentials, tokens, password values, or private sender addresses;
- `pnpm verify:multitable-email:readiness` works.

### Manual script probes

```bash
pnpm exec tsx scripts/ops/multitable-email-transport-readiness.ts >/tmp/email-readiness-mock.out

set +e
MULTITABLE_EMAIL_TRANSPORT=smtp \
  pnpm exec tsx scripts/ops/multitable-email-transport-readiness.ts \
  >/tmp/email-readiness-blocked.out
code=$?
set -e
printf 'blocked_exit=%s\n' "$code"
grep -q 'smtp-password-secret\|Bearer raw-token-value\|ops-private@example.com' \
  /tmp/email-readiness-blocked.out && echo 'secret_leak' || echo 'no_secret_leak'
```

Result:

```text
blocked_exit=2
no_secret_leak
```

### Type check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: pass.

### Playwright smoke parse

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

- No real email was sent.
- No SMTP/provider connection was attempted.
- The local Playwright RC smoke was not rerun against a live dev stack in this branch; the default mock path is covered by the new channel unit test and the existing RC/staging harness remains unchanged.

## Risk Review

| Risk | Verification |
|---|---|
| SMTP env missing but release gate reports pass | Script test asserts exit `2` and `status: "blocked"`. |
| Secrets leak into reports | Unit and script tests assert raw SMTP URL credentials, token, password, and sender address are absent. |
| Mock mode regresses | Channel unit test asserts default mock send still returns `sent`. |
| Explicit SMTP mode falsely reports `sent` before B2 | Channel unit test asserts controlled failed result. |
| Automation executor crashes on transport failure | `automation-v1` regression asserts failed step output instead. |

## Result

Lane B1 is ready for review. It adds a safe readiness seam and no-send release gate for future real email transport work while preserving default mock behavior.
