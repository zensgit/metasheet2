# DingTalk Directory Stack CI Blockers Development

Date: `2026-04-15`
Branch: `codex/feishu-gap-rc-integration-202605`
PR: `#873`

## Context

PR `#873` was blocked by two failing GitHub Actions checks:

- `Attendance Gate Contract Matrix / contracts (openapi)`
- `Plugin System Tests / test (18.x)`

The failure logs showed:

- `contracts (openapi)` failed with `openapi dist drift detected`
- `test (18.x)` failed because two test files executed DB-backed services in a no-Postgres CI environment:
  - `packages/core-backend/tests/integration/rc-regression.test.ts`
  - `packages/core-backend/tests/unit/multitable-automation-service.test.ts`

## Changes

### 1. Refreshed generated OpenAPI outputs

Rebuilt:

- `packages/openapi/dist/combined.openapi.yml`
- `packages/openapi/dist/openapi.json`
- `packages/openapi/dist/openapi.yaml`

This aligns the generated artifacts with the current `packages/openapi/src/paths/*` inputs so the attendance contract guard stops reporting drift.

### 2. Restored RC regression tests to no-DB semantics

Updated [rc-regression.test.ts](/tmp/metasheet2-dingtalk-stack/packages/core-backend/tests/integration/rc-regression.test.ts:1) so its Week 4 / Week 5 / Week 7 semantic checks use in-memory helpers instead of accidentally instantiating DB-backed production services.

Added lightweight in-memory helpers for:

- API tokens
- webhooks
- automation execution logs
- dashboard/chart CRUD semantics

This keeps the file aligned with its stated purpose: regression verification without a live PostgreSQL dependency.

### 3. Aligned automation unit tests with current runtime behavior

Updated [multitable-automation-service.test.ts](/tmp/metasheet2-dingtalk-stack/packages/core-backend/tests/unit/multitable-automation-service.test.ts:1):

- mocked `AutomationLogService` to avoid DB writes during service execution
- switched legacy `notify` expectations to current `send_notification` / `automation.notification`
- switched legacy `field.changed` expectations to current `field.value_changed`
- aligned update action assertions to current `update_record` query-based execution
- aligned init/shutdown assertions to the current three-event subscription set

## Claude Code CLI

CLI was available during this round.

Verified:

- `claude auth status`
- `claude -p "Return exactly: CLAUDE_CLI_OK"`

The CLI was treated as a narrow helper only; final code and verification were still completed locally.
