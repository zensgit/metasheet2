/**
 * Policy tests for the shared API path policy (`src/auth/api-path-policy.ts`).
 *
 * These assert POSITIVE properties of the policy:
 *   1. the predicate recognises every path form the Express router will actually route;
 *   2. each declared exception behaves exactly as its declared kind says it does;
 *   3. a path that merely resembles an exception does not inherit it.
 *
 * Property (1) is checked against a REAL Express router carrying neutral probe routes, not against a
 * restatement of what we believe Express does. The router answers, the policy is compared to it.
 */
import express from 'express'
import request from 'supertest'
import { describe, it, expect } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import { isPublicFormAuthBypass } from '../../src/auth/jwt-middleware'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
import {
  GLOBAL_GATE_EXCEPTIONS,
  apiPathEquals,
  apiPathHasPrefix,
  isApiPath,
  isGateException,
  matchGateException,
} from '../../src/auth/api-path-policy'

// Neutral probe paths. They name nothing real: the point is to ask the router how it treats a path
// SHAPE, so the answers stay true as routes come and go.
const PROBE_API_PATH = '/api/policy-probe/resource'
const PROBE_NON_API_PATH = '/apiary/policy-probe/resource'

/**
 * Spelling transforms to try against the router. Each returns a candidate spelling of a path; the test
 * below asks the router whether it routes that spelling, and requires the policy to agree.
 */
const SPELLINGS: readonly { name: string; of: (p: string) => string }[] = [
  { name: 'A', of: (p) => p },
  { name: 'B', of: (p) => p.toUpperCase() },
  { name: 'C', of: (p) => p.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('') },
  { name: 'D', of: (p) => `${p}/` },
  { name: 'E', of: (p) => p.replace(/^\/(\w)/, (_m, c: string) => `/%${c.charCodeAt(0).toString(16)}`) },
]

/** Build a real app: a path-less mounted router (the common shape in index.ts) carrying probe routes. */
function buildProbeApp(): express.Express {
  const app = express()
  const router = express.Router()
  router.get(PROBE_API_PATH, (_req, res) => { res.status(200).json({ routed: true }) })
  router.get(PROBE_NON_API_PATH, (_req, res) => { res.status(200).json({ routed: true }) })
  app.use(router)
  app.use((_req, res) => { res.status(404).json({ routed: false }) })
  return app
}

describe('API path policy — the predicate recognises what the router routes', () => {
  // One pinned listener for the whole file (tests/utils/pinned-server.ts): `request(app)` would make
  // supertest bind a fresh ephemeral port per request, which the app-mode tripwire bans.
  const pinned = usePinnedServer()
  pinned.setApp(buildProbeApp())

  it('has probe routes the router actually serves (positive control for the sweep below)', async () => {
    const res = await request(pinned.url()).get(PROBE_API_PATH)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ routed: true })
  })

  for (const spelling of SPELLINGS) {
    it(`agrees with the router about an API path spelled ${spelling.name}`, async () => {
      const candidate = spelling.of(PROBE_API_PATH)
      const res = await request(pinned.url()).get(candidate)
      const routerServesIt = res.status === 200

      if (routerServesIt) {
        // THE invariant: whatever the router is willing to hand to a handler is classified as API
        // traffic by the policy, so the gate and every downstream surface agree about it.
        expect(
          isApiPath(candidate),
          `policy and router disagree about this path`,
        ).toBe(true)
      } else {
        // Not routed: nothing to protect. Recorded so the sweep can never pass by routing nothing.
        expect(res.status).toBe(404)
      }
    })
  }

  it('at least one spelling other than the literal one is routed (the sweep is not vacuous)', async () => {
    const routed: string[] = []
    for (const spelling of SPELLINGS.filter((s) => s.name !== 'A')) {
      const res = await request(pinned.url()).get(spelling.of(PROBE_API_PATH))
      if (res.status === 200) routed.push(spelling.name)
    }
    expect(routed.length, 'no alternative spelling was routed — the agreement sweep proves nothing').toBeGreaterThan(0)
  })

  it('does not classify a path that merely begins with the same letters as an API path', async () => {
    expect(isApiPath(PROBE_NON_API_PATH)).toBe(false)
    expect(isApiPath('/apifoo')).toBe(false)
    expect(isApiPath('/apis/thing')).toBe(false)
    expect(isApiPath('/health')).toBe(false)
    expect(isApiPath('/')).toBe(false)
    expect(isApiPath('')).toBe(false)
    // …while the real thing still is one (positive control).
    expect(isApiPath('/api')).toBe(true)
    expect(isApiPath('/api/')).toBe(true)
    expect(isApiPath('/api/anything')).toBe(true)
  })
})

