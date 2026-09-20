/**
 * utils/delete-fallback.ts — DELETE transport fallback for an egress that silently drops HTTP DELETE.
 *
 * Pins: the probe flips the mode only on a network-level failure; native mode buys exactly one
 * POST+override retry and only on a network-level failure (an HTTP 404 is an answer -> no retry);
 * override mode sends POST+header from the start; sessionStorage being unusable does not break any
 * of it. Mutation evidence (in-memory, not committed): dropping the `isNetworkLevelFailure` condition
 * in `sendDelete` turns the "404 -> no retry" case red.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DELETE_TRANSPORT_STORAGE_KEY,
  DELETE_TRANSPORT_UNCONFIRMED,
  DELETE_UNCONFIRMED_COPY,
  METHOD_OVERRIDDEN_HEADER,
  METHOD_OVERRIDE_HEADER,
  METHOD_PROBE_PATH,
  getDeleteTransport,
  isDeleteTransportError,
  isNetworkLevelFailure,
  probeDeleteTransport,
  resetDeleteTransportForTests,
  sendDelete,
  setDeleteTransport,
} from '../src/utils/delete-fallback'

function transportFailure(): TypeError {
  return new TypeError('Failed to fetch')
}

/**
 * `receipt` = the server stamped `X-Method-Overridden: DELETE`, i.e. THIS server rewrote the POST.
 * Its absence on a 2xx is the inversion hazard the module exists to refuse.
 */
function response(status: number, opts: { receipt?: boolean; body?: unknown } = {}): Response {
  const headers = new Headers()
  if (opts.receipt) headers.set(METHOD_OVERRIDDEN_HEADER, 'DELETE')
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers,
    json: async () => {
      if (opts.body === undefined) throw new SyntaxError('no body')
      return opts.body
    },
  } as unknown as Response
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers
  if (headers instanceof Headers) return headers.get(name)
  if (headers && typeof headers === 'object') {
    const record = headers as Record<string, string>
    const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? record[key] : null
  }
  return null
}

