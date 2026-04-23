# DingTalk P4 Manual Evidence Kit Development

- Date: 2026-04-23
- Scope: P4 remote-smoke manual evidence capture
- Branch: `codex/dingtalk-p4-manual-evidence-kit-20260423`

## What Changed

- Extended `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs` with `--init-kit <dir>`.
- The kit writes `evidence.json`, `manual-evidence-checklist.md`, and artifact folders for the checks that require real DingTalk-client or admin proof.
- The standard `--init-template` JSON now includes the strict-mode manual evidence skeleton:
  - `source: "manual-client"` for group-message visibility, authorized submit, and unauthorized denial.
  - `source: "manual-admin"` for no-email local user creation and binding.
  - empty `operator`, `performedAt`, `summary`, and `artifacts` fields that must be filled before strict pass.
- API-bootstrap checks still default to `source: "api-bootstrap"`.
- Updated the remote smoke checklist and P4 TODO with the new kit flow.

## Why

The previous strict-mode gate prevented incomplete manual evidence from passing, but the initialization path still produced a generic template. This change makes the required evidence shape explicit before the operator starts the real DingTalk smoke run.

## Files

- `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`
- `scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs`
- `docs/dingtalk-remote-smoke-checklist-20260422.md`
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md`

## Operator Flow

1. Run `node scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs --init-kit output/dingtalk-p4-remote-smoke/<run>`.
2. Place real screenshots/log excerpts in the generated `artifacts/<check-id>/` folders.
3. Fill the matching per-check `evidence.operator`, `evidence.performedAt`, `evidence.summary`, and `evidence.artifacts`.
4. Compile with `--strict` only after the manual DingTalk-client/admin checks have real evidence.
