# Attendance Dev Verification (2026-01-19)

## Summary
- Environment: local dev
- Web: http://localhost:8899
- API: http://localhost:7778
- Plugin status: `plugin-attendance` active
- Result: pass (API + UI smoke)

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

## Findings
- Attendance plugin RBAC checks require `RBAC_BYPASS=true` for dev tokens unless permissions are seeded in DB.

## Follow-ups
- Validate grid save via UI interaction.
- Validate WebSocket updates.
- Run end-to-end attendance request workflows in UI.
