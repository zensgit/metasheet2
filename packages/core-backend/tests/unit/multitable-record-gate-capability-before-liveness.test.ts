/**
 * #5830 — `requireRecordReadable` (routes/univer-meta.ts) decides AUTHORITY before SHEET LIVENESS.
 *
 * The shared record read gate used to answer 404 (record missing, SHEET_DELETED, sheet not found)
 * BEFORE its 401/403, so a caller with no read access could tell a deleted or absent sheet from a
 * live one. Five routes rely on that gate alone:
 *
 *   POST /sheets/:sheetId/ai/shortcut/preview                              (routes/multitable-ai.ts)
 *   POST /sheets/:sheetId/ai/shortcut/run                                  (routes/multitable-ai.ts)
 *   POST /sheets/:sheetId/records/:recordId/fields/:fieldId/button/run     (routes/multitable-button.ts)
 *   POST /sheets/:sheetId/records/:recordId/approvals                      (routes/multitable-record-approvals.ts)
 *   GET  /sheets/:sheetId/records/:recordId/approvals                      (routes/multitable-record-approvals.ts)
 *
 * Pinned here, on the helper and on every one of those routes (real routers, real permission-service,
 * a fake pool that answers by SQL shape):
 *   - a caller the capability check refuses (no read, or not signed in) gets the SAME answer for a
 *     live, a soft-deleted and an absent sheet, and for a record that exists or not — and the only
 *     SQL issued is the capability lookup itself (no record row, no field, no template is read);
 *   - a caller who may read learns 404 for a deleted / absent sheet, still without a record read;
 *   - for that caller on a live sheet nothing changed: a missing record is 404, row-level read deny is
 *     403, an admin bypasses row-level deny, and the request goes on past the gate.
 *   - the scope of the promise (review of #5830): for the SAME id, live and soft-deleted answer alike
 *     even where a sheet-bound rule refuses (approval-projection base); an absent id is judged by
 *     global RBAC alone, so there it can differ. A reader the ROUTE refuses (no edit / submit) is told
 *     a deleted sheet is gone — intended, since any read route tells a reader the same.
 *
 * The fake answers "live" for any sheet id it does not know as deleted or absent, so a gate that asks
 * about the wrong id cannot pass the deleted/absent cases by accident.
 */
import type { Request } from 'express'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveSheetReadableCapabilities } from '../../src/multitable/permission-service'
import { SHEET_DELETED_CODE, SHEET_DELETED_MESSAGE, SHEET_NOT_FOUND_MESSAGE } from '../../src/multitable/sheet-liveness'
import { requireRecordReadable } from '../../src/routes/univer-meta'
import { usePinnedServer } from '../utils/pinned-server'

const LIVE = 'sht_gate_live'
const DELETED = 'sht_gate_deleted'
const ABSENT = 'sht_gate_absent'
const SHEETS = [LIVE, DELETED, ABSENT] as const
const RECORD = 'rec_gate_1'
const MISSING = 'rec_gate_missing'
// Sheets in the admin-only approval-projection base (permission-service.ts narrows a non-participant
// non-admin to no read there). Its lookup does not filter deleted_at, so both ids are projection sheets.
const PROJ_LIVE = 'sht_gate_proj_live'
const PROJ_DELETED = 'sht_gate_proj_deleted'
const PROJECTION_SHEETS = new Set([PROJ_LIVE, PROJ_DELETED])
// Record rows survive a SOFT delete; nothing can sit on a sheet that never existed.
const RECORD_ROWS = new Set([`${LIVE}/${RECORD}`, `${DELETED}/${RECORD}`, `${PROJ_LIVE}/${RECORD}`, `${PROJ_DELETED}/${RECORD}`])

type GateUser = { id: string; roles: string[]; perms: string[] }
const READER: GateUser = { id: 'u_gate_reader', roles: ['member'], perms: ['multitable:write', 'multitable:submit-approval'] }
// Authenticated, non-empty perms (so no RBAC lookup), none of which reads a sheet. It even holds the
// submit code: that alone must not open the record gate.
const OUTSIDER: GateUser = { id: 'u_gate_outsider', roles: ['member'], perms: ['comments:read', 'multitable:submit-approval'] }
const ADMIN: GateUser = { id: 'u_gate_admin', roles: ['admin'], perms: [] }
// May read every ordinary sheet, may neither edit a record nor submit one for approval.
const READ_ONLY: GateUser = { id: 'u_gate_read_only', roles: ['member'], perms: ['multitable:read'] }

