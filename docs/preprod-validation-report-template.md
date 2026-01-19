# Pre-Prod Validation Report (Template)

## Summary
- Date:
- Owner:
- Environment:
- Release tag / commit:
- Scope:
- Status: pending | pass | fail

## Build and Deploy
- Build ID:
- Image or artifact:
- Deploy window:
- Feature flags:
- Migration plan:
- Rollback plan:

## Environment Access
- Web URL:
- API URL:
- Admin URL:
- Observability links:
- Test accounts (roles only, no passwords):
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
- Migration IDs:
- [ ] Schema verification
- [ ] Seed data validation
- [ ] Rollback tested (if applicable)
- Post-migration queries:

### Performance and Monitoring
- P95 response time:
- Error rate:
- Log anomalies:
- Alerts triggered:

### Security and Permissions
- [ ] Role matrix spot checks
- [ ] Audit logging
- [ ] Plugin permission whitelist

### UI and UX
- [ ] Grid save / refresh
- [ ] Attendance UI (if enabled)
- [ ] Mobile layout

### Regression
- Areas covered:
- Areas deferred:

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
- Issues:
- Risks:
- Follow-ups:

## Artifacts
- Logs:
- Screenshots:
- Test runs:

## Sign-Off
- QA:
- Dev:
- Ops:
