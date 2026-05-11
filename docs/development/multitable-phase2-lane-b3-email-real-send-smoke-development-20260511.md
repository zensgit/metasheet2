# Multitable Phase 2 Lane B3 Email Real-Send Smoke - Development

> Date: 2026-05-11
> Branch: `codex/multitable-phase2-email-real-smoke-20260511`
> PR: #1465
> Baseline: `origin/main@ca70e340a`
> Scope: operator-run real SMTP mailbox smoke harness

## Context

Lane B1 added the no-send readiness gate. Lane B2 added SMTP runtime delivery through `nodemailer`.

The remaining gap is not source code delivery; it is an operator-controlled mailbox receipt proof. That proof needs real SMTP credentials and a real recipient, so it cannot be safely run by default in CI or source verification.

This B3 slice adds a guarded harness that operators can run on staging or another controlled runtime without exposing credentials in tracked artifacts.

## What Changed

### Real-Send Smoke Script

Added:

```bash
scripts/ops/multitable-email-real-send-smoke.ts
```

Package script:

```bash
pnpm verify:multitable-email:real-send
```

The script sends one real email only when all required guards are present:

```bash
MULTITABLE_EMAIL_TRANSPORT=smtp
MULTITABLE_EMAIL_SMTP_HOST=...
MULTITABLE_EMAIL_SMTP_PORT=587
MULTITABLE_EMAIL_SMTP_USER=...
MULTITABLE_EMAIL_SMTP_PASSWORD=...
MULTITABLE_EMAIL_SMTP_FROM=...
MULTITABLE_EMAIL_REAL_SEND_SMOKE=1
CONFIRM_SEND_EMAIL=1
MULTITABLE_EMAIL_SMOKE_TO=recipient@example.com
```

Optional:

```bash
MULTITABLE_EMAIL_SMOKE_SUBJECT="MetaSheet staging SMTP smoke"
EMAIL_REAL_SEND_JSON=output/multitable-email-real-send-smoke/report.json
EMAIL_REAL_SEND_MD=output/multitable-email-real-send-smoke/report.md
```

### Exit Codes

| Code | Meaning |
| --- | --- |
| 0 | Real-send smoke returned a sent notification result. |
| 1 | Runtime send failed after guards passed. |
| 2 | Configuration or safety guard blocked the send before any real email attempt. |

### Reports

The harness writes:

- `output/multitable-email-real-send-smoke/report.json`
- `output/multitable-email-real-send-smoke/report.md`

Reports include:

- pass / blocked / failed status;
- readiness result;
- whether a recipient was configured;
- notification status and id when available;
- redacted failure reason when available.

Reports intentionally do not include raw SMTP credentials or recipient addresses.

## Design Decisions

### Decision 1 - Fail closed by default

Running `pnpm verify:multitable-email:real-send` with no env exits `2` and sends nothing.

### Decision 2 - Reuse production channel path

The script uses `EmailNotificationChannel` rather than calling `nodemailer` directly. That keeps the smoke aligned with the actual automation email transport path.

### Decision 3 - Keep mailbox receipt manual

The script can prove that MetaSheet returned a sent result. The operator still needs to confirm the configured mailbox received the message and archive that external evidence separately.

### Decision 4 - No tracked secrets

All artifact text passes through the same email transport redaction helper, plus recipient-address redaction.

## Non-Goals

- No SMTP credentials committed to repo files.
- No default CI real-send job.
- No mailbox polling or IMAP integration.
- No HTML email rendering.
- No changes to DingTalk or webhook notification channels.

## Operator Command

Use a shell environment, secret manager, or CI masked variables. Do not paste credentials into docs or PR comments.

```bash
MULTITABLE_EMAIL_TRANSPORT=smtp \
MULTITABLE_EMAIL_SMTP_HOST="$SMTP_HOST" \
MULTITABLE_EMAIL_SMTP_PORT="$SMTP_PORT" \
MULTITABLE_EMAIL_SMTP_USER="$SMTP_USER" \
MULTITABLE_EMAIL_SMTP_PASSWORD="$SMTP_PASSWORD" \
MULTITABLE_EMAIL_SMTP_FROM="$SMTP_FROM" \
MULTITABLE_EMAIL_REAL_SEND_SMOKE=1 \
CONFIRM_SEND_EMAIL=1 \
MULTITABLE_EMAIL_SMOKE_TO="$SMTP_TEST_RECIPIENT" \
pnpm verify:multitable-email:real-send
```

Acceptance for staging:

1. Script exits `0`.
2. `report.md` contains `Status: pass`.
3. The test recipient mailbox receives the smoke email.
4. The archived evidence contains no SMTP credential or recipient address unless stored in a private operator vault.
