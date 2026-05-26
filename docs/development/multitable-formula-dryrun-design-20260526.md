# Multitable Formula Dry-Run Diagnostics — Scout + Design (2026-05-26)

**Status: docs-only scout/design. No implementation in this slice.**
benchmark v2 §9 **#5** (Formula dry-run diagnostics). Let a user **evaluate an unsaved formula expression against test data** before saving, to catch errors the existing static checks can't (runtime/semantic). Mirrors the #1849 design template (boundaries + shapes, not mechanics).

> **K3 precedence:** the formula **engine core is shared with the attendance module and is FROZEN** under [[k3-poc-stage1-lock]]. This design is **additive-only on the multitable side** — a new multitable endpoint + a new method on the multitable *wrapper*, calling the existing engine read-only. It touches **no** shared core, attendance, rbac, or integration-core. If K3 has any action, this track yields.

---

## 1. Scout findings (ground truth, 2026-05-26)

| # | finding | source |
|---|---|---|
| Engine: shared core | `FormulaEngine.calculate(formula, context)` parses → evaluates an AST; ~60 built-ins. **Shared with attendance → FROZEN.** | `packages/core-backend/src/formula/engine.ts:238` |
| Engine: multitable wrapper (EDITABLE) | `MultitableFormulaEngine.evaluateField(expr, recordData, fields)` — substitutes `{fldId}` from the **passed-in `recordData`**, then `engine.calculate('='+resolved, ctx)`. | `packages/core-backend/src/multitable/formula-engine.ts:49` |
| `evaluateField`: `{fldId}` refs are in-memory — **but the engine still has a default DB** | `{fldId}` refs are pre-substituted from the supplied `recordData` (in-memory). **BUT** the wrapper constructs `new FormulaEngine({ db: undefined as any })` and the core does `this.db = options.db ?? defaultDb` → **falls back to the real default DB**. So **A1/cell + `A1:B3` range refs would resolve via DB** (the `cells` table). Eval is in-memory **only if the expression is restricted to `{fldId}` refs** (no A1/range). | `formula-engine.ts:20-21`; `engine.ts:136-138`, `:279-299`, `:717-735` |
| Cross-table `lookup` is SEPARATE + not used by formula | `MultitableFormulaEngine.lookup` is a raw `SELECT … FROM meta_records` (and **bypasses field/D3c permissions**) — but it is **not called by `evaluateField`**. Cross-table lookups are the `lookup`/`rollup` *field types*, not the `formula` type. (This is a different path from the array functions VLOOKUP/HLOOKUP/INDEX/MATCH, which operate on in-formula ranges.) | `formula-engine.ts:83` |
| Error surface = heterogeneous | Engine **returns Excel-style sentinels** (`#ERROR!` `#DIV/0!` `#N/A` `#VALUE!`) AND **throws** in places (`Unknown function/operator/node`, `Invalid cell reference`); `calculate` has a top-level catch converting most throws → `#ERROR!`. | `engine.ts:252,268,662,701,800` |
| Existing diagnostics = **client-side static** (not eval) | `validateFormulaExpression(expr, fields, isZh)` runs **parse-time/static** checks only (bracket/quote balance, trailing operator, arity, unknown-field warning) — no evaluation, no server round-trip. **Actually ~12 checks, not the "15" §9 claims** (8 syntax + 3 arity + 1 empty-warning + 3 semantic warnings). | `apps/web/src/multitable/utils/formula-docs.ts:627,904,938` |
| Field editor wiring | `MetaFieldManager.vue` shows live static diagnostics + disables Save on any `severity==='error'`. Formula field `property = { expression }`. | `MetaFieldManager.vue:161-231,1048` |
| **No formula validate/preview endpoint exists** | grep `/formula/validate`, `/formula/preview` → none. | (absence) |
| Pattern to mirror | Automation **test-run**: `POST …/automations/:ruleId/test` builds a **synthetic** payload and runs the executor read-only, returning an execution result. | `routes/automation.ts:50,671` |

