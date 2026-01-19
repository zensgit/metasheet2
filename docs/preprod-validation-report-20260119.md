# Pre-Prod Validation Report

## Summary
- Date: 2026-01-19
- Owner: TBD
- Environment: pre-prod (TBD)
- Release tag / commit: TBD
- Scope: TBD
- Status: pending

## Build and Deploy
- Build ID: TBD
- Image or artifact: TBD
- Deploy window: TBD
- Feature flags: TBD
- Migration plan: TBD
- Rollback plan: TBD

## Environment Access
- Web URL: TBD
- API URL: TBD
- Admin URL: TBD
- Observability links: TBD
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
