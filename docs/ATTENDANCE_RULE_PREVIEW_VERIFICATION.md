# Attendance Rule Preview (Engine) Verification

## Build Verification
- Command: `pnpm --filter @metasheet/web build`
- Result: ✅ Success
- Notes: Vite reported a chunk-size warning (existing build guidance). No build errors.

## Runtime Verification
- UI/API execution: Not run in this workspace (requires running app + valid backend).
- Recommended check:
  1) Open Attendance → Admin → Rule Preview (Engine)
  2) Fill work date + clock in/out + (optional) role tags/attendance group
  3) Click **Run preview**
  4) Confirm status + minutes + engine diagnostics populate
