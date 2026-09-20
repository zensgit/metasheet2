/**
 * DELETE method-override (POST + X-HTTP-Method-Override: DELETE) — middleware/method-override.ts,
 * routes/method-probe.ts and their index.ts mount order.
 *
 * The app under test mirrors the index.ts pipeline segment that matters: a global `/api` gate that
 * attaches `req.user` for a good bearer and 401s otherwise, THEN the override middleware, THEN the
 * routers. A "route executed" counter proves the handler never ran on the refused paths.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The attendance limiters are built from env AT MODULE LOAD, so the budget must be shrunk before the
// import of attendance-production.ts is evaluated. `vi.hoisted` runs before the import block.
vi.hoisted(() => {
  process.env.ATTENDANCE_RATE_LIMIT_ENABLED = 'true'
  process.env.ATTENDANCE_RATE_LIMIT_IMPORT_COMMIT_PER_MIN = '2'
})

/**
 * Token verification is the ONLY thing stubbed for the real-gate suite at the bottom of this file:
 * `authService.verifyToken` is what `jwtAuthMiddleware` calls, and it talks to Postgres. Everything
 * else in that suite — the gate middleware, the override middleware, the probe router, the socket —
 * is the real thing. (Same mock shape as tests/unit/jwt-middleware.test.ts.)
 */
const authServiceMock = vi.hoisted(() => ({ verifyToken: vi.fn() }))
vi.mock('../../src/auth/AuthService', () => ({ authService: authServiceMock }))

import { usePinnedServer } from '../utils/pinned-server'
import { isApiPath } from '../../src/auth/api-path-policy'
import { isWhitelisted, jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import {
  METHOD_OVERRIDDEN_HEADER,
  methodOverrideMiddleware,
  readMethodOverrideHeader,
  resolveMethodOverride,
} from '../../src/middleware/method-override'
import { METHOD_PROBE_PATH, methodProbeRouter } from '../../src/routes/method-probe'
import { attendanceSecurityMiddleware } from '../../src/middleware/attendance-production'

const GOOD = 'Bearer good-token'
/**
 * A GATE EXCEPTION: the real JWT gate lets whitelisted paths and the OAPI `mst_` method-bound
 * allowlist through WITHOUT attaching `req.user`. Modelled here so the "claimed but not honoured"
 * branch is reachable, together with a POST twin on the same path that a fall-through would run.
 */
const WHITELISTED = '/api/public/thing'
let probeHits = 0
let twinExecuted = 0
let seenMethods: string[] = []

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  // Stand-in for the global JWT gate: /api/** requires the bearer; sets req.user on success.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next()
    // The pass-through shapes: authenticated is NOT asserted and `req.user` stays unset.
    if (req.path === WHITELISTED) return next()
    if (req.headers.authorization !== GOOD) {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } })
    }
    req.user = { id: 'u1', tenantId: 't1' }
    next()
  })
  app.use(methodOverrideMiddleware)
  app.use((req, _res, next) => { seenMethods.push(req.method); next() })
  app.post(WHITELISTED, (_req, res) => { twinExecuted += 1; res.status(201).json({ ok: true, twin: 'POST' }) })
  app.use(methodProbeRouter())
  return app
}

const pinned = usePinnedServer()

beforeEach(() => {
  probeHits = 0
  twinExecuted = 0
  seenMethods = []
  const app = buildApp()
  // Count executions of the DELETE handler: only the probe route answers 200 on that URL.
  pinned.setApp((req, res) => {
    res.on('finish', () => {
      if (req.url === METHOD_PROBE_PATH && res.statusCode === 200) probeHits += 1
    })
    app(req, res)
  })
})