const FIELDS = [
  { id: 'fld_text', name: 'Text', type: 'string', property: {}, order: 1 },
  { id: 'fld_btn', name: 'Run', type: 'button', property: { actionType: 'record_click', label: 'Go', actionConfig: {} }, order: 2 },
]

const FORBIDDEN = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }
const UNAUTHENTICATED = { error: 'Authentication required' }
const SHEET_DELETED = { ok: false, error: { code: SHEET_DELETED_CODE, message: SHEET_DELETED_MESSAGE } }
const SHEET_ABSENT = { ok: false, error: { code: 'NOT_FOUND', message: SHEET_NOT_FOUND_MESSAGE } }
const recordNotFound = (recordId: string) => ({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })

/** Anything a refused caller must never cause: record/field/template reads, or any write. */
const BEYOND_CAPABILITY = /\b(meta_records|meta_fields|field_permissions|record_permissions|row_level_read_permissions_enabled|conditional_read_rules|approval_templates|multitable_record_approval\w*|multitable_automation_executions|multitable_ai_usage_ledger)\b|^\s*(INSERT|UPDATE|DELETE)\b/i

let sqlLog: string[]
let rowLevel: { enabled: boolean; denied: Set<string> }

async function fakeQuery(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount?: number }> {
  sqlLog.push(sql.replace(/\s+/g, ' ').trim())
  if (/SELECT deleted_at FROM meta_sheets WHERE id = \$1/.test(sql)) {
    const id = params[0]
    if (id === ABSENT) return { rows: [] }
    return { rows: [{ deleted_at: id === DELETED || id === PROJ_DELETED ? new Date('2026-09-01T00:00:00Z') : null }] }
  }
  if (/SELECT id FROM meta_sheets WHERE id = ANY\(\$1::text\[\]\) AND base_id = \$2/.test(sql)) {
    const [ids, baseId] = params as [string[], string]
    // Honour a deleted_at filter if the lookup ever grows one: the "same 403 for live and deleted" case
    // below rests on this lookup NOT filtering it.
    const liveOnly = /deleted_at IS NULL/.test(sql)
    return {
      rows: baseId === 'base_apr_projection'
        ? ids.filter((id) => PROJECTION_SHEETS.has(id) && !(liveOnly && id === PROJ_DELETED)).map((id) => ({ id }))
        : [],
    }
  }
  if (/SELECT row_level_read_permissions_enabled/.test(sql)) {
    return { rows: params[0] === LIVE ? [{ enabled: rowLevel.enabled, base_id: 'base_gate' }] : [] }
  }
  if (/SELECT 1 FROM record_permissions WHERE sheet_id = \$1/.test(sql)) {
    return { rows: rowLevel.denied.size > 0 ? [{ '?column?': 1 }] : [] }
  }
  if (/FROM record_permissions rp/.test(sql)) {
    const [userId, , recordIds] = params as [string, string, string[]]
    return { rows: recordIds.filter((id) => rowLevel.denied.has(`${userId}/${id}`)).map((id) => ({ record_id: id, access_level: 'none' })) }
  }
  if (/FROM meta_records WHERE id = \$1 AND sheet_id = \$2/.test(sql)) {
    const [recordId, sheetId] = params as [string, string]
    if (!RECORD_ROWS.has(`${sheetId}/${recordId}`)) return { rows: [] }
    return { rows: [{ id: recordId, sheet_id: sheetId, version: 1, data: { fld_text: 'hello' }, created_by: READER.id }] }
  }
  if (/FROM meta_fields WHERE sheet_id/.test(sql)) {
    return { rows: FIELDS.map((f) => ({ ...f })) }
  }
  if (/FROM meta_sheets WHERE id = \$1 AND deleted_at IS NULL/.test(sql)) {
    return { rows: params[0] === LIVE ? [{ id: LIVE, base_id: 'base_gate', name: 'Gate', description: null }] : [] }
  }
  if (/INSERT INTO|UPDATE /i.test(sql)) return { rows: [], rowCount: 1 }
  // spreadsheet_permissions, projection / e-learning lookups, conditional rules, … → nothing.
  return { rows: [], rowCount: 0 }
}

