# DingTalk P4 Smoke Preflight Totals Design

Date: 2026-04-29

## Goal

Make the DingTalk P4 smoke preflight output easier to triage by exposing a direct check-count summary before operators run the remote smoke and manual evidence steps.

## Change

- Add a `totals` object to `preflight-summary.json` with `total`, `passed`, `failed`, and `skipped` counts.
- Render the same counts in `preflight-summary.md` immediately under `Overall status`.
- Keep the overall pass/fail semantics unchanged: only `fail` checks fail the preflight; `skipped` checks remain visible follow-up work.
- Preserve existing redaction behavior for bearer tokens, robot webhooks, SEC secrets, JWTs, public tokens, timestamps, signatures, and passwords.

## Operator Impact

The preflight report now answers "how much is left" without requiring manual row counting. A report such as `7/11 passed, 1 failed, 3 skipped` means the blocking item must be fixed before remote smoke, while skipped items are still explicit release follow-up evidence.
