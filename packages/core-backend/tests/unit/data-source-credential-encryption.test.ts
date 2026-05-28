import { describe, expect, it } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

// Stateful Kysely stand-in: insert captures the persisted record (with its
// encrypted-at-rest config), select returns active rows for loadFromDatabase.
function statefulFakeDb() {
  const rows = new Map<string, Record<string, unknown>>()
  const insertBuilder = () => {
    let pending: Record<string, unknown> = {}
    const b = {
      values: (v: Record<string, unknown>) => { pending = v; return b },
      onConflict: () => b,
      execute: async () => { rows.set(pending.id as string, { ...pending }); return [] },
    }
    return b
  }
  const selectBuilder = () => {
    const b = {
      selectAll: () => b,
      where: () => b,
      execute: async () => [...rows.values()].filter((r) => r.is_active === true && r.deleted_at == null),
    }
    return b
  }
  return {
    rows,
    db: {
      selectFrom: () => selectBuilder(),
      insertInto: () => insertBuilder(),
      updateTable: () => ({ set: () => ({ where: () => ({ execute: async () => [] }) }) }),
      deleteFrom: () => ({ where: () => ({ execute: async () => [] }) }),
    },
  }
}

function dbRow(id: string, credentials: Record<string, unknown>) {
  return {
    id,
    name: id,
    type: 'postgres',
    description: null,
    config: { connection: {}, credentials },
    status: 'disconnected',
    last_connected_at: null,
    last_error: null,
    owner_id: 'a',
    workspace_id: null,
    is_active: true,
    auto_connect: false,
    metadata: null,
    tags: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  }
}

function pgConfigWithCreds(id: string): DataSourceConfig {
  return {
    id,
    name: id,
    type: 'postgres',
    connection: { host: 'localhost', port: 5432, database: 'x' },
    // trailing space in password is significant and must survive the round-trip
    credentials: { username: 'u', password: 'p@ss ', apiKey: 'key-123', token: 'tok-xyz' },
    options: { autoConnect: false },
  }
}

describe('A1 credential encryption at rest', () => {
  it('encrypts secret fields at rest and decrypts on reload (username plaintext, no trim)', async () => {
    const { db, rows } = statefulFakeDb()
    const m1 = new DataSourceManager({ db: db as never })
    await m1.addDataSource(pgConfigWithCreds('ds1'), { ownerId: 'a' })

    // at rest: secrets are enc:, the identifier is not
    const stored = (rows.get('ds1') as { config: { credentials: Record<string, string> } }).config.credentials
    expect(stored.password).toMatch(/^enc:/)
    expect(stored.apiKey).toMatch(/^enc:/)
    expect(stored.token).toMatch(/^enc:/)
    expect(stored.username).toBe('u')

    // reload (fresh manager) decrypts back to the exact plaintext
    const m2 = new DataSourceManager()
    await m2.initialize(db as never)
    const creds = m2.getDataSource('ds1').getConfig().credentials as Record<string, string>
    expect(creds.password).toBe('p@ss ') // exact, incl. trailing space (no trim)
    expect(creds.apiKey).toBe('key-123')
    expect(creds.token).toBe('tok-xyz')
    expect(creds.username).toBe('u')
  })

  it('passes legacy plaintext credentials through unchanged (lazy migration)', async () => {
    const { db, rows } = statefulFakeDb()
    rows.set('legacy', dbRow('legacy', { username: 'u', password: 'plain-pw' }))
    const m = new DataSourceManager()
    await m.initialize(db as never)
    const creds = m.getDataSource('legacy').getConfig().credentials as Record<string, string>
    expect(creds.password).toBe('plain-pw')
  })

  it('fails loud (skips the source on load) when an encrypted credential cannot be decrypted', async () => {
    const { db, rows } = statefulFakeDb()
    rows.set('ok', dbRow('ok', { password: 'plain' }))
    rows.set('corrupt', dbRow('corrupt', { password: 'enc:invalid' }))
    const m = new DataSourceManager()
    await m.initialize(db as never)
    expect(() => m.getDataSource('ok')).not.toThrow() // valid row still loads
    expect(() => m.getDataSource('corrupt')).toThrow(/not found/) // undecryptable row skipped
  })

  it('round-trips a secret that literally starts with the enc: prefix', async () => {
    const { db, rows } = statefulFakeDb()
    const m1 = new DataSourceManager({ db: db as never })
    await m1.addDataSource(
      {
        id: 'pfx',
        name: 'pfx',
        type: 'postgres',
        connection: { host: 'localhost', port: 5432, database: 'x' },
        credentials: { username: 'u', password: 'enc:literal-secret', apiKey: 'enc:also', token: 'enc:too' },
        options: { autoConnect: false },
      },
      { ownerId: 'a' },
    )

    // must be genuinely encrypted, NOT passed through because it looked encrypted
    const stored = (rows.get('pfx') as { config: { credentials: Record<string, string> } }).config.credentials
    expect(stored.password).toMatch(/^enc:/)
    expect(stored.password).not.toBe('enc:literal-secret')

    const m2 = new DataSourceManager()
    await m2.initialize(db as never)
    const creds = m2.getDataSource('pfx').getConfig().credentials as Record<string, string>
    expect(creds.password).toBe('enc:literal-secret')
    expect(creds.apiKey).toBe('enc:also')
    expect(creds.token).toBe('enc:too')
  })
})