const reqFor = (user: GateUser | undefined) => ({ ...(user ? { user } : {}), headers: {} }) as unknown as Request

/** The SQL the capability lookup alone issues for this caller and sheet. */
async function capabilitySql(user: GateUser | undefined, sheetId: string): Promise<string[]> {
  const saved = sqlLog
  sqlLog = []
  try {
    await resolveSheetReadableCapabilities(reqFor(user), fakeQuery, sheetId)
    return sqlLog
  } finally {
    sqlLog = saved
  }
}

beforeEach(() => {
  sqlLog = []
  rowLevel = { enabled: false, denied: new Set() }
})

describe('requireRecordReadable: authority first, then sheet liveness, then the record (#5830)', () => {
  const gate = async (user: GateUser | undefined, sheetId: string, recordId = RECORD) => {
    sqlLog = []
    const result = await requireRecordReadable(reqFor(user), fakeQuery, sheetId, recordId)
    return { result, sql: sqlLog }
  }

  it('a caller without read gets the same 403 for a live, a deleted and an absent sheet — and only the capability lookup runs', async () => {
    for (const recordId of [RECORD, MISSING]) {
      for (const sheetId of SHEETS) {
        const { result, sql } = await gate(OUTSIDER, sheetId, recordId)
        expect(result, `${sheetId}/${recordId}`).toEqual({ status: 403, body: FORBIDDEN })
        expect(sql, `${sheetId}/${recordId}`).toEqual(await capabilitySql(OUTSIDER, sheetId))
        expect(sql.filter((s) => BEYOND_CAPABILITY.test(s))).toEqual([])
      }
    }
  })

  it('an unauthenticated caller gets the same 401 for a live, a deleted and an absent sheet — and only the capability lookup runs', async () => {
    for (const sheetId of SHEETS) {
      const { result, sql } = await gate(undefined, sheetId)
      expect(result, sheetId).toEqual({ status: 401, body: UNAUTHENTICATED })
      expect(sql, sheetId).toEqual(await capabilitySql(undefined, sheetId))
    }
  })

  it('a caller who may read learns 404 SHEET_DELETED / NOT_FOUND for a deleted / absent sheet, before any record read', async () => {
    for (const recordId of [RECORD, MISSING]) {
      const deleted = await gate(READER, DELETED, recordId)
      expect(deleted.result).toEqual({ status: 404, body: SHEET_DELETED })
      expect(deleted.sql).toEqual(await capabilitySql(READER, DELETED))
      const absent = await gate(READER, ABSENT, recordId)
      expect(absent.result).toEqual({ status: 404, body: SHEET_ABSENT })
      expect(absent.sql).toEqual(await capabilitySql(READER, ABSENT))
    }
  })

  it('unchanged for a reader on a live sheet: a missing record is 404 with the same body, after the record check', async () => {
    const { result, sql } = await gate(READER, LIVE, MISSING)
    expect(result).toEqual({ status: 404, body: recordNotFound(MISSING) })
    expect(sql).toEqual([
      ...(await capabilitySql(READER, LIVE)),
      'SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2',
    ])
  })

  it('unchanged for a reader on a live sheet: an existing record is readable (access, capabilities, origin)', async () => {
    const { result } = await gate(READER, LIVE)
    expect('status' in result).toBe(false)
    if ('status' in result) return
    expect(Object.keys(result).sort()).toEqual(['access', 'capabilities', 'capabilityOrigin'])
    expect(result.access.userId).toBe(READER.id)
    expect(result.capabilities.canRead).toBe(true)
  })

  it('unchanged: row-level read deny still refuses a non-admin reader with 403, and an admin still bypasses it', async () => {
    rowLevel = { enabled: true, denied: new Set([`${READER.id}/${RECORD}`, `${ADMIN.id}/${RECORD}`]) }
    const denied = await gate(READER, LIVE)
    expect(denied.result).toEqual({ status: 403, body: FORBIDDEN })
    expect(denied.sql.some((s) => /FROM record_permissions rp/.test(s))).toBe(true)

    const admin = await gate(ADMIN, LIVE)
    expect('status' in admin.result).toBe(false)
    expect(admin.sql.some((s) => /record_permissions/.test(s))).toBe(false)

    // Row-level deny is decided only for a live sheet: a denied reader of a deleted sheet is told it is gone.
    expect((await gate(READER, DELETED)).result).toEqual({ status: 404, body: SHEET_DELETED })
  })

  it('the promise is live vs soft-deleted for the SAME id: on an approval-projection sheet a refused reader gets one 403 for both, while an absent id is judged by global RBAC alone', async () => {
    // What the gate guarantees: soft delete changes nothing the capability lookup reads, so a caller
    // refused on a projection sheet is refused identically whether that sheet is live or deleted.
    for (const recordId of [RECORD, MISSING]) {
      const live = await gate(READER, PROJ_LIVE, recordId)
      const deleted = await gate(READER, PROJ_DELETED, recordId)
      expect(live.result, `live/${recordId}`).toEqual({ status: 403, body: FORBIDDEN })
      expect(deleted.result, `deleted/${recordId}`).toEqual(live.result)
      expect(live.sql).toEqual(await capabilitySql(READER, PROJ_LIVE))
      expect(deleted.sql).toEqual(await capabilitySql(READER, PROJ_DELETED))
      expect([...live.sql, ...deleted.sql].some((s) => /FROM meta_records WHERE id = \$1/.test(s))).toBe(false)
    }
    // What it does NOT promise (requireRecordReadable's ORDER comment): an absent id has no projection
    // row, so global RBAC decides it, and this reader holds global read. The difference is decided by the
    // capability lookup that every sheet-addressed route shares, before this gate's own order matters.
    const absent = await gate(READER, ABSENT)
    expect(absent.result).toEqual({ status: 404, body: SHEET_ABSENT })
    expect(absent.sql).toEqual(await capabilitySql(READER, ABSENT))
    const absentCapabilities = await resolveSheetReadableCapabilities(reqFor(READER), fakeQuery, ABSENT)
    const projectionCapabilities = await resolveSheetReadableCapabilities(reqFor(READER), fakeQuery, PROJ_DELETED)
    expect([absentCapabilities.capabilities.canRead, projectionCapabilities.capabilities.canRead]).toEqual([true, false])
    // An admin bypasses the projection fence, so it is told the deleted projection sheet is gone.
    expect((await gate(ADMIN, PROJ_DELETED)).result).toEqual({ status: 404, body: SHEET_DELETED })
  })
})

