# Formula Function Arity Diagnostics Verification - 2026-05-05

## Verification Plan

Run focused frontend checks from a clean worktree:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-formula-editor.spec.ts --reporter=dot
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

## Results

### Dependency Setup

```bash
pnpm install --frozen-lockfile
```

Result: completed successfully. `pnpm` emitted the expected ignored-build-scripts warning. The install rewrote plugin/tool dependency symlinks, which were restored before commit with `git restore plugins tools`.

### Focused Formula Editor Spec

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-formula-editor.spec.ts --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       10 passed (10)
```

### Frontend Type Check

```bash
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
```

Result: exit 0.

### Patch Hygiene

```bash
git diff --check
```

Result: clean.

## Coverage Notes

The new spec covers:

- Too few required arguments: `IF(...)`, `DATEDIF(...)`.
- Too many bounded arguments: `ROUND(...)`, `TODAY(...)`.
- Empty snippet placeholders: `ROUND(, 2)`.
- A valid bounded call: `ROUND({fld_price}, 2)`.
