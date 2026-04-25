# Approval Field Visibility Design - 2026-04-24

## Objective

Add a minimal field-visibility rule model to approval templates so form fields can be conditionally hidden during approval creation without storing stale hidden values.

This is intentionally a runtime and read-only review slice. It does not add a full template-authoring UI for editing visibility rules.

## Rule Model

Each approval form field may define one `visibilityRule`:

```ts
{
  dependsOn: string
  operator: 'eq' | 'neq' | 'in' | 'isEmpty' | 'notEmpty'
  value?: unknown
}
```

The rule is single-dependency by design. That keeps persisted template JSON stable and avoids introducing a boolean-expression DSL before the product has real usage data.

## Backend Semantics

Template validation rejects invalid visibility rules before persistence:

- missing dependency fields
- self references
- invalid operator/value combinations
- dependency cycles

Approval creation evaluates visibility against submitted form data:

- hidden required fields do not fail validation
- hidden field values are pruned before persistence
- graph execution receives the pruned form data, not the raw client payload

This preserves the server as the authoritative guard. The frontend can hide fields for UX, but it is not trusted for correctness.

## Frontend Semantics

`apps/web/src/approvals/fieldVisibility.ts` mirrors the backend rule evaluation for form rendering:

- fields are visible unless a rule explicitly hides them
- hidden values are removed from local submit state
- default values can be restored when a field becomes visible again

`TemplateDetailView` renders a read-only visibility-rule section so admins can inspect template behavior even before an authoring UI exists.

## Non-Goals

- no multi-condition or nested boolean rules
- no field-visibility editor in template authoring
- no role/user-based field-level permission model
- no schema migration; rules live inside existing template JSON

## Risk Controls

- Backend tests cover validation, pruning, and graph input behavior.
- Frontend tests cover field rendering and existing approval permission behavior.
- The rule evaluator is small and duplicated deliberately across backend/frontend to keep the client UX aligned while retaining backend authority.
