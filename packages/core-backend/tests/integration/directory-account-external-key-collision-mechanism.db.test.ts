import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Corp-scoped DingTalk directory identity isolation.
//
// DingTalk can return the same provider-level identity key in multiple enterprises. Directory
// accounts therefore key uniqueness on (provider, corp_id, external_key), while matching a legacy
// raw external_key must require the same corp. This suite proves both halves through the real sync
// orchestration: equal keys coexist across corps, still collide within one corp, and a raw identity
// from corp A can never auto-link an account pulled from corp B.
//
// DATABASE_URL-gated (describeIfDatabase): excluded from the no-DB vitest job so it cannot
// skip-green, and wired as a WHOLE FILE into the approval real-DB step in plugin-tests.yml
// (both points asserted by t2gate-collision-mechanism-ci-wiring.test.mjs).
const clientMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: clientMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: clientMocks.listDingTalkDepartments,
  getDingTalkDepartmentDetail: clientMocks.getDingTalkDepartmentDetail,
  listDingTalkDepartmentUsers: clientMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: clientMocks.getDingTalkUserDetail,
}))

import { query } from '../../src/db/pg'
import {
  down as corpScopeDown,
  up as corpScopeUp,
} from '../../src/db/migrations/zzzz20260725120000_scope_directory_account_external_key_by_corp'
import { createDirectoryIntegration, syncDirectoryIntegration } from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

/** One root department with one user; the user's identity fields are per-test knobs. */
type MockTenant = { unionId?: string; openId?: string; userId: string; name: string }
let activeTenant: MockTenant | null = null

