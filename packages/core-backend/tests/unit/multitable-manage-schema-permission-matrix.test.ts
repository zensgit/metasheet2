/**
 * `multitable:manage-schema` — actor x route permission matrix (mock pool, no DB).
 *
 * Models the W1-2 B-series permission-matrix goldens
 * (tests/integration/multitable-permmatrix-b3-mgmt-403-matrix-realdb.test.ts) at the layer that can
 * run without a real Postgres, using the mock-pool route harness of
 * tests/integration/multitable-sheet-permissions.api.test.ts.
 *
 * WHAT IS UNDER TEST
 * `canManageFields` used to be derived as `canWrite` — so anyone holding `multitable:write` could
 * rename, retype and DELETE fields. It now needs its own `multitable:manage-schema` code
 * (src/multitable/manage-schema-permission.ts). This file pins that separation on EVERY route that
 * gates on `canManageFields`.
 *
 * ACTOR TIERS (no sheet-scoped `spreadsheet_permissions` rows exist for any of them, so
 * `applyContextSheetSchemaWriteGrant` is inert and the GLOBAL derivation — the defect's actual path —
 * is what these cells measure):
 *   T1 admin              roles: ['admin']                                         — isAdminRole
 *   T2 write-only         perms: ['multitable:read','multitable:write']            — THE OPERATOR
 *   T3 write + schema     perms: [... , 'multitable:manage-schema']                — the administrator
 *   T4 read-only          perms: ['multitable:read']
 *   T5 unauthenticated    no req.user at all
 *
 * THE NEGATIVE CONTROLS ARE THE POINT. T2 is the shop-floor operator from the live-deployment
 * finding: it must still create/edit/delete RECORDS and still see its unchanged capability
 * projection, while being refused every schema mutation. Both halves are asserted.
 *
 * MOCK POOL: unlisted SQL returns an empty result set rather than throwing. That cannot make a cell
 * pass by accident — every cell asserts an EXACT status, and a DENIED cell additionally asserts the
 * exact FORBIDDEN body, so a route that silently fell through to some other error status would fail
 * the cell rather than satisfy it.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_ms'
const PEOPLE_SHEET_ID = 'sheet_ms_people'
const BASE_ID = 'base_ms'
const FLD_QTY = 'fld_qty'
const REVISION_ID = 'rev_field_update_1'
const TARGET_USER = 'u_ms_target'

const LEGACY_FLAG = 'MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA'

const FORBIDDEN_BODY = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }

type TierId = 'T1_admin' | 'T2_write_only' | 'T3_write_and_schema' | 'T4_read_only' | 'T5_anonymous'

const TIERS: TierId[] = ['T1_admin', 'T2_write_only', 'T3_write_and_schema', 'T4_read_only', 'T5_anonymous']

const TIER_USER: Record<TierId, { id: string; roles: string[]; perms: string[] } | null> = {
  T1_admin: { id: 'u_ms_admin', roles: ['admin'], perms: [] },
  T2_write_only: { id: 'u_ms_writer', roles: ['member'], perms: ['multitable:read', 'multitable:write'] },
  T3_write_and_schema: {
    id: 'u_ms_schema',
    roles: ['member'],
    perms: ['multitable:read', 'multitable:write', 'multitable:manage-schema'],
  },
  T4_read_only: { id: 'u_ms_reader', roles: ['member'], perms: ['multitable:read'] },
  T5_anonymous: null,
}

const TIER_LABEL: Record<TierId, string> = {
  T1_admin: 'T1 platform admin',
  T2_write_only: 'T2 multitable:write only (the shop-floor operator)',
  T3_write_and_schema: 'T3 multitable:write + multitable:manage-schema',
  T4_read_only: 'T4 multitable:read only',
  T5_anonymous: 'T5 unauthenticated',
}

/** Tiers that hold canManageFields under the TIGHTENED (default) derivation. */
const SCHEMA_TIERS: TierId[] = ['T1_admin', 'T3_write_and_schema']

// ── mock pool ──────────────────────────────────────────────────────────────────

