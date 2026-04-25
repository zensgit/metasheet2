# Approval Form-Data Prune-Order Audit · Design

> Date: 2026-04-26
> Trigger: post-merge audit of PR #1139 (`feat(approvals): add template field visibility rules`) raised a follow-up note in the audit comment ([#1139 issue-comment](https://github.com/zensgit/metasheet2/pull/1139#issuecomment-4320429341)).
> Scope: Verify that hidden-field validation errors do not leak field IDs, by confirming `pruneHiddenFormData()` runs **before** any validation that emits `${field.id}` in error strings.

## Concern raised

`ApprovalGraphExecutor.ts` validation paths (e.g. type checks, length checks, pattern checks at lines 307-412) emit error strings of the form `${field.id} must be ...`. If `pruneHiddenFormData()` were called **after** validation, a request submitting invalid data into a hidden field would surface that field's ID in a 400 response — a small information disclosure that lets clients enumerate hidden field IDs by sending bad payloads.

The audit comment marked this as a low-priority follow-up because:

- the question was unverified in the PR #1139 review pass;
- a fix (if needed) is one line — moving the prune ahead of any error path naming fields, or making errors reference indexes/codes instead of field IDs.

## Verification result

**No fix required.** The current main branch (`origin/main` @ `58862b394`) already calls prune **before** validation in the only customer-reachable backend submit path:

`packages/core-backend/src/services/ApprovalProductService.ts:1614-1615`

```ts
const formSchema = asFormSchema(bundle.version.form_schema)
const normalizedFormData = pruneHiddenFormData(formSchema, request.formData)         // ← prune first
const validationErrors = validateApprovalFormData(formSchema, normalizedFormData)    // ← validate only the already-pruned (visible) fields
if (validationErrors.length > 0) {
  throw new ServiceError(
    'Approval form data is invalid',
    400,
    'VALIDATION_ERROR',
    { errors: validationErrors },
  )
}
```

Behavior:

| Field state | Submitted value | What happens |
|---|---|---|
| Visible, valid | accepted by validator | persisted |
| Visible, invalid | validator returns error containing `${field.id}` (acceptable — caller can already see this field) | 400 with field id in error |
| **Hidden, valid** | stripped by prune → not in `normalizedFormData` → not validated → silently dropped | persisted record contains only visible-field data |
| **Hidden, invalid** | stripped by prune → not validated → **no error string mentioning field id is ever emitted** | 200 if all visible fields validate; the hidden invalid value is silently dropped along with the field |

The information-disclosure window described in the audit follow-up does not exist in the current code path.

## Other call sites surveyed

`git grep` for `pruneHiddenFormData` and `getVisibleFormFieldIds` on `origin/main` returned five hits:

| Site | File:line | Risk class | Result |
|---|---|---|---|
| Backend submit path | `packages/core-backend/src/services/ApprovalProductService.ts:1614` | High (customer-reachable) | ✅ Prune precedes validation (this audit) |
| Backend internal helper | `packages/core-backend/src/services/ApprovalGraphExecutor.ts:423` | Internal | Used inside graph execution; no error response surface |
| Frontend helper | `apps/web/src/approvals/fieldVisibility.ts:74` | UI ergonomics, not a security boundary | Not in audit scope (frontend prune is for UI hint only — backend is the security boundary) |
| Frontend test | `apps/web/tests/approval-field-visibility.spec.ts:43` | Test only | n/a |
| Backend test | `packages/core-backend/tests/unit/approval-graph-executor.test.ts` (covered indirectly) | Test only | n/a |

No additional risky call sites found.

## Recommendation

- **No code change required for this audit.** The prune-order is correct.
- **Document the invariant** so future refactors don't accidentally swap the order. This audit doc itself serves as the record; consider adding an inline comment near `ApprovalProductService.ts:1614` if a refactor is happening in that area.
- **Treat this audit as closing follow-up note from PR #1139's post-merge review.** No subsequent ticket needed.

## Out of scope

- Frontend `pruneHiddenFormData` audit: frontend visibility is UI ergonomics, not a security boundary. A user inspecting browser dev tools can already see all schema fields; backend is the only meaningful trust boundary.
- Other approval submission paths (admin override, batch import, etc.): the current `ApprovalProductService` is the canonical submit entrypoint; if/when other entrypoints are added, the same audit must be repeated.
- Field-level RBAC (read/write permissions distinct from visibility rules): a different concern (visibility = data-driven UI; RBAC = role-based access). Out of scope for this audit.

## Cross-references

- PR #1139: `feat(approvals): add template field visibility rules` — merged 2026-04-25 as commit `779fa38e2`.
- Audit comment: <https://github.com/zensgit/metasheet2/pull/1139#issuecomment-4320429341>