// ── The five routes that rely on the gate alone ─────────────────────────────

const pinned = usePinnedServer()
let currentUser: GateUser | undefined
let fetchSpy: ReturnType<typeof vi.fn>

async function buildApp() {
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { createMultitableAiRoutes } = await import('../../src/routes/multitable-ai')
  const { createMultitableButtonRoutes } = await import('../../src/routes/multitable-button')
  const { createMultitableRecordApprovalRoutes } = await import('../../src/routes/multitable-record-approvals')
  const query = vi.fn(fakeQuery)
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query,
    transaction: vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query })),
    getInternalPool: () => ({}),
  } as any)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (currentUser) (req as any).user = currentUser
    next()
  })
  app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchSpy as unknown as typeof fetch }))
  app.use('/api/multitable', createMultitableButtonRoutes())
  app.use('/api/multitable', createMultitableRecordApprovalRoutes({ approvalProductService: { createApproval: vi.fn() } as any }))
  return app
}

type Agent = ReturnType<typeof request>
type Send = (a: Agent, sheetId: string, recordId: string) => request.Test

interface RouteCase {
  name: string
  send: Send
  /** What the route answers when the gate refuses with 403 / 404 (the approvals route re-codes them). */
  forbidden: unknown
  deleted: unknown
  absent: unknown
  missingRecord: (recordId: string) => unknown
  /** Evidence that a live, readable request went on past the gate. */
  pastGate: (res: request.Response, sql: string[]) => void
}