type QueryResult = { rows: any[]; rowCount?: number }

type Field = { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }

function freshFields(): Map<string, Field> {
  return new Map<string, Field>([
    [FLD_QTY, { id: FLD_QTY, sheet_id: SHEET_ID, name: 'Total quantity', type: 'number', property: {}, order: 0 }],
    ['fld_note', { id: 'fld_note', sheet_id: SHEET_ID, name: 'Note', type: 'string', property: {}, order: 1 }],
    ['fld_person_user_id', { id: 'fld_person_user_id', sheet_id: PEOPLE_SHEET_ID, name: 'User ID', type: 'string', property: {}, order: 0 }],
    ['fld_person_name', { id: 'fld_person_name', sheet_id: PEOPLE_SHEET_ID, name: 'Name', type: 'string', property: {}, order: 1 }],
    ['fld_person_email', { id: 'fld_person_email', sheet_id: PEOPLE_SHEET_ID, name: 'Email', type: 'string', property: {}, order: 2 }],
    ['fld_person_avatar', { id: 'fld_person_avatar', sheet_id: PEOPLE_SHEET_ID, name: 'Avatar URL', type: 'string', property: {}, order: 3 }],
  ])
}

const SHEET_ROW = { id: SHEET_ID, base_id: BASE_ID, name: 'Stock prep', description: null }
const PEOPLE_SHEET_ROW = { id: PEOPLE_SHEET_ID, base_id: BASE_ID, name: 'People', description: '__metasheet_system:people__' }
const BASE_ROW = { id: BASE_ID, name: 'Ops', icon: 'table', color: '#1677ff', owner_id: 'owner_1', workspace_id: 'ws_1' }

// A recorded FIELD revision — routes the config-restore preview/execute gate onto canManageFields
// (entity_type === 'field'), which is exactly the cell under test.
const FIELD_REVISION = {
  id: REVISION_ID,
  sheet_id: SHEET_ID,
  entity_type: 'field',
  entity_id: FLD_QTY,
  action: 'update',
  before: { id: FLD_QTY, name: 'Qty', type: 'number', property: {} },
  after: { id: FLD_QTY, name: 'Total quantity', type: 'number', property: {} },
  changed_keys: ['name'],
  batch_id: null,
  actor_id: 'someone',
  created_at: '2026-08-30T00:00:00.000Z',
}

