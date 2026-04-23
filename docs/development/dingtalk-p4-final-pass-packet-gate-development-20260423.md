# DingTalk P4 Final-Pass Packet Gate Development

- Date: 2026-04-23
- Scope: staging evidence packet final-pass gating
- Branch: `codex/dingtalk-p4-evidence-packet-final-gate-20260423`

## What Changed

- Added `--require-dingtalk-p4-pass` to `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`.
- When enabled, every `--include-output` directory must be a finalized passing DingTalk P4 smoke session; mixed legacy evidence directories are intentionally rejected under this flag.
- The gate checks:
  - `session-summary.json` exists and has `tool: "dingtalk-p4-smoke-session"`.
  - `session-summary.json` has `sessionPhase: "finalize"`.
  - `session-summary.json` has `overallStatus: "pass"`.
  - `session-summary.json` has `finalStrictStatus: "pass"`.
  - `session-summary.json` has no `pendingChecks`.
  - `session-summary.json` includes a passing `strict-compile` step.
  - `compiled/summary.json` exists and has `tool: "compile-dingtalk-p4-smoke-evidence"`.
  - `compiled/summary.json` has `overallStatus: "pass"`.
  - `compiled/summary.json` has `apiBootstrapStatus: "pass"`.
  - `compiled/summary.json` has `remoteClientStatus: "pass"`.
  - All eight required P4 checks exist and have `status: "pass"`.
  - `compiled/summary.json` has empty arrays for `requiredChecksNotPassed`, `manualEvidenceIssues`, `failedChecks`, and `missingRequiredChecks`.
  - `compiled/summary.json` totals show zero pending, failed, and missing checks.
- The exporter validates all included output directories before copying packet files or writing `manifest.json`, so a failed gate does not create a partial new packet.
- The manifest records `requireDingTalkP4Pass` and per-evidence `dingtalkP4FinalStatus`.
- The packet README states whether the final-pass gate was enabled.
- Finalized smoke sessions now recommend the packet export command with `--require-dingtalk-p4-pass`.
- Updated the P4 smoke checklist and TODO with the final export command.

## Why

The session finalizer can prove that P4 evidence is complete, but the packet exporter previously copied any runtime directory. This gate prevents a release handoff packet from accidentally containing `manual_pending` or strict-failed DingTalk evidence.

## Files

- `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`
- `scripts/ops/dingtalk-p4-smoke-session.mjs`
- `scripts/ops/dingtalk-p4-smoke-session.test.mjs`
- `docs/dingtalk-remote-smoke-checklist-20260422.md`
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md`

## Operator Flow

1. Run the P4 smoke session.
2. Fill real manual DingTalk-client/admin evidence.
3. Run `node scripts/ops/dingtalk-p4-smoke-session.mjs --finalize <session-dir>`.
4. Export the packet with `node scripts/ops/export-dingtalk-staging-evidence-packet.mjs --include-output <session-dir> --require-dingtalk-p4-pass`.
5. Review raw included workspace/artifact files for tokens, webhooks, screenshots, or private data before publishing the packet.
