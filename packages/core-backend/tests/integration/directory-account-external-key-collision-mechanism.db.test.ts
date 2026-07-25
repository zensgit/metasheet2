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

  it('repairs a legacy blank account corp from its immutable parent integration during sync', async () => {
    const integrationId = await seedIntegration('corp-repair')
    activeTenant = {
      unionId: `t2g-union-corp-repair-${TS}`,
      userId: `t2g-user-corp-repair-${TS}`,
      name: 'Corp Repair',
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

  it('normalizes legacy whitespace corp before rejecting a same-corp identity conflict', async () => {
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