describe('delete-fallback', () => {
  beforeEach(() => {
    sessionStorage.clear()
    resetDeleteTransportForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('probeDeleteTransport', () => {
    it('stays native when the probe DELETE gets ANY HTTP response (200)', async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(200))
      expect(await probeDeleteTransport(baseFetch)).toBe('native')
      expect(getDeleteTransport()).toBe('native')
      expect(baseFetch).toHaveBeenCalledTimes(1)
      expect(baseFetch.mock.calls[0][0]).toBe(METHOD_PROBE_PATH)
      expect(baseFetch.mock.calls[0][1].method).toBe('DELETE')
    })

    it('stays native on a 4xx/5xx response: a status means DELETE reached the server', async () => {
      for (const status of [401, 404, 500]) {
        resetDeleteTransportForTests()
        const baseFetch = vi.fn().mockResolvedValue(response(status))
        expect(await probeDeleteTransport(baseFetch)).toBe('native')
      }
    })

    it('native DELETE dropped + tunnel CONFIRMED by the receipt header -> override, persisted', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(200, { receipt: true }))
      expect(await probeDeleteTransport(baseFetch)).toBe('override')
      expect(getDeleteTransport()).toBe('override')
      expect(sessionStorage.getItem(DELETE_TRANSPORT_STORAGE_KEY)).toBe('override')
      // Second leg really was the tunnel: POST + the override header, same probe path.
      const tunnel = baseFetch.mock.calls[1]
      expect(tunnel[0]).toBe(METHOD_PROBE_PATH)
      expect(tunnel[1].method).toBe('POST')
      expect(headerOf(tunnel[1], METHOD_OVERRIDE_HEADER)).toBe('DELETE')
    })

    /**
     * THE PROBE MAY NOT ACCEPT A WEAKER PROOF THAN `sendDelete` DEMANDS. `/api/method-probe` reports
     * `overridden: true` in its body as well, and an earlier draft latched on that alone. A hop that
     * strips the response header strips it from every delete too, so the probe would have promised a
     * tunnel whose very first use then failed the receipt gate. Body-only is NOT confirmation.
     */
    it('native DELETE dropped + tunnel says overridden in the BODY but sends NO receipt -> override-unavailable', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(200, { body: { ok: true, method: 'DELETE', overridden: true } }))
      expect(await probeDeleteTransport(baseFetch)).toBe('override-unavailable')
      expect(sessionStorage.getItem(DELETE_TRANSPORT_STORAGE_KEY)).toBe('override-unavailable')
    })

    it('native DELETE dropped + tunnel answers 200 WITHOUT confirmation -> override-unavailable', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(200, { body: { ok: true, overridden: false } }))
      expect(await probeDeleteTransport(baseFetch)).toBe('override-unavailable')
      expect(sessionStorage.getItem(DELETE_TRANSPORT_STORAGE_KEY)).toBe('override-unavailable')
    })

    it('native DELETE dropped + tunnel REFUSED (404: no such middleware/route) -> override-unavailable', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(404))
      expect(await probeDeleteTransport(baseFetch)).toBe('override-unavailable')
    })

    /**
     * The status is not the bit. A receipt-carrying 404 means THIS server rewrote the POST and the
     * DELETE route simply is not there (middleware present, probe route absent) — the tunnel is
     * proven, which is exactly what `sendDelete` concludes from the same header on a 4xx.
     */
    it('a receipt-carrying 404 from the tunnel still proves the rewrite -> override', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(404, { receipt: true }))
      expect(await probeDeleteTransport(baseFetch)).toBe('override')
    })

    /**
     * FIRE-AND-FORGET CONTRACT. `main.ts` calls this as `void probeDeleteTransport(...)` from inside
     * `router.beforeEach`, after `bootstrapSession()` succeeds (apps/web/src/main.ts:113). A rejected
     * promise there would be an unhandled rejection on every navigation of a broken session, and any
     * synchronous throw would break the guard itself and leave the app unrendered. Neither may happen
     * for ANY baseFetch behaviour — including one that throws before it ever returns a promise.
     */
    it('never throws and never rejects, whatever baseFetch does', async () => {
      const syncThrower = vi.fn(() => { throw new Error('boom') }) as unknown as typeof fetch
      expect(await probeDeleteTransport(syncThrower as never)).toBe('native')

      resetDeleteTransportForTests()
      const nonError = vi.fn().mockRejectedValue('a string, not an Error')
      expect(await probeDeleteTransport(nonError)).toBe('native')

      resetDeleteTransportForTests()
      // A response object with no usable `headers` at all: `hasOverrideReceipt` must absorb it.
      const headerless = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce({ status: 200 } as unknown as Response)
      expect(await probeDeleteTransport(headerless)).toBe('override-unavailable')
    })

    it('both legs get no response -> nothing learned, mode left at native', async () => {
      const baseFetch = vi.fn().mockRejectedValue(transportFailure())
      expect(await probeDeleteTransport(baseFetch)).toBe('native')
      expect(baseFetch).toHaveBeenCalledTimes(2)
    })

    /**
     * PLAYWRIGHT-SPEC HAZARD (attendance-web-guard, 6/6 red on this branch before the fix).
     * `apps/web/verification/attendance-makeup-request.spec.ts` installs
     * `page.route('**\/api/**', route => route.abort())` for everything it did not explicitly mock. The
     * probe's `DELETE /api/method-probe` is unmocked, so it is ABORTED — which is a network-level
     * failure. The pre-fix module latched `override` on that alone, after which every later DELETE in
     * the spec left as a POST, matched none of the spec's DELETE mocks, was aborted too, and the suite
     * timed out. With both legs aborted nothing is learned: the transport must stay `native`, and a
     * later mocked DELETE must go out as a plain DELETE.
     */
    it('probe native aborted AND override aborted -> stays native; the next DELETE is sent natively', async () => {
      const aborted = () => {
        const err = new Error('net::ERR_FAILED')
        err.name = 'TypeError'
        return err
      }
      const probeFetch = vi.fn().mockRejectedValue(aborted())
      expect(await probeDeleteTransport(probeFetch)).toBe('native')
      expect(probeFetch).toHaveBeenCalledTimes(2)
      expect(probeFetch.mock.calls[0][1].method).toBe('DELETE')
      expect(probeFetch.mock.calls[1][1].method).toBe('POST')
      expect(getDeleteTransport()).toBe('native')

      // A later, properly mocked DELETE leaves as a DELETE — the spec's route mock still matches.
      const baseFetch = vi.fn().mockResolvedValue(response(200))
      const res = await sendDelete(baseFetch, '/api/attendance/makeup-requests/m1')
      expect(res.status).toBe(200)
      expect(baseFetch).toHaveBeenCalledTimes(1)
      expect(baseFetch.mock.calls[0][1].method).toBe('DELETE')
      expect(headerOf(baseFetch.mock.calls[0][1], METHOD_OVERRIDE_HEADER)).toBeNull()
    })

    it('after override-unavailable, sendDelete never sends a POST again this session', async () => {
      const probeFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(200))
      expect(await probeDeleteTransport(probeFetch)).toBe('override-unavailable')

      const baseFetch = vi.fn().mockRejectedValue(transportFailure())
      await expect(sendDelete(baseFetch, '/api/x/1')).rejects.toBeInstanceOf(TypeError)
      expect(baseFetch).toHaveBeenCalledTimes(1)
      expect(baseFetch.mock.calls[0][1].method).toBe('DELETE')
    })

    it('a native leg that TIMES OUT (8s guard) is a dropped DELETE, and the tunnel leg decides', async () => {
      vi.useFakeTimers()
      const baseFetch = vi.fn()
        // Native leg: never answers; only the 8s abort ends it.
        .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }))
        // Tunnel leg: answers with the receipt.
        .mockResolvedValueOnce(response(200, { receipt: true }))
      const settled = probeDeleteTransport(baseFetch, { timeoutMs: 8000 })
      await vi.advanceTimersByTimeAsync(7999)
      expect(getDeleteTransport()).toBe('native')
      expect(baseFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await settled).toBe('override')
      expect(baseFetch).toHaveBeenCalledTimes(2)
    })

    it('runs once per session: concurrent and later calls share the first result', async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(200))
      await Promise.all([probeDeleteTransport(baseFetch), probeDeleteTransport(baseFetch)])
      await probeDeleteTransport(baseFetch)
      expect(baseFetch).toHaveBeenCalledTimes(1)
    })

    it('does not probe again once the session already learned override', async () => {
      setDeleteTransport('override')
      const baseFetch = vi.fn()
      expect(await probeDeleteTransport(baseFetch)).toBe('override')
      expect(baseFetch).not.toHaveBeenCalled()
    })

    it('does not probe again once the session learned override-unavailable', async () => {
      setDeleteTransport('override-unavailable')
      const baseFetch = vi.fn()
      expect(await probeDeleteTransport(baseFetch)).toBe('override-unavailable')
      expect(baseFetch).not.toHaveBeenCalled()
    })

    it('a non-network rejection leaves the mode untouched', async () => {
      const baseFetch = vi.fn().mockRejectedValue(new Error('domain error'))
      expect(await probeDeleteTransport(baseFetch)).toBe('native')
    })
  })

  describe('sendDelete in native mode', () => {
    it('sends a plain DELETE and returns the response', async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(200))
      const res = await sendDelete(baseFetch, '/api/x/1', { headers: { 'x-tenant-id': 't1' } })
      expect(res.status).toBe(200)
      expect(baseFetch).toHaveBeenCalledTimes(1)
      expect(baseFetch.mock.calls[0][1].method).toBe('DELETE')
      expect(headerOf(baseFetch.mock.calls[0][1], METHOD_OVERRIDE_HEADER)).toBeNull()
    })

    it('network-level failure -> exactly one retry as POST + X-HTTP-Method-Override: DELETE, then flips the mode', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(200, { receipt: true }))
      const res = await sendDelete(baseFetch, '/api/x/1', { headers: { 'x-tenant-id': 't1' } })
      expect(res.status).toBe(200)
      expect(baseFetch).toHaveBeenCalledTimes(2)
      expect(baseFetch.mock.calls[0][1].method).toBe('DELETE')
      const retry = baseFetch.mock.calls[1][1] as RequestInit
      expect(retry.method).toBe('POST')
      expect(headerOf(retry, METHOD_OVERRIDE_HEADER)).toBe('DELETE')
      expect(headerOf(retry, 'x-tenant-id')).toBe('t1')
      expect(baseFetch.mock.calls[1][0]).toBe('/api/x/1')
      expect(getDeleteTransport()).toBe('override')
      expect(sessionStorage.getItem(DELETE_TRANSPORT_STORAGE_KEY)).toBe('override')
    })

    it('both attempts failing -> rejects with the second failure, no third attempt', async () => {
      const baseFetch = vi.fn().mockRejectedValue(transportFailure())
      await expect(sendDelete(baseFetch, '/api/x/1')).rejects.toBeInstanceOf(TypeError)
      expect(baseFetch).toHaveBeenCalledTimes(2)
    })

    it('HTTP 404 on DELETE -> returned as-is, NO retry, mode stays native', async () => {
      const baseFetch = vi.fn().mockResolvedValue(response(404))
      const res = await sendDelete(baseFetch, '/api/x/1')
      expect(res.status).toBe(404)
      expect(baseFetch).toHaveBeenCalledTimes(1)
      expect(getDeleteTransport()).toBe('native')
    })

    it.each([401, 403, 409, 500, 503])('HTTP %s on DELETE -> no retry either', async (status) => {
      const baseFetch = vi.fn().mockResolvedValue(response(status))
      await sendDelete(baseFetch, '/api/x/1')
      expect(baseFetch).toHaveBeenCalledTimes(1)
      expect(getDeleteTransport()).toBe('native')
    })

    it('a non-network rejection (domain error) is rethrown without a retry', async () => {
      const baseFetch = vi.fn().mockRejectedValue(new Error('validation'))
      await expect(sendDelete(baseFetch, '/api/x/1')).rejects.toThrow('validation')
      expect(baseFetch).toHaveBeenCalledTimes(1)
    })

    /**
     * THE INVERSION CASE. `DELETE /api/comments/:id/reactions` has a POST twin on the same path that
     * ADDS the reaction. If the retry's override header is stripped, that twin answers 201 — success
     * for the OPPOSITE operation. Without the receipt check this module would return it as a
     * successful delete and latch the tunnel, so every later delete would silently invert too.
     */
    it('retry answers 2xx WITHOUT the receipt -> typed error, tunnel latched off, never returned as success', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(201))
      const caught = await sendDelete(baseFetch, '/api/comments/c1/reactions')
        .then(() => null, (error: unknown) => error)
      expect(isDeleteTransportError(caught)).toBe(true)
      expect((caught as { code?: string }).code).toBe(DELETE_TRANSPORT_UNCONFIRMED)
      expect((caught as { responseStatus?: number }).responseStatus).toBe(201)
      expect((caught as Error).message).toBe(DELETE_UNCONFIRMED_COPY.en)
      expect(getDeleteTransport()).toBe('override-unavailable')
      expect(baseFetch).toHaveBeenCalledTimes(2)
    })

    it('retry answers 404 (a refusal, not a wrong write) -> returned as-is, tunnel NOT latched on', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(404))
      const res = await sendDelete(baseFetch, '/api/x/1')
      expect(res.status).toBe(404)
      // A 404 from a server that never rewrote anything must not license the tunnel.
      expect(getDeleteTransport()).toBe('native')
    })

    it('a caller-aborted request is not retried (an abort is not an outage)', async () => {
      const controller = new AbortController()
      const baseFetch = vi.fn(async () => {
        controller.abort()
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      })
      await expect(sendDelete(baseFetch, '/api/x/1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
      expect(baseFetch).toHaveBeenCalledTimes(1)
      expect(getDeleteTransport()).toBe('native')
    })
  })

  describe('sendDelete in override mode', () => {
    it('sends POST + X-HTTP-Method-Override: DELETE from the start, single attempt', async () => {
      setDeleteTransport('override')
      const baseFetch = vi.fn().mockResolvedValue(response(200, { receipt: true }))
      await sendDelete(baseFetch, '/api/x/1', { headers: new Headers({ Authorization: 'Bearer t' }) })
      expect(baseFetch).toHaveBeenCalledTimes(1)
      const init = baseFetch.mock.calls[0][1] as RequestInit
      expect(init.method).toBe('POST')
      expect(headerOf(init, METHOD_OVERRIDE_HEADER)).toBe('DELETE')
      expect(headerOf(init, 'Authorization')).toBe('Bearer t')
    })

    it('a stored override mode is picked up by a fresh module state (same-tab reload)', async () => {
      sessionStorage.setItem(DELETE_TRANSPORT_STORAGE_KEY, 'override')
      resetDeleteTransportForTests()
      const baseFetch = vi.fn().mockResolvedValue(response(200, { receipt: true }))
      await sendDelete(baseFetch, '/api/x/1')
      expect(baseFetch.mock.calls[0][1].method).toBe('POST')
    })

    it('a 2xx WITHOUT the receipt is refused and drops the session out of override', async () => {
      setDeleteTransport('override')
      const baseFetch = vi.fn().mockResolvedValue(response(200))
      await expect(sendDelete(baseFetch, '/api/comments/c1/reactions')).rejects.toMatchObject({
        code: DELETE_TRANSPORT_UNCONFIRMED,
      })
      expect(getDeleteTransport()).toBe('override-unavailable')
      // And the next delete goes back to a plain DELETE, with no POST retry.
      const next = vi.fn().mockResolvedValue(response(200))
      await sendDelete(next, '/api/x/2')
      expect(next.mock.calls[0][1].method).toBe('DELETE')
    })

    it('a 4xx/5xx in override mode is returned unchanged (no wrong write can hide behind a refusal)', async () => {
      setDeleteTransport('override')
      const baseFetch = vi.fn().mockResolvedValue(response(403))
      const res = await sendDelete(baseFetch, '/api/x/1')
      expect(res.status).toBe(403)
      expect(getDeleteTransport()).toBe('override')
    })

    it('a network-level failure in override mode is NOT retried again (no infinite tunnel)', async () => {
      setDeleteTransport('override')
      const baseFetch = vi.fn().mockRejectedValue(transportFailure())
      await expect(sendDelete(baseFetch, '/api/x/1')).rejects.toBeInstanceOf(TypeError)
      expect(baseFetch).toHaveBeenCalledTimes(1)
    })
  })

  describe('sessionStorage unavailable', () => {
    it('still flips and serves deletes through the in-memory state when storage throws', async () => {
      const getSpy = vi.fn(() => { throw new Error('SecurityError') })
      const setSpy = vi.fn(() => { throw new Error('QuotaExceededError') })
      vi.stubGlobal('sessionStorage', { getItem: getSpy, setItem: setSpy })
      resetDeleteTransportForTests()
      expect(getDeleteTransport()).toBe('native')
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(200, { receipt: true }))
      await sendDelete(baseFetch, '/api/x/1')
      expect(getDeleteTransport()).toBe('override')
      const next = vi.fn().mockResolvedValue(response(200, { receipt: true }))
      await sendDelete(next, '/api/x/2')
      expect(next.mock.calls[0][1].method).toBe('POST')
      expect(getSpy).toHaveBeenCalled()
      expect(setSpy).toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('works when sessionStorage is not defined at all', async () => {
      vi.stubGlobal('sessionStorage', undefined)
      resetDeleteTransportForTests()
      const baseFetch = vi.fn().mockRejectedValueOnce(transportFailure()).mockResolvedValueOnce(response(200, { receipt: true }))
      await sendDelete(baseFetch, '/api/x/1')
      expect(getDeleteTransport()).toBe('override')
      vi.unstubAllGlobals()
    })
  })

  describe('isNetworkLevelFailure', () => {
    it('never treats the unconfirmed-delete error as a transport failure (it must not buy a retry)', () => {
      const unconfirmed = Object.assign(new Error('x'), { code: DELETE_TRANSPORT_UNCONFIRMED, status: 0 })
      expect(isNetworkLevelFailure(unconfirmed)).toBe(false)
    })

    it('recognises fetch TypeError, AbortError/TimeoutError and the translated NETWORK_UNAVAILABLE (status 0)', () => {
      expect(isNetworkLevelFailure(transportFailure())).toBe(true)
      expect(isNetworkLevelFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
      expect(isNetworkLevelFailure(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true)
      expect(isNetworkLevelFailure(Object.assign(new Error('x'), { code: 'NETWORK_UNAVAILABLE', status: 0 }))).toBe(true)
    })

    it('rejects anything that carries an HTTP status or is not a transport error', () => {
      expect(isNetworkLevelFailure(Object.assign(new Error('x'), { code: 'NETWORK_UNAVAILABLE', status: 503 }))).toBe(false)
      expect(isNetworkLevelFailure(new Error('domain'))).toBe(false)
      expect(isNetworkLevelFailure(response(500))).toBe(false)
      expect(isNetworkLevelFailure(null)).toBe(false)
      expect(isNetworkLevelFailure('Failed to fetch')).toBe(false)
    })
  })
})

/**
 * REGRESSION GUARD for the 2026-09-18 browser-lane breakage (attendance-web-guard 6/6 red;
 * `Stock-prep browser verify` cancelled after ~20 min). See the module header of
 * src/utils/delete-fallback.ts for the mechanism; in one line:
 *
 *   Vite serves every source module over HTTP in dev, so `src/api/delete-fallback.ts` is fetched as
 *   `/src/api/delete-fallback.ts`. That URL MATCHES the `**\/api/**` glob the verification harnesses
 *   install to stub HTTP. The unmocked module was aborted (attendance) / answered with a JSON 404
 *   (stock-prep), the whole module graph died, and the page rendered nothing at all — reproduced
 *   locally as `#app` innerHTML length 0 and `__STOCK_PREP_READY__` never true.
 *
 * WHAT IS PINNED, and why it is DERIVED rather than a list of known-bad spellings. The first version
 * of this guard recognised the single literal string `'**\/api/**'` and only followed `*-harness.html`
 * references. The same hazard installed as `'**\/api/**\/*'`, as a RegExp, through a local `const`, or
 * by a spec that drives the REAL app instead of a harness html would have produced an empty offender
 * map and a green guard — the 2026-09-18 outage, undetected. So the hazard itself is derived:
 *
 *   for every verification source that installs route stubs, take the entry it drives (the harness
 *   module behind the `*-harness.html` it navigates to, or `src/main.ts` when it navigates into the
 *   real app), walk that entry's module graph, turn each module into the URL Vite dev serves it at,
 *   and flag any module URL that one of that lane's own route stubs MATCHES.
 *
 * SELECTIVE vs CATCH-ALL. A stub that also matches the lane's own ENTRY module (e.g. `'**\/*'` in
 * attendance-group-context-r2.spec.ts) cannot be the hazard: if it swallowed module URLs the page
 * could not boot at all, so its handler necessarily continues them (asserted, not assumed — the
 * cluster must contain a `route.continue(`). Only SELECTIVE stubs — ones that pick out some modules
 * and not the entry — can kill a module graph while the lane still appears to run.
 *
 * NO SCOPE EXEMPTION IS NEEDED any more. `src/multitable/api/` is reached by several harness graphs
 * (approval-form-builder-mounted, cf-reactions, grouped-windowing, record-history-restore) and those
 * lanes stay green on their own merits: their stubs (`'**\/api/approval-templates/directory/**'` and
 * friends) do not match `/src/multitable/api/client.ts`. The earlier "api dir" heuristic needed prose
 * to excuse them; matching the actual stub against the actual module URL does not.
 */
describe('browser-lane module-path hazard: a lane\'s own route stubs must not match its own modules', () => {
  const WEB = resolve(__dirname, '..')
  const VERIFICATION = join(WEB, 'verification')
  const APP_ENTRY = join(WEB, 'src/main.ts')

  function resolveImport(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null
    const base = resolve(dirname(fromFile), spec)
    for (const candidate of [base, `${base}.ts`, `${base}.vue`, join(base, 'index.ts')]) {
      if (existsSync(candidate) && /\.(ts|vue)$/.test(candidate)) return candidate
    }
    return null
  }

  /** Relative-import closure of `entry`, following `from '...'` and dynamic `import('...')`. */
  function importGraph(entry: string): string[] {
    const seen = new Set<string>()
    const queue = [entry]
    while (queue.length) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      let source: string
      try {
        source = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const pattern of [/from\s+['"]([^'"]+)['"]/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g]) {
        for (const m of source.matchAll(pattern)) {
          const next = resolveImport(file, m[1])
          if (next) queue.push(next)
        }
      }
    }
    return [...seen]
  }

  const webRel = (file: string): string => relative(WEB, file).split(sep).join('/')
  /** Vite dev serves `apps/web` as its root, so every module is fetched at `/<path under apps/web>`. */
  const devUrl = (file: string): string => `/${webRel(file)}`

  /**
   * PLAYWRIGHT'S OWN glob→regex, ported statement for statement from
   * `playwright-core/lib/utils/isomorphic/urlMatch.js` -> `globToRegexPattern` (v1.57.0, the version
   * this workspace resolves). Ported rather than imported because `playwright-core` is a transitive
   * dependency and is NOT hoisted into `apps/web`'s resolution root under pnpm, so an import here
   * would fail at resolve time in the vitest lane.
   *
   * It is a PORT and not an approximation because the approximation was the bug: the first version
   * of this helper expanded every `**` to `.*`, which made the perfectly legal spelling
   * `'**\/api/**\/*'` FAIL to match `/src/api/delete-fallback.ts` — the detector was blind to a real
   * spelling of the very hazard it exists for (caught by the synthetic case below, which was red).
   * Playwright's actual rule: a `**` followed by `/` may match ZERO segments — `((.+/)|)` when it
   * also follows a `/`, `(.*\/)` at the start — and `?`, `[`, `]`, `,` outside `{}` are LITERALS,
   * not wildcards. (The `\` in that pattern is this comment escaping its own terminator, the very
   * trap documented on `stripComments` below.)
   */
  const GLOB_ESCAPED = new Set(['$', '^', '+', '.', '*', '(', ')', '|', '\\', '?', '{', '}', '[', ']'])

  function globToRegExp(glob: string): RegExp {
    const tokens = ['^']
    let inGroup = false
    for (let i = 0; i < glob.length; i += 1) {
      const c = glob[i]
      if (c === '\\' && i + 1 < glob.length) {
        i += 1
        const escaped = glob[i]
        tokens.push(GLOB_ESCAPED.has(escaped) ? `\\${escaped}` : escaped)
        continue
      }
      if (c === '*') {
        const charBefore = glob[i - 1]
        let starCount = 1
        while (glob[i + 1] === '*') { starCount += 1; i += 1 }
        if (starCount > 1 && glob[i + 1] === '/') {
          tokens.push(charBefore === '/' ? '((.+/)|)' : '(.*/)')
          i += 1
        } else if (starCount > 1) {
          tokens.push('(.*)')
        } else {
          tokens.push('([^/]*)')
        }
        continue
      }
      if (c === '{') { inGroup = true; tokens.push('('); continue }
      if (c === '}') { inGroup = false; tokens.push(')'); continue }
      if (c === ',') { tokens.push(inGroup ? '|' : '\\,'); continue }
      tokens.push(GLOB_ESCAPED.has(c) ? `\\${c}` : c)
    }
    tokens.push('$')
    return new RegExp(tokens.join(''))
  }

  interface Stub { readonly raw: string; matches(url: string): boolean }

  /**
   * Characters after which a `/` starts a REGEX literal rather than a division. Standard JS
   * heuristic; `''` covers start-of-input.
   */
  const REGEX_ALLOWED_AFTER = new Set([
    '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', '',
  ])

  /**
   * A comment stripper that KNOWS ABOUT STRINGS — and it has to, for a reason that is the whole
   * subject of this guard: the hazard being hunted is spelled `'**\/api/**'`, and that glob CONTAINS
   * the two characters `/` `*`. The obvious one-liner
   *
   *     text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
   *
   * therefore treats the middle of the glob as a block-comment OPENER and deletes everything up to
   * the next `*\/` anywhere in the file. Measured on this very tree (scratch probe, both strippers
   * over apps/web/verification): it rewrote `'**\/api/**\/*'` into `'**\/api*'`, and it swallowed
   * whole `page.route(` calls — `approval-canvas-sole-surface.spec.ts` 4 -> 2 and
   * `approval-form-builder-mounted-matrix.spec.ts` 5 -> 3. A guard whose parser eats the calls it is
   * supposed to inspect reports an empty offender map and passes. So: walk the text; skip string,
   * template and regex literals with their escapes; treat `//` and `/*` as comments only OUTSIDE
   * them. (`.route(` mentions that really are prose — two harness headers — are still removed, which
   * is the point.)
   */
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

  /** String-valued `const`/`let` bindings, so `const API = '**\/api/**'; page.route(API, ...)` resolves. */
  function stringConsts(text: string): Map<string, string> {
    const map = new Map<string, string>()
    for (const m of text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2/g)) {
      map.set(m[1], m[3])
    }
    return map
  }

  /**
   * Every `page.route(` / `context.route(` first argument in `text`, as a URL matcher: string glob,
   * RegExp literal, or identifier resolved through the local consts. Exported shape so the synthetic
   * positive control below runs THIS parser, not a copy of it.
   */
  function parseRouteStubs(text: string): { stubs: Stub[]; unresolved: string[]; total: number } {
    const clean = stripComments(text)
    const total = [...clean.matchAll(/\.route\(/g)].length
    const stubs: Stub[] = []
    const unresolved: string[] = []
    const consts = stringConsts(clean)
    for (const m of clean.matchAll(/\.route\(\s*(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*|(['"`])[^'"`\n]*\2|[A-Za-z_$][\w$]*)\s*,/g)) {
      const raw = m[1]
      if (raw.startsWith('/')) {
        const last = raw.lastIndexOf('/')
        const re = new RegExp(raw.slice(1, last), raw.slice(last + 1).replace(/[gy]/g, ''))
        stubs.push({ raw, matches: (url) => re.test(url) })
        continue
      }
      const literal = /^(['"`])([\s\S]*)\1$/.exec(raw)
      const glob = literal ? literal[2] : consts.get(raw)
      if (glob === undefined) { unresolved.push(raw); continue }
      const re = globToRegExp(glob)
      // Playwright matches a glob against the FULL url string; a glob that does not start with `*`
      // is first resolved against `baseURL` (`resolveGlobBase`, same module as the port above), and
      // every lane here sets `baseURL: http://127.0.0.1:<port>`. A module is therefore tested both
      // bare (`/src/x.ts`) and origin-prefixed. Testing both is deliberately a SUPERSET: it can only
      // make this guard stricter, never blind. Ceiling, stated: the port number is not modelled, so
      // a stub that pins a literal port is approximated by this one.
      stubs.push({ raw: glob, matches: (url) => re.test(url) || re.test(`http://127.0.0.1:4321${url}`) })
    }
    return { stubs, unresolved, total }
  }

  interface Lane {
    readonly source: string
    readonly entry: string
    readonly entryUrl: string
    readonly moduleUrls: string[]
    readonly stubs: Stub[]
    readonly hasContinue: boolean
  }

  /**
   * THE HAZARD ITSELF — pure, so the synthetic control and the real tree go through one code path.
   * A stub matching the lane's own entry module is a catch-all (see the header) and is skipped.
   */
  function laneHazards(lane: Lane): string[] {
    const hits: string[] = []
    for (const stub of lane.stubs) {
      if (stub.matches(lane.entryUrl)) {
        // Non-vacuity of the skip: a catch-all that did NOT continue would blank the page.
        expect(lane.hasContinue).toBe(true)
        continue
      }
      for (const url of lane.moduleUrls) {
        if (stub.matches(url)) hits.push(`${stub.raw} swallows ${url}`)
      }
    }
    return hits
  }

  /** The entries a verification source drives: harness modules it navigates to, else the real app. */
  function entriesOf(text: string): string[] {
    const clean = stripComments(text)
    const consts = stringConsts(clean)
    const found = new Set<string>()
    for (const m of clean.matchAll(/\.goto\(\s*(`[^`]*`|(['"])[^'"\n]*\2|[A-Za-z_$][\w$]*)/g)) {
      const raw = m[1]
      const target = /^[A-Za-z_$]/.test(raw) ? consts.get(raw) : raw.slice(1, -1)
      if (target === undefined) continue
      const harness = /([A-Za-z0-9-]+-harness)\.html/.exec(target)
      if (harness) {
        const entry = join(VERIFICATION, `${harness[1]}.ts`)
        if (existsSync(entry)) found.add(entry)
      } else if (target.startsWith('/')) {
        // Navigates into the real app (attendance-group-context-r2 does this): the lane's module
        // graph is the whole app, not a harness. Without this fallback such a lane contributed
        // nothing at all to the old guard.
        found.add(APP_ENTRY)
      }
    }
    // A harness html referenced without a literal goto (indirect navigation helper) still counts.
    for (const m of clean.matchAll(/([A-Za-z0-9-]+-harness)\.html/g)) {
      const entry = join(VERIFICATION, `${m[1]}.ts`)
      if (existsSync(entry)) found.add(entry)
    }
    return [...found]
  }

  /** Every (verification source x entry it drives) pair that installs route stubs, read off disk. */
  function derivedLanes(): Lane[] {
    const lanes: Lane[] = []
    for (const name of readdirSync(VERIFICATION)) {
      if (!name.endsWith('.ts')) continue
      // The stub and the `goto` can live in different files (stock-prep keeps both in its fixtures
      // module), so read each source together with its own relative-import closure.
      const cluster = importGraph(join(VERIFICATION, name)).filter((f) => f.startsWith(VERIFICATION))
      const text = cluster.map((f) => readFileSync(f, 'utf8')).join('\n')
      const { stubs, unresolved, total } = parseRouteStubs(text)
      if (!stubs.length) continue
      // A stub the parser cannot read is a hole in the derivation, not a pass.
      expect({ source: name, unresolved }).toEqual({ source: name, unresolved: [] })
      expect({ source: name, parsed: stubs.length }).toEqual({ source: name, parsed: total })
      const hasContinue = /\.continue\(/.test(text)
      for (const entry of entriesOf(text)) {
        lanes.push({
          source: name,
          entry: webRel(entry),
          entryUrl: devUrl(entry),
          moduleUrls: importGraph(entry).map(devUrl),
          stubs,
          hasContinue,
        })
      }
    }
    return lanes
  }

  it('the detector fires on every spelling of the hazard (synthetic lanes, no disk)', () => {
    const lane = (source: string, moduleUrls: string[]): Omit<Lane, 'stubs'> => ({
      source,
      entry: 'verification/x-harness.ts',
      entryUrl: '/verification/x-harness.ts',
      moduleUrls,
      hasContinue: true,
    })
    const SWALLOWED = ['/src/utils/api.ts', '/src/api/delete-fallback.ts']
    // The four spellings the literal-matching first version of this guard could not see.
    const spellings = [
      "page.route('**/api/**', handler)",
      "page.route('**/api/**/*', handler)",
      'page.route(/\\/api\\//, handler)',
      "const API_GLOB = '**/api/**'\npage.route(API_GLOB, handler)",
    ]
    for (const source of spellings) {
      const { stubs, unresolved } = parseRouteStubs(source)
      expect({ source, unresolved, stubs: stubs.length }).toEqual({ source, unresolved: [], stubs: 1 })
      expect(laneHazards({ ...lane(source, SWALLOWED), stubs })).toEqual([
        expect.stringContaining('/src/api/delete-fallback.ts'),
      ])
      // ...and does not fire when the same lane has no module under an `api/` path.
      expect(laneHazards({ ...lane(source, ['/src/utils/api.ts']), stubs })).toEqual([])
    }
    // A catch-all is skipped: it matches the entry module itself, so the lane could not boot unless
    // its handler continues module URLs.
    const catchAll = parseRouteStubs("page.route('**/*', handler)").stubs
    expect(catchAll).toHaveLength(1)
    expect(laneHazards({ ...lane('catch-all', SWALLOWED), stubs: catchAll })).toEqual([])
  })

  it('utils/api.ts reaches no module under an `api/` directory', () => {
    // Narrow by design (refuter finding: the old name promised harness coverage this case never had
    // — that claim lives in the lane case below). A cheap early warning on the one module graph this
    // PR owns: `utils/api.ts` is imported by every harness, so an `api/` module here reaches all of
    // them at once.
    const graph = importGraph(join(WEB, 'src/utils/api.ts'))
    // Positive control: the walk really reached this module, so `offenders === []` is not vacuous.
    expect(graph.some((f) => f.endsWith(`utils${sep}delete-fallback.ts`))).toBe(true)
    expect(graph.map(webRel).filter((r) => /(^|\/)api\//.test(r))).toEqual([])
  })

  it('no lane\'s selective route stubs match any module of the entry that lane drives', () => {
    const lanes = derivedLanes()
    const offenders: Record<string, string[]> = {}
    for (const lane of lanes) {
      const hits = laneHazards(lane)
      if (hits.length) offenders[`${lane.source} -> ${lane.entry}`] = hits
    }
    expect(offenders).toEqual({})
  })

  it('the lanes that went red on 2026-09-18 are still derived (a lane dropping out is a failure)', () => {
    const lanes = derivedLanes()
    const sources = [...new Set(lanes.map((l) => l.source))]
    // Named, so a lane silently disappearing from the derivation is red rather than a quiet pass.
    // Additions are deliberately NOT pinned: a new lane is already checked by the case above.
    for (const named of [
      'attendance-makeup-request.spec.ts',
      'stock-prep-fixtures.ts',
      'approval-instance-consistency-race.spec.ts',
      // Drives the real app rather than a harness html — only present via the APP_ENTRY fallback.
      'attendance-group-context-r2.spec.ts',
    ]) {
      expect(sources).toContain(named)
      const lane = lanes.find((l) => l.source === named) as Lane
      // Non-vacuity: both sides of the check have content for this lane.
      expect(lane.stubs.length).toBeGreaterThan(0)
      expect(lane.moduleUrls.length).toBeGreaterThan(1)
    }
    expect(lanes.find((l) => l.source === 'attendance-group-context-r2.spec.ts')?.entry).toBe('src/main.ts')
    // The module this PR moved is in the graph of the lane that went red — the whole point.
    const makeup = lanes.find((l) => l.source === 'attendance-makeup-request.spec.ts') as Lane
    expect(makeup.moduleUrls).toContain('/src/utils/delete-fallback.ts')
  })
})
