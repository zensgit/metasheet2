# Approval Formula Conditions — Design Lock

Status: PROPOSED — RUNTIME NOT BUILT.

Goal: make approval condition branches more flexible than today's
`fieldId + operator + value` rules, while keeping the approval backend as the
only authority for branch selection. Template authors should be able to express
conditions such as:

- `SUM({purchase_items.amount}) >= 20000`
- `{expense_type} == "差旅" AND {amount} >= 5000`
- `{leave_days} + {used_leave_days} > 5`
- `COUNT({purchase_items}) > 10`

This is the next layer above the shipped money chain:

`quantity * unit_price -> line amount -> total -> backend total-check`

The formula condition feature decides which branch is taken. It does not replace
the total-check or make FE-derived values tamper-proof.

## Current State

The approval engine already has condition nodes. A condition branch currently
contains:

```ts
interface ConditionBranch {
  edgeKey: string
  rules: ConditionRule[]
  conjunction?: 'and' | 'or'
}

interface ConditionRule {
  fieldId: string
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'isEmpty'
  value?: unknown
}
```

`ApprovalGraphExecutor.resolveConditionTarget()` evaluates branches in order and
takes the first matching branch, falling through to `defaultEdgeKey` when none
match. That branch order and fall-through behavior remain unchanged.

The web editor can already edit condition rules, conjunction, and default branch.
It cannot author formula predicates today.

## Locked Decisions

### 1. Additive Contract, Not a Rewrite

Formula conditions are an additive branch predicate. Existing rule branches keep
working byte-for-byte.

Proposed v1 shape:

```ts
interface ConditionBranch {
  edgeKey: string
  rules: ConditionRule[]
  conjunction?: 'and' | 'or'
  formula?: ConditionFormulaPredicate
}

interface ConditionFormulaPredicate {
  expression: string
}
```

Rules and formula are mutually exclusive for v1:

- `formula` absent: evaluate `rules` exactly as today.
- `formula` present: evaluate the formula and require `rules.length === 0`.

Reason: this avoids a broad graph contract rewrite and preserves old templates.
Mixing `rules` and `formula` in one branch is deferred; it can always be modeled
by writing the full boolean expression in the formula.

### 2. Narrow Approval Formula Language

This is not JavaScript and never uses `eval`.

V1 supports:

- Field references: `{amount}`, `{expense_type}`, `{leave_days}`.
- Detail sub-field references inside aggregate functions:
  `{purchase_items.amount}`.
- Literals: numbers, strings, booleans, `null`.
- Arithmetic: `+`, `-`, `*`, `/`.
- Comparisons: `==`, `!=`, `>`, `>=`, `<`, `<=`.
- Boolean operators: `AND`, `OR`, `NOT` and parentheses.
- Functions:
  - `SUM({detail.amount})`
  - `COUNT({detail})`
  - `MIN({detail.amount})`
  - `MAX({detail.amount})`

The result type MUST be boolean. A numeric or string formula is invalid for
branching unless it is compared to something.

Examples:

```text
SUM({purchase_items.amount}) >= 20000
{expense_type} == "差旅" AND {amount} >= 5000
{leave_days} + {used_leave_days} > 5
COUNT({purchase_items}) > 10
```

### 3. Approval-Specific Evaluator

Do not directly reuse the broad spreadsheet formula runtime as the branch
decision engine.

The repo already has multitable formula dry-run and a formula engine. That code
is useful as prior art and UI reference, but approval branch selection needs a
small deterministic evaluator with a narrower attack surface:

- no arbitrary code execution;
- no plugin/user-defined functions;
- no network, DB, filesystem, or cross-record lookup;
- no volatile functions such as time/random;
- no mutation;
- bounded expression length and AST size.

If implementation reuses any existing formula parser utilities, it must still
wrap them in an approval-specific validator that enforces the v1 allowlist above.

### 4. Backend Is the Only Branch Arbiter

The frontend may preview a formula result, but the backend decides the branch.

At template publish:

- parse/compile every formula expression;
- validate all referenced fields against the template form schema;
- validate detail aggregate references against same-detail leaf columns;
- validate the expression returns boolean;
- fail publish on any invalid expression.

At approval execution:

- evaluate against the normalized/pruned approval form data snapshot;
- use the first matching branch, same as existing rule branches;
- take `defaultEdgeKey` when no branch matches;
- if evaluation throws or returns a non-boolean result, fail closed.

"Fail closed" means do not silently take the default branch on a formula error.
For create-time resolution the approval create should reject. For later
resolution after an action, the action should fail rather than advancing through
an untrusted branch.

### 5. Data Model and Visibility Semantics

Formula evaluation reads the same form-data view as ordinary condition rules:

