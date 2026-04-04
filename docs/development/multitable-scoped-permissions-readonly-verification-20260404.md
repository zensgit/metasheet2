# Multitable Scoped Permissions Readonly Verification

Date: 2026-04-04

## Commands

### Targeted backend integration

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-context.api.test.ts tests/integration/multitable-record-form.api.test.ts
```

Result:

- passed
- `24/24` tests green

### Targeted frontend regression

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-record-drawer.spec.ts tests/multitable-form-view.spec.ts
```

Result:

- passed
- `11/11` tests green

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

The readonly permission slice is validated end-to-end:

- backend permission derivation now marks computed and explicit readonly fields correctly
- form and record context responses stay consistent
- frontend record drawer still honors scoped field permissions correctly
- builds, lint, and type-check remain green