describe('method-override middleware + /api/method-probe', () => {
  it('(a) POST + X-HTTP-Method-Override: DELETE with valid auth behaves as DELETE', async () => {
    const res = await request(pinned.url())
      .post(METHOD_PROBE_PATH)
      .set('Authorization', GOOD)
      .set('X-HTTP-Method-Override', 'delete')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, method: 'DELETE', overridden: true })
    expect(seenMethods).toEqual(['DELETE'])
    expect(probeHits).toBe(1)
  })

  it('(b) POST + override without auth is 401 and the route never executes', async () => {
    const res = await request(pinned.url())
      .post(METHOD_PROBE_PATH)
      .set('X-HTTP-Method-Override', 'DELETE')
    expect(res.status).toBe(401)
    expect(seenMethods).toEqual([])
    expect(probeHits).toBe(0)
  })

  it('(c) POST + X-HTTP-Method-Override: PUT is treated as a plain POST (probe has no POST handler)', async () => {
    const res = await request(pinned.url())
      .post(METHOD_PROBE_PATH)
      .set('Authorization', GOOD)
      .set('X-HTTP-Method-Override', 'PUT')
    expect(res.status).toBe(404)
    expect(seenMethods).toEqual(['POST'])
    expect(probeHits).toBe(0)
  })

  it('(c2) only the literal DELETE is accepted — every other value is ignored', () => {
    const base = { method: 'POST', user: { id: 'u1' } }
    expect(resolveMethodOverride({ ...base, headers: { 'x-http-method-override': 'DELETE' } } as Request)).toBe('DELETE')
    expect(resolveMethodOverride({ ...base, headers: { 'x-http-method-override': ' Delete ' } } as Request)).toBe('DELETE')
    for (const v of ['PUT', 'PATCH', 'GET', 'POST', 'DELETE;x', 'DELETEX', '', 'REMOVE']) {
      expect(resolveMethodOverride({ ...base, headers: { 'x-http-method-override': v } } as Request), v).toBeNull()
    }
    // No req.user (whitelisted path / OAPI mst_ allowlist pass-through): never rewritten.
    expect(resolveMethodOverride({ method: 'POST', user: undefined, headers: { 'x-http-method-override': 'DELETE' } } as Request)).toBeNull()
  })

  it('a rewritten request carries the X-Method-Overridden: DELETE receipt', async () => {
    const res = await request(pinned.url())
      .post(METHOD_PROBE_PATH)
      .set('Authorization', GOOD)
      .set('X-HTTP-Method-Override', 'DELETE')
    expect(res.headers['x-method-overridden']).toBe('DELETE')
  })

  it('a REFUSED override (wrong value) carries no receipt — the client must not read it as honoured', async () => {
    const res = await request(pinned.url())
      .post(METHOD_PROBE_PATH)
      .set('Authorization', GOOD)
      .set('X-HTTP-Method-Override', 'PUT')
    expect(res.headers['x-method-overridden']).toBeUndefined()
  })

  it('a plain DELETE carries no receipt (nothing was rewritten)', async () => {
    const res = await request(pinned.url()).delete(METHOD_PROBE_PATH).set('Authorization', GOOD)
    expect(res.headers['x-method-overridden']).toBeUndefined()
  })

  it('readMethodOverrideHeader reports the CLAIM only — no method, no auth involved', () => {
    expect(readMethodOverrideHeader({ headers: { 'x-http-method-override': 'delete' } } as unknown as Request)).toBe('DELETE')
    expect(readMethodOverrideHeader({ headers: { 'x-http-method-override': 'PUT' } } as unknown as Request)).toBeNull()
    expect(readMethodOverrideHeader({ headers: {} } as unknown as Request)).toBeNull()
  })

  it('(d) a plain DELETE is unaffected', async () => {
    const res = await request(pinned.url()).delete(METHOD_PROBE_PATH).set('Authorization', GOOD)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, method: 'DELETE', overridden: false })
    expect(seenMethods).toEqual(['DELETE'])
  })

  /**
   * FAIL CLOSED ON AN UNHONOURED CLAIM (refuter finding).
   *
   * The receipt header lets the CLIENT detect that its POST was not rewritten — after the fact. On
   * a path the gate lets through without `req.user` the server can see the claim itself, and letting
   * such a POST fall through would run the path's POST twin, which on several paths does the exact
   * OPPOSITE of the delete (`POST /api/comments/:id/reactions` ADDS what the DELETE removes, 201).
   * Detection after a committed write is not the same as prevention, so this branch refuses.
   */
  it('(f) POST + override on a gate-exception path is REFUSED, and the POST twin never runs', async () => {
    const res = await request(pinned.url())
      .post(WHITELISTED)
      .set('X-HTTP-Method-Override', 'DELETE')
      .send({ emoji: '👍' })
    expect(res.status).toBe(405)
    expect(res.body?.error?.code).toBe('METHOD_OVERRIDE_NOT_HONORED')
    // The inversion this exists to prevent: the twin did not execute, and nothing downstream ran.
    expect(twinExecuted).toBe(0)
    expect(seenMethods).toEqual([])
    // A refusal is not a rewrite: no receipt may be handed out.
    expect(res.headers['x-method-overridden']).toBeUndefined()
  })

  it('(f2) POSITIVE CONTROL: the same POST without the header reaches the twin (the header is what stops it)', async () => {
    const res = await request(pinned.url()).post(WHITELISTED).send({ emoji: '👍' })
    expect(res.status).toBe(201)
    expect(twinExecuted).toBe(1)
    expect(seenMethods).toEqual(['POST'])
  })

  it('(f3) the refusal is scoped to POST — a GET carrying the header still just proceeds as a GET', async () => {
    // A GET cannot be turned into a wrong write by a POST twin, so it is ignored, not refused.
    const res = await request(pinned.url()).get(WHITELISTED).set('X-HTTP-Method-Override', 'DELETE')
    expect(res.status).toBe(404)
    expect(seenMethods).toEqual(['GET'])
  })

  it('(e) GET + override header is ignored', async () => {
    const res = await request(pinned.url())
      .get(METHOD_PROBE_PATH)
      .set('Authorization', GOOD)
      .set('X-HTTP-Method-Override', 'DELETE')
    expect(res.status).toBe(404)
    expect(seenMethods).toEqual(['GET'])
    expect(probeHits).toBe(0)
  })
})

