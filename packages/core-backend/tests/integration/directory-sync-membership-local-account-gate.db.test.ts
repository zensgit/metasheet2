import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Directory sync and the local account (real DB).
 *
 * Invariant under test: a person who is active in the external directory is not, by that
 * fact alone, a local account that may hold an active organisation membership, nor one whose
 * applied deprovision evidence may be superseded. Sync confirms memberships only for local
 * accounts that pass the shared user authentication gate; activation, recycle-bin restore and
 * deprovision-evidence restore stay their own controlled flows.
 *
 * Every scenario asserts the layers separately — `users`, `user_orgs`, `user_external_auth_grants`,
 * `directory_deprovision_events/effects`, `users.access_generation` — and the run's own stats.
 *
 * Harness: the DingTalk HTTP client is mocked; the REAL `syncDirectoryIntegration` runs against
 * real Postgres (pattern of `attendance-w4pre1b-user-orgs-sync-automatch.db.test.ts`). Each
 * block owns its own integration, department and ids (one timestamp prefix per file, one tag
 * per block) and cleans up after itself. Env changes are set in `beforeAll` and restored in
 * `afterAll`; the integration config runs files serially.
 */
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

import { activatePendingUser } from '../../src/auth/user-activate'
import { query } from '../../src/db/pg'
import { restoreDeprovisionEvent } from '../../src/directory/deprovision-evidence-api'
import { createDirectoryIntegration, syncDirectoryIntegration } from '../../src/directory/directory-sync'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
// Anti-skip-green sentinel: a DB-expected lane must have a database, never a silent skip.
if (process.env.EXPECT_DB === '1')
  it('requires a real DB', () => expect(process.env.DATABASE_URL).toBeTruthy())

const TS = Date.now()
const STATS_KEY = 'membershipWritesSkippedLocalAccountGateCount'

type DirectoryMember = {
  ext: string
  name: string
  unionId: string
  openId: string
  email: string
}

type MockDirectory = {
  dept: string
  /** Read on every pull — mutate the array to change what the next sync sees. */
  members: DirectoryMember[]
}

function member(tag: string, suffix: string): DirectoryMember {
  const base = `gate-${tag}-${suffix}-${TS}`
  return {
    ext: `${base}-ext`,
    name: `Gate ${tag} ${suffix}`,
    unionId: `${base}-union`,
    openId: `${base}-open`,
    email: `${base}@example.test`,
  }
}

function armMockDirectory(directory: MockDirectory): void {
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('gate-token')
  clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) =>
    parentId === '1' ? [{ id: directory.dept, parentId: '1', name: 'Gate Department', order: 0, source: {} }] : [],
  )
  clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) =>
    deptId === directory.dept
      ? {
          users: directory.members.map((entry) => ({
            userId: entry.ext,
            name: entry.name,
            departmentIds: [directory.dept],
            source: {},
          })),
          nextCursor: null,
          hasMore: false,
        }
      : { users: [], nextCursor: null, hasMore: false },
  )
  clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => {
    const entry = directory.members.find((candidate) => candidate.ext === userId)
    return {
      userId,
      name: entry?.name ?? userId,
      unionId: entry?.unionId,
      openId: entry?.openId,
      email: entry?.email,
      mobile: undefined,
      departmentIds: [directory.dept],
      source: {},
    }
  })
}

type UserRow = {
  is_active: boolean
  activation_status: string | null
  role: string | null
  deleted_at: string | null
  access_generation: string
}

async function readUser(userId: string): Promise<UserRow> {
  const result = await query<UserRow>(
    `SELECT is_active,
            activation_status,
            role,
            (to_jsonb(users) ->> 'deleted_at') AS deleted_at,
            COALESCE(access_generation, 0)::text AS access_generation
       FROM users
      WHERE id = $1`,
    [userId],
  )
  expect(result.rows).toHaveLength(1)
  return result.rows[0]
}

