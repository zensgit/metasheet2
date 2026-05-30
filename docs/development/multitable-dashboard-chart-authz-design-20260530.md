# F0b — dashboard/chart endpoint authorization + chart-data field mask · design-lock

**Date:** 2026-05-30
**Design-lock:** successor to F0a (#2114) in the #2106 record-egress inventory (§3 F0b).
**Status:** DESIGN-LOCK ONLY — no runtime change. Impl is a **separate, explicit opt-in** after this merges.
**Anchored to:** `origin/main` (the `dashboardRouter` in `packages/core-backend/src/routes/dashboard.ts` + `multitable/dashboard-service.ts` + `multitable/chart-aggregation-service.ts`).

---

## 0. The hole (current state — code-verified)

`dashboardRouter()` mounts **11 endpoints** at `/api/multitable`, each gated **only** by the global JWT middleware (`index.ts:895` → 401 anon) plus a `chart.sheetId === req.params.sheetId` / `dashboard.sheetId === …` **404 match**. **None** call `resolveSheetReadableCapabilities` / `canRead` / `canManageViews` / a field mask. `createdBy` is recorded on create (`getUserId(req)`) but **never enforced**. So **any authenticated user can read and manage any sheet's charts/dashboards by `sheetId`** — list/read configs, and create/update/delete — with no per-sheet authorization. This is the same broken-access-control class as F0a (#2114), one severity tier above the field-mask gaps.

### Two distinct leak surfaces — keep them separate

1. **Authorization (REAL, current).** Cross-sheet read of chart/dashboard **configs** (list + get) and **manage** (create/update/delete) with no `canRead`/`canManageViews`. This is the headline. **Verified the config-read path returns real data cross-sheet** (it does *not* go through the inert provider): `listCharts`/`getChart`/`listDashboards` query the config tables directly — e.g. `db.selectFrom('multitable_charts').selectAll().where('sheet_id','=',sheetId)` — with no auth and no provider. So any authenticated user gets another sheet's chart/dashboard configs verbatim.
2. **Chart-data field *value* leak (LATENT, inert today).** `getChartData` (`dashboard-service.ts:234`) loads records **only** via an injected `recordProvider`, and **`setRecordProvider` is never called in production** (the only callers are `tests/unit/chart-dashboard.test.ts`). So in production `getChartData` aggregates over `records = []` → empty/zero series; **no record field values reach the wire today.** `computeChartData` *would* leak: a group `label` is `record.data[groupByFieldId]` **verbatim** (`chart-aggregation-service.ts:209-213`), and the measure is `record.data[aggregation.fieldId]`. So the value leak is a **forward risk** that activates the moment a real record provider is wired. F0b specifies the field mask so the gate already exists when that happens — but the doc must not claim a live value leak.

---

## 1. Endpoint inventory & required gate

| Endpoint | Method | Today | Required gate |
|---|---|---|---|
| `/sheets/:sheetId/charts` | GET (list) | none | **canRead** |
| `/sheets/:sheetId/charts` | POST (create) | none | **canManageViews** |
| `/sheets/:sheetId/charts/:id` | GET | sheetId-match 404 | **canRead** (+ keep 404) |
| `/sheets/:sheetId/charts/:id` | PATCH | sheetId-match 404 | **canManageViews** |
| `/sheets/:sheetId/charts/:id` | DELETE | sheetId-match 404 | **canManageViews** |
| `/sheets/:sheetId/charts/:id/data` | GET | sheetId-match 404 | **canRead + chart-data field mask** |
| `/sheets/:sheetId/dashboards` | GET (list) | none | **canRead** |
| `/sheets/:sheetId/dashboards` | POST (create) | none | **canManageViews** |
| `/sheets/:sheetId/dashboards/:id` | GET | sheetId-match 404 | **canRead** |
| `/sheets/:sheetId/dashboards/:id` | PATCH | sheetId-match 404 | **canManageViews** |
| `/sheets/:sheetId/dashboards/:id` | DELETE | sheetId-match 404 | **canManageViews** |

---

## 2. Auth model

- **Read (`canRead`)** — list/get charts + dashboards, and chart-data. Reading a sheet's config artifacts requires reading the sheet. `resolveSheetReadableCapabilities(req, query, req.params.sheetId)` → `if (!access.userId) 401` → `if (!capabilities.canRead) 403`, **before** the chart/dashboard lookup (so a non-reader can't distinguish missing from no-access — anti-oracle, same as F0a).
- **Manage (`canManageViews`)** — create/update/delete charts + dashboards. Charts and dashboards are **the same class of configuration artifact as views**, and `canManageViews` already governs view configure/delete (`permission-derivation.ts:108-109/117-118`). **Reuse it — do NOT invent `canManageDashboard`** (a new capability touches the capability model / central RBAC = K3 Stage-1 lock). 
- **Ownership (`createdBy`) — deferred, explicitly out of v1.** `createdBy` is recorded but is **not** a management grant here; manage is `canManageViews` uniformly. Owner-can-manage-own-chart is a separate product decision (would need a creator-vs-manager precedence rule) — noted, not built.
- The existing `chart.sheetId === params.sheetId` **404 match stays** (a routing guard against id/sheet mismatch), running **after** the `canRead`/`canManageViews` gate.

## 3. Chart-data field mask (forward-defense; inert today)

`GET /sheets/:sheetId/charts/:id/data`: after `canRead`, resolve the viewer's `allowedFieldIds` (layer-2 ∧ layer-3 composite — the #2015/#1840 pattern), then check the fields the chart references — **`dataSource.aggregation.fieldId`, `dataSource.groupByFieldId`, `dataSource.dateFieldId`, `dataSource.filterFieldId`** — against it.

