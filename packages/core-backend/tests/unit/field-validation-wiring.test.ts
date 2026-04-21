/**
 * Field validation — PATCH/GET wiring + engine round-trip.
 *
 * Closes audit gap #3 from PR #944: `MetaFieldValidationPanel.vue`
 * existed on the frontend and `field-validation-engine.ts` ran on
 * record submit, but nothing persisted `property.validation` through
 * the PATCH `/fields/:fieldId` handler, and the panel's flat rule
 * shape (`{ type, value, message }`) wasn't translated to the engine
 * shape (`{ type, params, message }`).
 *
 * These cases deliberately avoid overlap with
 * `tests/integration/field-validation-flow.test.ts`, which already
 * exercises pure engine-shape submit flows. The tests here cover:
 *   - PATCH accepts the flat UI shape and normalises it on write
 *   - GET returns engine-shape rules after the normalisation
 *   - Record submit sees the normalised rules end-to-end
 *   - Garbage payloads are rejected (not persisted verbatim)
 *
 * If any of these fail, the "build-but-not-wire" audit gap has
 * returned.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

const VIEW_ID = 'view_wiring_1'
const SHEET_ID = 'sheet_wiring_1'
const FIELD_ID = 'fld_wiring_1'

type StoredField = {
  id: string
  sheet_id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

/**
 * Build a tiny in-memory store that mirrors the subset of DB
 * interactions the field PATCH/GET + form submit paths perform.
 * We only keep what the handlers actually query — permission tables
 * and formula_dependencies short-circuit to empty rowsets.
 */
function createFieldStore(initial: StoredField): {
  store: { field: StoredField }
  handler: QueryHandler
} {
  const field: StoredField = { ...initial, property: { ...initial.property } }

  const handler: QueryHandler = (sql, params) => {
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID, base_id: 'base_wiring', name: 'Sheet', description: null }] }
    }
    if (sql.includes('FROM meta_views WHERE id = $1')) {
      return {
        rows: [{
          id: VIEW_ID,
          sheet_id: SHEET_ID,
          name: 'Form',
          type: 'form',
          filter_info: {},
          sort_info: {},
          group_info: {},
          hidden_field_ids: [],
          config: {},
        }],
      }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
      return { rows: [{ id: field.id, sheet_id: field.sheet_id }] }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      return { rows: [{ ...field }] }
    }
    if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      return { rows: [{ id: field.id, name: field.name, type: field.type, property: field.property, order: field.order }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return { rows: [{ id: field.id, name: field.name, type: field.type, property: field.property, order: field.order }] }
    }
    if (sql.startsWith('UPDATE meta_fields')) {
      const [, name, type, propertyJson, order] = params as [string, string, string, string, number]
      field.name = name
      field.type = type
      field.property = JSON.parse(propertyJson)
      field.order = order
      return { rows: [{ id: field.id, name: field.name, type: field.type, property: field.property, order: field.order }] }
    }
    if (sql.includes('INSERT INTO meta_records')) {
      return { rows: [{ id: params?.[0] ?? 'rec_new', version: 1 }] }
    }
    if (sql.includes('SELECT id, version, data FROM meta_records WHERE id = $1')) {
      return { rows: [{ id: 'rec_new', version: 1, data: {} }] }
    }
    return { rows: [], rowCount: 0 }
  }

  return { store: { field }, handler }
}

