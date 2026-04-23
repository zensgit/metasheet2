# DingTalk P4 Smoke Evidence Runner Development - 2026-04-22

## Goal

Continue the DingTalk plan after the P4 documentation/runbook slice by making remote smoke results machine-checkable without pretending that remote execution has already happened.

## Changes

- Added `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`.
  - Writes an editable evidence template with all required P4 checks.
  - Compiles operator-filled evidence into `summary.json`, `summary.md`, and `evidence.redacted.json`.
  - Supports `--strict` so missing, pending, skipped, or failed required checks return non-zero.
  - Redacts DingTalk robot `access_token`, `SEC...` secrets, bearer/JWT tokens, passwords, and public form tokens.
- Added `scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs`.
- Updated `docs/dingtalk-remote-smoke-checklist-20260422.md` with the evidence compiler workflow.
- Updated `scripts/ops/export-dingtalk-staging-evidence-packet.mjs` so the staging handoff packet includes the evidence compiler.
- Added an explicit backend integration test proving form-share save rejects unknown allowed member groups.
- Updated `docs/development/dingtalk-feature-plan-and-todo-20260422.md` to reflect completed P1/P2 implementation coverage and the new P4 evidence compiler, while keeping actual remote smoke execution unchecked.

## Non-Goals

- No real DingTalk webhook or work-notification call was executed in this slice.
- No remote authorized/unauthorized user session was simulated.
- No admin token or DingTalk secret was generated or recorded.

## Expected Effect

When the remote smoke is executed, operators can now produce a standardized, redacted evidence directory and use `--strict` to fail the run unless every required P4 check is marked `pass`.
