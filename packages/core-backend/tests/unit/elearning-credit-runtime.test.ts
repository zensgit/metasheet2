import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import type { ElearningCreditSurfaceDb } from '../../src/services/elearning-credit-surface'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-credit-runtime'
const ACTOR = 'actor-credit-runtime'
const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
} as NodeJS.ProcessEnv

const pinned = usePinnedServer()

function dummyDb(): ElearningCreditSurfaceDb {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (run) => run({
      query: async () => ({ rows: [], rowCount: 0 }),
    }),
  }
}

describe('e-learning credit runtime', () => {
  it('mounts the incentive router independently without exposing content routes', async () => {
    const walletCalls: string[] = []
    const adjustmentCalls: string[] = []
    const runtime = createElearningPilotRuntime({
      db: dummyDb(),
      env: { ...FLAG_ON },
      authenticate: (_req, _res, next) => next(),
      viewerId: () => ACTOR,
      orgId: () => ORG,
      readGuard: (_req, _res, next) => next(),
      adminGuard: (_req, _res, next) => next(),
      getElearningCreditWallet: async (_db, input) => {
        walletCalls.push(input.userId)
        return {
          userId: input.userId,
          balancePoints: 0,
          items: [],
          nextCursor: null,
        }
      },
      adjustElearningCredit: async (_db, input) => {
        adjustmentCalls.push(input.userId as string)
        return {
          adjustmentId: '11111111-1111-4111-8111-111111111111',
          userId: input.userId as string,
          points: input.points as number,
          balancePoints: 5,
          createdAt: '2026-08-29T00:00:00.000Z',
          duplicate: false,
        }
      },
    })
    expect(runtime).not.toBeNull()
    const app = express()
    app.use(runtime!.router)
    pinned.setApp(app)
    const api = request(pinned.url())

    const wallet = await api.get('/api/elearning/credits/wallet')
    expect(wallet.status).toBe(200)
    expect(wallet.body).toEqual({
      userId: ACTOR,
      balancePoints: 0,
      items: [],
      nextCursor: null,
    })
    expect(walletCalls).toEqual([ACTOR])
    const adjustment = await api
      .post('/api/elearning/admin/credits/adjustments')
      .send({
        requestId: 'request-runtime-adjust',
        userId: ACTOR,
        points: 5,
        reason: 'runtime adjustment',
      })
    expect(adjustment.status).toBe(200)
    expect(adjustment.body).toEqual({
      adjustmentId: '11111111-1111-4111-8111-111111111111',
      userId: ACTOR,
      points: 5,
      balancePoints: 5,
      createdAt: '2026-08-29T00:00:00.000Z',
    })
    expect(adjustmentCalls).toEqual([ACTOR])
    expect((await api.get('/api/elearning/courses')).status).toBe(404)
  })

  it('does not mount when either master or incentive is not exact true', () => {
    expect(createElearningPilotRuntime({
      db: dummyDb(),
      env: { ELEARNING_ENABLED: 'true' },
    })).toBeNull()
    expect(createElearningPilotRuntime({
      db: dummyDb(),
      env: { ELEARNING_INCENTIVE_ENABLED: 'true' },
    })).toBeNull()
  })
})
