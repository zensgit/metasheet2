import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
}))

const dingtalkMocks = vi.hoisted(() => ({
  fetchDingTalkAppAccessToken: vi.fn(),
  listDingTalkDepartments: vi.fn(),
  listDingTalkDepartmentUsers: vi.fn(),
  getDingTalkUserDetail: vi.fn(),
  getDingTalkDepartmentDetail: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
}))

vi.mock('../../src/integrations/dingtalk/client', () => ({
  fetchDingTalkAppAccessToken: dingtalkMocks.fetchDingTalkAppAccessToken,
  listDingTalkDepartments: dingtalkMocks.listDingTalkDepartments,
  listDingTalkDepartmentUsers: dingtalkMocks.listDingTalkDepartmentUsers,
  getDingTalkUserDetail: dingtalkMocks.getDingTalkUserDetail,
  getDingTalkDepartmentDetail: dingtalkMocks.getDingTalkDepartmentDetail,
}))

import {
  DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS,
  DIRECTORY_SYNC_LEASE_STALE_MINUTES,
  DirectorySyncInProgressError,
  DirectorySyncLeaseLostError,
  reclaimStaleDirectorySyncRuns,
  syncDirectoryIntegration,
} from '../../src/directory/directory-sync'

const INTEGRATION_ROW = {
  id: 'dir-1',
  org_id: 'default',
  provider: 'dingtalk',
  name: 'DingTalk CN',
  status: 'active',
  corp_id: 'dingcorp',
  config: { appKey: 'k', appSecret: 's' },
  sync_enabled: true,
  schedule_cron: null,
  default_deprovision_policy: 'mark_inactive',
  last_sync_at: null,
  last_success_at: null,
  last_error: null,
  created_at: '2026-07-08T00:00:00.000Z',
  updated_at: '2026-07-08T00:00:00.000Z',
}

const RUN_ID = 'run-1'

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    integration_id: 'dir-1',
    status: 'running',
    started_at: '2026-07-09T00:00:00.000Z',
    finished_at: null,
    stats: {},
    error_message: null,
    triggered_by: 'admin-1',
    trigger_source: 'scheduler',
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
    ...overrides,
  }
}

function uniqueViolation() {
  const error = new Error('duplicate key value violates unique constraint') as Error & { code: string }
  error.code = '23505'
  return error
}

type LoggedCall = { text: string; params: unknown[] | undefined }

/**
 * Full-run harness: an SQL-shape dispatcher instead of a positional mock chain, because
 * the heartbeat timer interleaves nondeterministically with the sync's own queries.
 * Everything not recognized answers empty rows — with zero users/departments every
 * loop in the apply body is a no-op, which is exactly the point: these tests pin the
 * lease machinery, not the apply.
 */
function installFullRunMocks(options: { completionRows?: Array<{ id: string }> } = {}) {
  const bareCalls: LoggedCall[] = []
  const beats: LoggedCall[] = []
  const txCalls: LoggedCall[] = []
  const completionRows = options.completionRows ?? [{ id: RUN_ID }]

  pgMocks.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql)
    bareCalls.push({ text, params })
    if (text.includes('SET last_heartbeat_at')) {
      beats.push({ text, params })
      return { rows: [] }
    }
    if (text.includes('INSERT INTO directory_sync_runs')) return { rows: [runRow()] }
    if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
    if (text.includes('FROM directory_sync_runs')) return { rows: [runRow({ status: 'completed' })] }
    return { rows: [] }
  })

  pgMocks.transaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: unknown, params?: unknown[]) => {
        const text = String(sql)
        txCalls.push({ text, params })
        if (text.includes("SET status = 'completed'")) return { rows: completionRows }
        return { rows: [] }
      },
    }
    return fn(client)
  })

  dingtalkMocks.fetchDingTalkAppAccessToken.mockResolvedValue('token')
  dingtalkMocks.listDingTalkDepartments.mockResolvedValue([])
  dingtalkMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
  dingtalkMocks.listDingTalkDepartmentUsers.mockResolvedValue({ users: [], hasMore: false, nextCursor: null })

  return { bareCalls, beats, txCalls }
}

/**
 * DT-HARDEN-05 — the sync lease.
 *
 * syncDirectoryIntegration inserts its run row and then pulls the entire DingTalk
 * directory before opening its apply transaction. A transaction-scoped lock around the
 * apply would not protect that pull. The lease is therefore claimed on the run row,
 * BEFORE the first outbound call, and the owner proves it is still alive by beating
 * last_heartbeat_at while it holds the lease.
 */
