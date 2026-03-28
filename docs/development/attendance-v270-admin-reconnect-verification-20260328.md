# Attendance v2.7.0 Admin Reconnect Verification

## Verified Commands

Executed in:

- `/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-v270-hotfix-20260328`

Commands run:

```bash
git diff --check
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts tests/attendance-admin-anchor-nav.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/web build
```

## Results

### Diff hygiene

- `git diff --check` passed

### Focused frontend regression coverage

`pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts tests/attendance-admin-anchor-nav.spec.ts --watch=false`

Passed:

- `2` test files
- `21` tests

Locked behaviors:

- focused admin section shell still works
- holiday calendar / base rule builder / import guide regressions stay restored
- template version detail is visible again
- import-batch diagnostics are visible again
- rule preview lab renders and returns preview summary, recommendations, selected-row detail, and source payload

### Type check

- `pnpm --filter @metasheet/web exec vue-tsc --noEmit` passed

### Production build

- `pnpm --filter @metasheet/web build` passed
- Vite finished successfully; only the existing large-chunk warnings remained

## Verified Reconnects

### Import batches

Confirmed the live admin page now renders the extracted import-batch diagnostics section and exposes:

- rollback impact estimate
- retry guidance
- mapping viewer
- selected item detail

### Template versions

Confirmed the live rule template library now supports:

- `View` on version rows
- selected-version metadata
- selected-version JSON detail

### Rule preview lab

Confirmed the live rule-set section now supports:

- draft preview trigger
- sample event builder
- scenario presets
- preview summary cards
- recommendation cards
- draft/resolved config comparison
- selected preview row detail

## Remaining Known Follow-ups

Still intentionally out of scope for this slice:

- approval-flow create `400`
- rule-set create `400` payload follow-up
- cross-route `400` vs `404` normalization
- login-route flash
