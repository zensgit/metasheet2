import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMigrationWith } from '../../src/db/migrate'

function makeFakeKysely() {
  const calls: string[] = []
  const chain = {
    addColumn: () => chain,
    columns: () => chain,
    on: () => chain,
    column: () => chain,
    unique: () => chain,
    ifExists: () => chain,
    cascade: () => chain,
    execute: () => Promise.resolve(),
  }
  return {
    calls,
    schema: {
      createTable: (name: string) => { calls.push(`createTable:${name}`); return chain },
      createIndex: (name: string) => { calls.push(`createIndex:${name}`); return chain },
      dropTable: (name: string) => { calls.push(`dropTable:${name}`); return chain },
    },
  }
}

describe('migrate runner', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('runs migration with provided Kysely instance', async () => {
    const fake = makeFakeKysely()
    const migration = { async up(db: any) { await db.schema.createTable('t').execute(); await db.schema.createIndex('i').on('t').column('c').execute() } }
    await expect(runMigrationWith(fake as any, undefined, migration, 'test.ts')).resolves.toBeUndefined()
    expect(fake.calls).toContain('createTable:t')
    expect(fake.calls).toContain('createIndex:i')
  })

  it('throws when neither db nor pool available', async () => {
    const migration = { async up() {} }
    await expect(runMigrationWith(undefined, undefined, migration, 'test.ts')).rejects.toThrow('No database connection available')
  })
})

