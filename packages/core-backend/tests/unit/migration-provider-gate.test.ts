import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transaction } from 'kysely'
import { createCoreBackendMigrationProvider } from '../../src/db/migration-provider'
import { runAuthorizationSchemaMutation } from '../../src/rbac/authorization-input-lock'

vi.mock('../../src/rbac/authorization-input-lock', () => ({ runAuthorizationSchemaMutation: vi.fn() }))
const gate = vi.mocked(runAuthorizationSchemaMutation)
const roots: string[] = []

async function fixture(name = '202611170001_code.mjs') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'metasheet-migration-gate-'))
  roots.push(root)
  const runtimeDir = path.join(root, 'src', 'db')
  const directory = path.join(runtimeDir, 'migrations')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, name), name.endsWith('.sql') ? 'SELECT 1;' :
    'export async function up(db) { db.events.push("up") }\nexport async function down(db) { db.events.push("down") }\n')
  return runtimeDir
}

beforeEach(() => { gate.mockReset().mockImplementation(async (tx, work) => work(tx)) })
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const owned = path.resolve(root)
    if (path.dirname(owned) !== path.resolve(os.tmpdir()) || !path.basename(owned).startsWith('metasheet-migration-gate-')) throw new Error('Unowned fixture')
    await fs.rm(owned, { recursive: true, force: true })
  }
})

describe('migration schema gate wiring', () => {
  it('guards code up/down first and passes the same transaction to both bodies', async () => {
    const runtimeDir = await fixture()
    const migrations = await createCoreBackendMigrationProvider({ runtimeDir }).getMigrations()
    const events: string[] = []
    const tx = { isTransaction: true, events } as unknown as Transaction<unknown>
    gate.mockImplementation(async (received, work, options) => {
      expect(received).toBe(tx)
      expect(options).toEqual({ caller: 'core_migration_provider' })
      events.push('gate')
      return work(received)
    })
    await migrations['202611170001_code'].up(tx)
    await migrations['202611170001_code'].down?.(tx)
    expect(events).toEqual(['gate', 'up', 'gate', 'down'])
    expect(gate).toHaveBeenCalledTimes(2)
  })

  it('does not run up/down when the formal entry refuses the transaction', async () => {
    const runtimeDir = await fixture()
    const migrations = await createCoreBackendMigrationProvider({ runtimeDir }).getMigrations()
    const events: string[] = []
    const refused = new Error('AUTHORIZATION_INPUT_BUSY')
    gate.mockRejectedValue(refused)
    await expect(migrations['202611170001_code'].up({ events } as never)).rejects.toBe(refused)
    await expect(migrations['202611170001_code'].down?.({ events } as never)).rejects.toBe(refused)
    expect(events).toEqual([])
    expect(gate).toHaveBeenCalledTimes(2)
  })

  it('keeps no-op history inert but guards explicitly revived SQL', async () => {
    const runtimeDir = await fixture('032_create_approval_records.sql')
    const normal = await createCoreBackendMigrationProvider({ runtimeDir }).getMigrations()
    await normal['032_create_approval_records'].up({} as never)
    expect(gate).not.toHaveBeenCalled()
    const revived = await createCoreBackendMigrationProvider({ runtimeDir, includeSupersededLegacySqlMigrations: true }).getMigrations()
    const refused = new Error('AUTHORIZATION_INPUT_BUSY')
    gate.mockRejectedValue(refused)
    await expect(revived['032_create_approval_records'].up({} as never)).rejects.toBe(refused)
    expect(gate).toHaveBeenCalledTimes(1)
  })
})
