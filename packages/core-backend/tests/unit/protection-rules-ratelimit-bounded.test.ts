/**
 * ADM-18 — the protection-rules in-memory rate-limit table grew without bound.
 *
 * Before: the bucket key carried the raw `req.path` (`${userId}:${method}:${req.path}`), and the
 * module held no delete, no timer and no ceiling — a bucket was only ever pruned when the SAME key
 * came back. The limiter is a `router.use` registered ahead of requireAdminRole on purpose
 * (#5710 / #5678 ordering note), so any authenticated non-admin could open one bucket per made-up
 * `GET /:id` and keep them all resident for the process lifetime.
 *
 * Three properties are pinned here:
 *   (1) the key space is bounded — N distinct ids collapse onto one `/:id` bucket, and the table
 *       never exceeds RATE_LIMIT_MAX_KEYS even with more distinct principals than that;
 *   (2) buckets whose newest timestamp fell out of the window are reclaimed by the lazy sweep;
 *   (3) the behaviour the ops probe depends on is unchanged — 11 quick GETs on the collection still
 *       end in 429 (scripts/verify-sprint2-staging.sh:155-167), and `/` and `/:id` stay separate
 *       buckets so the narrowing did not silently collapse every route into one quota.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
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

import protectionRulesRouter, {
  RATE_LIMIT_MAX_KEYS,
  protectionRulesRateLimit,
  _rateLimitStoreForTests,
  _resetRateLimitForTests,
} from '../../src/routes/protection-rules'

/** Mirrors RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS in src/routes/protection-rules.ts. */
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60_000

function buildApp(user?: { id: string }): Express {
  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req, _res, next) => {
      ;(req as express.Request & { user?: { id: string } }).user = user
      next()
    })
  }
  // Same mount base as admin-routes.ts (router.use('/safety/rules', ...) under /api/admin).
  app.use('/api/admin/safety/rules', protectionRulesRouter)
  return app
}

/**
 * Drive the exported limiter directly with synthetic req/res objects. Pure in-memory: it lets the
 * ceiling be exercised with tens of thousands of distinct principals without tens of thousands of
 * sockets, and it is the very function `router.use` is registered with.
 */
