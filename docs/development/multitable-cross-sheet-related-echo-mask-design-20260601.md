# Multitable cross-sheet related echo mask design

**Date:** 2026-06-01
**Slice:** post-F3 new finding #1 — `crossSheetRelated` write-path echo mask.
**Status:** DESIGN-LOCK ONLY. Implementation is a separate explicit opt-in.
**Grounding:** `origin/main` @ `f99841073`.

---

## 0. Why this exists

F3 (#2169) closed the same-sheet write echo: `PATCH /records/:recordId` and `POST /patch` now compute a layer-2 ∧ layer-3 readable echo set for the edited sheet and pass it into `RecordWriteService` (`univer-meta.ts:7373-7391`, `:8327-8338`). That echo set is explicitly **read-back only** (`record-write-service.ts:212-217`), not the write gate.

During the F3 review we found a different echo channel:

- `computeDependentLookupRollupRecords` recomputes lookup/rollup fields for dependent records in other sheets and returns `data: extractLookupRollupData(fields, row.data)` (`univer-meta.ts:1817-1901`).
- `RecordWriteService.patchRecords` splits those records into same-sheet and cross-sheet results. Same-sheet records are masked by the edited sheet's `visiblePropertyFieldIds` (`record-write-service.ts:854-859`), but cross-sheet records are just `relatedRecords.filter((record) => record.sheetId !== sheetId)` and are returned unchanged (`:860`, `:989`).
- The route handlers only aggregate and echo `result.relatedRecords` (`univer-meta.ts:8378-8422`, `:8441-8448`).

So a user who can write the edited sheet can receive computed lookup/rollup values from a related sheet without applying that related sheet's field-read gate. This is **not** the realtime broadcast issue (`record-write-service.ts:938-966`) and must not be fixed by the same mechanism.

---

## 1. Current safety boundaries

This channel is not an all-record or no-sheet-auth leak:

- `computeDependentLookupRollupRecords` already calls `resolveReadableSheetIds(req, query, rowsBySheet.keys())` and skips unreadable sheets (`univer-meta.ts:1871-1875`).
- `resolveReadableSheetIds` applies the request subject's sheet grants (`permission-service.ts:1187-1208`).
- The returned `data` is the computed lookup/rollup subset (`extractLookupRollupData`), not the full raw row.

The missing piece is field-level read masking for the **related sheet**. The edited sheet's readable field set is invalid for this purpose because field ids, field permissions, static hidden flags, and capabilities are scoped to the related sheet, not the edited sheet.

Record-level read-deny is not a current hard gate in this data model (record assignments grant read/write/admin; absence is not a deny). This slice preserves the existing sheet-read behavior and does not add a new record policy.

---

## 2. Locked decisions

### D1 — Mask, do not drop, field-denied related records

For a related sheet that the requester can read, keep the `relatedRecords[]` object but filter `data` to the related sheet's allowed field ids.

If the mask removes every key, return `data: {}` rather than dropping the record. This preserves the existing "a dependent record recomputed" signal without exposing values. It also mirrors same-sheet computed echo behavior, which may already produce empty `data` after filtering.

### D2 — Drop unreadable related sheets

Keep the existing `resolveReadableSheetIds` behavior: if the requester cannot read the related sheet, no `relatedRecords[]` entry for that sheet is emitted. This is already the production behavior and is safer than returning record ids with empty data.

### D3 — Allowed ids are per related sheet

For each related sheet, compute the same #2015 composite:

```ts
{ access, capabilities } = resolveSheetReadableCapabilities(req, query, relatedSheetId)
if (!access.userId || !capabilities.canRead) drop relatedSheetId
visibleFields = filterVisiblePropertyFields(relatedFields) // layer-2
fieldScopeMap = loadFieldPermissionScopeMap(query, relatedSheetId, access.userId)
fieldPermissions = deriveFieldPermissions(visibleFields, capabilities, {
  hiddenFieldIds: [], // layer-1 remains display-only / view-scoped
  fieldScopeMap,
})
allowedFieldIds = visibleFields where fieldPermissions[field.id]?.visible !== false
```

Do **not** reuse the edited sheet's `readableEchoFieldIds`. Do **not** use the view-hidden output set. This is a sheet-scope write echo, not a view projection.

### D4 — Fix at the related-record producer seam

Preferred implementation site: `computeDependentLookupRollupRecords`.

Reasoning:

- It already has `req`, `query`, rows grouped by related `sheetId`, and each related sheet's field definitions.
- It already drops sheets the requester cannot read; the implementation should upgrade that boolean set into a per-sheet readable-capability/allowed-field map so the same pass supplies both the canRead decision and the field mask.
- It is still a route-layer helper, so `RecordWriteService` remains Express/permission-service agnostic.
- Both `POST /patch` modes are covered because they both receive the helper through `RecordWriteHelpers.computeDependentLookupRollupRecords` (`univer-meta.ts:8363`).

Implementation may factor a small local helper such as `loadRelatedAllowedFieldIdsBySheet(req, query, fieldsBySheet)` if that keeps the code testable. That helper must key both `capabilities` and `fieldScopeMap` by the **related** sheet id. It should not introduce central RBAC/auth changes.

### D5 — Fail closed on missing subject

Patch routes are JWT-protected, but the helper should still avoid the historical empty-map fail-open pattern. If no request subject is available while computing related-sheet allowed ids, allowed ids for that related sheet are empty, or the sheet is omitted. Never interpret "no fieldScopeMap" as "all fields visible" for this echo path.

---

## 3. Verification matrix

All permission tests must be real-DB integration tests. Mock-pool tests are useful for pure helper edges, but not sufficient for the field-scope path.

### Required fail-first tests

- **R1 field-denied cross-sheet lookup/rollup echo:** seed two sheets. Editing sheet A recomputes a lookup/rollup field on sheet B. User can write A and read B, but has `field_permissions.visible=false` for B's computed field. On unmodified `origin/main`, `relatedRecords[].data[FLD_B_SECRET_COMPUTED]` contains the canary; after the fix it is omitted. A visible B computed field remains as a positive control.
- **R2 per-related-sheet allow set:** include a visible computed field on sheet B and ensure it survives. This fails if implementation accidentally filters B by A's allowed ids and drops all cross-sheet data.
- **R3 static hidden path:** a B computed field with `property.hidden=true` and no field-permission row is omitted. This pins layer-2 ∧ layer-3, not layer-3-only.
- **R4 multiple related sheets:** one related sheet has a denied field and another has a visible field. The response applies independent masks per related sheet, not a shared/global allow set.
- **R5 unreadable related sheet:** if the requester cannot read sheet B, B's `relatedRecords[]` entries are absent. This pins the existing `resolveReadableSheetIds` drop semantics.
- **R6 same-sheet regression:** same-sheet related/computed echo remains masked by the edited sheet's readable echo set and still returns visible computed values.

### Non-vacuous seed requirements

- The denied field's `property.hidden` must be explicitly unset in R1 so the failure is solely layer-3.
- The related-sheet visible positive control must use a unique canary so "empty response" cannot pass as a mask.
- At least one test must assert the DB/persisted recomputation still happened; the mask is response-only.
- If a helper test stubs permissions, include a no-subject/empty-map case that fails closed.

---

## 4. Non-goals

- **Realtime broadcast unmasked patches** (`record-write-service.ts:938-966`). Broadcast is per-recipient and needs a separate design decision: per-recipient masking vs no value payload. Do not quietly fold it into this slice.
- **F4 create echo** and **F5 link-options/person-fields** from the #2106 inventory.
- Full field-definition strip.
- New record-level read-deny semantics.
- Central RBAC/auth, plugin-integration-core, or K3-gated areas.

---

## 5. Landing checklist

- [x] Design-lock drafted.
- [ ] Implementation PR: mask cross-sheet `relatedRecords` at the related-record producer seam.
- [ ] Real-DB fail-first proof for R1/R2/R5, then GREEN after fix.
- [ ] Regression for F3 same-sheet write echo.
- [ ] Backend type-check and CI real-DB step verified-ran.
- [ ] Memory update only after merge, on explicit user instruction.