const APPROVAL_FORBIDDEN = { ok: false, error: { code: 'RECORD_APPROVAL_PERMISSION_DENIED', message: 'Insufficient permissions' } }
const APPROVAL_NOT_FOUND = { ok: false, error: { code: 'RECORD_APPROVAL_RECORD_NOT_FOUND', message: 'Record not found' } }
const readFields = (sql: string[]) => sql.some((s) => /FROM meta_fields WHERE sheet_id/.test(s))

const ROUTES: RouteCase[] = [
  {
    name: 'POST /sheets/:sheetId/ai/shortcut/preview',
    send: (a, s, r) => a.post(`/api/multitable/sheets/${s}/ai/shortcut/preview`).send({ recordId: r, fieldId: 'fld_text' }),
    forbidden: FORBIDDEN,
    deleted: SHEET_DELETED,
    absent: SHEET_ABSENT,
    missingRecord: recordNotFound,
    pastGate: (res, sql) => {
      expect(readFields(sql)).toBe(true)
      expect(res.body?.error?.code).not.toMatch(/^(FORBIDDEN|NOT_FOUND|SHEET_DELETED)$/)
    },
  },
  {
    name: 'POST /sheets/:sheetId/ai/shortcut/run',
    send: (a, s, r) => a.post(`/api/multitable/sheets/${s}/ai/shortcut/run`).send({ recordId: r, fieldId: 'fld_text' }),
    forbidden: FORBIDDEN,
    deleted: SHEET_DELETED,
    absent: SHEET_ABSENT,
    missingRecord: recordNotFound,
    pastGate: (res, sql) => {
      expect(readFields(sql)).toBe(true)
      expect(res.body?.error?.code).not.toMatch(/^(FORBIDDEN|NOT_FOUND|SHEET_DELETED)$/)
    },
  },
  {
    name: 'POST /sheets/:sheetId/records/:recordId/fields/:fieldId/button/run',
    send: (a, s, r) => a.post(`/api/multitable/sheets/${s}/records/${r}/fields/fld_btn/button/run`).send({}),
    forbidden: FORBIDDEN,
    deleted: SHEET_DELETED,
    absent: SHEET_ABSENT,
    missingRecord: recordNotFound,
    pastGate: (res, sql) => {
      expect(readFields(sql)).toBe(true)
      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe('succeeded')
    },
  },
  {
    name: 'POST /sheets/:sheetId/records/:recordId/approvals',
    send: (a, s, r) => a.post(`/api/multitable/sheets/${s}/records/${r}/approvals`).send({ templateId: 'tpl_gate', formData: {} }),
    forbidden: APPROVAL_FORBIDDEN,
    deleted: APPROVAL_NOT_FOUND,
    absent: APPROVAL_NOT_FOUND,
    missingRecord: () => APPROVAL_NOT_FOUND,
    pastGate: (res) => {
      // The next gate (template readability) answered — this caller holds no approvals:read.
      expect(res.status).toBe(403)
      expect(res.body.error.code).toBe('RECORD_APPROVAL_TEMPLATE_FORBIDDEN')
    },
  },
  {
    name: 'GET /sheets/:sheetId/records/:recordId/approvals',
    send: (a, s, r) => a.get(`/api/multitable/sheets/${s}/records/${r}/approvals`),
    forbidden: APPROVAL_FORBIDDEN,
    deleted: APPROVAL_NOT_FOUND,
    absent: APPROVAL_NOT_FOUND,
    missingRecord: () => APPROVAL_NOT_FOUND,
    pastGate: (res, sql) => {
      expect(readFields(sql)).toBe(true)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true, data: { submissions: [], hasMore: false } })
    },
  },
]

