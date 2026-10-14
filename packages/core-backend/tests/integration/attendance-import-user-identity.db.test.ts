import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'

interface IdentityDatabase {
  query(text: string, values: unknown[]): Promise<Array<Record<string, unknown>>>
}
interface IdentityMatch {
  userId?: string
  ambiguous?: boolean
  missing?: boolean
}
interface UserFixture {
  email?: string | null
  username?: string | null
  mobile?: string | null
  orgId?: string
  userActive?: boolean | null
  memberActive?: boolean | null
}

const require = createRequire(import.meta.url)
const identity = require('../../../../plugins/plugin-attendance/lib/attendance-import-user-identity.cjs') as {
  loadAttendanceImportUserIdentifierIndex(db: IdentityDatabase, orgId: string, identifiers: string[]): Promise<Map<string, IdentityMatch>>
  adoptCanonicalImportUserId(identifier: string, index: Map<string, IdentityMatch>): { userId: string | null; warning: string | null }
  importUserIdentifierLookupKey(identifier: string): string
}
const databaseUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
if (!databaseUrl) throw new Error('Attendance identity DB tests require ATTENDANCE_TEST_DATABASE_URL or DATABASE_URL')

async function withFixture(run: (fixture: {
  client: PoolClient
  db: IdentityDatabase
  seed(input: UserFixture): Promise<string>
}) => Promise<void>) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 })
  const schema = `attendance_import_identity_${randomUUID().replace(/-/g, '')}`
  let client: PoolClient | undefined
  let schemaCreated = false
  try {
    client = await pool.connect()
    await client.query(`CREATE SCHEMA "${schema}"`)
    schemaCreated = true
    // No public fallback: a dropped authorization column/table cannot resolve elsewhere.
    await client.query(`SET search_path TO "${schema}"`)
    await client.query("SET statement_timeout = '5000ms'")
    await client.query(`CREATE TABLE users (
      id text PRIMARY KEY, email text, username text, mobile text, is_active boolean
    )`)
    await client.query(`CREATE TABLE user_orgs (
      user_id text REFERENCES users(id), org_id text, is_active boolean,
      PRIMARY KEY (user_id, org_id)
    )`)
    const fixtureClient = client
    const db: IdentityDatabase = {
      async query(text, values) {
        return (await fixtureClient.query<Record<string, unknown>>(text, values)).rows
      },
    }
    await run({
      client: fixtureClient,
      db,
      async seed(input) {
        const id = randomUUID()
        await fixtureClient.query('INSERT INTO users (id, email, username, mobile, is_active) VALUES ($1, $2, $3, $4, $5)', [
          id, input.email ?? null, input.username ?? null, input.mobile ?? null,
          input.userActive === undefined ? true : input.userActive,
        ])
        await fixtureClient.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, $3)', [
          id, input.orgId ?? 'identity-org', input.memberActive === undefined ? true : input.memberActive,
        ])
        return id
      },
    })
  } finally {
    try {
      if (client && schemaCreated) await client.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      client?.release()
      await pool.end()
    }
  }
}

