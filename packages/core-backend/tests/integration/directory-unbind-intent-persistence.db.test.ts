/**
 * Directory link intent — an administrator's explicit unbind survives automatic processing.
 *
 * Invariant under test: once an administrator unbinds a directory account, the persisted link
 * row `(local_user_id NULL, link_status 'unmatched', match_strategy 'manual_unbound', reviewer
 * columns kept)` is left alone by every automatic writer — repeated syncs (manual and scheduled),
 * identity / unique-email / unique-mobile candidates, ambiguous identifiers, auto-admission and
 * the preview counters — and only an explicit administrator action (bind, admit) changes it.
 *
 * Drives the real `syncDirectoryIntegration`, `previewDirectorySyncIntegration`,
 * `unbindDirectoryAccount`, `bindDirectoryAccount` and `admitDirectoryAccountUser` against
 * PostgreSQL with the DingTalk HTTP client mocked (harness pattern of
 * directory-sync-preview-apply-parity.db.test.ts). Every "unchanged" assertion reads the whole
 * link row back, `updated_at` included, and the auto-admission scenarios compare the `users`
 * count before and after, so "not linked" alone can never satisfy them.
 *
 * Requires a live database: excluded from the no-DB vitest job and run whole-file in the
 * approval real-DB step of plugin-tests.yml.
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
  admitDirectoryAccountUser,
  bindDirectoryAccount,
  createDirectoryIntegration,
  previewDirectorySyncIntegration,
  syncDirectoryIntegration,
  unbindDirectoryAccount,
} from '../../src/directory/directory-sync'
import { isAdminUnboundDirectoryLink } from '../../src/directory/directory-link-intent'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const ADMIN_USER_ID = `f01_admin_${TS}`
const DEPT_IN = `f01din${TS}`

// ---------------------------------------------------------------------------------------------
// DingTalk pull state: one department in admission scope; the member list is switched per
// scenario. Every pulled member carries a unionId AND an openId (auto-admission and explicit
// bind both require the DingTalk login grant to be grantable).
// ---------------------------------------------------------------------------------------------
type PulledMember = {
  userId: string
  name: string
  unionId: string
  openId: string
  email?: string
  mobile?: string
}

const pull = { members: [] as PulledMember[] }

function setPulledMembers(members: PulledMember[]) {
  pull.members = members
}

function member(suffix: string, extra: { email?: string; mobile?: string } = {}): PulledMember {
  return {
    userId: `f01u${suffix}${TS}`,
    name: `Member ${suffix}`,
    unionId: `f01union${suffix}${TS}`,
    openId: `f01open${suffix}${TS}`,
    ...extra,
  }
}

beforeAll(() => {
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('synthetic-no-network-token')
  clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) =>
    parentId === '1' ? [{ id: DEPT_IN, parentId: '1', name: 'In Scope', order: 0, source: {} }] : [],
  )
  clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) =>
    deptId === DEPT_IN
      ? {
        users: pull.members.map((m) => ({ userId: m.userId, name: m.name, departmentIds: [DEPT_IN], source: {} })),
        nextCursor: null,
        hasMore: false,
      }
      : { users: [], nextCursor: null, hasMore: false },
  )
  clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => {
    const m = pull.members.find((candidate) => candidate.userId === userId)
    if (!m) throw new Error(`unexpected userId ${userId}`)
    return {
      userId: m.userId,
      name: m.name,
      unionId: m.unionId,
      openId: m.openId,
      email: m.email,
      mobile: m.mobile,
      departmentIds: [DEPT_IN],
      source: {},
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Shared helpers and cleanup bookkeeping.
// ---------------------------------------------------------------------------------------------
type LinkRow = {
  local_user_id: string | null
  link_status: string
  match_strategy: string | null
  reviewed_by: string | null
  review_note: string | null
  updated_at: string
}

const createdIntegrationIds: string[] = []
const createdUserIds = new Set<string>([ADMIN_USER_ID])

async function createIntegration(suffix: string, admissionMode: 'manual_only' | 'auto_for_scoped_departments') {
  const integration = await createDirectoryIntegration({
    name: `f01-${suffix}-${TS}`,
    corpId: `f01corp${suffix}${TS}`,
    appKey: `f01-appkey-${suffix}-${TS}`,
    appSecret: 'synthetic-no-network',
    admissionMode,
    admissionDepartmentIds: [DEPT_IN],
    excludeDepartmentIds: [],
  })
  createdIntegrationIds.push(integration.id)
  return integration
}

async function createLocalUser(suffix: string, extra: { email?: string | null; mobile?: string | null } = {}) {
  const id = `f01_user_${suffix}_${TS}`
  const email = extra.email === undefined ? `f01-${suffix}-${TS}@example.test` : extra.email
  await query(
    `INSERT INTO users (id, email, name, password_hash, role, mobile)
     VALUES ($1, $2, $3, 'x', 'user', $4)`,
    [id, email, `Local ${suffix}`, extra.mobile ?? null],
  )
  createdUserIds.add(id)
  return id
}

async function accountIdOf(integrationId: string, externalUserId: string): Promise<string> {
  const result = await query<{ id: string }>(
    `SELECT id::text AS id FROM directory_accounts WHERE integration_id = $1 AND external_user_id = $2`,
    [integrationId, externalUserId],
  )
  expect(result.rows, `account ${externalUserId}`).toHaveLength(1)
  return result.rows[0].id
}

async function readLink(accountId: string): Promise<LinkRow | null> {
  const result = await query<LinkRow>(
    `SELECT local_user_id, link_status, match_strategy, reviewed_by, review_note, updated_at::text AS updated_at
       FROM directory_account_links
      WHERE directory_account_id = $1`,
    [accountId],
  )
  return result.rows[0] ?? null
}

async function usersCount(): Promise<number> {
  const result = await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM users`)
  return Number(result.rows[0].n)
}

async function rememberLinkedUsers(integrationId: string) {
  const result = await query<{ local_user_id: string }>(
    `SELECT l.local_user_id
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
      WHERE a.integration_id = $1 AND l.local_user_id IS NOT NULL`,
    [integrationId],
  )
  for (const row of result.rows) createdUserIds.add(row.local_user_id)
}

function expectHeld(row: LinkRow | null) {
  expect(row).not.toBeNull()
  expect(isAdminUnboundDirectoryLink(row)).toBe(true)
  expect(row).toMatchObject({
    local_user_id: null,
    link_status: 'unmatched',
    match_strategy: 'manual_unbound',
    reviewed_by: ADMIN_USER_ID,
    review_note: 'unbound by admin',
  })
}

function expectHeldStats(stats: Record<string, unknown>, heldCount: number) {
  expect(stats.autoAdmissionCandidateCount).toBe(0)
  expect(stats.autoAdmissionFailedCount).toBe(0)
  expect(stats.autoAdmittedCount).toBe(0)
  expect(stats.adminUnboundHeldCount).toBe(heldCount)
}

async function waitUntilBlockedOnHolder(pool: Pool, holderPid: number, statementLike: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const blocked = await pool.query(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))
          AND query ILIKE $2`,
      [holderPid, statementLike],
    )
    if (Number(blocked.rows[0]?.n ?? 0) >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out waiting for the sync to block on the holder connection')
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describeIfDatabase('directory link intent persistence (real DB)', () => {
  beforeAll(async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, role)
       VALUES ($1, $2, 'F01 Admin', 'x', 'admin')`,
      [ADMIN_USER_ID, `f01-admin-${TS}@example.test`],
    )
  })

  afterAll(async () => {
    for (const integrationId of createdIntegrationIds) {
      await rememberLinkedUsers(integrationId)
    }
    const userIds = Array.from(createdUserIds)
    await query(`DELETE FROM user_invites WHERE user_id = ANY($1::text[])`, [userIds])
    await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = ANY($1::text[])`, [userIds])
    await query(`DELETE FROM user_external_identities WHERE local_user_id = ANY($1::text[])`, [userIds])
    await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [userIds])
    await query(`DELETE FROM user_roles WHERE user_id = ANY($1::text[])`, [userIds])
    for (const integrationId of createdIntegrationIds) {
      await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId])
      await query(
        `DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
        [integrationId],
      )
      await query(
        `DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`,
        [integrationId],
      )
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    }
    await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds])
  }, 60_000)

  // -------------------------------------------------------------------------------------------
  // Scenario group 1 (auto-admission mode): the held account has NO identity, email or mobile
  // match left after the unbind, which is exactly the shape auto-admission would otherwise
  // create a new local user for.
  // -------------------------------------------------------------------------------------------
  describe('auto-admission mode: unbind, then repeated syncs, candidates, ambiguity, explicit re-bind and admit', () => {
    let integrationId = ''
    let orgId = ''
    let accountId = ''
    let admittedUserId = ''
    let heldRow: LinkRow | null = null
    const A = member('a')

    beforeAll(async () => {
      const integration = await createIntegration('g1', 'auto_for_scoped_departments')
      integrationId = integration.id
      orgId = integration.orgId
      setPulledMembers([A])
    })

    it('d1: an admin unbind is kept across a manual and a scheduled sync; no user is created, all counters stay 0', async () => {
      await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      accountId = await accountIdOf(integrationId, A.userId)
      const admitted = await readLink(accountId)
      expect(admitted).toMatchObject({ link_status: 'linked', match_strategy: 'auto_admit' })
      admittedUserId = admitted?.local_user_id ?? ''
      expect(admittedUserId).toBeTruthy()
      createdUserIds.add(admittedUserId)

      await unbindDirectoryAccount(accountId, { adminUserId: ADMIN_USER_ID })
      heldRow = await readLink(accountId)
      expectHeld(heldRow)
      const usersBefore = await usersCount()
      const membershipAfterUnbind = await query<{ is_active: boolean }>(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
        [admittedUserId, orgId],
      )
      expect(membershipAfterUnbind.rows).toEqual([{ is_active: false }])

      const run2 = await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      expectHeldStats(run2.run.stats as Record<string, unknown>, 1)
      expect(await readLink(accountId)).toEqual(heldRow)

      const run3 = await syncDirectoryIntegration(integrationId, 'system:directory-sync-scheduler', 'scheduler')
      expectHeldStats(run3.run.stats as Record<string, unknown>, 1)
      expect(await readLink(accountId)).toEqual(heldRow)

      expect(await usersCount()).toBe(usersBefore)
      const membershipAfterSyncs = await query<{ is_active: boolean }>(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
        [admittedUserId, orgId],
      )
      expect(membershipAfterSyncs.rows).toEqual([{ is_active: false }])
      // Preview agrees with apply on the held key and reports no candidate.
      const preview = await previewDirectorySyncIntegration(integrationId)
      expect(preview.adminUnboundHeldCount).toBe(1)
      expect(preview.autoAdmissionCandidateCount).toBe(0)
    }, 120_000)

    it('d3: an identity row with the account corp+unionId for a local user does not re-link the held account', async () => {
      const integration = await query<{ corp_id: string }>(`SELECT corp_id FROM directory_integrations WHERE id = $1`, [integrationId])
      const corpId = integration.rows[0].corp_id
      const identityId = randomUUID()
      await query(
        `INSERT INTO user_external_identities (id, provider, external_key, provider_union_id, provider_open_id, corp_id, local_user_id, profile)
         VALUES ($1::uuid, 'dingtalk', $2, $3, $4, $5, $6, '{}'::jsonb)`,
        [identityId, `${corpId}:${A.openId}`, A.unionId, A.openId, corpId, admittedUserId],
      )
      try {
        const usersBefore = await usersCount()
        const run = await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
        expectHeldStats(run.run.stats as Record<string, unknown>, 1)
        expect(await readLink(accountId)).toEqual(heldRow)
        expect(await usersCount()).toBe(usersBefore)
        const identity = await query<{ local_user_id: string; corp_id: string }>(
          `SELECT local_user_id, corp_id FROM user_external_identities WHERE id = $1::uuid`,
          [identityId],
        )
        expect(identity.rows).toEqual([{ local_user_id: admittedUserId, corp_id: corpId }])
        const membership = await query<{ is_active: boolean }>(
          `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
          [admittedUserId, orgId],
        )
        expect(membership.rows).toEqual([{ is_active: false }])
      } finally {
        await query(`DELETE FROM user_external_identities WHERE id = $1::uuid`, [identityId])
      }
    }, 60_000)

    it('d4: an ambiguous identifier (two local users sharing the account mobile) leaves the held row untouched', async () => {
      const sharedMobile = `137${String(TS).slice(-8)}`
      await createLocalUser('m1', { mobile: sharedMobile })
      await createLocalUser('m2', { mobile: sharedMobile })
      setPulledMembers([{ ...A, mobile: sharedMobile }])

      const usersBefore = await usersCount()
      const run = await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      expectHeldStats(run.run.stats as Record<string, unknown>, 1)
      expect(await readLink(accountId)).toEqual(heldRow)
      expect(await usersCount()).toBe(usersBefore)

      setPulledMembers([A])
    }, 60_000)

    it('d5: an explicit admin bind replaces the hold, a sync keeps the bind, and a second unbind holds again', async () => {
      const targetUserId = await createLocalUser('v', { mobile: `136${String(TS).slice(-8)}` })

      await bindDirectoryAccount(accountId, { localUserRef: targetUserId, adminUserId: ADMIN_USER_ID })
      const bound = await readLink(accountId)
      expect(bound).toMatchObject({
        local_user_id: targetUserId,
        link_status: 'linked',
        match_strategy: 'manual_admin',
        reviewed_by: ADMIN_USER_ID,
        review_note: null,
      })
      expect(isAdminUnboundDirectoryLink(bound)).toBe(false)

      const run = await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      expect((run.run.stats as Record<string, unknown>).adminUnboundHeldCount).toBe(0)
      expect(await readLink(accountId)).toMatchObject({
        local_user_id: targetUserId,
        link_status: 'linked',
        match_strategy: 'manual_admin',
      })
      const membership = await query<{ is_active: boolean }>(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
        [targetUserId, orgId],
      )
      expect(membership.rows).toEqual([{ is_active: true }])

      await unbindDirectoryAccount(accountId, { adminUserId: ADMIN_USER_ID })
      heldRow = await readLink(accountId)
      expectHeld(heldRow)
      const usersBefore = await usersCount()
      const run2 = await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      expectHeldStats(run2.run.stats as Record<string, unknown>, 1)
      expect(await readLink(accountId)).toEqual(heldRow)
      expect(await usersCount()).toBe(usersBefore)
    }, 90_000)

    it('d6: an explicit admin admit with a non-colliding email replaces the hold and the next sync keeps it', async () => {
      const email = `f01-admitted-${TS}@example.test`
      const admitted = await admitDirectoryAccountUser(accountId, {
        adminUserId: ADMIN_USER_ID,
        name: 'Admitted Member',
        email,
      })
      createdUserIds.add(admitted.user.id)
      expect(await readLink(accountId)).toMatchObject({
        local_user_id: admitted.user.id,
        link_status: 'linked',
        match_strategy: 'manual_admin',
        reviewed_by: ADMIN_USER_ID,
        review_note: null,
      })

      const run = await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      expect((run.run.stats as Record<string, unknown>).adminUnboundHeldCount).toBe(0)
      expect(await readLink(accountId)).toMatchObject({
        local_user_id: admitted.user.id,
        link_status: 'linked',
        match_strategy: 'manual_admin',
      })
    }, 60_000)
  })

  // -------------------------------------------------------------------------------------------
  // Scenario group 2 (manual mode): the held account's email still matches a local user, so an
  // ordinary sync would otherwise write a pending hint pointing at that user.
  // -------------------------------------------------------------------------------------------
  describe('manual mode: a unique email candidate does not re-attach a held account', () => {
    it('d2: after an unbind the row stays held with no local user, across two syncs', async () => {
      const integration = await createIntegration('g2', 'manual_only')
      const email = `f01-hint-${TS}@example.test`
      const hintedUserId = await createLocalUser('hint', { email })
      const B = member('b', { email })
      setPulledMembers([B])

      await syncDirectoryIntegration(integration.id, ADMIN_USER_ID, 'manual')
      const accountId = await accountIdOf(integration.id, B.userId)
      // Ordinary matching on a fresh account writes the hint (also shows that a held row in
      // another integration does not affect this one).
      expect(await readLink(accountId)).toMatchObject({
        local_user_id: hintedUserId,
        link_status: 'pending',
        match_strategy: 'email',
      })

      await unbindDirectoryAccount(accountId, { adminUserId: ADMIN_USER_ID })
      const heldRow = await readLink(accountId)
      expectHeld(heldRow)

      for (const source of ['manual', 'scheduler'] as const) {
        const run = await syncDirectoryIntegration(integration.id, ADMIN_USER_ID, source)
        expect((run.run.stats as Record<string, unknown>).adminUnboundHeldCount).toBe(1)
        expect(await readLink(accountId)).toEqual(heldRow)
      }
      const preview = await previewDirectorySyncIntegration(integration.id)
      expect(preview.adminUnboundHeldCount).toBe(1)
      expect(preview.autoAdmissionCandidateCount).toBe(0)
    }, 90_000)
  })

  // -------------------------------------------------------------------------------------------
  // Scenario group 3: preview / apply parity, including a departed held account that apply
  // visits but preview (pulled members only) never sees — both report the pulled held account
  // only.
  // -------------------------------------------------------------------------------------------
  describe('preview/apply parity with a pulled held account, a departed held account and a plain candidate', () => {
    it('d7: both sides report held 1 and candidate 1; both held rows stay byte-for-byte unchanged', async () => {
      const integration = await createIntegration('g3', 'auto_for_scoped_departments')
      const H1 = member('h1')
      const H2 = member('h2')
      const P = member('p')

      setPulledMembers([H1, H2])
      await syncDirectoryIntegration(integration.id, ADMIN_USER_ID, 'manual')
      await rememberLinkedUsers(integration.id)
      const h1AccountId = await accountIdOf(integration.id, H1.userId)
      const h2AccountId = await accountIdOf(integration.id, H2.userId)
      expect(await readLink(h1AccountId)).toMatchObject({ link_status: 'linked', match_strategy: 'auto_admit' })
      expect(await readLink(h2AccountId)).toMatchObject({ link_status: 'linked', match_strategy: 'auto_admit' })

      // H2 departs (absent from the next pull) and is then unbound; H1 stays pulled and is unbound.
      setPulledMembers([H1])
      await syncDirectoryIntegration(integration.id, ADMIN_USER_ID, 'manual')
      const h2Active = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_accounts WHERE id = $1`, [h2AccountId])
      expect(h2Active.rows).toEqual([{ is_active: false }])
      await unbindDirectoryAccount(h1AccountId, { adminUserId: ADMIN_USER_ID })
      await unbindDirectoryAccount(h2AccountId, { adminUserId: ADMIN_USER_ID })
      const h1Held = await readLink(h1AccountId)
      const h2Held = await readLink(h2AccountId)
      expectHeld(h1Held)
      expectHeld(h2Held)

      setPulledMembers([H1, P])
      const usersBefore = await usersCount()
      const preview = await previewDirectorySyncIntegration(integration.id)
      expect(preview.adminUnboundHeldCount).toBe(1)
      expect(preview.autoAdmissionCandidateCount).toBe(1)

      const apply = await syncDirectoryIntegration(integration.id, ADMIN_USER_ID, 'manual')
      const stats = apply.run.stats as Record<string, unknown>
      expect(stats.adminUnboundHeldCount).toBe(preview.adminUnboundHeldCount)
      expect(stats.autoAdmissionCandidateCount).toBe(preview.autoAdmissionCandidateCount)
      expect(stats.autoAdmittedCount).toBe(1)
      expect(stats.autoAdmissionFailedCount).toBe(0)
      await rememberLinkedUsers(integration.id)

      expect(await readLink(h1AccountId)).toEqual(h1Held)
      expect(await readLink(h2AccountId)).toEqual(h2Held)
      const pAccountId = await accountIdOf(integration.id, P.userId)
      expect(await readLink(pAccountId)).toMatchObject({ link_status: 'linked', match_strategy: 'auto_admit' })
      // Exactly the plain candidate was created.
      expect(await usersCount()).toBe(usersBefore + 1)
    }, 120_000)
  })

  // -------------------------------------------------------------------------------------------
  // Scenario group 4 (manual mode): the sync's link write under concurrency, NULL-strategy rows,
  // and a reviewer column that is not an unbind.
  // -------------------------------------------------------------------------------------------
  describe('concurrent writes, NULL strategy rows and reviewer columns', () => {
    let integrationId = ''
    const C = member('c', { email: `f01-c-${TS}@example.test` })
    const D = member('d', { email: `f01-d-${TS}@example.test` })
    const E = member('e', { email: `f01-e-${TS}@example.test` })
    const F = member('f')
    const G = member('g')
    let cUserId = ''
    let dUserId = ''
    let eUserId = ''

    beforeAll(async () => {
      const integration = await createIntegration('g4', 'manual_only')
      integrationId = integration.id
      cUserId = await createLocalUser('c', { email: C.email })
      dUserId = await createLocalUser('d', { email: D.email })
      eUserId = await createLocalUser('e', { email: E.email })
      setPulledMembers([C, D, E, F, G])
      await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
    }, 60_000)

    it('d8a: an unbind that commits while the sync waits on the link row is kept (the conditional write re-reads the row)', async () => {
      const accountId = await accountIdOf(integrationId, C.userId)
      expect(await readLink(accountId)).toMatchObject({ local_user_id: cUserId, link_status: 'pending', match_strategy: 'email' })

      const pool = new Pool({ connectionString: process.env.DATABASE_URL })
      const holder = await pool.connect()
      let syncOutcome: Promise<unknown> | null = null
      try {
        await holder.query('BEGIN')
        const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        await holder.query(`SELECT 1 FROM directory_account_links WHERE directory_account_id = $1 FOR UPDATE`, [accountId])

        const sync = syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
        syncOutcome = sync.then(() => null, (error: unknown) => error)
        await waitUntilBlockedOnHolder(pool, holderPid, '%INSERT INTO directory_account_links%')

        // The holder now writes the unbind shape (same columns `unbindDirectoryAccount` writes)
        // and commits; the sync's write then sees this committed version.
        await holder.query(
          `UPDATE directory_account_links
              SET local_user_id = NULL, link_status = 'unmatched', match_strategy = 'manual_unbound',
                  reviewed_by = $2, review_note = 'unbound by admin', updated_at = NOW()
            WHERE directory_account_id = $1`,
          [accountId, ADMIN_USER_ID],
        )
        const written = await holder.query<LinkRow>(
          `SELECT local_user_id, link_status, match_strategy, reviewed_by, review_note, updated_at::text AS updated_at
             FROM directory_account_links WHERE directory_account_id = $1`,
          [accountId],
        )
        await holder.query('COMMIT')

        expect(await withTimeout(syncOutcome, 60_000, 'sync')).toBeNull()
        const after = await readLink(accountId)
        expectHeld(after)
        expect(after).toEqual(written.rows[0])
      } finally {
        // Release the row (no-op after COMMIT) and let a still-parked sync finish before closing.
        await holder.query('ROLLBACK').catch(() => undefined)
        if (syncOutcome) await withTimeout(syncOutcome, 60_000, 'sync drain').catch(() => undefined)
        holder.release()
        await pool.end()
      }
    }, 150_000)

    it('d8b: a real admin unbind that commits between the sync reading the links and writing them is kept', async () => {
      // F departs so the sync holds no account-row lock on it; it has no local user so the unbind
      // holds no users-row lock either. A gated BEFORE INSERT trigger on the link table parks the
      // sync at its first link write (any account) on an advisory lock the holder owns; the
      // trigger is skipped for the unbind's own write, so the unbind completes while the sync
      // waits.
      setPulledMembers([C, D, E, G])
      await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      const fAccountId = await accountIdOf(integrationId, F.userId)
      const gAccountId = await accountIdOf(integrationId, G.userId)
      expect((await query<{ is_active: boolean }>(`SELECT is_active FROM directory_accounts WHERE id = $1`, [fAccountId])).rows).toEqual([{ is_active: false }])
      expect(await readLink(fAccountId)).toMatchObject({ local_user_id: null, link_status: 'unmatched', match_strategy: 'none' })
      const gBefore = await readLink(gAccountId)

      const lockKey = Number(String(TS).slice(-8))
      const fnName = `f01_hold_${TS}`
      const pool = new Pool({ connectionString: process.env.DATABASE_URL })
      const holder = await pool.connect()
      let syncOutcome: Promise<unknown> | null = null
      try {
        await query(
          `CREATE FUNCTION ${fnName}() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             PERFORM pg_advisory_xact_lock(${lockKey});
             RETURN NEW;
           END $$`,
        )
        await query(
          `CREATE TRIGGER ${fnName} BEFORE INSERT ON directory_account_links
           FOR EACH ROW
           WHEN (NEW.match_strategy IS DISTINCT FROM 'manual_unbound'
                 AND NEW.directory_account_id IN ('${fAccountId}'::uuid, '${gAccountId}'::uuid))
           EXECUTE FUNCTION ${fnName}()`,
        )
        const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        await holder.query(`SELECT pg_advisory_lock($1)`, [lockKey])

        const sync = syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'scheduler')
        syncOutcome = sync.then(() => null, (error: unknown) => error)
        await waitUntilBlockedOnHolder(pool, holderPid, '%INSERT INTO directory_account_links%')

        await withTimeout(unbindDirectoryAccount(fAccountId, { adminUserId: ADMIN_USER_ID }), 30_000, 'unbind')
        const heldRow = await readLink(fAccountId)
        expectHeld(heldRow)

        await holder.query(`SELECT pg_advisory_unlock($1)`, [lockKey])
        expect(await withTimeout(syncOutcome, 60_000, 'sync')).toBeNull()

        expect(await readLink(fAccountId)).toEqual(heldRow)
        // The sync still wrote the other account normally.
        const gAfter = await readLink(gAccountId)
        expect(gAfter).toMatchObject({ local_user_id: null, link_status: 'unmatched', match_strategy: 'none' })
        expect(gAfter?.updated_at).not.toBe(gBefore?.updated_at)
      } finally {
        // Release the parked sync FIRST and let it finish: dropping the trigger needs an exclusive
        // lock on the table, which a still-running sync transaction would block.
        await holder.query(`SELECT pg_advisory_unlock_all()`).catch(() => undefined)
        if (syncOutcome) await withTimeout(syncOutcome, 60_000, 'sync drain').catch(() => undefined)
        await query(`DROP TRIGGER IF EXISTS ${fnName} ON directory_account_links`)
        await query(`DROP FUNCTION IF EXISTS ${fnName}()`)
        holder.release()
        await pool.end()
      }
    }, 180_000)

    it('d8c: a link row whose strategy is NULL is still updated by the sync', async () => {
      const accountId = await accountIdOf(integrationId, D.userId)
      await query(`UPDATE directory_account_links SET match_strategy = NULL WHERE directory_account_id = $1`, [accountId])
      expect(await readLink(accountId)).toMatchObject({ local_user_id: dUserId, link_status: 'pending', match_strategy: null })

      await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      expect(await readLink(accountId)).toMatchObject({ local_user_id: dUserId, link_status: 'pending', match_strategy: 'email' })
    }, 60_000)

    it('d9: a reviewer on an unmatched row is not an unbind — the sync re-matches it', async () => {
      const accountId = await accountIdOf(integrationId, E.userId)
      await query(
        `UPDATE directory_account_links
            SET local_user_id = NULL, link_status = 'unmatched', match_strategy = 'none', reviewed_by = $2
          WHERE directory_account_id = $1`,
        [accountId, ADMIN_USER_ID],
      )
      const before = await readLink(accountId)
      expect(isAdminUnboundDirectoryLink(before)).toBe(false)

      await syncDirectoryIntegration(integrationId, ADMIN_USER_ID, 'manual')
      const after = await readLink(accountId)
      expect(after).toMatchObject({ local_user_id: eUserId, link_status: 'pending', match_strategy: 'email', reviewed_by: ADMIN_USER_ID })
      expect(after?.updated_at).not.toBe(before?.updated_at)
    }, 60_000)
  })
})
