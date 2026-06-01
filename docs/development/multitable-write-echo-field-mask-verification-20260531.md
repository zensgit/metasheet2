# F3 — write-path echo field mask · verification

**Date:** 2026-05-31
**Design-lock:** `docs/development/multitable-record-egress-fieldperm-inventory-20260529.md` (#2106) §3 F3.
**Scope:** the **same-sheet** write-echo of `PATCH /records/:recordId` + `POST /patch`. No central RBAC/auth (K3 Stage-1 lock).

## The hole

After a write, both endpoints echo the record back masked by `visiblePropertyFieldIds` = **layer-2 only** (`property.hidden`). A `field_permissions.visible=false` (layer-3 read-denied) value was echoed anyway. The write gate is **layer-2 only too** (`canEditRecord` + `fieldById`'s `isFieldPermissionHidden`/`isFieldAlwaysReadOnly` — it never consults `field_permissions`), so a field can be **writable yet read-denied** ("write-only-no-read"): a user can PATCH `FLD_SECRET`, the write persists, and the echo handed the value right back.

## The fix — narrow the echo set, leave the write set

Both routes now compute the **layer-2 ∧ layer-3** composite (the #2028 read-mask pattern) and pass it as the echo read-back set:
- **PATCH** (`univer-meta.ts`): `readableEchoFields`/`readableEchoFieldIds` feed the record-data mask + attachment-summary mask + attachment-field selection (the write already happened upstream via `RecordService`).
- **POST /patch**: the route passes `readableEchoFields`/`Ids` into `RecordWriteService` (used there **only** for the echo — masks at `record-write-service.ts:828/854/882/914/929; computed-extract @834`). **`fieldById` stays built from ALL fields**, so write-only-no-read fields remain writable; only the echo omits them. (`RecordPatchInput.visiblePropertyFields/Ids` now carries a doc comment that it is the echo/read-back set, not the writable set.)

Mechanism choice = narrow-the-echo (no service signature change); `crossSheetRelated`/computed-echo ordering verified safe (see below).

## Fail-first (real DB)

`tests/integration/multitable-write-echo-field-mask.test.ts` (wired into the `plugin-tests.yml` real-DB step). Seed: `FLD_SECRET`/`FLD_FORMULA.property` carry no `hidden` → deny is **solely** layer-3.

| # | Scenario | Pre-fix | Post-fix |
|---|---|---|---|
| R1 | PATCH a readable field → full-record echo | `FLD_SECRET` value present | omitted (+ `FLD_VISIBLE` positive control) |
| **R2** | **PATCH `FLD_SECRET` itself (write-only-no-read)** | echoes the just-written value | **echo omits it; DB still persists it** |
| R3 | POST /patch → computed (FORMULA) echo | denied formula value present | omitted (USER_ID_2 positive-control first) |
| R5 | PATCH as an ungranted-to-deny user | — | denied field **present** (mask is per-subject) |

- **RED proven**: R1/R2/R3 failed on unmodified origin/main (`expected '<canary>' to be undefined`; R3 `expected 31 to be undefined`) → **5/5 GREEN** post-fix.
- **R2 is the F3-specific proof** — it closes what F0a's *read* mask did not: a field the caller **wrote** but cannot read. The DB-readback assertion confirms the write persisted (the mask is echo-only, not a write block).
- **R3 non-vacuous**: POST /patch echoes only computed/dependent data (`mergedRecords`), so a plain field would make the assertion vacuous. A **formula** field is the minimal computed seed (echoed @882); the USER_ID_2 positive control proves the channel carries the value before asserting the denied user's omission. (Direct-SQL field inserts skip the create-field path that records `formula_dependencies`, so the test seeds that row — `recalculateFormulaFields` gates on it.)

## Out of F3 scope — TWO NEW findings (not in the #2106 inventory; surfaced for re-ranking)

While mapping the POST /patch echo I found two leaks **beyond** the layer-2-only same-sheet echo F3 targets. Neither is fixed here; both are different mechanisms:

- **`crossSheetRelated` returned UNMASKED (`record-write-service.ts:985`).** Cross-sheet related records (recomputed lookup/rollup of dependents in *other* sheets) are returned in `result.relatedRecords` with **no field filter at all** — not even layer-2. Masking needs each *related* sheet's per-subject `allowedFieldIds` (a different resolution than F3's single edited-sheet set). **Severity: this is *unmasked*, so it arguably outranks F4/F5** — worth re-ranking ahead of them. (Verified independent of `visiblePropertyField*` — F3's narrowing leaves it byte-identical, no regression, no half-fix.)
- **Realtime broadcast carries unmasked values (`record-write-service.ts:~949-961`).** `publishMultitableSheetRealtime` emits `recordPatches` (`patch` = changed + materialized formula values) + `fieldIds` to **all** sheet subscribers — a per-recipient surface where the writer's perms aren't the right gate. Separate fix (per-recipient or don't-broadcast-values).

## Regression / type

- `tsc --noEmit` exit 0.
- `multitable-record-patch.api.test.ts` (mocked SQL) needed a one-line `field_permissions` stub (F3 adds that query to the echo path; the mock returns no denials) → **31/31** with the read-mask + partial-success + view-aggregate siblings.
- The `view-config` / `record-form` / `sheet-realtime` mocked tests fail **identically on pristine origin/main** (Unhandled SQL: `pg_advisory_xact_lock`, `/views meta_fields`, record-context — none `field_permissions`) → **pre-existing local-env mock gaps, not an F3 regression** (green in CI).

## Diff scope

`univer-meta.ts` (PATCH echo + POST /patch), `record-write-service.ts` (input-type doc comment), the new test, a one-line mock stub, the CI wiring, this doc. Write gating unchanged.
