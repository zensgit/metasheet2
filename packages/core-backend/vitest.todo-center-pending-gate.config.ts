import { defineConfig } from 'vitest/config'
import * as path from 'path'

/**
 * Isolated process for the todo-center §3.0 shared "pending" query production-path gate
 * (todo-center-design-lock v2.14 §3.0/§5). Mirrors `vitest.elearning-pilot-auth.config.ts`: does
 * NOT use `tests/setup.integration.ts` (that file sets RBAC_BYPASS / RBAC_TOKEN_TRUST true and
 * must not be weakened). `setup.ts` below sets both flags false, plus PRODUCT_MODE / NODE_ENV /
 * RBAC_CACHE_TTL_MS, BEFORE the gate file imports auth/RBAC/`src/index`.
 *
 * The gate file is named WITHOUT a `.test.ts` / `.spec.ts` suffix on purpose, so the default
 * no-DB `vitest.config.ts` (implicit include glob `**\/*.{test,spec}.*`) never collects it in the
 * first place — no `describe.skip`-shaped green is possible because the file is never even seen
 * there. The explicit exclude entry in `vitest.config.ts` is a redundant, harmless second guard.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    deps: {
      interopDefault: true,
    },
    include: [
      'tests/todo-center-pending-gate/todo-center-pending-gate.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 30000,
    hookTimeout: 20000,
    setupFiles: ['./tests/todo-center-pending-gate/setup.ts'],
    env: {
      RBAC_BYPASS: 'false',
      RBAC_TOKEN_TRUST: 'false',
      PRODUCT_MODE: 'plm-workbench',
      RBAC_CACHE_TTL_MS: '0',
    },
    reporter: ['verbose'],
    fileParallelism: false,
    maxConcurrency: 1,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
})
