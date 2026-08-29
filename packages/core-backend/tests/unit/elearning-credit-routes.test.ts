import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningCreditRouter } from '../../src/routes/elearning-credit'
import {
  ElearningCreditSurfaceError,
  type ElearningCreditSurfaceDb,
  type GetElearningCreditWalletInput,
  type PublishElearningCreditRuleInput,
} from '../../src/services/elearning-credit-surface'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-credit-routes'
const ACTOR = 'actor-credit-routes'
const TARGET = 'target-credit-routes'
const RULE_ID = '11111111-1111-4111-8111-111111111111'
const DECISION_ID = '22222222-2222-4222-8222-222222222222'
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

function makeApp(over: {
  env?: NodeJS.ProcessEnv
  viewer?: string | null
  org?: string | null
  adminAllowed?: boolean
  readAllowed?: boolean
  publishError?: ElearningCreditSurfaceError
  walletError?: ElearningCreditSurfaceError
} = {}) {
  const publishCalls: PublishElearningCreditRuleInput[] = []
  const walletCalls: GetElearningCreditWalletInput[] = []
  let adminGuardCalls = 0
  let readGuardCalls = 0
  const env = over.env ?? { ...FLAG_ON }
  const router = createElearningCreditRouter({
    db: dummyDb(),
    env,
    viewerId: () => over.viewer === undefined ? ACTOR : over.viewer,
    orgId: () => over.org === undefined ? ORG : over.org,
    adminGuard: (_req, res, next) => {
      adminGuardCalls += 1
      if (over.adminAllowed === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    readGuard: (_req, res, next) => {
      readGuardCalls += 1
      if (over.readAllowed === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    listElearningCreditRules: async () => [{
      behavior: 'pass_exam',
      ruleId: RULE_ID,
      version: 3,
      points: 10,
      dailyCap: 20,
      timeZone: 'Asia/Shanghai',
      createdAt: '2026-08-29T00:00:00.000Z',
      requestHash: 'must-not-leak',
    } as never],
    publishElearningCreditRule: async (_db, input) => {
      publishCalls.push(input)
      if (over.publishError) throw over.publishError
      return {
        behavior: 'pass_exam',
        ruleId: RULE_ID,
        version: 3,
        points: 10,
        dailyCap: 20,
        timeZone: 'Asia/Shanghai',
        createdAt: '2026-08-29T00:00:00.000Z',
        duplicate: false,
        requestHash: 'must-not-leak',
        actorId: 'must-not-leak',
      } as never
    },
    getElearningCreditWallet: async (_db, input) => {
      walletCalls.push(input)
      if (over.walletError) throw over.walletError
      return {
        userId: input.userId,
        balancePoints: 10,
        items: [{
          decisionId: DECISION_ID,
          behavior: 'pass_exam',
          awardedPoints: 10,
          status: 'awarded',
          occurredAt: '2026-08-29T00:00:00.000Z',
          createdAt: '2026-08-29T00:00:01.000Z',
          requestHash: 'must-not-leak',
          effectKey: 'must-not-leak',
          rawReference: { secret: true },
        }],
        nextCursor: null,
      } as never
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return {
    api: request(pinned.url()),
    env,
    publishCalls,
    walletCalls,
    guardCounts: () => ({ adminGuardCalls, readGuardCalls }),
    mounted: router !== null,
  }
}

describe('e-learning credit routes', () => {
  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_INCENTIVE_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'TRUE', ELEARNING_INCENTIVE_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_INCENTIVE_ENABLED: ' true' },
  ])('does not mount unless both flags are exact true %#', (env) => {
    expect(makeApp({ env }).mounted).toBe(false)
  })

  it('lists rules behind admin RBAC with a closed response shape', async () => {
    const harness = makeApp()
    const response = await harness.api.get('/api/elearning/admin/credit-rules')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [{
        behavior: 'pass_exam',
        ruleId: RULE_ID,
        version: 3,
        points: 10,
        dailyCap: 20,
        timeZone: 'Asia/Shanghai',
        createdAt: '2026-08-29T00:00:00.000Z',
      }],
    })
    expect(JSON.stringify(response.body)).not.toMatch(/requestHash|must-not-leak/)
    expect(harness.guardCounts()).toEqual({ adminGuardCalls: 1, readGuardCalls: 0 })
  })

  it('publishes with server-derived actor/org and exact request keys', async () => {
    const harness = makeApp()
    const response = await harness.api
      .post('/api/elearning/admin/credit-rules')
      .send({
        requestId: 'request-route-1',
        behavior: 'pass_exam',
        points: 10,
        dailyCap: 20,
        timeZone: 'Asia/Shanghai',
      })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      behavior: 'pass_exam',
      ruleId: RULE_ID,
      version: 3,
      points: 10,
      dailyCap: 20,
      timeZone: 'Asia/Shanghai',
      createdAt: '2026-08-29T00:00:00.000Z',
    })
    expect(harness.publishCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      requestId: 'request-route-1',
      behavior: 'pass_exam',
      points: 10,
      dailyCap: 20,
      timeZone: 'Asia/Shanghai',
    }])

    const injected = await harness.api
      .post('/api/elearning/admin/credit-rules')
      .send({
        requestId: 'request-route-2',
        behavior: 'pass_exam',
        points: 10,
        dailyCap: 20,
        timeZone: 'Asia/Shanghai',
        actorId: 'attacker',
      })
    expect(injected.status).toBe(400)
    expect(harness.publishCalls).toHaveLength(1)
  })

  it('returns a values-free 409 for an idempotency conflict', async () => {
    const harness = makeApp({
      publishError: new ElearningCreditSurfaceError('conflict'),
    })
    const response = await harness.api
      .post('/api/elearning/admin/credit-rules')
      .send({
        requestId: 'request-route-conflict',
        behavior: 'pass_exam',
        points: 10,
        dailyCap: 20,
        timeZone: 'UTC',
      })
    expect(response.status).toBe(409)
    expect(response.body).toEqual({ error: 'conflict' })
    expect(JSON.stringify(response.body)).not.toContain('request-route-conflict')
  })

  it('reads only the authenticated learner wallet and strips persistence-only fields', async () => {
    const harness = makeApp()
    const response = await harness.api.get('/api/elearning/credits/wallet?limit=10')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      userId: ACTOR,
      balancePoints: 10,
      items: [{
        decisionId: DECISION_ID,
        behavior: 'pass_exam',
        awardedPoints: 10,
        status: 'awarded',
        occurredAt: '2026-08-29T00:00:00.000Z',
        createdAt: '2026-08-29T00:00:01.000Z',
      }],
      nextCursor: null,
    })
    expect(harness.walletCalls).toEqual([{ orgId: ORG, userId: ACTOR, limit: 10 }])
    expect(JSON.stringify(response.body)).not.toMatch(/requestHash|effectKey|rawReference|secret/)

    const override = await harness.api.get(
      '/api/elearning/credits/wallet?userId=another-user',
    )
    expect(override.status).toBe(400)
    expect(harness.walletCalls).toHaveLength(1)
  })

  it('allows only admin RBAC to query one same-org target wallet', async () => {
    const denied = makeApp({ adminAllowed: false })
    expect((await denied.api.get(
      `/api/elearning/admin/credits/wallet?userId=${TARGET}`,
    )).status).toBe(403)
    expect(denied.walletCalls).toHaveLength(0)

    const allowed = makeApp()
    const response = await allowed.api.get(
      `/api/elearning/admin/credits/wallet?userId=${TARGET}&limit=5`,
    )
    expect(response.status).toBe(200)
    expect(allowed.walletCalls).toEqual([{ orgId: ORG, userId: TARGET, limit: 5 }])
  })

  it('fails context and runtime rechecks before any product call', async () => {
    expect((await makeApp({ viewer: null }).api.get(
      '/api/elearning/credits/wallet',
    )).status).toBe(401)
    expect((await makeApp({ org: null }).api.get(
      '/api/elearning/credits/wallet',
    )).status).toBe(403)

    const harness = makeApp()
    harness.env.ELEARNING_INCENTIVE_ENABLED = 'false'
    const response = await harness.api.get('/api/elearning/credits/wallet')
    expect(response.status).toBe(404)
    expect(harness.walletCalls).toHaveLength(0)
    expect(harness.guardCounts()).toEqual({ adminGuardCalls: 0, readGuardCalls: 0 })
  })
})
