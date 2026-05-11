# Multitable Phase 2 Lane B2 Email SMTP Transport - Development

> Date: 2026-05-11
> Branch: `codex/multitable-phase2-email-smtp-transport-20260511`
> PR: #1462
> Baseline: `origin/main@a6835b1c2`
> Scope: SMTP provider runtime for `send_email` automation

## Context

PR #1461 landed Lane B1: a no-send readiness gate and fail-closed runtime guard for `MULTITABLE_EMAIL_TRANSPORT=smtp`.

This B2 slice adds the actual SMTP provider behind the B1 env contract. It keeps the default mock channel unchanged, so local dev, CI, and existing RC smoke behavior remain stable unless SMTP is explicitly enabled.

## What Changed

### Dependency

Added to `@metasheet/core-backend`:

- `nodemailer`
- `@types/nodemailer`

The dependency is scoped to the backend package and recorded in `pnpm-lock.yaml`.

### SMTP Config

Extended `packages/core-backend/src/services/email-transport-readiness.ts` with SMTP transport resolution:

Required env:

- `MULTITABLE_EMAIL_TRANSPORT=smtp`
- `MULTITABLE_EMAIL_SMTP_HOST`
- `MULTITABLE_EMAIL_SMTP_PORT`
- `MULTITABLE_EMAIL_SMTP_USER`
- `MULTITABLE_EMAIL_SMTP_PASSWORD`
- `MULTITABLE_EMAIL_SMTP_FROM`

Optional env:

- `MULTITABLE_EMAIL_SMTP_SECURE`
  - If absent, defaults to `true` only for port `465`.
- `MULTITABLE_EMAIL_SMTP_CONNECTION_TIMEOUT_MS`
  - Default: `10000`.
  - Allowed range: `1000..60000`.
- `MULTITABLE_EMAIL_SMTP_GREETING_TIMEOUT_MS`
  - Default: `10000`.
  - Allowed range: `1000..60000`.

Readiness now also blocks invalid ports and invalid timeout/boolean values before runtime send.

### Runtime Send

Updated `EmailNotificationChannel`:

- mock mode still accepts notifications without a real SMTP send;
- SMTP mode now builds a `nodemailer` transport and calls `sendMail()`;
- the transport is cached per channel instance;
- tests can inject a `smtpTransportFactory` via channel config, so no unit test touches a real SMTP server;
- SMTP failures return a controlled `NotificationResult.status === "failed"` and flow into the existing automation failed-step path.

SMTP sends include:

- `from`: `MULTITABLE_EMAIL_SMTP_FROM`
- `to`: automation recipient
- `subject`: rendered automation subject
- `text`: rendered automation body
- headers:
  - `X-MetaSheet-Notification-Channel: email`
  - `X-MetaSheet-Notification-Source: automation`

### Runtime Redaction

Added `redactEmailTransportText()` and applied it to `EmailNotificationChannel` failure handling.

It strips configured SMTP host/user/password/from values, bearer tokens, JWT-like values, and common URL token parameters from failure messages before they are logged or returned as `failedReason`.

## Design Decisions

### Decision 1 - Environment opt-in only

SMTP is not activated by installing the dependency. Runtime stays mock unless `MULTITABLE_EMAIL_TRANSPORT=smtp` is set.

### Decision 2 - No real-send script in CI

This PR does not add a CI job or default script that sends real email. Real-send verification must be done manually or by deployment automation with explicit credentials and `CONFIRM_SEND_EMAIL=1` policy.

### Decision 3 - Plain text first

The provider sends `text` content only. HTML templating and attachments are intentionally deferred to avoid widening the security and rendering surface.

### Decision 4 - One message per recipient

The existing channel iterates recipients one-by-one. B2 preserves that behavior rather than introducing shared `to` lists or BCC semantics.

## Non-Goals

- No HTML email rendering.
- No attachments.
- No bounce handling.
- No SendGrid/SES/Mailgun provider abstraction.
- No frontend editor changes.
- No DingTalk behavior changes.

## Operational Usage

Readiness:

```bash
MULTITABLE_EMAIL_TRANSPORT=smtp \
MULTITABLE_EMAIL_SMTP_HOST=smtp.example.com \
MULTITABLE_EMAIL_SMTP_PORT=587 \
MULTITABLE_EMAIL_SMTP_USER=<smtp-user> \
MULTITABLE_EMAIL_SMTP_PASSWORD=<smtp-password> \
MULTITABLE_EMAIL_SMTP_FROM=metasheet@example.com \
pnpm verify:multitable-email:readiness
```

Runtime:

```bash
MULTITABLE_EMAIL_TRANSPORT=smtp
MULTITABLE_EMAIL_SMTP_HOST=smtp.example.com
MULTITABLE_EMAIL_SMTP_PORT=587
MULTITABLE_EMAIL_SMTP_USER=<smtp-user>
MULTITABLE_EMAIL_SMTP_PASSWORD=<smtp-password>
MULTITABLE_EMAIL_SMTP_FROM=metasheet@example.com
```

Optional:

```bash
MULTITABLE_EMAIL_SMTP_SECURE=false
MULTITABLE_EMAIL_SMTP_CONNECTION_TIMEOUT_MS=10000
MULTITABLE_EMAIL_SMTP_GREETING_TIMEOUT_MS=10000
```

Do not write real SMTP credentials into docs, PR comments, or tracked artifacts.

## Follow-Up

- Add an explicit operator-run real-send smoke script if staging needs a repeatable mailbox receipt artifact.
- Consider HTML template rendering after text delivery has production signal.
- Consider reusing the same SMTP channel for approval breach email once policy is confirmed.
