# DingTalk P4 Gate Secret Assignment Redaction Design

## Goal

Make the DingTalk P4 gate/status layer redact copied secret assignments consistently when operators paste values with spaces around `=`.

## Scope

- `scripts/ops/dingtalk-p4-smoke-status.mjs`
- `scripts/ops/dingtalk-p4-release-readiness.mjs`
- `scripts/ops/dingtalk-p4-regression-gate.mjs`

## Change Summary

The gate/status redactor now handles these forms:

- `client_secret = <redacted>`
- `DINGTALK_CLIENT_SECRET = <redacted>`
- `DINGTALK_STATE_SECRET = <redacted>`

The replacement preserves the assignment key and surrounding spacing, then replaces only the sensitive value. This keeps generated reports actionable while protecting copied env snippets in JSON, Markdown, logs, and CLI errors.

## Additional Hardening

`dingtalk-p4-regression-gate.mjs` now redacts top-level error messages before printing them to stderr. This matches the safer behavior already used by other DingTalk P4 operator tools.

## Regression Coverage

- Smoke status redacts spaced secret assignments inside manual evidence issue messages.
- Release readiness redacts spaced secret assignments in top-level argument errors.
- Regression gate redacts spaced secret assignments in captured logs, summaries, and top-level argument errors.
