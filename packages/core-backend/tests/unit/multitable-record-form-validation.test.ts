import type { Request, RequestHandler, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fieldValidation from '../../src/multitable/field-validation'
import { MultitableRecordValidationError } from '../../src/multitable/record-errors'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), authenticated: false }))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ query: mocks.query, transaction: mocks.transaction, getInternalPool: () => ({}) }) },
}))
vi.mock('../../src/multitable/permission-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/multitable/permission-service')>(),
  resolveSheetCapabilities: async () => ({
    access: { userId: mocks.authenticated ? 'user' : '', permissions: [], isAdminRole: false },
    capabilities: { canRead: true, canCreateRecord: true, canEditRecord: true },
    sheetLiveness: 'live',
  }),
}))
vi.mock('../../src/multitable/realtime-publish', () => ({ publishMultitableSheetRealtime: vi.fn() }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn().mockResolvedValue(false),
  userHasPermission: vi.fn().mockResolvedValue(false),
  listUserPermissions: vi.fn().mockResolvedValue([]),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))

const fields = [
  { id: 'day', name: 'Day', type: 'date', property: {} },
  { id: 'title', name: 'Title', type: 'string', property: {} },
  { id: 'rich', name: 'Rich', type: 'longText', property: { rich: true } },
]
let stored: Record<string, unknown>
let handler: RequestHandler

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mocks.authenticated = false
  stored = { day: 'legacy-invalid', title: 'before' }
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM meta_views WHERE id = $1')) {
      return { rows: [{ id: 'view_validation', sheet_id: 'sheet_validation', name: 'Form', type: 'form',
        config: { publicForm: { enabled: true, publicToken: 'synthetic', accessMode: 'public' } } }] }
    }
    if (sql.includes('FROM meta_sheets')) return { rows: [{ id: 'sheet_validation', base_id: 'base_validation', name: 'Synthetic' }] }
    if (sql.includes('FROM meta_fields')) return { rows: fields }
    if (sql.includes('FROM meta_records')) {
      return { rows: [{ id: String(params[0]), data: stored, version: 1, locked: false, created_by: 'user' }] }
    }
    if (sql.includes('INSERT INTO meta_records')) {
      stored = JSON.parse(String(params[2]))
      return { rows: [{ id: params[0], version: 1 }] }
    }
    if (sql.includes('UPDATE meta_records')) {
      stored = { ...stored, ...JSON.parse(String(params[0])) }
      return { rows: [{ version: 2 }] }
    }
    return { rows: [] }
  })
  mocks.transaction.mockImplementation(async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }))
  const router = univerMetaRouter()
  const route = router.stack.find((layer) => layer.route?.path === '/views/:viewId/submit')?.route
  handler = route.stack[route.stack.length - 1].handle
})

async function submit(data: Record<string, unknown>, edit = false) {
  mocks.authenticated = edit
  const req = {
    params: { viewId: 'view_validation' }, query: {},
    body: { data, ...(edit ? { recordId: 'record_validation' } : { publicToken: 'synthetic' }) },
    ...(edit ? { user: { id: 'user' } } : {}),
  } as unknown as Request
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
  const next = vi.fn()
  await handler(req, response as unknown as Response, next)
  expect(next).not.toHaveBeenCalled()
  return response
}

const invalid = [
  { day: '2026-02-29' }, { day: '1900-02-29' }, { day: '2024-02-30T00:00:00Z' },
  { title: 'a\u0000b' }, { ['bad\u0000']: 'safe' },
  { title: { nested: [{ ['bad\u0000']: 'safe' }] } },
  { title: { nested: [{ value: '\u0000' }] } }, { rich: '<p>a\u0000b</p>' },
]

describe.each([false, true])('real form-submit handler with mock collaborators, edit=%s', (edit) => {
  it.each(invalid)('returns typed 400 before any transaction: %j', async (data) => {
    const response = await submit(data, edit)
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    }))
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))).toEqual([])
  })

  it.each(['2024-02-29', '2000-02-29', '', null])('accepts safe date and strings: %j', async (day) => {
    const response = await submit({ day, title: '中文\\u0000\n', rich: '<p>safe</p>' }, edit)
    expect(response.status).not.toHaveBeenCalled()
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    expect(stored).toEqual({ day, title: '中文\\u0000\n', rich: '<p>safe</p>' })
  })

  it('maps a typed final serialization failure to 400 rather than 500', async () => {
    vi.spyOn(fieldValidation, 'serializeRecordData').mockImplementationOnce(() => {
      throw new MultitableRecordValidationError('Synthetic final serialization refusal')
    })
    const response = await submit({ day: '2024-02-29' }, edit)
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Synthetic final serialization refusal' } })
    expect(mocks.query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(sql))).toEqual([])
  })
})

it('an unrelated authenticated form edit preserves a dirty stored date', async () => {
  const response = await submit({ title: 'after' }, true)
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
  expect(stored).toEqual({ day: 'legacy-invalid', title: 'after' })
})
