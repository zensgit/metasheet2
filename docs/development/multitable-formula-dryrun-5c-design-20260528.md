# Multitable Formula Dry-run #5c — real-record sampling (DESIGN-LOCK)

- **Slice**: #5c — evaluate an UNSAVED formula expression against a **real existing record's** values (today #5b only evals user-typed sample data).
- **Status**: 🔒 DESIGN-LOCK (this doc). Implementation is gated: #5c-a backend, then #5c-b frontend — each a **separate explicit opt-in**, do not auto-start.
- **Date**: 2026-05-28
- **Grounding**: read-only against `origin/main` worktree `bb61fee2d`; every code anchor below was opened and verified at that tip (anchor-verification pass run before this doc was finalized).
- **Lineage**: #5a backend (`#1865`) + #5b frontend (`#1873`) shipped the dry-run arc; #5b explicitly deferred real-record sampling as "#5c, demand-gated — D3c surface" (`multitable-formula-dryrun-5b-design-20260526.md:83`). This is that slice.
- **Lock posture**: fully **additive**; the K3-frozen shared core `packages/core-backend/src/formula/engine.ts` is NOT touched, RBAC/auth is NOT touched, `plugin-integration-core` is NOT touched.

---

## 1. What #5c is (and is not)

#5b's dry-run panel evaluates an unsaved formula against **hand-typed sample values**. #5c adds an **alternate sample source**: pick a real existing record and use its field values as the sample input. The evaluation engine is unchanged — only the *source* of `sampleValues` changes.

**The dry-run engine needs NO change.** `MultitableFormulaEngine.dryRun(expression, sampleValues, fields)` already takes `sampleValues: Record<fieldId, unknown>` (`formula-engine.ts:152`), which is exactly the shape of `record.data`. #5c is a sample-source switch, not an engine change.

### 1.1 Contract — the honest label (load-bearing; must appear in 3 places)

> **#5c previews `sheet-scope`, `permission-safe`, `raw-record` sampling — NOT a mirror of the current view's displayed columns.**
> A field that is **readable to the user** (passes field-permission read) but **hidden in their current view** MAY still be used as a sample input by #5c. This is a deliberate **display-consistency** scoping choice, **not** a security relaxation: the field-read security gate (subject `field_permissions`) is fully enforced.

