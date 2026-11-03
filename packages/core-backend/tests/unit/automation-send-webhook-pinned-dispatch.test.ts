/**
 * Rule-driven `send_webhook`: the target check happens AT THE SEND, and the connection goes to the address
 * that check approved (S0-a, 2026-11-03).
 *
 * `automation-send-webhook-ssrf.test.ts` proves the gate REFUSES; it dispatches through an injected
 * `fetchFn` mock, so it cannot see what address a real send connects to. This file runs the production
 * wiring — no `fetchFn` — and watches the real transport:
 *
 *   - REBINDING: the resolver answers a public address for the check and an internal one afterwards; the
 *     only address the transport may connect to is the checked one (`https.request` is observed through a
 *     spy that drives the helper's real `lookup` callback with both of Node's call shapes).
 *   - RETRY RE-CHECK (legacy loop): every attempt is checked again; a target that turns internal between
 *     attempts is refused before the second send.
 *   - 3xx: the second hop receives ZERO requests, on both dispatch branches.
 *   - POSITIVE CONTROLS: a 204 and a non-JSON 2xx are delivered successfully through the REAL `https.request`
 *     to a loopback TLS server (certificate generated at runtime). The resolver is exercised separately —
 *     the `pinnedWebhookSendFn` seam records the pin the executor chose and then calls the real helper with
 *     the loopback pin. Without these, a suite of refusals would stay green if every send failed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import type { SsrfLookupFn } from '../../src/multitable/webhook-ssrf-guard'
import { pinnedHttpsFetch, type PinnedSendFn } from '../../src/multitable/webhook-pinned-fetch'
import { generateRuntimeSelfSignedCert } from '../helpers/runtime-self-signed-cert'

const CLASSB_FLAG = 'AUTOMATION_CLASSB_OUTBOUND_ENABLED'
const TRIGGER = { recordId: 'rec_1', sheetId: 'sheet_1', actorId: 'user_1', data: {} }
/** TEST-NET-3 (RFC 5737): public as far as the guard is concerned, never routed. */
const CHECKED_PUBLIC = '203.0.113.10'
const HOST = 'hooks.s0a-test.invalid'

type Branch = 'legacy' | 'two-phase'
const BRANCHES: Branch[] = ['legacy', 'two-phase']

