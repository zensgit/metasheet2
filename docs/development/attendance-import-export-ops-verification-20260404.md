# Attendance Import/Export Ops Verification

Date: 2026-04-04

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/attendance-import-ops-summary.spec.ts tests/attendance-import-preview-regression.spec.ts tests/AttendanceImportWorkflowSection.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- New real-page import summary test passes:
  - [attendance-import-ops-summary.spec.ts](../../apps/web/tests/attendance-import-ops-summary.spec.ts)
- Existing preview regression still passes after the UI changes:
  - [attendance-import-preview-regression.spec.ts](../../apps/web/tests/attendance-import-preview-regression.spec.ts)
- Existing workflow-section summary tests still pass:
  - [AttendanceImportWorkflowSection.spec.ts](../../apps/web/tests/AttendanceImportWorkflowSection.spec.ts)
- Type-check passed
- Build passed
- `git diff --check` passed

## Behavioral checks covered

- Admin import UI now shows a "Current import plan" block in the real page
- Admin import UI now shows a "Preview outcome" block before the preview table
- Preview retry failures do not leave stale preview rows/warnings on screen
