# Attendance Import: Groups + CSV + User Map (Verification)

Date: 2026-02-05

## Automated Tests
- `pnpm --filter @metasheet/web exec vitest run --watch=false`
  - Result: **PASS** (26 tests)

## Manual / Runtime Checks
- Not executed locally (requires running backend + DB).

## Suggested Runtime Verification
1. Load Attendance → Admin → Import UI.
2. Select mapping profile **DingTalk CSV Daily Summary**.
3. Upload CSV + user map JSON.
4. Enable **Auto-create groups** and **Auto-assign group members**.
5. Preview → ensure warnings list group creation info.
6. Import → confirm:
   - `attendance_groups` created
   - `attendance_group_members` populated
   - Import response contains `meta.groupCreated` and `meta.groupMembersAdded`.

