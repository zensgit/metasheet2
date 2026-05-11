# Multitable Phase 2 Lane B3 Email Real-Send Smoke - Verification

> Date: 2026-05-11
> Branch: `codex/multitable-phase2-email-real-smoke-20260511`
> PR: #1465
> Baseline: `origin/main@ca70e340a`
> Scope: source verification for guarded real-send SMTP smoke harness

## Tests Run

### Harness unit tests

```bash
node --test scripts/ops/multitable-email-real-send-smoke.test.mjs
```

Result:

```text
tests 4
pass 4
fail 0
```

Covered:

- real-send smoke blocks unless `MULTITABLE_EMAIL_REAL_SEND_SMOKE=1` and `CONFIRM_SEND_EMAIL=1` are set;
- real-send smoke blocks when `MULTITABLE_EMAIL_SMOKE_TO` is missing;
- blocked artifacts redact SMTP URL credentials, URL token parameters, bearer-like passwords, SMTP from address, and recipient address;
- package script `pnpm verify:multitable-email:real-send` launches the harness.

### Default blocked command

```bash
pnpm verify:multitable-email:real-send
```

Result:

```text
exit code 2
Status: `blocked`
Mode: `mock`
Recipient configured: `no`
```

Purpose:

- Confirms the operator-facing command is fail-closed by default.
- Confirms no real email is attempted without explicit SMTP mode, real-send guard, confirm guard, and recipient env.

### Existing readiness script regression

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

- Confirms B3 did not regress the B1 no-send readiness gate.

### Email transport unit regression

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/email-transport-readiness.test.ts --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       13 passed (13)
```

Purpose:

- Confirms B2 SMTP config and transport behavior remain source-verified.

### Type check

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
```

Result: pass.

### Diff hygiene

```bash
git diff --check
```

Result: pass.

## Non-Verification

- No real SMTP server was contacted.
- No mailbox receipt was produced.
- No staging deployment was touched.
- No SMTP credential was provided to this source verification run.

## Risk Review

| Risk | Verification |
| --- | --- |
| A developer accidentally sends real email by running the package script | Default command exits `2` and sends nothing. |
| Real-send smoke runs with incomplete env | Tests cover missing guards and missing recipient. |
| Reports expose SMTP secrets or recipient addresses | Redaction test scans stdout, stderr, markdown, and JSON. |
| B3 regresses B1 readiness behavior | Existing readiness script tests remain green. |
| B3 regresses B2 runtime types | Core backend `tsc --noEmit` remains green. |

## Result

B3 is source-verified. The repo now has a guarded, repeatable command for the remaining B2 staging evidence item. Actual mailbox receipt remains an operator/staging task that requires real SMTP credentials and a dedicated test recipient.
