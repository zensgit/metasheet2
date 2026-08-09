/**
 * W6-1 (#4556) — the authorization boundary of
 * `GET /api/attendance/groups/:groupId/effective-policy`, pinned rather than
 * asserted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS. Two claims about this route were being carried as
 * PROSE, and both turned out to be narrower than they read:
 *
 *  (1) "authorization precedes every scoped SQL read". A review supported this
 *      by stating that `/api/attendance` routes are "not whitelisted" at the
 *      global JWT gate (`src/index.ts`). That is true of the whitelist — but
 *      the gate has FOUR branches, three of which reach `next()` without
 *      running `jwtAuthMiddleware`, and the negative had been asserted rather
 *      than traced. TRACED HERE, and one of them is reachable for this route's
 *      path — see the `case-sensitivity gap` block below. The red line still
 *      holds, but through a DIFFERENT DOOR than the prose named, and that
 *      distinction is the whole point of pinning it.
 *
 *  (2) "the read-only transaction covers the authorization gate". It covers the
 *      MEMBERSHIP-CHECK BRANCH. For a platform admin the gate short-circuits
 *      and the membership statement never executes at all — so for that caller
 *      there is nothing of the gate inside the transaction. Pinned in part B.
 *
 * NO DATABASE. Part A drives a real Express app over a real socket; part B
 * calls the real authorization helper with a spy in the `runQuery` seam.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Request } from 'express'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { isPublicFormAuthBypass, isWhitelisted } from '../../src/auth/jwt-middleware'
import { correlationContextEnrichmentMiddleware } from '../../src/middleware/correlation'
import { attendanceAuditMiddleware, attendanceSecurityMiddleware } from '../../src/middleware/attendance-production'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
import { AGGREGATE_ROUTE_ENTRY_FILE, AGGREGATE_ROUTE_ENTRY_PATH, findRepoRoot } from '../helpers/attendance-w6-call-path-closure'

// `isAdmin` is the only RBAC call part B needs to steer; everything else in the
// module stays real (its `pool` is unset with no DATABASE_URL, so the real
// `isAdmin` would return false anyway — mocking makes that INTENTIONAL rather
// than incidental, which is what lets the admin legs be positive, not vacuous).
vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rbac/service')>()
  return { ...actual, isAdmin: vi.fn(async () => false) }
})

const { attendanceAdminRouter, canReadAttendanceDirectoryReadiness } = await import('../../src/routes/attendance-admin')
const { isAdmin } = await import('../../src/rbac/service')

const repoRoot = findRepoRoot(__dirname)
const indexSource = readFileSync(join(repoRoot, 'packages/core-backend/src/index.ts'), 'utf8')

// ═══════════════════════════════════════════════════════════════════════════
// PART A — can any spelling of this route's path reach the handler without
//          `jwtAuthMiddleware` having run?
// ═══════════════════════════════════════════════════════════════════════════

describe('W6-1 pre-auth boundary: the global JWT gate and its escapes', () => {
  /**
   * The gate is an inline anonymous middleware inside a class method, so it
   * cannot be imported. Part A therefore MIRRORS it — and a mirror that drifts
   * from the original proves nothing about the original. This leg pins the
   * mirror: it extracts the gate's real body and asserts the branch sequence is
   * EXACTLY the four this file models, in order. A fifth branch, a reordering,
   * or a changed predicate reds here, which is the signal to re-derive the
   * mirror rather than to trust it.
   */
  it('the mirrored gate is the REAL gate: exactly four branches, in this order, extracted from src/index.ts', () => {
    const anchor = 'if (isWhitelisted(req.path)) return next()'
    const at = indexSource.indexOf(anchor)
    expect(at, 'gate anchor not found — src/index.ts moved and the mirror below is unverified').toBeGreaterThan(-1)
    expect(indexSource.indexOf(anchor, at + 1), 'gate anchor is not unique').toBe(-1)

    // The middleware body runs from the anchor to its closing `})`.
    const end = indexSource.indexOf('\n    })', at)
    expect(end).toBeGreaterThan(at)
    const body = indexSource.slice(at, end)

    const statements = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('//'))

    expect(statements).toEqual([
      'if (isWhitelisted(req.path)) return next()',
      'if (isPublicFormAuthBypass(req)) return optionalJwtAuthMiddleware(req, res, next)',
      'if (isOapiAllowlistRequest(req.method, req.path, req.headers.authorization)) return next()',
      "if (req.path.startsWith('/api/')) return jwtAuthMiddleware(req, res, next)",
      'return next()',
    ])

    // Stated plainly because the review's framing said "two escapes": the gate
    // has FOUR conditional branches and exactly ONE of them enforces. Counted
    // mechanically rather than eyeballed.
    const conditionals = statements.filter((line) => line.startsWith('if ('))
    expect(conditionals.length).toBe(4)
    const enforcing = conditionals.filter((line) => /(?<!optional)[Jj]wtAuthMiddleware\(req, res, next\)/.test(line))
    expect(enforcing).toEqual(["if (req.path.startsWith('/api/')) return jwtAuthMiddleware(req, res, next)"])
    // THREE branches reach the next handler without enforcement — two by a bare
    // `next()`, and one via `optionalJwtAuthMiddleware`, which hydrates a user
    // if a token happens to be present but does NOT 401 when it is not. That
    // third one is an escape from ENFORCEMENT, not merely from the whitelist,
    // and it was absent from the review's enumeration entirely.
    expect(conditionals.length - enforcing.length).toBe(3)
    expect(conditionals.filter((line) => line.includes('optionalJwtAuthMiddleware')).length).toBe(1)
  })

  /**
   * The route is mounted AFTER the gate. If it were ever mounted before, every
   * conclusion in this file would be void, so the ordering is a check, not an
   * assumption.
   */
  it('the attendance-admin router is mounted AFTER the gate in src/index.ts', () => {
    const gateAt = indexSource.indexOf('if (isWhitelisted(req.path)) return next()')
    const mountAt = indexSource.indexOf('this.app.use(attendanceAdminRouter())')
    expect(gateAt).toBeGreaterThan(-1)
    expect(mountAt).toBeGreaterThan(-1)
    expect(mountAt).toBeGreaterThan(gateAt)
  })

  /**
   * The harness mounts everything `index.ts` puts between the gate and the
   * router. "Nothing in between refuses an unauthenticated request" is only a
   * MEASURED claim if the in-between really is all present — otherwise it is
   * the same assumed-negative this file was written to replace. This leg pins
   * the list: a new middleware inserted there reds here, which is the signal to
   * add it to the harness and re-measure rather than to keep trusting the old
   * verdict.
   */
  it('the harness carries EVERY middleware src/index.ts mounts between the gate and the router', () => {
    const gateEnd = indexSource.indexOf('\n    })', indexSource.indexOf('if (isWhitelisted(req.path)) return next()'))
    const mountAt = indexSource.indexOf('this.app.use(attendanceAdminRouter())')
    expect(gateEnd).toBeGreaterThan(-1)
    expect(mountAt).toBeGreaterThan(gateEnd)

    const between = indexSource.slice(gateEnd, mountAt)
    const mounts = [...between.matchAll(/^\s*this\.app\.use\((.+)$/gm)].map((match) => match[1].trim())

    // The four UNCONDITIONAL middlewares — they run for every request, so each
    // one is a place the request could be refused, and each is mounted in the
    // harness above. Anything added here is unmodelled and reds.
    expect(mounts.slice(0, 4)).toEqual([
      'correlationContextEnrichmentMiddleware)',
      '(req: Request, _res: Response, next: NextFunction) => {', // inline tenant context
      'attendanceAuditMiddleware())',
      'attendanceSecurityMiddleware())',
    ])

    // Everything else between here and our mount must be a ROUTER, not a bare
    // middleware. A router only handles paths it registered and falls through
    // otherwise, so it cannot refuse this route's request — but that reasoning
    // only holds if they really are all routers. Classified mechanically; an
    // unrecognised entry (a new inline middleware, say) reds rather than being
    // waved through as "probably a router".
    const rest = mounts.slice(4)
    expect(rest.length).toBeGreaterThan(0)
    for (const entry of rest) {
      const pathScoped = /^'([^']+)',/.exec(entry)
      if (pathScoped) {
        // A path-scoped mount can only see this route if its prefix matches.
        expect(canonical.startsWith(pathScoped[1]), `path-scoped mount ${entry} covers this route`).toBe(false)
        continue
      }
      expect(entry, `unmodelled non-router mount between the gate and our router: ${entry}`).toMatch(
        /^[A-Za-z][\w.]*(Router|Routes)\s*\(/,
      )
    }

    // And the two path-scoped ones are gated by the SAME case-sensitive `/api/`
    // prefix test as the gate — so an upper-cased spelling skips attendance
    // audit logging, the IP allowlist and rate limiting as well. Recorded here
    // because it widens the reported finding beyond authentication.
    const productionSource = readFileSync(
      join(repoRoot, 'packages/core-backend/src/middleware/attendance-production.ts'),
      'utf8',
    )
    expect(productionSource).toContain("if (!req.path.startsWith('/api/')) return false")
  })

  // ── the live harness ─────────────────────────────────────────────────────

  interface Probe {
    readonly target: string
    readonly status: number
    readonly serverPath: string
    readonly branch: string
    readonly authRan: boolean
    readonly handlerReached: boolean
  }

  let probes: Map<string, Probe>
  let server: ReturnType<express.Express['listen']>

  /**
   * Spellings are generated from the ROUTE'S OWN path literal (imported from
   * the closure helper, which reads it out of the route file) rather than typed
   * out, so a route rename cannot leave this suite testing a dead path.
   */
  /** A path under a REAL whitelist prefix (`/api/plugins`), used as the
   *  harness's own positive control — see the spelling list below. */
  const HARNESS_CONTROL_PATH = '/api/plugins/w6-authz-harness-control'

  const canonical = AGGREGATE_ROUTE_ENTRY_PATH.replace(':groupId', '11111111-1111-4111-8111-111111111111')
  const segments = canonical.split('/').filter(Boolean)
  const spellings: string[] = [
    canonical,
    `${canonical}/`,
    `${canonical}?x=1`,
    `${canonical}#frag`,
    `${canonical};x=1`,
    canonical.toUpperCase(),
    // one leading segment upper-cased — the minimal case perturbation
    `/${segments[0].toUpperCase()}/${segments.slice(1).join('/')}`,
    // percent-encoding, in the param and in a literal segment
    canonical.replace('/groups/', '/groups/%31'),
    canonical.replace('/api/', '/%61pi/'),
    canonical.replace('effective-policy', 'effective%2Dpolicy'),
    // separator games
    `/${canonical}`,
    canonical.replace('/api/', '/api//'),
    `/.${canonical}`,
    canonical.replace('/groups/', '/groups/./'),
    `${canonical}%2f`,
    // dot-segment traversal out of each whitelisted prefix that could plausibly
    // be used as a springboard
    `/api/plugins/..${canonical.slice('/api'.length)}`,
    `/api/plugins/%2e%2e${canonical.slice('/api'.length)}`,
    `/api/health/..${canonical.slice('/api'.length)}`,
    `/api/plm-embed/..${canonical.slice('/api'.length)}`,
    `/api/auth/login/..${canonical.slice('/api'.length)}`,
    // HARNESS CONTROL — a genuinely whitelisted path with its own sentinel
    // handler. It must arrive with `authRan === false` AND reach its handler,
    // which is the only way to know this harness can distinguish "auth ran"
    // from "auth did not run". Without it, every `authRan` assertion below
    // could be passing because the flag is stuck.
    HARNESS_CONTROL_PATH,
  ]

  /**
   * A raw socket, not a client library. This is load-bearing: `superagent`
   * (and therefore `supertest`) NORMALISES dot-segments client-side before the
   * request is written, so a supertest-driven probe silently measures the
   * CLIENT's normalisation instead of the server's and reports traversal
   * spellings as though the server had resolved them. Measured while building
   * this file: `/api/plugins/../attendance/...` arrived at Express already
   * rewritten to `/api/attendance/...` under supertest, and arrives VERBATIM
   * over a raw socket. Only the second is the server's behaviour.
   */
  /** Every probed spelling OF THIS ROUTE that the router matched. The harness
   *  control path is deliberately excluded: it is an unguarded decoy that
   *  exists to prove the instrumentation works, and folding it in would make
   *  the route-scoped claims below false by construction. */
  function routeProbesReachingTheRoute(): Probe[] {
    return [...probes.values()].filter((probe) => probe.target !== HARNESS_CONTROL_PATH && probe.status !== 404)
  }

  function rawGet(port: number, target: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
      })
      let buffered = ''
      socket.on('data', (chunk) => {
        buffered += chunk.toString('utf8')
      })
      socket.on('end', () => {
        const status = /^HTTP\/1\.1 (\d+)/.exec(buffered)?.[1]
        resolve(status ? Number(status) : 0)
      })
      socket.on('error', reject)
    })
  }

  beforeAll(async () => {
    let branch = ''
    let authRan = false
    let serverPath = ''
    let handlerReached = false

    const app = express()

    // THE MIRROR of `src/index.ts`'s gate — the four branches pinned above, with
    // the REAL predicate functions imported from the REAL modules.
    //
    // TWO substitutions, both stated so a reviewer comparing mirror to original
    // finds no unexplained divergence:
    //  - the terminal `jwtAuthMiddleware` becomes a sentinel that records that
    //    enforcement RAN. This suite is about whether auth runs, not about what
    //    a valid token does.
    //  - the publicForm branch's `optionalJwtAuthMiddleware(req, res, next)`
    //    becomes a bare `next()`. Equivalent for every probe here, all of which
    //    are token-less: with no bearer, `optionalJwtAuthMiddleware` hydrates
    //    nothing and calls `next()` — it never 401s, which is precisely why it
    //    counts as a non-enforcing branch. Substituting it keeps this harness
    //    from depending on `authService` for a branch no probe can even enter
    //    (its predicate requires a `publicToken` AND one of two multitable
    //    paths, asserted false for every spelling below).
    app.use((req, _res, next) => {
      branch = ''
      authRan = false
      serverPath = req.path
      handlerReached = false
      if (isWhitelisted(req.path)) {
        branch = 'whitelist'
        return next()
      }
      if (isPublicFormAuthBypass(req)) {
        branch = 'publicForm'
        return next()
      }
      if (isOapiAllowlistRequest(req.method, req.path, req.headers.authorization)) {
        branch = 'oapiAllowlist'
        return next()
      }
      if (req.path.startsWith('/api/')) {
        branch = 'jwtAuthMiddleware'
        authRan = true
        return next()
      }
      branch = 'fallThrough'
      return next()
    })

    // EVERYTHING `src/index.ts` mounts BETWEEN the gate and the router, real
    // and in order. Omitting them would leave the claim "nothing between the
    // gate and the handler refuses this request" as an assumption — the exact
    // shape of the mistake this file exists to correct. The next leg pins this
    // list against `index.ts` so it cannot silently fall behind.
    app.use(correlationContextEnrichmentMiddleware)
    // The tenant-context middleware is an inline anonymous function in the
    // class method; mirrored here. With no `req.user` it takes its early
    // `return next()`, which is the branch under test.
    app.use((req, _res, next) => {
      const tenantId = typeof req.user?.tenantId === 'string' && req.user.tenantId.trim().length > 0
        ? req.user.tenantId.trim()
        : undefined
      if (!tenantId) return next()
      return next()
    })
    app.use(attendanceAuditMiddleware())
    app.use(attendanceSecurityMiddleware())

    // The REAL router, so the route's own `rbacGuard('attendance', 'admin')` is
    // the real one. `req.user` is never populated (the sentinel above does not
    // authenticate), which is exactly the unauthenticated case under test.
    //
    // NOTE for a reviewer: this file `vi.mock`s `src/rbac/service`, but that is
    // NOT load-bearing for the 401 below — `rbacGuard` refuses on `!userId`
    // before it consults the service at all. The mock exists for part B.
    app.use(attendanceAdminRouter())

    // Reached only if BOTH the gate and the route-level guard let the request
    // through — i.e. the handler ran. A 200 from the real handler is impossible
    // without a database, so this sentinel is what distinguishes "the request
    // got past every door" from "the handler threw".
    const sentinel = express.Router()
    sentinel.get(AGGREGATE_ROUTE_ENTRY_PATH, (_req, res) => {
      handlerReached = true
      res.status(299).json({ ok: true })
    })
    // The harness's own control target: no guard of any kind, under a
    // whitelisted prefix, so it MUST arrive unauthenticated and MUST be reached.
    sentinel.get(HARNESS_CONTROL_PATH, (_req, res) => {
      handlerReached = true
      res.status(298).json({ ok: true })
    })
    app.use(sentinel)

    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const port = (server.address() as AddressInfo).port

    probes = new Map()
    for (const target of spellings) {
      const status = await rawGet(port, target)
      probes.set(target, { target, status, serverPath, branch, authRan, handlerReached })
    }
  })

  afterAll(() => {
    server?.close()
  })

  /**
   * VACUITY FLOOR, first and deliberately. "For every spelling that reaches the
   * route, X" is satisfied trivially if no spelling reaches it — a typo in the
   * path, a router that failed to mount, or a harness that 404s everything all
   * produce a green suite that checked nothing.
   */
  it('POSITIVE CONTROL: the harness really does reach this route, on more than one spelling', () => {
    const reaching = routeProbesReachingTheRoute()
    expect(reaching.length).toBeGreaterThanOrEqual(3)
    expect(probes.get(canonical)?.status, 'the canonical path does not even reach the route').not.toBe(404)
    expect(probes.get(`${canonical}/`)?.status, 'trailing-slash form unreachable').not.toBe(404)
    expect(probes.get(canonical.toUpperCase())?.status, 'upper-cased form unreachable').not.toBe(404)
  })

  it('POSITIVE CONTROL: the harness CAN observe a handler reached with NO auth (otherwise every authRan verdict is vacuous)', () => {
    // If `authRan` were stuck true, or `handlerReached` stuck false, the legs
    // below would pass for the wrong reason. This control drives the SAME
    // harness at a whitelisted path with an unguarded handler, and demands the
    // exact state the route legs demand never occurs.
    const control = probes.get(HARNESS_CONTROL_PATH)
    expect(control, 'the harness control path was not probed').toBeDefined()
    expect((control as Probe).branch).toBe('whitelist')
    expect((control as Probe).authRan).toBe(false)
    expect((control as Probe).handlerReached).toBe(true)
    expect((control as Probe).status).toBe(298)
    // …and the two states really are distinguishable: the canonical route path
    // arrives on the ENFORCING branch.
    expect(probes.get(canonical)?.authRan).toBe(true)
    expect(probes.get(canonical)?.branch).toBe('jwtAuthMiddleware')
  })

  it('NEITHER named escape admits ANY spelling of this route — traced, not asserted', () => {
    // The two the review named, plus the third it did not, evaluated with the
    // REAL predicates on the path the SERVER actually saw.
    const reaching = routeProbesReachingTheRoute()
    expect(reaching.length).toBeGreaterThan(0)
    for (const probe of reaching) {
      expect(isWhitelisted(probe.serverPath), `whitelist admitted ${probe.target}`).toBe(false)
      expect(
        isOapiAllowlistRequest('GET', probe.serverPath, undefined),
        `OAPI allowlist admitted ${probe.target}`,
      ).toBe(false)
      // …and with an `mst_` bearer, which is the only way the OAPI branch can
      // ever return true. Without this the negative is about the wrong input.
      expect(
        isOapiAllowlistRequest('GET', probe.serverPath, 'Bearer mst_probe'),
        `OAPI allowlist admitted ${probe.target} for a token bearer`,
      ).toBe(false)
      expect(
        isPublicFormAuthBypass({ path: probe.serverPath, method: 'GET', query: {}, body: {} } as unknown as Request),
        `public-form bypass admitted ${probe.target}`,
      ).toBe(false)
      expect(probe.branch === 'whitelist' || probe.branch === 'oapiAllowlist' || probe.branch === 'publicForm').toBe(false)
    }
  })

  it('POSITIVE CONTROL on the escape predicates: each one DOES admit its own legitimate input', () => {
    // Three predicates that returned false for every input would satisfy the
    // leg above while checking nothing.
    expect(isWhitelisted('/api/auth/login')).toBe(true)
    expect(isOapiAllowlistRequest('GET', '/api/multitable/records', 'Bearer mst_x')).toBe(true)
    expect(
      isPublicFormAuthBypass({
        path: '/api/multitable/form-context',
        method: 'GET',
        query: { publicToken: 't' },
        body: {},
      } as unknown as Request),
    ).toBe(true)
  })

  /**
   * ───────────────────────────────────────────────────────────────────────
   * THE CASE-SENSITIVITY GAP — a MEASURED fact, recorded as a fact.
   *
   * The gate's terminal branch is `req.path.startsWith('/api/')`, which is
   * CASE-SENSITIVE. Express's router is CASE-INSENSITIVE by default (`case
   * sensitive routing` is never enabled in `src/index.ts`). So an upper-cased
   * spelling of this path matches the route while failing the `/api/` prefix
   * test — the gate falls through to its final `return next()` and
   * `jwtAuthMiddleware` NEVER RUNS.
   *
   * This is not confined to this route: the same two properties hold for every
   * `/api/**` route in the app. It is a PRE-EXISTING, app-wide finding,
   * reported rather than patched here — the fix belongs at the gate, not in a
   * W6 slice, and choosing between "lower-case the prefix test" and "enable
   * case-sensitive routing" is an owner call with app-wide blast radius.
   *
   * WHAT SAVES THIS ROUTE is the SECOND door: `rbacGuard('attendance',
   * 'admin')` is mounted on the route itself and refuses a request with no
   * `req.user` (401) before the handler — and therefore before any scoped SQL.
   * The red line "authorization precedes every scoped SQL read" survives, but
   * it rests on the route-level guard, NOT on the global gate the prose named.
   *
   * Pinning both halves means that if anyone ever removes `rbacGuard` from this
   * route — believing, as the prose said, that the global gate has it covered —
   * this leg reds instead of the route silently becoming unauthenticated.
   * ───────────────────────────────────────────────────────────────────────
   */
  it('MEASURED GAP: an upper-cased spelling reaches this route with the global JWT gate NOT run', () => {
    const probe = probes.get(canonical.toUpperCase())
    expect(probe, 'upper-cased spelling was not probed').toBeDefined()
    const upper = probe as Probe
    // It matched the route (Express is case-insensitive by default)…
    expect(upper.status).not.toBe(404)
    // …and the gate did not enforce, because its prefix test is case-sensitive.
    expect(upper.authRan).toBe(false)
    expect(upper.branch).toBe('fallThrough')
    expect(upper.serverPath.startsWith('/api/')).toBe(false)
    // The mechanism, asserted directly rather than inferred from the outcome.
    expect(canonical.toUpperCase().startsWith('/api/')).toBe(false)
    expect(indexSource).not.toContain("app.set('case sensitive routing'")
  })

  it('AND THE SECOND DOOR HOLDS: that same spelling is refused 401 by the route-level rbacGuard, so the handler never runs', () => {
    const upper = probes.get(canonical.toUpperCase()) as Probe
    expect(upper.status).toBe(401)
    expect(upper.handlerReached).toBe(false)
    // The route file really does mount that guard — if this line goes, the
    // 401 above would become a 200 and this suite must red loudly.
    const routeSource = readFileSync(join(repoRoot, AGGREGATE_ROUTE_ENTRY_FILE), 'utf8')
    const at = routeSource.indexOf(`'${AGGREGATE_ROUTE_ENTRY_PATH}',`)
    expect(at).toBeGreaterThan(-1)
    expect(routeSource.slice(at, at + 200)).toContain("rbacGuard('attendance', 'admin')")
  })

  it('EVERY reaching spelling is either authenticated or refused BEFORE the handler — no spelling reaches the handler unauthenticated', () => {
    // The claim the red line actually needs, stated over the whole probed set
    // rather than over the one spelling anybody thought of.
    const reaching = routeProbesReachingTheRoute()
    expect(reaching.length).toBeGreaterThanOrEqual(3)
    for (const probe of reaching) {
      if (probe.handlerReached) {
        expect(probe.authRan, `handler reached WITHOUT auth via ${probe.target}`).toBe(true)
      } else {
        expect([401, 403, 400, 404, 500]).toContain(probe.status)
      }
    }
    // And at least one reaching spelling really was refused, so the branch
    // above is exercised rather than merely present.
    expect(reaching.some((probe) => probe.status === 401)).toBe(true)
  })

  it('dot-segment traversal out of a whitelisted prefix escapes the gate but does NOT reach this route', () => {
    // Worth pinning as its own fact: `isWhitelisted` is an UNANCHORED
    // `startsWith` over the raw (undecoded, unnormalised) `req.path`, so
    // `/api/plugins/../attendance/…` IS whitelisted — the gate is bypassed.
    // Express does not normalise `..`, so the route pattern (which requires a
    // literal `/api/attendance/groups/` prefix) does not match and the request
    // 404s. Both halves are stated because only the pair is the safe outcome:
    // if anything downstream ever normalises the path AFTER this gate, the
    // first half becomes an unauthenticated route hit.
    const traversal = `/api/plugins/..${canonical.slice('/api'.length)}`
    const probe = probes.get(traversal) as Probe
    expect(probe).toBeDefined()
    expect(isWhitelisted(probe.serverPath), 'the traversal spelling is NOT whitelisted — re-derive this leg').toBe(true)
    expect(probe.branch).toBe('whitelist')
    expect(probe.authRan).toBe(false)
    expect(probe.status).toBe(404)
    expect(probe.handlerReached).toBe(false)
    // The server saw it verbatim — i.e. nothing normalised it before routing.
    expect(probe.serverPath).toBe(traversal)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PART B — the admin short-circuit inside the membership gate.
// ═══════════════════════════════════════════════════════════════════════════

describe('W6-1 read-only coverage: what the admin short-circuit does and does not execute', () => {
  const ORG = '22222222-2222-4222-8222-222222222222'
  const USER = '33333333-3333-4333-8333-333333333333'

  // The `isAdmin` mock is module-scoped and therefore ACCUMULATES across legs.
  // Found the hard way: without this reset the legacy-claim leg read a call
  // made by the leg before it and reported a short-circuit failure that had not
  // happened. `not.toHaveBeenCalled()` on a shared spy is only meaningful if
  // the spy starts each leg clean.
  beforeEach(() => {
    vi.mocked(isAdmin).mockClear()
  })

  function spyQuery() {
    const calls: Array<{ sql: string; params: unknown }> = []
    const runQuery = vi.fn(async (sql: string, params?: unknown) => {
      calls.push({ sql, params })
      return { rows: [{ ok: 1 }], rowCount: 1 } as never
    })
    return { calls, runQuery }
  }

  it('POSITIVE CONTROL FIRST: a DELEGATED (non-admin) caller DOES execute the membership statement on the injected handle', async () => {
    // Without this, "the admin legs issued no SQL" could just mean the seam is
    // never used at all.
    vi.mocked(isAdmin).mockResolvedValueOnce(false)
    const { calls, runQuery } = spyQuery()
    const allowed = await canReadAttendanceDirectoryReadiness(
      { user: { id: USER } } as unknown as Request,
      USER,
      ORG,
      runQuery as never,
    )
    expect(allowed).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].sql).toContain('FROM user_orgs uo')
    expect(calls[0].sql).toContain('uo.is_active = true')
    expect(calls[0].sql).toContain('u.is_active = true')
    expect(calls[0].params).toEqual([USER, ORG])
  })

  it('a LEGACY-CLAIM admin short-circuits: the membership statement NEVER EXECUTES, and no SQL touches the injected handle', async () => {
    const { calls, runQuery } = spyQuery()
    const allowed = await canReadAttendanceDirectoryReadiness(
      { user: { id: USER, role: 'admin' } } as unknown as Request,
      USER,
      ORG,
      runQuery as never,
    )
    expect(allowed).toBe(true)
    // THE POINT: zero statements on the read-only handle for this caller. The
    // transaction still wraps the aggregate reads downstream — it just has no
    // membership statement of the gate's to wrap.
    expect(calls).toEqual([])
    expect(runQuery).not.toHaveBeenCalled()
    // And `isRbacAdmin` was not even consulted: `hasLegacyAdminClaim` is the
    // FIRST disjunct, and it issues no SQL anywhere — not on the handle, not on
    // the pool.
    expect(isAdmin).not.toHaveBeenCalled()
  })

  it('an RBAC platform admin short-circuits too: `isAdmin` runs OUTSIDE the transaction and the membership statement never executes', async () => {
    vi.mocked(isAdmin).mockResolvedValueOnce(true)
    const { calls, runQuery } = spyQuery()
    const allowed = await canReadAttendanceDirectoryReadiness(
      { user: { id: USER } } as unknown as Request,
      USER,
      ORG,
      runQuery as never,
    )
    expect(allowed).toBe(true)
    // `isAdmin` WAS consulted — this disjunct is the one that runs a query, and
    // it runs it on the module-scope pool, never on the injected handle.
    expect(isAdmin).toHaveBeenCalledWith(USER)
    // …and nothing at all reached the read-only handle.
    expect(calls).toEqual([])
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('a non-member delegated admin is refused, and it is the membership statement that refuses (not an early return)', async () => {
    vi.mocked(isAdmin).mockResolvedValueOnce(false)
    const calls: string[] = []
    const runQuery = vi.fn(async (sql: string) => {
      calls.push(sql)
      return { rows: [], rowCount: 0 } as never
    })
    const allowed = await canReadAttendanceDirectoryReadiness(
      { user: { id: USER } } as unknown as Request,
      USER,
      ORG,
      runQuery as never,
    )
    expect(allowed).toBe(false)
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('FROM user_orgs uo')
  })
})