describeIfDatabase('DingTalk directory account corp-scope (real sync, mocked pull)', () => {
  const cleanupIntegrationIds: string[] = []
  const cleanupUserIds: string[] = []

  beforeAll(() => {
    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('t2g-token')
    clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) =>
      parentId === '1' && activeTenant ? [{ id: 'd100', parentId: '1', name: 'Mechanism Dept', order: 1, source: {} }] : []
    )
    clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
    clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) => ({
      users:
        deptId === 'd100' && activeTenant
          ? [{ userId: activeTenant.userId, name: activeTenant.name, departmentIds: ['d100'], source: {} }]
          : [],
      nextCursor: null,
      hasMore: false,
    }))
    clientMocks.getDingTalkUserDetail.mockImplementation(async () => ({
      userId: activeTenant!.userId,
      name: activeTenant!.name,
      unionId: activeTenant!.unionId,
      openId: activeTenant!.openId,
      email: undefined,
      mobile: undefined,
      departmentIds: ['d100'],
      source: {},
    }))
  })

  afterAll(async () => {
    for (const id of cleanupIntegrationIds.splice(0)) await query(`DELETE FROM directory_integrations WHERE id = $1`, [id])
    if (cleanupUserIds.length > 0) {
      await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [cleanupUserIds])
      await query(`DELETE FROM user_external_identities WHERE local_user_id = ANY($1::text[])`, [cleanupUserIds])
      await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [cleanupUserIds])
    }
  })

  const corpIdForTag = (tag: string) => `t2g-corp-${tag}-${TS}`

  async function seedIntegration(tag: string, corpId = corpIdForTag(tag)): Promise<string> {
    const integration = await createDirectoryIntegration({
      name: `t2g-${tag}-${TS}`,
      corpId,
      appKey: `t2g-appkey-${tag}-${TS}`,
      appSecret: 't2g-secret',
      admissionMode: 'manual_only',
    })
    cleanupIntegrationIds.push(integration.id)
    return integration.id
  }

  async function accountKeys(integrationId: string): Promise<Array<{ external_key: string; is_active: boolean }>> {
    const rows = await query<{ external_key: string; is_active: boolean }>(
      `SELECT external_key, is_active FROM directory_accounts WHERE integration_id = $1 ORDER BY external_key`,
      [integrationId]
    )
    return rows.rows
  }

  /** Values-free local-directory write probe: count of department rows for one integration. */
  async function departmentCount(integrationId: string): Promise<number> {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM directory_departments WHERE integration_id = $1`,
      [integrationId],
    )
    return rows.rows[0]?.n ?? 0
  }

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('scopes account-key uniqueness by corp: equal keys across corps coexist, same-corp duplicates fail', async () => {
    const a = await seedIntegration('probe-a')
    const b = await seedIntegration('probe-b')
    const bSameCorp = await seedIntegration('probe-b-sibling', corpIdForTag('probe-b'))
    const sharedKey = `t2g-shared-${TS}`

    await query(
      `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, $4, 'Probe A', true, '{}'::jsonb)`,
      [a, corpIdForTag('probe-a'), `t2g-probe-a-${TS}`, sharedKey]
    )
    await query(
      `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, external_key, name, is_active, raw)
       VALUES ($1, 'dingtalk', $2, $3, $4, 'Probe B same key', true, '{}'::jsonb)`,
      [b, corpIdForTag('probe-b'), `t2g-probe-b-${TS}`, sharedKey]
    )
    const coexist = await query<{ corp_id: string }>(
      `SELECT corp_id FROM directory_accounts WHERE external_key = $1 ORDER BY corp_id`,
      [sharedKey],
    )
    expect(coexist.rows.map((row) => row.corp_id)).toEqual(
      [corpIdForTag('probe-a'), corpIdForTag('probe-b')].sort(),
    )

    let caught: { code?: string; constraint?: string } | null = null
    try {
      await query(
        `INSERT INTO directory_accounts (integration_id, provider, corp_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, 'dingtalk', $2, $3, $4, 'Probe B duplicate', true, '{}'::jsonb)`,
        [bSameCorp, corpIdForTag('probe-b'), `t2g-probe-b2-${TS}`, sharedKey]
      )
    } catch (error) {
      caught = error as { code?: string; constraint?: string }
    }
    expect(caught, 'same-corp duplicate unexpectedly succeeded').not.toBeNull()
    expect(caught?.code).toBe('23505')
    expect(caught?.constraint).toBe('idx_directory_accounts_provider_corp_external_key')
  })

  it('keeps the provider key raw while the uniqueness and matching layers carry corp scope', async () => {
    const a = await seedIntegration('derive')
    activeTenant = { unionId: `t2g-union-derive-${TS}`, openId: `t2g-open-derive-${TS}`, userId: `t2g-uid-derive-${TS}`, name: 'Derive' }
    const result = await syncDirectoryIntegration(a, `t2g-admin-${TS}`)
    expect(result.run.status).toBe('completed')
    const keys = await accountKeys(a)
    expect(keys).toHaveLength(1)
    // The stored provider value stays raw; corp_id is the separate scope column.
    expect(keys[0].external_key).toBe(`t2g-union-derive-${TS}`)
  })

  it('END-TO-END: two corp syncs with the same bare unionId both complete and retain their own rows', async () => {
    const corpA = await seedIntegration('e2e-a')
    const corpB = await seedIntegration('e2e-b')
    const sharedUnion = `t2g-union-shared-${TS}`

    activeTenant = { unionId: sharedUnion, userId: `t2g-uid-a-${TS}`, name: 'Overlap Person' }
    const first = await syncDirectoryIntegration(corpA, `t2g-admin-${TS}`)
    expect(first.run.status).toBe('completed')
    expect((await accountKeys(corpA)).map((r) => r.external_key)).toEqual([sharedUnion])

    // Same provider identity value, different corp-local user id and corp scope.
    activeTenant = { unionId: sharedUnion, userId: `t2g-uid-b-${TS}`, name: 'Overlap Person' }
    const second = await syncDirectoryIntegration(corpB, `t2g-admin-${TS}`)
    expect(second.run.status).toBe('completed')

    expect((await accountKeys(corpA)).map((r) => r.external_key)).toEqual([sharedUnion])
    expect((await accountKeys(corpB)).map((r) => r.external_key)).toEqual([sharedUnion])
    expect(
      await departmentCount(corpA),
      'corp-A successful sync must retain its department',
    ).toBeGreaterThan(0)
    expect(
      await departmentCount(corpB),
      'corp-B successful sync must retain its department',
    ).toBeGreaterThan(0)
  })

  it('CONTRAST (what a collision-free staging proof would look like): distinct unionIds per corp — both syncs complete and coexist', async () => {
    const corpA = await seedIntegration('ok-a')
    const corpB = await seedIntegration('ok-b')

    activeTenant = { unionId: `t2g-union-okA-${TS}`, userId: `t2g-uid-okA-${TS}`, name: 'Person A-side' }
    expect((await syncDirectoryIntegration(corpA, `t2g-admin-${TS}`)).run.status).toBe('completed')

    activeTenant = { unionId: `t2g-union-okB-${TS}`, userId: `t2g-uid-okB-${TS}`, name: 'Person B-side' }
    expect((await syncDirectoryIntegration(corpB, `t2g-admin-${TS}`)).run.status).toBe('completed')

    expect((await accountKeys(corpA)).map((r) => r.external_key)).toEqual([`t2g-union-okA-${TS}`])
    expect((await accountKeys(corpB)).map((r) => r.external_key)).toEqual([`t2g-union-okB-${TS}`])
  })

  it('does not auto-link a corp-B account to a corp-A legacy raw external identity', async () => {
    const identityUserId = `t2g-identity-a-${TS}`
    cleanupUserIds.push(identityUserId)
    await query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
      [identityUserId, `${identityUserId}@example.test`],
    )
    const sharedKey = `t2g-identity-shared-${TS}`
    await query(
      `INSERT INTO user_external_identities (
         provider, external_key, corp_id, local_user_id, profile
       ) VALUES ('dingtalk', $1, $2, $3, '{}'::jsonb)`,
      [sharedKey, corpIdForTag('identity-a'), identityUserId],
    )

    const corpB = await seedIntegration('identity-b')
    activeTenant = {
      unionId: sharedKey,
      userId: `t2g-identity-b-user-${TS}`,
      name: 'Corp B Account',
    }
    expect((await syncDirectoryIntegration(corpB, `t2g-admin-${TS}`)).run.status).toBe('completed')

    const link = await query<{ local_user_id: string | null; link_status: string; match_strategy: string | null }>(
      `SELECT l.local_user_id, l.link_status, l.match_strategy
         FROM directory_account_links l
         JOIN directory_accounts a ON a.id = l.directory_account_id
        WHERE a.integration_id = $1`,
      [corpB],
    )
    expect(link.rows).toEqual([{
      local_user_id: null,
      link_status: 'unmatched',
      match_strategy: 'none',
    }])
  })

  it('still auto-links a legacy raw external identity when account and identity share the same corp', async () => {
    const identityUserId = `t2g-identity-same-${TS}`
    cleanupUserIds.push(identityUserId)
    await query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
      [identityUserId, `${identityUserId}@example.test`],
    )
    const sharedKey = `t2g-identity-same-key-${TS}`
    const corpId = corpIdForTag('identity-same')
    await query(
      `INSERT INTO user_external_identities (
         provider, external_key, corp_id, local_user_id, profile
       ) VALUES ('dingtalk', $1, $2, $3, '{}'::jsonb)`,
      [sharedKey, corpId, identityUserId],
    )

    const integrationId = await seedIntegration('identity-same', corpId)
    activeTenant = {
      unionId: sharedKey,
      userId: `t2g-identity-same-user-${TS}`,
      name: 'Same Corp Account',
    }
    expect((await syncDirectoryIntegration(integrationId, `t2g-admin-${TS}`)).run.status).toBe('completed')

    const link = await query<{ local_user_id: string | null; link_status: string; match_strategy: string | null }>(
      `SELECT l.local_user_id, l.link_status, l.match_strategy
         FROM directory_account_links l
         JOIN directory_accounts a ON a.id = l.directory_account_id
        WHERE a.integration_id = $1`,
      [integrationId],
    )
    expect(link.rows).toEqual([{
      local_user_id: identityUserId,
      link_status: 'linked',
      match_strategy: 'external_identity',
    }])
  })
})

describeIfDatabase('directory account external-key corp-scope upgrade migration (isolated real DB)', () => {
  const dbUrl = process.env.DATABASE_URL!

  async function withOldSchema(
    run: (db: Kysely<unknown>) => Promise<void>,
  ): Promise<void> {
    const adminPool = new Pool({ connectionString: dbUrl })
    const schema = `dtcorp_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    const testPool = new Pool({
      connectionString: dbUrl,
      options: `-c search_path=${schema}`,
    })
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })
    try {
      await sql`
        CREATE TABLE directory_accounts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          provider text NOT NULL,
          corp_id text,
          external_key text NOT NULL
        )
      `.execute(db)
      await sql`
        CREATE UNIQUE INDEX idx_directory_accounts_provider_external_key
        ON directory_accounts(provider, external_key)
      `.execute(db)
      await run(db)
    } finally {
      await db.destroy()
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await adminPool.end()
    }
  }

  async function indexNames(db: Kysely<unknown>): Promise<string[]> {
    const result = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'directory_accounts'
      ORDER BY indexname
    `.execute(db)
    return result.rows.map((row) => row.indexname)
  }

  it('upgrades old schema, permits cross-corp coexistence, rejects same/null-corp duplicates, and replays', async () => {
    await withOldSchema(async (db) => {
      await sql`
        INSERT INTO directory_accounts(provider, corp_id, external_key)
        VALUES ('dingtalk', 'corp-a', 'shared')
      `.execute(db)

      await corpScopeUp(db)
      await corpScopeUp(db)
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_corp_external_key')
      expect(await indexNames(db)).not.toContain('idx_directory_accounts_provider_external_key')

      await expect(sql`
        INSERT INTO directory_accounts(provider, corp_id, external_key)
        VALUES ('dingtalk', 'corp-b', 'shared')
      `.execute(db)).resolves.toBeTruthy()
      await expect(sql`
        INSERT INTO directory_accounts(provider, corp_id, external_key)
        VALUES ('dingtalk', 'corp-a', 'shared')
      `.execute(db)).rejects.toThrow(/idx_directory_accounts_provider_corp_external_key/)

      await sql`
        INSERT INTO directory_accounts(provider, corp_id, external_key)
        VALUES ('dingtalk', NULL, 'legacy-global')
      `.execute(db)
      await expect(sql`
        INSERT INTO directory_accounts(provider, corp_id, external_key)
        VALUES ('dingtalk', NULL, 'legacy-global')
      `.execute(db)).rejects.toThrow(/idx_directory_accounts_provider_corp_external_key/)
    })
  })

  it('down refuses a data-incompatible rollback before removing the scoped protection', async () => {
    await withOldSchema(async (db) => {
      await corpScopeUp(db)
      await sql`
        INSERT INTO directory_accounts(provider, corp_id, external_key)
        VALUES
          ('dingtalk', 'corp-a', 'shared'),
          ('dingtalk', 'corp-b', 'shared')
      `.execute(db)

      await expect(corpScopeDown(db)).rejects.toThrow(/idx_directory_accounts_provider_external_key/)
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_corp_external_key')
    })
  })
})
