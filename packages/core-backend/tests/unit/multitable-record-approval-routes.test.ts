/**
 * Record-level submit-for-approval — the ROUTE gates, executed in the no-DB unit lane.
 *
 * WHY THIS FILE EXISTS (adversarial review 2026-09-15, finding "the realdb suite has no CI lane"): the
 * end-to-end proof for these gates lives in tests/integration/multitable-record-approval-realdb.test.ts,
 * which is excluded from the default (no-DB) config and whose standalone workflow file could not be pushed
 * (the pushing token has no `workflow` OAuth scope). Until that lane lands, the route contract would run
 * NOWHERE in CI. This spec executes the REAL router — the real gate order, the real refusal codes, the real
 * service underneath — with only its collaborators faked, so the claims are at least covered by the lane
 * that always runs. It does NOT replace the realdb suite: nothing here proves the partial unique index,
 * the row-level read deny or the field-permission mask against a real database.
 *
 * No supertest (#4154 tripwire): the route handlers are invoked directly, the way tests/unit's other
 * router specs (permissions-routes, admin-users-routes) do it.
 */
import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  requireRecordReadable: vi.fn(),
  loadReadableRecordFieldIds: vi.fn(),
  canReadApprovalTemplateForAutomation: vi.fn(),
  loadAuthorizedApprovalActor: vi.fn(),
  auditLog: vi.fn(),
  createApproval: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({ query: mocks.query, transaction: mocks.transaction }),
  },
}))

vi.mock('../../src/routes/univer-meta', () => ({
  requireRecordReadable: mocks.requireRecordReadable,
  loadReadableRecordFieldIds: mocks.loadReadableRecordFieldIds,
}))

vi.mock('../../src/multitable/automation-approval-template-access', () => ({
  canReadApprovalTemplateForAutomation: mocks.canReadApprovalTemplateForAutomation,
}))

vi.mock('../../src/multitable/automation-approval-bridge-service', () => ({
  loadAuthorizedApprovalActor: mocks.loadAuthorizedApprovalActor,
}))

vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.auditLog }))

vi.mock('../../src/services/ApprovalProductService', () => ({
  ApprovalProductService: class {
    createApproval = mocks.createApproval
  },
}))

import { createMultitableRecordApprovalRoutes } from '../../src/routes/multitable-record-approvals'

const SHEET = 'sht_route_1'
const RECORD = 'rec_route_1'
const TEMPLATE = 'tpl_route_1'
const USER = 'u_route_1'
const SECRET_VALUE = 'classified-13800000000'

const READABLE = {
  access: { userId: USER, isAdminRole: false },
  capabilities: { canRead: true, canSubmitApproval: true },
  capabilityOrigin: 'permission',
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  } as unknown as Response & { statusCode: number; body: unknown }
}

