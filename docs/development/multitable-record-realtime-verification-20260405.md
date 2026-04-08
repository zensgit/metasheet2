# Multitable Record Realtime Verification

Date: 2026-04-05
Branch: `codex/multitable-record-realtime-20260405`

## Commands

### Backend targeted integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/multitable-sheet-realtime.api.test.ts \
  tests/integration/multitable-attachments.api.test.ts
```

Result:

- passed
- `5/5`

### Frontend realtime/workbench regression

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/multitable-comment-realtime.spec.ts \
  tests/multitable-sheet-realtime.spec.ts \
  tests/multitable-workbench-view.spec.ts \
  tests/multitable-workbench-import-flow.spec.ts \
  tests/multitable-workbench-manager-flow.spec.ts
```

Result:

- passed
- `35/35`

### Record drawer regression

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-record-drawer.spec.ts
```

Result:

- passed
- `7/7`

### Frontend type-check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result:

- passed

### Backend build

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- passed

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Result:

- passed

Notes:

- Existing Vite chunk-size warnings remain unchanged.
- Existing `WorkflowDesigner.vue` dynamic/static import warning remains unchanged.

### Workspace lint

```bash
pnpm lint
```

Result:

- passed

### Workspace type-check

```bash
pnpm type-check
```

Result:

- passed

## Verification conclusion

This slice is ready for PR:

- backend realtime payload enrichment is covered
- frontend local merge/remove logic is covered
- record drawer behavior remains green
- build, lint, and type-check are green
