import { randomUUID } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Phase A DingTalk directory identity isolation.
//
// This slice intentionally keeps the legacy global account-key index. Before the Phase B schema
// expansion can land, every running worker must already scope identity matching by corp, reject
// ambiguous provider identities, and repair account corp drift during sync. That deployment order
// prevents an old unscoped worker from observing keys admitted by a relaxed index.
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
} from '../../src/db/migrations/zzzz20260725130000_expand_directory_identity_corp_scope'
import {
  bindDirectoryAccount,
  createDirectoryIntegration,
  syncDirectoryIntegration,
  unbindDirectoryAccount,
} from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

/** One root department with one user; the user's identity fields are per-test knobs. */
type MockTenant = { unionId?: string; openId?: string; userId: string; name: string }
let activeTenant: MockTenant | null = null
let phaseBSchemaInstalled = false

describeIfDatabase('DingTalk directory account corp-scope (real sync, mocked pull)', () => {
  const cleanupIntegrationIds: string[] = []
  const cleanupUserIds: string[] = []

  beforeAll(async () => {
    const phaseBSchema = await query<{ installed: boolean }>(
      `SELECT to_regclass(
         'idx_directory_accounts_provider_corp_external_key'
       ) IS NOT NULL AS installed`,
    )
    phaseBSchemaInstalled = phaseBSchema.rows[0]?.installed ?? false
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

  async function accountId(integrationId: string): Promise<string> {
    const rows = await query<{ id: string }>(
      `SELECT id FROM directory_accounts WHERE integration_id = $1`,
      [integrationId],
    )
    const id = rows.rows[0]?.id
    if (!id) throw new Error('expected one directory account')
    return id
  }

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it.each([
    ['embedded space', 'corp a'],
    ['tab', 'corp\ta'],
    ['non-breaking space', 'corp\u00a0a'],
    ['em space', 'corp\u2003a'],
    ['byte-order mark', 'corp\ufeffa'],
  ])('rejects a non-canonical corp token containing %s', async (_label, corpId) => {
    await expect(createDirectoryIntegration({
      name: `t2g-invalid-corp-${TS}`,
      corpId,
      appKey: `t2g-invalid-corp-key-${TS}`,
      appSecret: 't2g-secret',
      admissionMode: 'manual_only',
    })).rejects.toThrow('corpId must be a printable ASCII token without whitespace')
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

  it('repairs a legacy blank account corp before Phase B or rejects it after Phase B', async () => {
    const integrationId = await seedIntegration('corp-repair')
    activeTenant = {
      unionId: `t2g-union-corp-repair-${TS}`,
      userId: `t2g-user-corp-repair-${TS}`,
      name: 'Corp Repair',
    }
    if (phaseBSchemaInstalled) {
      await expect(query(
        `INSERT INTO directory_accounts (
           integration_id, provider, corp_id, external_user_id, external_key, name, is_active, raw
         ) VALUES ($1, 'dingtalk', '', $2, $3, 'Legacy Blank Corp', true, '{}'::jsonb)`,
        [integrationId, activeTenant.userId, activeTenant.unionId],
      )).rejects.toThrow(/directory_accounts_corp_id_canonical/)
      const account = await query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM directory_accounts
          WHERE integration_id = $1`,
        [integrationId],
      )
      expect(account.rows).toEqual([{ count: 0 }])
      return
    }
    await query(
      `INSERT INTO directory_accounts (
         integration_id, provider, corp_id, external_user_id, external_key, name, is_active, raw
       ) VALUES ($1, 'dingtalk', '', $2, $3, 'Legacy Blank Corp', true, '{}'::jsonb)`,
      [integrationId, activeTenant.userId, activeTenant.unionId],
    )

    expect((await syncDirectoryIntegration(integrationId, `t2g-admin-${TS}`)).run.status).toBe('completed')
    const account = await query<{ corp_id: string }>(
      `SELECT corp_id FROM directory_accounts WHERE integration_id = $1`,
      [integrationId],
    )
    expect(account.rows).toEqual([{ corp_id: corpIdForTag('corp-repair') }])
  })

  it('fails closed when two local users claim the same corp-scoped provider unionId', async () => {
    const firstUserId = `t2g-ambiguous-first-${TS}`
    const secondUserId = `t2g-ambiguous-second-${TS}`
    cleanupUserIds.push(firstUserId, secondUserId)
    await query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, 'x'), ($3, $4, 'x')`,
      [
        firstUserId,
        `${firstUserId}@example.test`,
        secondUserId,
        `${secondUserId}@example.test`,
      ],
    )
    const corpId = corpIdForTag('ambiguous')
    const sharedUnionId = `t2g-ambiguous-union-${TS}`
    if (phaseBSchemaInstalled) {
      await query(
        `INSERT INTO user_external_identities (
           provider, external_key, provider_union_id, corp_id, local_user_id, profile
         ) VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
        [`t2g-ambiguous-key-a-${TS}`, sharedUnionId, corpId, firstUserId],
      )
      await expect(query(
        `INSERT INTO user_external_identities (
           provider, external_key, provider_union_id, corp_id, local_user_id, profile
         ) VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
        [`t2g-ambiguous-key-b-${TS}`, sharedUnionId, corpId, secondUserId],
      )).rejects.toThrow(/idx_user_external_identities_provider_corp_union/)
      const identities = await query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM user_external_identities
          WHERE provider = 'dingtalk'
            AND corp_id = $1
            AND provider_union_id = $2`,
        [corpId, sharedUnionId],
      )
      expect(identities.rows).toEqual([{ count: 1 }])
      return
    }
    await query(
      `INSERT INTO user_external_identities (
         provider, external_key, provider_union_id, corp_id, local_user_id, profile
       ) VALUES
         ('dingtalk', $1, $3, $4, $5, '{}'::jsonb),
         ('dingtalk', $2, $3, $4, $6, '{}'::jsonb)`,
      [
        `t2g-ambiguous-key-a-${TS}`,
        `t2g-ambiguous-key-b-${TS}`,
        sharedUnionId,
        corpId,
        firstUserId,
        secondUserId,
      ],
    )

    const integrationId = await seedIntegration('ambiguous', corpId)
    activeTenant = {
      unionId: sharedUnionId,
      userId: `t2g-ambiguous-directory-user-${TS}`,
      name: 'Ambiguous Provider Identity',
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
      local_user_id: null,
      link_status: 'unmatched',
      match_strategy: 'none',
    }])
  })

  it('serializes the identity snapshot before Phase B or serializes uniqueness after Phase B', async () => {
    const firstUserId = `t2g-lock-first-${TS}`
    const secondUserId = `t2g-lock-second-${TS}`
    cleanupUserIds.push(firstUserId, secondUserId)
    await query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, 'x'), ($3, $4, 'x')`,
      [
        firstUserId,
        `${firstUserId}@example.test`,
        secondUserId,
        `${secondUserId}@example.test`,
      ],
    )
    const corpId = corpIdForTag('snapshot-lock')
    const sharedUnionId = `t2g-lock-union-${TS}`
    if (phaseBSchemaInstalled) {
      const inserts = await Promise.allSettled([
        query(
          `INSERT INTO user_external_identities (
             provider, external_key, provider_union_id, corp_id, local_user_id, profile
           ) VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
          [`t2g-lock-first-key-${TS}`, sharedUnionId, corpId, firstUserId],
        ),
        query(
          `INSERT INTO user_external_identities (
             provider, external_key, provider_union_id, corp_id, local_user_id, profile
           ) VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
          [`t2g-lock-second-key-${TS}`, sharedUnionId, corpId, secondUserId],
        ),
      ])
      expect(inserts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(inserts.filter((result) => result.status === 'rejected')).toHaveLength(1)
      const identities = await query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM user_external_identities
          WHERE provider = 'dingtalk'
            AND corp_id = $1
            AND provider_union_id = $2`,
        [corpId, sharedUnionId],
      )
      expect(identities.rows).toEqual([{ count: 1 }])
      return
    }
    await query(
      `INSERT INTO user_external_identities (
         provider, external_key, provider_union_id, corp_id, local_user_id, profile
       ) VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
      [`t2g-lock-first-key-${TS}`, sharedUnionId, corpId, firstUserId],
    )

    const integrationId = await seedIntegration('snapshot-lock', corpId)
    activeTenant = {
      unionId: sharedUnionId,
      userId: `t2g-lock-directory-user-${TS}`,
      name: 'Snapshot Lock',
    }
    const seededAccount = await query<{ id: string }>(
      `INSERT INTO directory_accounts (
         integration_id, provider, corp_id, external_user_id, union_id, external_key,
         name, is_active, raw
       ) VALUES ($1, 'dingtalk', $2, $3, $4, $4, 'Snapshot Lock', true, '{}'::jsonb)
       RETURNING id::text AS id`,
      [integrationId, corpId, activeTenant.userId, sharedUnionId],
    )
    const directoryAccountId = seededAccount.rows[0].id
    const advisoryKey = 2_000_000_000 + (TS % 100_000_000)
    const functionName = `t2g_block_link_${String(TS).replace(/\D/g, '')}`
    const triggerName = `t2g_block_link_trigger_${String(TS).replace(/\D/g, '')}`
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const blocker = await pool.connect()
    const writer = await pool.connect()

    async function waitForBlockedQuery(fragment: string): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
             AND query LIKE $1`,
          [`%${fragment}%`],
        )
        if ((result.rows[0]?.count ?? 0) > 0) return
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`timed out waiting for blocked query: ${fragment}`)
    }

    try {
      await query(`
        CREATE FUNCTION ${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.directory_account_id = '${directoryAccountId}'::uuid THEN
            PERFORM pg_advisory_xact_lock(${advisoryKey});
          END IF;
          RETURN NEW;
        END
        $$
      `)
      await query(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT OR UPDATE ON directory_account_links
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()
      `)
      await blocker.query('SELECT pg_advisory_lock($1)', [advisoryKey])

      const firstSync = syncDirectoryIntegration(integrationId, `t2g-admin-${TS}`)
      await waitForBlockedQuery('INSERT INTO directory_account_links')

      const duplicateInsert = writer.query(
        `INSERT INTO user_external_identities (
           provider, external_key, provider_union_id, corp_id, local_user_id, profile
         ) VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
        [`t2g-lock-second-key-${TS}`, sharedUnionId, corpId, secondUserId],
      )
      await waitForBlockedQuery('INSERT INTO user_external_identities')

      await blocker.query('SELECT pg_advisory_unlock($1)', [advisoryKey])
      expect((await firstSync).run.status).toBe('completed')
      await duplicateInsert

      expect((await syncDirectoryIntegration(integrationId, `t2g-admin-${TS}`)).run.status).toBe('completed')
      const link = await query<{ local_user_id: string | null; link_status: string; match_strategy: string | null }>(
        `SELECT local_user_id, link_status, match_strategy
         FROM directory_account_links
         WHERE directory_account_id = $1`,
        [directoryAccountId],
      )
      expect(link.rows).toEqual([{
        local_user_id: null,
        link_status: 'unmatched',
        match_strategy: 'none',
      }])
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [advisoryKey]).catch(() => undefined)
      blocker.release()
      writer.release()
      await query(`DROP TRIGGER IF EXISTS ${triggerName} ON directory_account_links`)
      await query(`DROP FUNCTION IF EXISTS ${functionName}()`)
      await pool.end()
    }
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

  it('allows a corp-B account sharing a legacy raw unionId to bind a different local user', async () => {
    const corpAUserId = `t2g-bind-a-${TS}`
    const corpBUserId = `t2g-bind-b-${TS}`
    cleanupUserIds.push(corpAUserId, corpBUserId)
    await query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, 'x'), ($3, $4, 'x')`,
      [
        corpAUserId,
        `${corpAUserId}@example.test`,
        corpBUserId,
        `${corpBUserId}@example.test`,
      ],
    )

    const sharedKey = `t2g-bind-shared-${TS}`
    await query(
      `INSERT INTO user_external_identities (
         provider, external_key, corp_id, local_user_id, profile
       ) VALUES ('dingtalk', $1, $2, $3, '{}'::jsonb)`,
      [sharedKey, corpIdForTag('bind-a'), corpAUserId],
    )

    const corpB = await seedIntegration('bind-b')
    activeTenant = {
      unionId: sharedKey,
      userId: `t2g-bind-b-user-${TS}`,
      name: 'Corp B Bind Target',
    }
    expect((await syncDirectoryIntegration(corpB, `t2g-admin-${TS}`)).run.status).toBe('completed')

    const corpBAccountId = await accountId(corpB)
    await expect(bindDirectoryAccount(
      corpBAccountId,
      {
        localUserRef: corpBUserId,
        adminUserId: `t2g-admin-${TS}`,
        enableDingTalkGrant: false,
      },
    )).resolves.toBeTruthy()

    const identities = await query<{ external_key: string; corp_id: string; local_user_id: string }>(
      `SELECT external_key, corp_id, local_user_id
         FROM user_external_identities
        WHERE local_user_id = ANY($1::text[])
        ORDER BY local_user_id`,
      [[corpAUserId, corpBUserId]],
    )
    expect(identities.rows).toEqual([
      {
        external_key: sharedKey,
        corp_id: corpIdForTag('bind-a'),
        local_user_id: corpAUserId,
      },
      {
        external_key: `${corpIdForTag('bind-b')}:${sharedKey}`,
        corp_id: corpIdForTag('bind-b'),
        local_user_id: corpBUserId,
      },
    ])

    await unbindDirectoryAccount(corpBAccountId, {
      adminUserId: `t2g-admin-${TS}`,
      disableDingTalkGrant: false,
    })
    const identitiesAfterUnbind = await query<{ corp_id: string; local_user_id: string }>(
      `SELECT corp_id, local_user_id
         FROM user_external_identities
        WHERE local_user_id = ANY($1::text[])
        ORDER BY local_user_id`,
      [[corpAUserId, corpBUserId]],
    )
    expect(identitiesAfterUnbind.rows).toEqual([{
      corp_id: corpIdForTag('bind-a'),
      local_user_id: corpAUserId,
    }])
  })

  it('rejects a drifted account before bind writes any identity or link', async () => {
    const localUserId = `t2g-drift-bind-user-${TS}`
    cleanupUserIds.push(localUserId)
    await query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
      [localUserId, `${localUserId}@example.test`],
    )

    const integrationId = await seedIntegration('drift-bind')
    activeTenant = {
      unionId: `t2g-drift-bind-union-${TS}`,
      userId: `t2g-drift-bind-directory-user-${TS}`,
      name: 'Drift Bind',
    }
    expect((await syncDirectoryIntegration(integrationId, `t2g-admin-${TS}`)).run.status).toBe('completed')
    const directoryAccountId = await accountId(integrationId)
    await query(
      `UPDATE directory_accounts SET corp_id = $2 WHERE id = $1`,
      [directoryAccountId, corpIdForTag('other-corp')],
    )

    await expect(bindDirectoryAccount(directoryAccountId, {
      localUserRef: localUserId,
      adminUserId: `t2g-admin-${TS}`,
      enableDingTalkGrant: false,
    })).rejects.toThrow('Directory account tenant scope is inconsistent')

    const effects = await query<{ identities: number; linked: number }>(
      `SELECT
         (SELECT count(*)::int FROM user_external_identities WHERE local_user_id = $2) AS identities,
         (SELECT count(*)::int FROM directory_account_links
           WHERE directory_account_id = $1 AND link_status = 'linked') AS linked`,
      [directoryAccountId, localUserId],
    )
    expect(effects.rows).toEqual([{ identities: 0, linked: 0 }])
  })

  it('fails unbind closed on a legacy blank identity or rejects that state after Phase B', async () => {
    const localUserId = `t2g-blank-unbind-user-${TS}`
    cleanupUserIds.push(localUserId)
    await query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
      [localUserId, `${localUserId}@example.test`],
    )

    const integrationId = await seedIntegration('blank-unbind')
    activeTenant = {
      unionId: `t2g-blank-unbind-union-${TS}`,
      userId: `t2g-blank-unbind-directory-user-${TS}`,
      name: 'Blank Unbind',
    }
    expect((await syncDirectoryIntegration(integrationId, `t2g-admin-${TS}`)).run.status).toBe('completed')
    const directoryAccountId = await accountId(integrationId)
    await bindDirectoryAccount(directoryAccountId, {
      localUserRef: localUserId,
      adminUserId: `t2g-admin-${TS}`,
      enableDingTalkGrant: false,
    })
    if (phaseBSchemaInstalled) {
      await expect(query(
        `UPDATE user_external_identities SET corp_id = '' WHERE local_user_id = $1`,
        [localUserId],
      )).rejects.toThrow(/user_external_identities_corp_id_canonical/)
      const state = await query<{ corp_id: string; link_status: string; local_user_id: string }>(
        `SELECT identity.corp_id, link.link_status, link.local_user_id
           FROM user_external_identities identity
           JOIN directory_account_links link ON link.local_user_id = identity.local_user_id
          WHERE identity.local_user_id = $1
            AND link.directory_account_id = $2`,
        [localUserId, directoryAccountId],
      )
      expect(state.rows).toEqual([{
        corp_id: corpIdForTag('blank-unbind'),
        link_status: 'linked',
        local_user_id: localUserId,
      }])
      return
    }
    await query(
      `UPDATE user_external_identities SET corp_id = '' WHERE local_user_id = $1`,
      [localUserId],
    )

    await expect(unbindDirectoryAccount(directoryAccountId, {
      adminUserId: `t2g-admin-${TS}`,
      disableDingTalkGrant: false,
    })).rejects.toThrow('Directory identity tenant scope is inconsistent')

    const state = await query<{ corp_id: string; link_status: string; local_user_id: string }>(
      `SELECT identity.corp_id, link.link_status, link.local_user_id
       FROM user_external_identities identity
       JOIN directory_account_links link ON link.local_user_id = identity.local_user_id
       WHERE identity.local_user_id = $1
         AND link.directory_account_id = $2`,
      [localUserId, directoryAccountId],
    )
    expect(state.rows).toEqual([{
      corp_id: '',
      link_status: 'linked',
      local_user_id: localUserId,
    }])
  })

  it('normalizes legacy whitespace corp before Phase B or rejects it after Phase B', async () => {
    const existingUserId = `t2g-space-existing-${TS}`
    const targetUserId = `t2g-space-target-${TS}`
    cleanupUserIds.push(existingUserId, targetUserId)
    await query(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, $2, 'x'), ($3, $4, 'x')`,
      [
        existingUserId,
        `${existingUserId}@example.test`,
        targetUserId,
        `${targetUserId}@example.test`,
      ],
    )

    const corpId = corpIdForTag('space-conflict')
    const sharedUnionId = `t2g-space-union-${TS}`
    if (phaseBSchemaInstalled) {
      await expect(query(
        `INSERT INTO user_external_identities (
           provider, external_key, provider_union_id, corp_id, local_user_id, profile
         ) VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
        [
          `t2g-space-existing-key-${TS}`,
          sharedUnionId,
          `  ${corpId}  `,
          existingUserId,
        ],
      )).rejects.toThrow(/user_external_identities_corp_id_canonical/)
      const identities = await query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM user_external_identities
          WHERE local_user_id = $1`,
        [existingUserId],
      )
      expect(identities.rows).toEqual([{ count: 0 }])
      return
    }
    await query(
      `INSERT INTO user_external_identities (
         provider, external_key, provider_union_id, corp_id, local_user_id, profile
       ) VALUES ('dingtalk', $1, $2, $3, $4, '{}'::jsonb)`,
      [
        `t2g-space-existing-key-${TS}`,
        sharedUnionId,
        `  ${corpId}  `,
        existingUserId,
      ],
    )

    const integrationId = await seedIntegration('space-conflict', corpId)
    activeTenant = {
      unionId: sharedUnionId,
      userId: `t2g-space-directory-user-${TS}`,
      name: 'Whitespace Corp Conflict',
    }
    expect((await syncDirectoryIntegration(integrationId, `t2g-admin-${TS}`)).run.status).toBe('completed')

    await expect(bindDirectoryAccount(
      await accountId(integrationId),
      {
        localUserRef: targetUserId,
        adminUserId: `t2g-admin-${TS}`,
        enableDingTalkGrant: false,
      },
    )).rejects.toThrow('DingTalk account is already bound to another local user')

    const targetIdentityCount = await query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM user_external_identities
        WHERE local_user_id = $1`,
      [targetUserId],
    )
    expect(targetIdentityCount.rows).toEqual([{ count: 0 }])
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

describeIfDatabase('directory corp-scope Phase B migration (isolated real DB)', () => {
  const dbUrl = process.env.DATABASE_URL!

  async function withLegacySchema(
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
        CREATE TABLE directory_integrations (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          provider text NOT NULL DEFAULT 'dingtalk',
          corp_id text NOT NULL
        )
      `.execute(db)
      await sql`
        CREATE TABLE directory_accounts (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          integration_id uuid NOT NULL REFERENCES directory_integrations(id),
          provider text NOT NULL,
          corp_id text,
          external_key text NOT NULL
        )
      `.execute(db)
      await sql`
        CREATE TABLE user_external_identities (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          provider text NOT NULL,
          external_key text NOT NULL,
          provider_union_id text,
          provider_open_id text,
          corp_id text
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
       ORDER BY indexname
    `.execute(db)
    return result.rows.map((row) => row.indexname)
  }

  async function constraintNames(db: Kysely<unknown>): Promise<string[]> {
    const result = await sql<{ conname: string }>`
      SELECT constraint_row.conname
        FROM pg_constraint constraint_row
        JOIN pg_class table_rel ON table_rel.oid = constraint_row.conrelid
        JOIN pg_namespace namespace ON namespace.oid = table_rel.relnamespace
       WHERE namespace.nspname = current_schema()
         AND constraint_row.contype = 'c'
       ORDER BY constraint_row.conname
    `.execute(db)
    return result.rows.map((row) => row.conname)
  }

  async function runUp(db: Kysely<unknown>): Promise<void> {
    await db.transaction().execute(
      (trx) => corpScopeUp(trx as unknown as Kysely<unknown>),
    )
  }

  async function runDown(db: Kysely<unknown>): Promise<void> {
    await db.transaction().execute(
      (trx) => corpScopeDown(trx as unknown as Kysely<unknown>),
    )
  }

  it('up canonicalizes corp data, installs every scoped guard, permits cross-corp keys, and replays', async () => {
    await withLegacySchema(async (db) => {
      const integrationA = randomUUID()
      const integrationB = randomUUID()
      await sql`
        INSERT INTO directory_integrations(id, corp_id)
        VALUES (${integrationA}, ' corp-a '), (${integrationB}, 'corp-b')
      `.execute(db)
      await sql`
        INSERT INTO directory_accounts(integration_id, provider, corp_id, external_key)
        VALUES (${integrationA}, 'dingtalk', '', 'shared')
      `.execute(db)
      await sql`
        INSERT INTO user_external_identities(
          provider, external_key, provider_union_id, provider_open_id, corp_id
        ) VALUES
          ('dingtalk', 'identity-a', 'union-a', 'open-a', ' corp-a '),
          ('dingtalk', 'identity-legacy', 'union-legacy', 'open-legacy', '   ')
      `.execute(db)

      await runUp(db)
      await runUp(db)

      expect(await indexNames(db)).toEqual(expect.arrayContaining([
        'idx_directory_accounts_provider_corp_external_key',
        'idx_directory_accounts_provider_null_corp_external_key',
        'idx_user_external_identities_provider_corp_union',
        'idx_user_external_identities_provider_null_corp_union',
        'idx_user_external_identities_provider_corp_open',
        'idx_user_external_identities_provider_null_corp_open',
      ]))
      expect(await indexNames(db)).not.toContain('idx_directory_accounts_provider_external_key')
      expect(await constraintNames(db)).toEqual(expect.arrayContaining([
        'directory_integrations_corp_id_canonical',
        'directory_accounts_corp_id_canonical',
        'user_external_identities_corp_id_canonical',
      ]))

      const integrationCorps = await sql<{ corp_id: string }>`
        SELECT corp_id FROM directory_integrations ORDER BY corp_id
      `.execute(db)
      expect(integrationCorps.rows).toEqual([{ corp_id: 'corp-a' }, { corp_id: 'corp-b' }])
      const accountCorp = await sql<{ corp_id: string }>`
        SELECT corp_id FROM directory_accounts WHERE external_key = 'shared'
      `.execute(db)
      expect(accountCorp.rows).toEqual([{ corp_id: 'corp-a' }])
      const identityCorps = await sql<{ corp_id: string | null }>`
        SELECT corp_id FROM user_external_identities ORDER BY external_key
      `.execute(db)
      expect(identityCorps.rows).toEqual([{ corp_id: 'corp-a' }, { corp_id: null }])

      await expect(sql`
        INSERT INTO directory_accounts(integration_id, provider, corp_id, external_key)
        VALUES (${integrationB}, 'dingtalk', 'corp-b', 'shared')
      `.execute(db)).resolves.toBeTruthy()
      await expect(sql`
        INSERT INTO directory_accounts(integration_id, provider, corp_id, external_key)
        VALUES (${integrationA}, 'dingtalk', 'corp-a', 'shared')
      `.execute(db)).rejects.toThrow(/idx_directory_accounts_provider_corp_external_key/)
      await expect(sql`
        INSERT INTO user_external_identities(
          provider, external_key, provider_union_id, corp_id
        ) VALUES ('dingtalk', 'identity-duplicate', 'union-a', 'corp-a')
      `.execute(db)).rejects.toThrow(/idx_user_external_identities_provider_corp_union/)
      await expect(sql`
        INSERT INTO directory_accounts(integration_id, provider, corp_id, external_key)
        VALUES (${integrationB}, 'dingtalk', ' corp-b ', 'bad-corp-shape')
      `.execute(db)).rejects.toThrow(/directory_accounts_corp_id_canonical/)
      await expect(sql`
        INSERT INTO user_external_identities(provider, external_key, corp_id)
        VALUES ('dingtalk', 'bad-identity-corp-shape', '   ')
      `.execute(db)).rejects.toThrow(/user_external_identities_corp_id_canonical/)
      for (const [suffix, invalidCorp] of [
        ['tab', '\t'],
        ['newline', '\n'],
        ['nbsp', '\u00a0'],
        ['em-space', '\u2003'],
        ['bom', '\ufeff'],
      ]) {
        await expect(sql`
          INSERT INTO user_external_identities(provider, external_key, corp_id)
          VALUES ('dingtalk', ${`bad-identity-${suffix}`}, ${invalidCorp})
        `.execute(db)).rejects.toThrow(/user_external_identities_corp_id_canonical/)
      }
      await expect(sql`
        INSERT INTO user_external_identities(provider, external_key, corp_id)
        VALUES ('dingtalk', 'null-identity-corp', NULL)
      `.execute(db)).resolves.toBeTruthy()
    })
  })

  it('up fails closed and rolls back every change when a parent integration corp is blank', async () => {
    await withLegacySchema(async (db) => {
      const integrationId = randomUUID()
      await sql`INSERT INTO directory_integrations(id, corp_id) VALUES (${integrationId}, '')`.execute(db)
      await sql`
        INSERT INTO directory_accounts(integration_id, provider, corp_id, external_key)
        VALUES (${integrationId}, 'dingtalk', NULL, 'legacy')
      `.execute(db)

      await expect(runUp(db)).rejects.toThrow(/integration scope is non-canonical/)
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await indexNames(db)).not.toContain('idx_directory_accounts_provider_corp_external_key')
      expect(await constraintNames(db)).not.toContain('directory_accounts_corp_id_canonical')
    })
  })

  it('up rejects account/provider drift instead of silently adopting the parent corp', async () => {
    await withLegacySchema(async (db) => {
      const integrationId = randomUUID()
      await sql`
        INSERT INTO directory_integrations(id, provider, corp_id)
        VALUES (${integrationId}, 'dingtalk', 'corp-a')
      `.execute(db)
      await sql`
        INSERT INTO directory_accounts(integration_id, provider, corp_id, external_key)
        VALUES (${integrationId}, 'other-provider', NULL, 'legacy')
      `.execute(db)

      await expect(runUp(db)).rejects.toThrow(/account parent scope is inconsistent/)
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await constraintNames(db)).not.toContain('directory_integrations_corp_id_canonical')
    })
  })

  it('up rejects duplicate same-scope union identities without dropping the legacy account guard', async () => {
    await withLegacySchema(async (db) => {
      await sql`
        INSERT INTO user_external_identities(
          provider, external_key, provider_union_id, corp_id
        ) VALUES
          ('dingtalk', 'identity-a', 'duplicate-union', 'corp-a'),
          ('dingtalk', 'identity-b', 'duplicate-union', 'corp-a')
      `.execute(db)

      await expect(runUp(db)).rejects.toThrow(/idx_user_external_identities_provider_corp_union/)
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await indexNames(db)).not.toContain('idx_directory_accounts_provider_corp_external_key')
      expect(await constraintNames(db)).not.toContain('directory_accounts_corp_id_canonical')
    })
  })

  it('up rejects a same-name wrong-definition replacement index and keeps the legacy guard', async () => {
    await withLegacySchema(async (db) => {
      await sql`
        CREATE UNIQUE INDEX idx_directory_accounts_provider_corp_external_key
        ON directory_accounts(provider, external_key)
        WHERE corp_id IS NOT NULL
      `.execute(db)

      await expect(runUp(db)).rejects.toThrow(
        /index drift: idx_directory_accounts_provider_corp_external_key/,
      )
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_corp_external_key')
      expect(await constraintNames(db)).not.toContain('directory_accounts_corp_id_canonical')
    })
  })

  it('up rejects a same-name expression replacement index that only appears to have the right keys', async () => {
    await withLegacySchema(async (db) => {
      await sql`
        CREATE UNIQUE INDEX idx_directory_accounts_provider_corp_external_key
        ON directory_accounts(provider, corp_id, external_key, ((id::text)))
        WHERE corp_id IS NOT NULL
      `.execute(db)

      await expect(runUp(db)).rejects.toThrow(
        /index drift: idx_directory_accounts_provider_corp_external_key/,
      )
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await constraintNames(db)).not.toContain('directory_integrations_corp_id_canonical')
    })
  })

  it('up rejects a same-name INCLUDE replacement index with hidden extra attributes', async () => {
    await withLegacySchema(async (db) => {
      await sql`
        CREATE UNIQUE INDEX idx_directory_accounts_provider_corp_external_key
        ON directory_accounts(provider, corp_id, external_key)
        INCLUDE (integration_id)
        WHERE corp_id IS NOT NULL
      `.execute(db)

      await expect(runUp(db)).rejects.toThrow(
        /index drift: idx_directory_accounts_provider_corp_external_key/,
      )
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await constraintNames(db)).not.toContain('directory_integrations_corp_id_canonical')
    })
  })

  it('up rejects a weaker same-name corp CHECK instead of accepting it as canonical', async () => {
    await withLegacySchema(async (db) => {
      await sql`
        ALTER TABLE directory_accounts
        ADD CONSTRAINT directory_accounts_corp_id_canonical
        CHECK (corp_id IS NULL OR length(corp_id) > 0)
      `.execute(db)

      await expect(runUp(db)).rejects.toThrow(
        /constraint drift: directory_accounts_corp_id_canonical/,
      )
      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await indexNames(db)).not.toContain(
        'idx_directory_accounts_provider_corp_external_key',
      )
      expect(await constraintNames(db)).toContain('directory_accounts_corp_id_canonical')
    })
  })

  it('up rejects a partially applied no-legacy state instead of treating it as a replay', async () => {
    await withLegacySchema(async (db) => {
      await sql`DROP INDEX idx_directory_accounts_provider_external_key`.execute(db)
      await sql`
        CREATE UNIQUE INDEX idx_directory_accounts_provider_corp_external_key
        ON directory_accounts(provider, corp_id, external_key)
        WHERE corp_id IS NOT NULL
      `.execute(db)

      await expect(runUp(db)).rejects.toThrow(
        /index drift: idx_directory_accounts_provider_null_corp_external_key/,
      )
      expect(await indexNames(db)).toEqual(expect.arrayContaining([
        'idx_directory_accounts_provider_corp_external_key',
      ]))
      expect(await indexNames(db)).not.toContain(
        'idx_directory_accounts_provider_null_corp_external_key',
      )
      expect(await constraintNames(db)).not.toContain('directory_accounts_corp_id_canonical')
    })
  })

  it('compatible down restores the global guard first and replays', async () => {
    await withLegacySchema(async (db) => {
      const integrationId = randomUUID()
      await sql`INSERT INTO directory_integrations(id, corp_id) VALUES (${integrationId}, 'corp-a')`.execute(db)
      await sql`
        INSERT INTO directory_accounts(integration_id, provider, corp_id, external_key)
        VALUES (${integrationId}, 'dingtalk', 'corp-a', 'one')
      `.execute(db)

      await runUp(db)
      const canonicalBeforeDown = await sql<{ corp_id: string }>`
        SELECT corp_id FROM directory_integrations WHERE id = ${integrationId}
      `.execute(db)
      await runDown(db)
      await runDown(db)

      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await indexNames(db)).not.toContain('idx_directory_accounts_provider_corp_external_key')
      expect(await constraintNames(db)).not.toContain('directory_accounts_corp_id_canonical')
      expect(await constraintNames(db)).not.toContain('directory_integrations_corp_id_canonical')
      const canonicalAfterDown = await sql<{ corp_id: string }>`
        SELECT corp_id FROM directory_integrations WHERE id = ${integrationId}
      `.execute(db)
      expect(canonicalAfterDown.rows).toEqual(canonicalBeforeDown.rows)
    })
  })

  it('incompatible down preserves all scoped protections', async () => {
    await withLegacySchema(async (db) => {
      const integrationA = randomUUID()
      const integrationB = randomUUID()
      await sql`
        INSERT INTO directory_integrations(id, corp_id)
        VALUES (${integrationA}, 'corp-a'), (${integrationB}, 'corp-b')
      `.execute(db)
      await runUp(db)
      await sql`
        INSERT INTO directory_accounts(integration_id, provider, corp_id, external_key)
        VALUES
          (${integrationA}, 'dingtalk', 'corp-a', 'shared'),
          (${integrationB}, 'dingtalk', 'corp-b', 'shared')
      `.execute(db)

      await expect(runDown(db)).rejects.toThrow(/idx_directory_accounts_provider_external_key/)
      expect(await indexNames(db)).toEqual(expect.arrayContaining([
        'idx_directory_accounts_provider_corp_external_key',
        'idx_user_external_identities_provider_corp_union',
      ]))
      expect(await constraintNames(db)).toContain('directory_accounts_corp_id_canonical')
    })
  })

  it('down rejects a same-name wrong legacy index and leaves scoped protections intact', async () => {
    await withLegacySchema(async (db) => {
      await runUp(db)
      await sql`
        CREATE UNIQUE INDEX idx_directory_accounts_provider_external_key
        ON directory_accounts(external_key)
      `.execute(db)

      await expect(runDown(db)).rejects.toThrow(
        /index drift: idx_directory_accounts_provider_external_key/,
      )
      expect(await indexNames(db)).toEqual(expect.arrayContaining([
        'idx_directory_accounts_provider_external_key',
        'idx_directory_accounts_provider_corp_external_key',
        'idx_user_external_identities_provider_corp_union',
      ]))
      expect(await constraintNames(db)).toContain('directory_accounts_corp_id_canonical')
    })
  })

  it('down rejects a same-name expression legacy index and leaves scoped protections intact', async () => {
    await withLegacySchema(async (db) => {
      await runUp(db)
      await sql`
        CREATE UNIQUE INDEX idx_directory_accounts_provider_external_key
        ON directory_accounts(provider, external_key, ((id::text)))
      `.execute(db)

      await expect(runDown(db)).rejects.toThrow(
        /index drift: idx_directory_accounts_provider_external_key/,
      )
      expect(await indexNames(db)).toEqual(expect.arrayContaining([
        'idx_directory_accounts_provider_external_key',
        'idx_directory_accounts_provider_corp_external_key',
        'idx_user_external_identities_provider_corp_union',
      ]))
      expect(await constraintNames(db)).toContain('directory_integrations_corp_id_canonical')
    })
  })

  it('restores caller transaction timeouts after successful up and down', async () => {
    await withLegacySchema(async (db) => {
      await db.transaction().execute(async (trx) => {
        await sql`SELECT set_config('lock_timeout', '37s', true)`.execute(trx)
        await sql`SELECT set_config('statement_timeout', '41s', true)`.execute(trx)
        await corpScopeUp(trx as unknown as Kysely<unknown>)
        const afterUp = await sql<{ lock_timeout: string; statement_timeout: string }>`
          SELECT
            current_setting('lock_timeout') AS lock_timeout,
            current_setting('statement_timeout') AS statement_timeout
        `.execute(trx)
        expect(afterUp.rows).toEqual([{ lock_timeout: '37s', statement_timeout: '41s' }])

        await corpScopeDown(trx as unknown as Kysely<unknown>)
        const afterDown = await sql<{ lock_timeout: string; statement_timeout: string }>`
          SELECT
            current_setting('lock_timeout') AS lock_timeout,
            current_setting('statement_timeout') AS statement_timeout
        `.execute(trx)
        expect(afterDown.rows).toEqual([{ lock_timeout: '37s', statement_timeout: '41s' }])
      })
    })
  })

  it('bounds lock waiting and rolls back without dropping the legacy guard', async () => {
    await withLegacySchema(async (db) => {
      const schemaResult = await sql<{ schema_name: string }>`
        SELECT current_schema() AS schema_name
      `.execute(db)
      const schemaName = schemaResult.rows[0].schema_name
      const blockerPool = new Pool({
        connectionString: dbUrl,
        options: `-c search_path=${schemaName}`,
      })
      const blocker = await blockerPool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('LOCK TABLE directory_accounts IN ACCESS EXCLUSIVE MODE')
        const startedAt = Date.now()
        await expect(runUp(db)).rejects.toThrow(/lock timeout|canceling statement due to lock timeout/i)
        const elapsedMs = Date.now() - startedAt
        expect(elapsedMs).toBeGreaterThanOrEqual(4_000)
        expect(elapsedMs).toBeLessThan(10_000)
      } finally {
        await blocker.query('ROLLBACK')
        blocker.release()
        await blockerPool.end()
      }

      expect(await indexNames(db)).toContain('idx_directory_accounts_provider_external_key')
      expect(await indexNames(db)).not.toContain('idx_directory_accounts_provider_corp_external_key')
      expect(await constraintNames(db)).not.toContain('directory_integrations_corp_id_canonical')
    })
  })
})
