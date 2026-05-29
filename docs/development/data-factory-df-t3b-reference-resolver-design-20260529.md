# DF-T3b — `from_reference_table` mapping-sheet resolver — implementation design & acceptance (2026-05-29)

> **Design-first, no runtime in this PR.** DF-T3b lifts the #1824 uniform-reference limit by composing
> a **per-material** K3 reference object from a mapping sheet (DF-T3a manifest, #2043) instead of the
> one authored sample's uniform scalar. Because it **changes what gets composed into the Save body**, it
> is one tier riskier than the schema-only T3a — so the contract is locked here before any code.

## Scope boundary (the load-bearing sentence)

T3b changes **how** `from_reference_table` composes a reference — a per-material mapping-sheet lookup
producing the full `{FNumber,FName}` / `{FID,FName}` object, vs. today's uniform pre-resolved scalar —
in the **shared composition path**, so the no-write preview stays **byte-identical** to the adapter
Save. It does **NOT** change the write **scope**: still M1 one-record Material Save-only, the existing
`/K3API/Material/Save` call, no Submit / Audit / BOM / multi-record / new write endpoint. The K3 write
operation itself is unchanged and stays separately gated.

## Grounded current state (verified, not assumed)

- `from_reference_table` today = `http-routes.cjs:674` → `raw = rule.value` (a **uniform pre-resolved
  scalar** — exactly the #1824 limit), then `applyDfT1Shape` → `applyReferenceShape`.
- Reference **shaping** is owned solely by `k3-save-body-composer.cjs:44` `applyReferenceShape`
  (the DF-T1-0 single source). A two-field object passes through **verbatim** (object-passthrough) — so
  a resolved `{FNumber,FName}` needs **no new shaper** (DF-T1 req #3 honored).
- The live adapter Save composes via `k3-wise-webapi-adapter.cjs:460` `buildSaveBody` →
  `composeSchemaBody` → `projectRecordForBody` (the **schema path**), from a record + the preset schema.
  It does **not** consume `fieldRules`.
- The existing parity test `k3-save-body-composer.parity.test.cjs` is **behavioral byte-equality**
  (`assert.deepEqual(preview.payload, adapterSaveBody)` against the *real* captured Save body) — but it
  exercises the **schema path** (`buildTemplatePreview` with `template.schema`, no `payloadTemplate`).
  The `from_reference_table` (fieldRules) path goes through `buildTargetPayloadPreview`
  (`http-routes.cjs:782`) and is **not yet under that parity**. Bringing it under parity is the keystone
  of T3b.

## The resolver — LOCKED behavior

Inputs: a material's `sourceCode` (from the source record) + the domain's mapping sheet (the DF-T3a
manifest fixes `domain` / `identifier` / `completeness` / columns).

1. **Bulk read + in-memory index.** Bulk-read the mapping sheet via the staging source-adapter and
   build an index keyed by `sourceCode`. **Index lifetime = per-composition-run; no cross-run cache** —
   a cached dictionary serving stale references is the retention gap #1880 flagged; T3b must re-read
   per run. *(Exact source-adapter read call shape = confirm-at-impl, as #2036 deferred.)*
2. **enabled-only** — index a row only if `enabled !== false`. A disabled row is invisible to resolution.
3. **blank `sourceCode` ignored** — a row with a blank/whitespace `sourceCode` is never indexed.
4. **Resolution for `(domain, sourceCode)`:**
   - **0** enabled-and-complete matches → **unresolved**.
   - **2+** enabled-and-complete matches → **ambiguous → fail closed**. The resolver **MUST NOT pick the
     first** row. *(This rule also makes the parity test order-independent — preview and Save can never
     diverge on read ordering, because any duplicate fails closed on both sides.)*
   - a matched row missing `fNumber`/`fID` **or** `fName` → **incomplete → unresolved**.
   - **exactly 1** enabled-and-complete match → compose the full object `{FNumber,FName}` /
     `{FID,FName}` and let the existing `applyReferenceShape` pass it through (object-passthrough).
5. **Completeness still gates readiness.** `require-fnumber-fname` / `require-fid-fname` fails closed on
   an unresolved/incomplete reference (surfaced through the existing `missingRequiredFields` /
   `unresolvedReferenceComponents`). **Never Save a half-formed reference.**

All five resolution outcomes are **read-only readiness signals** — the resolver never auto-picks,
mutates, or writes.

## preview ≡ Save parity — the keystone acceptance

- **Invariant:** the resolution runs at a **single shared point** invoked by **both** the preview and
  the Save composition (one resolver, not two copies — mirrors the DF-T1-0 single-composer discipline).
  The resolved per-material object is materialized into the record **upstream of** the shared
  `projectRecordForBody`, so both sides compose it identically. *(The exact injection point is
  confirm-at-impl — the locked requirement is "one shared resolver under byte-parity", not a specific
  call site.)*
- **Test:** **EXTEND** the existing behavioral `k3-save-body-composer.parity.test.cjs` with a
  `from_reference_table` mapping-sheet case: for the same `(sourceRecord, mapping index)`,
  `preview.payload` **deepEqual** the captured adapter Save body — including that the
  unresolved / ambiguous / incomplete **fail-closed dispositions are identical on both sides**.
- **Negative control (required):** the parity test MUST include a control where the preview resolver and
  the Save resolver are **intentionally desynchronized** (e.g. one resolves a `sourceCode` the other
  does not, or returns a different matched row) and the byte-parity assertion **fails** — proving the
  test actually catches resolver divergence rather than passing vacuously. (Consistent with the
  session's negative-control discipline: a guard that can't be made to fail isn't tested.)

## Evidence — values-free

Resolution evidence reports **only** the field + domain + whether a `sourceCode` was present + the error
type (`unresolved` / `ambiguous` / `incomplete-row`). It **never** carries customer values (the
`sourceCode` value, `FNumber`/`FID`/`FName`). Reuses the values-free evidence discipline
(`summarizeFieldProvenance` / `summarizeTemplateForEvidence`).

## Out of scope (gated / deferred)

- ❌ No K3 write change — write scope stays M1; no Submit / Audit / BOM / multi-record / new endpoint.
- ❌ No cross-run cache and no aging/retention policy (retention is its own concern, #1880).
- ❌ No mapping-sheet authoring / import UI (rows are customer-owned tenant data; authoring = T3c).
- ⏳ Confirm-at-impl: the exact source-adapter read call shape + the exact shared injection point.

## Decomposition (each a separate opt-in after this design)

- **T3b-1** — the pure resolver + index (the locked rules above), unit-tested, **latent** (no wiring).
- **T3b-2** — wire the resolver into the shared composition point **and extend the behavioral parity
  test** (the byte-parity-gated moment — its own explicit opt-in, since it changes the composed body).
- **T3c** — mapping-sheet manifest import/export + authoring (schema-only / customer-owned rows).

## Acceptance checklist (the nine locks)

- ☐ mapping sheet bulk read + in-memory index (per-run, **no** cross-run cache)
- ☐ enabled-only
- ☐ blank `sourceCode` ignored
- ☐ 0 match → unresolved
- ☐ 2+ enabled-and-complete → ambiguous **fail-closed** (never pick-first)
- ☐ missing `fNumber`/`fID`/`fName` → unresolved
- ☐ preview ≡ Save **byte-parity** test (extends the existing behavioral parity test with a
  `from_reference_table` case) **+ a negative control: desync the preview vs Save resolver → parity fails**
- ☐ evidence = field / domain / `sourceCode`-presence / error-type only — **no values**
- ☐ no K3 write / Submit / Audit / BOM / multi-record
