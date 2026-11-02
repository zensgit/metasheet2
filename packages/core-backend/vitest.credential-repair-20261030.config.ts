import { defineConfig } from 'vitest/config'
import base from './vitest.config'

// Explicit real-DB operator validation. Missing DATABASE_URL must fail, never skip-green.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['scripts/ops-tests/dingtalk-group-credentials-20261030.case.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    retry: 0,
    maxWorkers: 1,
    minWorkers: 1,
  },
})
