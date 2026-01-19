# Pre-Prod Validation Report

## Summary
- Date: 2026-01-19
- Owner: TBD
- Environment: dev (local)
- Release tag / commit: d485c1f3 (main)
- Scope: dev validation for grid/spreadsheets + attendance plugin (optional)
- Status: pending (partial dev validation)

## Build and Deploy
- Build ID: N/A (local dev)
- Image or artifact: N/A (local dev)
- Deploy window: N/A (local dev)
- Feature flags: RBAC_TOKEN_TRUST=true (dev token RBAC trust)
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
- [ ] Attendance endpoints (if enabled)
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
- [ ] Attendance UI (if enabled)
- [ ] Mobile layout

### Regression
- Areas covered: dev smoke (grid/attendance routes 200), plugins list shows attendance active, spreadsheets create + cell update
- Areas deferred: UI login flows, attendance API workflows, WebSocket checks, performance

## Commands Executed
```sh
pnpm --filter @metasheet/core-backend migrate
RBAC_TOKEN_TRUST=true PORT=7778 JWT_SECRET=dev-secret-key pnpm --filter @metasheet/core-backend dev
pnpm dev
curl http://localhost:8899/grid
curl http://localhost:8899/attendance
curl http://localhost:7778/api/plugins
curl http://localhost:7778/api/auth/dev-token
```

## Findings
- Issues: RBAC denies spreadsheets write unless `RBAC_TOKEN_TRUST=true` is set for dev token
- Risks: Frontend `.env.local` targets port 7778 while backend `.env` sets 8900; keep them aligned
- Follow-ups: Run attendance API flows, UI grid save flow, WebSocket validation

## Artifacts
- Logs: local dev server logs in terminal
- Screenshots: N/A
- Test runs: N/A (curl-based checks only)

## Sign-Off
- QA: TBD
- Dev: TBD
- Ops: TBD
