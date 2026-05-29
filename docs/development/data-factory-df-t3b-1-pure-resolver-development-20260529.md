# DF-T3b-1 — pure reference-mapping resolver + index — development verification (2026-05-29)

> First runtime slice of DF-T3b ([#2048](docs/development/data-factory-df-t3b-reference-resolver-design-20260529.md)
> design). **PURE + LATENT**: resolution decision logic only. It is wired to **nothing** — no
> `from_reference_table` runtime, no preview, no Save, no K3 write. Wiring into the shared composition
> path + the byte-parity test is **DF-T3b-2** (a separate, byte-parity-gated opt-in).

## Locked scope (owner-set)

In:
- A new pure module `lib/reference-mapping-resolver.cjs`: build a per-run in-memory index from a DF-T3a
  template (#2043) + the domain's mapping rows, then resolve a `(domain, sourceCode)` to one of four
  outcomes — **resolved / unresolved / ambiguous / incomplete**.
- Unit tests + this verification MD.

Explicitly **out** (DF-T3b-2 / later, separate opt-ins):
- ❌ No `from_reference_table` runtime change, no preview change, no Save change, no K3 write.
- ❌ No wiring into the shared composition path; no parity test (that is the T3b-2 keystone).
- ❌ No bulk-read I/O — the caller supplies rows; this module is pure (no fetch, no cache).

## What shipped

- `plugins/plugin-integration-core/lib/reference-mapping-resolver.cjs` (new):
  - `buildReferenceMappingIndex(template, rows)` → `{ domain, identifier, completeness, buckets }`;
    each bucket = `{ complete: [refObj], incomplete: number }`.
  - `resolveReference(index, sourceCode, { field? })` → `{ status, reference?, evidence }`.
  - `resolveReferenceFromRows(template, rows, sourceCode, opts?)` — build + resolve convenience.
  - `OUTCOME`, `STATUS_TO_ERROR_TYPE`, `__internals`.
- `plugins/plugin-integration-core/__tests__/reference-mapping-resolver.test.cjs` (new).
- `package.json`: added to the `test` chain (after `reference-mapping-templates`) + a
  `test:reference-mapping-resolver` script.

## Resolution rules (the five locks)

1. **enabled-only** — a row is indexed only if `enabled !== false` (an **absent** `enabled` counts as
   enabled). All-disabled rows for a `sourceCode` → `unresolved` (no separate "disabled" outcome).
2. **blank `sourceCode` ignored** — a row with a blank/whitespace `sourceCode` is never indexed.
3. **0** enabled+complete matches → `unresolved`.
4. **2+** enabled+complete matches → `ambiguous`, **fail-closed** — never picks the first, never dedups
   (even byte-identical duplicate rows stay ambiguous; this keeps the T3b-2 parity test
   order-independent).
5. a matched row missing `fNumber`/`fID` **or** `fName` → **incomplete**. With 0 complete + ≥1
   incomplete row → `incomplete`; with **exactly 1** complete row, that row wins even alongside
   incomplete siblings (they lack components and cannot compose).

## Contracts pinned (so T3b-2 can lean on them)

- **Evidence error-type tokens — locked VERBATIM** by #2036 P2 / #2048 line 81:
  `unresolved` / `ambiguous` / **`incomplete-row`**. The internal `status` vocabulary
  (`resolved`/`unresolved`/`ambiguous`/`incomplete`) is **deliberately distinct** from the evidence
  `errorType` — the `incomplete` status maps to the `incomplete-row` token (a `STATUS_TO_ERROR_TYPE`
  map, not `errorType = status`). `resolved` has no `errorType`.
- **`sourceCode` match normalization** = **trimmed + `String`-coerced, CASE-SENSITIVE**, applied
  identically on the index and query sides. Surrounding whitespace still matches; a case-mismatch does
  **not** (no case-folding — a "helpful" lowercase would silently change resolution and break T3b-2
  parity).
- **Value boundary.** `outcome.reference` carries the customer `{FNumber|FID, FName}` (it is the thing
  the caller composes). `outcome.evidence` is **values-free** — only `{ field?, domain,
  sourceCodePresent, errorType? }`; tests assert no customer value (`sourceCode`/`fNumber`/`fID`/`fName`)
  appears in evidence.
- **Deliberate asymmetry:** the `sourceCode` **key** is trimmed for matching, but the reference
  **values** (`row[idCol]` / `row.fName`) are stored **verbatim** — never mangle customer data.
- **Template error vs data outcome.** A malformed template **throws** `ReferenceMappingTemplateError`
  (via `normalizeReferenceMappingTemplate`); only mapping-**row data** conditions return the four
  outcomes. Clean separation, tested both ways.

## Tests + negative controls

`node __tests__/reference-mapping-resolver.test.cjs` → green. Covers all four outcomes, the five rules,
both identifier families (FNumber unit / FID category), the contract error-type tokens, the three
pinned judgment calls (1-complete-wins-over-incomplete-siblings · identical-duplicates-still-ambiguous ·
all-disabled→unresolved), `sourceCode` normalization (whitespace matches / case-mismatch unresolved),
values-free evidence across every non-resolved outcome, template-throws, and index reuse.

Three negative controls (Edit-revert, never `git checkout`):
1. `incomplete` errorType token → `'incomplete'` → the `incomplete-row` assertion + the
   `STATUS_TO_ERROR_TYPE` deepEqual fail (the headline contract-drift guard).
2. ambiguous branch picks the first row → the `ambiguous` assertions fail.
3. `enabled-only` skip removed → the disabled-row-invisible assertion fails.

Siblings unaffected: `reference-mapping-templates`, `k3-save-body-composer.parity`,
`connector-template-derive` green.

## Next (gated, separate opt-in)

- **DF-T3b-2** — wire the resolver into the **single shared composition point** (so preview and Save
  resolve identically) **and extend** the behavioral `k3-save-body-composer.parity.test.cjs` with a
  `from_reference_table` case **including the required desync negative control** (preview vs Save
  resolver intentionally desynchronized → parity fails). This is the byte-parity-gated moment and its
  own explicit opt-in. The exact source-adapter bulk-read call shape + the exact injection point are
  confirm-at-impl per #2048.