describe('DT-HARDEN-05 directory sync run lease', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    for (const mock of Object.values(dingtalkMocks)) mock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('has a positive staleness window of at least five heartbeat intervals', () => {
    expect(DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(5_000)
    expect(DIRECTORY_SYNC_LEASE_STALE_MINUTES).toBeGreaterThan(0)
    // A single missed beat (GC pause, slow pool) must never look like a death.
    expect(DIRECTORY_SYNC_LEASE_STALE_MINUTES * 60_000).toBeGreaterThanOrEqual(
      5 * DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS,
    )
  })

  it('refuses a concurrent sync and never touches the DingTalk API', async () => {
    pgMocks.query
      // getIntegrationRow
      .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
      // reclaimStaleDirectorySyncRuns → nothing stale
      .mockResolvedValueOnce({ rows: [] })
      // claimDirectorySyncRun → another run holds the lease
      .mockRejectedValueOnce(uniqueViolation())
      // findActiveDirectorySyncRunId
      .mockResolvedValueOnce({ rows: [{ id: 'run-active' }] })

    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'manual'))
      .rejects.toBeInstanceOf(DirectorySyncInProgressError)

    // The load-bearing assertion: the expensive, quota-consuming pull never started.
    expect(dingtalkMocks.fetchDingTalkAppAccessToken).not.toHaveBeenCalled()
    expect(dingtalkMocks.listDingTalkDepartments).not.toHaveBeenCalled()
  })

  it('carries the active run id so the caller can observe the run in flight', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ rows: [{ id: 'run-active' }] })

    const error = await syncDirectoryIntegration('dir-1', 'admin-1', 'manual').catch((err) => err)
    expect(error).toBeInstanceOf(DirectorySyncInProgressError)
    expect((error as DirectorySyncInProgressError).activeRunId).toBe('run-active')
    expect((error as DirectorySyncInProgressError).statusCode).toBe(409)
  })

  it('reclaims the lease before claiming it, so a crashed run cannot wedge an integration', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: 'stale-run' }] }) // reclaim
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ rows: [{ id: 'run-active' }] })

    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'manual')).rejects.toBeInstanceOf(DirectorySyncInProgressError)

    const reclaimCall = pgMocks.query.mock.calls[1]
    expect(String(reclaimCall[0])).toContain('UPDATE directory_sync_runs')
    expect(String(reclaimCall[0])).toContain("status = 'running'")
    // Reclaim strictly precedes the claim.
    expect(String(pgMocks.query.mock.calls[2][0])).toContain('INSERT INTO directory_sync_runs')
  })

  it('propagates a non-unique-violation insert error unchanged', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('connection reset'))

    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'manual')).rejects.toThrow('connection reset')
  })

  describe('reclaimStaleDirectorySyncRuns', () => {
    it('judges staleness by heartbeat (falling back to started_at), never by run age alone', async () => {
      pgMocks.query.mockResolvedValueOnce({ rows: [] })
      await reclaimStaleDirectorySyncRuns('dir-1')
      const [sql] = pgMocks.query.mock.calls[0]
      // The exact predicate is the contract: a live long run keeps beating and is
      // never reclaimed; a run that died before its first beat falls back to
      // started_at and still gets swept.
      expect(String(sql)).toContain("COALESCE(last_heartbeat_at, started_at) < NOW() - ($1::int * INTERVAL '1 minute')")
      expect(String(sql)).not.toMatch(/AND\s+started_at\s*</)
    })

    it('scopes to a single integration when asked', async () => {
      pgMocks.query.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
      const reclaimed = await reclaimStaleDirectorySyncRuns('dir-1')
      expect(reclaimed).toBe(1)
      const [sql, params] = pgMocks.query.mock.calls[0]
      expect(String(sql)).toContain('integration_id = $2')
      expect(params).toEqual([DIRECTORY_SYNC_LEASE_STALE_MINUTES, 'dir-1'])
    })

    it('sweeps every integration at boot when unscoped', async () => {
      pgMocks.query.mockResolvedValueOnce({ rows: [] })
      const reclaimed = await reclaimStaleDirectorySyncRuns()
      expect(reclaimed).toBe(0)
      const [sql, params] = pgMocks.query.mock.calls[0]
      expect(String(sql)).not.toContain('integration_id = $2')
      expect(params).toEqual([DIRECTORY_SYNC_LEASE_STALE_MINUTES])
    })
  })

  describe('heartbeat', () => {
    it('beats last_heartbeat_at mid-run and stops once the run finishes', async () => {
      vi.useFakeTimers()
      const { beats } = installFullRunMocks()
      // Hold the sync inside the DingTalk pull for two heartbeat intervals.
      dingtalkMocks.listDingTalkDepartments.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS * 2 + 5_000))
        return []
      })

      const pending = syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')
      await vi.advanceTimersByTimeAsync(DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS * 2)

      // At least one beat while the pull is still in flight, carrying the claimed
      // run id and refusing to touch a row the reclaimer already flipped.
      expect(beats.length).toBeGreaterThanOrEqual(1)
      for (const beat of beats) {
        expect(beat.text).toContain('SET last_heartbeat_at = NOW()')
        expect(beat.text).toContain("AND status = 'running'")
        expect(beat.params).toEqual([RUN_ID])
      }

      await vi.advanceTimersByTimeAsync(10_000)
      await pending

      // Interval is cleared in finally: no beats after completion.
      const beatsAtFinish = beats.length
      await vi.advanceTimersByTimeAsync(DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS * 10)
      expect(beats.length).toBe(beatsAtFinish)
    })

    it('stops beating after a failed run too', async () => {
      vi.useFakeTimers()
      const { beats } = installFullRunMocks()
      dingtalkMocks.listDingTalkDepartments.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS + 5_000))
        throw new Error('dingtalk exploded')
      })

      const pending = syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')
      const outcome = pending.catch((err) => err)
      await vi.advanceTimersByTimeAsync(DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS + 10_000)
      expect((await outcome) instanceof Error).toBe(true)

      const beatsAtFailure = beats.length
      expect(beatsAtFailure).toBeGreaterThanOrEqual(1)
      await vi.advanceTimersByTimeAsync(DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS * 10)
      expect(beats.length).toBe(beatsAtFailure)
    })
  })

  describe('markSyncFailure atomicity', () => {
    it('releases the lease and records the integration failure in ONE transaction, lease first', async () => {
      const { bareCalls, txCalls } = installFullRunMocks()
      dingtalkMocks.listDingTalkDepartments.mockRejectedValue(new Error('dingtalk exploded'))

      await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')).rejects.toThrow('dingtalk exploded')

      // Both failure UPDATEs travel through the transaction client...
      expect(pgMocks.transaction).toHaveBeenCalledTimes(1)
      const runRelease = txCalls.findIndex(
        (call) => call.text.includes('UPDATE directory_sync_runs') && call.text.includes("'failed'"),
      )
      const integrationMark = txCalls.findIndex((call) => call.text.includes('UPDATE directory_integrations'))
      expect(runRelease).toBeGreaterThanOrEqual(0)
      expect(integrationMark).toBeGreaterThanOrEqual(0)
      // ...with the lease release ordered first, so even a mid-transaction crash
      // under a non-transactional driver would still have freed the lease.
      expect(runRelease).toBeLessThan(integrationMark)
      expect(txCalls[runRelease].params).toEqual([RUN_ID, 'dingtalk exploded'])
      expect(txCalls[integrationMark].params).toEqual(['dir-1', 'dingtalk exploded'])

      // ...and neither goes out as a bare, non-transactional statement. (The reclaim
      // sweep also flips rows to 'failed' outside a transaction — that one is a single
      // statement and is excluded by its parameterless error_message.)
      const bareFailureWrites = bareCalls.filter(
        (call) =>
          (call.text.includes('UPDATE directory_integrations') && call.text.includes('last_error')) ||
          (call.text.includes('UPDATE directory_sync_runs') && call.text.includes('error_message = $2')),
      )
      expect(bareFailureWrites).toEqual([])
    })
  })

  describe('completion status guard', () => {
    it('completes the run row only while it is still running', async () => {
      const { txCalls } = installFullRunMocks()

      await syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')

      const completion = txCalls.find((call) => call.text.includes("SET status = 'completed'"))
      expect(completion).toBeDefined()
      // The guard: a reclaimed (now 'failed') row must not be resurrected.
      expect(completion?.text).toContain("AND status = 'running'")
      expect(completion?.text).toContain('RETURNING id')
      expect(completion?.params?.[0]).toBe(RUN_ID)
    })

    it('rolls back a zombie whose lease was reclaimed while it was alive, and says so', async () => {
      // Zero rows from the guarded completion UPDATE = someone reclaimed the lease.
      const { txCalls } = installFullRunMocks({ completionRows: [] })

      await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler'))
        .rejects.toBeInstanceOf(DirectorySyncLeaseLostError)

      // The failure record distinguishes reclaimed-while-alive from a crash: the
      // run row carries the lease-lost message, not the reclaimer's orphaned one.
      const failureWrite = txCalls.find(
        (call) => call.text.includes('UPDATE directory_sync_runs') && call.text.includes("'failed'"),
      )
      expect(failureWrite).toBeDefined()
      expect(failureWrite?.params?.[0]).toBe(RUN_ID)
      expect(String(failureWrite?.params?.[1])).toContain('lost its lease while still alive')
    })
  })
})
