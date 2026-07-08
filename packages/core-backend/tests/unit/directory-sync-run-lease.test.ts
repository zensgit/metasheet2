import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  DIRECTORY_SYNC_LEASE_TTL_MINUTES,
  DirectorySyncInProgressError,
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

function uniqueViolation() {
  const error = new Error('duplicate key value violates unique constraint') as Error & { code: string }
  error.code = '23505'
  return error
}

/**
 * DT-HARDEN-05 — the sync lease.
 *
 * syncDirectoryIntegration inserts its run row and then pulls the entire DingTalk
 * directory before opening its apply transaction. A transaction-scoped lock around the
 * apply would not protect that pull. The lease is therefore claimed on the run row,
 * BEFORE the first outbound call.
 */
describe('DT-HARDEN-05 directory sync run lease', () => {
  beforeEach(() => {
    pgMocks.query.mockReset()
    pgMocks.transaction.mockReset()
    for (const mock of Object.values(dingtalkMocks)) mock.mockReset()
  })

  it('has a bounded, positive lease TTL', () => {
    expect(DIRECTORY_SYNC_LEASE_TTL_MINUTES).toBeGreaterThan(0)
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
    expect(String(reclaimCall[0])).toContain('started_at <')
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
    it('scopes to a single integration when asked', async () => {
      pgMocks.query.mockResolvedValueOnce({ rows: [{ id: 'r1' }] })
      const reclaimed = await reclaimStaleDirectorySyncRuns('dir-1')
      expect(reclaimed).toBe(1)
      const [sql, params] = pgMocks.query.mock.calls[0]
      expect(String(sql)).toContain('integration_id = $2')
      expect(params).toEqual([DIRECTORY_SYNC_LEASE_TTL_MINUTES, 'dir-1'])
    })

    it('sweeps every integration at boot when unscoped', async () => {
      pgMocks.query.mockResolvedValueOnce({ rows: [] })
      const reclaimed = await reclaimStaleDirectorySyncRuns()
      expect(reclaimed).toBe(0)
      const [sql, params] = pgMocks.query.mock.calls[0]
      expect(String(sql)).not.toContain('integration_id = $2')
      expect(params).toEqual([DIRECTORY_SYNC_LEASE_TTL_MINUTES])
    })
  })
})
