# Attendance Run11 Release Checklist

## Candidate

- Branch: `codex/attendance-run11-release-20260315`
- Worktree: `/Users/huazhou/Downloads/Github/metasheet2-attendance-run11-release-20260315`
- Base: `origin/main` at `66cf34ac272409553a17862c2ddf37a990eb127b`

## Already Verified On 2026-03-13

- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend db:migrate`
- `pnpm exec vitest run --watch=false tests/useAttendanceAdminAuditLogs.spec.ts tests/useAttendanceAdminConfig.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/useAttendanceAdminPayroll.spec.ts tests/useAttendanceAdminProvisioning.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/attendance-experience-mobile-zh.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts`
- `CI=true pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "registers attendance routes and lists plugin" --reporter=dot`
- `node --check plugins/plugin-attendance/index.cjs`
- `pnpm --filter @metasheet/web exec vitest run tests/useAttendanceHolidayRuleSection.spec.ts`
- Browser validation on `http://127.0.0.1:8897/p/plugin-attendance/attendance?tab=admin` confirmed the holiday override `节假日名称` input expands with the column width after clicking `新增覆盖`.
- Narrow-desktop validation at `1100x950` confirmed the holiday name input renders at `309.75px` inside a `325.75px` table cell (`95.1%` fill) with no horizontal overflow.
- Narrow-screen validation at `820x950` intentionally switches to the existing desktop-only guidance state (`建议使用桌面端`) instead of rendering the admin console.
- Browser validation on `http://127.0.0.1:8896/p/plugin-attendance/attendance?tab=admin` confirmed the admin order is now `设置 -> 节假日策略 -> 节假日同步 -> 节假日 -> ... -> 默认规则 -> 轮班规则 -> 轮班分配 -> 班次 -> 排班分配`.
- Browser validation on `http://127.0.0.1:8896/p/plugin-attendance/attendance?tab=admin` confirmed `节假日覆盖规则` is collapsed by default, expands on click, and `新增覆盖` reveals an editable holiday-name input.
- Save/refresh regression against the current local backend confirmed holiday data created for `2026-02-11` reappears in the admin holiday table after reload.

## Additionally Verified On 2026-03-15

- `pnpm install --lockfile-only`
- `CI=true pnpm install --offline`
- `pnpm --filter @metasheet/web exec vitest run tests/featureFlags.spec.ts tests/useAuth.spec.ts tests/utils/api.test.ts tests/useAttendanceAdminAuditLogs.spec.ts tests/useAttendanceAdminConfig.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/useAttendanceAdminPayroll.spec.ts tests/useAttendanceAdminProvisioning.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts tests/attendance-experience-mobile-zh.spec.ts`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend db:migrate`
- `CI=true pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "registers attendance routes and lists plugin" --reporter=dot`
- `node --check plugins/plugin-attendance/index.cjs`
- The same public-page auth bootstrap fix was browser-validated on the latest platform branch before being ported into this release candidate: `/login` with no token made `0` `/api/auth/me` requests over a 3-second idle period, and `/login` with a stale token made exactly `1` `/api/auth/me` request before stopping.
- Final release validation required carrying `packages/core-backend/src/db/migrations/zzzz20260313183000_create_user_sessions.ts` because the local database had already executed that migration.

## Must Be True Before Publishing Run11

1. This release branch still contains the `/api/auth/me` login-page loop fix now staged in the web shell.
2. `pnpm-lock.yaml` is regenerated on this release branch, not copied from an older worktree snapshot.
3. The release branch still contains the migration history required by the local or target database.
4. The commands in the revalidation section below all pass again after any final cherry-pick or rebase.

## Revalidation On Final Target Branch

1. `pnpm install --lockfile-only`
2. `CI=true pnpm install --offline`
3. `pnpm --filter @metasheet/web build`
4. `pnpm --filter @metasheet/core-backend build`
5. `pnpm --filter @metasheet/core-backend db:migrate`
6. `pnpm exec vitest run --watch=false tests/useAttendanceAdminAuditLogs.spec.ts tests/useAttendanceAdminConfig.spec.ts tests/useAttendanceAdminImportBatches.spec.ts tests/useAttendanceAdminImportWorkflow.spec.ts tests/useAttendanceAdminLeavePolicies.spec.ts tests/useAttendanceAdminPayroll.spec.ts tests/useAttendanceAdminProvisioning.spec.ts tests/useAttendanceAdminRulesAndGroups.spec.ts tests/useAttendanceAdminScheduling.spec.ts tests/attendance-experience-mobile-zh.spec.ts tests/useAttendanceHolidayRuleSection.spec.ts`
7. `CI=true pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "registers attendance routes and lists plugin" --reporter=dot`

## Functional Changes Covered By This Candidate

- Attendance admin console split out of the giant attendance page into dedicated sections and composables.
- Punch status feedback added after successful punch.
- Date display localized instead of exposing raw ISO timestamps in request and record views.
- Leave type `paid/unpaid` wired through frontend, plugin, migration, DB types, and OpenAPI.
- Numeric placeholder attendance groups such as `"1"` no longer auto-create during CSV import.
- Login title flash fixed from the raw Vite default title to `MetaSheet`.
- Integration test hardened so anomaly assertions are not broken by developer-local holiday data.
- Holiday policy and holiday data sections are now grouped in the same area, and the holiday override block supports explicit collapse/expand with a visible state toggle (`节假日覆盖规则`) and an `新增覆盖` action that opens editable override rows.

## Known Non-Blocking Notes

- Vite still reports a large chunk warning during frontend build.
- Attendance import integration logs still show COPY fallback to `unnest` in this local environment; the tested flow still passes.
- The long-running backend on port `7778` is still serving `/Users/huazhou/Downloads/Github/metasheet2`, so live API checks against that port can still reflect older `/api/auth/me` behavior instead of this release branch.

## New Fixes From This Validation Round

- Holiday-related admin features are now grouped together: `节假日策略 -> 节假日同步 -> 节假日`, while `默认规则` moved back into scheduling.
- `节假日覆盖规则` is now an explicit accordion, so the section stays compact until the user expands it.
- Candidate code now accepts `holidaySync.lastRun: null` on `PUT /api/attendance/settings`, fixing the GET/PUT contract asymmetry discovered during regression.
- Public auth pages now skip session probing during feature bootstrap, so `/login` no longer hammers `/api/auth/me` when no token is present and no longer loops after a stale-token `401`.
- A later authenticated navigation now refreshes feature flags even if the SPA first booted on a public page with anonymous defaults.
- Final release integration explicitly includes the missing `zzzz20260313183000_create_user_sessions.ts` bridge migration required by the local DB migration history.

## External Blocker

- No additional technical blocker remains in this release branch. Only final reviewer sign-off and any requested cherry-picks should precede sending `run11` to testers.
