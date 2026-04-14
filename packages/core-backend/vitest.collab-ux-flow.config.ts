import { defineConfig } from 'vitest/config'
import * as path from 'path'

export default defineConfig({
  ssr: {
    // Treat kysely and other node_modules as external so vite doesn't try to
    // load them through the vite SSR bundler (which fails in pnpm workspaces
    // when packages are not symlinked at the workspace root).
    external: ['kysely', 'pg', 'pg-pool', 'socket.io'],
    noExternal: [],
  },
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    deps: {
      interopDefault: true,
      // Prevent vite from bundling kysely — use Node's native require instead
      inline: [],
    },
    include: [
      'tests/integration/collab-ux-flow.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
    ],
    testTimeout: 30000,
    hookTimeout: 15000,
    setupFiles: ['./tests/setup.integration.ts'],
    maxConcurrency: 1,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@tests': path.resolve(__dirname, './tests'),
    },
  },
})
