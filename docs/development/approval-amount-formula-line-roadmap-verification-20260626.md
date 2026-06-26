# Approval amount/formula line — roadmap + verification

## Scope (stated, not assumed)
This covers the **amount/formula chain** built recently: server-side total-check → W7 observability →
amount-tier presets → detail-row total auto-sum → per-row line-subtotal derivation → formula conditions.
The broader approval product (delegation, manager-chain / dept-head resolvers, complex-graph authoring,
add/reduce-sign, etc.) is a **separate line** and is out of scope here. If you meant the wider product,
redirect and I'll re-survey.

## Finding: the line is essentially complete
Everything functional on this chain is shipped on `origin/main`. There is **no buildable feature
remaining that does not require an owner decision or a fresh design-lock** — so the honest plan is a
closeout + this roadmap, not manufactured work. (Building a gated item now would break the
design-lock-first / staged-opt-in discipline this line has held throughout.)

### Shipped (design-lock → runtime, all on main)
| Capability | Design-lock | Runtime |
|---|---|---|
| Server-side amount total-check (consistency-checked routing) | #3161 (open draft; see closeout below) | #3176 |
| W7 observability (rule-save fail-fast + step-result skip-reason) | — | #3182 |
| Amount-tier presets (purchase / reimbursement) | amount-tier-presets lock | #3132 / #3183 |
| Detail-row **total** auto-sum (read-only auto-fill) | #3189 | #3198 |
| Per-row **line-subtotal** derivation (qty × unit_price → amount) | #3203 | #3205 |
| Formula conditions (evaluator + authoring + presets + dry-run) | #3210 | FC-1..FC-5: #3219 / #3220 / #3221 / #3222 / #3234, closeout #3235 |
| `manager_at_level` chain-bake regression pin | — | #3084 |

The money chain is closed end-to-end: **derive line (qty × unit_price) → sum total → backend
total-check**; formula conditions route on those consistency-checked values; the backend remains the sole
consistency boundary (binds total to detail sum).

## Remaining development — the plan (each item: its unblocker + who owns the call)

### Gated — needs your decision or a new design-lock (NOT buildable without it)
1. **Overridable line amount** — derive-as-default but allow a manual per-line override.
   *Unblocker:* your product call — do the target purchases/reimbursements have **line-level discounts /
   negotiated unit totals**? (v1 shipped read-only per your earlier choice.) *Then:* FE-only, small.
2. **Backend line-math enforcement** (`amount = qty × price` per row) — makes the line math tamper-proof
   (today it is FE convenience only). *Unblocker:* your security call that FE-convenience is insufficient
   → **then a new design-lock**; note it would FORCE read-only line amounts.
3. **User/org-attribute formulas** in conditions (e.g. `requester.rank >= M3`) — the evaluator's named
   next extension. *Unblocker:* a **resolver/snapshot design-lock** first — the formula needs a TRUSTED
   requester-attribute snapshot (distinct from applicant-controlled form data; a real security surface),
   not just a parser change.
4. **Operations beyond `product`** in line derivation (e.g. sum, subtotal-with-discount). *Unblocker:* a
   concrete template need; low priority until a real use-case names it.
5. **Mixing `rules` + `formula`** in one condition branch. *Unblocker:* a concrete need — currently
   modelable by writing the full boolean inside one formula, so low value.
6. **W7 rejection / cross-base backwrite** (the approval-result writeback's deferred slices).
   *Unblocker:* business semantics — rejection: *fail the automation* vs *write a rejected-status*;
   cross-base: permission / lock / audit / target-resolution all more sensitive → each its own design-lock.

### Non-goals (explicitly not to build)
Arbitrary JS / user scripts in formulas; cross-table or cross-record lookups; AI formula generation;
replacing the simple condition-rule editor. (From the formula-condition lock's Non-Goals.)

## Executed this pass (the closeout)
A status sweep across all five amount/formula design-locks found two lagging the shipped reality:
- **detail-autosum #3189** — read "RATIFIED — RUNTIME NOT BUILT" though #3198 shipped the runtime.
  **Fixed here** → "RATIFIED — SHIPPED (#3198)".
- **total-check #3161** — the *design-lock* PR was never merged (still open); only its **dev-verification
  MD** (`approval-amount-total-check-dev-verification-20260624.md`, #3180/#3187) landed, and that MD
  already records the design decisions + verification + the shipped runtime. **Resolution:** close #3161
  as superseded by that on-main MD (avoid landing a stale upfront draft over a documented shipped state).
The other three (amount-tier-presets, line-subtotal #3203, formula-condition #3210) already read SHIPPED.

## Verification
- `grep ^Status:` swept all five locks; post-fix, every lock on main reflects its true shipped/ratified
  state (detail-autosum corrected; total-check documented via its dev-verification MD; the rest already
  SHIPPED).
- Runtimes confirmed on `origin/main`: `amount-total-check.ts`, `useAutoSumTotal.ts`, `lineDerivation.ts`,
  `ApprovalConditionFormula.ts`, the `formula-condition/dry-run` route.
- Zero open formula-condition PRs; this closeout PR + the #3161 close are the only line-related PR actions.

## Net
The amount/formula line is **done and documented**. The next move is yours: pick a gated item, answer its
one decision (or commission its design-lock), and I'll build it under the same discipline. I did not touch
any owner-gated decision in producing this.
