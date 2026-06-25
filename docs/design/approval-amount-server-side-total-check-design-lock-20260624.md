# Amount Server-Side Total Check — Design Lock

Status: IMPLEMENTED BY #3176; FOLLOW-UP GAPS TRACKED

Grounding: the amount-tier approval line — design-lock
`approval-amount-tier-template-presets-design-lock-20260624.md` plus the Gate-A
approval-node source editor (#3124) — shipped with a written KNOWN CONTROL
LIMITATION (Decision 1 of that lock): the amount gate reads the applicant-entered
top-level `amount`, so a submitter can **under-state the total to route around the
higher-amount approval tier**. That line is closed; this is a NEW, narrow lock that
closes only that one gap, server-side. It is the lighter of the two documented
fixes — the heavier one, detail-row auto-sum, is a separate later lock.

## Goal

**Bind the number that drives tier routing to the line items the approver actually
sees.** When a template declares an amount-consistency mapping, the backend
validates at SUBMIT time that the applicant-entered total equals the sum of that
submission's detail-row amounts, and **rejects a mismatch fail-closed** before the
approval graph is built.

Scope of the guarantee, stated precisely (this is a control, not magic):

- It CLOSES the decouple — routing on a top-level `4000` while the line items sum
  to `8000` (under-stating only the routing field to dodge the tier) is rejected.
- It does NOT make amounts truthful. A submitter who under-states the total AND the
  line items *consistently* still routes low — that is a truthfulness problem
  (approver review, downstream reconciliation), outside this control's reach. Do
  not describe this as "tamper-proof"; it binds routing to the visible line items,
  it does not verify the line items are honest.

It does NOT compute or auto-fill the total (that is detail-row auto-sum — a separate
lock delivering the SAME routing guarantee with different ergonomics; see
Non-Goals). It validates an applicant-supplied total against the applicant-supplied
rows.

## Decisions

1. **Explicit declared mapping — never inferred.**
   The check runs ONLY when the template config declares an `amountConsistencyCheck`
   mapping `{ totalFieldId, detailFieldId, amountColumnId }`. No field-name
   convention, no "find the amount field" heuristic — both are brittle and fail
   OPEN. A template without the mapping is unaffected (no check). This mirrors the
   G-5 discipline: the editor offers only what the backend explicitly accepts; the
   control engages only on an explicit, validated declaration.

2. **Server-side, fail-closed, at submit time.**
   The check lives in `createApproval` (`ApprovalProductService`), AFTER
   `pruneHiddenFormData` and BEFORE the runtime graph is built, so it sees exactly
   the normalized `formData` the graph will route on. On a mismatch it raises a
   validation error (HTTP 400, precise but non-leaking message) and the approval is
   never created. A FE preview MAY mirror it for UX, but — as with
   `normalizeApprovalGraph` — the backend is the SOLE arbiter and the preview never
   relaxes it.

3. **Exact comparison on a money-safe representation.**
   Compare `total` against `sum(rows[*][amountColumnId])` in integer minor units
   (or a fixed-scale decimal), NEVER raw IEEE float — `0.1 + 0.2` drift must not
   create a phantom mismatch. The scale is derived from the mapped number fields'
   declared precision (approval `FormField.props`, aligned with the multitable
   `property.decimals` convention where present), not hard-coded to "currency = 2".
   When no precision is declared, the helper must preserve the submitted decimal
   precision with an exact decimal parser/normalizer rather than rounding both
   sides to two places. It then sums and compares exactly. No tolerance band in v1
   (a money control is exact); a configurable epsilon is out of scope.

4. **Structural validity at save; semantic / pruned absence fails closed at submit (as built, #3207).**
   `pruneHiddenFormData` (`ApprovalGraphExecutor`) prunes at TWO granularities — whole
   top-level fields (by visibility), and individual CELLS within each detail row (a
   sub-field `visibilityRule` evaluated per row, recursing the sub-schema). It does NOT
   drop whole rows — the row-array length is preserved.
   - SAVE-time is STRUCTURAL: `normalizeAmountConsistencyCheck` validates that the
     mapped fields exist and have the right types. Mapped fields MAY carry a
     `visibilityRule` — they are NOT required to be unconditionally visible.
   - SUBMIT-time is SEMANTIC and fail-closed: the check runs on the same post-prune
     `formData` the graph routes on, so a `visibilityRule`-hidden mapped field/cell is
     pruned → its value is absent → reject. A non-numeric/absent total, a non-array
     detail value, or an empty/non-numeric amount cell likewise rejects (the control
     cannot verify a field it cannot read). The control can never silently run on data
     it can't see.

5. **One total ↔ one detail column, v1.**
   v1 maps exactly one top-level total to exactly one `number` column of one
   `detail` field. Multi-detail roll-ups, nested details (the model is one nesting
   level regardless), cross-field arithmetic, and currency conversion are out of
   scope.

6. **Persistence: versioned `formSchema.amountConsistencyCheck` (as built in #3176) —
   the dedicated-column requirement is WITHDRAWN.**
   An earlier draft of this decision required a dedicated `amount_consistency_check`
   column on the parent template and argued AGAINST putting it in `form_schema`. That
   was wrong: `form_schema` (and `approval_graph`) live on
   `approval_template_versions`, not the parent `approval_templates`, so a
   parent-template column would DRIFT from the version a running instance is pinned
   to. #3176 instead put the mapping at `formSchema.amountConsistencyCheck`,
   normalized + re-emitted in `assertFormSchema` (`normalizeAmountConsistencyCheck`)
   and read in `createApproval` — version-pinned and explicitly allowlisted (not an
   un-allowlisted key the form-schema normalizer would drop). This lock adopts that
   home. The G-5 silent-drop risk does NOT disappear — it MOVES to the FRONTEND save
   path: the `apps/web` `FormSchema` type and `buildFormSchema()` must carry
   `amountConsistencyCheck` through, or the editing page rebuilds the schema without
   it and drops the mapping on first save (Remaining gaps §1).

## Mapping shape and authoring-time validation

`amountConsistencyCheck?: { totalFieldId: string; detailFieldId: string; amountColumnId: string }`
sits at `formSchema.amountConsistencyCheck` (version-pinned with the rest of the
form schema), is normalized + re-emitted in `assertFormSchema`, and is validated at
TEMPLATE-SAVE time (fail-closed authoring), mirroring the assignee-source allowlist
discipline:

- `totalFieldId` references a top-level field of `type: 'number'`.
- `detailFieldId` references a top-level field of `type: 'detail'`.
- `amountColumnId` references a `type: 'number'` entry in that detail field's
  `columns` (leaf sub-fields; the model already forbids nested `detail`).
- the comparison scale is derived from the mapped number fields' declared precision;
  a missing precision declaration does NOT imply "round to two places".

A mapping that points at a missing or wrong-typed field is REJECTED at save — the
unsupported-config gate, not a runtime surprise. A template carrying an
`amountConsistencyCheck` whose shape the backend does not re-emit is fail-closed in
the authoring UI exactly as G-5 handles unknown approval-node keys.

The amount-tier presets that motivated this lock MUST declare the mapping when the
runtime slice lands. In particular, the shipped purchase amount-tier preset needs
`{ totalFieldId: 'amount', detailFieldId: 'purchase_items', amountColumnId: 'amount' }`
so the high-tier route is actually controlled by the line-item total. Presets that
omit the mapping remain valid drafts, but they do NOT get this control.

## Build Gates

### Gate A — submit-time check + fail-closed unit tests
A pure `validateAmountTotalConsistency(formSchema, normalizedFormData, mapping)`
helper (no DB), unit-tested both directions:
- matching total ↔ row sum → passes;
- under-stated total (the bypass) → rejected;
- over-stated total → rejected;
- a `visibilityRule`-hidden mapped field/cell → pruned to absent at submit → rejected
  (semantic fail-closed; NOT a save-time reject);
- decimal precision cases: `0.1 + 0.2` vs `0.3` passes, and a higher-precision
  mapped amount (for example four decimal places) is not rounded to two places;
- non-numeric total / non-array detail / non-numeric amount cell → rejected;
- no mapping → no check (the helper is never invoked).

### Gate B — real-DB acceptance
A real-DB `createApproval` + create/update-template, mirroring the create-template
smoke:
- `formSchema.amountConsistencyCheck` survives a template save→reload round-trip AND
  a FRONTEND editing-page save, NOT dropped by normalization (the Remaining-gaps §1
  silent-drop regression);
- template WITH the mapping + a mismatched submission → REJECTED, no approval row
  written;
- same template + a matching submission → `201` + created;
- a submission whose mapped field is `visibilityRule`-hidden (pruned → absent) → REJECTED at submit;
- the amount-tier preset mapping is persisted on create and survives readback;
- template WITHOUT the mapping → unaffected (no check path executed).

### Gate C — no scope creep
The check only ever REJECTS; it NEVER mutates `formData` (no auto-fill — that is
the auto-sum lock). No currency conversion, no multi-detail, no tolerance band.

## Remaining gaps (all resolved — §1 #3197, §2 #3183, §3 ratified by #3207)

Status: §1 (FE preserve) closed by #3197, §2 (preset mapping) by #3183, and §3
(visibility policy) ratified as-built by #3207 — this lock is now consistent with that
verification record and has no open gap. The auto-sum lock (#3189, design-only) rides
the same save path and inherits the §1 preserve. A save-time semantic visibility reject
remains a deferred P2 hardening (§3 below), not a gap.

1. **[CLOSED — #3197] FE authoring save preserves the mapping.** Closed by #3197
   (merge `fd17ad2e7`): `TemplateAuthoringDraft` now carries `amountConsistencyCheck`,
   `draftFromTemplate` hydrates it, and `buildFormSchema` re-emits it — so opening a
   preset-created template in the authoring editor and saving no longer drops the
   control. Guarded by a unit round-trip and a mounted save round-trip test. The active
   exposure (a shipped preset control lost on the first authoring-page save) is resolved.
2. **[DONE — #3183] Amount-tier presets declare the mapping.** Closed by `4f6cd83b2`
   (#3183): `commonTemplatePresets.ts` `withAmountConsistency()` wires reimbursement
   `{ amount, expense_items, amount }` and purchase `{ amount, purchase_items, amount }`,
   with preset coverage. Retained as a record — the capability is shipped; its
   durability through the authoring editor depends on §1 (which landed AFTER it, hence
   the live exposure above).
3. **[CLOSED — ratified as-built by #3207] `visibilityRule` policy.** Ratified doc-only
   (no backend change): SAVE-time is STRUCTURAL (existence + type, via
   `normalizeAmountConsistencyCheck`); SUBMIT-time is SEMANTIC and fail-closed (a
   `visibilityRule`-hidden mapped field is pruned → absent → reject). Decision 4 /
   Mapping shape / Gate A / Gate B above are aligned to that split. A SAVE-time semantic
   reject of `visibilityRule`-bearing fields is left as a deferred P2 hardening (an
   earlier authoring-time signal), NOT pursued now. Verification record: #3207.

## Non-Goals
- Detail-row auto-sum (computing/auto-filling the total) — separate later lock. It
  delivers the SAME routing guarantee as this check (bind the routing total to the
  visible line items), NOT a stronger one — a consistent low-baller defeats both
  identically. It differs in ERGONOMICS (compute-and-lock the total vs
  validate-and-reject) and is the larger surface (a computed/rollup form-field
  capability). "Check first" is an ordering-by-cost call, not a claim auto-sum is
  weaker.
- Currency conversion / multi-currency arithmetic.
- Multi-detail roll-ups or cross-field arithmetic.
- A tolerance/epsilon band (v1 is exact).
- Inferring the total/amount fields by name or heuristic.
- `job_title` / `rank` resolver and W7 approval-result write-back (their own locks).
