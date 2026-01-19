# Pre-Prod Validation Report

## Summary
- Date: 2026-01-19
- Owner: TBD
- Environment: dev (local)
- Release tag / commit: be92b0e9 (main)
- Scope: dev validation for grid/spreadsheets + attendance plugin (optional)
- Status: in progress (dev validation)

## Build and Deploy
- Build ID: N/A (local dev)
- Image or artifact: N/A (local dev)
- Deploy window: N/A (local dev)
- Feature flags: RBAC_BYPASS=true, RBAC_TOKEN_TRUST=true
- Migration plan: run `pnpm --filter @metasheet/core-backend migrate` with `DATABASE_URL`
- Rollback plan: reset dev DB (drop + re-migrate) if needed

## Environment Access
- Web URL: http://localhost:8899 (Vite dev)
- API URL: http://localhost:7778 (backend dev, aligned to `VITE_API_URL`)
- Admin URL: http://localhost:7778/api/admin (direct) or http://localhost:8899/api/admin (via Vite proxy)
- Observability links: N/A (dev)
- Test accounts (roles only, no passwords): dev-user (admin via dev token)
- Secrets note: do not paste secrets, use <redacted>

## Pre-Checks
- [ ] Config diff reviewed
- [ ] Backups verified
- [ ] Monitoring and alerts enabled
- [ ] Rollback steps confirmed
- [x] Data migration dry-run completed (if applicable)

## Validation Checklist
### Smoke
- [ ] Login / logout
- [x] Navigation and routing
- [ ] Core workflows (list)
- [x] Plugin loading
- [ ] Error reporting / toast

### API
- [x] Auth endpoints
- [x] Spreadsheets endpoints
- [x] Attendance endpoints (if enabled)
- [ ] WebSocket connection
- [ ] OpenAPI / SDK compatibility

### Data and Migrations
- Migration IDs: zzzz20260113_create_spreadsheets_table, zzzz20260117120000_create_spreadsheet_grid_tables, zzzz20260114090000_create_attendance_tables, zzzz20260114100000_add_attendance_org_id, zzzz20260114120000_add_attendance_scheduling_tables, zzzz20260117090000_add_attendance_permissions
- [ ] Schema verification
- [ ] Seed data validation
- [ ] Rollback tested (if applicable)
- Post-migration queries: TBD

### Performance and Monitoring
- P95 response time: TBD
- Error rate: TBD
- Log anomalies: TBD
- Alerts triggered: TBD

### Security and Permissions
- [ ] Role matrix spot checks
- [ ] Audit logging
- [ ] Plugin permission whitelist

### UI and UX
- [ ] Grid save / refresh
- [x] Attendance UI (if enabled)
- [ ] Mobile layout

### Regression
- Areas covered: dev smoke (grid/attendance routes 200), plugins list shows attendance active, spreadsheets create + cell update, attendance API flows (rules/punch/records/summary/requests/settings/shifts)
- Areas deferred: UI login flows, grid save via UI, WebSocket checks, performance

## Commands Executed
```sh
pnpm --filter @metasheet/core-backend migrate
RBAC_BYPASS=true RBAC_TOKEN_TRUST=true PORT=7778 JWT_SECRET=dev-secret-key pnpm --filter @metasheet/core-backend dev
pnpm dev
curl http://localhost:8899/grid
curl http://localhost:8899/attendance
curl http://localhost:7778/api/plugins
curl http://localhost:7778/api/auth/dev-token
curl http://localhost:7778/api/attendance/punch
curl http://localhost:7778/api/attendance/records
curl http://localhost:7778/api/attendance/summary
curl http://localhost:7778/api/attendance/requests
curl http://localhost:7778/api/attendance/rules/default
curl http://localhost:7778/api/attendance/settings
```

## Findings
- Issues: Attendance plugin routes require `RBAC_BYPASS=true` unless permissions are seeded for the dev user
- Risks: Frontend `.env.local` targets port 7778 while backend `.env` sets 8900; keep them aligned
- Follow-ups: Grid save via UI, WebSocket validation, attendance request/review flows in UI

## Artifacts
- Logs: local dev server logs in terminal
- Screenshots: N/A
- Test runs: N/A (curl-based checks only)

## Sign-Off
- QA: TBD
- Dev: TBD
- Ops: TBD
