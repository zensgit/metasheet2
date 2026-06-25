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

4. **Mapped fields must be unconditionally visible; value gaps fail closed.**
   `pruneHiddenFormData` (`ApprovalGraphExecutor`) prunes at TWO granularities —
   whole top-level fields (by visibility), and individual CELLS within each detail
   row (a sub-field `visibilityRule` evaluated per row, recursing the sub-schema).
   It does NOT drop whole rows — the row-array length is preserved. So the dangerous
   edge is a mapped field/cell being pruned AWAY, not a row vanishing.
   - To remove that ambiguity entirely, the mapping REQUIRES its three referenced
     fields — the total field, the detail field, and the amount column — to carry NO
     `visibilityRule` (unconditionally visible), enforced at template-save
     (fail-closed authoring). They can then never be pruned, so the check always has
     well-defined inputs and reads the SAME post-prune `formData` the graph routes
     on.
   - With that guaranteed, value gaps still fail closed: a non-numeric/absent total,
     a non-array detail value, or a row whose amount cell is empty/non-numeric →
     reject (the control cannot verify a row it cannot read). The form-schema layer
     enforces field TYPES; this check enforces VALUE consistency on a type-valid
     submission.

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
- none of the three referenced fields carries a `visibilityRule` — they must be
  unconditionally present so the check always has its inputs (Decision 4).
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
- mapped fields with any `visibilityRule` → rejected at template-save (the submit
  helper never has to guess whether a pruned value should count);
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
- a mapping referencing a `visibilityRule`-bearing field → REJECTED at template-save;
- the amount-tier preset mapping is persisted on create and survives readback;
- template WITHOUT the mapping → unaffected (no check path executed).

### Gate C — no scope creep
The check only ever REJECTS; it NEVER mutates `formData` (no auto-fill — that is
the auto-sum lock). No currency conversion, no multi-detail, no tolerance band.

## Remaining gaps (#3176 shipped the capability; §2 since closed by #3183; §1 and §3 open)

Status: #3183 landed the preset mapping (§2) BEFORE the FE preserve (§1), INVERTING
the intended order — so the exposure §1 warned about is now live on shipped preset
templates. FE preserve (§1) is the active first priority; the auto-sum lock (#3189,
design-only) rides the same save path and is also blocked on it. Visibility (§3) last.

1. **[P1 — ACTIVE EXPOSURE] FE authoring save silently drops the mapping on a
   now-SHIPPED control.** With #3183 putting real mappings on the amount-tier presets
   (§2), this is no longer hypothetical: a preset-created template carries
   `formSchema.amountConsistencyCheck` (backend-persisted), but `templateAuthoring.ts`
   has no hydrate/preserve — `draftFromTemplate` reads only `template.formSchema.fields`
   and `buildFormSchema()` returns `{ fields }`. So the first time an admin opens such
   a template in the authoring editor and saves, the mapping is silently dropped and
   the control fails. The FE `FormSchema` TYPE already carries the field; the fix is
   `draftFromTemplate` hydrate + `buildFormSchema` preserve + a mounted save round-trip
   test. FIRST PRIORITY.
2. **[DONE — #3183] Amount-tier presets declare the mapping.** Closed by `4f6cd83b2`
   (#3183): `commonTemplatePresets.ts` `withAmountConsistency()` wires reimbursement
   `{ amount, expense_items, amount }` and purchase `{ amount, purchase_items, amount }`,
   with preset coverage. Retained as a record — the capability is shipped; its
   durability through the authoring editor depends on §1 (which landed AFTER it, hence
   the live exposure above).
3. **[P2] `visibilityRule` policy mismatch.** This lock (Decision 4 / Mapping shape /
   Gate B) asserts a SAVE-TIME reject of `visibilityRule`-bearing mapped fields, but
   `normalizeAmountConsistencyCheck` validates existence + type only — the shipped
   behavior is fail-closed at SUBMIT (a pruned mapped field → absent value → reject),
   not at save. Align one way: add the save-time reject, OR ratify "submit-time
   fail-closed" and drop the save-time claim from those three places.

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
