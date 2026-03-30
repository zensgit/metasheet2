# Attendance Import Template Quickstart

This note is the shortest operator-facing guide for the current on-prem attendance import flow.

## Minimum working CSV

For a single-user punch correction import, the minimum working header is:

```csv
日期,上班1打卡时间,下班1打卡时间
2026-03-30,09:02,18:11
```

Use `YYYY-MM-DD` for the date column when possible.

## When this minimum header is enough

- You are importing rows for the current signed-in user.
- You do not need to map multiple employees in the same file.

## When you need more than the minimum header

Add an employee key column or use a saved mapping profile when:

- one CSV contains multiple employees
- the backend needs to resolve `userId` from employee numbers or names
- you are importing a DingTalk daily summary export instead of a single-user correction file

## Recommended operator flow

1. Open Attendance admin.
2. Go to Import.
3. Click `Load template`.
4. Review `Suggested CSV header`, `Required fields`, and `Field meanings`.
5. If needed, select a saved mapping profile.
6. Download the server-generated CSV template from `Download CSV template`.
7. Run `Preview` before `Commit`.

## API endpoints

- `GET /api/attendance/import/template`
- `GET /api/attendance/import/template.csv`
- `POST /api/attendance/import/upload`
- `POST /api/attendance/import/prepare`
- `POST /api/attendance/import/preview`
- `POST /api/attendance/import/commit`

## Related references

- `docs/ATTENDANCE_IMPORT_DINGTALK_CSV.md`
- `docs/ATTENDANCE_IMPORT_VERIFICATION.md`