function webhookRule(config: Record<string, unknown>): AutomationRule {
  return {
    id: 'rule_pin',
    name: 'pinned webhook rule',
    sheetId: 'sheet_1',
    trigger: { type: 'record.created', config: {} },
    actions: [{ type: 'send_webhook', config } as never],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

interface Harness {
  deps: AutomationDeps
  sql: Array<{ text: string; params: unknown[] }>
}

function makeHarness(extra: Partial<AutomationDeps>): Harness {
  const sql: Harness['sql'] = []
  const queryFn = vi.fn(async (text: string, params?: unknown[]) => {
    sql.push({ text: String(text), params: params ?? [] })
    if (/meta_automation_outbound_intent/i.test(String(text))) return { rows: [], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) as unknown as AutomationDeps['queryFn']
  // NO `fetchFn` — the production wiring (`src/index.ts` passes none).
  return { deps: { eventBus: new EventBus(), queryFn, ...extra }, sql }
}

async function run(h: Harness, branch: Branch, config: Record<string, unknown>) {
  if (branch === 'two-phase') process.env[CLASSB_FLAG] = 'true'
  else delete process.env[CLASSB_FLAG]
  const exec = await new AutomationExecutor(h.deps).execute(
    webhookRule(config),
    TRIGGER,
    undefined,
    branch === 'two-phase' ? 'exec_root_pin' : undefined,
  )
  return exec.steps[0]
}

function recordedOutcome(h: Harness): unknown {
  const update = h.sql.find((q) => /UPDATE meta_automation_outbound_intent/i.test(q.text))
  return update?.params[3]
}

beforeEach(() => {
  process.env.AUTOMATION_WEBHOOK_MAX_RETRIES = '0'
  // `tests/setup.ts` stubs the global `fetch` with a bare `vi.fn()`; clear its call history per test.
  ;(globalThis.fetch as unknown as { mockClear?: () => void }).mockClear?.()
})
afterEach(() => {
  delete process.env[CLASSB_FLAG]
  delete process.env.AUTOMATION_WEBHOOK_MAX_RETRIES
  vi.restoreAllMocks()
})

/**
 * A spy on the REAL `https.request` export the helper calls by default. It drives the helper-supplied
 * `lookup` exactly as Node does (`{ all: true }` first, then the legacy shape), records every address it is
 * handed — i.e. the connect target — and answers `status` without opening a socket.
 */
function spyHttpsRequest(status: number) {
  const connectTargets: unknown[] = []
  const spy = vi.spyOn(https, 'request').mockImplementation(((_url: unknown, options: https.RequestOptions, cb?: (res: IncomingMessage) => void) => {
    const lookup = options.lookup as unknown as (h: string, o: unknown, done: (...a: unknown[]) => void) => void
    lookup(HOST, { all: true }, (_e, addresses) => { connectTargets.push(addresses) })
    lookup(HOST, {}, (_e, address) => { connectTargets.push(address) })
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>
    req.write = () => true
    req.destroy = () => req
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & Record<string, unknown>
      res.statusCode = status
      res.destroy = () => res
      setImmediate(() => cb?.(res as unknown as IncomingMessage))
      return req
    }
    return req
  }) as unknown as typeof https.request)
  return { spy, connectTargets }
}

describe('send_webhook — DNS rebinding between check and connect', () => {
  for (const branch of BRANCHES) {
    it(`${branch}: only the CHECKED address is connected, never a later resolution`, async () => {
      const lookup = vi.fn<SsrfLookupFn>()
        .mockResolvedValueOnce([{ address: CHECKED_PUBLIC, family: 4 }])
        .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
      const { spy, connectTargets } = spyHttpsRequest(204)
      const h = makeHarness({ ssrfLookupFn: lookup })
      const step = await run(h, branch, { url: `https://${HOST}/hook` })

      expect(step?.status).toBe('success')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(connectTargets).toEqual([[{ address: CHECKED_PUBLIC, family: 4 }], CHECKED_PUBLIC])
      // The platform `fetch` (which would re-resolve the name) is not on this path at all.
      expect(globalThis.fetch).not.toHaveBeenCalled()
      expect(lookup).toHaveBeenCalledTimes(1)
    })
  }

  it('legacy retry loop: every attempt is checked again — a target that turns internal is refused before the next send', async () => {
    process.env.AUTOMATION_WEBHOOK_MAX_RETRIES = '1'
    const lookup = vi.fn<SsrfLookupFn>()
      .mockResolvedValueOnce([{ address: CHECKED_PUBLIC, family: 4 }])
      .mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    const { spy } = spyHttpsRequest(503)
    const h = makeHarness({ ssrfLookupFn: lookup })
    const step = await run(h, 'legacy', { url: `https://${HOST}/hook` })

    expect(spy).toHaveBeenCalledTimes(1) // the first attempt went out; the second was never dispatched
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(step?.status).toBe('failed')
    expect(step?.error).toBe('WEBHOOK_TARGET_REJECTED:dns-resolved-internal')
  })
})

describe('send_webhook — refused targets never reach the transport', () => {
  const cases: Array<{ name: string; url: string; lookup?: SsrfLookupFn }> = [
    { name: 'http scheme', url: `http://${HOST}/hook` },
    { name: 'loopback literal', url: 'https://127.0.0.1/hook' },
    { name: 'private literal', url: 'https://10.1.2.3/hook' },
    { name: 'name resolving internal', url: `https://${HOST}/hook`, lookup: async () => [{ address: '192.168.1.20', family: 4 }] },
  ]
  for (const branch of BRANCHES) {
    for (const c of cases) {
      it(`${branch}: ${c.name}`, async () => {
        const pinnedSend = vi.fn<PinnedSendFn>()
        const { spy } = spyHttpsRequest(204)
        const h = makeHarness({ ssrfLookupFn: c.lookup ?? (async () => [{ address: CHECKED_PUBLIC, family: 4 }]), pinnedWebhookSendFn: pinnedSend })
        const step = await run(h, branch, { url: c.url })
        expect(step?.status).toBe('failed')
        expect(String(step?.error)).toMatch(/^WEBHOOK_TARGET_REJECTED:/)
        expect(pinnedSend).not.toHaveBeenCalled()
        expect(spy).not.toHaveBeenCalled()
        expect(globalThis.fetch).not.toHaveBeenCalled()
      })
    }
  }
})

describe('send_webhook — real https.request against a loopback TLS server', () => {
  let server: https.Server
  let port = 0
  let ca = ''
  const hits: Array<{ path: string; body: string }> = []

  beforeAll(async () => {
    const { cert, key } = generateRuntimeSelfSignedCert(HOST)
    ca = cert
    server = https.createServer({ cert, key }, (req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (c: string) => { body += c })
      req.on('end', () => {
        hits.push({ path: req.url ?? '', body })
        if (req.url === '/no-content') { res.writeHead(204); res.end(); return }
        if (req.url === '/text-ok') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('accepted'); return }
        if (req.url === '/redirect') { res.writeHead(307, { Location: `https://${HOST}:${port}/second-hop` }); res.end(); return }
        res.writeHead(200); res.end('second hop')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** Records the pin the EXECUTOR chose, then sends through the REAL helper + REAL https.request to loopback. */
  function loopbackSend() {
    const pins: string[] = []
    const send: PinnedSendFn = async (url, pinnedAddress, _family, opts) => {
      pins.push(pinnedAddress)
      return pinnedHttpsFetch(url, '127.0.0.1', 4, { ...opts, ca })
    }
    return { send, pins }
  }

  const publicLookup: SsrfLookupFn = async () => [{ address: CHECKED_PUBLIC, family: 4 }]

  for (const branch of BRANCHES) {
    it(`${branch} POSITIVE CONTROL: a 204 target is delivered`, async () => {
      hits.length = 0
      const { send, pins } = loopbackSend()
      const h = makeHarness({ ssrfLookupFn: publicLookup, pinnedWebhookSendFn: send })
      const step = await run(h, branch, { url: `https://${HOST}:${port}/no-content`, body: { hello: 'world' } })
      expect(step?.status).toBe('success')
      expect(pins).toEqual([CHECKED_PUBLIC])
      expect(hits).toEqual([{ path: '/no-content', body: '{"hello":"world"}' }])
      if (branch === 'two-phase') expect(recordedOutcome(h)).toBe('sent')
    })

    it(`${branch} POSITIVE CONTROL: a non-JSON 2xx body is delivered`, async () => {
      hits.length = 0
      const { send } = loopbackSend()
      const h = makeHarness({ ssrfLookupFn: publicLookup, pinnedWebhookSendFn: send })
      const step = await run(h, branch, { url: `https://${HOST}:${port}/text-ok` })
      expect(step?.status).toBe('success')
      expect(hits.map((x) => x.path)).toEqual(['/text-ok'])
      if (branch === 'two-phase') expect(recordedOutcome(h)).toBe('sent')
    })

    it(`${branch}: a 3xx is refused and the second hop receives ZERO requests`, async () => {
      hits.length = 0
      process.env.AUTOMATION_WEBHOOK_MAX_RETRIES = '2' // a retrying loop must not retry a redirect either
      const { send } = loopbackSend()
      const h = makeHarness({ ssrfLookupFn: publicLookup, pinnedWebhookSendFn: send })
      const step = await run(h, branch, { url: `https://${HOST}:${port}/redirect` })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(step?.status).toBe('failed')
      expect(step?.error).toBe('WEBHOOK_TARGET_REJECTED:redirect-not-allowed')
      expect(hits.filter((x) => x.path === '/second-hop')).toHaveLength(0)
      expect(hits.map((x) => x.path)).toEqual(['/redirect'])
      // Two-phase keeps its at-most-once bookkeeping: the intent is closed (not left pending) as an
      // ambiguous outcome, which a later run skips instead of re-sending.
      if (branch === 'two-phase') expect(recordedOutcome(h)).toBe('outcome_unknown')
    })
  }
})

describe('send_webhook — a transport failure on the pinned path persists a closed class, never the address (S0-a review F2)', () => {
  let server: https.Server
  let livePort = 0
  let closedPort = 0
  let ca = ''

  beforeAll(async () => {
    const { cert, key } = generateRuntimeSelfSignedCert(HOST)
    ca = cert
    server = https.createServer({ cert, key }, (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(204); res.end() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    livePort = (server.address() as AddressInfo).port
    // A port that was just bound and released: nothing listens there, so the connect is refused.
    const probe = https.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    closedPort = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const publicLookup: SsrfLookupFn = async () => [{ address: CHECKED_PUBLIC, family: 4 }]
  /** The REAL helper over a REAL socket, pinned to loopback (the executor's chosen pin is the checked one). */
  const realSend: PinnedSendFn = (url, _pin, _family, opts) => pinnedHttpsFetch(url, '127.0.0.1', 4, { ...opts, ca })

  function expectNoAddress(text: string, port: number, host: string) {
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain(CHECKED_PUBLIC)
    expect(text).not.toContain(String(port))
    expect(text).not.toContain(host)
    expect(text).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/)
  }

  for (const branch of BRANCHES) {
    it(`${branch}: connection refused -> step.error names the class only (no IP, no port)`, async () => {
      const h = makeHarness({ ssrfLookupFn: publicLookup, pinnedWebhookSendFn: realSend })
      const step = await run(h, branch, { url: `https://${HOST}:${closedPort}/hook` })
      expect(step?.status).toBe('failed')
      const text = String(step?.error)
      if (branch === 'legacy') {
        expect(text).toBe('Webhook failed after 1 attempts: conn-refused')
        expect(step?.output).toMatchObject({ failureClass: 'conn-refused' })
      }
      expectNoAddress(text, closedPort, HOST)
      expectNoAddress(JSON.stringify(step?.output ?? {}), closedPort, HOST)
    })

    it(`${branch}: TLS name mismatch -> step.error names the class only (no host, no IP, no port)`, async () => {
      const other = 'other.s0a-test.invalid'
      const h = makeHarness({ ssrfLookupFn: publicLookup, pinnedWebhookSendFn: realSend })
      const step = await run(h, branch, { url: `https://${other}:${livePort}/hook` })
      expect(step?.status).toBe('failed')
      const text = String(step?.error)
      if (branch === 'legacy') expect(text).toBe('Webhook failed after 1 attempts: tls-failure')
      expectNoAddress(text, livePort, other)
      expect(text).not.toContain(HOST)
    })
  }
})
