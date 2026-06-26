# Detail-row auto-sum — Design Lock

Status: RATIFIED — SHIPPED (PR #3198, read-only auto-fill v1). FE-only runtime: `useAutoSumTotal` derives
the top-level total from the detail rows (money-safe, round-each-cell-then-sum), read-only; the backend
total-check (#3176) remains the tamper-proof backstop. Per-row line-subtotal derivation followed as its
own lock (#3203) + runtime (#3205).

Grounding: the server-side amount total-check (design-lock #3161, shipped #3176/#3183) made amount-tier
routing tamper-resistant — the backend rejects a `createApproval` whose top-level total ≠ the money-safe
sum of the detail-row amounts, and the amount-tier presets declare the
`amountConsistencyCheck { totalFieldId, detailFieldId, amountColumnId }` mapping. That closed the
*defense* side. This lock adds the *ergonomics* side: the submitter no longer types the total at all — the
fill UI sums the detail rows into the total automatically. Together they form one loop: **auto-fill
(convenience) + total-check (tamper-proof)**. This lock does NOT relax or replace the backend check.

## Goal

When a template declares `amountConsistencyCheck`, the approval fill UI (`ApprovalNewView`) computes the
top-level total from the detail-row amount column and writes it into `formData[totalFieldId]` as a
**read-only, auto-maintained** value. The applicant fills only the line items; the total is derived. The
backend total-check stays exactly as shipped and remains the sole arbiter.

## Decisions

1. **FE-only runtime; the backend does not change.** The total-check (`validateAmountTotalConsistency`
   in `createApproval`) stays a VALIDATOR. The FE becomes a COMPUTER that auto-fills. We do NOT move the
   sum into the backend and drop the check — that would discard the 防篡改 against non-browser clients.
   FE auto-fills (UX), backend validates (security). That separation is the entire point of the loop.

2. **The mapping is the single declaration.** Auto-sum reads the SAME `amountConsistencyCheck` the
   backend check reads — no second config, no inference. A template has the behavior iff it carries the
   mapping (today: the two amount-tier presets). No mapping → no auto-fill, total stays applicant-entered
   exactly as now.

3. **Read-only auto-fill, NOT editable-with-default.** When the mapping is present the total field
   renders read-only and is driven entirely by the sum. Rationale is not merely "editable is confusing":
   the backend already enforces `total = sum` for mapped templates, so a read-only total removes ZERO
   expressiveness and can never reject a previously-valid submission — whereas an editable total could
   only ever produce a self-inflicted reject (the user overrides, then the backstop rejects at submit).

4. **Computational identity with the backend (LOAD-BEARING).** The backend compares
   `round(total·10^scale)` against `Σ round(cell·10^scale)` — it rounds EACH cell to scaled-integer
   minor units, then sums the integers. The FE auto-fill MUST replicate this byte-for-byte:
   `scaledSum = Σ Math.round(cell·10^scale)`, then `total = scaledSum / 10^scale`, with `scale` derived
   from the amount column's `props.precision` (default 2) — the SAME source the backend uses.
   - It must be round-each-cell-THEN-sum, never sum-then-round. Counter-example at scale 2: two cells of
     `0.005` → backend `round(0.5)+round(0.5) = 2` minor units; a naive float `0.005+0.005 = 0.01` →
     backend `round(0.01·100) = 1` → `1 ≠ 2` → **the backstop rejects the system's own auto-filled
     value** and the user, who filled everything correctly, cannot submit. Sum-then-round is a latent
     self-reject bug, not a rounding nicety.

5. **Mirror, don't import (verified boundary).** `apps/web` imports nothing from `packages/core-backend`
   (0 imports; no shared package / path alias) and `amount-total-check.ts` resolves backend-relative
   types — so the FE cannot reuse the helper. The algorithm is therefore MIRRORED in the FE as
   `computeConsistentTotal(rows, amountColumnId, scale)`, with a header comment cross-referencing
   `packages/core-backend/src/services/amount-total-check.ts` as the source of truth, and the parity
   test (Decision 6 / Gate A) is what makes the duplication safe.

6. **A parity test is the closed loop — not optional.** For tricky inputs (`0.005 + 0.005`, `0.1 + 0.2`,
   a 4-decimal-precision column, an empty detail) assert that the auto-filled total clears the backend
   comparison: `round(autoFilled·10^scale) === Σ round(cell·10^scale)`. This test, re-stating the
   backend's exact comparison in the FE (the boundary forbids importing the real helper), is what proves
   "the value we auto-fill always passes the backstop." Without it the lock is underspecified.

7. **Incomplete-row handling during entry.** While the applicant is still typing, a row may have an
   empty/non-numeric amount cell. The live sum treats a non-numeric cell as 0 (so the running total is
   useful), but this does NOT loosen submit: the backend rejects a non-numeric amount cell fail-closed,
   and the detail column's own `required` rule catches a truly-missing cell at submit. The FE must not
   pretend an incomplete form is valid — it only keeps the derived total live.

8. **Empty detail → total 0.** With no rows the auto-filled total is 0. The lock notes that the total
   field's `required` / `props.min` must be satisfiable by 0 for mapped templates (the amount-tier
   presets use `min: 0`, so this holds); a `min > 0` total field with auto-sum would be a misconfig to
   reject at template-save in a later pass.

## Build Gates (for the SEPARATE runtime opt-in, not this lock)

- **Gate A — pure `computeConsistentTotal` + parity tests.** The FE helper (no Vue, no DOM) + unit
  tests: the four tricky inputs of Decision 6, plus the round-each-cell-then-sum vs sum-then-round
  counter-example asserted explicitly, plus scale-derivation from a 4-decimal column.
- **Gate B — `ApprovalNewView` wiring.** A `watch` on `formData[detailFieldId]` (active only when the
  template carries the mapping) that sets `formData[totalFieldId]` via `computeConsistentTotal`; the
  total field renders read-only with a "由明细自动汇总" hint. A mounted test: edit a detail amount → the
  total updates to the derived value; the total input is read-only. No backend call changes.
- **Gate C — no scope creep / no backend touch.** The diff is FE-only; `validateAmountTotalConsistency`
  and the route are untouched; the preset's stale "applicant-entered total" comment is updated to
  "auto-summed from detail rows (read-only)".

## Non-Goals

- Any backend change (the validator stays the sole arbiter; this is purely a fill-UI convenience).
- An editable / override-able total for mapped templates (Decision 3).
- Multi-detail roll-ups, cross-field arithmetic (e.g. `quantity × unit_price` per row), currency
  conversion — each its own later lock. (Per-row `quantity × unit_price → amount` auto-calc is the
  natural next ergonomics step but is a distinct mapping and lock.)
- Retrofitting auto-sum onto templates without the mapping.
