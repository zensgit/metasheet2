import { defineConfig } from 'vitest/config'
export default defineConfig({test:{environment:'node',include:['tests/integration/plm-personal-change-read-pg.realdb.ts'],
  testTimeout:30000,hookTimeout:30000,pool:'forks',poolOptions:{forks:{singleFork:true}}}})
