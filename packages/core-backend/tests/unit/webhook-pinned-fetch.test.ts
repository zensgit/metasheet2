/**
 * pinnedHttpsFetch goldens — the resolve-then-pin egress for send_webhook (#2897 §3.1, owner review #1).
 * THE load-bearing test: the connection target must be the PINNED address from the SSRF check, not a
 * re-resolution of the hostname — otherwise resolve-then-pin is paper security (DNS rebinding wins).
 */
import { describe, test, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { pinnedHttpsFetch, type HttpsRequestFn } from '../../src/multitable/webhook-pinned-fetch'

// A controllable fake https.request. On `req.end()` it drives the helper-supplied `lookup` with an
// ATTACKER-CONTROLLED hostname and records the address `lookup` returns — i.e. the actual connect
// target. A correct pin returns the validated IP and ignores the hostname.
function makeFakeRequest(status: number, mode: { error?: Error; timeout?: boolean; neverEnd?: boolean } = {}) {
  let captured: { address: string; family: number } | null = null
  let capturedHeaders: Record<string, string> = {}
  let resDestroyed = false
  const writes: string[] = []
  const request = ((_url: unknown, options: any, cb: any) => {
    capturedHeaders = options.headers ?? {}
    const req: any = new EventEmitter()
    req.write = (chunk: string) => { writes.push(String(chunk)) }
    req.destroy = () => {}
    req.end = () => {
      options.lookup('rebind.attacker.example', {}, (_e: unknown, address: string, family: number) => {
        captured = { address, family }
      })
      if (mode.error) { setImmediate(() => req.emit('error', mode.error)); return }
      if (mode.timeout) { setImmediate(() => req.emit('timeout')); return }
      const res: any = new EventEmitter()
      res.statusCode = status
      res.resume = () => {}
      res.destroy = () => { resDestroyed = true }
      // neverEnd: deliver headers (cb) but NEVER emit 'end' — proves the helper resolves on headers.
      setImmediate(() => { cb(res); if (!mode.neverEnd) res.emit('end') })
    }
    return req
  }) as unknown as HttpsRequestFn
  return { request, captured: () => captured, headers: () => capturedHeaders, resDestroyed: () => resDestroyed, writes: () => writes }
}

describe('pinnedHttpsFetch — resolve-then-pin egress', () => {
  test('connects to the PINNED address, not the (re-resolvable) hostname — resolve-then-pin proof', async () => {
    const fake = makeFakeRequest(200)
    const r = await pinnedHttpsFetch('https://hooks.example.com/x', '93.184.216.34', 4, { timeoutMs: 1000, body: '{"a":1}' }, fake.request)
    expect(r).toEqual({ status: 200, ok: true })
    // The connect target (= what `lookup` returned) is the validated PINNED ip, NOT a re-resolution of
    // 'rebind.attacker.example'. This is the property that makes resolve-then-pin real.
    expect(fake.captured()).toEqual({ address: '93.184.216.34', family: 4 })
    expect(fake.writes()).toEqual(['{"a":1}'])
  })

  test('pins an IPv6 address too', async () => {
    const fake = makeFakeRequest(204)
    const r = await pinnedHttpsFetch('https://hooks.example.com/x', '2606:4700::1111', 6, { timeoutMs: 1000 }, fake.request)
    expect(r.ok).toBe(true)
    expect(fake.captured()).toEqual({ address: '2606:4700::1111', family: 6 })
  })

  test('forces Host to the URL host (strips a caller-supplied Host) — no virtual-host confusion [P2]', async () => {
    const fake = makeFakeRequest(200)
    await pinnedHttpsFetch('https://hooks.example.com/x', '93.184.216.34', 4, { timeoutMs: 1000, headers: { Host: 'attacker.evil', 'X-Custom': 'keep' } }, fake.request)
    const h = fake.headers()
    expect(h.host).toBe('hooks.example.com') // Host forced to the URL host
    expect('Host' in h).toBe(false) // the caller's capital-Host was stripped
    expect(h['X-Custom']).toBe('keep') // unrelated headers preserved
  })

  test('resolves on headers even if the body never ends; destroys the socket (slow-body DoS closed) [P2]', async () => {
    const fake = makeFakeRequest(200, { neverEnd: true })
    const r = await pinnedHttpsFetch('https://hooks.example.com/x', '93.184.216.34', 4, { timeoutMs: 1000 }, fake.request)
    expect(r).toEqual({ status: 200, ok: true }) // resolved without awaiting 'end'
    expect(fake.resDestroyed()).toBe(true) // body discarded immediately
  })

  test('a non-2xx response is { ok: false } (surfaced, not thrown; body never read)', async () => {
    const fake = makeFakeRequest(503)
    const r = await pinnedHttpsFetch('https://hooks.example.com/x', '93.184.216.34', 4, { timeoutMs: 1000 }, fake.request)
    expect(r).toEqual({ status: 503, ok: false })
  })

  test('a transport error rejects', async () => {
    const fake = makeFakeRequest(0, { error: new Error('ECONNREFUSED') })
    await expect(pinnedHttpsFetch('https://hooks.example.com/x', '93.184.216.34', 4, { timeoutMs: 1000 }, fake.request)).rejects.toThrow('ECONNREFUSED')
  })

  test('a timeout rejects', async () => {
    const fake = makeFakeRequest(0, { timeout: true })
    await expect(pinnedHttpsFetch('https://hooks.example.com/x', '93.184.216.34', 4, { timeoutMs: 1 }, fake.request)).rejects.toThrow('timed out')
  })
})