This sentence MUST be written into:
1. **this design MD's contract** (here);
2. **frontend copy / tooltip** on the record-sampling affordance (#5c-b);
3. **the #5c verification MD's non-goals section** (so a reviewer does not misread B as "forgot the view mask").

---

## 2. Two hard gates (co-equal) — `recordId` is an arbitrary user input

Because `recordId` becomes an explicit request input, #5c opens **two** distinct read-permission surfaces. Both are **hard gates**, applied **before** any evaluation, in this order:

### Gate 1 — record-level read gate (cheapest deny, applied first)
Reuse the audited primitive `requireRecordReadable(req, query, sheetId, recordId)` (`univer-meta.ts:2190`). It performs, in order:
- existence: `SELECT id, sheet_id … WHERE id=$1 AND sheet_id=$2` → **404** if not on this sheet;
- `resolveSheetReadableCapabilities` → **401** (no `userId`) / **403** (`!canRead`, sheet-level);
- **record-scope**: if `!isAdminRole && hasRecordPermissionAssignments(sheetId)` then `deriveRecordPermissions(recordId, capabilities, loadRecordPermissionScopeMap(…,[recordId],userId)).canRead` → **403** (`:2218-2225`).

> ⚠️ **Empty-assignments = open (by design, inherited).** The record-scope deny only fires when `hasRecordPermissionAssignments(sheetId)` is true AND the scope map is non-empty (`:2220-2222`). If a sheet has no record-permission assignments, every record passes — this is the audited primitive's existing behavior and is correct. **Consequence for tests:** the "record-scope-denied → 403" test MUST seed real `record_permissions` assignments, or it tests a no-op and silently false-greens (same trap as the field-scope empty-map below).

### Gate 2 — capability + field-level read mask
- **Capability**: require `capabilities.canManageFields` (the #5a authoring premise — #5c is still about authoring a field's formula) **AND** `canRead` (mandatory once real record values are read). Verified: `resolveSheetReadableCapabilities` (`permission-service.ts:1174`) returns the **full** `MultitableCapabilities` (same type as `resolveSheetCapabilities` `:1151`), and `canManageFields` is a field on it (`sheet-capabilities.ts:38`) — so switching to the readable resolver does **not** drop the authoring gate.
- **Field mask**: the record's `data` is masked to the **D3c-allowed** field set before it reaches the engine (§4).

### 2.1 Gate wiring — extend `requireRecordReadable` additively
`requireRecordReadable` currently returns only `{ access }` on success (`:2231`), but it internally computes `capabilities` via `resolveSheetReadableCapabilities` (`:2208`). To avoid a double-resolve and get `userId` + `canManageFields` + the record gate in one call:

- **(recommended)** extend its success return to `{ access, capabilities }`. This is **backward-compatible** — the 3 existing callers (`:4212`, `:4247`, `:4273`) destructure `{ access }` and ignore the extra field. It is a route-local helper in `univer-meta.ts` (NOT the frozen core, NOT RBAC), so this is lock-safe.
- **(alternative, zero-touch)** call `requireRecordReadable` for the gate, then a separate `resolveSheetReadableCapabilities` for `capabilities` (one redundant resolve).

Recommended: the additive return.

---

## 3. Design decisions (locked)

| # | Question | Decision | Rationale (anchors @ `bb61fee2d`) |
|---|---|---|---|
| **a0** | Record-level read gate? | **`requireRecordReadable` first** (Gate 1). | `recordId` is arbitrary input → row-level access vector. Field masking alone would let a user sample a record-scope-denied record. `:2190`. |
| **a** | Read one record → break the no-DB backstop? | **Route-level `SELECT`; engine unchanged.** | The no-DB rule constrains the `FormulaEngine` *instance* (`DRY_RUN_NO_DB` stub throws on `selectFrom`, `univer-meta.ts:180-183`), NOT the route — the route already does DB I/O. The engine still sees only pre-substituted `{fldId}` literals → `selectFrom`=0, so the DB-query-spy=0 invariant (`formula-dryrun.test.ts:84-93`) holds. Frontend-resolve rejected: masking MUST be server-side. |
| **b** | Lookup/rollup field refs? | **Read RAW persisted `data`; do NOT materialize.** | Production recalc (`recalculateRecord`, `formula-engine.ts:249`) reads RAW and never calls `applyLookupRollup` → **raw read makes preview == production**. Lookup/rollup are computed-on-read (`applyLookupRollup` writes only in-memory `row.data`, `univer-meta.ts:1789-1805`) so their keys are absent in raw data → fall through the existing `missing_sample` info diagnostic (`formula-engine.ts:180`) → treated as empty. Zero new code; does NOT activate the A2b complex-value branch (`formula-engine.ts:118-133`). Materialize REJECTED (would show a number production can't reproduce until the #1971 Layer-2 fix, and would make #5c the first caller into the A2b array path). |
| **c** | Field-level masking precedent? | **Copy the export-xlsx composite** (`univer-meta.ts:5840-5846`). | It is the only precedent that applies the subject-scoped `fieldScopeMap` to actually DROP record values. **Do NOT copy `GET /records/:recordId` (`:7383`)** — static-only `visiblePropertyFieldIds`, would leak `field_permissions.visible=false` fields. Mask on `visible` only, NOT `read_only` (formula/lookup/rollup are read-only-but-visible inputs). |
| **d** | Which record? | **Explicit `recordId` (body) + a picker UI.** | `MetaFieldManager` opens from field config, not a grid row — no natural "current record" (props `MetaFieldManager.vue:570` = `visible/fields/sheets/sheetId/dryRunFn`, no record/view). Auto-pick "first record" is arbitrary/misleading. Validate `recordId ∈ sheetId` (404). Sub-decision (either acceptable): record values populate `sampleValues` with optional manual per-field overrides on top, vs record-XOR-manual; default to record-as-base-with-overrides. |
| **e** | View context / `view.hiddenFieldIds`? | **OUT OF SCOPE (option B). Pass `hiddenFieldIds: []`.** | See §4. Display-consistency defer, NOT a security defer. |

---

## 4. View-context — the explicit either/or (B chosen)

`deriveFieldPermissions` (`permission-derivation.ts:79-90`) computes `visible` as **three ANDed layers**:
1. `!hiddenFieldIds.has(id)` — **view.hiddenFieldIds** (per-view display filter);
2. `!isFieldPermissionHidden(field)` — **static `property.hidden`**;
3. `scope?.visible ?? true` — **subject `field_permissions`** ← **this is the real field-read security gate** (view-independent).

`MetaFieldManager` has no `viewId` in scope (`:570`); `MultitableWorkbench` passes only `activeSheetId` + `dryRunFormulaFn` (`:352`); the dry-run route has only `:sheetId` (`:6020`). And the export-xlsx composite **already defaults `viewHiddenFieldIds = []` when no `viewId` is passed** (`univer-meta.ts:5822`) — it is not a separate code path.

- **(CHOSEN) B — sheet-scope sampling.** Call the **same** export-xlsx composite with `hiddenFieldIds: []`. #5c masks via static `property.hidden` + subject `field_permissions` (layers 2+3). Layer 3 — the actual read gate — is fully preserved. **B is NOT a security downgrade**; the only thing it omits is layer 1 (per-view display hiding). It is also conceptually correct: field authoring is sheet-scoped, with no "current view" to mirror. Smallest blast radius — no `viewId` threading, no change to the #5b `dryRunFn` contract.
- **(ALTERNATIVE) A — view-display parity.** If a product signal later wants the sample scoped to a specific view's visible columns: thread `viewId` through `MetaFieldManager` → `dryRunFn` → route → `resolveMetaSheetId/tryResolveViewShared` to obtain `hiddenFieldIds`. Security-equivalent to B (layer 3 identical); the only gain is display consistency. Not chosen now.

> View-hiding is a **display preference** in this model, not a field-read security mechanism — the field-read gate is `field_permissions` (consistent with the D3c golden "annotation-rich, enforcement-thin" finding). So B defers display consistency, not security.

---

## 5. The #5c flow (locked)

```
POST /sheets/:sheetId/formula/dry-run  { expression, sampleValues?, recordId? }

if recordId present:
  1. requireRecordReadable(req, query, sheetId, recordId)   ── Gate 1 (404/401/403), record-scope
     → { access, capabilities }   (additive return; §2.1)
  2. require capabilities.canManageFields                    ── authoring gate (verified present)
  3. SELECT data FROM meta_records WHERE id=$1 AND sheet_id=$2   ── RAW, no applyLookupRollup
  4. field mask (D3c, hiddenFieldIds: []):
       visibleFields  = filterVisiblePropertyFields(fields)            (univer-meta.ts ~:2267)
       fieldScopeMap  = loadFieldPermissionScopeMap(query, sheetId, access.userId)
       fieldPerms     = deriveFieldPermissions(visibleFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
       allowedIds     = visibleFields.filter(f => fieldPerms[f.id]?.visible !== false)
       maskedData     = filterRecordDataByFieldIds(record.data, allowedIds)   (univer-meta.ts ~:2271)
  5. dryRunFormulaEngine.dryRun(expression, maskedData, fields.map(f => ({id, type})))   ── unchanged no-DB engine

else (no recordId):
  unchanged #5b path — manual sampleValues (additive; #5b NOT regressed)
```

Reuse note: `filterVisiblePropertyFields` / `filterRecordDataByFieldIds` are module-level in `univer-meta.ts`; `loadFieldPermissionScopeMap` / `deriveFieldPermissions` are already imported. #5c **calls** these — no helper extraction, no copy of logic, no new export. `filterRecordDataByFieldIds` OMITS denied keys (drop, not null/redact) → a dropped key becomes `missing_sample` in the engine.

---

## 6. Frozen-core safety

- `packages/core-backend/src/formula/engine.ts` (shared with attendance under the K3 lock): **NOT modified.**
- `MultitableFormulaEngine.dryRun` / `evaluateField`: **NOT modified** — signatures already accept `Record<fieldId, unknown>`; `missing_sample`/`'0'` coercion reused as-is.
- No new `DryRunDiagnosticKind` (lookup refs reuse the existing `missing_sample` kind).
- Cross-table `lookup()` raw-SQL path stays unwired into dry-run (raw read + no-DB stub).
- D3c reuses the existing `field_permissions` read path (`loadFieldPermissionScopeMap`), NOT auth/RBAC.
- The only shared-surface change is the **additive** `requireRecordReadable` return (§2.1), a route-local helper.

---

## 7. Test matrix (mandatory)

| # | Test | Layer | Note |
|---|---|---|---|
| T1 | **record-scope-denied `recordId` → 403, NOT evaluated** | record gate | ⚠️ MUST seed real `record_permissions` assignments (else `hasRecordPermissionAssignments`=false → no-op false-green). Real-DB. |
| T2 | **field-scope-denied field's value NEVER appears in any result/diagnostic** (wire-vs-fixture round-trip leak test) | field gate | ⚠️ MUST seed `field_permissions.visible=false` + a formula referencing that field; assert via the REAL `POST …/dry-run` with `recordId`. Panel specs mock `dryRunFn` and would NOT catch a dropped/leaked field. Real-DB. |
| T3 | **`userId`-present masking actually fires** | field gate | Guards the empty-scope-map trap (no `userId` → empty map → masking no-ops → leak). Assert scope-denied field dropped WITH a real `userId`. |
| T4 | **lookup-ref → `missing_sample`/empty** (not a materialized value) | raw-read lock | Locks the raw-data decision; prevents a future silent switch to materialize; documents preview==production. Real-DB with a linked lookup. |
| T5 | **`recordId` validation** | gate | not on `:sheetId` → 404; on sheet but no `canRead`/record-scope → 403; missing `recordId` → #5b manual path unchanged (additive). |
| T6 | **OpenAPI parity** | contract | the optional `recordId` request field round-trips `verify:multitable-openapi:parity`. |
| T7 | **frontend record-swap mid-flight** covered by `dryRunSeq` stale-drop; record-load NEVER gates Save (C4) | frontend | extend the #5b stale-response spec to a record-change trigger. |

---

## 8. Out-of-scope / non-goals (explicit)

- **`view.hiddenFieldIds` masking (option A)** — display-consistency only; deferred, not a security gap (§4). The honest-label sentence (§1.1) must say so in the verification MD's non-goals.
- **Faithful lookup/rollup preview** (materialize) — deferred behind the #1971 Layer-2 fix (`multitable-formula-lookup-recalc-gap-20260528.md`); a separate gated opt-in. #5c surfaces lookup refs honestly as `missing_sample`.
- **`GET /records/:recordId` (`:7319`) latent leaks** — it lacks the record-scope gate AND uses static-only field masking. This is a pre-existing inconsistency #5c **flags but does not fix**; a separate opt-in.
- **#5c does NOT** introduce a new 404-vs-403 oracle — it inherits `requireRecordReadable`'s existing semantics, shared by 3 endpoints.

---

## 9. Gated TODO checklist

- ✅ **#5c-DESIGN** — this doc (design-lock; pending docs-only PR).
- ⬜ **#5c-a backend** (separate opt-in): optional `recordId` in `POST …/dry-run`; `requireRecordReadable` Gate 1 (+ additive `{access,capabilities}` return); `canManageFields && canRead`; RAW `SELECT data`; D3c field mask with `hiddenFieldIds: []`; pass masked data to the unchanged no-DB engine; OpenAPI parity; tests T1–T6 (real-DB for T1–T4).
- ⬜ **#5c-b frontend** (separate opt-in): record-picker affordance in the Zone-B dry-run panel; `recordId` passthrough mirroring `dryRunFormulaFn` wiring; keep #5b manual-input path additive; preserve C2 (explicit Evaluate + `dryRunSeq` covering record swap) and C4 (never gates Save); ephemeral reset on reopen; the §1.1 honest-label tooltip; test T7.
- 🔒 **frozen** (not part of #5c; each a separate opt-in): faithful lookup materialize (behind #1971 Layer-2); view-display parity (option A); `GET /records/:recordId` leak fix.

---

## 10. Risk register

1. **(highest) Leak via empty scope map** — if #5c reuses the #5a route scaffold verbatim (`canManageFields`-only, no `access.userId`), `loadFieldPermissionScopeMap` returns an empty Map → masking silently no-ops → leak. **Mitigation:** the §5 flow obtains `userId` via `requireRecordReadable`/readable resolver; T3 proves masking fires.
2. **Copying the wrong precedent** — `GET /records/:recordId` (`:7383`) / form-record path mask static-only and lack the record-scope gate. Copy from export-xlsx (`:5840-5846`) + `requireRecordReadable` only.
3. **Materialize temptation** — would make preview ≠ production and activate the A2b branch as first caller. Locked to RAW.
4. **Wire-vs-fixture drift** — panel unit specs mock `dryRunFn`; the integration leak tests (T1/T2) are mandatory, not optional.
5. **`read_only` vs `visible` confusion** — mask on `visible` only; read-only-but-visible fields (formula/lookup) must remain readable inputs.
6. **Type fidelity through string inputs** — send `recordId` server-side (recordId mode); do NOT round-trip real record values through #5b's `Record<string,string>` typed-text inputs (would corrupt or spuriously trip `type_mismatch`).
7. **Object-valued real fields → `#VALUE!`** — real person/location/object cells make `evaluateField` return `#VALUE!` (`formula-engine.ts:118-133`), surfaced as a runtime diagnostic; confirmed acceptable #5c UX (documented contract).
8. **Staging/test env** — `loadFieldPermissionScopeMap`/`loadRecordPermissionScopeMap` degrade to empty Map (open, not deny) if the permission tables are absent; T1–T3 must run on the `plugin-tests.yml` real-DB step with those tables present.
