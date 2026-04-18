# Yjs Backend Build Baseline Fix Verification

- Date: 2026-04-18
- Branch baseline: clean worktree from latest `main`

## Commands

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/api-token-webhook.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/chart-dashboard.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/automation-v1.test.ts tests/unit/yjs-cleanup.test.ts --watch=false
docker build -f Dockerfile.backend -t metasheet2-backend:yjs-baseline-fix-0f10cd181 <clean-exported-context>
docker build -f Dockerfile.frontend -t metasheet2-web:yjs-baseline-fix-0f10cd181 <clean-exported-context>
```

## Results

### Build

```text
pnpm --filter @metasheet/core-backend build
-> success

pnpm --filter @metasheet/web build
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

docker build -f Dockerfile.frontend -t metasheet2-web:yjs-baseline-fix-0f10cd181 <clean-exported-context>
-> success
-> local image tag: metasheet2-web:yjs-baseline-fix-0f10cd181
```

## Notes

- Vite printed its existing CJS deprecation warning during Vitest startup.
- Frontend build and frontend Docker build both printed the existing large-chunk warnings from Vite, but completed successfully.
- No new failing unit tests were introduced by this fix set.
- The code changes are backend-only; frontend verification here was limited to build-level regression checks so the next GHCR release can use a clean full-stack baseline.
- Docker verification used a clean `git archive` export instead of the active worktree because the worktree had local `node_modules` noise from `pnpm install`.