describe('the five routes guarded by requireRecordReadable alone (#5830)', () => {
  beforeEach(async () => {
    currentUser = READER
    fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))
    pinned.setApp(await buildApp())
  })

  afterEach(() => {
    vi.restoreAllMocks()
    currentUser = undefined
  })

  const call = async (route: RouteCase, sheetId: string, recordId = RECORD) => {
    sqlLog = []
    const res = await route.send(request(pinned.url()), sheetId, recordId)
    return { res, sql: sqlLog }
  }

  for (const route of ROUTES) {
    describe(route.name, () => {
      it('no read access: the same 403 for a live, a deleted and an absent sheet (record present or not); only the capability lookup runs', async () => {
        currentUser = OUTSIDER
        for (const recordId of [RECORD, MISSING]) {
          for (const sheetId of SHEETS) {
            const { res, sql } = await call(route, sheetId, recordId)
            expect(res.status, `${sheetId}/${recordId}`).toBe(403)
            expect(res.body, `${sheetId}/${recordId}`).toEqual(route.forbidden)
            expect(sql, `${sheetId}/${recordId}`).toEqual(await capabilitySql(OUTSIDER, sheetId))
          }
        }
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('not signed in: the same 401 for a live, a deleted and an absent sheet; only the capability lookup runs', async () => {
        currentUser = undefined
        for (const sheetId of SHEETS) {
          const { res, sql } = await call(route, sheetId)
          expect(res.status, sheetId).toBe(401)
          expect(res.body, sheetId).toEqual(UNAUTHENTICATED)
          expect(sql, sheetId).toEqual(await capabilitySql(undefined, sheetId))
        }
      })

      it('a reader learns 404 for a deleted and an absent sheet, before any record read', async () => {
        const deleted = await call(route, DELETED)
        expect(deleted.res.status).toBe(404)
        expect(deleted.res.body).toEqual(route.deleted)
        expect(deleted.sql).toEqual(await capabilitySql(READER, DELETED))
        const absent = await call(route, ABSENT)
        expect(absent.res.status).toBe(404)
        expect(absent.res.body).toEqual(route.absent)
        expect(absent.sql).toEqual(await capabilitySql(READER, ABSENT))
        expect(fetchSpy).not.toHaveBeenCalled()
      })

      it('unchanged for a reader on a live sheet: a missing record is 404', async () => {
        const { res, sql } = await call(route, LIVE, MISSING)
        expect(res.status).toBe(404)
        expect(res.body).toEqual(route.missingRecord(MISSING))
        expect(sql.filter((s) => BEYOND_CAPABILITY.test(s))).toEqual([
          'SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2',
        ])
      })

      it('live sheet, reader, existing record: the request goes on past the gate (positive control)', async () => {
        const { res, sql } = await call(route, LIVE)
        expect(sql.slice(0, (await capabilitySql(READER, LIVE)).length + 1)).toEqual([
          ...(await capabilitySql(READER, LIVE)),
          'SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2',
        ])
        route.pastGate(res, sql)
      })
    })
  }

  it('INTENDED: a reader refused by the ROUTE (no edit / submit) gets that 403 on a live sheet and the gate 404 on a deleted or absent one; the same reader is told so by the read-only route', async () => {
    // Not an oracle: this caller passes the gate, i.e. may read the sheet, and a reader is told that a
    // sheet is gone on every read route (GET …/approvals below). The route's own capability check runs
    // after the gate, as the all-routes closure guard allows (a permission 403 before the existence 404).
    currentUser = READ_ONLY
    const byName = (name: string) => ROUTES.find((r) => r.name === name)!
    const run = byName('POST /sheets/:sheetId/ai/shortcut/run')
    const submit = byName('POST /sheets/:sheetId/records/:recordId/approvals')
    const list = byName('GET /sheets/:sheetId/records/:recordId/approvals')

    const answers = async (route: RouteCase) => {
      const out: Record<string, [number, unknown]> = {}
      for (const sheetId of SHEETS) {
        const { res } = await call(route, sheetId)
        out[sheetId] = [res.status, res.body]
      }
      return out
    }
    expect(await answers(run)).toEqual({
      [LIVE]: [403, FORBIDDEN],
      [DELETED]: [404, SHEET_DELETED],
      [ABSENT]: [404, SHEET_ABSENT],
    })
    expect(await answers(submit)).toEqual({
      [LIVE]: [403, APPROVAL_FORBIDDEN],
      [DELETED]: [404, APPROVAL_NOT_FOUND],
      [ABSENT]: [404, APPROVAL_NOT_FOUND],
    })
    const listed = await answers(list)
    expect(listed[LIVE]![0]).toBe(200)
    expect(listed[DELETED]).toEqual([404, APPROVAL_NOT_FOUND])
    expect(listed[ABSENT]).toEqual([404, APPROVAL_NOT_FOUND])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