describe('API path policy — declared exceptions behave as their kind declares', () => {
  it('the exception table is populated and uses both kinds (the per-entry sweep is not vacuous)', () => {
    expect(GLOBAL_GATE_EXCEPTIONS.length).toBeGreaterThan(0)
    const kinds = new Set(GLOBAL_GATE_EXCEPTIONS.map((e) => e.kind))
    expect(kinds.has('exact')).toBe(true)
    expect(kinds.has('prefix')).toBe(true)
  })

  it('every entry declares a reason and a leading-slash path without a trailing slash', () => {
    for (const entry of GLOBAL_GATE_EXCEPTIONS) {
      expect(entry.path.startsWith('/'), `${entry.path} must be an absolute path`).toBe(true)
      expect(entry.path.endsWith('/'), `${entry.path} must not carry a trailing slash`).toBe(false)
      expect(entry.reason.trim().length, `${entry.path} must declare why it may skip the gate`).toBeGreaterThan(0)
    }
  })

  // Mechanical per-entry sweep over the declaration table itself, so it stays honest as entries change.
  for (const entry of GLOBAL_GATE_EXCEPTIONS) {
    describe(`${entry.kind} exception ${entry.path}`, () => {
      it('covers the path it names', () => {
        expect(isGateException(entry.path)).toBe(true)
        expect(matchGateException(entry.path)?.path).toBe(entry.path)
      })

      it('covers the same path written with a trailing slash', () => {
        expect(isGateException(`${entry.path}/`)).toBe(true)
      })

      it('does not cover a longer path that merely starts with the same characters', () => {
        expect(isGateException(`${entry.path}-sibling`)).toBe(false)
        expect(isGateException(`${entry.path}x`)).toBe(false)
      })

      it(`${entry.kind === 'prefix' ? 'covers' : 'does not cover'} a path below it`, () => {
        const child = `${entry.path}/child-probe`
        expect(isGateException(child)).toBe(entry.kind === 'prefix')
      })
    })
  }

  it('a path with no declaration is not an exception', () => {
    expect(isGateException('/api/policy-probe/resource')).toBe(false)
    expect(matchGateException('/api/policy-probe/resource')).toBeNull()
  })
})

/**
 * The gate's dispatch chain, assembled here from the SAME predicates `index.ts` imports, with a
 * recorder standing in for `jwtAuthMiddleware` so the test can see which branch a request took.
 *
 * This is a COPY of the chain in `index.ts`, not the chain itself — a unit test cannot boot the real
 * server cheaply. What keeps the copy honest is `api-path-policy.guard.test.ts`: it fails if any call
 * site (including `index.ts`) decides these questions with its own literal path test instead of the
 * shared predicates used below. The two together give the property: API paths default INTO the gate,
 * and only declared exceptions opt out.
 */
function buildGateApp(record: (outcome: 'gate' | 'exception' | 'not-api') => void): express.Express {
  const app = express()
  app.use((req, _res, next) => {
    if (isGateException(req.path)) { record('exception'); return next() }
    if (isPublicFormAuthBypass(req)) { record('exception'); return next() }
    if (isOapiAllowlistRequest(req.method, req.path, req.headers.authorization)) { record('exception'); return next() }
    if (isApiPath(req.path)) { record('gate'); return next() }
    record('not-api')
    return next()
  })
  // The probe routers sit BEHIND the chain, as the real routers do, so one request reports both which
  // branch the chain took AND whether a router would have served the request at all.
  const router = express.Router()
  router.get(PROBE_API_PATH, (_req, res) => { res.status(200).json({ routed: true }) })
  router.get(PROBE_NON_API_PATH, (_req, res) => { res.status(200).json({ routed: true }) })
  app.use(router)
  app.use((_req, res) => { res.status(404).json({ routed: false }) })
  return app
}