async function readMembership(userId: string, orgId: string): Promise<boolean | null> {
  const result = await query<{ is_active: boolean }>(
    `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
    [userId, orgId],
  )
  return result.rows[0]?.is_active ?? null
}

async function readGrants(userId: string): Promise<Array<{ provider: string; enabled: boolean }>> {
  const result = await query<{ provider: string; enabled: boolean }>(
    `SELECT provider, enabled FROM user_external_auth_grants WHERE local_user_id = $1 ORDER BY provider`,
    [userId],
  )
  return result.rows
}

async function readEvidence(userId: string): Promise<{ events: string[]; effects: string[] }> {
  const events = await query<{ status: string }>(
    `SELECT status FROM directory_deprovision_events WHERE local_user_id = $1 ORDER BY created_at, id`,
    [userId],
  )
  const effects = await query<{ status: string }>(
    `SELECT effect.status
       FROM directory_deprovision_effects effect
       JOIN directory_deprovision_events event ON event.id = effect.event_id
      WHERE event.local_user_id = $1
      ORDER BY effect.effect_type, effect.id`,
    [userId],
  )
  return { events: events.rows.map((row) => row.status), effects: effects.rows.map((row) => row.status) }
}

async function readLink(integrationId: string, ext: string): Promise<{ local_user_id: string | null; link_status: string; match_strategy: string | null } | null> {
  const result = await query<{ local_user_id: string | null; link_status: string; match_strategy: string | null }>(
    `SELECT l.local_user_id, l.link_status, l.match_strategy
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
      WHERE a.integration_id = $1 AND a.external_user_id = $2`,
    [integrationId, ext],
  )
  return result.rows[0] ?? null
}

async function readAccountActive(integrationId: string, ext: string): Promise<boolean | null> {
  const result = await query<{ is_active: boolean }>(
    `SELECT is_active FROM directory_accounts WHERE integration_id = $1 AND external_user_id = $2`,
    [integrationId, ext],
  )
  return result.rows[0]?.is_active ?? null
}

async function linkedUserIds(integrationId: string): Promise<string[]> {
  const result = await query<{ local_user_id: string }>(
    `SELECT DISTINCT l.local_user_id
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
      WHERE a.integration_id = $1 AND l.local_user_id IS NOT NULL`,
    [integrationId],
  )
  return result.rows.map((row) => row.local_user_id)
}

async function cleanupIntegration(integrationId: string, userIds: string[]): Promise<void> {
  const users = Array.from(new Set(userIds.filter(Boolean)))
  await query(`DELETE FROM directory_sync_alerts WHERE integration_id = $1`, [integrationId])
  await query(`DELETE FROM directory_deprovision_events WHERE integration_id = $1`, [integrationId])
  await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId])
  await query(
    `DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
    [integrationId],
  )
  await query(
    `DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
    [integrationId],
  )
  await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
  await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
  await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
  for (const userId of users) {
    await query(`DELETE FROM directory_deprovision_events WHERE local_user_id = $1`, [userId])
    await query(`DELETE FROM user_login_aliases WHERE user_id = $1`, [userId])
    await query(`DELETE FROM user_invites WHERE user_id = $1`, [userId])
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [userId])
    await query(`DELETE FROM user_external_identities WHERE local_user_id = $1`, [userId])
    await query(`DELETE FROM user_orgs WHERE user_id = $1`, [userId])
    await query(`DELETE FROM users WHERE id = $1`, [userId])
  }
}

/** Auto-admission fixture: one scoped department, one member, one sync → one linked local user. */
async function admitFixture(tag: string): Promise<{
  integrationId: string
  orgId: string
  userId: string
  person: DirectoryMember
  directory: MockDirectory
}> {
  const directory: MockDirectory = { dept: `gate-${tag}-dept-${TS}`, members: [member(tag, 'p')] }
  armMockDirectory(directory)
  const integration = await createDirectoryIntegration({
    name: `gate-${tag}-${TS}`,
    corpId: `gate-${tag}-corp-${TS}`,
    appKey: `gate-${tag}-appkey-${TS}`,
    appSecret: 'gate-secret',
    admissionMode: 'auto_for_scoped_departments',
    admissionDepartmentIds: [directory.dept],
  })
  await syncDirectoryIntegration(integration.id, `system:gate-${tag}`, 'manual')
  const link = await readLink(integration.id, directory.members[0].ext)
  expect(link?.link_status).toBe('linked')
  expect(link?.match_strategy).toBe('auto_admit')
  expect(link?.local_user_id).toBeTruthy()
  return {
    integrationId: integration.id,
    orgId: integration.orgId,
    userId: String(link?.local_user_id),
    person: directory.members[0],
    directory,
  }
}

async function waitForAnyUserLockWaiter(inspector: Pool, holderPid: number, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await inspector.query<{ pid: number }>(
      `SELECT activity.pid
         FROM pg_stat_activity activity
        WHERE activity.pid <> $1::int
          AND activity.wait_event_type = 'Lock'
          AND $1::int = ANY(pg_blocking_pids(activity.pid))
          AND activity.query LIKE '%FROM users%'
        ORDER BY activity.pid
        LIMIT 1`,
      [holderPid],
    )
    if (result.rows[0]?.pid) return Number(result.rows[0].pid)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for a sync writer to block on user holder ${holderPid}`)
}

