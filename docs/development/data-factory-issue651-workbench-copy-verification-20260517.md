# Data Factory issue #651 workbench copy verification - 2026-05-17

## Summary

This verifies the frontend-only usability follow-up for issue #651. The change
makes Data Factory's dataset-selection path explicit and replaces the most
visible engineering-oriented `Pipeline 执行` heading with business-facing
`运行与推送`.

## Local Commands

### Data Factory view spec

```bash
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
```

Expected:

- The view renders `数据工厂`.
- The quick flow contains `选来源系统 -> 选来源数据集`.
- The source/target selector section renders `选择系统与数据集`.
- The source column renders `1. 选来源系统与数据集`.
- The target column renders `2. 选目标系统与数据集`.
- The execution section renders `运行与推送`.
- The old heading `Pipeline 执行` is absent.

Result:

```text
PASS - 1 file, 7 tests
```

### Frontend type check

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Expected:

- Exit code `0`.

Result:

```text
PASS - exit 0
```

### Frontend build

```bash
pnpm --filter @metasheet/web build
```

Expected:

- Web bundle builds successfully.
- Existing Vite chunk warnings may still appear; they are unrelated to this
  copy-only change.

Result:

```text
PASS - vite build completed
```

Observed warnings:

- Existing WorkflowDesigner dynamic/static import chunking warning.
- Existing large chunk warnings.

### Diff hygiene

```bash
git diff --check
```

Expected:

- Exit code `0`.

Result:

```text
PASS - exit 0
```

## Risk Checks

- No backend files changed.
- No migration files changed.
- No API contract changed.
- No route changed.
- Existing test IDs are preserved.
- The workbench still uses the existing pipeline save/run APIs internally.
