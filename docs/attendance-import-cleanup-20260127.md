# Attendance Import Cleanup Guide (2026-01-27)

## Purpose
Remove test attendance data imported with `source = dingtalk_csv_test`.

## Generate Cleanup SQL
```bash
node scripts/attendance/generate-cleanup-sql.cjs \
  --source dingtalk_csv_test \
  --org default \
  --from 2025-12-01 \
  --to 2026-02-01 \
  --file /tmp/attendance_cleanup.sql
```

## Execute Cleanup SQL
```bash
psql "$DATABASE_URL" -f /tmp/attendance_cleanup.sql
```

## Notes
- The SQL removes attendance records and raw events linked to the source tag.
- Adjust the `from/to` range to limit scope.
- Run during low traffic; cleanup is destructive.
