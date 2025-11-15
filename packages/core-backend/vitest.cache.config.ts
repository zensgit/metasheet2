import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    threads: false,
    pool: 'forks',
    include: ['src/cache/__tests__/**/*.test.ts'],
    isolate: true,
    watch: false
  }
})