/**
 * LIMITER EVASION (refuter finding, CONFIRMED before the fix). `pickLimiter`
 * (middleware/attendance-production.ts) selects the import buckets on `req.method === 'POST'`. When the
 * override ran BEFORE `attendanceSecurityMiddleware()`, a `POST /api/attendance/import/commit` carrying
 * the override header arrived at the limiter as a DELETE, matched no bucket, and consumed no token —
 * while the 50 MB import JSON parser had already run. This suite uses the REAL security middleware and
 * the REAL limiter (budget 2/min via env, set in the hoisted block above), mounted in the REAL relative
 * order, so it fails if the mount ever moves back above it.
 */
describe('method-override cannot dodge the attendance import rate limiter', () => {
  const limiterPinned = usePinnedServer()
  const COMMIT_PATH = '/api/attendance/import/commit'
  let executed = 0
  // The limiters are module-level singletons (built once from env), so buckets survive across tests.
  // The key is `<prefix>:<userId>:<ip>` — a per-test user id gives each test a fresh budget of 2.
  let limiterUser = 'limiter-user-0'
  let limiterUserSeq = 0

  function buildLimiterApp(): Express {
    const app = express()
    app.use(express.json())
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (!req.path.startsWith('/api/')) return next()
      if (req.headers.authorization !== GOOD) {
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } })
      }
      req.user = { id: limiterUser, tenantId: 't1' }
      next()
    })
    app.use(attendanceSecurityMiddleware())
    // Mounted AFTER the guard, exactly as in index.ts.
    app.use(methodOverrideMiddleware)
    app.post(COMMIT_PATH, (_req, res) => { executed += 1; res.json({ ok: true, via: 'POST' }) })
    app.delete(COMMIT_PATH, (_req, res) => { executed += 1; res.json({ ok: true, via: 'DELETE' }) })
    return app
  }

  beforeEach(() => {
    executed = 0
    limiterUserSeq += 1
    limiterUser = `limiter-user-${limiterUserSeq}`
    limiterPinned.setApp(buildLimiterApp())
  })

  const post = (override: boolean) => {
    const req = request(limiterPinned.url()).post(COMMIT_PATH).set('Authorization', GOOD)
    return override ? req.set('X-HTTP-Method-Override', 'DELETE') : req
  }

  it('POST + override consumes the SAME bucket as a native POST and is refused identically', async () => {
    // Budget is 2/min for this (user, ip) key. Two native POSTs drain it.
    expect((await post(false)).status).toBe(200)
    expect((await post(false)).status).toBe(200)
    expect(executed).toBe(2)

    // The third request tunnels a DELETE through POST. It must hit the same exhausted bucket.
    const tunnelled = await post(true)
    expect(tunnelled.status).toBe(429)
    expect(tunnelled.body?.error?.code).toBe('RATE_LIMITED')
    // The route never ran, so the rewrite bought nothing.
    expect(executed).toBe(2)
  })

  it('a tunnelled delete consumes a token even when it succeeds (it is not invisible to the limiter)', async () => {
    // First request of a fresh bucket, sent as POST + override: it reaches the DELETE handler AND
    // spends a token, so only ONE native POST fits after it.
    const first = await post(true)
    expect(first.status).toBe(200)
    expect(first.body.via).toBe('DELETE')
    expect((await post(false)).status).toBe(200)
    expect((await post(false)).status).toBe(429)
  })
})

