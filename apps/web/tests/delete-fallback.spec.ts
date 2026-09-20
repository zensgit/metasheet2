/**
 * utils/delete-fallback.ts — DELETE transport fallback for an egress that silently drops HTTP DELETE.
 *
 * Pins: the probe flips the mode only on a network-level failure; native mode buys exactly one
 * POST+override retry and only on a network-level failure (an HTTP 404 is an answer -> no retry);
 * override mode sends POST+header from the start; sessionStorage being unusable does not break any
 * of it. Mutation evidence (in-memory, not committed): dropping the `isNetworkLevelFailure` condition
 * in `sendDelete` turns the "404 -> no retry" case red.
 */
import { existsSync, readFileSync } from 'node:fs'
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

    it('native DELETE dropped + tunnel confirmed by the BODY (overridden: true) -> override', async () => {
      const baseFetch = vi.fn()
        .mockRejectedValueOnce(transportFailure())
        .mockResolvedValueOnce(response(200, { body: { ok: true, method: 'DELETE', overridden: true } }))
      expect(await probeDeleteTransport(baseFetch)).toBe('override')
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
 * REGRESSION GUARD for the 2026-09-18 attendance-web-guard breakage (6/6 red, see the module header of
 * src/utils/delete-fallback.ts). The verification harnesses abort every unmocked `**\/api/**` request,
 * and Vite serves source modules over HTTP in dev, so ANY module in `utils/api.ts`'s import graph that
 * lives under a directory named `api` is fetched from a URL that glob matches — the abort then takes
 * down the whole graph and every harness renders an empty page. This walks the real graph.
 */
describe('no module in the utils/api.ts import graph may live under a directory named "api"', () => {
  const SRC = resolve(__dirname, '../src')

  function resolveImport(fromFile: string, spec: string): string | null {
    if (!spec.startsWith('.')) return null
    const base = resolve(dirname(fromFile), spec)
    for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate
    }
    return null
  }

  it('walks the graph and finds no `/api/` segment', () => {
    const entry = join(SRC, 'utils/api.ts')
    const seen = new Set<string>()
    const queue = [entry]
    const offenders: string[] = []
    while (queue.length) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      const rel = relative(SRC, file).split(sep).join('/')
      if (/(^|\/)api\//.test(rel)) offenders.push(rel)
      const source = readFileSync(file, 'utf8')
      for (const m of source.matchAll(/from\s+'([^']+)'/g)) {
        const next = resolveImport(file, m[1])
        if (next) queue.push(next)
      }
    }
    // Positive control: the walk really reached this module (otherwise the claim would be vacuous).
    expect([...seen].some((f) => f.endsWith(`delete-fallback.ts`))).toBe(true)
    expect(offenders).toEqual([])
  })
})
