# Attendance Leave Approval Builder Verification

Date: 2026-03-22
Branch: `codex/attendance-postrelease-next-20260322`
Published baseline main commit: `f81254d8cb3e88fd1fdfb5118287df044926dacd`
Published runtime release commit: `796be28e7de27bd07efed118e79e1fe25e09953e`

## Release Verification

`run21` has been published to GitHub Releases.

- workflow: `attendance-onprem-package-build.yml`
- trigger ref: `main`
- workflow run: `23402201542`
- result: `success`
- published release tag: `attendance-onprem-run21-20260322`
- release name: `Attendance On-Prem Run21 2026-03-22`
- published at: `2026-03-22T11:37:03Z`
- release URL: `https://github.com/zensgit/metasheet2/releases/tag/attendance-onprem-run21-20260322`

Verified assets:

- `metasheet-attendance-onprem-v2.5.0-run21.tgz`
- `metasheet-attendance-onprem-v2.5.0-run21.tgz.sha256`
- `metasheet-attendance-onprem-v2.5.0-run21.zip`
- `metasheet-attendance-onprem-v2.5.0-run21.zip.sha256`
- `metasheet-attendance-onprem-v2.5.0-run21.json`
- `SHA256SUMS`

## Code Verification

### Targeted Leave Approval Builder Checks

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminLeavePolicies.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts --watch=false
```

Result:

- `2 files`
- `11 tests passed`

Covered behaviors:

- builder <-> JSON synchronization
- request-type template application
- deprecated snake_case approval fields normalizing into the builder
- invalid JSON surfacing a builder sync error
- component-level template/add/remove delegation
- advanced JSON fallback messaging

### Wider Attendance Admin Regression

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminLeavePolicies.spec.ts tests/AttendanceLeavePoliciesSection.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/AttendanceImportBatchesSection.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/AttendanceRulesAndGroupsSection.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/AttendanceImportWorkflowSection.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/AttendanceSchedulingAdminSection.spec.ts tests/AttendanceHolidayDataSection.spec.ts --watch=false
```

Result:

- `11 files`
- `81 tests passed`

This confirms the new leave approval builder does not regress the previously delivered admin shells for:

- import workflow
- batch inbox and rollback guidance
- rules and groups
- scheduling admin
- holiday data

### Type And Build Gates

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- passed

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

- passed
- Vite emitted the existing large-chunk warning for the app bundle, but the build completed successfully

## Files Under Verification

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminLeavePolicies.ts`
- `apps/web/tests/AttendanceLeavePoliciesSection.spec.ts`
- `apps/web/tests/useAttendanceAdminLeavePolicies.spec.ts`

## Residual Risks

The following are still open and intentionally out of scope for this slice:

- no drag-and-drop or ordered-step reindex verification yet
- no end-to-end browser save/edit flow against a live backend in this slice
- no workflow-designer handoff verification yet
- no payroll-builder verification yet

## Conclusion

As of 2026-03-22:

1. `run21` is published on GitHub Releases.
2. Leave approval is no longer JSON-only in the admin UI.
3. The builder stays compatible with the current attendance approval-flow payload.
4. Targeted tests, wider regressions, type-checking, and the web production build all pass.