/**
 * Shared single-field scenario on an admitted, active, linked user: the user's membership is
 * deactivated, one local-account field is changed, and a second sync runs. The membership must
 * stay inactive, nothing else about the user may move, and the run reports one skipped write.
 */
async function assertSingleFieldDenial(
  fixture: Awaited<ReturnType<typeof admitFixture>>,
  changeUser: () => Promise<void>,
  expectUser: (user: UserRow) => void,
): Promise<void> {
  expect(await readMembership(fixture.userId, fixture.orgId)).toBe(true)
  await query(`UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2`, [fixture.userId, fixture.orgId])
  await changeUser()
  const before = await readUser(fixture.userId)
  const grantsBefore = await readGrants(fixture.userId)
  expect(await readEvidence(fixture.userId)).toEqual({ events: [], effects: [] })

  const result = await syncDirectoryIntegration(fixture.integrationId, 'system:gate-single-field', 'manual')
  const stats = result.run.stats as Record<string, unknown>
  expect(stats[STATS_KEY]).toBe(1)

  const after = await readUser(fixture.userId)
  expectUser(after)
  expect(after.access_generation).toBe(before.access_generation)
  expect(await readMembership(fixture.userId, fixture.orgId)).toBe(false)
  expect(await readGrants(fixture.userId)).toEqual(grantsBefore)
  expect(await readEvidence(fixture.userId)).toEqual({ events: [], effects: [] })
  expect((await readLink(fixture.integrationId, fixture.person.ext))?.link_status).toBe('linked')
}

describeIfDatabase('directory sync and the local account — globally inactive local account', () => {
  let fixture: Awaited<ReturnType<typeof admitFixture>>

  afterAll(async () => {
    if (fixture) await cleanupIntegration(fixture.integrationId, [fixture.userId])
  })

  it('a locally inactive account does not receive an active membership from sync; generation and evidence are untouched', async () => {
    fixture = await admitFixture('inactive')
    await assertSingleFieldDenial(
      fixture,
      async () => {
        await query(`UPDATE users SET is_active = false WHERE id = $1`, [fixture.userId])
      },
      (user) => {
        expect(user.is_active).toBe(false)
        expect(user.activation_status).toBe('activated')
      },
    )
  }, 30_000)
})

describeIfDatabase('directory sync and the local account — recycle-bin account that is still is_active', () => {
  let fixture: Awaited<ReturnType<typeof admitFixture>>

  afterAll(async () => {
    if (fixture) await cleanupIntegration(fixture.integrationId, [fixture.userId])
  })

  it('deleted_at alone keeps the membership inactive; the link row stays linked', async () => {
    fixture = await admitFixture('recycled')
    await assertSingleFieldDenial(
      fixture,
      async () => {
        await query(`UPDATE users SET deleted_at = NOW() WHERE id = $1`, [fixture.userId])
      },
      (user) => {
        expect(user.is_active).toBe(true)
        expect(user.deleted_at).toBeTruthy()
        expect(user.activation_status).toBe('activated')
      },
    )
  }, 30_000)
})

