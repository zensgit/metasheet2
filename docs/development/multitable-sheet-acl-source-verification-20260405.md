# Multitable Sheet ACL Source Verification

## Targeted Backend Integration
- Command:
  - `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/multitable-record-form.api.test.ts tests/integration/multitable-sheet-permissions.api.test.ts`
- Result:
  - `31/31` passed

## Build
- Command:
  - `pnpm --filter @metasheet/core-backend build`
- Result:
  - passed

## Repository Gates
- Command:
  - `pnpm lint`
- Result:
  - passed

- Command:
  - `pnpm type-check`
- Result:
  - passed

## Coverage Highlights
- Verified sheet read-only narrowing on:
  - multitable context capabilities
  - record drawer `rowActions`
  - record/form read flows
- Verified `403 FORBIDDEN` on read-only sheet assignments for:
  - record create/patch/delete
  - form submit
  - field create/update/delete
  - person preset preparation
  - view create/update/delete
  - sheet delete
  - records summary
  - link options when target sheet lacks readable access

## Validation Scope
- No frontend or OpenAPI changes were included in this slice.
- Plugin `node_modules` symlink noise introduced by `pnpm install` was not staged and is outside the intended delivery scope.
