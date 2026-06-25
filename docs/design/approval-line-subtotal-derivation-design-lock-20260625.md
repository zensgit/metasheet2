# Per-row line-subtotal derivation (quantity × unit_price → amount) — Design Lock

Status: RATIFIED — RUNTIME NOT BUILT. One OPEN QUESTION for the owner (read-only vs overridable, below).

Grounding: the amount-tier line shipped a two-stage money chain — the fill UI auto-sums the detail-row
amount column into the top-level total (read-only, #3198), and the backend total-check rejects any
total ≠ Σ amount (#3176). This lock adds the stage BELOW that: deriving each row's `amount` (小计) from
its own `quantity × unit_price`. It is NOT a simple extension of the total auto-sum — it introduces
**in-row derived field** semantics, and — critically — it has **no backend backstop** (the total-check
constrains `total = Σ amount`, never `amount = qty × price`). So every policy choice is locked here first.

## Goal

When a detail field's amount column declares a derivation, the fill UI computes that column per row from
its operand columns (`quantity × unit_price`) so the applicant fills only the operands. The derived
amount then feeds the existing total auto-sum, which feeds the backend total-check — one chain, one scale.

## The six locked dimensions

### 0. Persistence home — the target column's `props` → genuinely FE-only (VERIFIED)
The declaration rides on the amount column's `props`, e.g.
`props: { precision: 2, derivedFrom: { operandColumnIds: ['quantity','unit_price'], operation: 'product' } }`.
The backend `normalizeFormField` copies `props` **wholesale** (`props: { ...value.props }`, ApprovalProductService.ts:598)
and detail columns go through the same function (normalizeDetailFieldParts → normalizeFormField, :628), so
this new key round-trips create→publish→load with **zero backend change**. Gate C stays "no backend touch."
- TRADE-OFF, stated plainly: because it rides in `props` wholesale, the backend does **not** validate
  `derivedFrom`. The FE is therefore the SOLE validator and MUST be defensive — a malformed / partial /
  dangling-reference declaration falls back to a manual column, never throws. (Contrast the total-check,
  which the backend validates in `assertFormSchema`. The line-derivation deliberately trades backend
  validation for FE-only surface.)

### 1. Mapping declaration — narrow, on the target column, declaration-gated
One derived target column per detail field. `operandColumnIds` reference sibling leaf columns of the same
detail field; `operation: 'product'` only in v1 (sum / mixed arithmetic are non-goals). A detail field
whose amount column has no `derivedFrom` keeps today's manual column — the behavior engages ONLY on an
explicit declaration (mirrors `amountConsistencyCheck` / the G-5 discipline).

### 2. Read-only vs overridable — read-only in v1 (OPEN QUESTION for the owner)
Recommend **read-only** for v1 (consistent with the total, simplest). But this is NOT a security
decision and the lock must say why: the backend total-check enforces `total = Σ amount`, **not**
`amount = qty × price`, so in v1 the line math is **convenience only, NOT tamper-proof** — a non-browser
client can still submit consistent-but-fabricated line numbers (total still = Σ amount, so it passes).
That is acceptable and expected; nobody should read this as extending the 防篡改 boundary.
- Future, named not built: (a) *overridable* line amount (for line-level discounts / negotiated prices)
  — feasible precisely because there is no backstop to self-reject against; (b) *enforced* line math —
  a BACKEND total-check extension (`amount = qty × price` per row), a separate decision, and it would
  FORCE read-only. → See Open Question.

### 3. Precision — target column = the amount column, BY CONSTRUCTION (one scale, whole chain)
The derivation's target column IS the total-check's `amountColumnId`. So a single scale — that column's
`props.precision` (default 2) — governs the ENTIRE chain: rounding the line product `round(qty·price · 10^s)/10^s`
AND summing the lines (the existing `computeConsistentTotal`). Locking "target = the amount column" makes
precision-drift between the two stages impossible by construction, not by convention.

### 4. Hidden columns / hidden rows — reuse `getVisibleFormFields`, don't reinvent
The detail field already resolves per-row column visibility (`detailField.ts` `getVisibleFormFields` over
columns). Reuse it:
- An operand column NOT visible for a row → **skip derivation for that row** (leave the amount manual;
  never derive from a partial operand set).
- The target (amount) column hidden for a row → skip (nothing to fill).
- Hidden ROWS need no new handling — the total auto-sum / `pruneHiddenFormData` already exclude them.

### 5. Execution order vs the total auto-sum — ONE reactive pass (derive-then-sum)
The line derivation MUST complete before the total reads the amounts. Two separate watches (per-row →
amount, then deep-on-detail → total) would converge but risk a stale-within-flush transient. Lock a
**single reactive pass**: on a detail change, (1) derive every row's amount from its operands, (2) then
sum the amounts into the total — sequenced inside one place. Implication: **extend `useAutoSumTotal`**
(derive-then-sum in the same composable), not a parallel composable. The ordering question disappears.

## Build Gates (for the SEPARATE runtime opt-in, not this lock)

- **Gate A — pure derivation helper + tests.** `computeRowDerivation(row, decl, scale)` (product of
  operand cells, rounded to the column scale; non-numeric/partial-operand/hidden-operand → no derivation,
  leave manual). Tests incl. precision rounding at the amount-column scale and the partial-operand skip.
- **Gate B — derive-then-sum in `useAutoSumTotal` + read-only column.** One pass: derive rows → existing
  `computeConsistentTotal`. The derived amount cell renders read-only in the detail table when declared.
  A composable test: edit `quantity`/`unit_price` → the row amount updates AND the total updates, in one
  flush; an overridden/hidden-operand row stays manual.
- **Gate C — no backend touch + defensive declaration.** Diff is FE-only (verified persistence home); a
  malformed/dangling `derivedFrom` falls back to manual (a test asserts no throw). The amount-tier
  presets MAY then declare it on `purchase_items.amount` (`{operandColumnIds:['quantity','unit_price'],
  operation:'product'}`) — that enablement is its own small step after the runtime, as with #3183.

## Non-Goals
- Backend enforcement of the line math (a total-check extension; separate lock — would force read-only).
- Operations beyond `product` (sum, subtotal-with-discount, free-form expressions).
- Multi-target derivation, cross-row or cross-field references, currency conversion.
- Retrofitting onto detail columns without a `derivedFrom` declaration.

## Open Question for the owner (do not decide silently)
**Read-only vs overridable line amount.** Recommend read-only for v1. The one thing that could overturn
the default is a real workflow need: do the target purchases/reimbursements have **line-level
discounts / negotiated unit totals** where the applicant must adjust a single line's amount away from
`qty × price`? If yes, v1 should be overridable (derive-as-default, allow manual override) — still
FE-only, still feeds the total. If no, read-only is cleaner. This is a product call, flagged here rather
than baked in.
