/**
 * B1-a1 button/action field RUN route — route-level matrix with the REAL
 * routers (univerMetaRouter for the record-read + patch-context helpers, and
 * createMultitableButtonRunRoutes under test) and a mock pool.
 *
 * Design lock: docs/development/multitable-button-field-b1s0-designlock-20260615.md §9.
 *
 * The EXECUTOR and the AUDIT log-service are INJECTED at construction (the audit
 * row is written through the kysely `db` singleton, NOT the pool — a pool mock
 * cannot observe it), so these tests can assert:
 *   - the inert `record_click` settles `succeeded` with ZERO side effects,
 *   - exactly one audit row is written (and none on a deduped replay),
 *   - a dispatch that THROWS is surfaced (500 failed), never swallowed.
 *
 * Matrix (§9): non-reader 403 · field hidden 403/404-like · non-button 400 ·
 * malformed/unknown config 400 · inert success + audit + zero side effects ·
 * dispatch failure surfaces · requestId dedup · low-priv clicking a (would-be)
 * high-priv action blocked server-side (403, not 400).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type Express } from 'express'
import request from 'supertest'
import type { AutomationStepResult, ExecutionContext } from '../../src/multitable/automation-executor'
import type { AutomationAction } from '../../src/multitable/automation-actions'
import { VersionConflictError } from '../../src/multitable/record-write-service'

const SHEET_ID = 'sheet_btn'
const REC_ID = 'rec_btn'
const FLD_BUTTON = 'fld_button'
const FLD_BUTTON_WRITE = 'fld_button_write'
const FLD_BUTTON_UNKNOWN = 'fld_button_unknown'
const FLD_BUTTON_NOCONF = 'fld_button_noconf'
const FLD_BUTTON_UNSAFE = 'fld_button_unsafe'
const FLD_BUTTON_HIDDEN = 'fld_button_hidden'
const FLD_STRING = 'fld_string'

const FIELDS = [
  {
    id: FLD_BUTTON,
    name: 'Click me',
    type: 'button',
    property: { readOnly: true, label: 'Go', actionType: 'record_click', actionConfig: { note: 'hello' } },
    order: 1,
  },
  {
    id: FLD_BUTTON_WRITE,
    name: 'Write button',
    type: 'button',
    property: { readOnly: true, label: 'Write', actionType: 'update_record', actionConfig: { fields: { [FLD_STRING]: 'x' } } },
    order: 2,
  },
  {
    id: FLD_BUTTON_UNKNOWN,
    name: 'Unknown action',
    type: 'button',
    property: { readOnly: true, label: 'Huh', actionType: 'definitely_not_an_action', actionConfig: {} },
    order: 3,
  },
  {
    id: FLD_BUTTON_NOCONF,
    name: 'No action',
    type: 'button',
    property: { readOnly: true, label: 'Empty' },
    order: 4,
  },
  {
    id: FLD_BUTTON_UNSAFE,
    name: 'Unsafe config',
    type: 'button',
    // Build via JSON.parse so `__proto__` is a REAL own enumerable key (exactly
    // how a JSONB property round-trips out of Postgres), not the prototype-setting
    // object-literal form. This is what the run-route's proto-pollution guard must
    // catch before the config reaches a handler.
    property: {
      readOnly: true,
      label: 'Bad',
      actionType: 'record_click',
      actionConfig: JSON.parse('{"__proto__": {"polluted": true}}'),
    },
    order: 5,
  },
  {
    id: FLD_BUTTON_HIDDEN,
    name: 'Hidden button',
    type: 'button',
    property: { readOnly: true, label: 'Secret', actionType: 'record_click', actionConfig: {} },
    order: 6,
  },
  { id: FLD_STRING, name: 'Text', type: 'string', property: {}, order: 7 },
]

let recordData: Record<string, unknown>
let recordExists: boolean
let currentUser: { id: string; roles: string[]; perms: string[] } | undefined
let fieldPermissionRows: Array<{ field_id: string; visible: boolean; read_only: boolean }>

function createMockPool() {
  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number }> => {
    if (sql.includes('SELECT id, sheet_id FROM meta_records')) {
      const [recordId, sheetId] = (params ?? []) as [string, string]
      return recordExists && recordId === REC_ID && sheetId === SHEET_ID
        ? { rows: [{ id: REC_ID, sheet_id: SHEET_ID }] }
        : { rows: [] }
    }
    if (sql.includes('SELECT id, version, data, created_by FROM meta_records')) {
      return recordExists
        ? { rows: [{ id: REC_ID, version: 4, data: { ...recordData }, created_by: currentUser?.id ?? null }] }
        : { rows: [] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1 AND id = ANY')) {
      const ids = new Set((params?.[1] ?? []) as string[])
      return { rows: FIELDS.filter((f) => ids.has(f.id)).map((f) => ({ id: f.id, type: f.type })) }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id')) {
      return { rows: FIELDS.map((f) => ({ ...f })) }
    }
    if (sql.includes('FROM field_permissions')) {
      return { rows: fieldPermissionRows.map((row) => ({ ...row })) }
    }
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID }] }
    }
    if (sql.includes('FROM meta_fields WHERE id = $1')) {
      const f = FIELDS.find((candidate) => candidate.id === params?.[0])
      return { rows: f ? [{ ...f, sheet_id: SHEET_ID }] : [] }
    }
    // sheet_permissions / record_permissions / anything else → empty
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

let app: Express
let dispatchSpy: ReturnType<typeof vi.fn>
let auditSpy: ReturnType<typeof vi.fn>
let dispatchImpl: (action: AutomationAction, context: ExecutionContext) => Promise<AutomationStepResult>

async function buildApp() {
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const { createMultitableButtonRunRoutes } = await import('../../src/routes/multitable-button-run')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool() as any)

  dispatchSpy = vi.fn((action: AutomationAction, context: ExecutionContext) => dispatchImpl(action, context))
  auditSpy = vi.fn(async () => {})

  const built = express()
  built.use(express.json())
  built.use((req, _res, next) => {
    if (currentUser) (req as any).user = currentUser
    next()
  })
  built.use('/api/multitable', univerMetaRouter())
  built.use(
    '/api/multitable',
    createMultitableButtonRunRoutes({
      executor: { dispatchSingleAction: dispatchSpy as any },
      recordAudit: { record: auditSpy as any },
    }),
  )
  return built
}

function runUrl(fieldId: string): string {
  return `/api/multitable/sheets/${SHEET_ID}/records/${REC_ID}/fields/${fieldId}/button/run`
}

describe('B1-a1 button/run route (mock pool)', () => {
  beforeEach(async () => {
    recordData = { [FLD_STRING]: 'value' }
    recordExists = true
    currentUser = { id: 'u_writer', roles: ['member'], perms: ['multitable:write'] }
    fieldPermissionRows = [{ field_id: FLD_BUTTON_HIDDEN, visible: false, read_only: false }]
    // Default dispatch: the REAL inert record_click semantics — succeeded, zero side effects.
    dispatchImpl = async (action, context) => ({
      actionType: action.type,
      status: 'success',
      output: { kind: 'record_click', recordId: context.recordId },
    })
    app = await buildApp()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('§9 unauthenticated → 401, zero dispatch, zero audit', async () => {
    currentUser = undefined
    const res = await request(app).post(runUrl(FLD_BUTTON)).send({})
    expect(res.status).toBe(401)
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(auditSpy).not.toHaveBeenCalled()
  })

  it('§9 non-reader (no multitable capability) → 403, zero dispatch', async () => {
    currentUser = { id: 'u_norights', roles: ['member'], perms: ['comments:read'] }
    const res = await request(app).post(runUrl(FLD_BUTTON)).send({})
    expect(res.status).toBe(403)
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(auditSpy).not.toHaveBeenCalled()
  })

  it('§9 record not on sheet → 404', async () => {
    recordExists = false
    const res = await request(app).post(runUrl(FLD_BUTTON)).send({})
    expect(res.status).toBe(404)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('§9 field not found → 404', async () => {
    const res = await request(app).post(runUrl('fld_ghost')).send({})
    expect(res.status).toBe(404)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('§9 field hidden (layer-3 not visible) → 403, never leaks existence', async () => {
    const res = await request(app).post(runUrl(FLD_BUTTON_HIDDEN)).send({})
    // Hidden fields are dropped from the read-masked field set → 404 (existence
    // never disclosed); a field present-but-marked-invisible → 403. Either way
    // it is NOT runnable and nothing dispatches.
    expect([403, 404]).toContain(res.status)
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('§9 non-button field → 400 NOT_A_BUTTON_FIELD', async () => {
    const res = await request(app).post(runUrl(FLD_STRING)).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('NOT_A_BUTTON_FIELD')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('§9 button with no actionType → 400 BUTTON_CONFIG_INVALID', async () => {
    const res = await request(app).post(runUrl(FLD_BUTTON_NOCONF)).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BUTTON_CONFIG_INVALID')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('§9 button with unknown actionType (∉ ALL_ACTION_TYPES) → 400 at run time (codec defers it)', async () => {
    const res = await request(app).post(runUrl(FLD_BUTTON_UNKNOWN)).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BUTTON_ACTION_TYPE_UNKNOWN')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('defense-in-depth: actionConfig with a __proto__ key → 400, never reaches a handler', async () => {
    const res = await request(app).post(runUrl(FLD_BUTTON_UNSAFE)).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('BUTTON_CONFIG_INVALID')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('§4 visible ≠ executable: low-priv actor clicking a (would-be) high-priv action → 403 (gate), not 400 (unsupported)', async () => {
    // Reader has canRead but NOT canEditRecord. The button is configured to
    // update_record (a write-class action). The per-action gate (canEditRecord)
    // is re-evaluated AS THE ACTOR and BEFORE the supported-action gate, so this
    // surfaces as authorization (403), never as "unsupported" (400).
    currentUser = { id: 'u_reader', roles: ['member'], perms: ['multitable:read'] }
    fieldPermissionRows = []
    const res = await request(app).post(runUrl(FLD_BUTTON_WRITE)).send({})
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('a write-class button by an authorized writer is still NOT dispatched in B1-a1 → 400 ACTION_NOT_SUPPORTED (auth passes, scope-gate blocks)', async () => {
    // Writer HAS canEditRecord, so the §4 gate passes — but B1-a1 dispatches only
    // the inert record_click; write/egress actions are a later gated slice.
    const res = await request(app).post(runUrl(FLD_BUTTON_WRITE)).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('ACTION_NOT_SUPPORTED')
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('§9 inert record_click success → 200 succeeded + record context + ONE audit row + ZERO side effects', async () => {
    const res = await request(app).post(runUrl(FLD_BUTTON)).send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.status).toBe('succeeded')
    expect(res.body.data.recordId).toBe(REC_ID)
    expect(res.body.data.fieldId).toBe(FLD_BUTTON)
    expect(res.body.data.actionType).toBe('record_click')
    expect(res.body.data.executionId).toMatch(/^axe_btn_/)

    // Dispatched through the executor seam with a minimal context whose authority
    // fields are the ACTOR (never a synthetic privileged creator).
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    const [action, context] = dispatchSpy.mock.calls[0] as [AutomationAction, ExecutionContext]
    expect(action.type).toBe('record_click')
    expect(context.actorId).toBe('u_writer')
    expect(context.ruleCreatedBy).toBe('u_writer')
    expect(context.recordId).toBe(REC_ID)

    // Exactly one audit row, with ZERO record writes (no UPDATE/INSERT meta_records).
    expect(auditSpy).toHaveBeenCalledTimes(1)
    const audited = auditSpy.mock.calls[0][0]
    expect(audited.status).toBe('success')
    expect(audited.steps).toHaveLength(1)
    expect(audited.steps[0].actionType).toBe('record_click')
    const pool = (await import('../../src/integration/db/connection-pool')).poolManager.get() as any
    const writeCalls = (pool.query.mock?.calls ?? []).filter(([sql]: [string]) =>
      /UPDATE meta_records|INSERT INTO meta_records/i.test(sql),
    )
    expect(writeCalls).toHaveLength(0)
  })

  it('§5 dispatch failure is NOT swallowed → surfaces (500 + audit failed row)', async () => {
    dispatchImpl = async () => {
      throw new Error('boom in handler')
    }
    const res = await request(app).post(runUrl(FLD_BUTTON)).send({})
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.code).toBe('DISPATCH_FAILED')
    expect(res.body.error.message).toContain('boom in handler')
    // The failure is still audited (best-effort), as a failed row.
    expect(auditSpy).toHaveBeenCalledTimes(1)
    expect(auditSpy.mock.calls[0][0].status).toBe('failed')
  })

  it('§5 a version conflict thrown at dispatch → 409 VERSION_CONFLICT (seam wired for write actions), audited failed', async () => {
    // record_click cannot throw this, but the seam must map it like the AI run
    // route (#2623) so a future write-class action races safely. We force the
    // throw via the injected executor.
    dispatchImpl = async () => {
      throw new VersionConflictError(REC_ID, 9)
    }
    const res = await request(app).post(runUrl(FLD_BUTTON)).send({})
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('VERSION_CONFLICT')
    expect(res.body.error.serverVersion).toBe(9)
    expect(auditSpy).toHaveBeenCalledTimes(1)
    expect(auditSpy.mock.calls[0][0].status).toBe('failed')
  })

  it('§5 a settled-failed step (executor returns failed, no throw) → 422 failed, audited failed', async () => {
    dispatchImpl = async (action) => ({ actionType: action.type, status: 'failed', error: 'inert failed somehow' })
    const res = await request(app).post(runUrl(FLD_BUTTON)).send({})
    expect(res.status).toBe(422)
    expect(res.body.ok).toBe(false)
    expect(res.body.data.status).toBe('failed')
    expect(res.body.data.message).toContain('inert failed somehow')
    expect(auditSpy.mock.calls[0][0].status).toBe('failed')
  })

  it('§5 requestId dedup: a repeated requestId in-window returns the SAME settle and writes NO second audit row', async () => {
    const first = await request(app).post(runUrl(FLD_BUTTON)).send({ requestId: 'req-1' })
    expect(first.status).toBe(200)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(auditSpy).toHaveBeenCalledTimes(1)

    const second = await request(app).post(runUrl(FLD_BUTTON)).send({ requestId: 'req-1' })
    expect(second.status).toBe(200)
    expect(second.body.data.executionId).toBe(first.body.data.executionId)
    // No second dispatch, no second audit row (anti-double-click).
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(auditSpy).toHaveBeenCalledTimes(1)

    // A DIFFERENT requestId is a fresh run.
    const third = await request(app).post(runUrl(FLD_BUTTON)).send({ requestId: 'req-2' })
    expect(third.status).toBe(200)
    expect(dispatchSpy).toHaveBeenCalledTimes(2)
    expect(auditSpy).toHaveBeenCalledTimes(2)
  })

  it('§5 audit failure NEVER breaks an already-settled dispatch (best-effort)', async () => {
    auditSpy.mockRejectedValueOnce(new Error('audit db down'))
    const res = await request(app).post(runUrl(FLD_BUTTON)).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('succeeded')
  })
})
