/**
 * pinnedHttpsFetch over a REAL socket (S0-a, 2026-11-03).
 *
 * `webhook-pinned-fetch.test.ts` drives a fake `https.request` and calls the helper's `lookup` with the
 * legacy three-argument answer shape — so it stayed green while the real client could not connect at all:
 * Node 20's default `autoSelectFamily` calls a custom `lookup` with `{ all: true }`, and a single-string
 * answer is rejected (ERR_INVALID_IP_ADDRESS) before any connection is made.
 *
 * Every test here uses the REAL `https.request` (no `requestImpl` argument) against a loopback TLS server
 * whose certificate is generated at runtime (`tests/helpers/runtime-self-signed-cert.ts`; no key on disk).
 * The URL carries a NAME the resolver has never heard of (`*.invalid`, RFC 6761) — the only way the
 * connection can reach the server is through the pin.
 *
 * POSITIVE CONTROLS are the point: a suite that only proves refusals stays green when every send fails.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PINNED_WEBHOOK_USER_AGENT, pinnedHttpsFetch } from '../../src/multitable/webhook-pinned-fetch'
import { generateRuntimeSelfSignedCert } from '../helpers/runtime-self-signed-cert'

const HOST = 'hooks.pinned-test.invalid'

interface Hit {
  path: string
  method: string
  host: string | undefined
  body: string
  headers: IncomingMessage['headers']
}

let server: https.Server
let port = 0
let ca = ''
const hits: Hit[] = []

function handler(req: IncomingMessage, res: ServerResponse): void {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (c: string) => { body += c })
  req.on('end', () => {
    hits.push({ path: req.url ?? '', method: req.method ?? '', host: req.headers.host, body, headers: req.headers })
    if (req.url === '/no-content') {
      res.writeHead(204)
      res.end()
    } else if (req.url === '/text-ok') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok, not json')
    } else if (req.url === '/redirect') {
      // A second hop on the SAME server, so a follower would be visible as a hit on /second-hop.
      res.writeHead(307, { Location: `https://${HOST}:${port}/second-hop` })
      res.end()
    } else if (req.url === '/second-hop') {
      res.writeHead(200)
      res.end('second hop')
    } else {
      res.writeHead(500)
      res.end()
    }
  })
}

beforeAll(async () => {
  const { cert, key } = generateRuntimeSelfSignedCert(HOST)
  ca = cert
  server = https.createServer({ cert, key }, handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const url = (path: string) => `https://${HOST}:${port}${path}`

describe('pinnedHttpsFetch — real https.request, real lookup contract', () => {
  it('POSITIVE CONTROL: a 204 target is delivered through the pin', async () => {
    hits.length = 0
    const r = await pinnedHttpsFetch(url('/no-content'), '127.0.0.1', 4, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
      timeoutMs: 5000,
      ca,
    })
    expect(r).toMatchObject({ status: 204, ok: true })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ path: '/no-content', method: 'POST', body: '{"a":1}' })
    // Host stays the URL's host, not the pinned address.
    expect(hits[0].host).toBe(`${HOST}:${port}`)
  })

  it('POSITIVE CONTROL: a non-JSON 2xx body is a successful delivery', async () => {
    hits.length = 0
    const r = await pinnedHttpsFetch(url('/text-ok'), '127.0.0.1', 4, { body: '{}', timeoutMs: 5000, ca })
    expect(r).toMatchObject({ status: 200, ok: true })
    expect(hits.map((h) => h.path)).toEqual(['/text-ok'])
  })

  it('responseBodyLimit: a 2xx body is read up to the limit; without it the body is not read', async () => {
    const limited = await pinnedHttpsFetch(url('/text-ok'), '127.0.0.1', 4, { body: '{}', timeoutMs: 5000, ca, responseBodyLimit: 5 })
    expect(limited).toEqual({ status: 200, ok: true, body: 'ok, n' })
    const full = await pinnedHttpsFetch(url('/text-ok'), '127.0.0.1', 4, { body: '{}', timeoutMs: 5000, ca, responseBodyLimit: 1024 })
    expect(full).toEqual({ status: 200, ok: true, body: 'ok, not json' })
    const unread = await pinnedHttpsFetch(url('/text-ok'), '127.0.0.1', 4, { body: '{}', timeoutMs: 5000, ca })
    expect(unread).toEqual({ status: 200, ok: true })
  })

  it('responseBodyLimit never reads a 3xx body', async () => {
    const r = await pinnedHttpsFetch(url('/redirect'), '127.0.0.1', 4, { body: '{}', timeoutMs: 5000, ca, responseBodyLimit: 1024 })
    expect(r).toEqual({ status: 307, ok: false })
  })

  it('a 3xx is returned as-is: the second hop receives ZERO requests', async () => {
    hits.length = 0
    const r = await pinnedHttpsFetch(url('/redirect'), '127.0.0.1', 4, { body: '{"x":1}', timeoutMs: 5000, ca })
    expect(r).toMatchObject({ status: 307, ok: false })
    // Give a (hypothetical) follower a moment to show up before counting.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(hits.filter((h) => h.path === '/second-hop')).toHaveLength(0)
    expect(hits.map((h) => h.path)).toEqual(['/redirect'])
  })

  it('without the trust anchor the TLS identity check still applies (the pin does not disable verification)', async () => {
    hits.length = 0
    await expect(pinnedHttpsFetch(url('/no-content'), '127.0.0.1', 4, { timeoutMs: 5000 })).rejects.toMatchObject({
      code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/),
    })
    expect(hits).toHaveLength(0)
  })

  it('a URL with userinfo is refused before any socket, and the error text carries no part of the URL', async () => {
    hits.length = 0
    let caught: unknown
    try {
      await pinnedHttpsFetch(`https://svc:Pw0rd@${HOST}:${port}/no-content?token=QTOKEN`, '127.0.0.1', 4, { timeoutMs: 5000, ca })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(TypeError)
    const text = String((caught as Error).message)
    expect(text).not.toContain('Pw0rd')
    expect(text).not.toContain('QTOKEN')
    expect(text).not.toContain(HOST)
    expect(hits).toHaveLength(0)
  })

  it('a non-https URL is refused before any socket', async () => {
    await expect(pinnedHttpsFetch(`http://${HOST}:${port}/no-content`, '127.0.0.1', 4, { timeoutMs: 5000 })).rejects.toBeInstanceOf(TypeError)
  })
})

describe('pinnedHttpsFetch — lookup answers both shapes with the pin', () => {
  function captureLookup(): Promise<{ all: unknown; single: unknown[] }> {
    return new Promise((resolve, reject) => {
      const fakeRequest = ((_u: unknown, options: https.RequestOptions) => {
        const lookup = options.lookup as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void
        let all: unknown
        lookup('rebind.attacker.invalid', { all: true }, (_e, addresses) => { all = addresses })
        lookup('rebind.attacker.invalid', {}, (_e, address, family) => {
          resolve({ all, single: [address, family] })
        })
        const req = new EventEmitter() as EventEmitter & Record<string, unknown>
        req.write = () => undefined
        req.end = () => undefined
        req.destroy = () => undefined
        return req
      }) as unknown as typeof https.request
      void pinnedHttpsFetch('https://hooks.example.test/x', '203.0.113.10', 4, { timeoutMs: 50 }, fakeRequest).catch(reject)
    })
  }

  it('{ all: true } gets an ARRAY holding only the pinned address; the legacy shape gets the pinned string', async () => {
    const seen = await captureLookup()
    expect(seen.all).toEqual([{ address: '203.0.113.10', family: 4 }])
    expect(seen.single).toEqual(['203.0.113.10', 4])
  })
})

describe('pinnedHttpsFetch — wire framing matches the platform fetch (S0-a review F1)', () => {
  // Non-ASCII on purpose: the UTF-8 byte length differs from the string length, so a length computed from
  // `body.length` instead of the bytes would be caught here.
  const BODY = JSON.stringify({ name: '备料-ü', n: 1 })

  it('the body is sent with Content-Length = its UTF-8 byte length, never chunked; fixed User-Agent', async () => {
    hits.length = 0
    expect(Buffer.byteLength(BODY, 'utf8')).not.toBe(BODY.length)
    const r = await pinnedHttpsFetch(url('/no-content'), '127.0.0.1', 4, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Custom': 'keep' },
      body: BODY,
      timeoutMs: 5000,
      ca,
    })
    expect(r).toMatchObject({ status: 204, ok: true })
    expect(hits).toHaveLength(1)
    const h = hits[0].headers
    expect(h['content-length']).toBe(String(Buffer.byteLength(BODY, 'utf8')))
    expect(h['transfer-encoding']).toBeUndefined()
    expect(h['user-agent']).toBe(PINNED_WEBHOOK_USER_AGENT)
    expect(PINNED_WEBHOOK_USER_AGENT).toBe('MetaSheet-Automation-Webhook/1.0')
    expect(h['content-type']).toBe('application/json')
    expect(h['x-custom']).toBe('keep')
    expect(hits[0].body).toBe(BODY)
  })

  it('a caller Content-Length / Transfer-Encoding cannot frame the request; a caller User-Agent is kept', async () => {
    hits.length = 0
    const r = await pinnedHttpsFetch(url('/no-content'), '127.0.0.1', 4, {
      headers: { 'Content-Length': '3', 'Transfer-Encoding': 'chunked', 'User-Agent': 'caller-agent/2' },
      body: BODY,
      timeoutMs: 5000,
      ca,
    })
    expect(r).toMatchObject({ status: 204, ok: true })
    const h = hits[0].headers
    expect(h['content-length']).toBe(String(Buffer.byteLength(BODY, 'utf8')))
    expect(h['transfer-encoding']).toBeUndefined()
    expect(h['user-agent']).toBe('caller-agent/2')
    expect(hits[0].body).toBe(BODY)
  })

  it('no body: Content-Length 0, not chunked', async () => {
    hits.length = 0
    const r = await pinnedHttpsFetch(url('/no-content'), '127.0.0.1', 4, { timeoutMs: 5000, ca })
    expect(r).toMatchObject({ status: 204, ok: true })
    expect(hits[0].headers['content-length']).toBe('0')
    expect(hits[0].headers['transfer-encoding']).toBeUndefined()
  })
})
