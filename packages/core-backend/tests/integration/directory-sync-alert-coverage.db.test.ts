import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// R5 (per-run summary block below): the DingTalk HTTP client is mocked so real
// `syncDirectoryIntegration` runs can pull a synthetic directory against real Postgres.
// The DT-OPS-03 blocks in this file never touch the client, so they are unaffected.
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
  countConsecutiveFailedRuns,
  getDirectoryInactiveLinkedMetric,
  getDirectoryManagerBindingCoverage,
} from '../../src/directory/directory-sync-alert-delivery'
import {
  createDirectoryIntegration,
  listDirectorySyncRuns,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'

/**
 * DT-OPS-03 P2-2 — REAL DB coverage. The unit test (directory-sync-alert-delivery.test.ts)
 * drives both `getDirectoryManagerBindingCoverage` and `countConsecutiveFailedRuns` against a
 * fake `queryFn` that just echoes back whatever rows the test hands it — so it proves the
 * TypeScript plumbing but cannot catch a malformed or semantically-wrong SQL string. This file
 * proves the actual SQL against real Postgres: the leader/dept-head UNION + LEFT JOIN chain in
 * the coverage CTE, and the ORDER BY direction in the failure-streak query (mutating either one
 * leaves every unit test green — that is the gap this file closes).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

describeIfDatabase('DT-OPS-03 manager binding coverage + failure streak (real DB)', () => {
  describe('getDirectoryManagerBindingCoverage', () => {
    let integrationId = ''
    let deptAId = ''
    const DEPT_A = `dsac-deptA-${TS}`
    const DEPT_B = `dsac-deptB-${TS}`
    const U_HEAD = `dsac-uhead-${TS}`
    const U_LEADER = `dsac-uleader-${TS}`

    beforeAll(async () => {
      integrationId = (await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [`dsac-cov-${TS}`, `dsac-cov-corp-${TS}`],
      )).rows[0].id

      await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x'), ($3, $4, 'x')`, [
        U_HEAD, `${U_HEAD}@example.test`, U_LEADER, `${U_LEADER}@example.test`,
      ])

      // Dept A names its manager via dept_manager_userid_list (the "department head" path).
      deptAId = (await query<{ id: string }>(
        `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
         VALUES ($1, $2, 'DeptA', true, $3::jsonb) RETURNING id`,
        [integrationId, DEPT_A, JSON.stringify({ dept_manager_userid_list: [`ext-head-${TS}`] })],
      )).rows[0].id

      // Dept B has NO manager configured at all (absent key) — must not blow up the CTE, and must
      // not contribute any manager to the aggregate.
      await query(
        `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
         VALUES ($1, $2, 'DeptB', true, '{}'::jsonb)`,
        [integrationId, DEPT_B],
      )

      // Manager 1: named as DeptA's head, LINKED to a local user -> counts + bound.
      const accHead = (await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'Head', true, '{}'::jsonb) RETURNING id`,
        [integrationId, `ext-head-${TS}`, `key-head-${TS}`],
      )).rows[0].id

      // Manager 2: flagged leader:true of DeptA in its own raw, LINKED -> distinct manager, bound.
      const accLeaderTrue = (await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'LeaderTrue', true, $4::jsonb) RETURNING id`,
        [integrationId, `ext-leadertrue-${TS}`, `key-leadertrue-${TS}`,
          JSON.stringify({ leader_in_dept: [{ dept_id: DEPT_A, leader: true }] })],
      )).rows[0].id

      // Manager candidate that is explicitly leader:false — must NOT be counted as a manager at all.
      await query(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'LeaderFalse', true, $4::jsonb)`,
        [integrationId, `ext-leaderfalse-${TS}`, `key-leaderfalse-${TS}`,
          JSON.stringify({ leader_in_dept: [{ dept_id: DEPT_A, leader: false }] })],
      )

      // Manager 3: named as DeptA's head via a SECOND dept_manager_userid_list entry, but never
      // synced as a directory_account and never linked -> counts toward manager_count, not linked.
      await query(
        `UPDATE directory_departments SET raw = $2::jsonb WHERE id = $1`,
        [deptAId, JSON.stringify({ dept_manager_userid_list: [`ext-head-${TS}`, `ext-unlinked-${TS}`] })],
      )
      await query(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'Unlinked', true, '{}'::jsonb)`,
        [integrationId, `ext-unlinked-${TS}`, `key-unlinked-${TS}`],
      )

      // A plain employee — never named as a manager anywhere — must not leak into the count.
      await query(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
         VALUES ($1, $2, $3, 'Employee', true, '{}'::jsonb)`,
        [integrationId, `ext-employee-${TS}`, `key-employee-${TS}`],
      )

      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual')`,
        [accHead, U_HEAD, accLeaderTrue, U_LEADER],
      )
    })

    afterAll(async () => {
      if (integrationId) {
        await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
        await query(`DELETE FROM users WHERE id = ANY($1)`, [[U_HEAD, U_LEADER]])
      }
    })

    it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
      expect(process.env.DATABASE_URL).toBeTruthy()
    })

    it('counts dept-head + leader:true managers once each, excludes leader:false, and tracks link status per manager (real SQL)', async () => {
      const result = await getDirectoryManagerBindingCoverage(integrationId)
      // Managers: Head (dept-head, linked), LeaderTrue (leader:true, linked), Unlinked (dept-head, not linked).
      // LeaderFalse and Employee must not appear.
      expect(result).toEqual({ managerCount: 3, linkedManagerCount: 2, coverage: 2 / 3 })
    })

    it('does not divide by zero for an integration whose accounts never name a manager', async () => {
      const emptyIntegrationId = (await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [`dsac-cov-empty-${TS}`, `dsac-cov-empty-corp-${TS}`],
      )).rows[0].id
      try {
        // A wholly separate integration where NOTHING is ever named a manager — the aggregate
        // manager_count is genuinely 0, proving `managerCount === 0 ? 1 : ...` behaves against
        // a real empty result set rather than a hand-built mock row.
        await query(
          `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
           VALUES ($1, $2, 'EmptyDept', true, '{}'::jsonb)`,
          [emptyIntegrationId, `dsac-emptydept-${TS}`],
        )
        await query(
          `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw)
           VALUES ($1, $2, $3, 'NotAManager', true, '{}'::jsonb)`,
          [emptyIntegrationId, `ext-notamanager-${TS}`, `key-notamanager-${TS}`],
        )

        const result = await getDirectoryManagerBindingCoverage(emptyIntegrationId)
        expect(result).toEqual({ managerCount: 0, linkedManagerCount: 0, coverage: 1 })
      } finally {
        await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [emptyIntegrationId])
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [emptyIntegrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [emptyIntegrationId])
      }
    })
  })

  describe('countConsecutiveFailedRuns', () => {
    let integrationId = ''
    const runIds: string[] = []

    beforeAll(async () => {
      integrationId = (await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
        [`dsac-streak-${TS}`, `dsac-streak-corp-${TS}`],
      )).rows[0].id

      const base = new Date('2026-01-01T00:00:00.000Z').getTime()
      const at = (offsetMinutes: number) => new Date(base + offsetMinutes * 60_000).toISOString()

      // Chronological order (oldest -> newest): completed, failed, running, failed, failed(latest).
      // The trailing streak (from the latest run backward) is: failed, failed — then the `running`
      // row is skipped by the WHERE clause — then failed, then it hits `completed` and stops: streak=3.
      const seeds: Array<{ status: string; offset: number }> = [
        { status: 'completed', offset: 0 },
        { status: 'failed', offset: 10 },
        { status: 'running', offset: 20 },
        { status: 'failed', offset: 30 },
        { status: 'failed', offset: 40 },
      ]
      for (const seed of seeds) {
        const row = await query<{ id: string }>(
          `INSERT INTO directory_sync_runs (integration_id, status, started_at, trigger_source)
           VALUES ($1, $2, $3, 'manual') RETURNING id`,
          [integrationId, seed.status, at(seed.offset)],
        )
        runIds.push(row.rows[0].id)
      }
    })

    afterAll(async () => {
      if (integrationId) {
        await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
    })

    it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
      expect(process.env.DATABASE_URL).toBeTruthy()
    })

    it('counts the trailing failure streak from the most recent run backward, skipping running and stopping at completed (real SQL, proves ORDER BY DESC)', async () => {
      const streak = await countConsecutiveFailedRuns(integrationId)
      expect(streak).toBe(3)
    })

    it('is zero when the most recent completed/failed run succeeded', async () => {
      // Append a completed run after the existing seeds — now the latest completed/failed row is
      // itself a success, so the streak collapses to zero regardless of the earlier failures.
      const base = new Date('2026-01-01T00:00:00.000Z').getTime()
      const latest = new Date(base + 50 * 60_000).toISOString()
      const row = await query<{ id: string }>(
        `INSERT INTO directory_sync_runs (integration_id, status, started_at, trigger_source)
         VALUES ($1, 'completed', $2, 'manual') RETURNING id`,
        [integrationId, latest],
      )
      runIds.push(row.rows[0].id)

      const streak = await countConsecutiveFailedRuns(integrationId)
      expect(streak).toBe(0)
    })
  })
})

/**
 * R5 — per-run directory sync summary persisted into directory_sync_runs.stats.
 *
 * Drives the REAL `syncDirectoryIntegration` (mocked DingTalk pull, real Postgres apply)
 * four times over an evolving synthetic directory and asserts the run rows carry an honest
 * change summary: created-vs-updated split (the `(xmax = 0)` upsert discriminator — this is
 * exactly what mocks cannot exercise), per-run deactivation TRANSITION counts, the
 * manager-binding coverage snapshot, and durationMs. Real-DB on purpose: ON CONFLICT
 * resolution and xmax semantics only exist in PostgreSQL.
 *
 * The `it` blocks are order-dependent (run 1 → run 4), matching this file's existing style.
 */
describeIfDatabase('R5 per-run sync summary stats (real DB)', () => {
  const CORP = `dsrs-corp-${TS}`
  const D1 = `dsrs-d1-${TS}`
  const D2 = `dsrs-d2-${TS}`
  const EXT_M1 = `dsrs-ext-m1-${TS}` // dept head of D1, pre-seeded + pre-linked
  const EXT_M2 = `dsrs-ext-m2-${TS}` // leader_in_dept manager, never linked
  const EXT_E3 = `dsrs-ext-e3-${TS}` // plain employee, departs before run 2
  const U_MGR = `dsrs-umgr-${TS}` // local user M1 is linked to

  let integrationId = ''
  // Which directory the mocked DingTalk tenant currently answers with.
  let pullScenario: 'full' | 'e3Departed' | 'd2Departed' = 'full'

  function userDetail(userId: string, name: string, source: Record<string, unknown> = {}) {
    return {
      userId,
      name,
      unionId: `dsrs-un-${userId}`,
      openId: `dsrs-op-${userId}`,
      email: undefined,
      mobile: undefined,
      departmentIds: [] as string[],
      source,
    }
  }

  beforeAll(async () => {
    await query(
      `INSERT INTO users (id, email, name, password_hash, role)
       VALUES ($1, $2, 'DSRS Manager', 'x', 'user')
       ON CONFLICT (id) DO NOTHING`,
      [U_MGR, `${U_MGR}@example.test`],
    )

    const integration = await createDirectoryIntegration({
      name: `dsrs-${TS}`,
      corpId: CORP,
      appKey: `dsrs-appkey-${TS}`,
      appSecret: 'dsrs-appsecret',
      admissionMode: 'manual_only',
    })
    integrationId = integration.id

    // Pre-seed M1 as an existing, LINKED directory account: run 1 must count it as
    // UPDATED (upsert hits ON CONFLICT), and coverage must count it as the one bound manager.
    const m1Account = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (
         integration_id, corp_id, external_user_id, union_id, external_key, name, is_active, last_seen_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $4, 'Manager One', true, NOW(), NOW(), NOW())
       RETURNING id`,
      [integrationId, CORP, EXT_M1, `dsrs-un-${EXT_M1}`],
    )).rows[0].id
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
       VALUES ($1, $2, 'linked', 'manual', NOW(), NOW())`,
      [m1Account, U_MGR],
    )

    clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('dsrs-token')
    clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) => {
      if (parentId !== '1') return []
      const children = [{ id: D1, parentId: '1', name: 'Ops', order: 0, source: {} }]
      if (pullScenario !== 'd2Departed') {
        children.push({ id: D2, parentId: '1', name: 'Empty Wing', order: 1, source: {} })
      }
      return children
    })
    // D1 names M1 as its department head (dept_manager_userid_list manager path).
    clientMocks.getDingTalkDepartmentDetail.mockImplementation(async (_token: string, deptId: string) => ({
      deptManagerUserIdList: deptId === D1 ? [EXT_M1] : [],
    }))
    clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) => {
      if (deptId === D1) {
        const users = [
          { userId: EXT_M1, name: 'Manager One', departmentIds: [D1], source: {} },
          { userId: EXT_M2, name: 'Manager Two', departmentIds: [D1], source: {} },
        ]
        if (pullScenario === 'full') {
          users.push({ userId: EXT_E3, name: 'Employee Three', departmentIds: [D1], source: {} })
        }
        return { users, nextCursor: null, hasMore: false }
      }
      return { users: [], nextCursor: null, hasMore: false }
    })
    clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => {
      switch (userId) {
        case EXT_M1:
          return userDetail(EXT_M1, 'Manager One')
        case EXT_M2:
          // leader_in_dept manager path (account raw), never linked to a local user.
          return userDetail(EXT_M2, 'Manager Two', { leader_in_dept: [{ dept_id: 999, leader: true }] })
        case EXT_E3:
          return userDetail(EXT_E3, 'Employee Three')
        default:
          throw new Error(`unexpected userId ${userId}`)
      }
    })
  })

  afterAll(async () => {
    if (integrationId) {
      await query(`DELETE FROM directory_sync_runs WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_account_links WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`, [integrationId])
      await query(`DELETE FROM directory_account_departments WHERE directory_account_id IN (SELECT id FROM directory_accounts WHERE integration_id = $1)`, [integrationId])
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    }
    await query(`DELETE FROM users WHERE id = $1`, [U_MGR])
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('run 1: first sync splits created vs updated (xmax discriminator), snapshots manager coverage, keeps pre-existing stats keys, and flows through the runs list', async () => {
    pullScenario = 'full'
    const result = await syncDirectoryIntegration(integrationId, 'system:dsrs-test')
    const stats = result.run.stats as Record<string, unknown>

    // Departments: synthetic root + D1 + D2, all new to the DB.
    expect(stats.departmentsSynced).toBe(3)
    expect(stats.departmentsCreatedCount).toBe(3)
    expect(stats.departmentsUpdatedCount).toBe(0)
    expect(stats.departmentsDeactivatedCount).toBe(0)

    // Accounts: M2 + E3 are genuinely new (INSERT, xmax=0); pre-seeded M1 hits
    // ON CONFLICT DO UPDATE (xmax != 0). A mock could never prove this split.
    expect(stats.accountsSynced).toBe(3)
    expect(stats.accountsCreatedCount).toBe(2)
    expect(stats.accountsUpdatedCount).toBe(1)
    expect(stats.accountsDeactivatedCount).toBe(0)

    // Manager coverage snapshot: M1 (dept head, linked) + M2 (leader_in_dept, unlinked).
    expect(stats.managerCount).toBe(2)
    expect(stats.linkedManagerCount).toBe(1)
    expect(stats.managerCoverage).toBe(0.5)

    expect(typeof stats.durationMs).toBe('number')
    expect(stats.durationMs as number).toBeGreaterThanOrEqual(0)

    // The summary is ADDITIVE: pre-existing completion keys must survive the merge.
    expect(stats.linkedCount).toBe(1)
    expect(stats.pendingCount).toBe(0)
    expect(stats.unmatchedCount).toBe(2)
    expect(stats.autoAdmittedCount).toBe(0)
    expect(stats.deprovisionApplied).toBe(false)

    // The persisted snapshot must agree with the live #3914 coverage function that
    // GET /manager-coverage serves — same numbers, one from the run row, one live.
    const live = await getDirectoryManagerBindingCoverage(integrationId)
    expect(live).toEqual({ managerCount: 2, linkedManagerCount: 1, coverage: 0.5 })
    expect(stats.managerCount).toBe(live.managerCount)
    expect(stats.linkedManagerCount).toBe(live.linkedManagerCount)
    expect(stats.managerCoverage).toBe(live.coverage)

    // OPS-02 surface: GET /integrations/:id/runs serves listDirectorySyncRuns verbatim —
    // the new keys must arrive there with no route change.
    const runs = await listDirectorySyncRuns(integrationId, { limit: 5, offset: 0 })
    const listed = runs.items.find((item) => item.id === result.run.id)
    expect(listed).toBeTruthy()
    const listedStats = listed?.stats as Record<string, unknown>
    expect(listedStats.accountsCreatedCount).toBe(2)
    expect(listedStats.accountsUpdatedCount).toBe(1)
    expect(listedStats.managerCoverage).toBe(0.5)
    expect(typeof listedStats.durationMs).toBe('number')
  })

  it('run 2: after one user departs — nothing created, survivors updated, departure counted as deactivated', async () => {
    pullScenario = 'e3Departed'
    const result = await syncDirectoryIntegration(integrationId, 'system:dsrs-test')
    const stats = result.run.stats as Record<string, unknown>

    expect(stats.accountsCreatedCount).toBe(0)
    expect(stats.accountsUpdatedCount).toBe(2)
    expect(stats.accountsDeactivatedCount).toBe(1)

    expect(stats.departmentsCreatedCount).toBe(0)
    expect(stats.departmentsUpdatedCount).toBe(3)
    expect(stats.departmentsDeactivatedCount).toBe(0)

    // Cross-check the count against the actual DB effect: E3 really is inactive now.
    const e3 = await query<{ is_active: boolean }>(
      `SELECT is_active FROM directory_accounts WHERE integration_id = $1 AND external_user_id = $2`,
      [integrationId, EXT_E3],
    )
    expect(e3.rows[0]?.is_active).toBe(false)
  })

  it('run 3: a department departs — counted once; the already-inactive account is NOT re-counted', async () => {
    pullScenario = 'd2Departed'
    const result = await syncDirectoryIntegration(integrationId, 'system:dsrs-test')
    const stats = result.run.stats as Record<string, unknown>

    expect(stats.departmentsSynced).toBe(2)
    expect(stats.departmentsCreatedCount).toBe(0)
    expect(stats.departmentsUpdatedCount).toBe(2)
    expect(stats.departmentsDeactivatedCount).toBe(1)
    // E3 went inactive in run 2; a TRANSITION count must not report it again.
    expect(stats.accountsDeactivatedCount).toBe(0)
  })

  it('run 4: steady state — deactivation counts are transitions, not a re-stamp of the backlog', async () => {
    pullScenario = 'd2Departed'
    const result = await syncDirectoryIntegration(integrationId, 'system:dsrs-test')
    const stats = result.run.stats as Record<string, unknown>

    // D2 and E3 are long gone; without the `AND is_active = true` predicate both
    // deactivation sweeps would report them on every run forever.
    expect(stats.departmentsDeactivatedCount).toBe(0)
    expect(stats.accountsDeactivatedCount).toBe(0)
    expect(stats.accountsCreatedCount).toBe(0)
    expect(stats.accountsUpdatedCount).toBe(2)

    // Coverage snapshot is stable across runs when nothing about managers changed.
    expect(stats.managerCount).toBe(2)
    expect(stats.linkedManagerCount).toBe(1)
    expect(stats.managerCoverage).toBe(0.5)
  })
})


