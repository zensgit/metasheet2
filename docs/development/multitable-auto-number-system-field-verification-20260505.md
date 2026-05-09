# Multitable Auto Number System Field Verification - 2026-05-05

## Commands

```bash
pnpm install --frozen-lockfile
pnpm exec tsx packages/openapi/tools/build.ts
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/record-service.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run tests/multitable-system-fields.spec.ts --watch=false --reporter=dot
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
node --test scripts/ops/multitable-openapi-parity.test.mjs
```

## Results

- Backend focused unit: `record-service.test.ts` passed, `16/16`.
- Frontend focused unit: `multitable-system-fields.spec.ts` passed, `6/6`.
- Backend build: passed.
- Frontend type-check: passed.
- OpenAPI parity guard: passed.

## Notes

- The isolated worktree initially lacked `vitest` and `tsx`; `pnpm install --frozen-lockfile` restored workspace tool links without changing the lockfile.
- The frontend Vitest run printed `WebSocket server error: Port is already in use`; the test process still completed successfully. This is local test-server noise, not a failing assertion.
- `pnpm install` produced plugin/tool `node_modules` symlink noise; those paths were restored with `git restore plugins tools` before final diff review.
