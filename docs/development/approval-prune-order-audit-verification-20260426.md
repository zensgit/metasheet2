# Approval Form-Data Prune-Order Audit · Verification

> Pairs with `approval-prune-order-audit-design-20260426.md`.

## Method

Re-read of `origin/main` HEAD `58862b394` source for the approval submit / validate path. No code execution required — this is a static-analysis audit confirming a call-order invariant.

## Commands run

```bash
git fetch origin main

# Find every call site of the prune helpers
git grep -n "pruneHiddenFormData\|getVisibleFormFieldIds" origin/main -- '*.ts'

# Confirm prune precedes validation in the customer-reachable submit
git show origin/main:packages/core-backend/src/services/ApprovalProductService.ts | sed -n '1610,1625p'
```

## Evidence collected

### Call-site survey (5 hits)

```
origin/main:apps/web/src/approvals/fieldVisibility.ts:74
origin/main:apps/web/tests/approval-field-visibility.spec.ts:6
origin/main:apps/web/tests/approval-field-visibility.spec.ts:43
origin/main:packages/core-backend/src/services/ApprovalGraphExecutor.ts:237
origin/main:packages/core-backend/src/services/ApprovalGraphExecutor.ts:244
origin/main:packages/core-backend/src/services/ApprovalGraphExecutor.ts:248
origin/main:packages/core-backend/src/services/ApprovalGraphExecutor.ts:423
origin/main:packages/core-backend/src/services/ApprovalProductService.ts:26
origin/main:packages/core-backend/src/services/ApprovalProductService.ts:1614
```

The customer-reachable submit path is `ApprovalProductService.ts:1614`. Other backend hits are internal helpers / definitions. Frontend hits are UI ergonomics, not a security boundary.

### Critical sequence at `ApprovalProductService.ts:1614-1615`

```ts
const formSchema = asFormSchema(bundle.version.form_schema)
const normalizedFormData = pruneHiddenFormData(formSchema, request.formData)         // prune first
const validationErrors = validateApprovalFormData(formSchema, normalizedFormData)    // validate visible-only
if (validationErrors.length > 0) {
  throw new ServiceError(
    'Approval form data is invalid',
    400,
    'VALIDATION_ERROR',
    { errors: validationErrors },
  )
}
```

The `validateApprovalFormData(formSchema, normalizedFormData)` invocation receives the **pruned** form data on its right-hand argument. Validation iterates over `formSchema.fields` but reads values from `normalizedFormData` — meaning a hidden field has no value to type-check or pattern-check, so no error is appended for it.

### Validation error sources audited

`ApprovalGraphExecutor.ts` lines 307-412 emit error strings of the form `${field.id} must be ...` for type / format / length / range / pattern / date violations. Each requires a value in the `formData` argument; with pruned data, hidden fields contribute none.

## Result

| Question | Answer | Evidence |
|---|---|---|
| Does prune precede validation in the customer-reachable submit path? | **Yes** | `ApprovalProductService.ts:1614-1615` |
| Could a client enumerate hidden field IDs by submitting bad data? | **No** | Pruned data has no hidden field entries; no validation error names them |
| Are there other backend paths that bypass this prune? | **No additional risky paths found** | `git grep` returned only the audited paths |
| Is a code change required? | **No** | The invariant is already correct |

## Verification: no regression risk introduced by this PR

This PR contains only `docs/development/approval-prune-order-audit-{design,verification}-20260426.md`. No code, no tests, no migrations, no SDK regen. CI surface is docs-only.

```bash
git diff --check       # whitespace clean
```

## Closing follow-up from PR #1139 post-merge audit

The audit follow-up note left at <https://github.com/zensgit/metasheet2/pull/1139#issuecomment-4320429341> can be considered **resolved** by this PR. No subsequent ticket required for the prune-order concern.
