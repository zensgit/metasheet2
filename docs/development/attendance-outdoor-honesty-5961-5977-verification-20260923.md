# Outdoor approval / photo honesty — verification (#5961, #5977)

Date: 2026-09-23. Design: `attendance-outdoor-honesty-5961-5977-design-20260923.md`.

## What was checked

- `requireApproval: true` with an empty `approvalFlowId` and 0 active `outdoor_punch` flows: settings PUT returns `422 OUTDOOR_APPROVAL_FLOW_REQUIRED` and does not change the stored flag. Same for a missing explicit flow id.
- `requireApproval: false` still saves with zero flows.
- Empty id plus exactly one active flow saves. An explicit active `outdoor_punch` id saves even when a second active flow exists. Empty id plus two active flows is refused on save.
- After a valid save, deleting the only flow (or adding a second flow while the id is empty) still makes the punch return `422 OUTDOOR_APPROVAL_FLOW_REQUIRED` and write nothing.
- A settings write that does not include `punchPolicy.outdoor` still preserves a resolvable outdoor policy (existing sibling round-trip).
- `GET /api/attendance/rules/me` includes `punchPolicy.outdoorPhotoRequired` and does not echo the flow id.
- Web admin card refuses save when the loaded active list cannot resolve approval, and still PUTs when it can. Turning approval off still PUTs.
- Web punch classifies `OUTDOOR_PHOTO_REQUIRED` / `OUTDOOR_PHOTO_INVALID`, uploads via `POST /api/files/upload`, and retries with `photoFileId` plus the note already entered. No `location` and no `meta.outdoor`.

## Commands

Local Postgres (`postgres://127.0.0.1:5432/metasheet`) after `pnpm --filter @metasheet/core-backend migrate`.

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/outdoor-approval-flow-save.test.ts` — 5 passed
- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendance-outdoor-approval-save.spec.ts tests/attendance-punch-outcome.spec.ts` — 34 passed
- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendance-admin-regressions.spec.ts -t "outdoor|disabling requireApproval"` — outdoor save cases and the approval-off save passed
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-outdoor-punch.test.ts` — 29 passed
- same runner, `attendance-plugin.test.ts -t "attendance rules /me"` — passed
- same runner, `attendance-w4c3b-request-operation-routes.db.test.ts -t "P13 create families: outdoor"` — passed
- same runner, `attendance-files-acl.test.ts -t "S2 regression"` — passed

Removing the `refuseOutdoorApprovalFlowSave` call from `PUT /api/attendance/settings` turns the outdoor-punch cases “refused on save” red (they expect HTTP 422 and an unchanged flag). The pure unit test fails if 0 or >1 empty-id cases return null.

## Not checked in a browser

The employee and admin flows were exercised on the real Vue components in Vitest (click, file input, upload body, punch JSON). A logged-in browser session against the dev servers was not run.

## Open points

- Attendance settings are one global document. The new check uses `getOrgId(req)`, the same helper that creates approval flows and that an unscoped punch falls back to. A punch that names a different org still resolves flows in that org. The web outdoor card does not send `orgId`.
- Web still does not collect geolocation or send `meta.outdoor`. The photo control appears when the punch is already an outdoor candidate and the server returns `OUTDOOR_PHOTO_REQUIRED` (for example a configured geofence and no coordinates). `outdoorPhotoRequired` on `rules/me` is the advance notice.
- A settings write that omits `punchPolicy.outdoor` does not re-check a previously stored dead approval policy, so other cards keep saving. Punch remains fail-closed until an admin saves the outdoor card into a resolvable state or turns approval off.