- top-level hidden fields are already pruned before approval creation;
- hidden detail cells are pruned per row;
- detail rows/columns not visible to the submitted snapshot are not available to
  the formula.

Aggregate functions skip no rows by magic. They operate on the actual submitted
detail array after pruning:

- missing or non-numeric values inside numeric aggregates cause the formula to
  fail closed in v1;
- `COUNT({detail})` counts submitted rows;
- `SUM({detail.amount})` requires every referenced amount cell to be numeric.

Reason: approval routing should not silently ignore malformed monetary data.

### 6. Ordering With Money Helpers

Formula conditions run after the submitted form data has passed ordinary form
normalization and any declared amount total-check. They may read:

- FE-derived line amounts, because those are part of the submitted form data;
- FE-auto-summed totals, because the backend total-check already verified
  `total = SUM(detail.amount)` for mapped templates.

This does NOT make `amount = quantity * unit_price` tamper-proof. Backend
line-math enforcement remains a separate future lock.

### 7. Frontend Authoring Shape

Condition nodes get two predicate modes per branch:

- "Simple rule" — today's field/operator/value editor.
- "Formula" — expression editor with field/function insertion helpers.

The frontend should reuse existing formula-authoring UI patterns where useful:

- field insertion tokens like `{amount}`;
- function palette and diagnostics language from the multitable formula editor;
- a sample-data preview or dry-run, if available.

But frontend preview is only UX. It must not be the source of truth.

### 8. Dry-Run Endpoint

If a backend preview is added, it must be approval-specific, e.g.

`POST /api/approval-templates/formula-condition/dry-run`

Inputs:

- `formSchema`;
- `expression`;
- sample `formData`.

It must run the same evaluator used by publish/execution. Do not route approval
formulas through `/api/multitable/sheets/:sheetId/formula/dry-run`, because that
API is sheet-scoped and has different data/context semantics.

### 9. Backward Compatibility

- Existing templates with `rules` only are unchanged.
- Existing condition editor tests must remain green.
- Existing condition graph topology and edge semantics are unchanged.
- A formula branch cannot flatten or drop unknown graph data; unsupported shapes
  still fail closed under the existing complex-node config checks.

## Implementation Slices

### FC-1 — Backend Contract + Evaluator

- Add `ConditionFormulaPredicate` to backend and frontend approval types.
- Normalize formula branches in `normalizeApprovalGraph`.
- Add a pure `approval-condition-formula` parser/evaluator.
- Wire `ApprovalGraphExecutor.resolveConditionTarget()` to evaluate formula
  branches.
- Keep simple rule branches unchanged.

Required tests:

- simple rules still work;
- valid formula matches a branch;
- invalid syntax fails publish;
- unknown field fails publish;
- non-boolean expression fails publish;
- `SUM({detail.amount}) >= threshold` routes correctly;
- malformed runtime data fails closed, not default-branch.

### FC-2 — Authoring UI

- Add branch predicate mode switch: simple rule vs formula.
- Add formula text editor with field/function insert buttons.
- Validate references client-side as preview only.
- Preserve existing graph topology and anti-flatten guarantees.
- Add mounted wiring test: edit formula -> save payload contains `formula`;
  non-formula nodes and edges remain byte-identical.

### FC-3 — Optional Preset Upgrade / Examples

Use formula predicates in richer templates where it improves clarity, for
example:

- purchase high path: `SUM({purchase_items.amount}) >= 20000`;
- reimbursement high path: `{expense_type} == "差旅" AND {amount} >= 5000`;
- leave high path: `{leave_days} + {used_leave_days} > 5`.

This is optional. Existing amount-tier presets can remain on simple
`amount >= threshold` rules because the shipped total auto-sum and backend
total-check already make `amount` reliable.

## Non-Goals

- Arbitrary JavaScript or user scripts.
- Cross-table or cross-record lookups.
- User/org attribute formulas such as "requester's rank >= M3"; those need a
  separate snapshot/resolver design.
- Backend enforcement of line math (`amount = quantity * unit_price`).
- Replacing the simple condition-rule editor.
- AI formula generation. This can be a later convenience feature after the
  deterministic evaluator is shipped.

## Owner Decisions Before Runtime

1. Boolean syntax: accept only `AND/OR/NOT`, or also `&&/||/!` aliases?
   Recommendation: accept `AND/OR/NOT` in v1, add aliases later only if needed.
2. Aggregate strictness: fail closed on any non-numeric aggregate cell, or skip
   invalid cells? Recommendation: fail closed.
3. Dry-run timing: ship backend evaluator first without dry-run, or include the
   dry-run endpoint in FC-1? Recommendation: evaluator first, dry-run with FC-2.