function createMockPool(fields: Map<string, Field>) {
  const fieldsForSheet = (sheetId: string) =>
    Array.from(fields.values())
      .filter((f) => f.sheet_id === sheetId)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

  const query = vi.fn(async (sql: string, params?: unknown[]): Promise<QueryResult> => {
    const p = (i: number) => String(params?.[i] ?? '')

    // No sheet-scoped assignments anywhere: isolates the GLOBAL capability derivation.
    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [] }
    if (sql.includes('FROM field_permissions')) return { rows: [] }
    if (sql.includes('FROM record_permissions')) return { rows: [] }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [] }
    if (sql.includes('FROM formula_dependencies')) return { rows: [] }
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }

    // approval-projection read guard — this sheet is not a projection sheet
    if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }

    if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return { rows: p(0) === SHEET_ID ? [{ id: SHEET_ID }] : [] }
    }
    if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
      return { rows: p(0) === SHEET_ID ? [{ ...SHEET_ROW }] : [] }
    }
    if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
      return { rows: p(0) === BASE_ID ? [{ ...BASE_ROW }] : [] }
    }
    if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
      return { rows: [{ ...SHEET_ROW }, { ...PEOPLE_SHEET_ROW }] }
    }
    if (/FROM meta_sheets\b/.test(sql) && sql.includes('WHERE id = $1')) {
      if (p(0) === SHEET_ID) return { rows: [{ ...SHEET_ROW }] }
      if (p(0) === PEOPLE_SHEET_ID) return { rows: [{ ...PEOPLE_SHEET_ROW }] }
      return { rows: [] }
    }

    if (sql.includes('FROM meta_config_revisions') && sql.includes('WHERE id = $1')) {
      return { rows: p(0) === REVISION_ID && p(1) === SHEET_ID ? [{ ...FIELD_REVISION }] : [] }
    }
    if (/^\s*INSERT\s+INTO\s+meta_config_revisions\b/i.test(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM meta_config_revisions')) return { rows: [{ ...FIELD_REVISION }] }

    if (sql.includes('SELECT id FROM meta_fields WHERE id = $1 AND sheet_id = $2')) {
      const f = fields.get(p(0))
      return { rows: f && f.sheet_id === p(1) ? [{ id: f.id }] : [] }
    }
    if (sql.includes('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields')) {
      const rows = fieldsForSheet(p(0))
      return { rows: [{ max_order: rows.length ? rows[rows.length - 1]!.order : -1 }] }
    }
    if (/^\s*INSERT\s+INTO\s+meta_fields\b/i.test(sql)) {
      const [id, sheetId, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
      const row: Field = { id, sheet_id: sheetId, name, type, property: JSON.parse(propertyJson), order }
      fields.set(id, row)
      return { rows: [{ id, name, type, property: row.property, order }] }
    }
    if (/^\s*UPDATE\s+meta_fields\b/i.test(sql)) {
      const [fieldId, name, type, propertyJson, order] = params as [string, string, string, string, number]
      const row = fields.get(fieldId)
      if (!row) return { rows: [] }
      row.name = name
      row.type = type
      row.property = JSON.parse(propertyJson)
      row.order = order
      return { rows: [{ id: row.id, name: row.name, type: row.type, property: row.property, order: row.order }] }
    }
    if (/^\s*DELETE\s+FROM\s+meta_fields\b/i.test(sql)) {
      fields.delete(p(0))
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const f = fields.get(p(0))
      return { rows: f ? [{ ...f }] : [] }
    }
    if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const f = fields.get(p(0))
      return { rows: f ? [{ id: f.id, name: f.name, type: f.type, property: f.property, order: f.order }] : [] }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
      const f = fields.get(p(0))
      return { rows: f ? [{ id: f.id, sheet_id: f.sheet_id }] : [] }
    }
    if (sql.includes('FROM meta_fields') && sql.includes('WHERE sheet_id = $1')) {
      return { rows: fieldsForSheet(p(0)).map((f) => ({ ...f })) }
    }

    if (sql.includes('FROM users') && sql.includes('WHERE id = $1')) {
      return { rows: p(0) === TARGET_USER ? [{ id: TARGET_USER }] : [] }
    }

    // AI usage ledger (R11 lives on the multitable-ai router and settles a ledger row past the gate).
    if (sql.includes('INSERT INTO multitable_ai_usage_ledger')) return { rows: [], rowCount: 1 }
    if (sql.includes('UPDATE multitable_ai_usage_ledger')) {
      return { rows: [], rowCount: sql.includes("'in_flight'") ? 0 : 1 }
    }
    if (sql.includes('FROM multitable_ai_usage_ledger')) {
      return { rows: [{ user_daily_tokens: '0', user_weekly_tokens: '0', instance_daily_usd: '0' }] }
    }

    return { rows: [] }
  })

  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

// ── app harness ────────────────────────────────────────────────────────────────

async function buildApp(tier: TierId, fields: Map<string, Field>): Promise<Express> {
  return (await buildAppWithPool(tier, fields)).app
}

async function buildAppWithPool(
  tier: TierId,
  fields: Map<string, Field>,
): Promise<{ app: Express; pool: ReturnType<typeof createMockPool> }> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const pool = createMockPool(fields)
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as any)

  const app = express()
  app.use(express.json())
  const user = TIER_USER[tier]
  if (user) {
    app.use((req, _res, next) => {
      ;(req as any).user = { ...user }
      next()
    })
  }
  app.use('/api/multitable', univerMetaRouter())
  return { app, pool }
}

// ── transport ─────────────────────────────────────────────────────────────────
// ONE pinned listener for the whole file, app swapped per cell (#4154: `on(app)` re-listens per
// request and is banned by tests/unit/supertest-app-mode-tripwire.test.ts).
const pinned = usePinnedServer()

