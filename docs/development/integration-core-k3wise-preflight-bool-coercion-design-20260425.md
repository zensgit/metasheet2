# K3 WISE Preflight Boolean Coercion Sweep · Design

> Date: 2026-04-25
> Follow-up to: PR #1168 (boundary hardening)
> Scope: Same-class bug audit on the K3 WISE live PoC preflight script

## Problem

PR #1168 introduced `normalizeSafeBoolean()` to fix a class of bugs where customer JSON containing string `"true"` / `"yes"` / `"是"` would slip past `=== true` strict equality checks for `k3Wise.autoSubmit` and `k3Wise.autoAudit` — making the customer think Save-only was on while the script actually treated those flags as not-true.

Reviewer audit after the merge found **the same bug pattern still exists at three additional sites** in the same script:

| Site | Original code | Risk if customer types `"true"` instead of `true` |
|---|---|---|
| `sqlServer.enabled === true` | line 212 | `sqlEnabled = false` → **entire SQL Server validation block is skipped**, including the K3 core-table guard. Customer thinks SQL channel is enabled with safety; script skipped all validation. |
| `sqlServer.writeCoreTables === true` | line 216 | Even with `sqlEnabled` correctly true, `"true"` here would be read as falsy → core-table writes would not be blocked. |
| `bom.enabled === true` | line 223 | `bomEnabled = false` → `bom.productId` requirement check does not fire → BOM PoC runs without product scope. |

This is the most severe of the three (#1) because it cascades — disabling the entire SQL Server validation chain when the customer believed they had enabled it.

## Solution

1. Apply `normalizeSafeBoolean()` to all three sites. One-line change each.
2. Persist normalized values back into the returned `gate` object so downstream consumers (`gate.sqlServer.enabled`, `gate.bom.enabled`, `gate.sqlServer.writeCoreTables`) see canonical `true`/`false` rather than the customer's original input form.
3. Extend `normalizeSafeBoolean()` to accept numeric `0` and `1` — common spreadsheet-export convention. Any other number (including `NaN`/`Infinity`/`2`) throws with a clear message naming the field and the received value.

## Files changed

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
  - `normalizeSafeBoolean()` extended to handle `typeof value === 'number'` with explicit `0`/`1` mapping and `Number.isFinite` guard
  - 3 call sites converted from `=== true` to `normalizeSafeBoolean(...)`
  - Output `gate.sqlServer.{enabled,writeCoreTables}` and `gate.bom.enabled` now hold normalized booleans
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
  - 4 new test cases (1 per fixed site + 1 covering numeric coercion)
- This design doc + matching verification doc

## Acceptance criteria

- [x] `node --test scripts/ops/integration-k3wise-live-poc-preflight.test.mjs` reports 13/13 pass (was 9/9, +4 new)
- [x] String `"true"` for `sqlServer.enabled` triggers `allowedTables` core-table guard
- [x] String `"true"` for `sqlServer.writeCoreTables` triggers core-table guard
- [x] String `"true"` for `bom.enabled` enforces `bom.productId` requirement
- [x] Numeric `1` enables booleans; numeric `0` disables; numeric `2` rejected with clear "0 or 1" message; `NaN` rejected with "finite" message
- [x] Existing 9 tests from PR #1168 unchanged and still pass (no regression)
- [x] No `=== true` checks remaining on customer-supplied boolean fields in the script (downstream `gate.bom.enabled === true` reads are safe because the value is now canonically boolean)

## Out of scope

- The `mode: 'disabled'` UX message refinement (also flagged in review as item #2 — separate minor PR if pursued).
- Sweeping other ops scripts (`integration-k3wise-live-poc-evidence.mjs` etc.) for the same pattern. Reviewer audit limited to the preflight script for this PR.
