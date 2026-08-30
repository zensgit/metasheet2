import { describe, expect, it, vi } from 'vitest'
import { dispatchApprovalDepartureTransfersForRun } from '../../src/approvals/approval-departure-transfer-dispatch'
import type { ApprovalDepartureManagerContext } from '../../src/services/ApprovalDirectoryOrg'

const CONTEXT: ApprovalDepartureManagerContext = {
  integrationId: 'integration-a',
  requesterExternalId: 'external-departed',
  primaryDepartmentExternalId: 'dept-a',
}

describe('dispatchApprovalDepartureTransfersForRun', () => {
  it('consumes only exact applied user_changed effects and passes the post-commit manager to the writer', async () => {
    const query = vi.fn(async () => ({
      rows: [{ directory_account_id: 'account-a', local_user_id: 'local-departed' }],
    }))
    const resolveManager = vi.fn(async () => 'local-manager')
    const applyApprovalDepartureTransfer = vi.fn(async () => ({
      transferred: [],
      noManagerResolved: [],
      skipped: [],
    }))

    const result = await dispatchApprovalDepartureTransfersForRun({
      runId: 'run-a',
      integrationId: 'integration-a',
      managerContexts: new Map([['account-a', CONTEXT]]),
    }, {
      query,
      resolveManager,
      approvals: { applyApprovalDepartureTransfer },
    })

    const [sql, params] = query.mock.calls[0]
    expect(sql).toContain("event.event_origin = 'sync'")
    expect(sql).toContain("event.status = 'applied'")
    expect(sql).toContain("effect.effect_type = 'user_changed'")
    expect(sql).toContain("effect.status = 'applied'")
    expect(params).toEqual(['run-a', 'integration-a'])
    expect(resolveManager).toHaveBeenCalledWith(CONTEXT, query)
    expect(applyApprovalDepartureTransfer).toHaveBeenCalledWith('local-departed', {
      resolvedManagerId: 'local-manager',
    })
    expect(result).toEqual({
      signalCount: 1,
      dispatchedCount: 1,
      failedCount: 0,
      unresolvedContextCount: 0,
    })
  })

  it('applies the fail-closed no-manager outcome when the captured source context is missing', async () => {
    const query = vi.fn(async () => ({
      rows: [{ directory_account_id: 'account-missing', local_user_id: 'local-departed' }],
    }))
    const applyApprovalDepartureTransfer = vi.fn(async () => ({
      transferred: [],
      noManagerResolved: [],
      skipped: [],
    }))

    const result = await dispatchApprovalDepartureTransfersForRun({
      runId: 'run-a',
      integrationId: 'integration-a',
      managerContexts: new Map(),
    }, {
      query,
      resolveManager: vi.fn(),
      approvals: { applyApprovalDepartureTransfer },
    })

    expect(applyApprovalDepartureTransfer).toHaveBeenCalledWith('local-departed', {
      resolvedManagerId: null,
    })
    expect(result.unresolvedContextCount).toBe(1)
    expect(result.dispatchedCount).toBe(1)
  })

  it('rejects a captured manager context from another integration', async () => {
    const query = vi.fn(async () => ({
      rows: [{ directory_account_id: 'account-a', local_user_id: 'local-departed' }],
    }))
    const resolveManager = vi.fn(async () => 'local-manager')
    const applyApprovalDepartureTransfer = vi.fn(async () => ({
      transferred: [],
      noManagerResolved: [],
      skipped: [],
    }))

    const result = await dispatchApprovalDepartureTransfersForRun({
      runId: 'run-a',
      integrationId: 'integration-a',
      managerContexts: new Map([['account-a', {
        ...CONTEXT,
        integrationId: 'integration-b',
      }]]),
    }, {
      query,
      resolveManager,
      approvals: { applyApprovalDepartureTransfer },
    })

    expect(resolveManager).not.toHaveBeenCalled()
    expect(applyApprovalDepartureTransfer).toHaveBeenCalledWith('local-departed', {
      resolvedManagerId: null,
    })
    expect(result.unresolvedContextCount).toBe(1)
  })

  it('counts a valid source context whose live manager no longer resolves as unresolved', async () => {
    const query = vi.fn(async () => ({
      rows: [{ directory_account_id: 'account-a', local_user_id: 'local-departed' }],
    }))
    const applyApprovalDepartureTransfer = vi.fn(async () => ({
      transferred: [],
      noManagerResolved: [],
      skipped: [],
    }))

    const result = await dispatchApprovalDepartureTransfersForRun({
      runId: 'run-a',
      integrationId: 'integration-a',
      managerContexts: new Map([['account-a', CONTEXT]]),
    }, {
      query,
      resolveManager: vi.fn(async () => undefined),
      approvals: { applyApprovalDepartureTransfer },
    })

    expect(applyApprovalDepartureTransfer).toHaveBeenCalledWith('local-departed', {
      resolvedManagerId: null,
    })
    expect(result.unresolvedContextCount).toBe(1)
  })

  it('isolates one failed approval write and continues the remaining durable signals', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { directory_account_id: 'account-a', local_user_id: 'local-a' },
        { directory_account_id: 'account-b', local_user_id: 'local-b' },
      ],
    }))
    const applyApprovalDepartureTransfer = vi.fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ transferred: [], noManagerResolved: [], skipped: [] })

    const result = await dispatchApprovalDepartureTransfersForRun({
      runId: 'run-a',
      integrationId: 'integration-a',
      managerContexts: new Map([
        ['account-a', CONTEXT],
        ['account-b', CONTEXT],
      ]),
    }, {
      query,
      resolveManager: vi.fn(async () => 'local-manager'),
      approvals: { applyApprovalDepartureTransfer },
    })

    expect(applyApprovalDepartureTransfer).toHaveBeenCalledTimes(2)
    expect(result).toEqual({
      signalCount: 2,
      dispatchedCount: 1,
      failedCount: 1,
      unresolvedContextCount: 0,
    })
  })

  it('reports a writer-captured per-instance error as unresolved durable work', async () => {
    const query = vi.fn(async () => ({
      rows: [{ directory_account_id: 'account-a', local_user_id: 'local-departed' }],
    }))
    const applyApprovalDepartureTransfer = vi.fn(async () => ({
      transferred: [],
      noManagerResolved: [],
      skipped: [{ id: 'instance-a', reason: 'error' as const }],
    }))

    const result = await dispatchApprovalDepartureTransfersForRun({
      runId: 'run-a',
      integrationId: 'integration-a',
      managerContexts: new Map([['account-a', CONTEXT]]),
    }, {
      query,
      resolveManager: vi.fn(async () => 'local-manager'),
      approvals: { applyApprovalDepartureTransfer },
    })

    expect(result).toEqual({
      signalCount: 1,
      dispatchedCount: 0,
      failedCount: 1,
      unresolvedContextCount: 0,
    })
  })

  it('counts a handled business skip as a completed durable signal', async () => {
    const query = vi.fn(async () => ({
      rows: [{ directory_account_id: 'account-a', local_user_id: 'local-departed' }],
    }))
    const applyApprovalDepartureTransfer = vi.fn(async () => ({
      transferred: [],
      noManagerResolved: [],
      skipped: [{ id: 'instance-a', reason: 'target-is-requester' as const }],
    }))

    const result = await dispatchApprovalDepartureTransfersForRun({
      runId: 'run-a',
      integrationId: 'integration-a',
      managerContexts: new Map([['account-a', CONTEXT]]),
    }, {
      query,
      resolveManager: vi.fn(async () => 'local-manager'),
      approvals: { applyApprovalDepartureTransfer },
    })

    expect(result).toEqual({
      signalCount: 1,
      dispatchedCount: 1,
      failedCount: 0,
      unresolvedContextCount: 0,
    })
  })
})
