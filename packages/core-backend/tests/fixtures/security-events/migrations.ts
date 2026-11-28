import { register as registerEsm } from 'tsx/esm/api'
import { register as registerCjs } from 'tsx/cjs/api'
import { createCoreBackendMigrationProvider } from '../../../src/db/migration-provider'

export const migrationName = 'zzzz20261122140000_security_events'
export const futureMigrationName = 'zzzz99999999999999_security_events_future_fixture'

// Kysely's native import() bypasses Vitest's transform, including on Node 20.
// Keep both loaders active through up/down and release them after this suite.
export function registerEventMigrationLoaders() {
  const unregisterEsm = registerEsm()
  const unregisterCjs = registerCjs()
  return async () => {
    unregisterCjs()
    await unregisterEsm()
  }
}

export function createEventTestMigrationProvider() {
  const provider = createCoreBackendMigrationProvider()
  return {
    async getMigrations() {
      return {
        ...await provider.getMigrations(),
        [futureMigrationName]: { up: async () => { throw new Error('E1A_FUTURE_MIGRATION_EXECUTED') } },
      }
    },
  }
}