/** Install `app` on the pinned listener and return a supertest agent bound to its stable URL. */
function on(app: Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

/**
 * R11 lives on the OTHER router (routes/multitable-ai.ts) and gates on the SAME `canManageFields`
 * primitive. Built here with the provider seam stubbed at construction (`fetchFn`), so an ALLOWED
 * cell returns a real 200 without any outbound call.
 */
const AI_ENV: Record<string, string> = {
  MULTITABLE_AI_ENABLED: '1',
  MULTITABLE_AI_PROVIDER: 'anthropic',
  MULTITABLE_AI_API_KEY: `sk-${'matrixmocked1'.repeat(2)}`,
  MULTITABLE_AI_MODEL: 'claude-sonnet-4-6',
  MULTITABLE_AI_CONFIRM_LIVE_REQUESTS: '1',
}

async function buildAiApp(tier: TierId, fields: Map<string, Field>): Promise<Express> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { createMultitableAiRoutes } = await import('../../src/routes/multitable-ai')
  vi.spyOn(poolManager, 'get').mockReturnValue(createMockPool(fields) as any)

  const fetchStub = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: 'text', text: '={fld_qty}*2' }], usage: { input_tokens: 11, output_tokens: 4 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

  const app = express()
  app.use(express.json())
  const user = TIER_USER[tier]
  if (user) {
    app.use((req, _res, next) => {
      ;(req as any).user = { ...user }
      next()
    })
  }
  app.use('/api/multitable', createMultitableAiRoutes({ fetchFn: fetchStub }))
  return app
}

// ── the canManageFields-gated route table ──────────────────────────────────────

type RouteCell = {
  key: string
  label: string
  /** status when the actor HOLDS canManageFields */
  allowedStatus: number
  /**
   * Status for a tier WITHOUT canManageFields. 403 everywhere, except the two config-restore routes,
   * which run an explicit `!access.userId => 401 UNAUTHENTICATED` check BEFORE the capability gate —
   * so the anonymous tier is refused one step earlier there. Both are refusals; the code differs.
   */
  deniedStatus?: Partial<Record<TierId, number>>
  send: (app: Express) => request.Test
}

const SCHEMA_ROUTES: RouteCell[] = [
  {
    key: 'R1',
    label: 'POST /fields (create a column)',
    allowedStatus: 201,
    send: (app) => on(app).post('/api/multitable/fields').send({ sheetId: SHEET_ID, name: 'New column', type: 'string' }),
  },
  {
    key: 'R2',
    label: 'PATCH /fields/:fieldId (rename / retype a column)',
    allowedStatus: 200,
    send: (app) => on(app).patch(`/api/multitable/fields/${FLD_QTY}`).send({ name: 'Renamed quantity' }),
  },
  {
    key: 'R3',
    label: 'DELETE /fields/:fieldId (delete the "total quantity" column)',
    allowedStatus: 200,
    send: (app) => on(app).delete(`/api/multitable/fields/${FLD_QTY}`),
  },
  {
    key: 'R4',
    label: 'POST /person-fields/prepare (provision the people sheet + person field)',
    allowedStatus: 200,
    send: (app) => on(app).post('/api/multitable/person-fields/prepare').send({ sheetId: SHEET_ID }),
  },
  {
    key: 'R5',
    label: 'GET /sheets/:sheetId/field-permissions (read the field ACL)',
    allowedStatus: 200,
    send: (app) => on(app).get(`/api/multitable/sheets/${SHEET_ID}/field-permissions`),
  },
  {
    key: 'R6',
    label: 'PUT /sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId (write the field ACL)',
    allowedStatus: 200,
    send: (app) =>
      on(app)
        .put(`/api/multitable/sheets/${SHEET_ID}/field-permissions/${FLD_QTY}/user/${TARGET_USER}`)
        .send({ readOnly: true }),
  },
  {
    key: 'R8',
    label: 'POST /sheets/:sheetId/config-restore-preview (field revision)',
    // Past the gate the preview reaches the T9-W schema-drift/conflict check and answers 409 under
    // this mock. The load-bearing fact is that it is NOT 403 and is identical for T1 and T3.
    allowedStatus: 409,
    deniedStatus: { T5_anonymous: 401 },
    send: (app) => on(app).post(`/api/multitable/sheets/${SHEET_ID}/config-restore-preview`).send({ revisionId: REVISION_ID }),
  },
  {
    key: 'R9',
    label: 'POST /sheets/:sheetId/config-restore-execute (field revision)',
    // Past the gate the execute path reaches the same conflict check (409) before it would ever
    // validate the preview token.
    allowedStatus: 409,
    deniedStatus: { T5_anonymous: 401 },
    send: (app) =>
      on(app)
        .post(`/api/multitable/sheets/${SHEET_ID}/config-restore-execute`)
        .send({ revisionId: REVISION_ID, previewToken: 'not-a-real-token' }),
  },
  {
    key: 'R10',
    label: 'POST /sheets/:sheetId/formula/dry-run (author a formula against the schema)',
    allowedStatus: 200,
    send: (app) => on(app).post(`/api/multitable/sheets/${SHEET_ID}/formula/dry-run`).send({ expression: '1 + 1' }),
  },
]

