import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const state = vi.hoisted(() => ({
  actionOutcome: {
    status: 'ok',
    summary: {
      deliveryId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      deliveryKind: 'interactive_card',
      cardState: 'acted',
      sendStatus: 'sent',
      nodeKey: 'approval_1',
      recipientUserId: 'user-1',
      viewerIsRecipient: true,
      actionable: false,
      approval: {
        instanceId: 'approval-1',
        title: null,
        requestNo: null,
        status: 'rejected',
        currentNodeKey: null,
        rejectCommentRequired: true,
      },
      actedAction: 'reject',
      actedAt: '2026-08-18T04:00:00.000Z',
    },
  },
  execute: vi.fn(),
  update: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  pool: {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(),
  },
}))

vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      id: 'user-1',
      name: 'Route Approver',
      roles: [],
      permissions: ['*:*'],
    } as never
    next()
  },
}))

vi.mock('../../src/rbac/rbac', () => ({
  rbacGuard: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  rbacGuardAny: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

vi.mock('../../src/services/ApprovalCardDeliveryAction', () => ({
  executeApprovalActionFromCardDelivery: state.execute,
  getApprovalCardDeliverySummary: vi.fn(),
}))

vi.mock('../../src/integrations/dingtalk/interactive-card-update', () => ({
  applyDingTalkApprovalCardWebTerminalUpdate: state.update,
}))

const pinned = usePinnedServer()

describe('approval-card web terminal route seam', () => {
  let app: Express

  beforeEach(async () => {
    vi.resetModules()
    state.execute.mockReset().mockResolvedValue(state.actionOutcome)
    state.update.mockReset().mockResolvedValue({
      status: 'failed',
      outTrackId: state.actionOutcome.summary.deliveryId,
      reason: 'Error',
    })
    const { approvalsRouter } = await import('../../src/routes/approvals')
    app = express()
    app.use(express.json())
    app.use(approvalsRouter())
  })

  it('runs the failure-isolated card update after reject and preserves the successful HTTP result', async () => {
    pinned.setApp(app)
    const response = await request(pinned.url())
      .post(`/api/approval-card-deliveries/${state.actionOutcome.summary.deliveryId}/actions`)
      .send({ decision: 'reject', comment: '材料不完整', t: 'a'.repeat(32) })

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      ok: true,
      data: {
        approval: { status: 'rejected' },
        actedAction: 'reject',
      },
    })
    expect(state.execute).toHaveBeenCalledTimes(1)
    expect(state.update).toHaveBeenCalledTimes(1)
    expect(state.update).toHaveBeenCalledWith(state.actionOutcome)
    expect(state.execute.mock.invocationCallOrder[0]).toBeLessThan(state.update.mock.invocationCallOrder[0])
  })
})