/**
 * A comment stripper that KNOWS ABOUT STRINGS, ported from `apps/web/tests/delete-fallback.spec.ts`
 * (the two packages cannot share a helper). The naive one-liner
 * `src.replace(/\/\*[\s\S]*?\*\//g, '')` is NOT usable here: measured on this very index.ts it
 * treats the `/*` inside string literals as a block-comment opener and deletes to the next `*` `/`
 * anywhere in the file — 259462 chars -> 151997, and EVERY anchor this suite looks for (the gate
 * line, both attendance mounts, the override mount) went to -1. A guard whose parser eats the lines
 * it inspects reports nothing and passes.
 */
const REGEX_ALLOWED_AFTER = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', '',
])

function stripComments(text: string): string {
  let out = ''
  let i = 0
  let prev = ''
  const emit = (chunk: string): void => {
    out += chunk
    const trimmed = chunk.trimEnd()
    if (trimmed) prev = trimmed[trimmed.length - 1]
  }
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === c) { j += 1; break }
        j += 1
      }
      emit(text.slice(i, j))
      i = j
      continue
    }
    if (c === '/' && REGEX_ALLOWED_AFTER.has(prev)) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '[') inClass = true
        else if (text[j] === ']') inClass = false
        else if (text[j] === '/' && !inClass) { j += 1; closed = true; break }
        j += 1
      }
      if (closed) {
        while (j < text.length && /[a-z]/.test(text[j])) j += 1
        emit(text.slice(i, j))
        i = j
        continue
      }
    }
    emit(c)
    i += 1
  }
  return out
}

