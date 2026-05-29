# DF-T3b-2a — resolver wire into target preview + resolved-record schema parity + three-state fail-closed — development verification (2026-05-29)

> Second slice of DF-T3b ([#2048](docs/development/data-factory-df-t3b-reference-resolver-design-20260529.md)
> design; resolver = #2055). Wires the T3b-1 pure resolver into the composed Save body and locks
> **preview ≡ Save byte-parity** for a `from_reference_table` reference. The live mapping-sheet
> bulk-read / fuller pipeline wiring is **DF-T3b-2b** (a separate opt-in).

## Locked scope (owner-set)

In:
- **Resolver wire into the target preview** — `from_reference_table` in `buildTargetPayloadPreview`
  (the operator/DF-T2c surface) now resolves a per-material reference via an injected mapping index
  instead of the old uniform `raw = rule.value` scalar (the #1824 limit).
- **Resolved-record schema parity** — a shared step materializes the resolved reference INTO the
  record; the parity test proves it composes **byte-identically** through the schema-path preview and
  the real adapter Save.
- **Three-state fail-closed** — `unresolved` / `ambiguous` / `incomplete` all block both compose paths
  via the single `status !== 'resolved'` gate.

Explicitly **out** (DF-T3b-2b / later):
- ❌ No live source-adapter bulk-read (indexes are injected; the route does **not** source them yet).
- ❌ No fuller pipeline wiring; ❌ no K3 write / Submit / Audit / BOM / multi-record; ❌ no UI /
  authoring / import / export; ❌ no frontend change.

## Architecture decisions (grounded, owner-confirmed)

- **Option (a) + single-representation.** The resolved `{FNumber|FName}` / `{FID|FName}` **rides in the
  record** and flows through the **existing** preset schema untouched (`applyReferenceShape` passes
  objects through) — **no new schema descriptor**, avoiding the dual-representation drift DF-T1-0 was
  built to kill.
- **The operator surface is `buildTargetPayloadPreview` (fieldRules path), not the schema path** the
  named parity test exercises. Wiring resolution only into the schema path would pass the named test
  while the operator preview never resolved (wire-vs-fixture trap) — so `buildTargetPayloadPreview`
  is wired **and** has its own direct tests (`http-routes.test.cjs`).
- **Fail-closed = a placeholder sentinel, not a drop.** The schema-path preview does pure projection
  with **no bodyTemplate**, and the adapter Save only throws on `findUnfilledPlaceholders` (an absent
  field is silently omitted). So a *dropped* field would NOT fail-close either side. Instead a
  non-resolved status sets the target field to `UNRESOLVED_PLACEHOLDER = '<unresolved>'` (a bare `<…>`
  token) → `findUnfilledPlaceholders` fires on **both** sides with the same
  `K3_WISE_PRESET_PLACEHOLDER_UNFILLED` code → **identical disposition** (preview `valid:false`, Save
  throws). Reuses the existing machinery; no parallel error channel.

## What shipped

- `lib/reference-mapping-resolver.cjs` (T3b-1 module, extended):
  - `UNRESOLVED_PLACEHOLDER` (exported sentinel constant).
  - `resolveReferenceRuleValue(indexes, rule, sourceCode)` → `{ value, outcome }` — the **single
    shared per-field decision** called by BOTH `buildTargetPayloadPreview` and the record materializer,
    so the two surfaces cannot diverge on the composed value. `value` = the resolved object on
    `resolved`, else `UNRESOLVED_PLACEHOLDER`.
  - `resolveReferenceRulesIntoRecord(record, rules, indexes)` → `{ record, outcomes }` — materializes
    the resolved object (or sentinel) into a record; pure, reads `sourceField` / writes `targetField`
    via **`getPath`/`setPath`** — the SAME path semantics the operator preview uses (see P1 below).
- `lib/http-routes.cjs`:
  - `normalizeFieldRules` accepts an optional `domain` (selects the mapping index for a
    `from_reference_table` rule).
  - `buildTemplatePreview` / `buildTargetPayloadPreview` accept a **server-side `options` param**
    (`options.referenceMappingIndexes`) — indexes are NOT read from the client body (un-injectable).
  - `from_reference_table` resolves via the shared `resolveReferenceRuleValue`; non-resolved →
    sentinel → fail-closed; a **values-free** `referenceResolutions` evidence array
    (`field`/`domain`/`sourceCodePresent`/`errorType`) is added to `targetPayloadPreview`.
- Tests: `reference-mapping-resolver.test.cjs` (+ materializer / shared-fn / 3-state), the keystone
  `k3-save-body-composer.parity.test.cjs` (+ resolved-record parity + 3-state fail-closed + desync),
  `http-routes.test.cjs` (+ operator-surface resolution).

## `from_reference_table` semantics change — safe

Changed from "pre-resolved scalar (`raw = rule.value`)" to "resolve via mapping index". Verified **zero
scalar-dependent producers** exist (`rg from_reference_table`): it was only the enum membership, the
`raw = rule.value` line, a TS union, and comments. The DF-T2 authoring UI uses `preserve_template` for
references and never emits `from_reference_table`, so nothing relied on the old behavior.

## Tests + negative controls

Parity (the keystone) has **two regimes**, mirroring `testPlaceholderParity`:
- **resolved** → `deepEqual(preview.payload, capturedAdapterSaveBody)` (byte-parity).
- **non-resolved** (all 3) → the Save *throws* (no body) so we assert identical **disposition**:
  preview `valid:false` + adapter `upsert` errors `K3_WISE_PRESET_PLACEHOLDER_UNFILLED`.

Negative controls:
1. **Wire** (Edit-revert) — make `buildTargetPayloadPreview` ignore the injected index → the operator
   resolve test fails (proves the wire is load-bearing, not green-but-absent).
2. **Sentinel** (Edit-revert) — set `UNRESOLVED_PLACEHOLDER = ''` (≈ a drop) → the fail-closed
   assertions break on BOTH the parity test and the operator preview (proves the sentinel — not a drop
   — is what fail-closes both sides).
3. **Desync** (permanent test) — resolve the two sides with different indexes → `notDeepEqual` (proves
   the byte-parity assertion catches a preview/Save resolver divergence; not vacuous).
4. **Nested sourceField** (Edit-revert) — revert the materializer read to flat `out[sourceField]` → the
   nested-sourceField test fails (proves the path-semantics fix below is load-bearing).
5. **Overlap read-snapshot** (Edit-revert) — revert the materializer read to `getPath(out, …)` (the
   mutated record) → the overlap tests (resolver-level + cross-path) fail (proves the read-snapshot fix).

## P1 (owner review) — fixed: sourceField extraction divergence

The shared **decision** (`resolveReferenceRuleValue`) was shared, but the **sourceCode extraction**
before it was not: the operator preview read `getPath(input.sourceRecord, rule.sourceField)` (nested)
while the materializer read flat `out[sourceField]`. A nested `sourceField` (e.g. `source.unitGroup`)
therefore resolved in the preview but **sentinel'd** in the materializer — a latent preview-green /
Save-fail-closed divergence that would surface when T3b-2b wires the Save side. Fixed by reading
`sourceField` / writing `targetField` through `getPath`/`setPath` in `resolveReferenceRulesIntoRecord`
— identical path semantics on both surfaces. A permanent cross-path test (`testNestedSourceFieldNoDivergence`)
asserts the preview path and the materializer resolve the **same** object for a nested `sourceField`,
so "the shared decision cannot diverge" is now genuinely closed (extraction + decision).

## P2 (owner review) — fixed: read-snapshot divergence on overlapping rules

Same class as P1, one level deeper. The materializer read its source from `out` — which **earlier rules
rewrite** — while the operator preview always reads the **original** `input.sourceRecord`. So overlapping
source/target rules diverged (repro: rule 1 `targetField:'source.unitGroup'` writes the path rule 2
reads → preview `resolved`, materializer `unresolved`). Fixed: `resolveReferenceRulesIntoRecord` now
reads every `sourceField` from the **original record snapshot** and writes to an **independent deep
clone** (`out` no longer shares mutable refs with the read source, so a nested overlapping write can't
corrupt a later read — and the input record is never mutated). Locked by a resolver-level overlap test
(both rules resolve + input unmutated) and a cross-path `testSourceTargetOverlapNoDivergence`
(preview ≡ materializer with overlapping rules). **Invariant: read snapshot = original `sourceRecord`;
write = materialized `out`.**

Affected + adjacent suites green: `reference-mapping-resolver`, `reference-mapping-templates`,
`k3-save-body-composer.parity`, `http-routes`, `k3-df-t1-target-payload-preview`,
`connector-template-derive`, `payload-redaction`, `k3-wise-adapters`, `http-routes-plm-k3wise-poc`,
`e2e-plm-k3wise-writeback`, `adapter-contracts`.

## Next (gated, separate opt-in)

- **DF-T3b-2b** — source the mapping indexes from a **live mapping-sheet bulk-read** via the staging
  source-adapter (the injection seam `options.referenceMappingIndexes` is shaped to be populated, not
  replaced) + the fuller pipeline wiring so the resolver feeds the real Save end-to-end. Exact read
  call shape per #2048 (confirm-at-impl).
