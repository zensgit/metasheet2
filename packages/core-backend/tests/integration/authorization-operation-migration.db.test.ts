import { randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Client, Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { down, up } from '../../src/db/migrations/zzzz20261117120000_authorization_operation_receipts'

const connectionString = process.env.PERMISSION_COMMAND_TEST_DATABASE_URL
if (connectionString) {
  const parsed = new URL(connectionString)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.pathname !== '/permission_command_test') {
    throw new Error('authorization-operation tests require the isolated loopback fixture database')
  }
}
const suite = connectionString ? describe : describe.skip
suite('authorization operation evidence migration on PostgreSQL', () => {
  const schema = `permission_operation_${randomUUID().replaceAll('-', '')}`
  const control = new Client({ connectionString })
  let db: Kysely<unknown>
  let pool: Pool
  beforeAll(async () => {
    await control.connect()
    await control.query(`CREATE SCHEMA "${schema}"`)
    pool = new Pool({ connectionString, options: `-c search_path=${schema}` })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    await up(db)
  })
  afterAll(async () => {
    if (db) await db.destroy()
    await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await control.end()
  })
  it('rolls the receipt back when mandatory audit insertion fails', async () => {
    const id = randomUUID()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`INSERT INTO authorization_operation_receipts (actor_id, client_operation_id, request_digest, expected_version, target_user_id, action, receipt)
        VALUES ('actor', $1, 'digest', 'version', 'target', '{}'::jsonb, '{}'::jsonb)`, [id])
      await expect(client.query(`INSERT INTO authorization_operation_audit (actor_id, client_operation_id, reason_origin, impact)
        VALUES ('actor', $1, 'invalid', '{}'::jsonb)`, [id])).rejects.toMatchObject({ code: '23514' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    expect((await pool.query('SELECT count(*)::int AS count FROM authorization_operation_receipts WHERE client_operation_id = $1', [id])).rows[0].count).toBe(0)
  })
  it('preserves actor text and refuses duplicate keys, orphan audit, and destructive rollback', async () => {
    const id = randomUUID()
    await pool.query(`INSERT INTO authorization_operation_receipts (actor_id, client_operation_id, request_digest, expected_version, target_user_id, action, receipt)
      VALUES ($1, $2, 'digest', 'version', 'target', '{}'::jsonb, '{}'::jsonb)`, ['actor:uuid-text', id])
    await pool.query(`INSERT INTO authorization_operation_audit (actor_id, client_operation_id, reason_origin, impact)
      VALUES ($1, $2, 'not_required', '{}'::jsonb)`, ['actor:uuid-text', id])
    expect((await pool.query('SELECT actor_id FROM authorization_operation_audit')).rows).toEqual([{ actor_id: 'actor:uuid-text' }])
    await pool.query(`INSERT INTO authorization_operation_receipts (actor_id, client_operation_id, request_digest, expected_version, target_user_id, action, receipt)
      VALUES ('second-actor', $1, 'digest', 'version', 'target', '{}'::jsonb, '{}'::jsonb)`, [id])
    await expect(pool.query(`INSERT INTO authorization_operation_receipts (actor_id, client_operation_id, request_digest, expected_version, target_user_id, action, receipt)
      VALUES ($1, $2, 'digest', 'version', 'target', '{}'::jsonb, '{}'::jsonb)`, ['actor:uuid-text', id])).rejects.toMatchObject({ code: '23505' })
    await expect(pool.query(`INSERT INTO authorization_operation_audit (actor_id, client_operation_id, reason_origin, impact)
      VALUES ('other', $1, 'not_required', '{}'::jsonb)`, [id])).rejects.toMatchObject({ code: '23503' })
    await expect(down(db)).rejects.toMatchObject({ code: '55000' })
    expect((await pool.query('SELECT count(*)::int AS count FROM authorization_operation_receipts')).rows[0].count).toBe(2)
  })
})
