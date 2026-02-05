# Attendance Import Commit Token Persistence (Design)

Date: 2026-02-04

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

## Migration
- Added `packages/core-backend/migrations/055_create_attendance_import_tokens.sql` to formalize table creation.

## Lifecycle
1. **Prepare**
   - Generate UUID token
   - Save to memory + DB (if available)
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
- If DB table cannot be created (schema missing), token persistence is skipped.
- When token enforcement is disabled, UI/API can still use legacy `/api/attendance/import`.

## Notes
- Token persistence removes reliance on single-instance in-memory storage.
- DB storage is small and short-lived (TTL 10 minutes).
