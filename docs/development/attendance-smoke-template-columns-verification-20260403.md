# Attendance Smoke Template Columns Verification

## Commands

```bash
node --check scripts/ops/attendance-smoke-api.mjs

git diff --check
```

## Result

- script syntax: passed
- `git diff --check`: passed

## Verified Change

- The smoke script no longer echoes template-only `columns`/`requiredFields` back to preview and commit payloads.
- The smoke script now uses the template response's `defaultProfileId` before falling back to `dingtalk_csv_daily_summary`.

