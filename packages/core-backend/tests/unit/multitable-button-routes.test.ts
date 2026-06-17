/**
 * B1-a1 button/run route — mock-pool unit tests (no live DB). Mirrors the
 * AI-shortcut-run route test harness. Focus: the security-critical gates
 * (visibility != executability) + the inert-only restriction + fail semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'

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

  it('a non-inert actionType (send_webhook) is NOT enabled from a button yet → 400', async () => {
    const res = await request(app).post(runUrl('fld_btn_webhook')).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BUTTON_ACTION_NOT_ENABLED')
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
