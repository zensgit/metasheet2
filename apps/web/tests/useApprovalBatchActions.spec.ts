import { describe, expect, it, vi } from 'vitest'
import { runApprovalBatchAction } from '../src/approvals/useApprovalBatchActions'
import type { ApprovalActionRequest } from '../src/types/approval'

describe('runApprovalBatchAction', () => {
  it('returns an empty manifest and never dispatches for an empty selection', async () => {
    const dispatch = vi.fn()
    const result = await runApprovalBatchAction([], () => ({ action: 'approve' }), dispatch)
    expect(result).toEqual({ succeeded: [], failed: [] })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches the per-id request for every unique id and reports all succeeded', async () => {
    const seen: Array<{ id: string; req: ApprovalActionRequest }> = []
    const dispatch = vi.fn(async (id: string, req: ApprovalActionRequest) => { seen.push({ id, req }) })
    const result = await runApprovalBatchAction(
      ['a', 'b', 'a', 'c'], // duplicate 'a' is de-duped
      (id) => ({ action: 'reject', comment: `no-${id}` }),
      dispatch,
    )
    expect(result.succeeded.sort()).toEqual(['a', 'b', 'c'])
    expect(result.failed).toEqual([])
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(seen.find((s) => s.id === 'b')?.req).toEqual({ action: 'reject', comment: 'no-b' })
  })

  it('isolates per-row failures: one rejection does NOT abort the batch and lands in the manifest', async () => {
    const dispatch = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('APPROVAL_THRESHOLD_UNREACHABLE')
      if (id === 'bad2') throw 'plain string failure'
    })
    const result = await runApprovalBatchAction(
      ['ok1', 'bad', 'ok2', 'bad2', 'ok3'],
      () => ({ action: 'approve' }),
      dispatch,
    )
    expect(result.succeeded.sort()).toEqual(['ok1', 'ok2', 'ok3'])
    expect(result.failed).toContainEqual({ id: 'bad', message: 'APPROVAL_THRESHOLD_UNREACHABLE' })
    expect(result.failed).toContainEqual({ id: 'bad2', message: 'plain string failure' })
    expect(dispatch).toHaveBeenCalledTimes(5)
  })

  it('bounds concurrency: never more than `concurrency` dispatches are in flight at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const dispatch = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
    })
    await runApprovalBatchAction(
      ['1', '2', '3', '4', '5', '6'],
      () => ({ action: 'approve' }),
      dispatch,
      { concurrency: 2 },
    )
    expect(maxInFlight).toBe(2)
    expect(dispatch).toHaveBeenCalledTimes(6)
  })
})
