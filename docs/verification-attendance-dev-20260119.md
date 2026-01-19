# Attendance Dev Verification (2026-01-19)

## Summary
- Environment: local dev
- Web: http://localhost:8899
- API: http://localhost:7778
- Plugin status: `plugin-attendance` active
- Result: partial (API + UI smoke + grid save + WebSocket handshake + UI request flow + mobile check + admin scheduling/export + auth register/login/verify/me + grid RBAC fix verified; admin UI delete pending; logout endpoint not implemented)

## Setup
```sh
pnpm --filter @metasheet/core-backend migrate
RBAC_BYPASS=true RBAC_TOKEN_TRUST=true PORT=7778 JWT_SECRET=dev-secret-key pnpm --filter @metasheet/core-backend dev
pnpm dev
```

## Auth
- Dev token from `GET /api/auth/dev-token`
- Test accounts created via `POST /api/auth/register`: `attn-login3@example.com`, `attn-login4@example.com`, `attn-ui-verify-1768822476@example.com` (passwords redacted)
- Attendance permissions granted via `user_permissions` for `attn-ui-verify-1768822476@example.com` to validate attendance UI
- Roles/permissions: dev token has admin + attendance/spreadsheets; registered users default to `role=user` with spreadsheet permissions

## API Smoke Results
| Endpoint | Status |
| --- | --- |
| `POST /api/auth/register` | 201 |
| `POST /api/auth/login` | 200 |
| `GET /api/auth/verify` | 200 |
| `GET /api/auth/me` | 200 |
| `GET /api/attendance/rules/default` | 200 |
| `PUT /api/attendance/rules/default` | 200 |
| `POST /api/attendance/punch` | 200 |
| `GET /api/attendance/records` | 200 (records_count=1) |
| `GET /api/attendance/summary` | 200 (total_days=1) |
| `POST /api/attendance/requests` | 201 |
| `POST /api/attendance/requests/:id/approve` | 200 |
| `GET /api/attendance/settings` | 200 |
| `PUT /api/attendance/settings` | 200 |
| `GET /api/attendance/shifts` | 200 |
| `POST /api/attendance/shifts` | 201 |
| `GET /api/attendance/holidays` | 200 |
| `POST /api/attendance/assignments` | 201 |
| `DELETE /api/attendance/assignments/:id` | 200 |
| `POST /api/attendance/holidays` | 201 |
| `DELETE /api/attendance/holidays/:id` | 200 |
| `GET /api/attendance/export` | 200 (CSV) |

## UI Smoke
- `/grid` loaded with toolbar + grid cells visible.
- `/attendance` loaded with summary, calendar, adjustment form, and admin console.
- Navigation links present; plugin view visible.

## Additional Validation
- Grid cell edit persisted: updated A1 to `E2E-UI-2` via UI, verified via `GET /api/spreadsheets/:id/sheets/:id/cells`.
- WebSocket handshake: `GET /socket.io/?EIO=4&transport=polling` returned 200 with websocket upgrade advertised.
- Attendance request flow: submitted adjustment request in UI and approved it; request status updated to approved and records table reflected times.
- Mobile layout check: `/attendance` and `/grid` verified at 390x844 without layout breakage.
- Admin scheduling (API): created/deleted shifts, created/deleted assignments, created/deleted holidays.
- Export (API): CSV export returned header + row when `userId` filter supplied.
- Auth: register/login succeeded for test accounts; verify/me returned 200; logout is client-side token clear.
- Grid RBAC: normal user token created spreadsheet (201), loaded cells (200), and deleted spreadsheet (200) without 401/403.
- Attendance UI: `/attendance` endpoints returned 200 after granting attendance permissions to the test user (no 401/403 in console).
- Admin scheduling (UI): delete confirmed for shifts (confirmation dialog + row removed); holiday create/delete confirmed; assignment delete still not confirmed due to MCP automation timeouts.

## Findings
- Attendance plugin RBAC checks require `RBAC_BYPASS=true` for dev tokens unless permissions are seeded in DB.
- Attendance UI requires `user_permissions` (or admin role) for the viewing user; otherwise API calls return 403.
- RBAC now falls back to `users.permissions` for legacy user permissions in addition to RBAC tables.
- CSV export returns header-only when no `userId` filter matches records.
- Login flow requires `users` table in DB; migration now added so register/login works.
- Logout endpoint not implemented; UI should clear JWT locally.
- Admin UI delete: shifts + holidays confirmed; assignment delete still needs manual verification due to MCP automation timeouts.

## Follow-ups
- Validate admin UI delete flow for assignments.
- Verify login UI flow (if exposed) and document logout UX (token clear).
