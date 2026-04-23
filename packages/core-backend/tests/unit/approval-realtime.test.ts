import { describe, expect, it, vi } from 'vitest'
import {
  buildApprovalCountsUpdatedPayload,
  computeApprovalPendingCounts,
  publishApprovalCountsUpdate,
  type ApprovalCountQuery,
} from '../../src/services/approval-realtime'

describe('approval realtime count publisher', () => {
  it('computes pending and unread counts with user, role, and source filters', async () => {
    const query = vi.fn<ApprovalCountQuery>(async (_sql, params) => {
      expect(params).toEqual(['u1', ['finance'], 'platform'])
      return { rows: [{ count: '4', unread_count: '2' }] }
    })

    const counts = await computeApprovalPendingCounts(query, {
      userId: 'u1',
      roles: ['finance'],
      sourceSystem: 'platform',
    })

    expect(counts).toEqual({ count: 4, unreadCount: 2 })
    expect(query.mock.calls[0][0]).toContain(`COALESCE(i.source_system, 'platform') = $3`)
  })

  it('publishes all/platform/plm count snapshots to the current user room', async () => {
    const query = vi.fn<ApprovalCountQuery>(async (_sql, params) => {
      const sourceSystem = params[2]
      if (sourceSystem === 'platform') return { rows: [{ count: '2', unread_count: '1' }] }
      if (sourceSystem === 'plm') return { rows: [{ count: '1', unread_count: '1' }] }
      return { rows: [{ count: '3', unread_count: '2' }] }
    })
    const payload = await buildApprovalCountsUpdatedPayload({
      userId: 'u1',
      roles: ['finance'],
      reason: 'mark-read',
      query,
    })

    expect(payload).toMatchObject({
      count: 3,
      unreadCount: 2,
      sourceSystem: 'all',
      reason: 'mark-read',
      countsBySourceSystem: {
        all: { count: 3, unreadCount: 2 },
        platform: { count: 2, unreadCount: 1 },
        plm: { count: 1, unreadCount: 1 },
      },
    })
  })

  it('uses the authenticated user room and suppresses publish failures', async () => {
    const broadcastTo = vi.fn()
    const warn = vi.fn()
    const query = vi.fn<ApprovalCountQuery>(async () => ({ rows: [{ count: '0', unread_count: '0' }] }))

    await publishApprovalCountsUpdate({
      collabService: { broadcastTo },
      logger: { warn },
      userId: 'u1',
      reason: 'mark-all-read',
      query,
    })

    expect(broadcastTo).toHaveBeenCalledWith('auth-user:u1', 'approval:counts-updated', expect.objectContaining({
      count: 0,
      unreadCount: 0,
      reason: 'mark-all-read',
    }))
    expect(warn).not.toHaveBeenCalled()
  })
})
