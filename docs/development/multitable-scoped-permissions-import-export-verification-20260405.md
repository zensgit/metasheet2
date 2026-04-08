# Multitable Scoped Permissions Import/Export Verification

Date: 2026-04-05

## Commands
- `pnpm --filter @metasheet/web exec vitest run tests/multitable-import.spec.ts tests/multitable-import-modal.spec.ts tests/multitable-workbench-view.spec.ts`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`
- `pnpm type-check`

## Results
- frontend targeted Vitest: `57/57` passed
- `vue-tsc --noEmit`: passed
- `@metasheet/web build`: passed
- root `pnpm lint`: passed
- root `pnpm type-check`: passed

## Notes
- vitest emitted the existing non-blocking `WebSocket server error: Port is already in use` message; tests still passed
- web build emitted the pre-existing `WorkflowDesigner.vue` dynamic/static chunking warning; build still passed
