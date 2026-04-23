# DingTalk P4 Packet Publish Validator Development

- Date: 2026-04-23
- Scope: final DingTalk staging evidence packet publish check
- Branch: `codex/dingtalk-p4-packet-publish-check-20260423`

## What Changed

- Added `scripts/ops/validate-dingtalk-staging-evidence-packet.mjs`.
- The validator checks a packet directory before release handoff:
  - `manifest.json` exists and identifies `dingtalk-staging-evidence-packet`.
  - `README.md` exists.
  - `manifest.requireDingTalkP4Pass` is `true`.
  - At least one `includedEvidence` entry exists.
  - Each included evidence destination stays inside the packet directory.
  - Each included evidence entry has `dingtalkP4FinalStatus` pass metadata.
  - Each copied `session-summary.json` is finalized and has a passing `strict-compile` step.
  - Each copied `compiled/summary.json` has all eight required checks as `pass` and empty failure/manual issue arrays.
- The validator scans copied packet files for common raw secret shapes:
  - DingTalk robot webhook URLs and `access_token` parameters.
  - `SEC...` robot signing secrets.
  - Bearer tokens and JWTs.
  - DingTalk client/state secret assignments.
  - Public form token query parameters.
- Added optional `--output-json <file>` report output for release evidence.
- Added the validator to the staging evidence packet exporter so the script is included in handoff bundles.
- Updated the P4 remote smoke checklist and TODO.

## Why

The packet exporter and final-pass gate prove the run status, but release handoff still needs a single fail-closed command that checks the copied packet shape and catches obvious raw secret leaks before sharing the bundle.

## Files

- `scripts/ops/validate-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/validate-dingtalk-staging-evidence-packet.test.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.mjs`
- `scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`
- `docs/dingtalk-remote-smoke-checklist-20260422.md`
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md`

## Operator Flow

```bash
node scripts/ops/export-dingtalk-staging-evidence-packet.mjs \
  --include-output output/dingtalk-p4-remote-smoke-session/142-session \
  --require-dingtalk-p4-pass \
  --output-dir artifacts/dingtalk-staging-evidence-packet/142-final

node scripts/ops/validate-dingtalk-staging-evidence-packet.mjs \
  --packet-dir artifacts/dingtalk-staging-evidence-packet/142-final \
  --output-json artifacts/dingtalk-staging-evidence-packet/142-final-publish-check.json
```

Only publish the packet when the validator exits with status `0`.
