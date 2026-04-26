# K3 WISE Evidence Compiler Numeric ID Coercion · Verification

> Date: 2026-04-26
> Companion: `integration-core-k3wise-evidence-numeric-id-coercion-design-20260426.md`
> Picks up: deferred item from PR #1175 design doc

## Commands run

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
git diff --stat scripts/ops/integration-k3wise-live-poc-evidence.mjs \
                scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

## Result · `node --test`

```
✔ buildEvidenceReport returns PASS for complete Save-only evidence
✔ buildEvidenceReport returns PARTIAL when a required phase is missing
✔ buildEvidenceReport returns FAIL when Save-only row count exceeds PoC limit
✔ buildEvidenceReport returns FAIL when autoAudit appears in Save-only evidence
✔ buildEvidenceReport rejects unredacted secret-like evidence fields
✔ buildEvidenceReport returns FAIL when materialSaveOnly autoSubmit is the string "true"
✔ buildEvidenceReport returns FAIL when materialSaveOnly autoAudit is "yes" / "是" / "on" / "Y"
✔ buildEvidenceReport returns FAIL when bom.legacyPipelineOptionsSourceProductId is the string "true"
✔ buildEvidenceReport returns FAIL when materialSaveOnly autoSubmit is the number 1 (spreadsheet boolean)
✔ buildEvidenceReport accepts the number 0 / string "no" / "否" / "false" as legitimate Save-only confirmation
✔ buildEvidenceReport throws clear errors for non-coercible boolean values
✔ buildEvidenceReport accepts numeric runId / productId from spreadsheet exports
✔ buildEvidenceReport accepts bigint productId for very large external IDs
✔ buildEvidenceReport still rejects NaN / Infinity / object / array / null as missing IDs
✔ buildEvidenceReport accepts numeric runId for materialSaveOnly evidence
✔ CLI writes redacted JSON and Markdown reports

ℹ tests 16
ℹ pass 16
ℹ fail 0
ℹ duration_ms ~54
```

16/16 pass — was 12/12 before (PR #1175 baseline). +4 new tests, 0 regressions.

## New test coverage breakdown (4 added)

| # | Test | What it pins |
|---|---|---|
| 1 | `accepts numeric runId / productId from spreadsheet exports` | Headline fix: `runId: 1234567890` and `productId: 99887766` no longer false-trigger their respective required-field issues. Decision stays PASS. |
| 2 | `accepts bigint productId for very large external IDs` | Edge case: `productId: 9007199254740993n` (above `Number.MAX_SAFE_INTEGER`) works. K3 WISE rarely uses bigints but the customer might JSON-stringify them as bigint via custom serializer. |
| 3 | `still rejects NaN / Infinity / -Infinity / {} / [] / null / undefined / true / false as missing IDs` | Defensive: 9 junk types verified to STILL trigger `BOM_PRODUCT_SCOPE_REQUIRED`. Prevents the coercion from over-accepting and masking real bugs. |
| 4 | `accepts numeric runId for materialSaveOnly evidence (runId: 0)` | Edge case: `runId: 0` is falsy in JS but is a legal identifier in some K3 WISE schemas (auto-increment from 0). Verifies the fix doesn't mistakenly reject 0. |

## Existing test regression check

The 12 prior tests (6 from PR #1166 + 6 from PR #1175) all pass unchanged. The `text()` helper change is **additive**:

- String inputs: unchanged (same trim, same return)
- Number/bigint inputs: previously `''`, now stringified — only relevant where `text()` was being called on numeric customer JSON
- All other types (boolean, object, array, null, undefined, NaN, Infinity): unchanged (still `''`)

The 4 unrelated `text()` callers (lines 70, 106, 112, 137) all receive packet-generated values that are already strings, so the additive number/bigint branch never fires for them. Manually verified by inspection — see design doc table.

## Manual code review checklist

- [x] `text()` change is additive and bounded — only adds new accepting branches for `number` (with `Number.isFinite` guard) and `bigint`, all other return paths unchanged.
- [x] Inline comment explains *why* (spreadsheet exports auto-coerce numerics) and *what stays out* (NaN/Infinity/non-primitives still produce '').
- [x] No `throw` added — `text()` remains a pure best-effort coercion. Callers retain authority over what "empty means error".
- [x] No new dependencies, no schema change, no contract change for the 4 unaffected callers.
- [x] Test for junk-type rejection covers the 9 most likely accidental inputs (NaN, ±Infinity, {}, [], null, undefined, true, false) — comprehensive negative path.
- [x] Test for bigint covers an above-MAX_SAFE_INTEGER value — the only case where a customer would actually *need* bigint serialization.

## Why this PR is small and standalone

PR #1175's design doc explicitly listed `text(bom.productId)` numeric coercion as a deferred item: "Real but lower severity (false positive, not silent pass). Defer." This PR picks it up as the next narrow audit-style fix, mirroring the #1168 → #1169 progression on the preflight side.

The change is intentionally narrow: only `text()` is touched, no other refactors, no new helpers, no expanded scope into `normalizeStatus` synonym maps (which would dilute the "single bug class per PR" discipline that has worked well for this audit series).

## Cross-references

- Design doc: `docs/development/integration-core-k3wise-evidence-numeric-id-coercion-design-20260426.md`
- Predecessor PR: #1175 (evidence bool-coercion sweep — design doc deferred this exact item)
- Symmetric work: #1168 / #1169 (preflight bool-coercion sweep)
- Original ship: #1166 (evidence compiler v1)
