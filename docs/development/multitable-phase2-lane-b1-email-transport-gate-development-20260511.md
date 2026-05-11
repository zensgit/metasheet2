# Multitable Phase 2 Lane B1 Email Transport Gate - Development

> Date: 2026-05-11
> Branch: `codex/multitable-phase2-email-transport-gate-20260511`
> PR: #1461
> Baseline: `origin/main@013797fc3`
> Scope: env-gated readiness for `send_email` automation transport

## Context

Phase 2 Lane B exists because the RC proved the `send_email` automation wire path through the default mock `EmailNotificationChannel`, not real SMTP/provider delivery.

Before coding this slice, Lane A was rechecked and found complete in main:

- PR #1449 merged audit-only `longText` coverage at `2082f169e`.
- `longText` exists in backend codecs, OpenAPI, frontend editors/renderers/forms/drawer, XLSX tests, and focused frontend tests.

So this branch pivots to Lane B1, the smallest security-sensitive prerequisite for future real email delivery.

## What Changed

### Readiness Resolver

Added `packages/core-backend/src/services/email-transport-readiness.ts`.

It resolves:

- `MULTITABLE_EMAIL_TRANSPORT`
  - unset / `mock` / `disabled` / `off` -> mock mode
  - `smtp` -> SMTP readiness mode
  - any other value -> blocked unsupported mode
- `MULTITABLE_EMAIL_REAL_SEND_SMOKE`
- `CONFIRM_SEND_EMAIL`
- required SMTP env when SMTP mode is enabled:
  - `MULTITABLE_EMAIL_SMTP_HOST`
  - `MULTITABLE_EMAIL_SMTP_PORT`
  - `MULTITABLE_EMAIL_SMTP_USER`
  - `MULTITABLE_EMAIL_SMTP_PASSWORD`
  - `MULTITABLE_EMAIL_SMTP_FROM`

The resolver returns `status: "pass" | "blocked"` and only redacted env values. It never sends email.

### Runtime Guard

Updated `EmailNotificationChannel` in `packages/core-backend/src/services/NotificationService.ts`.

Behavior:

- Default/mock mode remains the existing no-real-send behavior.
- Explicit SMTP mode with missing env returns a controlled failed notification result through the existing channel error path.
- Explicit SMTP mode with complete env still fails controlled with `SMTP email transport is configured but not implemented in this build`; B2 must add the actual provider implementation before real sends can succeed.
- Mock-mode logging no longer prints raw recipient or subject text.

This prevents a future deployment from setting `MULTITABLE_EMAIL_TRANSPORT=smtp` and silently receiving mock `sent` results.

### Ops Gate

Added:

- `scripts/ops/multitable-email-transport-readiness.ts`
- `scripts/ops/multitable-email-transport-readiness.test.mjs`
- root script `pnpm verify:multitable-email:readiness`

Default outputs:

```text
output/multitable-email-transport-readiness/report.json
output/multitable-email-transport-readiness/report.md
```

Exit codes:

- `0` - readiness passes.
- `2` - readiness is blocked by configuration.
- `1` - script/runtime error.

The gate is intentionally no-send. A real-send smoke path must be a later B2/B3 slice and must set `MULTITABLE_EMAIL_REAL_SEND_SMOKE=1` plus `CONFIRM_SEND_EMAIL=1`.

## Design Decisions

### Decision 1 - No SMTP dependency in B1

This branch does not add `nodemailer`, SendGrid, SES, Mailgun, or any provider dependency. B1 is the seam and release gate only.

Reason: the security risk is not the SMTP call itself; the immediate gap is that staging/release gates had no explicit way to distinguish "mock wire works" from "real transport is configured".

### Decision 2 - Explicit SMTP mode fails closed until B2

If SMTP mode is enabled before a provider is implemented, `EmailNotificationChannel` returns a failed result instead of mock success.

Reason: false `sent` is worse than a visible failed automation step.

### Decision 3 - Redacted artifacts by construction

The readiness report stores only `<set>`, `<unset>`, `true`, `false`, or simple non-secret values like the SMTP port. It does not render SMTP host URLs, usernames, passwords, bearer tokens, JWTs, or recipient lists.

### Decision 4 - Keep existing automation logs API unchanged

No route or schema changes were made. The existing flat automation logs API remains the contract used by RC smoke.

## Non-Goals

- No real SMTP/provider send.
- No dev-only email history endpoint.
- No recipient/body inspection endpoint.
- No DingTalk behavior changes.
- No frontend editor changes.

## Follow-Up

B2 can now add the actual SMTP/provider channel behind the same env names. Required follow-up checks:

- real provider dependency and deployment policy approved;
- explicit real-send smoke with `CONFIRM_SEND_EMAIL=1`;
- no raw recipient, subject/body, credential, bearer token, or JWT leakage in logs/artifacts;
- automation execution log persists failed transport steps.
