/**
 * issue #5667 — the protection-rules router (mounted at /api/admin/safety/rules by
 * admin-routes.ts:2022) had ZERO authorization on its four write endpoints, and took the
 * rule creator + rate-limit identity from the spoofable `x-user-id` request header
 * (protection-rules.ts:21 and :113, with an `'anon'`/`'system'` fallback). Any authenticated
 * user could create/patch/delete protection rules under any identity they typed into a header.
 *
 * The writes are now platform-admin (requireAdminRole) and identity comes ONLY from req.user.id.
 * Reads (GET / and GET /:id) are deliberately unchanged.
 *
 * Mirrors snapshot-labels-authz.test.ts (GHSA-h8mf F2) — the sibling router mounted by the same
 * admin-routes block, hardened the same way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { isAdmin } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../src/db/pg', () => ({
  pool: null,
}))

vi.mock('../../src/services/ProtectionRuleService', () => ({
  protectionRuleService: {
    createRule: vi.fn().mockResolvedValue({ id: 'r1', rule_name: 'r' }),
    updateRule: vi.fn().mockResolvedValue({ id: 'r1', rule_name: 'r' }),
    deleteRule: vi.fn().mockResolvedValue(undefined),
    evaluateRules: vi.fn().mockResolvedValue({ matched: false }),
    listRules: vi.fn().mockResolvedValue([]),
    getRule: vi.fn().mockResolvedValue({ id: 'r1', rule_name: 'r' }),
  },
}))

import protectionRulesRouter from '../../src/routes/protection-rules'
import { protectionRuleService } from '../../src/services/ProtectionRuleService'

/** Mirrors RATE_LIMIT_MAX in src/routes/protection-rules.ts. */
const RATE_LIMIT_MAX = 10

/** A body that passes every validation branch in POST / so a 400 can never masquerade as a gate. */
const VALID_CREATE_BODY = {
  rule_name: 'block-critical',
  description: 'd',
  target_type: 'snapshot',
  conditions: { protection_level: 'critical' },
  effects: { action: 'block' },
}

function buildApp(user?: { id: string }): Express {
  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = user
      next()
    })
  }
  // Same mount base as admin-routes.ts:2022 (router.use('/safety/rules', ...) under /api/admin).
  app.use('/api/admin/safety/rules', protectionRulesRouter)
  return app
}

function writeServiceCalls(): number {
  const s = protectionRuleService as unknown as Record<string, { mock?: { calls: unknown[] } }>
  return (
    (s.createRule?.mock?.calls.length ?? 0) +
    (s.updateRule?.mock?.calls.length ?? 0) +
    (s.deleteRule?.mock?.calls.length ?? 0) +
    (s.evaluateRules?.mock?.calls.length ?? 0)
  )
}

const pinned = usePinnedServer()

