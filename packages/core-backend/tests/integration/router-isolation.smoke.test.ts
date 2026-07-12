/**
 * Real-app router-isolation smoke test.
 *
 * INVARIANT: a router mounted with `app.use('/api', someRouter)` must only handle the paths it owns.
 *
 * Express runs a PATH-LESS `router.use(middleware)` for EVERY request that enters that router — and a
 * router mounted at '/api' is entered by every `/api/*` request, including ones that belong to routers
 * mounted AFTER it. So a path-less `router.use(...)` inside such a router can intercept, reject, or
 * short-circuit foreign traffic (e.g. all of `/api/multitable/*`, `/api/workflow/*`, `/api/admin/*`)
 * before it ever reaches its own router. Middleware in a router mounted at a shared prefix must
 * therefore be bound to the paths that router actually owns (`router.use('/thing', mw)`), never added
 * path-less.
 *
 * Route-level UNIT tests structurally cannot catch this: they mount one router in isolation, so every
 * path exercised belongs to that router and a leak is invisible. Only real app assembly shows it.
 *
 * The cheapest total check for the whole `/api` surface: an AUTHENTICATED request to an `/api` path
 * that no router owns must fall through every router and end in 404. If any router under `/api`
 * intercepts traffic it does not own, this probe comes back as that router's rejection (403/503/…)
 * instead of 404 — and this test fails, naming the interception.
 *
 * This is a generic architectural guard, not a test of any particular endpoint: it stays correct as
 * routers are added, and needs no knowledge of individual routes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import net from 'net'

// A path deliberately owned by NO router. If any /api router intercepts foreign traffic, it answers this.
const UNOWNED_API_PATH = '/api/__router_isolation_probe__/no-router-owns-this'

describe('router isolation — no /api router may intercept traffic it does not own', () => {
  let server: MetaSheetServer
  let baseUrl = ''
  let authToken = ''
  const probeUserId = 'test-user-router-isolation'

  beforeAll(async () => {
    // Setup HARD-FAILS. A silent `return` here would leave every assertion below unexecuted while the
    // suite still reported green — the exact false-green this test exists to prevent.
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) throw new Error('router-isolation smoke: cannot bind an ephemeral port')

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
    await server.start()
    const address = server.getAddress()
    if (!address || !address.port) throw new Error('router-isolation smoke: server did not report an address')
    baseUrl = `http://127.0.0.1:${address.port}`

    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(probeUserId)}`)
    if (tokenRes.status !== 200) {
      throw new Error(`router-isolation smoke: dev-token request failed (${tokenRes.status})`)
    }
    const tokenJson = (await tokenRes.json()) as { token?: string }
    if (!tokenJson.token) throw new Error('router-isolation smoke: dev-token response carried no token')
    authToken = tokenJson.token
  })

  afterAll(async () => {
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) {
      await server.stop()
    }
  })

  it('an unauthenticated /api request is rejected by the auth chain (probe is behind auth)', async () => {
    // Positive control: proves the probe path really does traverse the /api middleware chain, so a 404
    // in the next test means "fell through the routers", not "never entered the app".
    const res = await fetch(`${baseUrl}${UNOWNED_API_PATH}`)
    expect(res.status).toBe(401)
  })

  it('an AUTHENTICATED request to an /api path no router owns falls through to 404 (no router intercepts foreign traffic)', async () => {
    const res = await fetch(`${baseUrl}${UNOWNED_API_PATH}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })

    // 404 = every /api router correctly declined a path it does not own.
    // Anything else (typically 403/503 from a guard) = some router under /api is running middleware
    // against traffic belonging to other routers — it would reject those routers' real requests too.
    expect(
      res.status,
      `Expected 404 for an /api path no router owns, got ${res.status}. Some router mounted under /api is ` +
        `intercepting foreign traffic — most likely a PATH-LESS router.use(middleware) in a router mounted ` +
        `at app.use('/api', ...). Bind that middleware to the paths the router owns instead.`,
    ).toBe(404)
  })
})
