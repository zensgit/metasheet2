# DingTalk P4 Manual Target Readiness Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-release-gate-20260423`
- Scope: local P4 smoke tooling only; no DingTalk or staging calls.

## Completed Work

- Added manual target inputs to the P4 preflight/session/remote-smoke tooling:
  - `DINGTALK_P4_AUTHORIZED_USER_ID`
  - `DINGTALK_P4_UNAUTHORIZED_USER_ID`
  - `DINGTALK_P4_NO_EMAIL_DINGTALK_EXTERNAL_ID`
- Added CLI flags:
  - `--authorized-user`
  - `--unauthorized-user`
  - `--no-email-dingtalk-external-id`
  - `--require-manual-targets` for preflight/session gating.
- Updated generated env templates so operators fill the three manual validation targets before final remote smoke.
- Wrote manual target context into `preflight-summary.json`, `session-summary.json`, `workspace/evidence.json`, and `manual-evidence-checklist.md`.
- Updated P4 plan/TODO docs so final remote smoke uses `--require-manual-targets`.

## Behavior

- If `--require-manual-targets` is set, preflight fails when the unauthorized target or no-email DingTalk external target is missing.
- If `DINGTALK_P4_AUTHORIZED_USER_ID` is blank, the first allowed user is used as the suggested authorized submit target.
- The new fields are IDs only; credentials, webhooks, bearer tokens, temporary passwords, and public form tokens remain excluded from tracked outputs.
