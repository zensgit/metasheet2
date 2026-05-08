# E2E Tests

Browser-level regression tests for federated PLM user journeys.

## Prerequisites

These tests require **three servers running externally**:

1. **Yuantus** on `http://127.0.0.1:7910`
2. **Metasheet backend** on `http://localhost:7778`
3. **Metasheet frontend** on `http://127.0.0.1:8899`

Tests auto-skip if any server is unreachable.

## Quick start

```bash
# Terminal 1: Yuantus
cd /path/to/Yuantus
./.venv/bin/uvicorn yuantus.api.app:create_app --factory --host 127.0.0.1 --port 7910

# Terminal 2: Metasheet backend
cd /path/to/metasheet2/packages/core-backend
PLM_BASE_URL=http://127.0.0.1:7910 PLM_API_MODE=yuantus PLM_TENANT_ID=tenant-1 \
  PLM_ORG_ID=org-1 PLM_USERNAME=phase0-test PLM_PASSWORD=phase0pass PLM_ITEM_TYPE=Part \
  npx tsx src/index.ts

# Terminal 3: Metasheet frontend
cd /path/to/metasheet2/apps/web
npx vite --host 127.0.0.1 --port 8899

# Terminal 4: Run E2E
cd /path/to/metasheet2/packages/core-backend
npx playwright test --config tests/e2e/playwright.config.ts
```

## Test data

Tests use the B demo object:

- Part `b5ecee24-5ce8-4b59-9551-446e1c50b608` (Doc UI Product)
- Has 1 file attachment + 1 AML related document (Doc UI Doc)
- Has 1 ECO (DOCUI-ECO-1768357216, state=progress)

Metasheet user: `phase0@test.local` / `Phase0Test!2026` (role=admin)

## What's tested

- `handoff-journey.spec.ts`: source product → documents → open AML doc → return → roundtrip
- `multitable-lifecycle-smoke.spec.ts`: create base → sheet → field → view → record (REST), then assert workbench frontend renders the value; also includes an autoNumber raw-write rejection regression guard. Closes the `Smoke test basic multitable sheet lifecycle` RC TODO item. Yuantus/PLM is NOT required.
- `multitable-public-form-smoke.spec.ts`: admin sets up a sheet + grid view, enables `accessMode: 'public'` form sharing via `PATCH /sheets/:sheetId/views/:viewId/form-share`, then an anonymous (unauthenticated) request submits a record through `POST /views/:viewId/submit` using the issued `publicToken`. Admin verifies the record is queryable via `GET /records?sheetId=…`. Includes two regression guards: anonymous submit on a view with form-share disabled returns 401, and anonymous submit using a token rotated by `POST /form-share/regenerate` returns 401. Closes the `Smoke test public form submit path` RC TODO item. Yuantus/PLM is NOT required.
- `multitable-hierarchy-smoke.spec.ts`: admin sets up a sheet with a Title (string) field, a self-table single-value link `Parent` field, and a hierarchy view configured to use the parent link. Creates a parent record + child record with the parent link, then asserts the workbench renders both names. Two regression guards exercise the server-side hierarchy cycle guard via PATCH (`assertNoHierarchyParentCycle`): a record cannot set itself as its own parent, and a record cannot set a descendant as its parent. Both rejections expect HTTP 400 + `error.code === 'HIERARCHY_CYCLE'`. Closes the `Smoke test Hierarchy view rendering and child creation` RC TODO item. Yuantus/PLM is NOT required.
- `multitable-gantt-smoke.spec.ts`: admin sets up a sheet with Title (string) + Start (date) + End (date) fields and configures a gantt view pointing at those fields. Creates two records spanning date ranges and asserts the workbench renders `.meta-gantt__bar` elements with both task labels visible. A second case adds a self-table single-value link `Predecessor` field and a gantt view with `dependencyFieldId` configured, creates A then B linking back to A, and asserts a `.meta-gantt__dependency-arrow` renders. A regression guard exercises `validateGanttDependencyConfig` at the HTTP layer (`PATCH /views/:viewId` with a non-link `dependencyFieldId` → 400 + `VALIDATION_ERROR` containing `self-table link field`). Closes the `Smoke test Gantt view rendering` RC TODO item. Yuantus/PLM is NOT required.
