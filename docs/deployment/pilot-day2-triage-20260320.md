# Multitable Pilot Daily Triage - Day 2

Date: 2026-03-20
Scope: Day 2-3 scenario validation (4 categories)

## Triage Metadata

- Date: 2026-03-20
- Moderator: Claude (automated pilot tester)
- Teams reviewed: Team A (Admin), Team C (Tester C)
- Build / branch / commit: metasheet-multitable-onprem-v2.5.0-local-20260320 / codex/attendance-run16-feedback-20260320 / 084ff11da

## New Issues

### 1. Comments API: PATCH/DELETE not implemented

1. Title: Comment resolve and delete endpoints return 404
2. Team: Team A
3. Scenario: `comments`
4. Severity: `P2`
5. Blocking pilot: No
6. Repro steps:
   - Create comment via `POST /api/comments` (works)
   - `PATCH /api/comments/:id` with `{"resolved":true}` → 404
   - `DELETE /api/comments/:id` → 404
7. Expected: Comment resolved/deleted
8. Actual: `Cannot PATCH/DELETE /api/comments/:id`
9. Artifact path or issue link: TBD
10. Owner: Backend
11. Fix target: `24h`

### 2. File upload not available (multer not installed)

1. Title: Attachment upload returns "multer not installed"
2. Team: Team A
3. Scenario: `attachment`
4. Severity: `P2`
5. Blocking pilot: No (attachment UI may use different path)
6. Repro steps:
   - `POST /api/files/upload` with multipart file
7. Expected: File uploaded and stored
8. Actual: `{"error":"File upload not available - multer not installed"}`
9. Artifact path or issue link: TBD
10. Owner: Backend
11. Fix target: `24h`

### 3. Non-admin user cannot create comments

1. Title: Tester C (role=user) gets "Insufficient permissions" on comments
2. Team: Team C
3. Scenario: `comments`
4. Severity: `P2`
5. Blocking pilot: No (admin can comment)
6. Repro steps:
   - Login as tester-c@pilot-test.local (role=user)
   - `POST /api/comments` → `{"error":"Insufficient permissions"}`
7. Expected: Regular users should be able to comment on shared spreadsheets
8. Actual: Only admin can create comments
9. Artifact path or issue link: TBD
10. Owner: Backend (RBAC)
11. Fix target: `24h`

### 4. Snapshot compare API not working

1. Title: `/api/snapshots/compare` returns "Snapshot not found"
2. Team: Team A
3. Scenario: `conflict`
4. Severity: `P3`
5. Blocking pilot: No
6. Repro steps:
   - Create 2 snapshots (v1, v2) on same view_id ✅
   - `GET /api/snapshots/compare?view_id=...&from=1&to=2` → NOT_FOUND
7. Expected: Diff between v1 and v2
8. Actual: `{"ok":false,"error":{"code":"NOT_FOUND","message":"Snapshot not found"}}`
9. Artifact path or issue link: TBD
10. Owner: Backend
11. Fix target: `backlog`

### 5. Search API not exposed as REST endpoint

1. Title: No `/api/search` or `/api/spreadsheets/:id/search` route
2. Team: Team A
3. Scenario: `search`
4. Severity: `P2`
5. Blocking pilot: No (frontend search may use client-side filtering)
6. Repro steps:
   - `GET /api/search?q=test` → 404
   - `GET /api/spreadsheets/:id/search?q=test` → 404
7. Expected: Server-side search across spreadsheet data
8. Actual: No route registered
9. Artifact path or issue link: TBD
10. Owner: Backend
11. Fix target: `backlog`

### 6. Backend startup takes ~5s, no readiness probe

1. Title: PM2 restart shows "online" but API unreachable for ~5 seconds
2. Team: Team A
3. Scenario: `other`
4. Severity: `P3`
5. Blocking pilot: No
6. Repro steps:
   - `pm2 restart metasheet-backend`
   - Immediately `curl /health` → connection refused
   - Wait 5s → OK
7. Expected: Readiness probe or startup delay in healthcheck script
8. Actual: Script may false-fail if run immediately after restart
9. Artifact path or issue link: TBD
10. Owner: DevOps
11. Fix target: `backlog`

## Verified Working (Day 2)

| Feature | Status | Notes |
|---------|--------|-------|
| Snapshot create | ✅ | Manual snapshots with version increment |
| Snapshot list | ✅ | Returns all snapshots for view_id |
| Snapshot restore | ✅ | Restores with itemsRestored count |
| Comment create (admin) | ✅ | With spreadsheetId + rowId |
| Comment list | ✅ | Paginated with total count |
| Spreadsheet list | ✅ | Paginated (page/pageSize) |
| WebSocket collab endpoint | ✅ | /socket.io/ returns 200 |
| Multi-user login | ✅ | Admin + Tester C both login OK |
| DB backup/restore | ✅ | pg_dump 1.0M, restores cleanly |
| PM2 stop/restart cycle | ✅ | Data persists across restart |
| Data persistence | ✅ | Snapshots (2) + comments (1) survive restart |

## Daily Decision

- `P0` count: 0
- `P1` count: 0 (Day 1 P1 #515 still open but has workaround)
- `P2` count: 3 new (comments CRUD, file upload, user permissions)
- `P3` count: 2 new (snapshot compare, startup probe)
- Pilot should continue tomorrow: **Yes**
- Hotfix required today: **No**
- If yes, exact fix batch: N/A

## Notes

- Repeated confusion themes: REST API coverage is thin for comments/attachments/search — most data flow goes through WebSocket collab, which makes API-only testing limited
- Copy / UX issues worth fixing without changing contracts: Comment PATCH/DELETE routes just need wiring (likely already implemented in service layer)
- Risks to watch tomorrow: File upload (multer) blocks attachment scenario; non-admin comment permission blocks multi-user collaboration testing
