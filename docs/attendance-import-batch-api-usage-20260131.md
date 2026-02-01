# Attendance Import Batch API Usage (2026-01-31)

## Overview
This outlines the commit-token based import flow for the attendance plugin:

1) `POST /api/attendance/import/prepare` → returns `commitToken`
2) `POST /api/attendance/import/commit` → persists batch + records
3) `POST /api/attendance/import/rollback/:batchId` → removes imported records

## Auth
Use a JWT with `attendance:admin` permission.

### Dev token (non-production only)
```
curl -s "http://localhost:8900/api/auth/dev-token?userId=<USER_ID>&roles=admin&perms=attendance:admin" | jq -r .token
```

## Prepare commit token
```
curl -s -X POST "http://localhost:8900/api/attendance/import/prepare" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "x-user-id: <USER_ID>" \
  -H "x-org-id: default"
```

Response:
```
{
  "ok": true,
  "data": {
    "commitToken": "<TOKEN>",
    "expiresAt": "2026-01-31T09:14:32.218Z",
    "ttlSeconds": 600
  }
}
```

## Commit batch (manual rows)
```
curl -s -X POST "http://localhost:8900/api/attendance/import/commit" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "x-user-id: <USER_ID>" \
  -H "x-org-id: default" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "manual",
    "orgId": "default",
    "commitToken": "<COMMIT_TOKEN>",
    "rows": [
      {
        "workDate": "2026-01-30",
        "fields": {
          "firstInAt": "2026-01-30 09:05",
          "lastOutAt": "2026-01-30 18:01",
          "workMinutes": 480,
          "status": "normal"
        }
      }
    ]
  }'
```

Response:
```
{
  "ok": true,
  "data": {
    "batchId": "<BATCH_ID>",
    "imported": 1,
    "items": [
      { "id": "<RECORD_ID>", "userId": "<USER_ID>", "workDate": "2026-01-30" }
    ]
  }
}
```

## Rollback batch
```
curl -s -X POST "http://localhost:8900/api/attendance/import/rollback/<BATCH_ID>" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "x-user-id: <USER_ID>" \
  -H "x-org-id: default"
```

Response:
```
{
  "ok": true,
  "data": {
    "status": "rolled_back"
  }
}
```

## Notes
- `commitToken` is required for `/import/commit`.
- Batches are stored in `attendance_import_batches`; per-row snapshots go to `attendance_import_items`.
- Attendance records are linked by `attendance_records.source_batch_id` for cleanup.
