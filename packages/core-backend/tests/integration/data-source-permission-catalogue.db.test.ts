import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import * as migration from '../../src/db/migrations/zzzz20261020160000_add_data_source_management_permissions'

const databaseUrl = process.env.PLM_VISUAL_SOURCE_TEST_DATABASE_URL
if (process.env.EXPECT_PLM_VISUAL_SOURCE_DB === '1' && !databaseUrl) {
  throw new Error('Source permission catalog requires the owned PostgreSQL URL')
}
const suite = databaseUrl ? describe : describe.skip

suite('data-source management catalog on real PostgreSQL', () => {
  const schema = 'plm_source_catalog_' + randomUUID().replaceAll('-', '')
  let owner: Pool
  let db: Kysely<unknown>

  beforeAll(async () => {
    owner = new Pool({ connectionString: databaseUrl })
    await owner.query(`CREATE SCHEMA "${schema}"`)
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({
      connectionString: databaseUrl, options: '-c search_path=' + schema,
    }) }) })
    await sql`CREATE TABLE permissions (code text PRIMARY KEY, name text, description text)`.execute(db)
    await sql`CREATE TABLE role_permissions (
      role_id text, permission_code text REFERENCES permissions(code) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_code))`.execute(db)
    await sql`CREATE TABLE user_permissions (
      user_id text, permission_code text REFERENCES permissions(code) ON DELETE CASCADE,
      PRIMARY KEY (user_id, permission_code))`.execute(db)
  })

  afterAll(async () => {
    await db?.destroy()
    if (owner) {
      await owner.query(`DROP SCHEMA "${schema}" CASCADE`)
      await owner.end()
    }
  })

  it('registers both missing identifiers idempotently without granting authority', async () => {
    expect((await sql`SELECT code FROM permissions`.execute(db)).rows).toEqual([])
    await migration.up(db)
    await migration.up(db)
    expect((await sql`SELECT code FROM permissions ORDER BY code`.execute(db)).rows).toEqual([
      { code: 'data_sources:read' }, { code: 'data_sources:write' },
    ])
    expect((await sql`SELECT * FROM role_permissions`.execute(db)).rows).toEqual([])
    expect((await sql`SELECT * FROM user_permissions`.execute(db)).rows).toEqual([])
  })

  it('preserves pre-existing descriptions, unrelated rows and explicit grants across rollback', async () => {
    await sql`UPDATE permissions SET description='pre-existing owner wording' WHERE code='data_sources:read'`.execute(db)
    await sql`INSERT INTO permissions VALUES ('unrelated:read', 'Unrelated', 'retained')`.execute(db)
    await sql`INSERT INTO role_permissions VALUES ('source_editor', 'data_sources:read')`.execute(db)
    await sql`INSERT INTO user_permissions VALUES ('source_owner', 'data_sources:write')`.execute(db)
    const rows = async () => ({
      permissions: (await sql`SELECT * FROM permissions ORDER BY code`.execute(db)).rows,
      roles: (await sql`SELECT * FROM role_permissions ORDER BY role_id, permission_code`.execute(db)).rows,
      users: (await sql`SELECT * FROM user_permissions ORDER BY user_id, permission_code`.execute(db)).rows,
    })
    const before = await rows()
    await migration.up(db)
    await db.transaction().execute(tx => migration.down(tx))
    expect(await rows()).toEqual(before)
    await migration.up(db)
    expect(await rows()).toEqual(before)
  })
})