**Consequence:** the new value of "dry-run" is **real evaluation** (runtime/semantic errors, type coercion outcomes) which the client's static checks can't produce, and which **requires the backend engine**. That evaluation is in-memory with **zero data-access surface only if dry-run restricts the expression to `{fldId}` references** — A1/cell/range refs (and the DB-backed cross-table `lookup` path) must be rejected *before* eval (§3.3). The "no DB access" property is therefore something the design must **enforce and prove**, not assume.

---

## 2. The additive boundary (the analog of #1849's fast/slow line)

Dry-run is **one new multitable endpoint + one new wrapper method**, and a hard rule on where classification lives:

- **New endpoint** `POST /api/multitable/sheets/:sheetId/formula/dry-run` (multitable route surface; editable).
- **New wrapper method** on `MultitableFormulaEngine` (editable), e.g. `dryRun(expression, sampleValues, fields) → { result, diagnostics }`. It runs **pre-eval gates** (§3.3: reference-existence + supported-reference-shape), and only if they pass calls the existing `evaluateField` and **classifies the outcome**.
- **NEVER touch `formula/engine.ts`** (frozen, shared with attendance).
- **#5a injects a no-DB engine** (`new FormulaEngine({ db: <spy that throws/counts> })`) and asserts the DB-query count is **0** — turning "in-memory, no data access" from an assumption into a tested invariant.

### 2.1 Classification rule (the single place additive-only can quietly drift into the core)

The wrapper classifies on **what the core already exposes** — never by adding error codes to the core:

| core output | dry-run disposition |
|---|---|
| a normal value (number/string/bool/date) | `success`, with `result` + `resultType` |
| an Excel-style sentinel (`#DIV/0!` `#N/A` `#VALUE!` `#NAME?` `#ERROR!`) | diagnostic `kind: 'runtime'`, `code` = the sentinel (these are stable, documented) |
| a thrown `Error` that escapes `calculate` | wrapper's own `try/catch` → diagnostic `kind: 'runtime'`, `code: 'THROWN'`, `message` = raw error message |

**Locked:** anything finer-grained than the sentinel/thrown distinction is a `runtime` diagnostic carrying the **raw message** — we do **not** parse error-message text into typed codes (fragile) and we do **not** "just add a code to the core throw" (frozen-core violation).

---

## 3. The locks

### 3.1 Endpoint shape (LOCKED)

Unlike #4-3b-1 (which read *persisted* view config), dry-run is inherently **ad-hoc** — you are testing an **unsaved** expression — so it is a `POST` carrying the expression + sample values in the body (nothing persisted):

```jsonc
// POST /api/multitable/sheets/:sheetId/formula/dry-run
// request
{
  "expression": "=ROUND({fld_price} * (1 + {fld_taxRate}), 2)",
  "sampleValues": { "fld_price": 100, "fld_taxRate": 0.08 }   // user-supplied; keyed by referenced fieldId
}
// response (success)
{ "ok": true, "data": {
    "success": true,
    "result": 108,
    "resultType": "number",                      // number | string | boolean | date | null
    "referencedFields": ["fld_price", "fld_taxRate"],   // from extractFieldReferences (echo, drives the UI form)
    "diagnostics": []
} }
// response (eval produced an error sentinel)
{ "ok": true, "data": {
    "success": false,
    "result": "#DIV/0!",
    "diagnostics": [ { "severity": "error", "kind": "runtime", "code": "#DIV/0!", "message": "Division by zero" } ]
} }
// response (pre-eval gate failed → NOT evaluated, so no false-green)
{ "ok": true, "data": {
    "success": false,
    "diagnostics": [
      { "severity": "error", "kind": "unknown_field", "message": "Unknown field reference: {fld_missing}" },
      { "severity": "error", "kind": "unsupported", "message": "Cell/range references (e.g. A1, A1:B3) are not supported in dry-run" }
    ]
} }
```

- `sheetId` in the path scopes capability (§3.3) and lets the server load `fields` (for type info + `extractFieldReferences`). The **field need not exist** (the expression is unsaved).
- HTTP status: `200` even when `success:false` (a runtime error is a *successful dry-run that found a problem*, not a transport error). `400` only for a malformed request (missing expression); `403` for capability; `413`/`422` for bounds (§3.3).

