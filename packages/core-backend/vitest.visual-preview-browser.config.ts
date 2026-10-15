import { defineConfig } from 'vitest/config'

if (process.env.RUN_PLM_VISUAL_BROWSER_E2E !== '1') {
  throw new Error('Set RUN_PLM_VISUAL_BROWSER_E2E=1 for the real provider/browser run')
}

export default defineConfig({ test: {
  environment: 'node',
  pool: 'forks',
  poolOptions: { forks: { singleFork: true } },
  include: ['tests/e2e/plm-visual-preview-browser-e2e.test.ts'],
  passWithNoTests: false,
  testTimeout: 240_000,
  hookTimeout: 120_000,
  retry: 0,
} })
