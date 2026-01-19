# Pre-Prod Validation Report

## Summary
- Date: 2026-01-19
- Owner: TBD
- Environment: dev (local)
- Release tag / commit: a50fe9df (main)
- Scope: dev validation for grid/spreadsheets + attendance plugin (optional)
- Status: pending

## Build and Deploy
- Build ID: N/A (local dev)
- Image or artifact: N/A (local dev)
- Deploy window: N/A (local dev)
- Feature flags: None detected in local env files (confirm runtime overrides)
- Migration plan: run `pnpm --filter @metasheet/core-backend migrate` with `DATABASE_URL`
- Rollback plan: reset dev DB (drop + re-migrate) if needed

## Environment Access
- Web URL: http://localhost:8899 (default `VITE_PORT`, confirm)
- API URL: http://127.0.0.1:7778 (from `.env.local` `VITE_API_URL`)
- Admin URL: http://127.0.0.1:7778/api/admin (if admin served on same origin); backend `PORT=8900` in `packages/core-backend/.env`
- Observability links: N/A (dev)
- Test accounts (roles only, no passwords): TBD
- Secrets note: do not paste secrets, use <redacted>

## Pre-Checks
- [ ] Config diff reviewed
- [ ] Backups verified
- [ ] Monitoring and alerts enabled
- [ ] Rollback steps confirmed
- [ ] Data migration dry-run completed (if applicable)

## Validation Checklist
### Smoke
- [ ] Login / logout
- [ ] Navigation and routing
- [ ] Core workflows (list)
- [ ] Plugin loading
- [ ] Error reporting / toast

### API
- [ ] Auth endpoints
- [ ] Spreadsheets endpoints
- [ ] Attendance endpoints (if enabled)
- [ ] WebSocket connection
- [ ] OpenAPI / SDK compatibility

### Data and Migrations
- Migration IDs: TBD
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
- Areas covered: TBD
- Areas deferred: TBD

## Commands Executed
```sh
# Example
pnpm lint
pnpm type-check
pnpm test
pnpm --filter @metasheet/core-backend test:integration
pnpm --filter @metasheet/web exec vitest run --watch=false
```

## Findings
- Issues: TBD
- Risks: TBD
- Follow-ups: TBD

## Artifacts
- Logs: TBD
- Screenshots: TBD
- Test runs: TBD

## Sign-Off
- QA: TBD
- Dev: TBD
- Ops: TBD
