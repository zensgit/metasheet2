/**
 * Subscription delivery: the target check happens AT EVERY ATTEMPT and the connection goes to the address
 * that check approved (S0-a, 2026-11-03).
 *
 * `webhook-service-ssrf.test.ts` proves refusals through an injected `fetchFn` mock, which cannot show what
 * address a real send connects to. This file runs the production wiring — `new WebhookService(db)`-style,
 * no `fetchFn` — and watches the real transport:
 *
 *   - REBINDING: the resolver answers a public address for the check and an internal one afterwards; only the
 *     checked address may be connected (`https.request` spied, its real `lookup` callback driven with both of
 *     Node's call shapes). A retry attempt is checked again and refused once the name turns internal.
 *   - 3xx: the second hop receives ZERO requests; the row ends terminal, not re-queued.
 *   - Refused targets (http / loopback / private / name resolving internal) never reach the transport.
 *   - The access re-check, re-mask and signature still run on the pinned path (the receiver sees the
 *     re-masked body and a valid signature).
 *   - POSITIVE CONTROLS: a 204 and a non-JSON 2xx are delivered through the REAL `https.request` to a
 *     loopback TLS server (certificate generated at runtime). The resolver is exercised separately — the
 *     pinned-send seam records the pin the service chose and then calls the real helper with the loopback pin.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/types'
import type { WebhookDelivery } from '../../src/multitable/webhooks'
import type { SsrfLookupFn } from '../../src/multitable/webhook-ssrf-guard'
import { pinnedHttpsFetch, type PinnedSendFn } from '../../src/multitable/webhook-pinned-fetch'
import { generateRuntimeSelfSignedCert } from '../helpers/runtime-self-signed-cert'

const decision = vi.hoisted(() => ({ next: null as unknown }))
vi.mock('../../src/multitable/webhook-delivery-authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/webhook-delivery-authority')>()
  return { ...actual, authorizeWebhookDelivery: vi.fn(async () => decision.next) }
})

import { WebhookService } from '../../src/multitable/webhook-service'

const HOST = 'hooks.s0a-sub-test.invalid'
const CHECKED_PUBLIC = '203.0.113.10'
const SECRET = 'subscription-test-secret'
const MASKED_PAYLOAD = { sheetId: 'sheet1', recordId: 'rec1', changes: { fld_visible: 2 } }

type Op = { kind: string; table: string; data?: unknown }

function recordingDb(webhookRow: Record<string, unknown>) {
  const ops: Op[] = []
  const chain = (kind: string, table: string) => {
    const op: Op = { kind, table }
    ops.push(op)
    const self: Record<string, unknown> = {}
    for (const m of ['selectAll', 'select', 'where', 'orderBy', 'limit']) self[m] = vi.fn(() => self)
    self.set = vi.fn((data: unknown) => { op.data = data; return self })
    self.values = vi.fn((data: unknown) => { op.data = data; return self })
    self.execute = vi.fn(async () => [])
    self.executeTakeFirst = vi.fn(async () => (kind === 'select' ? webhookRow : undefined))
    return self
  }
  const db = {
    selectFrom: vi.fn((t: string) => chain('select', t)),
    insertInto: vi.fn((t: string) => chain('insert', t)),
    updateTable: vi.fn((t: string) => chain('update', t)),
    deleteFrom: vi.fn((t: string) => chain('delete', t)),
  }
  const deliveryWrites = () => ops
    .filter((op) => op.kind === 'update' && op.table === 'multitable_webhook_deliveries')
    .map((op) => op.data as Record<string, unknown>)
  return { db: db as unknown as Kysely<Database>, deliveryWrites }
}

function webhookRow(url: string) {
  return {
    id: 'wh1',
    name: 'w',
    url,
    secret: SECRET,
    events: JSON.stringify(['record.updated']),
    active: true,
    created_by: 'owner1',
    created_at: '2026-11-03T00:00:00.000Z',
    failure_count: 0,
    max_retries: 3,
    sheet_id: 'sheet1',
  }
}

function pending(over: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id: 'del1',
    webhookId: 'wh1',
    event: 'record.updated',
    payload: { sheetId: 'sheet1', recordId: 'rec1', changes: { fld_hidden: 1, fld_visible: 2 } },
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-11-03T00:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  decision.next = { deliver: true, payload: MASKED_PAYLOAD }
  ;(globalThis.fetch as unknown as { mockClear?: () => void }).mockClear?.()
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** Spy on the REAL `https.request` export; drive the helper's `lookup` exactly as Node does; answer `status`. */
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
      res.setEncoding = () => res
      setImmediate(() => {
        cb?.(res as unknown as IncomingMessage)
        setImmediate(() => res.emit('end'))
      })
      return req
    }
    return req
  }) as unknown as typeof https.request)
  return { spy, connectTargets }
}

