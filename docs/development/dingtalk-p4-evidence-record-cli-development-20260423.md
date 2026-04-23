# DingTalk P4 Evidence Record CLI Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-evidence-record-cli-20260423`
- Scope: local P4 remote-smoke evidence tooling only.

## Changes

- Added `scripts/ops/dingtalk-p4-evidence-record.mjs`.
- The CLI updates one check inside `workspace/evidence.json` by `--session-dir` or direct `--evidence` path.
- It supports `pass`, `fail`, `skipped`, and `pending` statuses.
- For manual pass checks, it enforces the expected source:
  - `send-group-message-form-link`: `manual-client`
  - `authorized-user-submit`: `manual-client`
  - `unauthorized-user-denied`: `manual-client`
  - `no-email-user-create-bind`: `manual-admin`
- It validates operator, summary or notes, timestamp, artifact refs, relative artifact folder, file existence, and non-empty artifact files.
- It scans summary, notes, artifact refs, and small text artifacts for common raw secret shapes before writing.
- Added the recorder command to smoke-session next commands, remote smoke checklist, TODO, and exported staging evidence packet.

## Non-Goals

- Does not call DingTalk, staging, Docker, or GitHub.
- Does not generate or expose admin tokens.
- Does not replace final strict compile, status reporting, final handoff, or packet publish validation.