### 3.2 Sample-data contract + NO silent coercion (LOCKED)

- `sampleValues: Record<fieldId, rawValue>` — user-supplied, one per referenced field. The UI derives the field list from `extractFieldReferences(expression)` and renders a **type-appropriate input** per field (number input for `number`, etc.), so values usually arrive correctly typed.
- **No silent coercion.** `evaluateField` already coerces (`null→'0'`, string→quoted, etc.); dry-run's *job* is to catch mismatches, so when a supplied value's JS type disagrees with the field's declared `type` (e.g. a string `"3"` for a `number` field), the server emits a **`kind: 'type_mismatch'` warning diagnostic** AND still evaluates (so the user sees both the warning and the coerced outcome). Silent coercion would defeat the feature.
- Missing sample value for a referenced field → `evaluateField`'s `null→'0'` applies; dry-run emits an **`info` diagnostic** ("no sample value for {field}; treated as empty") so the result isn't silently misleading.

### 3.3 Security / scope (LOCKED)

Two **pre-eval gates** run in the wrapper BEFORE any `evaluateField` call. If either fails, the response carries the diagnostic and **does not evaluate** (no false-green, no DB-reaching node ever runs):

- **(a) Reference existence.** Every id from `extractFieldReferences(expression)` MUST exist in the current sheet's `fields`. An unknown `{fld_missing}` → **`error` / `kind:'unknown_field'`**, do not evaluate. *(Why this matters: `evaluateField` substitutes a missing `{fldId}` with `'0'`, so without this gate an unknown-field formula returns `success:true` — a false green. This is the minimal server check, **not** a re-implementation of the client static checks.)*
- **(b) Supported reference shape.** Dry-run supports **only `{fldId}` references**. **A1/cell and `A1:B3` range references are unsupported** → **`error` / `kind:'unsupported'`**, do not evaluate. *(Why: `{fldId}` refs are pre-substituted to literals and never reach the DB, but A1/range refs resolve via the engine's default DB — §1. Rejecting them is what makes the "no DB access" property true.)*

Given those gates:

- **Zero data-access surface — by construction and proven.** With only `{fldId}` refs surviving, the resolved expression contains no DB-reaching node; eval is pure in-memory over caller-supplied `sampleValues`, reading **no records**. **#5a injects a no-DB engine and asserts a DB-query-spy count of 0** (proof, not assumption).
- **Cross-table / DB-backed lookup path is out of scope** — the wrapper never wires `MultitableFormulaEngine.lookup` (the permission-bypassing raw-SQL path), matching `formula`-type field behavior. **Do NOT blanket-block the array functions `VLOOKUP`/`HLOOKUP`/`INDEX`/`MATCH`** — those operate on in-formula ranges and are only out of reach insofar as their arguments use A1/range refs, which gate (b) already rejects. The boundary is **reference shape (A1/range) + the DB-backed `lookup` path**, not function names.
- **Capability gate = `canManageFields`** on the sheet (resolved from `sheetId`) — the same capability as create/update field. Rationale: dry-run grants no data access beyond save+view; gating here keeps a read-only user from probing and matches who the feature is for.
- **Bounds = STRUCTURAL caps, not a hard timeout.** A same-process JS eval can't be reliably preempted while CPU-bound, so a wall-clock "timeout" isn't a real boundary here. Lock structural caps instead: **expression length, referenced-field count, array-literal size, and AST/nesting depth** (over-cap → `413`/`422`). A true hard timeout would require **worker/process isolation** — explicitly **out of scope** for #5a (revisit only if a real abuse case appears). **Exact cap values = reviewer decision (§6), set in #5a.**

### 3.4 Diagnostics layering (LOCKED — don't duplicate)

- **Client static diagnostics** (`validateFormulaExpression`, existing ~12) stay the **fast pre-check** on every keystroke (syntax/arity/unknown-field). Save stays blocked on `error`-severity static diagnostics.
- **Server dry-run** is the **eval-time truth** (runtime sentinels, type mismatches, unsupported features) — only meaningful once the expression is syntactically valid. The UI runs dry-run **on demand** ("Evaluate"), not per keystroke.
- The server does **not** re-run the full client static-syntax suite (bracket/quote balance, arity, etc. — adding those server-side is a separate optional parity decision, §6). But the server **MUST** run the two minimal pre-eval gates of §3.3 — **reference existence** + **supported-reference-shape (reject A1/range; the DB-backed raw-SQL `lookup` path stays unwired by construction)** — because those are correctness/safety gates, not cosmetic static checks: skipping them yields false-greens or a DB-reaching eval. So: minimal mandatory server gates, no full static duplication.

---

## 4. PR split + gates (LOCKED)

Three separate PRs, each a separate explicit opt-in:

### #5a — Backend dry-run endpoint + wrapper method — *available to opt-in after this design*
- New `MultitableFormulaEngine.dryRun(...)` — pre-eval gates (§3.3) then classification (§2.1) — + `POST …/formula/dry-run` route (§3.1) + `canManageFields` gate + structural bounds (§3.3).
- Tests: pure-eval success (number/string/bool); `#DIV/0!`/`#VALUE!` sentinel → diagnostic; thrown-error → `THROWN` diagnostic; **unknown-field → `unknown_field` error, NOT evaluated**; **A1/range ref → `unsupported` error, NOT evaluated**; **no-DB engine spy asserts 0 DB queries**; type-mismatch warning; missing-sample info; `canManageFields` 403; structural-cap 413/422. (Eval path is in-memory → unit-testable; capability/route via the existing real-DB harness.)
- **No change to `formula/engine.ts`.**

### #5b — Frontend "Test with sample data" UI — *separate opt-in, after #5a green*
- In `MetaFieldManager.vue` formula panel: a "Test" affordance → panel with a type-appropriate input per `extractFieldReferences` field + "Evaluate" → calls the endpoint → shows `result` + diagnostics. Server response only.
- Reuses the existing static diagnostics for the pre-check; adds the eval result/diagnostics display.

### (deferred) #5c — Evaluate against a real record — *demand-gated, NOT planned now*
- "Pick an existing record" as sample data. **Deferred** because reading a real record re-introduces the D3c field-permission surface (the same composite as #4-3b-1) — out of scope for the in-memory MVP.

---

## 5. Out of scope (resist)
- Modifying the shared `formula/engine.ts` (frozen) — including "just add an error code." Classify on existing surface (§2.1).
- A1/cell/range reference evaluation + the DB-backed cross-table `lookup` raw-SQL path (rejected pre-eval per §3.3 — **not** a blanket block of the `VLOOKUP`/`HLOOKUP`/`INDEX`/`MATCH` array functions).
- A hard wall-clock eval timeout (needs worker/process isolation; structural caps only for #5a).
- Real-record sample data (#5c, demand-gated — D3c surface).
- Anything attendance / rbac / integration-core. AI-field work (§9 #6) is a separate, later item.

## 6. Resolved decisions (reviewer, 2026-05-26)
1. **Sample-data source** — ✅ user-supplied values only for MVP; real-record sampling deferred to #5c (D3c surface).
2. **Capability gate** — ✅ `canManageFields` (same as create/update field).
3. **Bounds** — ✅ **structural caps** (expression length / referenced-field count / array-literal size / AST depth); **no hard timeout** promised unless a separate worker/process-isolation slice is opened.
4. **Static parity** — ✅ do **not** duplicate the full client static suite, **but** the server **must** run the two pre-eval gates: **reference existence** + **A1/range reference-shape rejection** (the DB-backed raw-SQL `lookup` path stays unwired by construction) (§3.3). These are correctness/safety gates, not cosmetic checks.

> Note: §9 calls this "extends the 15 diagnostics"; the actual count is **~12** (see §1). Not fixing the §9 number; flagged so the next person doesn't hunt for 3 missing checks.