describe('subscription delivery — DNS rebinding between check and connect', () => {
  it('only the CHECKED address is connected, never a later resolution', async () => {
    const lookup = vi.fn<SsrfLookupFn>()
      .mockResolvedValueOnce([{ address: CHECKED_PUBLIC, family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const { spy, connectTargets } = spyHttpsRequest(204)
    const { db, deliveryWrites } = recordingDb(webhookRow(`https://${HOST}/in`))
    const delivery = pending()
    await new WebhookService(db, undefined, lookup).executeDelivery(delivery)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(connectTargets).toEqual([[{ address: CHECKED_PUBLIC, family: 4 }], CHECKED_PUBLIC])
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(delivery.status).toBe('success')
    expect(deliveryWrites().some((w) => w.status === 'success')).toBe(true)
  })

  it('the next attempt is checked again: a name that turned internal is refused before any send', async () => {
    const lookup = vi.fn<SsrfLookupFn>()
      .mockResolvedValueOnce([{ address: CHECKED_PUBLIC, family: 4 }])
      .mockResolvedValue([{ address: '10.0.0.5', family: 4 }])
    const { spy } = spyHttpsRequest(503)
    const { db } = recordingDb(webhookRow(`https://${HOST}/in`))
    const svc = new WebhookService(db, undefined, lookup)
    const delivery = pending()
    await svc.executeDelivery(delivery) // 503 → re-queued
    await svc.executeDelivery(delivery) // retry: re-checked, refused
    expect(lookup).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(delivery.responseBody)).toBe('WEBHOOK_TARGET_REJECTED:dns-resolved-internal')
  })
})

describe('subscription delivery — refused targets never reach the transport', () => {
  const cases: Array<{ name: string; url: string; lookup?: SsrfLookupFn }> = [
    { name: 'http scheme', url: `http://${HOST}/in` },
    { name: 'loopback literal', url: 'https://127.0.0.1/in' },
    { name: 'private literal', url: 'https://10.1.2.3/in' },
    { name: 'name resolving internal', url: `https://${HOST}/in`, lookup: async () => [{ address: '192.168.1.20', family: 4 }] },
  ]
  for (const c of cases) {
    it(c.name, async () => {
      const pinnedSend = vi.fn<PinnedSendFn>()
      const { spy } = spyHttpsRequest(204)
      const { db } = recordingDb(webhookRow(c.url))
      const delivery = pending()
      await new WebhookService(db, undefined, c.lookup ?? (async () => [{ address: CHECKED_PUBLIC, family: 4 }]), pinnedSend).executeDelivery(delivery)
      expect(pinnedSend).not.toHaveBeenCalled()
      expect(spy).not.toHaveBeenCalled()
      expect(globalThis.fetch).not.toHaveBeenCalled()
      expect(String(delivery.responseBody)).toMatch(/^WEBHOOK_TARGET_REJECTED:/)
    })
  }
})

describe('subscription delivery — real https.request against a loopback TLS server', () => {
  let server: https.Server
  let port = 0
  let ca = ''
  const hits: Array<{ path: string; body: string; signature: string | undefined; deliveryId: string | undefined }> = []

  beforeAll(async () => {
    const { cert, key } = generateRuntimeSelfSignedCert(HOST)
    ca = cert
    server = https.createServer({ cert, key }, (req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (c: string) => { body += c })
      req.on('end', () => {
        hits.push({
          path: req.url ?? '',
          body,
          signature: req.headers['x-webhook-signature'] as string | undefined,
          deliveryId: req.headers['x-webhook-delivery'] as string | undefined,
        })
        if (req.url === '/no-content') { res.writeHead(204); res.end(); return }
        if (req.url === '/text-ok') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('accepted, not json'); return }
        if (req.url === '/redirect') { res.writeHead(307, { Location: `https://${HOST}:${port}/second-hop` }); res.end('moved'); return }
        res.writeHead(200); res.end('second hop')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function loopbackSend() {
    const pins: string[] = []
    const send: PinnedSendFn = async (url, pinnedAddress, _family, opts) => {
      pins.push(pinnedAddress)
      return pinnedHttpsFetch(url, '127.0.0.1', 4, { ...opts, ca })
    }
    return { send, pins }
  }
  const publicLookup: SsrfLookupFn = async () => [{ address: CHECKED_PUBLIC, family: 4 }]

  it('POSITIVE CONTROL: a 204 target is delivered, with the re-masked body and a valid signature', async () => {
    hits.length = 0
    const { send, pins } = loopbackSend()
    const { db, deliveryWrites } = recordingDb(webhookRow(`https://${HOST}:${port}/no-content`))
    const delivery = pending()
    await new WebhookService(db, undefined, publicLookup, send).executeDelivery(delivery)

    expect(delivery.status).toBe('success')
    expect(delivery.httpStatus).toBe(204)
    expect(pins).toEqual([CHECKED_PUBLIC])
    expect(hits).toHaveLength(1)
    expect(JSON.parse(hits[0].body)).toEqual(MASKED_PAYLOAD) // re-masked, not the stored body
    expect(hits[0].signature).toBe(WebhookService.signPayload(hits[0].body, SECRET))
    expect(hits[0].deliveryId).toBe('del1')
    expect(deliveryWrites().some((w) => w.status === 'success')).toBe(true)
  })

  it('POSITIVE CONTROL: a non-JSON 2xx body is delivered and its text is recorded', async () => {
    hits.length = 0
    const { send } = loopbackSend()
    const { db } = recordingDb(webhookRow(`https://${HOST}:${port}/text-ok`))
    const delivery = pending()
    await new WebhookService(db, undefined, publicLookup, send).executeDelivery(delivery)
    expect(delivery.status).toBe('success')
    expect(delivery.httpStatus).toBe(200)
    expect(delivery.responseBody).toBe('accepted, not json')
    expect(hits.map((h) => h.path)).toEqual(['/text-ok'])
  })

  it('a 3xx is refused terminally and the second hop receives ZERO requests', async () => {
    hits.length = 0
    const { send } = loopbackSend()
    const { db, deliveryWrites } = recordingDb(webhookRow(`https://${HOST}:${port}/redirect`))
    const delivery = pending()
    await new WebhookService(db, undefined, publicLookup, send).executeDelivery(delivery)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(hits.filter((h) => h.path === '/second-hop')).toHaveLength(0)
    expect(hits.map((h) => h.path)).toEqual(['/redirect'])
    expect(delivery.status).toBe('failed')
    // Terminal: the row is written failed with no retry scheduled.
    const last = deliveryWrites().at(-1) ?? {}
    expect(last.status).toBe('failed')
    expect(last.next_retry_at ?? null).toBeNull()
    // The redirect response body is never read or stored.
    expect(String(delivery.responseBody ?? '')).not.toContain('moved')
  })
})
