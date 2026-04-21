# Audit Follow-up Fixes — Development & Verification Report

Date: 2026-04-20
Parent audit: `docs/operations/monthly-delivery-audit-20260420.md`

## Scope of this session

The audit in PR #944 found 4 feature clusters with wiring gaps. This
session addressed the 2 that were purely mechanical wiring fixes. The
other 2 (Field Validation Panel API design, Yjs frontend integration)
are deferred because they require product decisions, not just plumbing.

### Handled

- PR #946 — Chart / Dashboard V1 router wiring + path + response shape
- PR #947 — Automation test/logs/stats router wiring + shape + lazy
  service resolution

### Explicitly deferred

- Field Validation Panel — needs API design for rule CRUD + UI
  placement decision. Documented as gap in PR #944.
- Yjs frontend integration — product-level decision about changing
  the main edit code path. Separate track.

## What was built

### PR #946: Chart/Dashboard routes

Files touched:
- `packages/core-backend/src/routes/dashboard.ts` — paths changed from
  `/:sheetId/...` to `/sheets/:sheetId/...`; list responses changed
  from `{ items: [...] }` to `{ charts: [...] }` / `{ dashboards: [...] }`
- `packages/core-backend/src/index.ts` — imported and mounted
  `dashboardRouter()` at `/api/multitable`
- `packages/core-backend/tests/unit/dashboard-routes-wiring.test.ts`
  — new supertest-based HTTP integration test (7 cases)

### PR #947: Automation routes

Files touched:
- `packages/core-backend/src/routes/automation.ts` — response shapes
  changed to flat (test, stats) or `{ executions }` (logs); added lazy
  service resolver pattern so routes mount before service init
- `packages/core-backend/src/index.ts` — imported and mounted
  `createAutomationRoutes(() => this.automationService)` at `/api/multitable`
- `packages/core-backend/tests/unit/automation-routes-wiring.test.ts`
  — new supertest-based HTTP integration test (7 cases)

## Independent verification performed

For each fix, the following were verified by the parent agent (not
just reported by a sub-agent):

### Dashboard (PR #946)

1. `grep -rn "dashboardRouter" packages/core-backend/src/` — before fix
   returned only the definition; after fix returns both definition and
   the new `import` in `index.ts`.

2. Supertest-based test confirms:
   - Router IS actually mounted on a real Express app
   - `GET /api/multitable/sheets/:sheetId/charts` returns `{ charts: [] }`
     (not `{ items: [] }`, not 404)
   - `GET /api/multitable/:sheetId/charts` (legacy path, no `sheets/`
     segment) returns 404 — prevents someone "helpfully" bringing back
     the broken path
   - Shape assertions verify `items` key is NOT in response

3. Existing `chart-dashboard.test.ts` service-layer suite continues to
   pass — 49/49.

### Automation (PR #947)

1. `grep -rn "createAutomationRoutes" packages/core-backend/src/` —
   now returns definition + `index.ts` import.

2. Supertest-based test confirms:
   - Router is mounted
   - `GET .../logs` returns `{ executions: [...] }` — NOT the old
     `{ ok, data: { logs } }` envelope
   - Shape assertions verify the old envelope keys (`ok`, `data`,
     `logs`) are absent from the new responses
   - 503 path: when service has not yet initialized
   - Lazy recovery: service goes from undefined → defined, same
     request URL returns 200 (simulates startup sequence)

3. Existing `automation-v1.test.ts` suite unaffected.

## Aggregate test status

After both PRs merged to main:

```
$ vitest run tests/unit/dashboard-routes-wiring.test.ts \
             tests/unit/automation-routes-wiring.test.ts \
             tests/unit/chart-dashboard.test.ts \
             tests/unit/automation-v1.test.ts \
             tests/unit/yjs-poc.test.ts
Test Files  5 passed (5)
     Tests  187 passed (187)
```

No regressions introduced.

## User-visible impact (predicted)

### Before this session

- Clicking the **📊 Dashboard** button in `MultitableWorkbench` loaded
  an empty dashboard UI and silently 404'd on its first fetch
- Clicking **View Logs** on any automation rule showed an empty list
  with no error indication

### After this session

- Dashboard list loads (empty if no dashboards exist, populated if
  `DashboardService` has data)
- Log viewer populates from `AutomationService.logs.getByRule()`
- Both features actually reach the DashboardService / AutomationService
  that already existed but were unreachable

### Needs staging confirmation

The test suite is fully green, but **no real browser click has been
performed after these fixes**. Per the preflight checklist item 1, the
next step is to deploy main to staging and verify:

- "📊 Dashboard" button in a real workbench no longer errors
- "View Logs" button populates with real execution history

Reuse `scripts/ops/yjs-client-validation/yjs-node-client.mjs` as a
template if a similar validation script is wanted for chart/automation.

## What was NOT fixed and why

### Field Validation Panel (audit gap #3)

The frontend component exists but:
- No backend API surface to GET or SET validation rules per field
- No integration point in the field editor UI (`MetaFieldManager`)

Fixing this is NOT a wiring patch — it is a small feature:
- Decide API contract (PATCH `/fields/:fieldId` extension vs new
  endpoint `PATCH /fields/:fieldId/validation`)
- Decide UI placement (panel inside field settings dialog vs standalone)
- Tests + staging verification

Estimated scope: 1 day including review cycle. Should get its own PR
with its own design check.

### Yjs frontend integration (audit gap #4)

Wiring `useYjsDocument` / `useYjsTextField` into the actual text cell
editor would change the primary editing code path for every user. Even
behind the `ENABLE_YJS_COLLAB` flag, the integration surface is
significant (grid editor modifications, focus/blur behaviour, diff
handling). This is a feature commitment, not a gap close.

Recommended: separate track, explicit product sign-off, full rollout
staging run before any widening.

## Outcome

The two user-visible 404s surfaced by the audit are closed. The 2 gaps
that needed design work are explicitly left to separate tracks. The
new HTTP-level wiring tests would have caught the original bugs — they
are the pattern the preflight checklist is asking for when it says
"end-to-end real run" in item 1.

## Artifacts

- PR #946 — dashboard wiring (merged)
- PR #947 — automation wiring (merged)
- Parent audit: PR #944 (merged)
- Checklist this audit applied: `docs/operations/poc-preflight-checklist.md`
- Session summary: this file
