# DingTalk P4 Final Input Blocked Count Design

- Date: 2026-04-29
- Branch: `codex/dingtalk-final-input-blocked-count-20260429`
- Base: `origin/main` at `9b49c5333`
- Scope: make the P4 final-input offline status report expose an explicit blocked-input count

## Goal

The existing final-input checker already reports `overallStatus` and `missingInputs[]`, but operators and downstream handoff docs have to infer the blocker count from array length. This slice adds a direct count so the current blocker volume can be copied into status updates without changing existing parsing contracts.

## Design

- Add top-level `blockedInputCount` to `scripts/ops/dingtalk-p4-final-input-status.mjs`.
- Set `blockedInputCount` from `missingInputs.length` after all checks are evaluated.
- Keep `schemaVersion: 1` because this is a backward-compatible additive field.
- Keep `overallStatus`, `checks[]`, `missingInputs[]`, and `nextCommands[]` unchanged.
- Render `Blocked Input Count` near `Overall Status` in the generated Markdown summary.
- Keep all redaction behavior unchanged; the count does not expose token, webhook, robot secret, or private target values.

## Compatibility

- Existing consumers that read `missingInputs[]` continue to work.
- New consumers can read `blockedInputCount` directly.
- No network, 142 server, DingTalk, or database call is added.

## Test Coverage

- Blocked fixture asserts `blockedInputCount === missingInputs.length`.
- Ready fixture asserts `blockedInputCount === 0`.
- Markdown fixture asserts the rendered count is present.
- Existing redaction and non-zero blocked exit behavior remains covered.
