# Server-side amount total-check — development + verification

Executes the plan after the #3161 design-lock review: the narrow server-side total-check that makes
amount-tier approval routing tamper-resistant. Closes the KNOWN CONTROL LIMITATION the amount-tier
line shipped with — the gate trusts the applicant-entered top-level `amount`, so a submitter could
**under-state the total to dodge the higher-amount approval tier**.

## What shipped (PR #3176 — control + createApproval wiring + real-DB)

Built in two gates per the design-lock; landed as one consolidated PR.

### Gate A — the pure control (`amount-total-check.ts`)
`validateAmountTotalConsistency(formSchema, formData, mapping)` — pure, no DB. The applicant total must
equal the sum of that submission's detail-row amounts:
- **Money-safe** — compares SCALED-INTEGER minor units, never raw float (`0.1 + 0.2 === 0.3`).
- **Scale DERIVED from the amount column's own `props.precision`** (default 2), resolving the one
  review point from #3161 — a 4-decimal amount column compares at its real granularity; a hardcoded
  scale-2 would both hide a real mismatch and manufacture a false one.
- **Fail-closed** — missing/non-numeric total, non-array detail, non-record row, non-numeric amount
  cell, and a mapping that points at a missing/wrong-typed field all return an error (never skipped).

### Gate B — wiring + persistence, NO migration
- The mapping lives in `FormSchema.amountConsistencyCheck` (types/approval-product) so it **rides with
  `form_schema`** — round-trips create→publish→createApproval with no new column / no migration. This
  was the verified-before-build persistence decision: the version INSERT writes only `form_schema` /
  `approval_graph`, and a `metadata` column does NOT round-trip, so embedding-in-form_schema (validated
  + preserved in `assertFormSchema`) is the clean home.
- **`assertFormSchema` validates + PRESERVES the mapping**: a malformed mapping (wrong-typed total /
  detail / amount-column reference) is rejected at TEMPLATE-SAVE (fail-closed authoring), and a valid
  one is kept on read — closing the field-by-field projection drop trap in the same place.
- **`createApproval` runs the check** on the SAME post-`pruneHiddenFormData` `formData` the graph routes
  on, BEFORE the graph is built — fail-closed (`400 APPROVAL_AMOUNT_TOTAL_MISMATCH`) on a mismatch. A
  hidden line item is excluded from both sides (already pruned), per design-lock Decision 4.

## Verification
- **Gate A — 9 unit tests:** under/over-stated, money-safe float, the 4-decimal scale-derivation (both
  directions), every fail-closed input, empty-detail.
- **Gate B — 4 real-DB tests** (wired into the plugin-tests real-DB lane): mismatch → 400, match → 201,
  malformed mapping → rejected at template-save, no-mapping → unaffected. Green locally against Postgres.
- No regression (approval-product-service unit suite unchanged); backend tsc clean.

## Shipped as the rest of this line (separate PRs, all on main)
- **Preset enablement → #3183.** `purchase_amount_tier` ships `{amount, purchase_items, amount}` and
  `reimbursement_amount_tier` ships `{amount, expense_items, amount}` (via a `withAmountConsistency`
  helper); the basic presets (leave/reimbursement/purchase) keep no mapping. The FE
  `FormSchema.amountConsistencyCheck` type was added (carried verbatim — backend is sole arbiter). So the
  amount-tier templates are tamper-resistant by default. Preset test +3; vue-tsc clean.
- **W7 observability pair → #3182.**
  - *rule-save fail-fast* (`createRule`) — validates the `resultWriteback` target fields against the
    source sheet at save (reusing #3157's existence/type check). LENIENT on absence (deferred to the
    runtime skip — record data is schemaless, the field may be added after the rule), FAIL-FAST on a
    TYPE mismatch for a field that already exists. NOTE: this changes the at-save incompatible-type case
    from "saved + skipped at runtime" to "rejected at rule-save" (the point of fail-fast); W7-1b's
    skip-don't-block posture is preserved for missing fields + post-save changes, and that test was
    updated accordingly.
  - *step-result skip-reason* — the runtime backwrite skip is surfaced on the `start_approval` step
    result (`backwriteSkipped`), not only `logger.warn`. 14/14 start_approval integration; automation-v1 186/186.

## Still a follow-up (not built)
- **Detail-row auto-sum** — the heavier of the two #3161 fixes (compute/auto-fill the total, removing
  the gameable separate total) — its own later lock; pulls in a computed/rollup form-field capability.

## Deferred (need explicit business semantics — per the plan, do not pre-build)
- **W7 rejection backwrite** — write `status='rejected'` on the non-approved path (which currently fails
  the automation by design).
- **W7 cross-base backwrite** — permission / lock / audit / target-resolution are all more sensitive.

## #3084 determination
`#3084` ("regression-pin createApproval manager_at_level chain bake + align managerChainIds contract")
pins behavior whose wiring (`includeManagerChain` / `needsManagerChain`) is already on main. So it is
additive test coverage for existing behavior — it can land or be closed on its own, and does NOT gate
the total-check (even though both touch `createApproval`).
