import { defineConfig } from 'vitest/config'
import admin from './vitest.admin-users-realdb.config'

export default defineConfig({
  ...admin,
  test: {
    ...admin.test,
    include: ['tests/integration/admin-user-invite-manual-delivery.db.test.ts', 'tests/integration/password-session-revision.db.test.ts'],
  },
})