function callLimiter(userId: string, method = 'GET', path = '/'): { nexted: boolean; status: number | null } {
  let nexted = false
  let status: number | null = null
  const req = { user: { id: userId }, method, path, ip: '127.0.0.1' } as unknown as Request
  const res = {
    status(code: number) {
      status = code
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
  const next = (() => {
    nexted = true
  }) as unknown as NextFunction
  protectionRulesRateLimit(req, res, next)
  return { nexted, status }
}

const pinned = usePinnedServer()

/** Clock spy for the expiry spec; torn down in afterEach even if that spec throws first. */
let nowSpy: ReturnType<typeof vi.spyOn> | null = null

describe('protection-rules rate-limit table is bounded (ADM-18)', () => {
  beforeEach(() => {
    vi.mocked(isAdmin).mockResolvedValue(true)
    _resetRateLimitForTests()
  })

  afterEach(() => {
    // Only the clock spy is torn down here: a blanket restoreAllMocks() would also strip the
    // implementations the vi.mock factories above installed (isAdmin / the service), so a later
    // spec would silently get 403/500 instead of the path under test.
    nowSpy?.mockRestore()
    nowSpy = null
    _resetRateLimitForTests()
  })

  it('(1a) N distinct /:id requests collapse onto ONE bucket — the key no longer carries req.path', async () => {
    const app = buildApp({ id: 'u-keyspace' })
    pinned.setApp(app)

    const distinctIds = 200
    for (let i = 0; i < distinctIds; i++) {
      // Status is irrelevant here (the quota bites after 10); what matters is the table shape.
      await request(pinned.url()).get(`/api/admin/safety/rules/rule-${i}`)
    }

    const store = _rateLimitStoreForTests()
    // With the raw path in the key this was `distinctIds` buckets and grew forever.
    expect(store.size).toBe(1)
    const keys = [...store.keys()]
    expect(keys[0]).toBe('u-keyspace:GET:/:id')
    expect(keys.some(k => k.includes('rule-'))).toBe(false)
  })

  it('(1b) the table never exceeds RATE_LIMIT_MAX_KEYS, and the overflow request fails OPEN', () => {
    // One fresh principal per call: every call wants a brand-new bucket, so this is the worst case
    // for the ceiling. Without a ceiling the map would simply reach overflowBy above the max.
    const overflowBy = 50
    const results: Array<{ nexted: boolean; status: number | null }> = []
    for (let i = 0; i < RATE_LIMIT_MAX_KEYS + overflowBy; i++) {
      results.push(callLimiter(`u-cap-${i}`))
    }

    const store = _rateLimitStoreForTests()
    expect(store.size).toBeLessThanOrEqual(RATE_LIMIT_MAX_KEYS)
    expect(store.size).toBe(RATE_LIMIT_MAX_KEYS)
    // Fail-open: an overflow caller is passed through unmetered, never 429'd. requireAdminRole is
    // the security boundary, not this table.
    const overflow = results.slice(RATE_LIMIT_MAX_KEYS)
    expect(overflow).toHaveLength(overflowBy)
    expect(overflow.every(r => r.nexted)).toBe(true)
    expect(overflow.every(r => r.status === null)).toBe(true)
  })

  it('(2) buckets whose window has passed are reclaimed by the lazy sweep on the next request', async () => {
    let fakeNow = 1_700_000_000_000
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)

    const store = _rateLimitStoreForTests()
    // Three principals park one bucket each.
    for (const id of ['u-expire-1', 'u-expire-2', 'u-expire-3']) {
      pinned.setApp(buildApp({ id }))
      await request(pinned.url()).get('/api/admin/safety/rules')
    }
    expect(store.size).toBe(3)

    // Two windows later every one of those timestamps is out of the window.
    fakeNow += RATE_LIMIT_WINDOW_MS * 2 + 1

    pinned.setApp(buildApp({ id: 'u-expire-4' }))
    await request(pinned.url()).get('/api/admin/safety/rules')

    // Without the sweep this is 4: the three dead buckets are only ever pruned if their own key
    // comes back, which for a walk-away caller never happens.
    expect(store.size).toBe(1)
    expect([...store.keys()]).toEqual(['u-expire-4:GET:/'])
  })

  it('(3a) regression: 11 quick GETs on the collection still end in 429 (staging probe)', async () => {
    const app = buildApp({ id: 'u-probe' })
    pinned.setApp(app)

    const statuses: number[] = []
    for (let i = 0; i < RATE_LIMIT_MAX + 1; i++) {
      const res = await request(pinned.url()).get('/api/admin/safety/rules')
      statuses.push(res.status)
    }

    // scripts/verify-sprint2-staging.sh:155-167 reads the LAST of 11 and passes only on 429.
    expect(statuses[RATE_LIMIT_MAX]).toBe(429)
    expect(statuses.slice(0, RATE_LIMIT_MAX).some(s => s === 429)).toBe(false)
  })

  it('(3b) the narrowing keeps `/` and `/:id` as separate buckets — it did not collapse to user+method', async () => {
    const app = buildApp({ id: 'u-shapes' })
    pinned.setApp(app)

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      await request(pinned.url()).get('/api/admin/safety/rules')
    }
    await request(pinned.url()).get('/api/admin/safety/rules').expect(429)

    // A different route shape under the same principal + method still has its own quota.
    await request(pinned.url()).get('/api/admin/safety/rules/r1').expect(200)

    const keys = [...(_rateLimitStoreForTests().keys())].sort()
    expect(keys).toEqual(['u-shapes:GET:/', 'u-shapes:GET:/:id'])
  })
})
