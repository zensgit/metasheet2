# Amount Server-Side Total Check — Design Lock

Status: RATIFIED — RUNTIME NOT BUILT

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
   create a phantom mismatch. The implementation scales each value to a fixed number
   of decimal places (default 2), sums, and compares exactly. No tolerance band in
   v1 (a money control is exact); a configurable epsilon is out of scope.

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

6. **`amountConsistencyCheck` needs an explicit persisted home + an allowlisted
   re-emit — or it is silently dropped (the G-5 lesson).**
   The mapping is a NEW persisted template field, and the exact audit that drove
   G-5 applies: the template save/normalization path rebuilds its output from a
   FIXED set of keys and drops anything it does not re-emit. So the mapping must
   live in a dedicated, explicitly-normalized slot — a nullable
   `amount_consistency_check` column on the template (parallel to `form_schema` /
   `approval_graph`), NOT tucked inside `form_schema` or graph `metadata` where a
   different normalizer owns the shape and would flatten it. Build scope therefore
   includes a migration (new nullable column), the create/update-template DTO, and
   an explicit normalize-and-re-emit of the mapping in the save path (validated per
   "Mapping shape"). Without this, the control config is dropped on the first save
   and the check silently never runs — fail-OPEN, the precise failure mode this lock
   exists to prevent.

## Mapping shape and authoring-time validation

`amountConsistencyCheck?: { totalFieldId: string; detailFieldId: string; amountColumnId: string }`
sits on the template alongside `formSchema` / `approvalGraph`, is persisted
verbatim, and is validated at TEMPLATE-SAVE time (fail-closed authoring), mirroring
the assignee-source allowlist discipline:

- `totalFieldId` references a top-level field of `type: 'number'`.
- `detailFieldId` references a top-level field of `type: 'detail'`.
- `amountColumnId` references a `type: 'number'` entry in that detail field's
  `columns` (leaf sub-fields; the model already forbids nested `detail`).
- none of the three referenced fields carries a `visibilityRule` — they must be
  unconditionally present so the check always has its inputs (Decision 4).

A mapping that points at a missing or wrong-typed field is REJECTED at save — the
unsupported-config gate, not a runtime surprise. A template carrying an
`amountConsistencyCheck` whose shape the backend does not re-emit is fail-closed in
the authoring UI exactly as G-5 handles unknown approval-node keys.

## Build Gates

### Gate A — submit-time check + fail-closed unit tests
A pure `validateAmountTotalConsistency(formSchema, normalizedFormData, mapping)`
helper (no DB), unit-tested both directions:
- matching total ↔ row sum → passes;
- under-stated total (the bypass) → rejected;
- over-stated total → rejected;
- a hidden/pruned row drops out of BOTH sides → still consistent (no false reject);
- non-numeric total / non-array detail / non-numeric amount cell → rejected;
- float-drift case (`0.1 + 0.2` vs `0.3`) → passes (money-safe scaling);
- no mapping → no check (the helper is never invoked).

### Gate B — real-DB acceptance
A real-DB `createApproval` + create/update-template, mirroring the create-template
smoke:
- the `amount_consistency_check` mapping survives a template save→reload round-trip,
  NOT dropped by normalization (the Decision 6 silent-drop regression);
- template WITH the mapping + a mismatched submission → REJECTED, no approval row
  written;
- same template + a matching submission → `201` + created;
- a mapping referencing a `visibilityRule`-bearing field → REJECTED at template-save;
- template WITHOUT the mapping → unaffected (no check path executed).

### Gate C — no scope creep
The check only ever REJECTS; it NEVER mutates `formData` (no auto-fill — that is
the auto-sum lock). No currency conversion, no multi-detail, no tolerance band.

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
