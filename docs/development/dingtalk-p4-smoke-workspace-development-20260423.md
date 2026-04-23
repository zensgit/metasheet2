# DingTalk P4 Smoke Workspace Development

- Date: 2026-04-23
- Scope: P4 API-only remote smoke workspace output
- Branch: `codex/dingtalk-p4-smoke-workspace-20260423`

## What Changed

- Updated `scripts/ops/dingtalk-p4-remote-smoke.mjs` so every run writes a complete evidence workspace:
  - `evidence.json`
  - `manual-evidence-checklist.md`
  - `artifacts/send-group-message-form-link/`
  - `artifacts/authorized-user-submit/`
  - `artifacts/unauthorized-user-denied/`
  - `artifacts/no-email-user-create-bind/`
- Manual checks now start with strict-mode skeleton fields:
  - `source`
  - `operator`
  - `performedAt`
  - `summary`
  - `artifacts`
- The group-message check preserves API bootstrap details under `evidence.apiBootstrap` while still requiring `manual-client` evidence before strict pass.
- Updated tests to assert the generated workspace, manual checklist, and source skeletons.
- Updated the remote smoke checklist and P4 TODO to describe the unified workspace flow.

## Why

Operators previously had two separate paths: run the API-only smoke and separately initialize a manual evidence kit. That could create two different `evidence.json` files for one smoke run. The runner now creates the manual evidence workspace directly, so API bootstrap data and manual proof live in one bundle.

## Files

- `scripts/ops/dingtalk-p4-remote-smoke.mjs`
- `scripts/ops/dingtalk-p4-remote-smoke.test.mjs`
- `docs/dingtalk-remote-smoke-checklist-20260422.md`
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md`

## Operator Flow

1. Run `scripts/ops/dingtalk-p4-remote-smoke.mjs` with the staging API, web base, admin token, DingTalk group robots, and allowlist inputs.
2. Use the generated `manual-evidence-checklist.md` to finish real DingTalk-client/admin checks.
3. Put proof files under the generated `artifacts/<check-id>/` folders.
4. Fill `evidence.json` and compile with `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs --strict`.
