/**
 * C-1 "dormant merge" condition 2 — the DYNAMIC half of the unreachability check.
 *
 * The static census (`tests/unit/approval-cancel-round-dormancy-unreachable.test.ts`) proves no
 * production source TEXT names `createCancelRoundInstance`. That scan can be defeated by exactly
 * one mechanism: dispatch that never spells the name in a source file this scan walks — a plugin
 * loaded at runtime from `cwd/plugins`, a handler registered from data, a property access built at
 * runtime. This probe attacks THAT mechanism instead of re-asserting the same text claim:
 *
 *   1. wrap `ApprovalProductService.prototype.createCancelRoundInstance` with a counter BEFORE the
 *      server module is imported, so every dispatch form (direct call, `svc[key]`, `Reflect.get`,
 *      a plugin's own reference) passes through the wrapper;
 *   2. boot the REAL server — real plugin loader, real route registration, real schedulers;
 *   3. enumerate the express route table and the plugin/event registrations that actually exist at
 *      runtime, and print them (the enumeration is evidence, not just an assertion input);
 *   4. fire every enumerated GET route plus the approval mutation routes with a real token;
 *   5. assert the counter is still 0.
 *
 * POSITIVE CONTROLS (this probe is worthless without them):
 *   `DORMANCY_PROBE_CONTROL=self`  — the probe itself calls the wrapped method once. If the counter
 *                                    does not move, the wrapper is not on the prototype the app
 *                                    actually uses and every "0" below is meaningless.
 *   `DORMANCY_PROBE_CONTROL=none`  — the real run.
 *
 * Exit code 0 = dormant. Non-zero = a reachable entry point exists (or a control failed).
 *
 * WHAT "routes fired" DOES AND DOES NOT BUY, stated plainly so the number is not over-read:
 * every concrete route is INVOKED, but most POSTs are sent `{}` with synthetic `:param` values, so
 * a large share are answered by validation/authorization before any business logic runs. The
 * counter's guarantee is therefore "no handler that actually executed reached the method" — NOT
 * "every code path behind every route was explored". Route depth is a named residual, and it is why
 * the STATIC census, not this probe, is the load-bearing half of the unreachability claim; this
 * probe exists to close the one hole the static census cannot see (runtime/dynamic dispatch).
 *
 * ROUND 3 — WIRING DAY (registration item L-4 of the product-entry errata v2): the product entry's
 * phase A registers exactly two routes whose path names the entry, `GET` and `POST
 * /api/attendance/requests/:id/cancel-round` (plugin-attendance, P-1 Q1′ = (i)). L-4 requires this
 * probe to move from 「no route names it, reach = 0」 to 「only the NAMED entry points exist, and any
 * reach goes through the NAMED entry port」 in the same commit. So:
 *   - `NAMED_ENTRY_ROUTES` is the exact (method, path) allow-list; any OTHER route matching a
 *     cancel-round token still fails (exit 2), and a named route that is MISSING also fails (exit 5 —
 *     the allow-list must not silently outlive the routes it names);
 *   - a reach is tolerated only when its stack passes through `NAMED_ENTRY_PORT_MODULE`; any other
 *     reach still fails (exit 1). With synthetic `:id` values the named routes answer 400 before any
 *     lookup, so the expected real-run count is still 0 — the stack rule is what keeps the probe
 *     honest if a future run fires them with real ids.
 *
 * HOME: this file lives under `tests/` on purpose. It NAMES `createCancelRoundInstance`, and the
 * static census's whole point is that no PRODUCTION source may name it — a harness parked in a
 * production root would have to be waved through by an allowlist, i.e. exactly the hole the census
 * exists to close. Being a test source, it is partitioned out by the census's `TEST_PATH_MARKERS`
 * with no exemption of its own, and the census's own positive control then pins it by name as one
 * of the excluded callers.
 */
import type { Server } from 'node:http'

const CONTROL = process.env.DORMANCY_PROBE_CONTROL ?? 'none'

/** Round 3 (L-4): the exact entry routes the product entry's phase A registers. */
const NAMED_ENTRY_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/attendance/requests/:id/cancel-round' },
  { method: 'POST', path: '/api/attendance/requests/:id/cancel-round' },
]
/** Round 3 (L-4): the one production module allowed on a reach stack. */
const NAMED_ENTRY_PORT_MODULE = 'approval-cancel-round-entry-port'

function isNamedEntryRoute(route: { method: string; path: string }): boolean {
  return NAMED_ENTRY_ROUTES.some((named) => named.method === route.method && named.path === route.path)
}

