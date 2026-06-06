import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { MetaSheetServer } from '../../src/index'
import * as path from 'path'
import net from 'net'
import http from 'http'
import { randomUUID } from 'crypto'
import { Pool } from 'pg'

// ② 打卡策略组 S3 外勤审批 — route-level real-DB integration (design-lock
// attendance-outdoor-approval-s3-design-lock-20260605.md / #2304). Drives the actual HTTP punch / settings /
// approve / reject routes against a migrated postgres; asserts the punch→pending→approve/reject state-flow
// through attendance_events / attendance_records / attendance_requests (the same tables summary reads, so
// "pending not counted / approved counted" is proven by record presence/absence).

type HttpResponse = { status: number; body?: unknown; raw: string }

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
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          let body: unknown
          try { body = data ? JSON.parse(data) : undefined } catch { body = undefined }
          resolve({ status: res.statusCode || 0, body, raw: data })
        })
      },
    )
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const ORG = 'default'
const FENCE = { lat: 31.2304, lng: 121.4737, radiusMeters: 100 }
const INSIDE = { lat: 31.2304, lng: 121.4737 }
const OUTSIDE = { lat: 0, lng: 0 }

describeDb('② S3 outdoor punch approval (real DB, route-level)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let pool: Pool
  let adminToken = ''
  let originalPunchPolicy: unknown
  let originalGeoFence: unknown

  const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

  async function mintToken(userId: string, perms: string): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent(perms)}`)
    return (res.body as { token?: string } | undefined)?.token ?? ''
  }
  const putSettings = (body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/settings`, { method: 'PUT', headers: authHeaders(adminToken), body: JSON.stringify(body) })
  const getSettings = () => requestJson(`${baseUrl}/api/attendance/settings`, { headers: authHeaders(adminToken) })
  const punch = (token: string, body: Record<string, unknown>) =>
    requestJson(`${baseUrl}/api/attendance/punch`, { method: 'POST', headers: authHeaders(token), body: JSON.stringify(body) })
  const approve = (id: string) =>
    requestJson(`${baseUrl}/api/attendance/requests/${id}/approve`, { method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ comment: 'ok' }) })
  const reject = (id: string) =>
    requestJson(`${baseUrl}/api/attendance/requests/${id}/reject`, { method: 'POST', headers: authHeaders(adminToken), body: JSON.stringify({ comment: 'no' }) })

  const deleteOutdoorFlows = () => pool.query(`DELETE FROM attendance_approval_flows WHERE org_id = $1 AND request_type = 'outdoor_punch'`, [ORG])
  async function addOutdoorFlow(): Promise<string> {
    const res = await requestJson(`${baseUrl}/api/attendance/approval-flows`, {
      method: 'POST', headers: authHeaders(adminToken),
      body: JSON.stringify({ name: `outdoor-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`, requestType: 'outdoor_punch', isActive: true, steps: [] }),
    })
    return (res.body as { data?: { id?: string } } | undefined)?.data?.id ?? ''
  }
  // Reset to EXACTLY ONE active outdoor flow (the empty-approvalFlowId path now requires a unique flow).
  async function createOutdoorFlow(): Promise<string> {
    await deleteOutdoorFlows()
    return addOutdoorFlow()
  }

  // settings.outdoor + geofence in one PUT. Always send ALL three outdoor fields (defaults below), so a
  // value left by a previous test never leaks through mergeSettings into this test's policy.
  const setOutdoor = (outdoor: Record<string, unknown> | null, withFence = true) =>
    putSettings({ geoFence: withFence ? FENCE : null, punchPolicy: outdoor ? { outdoor: { requireApproval: false, requireNote: false, approvalFlowId: '', ...outdoor } } : {} })
  const setMerge = (merge: Record<string, unknown>) =>
    putSettings({ punchPolicy: { merge: { internalWinsOnIn: false, externalWinsOnOut: false, ...merge } } })

  async function counts(userId: string) {
    const ev = (await pool.query(`SELECT event_type, source FROM attendance_events WHERE user_id = $1`, [userId])).rows as { event_type: string; source: string }[]
    const rec = Number((await pool.query(`SELECT count(*)::int n FROM attendance_records WHERE user_id = $1`, [userId])).rows[0].n)
    const recRow = (await pool.query(`SELECT first_in_at, last_out_at, is_workday FROM attendance_records WHERE user_id = $1 LIMIT 1`, [userId])).rows[0] ?? null
    const reqs = (await pool.query(`SELECT status, metadata -> 'outdoorPunch' ->> 'eventType' AS event_type FROM attendance_requests WHERE user_id = $1 AND request_type = 'outdoor_punch'`, [userId])).rows as { status: string; event_type: string }[]
    return { events: ev, records: rec, recRow, outdoorReqs: reqs }
  }
  async function recordFor(userId: string, workDate: string) {
    return (await pool.query(
      `SELECT first_in_at, last_out_at, work_minutes, status
       FROM attendance_records
       WHERE user_id = $1 AND work_date = $2 AND org_id = $3
       LIMIT 1`,
      [userId, workDate, ORG]
    )).rows[0] ?? null
  }
  async function eventRows(userId: string, workDate: string) {
    return (await pool.query(
      `SELECT event_type, source, occurred_at
       FROM attendance_events
       WHERE user_id = $1 AND work_date = $2 AND org_id = $3
       ORDER BY occurred_at ASC, event_type ASC`,
      [userId, workDate, ORG]
    )).rows as { event_type: string; source: string; occurred_at: Date }[]
  }
  const iso = (value: unknown) => new Date(value as string | number | Date).toISOString()
  async function seedRecordOnlyFirstIn(userId: string, workDate: string, firstInAt: string, options: { status?: string; source?: string } = {}) {
    await pool.query(
      `INSERT INTO attendance_records
       (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'UTC', $5, NULL, 0, 0, 0, $6, true, $7::jsonb, NULL, now(), now())`,
      [
        randomUUID(),
        userId,
        ORG,
        workDate,
        firstInAt,
        options.status ?? 'adjusted',
        JSON.stringify({ source: options.source ?? 'record-only' }),
      ],
    )
  }
  async function seedRecordOnlyLastOut(userId: string, workDate: string, lastOutAt: string, options: { status?: string; source?: string } = {}) {
    await pool.query(
      `INSERT INTO attendance_records
       (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'UTC', NULL, $5, 0, 0, 0, $6, true, $7::jsonb, NULL, now(), now())`,
      [
        randomUUID(),
        userId,
        ORG,
        workDate,
        lastOutAt,
        options.status ?? 'adjusted',
        JSON.stringify({ source: options.source ?? 'record-only' }),
      ],
    )
  }
  async function cleanupUser(userId: string) {
    await pool.query(`DELETE FROM approval_instances WHERE business_key IN (SELECT 'attendance-request:' || id FROM attendance_requests WHERE user_id = $1)`, [userId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_requests WHERE user_id = $1`, [userId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_events WHERE user_id = $1`, [userId]).catch(() => undefined)
    await pool.query(`DELETE FROM attendance_records WHERE user_id = $1`, [userId]).catch(() => undefined)
  }

  beforeAll(async () => {
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen || !dbUrl) throw new Error('outdoor punch integration needs a loopback port + DATABASE_URL')

    process.env.DATABASE_URL = dbUrl
    process.env.RBAC_BYPASS = 'true'
    process.env.SKIP_PLUGINS = 'false'
    const repoRoot = path.join(__dirname, '../../../../')
    const { MetaSheetServer } = await import('../../src/index')
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')] })
    await server.start()
    const address = server.getAddress()
    if (!address || typeof address === 'string') throw new Error('server did not expose a TCP address')
    baseUrl = `http://127.0.0.1:${address.port}`
    pool = new Pool({ connectionString: dbUrl })
    adminToken = await mintToken('outdoor-admin', 'attendance:read,attendance:write,attendance:admin,attendance:approve')
    const before = await getSettings()
    const data = (before.body as { data?: { punchPolicy?: unknown; geoFence?: unknown } } | undefined)?.data
    originalPunchPolicy = data?.punchPolicy
    originalGeoFence = data?.geoFence
  })

  afterAll(async () => {
    if (adminToken) await putSettings({ geoFence: originalGeoFence ?? null, punchPolicy: originalPunchPolicy ?? {} }).catch(() => undefined)
    await deleteOutdoorFlows().catch(() => undefined)
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) await (server as unknown as { stop: () => Promise<void> }).stop()
    await pool?.end().catch(() => undefined)
  })

  it('default OFF: outside-fence still LOCATION_RESTRICTED; meta.outdoor ignored; in-fence writes event+record', async () => {
    await setOutdoor({ requireApproval: false })
    const a = `out-a-${Date.now().toString(36)}`, b = `out-b-${Date.now().toString(36)}`, c = `out-c-${Date.now().toString(36)}`
    const tA = await mintToken(a, 'attendance:read,attendance:write')
    const tB = await mintToken(b, 'attendance:read,attendance:write')
    const tC = await mintToken(c, 'attendance:read,attendance:write')
    try {
      // (a) outside fence + approval OFF → LOCATION_RESTRICTED, nothing written
      const ra = await punch(tA, { eventType: 'check_in', location: OUTSIDE })
      expect(ra.status).toBe(403)
      expect((ra.body as { error?: { code?: string } })?.error?.code).toBe('LOCATION_RESTRICTED')
      expect((await counts(a)).events).toHaveLength(0)
      // (b) inside fence → normal punch
      const rb = await punch(tB, { eventType: 'check_in', location: INSIDE })
      expect(rb.status).toBe(200)
      const cb = await counts(b)
      expect(cb.events).toHaveLength(1)
      expect(cb.records).toBe(1)
      // (c) inside fence + meta.outdoor=true but approval OFF → marker ignored, normal punch, NO pending request
      const rc = await punch(tC, { eventType: 'check_in', location: INSIDE, meta: { outdoor: true } })
      expect(rc.status).toBe(200)
      const cc = await counts(c)
      expect(cc.events).toHaveLength(1)
      expect(cc.outdoorReqs).toHaveLength(0)
    } finally {
      await cleanupUser(a); await cleanupUser(b); await cleanupUser(c)
    }
  })

  it('enabled: outside-fence punch → pending (no event/record); final approve writes one outdoor_approval event + record, no adjustment', async () => {
    await createOutdoorFlow()
    await setOutdoor({ requireApproval: true, requireNote: false, approvalFlowId: '' })
    const u = `out-pend-${Date.now().toString(36)}`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      const r = await punch(t, { eventType: 'check_in', location: OUTSIDE, meta: { note: 'client site' } })
      expect(r.status).toBe(202)
      expect((r.body as { data?: { pendingApproval?: boolean } })?.data?.pendingApproval).toBe(true)
      const reqId = (r.body as { data?: { request?: { id?: string } } })?.data?.request?.id as string
      expect(reqId).toBeTruthy()
      const pending = await counts(u)
      expect(pending.outdoorReqs).toEqual([{ status: 'pending', event_type: 'check_in' }])
      expect(pending.events).toHaveLength(0) // no event until approved
      expect(pending.records).toBe(0) // → not counted by summary (which reads attendance_records)

      const ap = await approve(reqId)
      expect(ap.status).toBe(200)
      const approved = await counts(u)
      // exactly one REAL punch event, source outdoor_approval, NOT a generic adjustment
      expect(approved.events).toEqual([{ event_type: 'check_in', source: 'outdoor_approval' }])
      expect(approved.records).toBe(1) // → now counted
      expect(approved.recRow?.first_in_at).toBeTruthy()
    } finally {
      await cleanupUser(u)
    }
  })

  it('enabled: final reject leaves no event and no record', async () => {
    await createOutdoorFlow()
    await setOutdoor({ requireApproval: true, requireNote: false, approvalFlowId: '' })
    const u = `out-rej-${Date.now().toString(36)}`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      const r = await punch(t, { eventType: 'check_in', location: OUTSIDE })
      expect(r.status).toBe(202)
      const reqId = (r.body as { data?: { request?: { id?: string } } })?.data?.request?.id as string
      const rj = await reject(reqId)
      expect(rj.status).toBe(200)
      const after = await counts(u)
      expect(after.events).toHaveLength(0)
      expect(after.records).toBe(0)
    } finally {
      await cleanupUser(u)
    }
  })

  it('same-day check_in and check_out outdoor pending coexist; duplicate same eventType → 409', async () => {
    await createOutdoorFlow()
    await setOutdoor({ requireApproval: true, requireNote: false, approvalFlowId: '' })
    const u = `out-dup-${Date.now().toString(36)}`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      expect((await punch(t, { eventType: 'check_in', location: OUTSIDE })).status).toBe(202)
      expect((await punch(t, { eventType: 'check_out', location: OUTSIDE })).status).toBe(202)
      const c = await counts(u)
      expect(c.outdoorReqs.map((x) => x.event_type).sort()).toEqual(['check_in', 'check_out'])
      // duplicate check_in while one is pending → 409
      const dup = await punch(t, { eventType: 'check_in', location: OUTSIDE })
      expect(dup.status).toBe(409)
      expect((dup.body as { error?: { code?: string } })?.error?.code).toBe('DUPLICATE_REQUEST')
      expect((await counts(u)).outdoorReqs).toHaveLength(2) // still just the two
    } finally {
      await cleanupUser(u)
    }
  })

  it('requireApproval with no usable outdoor_punch flow → 422, writes nothing (bogus id AND empty+none)', async () => {
    const u = `out-flow-${Date.now().toString(36)}`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      // bogus approvalFlowId
      await setOutdoor({ requireApproval: true, approvalFlowId: '00000000-0000-4000-8000-000000000000' })
      const r1 = await punch(t, { eventType: 'check_in', location: OUTSIDE })
      expect(r1.status).toBe(422)
      expect((r1.body as { error?: { code?: string } })?.error?.code).toBe('OUTDOOR_APPROVAL_FLOW_REQUIRED')
      // empty id + no active outdoor flow
      await deleteOutdoorFlows()
      await setOutdoor({ requireApproval: true, approvalFlowId: '' })
      const r2 = await punch(t, { eventType: 'check_in', location: OUTSIDE })
      expect(r2.status).toBe(422)
      expect((r2.body as { error?: { code?: string } })?.error?.code).toBe('OUTDOOR_APPROVAL_FLOW_REQUIRED')
      const c = await counts(u)
      expect(c.outdoorReqs).toHaveLength(0)
      expect(c.events).toHaveLength(0)
    } finally {
      await cleanupUser(u)
    }
  })

  it('requireNote with no note → 422, writes nothing', async () => {
    await createOutdoorFlow()
    await setOutdoor({ requireApproval: true, requireNote: true, approvalFlowId: '' })
    const u = `out-note-${Date.now().toString(36)}`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      const r = await punch(t, { eventType: 'check_in', location: OUTSIDE })
      expect(r.status).toBe(422)
      expect((r.body as { error?: { code?: string } })?.error?.code).toBe('OUTDOOR_NOTE_REQUIRED')
      const c = await counts(u)
      expect(c.outdoorReqs).toHaveLength(0)
      expect(c.events).toHaveLength(0)
      // with a note → accepted
      const r2 = await punch(t, { eventType: 'check_in', location: OUTSIDE, meta: { note: 'on site' } })
      expect(r2.status).toBe(202)
    } finally {
      await cleanupUser(u)
    }
  })

  it('settings wire: PUT→GET round-trip for punchPolicy.outdoor/merge; partial update preserves siblings', async () => {
    const flowId = await createOutdoorFlow()
    await putSettings({
      punchPolicy: {
        merge: { internalWinsOnIn: true, externalWinsOnOut: true },
        outdoor: { requireApproval: true, requireNote: true, approvalFlowId: flowId },
      },
    })
    const got = await getSettings()
    const pp = (got.body as { data?: { punchPolicy?: { outdoor?: Record<string, unknown>; merge?: Record<string, unknown> } } })?.data?.punchPolicy
    expect(pp?.outdoor).toMatchObject({ requireApproval: true, requireNote: true, approvalFlowId: flowId })
    expect(pp?.merge).toMatchObject({ internalWinsOnIn: true, externalWinsOnOut: true })
    // partial update of a sibling (unscheduled) must not clear outdoor
    await putSettings({ punchPolicy: { unscheduled: { mode: 'block' } } })
    const got2 = await getSettings()
    const pp2 = (got2.body as { data?: { punchPolicy?: { outdoor?: Record<string, unknown>; unscheduled?: { mode?: string }; merge?: Record<string, unknown> } } })?.data?.punchPolicy
    expect(pp2?.unscheduled?.mode).toBe('block')
    expect(pp2?.outdoor).toMatchObject({ requireApproval: true, requireNote: true, approvalFlowId: flowId }) // preserved
    expect(pp2?.merge).toMatchObject({ internalWinsOnIn: true, externalWinsOnOut: true }) // sibling preserved
    // restore unscheduled
    await putSettings({ punchPolicy: { unscheduled: { mode: 'allow' }, merge: { internalWinsOnIn: false, externalWinsOnOut: false } } })
  })

  it('P1: generic /requests API cannot create or update an outdoor_punch (must go through /punch)', async () => {
    const u = `out-api-${Date.now().toString(36)}`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      // direct create via the requests API → 422, nothing persisted (no policy-bypassing pending punch)
      const create = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers: authHeaders(t),
        body: JSON.stringify({ workDate: '2026-09-25', requestType: 'outdoor_punch', requestedInAt: '2026-09-25T09:00:00.000Z' }),
      })
      expect(create.status).toBe(422)
      expect((create.body as { error?: { code?: string } })?.error?.code).toBe('OUTDOOR_PUNCH_VIA_PUNCH_ONLY')
      const c1 = await counts(u)
      expect(c1.outdoorReqs).toHaveLength(0)
      expect(c1.events).toHaveLength(0)
      // create a normal request, then try to UPDATE its type to outdoor_punch → 422 (same chokepoint)
      const normal = await requestJson(`${baseUrl}/api/attendance/requests`, {
        method: 'POST', headers: authHeaders(t),
        body: JSON.stringify({ workDate: '2026-09-26', requestType: 'missed_check_in', requestedInAt: '2026-09-26T09:00:00.000Z' }),
      })
      expect(normal.status).toBe(201)
      const reqId = (normal.body as { data?: { request?: { id?: string } } })?.data?.request?.id as string
      const upd = await requestJson(`${baseUrl}/api/attendance/requests/${reqId}`, {
        method: 'PUT', headers: authHeaders(t),
        body: JSON.stringify({ requestType: 'outdoor_punch' }),
      })
      expect(upd.status).toBe(422)
      expect((upd.body as { error?: { code?: string } })?.error?.code).toBe('OUTDOOR_PUNCH_VIA_PUNCH_ONLY')
    } finally {
      await cleanupUser(u)
    }
  })

  it('P2: empty approvalFlowId requires a UNIQUE active outdoor flow; two active → 422, nothing written', async () => {
    await deleteOutdoorFlows()
    await addOutdoorFlow()
    await addOutdoorFlow() // two active outdoor_punch flows → ambiguous
    await setOutdoor({ requireApproval: true, approvalFlowId: '' })
    const u = `out-amb-${Date.now().toString(36)}`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      const r = await punch(t, { eventType: 'check_in', location: OUTSIDE })
      expect(r.status).toBe(422)
      expect((r.body as { error?: { code?: string } })?.error?.code).toBe('OUTDOOR_APPROVAL_FLOW_REQUIRED')
      expect((await counts(u)).outdoorReqs).toHaveLength(0)
    } finally {
      await cleanupUser(u)
      await deleteOutdoorFlows()
    }
  })

  it('S2-0: a client cannot forge the reserved source `outdoor_approval` on /punch', async () => {
    await setOutdoor({ requireApproval: false }, false) // no outdoor approval, no geofence → plain punch path
    const u = `out-resv-${Date.now().toString(36)}`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      // Forged reserved source → 422, nothing written (so it can never be mis-classified as approved outdoor).
      const forged = await punch(t, { eventType: 'check_in', source: 'outdoor_approval', location: INSIDE })
      expect(forged.status).toBe(422)
      expect((forged.body as { error?: { code?: string } })?.error?.code).toBe('PUNCH_SOURCE_RESERVED')
      expect((await counts(u)).events).toHaveLength(0)
      // A normal source still punches fine (no over-block) and lands with its own source — never outdoor_approval.
      const ok = await punch(t, { eventType: 'check_in', source: 'mobile', location: INSIDE })
      expect(ok.status).toBe(200)
      expect((await counts(u)).events.map((e) => e.source)).toEqual(['mobile'])
    } finally {
      await cleanupUser(u)
    }
  })

  it('S2-1: merge policy independently picks internal check-in and outdoor check-out without rewriting events', async () => {
    await createOutdoorFlow()
    await setMerge({ internalWinsOnIn: true, externalWinsOnOut: true })
    await setOutdoor({ requireApproval: true, requireNote: false, approvalFlowId: '' }, false)
    const u = `out-merge-${Date.now().toString(36)}`
    const workDate = '2026-06-05'
    const outdoorInAt = `${workDate}T08:50:00.000Z`
    const internalInAt = `${workDate}T09:05:00.000Z`
    const outdoorOutAt = `${workDate}T18:30:00.000Z`
    const internalOutAt = `${workDate}T19:00:00.000Z`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      const outdoorIn = await punch(t, { eventType: 'check_in', occurredAt: outdoorInAt, location: INSIDE, meta: { outdoor: true, note: 'client morning' } })
      const outdoorOut = await punch(t, { eventType: 'check_out', occurredAt: outdoorOutAt, location: INSIDE, meta: { outdoor: true, note: 'client evening' } })
      expect(outdoorIn.status).toBe(202)
      expect(outdoorOut.status).toBe(202)
      const internalIn = await punch(t, { eventType: 'check_in', occurredAt: internalInAt, source: 'mobile', location: INSIDE })
      const internalOut = await punch(t, { eventType: 'check_out', occurredAt: internalOutAt, source: 'mobile', location: INSIDE })
      expect(internalIn.status).toBe(200)
      expect(internalOut.status).toBe(200)

      const reqIn = (outdoorIn.body as { data?: { request?: { id?: string } } })?.data?.request?.id as string
      const reqOut = (outdoorOut.body as { data?: { request?: { id?: string } } })?.data?.request?.id as string
      expect((await approve(reqIn)).status).toBe(200)
      expect((await approve(reqOut)).status).toBe(200)

      const record = await recordFor(u, workDate)
      expect(iso(record.first_in_at)).toBe(internalInAt)
      expect(iso(record.last_out_at)).toBe(outdoorOutAt)
      expect((await eventRows(u, workDate)).map((row) => `${row.event_type}:${row.source}:${iso(row.occurred_at)}`)).toEqual([
        `check_in:outdoor_approval:${outdoorInAt}`,
        `check_in:mobile:${internalInAt}`,
        `check_out:outdoor_approval:${outdoorOutAt}`,
        `check_out:mobile:${internalOutAt}`,
      ])
    } finally {
      await setMerge({ internalWinsOnIn: false, externalWinsOnOut: false }).catch(() => undefined)
      await cleanupUser(u)
    }
  })

  it('S2-1: protected record-only first-in survives later mixed internal/outdoor punch recompute', async () => {
    await setMerge({ internalWinsOnIn: true, externalWinsOnOut: false })
    await setOutdoor({ requireApproval: false }, false)
    const u = `out-protect-${Date.now().toString(36)}`
    const workDate = '2026-06-04'
    const protectedFirst = `${workDate}T10:00:00.000Z`
    const outdoorInAt = `${workDate}T08:50:00.000Z`
    const internalInAt = `${workDate}T09:05:00.000Z`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      await pool.query(
        `INSERT INTO attendance_records
         (id, user_id, org_id, work_date, timezone, first_in_at, last_out_at, work_minutes, late_minutes, early_leave_minutes, status, is_workday, meta, source_batch_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'UTC', $5, NULL, 0, 0, 0, 'adjusted', true, $6::jsonb, NULL, now(), now())`,
        [randomUUID(), u, ORG, workDate, protectedFirst, JSON.stringify({ source: 'override-protected' })]
      )
      await pool.query(
        `INSERT INTO attendance_events
         (id, user_id, org_id, work_date, occurred_at, event_type, source, timezone, location, meta)
         VALUES ($1, $2, $3, $4, $5, 'check_in', 'outdoor_approval', 'UTC', '{}'::jsonb, '{}'::jsonb)`,
        [randomUUID(), u, ORG, workDate, outdoorInAt]
      )

      const internal = await punch(t, { eventType: 'check_in', occurredAt: internalInAt, source: 'mobile', location: INSIDE })
      expect(internal.status).toBe(200)
      const record = await recordFor(u, workDate)
      // S2-1 preserves the record-only timestamp candidate; status/provenance still
      // follow the normal record upsert semantics and are not asserted here.
      expect(iso(record.first_in_at)).toBe(protectedFirst)
      expect((await eventRows(u, workDate)).map((row) => `${row.event_type}:${row.source}:${iso(row.occurred_at)}`)).toEqual([
        `check_in:outdoor_approval:${outdoorInAt}`,
        `check_in:mobile:${internalInAt}`,
      ])
    } finally {
      await setMerge({ internalWinsOnIn: false, externalWinsOnOut: false }).catch(() => undefined)
      await cleanupUser(u)
    }
  })

  it('S2-1: keys-off keeps existing append behavior for a record-only first-in', async () => {
    await setMerge({ internalWinsOnIn: false, externalWinsOnOut: false })
    await setOutdoor({ requireApproval: false }, false)
    const u = `off-protect-${Date.now().toString(36)}`
    const workDate = '2026-06-03'
    const recordOnlyFirst = `${workDate}T10:00:00.000Z`
    const internalInAt = `${workDate}T09:05:00.000Z`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      await seedRecordOnlyFirstIn(u, workDate, recordOnlyFirst, { status: 'normal', source: 'import-batch' })
      const internal = await punch(t, { eventType: 'check_in', occurredAt: internalInAt, source: 'mobile', location: INSIDE })
      expect(internal.status).toBe(200)
      const record = await recordFor(u, workDate)
      expect(iso(record.first_in_at)).toBe(internalInAt)
    } finally {
      await cleanupUser(u)
    }
  })

  it('S2-1: keys-off keeps existing append behavior for a record-only last-out', async () => {
    await setMerge({ internalWinsOnIn: false, externalWinsOnOut: false })
    await setOutdoor({ requireApproval: false }, false)
    const u = `off-out-protect-${Date.now().toString(36)}`
    const workDate = '2026-06-03'
    const recordOnlyLast = `${workDate}T17:00:00.000Z`
    const internalOutAt = `${workDate}T19:00:00.000Z`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      await seedRecordOnlyLastOut(u, workDate, recordOnlyLast, { status: 'normal', source: 'import-batch' })
      const internal = await punch(t, { eventType: 'check_out', occurredAt: internalOutAt, source: 'mobile', location: INSIDE })
      expect(internal.status).toBe(200)
      const record = await recordFor(u, workDate)
      expect(iso(record.last_out_at)).toBe(internalOutAt)
    } finally {
      await cleanupUser(u)
    }
  })

  it('S2-1: import record-only first-in survives a later ordinary punch when internal merge is enabled', async () => {
    await setMerge({ internalWinsOnIn: true, externalWinsOnOut: false })
    await setOutdoor({ requireApproval: false }, false)
    const u = `imp-protect-${Date.now().toString(36)}`
    const workDate = '2026-06-03'
    const importedFirst = `${workDate}T10:00:00.000Z`
    const internalInAt = `${workDate}T09:05:00.000Z`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      await seedRecordOnlyFirstIn(u, workDate, importedFirst, { status: 'normal', source: 'import-batch' })
      const internal = await punch(t, { eventType: 'check_in', occurredAt: internalInAt, source: 'mobile', location: INSIDE })
      expect(internal.status).toBe(200)
      const record = await recordFor(u, workDate)
      expect(iso(record.first_in_at)).toBe(importedFirst)
      expect((await eventRows(u, workDate)).map((row) => `${row.event_type}:${row.source}:${iso(row.occurred_at)}`)).toEqual([
        `check_in:mobile:${internalInAt}`,
      ])
    } finally {
      await setMerge({ internalWinsOnIn: false, externalWinsOnOut: false }).catch(() => undefined)
      await cleanupUser(u)
    }
  })

  it('S2-1: override record-only first-in survives a later ordinary punch when internal merge is enabled', async () => {
    await setMerge({ internalWinsOnIn: true, externalWinsOnOut: false })
    await setOutdoor({ requireApproval: false }, false)
    const u = `ovr-protect-${Date.now().toString(36)}`
    const workDate = '2026-06-02'
    const correctedFirst = `${workDate}T10:00:00.000Z`
    const internalInAt = `${workDate}T09:05:00.000Z`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      await seedRecordOnlyFirstIn(u, workDate, correctedFirst, { status: 'adjusted', source: 'missed-override' })
      const internal = await punch(t, { eventType: 'check_in', occurredAt: internalInAt, source: 'mobile', location: INSIDE })
      expect(internal.status).toBe(200)
      const record = await recordFor(u, workDate)
      expect(iso(record.first_in_at)).toBe(correctedFirst)
      expect((await eventRows(u, workDate)).map((row) => `${row.event_type}:${row.source}:${iso(row.occurred_at)}`)).toEqual([
        `check_in:mobile:${internalInAt}`,
      ])
    } finally {
      await setMerge({ internalWinsOnIn: false, externalWinsOnOut: false }).catch(() => undefined)
      await cleanupUser(u)
    }
  })

  it('S2-1: import record-only last-out survives a later ordinary punch when external merge is enabled', async () => {
    await setMerge({ internalWinsOnIn: false, externalWinsOnOut: true })
    await setOutdoor({ requireApproval: false }, false)
    const u = `imp-out-protect-${Date.now().toString(36)}`
    const workDate = '2026-06-03'
    const importedLast = `${workDate}T17:00:00.000Z`
    const internalOutAt = `${workDate}T19:00:00.000Z`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      await seedRecordOnlyLastOut(u, workDate, importedLast, { status: 'normal', source: 'import-batch' })
      const internal = await punch(t, { eventType: 'check_out', occurredAt: internalOutAt, source: 'mobile', location: INSIDE })
      expect(internal.status).toBe(200)
      const record = await recordFor(u, workDate)
      expect(iso(record.last_out_at)).toBe(importedLast)
      expect((await eventRows(u, workDate)).map((row) => `${row.event_type}:${row.source}:${iso(row.occurred_at)}`)).toEqual([
        `check_out:mobile:${internalOutAt}`,
      ])
    } finally {
      await setMerge({ internalWinsOnIn: false, externalWinsOnOut: false }).catch(() => undefined)
      await cleanupUser(u)
    }
  })

  it('S2-1: override record-only last-out survives a later ordinary punch when external merge is enabled', async () => {
    await setMerge({ internalWinsOnIn: false, externalWinsOnOut: true })
    await setOutdoor({ requireApproval: false }, false)
    const u = `ovr-out-protect-${Date.now().toString(36)}`
    const workDate = '2026-06-02'
    const correctedLast = `${workDate}T17:00:00.000Z`
    const internalOutAt = `${workDate}T19:00:00.000Z`
    const t = await mintToken(u, 'attendance:read,attendance:write')
    try {
      await seedRecordOnlyLastOut(u, workDate, correctedLast, { status: 'adjusted', source: 'missed-override' })
      const internal = await punch(t, { eventType: 'check_out', occurredAt: internalOutAt, source: 'mobile', location: INSIDE })
      expect(internal.status).toBe(200)
      const record = await recordFor(u, workDate)
      expect(iso(record.last_out_at)).toBe(correctedLast)
      expect((await eventRows(u, workDate)).map((row) => `${row.event_type}:${row.source}:${iso(row.occurred_at)}`)).toEqual([
        `check_out:mobile:${internalOutAt}`,
      ])
    } finally {
      await setMerge({ internalWinsOnIn: false, externalWinsOnOut: false }).catch(() => undefined)
      await cleanupUser(u)
    }
  })
})
