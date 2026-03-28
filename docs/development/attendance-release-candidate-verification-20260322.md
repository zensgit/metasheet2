# Attendance Release Candidate Verification

Date: 2026-03-22
Branch: `codex/attendance-run20-followup-20260320`
PR: `#536`
Merged main commit: `796be28e7de27bd07efed118e79e1fe25e09953e`
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

GitHub checks are green on the current PR head `8af3a4e72a99b7ec9ecca898d10a374e5ce413e3` as of 2026-03-22.

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

## Merge And Publication Outcome

Observed final release path on 2026-03-22:

- `PR #536` merged into `main` at `2026-03-22T10:51:09Z`
- merge commit: `796be28e7de27bd07efed118e79e1fe25e09953e`
- auto-deploy workflow:
  - `Build and Push Docker Images`
  - run: `#23401465080`
  - result: `success`
  - build job completed at `2026-03-22T10:53:23Z`
  - deploy job completed at `2026-03-22T10:54:34Z`
- non-publishing workflow result on the same push:
  - `Deploy to Production`
  - run: `#23401465079`
  - result: `success`
  - `build-and-push` and `deploy` jobs were skipped on push-to-main, so this was not the publishing path

Interpretation:

1. The attendance RC is no longer only a release candidate; it has been merged and published through the repo's main-branch auto-deploy path.
2. The effective publishing workflow for this release was `.github/workflows/docker-build.yml`, not `.github/workflows/deploy.yml`.
3. No new semver tag was cut during this publication; root package version remains `2.5.0`.

## Working Tree Status

At the time this verification note was refreshed:

- current branch is `codex/attendance-run20-followup-20260320`
- `origin/main` includes merge commit `796be28e7de27bd07efed118e79e1fe25e09953e`
- working tree is clean except untracked `node_modules` paths

## Verification Conclusion

This attendance line has cleared release-candidate validation and has now been published from `main`.

Publication confidence is supported by:

- targeted frontend test coverage for the new rule and batch console behaviors
- successful type-check and production build
- successful backend type-check and focused regression tests
- green GitHub checks on the verified PR head
- successful merge into `main`
- successful `Build and Push Docker Images` deploy run on the merged main commit

No further release gate remains for this change set. The only remaining follow-up would be optional version/tag housekeeping if the team wants a named release artifact beyond the existing `main` deployment.
