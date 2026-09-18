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
import { beforeEach, describe, expect, it } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'
import { methodOverrideMiddleware, resolveMethodOverride } from '../../src/middleware/method-override'
import { METHOD_PROBE_PATH, methodProbeRouter } from '../../src/routes/method-probe'

const GOOD = 'Bearer good-token'
let probeHits = 0
let seenMethods: string[] = []

function buildApp(): Express {
  const app = express()
  app.use(express.json())
  // Stand-in for the global JWT gate: /api/** requires the bearer; sets req.user on success.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next()
    if (req.headers.authorization !== GOOD) {
      return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED' } })
    }
    req.user = { id: 'u1', tenantId: 't1' }
    next()
  })
  app.use(methodOverrideMiddleware)
  app.use((req, _res, next) => { seenMethods.push(req.method); next() })
  app.use(methodProbeRouter())
  return app
}

const pinned = usePinnedServer()

beforeEach(() => {
  probeHits = 0
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

  it('(d) a plain DELETE is unaffected', async () => {
    const res = await request(pinned.url()).delete(METHOD_PROBE_PATH).set('Authorization', GOOD)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, method: 'DELETE', overridden: false })
    expect(seenMethods).toEqual(['DELETE'])
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

describe('index.ts wiring', () => {
  const source = readFileSync(join(__dirname, '../../src/index.ts'), 'utf8')

  it('mounts the override right after the global JWT gate and before post-auth enrichment', () => {
    const gate = source.indexOf('if (isApiPath(req.path)) return jwtAuthMiddleware(req, res, next)')
    const override = source.indexOf('this.app.use(methodOverrideMiddleware)')
    const enrichment = source.indexOf('this.app.use(correlationContextEnrichmentMiddleware)')
    expect(gate).toBeGreaterThan(0)
    expect(override).toBeGreaterThan(gate)
    expect(enrichment).toBeGreaterThan(override)
    // Exactly one mount, and nothing else registered between the gate's closing and the override
    // except the gate's own closing braces/comments.
    expect(source.split('this.app.use(methodOverrideMiddleware)').length).toBe(2)
    expect(source.slice(gate, override)).not.toMatch(/this\.app\.use\((?!methodOverrideMiddleware)/)
  })

  it('registers the probe router after the health handlers', () => {
    const health = source.indexOf("this.app.get('/api/health', healthHandler)")
    const probe = source.indexOf('this.app.use(methodProbeRouter())')
    expect(health).toBeGreaterThan(0)
    expect(probe).toBeGreaterThan(health)
  })
})
