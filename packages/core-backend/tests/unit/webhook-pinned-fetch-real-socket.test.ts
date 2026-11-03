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
import { pinnedHttpsFetch } from '../../src/multitable/webhook-pinned-fetch'
import { generateRuntimeSelfSignedCert } from '../helpers/runtime-self-signed-cert'

const HOST = 'hooks.pinned-test.invalid'

interface Hit {
  path: string
  method: string
  host: string | undefined
  body: string
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
    hits.push({ path: req.url ?? '', method: req.method ?? '', host: req.headers.host, body })
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
