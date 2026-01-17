# PR: fix(core-backend): stabilize integration suite (feat/plm-updates)

## Summary
- Stabilize core-backend integration tests across plugin loading, auth/audit, snapshots, and spreadsheet flows.
- Normalize protection rule conditions and add snapshot expiry updates.
- Align WebSocket and plugin APIs to tolerate current test fixtures and localized display names.

## Why
- Integration tests were failing in multiple areas (plugin loading, auth/audit IDs, snapshot protection, spreadsheet routes), blocking development and CI confidence.

## Changes
- Plugin loader: stricter permission/engine validation, consistent failure tracking, and fallback discovery behavior.
- Auth/audit: prevent NaN user IDs, align audit log insert shape, and stabilize test env flags.
- Snapshot protection: normalize condition payloads, add snapshot expiry update helper, and keep tests consistent.
- WebSocket/Core API: preserve backward compatibility for room joins and broadcast helpers.
- Tests: adjust kanban expectations for localized display names and align test routes/events.
- Dev deps: add `supertest`, `socket.io-client`, `@types/supertest` for integration tests.

## Verification
- `DATABASE_URL=postgres://metasheet:metasheet@localhost:5435/metasheet_integration_verify pnpm --filter @metasheet/core-backend test:integration`
  - Result: 63 passed, 1 skipped

## Notes
- Workflow engine init noise avoided in tests by setting `DISABLE_WORKFLOW=true` in test setup.
- No frontend changes.
- No new migrations; rollback is revert of this PR.

## References
- Issue/Phase: N/A
- Screenshots: N/A