describe('attendance import identity resolution against PostgreSQL', () => {
  it('resolves active member email, username, and formatted mobile aliases', async () => {
    await withFixture(async ({ db, seed }) => {
      const userId = await seed({ email: 'Active@Example.TEST', username: 'Active.Login', mobile: '+86 (138) 0000-0000' })
      const identifiers = [' ACTIVE@EXAMPLE.TEST ', 'active.login', '13800000000', '+86 138-0000-0000']
      const index = await identity.loadAttendanceImportUserIdentifierIndex(db, 'identity-org', identifiers)
      for (const identifier of identifiers) {
        expect(identity.adoptCanonicalImportUserId(identifier, index)).toEqual({ userId, warning: null })
      }
    })
  })

  it.each([
    { identifier: 'shared@example.test', username: 'shared@example.test' },
    { identifier: 'shared@example.test', username: 'ｓｈａｒｅｄ＠ｅｘａｍｐｌｅ．ｔｅｓｔ' },
    { identifier: 'shared@example.test', username: 'shared@example.test\t\r\n' },
    { identifier: 'δ@example.test', username: 'Δ@example.test' },
    { identifier: '13800000000', mobile: '+86 (138) 0000-0000' },
    { identifier: '13800000000', mobile: '１３８００００００００' },
  ])('rejects different historical owners across alias fields ($identifier)', async ({ identifier, ...otherAlias }) => {
    await withFixture(async ({ db, seed }) => {
      await seed({ email: identifier })
      await seed(otherAlias)
      const index = await identity.loadAttendanceImportUserIdentifierIndex(db, 'identity-org', [identifier])
      expect(index.get(identity.importUserIdentifierLookupKey(identifier))).toEqual({ ambiguous: true })
      expect(identity.adoptCanonicalImportUserId(identifier, index)).toEqual({
        userId: null,
        warning: 'Unresolved user identifier; more than one user in this organization matches',
      })
    })
  })

  it.each([
    { mobile: '+65 6123-4567', identifier: '6561234567' },
    { mobile: '+86 123-4567', identifier: '1234567' },
    { mobile: '+86 212-3456-7890', identifier: '21234567890' },
  ])('resolves each normalized mobile form in a separate query ($identifier)', async ({ mobile, identifier: plainIdentifier }) => {
    await withFixture(async ({ db, seed }) => {
      const userId = await seed({ email: 'international@example.test', mobile })
      for (const identifier of [mobile, plainIdentifier]) {
        // Separate queries: a second input must not accidentally supply the missing candidate.
        const index = await identity.loadAttendanceImportUserIdentifierIndex(db, 'identity-org', [identifier])
        expect(identity.adoptCanonicalImportUserId(identifier, index)).toEqual({ userId, warning: null })
      }
    })
  })

  it.each([
    { mobile: '+65 6123-4567', identifier: '6561234567' },
    { mobile: '+86 123-4567', identifier: '1234567' },
    { mobile: '+86 212-3456-7890', identifier: '21234567890' },
  ])('rejects a normalized mobile identifier owned by another username ($identifier)', async ({ mobile, identifier }) => {
    await withFixture(async ({ db, seed }) => {
      await seed({ email: 'username-owner@example.test', username: identifier })
      await seed({ email: 'mobile-owner@example.test', mobile })
      const index = await identity.loadAttendanceImportUserIdentifierIndex(db, 'identity-org', [identifier])
      expect(index.get(identifier)).toEqual({ ambiguous: true })
      expect(identity.adoptCanonicalImportUserId(identifier, index)).toEqual({
        userId: null,
        warning: 'Unresolved user identifier; more than one user in this organization matches',
      })
    })
  })

  it.each(['++6561234567', '65+61234567', '6561234567+'])('ignores invalid mobile candidates returned by SQL (%s)', async (mobile) => {
    await withFixture(async ({ db, seed }) => {
      const userId = await seed({ email: 'valid-username@example.test', username: '6561234567' })
      const invalidOwnerId = await seed({ email: 'invalid-mobile@example.test', mobile })
      const observedDb: IdentityDatabase = {
        async query(text, values) {
          const rows = await db.query(text, values)
          expect(rows.some(row => row.id === invalidOwnerId)).toBe(true)
          return rows
        },
      }
      const index = await identity.loadAttendanceImportUserIdentifierIndex(observedDb, 'identity-org', ['6561234567'])
      expect(identity.adoptCanonicalImportUserId('6561234567', index)).toEqual({ userId, warning: null })
    })
  })

  it('allows the same owner to match several normalized fields', async () => {
    await withFixture(async ({ db, seed }) => {
      const userId = await seed({ email: '13800000000', username: '１３８００００００００', mobile: '+86 (138) 0000-0000' })
      const index = await identity.loadAttendanceImportUserIdentifierIndex(db, 'identity-org', ['13800000000'])
      expect(identity.adoptCanonicalImportUserId('13800000000', index)).toEqual({ userId, warning: null })
    })
  })

  it.each(['none', 'username', 'mobile', 'both'])('keeps active organization membership filtering with optional columns absent (%s)', async (missing) => {
    await withFixture(async ({ client, db, seed }) => {
      const activeId = await seed({ email: 'active@example.test', username: 'active-login', mobile: '13800000000' })
      await seed({ email: 'inactive-user@example.test', username: 'active@example.test', userActive: false })
      await seed({ email: 'inactive-member@example.test', memberActive: false })
      await seed({ email: 'null-user@example.test', userActive: null })
      await seed({ email: 'null-member@example.test', memberActive: null })
      await seed({ email: 'foreign@example.test', username: 'active@example.test', orgId: 'other-org' })
      if (missing === 'username' || missing === 'both') await client.query('ALTER TABLE users DROP COLUMN username')
      if (missing === 'mobile' || missing === 'both') await client.query('ALTER TABLE users DROP COLUMN mobile')
      const denied = ['inactive-user@example.test', 'inactive-member@example.test', 'null-user@example.test', 'null-member@example.test', 'foreign@example.test']
      const identifiers = ['active@example.test', 'active-login', '13800000000', ...denied]
      const index = await identity.loadAttendanceImportUserIdentifierIndex(db, 'identity-org', identifiers)
      expect(identity.adoptCanonicalImportUserId('active@example.test', index)).toEqual({ userId: activeId, warning: null })
      expect(identity.adoptCanonicalImportUserId('active-login', index).userId).toBe(missing === 'username' || missing === 'both' ? null : activeId)
      expect(identity.adoptCanonicalImportUserId('13800000000', index).userId).toBe(missing === 'mobile' || missing === 'both' ? null : activeId)
      for (const identifier of denied) {
        expect(index.get(identifier)).toEqual({ missing: true })
        expect(identity.adoptCanonicalImportUserId(identifier, index).userId).toBeNull()
      }
    })
  })

  it.each(['users', 'user_orgs'])('fails closed if required %s activity column is missing', async (table) => {
    await withFixture(async ({ client, db, seed }) => {
      await seed({ email: 'active@example.test' })
      await client.query(`ALTER TABLE ${table} DROP COLUMN is_active`)
      const error = await identity.loadAttendanceImportUserIdentifierIndex(db, 'identity-org', ['active@example.test'])
        .then(() => null, (failure: unknown) => failure)
      expect(error).toMatchObject({ code: '42703', message: 'ATTENDANCE_IMPORT_IDENTITY_SCHEMA_NOT_READY' })
      expect(error).not.toHaveProperty('detail')
      expect(error).not.toHaveProperty('cause')
    })
  })

  it('fails closed if the required membership table is missing', async () => {
    await withFixture(async ({ client, db, seed }) => {
      await seed({ email: 'active@example.test' })
      await client.query('DROP TABLE user_orgs')
      await expect(identity.loadAttendanceImportUserIdentifierIndex(db, 'identity-org', ['active@example.test']))
        .rejects.toMatchObject({ code: '42P01', message: 'ATTENDANCE_IMPORT_IDENTITY_SCHEMA_NOT_READY' })
    })
  })
})
