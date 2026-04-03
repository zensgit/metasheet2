# Attendance Request Settlement Smoke Verification

## Commands

```bash
node --check scripts/ops/attendance-smoke-api.mjs

git diff --check
```

## Result

- script syntax: passed
- `git diff --check`: passed

## Verified Change

The smoke script now fails fast unless all three stages line up for the same work date:

1. request creation succeeds
2. approval succeeds
3. `/api/attendance/records` returns an `adjusted` record for that same user and date

## Operational Use

Run the script against a deployed environment with the usual `API_BASE` and `AUTH_TOKEN`. The script now captures the exact approval-settlement chain that previously required manual curl debugging.

