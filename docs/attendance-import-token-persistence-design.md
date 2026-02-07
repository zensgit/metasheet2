# Attendance Import Commit Token Persistence (Design)

Date: 2026-02-07

## Goal
Prevent commit token failures in multi-instance or restart scenarios by persisting import commit tokens outside process memory.

## Storage
Use a dedicated table in the primary DB:

```
attendance_import_tokens
- token (text, PK)
- org_id (text)
- user_id (text)
- expires_at (timestamptz)
- created_at (timestamptz)
```

Indexes:
- `attendance_import_tokens_org_idx` on `org_id`
- `attendance_import_tokens_expires_idx` on `expires_at`
- `attendance_import_tokens_user_idx` on (`org_id`, `user_id`)

## Migration
- Added `packages/core-backend/src/db/migrations/zzzz20260207150000_create_attendance_import_tokens.ts` to formalize table creation.
- The plugin **must not** create tables at runtime (production hardening). Migrations are required.

## Lifecycle
1. **Prepare**
   - Generate UUID token
   - Persist to DB
   - Cache in memory as an optimization (optional)
   - Return token + expiresAt

2. **Consume**
   - Check memory first
   - If not present, read DB
   - Validate org/user/expiry
   - Delete from DB on use

3. **Prune**
   - Delete expired rows on create/consume

## Feature Flags
- `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1` enforces commit token usage.
- If not set, commit endpoint accepts payloads without token (useful for test envs).

## Failure Modes / Fallback
- If `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1` and `attendance_import_tokens` is missing:
  - `/api/attendance/import/prepare` returns `503 DB_NOT_READY`
  - `/api/attendance/import/preview` + `/api/attendance/import/commit` return `503 DB_NOT_READY`
  - legacy `/api/attendance/import` also requires a valid `commitToken` (prevents bypass + masks)
- When token enforcement is disabled:
  - preview/commit accept missing tokens
  - legacy `/api/attendance/import` remains available for older UI compatibility

## Notes
- Token persistence removes reliance on single-instance in-memory storage.
- DB storage is small and short-lived (TTL 10 minutes).
- Frontend should treat `commitToken` as **single-use** (refresh before preview/commit).
