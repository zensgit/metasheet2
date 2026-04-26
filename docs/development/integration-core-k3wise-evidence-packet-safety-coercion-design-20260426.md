# K3 WISE Evidence Compiler Packet Safety Coercion · Design

> Date: 2026-04-26
> Picked up from: PR #1175 / #1176 / #1177 "out of scope" lists
> Series: 4th and final audit-style hardening of `integration-k3wise-live-poc-evidence.mjs`

## Problem

`requirePacketSafety()` enforces the live-PoC safety contract (Save-only, no auto-submit/audit, production writes blocked). It uses 4 strict-equality checks:

```javascript
function requirePacketSafety(packet) {
  const safety = asObject(packet.safety, 'packet.safety')
  if (safety.saveOnly !== true || safety.autoSubmit !== false || safety.autoAudit !== false) {
    throw new LivePocEvidenceError('preflight packet must be Save-only with autoSubmit=false and autoAudit=false', { field: 'packet.safety' })
  }
  if (safety.productionWriteBlocked !== true) {
    throw new LivePocEvidenceError('preflight packet must explicitly block production writes', { field: 'packet.safety.productionWriteBlocked' })
  }
}
```

**In the normal flow**, this is safe — preflight generates the packet with hard-coded boolean values (`saveOnly: true`, `autoSubmit: false`, etc.). Strict equality matches.

**The hand-edit edge case**: during incident response, an operator might re-run the evidence compiler against a hand-edited packet (e.g., they tweaked one field for a re-test, or copy-pasted from a markdown table that serialized booleans as strings). If the operator hand-typed `saveOnly: "true"` (string) instead of `saveOnly: true` (boolean), the strict `!== true` check would FAIL with `"preflight packet must be Save-only..."` — a confusing error because the operator *did* say Save-only.

This is the bug class previously addressed for customer evidence inputs in PRs #1175 (bool sweep), #1176 (numeric IDs), #1177 (status synonyms). The packet-safety check was deferred each time as "paranoid hardening, edge case workflow". This PR closes the symmetric gap so all 4 named deferred items from the audit series are now resolved.

## Solution

Coerce all 4 safety fields through the existing `normalizeSafeBoolean()` helper before testing the safety predicates:

```javascript
function requirePacketSafety(packet) {
  const safety = asObject(packet.safety, 'packet.safety')
  const saveOnly = normalizeSafeBoolean(safety.saveOnly, 'packet.safety.saveOnly')
  const autoSubmit = normalizeSafeBoolean(safety.autoSubmit, 'packet.safety.autoSubmit')
  const autoAudit = normalizeSafeBoolean(safety.autoAudit, 'packet.safety.autoAudit')
  if (!saveOnly || autoSubmit || autoAudit) {
    throw new LivePocEvidenceError('preflight packet must be Save-only with autoSubmit=false and autoAudit=false', { field: 'packet.safety' })
  }
  const productionWriteBlocked = normalizeSafeBoolean(safety.productionWriteBlocked, 'packet.safety.productionWriteBlocked')
  if (!productionWriteBlocked) {
    throw new LivePocEvidenceError('preflight packet must explicitly block production writes', { field: 'packet.safety.productionWriteBlocked' })
  }
}
```

Same coercion contract as #1175 (already-existing helper, no duplication, no behavior drift):

| Hand-edited input | Result |
|---|---|
| `true` / `false` (boolean) | passthrough |
| `1` / `0` (number) | true / false |
| `"true"` / `"yes"` / `"是"` / `"启用"` | true |
| `"false"` / `"no"` / `"否"` / `"关闭"` | false |
| `null` / `undefined` / `""` | false (treated as unset → fails Save-only check) |
| `"maybe"` / non-finite number / object / array | throws with field name |

## Why this DOES NOT weaken the safety contract

Coercion only widens the **input surface** — what the script accepts as valid representations of `true`/`false`. The **predicate** is unchanged:

- `saveOnly` must be **truthy** (any of `true`, `1`, `"true"`, `"是"`, etc.). If operator hand-edits to `"false"` or `0`, the safety guard correctly fires.
- `autoSubmit` must be **falsy**. Hand-edited `"true"` / `1` / `"是"` correctly fires the guard.
- `autoAudit` must be **falsy**. Same.
- `productionWriteBlocked` must be **truthy**. Same.

The 8 new tests pin both directions:
- 3 positive-coercion tests (string/numeric/Chinese hand-edits accepted as legitimate Save-only)
- 4 safety-contract preservation tests (truthy hand-edits to autoSubmit/autoAudit and falsy hand-edits to saveOnly/productionWriteBlocked all still fail the guard)
- 1 non-coercible test (`"maybe"` throws with field name, no silent acceptance)

There is **no input value** that previously failed and now passes, where the underlying intent was to bypass safety. Coercion only fixes the case where the operator's intent matched the safety contract but their typing did not match strict equality.

## Files changed

- `scripts/ops/integration-k3wise-live-poc-evidence.mjs` — `requirePacketSafety` uses `normalizeSafeBoolean` for all 4 safety fields (~15 lines net, +inline comment)
- `scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` — 8 new test cases (~80 lines)
- this design doc + matching verification doc

## Acceptance criteria

- [x] `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` reports 31/31 pass (was 23/23, +8 new)
- [x] Hand-edited string `"true"` / numeric `1` / Chinese `"是"` for safety fields are accepted
- [x] Hand-edited string `"false"` / numeric `0` / Chinese `"否"` for `saveOnly` / `productionWriteBlocked` correctly fail the safety guard
- [x] Hand-edited string `"true"` / numeric `1` for `autoSubmit` / `autoAudit` correctly fail the safety guard (auto-submit/audit must remain off)
- [x] Non-coercible values (e.g. `"maybe"`) throw with `packet.safety.<field>` in the error
- [x] All 23 prior tests pass unchanged (no regression)
- [x] No new helper functions added — reuses the existing `normalizeSafeBoolean` from #1175

## Out of scope (audit series complete; remaining items are non-customer-facing)

- **`findSecretLeaks` non-string scanning** — true edge case; tokens are strings in practice. Not worth the dedicated PR cycle.
- **Refactor `normalizeSafeBoolean` / `STATUS_SYNONYMS` into a shared module** — would touch preflight too, collision risk with parallel codex sessions, and the audit-style local-duplication discipline has been intentional for keeping customer-runnable scripts standalone.

After this PR, the K3 WISE Live PoC evidence compiler has been hardened against:
1. Customer-supplied bool strings (#1175)
2. Customer-supplied numeric IDs (#1176)
3. Customer-supplied status synonyms (#1177)
4. Operator hand-edited packet bools (this PR)

The 4 named deferred items from the original PR #1175 design doc are now all resolved.

## Cross-references

- PR #1175 — evidence bool-coercion sweep (introduced `normalizeSafeBoolean`)
- PR #1176 — `text()` numeric ID coercion (commit `d5f1d0613`)
- PR #1177 — `normalizeStatus` synonym map (commit `a60819511`)
- PR #1166 — original evidence compiler ship
- PR #1168 / #1169 — preflight bool-coercion sweep (input side)