describe('protection-rules router — platform-admin gate + identity (issue #5667)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isAdmin).mockResolvedValue(true)
  })

  it('non-admin -> 403 ADMIN_REQUIRED on all four write endpoints, NO service write called', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const app = buildApp({ id: 'u-nonadmin' })
    pinned.setApp(app)

    const create = await request(pinned.url())
      .post('/api/admin/safety/rules')
      .send(VALID_CREATE_BODY)
      .expect(403)
    expect(create.body.code).toBe('ADMIN_REQUIRED')

    const patch = await request(pinned.url())
      .patch('/api/admin/safety/rules/r1')
      .send({ priority: 5 })
      .expect(403)
    expect(patch.body.code).toBe('ADMIN_REQUIRED')

    const del = await request(pinned.url())
      .delete('/api/admin/safety/rules/r1')
      .expect(403)
    expect(del.body.code).toBe('ADMIN_REQUIRED')

    const evaluate = await request(pinned.url())
      .post('/api/admin/safety/rules/evaluate')
      .send({ entity_type: 'snapshot', entity_id: 's1', operation: 'delete' })
      .expect(403)
    expect(evaluate.body.code).toBe('ADMIN_REQUIRED')

    expect(writeServiceCalls()).toBe(0)
  })

  it('a forged `x-user-id: admin-looking` header does NOT buy a non-admin any write', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const app = buildApp({ id: 'u-nonadmin2' })
    pinned.setApp(app)

    await request(pinned.url())
      .post('/api/admin/safety/rules')
      .set('x-user-id', 'admin-looking')
      .send(VALID_CREATE_BODY)
      .expect(403)
    await request(pinned.url())
      .patch('/api/admin/safety/rules/r1')
      .set('x-user-id', 'admin-looking')
      .send({ priority: 5 })
      .expect(403)
    await request(pinned.url())
      .delete('/api/admin/safety/rules/r1')
      .set('x-user-id', 'admin-looking')
      .expect(403)
    await request(pinned.url())
      .post('/api/admin/safety/rules/evaluate')
      .set('x-user-id', 'admin-looking')
      .send({ entity_type: 'snapshot', entity_id: 's1', operation: 'delete' })
      .expect(403)

    expect(writeServiceCalls()).toBe(0)
    // The header must not even have been consulted as an identity source.
    expect(isAdmin).not.toHaveBeenCalledWith('admin-looking')
  })

  it('unauthenticated (no req.user) -> 403, no service write', async () => {
    const app = buildApp(undefined)
    pinned.setApp(app)
    const res = await request(pinned.url())
      .post('/api/admin/safety/rules')
      .send(VALID_CREATE_BODY)
      .expect(403)
    expect(res.body.code).toBe('ADMIN_REQUIRED')
    expect(writeServiceCalls()).toBe(0)
  })

  it('RBAC check failure (isAdmin throws) -> 503 fail-closed, no service write', async () => {
    vi.mocked(isAdmin).mockRejectedValue(new Error('rbac db down'))
    const app = buildApp({ id: 'u-503' })
    pinned.setApp(app)
    await request(pinned.url())
      .post('/api/admin/safety/rules')
      .send(VALID_CREATE_BODY)
      .expect(503)
    await request(pinned.url())
      .delete('/api/admin/safety/rules/r1')
      .expect(503)
    expect(writeServiceCalls()).toBe(0)
  })

  it('platform-admin -> POST / creates, and created_by is req.user.id, NOT the x-user-id header', async () => {
    const app = buildApp({ id: 'u-realadmin' })
    pinned.setApp(app)

    await request(pinned.url())
      .post('/api/admin/safety/rules')
      .set('x-user-id', 'u-spoofed')
      .send(VALID_CREATE_BODY)
      .expect(201)

    expect(protectionRuleService.createRule).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(protectionRuleService.createRule).mock.calls[0][0] as { created_by?: string }
    expect(arg.created_by).toBe('u-realadmin')
    expect(arg.created_by).not.toBe('u-spoofed')
    expect(arg.created_by).not.toBe('system')
  })

  it('platform-admin -> patch / delete / evaluate reach the service', async () => {
    const app = buildApp({ id: 'u-realadmin2' })
    pinned.setApp(app)

    await request(pinned.url())
      .patch('/api/admin/safety/rules/r1')
      .send({ priority: 5 })
      .expect(200)
    await request(pinned.url())
      .delete('/api/admin/safety/rules/r1')
      .expect(200)
    await request(pinned.url())
      .post('/api/admin/safety/rules/evaluate')
      .send({ entity_type: 'snapshot', entity_id: 's1', operation: 'delete' })
      .expect(200)

    expect(protectionRuleService.updateRule).toHaveBeenCalledTimes(1)
    expect(protectionRuleService.deleteRule).toHaveBeenCalledTimes(1)
    expect(protectionRuleService.evaluateRules).toHaveBeenCalledTimes(1)
  })

  it('the rate-limit bucket keys on the principal — flipping x-user-id cannot mint fresh quota', async () => {
    // RATE_LIMIT_MAX is 10 per (identity, method, path) per 60s. One principal fires 11 requests, each
    // with a DIFFERENT x-user-id header. While the key came from that header every request landed in its
    // own empty bucket and nothing was ever limited; keyed on req.user.id they share one bucket and the
    // quota bites. Asserting "a 429 appears" (not "the 11th is the first 429") keeps this stable under
    // vitest's CI `retry`, where a re-run starts with the bucket already full.
    const app = buildApp({ id: 'u-ratelimit' })
    pinned.setApp(app)

    const statuses: number[] = []
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      const res = await request(pinned.url())
        .get('/api/admin/safety/rules')
        .set('x-user-id', `disguise-${i}`)
      statuses.push(res.status)
    }

    expect(statuses).toContain(429)
  })

  it('reads are deliberately UNCHANGED — a non-admin can still GET / and GET /:id', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    const app = buildApp({ id: 'u-reader' })
    pinned.setApp(app)

    const list = await request(pinned.url()).get('/api/admin/safety/rules').expect(200)
    expect(list.body.success).toBe(true)
    const one = await request(pinned.url()).get('/api/admin/safety/rules/r1').expect(200)
    expect(one.body.success).toBe(true)

    expect(protectionRuleService.listRules).toHaveBeenCalledTimes(1)
    expect(protectionRuleService.getRule).toHaveBeenCalledTimes(1)
  })
})
