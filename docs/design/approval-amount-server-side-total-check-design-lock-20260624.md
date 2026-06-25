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

Make amount-tier routing tamper-resistant. When a template declares an
amount-consistency mapping, the backend validates at SUBMIT time that the
applicant-entered total equals the sum of that submission's detail-row amounts, and
**rejects a mismatch fail-closed** before the approval graph is built. A total that
does not match its own line items can no longer slip a request under the
higher-tier threshold.

This is a CONTROL, not a convenience. It does NOT compute or auto-fill the total
(that is detail-row auto-sum, a separate lock). It validates an applicant-supplied
total against the applicant-supplied rows.

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

4. **Hidden/pruned rows and empty states are handled consistently and fail closed.**
   - The check runs on the SAME post-`pruneHiddenFormData` `formData` the graph
     sees, so a conditionally hidden line item is excluded from BOTH the total
     interpretation and the row sum — it can neither manufacture a false mismatch
     nor open a hidden bypass.
   - A missing or non-numeric total, a missing detail field, a non-array detail
     value, or a non-numeric amount cell → fail-closed (reject), never silently
     skipped. The form-schema validation already enforces field TYPES; this check
     enforces VALUE consistency on top of a type-valid submission.

5. **One total ↔ one detail column, v1.**
   v1 maps exactly one top-level total to exactly one `number` column of one
   `detail` field. Multi-detail roll-ups, nested details (the model is one nesting
   level regardless), cross-field arithmetic, and currency conversion are out of
   scope.

## Mapping shape and authoring-time validation

`amountConsistencyCheck?: { totalFieldId: string; detailFieldId: string; amountColumnId: string }`
sits on the template alongside `formSchema` / `approvalGraph`, is persisted
verbatim, and is validated at TEMPLATE-SAVE time (fail-closed authoring), mirroring
the assignee-source allowlist discipline:

- `totalFieldId` references a top-level field of `type: 'number'`.
- `detailFieldId` references a top-level field of `type: 'detail'`.
- `amountColumnId` references a `type: 'number'` entry in that detail field's
  `columns` (leaf sub-fields; the model already forbids nested `detail`).

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
A real-DB `createApproval`, mirroring the create-template smoke:
- template WITH the mapping + a mismatched submission → REJECTED, no approval row
  written;
- same template + a matching submission → `201` + created;
- template WITHOUT the mapping → unaffected (no check path executed).

### Gate C — no scope creep
The check only ever REJECTS; it NEVER mutates `formData` (no auto-fill — that is
the auto-sum lock). No currency conversion, no multi-detail, no tolerance band.

## Non-Goals
- Detail-row auto-sum (computing/auto-filling the total) — separate later lock; it
  is the stronger fix and removes the gameable separate total entirely, but it
  pulls in a computed/rollup form-field capability and is the larger surface.
- Currency conversion / multi-currency arithmetic.
- Multi-detail roll-ups or cross-field arithmetic.
- A tolerance/epsilon band (v1 is exact).
- Inferring the total/amount fields by name or heuristic.
- `job_title` / `rank` resolver and W7 approval-result write-back (their own locks).
