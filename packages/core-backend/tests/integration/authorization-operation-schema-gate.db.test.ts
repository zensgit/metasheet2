import { Kysely, PostgresDialect } from 'kysely'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAuthorizationSchemaMutation } from '../../src/rbac/authorization-input-lock'

const url = process.env.PERMISSION_COMMAND_TEST_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/permission_command_test') throw new Error('isolated loopback fixture required')
}
const suite = url ? describe : describe.skip
suite('schema mutation gate on synthetic PostgreSQL', () => {
  let db: Kysely<unknown>
  let client: Client
  beforeAll(async () => {
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }) })
    client = new Client({ connectionString: url }); await client.connect()
  })
  afterAll(async () => { await db.destroy(); await client.end() })
  it('refuses immediately while an authorization shared-world reader holds R0', async () => {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock_shared(20261106, 1)')
    let invoked = false
    try {
      await expect(db.transaction().execute(tx => runAuthorizationSchemaMutation(tx, async () => { invoked = true }, { caller: 'core_migration_provider' })))
        .rejects.toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', status: 409 })
      expect(invoked).toBe(false)
    } finally { await client.query('ROLLBACK') }
  })
  it('holds R0 exclusive through the transaction and releases it on rollback', async () => {
    await db.transaction().execute(async tx => {
      await runAuthorizationSchemaMutation(tx, async () => {
        expect((await client.query('SELECT pg_try_advisory_xact_lock_shared(20261106, 1) AS acquired')).rows[0].acquired).toBe(false)
      }, { caller: 'core_migration_provider' })
      throw new Error('synthetic rollback')
    }).catch(error => expect(error.message).toBe('synthetic rollback'))
    expect((await client.query('SELECT pg_try_advisory_xact_lock_shared(20261106, 1) AS acquired')).rows[0].acquired).toBe(true)
  })
})
