# Attendance Run11 Commit Inventory

## Include

- `apps/web/index.html`
- `apps/web/src/App.vue`
- `apps/web/src/stores/featureFlags.ts`
- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/AttendanceAuditLogsSection.vue`
- `apps/web/src/views/attendance/AttendanceHolidayRuleSection.vue`
- `apps/web/src/views/attendance/AttendanceHolidayDataSection.vue`
- `apps/web/src/views/attendance/AttendanceImportBatchesSection.vue`
- `apps/web/src/views/attendance/AttendanceImportWorkflowSection.vue`
- `apps/web/src/views/attendance/AttendanceLeavePoliciesSection.vue`
- `apps/web/src/views/attendance/AttendancePayrollAdminSection.vue`
- `apps/web/src/views/attendance/AttendanceProvisioningSection.vue`
- `apps/web/src/views/attendance/AttendanceRequestCenterSection.vue`
- `apps/web/src/views/attendance/AttendanceRulesAndGroupsSection.vue`
- `apps/web/src/views/attendance/AttendanceSchedulingAdminSection.vue`
- `apps/web/src/views/attendance/AttendanceSettingsSection.vue`
- `apps/web/src/views/attendance/useAttendanceAdminAuditLogs.ts`
- `apps/web/src/views/attendance/useAttendanceAdminConfig.ts`
- `apps/web/src/views/attendance/useAttendanceAdminImportBatches.ts`
- `apps/web/src/views/attendance/useAttendanceAdminImportWorkflow.ts`
- `apps/web/src/views/attendance/useAttendanceAdminLeavePolicies.ts`
- `apps/web/src/views/attendance/useAttendanceAdminPayroll.ts`
- `apps/web/src/views/attendance/useAttendanceAdminProvisioning.ts`
- `apps/web/src/views/attendance/useAttendanceAdminRulesAndGroups.ts`
- `apps/web/src/views/attendance/useAttendanceAdminScheduling.ts`
- `apps/web/tests/useAttendanceAdminAuditLogs.spec.ts`
- `apps/web/tests/useAttendanceAdminConfig.spec.ts`
- `apps/web/tests/useAttendanceAdminImportBatches.spec.ts`
- `apps/web/tests/useAttendanceAdminImportWorkflow.spec.ts`
- `apps/web/tests/useAttendanceAdminLeavePolicies.spec.ts`
- `apps/web/tests/useAttendanceAdminPayroll.spec.ts`
- `apps/web/tests/useAttendanceAdminProvisioning.spec.ts`
- `apps/web/tests/useAttendanceAdminRulesAndGroups.spec.ts`
- `apps/web/tests/useAttendanceAdminScheduling.spec.ts`
- `apps/web/tests/attendance-experience-mobile-zh.spec.ts`
- `apps/web/tests/featureFlags.spec.ts`
- `apps/web/tests/useAttendanceHolidayRuleSection.spec.ts`
- `docs/development/attendance-run11-commit-inventory-20260313.md`
- `docs/development/attendance-run11-release-checklist-20260313.md`
- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/db/migrations/zzzz20260313093000_add_paid_to_attendance_leave_types.ts`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/attendance.yml`
- `plugins/plugin-attendance/index.cjs`
- `plugins/plugin-attendance/package.json`
- `pnpm-lock.yaml`

## Conditional Include

Include these only if the final target branch still lacks them and the target database has already executed them. They are migration-history bridge files, not new attendance features.

- `packages/core-backend/src/db/migrations/zzzz20260309103000_create_workflow_designer_support_tables.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309113000_create_workflow_hub_team_views.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309123000_create_plm_filter_team_presets.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309133000_add_default_to_plm_filter_team_presets.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309143000_create_plm_workbench_team_views.ts`
- `packages/core-backend/src/db/migrations/zzzz20260309150000_create_plm_workbench_team_views.ts`
- `packages/core-backend/src/db/migrations/zzzz20260310170000_add_archived_to_plm_workbench_team_views.ts`
- `packages/core-backend/src/db/migrations/zzzz20260310183000_add_archived_to_plm_filter_team_presets.ts`
- `packages/core-backend/src/db/migrations/zzzz20260312170000_create_user_session_revocations.ts`
- `packages/core-backend/src/db/migrations/zzzz20260313103000_create_user_invites.ts`
- `packages/core-backend/src/db/migrations/zzzz20260313183000_create_user_sessions.ts`

## Exclude

- `.playwright-cli/`
- Any `node_modules` directory or symlinked package content.
- Any `plugins/*/node_modules/**` change caused by `pnpm install`.
- Any `output/playwright/*.png` screenshot captured only for local browser verification.
- Any PLM, workflow, platform shell, or IAM file not listed in the include section.
- Any file copied from the old attendance worktree root by mistake.

## Commit Guidance

- Prefer one focused commit for attendance runtime changes and one focused commit for docs/checklist if you want a clean review.
- The attendance runtime commit should include the `holidaySync.lastRun: null` compatibility fix in `plugins/plugin-attendance/index.cjs`; otherwise `GET /api/attendance/settings` and `PUT /api/attendance/settings` remain asymmetric.
- The final target branch must also carry the `/api/auth/me` public-page bootstrap fix in `apps/web/src/App.vue` and `apps/web/src/stores/featureFlags.ts`; otherwise testers will still see the login-page request storm even if the attendance files are correct.
- If the final target branch already contains the migration bridge files, drop them before commit.
- Regenerate `pnpm-lock.yaml` on the final target branch after rebasing or merging the platform login fix.