describe('API path policy — the gate chain sends API paths to the gate', () => {
  const pinned = usePinnedServer()
  let outcome: 'gate' | 'exception' | 'not-api' | null = null
  pinned.setApp(buildGateApp((o) => { outcome = o }))

  async function probe(path: string): Promise<{ outcome: string | null; routed: boolean }> {
    outcome = null
    const res = await request(pinned.url()).get(path)
    return { outcome, routed: res.status === 200 }
  }

  async function outcomeFor(path: string): Promise<string | null> {
    return (await probe(path)).outcome
  }

  for (const spelling of SPELLINGS) {
    it(`classifies an undeclared API path spelled ${spelling.name} consistently with the router`, async () => {
      const { outcome: branch, routed } = await probe(spelling.of(PROBE_API_PATH))
      if (routed) {
        // Anything a router would serve must have been sent to the gate on the way in.
        expect(branch, 'a routable API path did not reach the gate').toBe('gate')
      } else {
        // Not routable: no handler to protect. Recorded so the sweep cannot pass by routing nothing.
        expect(branch).not.toBe('exception')
      }
    })
  }

  it('at least three spellings are routable and every one of them reached the gate', async () => {
    const reached: string[] = []
    for (const spelling of SPELLINGS) {
      const { outcome: branch, routed } = await probe(spelling.of(PROBE_API_PATH))
      if (routed && branch === 'gate') reached.push(spelling.name)
    }
    expect(reached.length, 'too few routable spellings — the gate sweep proves little').toBeGreaterThanOrEqual(3)
  })

  it('sends a path outside the API surface past the gate untouched', async () => {
    expect(await outcomeFor(PROBE_NON_API_PATH)).toBe('not-api')
    expect(await outcomeFor('/health-probe')).toBe('not-api')
  })

  // Per-declaration sweep: each declared exception must actually take the exception branch, and a
  // sibling that merely resembles it must still reach the gate.
  for (const entry of GLOBAL_GATE_EXCEPTIONS.filter((e) => isApiPath(e.path))) {
    it(`lets the declared ${entry.kind} exception ${entry.path} skip the gate, but not its look-alike`, async () => {
      expect(await outcomeFor(entry.path)).toBe('exception')
      expect(await outcomeFor(`${entry.path}-sibling`)).toBe('gate')
      expect(await outcomeFor(`${entry.path}/child-probe`)).toBe(entry.kind === 'prefix' ? 'exception' : 'gate')
    })
  }
})

describe('API path policy — comparison helpers', () => {
  it('apiPathEquals matches one path, tolerating only a trailing slash', () => {
    expect(apiPathEquals('/api/thing', '/api/thing')).toBe(true)
    expect(apiPathEquals('/api/thing/', '/api/thing')).toBe(true)
    expect(apiPathEquals('/api/thing', '/api/thing/')).toBe(true)
    expect(apiPathEquals('/api/thing/child', '/api/thing')).toBe(false)
    expect(apiPathEquals('/api/thingamajig', '/api/thing')).toBe(false)
  })

  it('apiPathHasPrefix matches at a segment boundary only', () => {
    expect(apiPathHasPrefix('/api/thing', '/api/thing')).toBe(true)
    expect(apiPathHasPrefix('/api/thing/child', '/api/thing')).toBe(true)
    expect(apiPathHasPrefix('/api/thing/child/grandchild', '/api/thing')).toBe(true)
    expect(apiPathHasPrefix('/api/thingamajig', '/api/thing')).toBe(false)
    expect(apiPathHasPrefix('/api/thing-admin', '/api/thing')).toBe(false)
    expect(apiPathHasPrefix('/api/other', '/api/thing')).toBe(false)
  })

  it('the attendance subtrees stay disjoint under the shared prefix helper', () => {
    // `/api/attendance` must not swallow `/api/attendance-admin`: the audit predicate, the IP allowlist
    // and the limiter all distinguish them, and a prefix test that matched mid-segment would merge them.
    expect(apiPathHasPrefix('/api/attendance-admin/users', '/api/attendance')).toBe(false)
    expect(apiPathHasPrefix('/api/attendance-admin/users', '/api/attendance-admin')).toBe(true)
    expect(apiPathHasPrefix('/api/attendance/punch', '/api/attendance')).toBe(true)
  })
})