- **Parity with #1840 view-aggregate**, which gates `canRead` then **omits** denied/view-hidden-field aggregates (it does **not** 403 the request, and it does **not** apply record-level permissions — it `SELECT … FROM meta_records WHERE sheet_id` over all rows; record-read is a golden non-gate). **F0b matches: field-level omit, no record-perm in aggregation.**
- **Withhold contract (PINNED).** `canRead` is still required (else 403). If `canRead` holds but **any** referenced `dataSource` field ∉ `allowedFieldIds`, the endpoint returns the `ChartData` shape with **withheld values**, not the aggregation and not a 403:
  ```jsonc
  { "chartId": "...", "chartType": "...", "dataPoints": [], "total": 0,
    "metadata": { "restricted": true, "recordCount": 0 } }
  ```
  `metadata.restricted: true` is an explicit flag so the client renders "restricted by permissions", not "no data". (A new optional `restricted?: boolean` on `ChartData.metadata`.)
- **Today this branch is unreachable in practice** (provider unwired → records empty → series already empty), so it is **forward-defense**: it lands with the authz so the gate exists before any real record provider is wired. The verification doc and tests must state this — the mask is not closing a live value leak.
- **Impl sequencing constraint (for the F0b impl opt-in):** wiring a real `recordProvider` is itself what *activates* this value channel. So the withhold mask MUST land in the **same** PR as any provider wiring — **never a PR earlier, never later**. If the impl slice does not wire a provider (keeps charts data-empty), the mask still lands (cheap, future-proofs), but no provider may be wired in a separate unmasked PR.

## 4. Implementation notes (for the impl slice)

- **Route-level mask, not service-level.** `dashboardService` is a module singleton (`new DashboardService()` at load); its `recordProvider` is global, so per-viewer masking **cannot** live in the service. The route resolves `canRead` + `allowedFieldIds` and applies the withhold check around `getChartData` (read `chart.dataSource` field refs; if any denied → return the withheld shape without calling `getChartData`).
- **Wiring.** `dashboard.ts` currently imports only `DashboardService`. The impl needs `poolManager` + `resolveSheetReadableCapabilities`/`resolveSheetCapabilities` + the `deriveFieldPermissions`/`loadFieldPermissionScopeMap` composite (or a shared `loadAllowedFieldIds` helper) — same imports F0a used in `univer-meta.ts`.
- **No cache** on this path (unlike F0a — `getChartData` has none), so no cache-poisoning dimension.
- **`getUserId` `x-user-id` fallback** (`dashboard.ts:41`) is moot under the global JWT gate (req.user is authoritative); leave it, but capabilities/identity for the gate come from `resolveSheet*`, not `getUserId`.

## 5. Fail-first matrix (real DB; impl slice)

| # | Scenario | Pre-fix (origin/main) | Post-fix |
|---|---|---|---|
| R1 | non-reader → `GET …/charts` (list) | 200 + configs | **403** |
| R2 | non-reader → `GET …/charts/:id` (config) | 200 + config | **403** |
| R3 | non-reader → `GET …/charts/:id/data` | 200 (empty data) | **403** |
| R4 | reader-not-manager → `POST/PATCH/DELETE …/charts` | 201/200/204 | **403** |
| R5 | non-reader → dashboards list/get/manage | 200 / 2xx | **403** / **403** |
| R6 | **positive** reader → list/get/data | 200 | 200 |
| R7 | **positive** manager (canManageViews) → create/edit/delete | 2xx | 2xx |
| R8 | **field mask (forward)** — inject a record provider (as `chart-dashboard.test.ts` does), chart groupBy = a layer-3-denied field whose values carry a **canary** → `GET …/charts/:id/data` | the denied value appears as a group `label` on the wire | **canary absent from the whole response body** + `metadata.restricted: true` |

- R1–R5/R7 are **real authz RED on origin/main** (no gate today). R6 positive control.
- **R8 is the forward-defense test**: because the production provider is unwired, R8 must **inject a record provider** (mirroring `chart-dashboard.test.ts`) to make the value channel exist, then assert the mask withholds it **by the denied value's absence** — `expect(JSON.stringify(body)).not.toContain(canary)`, **NOT** `dataPoints.length === 0` (a legitimately-empty chart also has `[]`, so a length assertion false-passes). The verification doc must label R8 as forward-defense, not a live-leak RED.
- Anti-oracle: a non-reader gets **403 before** the chart/dashboard lookup, so missing-vs-no-access is indistinguishable (parity with F0a T8).

## 6. Sequencing

1. **This design-lock** → docs-only PR.
2. **F0b impl** (separate opt-in) — canRead + canManageViews gates on all 11 endpoints + the chart-data withhold mask + R1–R8 real-DB fail-first. One PR.
3. **Then F1** (record history snapshot/patch mask) — the broadest remaining *field* leak once the no-authz surfaces (F0a, F0b) are closed.

## 7. Scope guard

- Design-lock only. Impl adds authorization to the **dashboard module endpoints only**, reusing the **existing** `canRead` / `canManageViews` capabilities and the `field_permissions` composite — **no new capability, no `canManageDashboard`, no central RBAC/auth** (K3 Stage-1 lock).
- The chart-data field mask is forward-defense for a latent channel (provider unwired); it is specified now so it lands with the authz, but it is **not** closing a currently-exploitable value leak — the verification must say so.
