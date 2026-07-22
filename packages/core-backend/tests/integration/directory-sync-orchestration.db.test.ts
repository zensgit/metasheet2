import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// R1-L4 — the syncDirectoryIntegration ORCHESTRATION HARNESS.
//
// dingtalk-sync-hardening-design-and-verification-20260708.md §5.2 names the repo-wide
// systemic gap this file closes: no test drove the sync orchestration end-to-end, so a
// regression at a CALL SITE (DT-HARDEN-02 admission wiring, DT-OPS-01 deprovision executor
// wiring, DT-HARDEN-05 heartbeat lifecycle / reclaim composition) turned no test red even
// though each helper was individually proven. This suite follows the R5 fixture pattern in
// directory-sync-alert-coverage.db.test.ts (#4054): the DingTalk HTTP client is mocked so
// the REAL `syncDirectoryIntegration` pulls a synthetic directory and applies it against
// real Postgres — nothing between the test and the orchestration except the network client.
//
// Heartbeat timing: DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS is a module-load constant with a
// hard 5000ms floor (sub-5s values fall back to 60s by design), so it is pinned to the
// minimum via vi.hoisted BEFORE the module import — no production seam was added for this.
// The lease-stale floor stays max(10min, 5x beats) = 10min, so live runs here (beating
// every 5s) are never reclaimed while seeded 2h-old zombies always are.
const hoistedEnv = vi.hoisted(() => {
  process.env.DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS = '5000'
  return { heartbeatMs: 5000 }
})

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
  createDirectoryIntegration,
  DirectorySyncInProgressError,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'
import {
  resetDirectorySyncSchedulerForTests,
  startDirectorySyncScheduler,
  stopDirectorySyncScheduler,
} from '../../src/directory/directory-sync-scheduler'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const HEARTBEAT_MS = hoistedEnv.heartbeatMs

// ---------------------------------------------------------------------------
// Mocked DingTalk tenant. One mutable directory shape; each block assigns its
// own shape immediately before triggering a sync (files in the real-DB CI lane
// run serially, and describe blocks run in order within this file).
// ---------------------------------------------------------------------------

type MockUser = {
  userId: string
  name: string
  departmentIds: string[]
  unionId?: string
  openId?: string
  email?: string
}

type MockDirectory = {
  /** Children by parent id; the sync always starts its walk at root '1'. */
  departments: Array<{ id: string; parentId: string; name: string; order: number }>
  usersByDept: Record<string, MockUser[]>
}

let activeDirectory: MockDirectory = { departments: [], usersByDept: {} }

/**
 * Gate on the mocked pull, so a test can hold a REAL sync open mid-pull (heartbeat
 * observation, concurrent-trigger 409) without sleeping inside product code.
 */
let pullGate: { promise: Promise<void>; release: () => void } | null = null

function armPullGate(): void {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  pullGate = { promise, release }
}

function releasePullGate(): void {
  pullGate?.release()
  pullGate = null
}

function findMockUser(userId: string): MockUser {
  for (const users of Object.values(activeDirectory.usersByDept)) {
    const hit = users.find((user) => user.userId === userId)
    if (hit) return hit
  }
  throw new Error(`unexpected userId ${userId}`)
}

beforeAll(() => {
  clientMocks.fetchDingTalkAppAccessToken.mockResolvedValue('dso-token')
  clientMocks.listDingTalkDepartments.mockImplementation(async (_token: string, parentId: string) => {
    if (pullGate) await pullGate.promise
    return activeDirectory.departments
      .filter((department) => department.parentId === parentId)
      .map((department) => ({ ...department, source: {} }))
  })
  clientMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  clientMocks.listDingTalkDepartmentUsers.mockImplementation(async (_token: string, deptId: string) => ({
    users: (activeDirectory.usersByDept[deptId] ?? []).map((user) => ({
      userId: user.userId,
      name: user.name,
      departmentIds: user.departmentIds,
      source: {},
    })),
    nextCursor: null,
    hasMore: false,
  }))
  clientMocks.getDingTalkUserDetail.mockImplementation(async (_token: string, userId: string) => {
    const user = findMockUser(userId)
    return {
      userId: user.userId,
      name: user.name,
      unionId: user.unionId,
      openId: user.openId,
      email: user.email,
      mobile: undefined,
      departmentIds: user.departmentIds,
      source: {},
    }
  })
})

// ---------------------------------------------------------------------------
// Shared fixture helpers (shapes copied from the lease + alert-coverage suites).
// ---------------------------------------------------------------------------

