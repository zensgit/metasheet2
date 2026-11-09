import { defineConfig, mergeConfig, type UserConfig } from 'vitest/config'
import integrationConfig from './vitest.integration.config'

// #6721 date matrix (.github/workflows/attendance-date-matrix.yml): the unchanged
// integration config plus one setup file that proves the run day reached the
// injectable attendance clocks. setupFiles arrays concatenate, so
// setup.integration.ts still runs first.
export default mergeConfig(integrationConfig as UserConfig, defineConfig({
  test: {
    setupFiles: ['./tests/setup.attendance-run-date.ts'],
  },
}))
