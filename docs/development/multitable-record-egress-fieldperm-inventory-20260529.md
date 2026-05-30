# Multitable record-data egress — field-permission inventory & design-lock (#3)

**Date:** 2026-05-29
**Slice:** Backlog item #3 — "other layer-2-only read sites" → **read-only inventory + design-lock** (no code, no behavior change in this slice).
**Anchored to:** `origin/main` @ `5d6e5dd75` (verified — see Methodology; an earlier pass against a 255-commit-stale canonical checkout was discarded).
**Status:** DESIGN-LOCK ONLY. Each fix below is a **separate, explicit, gated opt-in**. This document does **not** authorize any change.

---

## 0. Why this slice exists

The field-read gate arc (#2015/#2028 read mask, #1840 view-aggregate, #2044 selection, #2059 filter-literal echo, #2074 re-save guard, #2084 UX) hardened the **grid read** and **view-config** surfaces. The standing question was whether the "data-safety floor" actually covers **every** path that egresses record cell values. This inventory enumerates all such egress sites and classifies each against the 3-layer field model:

- **layer-1** — `view.hidden_field_ids` (display-only; not a server data gate).
- **layer-2** — `field.property.hidden` (static; `isFieldPermissionHidden(field)` / `filterVisiblePropertyFields`).
- **layer-3** — `field_permissions.visible` (subject-scoped; **the real read gate**), composed via `deriveFieldPermissions(fields, caps, { hiddenFieldIds, fieldScopeMap }).visible !== false` → `allowedFieldIds`.

The canonical safe pattern (GET /view @6586, GET /records/:recordId @7626, view-aggregate @6266) is: resolve subject → `loadFieldPermissionScopeMap` → `allowedFieldIds` (layer-2 ∧ layer-3) → `filterRecordDataByFieldIds(data, allowedFieldIds)`, plus sheet `canRead` and record-permission filtering.

---

## 1. Methodology & honesty notes

- **Stale-checkout catch.** The canonical checkout (`codex/attendance-uuid-validation-20260526`) is **255 commits behind** `origin/main` and predates the entire arc. The first inventory pass read pre-#2028 code (e.g. GET /view masking by `visiblePropertyFieldIds`) and was **invalid**; redone in a fresh worktree off `origin/main` `5d6e5dd75`. All line numbers below are that tree.
- **Auth model (verified, `index.ts:888-896`):** `isWhitelisted(path)` → `next()`; `isPublicFormAuthBypass(req)` → `optionalJwtAuthMiddleware`; else `/api/*` → `jwtAuthMiddleware`, which **hard-rejects** (401) on missing/invalid token (`auth/jwt-middleware.ts:152-170`). So every `/api/multitable/*` route requires a valid JWT **unless** whitelisted or a public-form path. "Unauthenticated" is therefore **wrong** for these routes; the correct failure mode for the findings below is **broken authorization**, not missing authentication.
- **Scan extent.** Fully traced: `univer-meta.ts` (all record/value egress), `dashboard.ts` + `chart-aggregation-service.ts`, `record-history-service.ts`, `record-write-service.ts`, `query-service.ts` (cursor query), the global auth chain, OpenAPI `paths/multitable.yml`, and the frontend API client. **Deferred to a dedicated follow-up scan (NOT claimed clean here), highest-value first:** (1) **kanban** (`/api/kanban`, `kanban.ts:114` returns `res.json({ data: payload })` — a record-data *view* endpoint, the class most likely to repeat the no-mask pattern); (2) gallery/calendar view-data plugins; (3) `createAutomationRoutes` (automation test/logs). These mount at `/api/multitable` (or `/api/kanban`) and may carry their own record-data paths; this inventory did not exhaustively trace them. Snapshots (`/api/snapshots`) are `rbacGuard`-gated whole-snapshot artifacts (separate object model) — out of field-mask scope.

---

## 2. Egress map (origin/main `5d6e5dd75`)

| # | Endpoint | Site | Mask applied | Layer-3? | Verdict |
|---|---|---|---|---|---|
| — | `GET /view` (grid) | univer-meta @6586 | `allowedFieldIds` | ✅ | SAFE (#2028) |
| — | `GET /records/:recordId` (single) | @7626 | `allowedFieldIds` | ✅ | SAFE (#2028) |
| — | `GET /sheets/:id/view-aggregate` | @6266 | `allowedIds` | ✅ | SAFE (#1840) |
| — | `POST /dashboard/query` | @4741→2463 | `visibleFields` = L2 ∧ L3 | ✅ | SAFE |
| **F0a** | **`GET /records`** (cursor list) | @7489 | **none** | ❌ | **HOLE — no authz at all** |
| **F0b** | **`GET .../charts`, `/charts/:id/data`, `/dashboards`** | dashboard.ts @53-125 | **none** | ❌ | **HOLE — no per-sheet authz** |
| **F1** | **`GET /sheets/:id/records/:rid/history`** | @4297 | **none** (snapshot+patch) | ❌ | **HOLE — bypasses even L2** |
| **F2** | **`GET /records-summary`** | @7708 | **none** (`displayFieldId`) | ❌ | **HOLE — arbitrary field** |
| **F3** | **`PATCH /records/:recordId`** echo | @7404 | `visiblePropertyFieldIds` | ❌ L2-only | **HOLE — write echo** |
| **F3** | **`POST /patch`** echo | @8386/8344 | `visiblePropertyFieldIds` | ❌ L2-only | **HOLE — write echo** |
| **F4** | **`POST /records`** create echo | @8155 | **none** (`result.data`) | ❌ | **HOLE — write echo (low)** |
| **F5** | `GET /fields/:id/link-options` | @7758 | none (primary field) | ❌ | candidate (low) |
| **F5** | `POST /person-fields/prepare` | @4866 | none (summary) | ❌ | candidate (low) |
| **D1** | `GET /form-context` prefill | @6792 | `visibleFields` = L1+L2 | ❌ | design Q (anon) |
| **D1** | `POST /views/:id/submit` echo | @7196 | `visibleFormFields` = L1+L2 | ❌ | design Q (anon) |

---

## 3. Findings, by severity

### F0a — `GET /records` (cursor list): authenticated, **no authorization** · HIGH
`router.get('/records')` (@7489-7551) validates `sheetId`, queries `queryRecordsWithCursor`, and returns `records: items.map(r => ({ id, version, data: r.data }))`. The handler contains **0 references** to `resolveSheetReadableCapabilities` / `canRead` / record-permissions / `allowedFieldIds` / tenant. The cursor SQL filters by `sheet_id` only (no tenant). Net: **any authenticated user can read any sheet's full record data — every field, every row — by passing its `sheetId`,** bypassing sheet-read permission, record permissions, and field permissions.
- **Reachability:** Production mount `/api/multitable/records`; valid JWT required (global gate → 401 anon). In OpenAPI (`security: bearerAuth`) → sanctioned endpoint, missing-authz = impl bug.
- **Blast radius (tenant scoping — verified):** `queryRecordsWithCursor` (`query-service.ts:314`) builds `WHERE sheet_id = $1` with **no tenant clause**; `meta_records`/`meta_sheets` carry **no `tenant_id` column**; `tenantContext` (`index.ts:903`) feeds `db/sharding/*` (shard/message routing) **not** the multitable record SQL; `poolManager.get()` is not RLS/`search_path` tenant-scoped. So **intra-database horizontal read is certain** (any authenticated user reads any sheet in the same DB/shard by `sheetId`). **Cross-tenant** therefore holds in a **shared-database** deployment, but **may be blocked by per-tenant shard routing** if tenants are sharded to separate pools — deployment-topology dependent, not asserted as universal.
- **Exploitability:** IDOR on `sheetId` (UUID; not guessable, but any shared/leaked/referer-exposed id suffices). **Not used by the frontend grid** (which uses gated `GET /view`); the only frontend `/records` caller is `createRecord` (POST). The only test touching it (`multitable-public-form-smoke.spec.ts:88`) uses an **admin** token and asserts admin visibility — **no authz test guards this.**
- **Why missed:** #2028's "/view + GET /records" meant `GET /records/:recordId` (single, @7626 — fixed); the cursor **list** was untouched.
- **Surface beyond data egress (two extra fix-blockers — see §4):**
  - **(i) subject-less cache, checked before authz.** `cacheKey = buildRecordsCacheKey(sheetId, { filter, sort, cursor })` (`query-service.ts:82`) carries **no subject / effective allowed-field set / record-scope / limit**, and `getRecordsCache(cacheKey)` returns the body **before** any per-subject logic (@7514-7517). Bolting a field mask on without rescoping the key would let one subject's masked body be served to another (cross-subject cache poisoning) — and `limit` absent from the key is a pre-existing correctness collision too.
  - **(ii) selection/sort oracle on denied fields.** `filter.*` and `sortField` flow into `queryRecordsWithCursor` as **arbitrary fieldIds** (`data ->> $n = $m` predicates and `ORDER BY data ->> $n`, `query-service.ts:~324-340`) with **no allowed-set check**. Even with a correct data mask, `filter.<deniedField>=x` is a value **oracle** and `sortField=<deniedField>` leaks ordering — the exact #2044 selection-gate class.

### F0b — dashboard/charts module: authenticated, **no per-sheet authz** · HIGH-ish
Every `dashboardRouter()` handler (`/charts`, `/charts/:id`, `/charts/:id/data`, `/dashboards`, …) relies solely on the global JWT gate + a `chart.sheetId === params.sheetId` 404 match — **no `canRead`, no field-perm**. `getChartData` → `chart-aggregation-service` reads `record.data[fieldId]` directly (@90/119/212/231/253) with no masking. Any authed user can read any sheet's chart configs and **computed chart data**, which may group-by/aggregate a field the viewer is layer-3-denied (#1840/D3c-parity, but in the *separate* dashboard module).
- **Exploitability:** Lower than F0a — fields are **author-fixed** in the chart config (viewer can't choose), and output is aggregated (group labels / counts / sums), not raw rows. Still a cross-sheet read + denied-field aggregate leak.

### F1 — record history: full snapshot, **no mask** · MED-HIGH (broadest field leak)
`GET /sheets/:id/records/:rid/history` (@4297) gates sheet `canRead` + record-permission, then returns `listRecordRevisions(...)` items verbatim. Each `RecordRevisionEntry` carries `patch` (changed `{fieldId: value}`) **and `snapshot` (the full record `{fieldId: value}` at that version)** — masked by **nothing** (bypasses layer-2 *and* layer-3). A user who can read the sheet+record can read **all fields' historical values**, including statically-hidden and subject-denied fields.

### F2 — records-summary: arbitrary `displayFieldId` · MED
`GET /records-summary` (@7708) checks sheet `canRead`, then `loadRecordSummaries(sheetId, { displayFieldId })`. `loadRecordSummaries` (@2699) does **no field-permission check** and reads `data[effectiveDisplayFieldId]` where `displayFieldId` is **caller-controlled**. A sheet-reader denied a specific field (layer-3) can set `displayFieldId=<denied field>` and page the full `displayMap` → **bulk read of any one field's values across all rows.**

### F3 — write-path echoes (PATCH /records/:recordId, POST /patch): layer-2-only · MED
Both echo the written record's data masked by `visiblePropertyFieldIds` = `filterVisiblePropertyFields` (**layer-2 only**; PATCH @7404, POST /patch via `RecordWriteService` @8386/8344). `field_permissions` separates read (`visible`) from write (handlers enforce write via `RecordServiceFieldForbiddenError`), so a subject with **record-edit + ≥1 layer-3 read-denied field** receives that denied field's current value in the echo. The single-record **read** (@7626) was fixed by #2028; the symmetric **write echoes** were not.

### F4 — POST /records create echo: unmasked · LOW-MED
`POST /records` (@8119) returns `record.data = result.data` with **no `filterRecordDataByFieldIds`**. Mostly the caller's own input, but computed/default/formula values written by `RecordService.createRecord` on fields the caller is layer-3 read-denied could ride along.

### F5 — link-options / person-fields/prepare: `loadRecordSummaries` class · LOW
Both return `loadRecordSummaries(...).records` (display value of the foreign/source sheet's **primary/first-string** field) with no field-perm. Unlike F2 the field is not caller-chosen, so the leak is limited to a restricted primary/display field — low.

### D1 — form-context prefill / form-submit echo: layer-1+2, **design decision** · NOT a clear bug
`GET /form-context` (@6792) and `POST /views/:id/submit` (@7196) mask by `visibleFields`/`visibleFormFields` = `!hidden && !isFieldPermissionHidden` (**layer-1 + layer-2, no layer-3**). These serve **public/anonymous** form flows where there is no authenticated subject to scope `field_permissions` to (`fieldScopeMap` would be empty). Treating these as layer-1+2 is **defensible by design**; flag as a product question (should layer-3 apply to identified-but-non-anonymous form callers?), not a fix.

---

## 4. Proposed fix shape (per-finding; NOT executed in this slice)

The composite already exists — reuse it, do not reinvent:
```ts
const fieldScopeMap = access.userId
  ? await loadFieldPermissionScopeMap(query, sheetId, access.userId) : new Map()
const securityFieldPermissions = deriveFieldPermissions(visibleFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
const allowedFieldIds = new Set(visibleFields.filter(f => securityFieldPermissions[f.id]?.visible !== false).map(f => f.id))
```

- **F0a `GET /records`:** add the **full** GET /view treatment — `resolveSheetReadableCapabilities` + `if (!access.userId) 401` + `canRead` gate + record-permission filter + `allowedFieldIds` (layer-2 ∧ layer-3) mask. (Largest; it currently has *no* authz, so this is access-control hardening, not just a field mask.) **Plus two mandatory, endpoint-specific blockers:**
  - **(i) authz BEFORE cache, and a safe cache key.** Resolve authorization first, then **either disable `getRecordsCache`/`setRecordsCache` for this path, or rescope `buildRecordsCacheKey` to the security dimensions** (subject **and** effective allowed-field set **and** record-scope **and** `limit`) so a cached body can never cross subjects. A field mask alone, with the current subject-less key consulted first, is cross-subject cache poisoning.
  - **(ii) gate `filter.*` and `sortField`.** Filter/reject both against the same layer-2 ∧ layer-3 allowed set (omit denied predicates, or 400 on a denied field) so the response is not merely masked but the **selection/sort cannot oracle a denied field** (#2044 parity). Apply at the route boundary, before `queryRecordsWithCursor`.
  ⚠️ This is the only finding that touches authorization broadly — keep it scoped to this endpoint; **do not** generalize into central RBAC/auth (K3 lock).
- **F0b dashboard/charts:** add `canRead` to dashboard handlers + apply the #1840 hidden-field-omit rule inside `getChartData`/`chart-aggregation` so denied group/value fields are omitted. Verify against the #1840 contract.
- **F1 history:** mask `patch` and `snapshot` keys to `allowedFieldIds` in the route (or in `serializeRecordRevision` given a passed-in allow-set). Bypasses layer-2 today, so mask must be the full composite.
- **F2 records-summary / F5 link-options / person-fields:** field-permission-gate `displayFieldId` (reject or coerce to a readable field if denied) and apply `allowedFieldIds` to summary display derivation.
- **F3 write echoes:** swap `visiblePropertyFieldIds` → `allowedFieldIds` at PATCH @7404 and in `RecordWriteService` echo masking (mirror the read-path composite).
- **F4 create echo:** apply `filterRecordDataByFieldIds(result.data, allowedFieldIds)` before returning.
- **D1 forms:** product decision first; no code until decided.

Each fix follows the arc discipline: **fail-first** (prove the leak RED against `origin/main` via real-DB integration test → fix → GREEN), wire-vs-fixture integration assertion, design-lock honored.

---

## 5. Recommended sequencing (each = separate explicit opt-in; do NOT auto-start)

**Process:** this design-lock lands **first, as its own docs-only PR**, kept **separate from any implementation**. Each fix below is opened as a distinct slice only **after** the doc PR merges, one explicit opt-in at a time.

1. **F0a `GET /records` authorization** — highest: broken access control, cross-sheet full-data, no test guard. Likely **jumps the queue** ahead of the layer-2/3 polish. Implementation slice = **fail-first real-DB test (prove the leak RED) → `canRead` + record-permission filter + `allowedFieldIds` field mask + cache handling (§4 i) + filter/sort gate (§4 ii) → GREEN**, with a wire-vs-fixture integration assertion. All five must land together — a partial fix (mask without cache/selection handling) is still a leak.
2. **F0b dashboard/charts authorization + #1840-parity** — same access-control class.
3. **F1 history snapshot/patch mask** — broadest *field* leak among sheet-readable paths.
4. **F2 records-summary** (+ F5 link-options / person-fields in the same slice).
5. **F3 write-path echoes** (PATCH + POST /patch together).
6. **F4 create echo** (smallest; can ride with F3).
7. **D1 form layer-3 question** — product decision, then maybe code.
8. **Deferred scan** — dedicated egress pass, **kanban first** (`kanban.ts:114`), then gallery/calendar/automation (close the coverage gap noted in §1).

---

## 6. Scope guard

- This is a **docs-only design-lock.** No runtime change is authorized by this document.
- F0a/F0b touch **authorization** on two specific multitable endpoints/modules — permitted as kernel-polish **only** when individually opted-in, and **must not** spill into `plugin-integration-core`, central RBAC, or shared auth (K3 Stage-1 lock).
- Findings list is anchored to `5d6e5dd75`; re-verify line numbers before any fix (main laps frequently).
