# Attendance Release Candidate Verification

Date: 2026-03-22
Branch: `codex/attendance-run20-followup-20260320`
PR: `#536`
Current PR head: `19157f1d1d317fb69acd9c08a4bc5322ed1137e6`
Runtime verification baseline head: `2edb62ab42f994f51b979caa8bacbd1ed2ea9d8e`

## Scope

This verification record covers the attendance release-candidate line that includes:

- rule preview builder and explainable diagnostics
- import workflow lane hints and plan summary
- batch inbox triage, saved inbox views, rollback impact analysis, and rollback confirmation
- scheduling and holiday admin hardening
- admin RBAC and batch-route reliability fixes

## Local Verification

### Frontend

Verified on the RC runtime baseline:

- `pnpm --filter @metasheet/web exec vitest run tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminImportBatches.spec.ts --watch=false`
  - result: `18 passed`
- `pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false`
  - result: `70 passed`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - result: passed
- `pnpm --filter @metasheet/web build`
  - result: passed

### Backend

Verified earlier on the same RC code line:

- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`
  - result: passed
- `pnpm --filter @metasheet/core-backend exec vitest run src/rbac/__tests__/rbac.test.ts`
  - result: passed
- `pnpm exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts`
  - result: passed

## GitHub Checks

GitHub checks are green on the current PR head `19157f1d1d317fb69acd9c08a4bc5322ed1137e6` as of 2026-03-22.

Successful checks:

- `coverage`
- `contracts (dashboard)`
- `contracts (openapi)`
- `contracts (strict)`
- `core-backend-cache`
- `e2e`
- `migration-replay`
- `pr-validate`
- `telemetry-plugin`
- `test (18.x)`
- `test (20.x)`

Non-failing skipped check:

- `Strict E2E with Enhanced Gates`

## PR Gate Status

Observed PR status on 2026-03-22:

- `state = open`
- `mergeable = true`
- `mergeStateStatus = BLOCKED`
- `reviewDecision = REVIEW_REQUIRED`

Interpretation:

1. Code and CI are no longer the release blocker.
2. The remaining blocker is review approval and merge.
3. After approval and merge into `main`, version update and publication can proceed immediately.

## Working Tree Status

At the time this verification note was recorded:

- current branch is `codex/attendance-run20-followup-20260320`
- PR head is `ahead 20` relative to `origin/main`
- working tree is clean except untracked `node_modules` paths

## Verification Conclusion

This attendance branch qualifies as a release candidate.

Release readiness is supported by:

- targeted frontend test coverage for the new rule and batch console behaviors
- successful type-check and production build
- successful backend type-check and focused regression tests
- green GitHub checks on the current PR head

The remaining action before version update and publication is review approval and merge of `#536`.
