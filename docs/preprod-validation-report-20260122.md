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
# Server-local validation (backend direct)
curl http://127.0.0.1:8900/api/auth/login
curl http://127.0.0.1:8900/api/attendance/settings
```

## Findings
- `/api/plugins` reports attendance plugin as `active`, but `/api/attendance/settings` returns `{"ok":false,"error":"Not enabled"}`.
- Attendance UI route is reachable and shows plugin status loading state, but enablement is still pending.
- Playwright visited `/admin/plugins` and `/settings/plugins` but did not find an Attendance enable toggle (no plugin row detected).
- Direct backend call on `127.0.0.1:8900` also returns `404 {"ok":false,"error":"Not enabled"}`, so this is not a proxy-only issue.
- Role display mismatch observed: admin at DB, token shows user; may need app-level refresh.

## Update (2026-01-23)
- Root cause confirmed: fallback-test routes were mounted at root, intercepting `/api/attendance/*` and returning `"Not enabled"`.
- GHCR `metasheet2-backend:latest` (digest `sha256:fdc16b93f6985c01b787d761aa862db1a2093a59df18b6be5372b010675b0ace`) still contains the old mount (no `/internal/test` prefix).
- Applied **temporary hotfix** inside running backend container to scope fallback-test to `/internal/test`, then restarted backend.
- After hotfix, both endpoints now return `200`:
  - `GET /api/attendance/settings` → ok + default settings
  - `GET /api/attendance/summary` → ok + empty summary
- GHCR `metasheet2-backend:latest` updated (digest `sha256:e000261bfab1cdf72e01fea6b39ab7a6e9ea7c6fcb46953e5759dbaa7efaa93c`) and includes the `/internal/test` scope fix.
- Redeployed backend with the updated image; temporary hotfix is no longer required.
- Post-redeploy verification: both attendance endpoints remain `200` with expected payloads.
- UI route check: `GET /attendance` returns `200` (SPA entry loads).
- RBAC mismatch persists: DB `user_roles` shows `admin@metasheet.app` has role `admin`, but `/api/auth/me` returns role `user` with limited permissions.
- Security finding: `/api/auth/me` response includes `password_hash` field; should be removed or redacted.

## Artifacts
- Logs: N/A
- Screenshots: `/tmp/attendance-page.png`
- Test runs: TBD

## Sign-Off
- QA: TBD
- Dev: TBD
- Ops: TBD
