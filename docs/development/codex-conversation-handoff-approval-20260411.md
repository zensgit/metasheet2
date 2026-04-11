# Codex Conversation Handoff: Approval MVP Wave 1

Date: 2026-04-11

## Current Status

Approval MVP Wave 1 is in `main`.

This includes:

- contract freeze
- migrations and db types
- runtime executor
- template CRUD
- frontend shell
- hardening fixes
- UI polish
- E2E acceptance coverage
- wave 1 execution docs

The latest approval docs alignment is also merged:

- PR `#828`
- merge commit `063d1543b248f3dabfb010a4c39d88a3b9a07005`

## What Is Already Done

Wave 1 product scope is implemented and merged:

- platform-native approval templates
- approval center
- create approval from template
- approval detail
- unified actions and history

Support lines already merged:

- approval docs and API guide
- acceptance checklist
- Feishu gap matrix
- verification report
- wave 2 scope breakdown

Key reference docs:

- [approval-mvp-wave1-execution-runbook-20260411.md](./approval-mvp-wave1-execution-runbook-20260411.md)
- [approval-mvp-wave1-acceptance-checklist-20260411.md](./approval-mvp-wave1-acceptance-checklist-20260411.md)
- [approval-mvp-wave1-verification-report-20260411.md](./approval-mvp-wave1-verification-report-20260411.md)
- [approval-api-usage-guide-20260411.md](./approval-api-usage-guide-20260411.md)
- [approval-mvp-feishu-gap-matrix-20260411.md](./approval-mvp-feishu-gap-matrix-20260411.md)
- [approval-mvp-wave2-scope-breakdown-20260411.md](./approval-mvp-wave2-scope-breakdown-20260411.md)

## Current Technical Judgment

There are no remaining Wave 1 code blockers.

The last acceptance adjudication is:

- `B1` is handled as docs/contract alignment, not a runtime bug
  - current unified `POST /api/approvals/{id}/actions` uses DB row-lock serialization
  - it does not use client `version`
  - it does not promise `APPROVAL_VERSION_CONFLICT`
- `B2` is `PASS`
  - `cc` history is already written to `approval_records`
- `B3` is accepted for Wave 1
  - `formSnapshot` may keep `YYYY-MM-DD` for `date` fields
  - this is acceptable for current scope

## Remaining Blockers

Only the 6 environment validations remain blocked:

- `BL1` real user without `approval-templates:manage` returns `403`
- `BL2` real user without `approvals:write` returns `403`
- `BL3` real user without permission returns `403`
- `BL4` real read-only user can view but cannot act
- `BL5` PLM compatibility in a real environment
- `BL6` attendance compatibility in a real environment

These are not code tasks. They require real deployment URLs and real accounts or JWTs.

## What Codex Should Do Next

Do not open new Wave 1 implementation work.

The next step is formal environment validation:

1. Run approval Wave 1 validation against real `WEB_BASE` and `API_BASE`
2. Validate the 4-role permission matrix with real accounts or JWTs
3. Validate PLM compatibility
4. Validate attendance compatibility
5. Only if a real blocker appears, open a small targeted fix
6. If environment validation passes, move to Wave 2 planning/execution

## Inputs Needed To Continue

To resume on another computer, the next operator needs:

- `WEB_BASE`
- `API_BASE`
- a user or JWT with `approval-templates:manage`
- a user or JWT with `approvals:write`
- a user or JWT with `approvals:act`
- a read-only or no-permission user/JWT
- PLM validation access
- attendance validation access

## Useful Existing Commands

Local automated baseline:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-graph-executor.test.ts \
  tests/unit/approval-product-service.test.ts \
  tests/unit/approval-template-routes.test.ts \
  tests/unit/approvals-routes.test.ts \
  tests/unit/approvals-bridge-routes.test.ts \
  --watch=false --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web exec vitest run \
  tests/approval-center.spec.ts \
  tests/approval-e2e-lifecycle.spec.ts \
  tests/approval-e2e-permissions.spec.ts \
  tests/approval-inbox-auth-guard.spec.ts \
  --watch=false --reporter=dot
```

Approval API examples:

- see [approval-api-usage-guide-20260411.md](./approval-api-usage-guide-20260411.md)

PLM compatibility entry:

```bash
pnpm verify:plm-ui-regression
```

Attendance compatibility entry:

```bash
pnpm verify:attendance-post-merge
```

Dev JWT helper:

```bash
npx tsx packages/core-backend/scripts/gen-dev-token.ts \
  --user dev-user \
  --roles admin \
  --perms approvals:read,approvals:write,approvals:act,approval-templates:manage \
  --expiresIn 1d
```

## Repo Working-State Warning

Do not trust the root worktree as a clean implementation base.

The root repo has unrelated local modifications and untracked files. For any new fix or validation slice, prefer a fresh worktree from current `origin/main`.

## How To Resume On Another Computer

Open this file and tell Codex:

> Continue from `docs/development/codex-conversation-handoff-approval-20260411.md`. Treat Approval MVP Wave 1 as merged in `main`. Do not add new Wave 1 features. Focus only on the 6 remaining environment validations from `approval-mvp-wave1-verification-report-20260411.md`.