async function seedZombieRun(integrationId: string, ageMinutes: number): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO directory_sync_runs (integration_id, status, started_at, last_heartbeat_at, triggered_by, trigger_source)
     VALUES ($1, 'running', NOW() - ($2::int * INTERVAL '1 minute'), NOW() - ($2::int * INTERVAL '1 minute'), 'dso-zombie', 'manual')
     RETURNING id`,
    [integrationId, ageMinutes],
  )
  return result.rows[0].id
}

async function readRun(runId: string): Promise<{ status: string; error_message: string | null; finished_at: string | null; last_heartbeat_at: string | null }> {
  const result = await query<{ status: string; error_message: string | null; finished_at: string | null; last_heartbeat_at: string | null }>(
    `SELECT status, error_message, finished_at, last_heartbeat_at FROM directory_sync_runs WHERE id = $1`,
    [runId],
  )
  return result.rows[0]
}

async function cleanupIntegration(integrationId: string): Promise<void> {
  await query(`DELETE FROM directory_sync_alerts WHERE integration_id = $1`, [integrationId])
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
}

async function deleteUsersByEmail(emails: string[]): Promise<void> {
  if (emails.length === 0) return
  const ids = await query<{ id: string }>(`SELECT id FROM users WHERE email = ANY($1)`, [emails])
  const userIds = ids.rows.map((row) => row.id)
  if (userIds.length === 0) return
  await query(`DELETE FROM user_invites WHERE user_id = ANY($1)`, [userIds])
  await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = ANY($1)`, [userIds])
  await query(`DELETE FROM user_external_identities WHERE local_user_id = ANY($1)`, [userIds])
  await query(`DELETE FROM users WHERE id = ANY($1)`, [userIds])
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, everyMs = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await read()
  while (!done(value) && Date.now() < deadline) {
    await sleep(everyMs)
    value = await read()
  }
  return value
}

