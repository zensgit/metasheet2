/**
 * B1-a1 button/run route — mock-pool unit tests (no live DB). Mirrors the
 * AI-shortcut-run route test harness. Focus: the security-critical gates
 * (visibility != executability) + the inert-only restriction + fail semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import { checkWebhookTargetUrl } from '../../src/multitable/webhook-ssrf-guard'
import { pinnedHttpsFetch } from '../../src/multitable/webhook-pinned-fetch'

// Egress + SSRF are mocked at their module boundary so the dispatch's gate / dedup / audit /
// scrub logic is exercised without real DNS or sockets. importOriginal-spread preserves the
// modules' other exports (isInternalAddress, etc.) for the rest of the dep graph.
vi.mock('../../src/multitable/webhook-ssrf-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/webhook-ssrf-guard')>()),
  checkWebhookTargetUrl: vi.fn(),
}))
vi.mock('../../src/multitable/webhook-pinned-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/multitable/webhook-pinned-fetch')>()),
  pinnedHttpsFetch: vi.fn(),
}))

const SHEET_ID = 'sheet_btn'
const RECORD_ID = 'rec_btn'

const FIELDS = [
  { id: 'fld_btn', name: 'Run', type: 'button', property: { actionType: 'record_click', label: 'Go', actionConfig: {} }, order: 1 },
  { id: 'fld_btn_webhook', name: 'Hook', type: 'button', property: { actionType: 'send_webhook', actionConfig: {} }, order: 2 },
  { id: 'fld_btn_unconf', name: 'Unconf', type: 'button', property: {}, order: 3 },
  { id: 'fld_text', name: 'Text', type: 'string', property: {}, order: 4 },
  // B1-S1 D0-A: send_notification buttons. `u_member` / `u_editor` are members; `u_outsider` is NOT.
  // All-members recipient set (delivers).
  { id: 'fld_btn_notify', name: 'Notify', type: 'button', property: { actionType: 'send_notification', actionConfig: { userIds: ['u_member'], message: 'Hello team' } }, order: 5 },
  // Mixed set with a non-member → §3.1 HARD-REJECT (write nothing).
  { id: 'fld_btn_notify_bad', name: 'NotifyBad', type: 'button', property: { actionType: 'send_notification', actionConfig: { userIds: ['u_member', 'u_outsider'], message: 'Hello team' } }, order: 6 },
  // confirm.enabled send_notification (server-confirm gate).
  { id: 'fld_btn_notify_confirm', name: 'NotifyConfirm', type: 'button', property: { actionType: 'send_notification', confirm: { enabled: true, message: 'Send it?' }, actionConfig: { userIds: ['u_member'], message: 'Hello team' } }, order: 7 },
  // B1-S2 send_webhook fixtures. fld_wh_ok = bare target; fld_wh_secret = HMAC + a hostile header set
  // (caller tries to inject auth / a custom header / a forged signature — all must be dropped/overridden).
  { id: 'fld_wh_ok', name: 'WH', type: 'button', property: { actionType: 'send_webhook', actionConfig: { url: 'https://hooks.example.com/x', body: { a: 1 } } }, order: 8 },
  { id: 'fld_wh_secret', name: 'WHsec', type: 'button', property: { actionType: 'send_webhook', actionConfig: { url: 'https://hooks.example.com/x', secret: 's3cr3t', headers: { 'Content-Type': 'application/xml', Accept: 'text/plain', 'X-Custom': 'nope', Authorization: 'Bearer leak', 'X-Webhook-Signature': 'forged' }, body: { a: 1 } } }, order: 9 },
]

let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
let noRecord = false
let auditInserts = 0

function createMockPool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: any[]; rowCount?: number }> => {
    if (/INSERT INTO multitable_automation_executions/i.test(sql)) {
      auditInserts += 1
      return { rows: [], rowCount: 1 }
    }
    if (/FROM meta_records WHERE id/i.test(sql)) {
      return noRecord ? { rows: [] } : { rows: [{ id: RECORD_ID, sheet_id: SHEET_ID }] }
    }
    if (/FROM meta_fields WHERE sheet_id/i.test(sql)) {
      return { rows: FIELDS.map((f) => ({ ...f })) }
    }
    if (/FROM meta_sheets WHERE id/i.test(sql)) {
      return { rows: [{ id: SHEET_ID }] }
    }
    // permission scope tables (sheet/record/field) → empty: role perms govern.
    return { rows: [], rowCount: 0 }
  })
  return { query, transaction: vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query })) }
}

let app: Express

async function buildApp() {
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { createMultitableButtonRoutes } = await import('../../src/routes/multitable-button')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool() as any)
  const built = express()
  built.use(express.json())
  built.use((req, _res, next) => { if (currentUser) (req as any).user = currentUser; next() })
  built.use('/api/multitable', createMultitableButtonRoutes())
  return built
}

const runUrl = (fieldId: string) => `/api/multitable/sheets/${SHEET_ID}/records/${RECORD_ID}/fields/${fieldId}/button/run`
const reader = { id: 'u_read', roles: ['member'], perms: ['multitable:read'] }
// A genuine authenticated non-reader: non-empty perms (so resolveRequestAccess
// reads them directly, no DB lookup) that do NOT include multitable read/write.
const nonReader = { id: 'u_none', roles: ['member'], perms: ['multitable:comment'] }

describe('B1-a1 button/run route (mock pool)', () => {
  beforeEach(async () => { currentUser = reader; noRecord = false; auditInserts = 0; app = await buildApp() })
  afterEach(() => { vi.restoreAllMocks(); currentUser = undefined; noRecord = false })

  it('runs an inert record_click button → 200 succeeded', async () => {
    const res = await request(app).post(runUrl('fld_btn')).send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.status).toBe('succeeded')
    expect(res.body.data.executionId).toMatch(/^axe_btn_/)
    // record_click is INERT: logger-only, NO durable automation-execution row
    // (design-lock §7/§9, AUDIT-1). Durable rows are exclusive to side-effecting actions.
    expect(auditInserts).toBe(0)
  })

  it('SECURITY: a non-reader cannot execute (403) — visibility != executability', async () => {
    currentUser = nonReader
    app = await buildApp()
    const res = await request(app).post(runUrl('fld_btn')).send({})
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('record not on the sheet → 404', async () => {
    noRecord = true
    app = await buildApp()
    const res = await request(app).post(runUrl('fld_btn')).send({})
    expect(res.status).toBe(404)
  })

  it('non-button field → 400 NOT_A_BUTTON', async () => {
    const res = await request(app).post(runUrl('fld_text')).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('NOT_A_BUTTON')
  })

  it('button with no actionType → 400 BUTTON_NOT_CONFIGURED', async () => {
    const res = await request(app).post(runUrl('fld_btn_unconf')).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BUTTON_NOT_CONFIGURED')
  })

  it('send_webhook is now enabled but EGRESS-gated: a reader (no admin / no multitable:send_webhook) → 403', async () => {
    const res = await request(app).post(runUrl('fld_btn_webhook')).send({ requestId: 'req_wh_1' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('unknown field → 404', async () => {
    const res = await request(app).post(runUrl('fld_missing')).send({})
    expect(res.status).toBe(404)
  })

  it('record_click stays inert: requestId is OPTIONAL (no requestId → 200)', async () => {
    const res = await request(app).post(runUrl('fld_btn')).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')
  })
})

// ── B1-S1 D0-A: send_notification (first side-effecting button action) ──────────
// Stateful mock with REAL transaction semantics: the `transaction` wrapper snapshots
// the in-memory side-effect state and ROLLS IT BACK if the handler throws — so the
// hard-audit fail-closed assertion ("nothing written") is meaningful, not fake-green.
// (The real-DB suite is the keystone for true rollback; this unit mirror prevents
// the route's tx wiring from silently regressing.)
const editor = { id: 'u_editor', roles: ['member'], perms: ['multitable:write'] }
const MEMBER_IDS = new Set(['u_member', 'u_editor'])

interface NotifyState {
  dedupKeys: Set<string>
  dedupExec: Map<string, string>
  notificationInserts: any[]
  auditInserts: any[]
}

function createNotifyMockPool(state: NotifyState) {
  const query = vi.fn(async (sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number }> => {
    if (/FROM meta_records WHERE id/i.test(sql)) {
      return { rows: [{ id: RECORD_ID, sheet_id: SHEET_ID }] }
    }
    if (/FROM meta_fields WHERE sheet_id/i.test(sql)) {
      return { rows: FIELDS.map((f) => ({ ...f })) }
    }
    if (/FROM meta_sheets WHERE id/i.test(sql)) {
      return { rows: [{ id: SHEET_ID }] }
    }
    // Dedup marker insert (§6 at-most-once). UNIQUE(dedup_key): a repeat key inserts 0 rows.
    if (/INSERT INTO multitable_button_run_dedup/i.test(sql)) {
      const dedupKey = String(params?.[1] ?? '')
      if (state.dedupKeys.has(dedupKey)) return { rows: [], rowCount: 0 }
      state.dedupKeys.add(dedupKey)
      state.dedupExec.set(dedupKey, String(params?.[7] ?? '')) // $8 = execution_id
      return { rows: [], rowCount: 1 }
    }
    // Replay path resolves the ORIGINAL committed execution id from the dedup row.
    if (/SELECT execution_id FROM multitable_button_run_dedup/i.test(sql)) {
      const dedupKey = String(params?.[0] ?? '')
      const ex = state.dedupExec.get(dedupKey)
      return { rows: ex ? [{ execution_id: ex }] : [] }
    }
    // Member-set resolver (loadSheetMemberUserIdSet → listSheetPermissionCandidates).
    if (/user_candidates/i.test(sql)) {
      return {
        rows: Array.from(MEMBER_IDS).map((id) => ({
          subject_type: 'user', subject_id: id, user_name: id, user_email: `${id}@x`, user_is_active: true,
          role_name: null, group_name: null, group_description: null, member_count: null, permission_codes: [],
        })),
      }
    }
    // Candidate eligibility (loadCandidateUserEligibilityMap): grant members multitable:read.
    if (/FROM user_permissions/i.test(sql)) {
      return { rows: Array.from(MEMBER_IDS).map((id) => ({ user_id: id, permission_code: 'multitable:read' })) }
    }
    // Durable notification write (the §3.1 effect).
    if (/INSERT INTO meta_record_subscription_notifications/i.test(sql)) {
      const payload = JSON.parse(String(params?.[0] ?? '[]'))
      state.notificationInserts.push(...payload)
      return { rows: [], rowCount: payload.length }
    }
    // Audit row (HARD, in-transaction) — recordWithQuery emits this raw INSERT.
    // Capture the steps jsonb ($6) too: the row's content must be the REAL redacted
    // step, not an empty {} (a RawBuilder-stringify bug would persist empty content).
    if (/INSERT INTO multitable_automation_executions/i.test(sql)) {
      state.auditInserts.push({
        id: params?.[0],
        triggered_by: params?.[2],
        status: params?.[4],
        steps: params?.[5],
      })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  // Transaction wrapper with rollback: snapshot mutable state, restore on throw.
  const transaction = vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => {
    const snapDedup = new Set(state.dedupKeys)
    const snapExec = new Map(state.dedupExec)
    const snapNotif = state.notificationInserts.length
    const snapAudit = state.auditInserts.length
    try {
      return await fn({ query })
    } catch (e) {
      state.dedupKeys = snapDedup
      state.dedupExec = snapExec
      state.notificationInserts.length = snapNotif
      state.auditInserts.length = snapAudit
      throw e
    }
  })
  return { query, transaction }
}

describe('B1-S1 D0-A send_notification button (mock pool)', () => {
  let state: NotifyState
  let recordWithQuerySpy: ReturnType<typeof vi.spyOn>
  let notifyApp: Express
  let createRoutes: () => import('express').Router

  async function buildNotifyApp(asUser: typeof editor) {
    const built = express()
    built.use(express.json())
    built.use((req, _res, next) => { (req as any).user = asUser; next() })
    built.use('/api/multitable', createRoutes())
    return built
  }

  beforeEach(async () => {
    state = { dedupKeys: new Set(), dedupExec: new Map(), notificationInserts: [], auditInserts: [] }
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const { createMultitableButtonRoutes } = await import('../../src/routes/multitable-button')
    createRoutes = createMultitableButtonRoutes
    // recordWithQuery is the in-transaction audit writer — let it run the real raw
    // INSERT against the mock query (so the §2 hard-audit wiring is exercised end to
    // end); individual tests re-mock it to simulate an audit failure.
    vi.spyOn(poolManager, 'get').mockReturnValue(createNotifyMockPool(state) as any)
    notifyApp = await buildNotifyApp(editor)
  })
  afterEach(() => { vi.restoreAllMocks() })

  const url = `/api/multitable/sheets/${SHEET_ID}/records/${RECORD_ID}/fields/fld_btn_notify/button/run`
  const badUrl = `/api/multitable/sheets/${SHEET_ID}/records/${RECORD_ID}/fields/fld_btn_notify_bad/button/run`
  const confirmUrl = `/api/multitable/sheets/${SHEET_ID}/records/${RECORD_ID}/fields/fld_btn_notify_confirm/button/run`

  it('side-effecting action REQUIRES a requestId → 400 without one (no write)', async () => {
    const res = await request(notifyApp).post(url).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('REQUEST_ID_REQUIRED')
    expect(state.notificationInserts).toHaveLength(0)
    expect(state.auditInserts).toHaveLength(0)
    expect(state.dedupKeys.size).toBe(0)
  })

  it('§3 actor gate: a read-only user lacks canSendNotification → 403, NOTHING written', async () => {
    notifyApp = await buildNotifyApp(reader)
    const res = await request(notifyApp).post(url).send({ requestId: 'req-1' })
    expect(res.status).toBe(403)
    expect(state.notificationInserts).toHaveLength(0)
    expect(state.dedupKeys.size).toBe(0)
  })

  it('§3 actor gate: a WRITE-OWN user CANNOT send_notification → 403 (notify = full sheet write/admin, NOT record-scoped write-own)', async () => {
    // canSendNotification derives from full multitable:write/admin only; write-own is
    // record-scoped and must NOT imply notifying members from any row.
    notifyApp = await buildNotifyApp({ id: 'u_writeown', roles: ['member'], perms: ['multitable:write-own'] })
    const res = await request(notifyApp).post(url).send({ requestId: 'req-wo' })
    expect(res.status).toBe(403)
    expect(state.notificationInserts).toHaveLength(0)
    expect(state.dedupKeys.size).toBe(0)
  })

  it('§4 server-confirm: confirm.enabled + confirmed omitted → 400 CONFIRMATION_REQUIRED, NOTHING written, requestId NOT consumed', async () => {
    const res = await request(notifyApp).post(confirmUrl).send({ requestId: 'req-confirm' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED')
    expect(state.notificationInserts).toHaveLength(0)
    expect(state.auditInserts).toHaveLength(0)
    expect(state.dedupKeys.size).toBe(0)

    // The SAME requestId later WITH confirmed:true still sends once (not consumed).
    const retry = await request(notifyApp).post(confirmUrl).send({ requestId: 'req-confirm', confirmed: true })
    expect(retry.status).toBe(200)
    expect(retry.body.data.status).toBe('succeeded')
    expect(retry.body.data.deduplicated).toBeUndefined()
    expect(state.notificationInserts.filter((r) => r.user_id === 'u_member')).toHaveLength(1)
  })

  it('§4 server-confirm: confirmed:false is treated as not-confirmed → 400', async () => {
    const res = await request(notifyApp).post(confirmUrl).send({ requestId: 'req-confirm-f', confirmed: false })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('CONFIRMATION_REQUIRED')
    expect(state.notificationInserts).toHaveLength(0)
  })

  it('§3.1 recipient HARD-REJECT: ANY non-member rejects the whole run → 400, NOTHING written', async () => {
    const res = await request(notifyApp).post(badUrl).send({ requestId: 'req-bad' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(state.notificationInserts).toHaveLength(0)
    expect(state.auditInserts).toHaveLength(0)
    expect(state.dedupKeys.size).toBe(0)
  })

  it('all-members recipient set delivers a notification.sent row with the message + writes an audit row', async () => {
    const res = await request(notifyApp).post(url).send({ requestId: 'req-ok' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')
    expect(state.notificationInserts.map((r) => r.user_id)).toEqual(['u_member'])
    expect(state.notificationInserts[0]).toEqual(expect.objectContaining({ event_type: 'notification.sent', message: 'Hello team' }))
    // §2 audit row written in the SAME transaction, triggered_by='button'.
    expect(state.auditInserts).toHaveLength(1)
    expect(state.auditInserts[0]).toEqual(expect.objectContaining({ triggered_by: 'button', status: 'success' }))
    // The steps jsonb persists the REAL redacted step content (NOT an empty {} — a
    // RawBuilder-stringify bug would silently store empty content and defeat §2).
    const steps = JSON.parse(String(state.auditInserts[0].steps))
    expect(steps).toEqual([
      expect.objectContaining({ actionType: 'send_notification', status: 'success', output: { notifiedUsers: 1 } }),
    ])
  })

  it('§6 at-most-once: a duplicate requestId writes the notification ONCE + no second audit', async () => {
    const first = await request(notifyApp).post(url).send({ requestId: 'req-dup' })
    expect(first.status).toBe(200)
    const replay = await request(notifyApp).post(url).send({ requestId: 'req-dup' })
    expect(replay.status).toBe(200)
    expect(replay.body.data.deduplicated).toBe(true)
    expect(state.notificationInserts.filter((r) => r.user_id === 'u_member')).toHaveLength(1)
    expect(state.auditInserts).toHaveLength(1)
    // Replay returns the ORIGINAL committed executionId (maps to the real audit row),
    // not a fresh untraceable one (review Low #3).
    expect(replay.body.data.executionId).toBe(first.body.data.executionId)
  })

  it('§2 HARD AUDIT: an audit insert failure ROLLS BACK the notification → fail-closed, NOTHING committed', async () => {
    const logServiceModule = await import('../../src/multitable/automation-log-service')
    // Simulate the audit insert failing (recordWithQuery throws). Because audit runs in
    // the SAME transaction as the notification write, the whole run must roll back.
    recordWithQuerySpy = vi
      .spyOn(logServiceModule.AutomationLogService.prototype, 'recordWithQuery')
      .mockRejectedValue(new Error('audit boom'))

    const res = await request(notifyApp).post(url).send({ requestId: 'req-failclosed' })
    // Fail-closed: the run does NOT report success.
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
    // Notification + dedup rolled back (mock transaction restores the snapshot).
    expect(state.notificationInserts).toHaveLength(0)
    expect(state.dedupKeys.size).toBe(0)
    expect(recordWithQuerySpy).toHaveBeenCalledTimes(1)
  })
})

// ── B1-S2 send_webhook (external egress) ────────────────────────────────────────
// The mock pool MODELS the dedup `outcome` column (store on INSERT, return on SELECT,
// guarded UPDATE) so the P1 "false-success" tests exercise the real fix — a fixture that
// only tracked existence would pass against the OLD unconditional-succeeded replay too.
interface WebhookState {
  dedupRows: Map<string, { execution_id: string; outcome: string | null; http_status: number | null; result_message: string | null }>
  auditInserts: Array<{ id: any; triggered_by: any; status: any; steps: any }>
}

function createWebhookMockPool(state: WebhookState) {
  const query = vi.fn(async (sql: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number }> => {
    if (/FROM meta_records WHERE id/i.test(sql)) return { rows: [{ id: RECORD_ID, sheet_id: SHEET_ID }] }
    if (/FROM meta_fields WHERE sheet_id/i.test(sql)) return { rows: FIELDS.map((f) => ({ ...f })) }
    if (/FROM meta_sheets WHERE id/i.test(sql)) return { rows: [{ id: SHEET_ID }] }
    // Claim with outcome='pending'. UNIQUE(dedup_key): a repeat key inserts 0 rows.
    if (/INSERT INTO multitable_button_run_dedup/i.test(sql)) {
      const dedupKey = String(params?.[1] ?? '')
      if (state.dedupRows.has(dedupKey)) return { rows: [], rowCount: 0 }
      state.dedupRows.set(dedupKey, { execution_id: String(params?.[7] ?? ''), outcome: 'pending', http_status: null, result_message: null })
      return { rows: [], rowCount: 1 }
    }
    // Replay resolves the STORED outcome (not mere existence) — the crux of the P1 fix.
    if (/SELECT execution_id, outcome, http_status, result_message/i.test(sql)) {
      const row = state.dedupRows.get(String(params?.[0] ?? ''))
      return { rows: row ? [{ execution_id: row.execution_id, outcome: row.outcome, http_status: row.http_status, result_message: row.result_message }] : [] }
    }
    // Guarded finalize: dedup_key + execution_id + outcome='pending'. Anything else → 0 rows (fail-closed).
    if (/UPDATE multitable_button_run_dedup/i.test(sql)) {
      const row = state.dedupRows.get(String(params?.[3] ?? ''))
      if (row && row.execution_id === String(params?.[4] ?? '') && row.outcome === 'pending') {
        row.outcome = String(params?.[0] ?? '')
        row.http_status = params?.[1] ?? null
        row.result_message = params?.[2] ?? null
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    if (/INSERT INTO multitable_automation_executions/i.test(sql)) {
      state.auditInserts.push({ id: params?.[0], triggered_by: params?.[2], status: params?.[4], steps: params?.[5] })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  // Transaction with rollback — snapshot deep-copies rows so a thrown Tx B restores outcome='pending'.
  const transaction = vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => {
    const snap = new Map(Array.from(state.dedupRows, ([k, v]) => [k, { ...v }]))
    const snapAudit = state.auditInserts.length
    try {
      return await fn({ query })
    } catch (e) {
      state.dedupRows = snap
      state.auditInserts.length = snapAudit
      throw e
    }
  })
  return { query, transaction }
}

describe('B1-S2 send_webhook button (mock pool)', () => {
  const whAdmin = { id: 'u_admin', roles: ['admin'], perms: [] }
  // canRead needs multitable:read; the dedicated egress grant is multitable:send_webhook.
  const whGrant = { id: 'u_hook', roles: ['member'], perms: ['multitable:read', 'multitable:send_webhook'] }
  // multitable:* passes canRead AND the OLD wildcard gate — but must FAIL the new EXACT egress gate.
  const whWildcard = { id: 'u_wild', roles: ['member'], perms: ['multitable:*'] }

  let state: WebhookState
  let mockSsrf: ReturnType<typeof vi.mocked<typeof checkWebhookTargetUrl>>
  let mockFetch: ReturnType<typeof vi.mocked<typeof pinnedHttpsFetch>>

  async function buildWebhookApp(asUser: { id: string; roles: string[]; perms: string[] }) {
    const built = express()
    built.use(express.json())
    built.use((req, _res, next) => { (req as any).user = asUser; next() })
    built.use('/api/multitable', (await import('../../src/routes/multitable-button')).createMultitableButtonRoutes())
    return built
  }

  beforeEach(async () => {
    state = { dedupRows: new Map(), auditInserts: [] }
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    vi.spyOn(poolManager, 'get').mockReturnValue(createWebhookMockPool(state) as any)
    mockSsrf = vi.mocked(checkWebhookTargetUrl)
    mockFetch = vi.mocked(pinnedHttpsFetch)
    // Default: a validated, non-SSRF target that returns 200.
    mockSsrf.mockResolvedValue({ ok: true, protocol: 'https:', hostname: 'hooks.example.com', addresses: ['93.184.216.34'] } as any)
    mockFetch.mockResolvedValue({ status: 200, ok: true })
  })
  afterEach(() => { vi.restoreAllMocks() })

  const wh = (fieldId: string) => `/api/multitable/sheets/${SHEET_ID}/records/${RECORD_ID}/fields/${fieldId}/button/run`

  it('admin success: reached 2xx → 200 succeeded, dedup outcome=succeeded, audit row written', async () => {
    const app = await buildWebhookApp(whAdmin)
    const res = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-ok' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect([...state.dedupRows.values()][0].outcome).toBe('succeeded')
    expect(state.auditInserts).toHaveLength(1)
    expect(state.auditInserts[0].status).toBe('success')
  })

  it('exact-grant (multitable:read + multitable:send_webhook) user → 200 succeeded', async () => {
    const app = await buildWebhookApp(whGrant)
    const res = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-grant' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')
  })

  it('SECURITY [P2-2]: a wildcard multitable:* grant does NOT confer egress → 403 (exact grant required)', async () => {
    const app = await buildWebhookApp(whWildcard)
    const res = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-wild' })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(state.dedupRows.size).toBe(0)
  })

  it('non-2xx reached → 200 failed (surfaced, no body leak), dedup outcome=failed', async () => {
    mockFetch.mockResolvedValue({ status: 502, ok: false })
    const app = await buildWebhookApp(whAdmin)
    const res = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-502' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('failed')
    expect([...state.dedupRows.values()][0].outcome).toBe('failed')
    expect(state.auditInserts[0].status).toBe('failed')
  })

  it('transport error → 200 failed, dedup outcome=failed', async () => {
    mockFetch.mockRejectedValue(new Error('socket hang up'))
    const app = await buildWebhookApp(whAdmin)
    const res = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-transport' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('failed')
    expect([...state.dedupRows.values()][0].outcome).toBe('failed')
  })

  it('SSRF reject → 400 pre-txn, NOTHING sent, NO dedup row, NO audit', async () => {
    mockSsrf.mockResolvedValue({ ok: false, reason: 'blocked internal address 169.254.169.254' } as any)
    const app = await buildWebhookApp(whAdmin)
    const res = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-ssrf' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('WEBHOOK_TARGET_REJECTED')
    expect(mockFetch).not.toHaveBeenCalled()
    expect(state.dedupRows.size).toBe(0)
    expect(state.auditInserts).toHaveLength(0)
  })

  it('[P1-2] replay of a SUCCESS → succeeded+deduplicated, NO second egress', async () => {
    const app = await buildWebhookApp(whAdmin)
    const first = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-dup' })
    expect(first.body.data.status).toBe('succeeded')
    const replay = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-dup' })
    expect(replay.status).toBe(200)
    expect(replay.body.data.status).toBe('succeeded')
    expect(replay.body.data.deduplicated).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1) // at-most-once: no re-send
  })

  it('[P1-2] replay of a FAILURE → failed+deduplicated (NOT a false success), NO second egress', async () => {
    mockFetch.mockResolvedValue({ status: 500, ok: false })
    const app = await buildWebhookApp(whAdmin)
    const first = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-dupfail' })
    expect(first.body.data.status).toBe('failed')
    const replay = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-dupfail' })
    expect(replay.status).toBe(200)
    expect(replay.body.data.status).toBe('failed') // the OLD code returned 'succeeded' here
    expect(replay.body.data.deduplicated).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('[P1-3] audit/outcome write fails → NOT a false success; dedup stays pending; replay non-success', async () => {
    const logServiceModule = await import('../../src/multitable/automation-log-service')
    vi.spyOn(logServiceModule.AutomationLogService.prototype, 'recordWithQuery').mockRejectedValue(new Error('audit boom'))
    const app = await buildWebhookApp(whAdmin)
    const res = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-auditfail' })
    // Egress happened once, but the durable record failed → response is NON-success.
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('failed')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    // Tx B rolled back → outcome stays 'pending' (terminal; a replay must also be non-success + no re-send).
    expect([...state.dedupRows.values()][0].outcome).toBe('pending')
    vi.restoreAllMocks()
    // re-spy poolManager for the replay (restoreAllMocks cleared it)
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    vi.spyOn(poolManager, 'get').mockReturnValue(createWebhookMockPool(state) as any)
    mockFetch = vi.mocked(pinnedHttpsFetch)
    mockSsrf = vi.mocked(checkWebhookTargetUrl)
    mockSsrf.mockResolvedValue({ ok: true, protocol: 'https:', hostname: 'hooks.example.com', addresses: ['93.184.216.34'] } as any)
    mockFetch.mockResolvedValue({ status: 200, ok: true })
    const app2 = await buildWebhookApp(whAdmin)
    const replay = await request(app2).post(wh('fld_wh_ok')).send({ requestId: 'r-auditfail' })
    expect(replay.body.data.status).toBe('failed') // pending → non-success, never re-egressed
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('[#1882 F1] value-scrub: a secret-shaped value in the error is scrubbed in audit AND dedup result_message', async () => {
    mockFetch.mockRejectedValue(new Error('connect failed: postgresql://admin:SuperSecretPwd@db.internal:5432/app'))
    const app = await buildWebhookApp(whAdmin)
    const res = await request(app).post(wh('fld_wh_ok')).send({ requestId: 'r-scrub' })
    expect(res.body.data.status).toBe('failed')
    const stored = [...state.dedupRows.values()][0]
    expect(stored.result_message).not.toContain('SuperSecretPwd')
    const steps = JSON.parse(String(state.auditInserts[0].steps))
    expect(JSON.stringify(steps)).not.toContain('SuperSecretPwd')
    // response message must not leak it either
    expect(JSON.stringify(res.body)).not.toContain('SuperSecretPwd')
  })

  it('[P2-3] header allowlist: only content-type/accept pass; auth/custom dropped; HMAC signature code-owned (not shadowable)', async () => {
    const app = await buildWebhookApp(whAdmin)
    await request(app).post(wh('fld_wh_secret')).send({ requestId: 'r-hdr' })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const sentHeaders = (mockFetch.mock.calls[0] as any[])[3].headers as Record<string, string>
    expect(sentHeaders['Content-Type']).toBe('application/xml') // caller may set content-type
    expect(sentHeaders.Accept).toBe('text/plain')
    expect('X-Custom' in sentHeaders).toBe(false) // arbitrary custom header dropped
    expect('Authorization' in sentHeaders).toBe(false) // auth never settable from config
    // The caller tried to inject X-Webhook-Signature:'forged' — the code-owned HMAC must win.
    expect(sentHeaders['X-Webhook-Signature']).toBeDefined()
    expect(sentHeaders['X-Webhook-Signature']).not.toBe('forged')
    expect('X-Webhook-Timestamp' in sentHeaders).toBe(true)
  })
})
