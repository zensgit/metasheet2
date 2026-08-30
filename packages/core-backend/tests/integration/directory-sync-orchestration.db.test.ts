import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

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

import { query, transaction } from '../../src/db/pg'
import { Logger } from '../../src/core/logger'
import { applyDirectoryDeprovisionCandidate } from '../../src/directory/deprovision-ledger'
import {
  createDirectoryIntegration,
  DirectorySyncInProgressError,
  DirectorySyncRunReplayError,
  getDirectorySyncRun,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'
import {
  resetDirectorySyncSchedulerForTests,
  startDirectorySyncScheduler,
  stopDirectorySyncScheduler,
} from '../../src/directory/directory-sync-scheduler'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import type { ApprovalGraph, FormSchema } from '../../src/types/approval-product'
import { grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

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
  source?: Record<string, unknown>
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
      source: user.source ?? {},
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
      source: user.source ?? {},
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
  // D4: deprovision evidence references the run via the composite FK
  // ddev_run_integration_fk (that FK holding is the schema working, not a test bug), so the
  // ledger rows go first or the runs DELETE is refused.
  await query(
    `DELETE FROM directory_deprovision_effects WHERE event_id IN
       (SELECT id FROM directory_deprovision_events WHERE integration_id = $1::uuid)`,
    [integrationId],
  )
  await query(`DELETE FROM directory_deprovision_events WHERE integration_id = $1::uuid`, [integrationId])
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

  it('claims a caller-reserved run UUID once and replays it without a second provider pull', async () => {
    const integration = await createDirectoryIntegration({
      name: `dso-reserved-${TS}`,
      corpId: `dso-reserved-corp-${TS}`,
      appKey: `dso-reserved-appkey-${TS}`,
      appSecret: 'dso-secret',
      admissionMode: 'manual_only',
    })
    const requestedRunId = randomUUID()
    activeDirectory = { departments: [], usersByDept: {} }
    const pullsBefore = clientMocks.fetchDingTalkAppAccessToken.mock.calls.length

    try {
      const first = await syncDirectoryIntegration(integration.id, 'system:dso-reserved', 'manual', {
        requestedRunId,
      })
      expect(first.run.id).toBe(requestedRunId)
      expect(first.run.status).toBe('completed')
      const pullsAfterFirst = clientMocks.fetchDingTalkAppAccessToken.mock.calls.length
      expect(pullsAfterFirst).toBeGreaterThan(pullsBefore)
      expect(await getDirectorySyncRun(integration.id, requestedRunId)).toMatchObject({
        id: requestedRunId,
        integrationId: integration.id,
        status: 'completed',
      })
      expect(await getDirectorySyncRun(randomUUID(), requestedRunId)).toBeNull()

      const replay = await syncDirectoryIntegration(integration.id, 'system:dso-reserved', 'manual', {
        requestedRunId,
      }).catch((error) => error)
      expect(replay).toBeInstanceOf(DirectorySyncRunReplayError)
      expect((replay as DirectorySyncRunReplayError).runId).toBe(requestedRunId)
      expect(clientMocks.fetchDingTalkAppAccessToken.mock.calls.length).toBe(pullsAfterFirst)

      const rows = await query<{ id: string }>(
        `SELECT id FROM directory_sync_runs WHERE id = $1 AND integration_id = $2`,
        [requestedRunId, integration.id],
      )
      expect(rows.rows).toEqual([{ id: requestedRunId }])
    } finally {
      await cleanupIntegration(integration.id)
    }
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

      // Identity falls back to the corp-scoped unionId; NO grant row is written when the grant is off.
      const identity = await query<{ external_key: string }>(
        `SELECT external_key FROM user_external_identities WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [user.rows[0].id],
      )
      expect(identity.rows).toHaveLength(1)
      expect(identity.rows[0].external_key).toBe(`${CORP}:dso-un-nogrant-${TS}`)

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
    const approvalService = new ApprovalProductService()
    const approvalFormSchema: FormSchema = {
      fields: [{ id: 'reason', type: 'text', label: 'Reason', required: true }],
    }

    function approvalGraph(assigneeId: string): ApprovalGraph {
      return {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: 'Approval',
            config: {
              assigneeSources: [{ kind: 'static_user', userIds: [assigneeId] }],
              approvalMode: 'single',
              emptyAssigneePolicy: 'error',
            },
          },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'edge-start', source: 'start', target: 'approval_1' },
          { key: 'edge-end', source: 'approval_1', target: 'end' },
        ],
      }
    }

    async function seedDepartureFixture(tag: string): Promise<{
      accountId: string
      departedExternalUserId: string
      departedUnionId: string
      deptId: string
      integrationId: string
      localUserId: string
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

      const localUserId = `dso-dep-user-${tag}-${TS}`
      await query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE)`, [
        localUserId,
        `${localUserId}@example.test`,
      ])

      // Pre-linked directory account that will be ABSENT from the pull below —
      // last_seen_at predates the sync timestamp, so the sweep transitions it
      // to inactive and hands its id to the executor within the same run.
      const departedExternalUserId = `dso-dep-ext-${tag}-${TS}`
      const departedUnionId = `dso-dep-un-${tag}-${TS}`
      const account = await query<{ id: string }>(
        `INSERT INTO directory_accounts (
           integration_id, corp_id, external_user_id, union_id, external_key, name, is_active, last_seen_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $4, 'Departed', true, NOW(), NOW(), NOW())
         RETURNING id`,
        [
          integration.id,
          `dso-dep-corp-${tag}-${TS}`,
          departedExternalUserId,
          departedUnionId,
        ],
      )
      await query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
         VALUES ($1, $2, 'linked', 'manual', NOW(), NOW())`,
        [account.rows[0].id, localUserId],
      )
      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [localUserId],
      )
      await query(
        `INSERT INTO user_external_auth_grants (
           provider, local_user_id, enabled, granted_by, created_at, updated_at
         ) VALUES ('dingtalk', $1, TRUE, 'system:test-fixture', NOW(), NOW())`,
        [localUserId],
      )

      return {
        integrationId: integration.id,
        localUserId,
        accountId: account.rows[0].id,
        departedExternalUserId,
        departedUnionId,
        deptId: `dso-dep-dept-${tag}-${TS}`,
        survivorExt: `dso-dep-surv-${tag}-${TS}`,
      }
    }

    async function seedApprovalDepartureSyncFixture(
      tag: string,
      policy: 'mark_inactive' | 'disable_grant_only',
    ): Promise<{
      accountId: string
      approvalId: string
      deptId: string
      directory: MockDirectory
      integrationId: string
      localUserId: string
      managerExternalId: string
      managerUserId: string
      requesterUserId: string
      templateId: string
      extraUserIds: string[]
    }> {
      const corpId = `dso-f4e-corp-${tag}-${TS}`
      const integration = await createDirectoryIntegration({
        name: `dso-f4e-${tag}-${TS}`,
        corpId,
        appKey: `dso-f4e-appkey-${tag}-${TS}`,
        appSecret: 'dso-secret',
        admissionMode: 'manual_only',
        defaultDeprovisionPolicy: policy,
      })
      const localUserId = `dso-f4e-departed-${tag}-${TS}`
      const managerUserId = `dso-f4e-manager-${tag}-${TS}`
      const requesterUserId = `dso-f4e-requester-${tag}-${TS}`
      await query(
        `INSERT INTO users (id, email, password_hash, is_active)
         VALUES ($1, $2, 'x', TRUE), ($3, $4, 'x', TRUE), ($5, $6, 'x', TRUE)`,
        [
          localUserId,
          `${localUserId}@example.test`,
          managerUserId,
          `${managerUserId}@example.test`,
          requesterUserId,
          `${requesterUserId}@example.test`,
        ],
      )
      await grantApprovalWriteForIntegrationActor(requesterUserId)
      await query(
        `INSERT INTO user_orgs (user_id, org_id, is_active)
         VALUES ($1, 'default', TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [localUserId],
      )
      await query(
        `INSERT INTO user_external_auth_grants (
           provider, local_user_id, enabled, granted_by, created_at, updated_at
         ) VALUES ('dingtalk', $1, TRUE, 'system:test-fixture', NOW(), NOW())`,
        [localUserId],
      )

      const deptId = `dso-f4e-dept-${tag}-${TS}`
      const department = await query<{ id: string }>(
        `INSERT INTO directory_departments (
           integration_id, external_department_id, name, is_active, raw
         ) VALUES ($1, $2, 'F4E', TRUE, '{}'::jsonb)
         RETURNING id::text AS id`,
        [integration.id, deptId],
      )
      const departedExternalId = `dso-f4e-ext-departed-${tag}-${TS}`
      const managerExternalId = `dso-f4e-ext-manager-${tag}-${TS}`
      const departedAccount = await query<{ id: string }>(
        `INSERT INTO directory_accounts (
           integration_id, corp_id, external_user_id, external_key, name, is_active, last_seen_at, raw
         ) VALUES ($1, $2, $3, $3, 'Departed', TRUE, NOW(), '{}'::jsonb)
         RETURNING id::text AS id`,
        [integration.id, corpId, departedExternalId],
      )
      const managerSource = { leader_in_dept: [{ dept_id: deptId, leader: true }] }
      const managerAccount = await query<{ id: string }>(
        `INSERT INTO directory_accounts (
           integration_id, corp_id, external_user_id, external_key, name, is_active, last_seen_at, raw
         ) VALUES ($1, $2, $3, $3, 'Manager', TRUE, NOW(), $4::jsonb)
         RETURNING id::text AS id`,
        [integration.id, corpId, managerExternalId, JSON.stringify(managerSource)],
      )
      await query(
        `INSERT INTO directory_account_links (
           directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at
         ) VALUES
           ($1, $2, 'linked', 'manual', NOW(), NOW()),
           ($3, $4, 'linked', 'manual', NOW(), NOW())`,
        [departedAccount.rows[0].id, localUserId, managerAccount.rows[0].id, managerUserId],
      )
      await query(
        `INSERT INTO directory_account_departments (
           directory_account_id, directory_department_id, is_primary
         ) VALUES ($1, $3, TRUE), ($2, $3, TRUE)`,
        [departedAccount.rows[0].id, managerAccount.rows[0].id, department.rows[0].id],
      )

      const templateKey = `dso-f4e-template-${tag}-${TS}`
      const template = await approvalService.createTemplate({
        key: templateKey,
        name: templateKey,
        formSchema: approvalFormSchema,
        approvalGraph: approvalGraph(localUserId),
      })
      await approvalService.publishTemplate(template.id, { policy: { allowRevoke: true } })
      const approval = await approvalService.createApproval(
        { templateId: template.id, formData: { reason: 'departure wiring' } },
        { userId: requesterUserId, userName: requesterUserId },
      )

      return {
        accountId: departedAccount.rows[0].id,
        approvalId: approval.id,
        deptId,
        directory: {
          departments: [{ id: deptId, parentId: '1', name: 'F4E', order: 0 }],
          usersByDept: {
            [deptId]: [{
              userId: managerExternalId,
              name: 'Manager',
              departmentIds: [deptId],
              source: managerSource,
            }],
          },
        },
        integrationId: integration.id,
        localUserId,
        managerExternalId,
        managerUserId,
        requesterUserId,
        templateId: template.id,
        extraUserIds: [managerUserId, requesterUserId],
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

    function rehireDirectory(fixture: {
      departedExternalUserId: string
      departedUnionId: string
      deptId: string
    }): MockDirectory {
      return {
        departments: [{
          id: fixture.deptId,
          parentId: '1',
          name: 'Rehire Ops',
          order: 0,
        }],
        usersByDept: {
          [fixture.deptId]: [{
            userId: fixture.departedExternalUserId,
            name: 'Returned',
            departmentIds: [fixture.deptId],
            unionId: fixture.departedUnionId,
          }],
        },
      }
    }

    async function seedOpenEvidenceBeforeDeparture(
      fixture: {
        accountId: string
        integrationId: string
        localUserId: string
      },
    ): Promise<{ eventId: string; generation: number }> {
      await query(
        `UPDATE directory_accounts SET is_active = FALSE WHERE id = $1::uuid`,
        [fixture.accountId],
      )
      const run = await query<{ id: string }>(
        `INSERT INTO directory_sync_runs (
           integration_id, status, triggered_by, trigger_source
         ) VALUES ($1::uuid, 'success', 'test:d5c-prior-event', 'manual')
         RETURNING id::text AS id`,
        [fixture.integrationId],
      )
      const applied = await transaction((client) =>
        applyDirectoryDeprovisionCandidate(client, {
          localUserId: fixture.localUserId,
          orgId: 'default',
          integrationId: fixture.integrationId,
          directoryAccountId: fixture.accountId,
          runId: run.rows[0].id,
          triggeredBy: 'test:d5c-prior-event',
          policy: 'mark_inactive',
          write: true,
        }),
      )
      if (!applied.eventId) {
        throw new Error('failed to seed prior deprovision evidence')
      }

      // Re-open only the source account. The prior event remains applied and its
      // three after-values remain current, so the next source-state transition
      // must supersede that evidence without inventing a replacement event.
      await query(
        `UPDATE directory_accounts SET is_active = TRUE WHERE id = $1::uuid`,
        [fixture.accountId],
      )
      return {
        eventId: applied.eventId,
        generation: applied.accessGeneration,
      }
    }

    const cleanupTargets: Array<{
      approvalId?: string
      extraUserIds?: string[]
      integrationId: string
      localUserId: string
      siblingIntegrationId?: string
      templateId?: string
    }> = []

    afterAll(async () => {
      for (const target of cleanupTargets) {
        if (target.approvalId) {
          await query(`DELETE FROM approval_records WHERE instance_id = $1`, [target.approvalId])
          await query(`DELETE FROM approval_assignments WHERE instance_id = $1`, [target.approvalId])
          await query(`DELETE FROM approval_metrics WHERE instance_id = $1`, [target.approvalId])
          await query(`DELETE FROM approval_instances WHERE id = $1`, [target.approvalId])
        }
        if (target.templateId) {
          await query(`DELETE FROM approval_published_definitions WHERE template_id = $1::uuid`, [target.templateId])
          await query(`DELETE FROM approval_template_versions WHERE template_id = $1::uuid`, [target.templateId])
          await query(`DELETE FROM approval_templates WHERE id = $1::uuid`, [target.templateId])
        }
        await cleanupIntegration(target.integrationId)
        if (target.siblingIntegrationId) await cleanupIntegration(target.siblingIntegrationId)
        const userIds = [target.localUserId, ...(target.extraUserIds ?? [])]
        await query(`DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`, [userIds])
        await query(`DELETE FROM user_orgs WHERE user_id = ANY($1::text[])`, [userIds])
        await query(`DELETE FROM user_external_auth_grants WHERE local_user_id = ANY($1::text[])`, [userIds])
        await query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds])
      }
    })

    it('F4-E consumes the committed mark_inactive user_changed signal and transfers the active seat to the live manager at the same epoch', async () => {
      const fixture = await seedApprovalDepartureSyncFixture('approval-on', 'mark_inactive')
      cleanupTargets.push(fixture)
      activeDirectory = fixture.directory
      const before = await query<{ entry_epoch: number; id: string }>(
        `SELECT id::text AS id, entry_epoch
           FROM approval_assignments
          WHERE instance_id = $1 AND assignee_id = $2 AND is_active = TRUE`,
        [fixture.approvalId, fixture.localUserId],
      )
      expect(before.rows).toHaveLength(1)

      const warnSpy = vi.spyOn(Logger.prototype, 'warn')
      process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
      let runId = ''
      try {
        const result = await syncDirectoryIntegration(fixture.integrationId, 'system:dso-f4e-on')
        runId = result.run.id
      } finally {
        delete process.env.DIRECTORY_DEPROVISION_ENABLED
      }
      const dispatchWarnings = warnSpy.mock.calls
        .map((call) => call[0])
        .filter((message) => message.startsWith('Approval departure dispatch'))
      warnSpy.mockRestore()
      expect(dispatchWarnings).toEqual([])

      const signal = await query<{ local_user_id: string }>(
        `SELECT event.local_user_id
           FROM directory_deprovision_events event
           JOIN directory_deprovision_effects effect ON effect.event_id = event.id
          WHERE event.run_id = $1::uuid
            AND effect.effect_type = 'user_changed'
            AND event.status = 'applied'
            AND effect.status = 'applied'`,
        [runId],
      )
      expect(signal.rows).toEqual([{ local_user_id: fixture.localUserId }])

      const managerDirectoryState = await query<{
        external_department_id: string
        is_active: boolean
        is_primary: boolean
        leader_department_id: string | null
        link_status: string
        local_user_id: string | null
      }>(
        `SELECT a.is_active,
                l.link_status,
                l.local_user_id,
                d.external_department_id,
                ad.is_primary,
                a.raw -> 'leader_in_dept' -> 0 ->> 'dept_id' AS leader_department_id
           FROM directory_accounts a
           JOIN directory_account_links l ON l.directory_account_id = a.id
           JOIN directory_account_departments ad ON ad.directory_account_id = a.id
           JOIN directory_departments d ON d.id = ad.directory_department_id
          WHERE a.integration_id = $1::uuid
            AND a.external_user_id = $2`,
        [fixture.integrationId, fixture.managerExternalId],
      )
      expect(managerDirectoryState.rows).toEqual([{
        external_department_id: fixture.deptId,
        is_active: true,
        is_primary: true,
        leader_department_id: fixture.deptId,
        link_status: 'linked',
        local_user_id: fixture.managerUserId,
      }])

      const audit = await query<{
        actor_id: string
        metadata: Record<string, unknown>
        target_user_id: string | null
      }>(
        `SELECT actor_id, metadata, target_user_id
           FROM approval_records
          WHERE instance_id = $1 AND action = 'reassign'
          ORDER BY created_at DESC
          LIMIT 1`,
        [fixture.approvalId],
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0]).toMatchObject({
        actor_id: 'system:approval-departure',
        target_user_id: fixture.managerUserId,
        metadata: {
          departureTransfer: true,
          fromUserId: fixture.localUserId,
          outcome: 'transferred',
          toUserId: fixture.managerUserId,
        },
      })

      const seats = await query<{
        assignee_id: string
        entry_epoch: number
        is_active: boolean
      }>(
        `SELECT assignee_id, entry_epoch, is_active
           FROM approval_assignments
          WHERE instance_id = $1
          ORDER BY created_at ASC`,
        [fixture.approvalId],
      )
      expect(seats.rows).toEqual([
        {
          assignee_id: fixture.localUserId,
          entry_epoch: before.rows[0].entry_epoch,
          is_active: false,
        },
        {
          assignee_id: fixture.managerUserId,
          entry_epoch: before.rows[0].entry_epoch,
          is_active: true,
        },
      ])
    })

    it('F4-E leaves the active seat in place and audits when the committed departure has no live manager', async () => {
      const fixture = await seedApprovalDepartureSyncFixture('approval-no-manager', 'mark_inactive')
      cleanupTargets.push(fixture)
      const manager = fixture.directory.usersByDept[fixture.deptId][0]
      manager.source = { leader_in_dept: [{ dept_id: fixture.deptId, leader: false }] }
      activeDirectory = fixture.directory

      const before = await query<{
        assignee_id: string
        id: string
        is_active: boolean
      }>(
        `SELECT id::text AS id, assignee_id, is_active
           FROM approval_assignments
          WHERE instance_id = $1 AND is_active = TRUE`,
        [fixture.approvalId],
      )
      expect(before.rows).toHaveLength(1)
      expect(before.rows[0]).toMatchObject({
        assignee_id: fixture.localUserId,
        is_active: true,
      })

      process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
      try {
        await syncDirectoryIntegration(fixture.integrationId, 'system:dso-f4e-no-manager')
      } finally {
        delete process.env.DIRECTORY_DEPROVISION_ENABLED
      }

      const after = await query<{
        assignee_id: string
        id: string
        is_active: boolean
      }>(
        `SELECT id::text AS id, assignee_id, is_active
           FROM approval_assignments
          WHERE instance_id = $1
          ORDER BY created_at ASC`,
        [fixture.approvalId],
      )
      expect(after.rows).toEqual(before.rows)

      const audit = await query<{
        actor_id: string
        from_status: string
        from_version: number
        metadata: Record<string, unknown>
        target_user_id: string | null
        to_status: string
        to_version: number
      }>(
        `SELECT actor_id, from_status, from_version, metadata, target_user_id, to_status, to_version
           FROM approval_records
          WHERE instance_id = $1 AND action = 'reassign'
          ORDER BY created_at DESC
          LIMIT 1`,
        [fixture.approvalId],
      )
      expect(audit.rows).toHaveLength(1)
      expect(audit.rows[0]).toMatchObject({
        actor_id: 'system:approval-departure',
        target_user_id: null,
        metadata: {
          departureTransfer: true,
          fromUserId: fixture.localUserId,
          outcome: 'no_manager_resolved',
        },
      })
      expect(audit.rows[0].from_status).toBe(audit.rows[0].to_status)
      expect(Number(audit.rows[0].from_version)).toBe(Number(audit.rows[0].to_version))
    })

    it('F4-E does not transfer for a grant-only deprovision event without user_changed', async () => {
      const fixture = await seedApprovalDepartureSyncFixture('approval-grant-only', 'disable_grant_only')
      cleanupTargets.push(fixture)
      activeDirectory = fixture.directory

      process.env.DIRECTORY_DEPROVISION_ENABLED = 'true'
      let runId = ''
      try {
        const result = await syncDirectoryIntegration(fixture.integrationId, 'system:dso-f4e-grant-only')
        runId = result.run.id
      } finally {
        delete process.env.DIRECTORY_DEPROVISION_ENABLED
      }

      const effectTypes = await query<{ effect_type: string }>(
        `SELECT effect.effect_type
           FROM directory_deprovision_events event
           JOIN directory_deprovision_effects effect ON effect.event_id = event.id
          WHERE event.run_id = $1::uuid
          ORDER BY effect.effect_type ASC`,
        [runId],
      )
      expect(effectTypes.rows).toEqual([
        { effect_type: 'grant_changed' },
        { effect_type: 'membership_changed' },
      ])
      const activeSeat = await query<{ assignee_id: string; is_active: boolean }>(
        `SELECT assignee_id, is_active
           FROM approval_assignments
          WHERE instance_id = $1 AND is_active = TRUE`,
        [fixture.approvalId],
      )
      expect(activeSeat.rows).toEqual([{ assignee_id: fixture.localUserId, is_active: true }])
      const reassignCount = await query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM approval_records
          WHERE instance_id = $1 AND action = 'reassign'`,
        [fixture.approvalId],
      )
      expect(reassignCount.rows).toEqual([{ count: '0' }])
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

    it('a retained account whose email newly matches a local user does not kill the run (D5 review P1: inventory is a superset of the loop)', async () => {
      // Before the fix, the mutex inventory was built ONLY from the pull payload, while the link
      // loop iterates EVERY account of the integration and resolves against match maps built
      // from all of them. This fixture is the deterministic killer: an account already in the DB
      // (absent from the pull) whose email matches a user created since the last sync — the loop
      // resolved a user the inventory never locked, threw "resolved a local user after the mutex
      // inventory; retry the run", and every retry failed identically.
      const integration = await createDirectoryIntegration({
        name: `dso-inv-${TS}`,
        corpId: `dso-inv-corp-${TS}`,
        appKey: `dso-inv-appkey-${TS}`,
        appSecret: 'dso-secret',
        admissionMode: 'manual_only',
        defaultDeprovisionPolicy: 'manual_review',
      })
      const matchedUserId = `dso-inv-user-${TS}`
      await query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE)`, [
        matchedUserId,
        `${matchedUserId}@example.test`,
      ])
      // Retained DB account with the matching email — NOT in the pull below.
      await query(
        `INSERT INTO directory_accounts (
           integration_id, corp_id, external_user_id, external_key, name, email, is_active, last_seen_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $3, 'Retained', $4, true, NOW(), NOW(), NOW())`,
        [integration.id, `dso-inv-corp-${TS}`, `dso-inv-ext-${TS}`, `${matchedUserId}@example.test`],
      )
      const survivorExt = `dso-inv-survivor-${TS}`
      const deptId = `55${TS % 100000}`
      activeDirectory = {
        departments: [{ id: deptId, parentId: '1', name: 'Dep Inv', order: 0 }],
        usersByDept: {
          [deptId]: [
            { userId: survivorExt, name: 'Survivor', departmentIds: [deptId], unionId: `${survivorExt}-un` },
          ],
        },
      }
      cleanupTargets.push({ integrationId: integration.id, localUserId: matchedUserId })

      const result = await syncDirectoryIntegration(integration.id, 'system:dso-inv')
      expect(result.run.status).toBe('completed')
      // The retained account resolved its email hint without killing the run.
      const hint = await query<{ local_user_id: string | null; link_status: string }>(
        `SELECT l.local_user_id, l.link_status
           FROM directory_account_links l
           JOIN directory_accounts a ON a.id = l.directory_account_id
          WHERE a.integration_id = $1 AND a.external_user_id = $2`,
        [integration.id, `dso-inv-ext-${TS}`],
      )
      expect(hint.rows[0]?.local_user_id).toBe(matchedUserId)
    })

    it('with the flag unset (shipped default), the same departure writes NOTHING — counts are preview-only', async () => {
      const fixture = await seedDepartureFixture('off')
      cleanupTargets.push(fixture)
      activeDirectory = departureDirectory(fixture)
      expect(process.env.DIRECTORY_DEPROVISION_ENABLED).toBeUndefined()

      const result = await syncDirectoryIntegration(fixture.integrationId, 'system:dso-dep-off')
      const stats = result.run.stats as Record<string, unknown>

      // Default-off pin: the person keeps every pre-existing access-graph edge.
      const user = await query<{ is_active: boolean }>(`SELECT is_active FROM users WHERE id = $1`, [fixture.localUserId])
      expect(user.rows[0].is_active).toBe(true)

      const grant = await query<{ enabled: boolean }>(
        `SELECT enabled FROM user_external_auth_grants WHERE provider = 'dingtalk' AND local_user_id = $1`,
        [fixture.localUserId],
      )
      expect(grant.rows).toHaveLength(1)
      expect(grant.rows[0].enabled).toBe(true)

      const membership = await query<{ is_active: boolean }>(
        `SELECT is_active FROM user_orgs WHERE user_id = $1 AND org_id = 'default'`,
        [fixture.localUserId],
      )
      expect(membership.rows).toHaveLength(1)
      expect(membership.rows[0].is_active).toBe(true)

      // But the run REPORTS what it would have done (the operator preview).
      expect(stats.deprovisionApplied).toBe(false)
      expect(stats.deprovisionCandidateCount).toBe(1)
      expect(stats.deprovisionGlobalCandidateCount).toBe(1)
      expect(stats.deprovisionGrantsDisabledCount).toBe(1)
      expect(stats.deprovisionUsersDeactivatedCount).toBe(1)
    })

    it('supersedes prior evidence when the sync itself changes a linked account from active to inactive', async () => {
      const fixture = await seedDepartureFixture('d5c-supersede')
      cleanupTargets.push(fixture)
      const prior = await seedOpenEvidenceBeforeDeparture(fixture)
      activeDirectory = departureDirectory(fixture)
      expect(process.env.DIRECTORY_DEPROVISION_ENABLED).toBeUndefined()

      await syncDirectoryIntegration(
        fixture.integrationId,
        'system:d5c-sync-account-transition',
      )

      const state = await query<{
        access_generation: string
        account_active: boolean
        event_status: string
        effect_statuses: string[]
        resolved_by: string | null
      }>(
        `SELECT
           candidate_user.access_generation::text,
           account.is_active AS account_active,
           event.status AS event_status,
           event.resolved_by,
           array_agg(effect.status ORDER BY effect.effect_type)::text[] AS effect_statuses
         FROM users candidate_user
         JOIN directory_accounts account ON account.id = $2::uuid
         JOIN directory_deprovision_events event
           ON event.id = $3::uuid
          AND event.local_user_id = candidate_user.id
         JOIN directory_deprovision_effects effect ON effect.event_id = event.id
        WHERE candidate_user.id = $1
        GROUP BY
          candidate_user.access_generation,
          account.is_active,
          event.status,
          event.resolved_by`,
        [fixture.localUserId, fixture.accountId, prior.eventId],
      )
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        account_active: false,
        event_status: 'superseded',
        effect_statuses: ['superseded', 'superseded', 'superseded'],
        resolved_by: 'system:d5c-sync-account-transition',
      })
      expect(Number(state.rows[0].access_generation)).toBe(
        prior.generation + 1,
      )

      const events = await query<{ status: string }>(
        `SELECT status
           FROM directory_deprovision_events
          WHERE local_user_id = $1`,
        [fixture.localUserId],
      )
      expect(events.rows).toEqual([{ status: 'superseded' }])
    })

    it('preserves applied evidence and the inactive access graph when its source account reappears for rehire review', async () => {
      const fixture = await seedDepartureFixture('d5c-rehire')
      cleanupTargets.push(fixture)
      const prior = await seedOpenEvidenceBeforeDeparture(fixture)
      activeDirectory = rehireDirectory(fixture)
      expect(process.env.DIRECTORY_DEPROVISION_ENABLED).toBeUndefined()

      await syncDirectoryIntegration(
        fixture.integrationId,
        'system:d5c-sync-rehire-signal',
      )

      const state = await query<{
        access_generation: string
        account_active: boolean
        event_status: string
        effect_statuses: string[]
        grant_enabled: boolean
        membership_active: boolean
        user_active: boolean
      }>(
        `SELECT
           candidate_user.access_generation::text,
           candidate_user.is_active AS user_active,
           account.is_active AS account_active,
           event.status AS event_status,
           grant_row.enabled AS grant_enabled,
           membership.is_active AS membership_active,
           array_agg(effect.status ORDER BY effect.effect_type)::text[] AS effect_statuses
         FROM users candidate_user
         JOIN directory_accounts account ON account.id = $2::uuid
         JOIN directory_deprovision_events event
           ON event.id = $3::uuid
          AND event.local_user_id = candidate_user.id
         JOIN directory_deprovision_effects effect ON effect.event_id = event.id
         JOIN user_external_auth_grants grant_row
           ON grant_row.provider = 'dingtalk'
          AND grant_row.local_user_id = candidate_user.id
         JOIN user_orgs membership
           ON membership.user_id = candidate_user.id
          AND membership.org_id = 'default'
        WHERE candidate_user.id = $1
        GROUP BY
          candidate_user.access_generation,
          candidate_user.is_active,
          account.is_active,
          event.status,
          grant_row.enabled,
          membership.is_active`,
        [fixture.localUserId, fixture.accountId, prior.eventId],
      )
      expect(state.rows).toEqual([{
        access_generation: String(prior.generation),
        account_active: true,
        event_status: 'applied',
        effect_statuses: ['applied', 'applied', 'applied'],
        grant_enabled: false,
        membership_active: false,
        user_active: false,
      }])
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