/**
 * roadmap §7.1 — offboarding blind spot. Self-contained describe block, appended at the end
 * of the file on purpose (see the lane brief this was written under): this file is also
 * being extended by another unlanded PR touching the deprovision-selection area, and a
 * trailing, independent describe block keeps that a trivial 3-way merge.
 *
 * "Linked" mirrors the `inactive_linked` review-item filter in directory-sync.ts exactly:
 * `directory_account_links.local_user_id IS NOT NULL`, independent of `link_status`. Anchor
 * for "how long inactive": `directory_accounts.updated_at`, set directly by these fixtures
 * (see the module doc-comment on `getDirectoryInactiveLinkedMetric` for why that column is
 * the correct anchor given the current schema).
 */
describeIfDatabase('§7.1 directory inactive-linked backlog metric (real DB)', () => {
  const TS2 = Date.now()
  const THRESHOLD_DAYS = 10
  let integrationId = ''
  let otherIntegrationIdRef = ''
  const userIds: string[] = []

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString()

  beforeAll(async () => {
    integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`dil-int-${TS2}`, `dil-corp-${TS2}`],
    )).rows[0].id

    // A second, wholly separate integration — proves the metric is scoped per-integration
    // and does not leak another tenant's backlog into this one's count.
    const otherIntegrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`dil-other-int-${TS2}`, `dil-other-corp-${TS2}`],
    )).rows[0].id

    const insertUser = async (id: string, isActive: boolean) => {
      await query(
        `INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', $3)`,
        [id, `${id}@example.test`, isActive],
      )
      userIds.push(id)
    }
    const insertAccount = async (opts: {
      externalUserId: string
      isActive: boolean
      updatedAt: string
      integration?: string
    }) => {
      const result = await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active, raw, updated_at)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6) RETURNING id`,
        [opts.integration ?? integrationId, opts.externalUserId, `key-${opts.externalUserId}`, opts.externalUserId, opts.isActive, opts.updatedAt],
      )
      return result.rows[0].id
    }
    const link = async (accountId: string, userId: string) => {
      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
         VALUES ($1, $2, 'linked', 'manual')`,
        [accountId, userId],
      )
    }

    const uOldActive = `dil-u-old-active-${TS2}`
    const uBoundaryActive = `dil-u-boundary-active-${TS2}`
    const uRecentActive5 = `dil-u-recent5-${TS2}`
    const uRecentActive1 = `dil-u-recent1-${TS2}`
    const uLocalInactive = `dil-u-local-inactive-${TS2}`
    const uStillActiveAccount = `dil-u-still-active-account-${TS2}`
    const uOtherTenant = `dil-u-other-tenant-${TS2}`
    await Promise.all([
      insertUser(uOldActive, true),
      insertUser(uBoundaryActive, true),
      insertUser(uRecentActive5, true),
      insertUser(uRecentActive1, true),
      insertUser(uLocalInactive, false),
      insertUser(uStillActiveAccount, true),
      insertUser(uOtherTenant, true),
    ])

    // 1. QUALIFIES — 20 days inactive (past threshold), linked, local user still active.
    const accOld = await insertAccount({ externalUserId: `dil-old-${TS2}`, isActive: false, updatedAt: daysAgo(20) })
    await link(accOld, uOldActive)

    // 2. QUALIFIES — exactly AT the 10-day threshold (the predicate is `<=`, inclusive).
    const accBoundary = await insertAccount({ externalUserId: `dil-boundary-${TS2}`, isActive: false, updatedAt: daysAgo(THRESHOLD_DAYS) })
    await link(accBoundary, uBoundaryActive)

    // 3. EXCLUDED — only 5 days inactive, short of the 10-day threshold (crosses the
    //    boundary the OTHER way from fixture 1/2).
    const accRecent5 = await insertAccount({ externalUserId: `dil-recent5-${TS2}`, isActive: false, updatedAt: daysAgo(5) })
    await link(accRecent5, uRecentActive5)

    // 4. EXCLUDED — 1 day inactive, well short of the threshold.
    const accRecent1 = await insertAccount({ externalUserId: `dil-recent1-${TS2}`, isActive: false, updatedAt: daysAgo(1) })
    await link(accRecent1, uRecentActive1)

    // 5. EXCLUDED — unlinked. 20 days inactive but no directory_account_links row at all;
    //    this is the review-queue's OWN definition of "not linked" — must not leak in.
    await insertAccount({ externalUserId: `dil-unlinked-${TS2}`, isActive: false, updatedAt: daysAgo(20) })

    // 6. EXCLUDED — linked, 20 days inactive, but the LOCAL USER is already inactive. This
    //    account is not part of the offboarding blind spot: there is nothing left to revoke.
    const accLocalInactive = await insertAccount({ externalUserId: `dil-local-inactive-${TS2}`, isActive: false, updatedAt: daysAgo(20) })
    await link(accLocalInactive, uLocalInactive)

    // 7. EXCLUDED — linked, local user active, but the directory ACCOUNT itself is still
    //    active (never went inactive) — sanity check on `a.is_active = FALSE`.
    const accStillActive = await insertAccount({ externalUserId: `dil-still-active-${TS2}`, isActive: true, updatedAt: daysAgo(20) })
    await link(accStillActive, uStillActiveAccount)

    // 8. EXCLUDED — same shape as fixture 1, but under a DIFFERENT integration. Kept alive
    //    through the assertions below (cleaned up in afterAll) — proves the metric is
    //    scoped by integration_id rather than trivially absent.
    const accOtherTenant = await insertAccount({ externalUserId: `dil-other-tenant-${TS2}`, isActive: false, updatedAt: daysAgo(20), integration: otherIntegrationId })
    await link(accOtherTenant, uOtherTenant)

    otherIntegrationIdRef = otherIntegrationId
  })

  afterAll(async () => {
    if (integrationId) {
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
    }
    if (otherIntegrationIdRef) {
      await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [otherIntegrationIdRef])
      await query(`DELETE FROM directory_integrations WHERE id = $1`, [otherIntegrationIdRef])
    }
    if (userIds.length) {
      await query(`DELETE FROM users WHERE id = ANY($1)`, [userIds])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('counts only linked, still-locally-active accounts inactive at least the threshold, crossing the boundary both ways (real SQL)', async () => {
    const metric = await getDirectoryInactiveLinkedMetric(integrationId, THRESHOLD_DAYS)
    expect(metric.thresholdDays).toBe(THRESHOLD_DAYS)
    expect(metric.count).toBe(2)

    const externalIds = metric.sample.map((s) => s.externalUserId)
    expect(externalIds).toContain(`dil-old-${TS2}`)
    expect(externalIds).toContain(`dil-boundary-${TS2}`)
    expect(externalIds).not.toContain(`dil-recent5-${TS2}`)
    expect(externalIds).not.toContain(`dil-recent1-${TS2}`)
    expect(externalIds).not.toContain(`dil-unlinked-${TS2}`)
    expect(externalIds).not.toContain(`dil-local-inactive-${TS2}`)
    expect(externalIds).not.toContain(`dil-still-active-${TS2}`)
    expect(externalIds).not.toContain(`dil-other-tenant-${TS2}`)

    // ORDER BY updated_at ASC — the most-overdue account (20 days) sorts before the
    // boundary account (10 days).
    expect(metric.sample[0].externalUserId).toBe(`dil-old-${TS2}`)
    expect(metric.sample[0].inactiveDays).toBeGreaterThanOrEqual(20)
    expect(metric.sample[1].externalUserId).toBe(`dil-boundary-${TS2}`)
  })

  it('returns zero for a threshold high enough that nothing qualifies', async () => {
    const metric = await getDirectoryInactiveLinkedMetric(integrationId, 3650)
    expect(metric).toMatchObject({ count: 0, sample: [] })
  })
})
