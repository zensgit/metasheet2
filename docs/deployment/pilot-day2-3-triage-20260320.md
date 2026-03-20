# Multitable Pilot Daily Triage - Day 2-3

## Triage Metadata

- Date: 2026-03-20 (Day 2-3 combined)
- Moderator: Claude (automated pilot tester)
- Teams reviewed: Team A (comments/attachments), Team B (grid/search/conflict)
- Build / branch / commit: metasheet-multitable-onprem-v2.5.0-local-20260320 / codex/attendance-run16-feedback-20260320 / 084ff11da

## New Issues

### Issue 1: No optimistic locking / version conflict detection

1. Title: Cell writes use last-write-wins, no conflict detection
2. Team: B
3. Scenario: conflict
4. Severity: P1
5. Blocking pilot: No (workaround: manual coordination)
6. Repro steps:
   - User A writes cell R2C0 = "User A writes this"
   - User B writes cell R2C0 = "User B writes this" (simultaneously)
   - No error returned to either user
7. Expected: Second writer gets conflict error or merge prompt
8. Actual: Last HTTP request wins silently, first user's data lost
9. Artifact path: N/A (API behavior)
10. Owner: backend team
11. Fix target: 24h (add version field to cells, return 409 on stale write)

### Issue 2: New users cannot write to spreadsheets (RBAC)

1. Title: Non-admin users get "Insufficient permissions" on cell writes
2. Team: B
3. Scenario: conflict
4. Severity: P2
5. Blocking pilot: Yes (multi-user testing blocked)
6. Repro steps:
   - Create user via POST /api/admin/users with role "user"
   - Login as new user
   - PUT /api/spreadsheets/:id/sheets/:sheetId/cells → "Insufficient permissions"
7. Expected: Users with "user" role can write to spreadsheets
8. Actual: Only admin can write
9. Artifact path: N/A
10. Owner: backend team
11. Fix target: today (grant spreadsheets:write to default user role)

### Issue 3: File upload not available - multer not installed

1. Title: POST /api/files/upload returns "File upload not available - multer not installed"
2. Team: A
3. Scenario: attachment
4. Severity: P1
5. Blocking pilot: Yes (attachment flow completely broken)
6. Repro steps:
   - POST /api/files/upload with multipart form data
7. Expected: File uploaded and stored
8. Actual: Error: "File upload not available - multer not installed"
9. Artifact path: N/A
10. Owner: backend team / packaging
11. Fix target: today (add multer to dependencies or pre-install in package)

### Issue 4: No server-side search endpoint

1. Title: No /api/search or /api/spreadsheets/:id/search endpoint exists
2. Team: B
3. Scenario: search
4. Severity: P2
5. Blocking pilot: No (frontend client-side search works for small datasets)
6. Repro steps:
   - GET /api/search?q=anything → 404
   - GET /api/spreadsheets/:id/search?q=anything → 404
7. Expected: Server-side full-text search across cells
8. Actual: No search API; search is frontend-only (loads all data, filters in browser)
9. Artifact path: N/A
10. Owner: backend team
11. Fix target: backlog (acceptable for <5000 rows, problematic at scale)

### Issue 5: No server-side pagination for cells

1. Title: GET cells returns ALL cells, no limit/offset support
2. Team: B
3. Scenario: search
4. Severity: P2
5. Blocking pilot: No (1100 rows / 2305 cells load in 56ms)
6. Repro steps:
   - Write 1100 rows
   - GET /api/spreadsheets/:id/sheets/:sheetId/cells?startRow=50&endRow=55
   - All 2305 cells returned (params ignored)
7. Expected: Only cells in requested range returned
8. Actual: Full dataset returned regardless of query params
9. Artifact path: N/A
10. Owner: backend team
11. Fix target: backlog (acceptable <10K rows, required for larger datasets)

### Issue 6: Snapshot restore reports success but does not restore data

1. Title: POST /snapshots/:id/restore returns itemsRestored=0, data unchanged
2. Team: B
3. Scenario: other (rollback)
4. Severity: P1
5. Blocking pilot: No (snapshot create works, restore is broken)
6. Repro steps:
   - Create snapshot S1
   - Overwrite cells
   - POST /snapshots/S1/restore → {"success":true,"itemsRestored":0}
   - Read cells → still shows overwritten values
7. Expected: Cells restored to snapshot state
8. Actual: Restore reports success but restores 0 items
9. Artifact path: N/A
10. Owner: backend team
11. Fix target: 24h (critical for upgrade rollback story)

### Issue 7: Snapshot list returns empty

1. Title: GET /api/snapshots?view_id=:id returns no items despite snapshots created
2. Team: B
3. Scenario: other (rollback)
4. Severity: P2
5. Blocking pilot: No
6. Repro steps:
   - Create 2 snapshots via POST /api/snapshots
   - GET /api/snapshots?view_id=:sheetId → empty items
7. Expected: Created snapshots listed
8. Actual: Empty list (snapshots may be using different query field)
9. Artifact path: N/A
10. Owner: backend team
11. Fix target: 24h

## Carried Over from Day 1

| # | Title | Severity | Day 1 Issue | Status |
|---|-------|----------|-------------|--------|
| D1-1 | pnpm add -w deletes dist | P1 | #515 | Open |
| D1-2 | DATABASE_URL sslmode | P2 | #517 | Open |
| D1-3 | bcryptjs missing | P2 | #518 | Open |
| D1-4 | CSV import format | P2 | #519 | Open |
| D1-5 | View API 500 | P2 | #520 | Open |
| D1-6 | Form submit 404 | P2 | #521 | Open |
| D1-7 | PM2 env vars | P2 | #522 | Open |
| D1-8 | /api/events SQL column | P3 | #523 | Open |

## Daily Decision

- P0 count: 0
- P1 count: 3 (conflict detection, file upload, snapshot restore)
- P2 count: 4 (RBAC, search, pagination, snapshot list)
- P3 count: 0
- Pilot should continue tomorrow: **Yes** (core CRUD works, performance good)
- Hotfix required today: **Yes**
- If yes, exact fix batch:
  1. Add multer to package dependencies (unblocks attachment testing)
  2. Grant spreadsheets:write to default user role (unblocks multi-user)
  3. Fix snapshot restore logic (unblocks rollback story)

## Notes

- Repeated confusion themes:
  - Comment API requires `rowId` field that doesn't map to actual cell row indexes
  - No discoverable API documentation (endpoints found by reading source code)
- Copy / UX issues worth fixing without changing contracts:
  - Comment `parentId` resolution - reply created with parentId="NONE" when comment ID extraction fails
- Risks to watch tomorrow:
  - Performance at >10K rows without pagination
  - WebSocket collab (socket.io) not tested yet (nginx proxy configured but untested)
- Positive findings:
  - Cell write performance excellent: 2000 cells in 378ms
  - Cell read performance excellent: 2305 cells in 56ms
  - PM2 restart preserves all data (PostgreSQL persistence works)
  - Comments CRUD fully functional (create, reply, resolve)
  - Health endpoint reliable across restarts
