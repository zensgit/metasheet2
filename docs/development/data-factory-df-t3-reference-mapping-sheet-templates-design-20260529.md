# DF-T3 — multitable reference-mapping sheet templates (design, 2026-05-29)

**Design note — not an implementation.** Design-first, no runtime, per the owner's DF-T3 framing.
DF-T3 is the path to lift the **DF-T2 v1 uniform-reference limitation**: today a profile preserves
the *same* reference objects (unit / account / warehouse / manager) from the one working sample
(`preserve_template`), so per-material reference *variation* is impossible. Reference-mapping
**sheets** give each material row its own reference object, resolved by a source code.

This doc defines the sheet model, the create-from-template manifest, how it composes a full
reference (lifting #1824), and the values-safe manifest rules. The **resolver runtime is a separate,
later gated slice** — DF-T3 itself ships no runtime.

## The limitation it lifts

- DF-T2 v1: reference fields are `preserve_template` (locked) — every material in a profile inherits
  the same `{FNumber,FName}` / `{FID,FName}` objects from the authored sample. Fine when the customer's
  materials share standard units/accounts; insufficient when they vary per material.
- `from_reference_table` exists in the DF-T1 vocabulary but is **scalar-component only in v1** — the
  #1824 probe showed a single multitable lookup yields one field's value, not a 2-field object, so it
  cannot synthesize `{FNumber,FName}`. DF-T3 closes exactly that gap with a **mapping sheet** (one row
  = one full reference object) + a resolver that composes both components.

## Reference-mapping sheet model

One multitable sheet per reference **domain**. A row maps a customer **source code** → a full K3
reference object. Two shapes, matching the adapter's `K3_REFERENCE_BY_NUMBER` / `K3_REFERENCE_BY_ID`:

| Domain examples | Identifier | Columns (one row = one full reference object) |
|---|---|---|
| unit, unit-group, order/sale/product/store unit, account (inventory/sales/cost), warehouse, manager | **FNumber** (`require-fnumber-fname`) | `sourceCode` · `fNumber` · `fName` · `enabled` · `notes` |
| ERP category, use-state, track, planning/order strategy, inspection levels & modes | **FID** (`require-fid-fname`) | `sourceCode` · `fID` · `fName` · `enabled` · `notes` |

- `sourceCode` = the value in the cleansed material row that selects the reference (e.g. the staging
  `unitSourceCode`). `fNumber/fID` + `fName` = the **full** K3 reference object components.
- One sheet per domain (a material's `FUnitID` resolves from the unit sheet, `FErpClsID` from the
  category sheet, …). This mirrors the existing `k3_unit_mapping` shape in the DF-T open-source design
  (`one row represents one full K3 reference object`).
- **Dictionary content (rows) is customer-owned tenant / runtime data** — it lives in the customer's
  workspace multitable sheet and the resolver reads it at runtime (T3b). It is **not** operator-local:
  it is real customer business data (not secret, but customer-owned) that stays **off Git, off
  manifests, and off issue/PR evidence** — only resident in the tenant's sheet.

## Create-from-template (the templatized part)

A **sheet-template manifest** describes each domain's sheet — **schema only, no content**:

```json
{
  "id": "k3wise.refmap.unit.v1",
  "domain": "unit",
  "identifier": "FNumber",
  "completeness": "require-fnumber-fname",
  "columns": [
    { "name": "sourceCode", "type": "text", "required": true, "key": true },
    { "name": "fNumber",    "type": "text", "required": true },
    { "name": "fName",      "type": "text", "required": true },
    { "name": "enabled",    "type": "checkbox" },
    { "name": "notes",      "type": "text" }
  ]
}
```

"Create from template" provisions the multitable sheet from this schema (empty); the customer fills
rows. The manifest is shareable (built-in templates for unit / unit-group / account / warehouse /
manager / category); **customer codes/values never enter the manifest**.

## How it composes a full reference (the resolve contract — runtime is a LATER slice)

When the resolver ships (separate gated runtime slice), the DF-T1 `from_reference_table` rule evolves
from "pre-resolved scalar" to a **mapping-sheet lookup**:

1. For a `from_reference_table` rule on a reference field, read the material row's `sourceCode`.
2. Look up the domain's mapping sheet by `sourceCode` — exactly **one enabled, complete** row must
   match (the resolution rules below); 0, 2+, or incomplete → **unresolved**, fail closed.
3. Compose the **full** reference object — `{ FNumber: row.fNumber, FName: row.fName }` (or
   `{ FID, FName }`) — and set it on the payload, **through the existing `applyReferenceShape`** in
   `k3-save-body-composer` (no new shaper).
4. `require-fnumber-fname` / `require-fid-fname` completeness still gates readiness (a missing or
   half-filled mapping row → not ready, fail closed; never a half-formed reference to Save).

The mapping sheet is read **the same way the staging source-adapter already reads cleansing sheets**
— its rows via the multitable records API by `sheetId` (verified: `metasheet-staging-source-adapter`
maps each object to a `sheetId` and reads its records). The resolver then **indexes/resolves by
`sourceCode` in-app** (an in-memory index over a bounded dictionary) — a **bulk read, not a keyed
read**, and **not** a new multitable-internals wire. Per-material variation is achieved because each
material's `sourceCode` selects its own row. (Confirm the exact read call shape at T3b scoping.)

**Mapping-row resolution rules (fail-closed — locked here, enforced by the T3b resolver):**

- The resolver indexes **only `enabled !== false`** rows — a disabled row is invisible to resolution.
- A row with a **blank `sourceCode`** is invalid and is **ignored** (never indexed).
- A row missing any required component for its domain (`fNumber`/`fID` **or** `fName`) is **incomplete**
  and is ignored for resolution (surfaced as a sheet-data warning).
- `(domain, sourceCode)` with **0** enabled-and-complete rows → **unresolved**: the reference is not
  ready; `require-*-fname` completeness fails closed — never Save a half-formed reference.
- `(domain, sourceCode)` with **2+** enabled-and-complete rows → **ambiguous** → **fail closed**. The
  resolver MUST NOT silently pick the first row; ambiguity is a sheet-data error for the operator to fix.
- These are **read-only readiness signals** (like `missingRequiredFields` / `unresolvedPlaceholders`):
  they block Save-only readiness; they never write, never auto-pick, never mutate the mapping sheet.
- **Evidence** for an unresolved/ambiguous reference reports the **field + domain + `sourceCode`
  presence + error type** (`unresolved` / `ambiguous` / `incomplete-row`) — **never** the customer code
  value or the candidate reference values.

## Decomposition (each a separate gated opt-in)

- **DF-T3a** — sheet-template **manifest model + create-from-template** (built-in domain schemas;
  provision an empty sheet; customer fills content). No resolver, no runtime composition.
- **DF-T3b** — **resolver runtime**: `from_reference_table` composes the full reference by mapping-sheet
  lookup (lifts #1824), via the shared composer + the staging source-adapter read. **It CHANGES the
  composed Save body, so it carries the DF-T1-0 byte-parity discipline (preview ≡ Save, fail-closed)
  and is its OWN owner opt-in — NOT an automatic cascade from T3a.** Wire-vs-fixture + completeness /
  fail-closed tests. **This is where the uniform-reference limitation actually lifts.**
- **DF-T3c** — manifest **import/export** (schema only; diff-before-apply; **no customer content/secrets**).

Recommend DF-T3a first (schema/templates, lowest risk), then DF-T3b (the runtime payoff), then T3c.

## Boundaries (hold these)

- **Design-only here; no runtime, no resolver, no K3 write.** DF-T2's preserve-only stays the behavior
  until DF-T3b ships.
- Customer dictionary **content** is customer-owned tenant / runtime data — **off Git / off manifests /
  off evidence** (resident only in the tenant's workspace sheet); manifests carry **schema only**.
- Reuse the composer's `applyReferenceShape` + completeness (no new shaper); reuse the staging
  source-adapter to read the mapping sheet (no new multitable-internals wire).
- No Submit / Audit / BOM / multi-record. No secrets in manifests; no raw SQL / user JS.
- Evidence/PR: field names + domain + shape only — never customer codes/values (the DF-T2 evidence rule).

## Open questions (resolve at T3a/T3b scoping)

- Whether the cleansing sheet links to the mapping sheet via a multitable **link field** vs. a
  resolve-time **join** by `sourceCode` (lean: resolve-time join in the resolver, keeps the mapping
  sheet a plain dictionary).
- One sheet per domain vs. a single sheet with a `domain` column (lean: one sheet per domain — simpler
  permissions + clearer templates).
- How a profile binds a reference field to its domain sheet (likely a small per-field
  `referenceTable` hint in the field rule — defined at T3b, not now).
