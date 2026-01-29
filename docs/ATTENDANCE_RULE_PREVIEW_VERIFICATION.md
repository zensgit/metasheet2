# Attendance Rule Preview (Engine) Verification

## Build Verification
- Command: `pnpm --filter @metasheet/web build`
- Result: ✅ Success
- Notes: Vite reported a chunk-size warning (existing build guidance). No build errors.

## Runtime Verification
- UI/API execution: ✅ Pass (2026-01-29)
- Steps:
  1) Opened Attendance → Admin → Rule Preview (Engine)
  2) Filled: userId=attendance-test, workDate=today, clockIn=09:05, clockOut=18:02, actualHours=8
  3) Clicked **Run preview**
- Result:
  - Status: Normal
  - Work minutes: 480
  - Late minutes: 0
  - Early leave: 0
  - Leave minutes: 0
  - Overtime minutes: 0
  - Engine diagnostics: empty (no engine overrides returned for this sample)
  - Overrides/Base: not shown (engine result empty for this sample)

## Engine Override Verification
- Rule added in `用户自定义` template: `rule_driver_short`
  - when: `role_tags_contains: driver`
  - then: `actual_hours: 6`, `warning: Driver short shift`, `reason: Role-based adjustment`
- Preview inputs: roleTags=driver, clockIn=09:05, clockOut=18:02, actualHours=8
- Result:
  - Applied rules: `rule_driver_short`
  - Warnings: `Driver short shift`
  - Reasons: `Role-based adjustment`
  - Overrides: `workMinutes=360` (6 hours), `overtimeMinutes=0`, `requiredMinutes=0`
  - Base metrics: `workMinutes=480`, `overtimeMinutes=0`
