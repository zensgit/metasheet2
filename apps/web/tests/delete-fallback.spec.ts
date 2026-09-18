/**
 * api/delete-fallback.ts — DELETE transport fallback for an egress that silently drops HTTP DELETE.
 *
 * Pins: the probe flips the mode only on a network-level failure; native mode buys exactly one
 * POST+override retry and only on a network-level failure (an HTTP 404 is an answer -> no retry);
 * override mode sends POST+header from the start; sessionStorage being unusable does not break any
 * of it. Mutation evidence (in-memory, not committed): dropping the `isNetworkLevelFailure` condition
 * in `sendDelete` turns the "404 -> no retry" case red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DELETE_TRANSPORT_STORAGE_KEY,
  METHOD_OVERRIDE_HEADER,
  METHOD_PROBE_PATH,
  getDeleteTransport,
  isNetworkLevelFailure,
  probeDeleteTransport,
  resetDeleteTransportForTests,
  sendDelete,
  setDeleteTransport,
} from '../src/api/delete-fallback'

function transportFailure(): TypeError {
  return new TypeError('Failed to fetch')
}

function response(status: number): Response {
  return { ok: status >= 200 && status < 300, status, statusText: String(status) } as unknown as Response
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

    it('flips to override when the probe fails at the network level (TypeError) and persists it', async () => {
      const baseFetch = vi.fn().mockRejectedValue(transportFailure())
      expect(await probeDeleteTransport(baseFetch)).toBe('override')
      expect(getDeleteTransport()).toBe('override')
      expect(sessionStorage.getItem(DELETE_TRANSPORT_STORAGE_KEY)).toBe('override')
    })

    it('flips to override when the probe times out (AbortError from the 8s guard)', async () => {
      vi.useFakeTimers()
      const baseFetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }))
      const settled = probeDeleteTransport(baseFetch, { timeoutMs: 8000 })
      await vi.advanceTimersByTimeAsync(7999)
      expect(getDeleteTransport()).toBe('native')
      await vi.advanceTimersByTimeAsync(1)
      expect(await settled).toBe('override')
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
        .mockResolvedValueOnce(response(200))
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
      const baseFetch = vi.fn().mockResolvedValue(response(200))
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
      const baseFetch = vi.fn().mockResolvedValue(response(200))
      await sendDelete(baseFetch, '/api/x/1')
      expect(baseFetch.mock.calls[0][1].method).toBe('POST')
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
        .mockResolvedValueOnce(response(200))
      await sendDelete(baseFetch, '/api/x/1')
      expect(getDeleteTransport()).toBe('override')
      const next = vi.fn().mockResolvedValue(response(200))
      await sendDelete(next, '/api/x/2')
      expect(next.mock.calls[0][1].method).toBe('POST')
      expect(getSpy).toHaveBeenCalled()
      expect(setSpy).toHaveBeenCalled()
      vi.unstubAllGlobals()
    })

    it('works when sessionStorage is not defined at all', async () => {
      vi.stubGlobal('sessionStorage', undefined)
      resetDeleteTransportForTests()
      const baseFetch = vi.fn().mockRejectedValueOnce(transportFailure()).mockResolvedValueOnce(response(200))
      await sendDelete(baseFetch, '/api/x/1')
      expect(getDeleteTransport()).toBe('override')
      vi.unstubAllGlobals()
    })
  })

  describe('isNetworkLevelFailure', () => {
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
