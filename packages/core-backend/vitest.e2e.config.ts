import { defineConfig } from 'vitest/config'

/**
 * PLM-COLLAB Discussion read-auth line — sub-slice 6 (capstone dual-service E2E) runner.
 *
 * Isolated config: the E2E boots REAL Yuantus uvicorn subprocesses (heavy, ~10s startup) and is
 * gated behind RUN_PLM_READ_E2E so the normal unit run never touches it. Single fork, long
 * timeouts. CI wiring is DEFERRED (build-then-HOLD): the owner will wire this as the final merge
 * gate once Actions is restored.
 *
 * Run: RUN_PLM_READ_E2E=1 npx vitest run --config vitest.e2e.config.ts
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    retry: 0,
  },
})
