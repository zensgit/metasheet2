# kanban / gallery / calendar view-data egress scan — verdict: CLEAN (no live egress)

**Closes:** the deferred coverage scan in the multitable field-read-gate arc (tracker `multitable-field-read-gate-tracker-20260602.md` §2b last row; #2106 inventory §1/§8 "deferred, NOT claimed clean here"). **Date:** 2026-06-02. **Method:** the #2106 egress-inventory method applied to the view-data plugins + their routes, anchored to fresh `origin/main` (`9f558d522`), Read-verified (Bash/grep output was character-mangled in this environment — every hit confirmed by Reading the file).

## Question
Do the kanban / gallery / calendar view-data paths (plugins + routes) egress `meta_records` cell values **without** the layer-2 ∧ layer-3 field mask that the grid/read/echo/summary surfaces now enforce?

## Per-surface findings

| Surface | Loaded in prod? | Record-data source | authz | field-mask | Verdict |
|---|---|---|---|---|---|
| `src/routes/kanban.ts` `GET /:viewId` (the real `kanban.ts:114`, hardcoded-mounted) | **yes** | `views` + `view_states` (view config + per-user view state) — **not** `meta_records` | view-existence | n/a (no cell values) | **SAFE** — `payload` is config/state, not record data; the #2106 worry was a false alarm |
| boards-kanban plugin `packages/core-backend/plugins/plugin-view-kanban` (has `plugin.json`) | loadable | `FROM views` + kanban board config — no `meta_records`, no `.data` | — | n/a | **SAFE** (config only) |
| root sample-kanban `plugins/plugin-view-kanban` (has `plugin.json`) | maybe | `SELECT * FROM records` — **a bare `records` table that does not exist in any migration** (only `meta_records` does) | none | none | **DEAD** — query errors → 500, no egress |
| gallery plugin `plugins/plugin-view-gallery` | **no — no manifest** (`plugin.json`/`manifest.json` absent → loader throws "manifest not found") | all record data via `api.events.request('spreadsheet:records:query', …)`; direct `pool.query` only on `gallery_configs` | none | none | **DEAD + unreachable** |
| calendar plugin `plugins/plugin-view-calendar` | **no — no manifest** | all record data via `api.events.request('spreadsheet:…', …)`; direct `pool.query` only on `calendar_configs` | none | none | **DEAD + unreachable** |
| product kanban/gallery/calendar **view-types** (the actual UI) | yes | client-side re-layout of `GET /api/multitable/view` | gated | **masked** (#2015/#2028) | **SAFE** — no separate server egress |
| automation `test` / `logs` routes | yes | `redactAutomationExecutionForResponse` | `requireAdminRole` | redacted | **SAFE** |

Two facts make the dead/unreachable verdicts hard:
1. **`spreadsheet:records:query` has zero registered handlers** — it appears in the codebase only as `.request(...)` callers (gallery `:402`, calendar `:444`/`:779`). With no responder, `recordsResult` is never `success` → the routes throw → 500. Every gallery/calendar record-data route (list **and** detail) is event-mediated this way; none does a direct `meta_records` read.
2. **No bare `records` table** exists in `packages/core-backend/src/db/migrations/*` or `packages/core-backend/migrations/*` — only `meta_records`. The sample kanban's `SELECT * FROM records` cannot run.

## Verdict
**No live, reachable, unmasked egress of `meta_records` cell values through kanban / gallery / calendar / automation.** The standalone view plugins are non-functional samples (missing table / missing event handler / no manifest); the real product renders these view-types client-side from the already-gated `GET /api/multitable/view`. **No new finding; no locking test added.**

## Latent risk (record, do not ignore — the F0b latent-not-live pattern)
The gallery and calendar sample plugins ship **fully-formed `GET /…/records` and `/records/:recordId` egress routes with no authz and no field mask.** They are inert **only** because (a) they have no manifest to load and (b) `spreadsheet:records:query` has no handler. If a future change adds a manifest **or** wires a `spreadsheet:records:query` handler that returns raw `meta_records.data`, these routes bypass the entire field-read gate — exactly F0b's "wire the provider and it leaks."

**Forward defense:** any future `spreadsheet:records:query` handler (or revival of these plugins) MUST route record data through the target sheet's `allowedFieldIds` (layer-2 ∧ layer-3) and re-enter this egress inventory before shipping. Deleting the dead sample plugins outright would remove the latent guns entirely — tracked as **optional hardening** (tracker §4), deliberately kept out of this scan-closure to avoid entangling it with the plugin-sample retention policy.
