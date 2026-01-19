# Attendance Dev Verification (2026-01-19)

## Summary
- Environment: local dev
- Web: http://localhost:8899
- API: http://localhost:7778
- Plugin status: `plugin-attendance` active
- Result: pass (API + UI smoke + grid save + WebSocket handshake + UI request flow + mobile check)

## Setup
```sh
pnpm --filter @metasheet/core-backend migrate
RBAC_BYPASS=true RBAC_TOKEN_TRUST=true PORT=7778 JWT_SECRET=dev-secret-key pnpm --filter @metasheet/core-backend dev
pnpm dev
```

## Auth
- Dev token from `GET /api/auth/dev-token`
- Roles/permissions: admin + attendance/spreadsheets

## API Smoke Results
| Endpoint | Status |
| --- | --- |
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

## UI Smoke
- `/grid` loaded with toolbar + grid cells visible.
- `/attendance` loaded with summary, calendar, adjustment form, and admin console.
- Navigation links present; plugin view visible.

## Additional Validation
- Grid cell edit persisted: updated A1 to `E2E-UI-2` via UI, verified via `GET /api/spreadsheets/:id/sheets/:id/cells`.
- WebSocket handshake: `GET /socket.io/?EIO=4&transport=polling` returned 200 with websocket upgrade advertised.
- Attendance request flow: submitted adjustment request in UI and approved it; request status updated to approved and records table reflected times.
- Mobile layout check: `/attendance` and `/grid` verified at 390x844 without layout breakage.

## Findings
- Attendance plugin RBAC checks require `RBAC_BYPASS=true` for dev tokens unless permissions are seeded in DB.

## Follow-ups
- Validate attendance export + admin settings edits (settings/rules/shifts/assignments/holidays).
- Run login/logout flows with real auth.
