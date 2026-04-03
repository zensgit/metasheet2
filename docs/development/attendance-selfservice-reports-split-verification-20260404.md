# Attendance Self-Service Reports Split Verification

## Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/web exec vitest run tests/attendance-experience-entrypoints.spec.ts tests/attendance-experience-zh-tabs.spec.ts tests/attendance-experience-mobile-zh.spec.ts tests/attendance-surface-modes.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
git diff --check
```

## Results

- `attendance-experience-entrypoints.spec.ts`: passed
- `attendance-experience-zh-tabs.spec.ts`: passed
- `attendance-experience-mobile-zh.spec.ts`: passed
- `attendance-surface-modes.spec.ts`: passed
- `vue-tsc --noEmit`: passed
- `pnpm --filter @metasheet/web build`: passed

## Notes

- The Vite build still reports the existing large-chunk warning around the web bundle. This slice does not change chunking strategy.
- No approval-center files were modified in this slice.
