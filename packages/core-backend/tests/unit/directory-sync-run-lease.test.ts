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

import { Logger } from '../../src/core/logger'
import { requestDingTalkTransportJson } from '../../src/integrations/dingtalk/transport'
import {
  DIRECTORY_SYNC_HEARTBEAT_INTERVAL_MS,
  DIRECTORY_SYNC_LEASE_STALE_MINUTES,
  DirectorySyncInProgressError,
  DirectorySyncLeaseLostError,
  DirectorySyncRunReplayError,
  previewDirectorySyncIntegration,
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
function installFullRunMocks(options: { completionRows?: Array<{ id: string }>; runId?: string } = {}) {
  const bareCalls: LoggedCall[] = []
  const beats: LoggedCall[] = []
  const txCalls: LoggedCall[] = []
  const runId = options.runId ?? RUN_ID
  const completionRows = options.completionRows ?? [{ id: runId }]

  pgMocks.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql)
    bareCalls.push({ text, params })
    if (text.includes('SET last_heartbeat_at')) {
      beats.push({ text, params })
      return { rows: [] }
    }
    if (text.includes('INSERT INTO directory_sync_runs')) return { rows: [runRow({ id: runId })] }
    if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
    if (text.includes('FROM directory_sync_runs')) return { rows: [runRow({ id: runId, status: 'completed' })] }
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
      // T2 freeze gate (migrated schema present, no active frozen transfer)
      .mockResolvedValueOnce({ rows: [{ reg: null }] }) // no controlled handover journal
      .mockResolvedValueOnce({ rows: [{ reg: 'provider_org_transfers' }] }) // to_regclass
      .mockResolvedValueOnce({ rows: [] }) // active frozen-transfer SELECT
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
      .mockResolvedValueOnce({ rows: [{ reg: null }] }) // no controlled handover journal
      .mockResolvedValueOnce({ rows: [{ reg: 'provider_org_transfers' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ rows: [{ id: 'run-active' }] })

    const error = await syncDirectoryIntegration('dir-1', 'admin-1', 'manual').catch((err) => err)
    expect(error).toBeInstanceOf(DirectorySyncInProgressError)
    expect((error as DirectorySyncInProgressError).activeRunId).toBe('run-active')
    expect((error as DirectorySyncInProgressError).statusCode).toBe(409)
  })

  it('claims the exact caller-reserved UUID before the provider pull', async () => {
    const requestedRunId = '11111111-1111-4111-8111-111111111111'
    const onRunStarted = vi.fn()
    const { bareCalls } = installFullRunMocks({ runId: requestedRunId })

    const result = await syncDirectoryIntegration('dir-1', 'admin-1', 'manual', {
      requestedRunId,
      onRunStarted,
    })

    const claim = bareCalls.find((call) => call.text.includes('INSERT INTO directory_sync_runs'))
    expect(claim?.text).toContain('COALESCE($4::uuid, gen_random_uuid())')
    expect(claim?.params).toEqual(['dir-1', 'admin-1', 'manual', requestedRunId])
    expect(onRunStarted).toHaveBeenCalledOnce()
    expect(onRunStarted).toHaveBeenCalledWith(requestedRunId)
    expect(result.run.id).toBe(requestedRunId)
  })

  it('treats a repeated reserved UUID as observation and never pulls DingTalk twice', async () => {
    const requestedRunId = '22222222-2222-4222-8222-222222222222'
    pgMocks.query
      .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
      .mockResolvedValueOnce({ rows: [{ reg: null }] }) // no controlled handover journal
      .mockResolvedValueOnce({ rows: [{ reg: 'provider_org_transfers' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ rows: [{ id: requestedRunId }] })
      .mockResolvedValueOnce({ rows: [] })

    const error = await syncDirectoryIntegration('dir-1', 'admin-1', 'manual', {
      requestedRunId,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(DirectorySyncRunReplayError)
    expect((error as DirectorySyncRunReplayError).runId).toBe(requestedRunId)
    expect(pgMocks.query.mock.calls[5]?.[1]).toEqual(['dir-1', 'admin-1', 'manual', requestedRunId])
    expect(String(pgMocks.query.mock.calls[6]?.[0])).toContain('WHERE id = $1')
    expect(pgMocks.query.mock.calls[6]?.[1]).toEqual([requestedRunId, 'dir-1'])
    expect(String(pgMocks.query.mock.calls[7]?.[0])).toContain("status = 'running'")
    expect(dingtalkMocks.fetchDingTalkAppAccessToken).not.toHaveBeenCalled()
    expect(dingtalkMocks.listDingTalkDepartments).not.toHaveBeenCalled()
  })

  it('does not let replay of an old run hide a different live run', async () => {
    const requestedRunId = '33333333-3333-4333-8333-333333333333'
    pgMocks.query
      .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
      .mockResolvedValueOnce({ rows: [{ reg: null }] }) // no controlled handover journal
      .mockResolvedValueOnce({ rows: [{ reg: 'provider_org_transfers' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ rows: [{ id: requestedRunId }] })
      .mockResolvedValueOnce({ rows: [{ id: 'different-live-run' }] })

    const error = await syncDirectoryIntegration('dir-1', 'admin-1', 'manual', {
      requestedRunId,
    }).catch((caught) => caught)

    expect(error).toBeInstanceOf(DirectorySyncInProgressError)
    expect((error as DirectorySyncInProgressError).activeRunId).toBe('different-live-run')
    expect(dingtalkMocks.fetchDingTalkAppAccessToken).not.toHaveBeenCalled()
  })

  it('reclaims the lease before claiming it, so a crashed run cannot wedge an integration', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
      // T2 freeze gate: migrated schema present, no active freeze — both queries must
      // precede reclaim, which must precede claim (indexes below pin that order).
      .mockResolvedValueOnce({ rows: [{ reg: null }] }) // no controlled handover journal
      .mockResolvedValueOnce({ rows: [{ reg: 'provider_org_transfers' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'stale-run' }] }) // reclaim
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ rows: [{ id: 'run-active' }] })

    await expect(syncDirectoryIntegration('dir-1', 'admin-1', 'manual')).rejects.toBeInstanceOf(DirectorySyncInProgressError)

    // Handover schema probe precedes the existing transfer gate.
    expect(String(pgMocks.query.mock.calls[1][0])).toContain("to_regclass('directory_handovers')")
    // Freeze-gate SQL shapes: to_regclass then active frozen-transfer SELECT.
    expect(String(pgMocks.query.mock.calls[2][0])).toContain("to_regclass('provider_org_transfers')")
    expect(String(pgMocks.query.mock.calls[3][0])).toContain('FROM provider_org_transfers')
    expect(String(pgMocks.query.mock.calls[3][0])).toContain('freeze_source_sync')

    const reclaimCall = pgMocks.query.mock.calls[4]
    expect(String(reclaimCall[0])).toContain('UPDATE directory_sync_runs')
    expect(String(reclaimCall[0])).toContain("status = 'running'")
    // Reclaim strictly precedes the claim (and freeze-gate strictly precedes reclaim).
    expect(String(pgMocks.query.mock.calls[5][0])).toContain('INSERT INTO directory_sync_runs')
  })

  it('propagates a non-unique-violation insert error unchanged', async () => {
    pgMocks.query
      .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
      // Same migrated-schema freeze gate as the lease-conflict path above so this rejection
      // still lands on claim/INSERT rather than the freeze SELECT or reclaim.
      .mockResolvedValueOnce({ rows: [{ reg: null }] }) // no controlled handover journal
      .mockResolvedValueOnce({ rows: [{ reg: 'provider_org_transfers' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }) // reclaim
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
      // R-41: the persisted text is the classified one; an untyped error's own text goes to the log only.
      expect(txCalls[runRelease].params).toEqual([RUN_ID, 'Directory sync failed'])
      expect(txCalls[integrationMark].params).toEqual(['dir-1', 'Directory sync failed'])

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

  /**
   * Roadmap §7.7 per-phase timing + retry stats on the run record. Only the DingTalk client (and
   * db/pg) is mocked here; the transport is real. So this is the one offline case that drives the
   * REAL transport retry loop through BOTH of syncDirectoryIntegration's observer wrappers
   * (department pull and user pull) all the way to the completion write: it turns red if either
   * pull's retry counters or timing stop reaching `directory_sync_runs.stats`, which the DB tests
   * (mocked client, zero retries) cannot tell from a clean run.
   */
  describe('per-phase timing and retry stats on the completion write (roadmap §7.7)', () => {
    const PULL_DELAY_MS = 50
    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

    it('writes one retry per pull (flow-control, then HTTP 429) and a measured pull duration into the run stats', async () => {
      // Full-jitter backoff × 0 ⇒ each retry waits 0 ms, so the pull time below is the two holds alone.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      try {
        const { txCalls } = installFullRunMocks()
        const departmentFetchFn = vi.fn()
          .mockResolvedValueOnce(jsonResponse({ errcode: 90018, errmsg: 'flow control' }))
          .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok', result: [] }))
        const userFetchFn = vi.fn()
          .mockResolvedValueOnce(jsonResponse({ message: 'too many requests' }, 429))
          .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: 'ok', result: { list: [], has_more: false } }))
        // Each mocked pull makes one real transport call (rejected once — the flow-control errcode
        // for departments, HTTP 429 for users — then served) and then holds for a measurable interval.
        // The root department is always seeded, so the user pull runs once even with no children.
        dingtalkMocks.listDingTalkDepartments.mockImplementation(async () => {
          await requestDingTalkTransportJson({
            input: 'https://example.test/topapi/v2/department/listsub',
            init: { method: 'POST', body: '{}' },
            fallbackError: 'department listing failed',
            kind: 'read',
            envelope: 'oapi',
            fetchFn: departmentFetchFn as unknown as typeof fetch,
          })
          await new Promise((resolve) => setTimeout(resolve, PULL_DELAY_MS))
          return []
        })
        dingtalkMocks.listDingTalkDepartmentUsers.mockImplementation(async () => {
          await requestDingTalkTransportJson({
            input: 'https://example.test/topapi/user/listsimple',
            init: { method: 'POST', body: '{}' },
            fallbackError: 'department user listing failed',
            kind: 'read',
            envelope: 'oapi',
            fetchFn: userFetchFn as unknown as typeof fetch,
          })
          await new Promise((resolve) => setTimeout(resolve, PULL_DELAY_MS))
          return { users: [], hasMore: false, nextCursor: null }
        })

        await syncDirectoryIntegration('dir-1', 'admin-1', 'scheduler')

        expect(dingtalkMocks.listDingTalkDepartmentUsers).toHaveBeenCalledTimes(1)
        expect(departmentFetchFn).toHaveBeenCalledTimes(2)
        expect(userFetchFn).toHaveBeenCalledTimes(2)
        const completion = txCalls.find((call) => call.text.includes("SET status = 'completed'"))
        const stats = JSON.parse(String(completion?.params?.[1])) as Record<string, unknown>
        for (const key of [
          'fetchDurationMs',
          'applyTransactionMs',
          'bcryptMsInTransaction',
          'externalPullRetryCount',
          'externalPullRetryFlowControlCount',
          'externalPullRetryHttp429Count',
          'externalPullRetryNetworkCount',
          'externalPullRetryOtherCount',
        ]) {
          expect(typeof stats[key], key).toBe('number')
        }
        // One retry per pull reached the run record, each in its own bucket — so dropping either
        // pull's observer wrapper cannot pass.
        expect(stats.externalPullRetryCount).toBe(2)
        expect(stats.externalPullRetryFlowControlCount).toBe(1)
        expect(stats.externalPullRetryHttp429Count).toBe(1)
        expect(stats.externalPullRetryNetworkCount).toBe(0)
        expect(stats.externalPullRetryOtherCount).toBe(0)
        // No admission ran (zero users) ⇒ nothing was hashed inside the transaction.
        expect(stats.bcryptMsInTransaction).toBe(0)
        // Both pulls were held for PULL_DELAY_MS, so neither a constant 0 nor a single pull's time
        // can pass (small slack for timer rounding); the per-phase values stay inside the whole-run
        // window.
        expect(stats.fetchDurationMs).toBeGreaterThanOrEqual(2 * PULL_DELAY_MS - 10)
        expect((stats.fetchDurationMs as number) + (stats.applyTransactionMs as number))
          .toBeLessThanOrEqual(stats.durationMs as number)
      } finally {
        randomSpy.mockRestore()
        warnSpy.mockRestore()
      }
    })
  })

  /**
   * R3 — preview must not double the shared DingTalk API quota the lease exists to bound.
   * `previewDirectorySyncIntegration` pulls the FULL directory just like apply does, so
   * running it while a real sync holds the lease consumes the same quota twice. Unlike
   * apply, preview never claims the lease (`claimDirectorySyncRun`/`INSERT INTO
   * directory_sync_runs` must never appear here) — it only asks `findActiveDirectorySyncRunId`
   * whether a run is currently `running` and refuses, read-only, before any outbound call.
   */
  describe('previewDirectorySyncIntegration refuses while a run holds the lease (R3)', () => {
    it('refuses a preview while a sync is running and never touches the DingTalk API', async () => {
      pgMocks.query
        // getIntegrationRow
        .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
        // findActiveDirectorySyncRunId
        .mockResolvedValueOnce({ rows: [{ id: 'run-active' }] })

      await expect(previewDirectorySyncIntegration('dir-1'))
        .rejects.toBeInstanceOf(DirectorySyncInProgressError)

      // The load-bearing assertion: the expensive, quota-consuming pull never started.
      expect(dingtalkMocks.fetchDingTalkAppAccessToken).not.toHaveBeenCalled()
      expect(dingtalkMocks.listDingTalkDepartments).not.toHaveBeenCalled()
    })

    it('carries the active run id, and never claims a lease of its own', async () => {
      pgMocks.query
        .mockResolvedValueOnce({ rows: [INTEGRATION_ROW] })
        .mockResolvedValueOnce({ rows: [{ id: 'run-active' }] })

      const error = await previewDirectorySyncIntegration('dir-1').catch((err) => err)
      expect(error).toBeInstanceOf(DirectorySyncInProgressError)
      expect((error as DirectorySyncInProgressError).activeRunId).toBe('run-active')
      expect((error as DirectorySyncInProgressError).statusCode).toBe(409)

      // Preview is read-only: it must never attempt to claim the lease it is checking.
      const insertedRunRow = pgMocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO directory_sync_runs'))
      expect(insertedRunRow).toBe(false)
    })

    it('proceeds with the pull when no run is active', async () => {
      pgMocks.query.mockImplementation(async (sql: unknown) => {
        const text = String(sql)
        if (text.includes('FROM directory_integrations')) return { rows: [INTEGRATION_ROW] }
        if (text.includes('FROM directory_sync_runs') && text.includes("status = 'running'")) return { rows: [] }
        if (text.includes('FROM directory_accounts')) return { rows: [] }
        return { rows: [] }
      })
      dingtalkMocks.fetchDingTalkAppAccessToken.mockResolvedValue('token')
      dingtalkMocks.listDingTalkDepartments.mockResolvedValue([])
      dingtalkMocks.getDingTalkDepartmentDetail.mockResolvedValue({ deptManagerUserIdList: [] })
      dingtalkMocks.listDingTalkDepartmentUsers.mockResolvedValue({ users: [], hasMore: false, nextCursor: null })

      const preview = await previewDirectorySyncIntegration('dir-1')

      expect(preview.integrationId).toBe('dir-1')
      // No active run this time — the pull proceeds.
      expect(dingtalkMocks.fetchDingTalkAppAccessToken).toHaveBeenCalled()
    })
  })
})
