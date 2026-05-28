# K3 WISE M1 — customer-profile FBaseUnitID alignment (verification, 2026-05-28)

Issue: **#1792** (customer GATE). Scope: **Step 7** — productionize the M1 Material Save-only
shape that PASSed on the entity machine by aligning the `material-k3wise-customer-profile-v1`
preset to the customer's actual K3 WISE 15.1 Material contract. **One preset edit + tests + this
doc; no Save authorization; no Submit / Audit / BOM / multi-record.**

## Evidence (what was proven before this change)

On 2026-05-28 the operator ran, on the on-prem bridge machine, an evidence-first sequence that
closed the config track and then passed a single Material Save-only:

- **Config track PASS** — using the customer's working `Material/Save` template (from their
  `ErpController#doAddMaterial()`) as `config.objects.material.bodyTemplate.Data`, with the
  pipeline mapping reduced to `FNumber`/`FName`/`FModel` and **no `FBaseUnitID`**: the DF-T1
  no-write preview was green (`valid` and `eligibleForSaveOnly` true; 0 placeholders / 0
  unresolved references / 0 missing required; redaction self-check clean; `compositionSource =
  k3-save-body-composer`) and the pipeline dry-run cross-check matched the preview on both the
  top-level field set (28 == 28) and recursive shape (77 == 77).
- **M1 one-record Material Save-only PASS** — Save HTTP 200 + envelope/business success true +
  row status/message present + item id present + number echo present; one readonly readback
  returned the saved record (189 fields). Boundaries held (one record, `Material/Save` only; no
  Submit / Audit / BOM / multi-record / retry).

The two earlier M1 Save attempts FAILED at the row level. Root cause, confirmed by the above: the
base used an incomplete `Material/GetDetail` clone (`FUnitGroupID` returned `{FName}`-only) **and**
the pipeline composed `FBaseUnitID`, a field the customer's K3 contract does not use.

## Change

`material-k3wise-customer-profile-v1` (`plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs`):
**remove `FBaseUnitID` from the profile schema.** The customer contract uses `FUnitID` + the unit
family (`FOrderUnitID` / `FSaleUnitID` / `FProductUnitID` / `FStoreUnitID`); `FBaseUnitID` is not
part of it.

Why schema-only: `FBaseUnitID` stays in the shared `MATERIAL_FIELD_MAPPINGS` table (which also
serves BOM). Removing it from the **schema** is sufficient and load-bearing because the Save body
is composed by `projectRecordForBody`, which only iterates **schema** fields — so a staging record
(or mapping) carrying `FBaseUnitID` no longer reaches the Save body. Touching the shared mappings
is out of scope (the "do not expand functionality" boundary); the new parity test proves the schema
removal alone defends the Save body.

This is **structure only** — no customer dictionary values are baked into the preset; operators
still supply real values at runtime via the on-prem `bodyTemplate` (off Git).

## Tests

- `k3-wise-material-presets.test.cjs` — `testCustomerProfileOmitsFBaseUnitID`: the profile schema
  has no `FBaseUnitID` and keeps `FUnitID` + the unit family. `testPerFieldShapeDeclared` updated
  (its by-FNumber assertion list dropped `FBaseUnitID`, which it had asserted since #1912 — the
  pre-PASS design assumption that the M1 evidence now supersedes).
- `k3-save-body-composer.parity.test.cjs` — `testCustomerProfileDropsFBaseUnitID`: a staging record
  that *carries* `FBaseUnitID` composes a Save body (and a no-write preview) that **omit** it, and
  `preview.payload` equals the adapter Save body (no divergence). Identity / `FModel` scalars still
  compose.

### Negative control

Re-adding `FBaseUnitID` to the profile schema makes both new tests fail:
`testCustomerProfileDropsFBaseUnitID` (the record's `FBaseUnitID` is then projected into
`body.Data`, so `'FBaseUnitID' in body.Data` is true) and `testCustomerProfileOmitsFBaseUnitID`
(the schema then contains it). Reverting restores green. Run locally on 2026-05-28.

Full integration-core test set re-run after the change — presets / parity / adapters / DF-T1
preview / http-routes / external-systems — all pass.

## Scope boundary

Step 7 solidifies the PASSed one-record Material Save-only shape only. **Still locked / out of
scope:** Submit, Audit, BOM, multi-record, production batch — each a separate gated step. This
change does not authorize any Save; a Save-only attempt remains a separate, fresh #1792 approval.
