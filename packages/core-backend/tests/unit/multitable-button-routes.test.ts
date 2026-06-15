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
]

let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
let noRecord = false

function createMockPool() {
  const query = vi.fn(async (sql: string): Promise<{ rows: any[]; rowCount?: number }> => {
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
  beforeEach(async () => { currentUser = reader; noRecord = false; app = await buildApp() })
  afterEach(() => { vi.restoreAllMocks(); currentUser = undefined; noRecord = false })

  it('runs an inert record_click button → 200 succeeded', async () => {
    const res = await request(app).post(runUrl('fld_btn')).send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.status).toBe('succeeded')
    expect(res.body.data.executionId).toMatch(/^axe_btn_/)
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
})