describeIfDatabase('directory sync and the local account — role-disabled account that is still is_active', () => {
  let fixture: Awaited<ReturnType<typeof admitFixture>>

  afterAll(async () => {
    if (fixture) await cleanupIntegration(fixture.integrationId, [fixture.userId])
  })

  it("role='disabled' alone keeps the membership inactive", async () => {
    fixture = await admitFixture('roledis')
    await assertSingleFieldDenial(
      fixture,
      async () => {
        await query(`UPDATE users SET role = 'disabled' WHERE id = $1`, [fixture.userId])
      },
      (user) => {
        expect(user.is_active).toBe(true)
        expect(user.role).toBe('disabled')
      },
    )
  }, 30_000)
})

describeIfDatabase('directory sync and the local account — pending-activation admission', () => {
  const tag = 'pending'
  const directory: MockDirectory = { dept: `gate-${tag}-dept-${TS}`, members: [member(tag, 'p')] }
  let integrationId = ''
  let orgId = ''
  let userId = ''
  let previousFlag: string | undefined

  beforeAll(() => {
    previousFlag = process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
    process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = 'true'
    armMockDirectory(directory)
  })

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
    else process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = previousFlag
    if (integrationId) await cleanupIntegration(integrationId, [userId])
  })

  it('a user admitted in pending mode has no membership row after admission or a re-sync; activation then creates it', async () => {
    const integration = await createDirectoryIntegration({
      name: `gate-${tag}-${TS}`,
      corpId: `gate-${tag}-corp-${TS}`,
      appKey: `gate-${tag}-appkey-${TS}`,
      appSecret: 'gate-secret',
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: [directory.dept],
    })
    integrationId = integration.id
    orgId = integration.orgId

    const first = await syncDirectoryIntegration(integrationId, `system:gate-${tag}`, 'manual')
    const link = await readLink(integrationId, directory.members[0].ext)
    expect(link?.link_status).toBe('linked')
    expect(link?.match_strategy).toBe('auto_admit')
    userId = String(link?.local_user_id)
    expect(userId).toBeTruthy()

    const admitted = await readUser(userId)
    expect(admitted.is_active).toBe(false)
    expect(admitted.activation_status).toBe('pending_activation')
    expect(admitted.access_generation).toBe('0')
    expect(await readMembership(userId, orgId)).toBeNull()
    expect(await readGrants(userId)).toEqual([])
    expect((first.run.stats as Record<string, unknown>)[STATS_KEY]).toBe(1)

    const second = await syncDirectoryIntegration(integrationId, `system:gate-${tag}`, 'manual')
    expect((second.run.stats as Record<string, unknown>)[STATS_KEY]).toBe(1)
    const resynced = await readUser(userId)
    expect(resynced.is_active).toBe(false)
    expect(resynced.activation_status).toBe('pending_activation')
    expect(resynced.access_generation).toBe('0')
    expect(await readMembership(userId, orgId)).toBeNull()
    expect(await readGrants(userId)).toEqual([])

    // The controlled flow: activation creates the membership in its own transaction.
    const activated = await activatePendingUser({ userId, mode: 'admin_no_password', adminUserId: 'admin:gate-test' })
    expect(activated.membershipOrgId).toBe(orgId)
    const activeUser = await readUser(userId)
    expect(activeUser.is_active).toBe(true)
    expect(activeUser.activation_status).toBe('activated')
    expect(await readMembership(userId, orgId)).toBe(true)

    // After activation the same sync confirms the membership and declines nothing.
    const third = await syncDirectoryIntegration(integrationId, `system:gate-${tag}`, 'manual')
    expect((third.run.stats as Record<string, unknown>)[STATS_KEY]).toBe(0)
    expect(await readMembership(userId, orgId)).toBe(true)
  }, 60_000)
})

