import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'src/routes/__tests__/admin-unsafe.test.ts',
      'src/routes/__tests__/guard-routes.test.ts',
      'src/routes/__tests__/internal-config.test.ts',
      'src/core/__tests__/cache-registry.test.ts',
    ],
    exclude: [],
    setupFiles: [],
    threads: false,
    isolate: true,
    watch: false,
    reporters: ['dot'],
  },
});

