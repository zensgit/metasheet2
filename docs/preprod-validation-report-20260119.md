# Pre-Prod Validation Report

## Summary
- Date: 2026-01-19
- Owner: TBD
- Environment: dev (local)
- Release tag / commit: be92b0e9 (main)
- Scope: dev validation for grid/spreadsheets + attendance plugin (optional)
- Status: in progress (dev validation; grid save + WebSocket + attendance UI flow + mobile + OpenAPI ok; admin scheduling/export verified; auth register/login/verify/me done; logout not implemented; assignment delete pending)

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
- Test accounts (roles only, no passwords): dev-user (admin via dev token), attn-login3@example.com, attn-login4@example.com
- Secrets note: do not paste secrets, use <redacted>

## Pre-Checks
- [ ] Config diff reviewed
- [ ] Backups verified
- [ ] Monitoring and alerts enabled
- [ ] Rollback steps confirmed
- [x] Data migration dry-run completed (if applicable)

## Validation Checklist
### Smoke
- [x] Login (API)
- [ ] Logout (client-side token clear only)
- [x] Navigation and routing
- [ ] Core workflows (list)
- [x] Plugin loading
- [ ] Error reporting / toast

### API
- [x] Auth endpoints
- [x] Spreadsheets endpoints
- [x] Attendance endpoints (if enabled)
- [x] WebSocket connection
- [x] OpenAPI / SDK compatibility

### Data and Migrations
- Migration IDs: zzzz20260113_create_spreadsheets_table, zzzz20260117120000_create_spreadsheet_grid_tables, zzzz20260114090000_create_attendance_tables, zzzz20260114100000_add_attendance_org_id, zzzz20260114120000_add_attendance_scheduling_tables, zzzz20260117090000_add_attendance_permissions, zzzz20260119100000_create_users_table
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
- [x] Grid save / refresh
- [x] Attendance UI (if enabled)
- [x] Attendance admin scheduling + export (API)
- [x] Mobile layout

### Regression
- Areas covered: dev smoke (grid/attendance routes 200), plugins list shows attendance active, spreadsheets create + cell update, grid UI save persisted, WebSocket handshake, attendance API flows (rules/punch/records/summary/requests/settings/shifts/assignments/holidays/export), attendance UI request submit/approve, attendance UI delete for shifts/holidays, mobile layout checks, OpenAPI security validation + SDK match
- Areas deferred: logout UX (token clear), attendance admin UI delete flow for assignments, performance

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
curl http://localhost:7778/api/attendance/shifts
curl http://localhost:7778/api/attendance/assignments
curl http://localhost:7778/api/attendance/holidays
curl http://localhost:7778/api/attendance/export
curl http://localhost:7778/api/auth/login
curl http://localhost:7778/api/auth/register
curl http://localhost:7778/api/auth/verify
curl http://localhost:7778/api/auth/me
curl http://localhost:7778/socket.io/?EIO=4&transport=polling
# authenticated dev token used for spreadsheet cell verification
curl http://localhost:7778/api/spreadsheets/:id/sheets/:id/cells
pnpm dlx tsx packages/openapi/tools/validate.ts packages/openapi/src/openapi.yml
cmp -s packages/openapi/dist/sdk.ts packages/openapi/dist-sdk/index.d.ts
```

## Findings
- Issues: Attendance plugin routes require `RBAC_BYPASS=true` unless permissions are seeded for the dev user
- Issues: Attendance export returns header-only unless `userId` matches records
- Issues: Logout endpoint not implemented; UI should clear JWT locally
- Issues: Users table migration required for auth register/login (now added)
- Risks: Frontend `.env.local` targets port 7778 while backend `.env` sets 8900; keep them aligned
- Follow-ups: Attendance admin UI delete flow for assignments, logout UX, performance

## Artifacts
- Logs: local dev server logs in terminal
- Screenshots: N/A
- Test runs: N/A (curl-based checks only)

## Sign-Off
- QA: TBD
- Dev: TBD
- Ops: TBD
