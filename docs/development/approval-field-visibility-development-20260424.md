## Summary

This slice adds a minimal persisted field-visibility rule to approval template form fields and wires it through both runtime validation and the approval form UI.

## Scope

- Added `visibilityRule` to approval form-field types on backend and frontend.
- Supported operators are deliberately narrow: `eq`, `neq`, `in`, `isEmpty`, `notEmpty`.
- Backend template validation now rejects:
  - missing dependency field references
  - self-references
  - invalid operator/value shapes
  - dependency cycles
- Backend approval creation now:
  - computes visible fields from submitted form data
  - skips validation for hidden fields
  - prunes hidden field values before persistence and graph execution
- Frontend approval form now:
  - shows only fields whose rule currently evaluates true
  - removes hidden values from local submit state
  - restores defaults when a field becomes visible again
- Template detail now exposes a read-only “字段显隐规则” section for admin review.

## Files

- `packages/core-backend/src/types/approval-product.ts`
- `packages/core-backend/src/services/ApprovalProductService.ts`
- `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- `packages/core-backend/tests/unit/approval-graph-executor.test.ts`
- `packages/core-backend/tests/unit/approval-product-service.test.ts`
- `packages/core-backend/tests/unit/approval-template-routes.test.ts`
- `apps/web/src/types/approval.ts`
- `apps/web/src/approvals/fieldVisibility.ts`
- `apps/web/src/views/approval/ApprovalNewView.vue`
- `apps/web/src/views/approval/TemplateDetailView.vue`
- `apps/web/tests/helpers/approval-test-fixtures.ts`
- `apps/web/tests/approval-field-visibility.spec.ts`
- `apps/web/tests/approval-e2e-permissions.spec.ts`

## Design Notes

- The rule model is intentionally single-dependency and additive. This keeps the persisted JSON stable and avoids introducing a full rule-editor or boolean-expression DSL.
- Hidden fields are pruned before persistence, not merely ignored during validation. That avoids stale hidden values surviving in stored form snapshots.
- The frontend helper mirrors the backend visibility evaluation semantics so a field that is hidden in the UI is also hidden for backend validation.

## Deferred

- No template authoring UI for editing `visibilityRule`.
- No multi-condition / nested boolean expressions.
- No dedicated display-name resolution beyond the dependent field label already present in `formSchema`.
