# Attendance Record Timeline Suggestion Verification

## Commands

```bash
git diff --check
pnpm --filter @metasheet/web exec vitest run tests/attendance-record-timeline.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Focused Test Result

The shared record timeline spec now verifies:

- inline timeline loading and unsupported fallback
- request-form bridge behavior
- request-type inference for one-sided timelines
- visible suggestion copy and matching CTA label

Observed result:

- `4 passed`

## Typecheck / Build

- `vue-tsc --noEmit` passed
- `@metasheet/web build` passed

## Behavioral Summary

Verified outcomes for this slice:

- the expanded record timeline now explicitly shows the suggested request type
- the action label mirrors that suggestion
- one-sided punch days surface a clearer correction path before the operator clicks
