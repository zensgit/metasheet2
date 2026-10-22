import { defineConfig, mergeConfig } from 'vitest/config'
import path from 'node:path'
import base from '../../vitest.config'
export default mergeConfig(base, defineConfig({
  root: path.resolve(__dirname, '../..'),
  cacheDir: path.resolve(__dirname, '../../../../artifacts/csv-calendar/vite-cache-protocol'),
  test: { include: ['tests/attendance-import-timezone-protocol/csv-protocol.ts'], exclude: [],
    reporters: ['verbose', 'json'], outputFile: { json: path.resolve(__dirname, '../../../../artifacts/csv-calendar/csv-result.json') },
    maxWorkers: 1, minWorkers: 1, testTimeout: 60000, hookTimeout: 120000 },
}))