describe('index.ts wiring', () => {
  const source = readFileSync(join(__dirname, '../../src/index.ts'), 'utf8')
  /**
   * CODE ONLY. Every ordering claim below is about what index.ts DOES, so the comments come out
   * first. Refuter finding: on raw text a COMMENTED-OUT mount line still satisfied `indexOf`, so
   * this suite stayed green with the middleware mounted nowhere. `source` (raw) is kept for the two
   * tests whose anchors are deliberately comments.
   */
  const code = stripComments(source)

  const GATE_LINE = 'if (isApiPath(req.path)) return jwtAuthMiddleware(req, res, next)'
  const SECURITY_MOUNT = 'this.app.use(attendanceSecurityMiddleware())'
  const OVERRIDE_MOUNT = 'this.app.use(methodOverrideMiddleware)'

  it('mounts the override AFTER the JWT gate and AFTER the attendance security guard', () => {
    const gate = code.indexOf(GATE_LINE)
    const security = code.indexOf(SECURITY_MOUNT)
    const override = code.indexOf(OVERRIDE_MOUNT)
    expect(gate).toBeGreaterThan(0)
    expect(security).toBeGreaterThan(gate)
    // The whole point of the limiter suite above: the rewrite may not precede a method-keyed guard.
    expect(override).toBeGreaterThan(security)
    expect(code.split(OVERRIDE_MOUNT).length).toBe(2)
  })

  /**
   * THE STRIPPER IS ITSELF UNDER TEST, in both directions, because everything above rests on it:
   *   - a commented-out mount must DISAPPEAR (otherwise the order check is prose-satisfiable), and
   *   - real code must SURVIVE (otherwise the whole suite passes on an empty string).
   * Both run against this tree's real index.ts, in memory — nothing is written.
   */
  it('a COMMENTED-OUT mount cannot satisfy the order check, and real code survives the stripper', () => {
    // Positive control: the exact text the sabotage below rewrites really is in the file.
    expect(source).toContain(`\n    ${OVERRIDE_MOUNT}`)
    const sabotaged = stripComments(source.replace(`\n    ${OVERRIDE_MOUNT}`, `\n    // ${OVERRIDE_MOUNT}`))
    expect(sabotaged.indexOf(OVERRIDE_MOUNT)).toBe(-1)
    // ...and the same for a block-commented mount, which is the other way to disable it silently.
    const blockSabotaged = stripComments(source.replace(`\n    ${OVERRIDE_MOUNT}`, `\n    /* ${OVERRIDE_MOUNT} */`))
    expect(blockSabotaged.indexOf(OVERRIDE_MOUNT)).toBe(-1)
    // Survival control: a string literal containing the block-comment opener must not eat the file.
    expect(code.indexOf(GATE_LINE)).toBeGreaterThan(0)
    expect(code.indexOf(SECURITY_MOUNT)).toBeGreaterThan(0)
    expect(code.length).toBeGreaterThan(source.length * 0.5)
    expect(stripComments(`const glob = '**/api/**'\n${OVERRIDE_MOUNT}\n`)).toContain(OVERRIDE_MOUNT)
  })

  /**
   * THE E-LEARNING PIPELINE ANCHOR — this PR broke it once and turned `test (18.x)/(20.x)` red.
   * `tests/unit/elearning-media-playback-runtime.test.ts:116` locates the request-log middleware by
   * searching index.ts for this exact template literal, and orders the whole pipeline around it
   * (`metricsAt < loggerAt < jwtAt`). Interpolating the override claim INTO that template made the
   * search return -1 (`expected -1 to be greater than 4755`). The claim now lives in its own branch;
   * this test fails HERE, in the suite that owns the change, if anyone interpolates it again.
   */
  it('keeps the request-log literal the e-learning pipeline guard anchors on', () => {
    const ELEARNING_ANCHOR = /this\.logger\.info\(\s*`\$\{req\.method\} \$\{req\.path\}`\s*\)/
    const setupAt = source.search(/private\s+setupMiddleware\s*\(\s*\)\s*:\s*void\s*\{/)
    const setupEndAt = source.search(/private\s+installGlobalErrorHandler\s*\(\s*\)\s*:\s*void\s*\{/)
    expect(setupAt).toBeGreaterThanOrEqual(0)
    expect(setupEndAt).toBeGreaterThan(setupAt)
    const setupSrc = source.slice(setupAt, setupEndAt)
    const loggerAt = setupSrc.search(ELEARNING_ANCHOR)
    expect(loggerAt).toBeGreaterThanOrEqual(0)
    // It must be CODE, not this file's prose about it: the same search on stripped source still hits.
    expect(stripComments(setupSrc).search(ELEARNING_ANCHOR)).toBeGreaterThanOrEqual(0)
    // And it sits where that guard needs it: after the metrics middleware, before the JWT gate.
    expect(loggerAt).toBeGreaterThan(setupSrc.search(/requestMetricsMiddleware/))
    expect(setupSrc.search(/return\s+jwtAuthMiddleware\s*\(\s*req\s*,\s*res\s*,\s*next\s*\)/)).toBeGreaterThan(loggerAt)
  })

  /**
   * WHAT THIS PINS, stated as narrowly as it is true (refuter finding: the previous name, "nothing
   * mounted between the JWT gate and the override reads req.method", was FALSE for two of the three
   * middlewares it itself listed — and the check never opened either of them).
   *
   * Two of the three DO read the verb, on purpose: `attendanceSecurityMiddleware`'s `pickLimiter` is
   * the entire reason the override is mounted below it, and `attendanceAuditMiddleware` captures the
   * wire verb for the audit row. So the claim is: in that window, the ONLY reads of `req.method` are
   * the ones allow-listed below, one line each. A new verb-keyed read in attendance-production.ts
   * turns this red and has to be reviewed against the mount order rather than sliding in.
   */
  it('in the gate→override window, req.method is read ONLY by the allow-listed attendance lines', () => {
    const gate = code.indexOf(GATE_LINE)
    const override = code.indexOf(OVERRIDE_MOUNT)
    expect(gate).toBeGreaterThan(0)
    expect(override).toBeGreaterThan(gate)
    // Comments were stripped first (string-aware, see above): prose about `req.method` — index.ts's
    // own mount note explains the ordering rule — must not be able to satisfy or break a claim about
    // CODE, and a commented-out mount must not be able to bound this window either.
    const window = code.slice(gate, override)
    // Inline middleware in that window (the tenant ALS wrapper) must not key on the verb...
    expect(window).not.toMatch(/req\.method/)
    // ...and the imported ones it mounts there are enumerated, then each one is actually opened.
    const mounted = [...window.matchAll(/this\.app\.use\(([A-Za-z]+)/g)].map((m) => m[1])
    expect(mounted).toEqual(['correlationContextEnrichmentMiddleware', 'attendanceAuditMiddleware', 'attendanceSecurityMiddleware'])

    const correlation = readFileSync(join(__dirname, '../../src/middleware/correlation.ts'), 'utf8')
    // Just that function's own body — the module also exports an error handler further down that
    // legitimately logs the verb, and it is not mounted in this window.
    const start = correlation.indexOf('export function correlationContextEnrichmentMiddleware')
    const end = correlation.indexOf('export ', start + 1)
    const enrichment = correlation.slice(start, end > start ? end : undefined)
    expect(enrichment).toContain('enrichRequestContext(')
    expect(enrichment).not.toMatch(/req\.method/)

    // The module that hosts BOTH attendance middlewares, read line by line. `req.methodOverride` is
    // not a verb read (no word boundary after `method`), so the pattern below skips it by itself.
    const attendance = stripComments(
      readFileSync(join(__dirname, '../../src/middleware/attendance-production.ts'), 'utf8'),
    )
    const reads = attendance.split(/\r?\n/).map((l) => l.trim()).filter((l) => /req\.method\b/.test(l)).sort()
    expect(reads).toEqual([
      // attendanceAuditMiddleware: the wire verb, captured ONCE at request time and used for
      // `action`, `meta.request.method` and the operation label (one row, one verb).
      'const method = req.method',
      // shouldLogAuditForRequest: audit VOLUME filter (skip plain reads). Not a routing or
      // authorisation decision — a tunnelled delete arrives here as POST and is logged either way.
      "if (req.method !== 'GET') return true",
      // pickLimiter: the intentional verb-keyed guard. THIS is why the override is mounted below.
      "if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/commit-async`) && req.method === 'POST') {",
      "if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/commit`) && req.method === 'POST') {",
      "if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/prepare`) && req.method === 'POST') {",
      "if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/preview-async`) && req.method === 'POST') {",
      "if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/preview`) && req.method === 'POST') {",
      "if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/upload-artifact`) && req.method === 'POST') {",
      "if (apiPathEquals(path, `${ATTENDANCE_IMPORT_PREFIX}/upload`) && req.method === 'POST') {",
      "if (apiPathEquals(path, `${ATTENDANCE_PREFIX}/export`) && req.method === 'GET') {",
      "if (apiPathHasPrefix(path, ATTENDANCE_ADMIN_PREFIX) && req.method !== 'GET') {",
      "if (isCsvExportPath(path) && req.method === 'GET') {",
      // Metric label on a refusal — reporting, no decision.
      'attendanceRateLimitedTotal.inc({ route: routeLabel, method: req.method })',
    ].sort())
  })

  it('the pre-auth request log records the override CLAIM without rewriting anything', () => {
    const log = source.slice(source.indexOf('// 请求日志'), source.indexOf('// 全局 JWT'))
    expect(log).toContain('readMethodOverrideHeader(req)')
    expect(log).toContain('methodOverride=')
    // A rewrite here would be a pre-auth rewrite — the one thing this middleware must never do.
    expect(log).not.toMatch(/req\.method\s*=/)
  })

  it('does NOT carry the dead AuditService marker (that middleware is mounted nowhere)', () => {
    const auditService = readFileSync(join(__dirname, '../../src/audit/AuditService.ts'), 'utf8')
    expect(auditService).not.toContain('methodOverride')
    expect(source).not.toContain('auditService.middleware(')
    // The audit hook that IS wired keeps the marker.
    const wired = readFileSync(join(__dirname, '../../src/guards/audit-integration.ts'), 'utf8')
    expect(wired).toContain('req.methodOverride')
  })

  it('names the receipt header in the explicit CORS exposedHeaders list', () => {
    expect(source).toContain("exposedHeaders: ['X-Correlation-ID', 'X-Method-Overridden']")
    expect(METHOD_OVERRIDDEN_HEADER).toBe('X-Method-Overridden')
  })

  it('registers the probe router after the health handlers', () => {
    const health = source.indexOf("this.app.get('/api/health', healthHandler)")
    const probe = source.indexOf('this.app.use(methodProbeRouter())')
    expect(health).toBeGreaterThan(0)
    expect(probe).toBeGreaterThan(health)
  })
})

/**
 * RUNTIME WIRING, not text (judge finding: the gate→override relationship was only ever checked by
 * an `indexOf` over index.ts). This suite runs the REAL gate middleware (`jwtAuthMiddleware`,
 * reached exactly the way index.ts reaches it), the REAL override middleware and the REAL probe
 * router over a REAL socket — `usePinnedServer`, never `request(app)` (#4154). Only
 * `authService.verifyToken` is stubbed: it is the single step that needs a database.
 *
 * The gate closure below is index.ts's; its decisive line and the mount order are pinned as text by
 * the wiring suite above, so behaviour proven here and the real pipeline cannot drift apart
 * silently.
 */
describe('real JWT gate -> real override -> real probe, over a socket', () => {
  const realPinned = usePinnedServer()
  const SESSION = 'Bearer session-token'
  const MUST_CHANGE = 'Bearer must-change-token'

  beforeEach(() => {
    authServiceMock.verifyToken.mockReset()
    authServiceMock.verifyToken.mockImplementation(async (token: string) => {
      if (token === 'session-token') return { id: 'u-real', tenantId: 't-real', must_change_password: false }
      if (token === 'must-change-token') return { id: 'u-new', tenantId: 't-real', must_change_password: true }
      return null
    })
    const app = express()
    app.use(express.json())
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (isWhitelisted(req.path)) return next()
      if (isApiPath(req.path)) return jwtAuthMiddleware(req, res, next)
      return next()
    })
    app.use(methodOverrideMiddleware)
    app.use(methodProbeRouter())
    realPinned.setApp(app)
  })

  it('POST /api/method-probe + X-HTTP-Method-Override: DELETE + a valid session -> 200 with the receipt', async () => {
    const res = await request(realPinned.url())
      .post(METHOD_PROBE_PATH)
      .set('Authorization', SESSION)
      .set('X-HTTP-Method-Override', 'DELETE')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, method: 'DELETE', overridden: true })
    expect(res.headers['x-method-overridden']).toBe('DELETE')
    // The gate really ran (this is what attaches `req.user`, without which nothing is rewritten).
    expect(authServiceMock.verifyToken).toHaveBeenCalledWith('session-token')
  })

  it('the very same POST without a session is 401 from the gate and carries no receipt', async () => {
    const res = await request(realPinned.url())
      .post(METHOD_PROBE_PATH)
      .set('X-HTTP-Method-Override', 'DELETE')
    expect(res.status).toBe(401)
    expect(res.headers['x-method-overridden']).toBeUndefined()
  })

  /**
   * THE SERVER HALF OF THE PROBE-LATCH FINDING. A first login whose password must change is answered
   * 403 `PASSWORD_CHANGE_REQUIRED` by the gate — ABOVE this middleware, on every /api path including
   * the probe — so the answer says NOTHING about whether the tunnel works. This test states that
   * shape (403, no receipt) as a server fact; the client half (that a receipt-less >= 400 must not
   * latch 'override-unavailable') is pinned in apps/web/tests/delete-fallback.spec.ts.
   */
  it('a session that must change its password is 403 at the gate, with no receipt', async () => {
    const res = await request(realPinned.url())
      .post(METHOD_PROBE_PATH)
      .set('Authorization', MUST_CHANGE)
      .set('X-HTTP-Method-Override', 'DELETE')
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('PASSWORD_CHANGE_REQUIRED')
    expect(res.headers['x-method-overridden']).toBeUndefined()
  })

  it('a native DELETE through the same real gate answers identically, minus the receipt', async () => {
    const res = await request(realPinned.url()).delete(METHOD_PROBE_PATH).set('Authorization', SESSION)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, method: 'DELETE', overridden: false })
    expect(res.headers['x-method-overridden']).toBeUndefined()
  })
})
