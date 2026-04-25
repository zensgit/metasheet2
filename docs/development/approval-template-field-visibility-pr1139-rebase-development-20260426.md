# Approval Template Field Visibility PR #1139 Rebase Development

Date: 2026-04-26

## Scope

PR #1139 (`codex/approval-wave2-wp4-field-visibility-20260424`) was behind `origin/main` and had conflicts after the approval SLA, metrics, DingTalk closeout, integration, and runtime-security work landed on main.

This rebase/sync was done in an isolated detached worktree:

`/Users/chouhua/Downloads/Github/metasheet2/.worktrees/pr1139-clean-review-20260426`

The original checked-out PR worktree was not modified.

## Merge Strategy

The branch was synchronized by merging `origin/main` into the PR head, then resolving only the two conflicted files:

- `apps/web/src/views/approval/TemplateDetailView.vue`
- `packages/core-backend/tests/unit/approval-product-service.test.ts`

No product behavior was intentionally redesigned in this sync. The goal was behavior parity with both sides:

- keep PR #1139 field visibility UI and helper rendering;
- keep mainline template SLA UI/API integration;
- keep PR #1139 field visibility backend validation tests;
- keep mainline auto-approved approval terminal metrics coverage.

## Conflict Resolution Details

### Template Detail View

`TemplateDetailView.vue` had overlapping imports and adjacent template detail metadata changes.

Resolution:

- preserved the field visibility import:
  - `describeFieldVisibilityRule`
- preserved the mainline approval API imports:
  - `updateTemplateCategory`
  - `updateTemplateSlaHours`
  - `updateTemplateVisibilityScope`
- retained the SLA editor block from mainline;
- retained the visibility rule rendering/editing behavior from PR #1139.

### Approval Product Service Tests

`approval-product-service.test.ts` conflicted because PR #1139 added visibility rule persistence/validation coverage while main added SLA-aware metrics coverage.

Resolution:

- kept `persists visibility rules when creating a template`;
- kept `rejects invalid visibility rules before hitting the database`;
- kept `records terminal metrics for approvals auto-approved at creation`;
- added `sla_hours: null` to visibility test row fixtures so they match the current template row shape.

## Generated File Hygiene

The detached worktree initially lacked dependencies, so `pnpm install --ignore-scripts --prefer-offline` was run before targeted Vitest commands.

That install touched generated workspace dependency links and `pnpm-lock.yaml`; those generated changes were removed before commit. Only source/test/docs changes are intended to be pushed.

## Result

The PR branch now carries a clean main synchronization commit plus this documentation update. The effective PR diff remains focused on approval template field visibility once GitHub compares it against the updated base branch.
