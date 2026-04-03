# Platform UI Follow-up Verification

Date: 2026-04-03

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/attendance-experience-entrypoints.spec.ts tests/attendance-experience-zh-tabs.spec.ts tests/attendance-experience-mobile-zh.spec.ts tests/routeTitles.spec.ts tests/approval-inbox-auth-guard.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- Attendance reports tab now resolves to a dedicated reports view in tests.
- Chinese attendance route title resolution is covered by unit tests.
- Approval inbox boot requests now explicitly suppress the global unauthorized redirect path and this is covered by unit test.
- Frontend type-check passed.
- Production frontend build passed.
- `git diff --check` passed.

## Manual follow-up

After deploy, confirm in browser:

1. Chinese locale shows `考勤 - MetaSheet` instead of `Attendance - MetaSheet`.
2. Attendance `报表` no longer opens the same mixed overview screen as `总览`.
3. Clicking `审批中心` no longer clears the current login session when the approval API is unavailable.
4. With `ENABLE_PLM=0`, `/plm` and `/plm/audit` links are not shown.
