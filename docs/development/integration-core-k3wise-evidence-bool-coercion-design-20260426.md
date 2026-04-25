# K3 WISE Evidence Compiler Boolean Coercion Sweep · Design

> Date: 2026-04-26
> Trigger: post-merge audit during K3 customer answer wait period
> Pattern: same bug class as preflight script's PR #1168 / #1169 — `=== true` strict equality on customer-supplied JSON booleans
> Companion: this PR is the evidence-compiler counterpart of the preflight bool-coercion sweep

## Problem

PR #1166 shipped `scripts/ops/integration-k3wise-live-poc-evidence.mjs` (the K3 WISE Live PoC PASS / PARTIAL / FAIL evidence compiler). It validates customer-supplied evidence JSON to make a deploy/no-deploy call after the live test.

Two checks use **strict `=== true` equality** against fields the customer fills in by hand (often via spreadsheet export, Chinese form tools, or partial JSON edits):

| Site | Original code | Risk if customer types `"true"` instead of `true` |
|---|---|---|
| `evaluateMaterialSaveOnly` | `if (save.autoSubmit === true \|\| save.autoAudit === true)` | The `SAVE_ONLY_VIOLATED` issue is NOT raised. The compiler returns PASS even though the customer's actual K3 run had auto-submit / auto-audit enabled — the **most dangerous false positive** because Save-only is the central safety contract of the live PoC. |
| `evaluateBom` | `if (bom.legacyPipelineOptionsSourceProductId === true)` | The `LEGACY_BOM_PRODUCT_ID_USED` issue is NOT raised. Customers using the deprecated `pipeline.options.source.productId` path (instead of `bom.productId` / `plm.defaultProductId`) would not be flagged. |

This is the **identical bug pattern** previously fixed in:
- PR #1168 — boundary hardening for `k3Wise.autoSubmit / autoAudit` strings
- PR #1169 — sweep for `sqlServer.enabled`, `sqlServer.writeCoreTables`, `bom.enabled`

The preflight script (input side) is now hardened. The evidence script (output side) was missed in those sweeps. Customer JSON enters BOTH:

```
GATE answers JSON → preflight script → execution packet (hardened ✅)
                         ↓
               customer runs live PoC
                         ↓
              evidence JSON → evidence compiler → PASS/PARTIAL/FAIL
                                  ↑
                         this PR closes this gap
```

## Solution

Mirror the same `normalizeSafeBoolean()` helper and same intercepts that `#1169` applied to preflight, scoped to the two affected sites.

1. Add a **local** `normalizeSafeBoolean(value, field)` in `evidence.mjs` (intentional duplication: keeps the customer-runnable script free of cross-file imports; matches preflight's same pattern).
2. Replace `save.autoSubmit === true || save.autoAudit === true` with `normalizeSafeBoolean(save.autoSubmit, 'materialSaveOnly.autoSubmit') || normalizeSafeBoolean(save.autoAudit, 'materialSaveOnly.autoAudit')`.
3. Replace `bom.legacyPipelineOptionsSourceProductId === true` with `normalizeSafeBoolean(bom.legacyPipelineOptionsSourceProductId, 'bomPoC.legacyPipelineOptionsSourceProductId')`.

Coercion contract (identical to preflight's, copied for parity):

| Input | Result |
|---|---|
| `true` / `false` (boolean) | passthrough |
| `1` / `0` (finite number) | `true` / `false` |
| Any other finite number (e.g. `2`) | throws with field name + received value, message contains `0 or 1` |
| `NaN` / `Infinity` | throws with `finite` in the message |
| `"true"` / `"yes"` / `"y"` / `"on"` / `"1"` / `"是"` / `"启用"` / `"开启"` | `true` |
| `"false"` / `"no"` / `"n"` / `"off"` / `"0"` / `"否"` / `"禁用"` / `"关闭"` | `false` |
| `null` / `undefined` / `""` | `false` (treated as not-set) |
| Any other string (e.g. `"maybe"`) | throws with field name |
| Other types (object, array) | throws with field name |

## Files changed

- `scripts/ops/integration-k3wise-live-poc-evidence.mjs` — `normalizeSafeBoolean` helper added; 2 call sites converted (~25 lines added)
- `scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` — 6 new test cases (~80 lines added)
- this design doc + matching verification doc

## Acceptance criteria

- [x] `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` reports 12/12 pass (was 6/6, +6 new)
- [x] String `"true"` for `materialSaveOnly.autoSubmit` raises `SAVE_ONLY_VIOLATED`
- [x] String `"yes"` / `"是"` / `"on"` / `"Y"` for `materialSaveOnly.autoAudit` raises `SAVE_ONLY_VIOLATED`
- [x] String `"true"` for `bomPoC.legacyPipelineOptionsSourceProductId` raises `LEGACY_BOM_PRODUCT_ID_USED`
- [x] Number `1` for `materialSaveOnly.autoSubmit` raises `SAVE_ONLY_VIOLATED`
- [x] False-like values (`0`, `"no"`, `"否"`, `"false"`, `"off"`) are accepted as legitimate Save-only confirmation (do NOT raise the issue)
- [x] Non-coercible values (`"maybe"`, `2`, `NaN`) throw with clear field-named error messages
- [x] Existing 6 tests from PR #1166 unchanged and still pass (no regression)

## Out of scope

Not pursued in this PR (would dilute the focused fix scope, same discipline as the preflight sweep):

- **`requirePacketSafety` strict booleans** at lines 94-96 (`safety.saveOnly !== true || safety.autoSubmit !== false`). These read from the preflight-generated packet, which already canonicalizes booleans before output. Strict equality is safe IF the customer doesn't hand-edit the packet; if hand-editing is a concern, that's a separate paranoid hardening pass.
- **`text(bom.productId)` rejecting numeric productId**. Customer might supply `productId: 12345` (number) and trigger a false-positive `BOM_PRODUCT_SCOPE_REQUIRED`. Real but lower severity (false positive, not silent pass). Defer.
- **`normalizeStatus` defaulting `"passed"` / `"成功"` to `'todo'`**. Localization / synonym ergonomics, not safety. Defer.
- **`findSecretLeaks` only checks string children**. Numeric secret values would be missed. Edge case, low ROI.
- **Refactor `normalizeSafeBoolean` into a shared helper module**. Would touch preflight too; collision risk with future Codex work. The intentional local duplication keeps the customer-runnable scripts standalone.

## Cross-references

- PR #1168 — preflight boundary hardening (introduced `normalizeSafeBoolean` for preflight)
- PR #1169 — preflight bool-coercion sweep (covered remaining `=== true` sites in preflight)
- PR #1166 — original evidence compiler ship
- This PR — evidence compiler bool-coercion sweep (closes the symmetric gap)
