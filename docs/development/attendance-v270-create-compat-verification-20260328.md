# Attendance v2.7.0 Create Compatibility Verification

## What I verified

### Repo hygiene

- `git diff --check`
  - result: passed

### Frontend contract guard

- `pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminLeavePolicies.spec.ts --watch=false`
  - result: passed
  - verified:
    - invalid approval-flow step JSON is still rejected client-side
    - approval-flow create still sends `requestType` in the POST body
    - approval-flow save reloads the list and keeps the success path intact

- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - result: passed

### Backend compatibility

- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "accepts compatibility payload aliases for approval flow and rule set create routes" --reporter=dot`
  - result: passed
  - verified:
    - approval-flow create accepts `type` as a compatibility alias for `requestType`
    - approval-flow create accepts `steps` as a JSON string and still normalizes nested snake_case approver ids
    - rule-set create accepts numeric `version` strings
    - rule-set create accepts object-shaped `config` as a JSON string
    - normalized responses still come back in the canonical payload shape

- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`
  - result: passed

## Validation intent

This verification targets the narrow remaining gap reported in `v2.7.0` testing:

- the admin UI is proven to still send the required approval-flow request fields
- the backend is more tolerant of realistic legacy/external payloads
- the change remains scoped to create-path compatibility rather than broader Attendance route semantics
