# K3 WISE Evidence Compiler Boolean Coercion Sweep · Verification

> Date: 2026-04-26
> Companion: `integration-core-k3wise-evidence-bool-coercion-design-20260426.md`
> Pattern source: PR #1168 / #1169 (preflight bool-coercion sweep)

## Commands run

```bash
# 1. Run the evidence test suite (must report 12/12 pass)
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs

# 2. Confirm only this PR's files are modified
git status --short
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
✔ CLI writes redacted JSON and Markdown reports

ℹ tests 12
ℹ pass 12
ℹ fail 0
ℹ duration_ms ~52
```

12/12 pass. The previous 6 tests (PR #1166 baseline) remain unchanged; the 6 new tests cover the bool-coercion sweep.

## New test coverage breakdown (6 added)

| # | Test | What it pins |
|---|---|---|
| 1 | `materialSaveOnly autoSubmit is the string "true"` | The original bug — `=== true` would silently let this PASS. Now raises `SAVE_ONLY_VIOLATED`. |
| 2 | `materialSaveOnly autoAudit is "yes" / "是" / "on" / "Y"` | Covers the 4 most likely customer variants (English yes, Chinese 是, English on, capitalized Y). All raise `SAVE_ONLY_VIOLATED`. |
| 3 | `bom.legacyPipelineOptionsSourceProductId is the string "true"` | Same bug, second site. Now raises `LEGACY_BOM_PRODUCT_ID_USED`. |
| 4 | `materialSaveOnly autoSubmit is the number 1` | Spreadsheet exports often coerce booleans to 0/1; covered. |
| 5 | `false-like values are accepted` (`0`, `"no"`, `"否"`, `"false"`, `"off"`) | Confirms the safety check **does not** false-positive on legitimate Save-only confirmation. Save-only is the central safety contract; over-triggering would erode trust in the evidence compiler. |
| 6 | Non-coercible values throw with clear errors | `"maybe"` → field name. `2` → `0 or 1` message. `NaN` → `finite` message. Failing loud is correct here — silent acceptance is what we're trying to fix. |

## Existing test regression check

The 6 PR #1166 tests still pass unchanged:

1. PASS for complete Save-only evidence ✓
2. PARTIAL when required phase is missing ✓
3. FAIL when row count exceeds PoC limit ✓
4. FAIL when `autoAudit === true` (boolean) ✓ — confirms passthrough still works for proper booleans
5. Rejects unredacted secret leaks ✓
6. CLI writes redacted JSON + Markdown ✓

No regression. The `normalizeSafeBoolean` helper is **additive** for the boolean-passthrough case — `true`/`false` go through unchanged, so the original test that uses `autoAudit = true` still raises `SAVE_ONLY_VIOLATED` exactly as before.

## Manual code review checklist

- [x] `normalizeSafeBoolean` is **identical in contract** to the preflight version — TRUE_BOOLEAN_TEXT / FALSE_BOOLEAN_TEXT sets, throw shapes, error messages all match. Customer-runnable scripts stay standalone (no shared import) by design — same discipline as preflight.
- [x] Both bug sites converted: `evaluateMaterialSaveOnly` (autoSubmit + autoAudit) and `evaluateBom` (legacyPipelineOptionsSourceProductId).
- [x] `requirePacketSafety` strict equality at lines 94-96 left intact — reads from preflight-canonicalized packet, not customer hand-edit. Documented as out-of-scope in design doc.
- [x] `normalizeStatus`, `text(bom.productId)` numeric, `findSecretLeaks` non-string children — all unchanged, all documented as out-of-scope (low ROI, lower severity).
- [x] No new dependencies, no behavior change for existing callers, no schema change.
- [x] Error messages include the field name (e.g. `materialSaveOnly.autoSubmit`) so a customer running the script can fix their JSON without our help.
- [x] `LivePocEvidenceError` carries `details.field` — already an existing test pattern (line 64 in test file), so our new tests use the same assertion shape.

## Why this PR closes the symmetric gap

Customer JSON enters the live PoC twice:

1. **GATE answers JSON → preflight script** (input side) — already hardened in #1168 / #1169.
2. **Evidence JSON → evidence compiler** (output side) — this PR.

If only the input side coerces booleans, a customer who hand-edits the post-run evidence to type `"true"` (because their spreadsheet, IME, or form tool serializes that way) would receive a **PASS** on a run where Save-only was actually violated. That is the most dangerous false positive in the whole live PoC: the evidence compiler is the gate between PoC and M3 UI build-out. A silent PASS on a violated Save-only run leaks into real K3 WISE writes downstream.

After this PR, both sides apply the same coercion contract, and the same 6-bug-class regression net guards both scripts.

## Cross-references

- Design doc: `docs/development/integration-core-k3wise-evidence-bool-coercion-design-20260426.md`
- Preflight design: `docs/development/integration-core-k3wise-live-poc-preflight-design-20260425.md`
- Preflight bool-coercion sweep verification: `docs/development/integration-core-k3wise-preflight-bool-coercion-verification-20260425.md` (PR #1169)
- PR #1166 (original evidence compiler ship)
- PR #1168 (preflight boundary hardening — introduced `normalizeSafeBoolean`)
- PR #1169 (preflight bool-coercion sweep — full coverage of input side)
