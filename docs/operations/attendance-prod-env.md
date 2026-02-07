# Attendance Production Environment Variables

This document describes the minimum required environment variables to run MetaSheet2 with the Attendance plugin in a production-ready configuration.

## Files

- Copy `docker/app.env.example` to `docker/app.env`
- Never commit `docker/app.env` (it is gitignored)

## Required (Production)

- `NODE_ENV=production`
- `JWT_SECRET=<random strong secret>`
- `DATABASE_URL=postgres://metasheet:<POSTGRES_PASSWORD>@postgres:5432/metasheet`
- `POSTGRES_PASSWORD=<random strong password>`
- `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`
  - Required to make `/api/attendance/import/preview` + `/commit` safe across restarts and multi-node deployments.

## Recommended

- `PRODUCT_MODE=attendance`
  - Enables the attendance-focused shell (standalone attendance product).
  - Use `PRODUCT_MODE=platform` to keep the full MetaSheet navigation.

## Notes

- If you change `JWT_SECRET`, all existing tokens become invalid (users will need to log in again).
- If `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1` is enabled, ensure migrations are applied:
  - `zzzz20260207150000_create_attendance_import_tokens`