function createMockPool(handler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    // Short-circuit permission/dependency tables so the handler's
    // canManageFields check lands on the stubbed `write` grant below.
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
      || sql.includes('FROM formula_dependencies')
    ) {
      return { rows: [], rowCount: 0 }
    }
    return handler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(handler: QueryHandler) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(['multitable:write']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(handler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_wiring',
      roles: [],
      perms: ['multitable:read', 'multitable:write'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool }
}

describe('field validation wiring — PATCH → GET → submit', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('accepts flat-shape validation rules on PATCH and round-trips engine-shape on GET', async () => {
    const { handler, store } = createFieldStore({
      id: FIELD_ID,
      sheet_id: SHEET_ID,
      name: 'Name',
      type: 'string',
      property: {},
      order: 0,
    })
    const { app } = await createApp(handler)

    // The panel emits `{ type, value, message }`. The backend must
    // normalise that to the engine's `{ type, params, message }`
    // before persisting.
    const patchRes = await request(app)
      .patch(`/api/multitable/fields/${FIELD_ID}`)
      .send({
        property: {
          validation: [
            { type: 'required', message: 'Name cannot be blank' },
            { type: 'minLength', value: 3, message: 'Too short' },
            { type: 'pattern', value: '^[A-Z]', message: 'Start with capital' },
          ],
        },
      })

    expect(patchRes.status).toBe(200)
    expect(patchRes.body.ok).toBe(true)

    // Persisted storage must be in engine shape — the engine only
    // understands `params.value` / `params.regex`.
    expect(store.field.property.validation).toEqual([
      { type: 'required', message: 'Name cannot be blank' },
      { type: 'minLength', params: { value: 3 }, message: 'Too short' },
      { type: 'pattern', params: { regex: '^[A-Z]' }, message: 'Start with capital' },
    ])

    // GET returns the same engine shape so the frontend can load it
    // back into the panel.
    const getRes = await request(app).get(`/api/multitable/fields?sheetId=${SHEET_ID}`)
    expect(getRes.status).toBe(200)
    expect(getRes.body.ok).toBe(true)
    expect(getRes.body.data.fields[0].property.validation).toEqual([
      { type: 'required', message: 'Name cannot be blank' },
      { type: 'minLength', params: { value: 3 }, message: 'Too short' },
      { type: 'pattern', params: { regex: '^[A-Z]' }, message: 'Start with capital' },
    ])
  })

  it('preserves engine-shape rules without re-wrapping', async () => {
    const { handler, store } = createFieldStore({
      id: FIELD_ID,
      sheet_id: SHEET_ID,
      name: 'Age',
      type: 'number',
      property: {},
      order: 0,
    })
    const { app } = await createApp(handler)

    // A client that already speaks engine shape must NOT get
    // double-wrapped into `params: { value: { value: 0 } }` or similar.
    const patchRes = await request(app)
      .patch(`/api/multitable/fields/${FIELD_ID}`)
      .send({
        property: {
          validation: [
            { type: 'min', params: { value: 0 } },
            { type: 'max', params: { value: 100 } },
          ],
        },
      })

    expect(patchRes.status).toBe(200)
    expect(store.field.property.validation).toEqual([
      { type: 'min', params: { value: 0 } },
      { type: 'max', params: { value: 100 } },
    ])
  })

  it('drops garbage rule entries and rejects non-array validation', async () => {
    const { handler, store } = createFieldStore({
      id: FIELD_ID,
      sheet_id: SHEET_ID,
      name: 'Name',
      type: 'string',
      property: { options: [{ value: 'keep-me' }] },
      order: 0,
    })
    const { app } = await createApp(handler)

    // Mixing a valid rule with two malformed entries should keep the
    // valid one and silently drop the rest — not reject the whole
    // request and corrupt unrelated property keys.
    const patchRes = await request(app)
      .patch(`/api/multitable/fields/${FIELD_ID}`)
      .send({
        property: {
          options: [{ value: 'keep-me' }],
          validation: [
            { type: 'required' },
            { type: 'unknownRule', value: 42 },
            { type: 'pattern' /* missing value/regex */ },
            'not-an-object',
          ],
        },
      })

    expect(patchRes.status).toBe(200)
    expect(store.field.property.validation).toEqual([{ type: 'required' }])

    // A non-array `validation` value is dropped entirely so the engine
    // defaults kick back in — the rest of `property` survives.
    const patchRes2 = await request(app)
      .patch(`/api/multitable/fields/${FIELD_ID}`)
      .send({ property: { options: [{ value: 'keep-me' }], validation: 'nope' } })

    expect(patchRes2.status).toBe(200)
    expect(store.field.property.validation).toBeUndefined()
    expect(store.field.property.options).toEqual([{ value: 'keep-me' }])
  })

  it('record submit enforces minLength rules persisted via the flat UI shape', async () => {
    // This is the smoking-gun assertion for the audit gap: if the
    // flat `{ value: N }` shape persists unchanged, the engine reads
    // `params?.value` and silently no-ops, so submitting a too-short
    // value would return 200 instead of 422. Seed the field with a
    // minLength rule via PATCH, then try to submit values either side
    // of the limit and confirm enforcement.
    const { handler } = createFieldStore({
      id: FIELD_ID,
      sheet_id: SHEET_ID,
      name: 'Name',
      type: 'string',
      property: {},
      order: 0,
    })
    const { app } = await createApp(handler)

    await request(app)
      .patch(`/api/multitable/fields/${FIELD_ID}`)
      .send({ property: { validation: [{ type: 'minLength', value: 5 }] } })
      .expect(200)

    const tooShort = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { [FIELD_ID]: 'hi' } })

    expect(tooShort.status).toBe(422)
    expect(tooShort.body.error).toBe('VALIDATION_FAILED')
    expect(tooShort.body.fieldErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldId: FIELD_ID, rule: 'minLength' }),
      ]),
    )

    const okRes = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { [FIELD_ID]: 'hello world' } })

    expect(okRes.status).toBe(200)
  })

  it('record submit enforces pattern rules persisted via the flat UI shape', async () => {
    const { handler } = createFieldStore({
      id: FIELD_ID,
      sheet_id: SHEET_ID,
      name: 'Email',
      type: 'string',
      property: {},
      order: 0,
    })
    const { app } = await createApp(handler)

    await request(app)
      .patch(`/api/multitable/fields/${FIELD_ID}`)
      .send({
        property: {
          validation: [
            { type: 'pattern', value: '^[^@]+@[^@]+\\.[^@]+$', message: 'Invalid email' },
          ],
        },
      })
      .expect(200)

    const bad = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { [FIELD_ID]: 'not-an-email' } })

    expect(bad.status).toBe(422)
    expect(bad.body.fieldErrors[0]).toMatchObject({
      fieldId: FIELD_ID,
      rule: 'pattern',
      message: 'Invalid email',
    })

    const good = await request(app)
      .post(`/api/multitable/views/${VIEW_ID}/submit`)
      .send({ data: { [FIELD_ID]: 'user@example.com' } })

    expect(good.status).toBe(200)
  })
})
