# Yjs Backend Build Baseline Fix Verification

- Date: 2026-04-18
- Branch baseline: clean worktree from latest `main`

## Commands

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/api-token-webhook.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/chart-dashboard.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts tests/unit/yjs-cleanup.test.ts --watch=false
docker build -f Dockerfile.backend -t metasheet2-backend:yjs-baseline-fix-0f10cd181 <clean-exported-context>
```

## Results

### Build

```text
pnpm --filter @metasheet/core-backend build
-> success
```

### Unit Tests

```text
tests/unit/api-token-webhook.test.ts
-> 41 passed

tests/unit/chart-dashboard.test.ts
-> 49 passed

tests/unit/automation-v1.test.ts
tests/unit/yjs-cleanup.test.ts
-> 96 passed
```

### Docker Build

```text
docker build -f Dockerfile.backend -t metasheet2-backend:yjs-baseline-fix-0f10cd181 <clean-exported-context>
-> success
-> local image tag: metasheet2-backend:yjs-baseline-fix-0f10cd181
```

## Notes

- Vite printed its existing CJS deprecation warning during Vitest startup.
- No new failing unit tests were introduced by this fix set.
- The touched code path is backend-only; no frontend validation was needed for this repair.
- Docker verification used a clean `git archive` export instead of the active worktree because the worktree had local `node_modules` noise from `pnpm install`.
