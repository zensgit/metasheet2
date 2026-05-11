# Multitable Automation Nested Conditions Development - 2026-05-11

## Context

Phase 2 email real-send mailbox receipt is intentionally deferred because it needs operator-controlled SMTP credentials and a real recipient.

The next source-only Feishu parity slice targets automation conditions. `packages/core-backend/src/multitable/automation-conditions.ts` still described a V1-only flat condition list, and it accepted only backend-shaped `logic: 'and' | 'or'`.

The current frontend rule editor sends `conditions.conjunction: 'AND' | 'OR'`. Before this slice, the backend evaluator ignored `conjunction`; any frontend-authored `AND` group fell through to the default OR branch. That made multi-condition automation rules fire too broadly.

## Scope

Implemented:

- Accept both backend `logic` and frontend `conjunction` group keys.
- Default unknown/missing group logic to `and`, which is the safer fail-closed behavior for rule conditions.
- Evaluate nested condition groups recursively.
- Add backend support for `greater_or_equal` and `less_or_equal`, matching frontend condition operator types.
- Simplify executor gating so empty or malformed condition groups go through the evaluator instead of reading `.conditions.length` directly.
- Add focused unit coverage for:
  - backend `logic=and`;
  - frontend `conjunction=AND`;
  - frontend `conjunction=OR`;
  - nested group recursion;
  - inclusive comparison operators.

Not implemented:

- Frontend nested-condition editor UI.
- Condition schema migration or DB shape changes.
- New route payload validation. Existing routes already persist JSONB condition payloads.
- SMTP real mailbox receipt verification.

## Design

### Dual group shape

`ConditionGroup` now supports both:

```ts
{ logic: 'and', conditions: [...] }
{ conjunction: 'AND', conditions: [...] }
```

This preserves older backend callers while making existing frontend-authored rules execute with the intended conjunction.

### Recursive nodes

The evaluator now treats each group entry as either a leaf `AutomationCondition` or another `ConditionGroup`.

```ts
type AutomationConditionNode = AutomationCondition | ConditionGroup
```

This enables API clients and future UI work to submit nested rule trees without changing the executor contract.

### Safe fallback

If a group has neither a recognized `logic` nor `conjunction`, the evaluator uses `and`.

Reason: a malformed condition group should not broaden automation execution accidentally.

## Files Changed

- `packages/core-backend/src/multitable/automation-conditions.ts`
- `packages/core-backend/src/multitable/automation-executor.ts`
- `packages/core-backend/tests/unit/multitable-automation-conditions.test.ts`

## Follow-Ups

- Add a frontend nested-condition builder only after product confirms the desired interaction model.
- Add route-level zod validation if automation rules start accepting externally authored nested condition trees from untrusted integrations.