/**
 * Departure fixture for the deprovision scenarios: a pre-existing linked user whose account is
 * stale (`last_seen_at` before the run) and absent from the pull, plus a survivor that keeps
 * the pull non-empty. Pattern of `attendance-w4pre1c-departure-sweep-deprovision.db.test.ts`.
 */
async function departureFixture(options: {
  tag: string
  policy: 'mark_inactive' | 'disable_grant_only'
  admissionMode?: 'manual_only' | 'auto_for_scoped_departments'
}): Promise<{
  integrationId: string
  orgId: string
  corpId: string
  userId: string
  accountId: string
  person: DirectoryMember
  survivor: DirectoryMember
  directory: MockDirectory
}> {
  const person = member(options.tag, 'p')
  const survivor = member(options.tag, 's')
  const directory: MockDirectory = { dept: `gate-${options.tag}-dept-${TS}`, members: [survivor] }
  armMockDirectory(directory)
  const corpId = `gate-${options.tag}-corp-${TS}`
  const integration = await createDirectoryIntegration({
    name: `gate-${options.tag}-${TS}`,
    corpId,
    appKey: `gate-${options.tag}-appkey-${TS}`,
    appSecret: 'gate-secret',
    admissionMode: options.admissionMode ?? 'manual_only',
    admissionDepartmentIds: options.admissionMode ? [directory.dept] : undefined,
    defaultDeprovisionPolicy: options.policy,
  })
  const userId = `gate-${options.tag}-user-${TS}`
  await query(
    `INSERT INTO users (id, email, password_hash, is_active, activation_status)
     VALUES ($1, $2, 'x', TRUE, 'activated')`,
    [userId, person.email],
  )
  await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [userId, integration.orgId])
  await query(
    `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
     VALUES ('dingtalk', $1, TRUE, 'test:gate-fixture', NOW(), NOW())`,
    [userId],
  )
  const account = await query<{ id: string }>(
    `INSERT INTO directory_accounts (
       integration_id, corp_id, external_user_id, union_id, external_key, name, is_active, last_seen_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $4, $5, true, NOW(), NOW(), NOW())
     RETURNING id::text AS id`,
    [integration.id, corpId, person.ext, person.unionId, person.name],
  )
  await query(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
     VALUES ($1::uuid, $2, 'linked', 'manual', NOW(), NOW())`,
    [account.rows[0].id, userId],
  )
  return {
    integrationId: integration.id,
    orgId: integration.orgId,
    corpId,
    userId,
    accountId: account.rows[0].id,
    person,
    survivor,
    directory,
  }
}

describeIfDatabase('directory sync and the local account — open rehire keeps applied evidence; restore is the controlled flow', () => {
  let fixture: Awaited<ReturnType<typeof departureFixture>>
  let previousFlag: string | undefined

  beforeAll(() => {
    previousFlag = process.env.DIRECTORY_DEPROVISION_ENABLED
    process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
  })

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.DIRECTORY_DEPROVISION_ENABLED
    else process.env.DIRECTORY_DEPROVISION_ENABLED = previousFlag
    if (fixture) await cleanupIntegration(fixture.integrationId, [fixture.userId, ...(await linkedUserIds(fixture.integrationId))])
  })

  it('a returning member with applied evidence keeps membership and grant closed until restore', async () => {
    fixture = await departureFixture({ tag: 'rehire', policy: 'disable_grant_only' })

    // Departure: the sweep transitions the account and the executor applies the policy.
    const departed = await syncDirectoryIntegration(fixture.integrationId, 'system:gate-rehire', 'manual')
    const departedStats = departed.run.stats as Record<string, unknown>
    expect(departedStats.deprovisionApplied).toBe(true)
    expect(departedStats.deprovisionCandidateCount).toBe(1)
    expect(await readAccountActive(fixture.integrationId, fixture.person.ext)).toBe(false)
    expect(await readMembership(fixture.userId, fixture.orgId)).toBe(false)
    expect(await readGrants(fixture.userId)).toEqual([{ provider: 'dingtalk', enabled: false }])
    const afterDeparture = await readUser(fixture.userId)
    expect(afterDeparture.is_active).toBe(true)
    const evidence = await readEvidence(fixture.userId)
    expect(evidence.events).toEqual(['applied'])
    expect(evidence.effects.length).toBeGreaterThan(0)
    expect(new Set(evidence.effects)).toEqual(new Set(['applied']))

    // Return: the person reappears in the directory and the account is active again.
    fixture.directory.members.push(fixture.person)
    const returned = await syncDirectoryIntegration(fixture.integrationId, 'system:gate-rehire', 'manual')
    expect((returned.run.stats as Record<string, unknown>)[STATS_KEY]).toBe(0)
    expect(await readAccountActive(fixture.integrationId, fixture.person.ext)).toBe(true)
    expect((await readLink(fixture.integrationId, fixture.person.ext))?.link_status).toBe('linked')
    expect(await readMembership(fixture.userId, fixture.orgId)).toBe(false)
    expect(await readGrants(fixture.userId)).toEqual([{ provider: 'dingtalk', enabled: false }])
    const afterReturn = await readUser(fixture.userId)
    expect(afterReturn.is_active).toBe(true)
    expect(afterReturn.access_generation).toBe(afterDeparture.access_generation)
    expect(await readEvidence(fixture.userId)).toEqual(evidence)

    // The controlled flow still works: a rehire restore reopens membership and grant.
    const eventId = (await query<{ id: string }>(
      `SELECT id::text AS id FROM directory_deprovision_events WHERE local_user_id = $1`,
      [fixture.userId],
    )).rows[0].id
    await restoreDeprovisionEvent({ eventId, mode: 'rehire', adminUserId: 'admin:gate-test' })
    expect(await readMembership(fixture.userId, fixture.orgId)).toBe(true)
    expect(await readGrants(fixture.userId)).toEqual([{ provider: 'dingtalk', enabled: true }])
    const restored = await readEvidence(fixture.userId)
    expect(restored.events).toHaveLength(1)
    expect(restored.events[0]).not.toBe('applied')
    expect(restored.effects.every((status) => status !== 'applied')).toBe(true)
  }, 60_000)
})

describeIfDatabase('directory sync and the local account — org-scoped deactivation stays org-scoped', () => {
  let fixture: Awaited<ReturnType<typeof departureFixture>>
  let integrationB = ''
  let orgB = ''
  let previousFlag: string | undefined

  beforeAll(() => {
    previousFlag = process.env.DIRECTORY_DEPROVISION_ENABLED
    process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
  })

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.DIRECTORY_DEPROVISION_ENABLED
    else process.env.DIRECTORY_DEPROVISION_ENABLED = previousFlag
    if (fixture) {
      // Integration B owns its accounts/links (FK cascade); its org membership belongs to the user.
      if (integrationB) await query(`DELETE FROM directory_integrations WHERE id = $1::uuid`, [integrationB])
      await cleanupIntegration(fixture.integrationId, [fixture.userId, ...(await linkedUserIds(fixture.integrationId))])
    }
  })

  it('a person who left org A but is still bound in org B keeps the global account, grant and org B membership; org A stays inactive on return', async () => {
    fixture = await departureFixture({ tag: 'orgscoped', policy: 'mark_inactive' })

    // A REAL second binding in another org: its own integration, account and linked row.
    orgB = `gate-orgscoped-org-b-${TS}`
    integrationB = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, provider, corp_id, org_id, status)
       VALUES ($1, 'dingtalk', $2, $3, 'active')
       RETURNING id::text AS id`,
      [`gate-orgscoped-b-${TS}`, `gate-orgscoped-corp-b-${TS}`, orgB],
    )).rows[0].id
    await query(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)`, [fixture.userId, orgB])
    const accountB = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active)
       VALUES ($1, $2, $3, 'Gate org B', TRUE) RETURNING id::text AS id`,
      [integrationB, `gate-orgscoped-b-ext-${TS}`, `dingtalk:gate-orgscoped-b-ext-${TS}`],
    )
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
       VALUES ($1::uuid, $2, 'linked')`,
      [accountB.rows[0].id, fixture.userId],
    )

    // Departure from org A only: candidate in A, not globally clear because of B.
    const departed = await syncDirectoryIntegration(fixture.integrationId, 'system:gate-orgscoped', 'manual')
    const departedStats = departed.run.stats as Record<string, unknown>
    expect(departedStats.deprovisionApplied).toBe(true)
    expect(departedStats.deprovisionCandidateCount).toBe(1)
    expect(departedStats.deprovisionGlobalCandidateCount).toBe(0)
    expect(departedStats.deprovisionUsersDeactivatedCount).toBe(0)
    expect(await readMembership(fixture.userId, fixture.orgId)).toBe(false)
    expect(await readMembership(fixture.userId, orgB)).toBe(true)
    const afterDeparture = await readUser(fixture.userId)
    expect(afterDeparture.is_active).toBe(true)
    expect(await readGrants(fixture.userId)).toEqual([{ provider: 'dingtalk', enabled: true }])
    const evidence = await readEvidence(fixture.userId)
    expect(evidence.events).toEqual(['applied'])
    expect(evidence.effects).toEqual(['applied'])

    // Return to org A's directory: the applied evidence keeps the org A membership closed,
    // the global account, the grant and the org B membership are untouched.
    fixture.directory.members.push(fixture.person)
    const returned = await syncDirectoryIntegration(fixture.integrationId, 'system:gate-orgscoped', 'manual')
    expect((returned.run.stats as Record<string, unknown>)[STATS_KEY]).toBe(0)
    expect(await readAccountActive(fixture.integrationId, fixture.person.ext)).toBe(true)
    expect(await readMembership(fixture.userId, fixture.orgId)).toBe(false)
    expect(await readMembership(fixture.userId, orgB)).toBe(true)
    const afterReturn = await readUser(fixture.userId)
    expect(afterReturn.is_active).toBe(true)
    expect(afterReturn.access_generation).toBe(afterDeparture.access_generation)
    expect(await readGrants(fixture.userId)).toEqual([{ provider: 'dingtalk', enabled: true }])
    expect(await readEvidence(fixture.userId)).toEqual(evidence)
  }, 60_000)
})

describeIfDatabase('directory sync and the local account — a deactivation committed while sync waits on the user lock', () => {
  let fixture: Awaited<ReturnType<typeof admitFixture>>

  afterAll(async () => {
    if (fixture) await cleanupIntegration(fixture.integrationId, [fixture.userId])
  })

  it('sync blocked on the users row reads the committed deactivation and declines the membership', async () => {
    fixture = await admitFixture('concurrent')
    expect(await readMembership(fixture.userId, fixture.orgId)).toBe(true)
    await query(`UPDATE user_orgs SET is_active = false WHERE user_id = $1 AND org_id = $2`, [fixture.userId, fixture.orgId])
    const before = await readUser(fixture.userId)
    const grantsBefore = await readGrants(fixture.userId)

    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    const holder = await pool.connect()
    let syncPromise: ReturnType<typeof syncDirectoryIntegration> | undefined
    try {
      await holder.query('BEGIN')
      const holderPid = Number((await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      await holder.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [fixture.userId])

      syncPromise = syncDirectoryIntegration(fixture.integrationId, 'system:gate-concurrent', 'manual')
      // Barrier: the sync's access-graph lock must actually be waiting on the holder before the
      // deactivation commits. Timing out here fails the test; it never falls through.
      const waiterPid = await waitForAnyUserLockWaiter(pool, holderPid)
      expect(waiterPid).toBeGreaterThan(0)

      await holder.query(`UPDATE users SET is_active = false WHERE id = $1`, [fixture.userId])
      await holder.query('COMMIT')

      const result = await syncPromise
      expect((result.run.stats as Record<string, unknown>)[STATS_KEY]).toBe(1)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      if (syncPromise) await syncPromise.catch(() => undefined)
      holder.release()
      await pool.end()
    }

    const after = await readUser(fixture.userId)
    expect(after.is_active).toBe(false)
    expect(after.activation_status).toBe('activated')
    expect(after.access_generation).toBe(before.access_generation)
    expect(await readMembership(fixture.userId, fixture.orgId)).toBe(false)
    expect(await readGrants(fixture.userId)).toEqual(grantsBefore)
    expect(await readEvidence(fixture.userId)).toEqual({ events: [], effects: [] })
  }, 60_000)
})

describeIfDatabase('directory sync and the local account — a link re-established for an inactive account keeps its evidence', () => {
  const tag = 'relink'
  const person = member(tag, 'p')
  const survivor = member(tag, 's')
  const directory: MockDirectory = { dept: `gate-${tag}-dept-${TS}`, members: [person, survivor] }
  let integrationId = ''
  let orgId = ''
  let userId = ''
  let previousFlag: string | undefined

  beforeAll(() => {
    previousFlag = process.env.DIRECTORY_DEPROVISION_ENABLED
    process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
    armMockDirectory(directory)
  })

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.DIRECTORY_DEPROVISION_ENABLED
    else process.env.DIRECTORY_DEPROVISION_ENABLED = previousFlag
    if (integrationId) await cleanupIntegration(integrationId, [userId, ...(await linkedUserIds(integrationId))])
  })

  it('an identity re-match that links an inactive account writes no membership and supersedes no evidence', async () => {
    const integration = await createDirectoryIntegration({
      name: `gate-${tag}-${TS}`,
      corpId: `gate-${tag}-corp-${TS}`,
      appKey: `gate-${tag}-appkey-${TS}`,
      appSecret: 'gate-secret',
      admissionMode: 'auto_for_scoped_departments',
      admissionDepartmentIds: [directory.dept],
      defaultDeprovisionPolicy: 'mark_inactive',
    })
    integrationId = integration.id
    orgId = integration.orgId

    // Admission: both members become linked local users.
    await syncDirectoryIntegration(integrationId, `system:gate-${tag}`, 'manual')
    const link = await readLink(integrationId, person.ext)
    expect(link?.match_strategy).toBe('auto_admit')
    userId = String(link?.local_user_id)
    expect(userId).toBeTruthy()
    expect(await readMembership(userId, orgId)).toBe(true)

    // Departure of the person (survivor stays): the executor applies mark_inactive globally.
    directory.members.splice(directory.members.indexOf(person), 1)
    const departed = await syncDirectoryIntegration(integrationId, `system:gate-${tag}`, 'manual')
    expect((departed.run.stats as Record<string, unknown>).deprovisionApplied).toBe(true)
    const afterDeparture = await readUser(userId)
    expect(afterDeparture.is_active).toBe(false)
    expect(await readMembership(userId, orgId)).toBe(false)
    const grantsAfterDeparture = await readGrants(userId)
    const evidence = await readEvidence(userId)
    expect(evidence.events).toEqual(['applied'])
    expect(evidence.effects.length).toBeGreaterThan(0)
    expect(new Set(evidence.effects)).toEqual(new Set(['applied']))

    // The link row goes away while the identity row stays, so the next sync re-matches the
    // account to the same (now inactive) local account through its identity.
    await query(
      `DELETE FROM directory_account_links
        WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1 AND external_user_id = $2)`,
      [integrationId, person.ext],
    )
    directory.members.push(person)
    const relinked = await syncDirectoryIntegration(integrationId, `system:gate-${tag}`, 'manual')
    expect((relinked.run.stats as Record<string, unknown>)[STATS_KEY]).toBe(1)

    const relink = await readLink(integrationId, person.ext)
    expect(relink?.link_status).toBe('linked')
    expect(relink?.match_strategy).toBe('external_identity')
    expect(relink?.local_user_id).toBe(userId)
    expect(await readAccountActive(integrationId, person.ext)).toBe(true)

    const afterRelink = await readUser(userId)
    expect(afterRelink.is_active).toBe(false)
    expect(afterRelink.access_generation).toBe(afterDeparture.access_generation)
    expect(await readMembership(userId, orgId)).toBe(false)
    expect(await readGrants(userId)).toEqual(grantsAfterDeparture)
    expect(await readEvidence(userId)).toEqual(evidence)
  }, 60_000)
})
