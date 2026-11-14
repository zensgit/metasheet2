# CALC15 legacy envelope explanation read contract

Human explicitly approved this named read-only response exception on2026-10-27.
Refs #4556. Draft/HOLD only.

## Exact contract

The existing calculation-detail response may add optional
`current.calculationMode: "envelope_legacy"` only when the persisted current
record is `projection_owner=legacy_untracked`, current_calculation_id is
strictly null, visibility_state is active and visibility_reason is active.
This describes the current visible daily projection. It does not classify
the complete calculation history or imply the absence of legitimate older
children on a restored row. Existing posture remains independent, including
`undeterminable`. Review placeholders, retired records, tracked/group-owned
projections and pointer-bearing projections do not receive the label.
All other response fields, authorization, SQL scope and fail-closed parsing
remain unchanged.

This is the named compatibility exception to W4 section10.2 closed current
and section12 OFF response bytes: only the optional field on eligible legacy
explanations. The required four current keys remain required; additional
properties remain forbidden; the new optional field accepts one literal.
Schema and generated types must match. No unrelated compatibility exception.

No migration, backfill, writer, baseline/segment manufacture, historical
recompute or calculator enablement. Native tests must prove unchanged parent
row and existing calculation/segment census around the read, including a
virgin pre-cutover legacy fixture with zero children and a completed tracked
control. No duplicate migration replay in an already qualified database.

| Gate | Required actual proof |
| --- | --- |
| Eligibility | Exact complete legacy response with one optional literal field |
| Non-eligibility | Owner/pointer/visibility/reason guards, no placeholder label |
| Fail closed | Existing enum/schema parsing and 403/404 isolation preserved |
| Native read-only | Actual route/service reads; parent and calc/child rows equal before/after |
| Discrimination | Matching label removal and eligibility broadening mutants red; restore |
| Contract | OpenAPI build/validate, generated SDK/types and strict literal rejection |
| Neighbors / quality | Affected detail unit/routes/native plus relevant guard/validateall |
| Delivery | Draft, current-head required terminal success and actual target logs |

Stream/lifecycle and external writes remain OFF. No Ready/merge/deploy,
R71/tag/release/business-configuration changes. Real UAT/business50004 excluded;
historical08PUT INCONCLUSIVE. Correction target and CALC14 effective-date
questions remain unanswered; this approval grants neither of those choices.
Parent/owner and full-product acceptance remain open.
