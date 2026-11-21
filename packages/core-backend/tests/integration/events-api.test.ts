import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Pool } from 'pg'
import net from 'net'
import http from 'http'

type HttpResponse = { status: number; body?: unknown; raw: string }
type TestServer = {
  start: () => Promise<void>
  stop?: () => Promise<void>
  getAddress: () => { port?: number } | null
}

/*
 * Event bus API on the REAL server mount, against the database the CI step migrated (2026-11-21, review
 * P2 on #6941). Wired as a whole file into the `events-api-real-db-integration` step of plugin-tests.yml
 * (after `db:migrate`, `DATABASE_URL` + `EXPECT_DB=1`); excluded from the no-DB default config. The file
 * used to run its own Kysely migrator over the TypeScript migrations only, in an isolated schema — that
 * is not the production migration set (no SQL migrations, no CI exclusions) and it stopped on an old
 * migration before any route ran, so the file never ran in CI at all. It now uses the step's migrated
 * database, like every other wired real-DB suite.
 *
 * Webhook delivery from POST /api/events/subscribe goes through the S0-a egress guard (2026-11-17): https
 * only, no internal name or IP literal (a values-free 400 at subscribe), resolve-and-refuse plus the pinned
 * https transport on every delivery. `MetaSheetServer` mounts `eventsRouter()` with no seams, exactly as
 * production does. Two module seams, no others:
 *  - the pinned transport is a recorder (no socket);
 *  - `node:dns/promises` (what the guard's default resolver calls) answers ONE test name with a private
 *    address and passes every other name through, so the delivery-time refusal runs the real guard on a
 *    real resolution path without the network; and ONE more name with a public address that arrives
 *    only after the delivery budget is spent (the late-resolution case of the same review).
 * What is checked on the database is the bus's own bookkeeping: one `event_deliveries` row per
 * (event, subscription) with `success` and the closed-set `error_message`.
 */
const seams = vi.hoisted(() => ({
  pinnedSends: [] as Array<{ url: string; pin: string; family: number; body: string }>,
  internalName: 'hooks-internal.example.test',
  internalAddr: '10.20.30.40',
  // Answers with a public address, but only after the subscription's whole delivery budget is gone.
  slowName: 'hooks-slow.example.test',
  slowDelayMs: 1_800,
}))
vi.mock('../../src/multitable/webhook-pinned-fetch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pinnedHttpsFetch: async (url: string, pin: string, family: number, init: { body?: string }) => {
    seams.pinnedSends.push({ url, pin, family, body: String(init?.body ?? '') })
    return { status: 200, ok: true }
  },
}))
vi.mock('node:dns/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns/promises')>()
  const lookup = (async (hostname: string, options?: unknown) => {
    if (hostname === seams.internalName) return [{ address: seams.internalAddr, family: 4 }]
    if (hostname === seams.slowName) {
      await new Promise(resolve => setTimeout(resolve, seams.slowDelayMs))
      return [{ address: '93.184.216.34', family: 4 }]
    }
    return (actual.lookup as (h: string, o?: unknown) => Promise<unknown>)(hostname, options)
  }) as typeof actual.lookup
  return { ...actual, lookup, default: { ...((actual as { default?: object }).default ?? {}), lookup } }
})

const PUBLIC_WEBHOOK_ADDR = '93.184.216.34'

const dbUrl = process.env.DATABASE_URL
// In the real-DB step a missing database is a failure, never a skip-green.
if (!dbUrl && process.env.EXPECT_DB === '1') {
  throw new Error('events-api.test.ts: DATABASE_URL is required when EXPECT_DB=1')
}

function requestJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(
      {
        method: options.method || 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (res) => {
        let data = ''
        res.on('data', chunk => {
          data += chunk
        })
        res.on('end', () => {
          let body: unknown
          try {
            body = data ? JSON.parse(data) : undefined
          } catch {
            body = undefined
          }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      }
    )
    req.on('error', reject)
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

type DeliveryRow = { success: boolean; error_message: string | null }

async function waitForDeliveries(pool: Pool, eventId: string, subscriptionId: string): Promise<DeliveryRow[]> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const { rows } = await pool.query<DeliveryRow>(
      'SELECT success, error_message FROM event_deliveries WHERE event_id = $1 AND subscription_id = $2',
      [eventId, subscriptionId],
    )
    if (rows.length > 0 || Date.now() > deadline) return rows
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

function sendsFor(eventId: string) {
  return seams.pinnedSends.filter((s) => {
    try {
      return (JSON.parse(s.body) as { event_id?: string }).event_id === eventId
    } catch {
      return false
    }
  })
}

const describeWithDb = dbUrl ? describe : describe.skip

describeWithDb('Event bus API integration (real mount, migrated database)', () => {
  let server: TestServer | undefined
  let pool: Pool | undefined
  let baseUrl = ''
  const runTag = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`
  const subscriptionIds: string[] = []
  let adminToken = ''

  async function devToken(query: string): Promise<string> {
    const tokenRes = await requestJson(`${baseUrl}/api/auth/dev-token?${query}`)
    expect(tokenRes.status).toBe(200)
    const token = (tokenRes.body as { token?: string } | undefined)?.token
    expect(token).toBeTruthy()
    return token as string
  }

  function adminHeaders() {
    return { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }
  }

  async function subscribe(subscriberId: string, eventPattern: string, webhookUrl: string, options?: Record<string, unknown>): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/events/subscribe`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ subscriberId, eventPattern, webhookUrl, ...(options ? { options } : {}) }),
    })
    expect(res.status).toBe(200)
    expect((res.body as { ok?: boolean } | undefined)?.ok).toBe(true)
    const id = (res.body as { data?: { subscriptionId?: string } } | undefined)?.data?.subscriptionId || ''
    expect(id).toBeTruthy()
    subscriptionIds.push(id)
    return id
  }

  async function emit(eventName: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/events/emit`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ eventName, payload: { source: 'events-api-test', runTag } }),
    })
    expect(res.status).toBe(200)
    expect((res.body as { ok?: boolean } | undefined)?.ok).toBe(true)
    const eventId = (res.body as { data?: { eventId?: string } } | undefined)?.data?.eventId || ''
    expect(eventId).toBeTruthy()
    return eventId
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const socket = net.createServer()
      socket.once('error', () => resolve(false))
      socket.listen(0, '127.0.0.1', () => socket.close(() => resolve(true)))
    })
    // Not a silent skip: a runner that cannot listen on loopback cannot prove anything here.
    expect(canListen).toBe(true)

    process.env.SKIP_PLUGINS = 'true'
    pool = new Pool({ connectionString: dbUrl as string })

    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
    })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address?.port}`
    adminToken = await devToken('userId=events-admin&roles=admin&perms=admin')
  }, 180_000) // importing and starting the whole server is slow on a cold runner

  afterAll(async () => {
    for (const id of subscriptionIds) {
      if (baseUrl && adminToken) {
        await requestJson(`${baseUrl}/api/events/subscribe/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${adminToken}` },
        }).catch(() => undefined)
      }
    }
    if (server && server.stop) {
      await server.stop()
    }
    if (pool) {
      await pool.end()
    }
  })

  it('rejects non-admin users from querying event bus routes', async () => {
    const userToken = await devToken('userId=events-user&roles=user&perms=attendance:read')
    const listRes = await requestJson(`${baseUrl}/api/events?limit=10`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(listRes.status).toBe(403)
    expect((listRes.body as { error?: { code?: string } } | undefined)?.error?.code).toBe('FORBIDDEN')
  })

  it('refuses the pre-guard receiver shape (loopback http) at subscribe, values-free, and stores no subscription', async () => {
    const subscriberId = `events-api-loopback-${runTag}`
    const res = await requestJson(`${baseUrl}/api/events/subscribe`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        subscriberId,
        eventPattern: `integration.events_api_loopback_${runTag}`,
        webhookUrl: 'http://127.0.0.1:8900/hook',
      }),
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ ok: false, error: { code: 'WEBHOOK_TARGET_REJECTED', refusalClass: 'loopback' } })
    expect(res.raw).not.toContain('127.0.0.1')
    const { rows } = await (pool as Pool).query('SELECT 1 FROM event_subscriptions WHERE subscriber_id = $1', [subscriberId])
    expect(rows).toHaveLength(0)
  })

  it('a successful delivery goes through the pinned transport and is booked success = true', async () => {
    const eventName = `integration.events_api_ok_${runTag}`
    const subscriptionId = await subscribe(`events-api-ok-${runTag}`, eventName, `https://${PUBLIC_WEBHOOK_ADDR}/hook`)
    const eventId = await emit(eventName)

    const rows = await waitForDeliveries(pool as Pool, eventId, subscriptionId)
    expect(rows).toEqual([{ success: true, error_message: null }])

    // Delivered through the pinned transport to the approved address, with the event as the body. At least
    // one: a non-wildcard pattern is delivered by both bus call sites (processEvent and the local listener).
    const sends = sendsFor(eventId)
    expect(sends.length).toBeGreaterThanOrEqual(1)
    for (const send of sends) {
      expect(send.url).toBe(`https://${PUBLIC_WEBHOOK_ADDR}/hook`)
      expect(send.pin).toBe(PUBLIC_WEBHOOK_ADDR)
      expect(send.family).toBe(4)
      expect(JSON.parse(send.body)).toMatchObject({ event_id: eventId, event_name: eventName })
    }

    const listRes = await requestJson(`${baseUrl}/api/events?limit=10`, { headers: adminHeaders() })
    expect(listRes.status).toBe(200)
    expect((listRes.body as { ok?: boolean } | undefined)?.ok).toBe(true)
    expect(Array.isArray((listRes.body as { data?: { events?: unknown[] } } | undefined)?.data?.events)).toBe(true)

    const replayRes = await requestJson(`${baseUrl}/api/events/replay`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ criteria: { event_ids: [eventId] }, reason: 'integration coverage' }),
    })
    expect(replayRes.status).toBe(200)
    expect((replayRes.body as { ok?: boolean } | undefined)?.ok).toBe(true)
    expect((replayRes.body as { data?: { replayId?: string } } | undefined)?.data?.replayId).toBeTruthy()
  })

  it('a name that resolves to a private address is refused at delivery: nothing is sent, booked success = false with the closed-set token', async () => {
    const eventName = `integration.events_api_refused_${runTag}`
    // The shape check (no DNS) accepts a public-looking name; the per-delivery resolution is the boundary.
    const subscriptionId = await subscribe(`events-api-refused-${runTag}`, eventName, `https://${seams.internalName}/in`)
    const eventId = await emit(eventName)

    const rows = await waitForDeliveries(pool as Pool, eventId, subscriptionId)
    expect(rows).toEqual([{ success: false, error_message: 'WEBHOOK_TARGET_REJECTED:dns-resolved-internal' }])
    expect(sendsFor(eventId)).toHaveLength(0)

    const { rows: stats } = await (pool as Pool).query<{ total_events_failed: number | string }>(
      'SELECT total_events_failed FROM event_subscriptions WHERE id = $1',
      [subscriptionId],
    )
    expect(stats).toHaveLength(1)
    expect(Number(stats[0].total_events_failed)).toBeGreaterThanOrEqual(1)
  })

  it('a resolution slower than the subscription budget: the bus books the closed-set timeout and the late answer sends nothing', async () => {
    const eventName = `integration.events_api_slow_${runTag}`
    const subscriptionId = await subscribe(`events-api-slow-${runTag}`, eventName, `https://${seams.slowName}/in`, { timeout_ms: 1000 })
    const eventId = await emit(eventName)

    const rows = await waitForDeliveries(pool as Pool, eventId, subscriptionId)
    expect(rows).toEqual([{ success: false, error_message: 'EVENT_WEBHOOK_DELIVERY_FAILED:timeout' }])
    // Let every late resolution of this event (both bus call sites) arrive, then prove none of them sent.
    await new Promise(resolve => setTimeout(resolve, seams.slowDelayMs + 700))
    expect(sendsFor(eventId)).toHaveLength(0)
  })
})