describeIfDatabase('syncDirectoryIntegration orchestration harness (real DB)', () => {
  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // -------------------------------------------------------------------------
  // 1. HEARTBEAT LIFECYCLE + concurrent-trigger 409 (DT-HARDEN-05 composition)
  //
  // The lease golden (directory-sync-run-lease.db.test.ts) proves the partial
  // unique index and the staleness predicate at SQL level; what was never proven
  // is the LIFECYCLE the orchestration composes around them: the interval beats
  // while the run holds the lease, a concurrent trigger during the pull gets a
  // typed 409 carrying the live runId, and — the previously-unproven claim —
  // the interval is actually CLEARED on completion (the beat's own
  // `status='running'` predicate would mask a leaked interval from any
  // "stats stopped changing" observation, so the probe below flips the row
  // back to running with a NULL beat and watches whether a zombie beat lands).
  // -------------------------------------------------------------------------
  describe('heartbeat lifecycle + in-progress rejection', () => {
    const DEPT = `dso-hb-dept-${TS}`
    let integrationId = ''
    let runId = ''
    let syncPromise: Promise<unknown> | null = null

    beforeAll(async () => {
      const integration = await createDirectoryIntegration({
        name: `dso-hb-${TS}`,
        corpId: `dso-hb-corp-${TS}`,
        appKey: `dso-hb-appkey-${TS}`,
        appSecret: 'dso-secret',
        admissionMode: 'manual_only',
      })
      integrationId = integration.id
    })

    afterAll(async () => {
      // Defensive: if an assertion failed mid-block, unblock the held sync so the
      // suite does not hang, and swallow its settled state (asserted in-line above).
      releasePullGate()
      if (syncPromise) await syncPromise.catch(() => null)
      await cleanupIntegration(integrationId)
    })

    it('beats last_heartbeat_at at least once while the run holds the lease mid-pull', async () => {
      activeDirectory = {
        departments: [{ id: DEPT, parentId: '1', name: 'HB Ops', order: 0 }],
        usersByDept: {
          [DEPT]: [{ userId: `dso-hb-u1-${TS}`, name: 'HB One', departmentIds: [DEPT], unionId: `dso-hb-un1-${TS}` }],
        },
      }

      armPullGate()
      let started!: (id: string) => void
      const runStarted = new Promise<string>((resolve) => {
        started = resolve
      })
      syncPromise = syncDirectoryIntegration(integrationId, 'system:dso-hb', 'manual', {
        onRunStarted: (id) => started(id),
      })
      // Attach a no-op catch immediately: if an assertion below throws while the sync
      // is still pending, the eventual settle must not become an unhandled rejection.
      syncPromise.catch(() => null)

      runId = await runStarted
      expect(runId).toBeTruthy()

      // The run row exists, the pull is gated. First beat lands at ~HEARTBEAT_MS.
      const beat = await pollUntil(
        () => readRun(runId),
        (run) => run.last_heartbeat_at !== null,
        HEARTBEAT_MS * 3,
      )
      expect(beat.status).toBe('running')
      expect(beat.last_heartbeat_at).not.toBeNull()
    }, 25_000)

    it('rejects a second concurrent trigger during the pull with DirectorySyncInProgressError carrying the active runId', async () => {
      // The pull gate is still armed — the first run is alive and mid-pull.
      const error = await syncDirectoryIntegration(integrationId, 'system:dso-hb-second').then(
        () => null,
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(DirectorySyncInProgressError)
      const typed = error as DirectorySyncInProgressError
      expect(typed.code).toBe('DIRECTORY_SYNC_IN_PROGRESS')
      expect(typed.statusCode).toBe(409)
      expect(typed.activeRunId).toBe(runId)

      // And the loser must not have failed the live run's row or claimed its own.
      const runs = await query<{ id: string; status: string }>(
        `SELECT id, status FROM directory_sync_runs WHERE integration_id = $1 ORDER BY started_at`,
        [integrationId],
      )
      expect(runs.rows).toHaveLength(1)
      expect(runs.rows[0]).toEqual({ id: runId, status: 'running' })
    })

    it('completes after the pull resumes, and the heartbeat interval is genuinely cleared (no zombie beats)', async () => {
      releasePullGate()
      await syncPromise
      syncPromise = null

      const completed = await readRun(runId)
      expect(completed.status).toBe('completed')
      expect(completed.finished_at).not.toBeNull()

      // Leaked-interval probe. A beat is `UPDATE ... WHERE id=$1 AND status='running'`,
      // so simply watching the completed row proves nothing — the status predicate
      // would absorb a leaked interval forever. Flip the row back to 'running' with a
      // NULL beat: if `clearInterval(heartbeat)` in the sync's finally were removed,
      // the still-armed 5s interval (keyed on this runId) would stamp
      // last_heartbeat_at within one period. Silence across 1.5 periods = cleared.
      await query(
        `UPDATE directory_sync_runs SET status = 'running', last_heartbeat_at = NULL WHERE id = $1`,
        [runId],
      )
      try {
        await sleep(HEARTBEAT_MS * 1.5)
        const probe = await readRun(runId)
        expect(probe.last_heartbeat_at).toBeNull()
      } finally {
        await query(`UPDATE directory_sync_runs SET status = 'completed' WHERE id = $1`, [runId])
      }
    }, 25_000)
  })

  // -------------------------------------------------------------------------
  // 2. ADMISSION WIRING (DT-HARDEN-02 call site)
  //
  // directory-sync-admission-orphan-guard.db.test.ts proves the HELPER
  // (createDirectoryAdmittedUserInTransaction) via the exported test seam. §5.2's
  // point is that the CALL SITE inside the sync loop had no coverage: hardcoding
  // `enableDingTalkGrant: true` back (the original H02 bug) or dropping the
  // SAVEPOINT would turn nothing red. Here one real sync run carries three
  // accounts through the real loop:
  //   GOOD     openId+unionId  -> created, linked, grant granted
  //   NOGRANT  unionId only    -> created, linked, grant computed OFF (call-site
  //                               resolveDirectoryAutoAdmissionCanGrantDingTalkLogin;
  //                               with the old hardcoded true this account's
  //                               admission THROWS instead)
  //   POISON   no identity key -> bind throws AFTER the users INSERT; the
  //                               per-account SAVEPOINT must roll the user back
  //                               (no orphan) and the run must still complete.
  // -------------------------------------------------------------------------
  describe('auto-admission wiring inside the sync run (H02 call site)', () => {
    const CORP = `dso-adm-corp-${TS}`
    const DEPT = `dso-adm-dept-${TS}`
    const EXT_GOOD = `dso-adm-good-${TS}`
    const EXT_NOGRANT = `dso-adm-nogrant-${TS}`
    const EXT_POISON = `dso-adm-poison-${TS}`
    const EMAIL_GOOD = `dso-adm-good-${TS}@example.test`
    const EMAIL_NOGRANT = `dso-adm-nogrant-${TS}@example.test`
    const EMAIL_POISON = `dso-adm-poison-${TS}@example.test`
    let integrationId = ''
    let runStats: Record<string, unknown> = {}
    let runStatus = ''

    beforeAll(async () => {
      const integration = await createDirectoryIntegration({
        name: `dso-adm-${TS}`,
        corpId: CORP,
        appKey: `dso-adm-appkey-${TS}`,
        appSecret: 'dso-secret',
        admissionMode: 'auto_for_scoped_departments',
        admissionDepartmentIds: [DEPT],
      })
      integrationId = integration.id

      activeDirectory = {
        departments: [{ id: DEPT, parentId: '1', name: 'Admit Ops', order: 0 }],
        usersByDept: {
          [DEPT]: [
            { userId: EXT_GOOD, name: 'Good One', departmentIds: [DEPT], unionId: `dso-un-good-${TS}`, openId: `dso-op-good-${TS}`, email: EMAIL_GOOD },
            { userId: EXT_NOGRANT, name: 'NoGrant Two', departmentIds: [DEPT], unionId: `dso-un-nogrant-${TS}`, email: EMAIL_NOGRANT },
            { userId: EXT_POISON, name: 'Poison Three', departmentIds: [DEPT], email: EMAIL_POISON },
          ],
        },
      }

      const result = await syncDirectoryIntegration(integrationId, 'system:dso-adm')
      runStats = result.run.stats as Record<string, unknown>
      runStatus = result.run.status
    })

    afterAll(async () => {
      await cleanupIntegration(integrationId)
      await deleteUsersByEmail([EMAIL_GOOD, EMAIL_NOGRANT, EMAIL_POISON])
    })

    it('admits the eligible account end-to-end in the SAME run: user created, linked auto_admit, identity bound, grant enabled', async () => {
      const user = await query<{ id: string; is_active: boolean; must_change_password: boolean }>(
        `SELECT id, is_active, must_change_password FROM users WHERE email = $1`,
        [EMAIL_GOOD],
      )
      expect(user.rows).toHaveLength(1)
      expect(user.rows[0].is_active).toBe(true)
      expect(user.rows[0].must_change_password).toBe(true)

      const link = await query<{ link_status: string; match_strategy: string; local_user_id: string }>(
        `SELECT l.link_status, l.match_strategy, l.local_user_id
           FROM directory_account_links l
           JOIN directory_accounts a ON a.id = l.directory_account_id
          WHERE a.integration_id = $1 AND a.external_user_id = $2`,
        [integrationId, EXT_GOOD],
      )
      expect(link.rows).toHaveLength(1)
      expect(link.rows[0].link_status).toBe('linked')
      expect(link.rows[0].match_strategy).toBe('auto_admit')
      expect(link.rows[0].local_user_id).toBe(user.rows[0].id)

      // The bind really happened inside the run: identity keyed corp:openId, grant ON.
      const identity = await query<{ external_key: string }>(
        `SELECT external_key FROM user_external_identities WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [user.rows[0].id],
      )
      expect(identity.rows).toHaveLength(1)
      expect(identity.rows[0].external_key).toBe(`${CORP}:dso-op-good-${TS}`)

      const grant = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [user.rows[0].id],
      )
      expect(grant.rows).toHaveLength(1)
      expect(grant.rows[0].enabled).toBe(true)
    })

    it('admits a corp account without openId with the grant computed OFF (the H02 call-site line, not the helper)', async () => {
      const user = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [EMAIL_NOGRANT])
      expect(user.rows).toHaveLength(1)

      const link = await query<{ link_status: string; match_strategy: string }>(
        `SELECT l.link_status, l.match_strategy
           FROM directory_account_links l
           JOIN directory_accounts a ON a.id = l.directory_account_id
          WHERE a.integration_id = $1 AND a.external_user_id = $2`,
        [integrationId, EXT_NOGRANT],
      )
      expect(link.rows).toHaveLength(1)
      expect(link.rows[0].link_status).toBe('linked')
      expect(link.rows[0].match_strategy).toBe('auto_admit')

      // Identity falls back to unionId; NO grant row is written when the grant is off.
      const identity = await query<{ external_key: string }>(
        `SELECT external_key FROM user_external_identities WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [user.rows[0].id],
      )
      expect(identity.rows).toHaveLength(1)
      expect(identity.rows[0].external_key).toBe(`dso-un-nogrant-${TS}`)

      const grant = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [user.rows[0].id],
      )
      expect(grant.rows).toHaveLength(0)
    })

    it('rolls a poisoned account back per-account (SAVEPOINT): no orphan users row, account unmatched, run still completed', async () => {
      // The bind threw AFTER the users INSERT (no openId/unionId -> no identity key);
      // the SAVEPOINT must have rolled that INSERT back before the loop swallowed it.
      const orphan = await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [EMAIL_POISON])
      expect(orphan.rows).toHaveLength(0)

      const link = await query<{ link_status: string; local_user_id: string | null }>(
        `SELECT l.link_status, l.local_user_id
           FROM directory_account_links l
           JOIN directory_accounts a ON a.id = l.directory_account_id
          WHERE a.integration_id = $1 AND a.external_user_id = $2`,
        [integrationId, EXT_POISON],
      )
      expect(link.rows).toHaveLength(1)
      expect(link.rows[0].link_status).toBe('unmatched')
      expect(link.rows[0].local_user_id).toBeNull()

      // One poisoned account must not fail the whole run.
      expect(runStatus).toBe('completed')
    })

    it('reports the split honestly in the run stats', () => {
      expect(runStats.autoAdmissionCandidateCount).toBe(3)
      expect(runStats.autoAdmittedCount).toBe(2)
      expect(runStats.autoAdmissionFailedCount).toBe(1)
      expect(runStats.autoAdmittedWithoutGrantCount).toBe(1)
      expect(runStats.linkedCount).toBe(2)
      expect(runStats.unmatchedCount).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // 3. DEPROVISION EXECUTOR WIRING (DT-OPS-01 call site)
  //
  // directory-deprovision-selection.db.test.ts proves the executor's selection
  // and write shapes by calling it directly; its wiring INTO the sync (fed the
  // per-run TRANSITION ids from the deactivation sweep, gated on the env flag,
  // policy read off the integration row) is what §5.2 says is uncovered. Both
  // arms run the REAL sync over a departure.
  // -------------------------------------------------------------------------
  describe('deprovision executor wiring inside the sync run (OPS-01 call site)', () => {
    async function seedDepartureFixture(tag: string): Promise<{ integrationId: string; localUserId: string; accountId: string; deptId: string; survivorExt: string }> {
      const integration = await createDirectoryIntegration({
        name: `dso-dep-${tag}-${TS}`,
        corpId: `dso-dep-corp-${tag}-${TS}`,
        appKey: `dso-dep-appkey-${tag}-${TS}`,
        appSecret: 'dso-secret',
        admissionMode: 'manual_only',
        defaultDeprovisionPolicy: 'mark_inactive',
      })

      const localUserId = `dso-dep-user-${tag}-${TS}`
      await query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE)`, [
        localUserId,
        `${localUserId}@example.test`,
      ])

      // Pre-linked directory account that will be ABSENT from the pull below —
      // last_seen_at predates the sync timestamp, so the sweep transitions it
      // to inactive and hands its id to the executor within the same run.
      const account = await query<{ id: string }>(
        `INSERT INTO directory_accounts (
           integration_id, corp_id, external_user_id, union_id, external_key, name, is_active, last_seen_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $4, 'Departed', true, NOW(), NOW(), NOW())
         RETURNING id`,
        [integration.id, `dso-dep-corp-${tag}-${TS}`, `dso-dep-ext-${tag}-${TS}`, `dso-dep-un-${tag}-${TS}`],
      )
      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
         VALUES ($1, $2, 'linked', 'manual', NOW(), NOW())`,
        [account.rows[0].id, localUserId],
      )

      return {
        integrationId: integration.id,
        localUserId,
        accountId: account.rows[0].id,
        deptId: `dso-dep-dept-${tag}-${TS}`,
        survivorExt: `dso-dep-surv-${tag}-${TS}`,
      }
    }

    function departureDirectory(fixture: { deptId: string; survivorExt: string }): MockDirectory {
      // The departed account is NOT in the pull; the survivor keeps
      // syncedAccountCount > 0 so the empty-fetch circuit breaker stays quiet.
      return {
        departments: [{ id: fixture.deptId, parentId: '1', name: 'Dep Ops', order: 0 }],
        usersByDept: {
          [fixture.deptId]: [
            { userId: fixture.survivorExt, name: 'Survivor', departmentIds: [fixture.deptId], unionId: `${fixture.survivorExt}-un` },
          ],
        },
      }
    }

    const cleanupTargets: Array<{ integrationId: string; localUserId: string; siblingIntegrationId?: string }> = []

    afterAll(async () => {
      for (const target of cleanupTargets) {
        await cleanupIntegration(target.integrationId)
        if (target.siblingIntegrationId) await cleanupIntegration(target.siblingIntegrationId)
        await query(`DELETE FROM user_orgs WHERE user_id = $1`, [target.localUserId])
        await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = $1`, [target.localUserId])
        await query(`DELETE FROM users WHERE id = $1`, [target.localUserId])
      }
    })

    it('with the policy enabled, a departure triggers the executor inside the run: grant revoked + user deactivated per policy', async () => {
      const fixture = await seedDepartureFixture('on')
      cleanupTargets.push(fixture)
      activeDirectory = departureDirectory(fixture)

      process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
      let stats: Record<string, unknown>
      try {
        const result = await syncDirectoryIntegration(fixture.integrationId, 'system:dso-dep-on')
        stats = result.run.stats as Record<string, unknown>
      } finally {
        delete process.env.DIRECTORY_DEPROVISION_ENABLED
      }

      // The sweep transitioned the departed account in this run...
      const account = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_accounts WHERE id = $1`, [fixture.accountId])
      expect(account.rows[0].is_active).toBe(false)

      // ...and the executor acted on it INSIDE the same run: mark_inactive policy.
      const user = await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [fixture.localUserId])
      expect(user.rows[0].is_active).toBe(false)

      const grant = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [fixture.localUserId],
      )
      expect(grant.rows).toHaveLength(1)
      expect(grant.rows[0].enabled).toBe(false)

      expect(stats.deprovisionApplied).toBe(true)
      expect(stats.deprovisionCandidateCount).toBe(1)
      // W4-PRE-1d (owner P2 item 2, review-findings P1/P2): this fixture is a single-org
      // departure with no sibling binding anywhere, so the org-membership candidate is ALSO
      // globally clear — both counts read 1 for this scenario. The dual-org test below
      // ("with a real, still-active binding in ANOTHER org...") is the one that actually
      // exercises `globalCandidateCount` diverging from `candidateCount`.
      expect(stats.deprovisionGlobalCandidateCount).toBe(1)
      expect(stats.deprovisionGrantsDisabledCount).toBe(1)
      expect(stats.deprovisionUsersDeactivatedCount).toBe(1)
      expect(stats.deprovisionAbortedReason).toBeNull()
      expect(stats.deprovisionAffected).toEqual([
        { directoryAccountId: fixture.accountId, localUserId: fixture.localUserId, policy: 'mark_inactive', globallyClear: true },
      ])

      // Sweep-layer audit trail (owner P2 item 2, review finding: `meta.grantDisabled` /
      // `meta.userDeactivated` were previously hardcoded `true` / `policy === 'mark_inactive'`
      // and NO test — at the real `syncDirectoryIntegration` sweep layer, as opposed to a
      // direct `applyDirectoryDeprovisionPolicies` call — asserted on them; a revert to the
      // hardcoded form would have stayed green here). This is the globally-clear=true branch;
      // the dual-org test below covers the false branch.
      const audit = await query<{ action_details: Record<string, unknown> }>(
        `SELECT action_details FROM audit_logs
          WHERE resource_type = 'directory-account-link' AND resource_id = $1
          ORDER BY id DESC LIMIT 1`,
        [fixture.accountId],
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0].action_details).toMatchObject({
        policy: 'mark_inactive',
        grantDisabled: true,
        userDeactivated: true,
        globallyClear: true,
        membershipDeactivationAttempted: true,
      })
    })

    it('with the flag unset (shipped default), the same departure writes NOTHING — counts are preview-only', async () => {
      const fixture = await seedDepartureFixture('off')
      cleanupTargets.push(fixture)
      activeDirectory = departureDirectory(fixture)
      expect(process.env.DIRECTORY_DEPROVISION_ENABLED).toBeUndefined()

      const result = await syncDirectoryIntegration(fixture.integrationId, 'system:dso-dep-off')
      const stats = result.run.stats as Record<string, unknown>

      // Default-off pin: the person keeps access; no grant row appears.
      const user = await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [fixture.localUserId])
      expect(user.rows[0].is_active).toBe(true)

      const grant = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [fixture.localUserId],
      )
      expect(grant.rows).toHaveLength(0)

      // But the run REPORTS what it would have done (the operator preview).
      expect(stats.deprovisionApplied).toBe(false)
      expect(stats.deprovisionCandidateCount).toBe(1)
      expect(stats.deprovisionGlobalCandidateCount).toBe(1)
      expect(stats.deprovisionUsersDeactivatedCount).toBe(1)
    })

    // -----------------------------------------------------------------------
    // Dual-org fixture (owner P1/P2, #4530 review — issuecomment-5043752399):
    // the named scenario is a real, still-active binding in a DIFFERENT org, not a
    // bare `user_orgs` stand-in. This is the one test in this file where
    // `globalCandidateCount` actually diverges from `candidateCount` (0 vs 1),
    // exercising the sweep-layer observability (run-stats + audit meta) that the
    // two single-org fixtures above cannot: their globally-clear=true scenario
    // cannot distinguish a correct `globallyClear`-gated write from an
    // unconditional one.
    // -----------------------------------------------------------------------
    async function seedDualOrgDepartureFixture(tag: string): Promise<{
      integrationId: string
      siblingIntegrationId: string
      siblingOrgId: string
      localUserId: string
      accountId: string
      deptId: string
      survivorExt: string
    }> {
      const integration = await createDirectoryIntegration({
        name: `dso-dep-${tag}-${TS}`,
        corpId: `dso-dep-corp-${tag}-${TS}`,
        appKey: `dso-dep-appkey-${tag}-${TS}`,
        appSecret: 'dso-secret',
        admissionMode: 'manual_only',
        defaultDeprovisionPolicy: 'mark_inactive',
      })

      // A second, real integration with its OWN distinct, explicit org_id (never the shared
      // 'default' sentinel the fixture above uses — two integrations without an explicit
      // org_id would collapse onto the same org and silently defeat this fixture).
      const siblingOrgId = `dso-dep-orgB-${tag}-${TS}`
      const siblingIntegration = await query<{ id: string }>(
        `INSERT INTO directory_integrations (name, corp_id, org_id) VALUES ($1, $2, $3) RETURNING id::text AS id`,
        [`dso-dep-sib-${tag}-${TS}`, `dso-dep-sib-corp-${tag}-${TS}`, siblingOrgId],
      )

      const localUserId = `dso-dep-dual-user-${tag}-${TS}`
      await query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE)`, [
        localUserId,
        `${localUserId}@example.test`,
      ])
      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [localUserId],
      )

      // THIS org's account: pre-linked, absent from the pull below — the sweep transitions it
      // to inactive and hands its id to the executor within the same run (same shape as the
      // single-org fixture above).
      const account = await query<{ id: string }>(
        `INSERT INTO directory_accounts (
           integration_id, corp_id, external_user_id, union_id, external_key, name, is_active, last_seen_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $4, 'Departed', true, NOW(), NOW(), NOW())
         RETURNING id`,
        [integration.id, `dso-dep-corp-${tag}-${TS}`, `dso-dep-dual-ext-${tag}-${TS}`, `dso-dep-dual-un-${tag}-${TS}`],
      )
      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
         VALUES ($1, $2, 'linked', 'manual', NOW(), NOW())`,
        [account.rows[0].id, localUserId],
      )

      // The REAL sibling binding in the OTHER org — active and linked throughout. Owner P1,
      // verbatim: "全局 sibling guard...把「A 离职但仍在 B 任职」的用户整体排除出候选集"; owner
      // P2 item 4 requires this be a real integration + real binding, never a bare `user_orgs`
      // row standing in for one.
      const siblingAccount = await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, is_active)
         VALUES ($1, $2, $3, 'Sibling', TRUE) RETURNING id`,
        [siblingIntegration.rows[0].id, `dso-dep-dual-sib-ext-${tag}-${TS}`, `dingtalk:dso-dep-dual-sib-${tag}-${TS}`],
      )
      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
         VALUES ($1, $2, 'linked')`,
        [siblingAccount.rows[0].id, localUserId],
      )
      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [localUserId, siblingOrgId],
      )

      // Pre-existing enabled grant — must survive UNTOUCHED (globallyClear is false here).
      await query(
        `INSERT INTO user_external_auth_grants (provider, local_user_id, enabled, granted_by, created_at, updated_at)
         VALUES ('dingtalk', $1, TRUE, 'system:test-fixture', NOW(), NOW())`,
        [localUserId],
      )

      return {
        integrationId: integration.id,
        siblingIntegrationId: siblingIntegration.rows[0].id,
        siblingOrgId,
        localUserId,
        accountId: account.rows[0].id,
        deptId: `dso-dep-dual-dept-${tag}-${TS}`,
        survivorExt: `dso-dep-dual-surv-${tag}-${TS}`,
      }
    }

    it('with a real, still-active binding in ANOTHER org, mark_inactive deactivates only THIS org membership: grant + platform user survive, and the sweep-layer observability tells the truth (owner P2 items 1/2/4)', async () => {
      const fixture = await seedDualOrgDepartureFixture('dual')
      cleanupTargets.push(fixture)
      activeDirectory = departureDirectory(fixture)

      process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
      let stats: Record<string, unknown>
      try {
        const result = await syncDirectoryIntegration(fixture.integrationId, 'system:dso-dep-dual')
        stats = result.run.stats as Record<string, unknown>
      } finally {
        delete process.env.DIRECTORY_DEPROVISION_ENABLED
      }

      // THIS org's membership WAS deactivated — item 1 is org-scoped and unconditional on
      // global clearance.
      const membershipA = await query<{ is_active: boolean }>(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = 'default'`,
        [fixture.localUserId],
      )
      expect(membershipA.rows[0].is_active).toBe(false)

      // The SIBLING org's membership is untouched — a different run, a different org.
      const membershipB = await query<{ is_active: boolean }>(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = $2`,
        [fixture.localUserId, fixture.siblingOrgId],
      )
      expect(membershipB.rows[0].is_active).toBe(true)

      // NOT globally clear: the platform user and the DingTalk grant both survive.
      const user = await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [fixture.localUserId])
      expect(user.rows[0].is_active).toBe(true)

      const grant = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [fixture.localUserId],
      )
      expect(grant.rows).toHaveLength(1)
      expect(grant.rows[0].enabled).toBe(true)

      expect(stats.deprovisionApplied).toBe(true)
      expect(stats.deprovisionCandidateCount).toBe(1)
      expect(stats.deprovisionGlobalCandidateCount).toBe(0)
      expect(stats.deprovisionGrantsDisabledCount).toBe(0)
      expect(stats.deprovisionUsersDeactivatedCount).toBe(0)
      expect(stats.deprovisionMembershipDeactivationAttemptedCount).toBe(1)
      expect(stats.deprovisionAbortedReason).toBeNull()
      expect(stats.deprovisionAffected).toEqual([
        { directoryAccountId: fixture.accountId, localUserId: fixture.localUserId, policy: 'mark_inactive', globallyClear: false },
      ])

      // Sweep-layer audit trail must tell the truth per-person (owner P2 item 2, review
      // finding: this is the globally-clear=FALSE branch of the same hardcoded-value regression
      // the test above closes for the TRUE branch — a revert to `grantDisabled: true` /
      // `userDeactivated: policy === 'mark_inactive'` unconditionally would go red here).
      const audit = await query<{ action_details: Record<string, unknown> }>(
        `SELECT action_details FROM audit_logs
          WHERE resource_type = 'directory-account-link' AND resource_id = $1
          ORDER BY id DESC LIMIT 1`,
        [fixture.accountId],
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0].action_details).toMatchObject({
        policy: 'mark_inactive',
        grantDisabled: false,
        userDeactivated: false,
        globallyClear: false,
        membershipDeactivationAttempted: true,
      })
    })
  })

  // -------------------------------------------------------------------------
  // 4. RECLAIM + COMPLETION-GUARD COMPOSITION (DT-HARDEN-05 call sites)
  //
  // The lease golden proves reclaimStaleDirectorySyncRuns' SQL. Uncovered were
  // its two call sites: the trigger path (reclaim-before-claim — without it a
  // crashed run wedges the integration forever) and the scheduler boot sweep.
  // -------------------------------------------------------------------------
  describe('stale-lease reclaim composition', () => {
    let integrationId = ''
    const DEPT = `dso-rec-dept-${TS}`

    beforeAll(async () => {
      const integration = await createDirectoryIntegration({
        name: `dso-rec-${TS}`,
        corpId: `dso-rec-corp-${TS}`,
        appKey: `dso-rec-appkey-${TS}`,
        appSecret: 'dso-secret',
        admissionMode: 'manual_only',
      })
      integrationId = integration.id
    })

    afterAll(async () => {
      await stopDirectorySyncScheduler()
      resetDirectorySyncSchedulerForTests()
      await cleanupIntegration(integrationId)
    })

    it('a trigger against a stale running row reclaims it, claims its own run, and completes; the zombie stays failed', async () => {
      const zombieId = await seedZombieRun(integrationId, 120)

      activeDirectory = {
        departments: [{ id: DEPT, parentId: '1', name: 'Rec Ops', order: 0 }],
        usersByDept: {
          [DEPT]: [{ userId: `dso-rec-u1-${TS}`, name: 'Rec One', departmentIds: [DEPT], unionId: `dso-rec-un1-${TS}` }],
        },
      }

      // Without the reclaim call inside the trigger path this claim would be a
      // unique violation (the zombie still holds the partial-index lease) and the
      // sync would throw DirectorySyncInProgressError instead of completing.
      const result = await syncDirectoryIntegration(integrationId, 'system:dso-rec')
      expect(result.run.id).not.toBe(zombieId)
      expect(result.run.status).toBe('completed')

      const zombie = await readRun(zombieId)
      expect(zombie.status).toBe('failed')
      expect(zombie.error_message).toContain('orphaned')
      expect(zombie.finished_at).not.toBeNull()

      // The completion write is keyed to the new run's own id + status guard:
      // it must not have resurrected the reclaimed row.
      const running = await query<{ id: string }>(
        `SELECT id FROM directory_sync_runs WHERE integration_id = $1 AND status = 'running'`,
        [integrationId],
      )
      expect(running.rows).toHaveLength(0)
    })

    it('the scheduler boot sweep reclaims a stale running row before any trigger arrives', async () => {
      const zombieId = await seedZombieRun(integrationId, 120)

      // NOTE: the boot sweep is deliberately UNSCOPED in production (crash recovery
      // across all integrations). In the shared CI database this is safe because the
      // real-DB lane runs files serially — no sibling suite holds a live 'running'
      // fixture while this file executes, and a >10min-stale leftover is exactly what
      // the sweep exists to close out.
      resetDirectorySyncSchedulerForTests()
      const stubScheduler = {
        schedule: async () => {},
        reschedule: async () => {},
        unschedule: async () => {},
        getJob: async () => null,
        destroy: () => {},
      }
      await startDirectorySyncScheduler({ scheduler: stubScheduler as never })
      try {
        const zombie = await readRun(zombieId)
        expect(zombie.status).toBe('failed')
        expect(zombie.error_message).toContain('orphaned')
      } finally {
        await stopDirectorySyncScheduler()
      }
    })
  })
})
