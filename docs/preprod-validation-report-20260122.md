# Pre-Prod Validation Report

## Summary
- Date: 2026-01-22
- Owner: TBD
- Environment: pre-prod
- Release tag / commit: 92ae0962
- Scope: login, grid, attendance plugin load, plugin list, API token
- Status: pass with notes (attendance enablement pending)

## Build and Deploy
- Build ID: TBD
- Image or artifact: ghcr.io/zensgit/metasheet2-backend:latest
- Deploy window: TBD
- Feature flags: attendance enablement pending (API returns Not enabled)
- Migration plan: TBD
- Rollback plan: TBD

## Environment Access
- Web URL: http://142.171.239.56:8081
- API URL: http://142.171.239.56:8081/api (proxy) or http://127.0.0.1:8900 (internal)
- Admin URL: TBD
- Observability links: TBD
- Test accounts (roles only, no passwords): admin (DB), user (token display)
- Secrets note: do not paste secrets, use <redacted>

## Pre-Checks
- [ ] Config diff reviewed
- [ ] Backups verified
- [ ] Monitoring and alerts enabled
- [ ] Rollback steps confirmed
- [ ] Data migration dry-run completed (if applicable)

## Validation Checklist
### Smoke
- [x] Login / logout
- [ ] Navigation and routing
- [x] Core workflows (grid)
- [x] Plugin loading
- [ ] Error reporting / toast

### API
- [x] Auth endpoints
- [x] Spreadsheets endpoints
- [ ] Attendance endpoints (returns "Not enabled")
- [ ] WebSocket connection
- [x] OpenAPI / SDK compatibility (token auth)

### Data and Migrations
- Migration IDs: TBD
- [ ] Schema verification
- [ ] Seed data validation
- [ ] Rollback tested (if applicable)
- Post-migration queries: TBD

### Performance and Monitoring
- P95 response time: < 100ms (API token check)
- Error rate: TBD
- Log anomalies: TBD
- Alerts triggered: TBD

### Security and Permissions
- [ ] Role matrix spot checks
- [ ] Audit logging
- [ ] Plugin permission whitelist

### UI and UX
- [x] Grid save / refresh
- [x] Attendance UI reachable (loads plugin status)
- [ ] Attendance UI enabled (pending)
- [ ] Mobile layout

### Regression
- Areas covered: login, grid, plugin load, API token
- Areas deferred: attendance UI enablement, websocket, mobile

## Commands Executed
```sh
# Manual validation via live environment (token not recorded)
curl http://142.171.239.56:8081/api/plugins
curl http://142.171.239.56:8081/api/attendance/settings
node /tmp/attendance-enable.js
```

## Findings
- `/api/plugins` reports attendance plugin as `active`, but `/api/attendance/settings` returns `{"ok":false,"error":"Not enabled"}`.
- Attendance UI route is reachable and shows plugin status loading state, but enablement is still pending.
- Playwright visited `/admin/plugins` and `/settings/plugins` but did not find an Attendance enable toggle (no plugin row detected).
- Role display mismatch observed: admin at DB, token shows user; may need app-level refresh.

## Artifacts
- Logs: N/A
- Screenshots: `/tmp/attendance-page.png`
- Test runs: TBD

## Sign-Off
- QA: TBD
- Dev: TBD
- Ops: TBD