// ── suite ──────────────────────────────────────────────────────────────────────

describe('multitable:manage-schema — actor x route matrix', () => {
  beforeEach(() => {
    delete process.env[LEGACY_FLAG]
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env[LEGACY_FLAG]
    vi.restoreAllMocks()
    vi.resetModules()
  })

  describe('capability projection (GET /context) — the record plane is untouched', () => {
    const EXPECTED_CAPABILITIES: Record<string, Record<string, boolean>> = {
      T1_admin: {
        canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
        canManageFields: true, canManageSheetAccess: true, canManageViews: true,
        canComment: true, canManageAutomation: true, canExport: true, canSendNotification: true,
      },
      // THE DEFECT, PINNED: every record capability stays true, canManageFields flips to false.
      T2_write_only: {
        canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
        canManageFields: false, canManageSheetAccess: false, canManageViews: true,
        canComment: false, canManageAutomation: false, canExport: true, canSendNotification: true,
      },
      T3_write_and_schema: {
        canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
        canManageFields: true, canManageSheetAccess: false, canManageViews: true,
        canComment: false, canManageAutomation: false, canExport: true, canSendNotification: true,
      },
      T4_read_only: {
        canRead: true, canCreateRecord: false, canEditRecord: false, canDeleteRecord: false,
        canManageFields: false, canManageSheetAccess: false, canManageViews: false,
        canComment: false, canManageAutomation: false, canExport: true, canSendNotification: false,
      },
    }

    for (const tier of TIERS.filter((t) => t !== 'T5_anonymous')) {
      it(`${TIER_LABEL[tier]}: capability projection`, async () => {
        const app = await buildApp(tier, freshFields())
        const res = await on(app).get('/api/multitable/context').query({ sheetId: SHEET_ID })
        expect(res.status).toBe(200)
        expect(res.body.data.capabilities).toMatchObject(EXPECTED_CAPABILITIES[tier]!)
      })
    }

    it('T2 vs T3 differ in EXACTLY one capability key — the change widens nothing else', async () => {
      const t2 = await on(await buildApp('T2_write_only', freshFields()))
        .get('/api/multitable/context').query({ sheetId: SHEET_ID })
      vi.resetModules()
      const t3 = await on(await buildApp('T3_write_and_schema', freshFields()))
        .get('/api/multitable/context').query({ sheetId: SHEET_ID })
      const a = t2.body.data.capabilities as Record<string, unknown>
      const b = t3.body.data.capabilities as Record<string, unknown>
      const changed = Object.keys(b).filter((k) => a[k] !== b[k])
      expect(changed).toEqual(['canManageFields'])
    })
  })

  describe('schema mutation routes — DENIED for every tier without multitable:manage-schema', () => {
    for (const route of SCHEMA_ROUTES) {
      for (const tier of TIERS) {
        const allowed = SCHEMA_TIERS.includes(tier)
        const expected = allowed ? route.allowedStatus : (route.deniedStatus?.[tier] ?? 403)
        it(`${route.key} ${route.label} x ${TIER_LABEL[tier]} => ${expected}`, async () => {
          const app = await buildApp(tier, freshFields())
          const res = await route.send(app)
          expect(res.status).toBe(expected)
          if (!allowed && expected === 403) expect(res.body).toEqual(FORBIDDEN_BODY)
        })
      }
    }
  })

  describe('GET /sheets/:sheetId/config-history — a PROJECTION gate, not a 403', () => {
    // This route never 403s: canManageFields decides, IN THE WHERE CLAUSE, whether `field` (and
    // `permission`-scoped-to-field) revisions are selectable at all. So the assertion is on the SQL
    // the route actually built, which is where the gate lives — a mock cannot enforce a WHERE clause
    // for it, and asserting on returned rows would be vacuous.
    const fieldClause = "entity_type = 'field'"

    for (const tier of TIERS.filter((t) => t !== 'T5_anonymous')) {
      const allowed = SCHEMA_TIERS.includes(tier)
      it(`R7 ${TIER_LABEL[tier]} => 200, field revisions ${allowed ? 'SELECTABLE' : 'EXCLUDED from the WHERE clause'}`, async () => {
        const { app, pool } = await buildAppWithPool(tier, freshFields())
        const res = await on(app).get(`/api/multitable/sheets/${SHEET_ID}/config-history`)
        expect(res.status).toBe(200)

        const selects = pool.query.mock.calls
          .map((c) => String(c[0]))
          .filter((sql) => sql.includes('FROM meta_config_revisions') && sql.trim().toUpperCase().startsWith('SELECT'))

        if (allowed) {
          expect(selects.some((sql) => sql.includes(fieldClause))).toBe(true)
        } else {
          expect(selects.every((sql) => !sql.includes(fieldClause))).toBe(true)
        }

        // T4 manages no config at all → the route short-circuits to an empty page without querying.
        if (tier === 'T4_read_only') {
          expect(selects).toEqual([])
          expect(res.body.data.items).toEqual([])
        }
      })
    }

    it('R7 T5 unauthenticated => 401', async () => {
      const app = await buildApp('T5_anonymous', freshFields())
      const res = await on(app).get(`/api/multitable/sheets/${SHEET_ID}/config-history`)
      expect(res.status).toBe(401)
    })
  })

  describe('R11 POST /sheets/:sheetId/ai/suggest-formula (routes/multitable-ai.ts, same gate)', () => {
    const AI_FORBIDDEN_BODY = {
      ok: false,
      error: { code: 'FORBIDDEN', message: 'You cannot manage fields on this sheet' },
    }

    beforeEach(() => {
      for (const [k, v] of Object.entries(AI_ENV)) process.env[k] = v
    })
    afterEach(() => {
      for (const k of Object.keys(AI_ENV)) delete process.env[k]
    })

    for (const tier of TIERS) {
      const allowed = SCHEMA_TIERS.includes(tier)
      // The AI route runs its own `!access.userId => 401` check before the capability gate.
      const expected = allowed ? 200 : tier === 'T5_anonymous' ? 401 : 403
      it(`${TIER_LABEL[tier]} => ${expected}`, async () => {
        const app = await buildAiApp(tier, freshFields())
        const res = await on(app)
          .post(`/api/multitable/sheets/${SHEET_ID}/ai/suggest-formula`)
          .send({ instruction: 'double the quantity' })
        expect(res.status).toBe(expected)
        if (expected === 403) expect(res.body).toEqual(AI_FORBIDDEN_BODY)
      })
    }

    it('flag=true restores the legacy fused behaviour here too', async () => {
      process.env[LEGACY_FLAG] = 'true'
      const app = await buildAiApp('T2_write_only', freshFields())
      const res = await on(app)
        .post(`/api/multitable/sheets/${SHEET_ID}/ai/suggest-formula`)
        .send({ instruction: 'double the quantity' })
      expect(res.status).toBe(200)
    })
  })

  describe('NEGATIVE CONTROL — the write-only operator keeps every RECORD capability', () => {
    it('T2 may still create, edit and delete records while every schema mutation is refused', async () => {
      const app = await buildApp('T2_write_only', freshFields())

      const created = await on(app).post('/api/multitable/records').send({ sheetId: SHEET_ID, data: { [FLD_QTY]: 7 } })
      expect(created.status).not.toBe(403)
      expect(created.body).not.toEqual(FORBIDDEN_BODY)

      const patched = await on(app).patch('/api/multitable/records/rec_ms_1').send({ data: { [FLD_QTY]: 8 } })
      expect(patched.status).not.toBe(403)
      expect(patched.body).not.toEqual(FORBIDDEN_BODY)

      const deleted = await on(app).delete('/api/multitable/records/rec_ms_1')
      expect(deleted.status).not.toBe(403)
      expect(deleted.body).not.toEqual(FORBIDDEN_BODY)
    })
  })

  describe('transition switch MULTITABLE_LEGACY_WRITE_IMPLIES_MANAGE_SCHEMA', () => {
    it('default (unset) is the TIGHTENED behaviour — T2 is refused the field delete', async () => {
      expect(process.env[LEGACY_FLAG]).toBeUndefined()
      const app = await buildApp('T2_write_only', freshFields())
      const res = await on(app).delete(`/api/multitable/fields/${FLD_QTY}`)
      expect(res.status).toBe(403)
    })

    // Only the literal string `true` (trimmed, case-insensitive — the repo's flag idiom) re-opens the
    // gate. ' TRUE ' is included precisely because it DOES, and that must be deliberate, not a surprise.
    for (const value of ['false', '1', ' TRUE ', 'yes', '', 'true']) {
      const reopens = value.trim().toLowerCase() === 'true'
      it(`flag=${JSON.stringify(value)} ${reopens ? 'RE-OPENS' : 'does NOT re-open'} the gate`, async () => {
        process.env[LEGACY_FLAG] = value
        const app = await buildApp('T2_write_only', freshFields())
        const res = await on(app).delete(`/api/multitable/fields/${FLD_QTY}`)
        expect(res.status).toBe(reopens ? 200 : 403)
      })
    }

    it('flag=true RESTORES the legacy fused behaviour on every schema route (a REGRESSION, staged only)', async () => {
      for (const route of SCHEMA_ROUTES) {
        process.env[LEGACY_FLAG] = 'true'
        vi.resetModules()
        const app = await buildApp('T2_write_only', freshFields())
        const res = await route.send(app)
        expect({ route: route.key, status: res.status }).toEqual({ route: route.key, status: route.allowedStatus })
      }
    })

    it('flag=true widens NOTHING else — only canManageFields changes for T2, and T4 stays untouched', async () => {
      const flagOff = await on(await buildApp('T2_write_only', freshFields()))
        .get('/api/multitable/context').query({ sheetId: SHEET_ID })
      process.env[LEGACY_FLAG] = 'true'
      vi.resetModules()
      const flagOn = await on(await buildApp('T2_write_only', freshFields()))
        .get('/api/multitable/context').query({ sheetId: SHEET_ID })
      const a = flagOff.body.data.capabilities as Record<string, unknown>
      const b = flagOn.body.data.capabilities as Record<string, unknown>
      expect(Object.keys(b).filter((k) => a[k] !== b[k])).toEqual(['canManageFields'])

      // A read-only actor gains nothing from the flag: it never held multitable:write.
      vi.resetModules()
      const readerOn = await on(await buildApp('T4_read_only', freshFields()))
        .get('/api/multitable/context').query({ sheetId: SHEET_ID })
      expect((readerOn.body.data.capabilities as Record<string, unknown>).canManageFields).toBe(false)
      vi.resetModules()
      const readerRoute = await on(await buildApp('T4_read_only', freshFields()))
        .delete(`/api/multitable/fields/${FLD_QTY}`)
      expect(readerRoute.status).toBe(403)
    })
  })
})