async function main(): Promise<number> {
  const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')

  const proto = ApprovalProductService.prototype as unknown as Record<string, unknown>
  const original = proto.createCancelRoundInstance
  if (typeof original !== 'function') {
    console.error('[probe] FATAL: createCancelRoundInstance is not on the prototype — nothing to instrument')
    return 3
  }
  let reachCount = 0
  const reachedVia: string[] = []
  proto.createCancelRoundInstance = function patched(this: unknown, ...args: unknown[]) {
    reachCount += 1
    reachedVia.push(new Error('reached').stack ?? '<no stack>')
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  }

  const { MetaSheetServer } = await import('../../src/index')
  const port = Number(process.env.PORT ?? '7899')
  const server = new MetaSheetServer({ port, manageProcessSignals: false })
  await server.start()

  const app = (server as unknown as { app: { _router?: { stack?: unknown[] } } }).app

  // ---- 3. enumerate the route table that actually got registered ----
  interface Layer { route?: { path?: unknown; methods?: Record<string, boolean> }; handle?: { stack?: Layer[] }; name?: string }
  const routes: { method: string; path: string }[] = []
  const walkStack = (stack: Layer[] | undefined, prefix: string): void => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const p = Array.isArray(layer.route.path) ? layer.route.path.join(',') : String(layer.route.path)
        for (const m of Object.keys(layer.route.methods ?? {})) routes.push({ method: m.toUpperCase(), path: prefix + p })
      } else if (layer.handle?.stack) {
        walkStack(layer.handle.stack, prefix)
      }
    }
  }
  walkStack(app._router?.stack as Layer[] | undefined, '')
  routes.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method))

  const CANCEL_ROUND_PATH_TOKENS = ['cancel-round', 'cancelround', 'cancel_round', '撤销轮']
  const tokenRoutes = routes.filter((r) =>
    CANCEL_ROUND_PATH_TOKENS.some((t) => r.path.toLowerCase().includes(t)))
  const suspiciousRoutes = tokenRoutes.filter((r) => !isNamedEntryRoute(r))
  const missingNamedRoutes = NAMED_ENTRY_ROUTES.filter(
    (named) => !routes.some((r) => r.method === named.method && r.path === named.path),
  )

  console.log(`[probe] registered routes: ${routes.length}`)
  console.log(`[probe] routes matching a cancel-round token: ${tokenRoutes.length} ${JSON.stringify(tokenRoutes)}`)
  console.log(`[probe] of which NOT in the named allow-list: ${suspiciousRoutes.length} ${JSON.stringify(suspiciousRoutes)}`)
  console.log(`[probe] named entry routes missing from the table: ${missingNamedRoutes.length} ${JSON.stringify(missingNamedRoutes)}`)

  // ---- 4. fire every enumerated route ----
  const base = `http://127.0.0.1:${port}`
  const tokenRes = await fetch(`${base}/api/auth/dev-token?userId=probe-admin&roles=admin&perms=*:*&tenantId=default`)
  const token = ((await tokenRes.json()) as { token?: string }).token ?? ''
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  let fired = 0
  for (const r of routes) {
    if (r.method !== 'GET' && r.method !== 'POST') continue
    // Only fire concrete paths; a `:param` path is fired with a synthetic id.
    const url = base + r.path.replace(/:[A-Za-z0-9_]+/g, 'probe-synthetic-id')
    if (url.includes('*')) continue
    try {
      await fetch(url, {
        method: r.method,
        headers,
        ...(r.method === 'POST' ? { body: '{}' } : {}),
        signal: AbortSignal.timeout(4000),
      })
      fired += 1
    } catch {
      // A route that errors is still a route that was exercised; a timeout is not evidence of reach.
    }
  }
  console.log(`[probe] routes fired: ${fired}`)

  if (CONTROL === 'self') {
    try {
      await (proto.createCancelRoundInstance as (...a: unknown[]) => Promise<unknown>).call(
        Object.create(ApprovalProductService.prototype),
        'probe-doc',
        { userId: 'probe' },
      )
    } catch {
      // The call is expected to throw (no such document). What matters is that it passed the wrapper.
    }
  }

  console.log(`[probe] createCancelRoundInstance reach count: ${reachCount}`)

  await new Promise<void>((resolve) => {
    const http = (server as unknown as { httpServer: Server }).httpServer
    http.close(() => resolve())
    setTimeout(resolve, 3000)
  })

  if (CONTROL === 'self') {
    if (reachCount < 1) {
      console.error('[probe] POSITIVE CONTROL FAILED: the counter did not move on a direct call — the wrapper is not load-bearing')
      return 4
    }
    console.log('[probe] POSITIVE CONTROL PASSED: counter moved on a direct call')
    return 0
  }

  const unnamedReaches = reachedVia.filter((stack) => !stack.includes(NAMED_ENTRY_PORT_MODULE))
  if (unnamedReaches.length !== 0) {
    console.error(`[probe] FAIL: createCancelRoundInstance was reached ${unnamedReaches.length} time(s) outside the named entry port:`)
    for (const s of unnamedReaches) console.error(s)
    return 1
  }
  if (suspiciousRoutes.length !== 0) {
    console.error('[probe] FAIL: a route path outside the named allow-list names a cancel-round entry point')
    return 2
  }
  if (missingNamedRoutes.length !== 0) {
    console.error('[probe] FAIL: a named entry route is missing — the allow-list outlived the routes it names')
    return 5
  }
  console.log(
    `[probe] PASS: only the named entry routes exist; reaches through the named port: ${reachCount - unnamedReaches.length}, elsewhere: 0`,
  )
  return 0
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('[probe] crashed', err)
  process.exit(9)
})
