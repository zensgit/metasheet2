# K3 WISE Evidence Compiler Numeric ID Coercion · Design

> Date: 2026-04-26
> Picked up from: PR #1175's "out of scope" list (`text(bom.productId)` numeric handling)
> Related: PR #1175 (evidence bool-coercion sweep), PR #1168 / #1169 (preflight bool-coercion sweep)

## Problem

The evidence compiler's `text(value)` helper currently returns `''` for any non-string value:

```javascript
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}
```

That breaks two customer-supplied identifier fields when the customer's evidence JSON exports them as numbers (a very common pattern when evidence is built from spreadsheets, K3 WISE WebAPI raw responses, or partial JSON edits):

| Site | Customer input | Current behavior | Desired behavior |
|---|---|---|---|
| `evaluateBom`: `if (!text(bom.productId))` | `productId: 12345` (number) | `text(12345)` returns `''` → false-positive `BOM_PRODUCT_SCOPE_REQUIRED` even though productId is set | Treat finite numbers as the customer's identifier; only raise the issue when productId is genuinely missing |
| `evaluateMaterialSaveOnly`: `if (!text(save.runId))` | `runId: 1234567890` (number) | `text(1234567890)` returns `''` → false-positive `SAVE_ONLY_RUN_ID_REQUIRED` | Same — accept numeric run identifiers |

Why this matters: a false positive on `BOM_PRODUCT_SCOPE_REQUIRED` flips the report from PASS to PARTIAL/FAIL on a successful BOM PoC. The customer-facing decision changes (PASS vs PARTIAL gates M3 UI build-out). It is not a *silent pass on a violated run* (that was the bool-coercion bug class), but it is an incorrect FAIL that erodes trust in the compiler.

## Solution

Generalize `text(value)` to accept finite numbers and bigints as identifier text, while keeping the safe-empty fallback for arrays / objects / booleans / NaN / Infinity / null / undefined:

```javascript
function text(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'bigint') return String(value)
  return ''
}
```

This is **additive**:
- Existing string callers behave unchanged.
- Numbers and bigints now produce useful text (the stringified form).
- Junk inputs (booleans, NaN, Infinity, objects, arrays, null, undefined) still produce `''`, so the "missing required field" checks remain authoritative for genuine errors.

### Affected call sites (all 6 callers benefit; 2 fix real bugs, 4 are no-op safe)

| Line | Caller | Was | Now |
|---|---|---|---|
| 70 | `normalizeStatus(text(value).toLowerCase())` | numeric → '' → 'todo' | numeric → "1" → 'todo' (still 'todo' — no behavior change) |
| 106 | `text(pipeline.sourceObject).toLowerCase() === 'bom'` | packet field, always string | unchanged |
| 112 | `text(system.kind).toLowerCase() === 'erp:k3-wise-sqlserver'` | packet field, always string | unchanged |
| 137 | `text(source.evidence \|\| ... \|\| source.runId \|\| ...)` | numeric runId in OR chain skipped (0 falsy), other numerics returned `''` | numeric values now return their string form |
| 179 | `if (!text(save.runId))` | **bug**: numeric runId triggered false `SAVE_ONLY_RUN_ID_REQUIRED` | **fixed**: numeric runId works |
| 191 | `if (!text(bom.productId))` | **bug**: numeric productId triggered false `BOM_PRODUCT_SCOPE_REQUIRED` | **fixed**: numeric productId works |

## Files changed

- `scripts/ops/integration-k3wise-live-poc-evidence.mjs` — `text()` helper extended (~5 lines added, +inline comment)
- `scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` — 4 new test cases (~50 lines added)
- this design doc + matching verification doc

## Acceptance criteria

- [x] `node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs` reports 16/16 pass (was 12/12, +4 new)
- [x] Numeric `productId` (e.g. `12345`) does NOT raise `BOM_PRODUCT_SCOPE_REQUIRED`
- [x] Numeric `runId` (e.g. `1234567890`) does NOT raise `SAVE_ONLY_RUN_ID_REQUIRED`
- [x] BigInt `productId` (e.g. `9007199254740993n`) is accepted (rare but legal)
- [x] `runId: 0` is accepted (legitimate edge case — 0 is a valid identifier in some K3 WISE schemas)
- [x] `NaN` / `Infinity` / `-Infinity` / `{}` / `[]` / `null` / `undefined` / `true` / `false` for `productId` STILL raise `BOM_PRODUCT_SCOPE_REQUIRED` (genuine errors not masked)
- [x] Existing 12 tests from PR #1166 + PR #1175 unchanged and still pass (no regression)
- [x] No new error paths introduced — `text()` remains a pure best-effort coercion (no throws)

## Why no `throw` for junk types?

`text()` is used in 6 call sites. Some are conditional checks (`if (!text(...))`), some feed into `.toLowerCase()` chains, some are in OR fallback expressions. Throwing from inside `text()` would propagate to all of them and break the existing "required field check returns true" pattern. The compiler's existing convention is: `text()` returns the safe-empty value, and the caller decides whether emptiness is an error. We preserve that convention.

For *boolean* fields the bug class was different — silent acceptance of `"true"` strings would mask a Save-only violation. There, throwing on junk was the right call (PR #1175). For *identifier text*, throwing would be over-strict and would block the simple "is this field set?" check that all 6 callers rely on.

## Out of scope

Same discipline as PR #1175 — explicit deferrals so the next PR has a clear starting point:

- **`normalizeStatus` synonym map** — Customer might write `"passed"` / `"成功"` / `"completed"` and have the phase silently default to `'todo'`. UX-impacting (false PARTIAL on completed phases) but not safety-critical. Defer to a focused "evidence status synonym ergonomics" PR.
- **`requirePacketSafety` strict equality** at lines 94-96 — reads from preflight-canonicalized packet, safe IF customer doesn't hand-edit the packet. Paranoid hardening, defer.
- **`findSecretLeaks` non-string scanning** — numeric secret values would be missed in the leak scanner. Edge case (tokens are strings in practice), low ROI.
- **Refactor `text()` into a shared helper module** — would touch preflight too, collision risk with parallel codex sessions, kept local on purpose.

## Cross-references

- PR #1175 — evidence bool-coercion sweep (this PR's predecessor; its design doc deferred this exact item)
- PR #1166 — original evidence compiler ship
- PR #1168 / #1169 — preflight boundary hardening + bool-coercion sweep (input side)
