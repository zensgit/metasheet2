import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createEventTestMigrationProvider, futureMigrationName, migrationName, registerEventMigrationLoaders } from '../fixtures/security-events/migrations'

// No database: exercise the native Kysely imports used by the DB suite's beforeAll.
describe('E1-A native migration loading', () => {
  let migrations: Awaited<ReturnType<ReturnType<typeof createEventTestMigrationProvider>['getMigrations']>>
  let unregister: ReturnType<typeof registerEventMigrationLoaders>
  beforeAll(async () => {
    unregister = registerEventMigrationLoaders()
    migrations = await createEventTestMigrationProvider().getMigrations()
  })
  afterAll(async () => { await unregister?.() })
  afterEach(() => { expect(expect.getState().assertionCalls).toBeGreaterThan(0) })

  it('loads the real migration chain with a later throwing fixture', () => {
    const names = Object.keys(migrations).sort()
    const index = names.indexOf(migrationName)
    expect(index).toBeGreaterThan(0)
    expect(names.indexOf(futureMigrationName)).toBeGreaterThan(index)
    expect(typeof migrations[migrationName].up).toBe('function')
    expect(typeof migrations[migrationName].down).toBe('function')
    for (const migration of Object.values(migrations)) expect(typeof migration.up).toBe('function')
    console.info('E1_PROVIDER_LOADED', names.length - 1, 'real migrations; later fixture present')
  })

  it('fails if the future fixture is executed', async () => {
    await expect(migrations[futureMigrationName].up()).rejects.toThrow('E1A_FUTURE_MIGRATION_EXECUTED')
  })
})
