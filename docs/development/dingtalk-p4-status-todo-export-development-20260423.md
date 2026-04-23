# DingTalk P4 Status TODO Export Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-status-todo-export-20260423`
- Scope: local P4 remote-smoke operator tooling.

## Changes

- Extended `dingtalk-p4-smoke-status.mjs` to generate `smoke-todo.md` next to `smoke-status.json` and `smoke-status.md`.
- Added `--output-todo-md` for custom TODO output paths.
- Added `remoteSmokeTodos` to the status JSON with total, completed, remaining, and per-check item metadata.
- Added per-check manual evidence recorder command templates in the TODO report.
- Added unauthorized-user evidence recorder hints for `--submit-blocked`, `--record-insert-delta 0`, and `--blocked-reason`.
- Updated the remote smoke checklist and feature TODO.

## Rationale

The remaining DingTalk target work is mostly real remote smoke execution, not new product code. The status TODO export makes the remaining work concrete for each staging session and reduces operator mistakes while collecting manual DingTalk evidence.
