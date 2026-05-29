# Multitable interactive-read field mask (#2015) — implementation & verification

- **Issue**: #2015 — interactive read paths used static-only (layer-2) field masking, shipping a `field_permissions`-denied value in the JSON payload.
- **Design-lock**: [`multitable-records-read-field-mask-design-20260529.md`](./multitable-records-read-field-mask-design-20260529.md) (#2024, scope B / value-only).
- **Status**: implemented + real-DB verified (fail-first). Backend-only; awaiting merge greenlight.
- **Date**: 2026-05-29
- **Grounding**: worktree off `origin/main 14f48cd73`. Lock posture: multitable read-path **kernel-polish** only — RBAC/auth, central permission model, `plugin-integration-core`, and `src/formula/engine.ts` are **NOT touched** ([[k3-poc-stage1-lock]]).

## 1. What changed

Two handlers in `packages/core-backend/src/routes/univer-meta.ts` now mask `row.data`/`record.data` (and link/attachment summaries) by the **D3c security composite** — layer-2 (`property.hidden`) ∧ layer-3 (`field_permissions.visible`, the subject-scoped read gate) — instead of layer-2 alone. This is the exact composite already shipped on export-xlsx (`:5839`), view-aggregate (`:5943`), and formula dry-run #5c-a (`:6089`).

**`GET /view`** and **`GET /records/:recordId`**, each (3 edits per handler):
1. Introduce `securityFieldPermissions = deriveFieldPermissions(visiblePropertyFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })` → `allowedFieldIds`. `hiddenFieldIds: []` deliberately omits **layer-1** (`view.hidden_field_ids`) — it stays a display-only concern carried in the returned `fieldPermissions` metadata, not a server-side data drop.
2. Swap the **3 data/summary** mask sites (`row.data`/`record.data`, `linkSummaries`, `attachmentSummaries`) from the layer-2 `visiblePropertyFieldIds` to `allowedFieldIds`.
3. Load `fieldScopeMap` **once** before the mask and **reuse** it for the returned-metadata derive (deleted the redundant second `loadFieldPermissionScopeMap` call — `/view` is the hottest read endpoint). `access.userId` is guaranteed truthy at mask time (both handlers 401 before the mask), so the empty-map trap is closed by construction.

The now-dead layer-2 `visiblePropertyFieldIds` declaration was removed from both handlers. The returned `fieldPermissions` **metadata** derive (all fields + layer-1, for the client display signal) is **unchanged** — only its `fieldScopeMap` source is now the shared single load.

**Value-only** (design §2.1 = (i)): values + summaries are masked; the denied field's **definition** (name/type/config in `fields[]`) and its `fieldPermissions` metadata entry remain (the client never renders the column). Full field-definition stripping (ii) is deferred behind a "missing field definition" compat scan.

## 2. Fail-first proof (design §5 #2 — the security regression's actual evidence)

Run against local real DB (`DATABASE_URL=postgresql://<user>@localhost:5432/<db>`), `vitest.integration.config.ts`, new file `tests/integration/multitable-records-read-field-mask.test.ts`.

**Pre-fix (route reverted via `git stash`, test present) — the leak is live:**
```
Tests  4 failed | 4 passed (8)
  × R1 (GET /view)  → row.data[FLD_SECRET] = 'do-not-leak-canary'   (leak)
  × R2 (GET /records) → record.data[FLD_SECRET] = 'do-not-leak-canary' (leak)
  × R4 (embedded FLD_SECRET-absence on the /view path)               (leak)
  × R6 (denied link field's summary carried the foreign canary)      (leak)
  ✓ sentinel, R3 (no over-strip), R5 (ungranted user), R7 (401)
```
Each of R1/R2 failed on the **leak** assertion (`row.data[FLD_SECRET]).toBeUndefined()`) while its **preceding** assertions passed — the positive control (`FLD_VISIBLE` present) **and** the metadata control (`fieldPermissions[FLD_SECRET].visible === false`, computed regardless of the fix). So the response is well-formed, the deny is correctly wired, and the **only** defect is the value leaking at the wire. That split is the proof; a bare red (empty response, 500, dropped row) would false-green the "canary absent" check — the positive control defeats it.

**Post-fix (R1–R7) — all green:**
```
Tests  8 passed (8)
```
The exact assertions that were RED now pass; nothing else changed.

## 3. Test design

`describeIfDatabase` + a `DATABASE_URL` sentinel (fails-not-skips in CI). TS-namespaced IDs (global-PK collision trap). Seed non-negotiable: **`FLD_SECRET.property = {}` → `property.hidden` UNSET** so the deny is **solely** layer-3 (else layer-2 would mask it pre-fix and R1/R2 would prove nothing).

| Test | Path | Asserts |
|---|---|---|
| **R1** (required) | `GET /view` | positive control (`REC_ID` present, `FLD_VISIBLE`=10) → metadata `fieldPermissions[FLD_SECRET].visible===false` → `row.data` omits `FLD_SECRET`, canary absent from whole body |
| **R2** (required) | `GET /records/:recordId` | same shape on `record.data` |
| R3 | both | non-denied `FLD_VISIBLE` present (mask doesn't over-strip) |
| R4 | both | layer-1 (`view.hidden_field_ids`) field value **STAYS** in data, hidden only via metadata (pins the §2 non-goal; FLD_SECRET still denied on the view path) |
| R5 | both | **ungranted-to-deny** user (no `field_permissions` row) still sees `FLD_SECRET` (per-subject grant-additive) |
| R6 | `GET /view` | a **denied link field's summary** is masked too — **positive control first** (ungranted user *does* receive the summary carrying the foreign canary, proving the fixture is non-vacuous), then the denied user's summary key is gone + foreign canary absent from body |
| R7 | both | unauth → 401 (mask never runs on an empty `fieldScopeMap`) |

Canary assertions scan the **whole serialized body** (not just `data[id]`) so a value re-surfacing via a summary/nested field is caught.

## 4. Regression — clean

- **tsc** (`tsc --noEmit -p tsconfig.json`): no errors in `univer-meta.ts` / the new test / `permission-derivation.ts`.
- **`multitable-view-aggregate.test.ts`** (the metadata-path sibling — exercises `deriveFieldPermissions` + `loadFieldPermissionScopeMap` like this change): **passes** pre and post-fix. This is the key regression check for the one non-mechanical edit (relocating + de-duplicating the `fieldScopeMap` load).
- **`multitable-formula-dryrun.test.ts`** (#5c-a sibling): passes.
- **`d3d1` / `d3d2` golden suites fail _locally only_, proven pre-existing**: identical failures on **unmodified** code (`git stash` baseline). Causes are local-DB-schema gaps — `field_permissions_subject_type_check` allows only `user`/`role` (rejects `member-group`, d3d2 seed) and `column "modified_by" does not exist` in the export query (d3d1, a handler this change never touches). CI's freshly-migrated `metasheet_test` has both; these suites are green on `main`.
- **CI wiring**: the new file is added to the `plugin-tests.yml` real-DB integration step (DATABASE_URL hard-guard) alongside the golden / view-aggregate / dry-run suites.

## 5. Scope adherence & deferred (same-class) items

**In scope (done):** `/view` + `GET /records/:recordId` value+summary mask; value-only; golden-doc §0/§1 reconciliation (this change, not a model change).

**Deferred same-class — NOT touched (each a separate opt-in):**
- **(ii) full field-definition strip** — gated on a "missing field definition" compat scan (design §2.1).
- **Other layer-2-only read sites** — `POST /patch` write-echo (`:8090`), `GET /form-context`, `POST /views/:viewId/submit`, `GET /records` list (`:7298`), `GET /records-summary` (`:7202`-class). Public-form paths use their own narrower form-field model.
- **Sort / search / filter operate on layer-2** (`searchableFieldIds` / `fieldTypeById`), unchanged by this slice. Note (verified, not assumed): `/view` `search=` filters server-side on field **values** (`buildRecordSearchPredicateSql` → SQL `ILIKE`, `:6204`), so a `field_permissions`-denied-but-`property`-visible field remains **searchable by value** (a `search=` term can probe its existence/ordering). This is **pre-existing** (search already ran on layer-2 before this change) and the data mask being tightened to layer-3 does **not** worsen it. Listed honestly as a deferred same-class candidate — out of the locked scope.
- **Returned `view: viewConfig` carries raw `filterInfo`/`sortInfo`** (verified: `MetaFilterCondition` = `{ fieldId, operator, value?: unknown }`; `parseMetaFilterInfo` keeps `value`; both handlers return `...(viewConfig ? { view: viewConfig } : {})` at `:6497` / `:7483`). A view configured to filter on a denied field with a literal comparison value (e.g. `FLD_SECRET = "topsecret"`) ships that literal in the body via the view config — a denied-value leak through a **non-data channel** that this slice's `row.data`/summary mask does not touch. **Pre-existing** (the raw view config was always returned) and **out of the locked scope** (scope B = the data/summary mask). Same class as the search-on-values note above; deferred candidate — not fixed here.
- **Record-scope gate consolidation on `GET /records`** — under the current schema `record_permissions.access_level` is grant-only (no deny), so record-read is grant-additive; the "lacks record-scope gate" half of the #2015 title is **assessed-inert**, not silently dropped (golden §2 record-read non-gate; same finding as #5c-a's T1 reframe). The live half of #2015 is the field mask, which this slice fixes.

## 6. Gated TODO (updated)

- ✅ Impl (`/view` + `GET /records` value+summary mask swap; single shared `fieldScopeMap` load; dead layer-2 set removed).
- ✅ R1–R7 real-DB tests, **fail-first demonstrated** (R1/R2/R4/R6 red → all green); wired into `plugin-tests.yml`.
- ✅ Golden-doc reconciliation (§0 gate-#1 + §1 matrix rows; not a model change).
- 🔒 **(ii) full field-strip hardening** — precondition: missing-field-def compat scan, then its own opt-in.
- 🔒 Deferred same-class (other read sites · sort/search layer-2 · record-gate consolidation) — separate, not started.