async function invoke(
  method: 'post' | 'get',
  options: { params?: Record<string, string>; body?: Record<string, unknown>; query?: Record<string, unknown> } = {},
) {
  const router = createMultitableRecordApprovalRoutes()
  const path = '/sheets/:sheetId/records/:recordId/approvals'
  const layer = (router.stack as Array<{ route?: { path?: string; methods?: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }>)
    .find((entry) => entry.route?.path === path && entry.route?.methods?.[method])
  if (!layer?.route) throw new Error(`route ${method} ${path} not found`)

  const req = {
    method: method.toUpperCase(),
    headers: {},
    params: options.params ?? { sheetId: SHEET, recordId: RECORD },
    body: options.body ?? {},
    query: options.query ?? {},
  } as unknown as Request
  const res = createMockResponse()
  for (const routeLayer of layer.route.stack) {
    await (routeLayer.handle as (req: Request, res: Response, next: (e?: unknown) => void) => unknown)(req, res, () => undefined)
  }
  return res
}

/** Answers the SQL the route + service issue; every unmatched statement is an empty result. */
function seedQueries(overrides: { templateStatus?: string | null; record?: { version: number; data: unknown } | null; insertThrows?: unknown } = {}) {
  const templateStatus = overrides.templateStatus === undefined ? 'published' : overrides.templateStatus
  const record = overrides.record === undefined ? { version: 4, data: { fld_a: SECRET_VALUE } } : overrides.record
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM approval_templates')) {
      return { rows: templateStatus === null ? [] : [{ status: templateStatus }], rowCount: templateStatus === null ? 0 : 1 }
    }
    if (sql.includes('FROM meta_records')) {
      return { rows: record ? [record] : [], rowCount: record ? 1 : 0 }
    }
    if (sql.includes('FROM approval_instances')) {
      return { rows: [{ status: 'pending' }], rowCount: 1 }
    }
    if (sql.trimStart().startsWith('INSERT INTO multitable_record_approval_submissions')) {
      if (overrides.insertThrows) throw overrides.insertThrows
      return { rows: [], rowCount: 1 }
    }
    if (sql.trimStart().startsWith('UPDATE multitable_record_approval_submissions')) {
      return {
        rows: [
          {
            id: 'sub_route_1',
            sheet_id: SHEET,
            record_id: RECORD,
            template_id: TEMPLATE,
            approval_instance_id: 'inst_route_1',
            approval_request_no: 'AP-ROUTE-1',
            status: params[3] ?? 'pending',
            outcome: params[4] ?? null,
            submitted_by: USER,
            record_version_at_submit: 4,
            error: null,
            created_at: '2026-09-15T00:00:00.000Z',
            completed_at: null,
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('FROM multitable_record_approval_submissions')) {
      return {
        rows: [
          {
            id: 'sub_route_existing',
            sheet_id: SHEET,
            record_id: RECORD,
            template_id: TEMPLATE,
            approval_instance_id: 'inst_existing',
            approval_request_no: 'AP-EXISTING',
            status: 'pending',
            outcome: null,
            submitted_by: USER,
            record_version_at_submit: 2,
            error: null,
            created_at: '2026-09-14T00:00:00.000Z',
            completed_at: null,
            record_snapshot: { fld_a: 'old-secret', fld_hidden: 'hidden-old' },
          },
        ],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  })
}

const submitBody = { templateId: TEMPLATE, formData: { summary: SECRET_VALUE } }

const insertsAttempted = () =>
  mocks.query.mock.calls.filter(([sql]) => String(sql).trimStart().startsWith('INSERT INTO multitable_record_approval_submissions')).length

describe('POST /sheets/:sheetId/records/:recordId/approvals — the gates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireRecordReadable.mockResolvedValue(READABLE)
    mocks.canReadApprovalTemplateForAutomation.mockResolvedValue(true)
    mocks.loadAuthorizedApprovalActor.mockResolvedValue({ userId: USER, roles: ['user'], permissions: ['approvals:write'] })
    mocks.loadReadableRecordFieldIds.mockResolvedValue(new Set(['fld_a']))
    mocks.auditLog.mockResolvedValue(undefined)
    mocks.createApproval.mockResolvedValue({ id: 'inst_route_1', requestNo: 'AP-ROUTE-1', status: 'pending' })
    seedQueries()
  })

  it('refuses a caller WITHOUT canSubmitApproval before it even looks at the template (403, zero writes)', async () => {
    mocks.requireRecordReadable.mockResolvedValue({ ...READABLE, capabilities: { canRead: true, canSubmitApproval: false } })
    const res = await invoke('post', { body: submitBody })
    expect(res.statusCode).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('RECORD_APPROVAL_PERMISSION_DENIED')
    // GATE ORDER: the multitable door comes before any template read and before any write
    expect(mocks.canReadApprovalTemplateForAutomation).not.toHaveBeenCalled()
    expect(mocks.createApproval).not.toHaveBeenCalled()
    expect(insertsAttempted()).toBe(0)
  })

  it('maps the shared read gate refusals onto this route vocabulary (403 → PERMISSION_DENIED, 404 → RECORD_NOT_FOUND)', async () => {
    mocks.requireRecordReadable.mockResolvedValue({ status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } })
    const forbidden = await invoke('post', { body: submitBody })
    expect(forbidden.statusCode).toBe(403)
    expect((forbidden.body as { error: { code: string } }).error.code).toBe('RECORD_APPROVAL_PERMISSION_DENIED')

    mocks.requireRecordReadable.mockResolvedValue({ status: 404, body: { ok: false, error: { code: 'NOT_FOUND' } } })
    const missing = await invoke('post', { body: submitBody })
    expect(missing.statusCode).toBe(404)
    expect((missing.body as { error: { code: string } }).error.code).toBe('RECORD_APPROVAL_RECORD_NOT_FOUND')
    expect(insertsAttempted()).toBe(0)
  })

  it('refuses a template the caller may not read (403 TEMPLATE_FORBIDDEN, zero writes)', async () => {
    mocks.canReadApprovalTemplateForAutomation.mockResolvedValue(false)
    const res = await invoke('post', { body: submitBody })
    expect(res.statusCode).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('RECORD_APPROVAL_TEMPLATE_FORBIDDEN')
    expect(insertsAttempted()).toBe(0)
  })

  it('refuses an UNPUBLISHED template (400) and an unknown one, without creating anything', async () => {
    seedQueries({ templateStatus: 'draft' })
    const draft = await invoke('post', { body: submitBody })
    expect(draft.statusCode).toBe(400)
    expect((draft.body as { error: { code: string } }).error.code).toBe('RECORD_APPROVAL_TEMPLATE_NOT_PUBLISHED')

    seedQueries({ templateStatus: null })
    const unknown = await invoke('post', { body: submitBody })
    expect(unknown.statusCode).toBe(400)
    expect(mocks.createApproval).not.toHaveBeenCalled()
    expect(insertsAttempted()).toBe(0)
  })

  it('refuses when the record row is gone between the gate and the snapshot read (404)', async () => {
    seedQueries({ record: null })
    const res = await invoke('post', { body: submitBody })
    expect(res.statusCode).toBe(404)
    expect((res.body as { error: { code: string } }).error.code).toBe('RECORD_APPROVAL_RECORD_NOT_FOUND')
    expect(insertsAttempted()).toBe(0)
  })

  it('surfaces the actor loader refusal as PERMISSION_DENIED (approvals:write is the approval side door)', async () => {
    mocks.loadAuthorizedApprovalActor.mockRejectedValue(Object.assign(new Error('missing approvals:write'), { statusCode: 403 }))
    const res = await invoke('post', { body: submitBody })
    expect(res.statusCode).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('RECORD_APPROVAL_PERMISSION_DENIED')
    expect(insertsAttempted()).toBe(0)
  })

  it('happy path: 201 with the repo envelope, the instance bound, and a values-free audit event', async () => {
    const res = await invoke('post', { body: submitBody })
    expect(res.statusCode).toBe(201)
    const body = res.body as { ok: boolean; data: { submission: Record<string, unknown> } }
    expect(body.ok).toBe(true)
    expect(body.data.submission).toMatchObject({ status: 'pending', approvalInstanceId: 'inst_route_1', requestNo: 'AP-ROUTE-1' })

    expect(mocks.auditLog).toHaveBeenCalledTimes(1)
    const audit = mocks.auditLog.mock.calls[0]![0] as { action: string; meta: Record<string, unknown> }
    expect(audit.action).toBe('multitable.record.approval.submitted')
    expect(audit.meta).toMatchObject({ sheetId: SHEET, recordId: RECORD, templateId: TEMPLATE, approvalInstanceId: 'inst_route_1' })
    // VALUES-FREE: neither the submitted form data nor the record snapshot may ride in the audit row or
    // the response body.
    expect(JSON.stringify(audit)).not.toContain(SECRET_VALUE)
    expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE)
  })

  it('threads the created approval STATUS through: an auto-approved template lands terminal, not pending', async () => {
    mocks.createApproval.mockResolvedValue({ id: 'inst_auto', requestNo: 'AP-AUTO', status: 'approved' })
    const res = await invoke('post', { body: submitBody })
    expect(res.statusCode).toBe(201)
    const submission = (res.body as { data: { submission: { status: string } } }).data.submission
    expect(submission.status).toBe('approved')
    const promote = mocks.query.mock.calls.find(([sql]) => String(sql).includes('SET status = $4, outcome = $5'))!
    expect((promote[1] as unknown[])[3]).toBe('approved')
    expect((promote[1] as unknown[])[4]).toBe('approved')
  })

  it('a duplicate in-flight submission is 409 with ids only', async () => {
    seedQueries({
      insertThrows: Object.assign(new Error('duplicate key value violates unique constraint "uniq_mt_record_approval_in_flight"'), {
        code: '23505',
        constraint: 'uniq_mt_record_approval_in_flight',
      }),
    })
    const res = await invoke('post', { body: submitBody })
    expect(res.statusCode).toBe(409)
    const body = res.body as { error: { code: string; details: Record<string, unknown> } }
    expect(body.error.code).toBe('RECORD_APPROVAL_IN_FLIGHT')
    expect(body.error.details).toMatchObject({ approvalInstanceId: 'inst_existing', requestNo: 'AP-EXISTING', status: 'pending' })
    expect(mocks.createApproval).not.toHaveBeenCalled()
    expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE)
  })

  it('validates the body before touching the database', async () => {
    const res = await invoke('post', { body: { formData: {} } })
    expect(res.statusCode).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('an unexpected driver failure is 500 INTERNAL_ERROR and never echoes driver text', async () => {
    mocks.query.mockRejectedValue(new Error(`relation "meta_records" does not exist near ${SECRET_VALUE}`))
    const res = await invoke('post', { body: submitBody })
    expect(res.statusCode).toBe(500)
    expect((res.body as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(res.body)).not.toContain(SECRET_VALUE)
  })
})

describe('GET /sheets/:sheetId/records/:recordId/approvals — read gate + masked drift', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireRecordReadable.mockResolvedValue(READABLE)
    mocks.loadReadableRecordFieldIds.mockResolvedValue(new Set(['fld_a']))
    seedQueries()
  })

  it('returns the submissions with drift FIELD IDS masked by the record read path mask, never values', async () => {
    const res = await invoke('get')
    expect(res.statusCode).toBe(200)
    const body = res.body as { ok: boolean; data: { submissions: Array<{ drift: { changed: boolean; changedFieldIds: string[] } }> } }
    expect(body.ok).toBe(true)
    expect(body.data.submissions).toHaveLength(1)
    expect(body.data.submissions[0]!.drift.changed).toBe(true)
    // fld_hidden differs too, but it is outside the caller's read mask → not even its id appears
    expect(body.data.submissions[0]!.drift.changedFieldIds).toEqual(['fld_a'])
    const serialized = JSON.stringify(res.body)
    for (const value of [SECRET_VALUE, 'old-secret', 'hidden-old']) {
      expect(serialized).not.toContain(value)
    }
    expect(mocks.loadReadableRecordFieldIds).toHaveBeenCalledTimes(1)
  })

  it('refuses a caller the shared read gate refuses (no list without canRead)', async () => {
    mocks.requireRecordReadable.mockResolvedValue({ status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } })
    const res = await invoke('get')
    expect(res.statusCode).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe('RECORD_APPROVAL_PERMISSION_DENIED')
    expect(mocks.loadReadableRecordFieldIds).not.toHaveBeenCalled()
  })
})
