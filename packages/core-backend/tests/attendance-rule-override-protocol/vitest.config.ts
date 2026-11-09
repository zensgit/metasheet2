import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Deliberately outside the default unit glob; DATABASE_URL is mandatory in protocol.ts.
export default defineConfig({
  root: path.resolve(__dirname, '../..'),
  cacheDir: path.resolve(__dirname, '../../../../artifacts/rule-overrides/pg-vite-cache'),
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['tests/attendance-rule-override-protocol/protocol.ts'],
    reporters: ['verbose', 'json'],
    outputFile: { json: path.resolve(__dirname, '../../../../artifacts/rule-overrides/pg-result.json') },
    maxWorkers: 1,
    minWorkers: 1,
    retry: 0,
    testTimeout: 60000,
    hookTimeout: 120000,
  },
})
