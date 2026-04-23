# DingTalk P4 Smoke Status And Offline Handoff Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-smoke-status-report-20260423`
- Scope: local P4 remote-smoke tooling only; no DingTalk or staging calls are added by the status reporter.

## Changes

- Added `scripts/ops/dingtalk-p4-smoke-status.mjs`.
- The status reporter reads `session-summary.json`, `workspace/evidence.json`, `compiled/summary.json`, optional `handoff-summary.json`, and optional `publish-check.json`.
- It writes `smoke-status.json` / `smoke-status.md` with `manual_pending`, `finalize_pending`, `handoff_pending`, `release_ready`, or `fail`.
- It reports required check gaps, manual evidence issues, finalization state, handoff publish status, and next commands without copying raw evidence payloads.
- Added `--require-release-ready` for CI/operator gates that should fail unless the finalized session and handoff packet are ready.
- Added the status command to `dingtalk-p4-smoke-session.mjs` next commands and to the exported DingTalk staging evidence packet.
- Added `scripts/ops/dingtalk-p4-offline-handoff.test.mjs` to exercise session bootstrap, manual evidence completion, strict finalize, final handoff, and final status in one offline chain.

## Guardrails

- The status reporter does not call DingTalk, staging, Docker, or GitHub.
- It does not create or infer admin tokens.
- It redacts DingTalk robot access tokens, `SEC...` secrets, bearer tokens, JWTs, client secrets, public form tokens, and timestamp/sign query values from output strings.
- Strict compile failures caused by missing manual evidence are surfaced as `manual_pending`, not as fake release readiness.
