/**
 * 一个项目一张备料表 — option B (owner 2026-10-29, register R-66 ②; ADR §11.7 first known cost): on a REGISTERED
 * stock-preparation project sheet only a platform admin manages fields and views. Mock query functions, no DB —
 * the real-DB twin is the S4 case in tests/integration/stock-prep-w2-scoped-repair-realdb.test.ts.
 *
 *   (a) the pure clamp and the lookup: only canManageFields / canManageViews change; admins untouched; the
 *       derived-id prefilter issues no statement for a client id; the object-id shape and the plugin decide;
 *   (b) THREE-RESOLVER PARITY: a floor role holding the G1 `spreadsheet:write` sheet grant, a global
 *       `multitable:manage-schema` holder and a sheet-admin grant holder all lose both bits on the project
 *       sheet — through REST `resolveSheetCapabilitiesForAccess`, the collab / token
 *       `resolveSheetCapabilitiesForUser` and the transaction-bound `resolveSheetCapabilitiesForUserOnQuery` —
 *       while every other capability is exactly what the same person resolves on an ordinary sheet; a platform
 *       admin keeps everything; an unregistered derived twin, the canonical main table, the overview object and
 *       another plugin's registration are untouched; a registry error propagates;
 *   (c) ROUTE MATRIX (usePinnedServer, mock pool): every schema route refuses the floor and the schema holder on
 *       the project sheet with the plain FORBIDDEN, while the same person passes the gate on the unregistered
 *       twin and the platform admin passes it on the project sheet; `/context` keeps the record plane;
 *       `GET /view?seed=true` on the live project sheet reads but writes no field / record for a clamped person.
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
  userHasPermission: vi.fn(),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))

import type { ResolvedRequestAccess } from '../../src/multitable/access'
import { MULTITABLE_MANAGE_SCHEMA_PERMISSION } from '../../src/multitable/manage-schema-permission'
import { resolveSheetCapabilitiesForAccess, type QueryFn } from '../../src/multitable/permission-service'
import { getObjectSheetId } from '../../src/multitable/provisioning'
import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'
import { STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID } from '../../src/multitable/stock-preparation-overview-contract'
import {
  STOCK_PREPARATION_PROJECT_SHEET_PLUGIN,
  STOCK_PREPARATION_PROJECT_SHEET_REGISTRY_SQL,
  applyStockPreparationProjectSheetSchemaClamp,
  loadStockPreparationProjectSheetIds,
  restrictStockPreparationProjectSheetSchemaCapabilities,
} from '../../src/multitable/stock-preparation-project-sheet-schema-clamp'
import { resolveSheetCapabilitiesForUserOnQuery } from '../../src/services/approval-record-link-txn-auth'
import { isAdmin, listUserPermissions } from '../../src/rbac/service'
import { usePinnedServer } from '../utils/pinned-server'

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

const PROJECT = 'tenant_b_clamp:integration-core'
const PROJECT_OBJECT = `plm_stock_preparation_sandbox_p_${'0a1b2c3d4e5f'.repeat(2)}`
const TWIN_OBJECT = `plm_stock_preparation_sandbox_p_${'f5e4d3c2b1a0'.repeat(2)}`
const PROJECT_SHEET = getObjectSheetId(PROJECT, PROJECT_OBJECT)
/** Same derived shape, NO registry row (a hand-provisioned twin) — must be untouched. */
const TWIN_SHEET = getObjectSheetId(PROJECT, TWIN_OBJECT)
const MAIN_SHEET = getObjectSheetId(PROJECT, 'plm_stock_preparation_main')
const OVERVIEW_SHEET = getObjectSheetId(PROJECT, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)
const OTHER_PLUGIN_SHEET = getObjectSheetId('tenant_b_clamp:after-sales', PROJECT_OBJECT)

type RegistryRow = { sheet_id: string; object_id: string; plugin_name: string }
const REGISTRY: RegistryRow[] = [
  { sheet_id: PROJECT_SHEET, object_id: PROJECT_OBJECT, plugin_name: STOCK_PREPARATION_PROJECT_SHEET_PLUGIN },
  { sheet_id: MAIN_SHEET, object_id: 'plm_stock_preparation_main', plugin_name: STOCK_PREPARATION_PROJECT_SHEET_PLUGIN },
  { sheet_id: OVERVIEW_SHEET, object_id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, plugin_name: STOCK_PREPARATION_PROJECT_SHEET_PLUGIN },
  // A project-shaped object id registered by ANOTHER plugin: the plugin_name filter must exclude it.
  { sheet_id: OTHER_PLUGIN_SHEET, object_id: PROJECT_OBJECT, plugin_name: 'plugin-after-sales' },
]

/** The registry statement, answered like PostgreSQL would (ANY($1) ∧ plugin_name = $2). */
function answerRegistry(params: unknown[]): { rows: unknown[] } {
  const ids = Array.isArray(params[0]) ? (params[0] as string[]) : []
  const plugin = params[1]
  return {
    rows: REGISTRY
      .filter((row) => ids.includes(row.sheet_id) && row.plugin_name === plugin)
      .map(({ sheet_id, object_id }) => ({ sheet_id, object_id })),
  }
}

// ── (a) pure clamp + lookup ──────────────────────────────────────────────────────────────────────

describe('option B — the pure clamp and the lookup', () => {
  const CAPS = {
    canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
    canManageFields: true, canManageViews: true, canComment: true, canSendNotification: true,
    canExport: true, canManageSheetAccess: true, canManageAutomation: true,
  }

  it('off a project sheet, or for a platform admin, the input object is returned untouched', () => {
    expect(restrictStockPreparationProjectSheetSchemaCapabilities(CAPS, false, false)).toBe(CAPS)
    expect(restrictStockPreparationProjectSheetSchemaCapabilities(CAPS, true, true)).toBe(CAPS)
  })

  it('on a project sheet for a non-admin ONLY canManageFields / canManageViews become false', () => {
    const out = restrictStockPreparationProjectSheetSchemaCapabilities(CAPS, true, false)
    expect(out).toEqual({ ...CAPS, canManageFields: false, canManageViews: false })
    expect(CAPS.canManageFields).toBe(true)
  })

  it('the lookup: no ids / no derived id → no statement; one statement with the plugin; object-id shape decides in memory', async () => {
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      expect(normalize(sql)).toBe(STOCK_PREPARATION_PROJECT_SHEET_REGISTRY_SQL)
      return answerRegistry(params)
    })
    expect(await loadStockPreparationProjectSheetIds(query, [])).toEqual(new Set())
    expect(await loadStockPreparationProjectSheetIds(query, ['sheet_plain', 'sheet_orders', 42, null])).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
    const ids = await loadStockPreparationProjectSheetIds(query, [PROJECT_SHEET, TWIN_SHEET, MAIN_SHEET, OVERVIEW_SHEET, OTHER_PLUGIN_SHEET, 'sheet_plain'])
    expect(Array.from(ids)).toEqual([PROJECT_SHEET])
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual([[PROJECT_SHEET, TWIN_SHEET, MAIN_SHEET, OVERVIEW_SHEET, OTHER_PLUGIN_SHEET], 'plugin-integration-core'])
  })

  it('the resolvers\' helper asks nothing for an admin and propagates a registry error for everyone else', async () => {
    const failing = vi.fn(async () => { throw new Error('registry unavailable') })
    await expect(applyStockPreparationProjectSheetSchemaClamp(failing, PROJECT_SHEET, CAPS, true)).resolves.toEqual({ capabilities: CAPS, clamped: false })
    expect(failing).not.toHaveBeenCalled()
    await expect(applyStockPreparationProjectSheetSchemaClamp(failing, PROJECT_SHEET, CAPS, false)).rejects.toThrow('registry unavailable')
  })
})

// ── (b) three-resolver parity ────────────────────────────────────────────────────────────────────

type Premise = { sheetCodes?: string[]; registryFails?: boolean }

/** Answers every statement the three resolvers issue for one sheet. */
function resolverQuery(sheetId: string, premise: Premise): QueryFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (sql: string, params: unknown[] = []) => {
    const q = normalize(sql)
    if (q === STOCK_PREPARATION_PROJECT_SHEET_REGISTRY_SQL) {
      if (premise.registryFails) throw new Error('registry unavailable')
      return answerRegistry(params)
    }
    if (q === 'SELECT deleted_at FROM meta_sheets WHERE id = $1') return { rows: [{ deleted_at: null }] }
    if (q.includes('FROM spreadsheet_permissions')) {
      return { rows: (premise.sheetCodes ?? []).map((code) => ({ sheet_id: sheetId, perm_code: code, subject_type: 'role' })) }
    }
    return { rows: [] }
  }) as never
}

const accessOf = (permissions: string[], isAdminRole: boolean): ResolvedRequestAccess => ({
  userId: 'u_b_clamp',
  permissions,
  isAdminRole,
})

type Person = { label: string; permissions: string[]; isAdminRole: boolean; sheetCodes: string[] }
const CLAMPED_PERSONS: Person[] = [
  { label: 'the floor role holding only the G1 spreadsheet:write sheet grant', permissions: [], isAdminRole: false, sheetCodes: ['spreadsheet:write'] },
  { label: 'a global multitable:write + multitable:manage-schema holder', permissions: ['multitable:read', 'multitable:write', MULTITABLE_MANAGE_SCHEMA_PERMISSION], isAdminRole: false, sheetCodes: [] },
  { label: 'a sheet-level spreadsheet:admin grant holder', permissions: [], isAdminRole: false, sheetCodes: ['spreadsheet:admin'] },
]
const ADMIN: Person = { label: 'a platform admin', permissions: [], isAdminRole: true, sheetCodes: [] }

type Resolved = { capabilities: Record<string, unknown>; marker: boolean }
type Resolver = { name: string; run: (sheetId: string, person: Person, premise?: Premise) => Promise<Resolved> }

const RESOLVERS: Resolver[] = [
  {
    name: 'resolveSheetCapabilitiesForAccess (REST, /context)',
    run: async (sheetId, person, premise = {}) => {
      const r = await resolveSheetCapabilitiesForAccess(resolverQuery(sheetId, { sheetCodes: person.sheetCodes, ...premise }), sheetId, accessOf(person.permissions, person.isAdminRole))
      return { capabilities: r.capabilities as unknown as Record<string, unknown>, marker: r.stockPrepProjectSheetSchemaClamped === true }
    },
  },
  {
    name: 'resolveSheetCapabilitiesForUser (Yjs / collab / API token)',
    run: async (sheetId, person, premise = {}) => {
      vi.mocked(isAdmin).mockResolvedValue(person.isAdminRole)
      vi.mocked(listUserPermissions).mockResolvedValue(person.permissions)
      const r = await resolveSheetCapabilitiesForUser(resolverQuery(sheetId, { sheetCodes: person.sheetCodes, ...premise }) as never, sheetId, 'u_b_clamp')
      return { capabilities: r.capabilities as unknown as Record<string, unknown>, marker: r.stockPrepProjectSheetSchemaClamped === true }
    },
  },
  {
    name: 'resolveSheetCapabilitiesForUserOnQuery (automation FWB / record-permission routes)',
    run: async (sheetId, person, premise = {}) => {
      const r = await resolveSheetCapabilitiesForUserOnQuery(
        resolverQuery(sheetId, { sheetCodes: person.sheetCodes, ...premise }),
        sheetId,
        'u_b_clamp',
        undefined,
        { isAdminRole: person.isAdminRole, permissions: person.permissions },
      )
      return { capabilities: r.capabilities as unknown as Record<string, unknown>, marker: r.stockPrepProjectSheetSchemaClamped === true }
    },
  },
]

function expectOnlySchemaBitsRemoved(clamped: Record<string, unknown>, plain: Record<string, unknown>) {
  expect(plain.canManageFields).toBe(true)
  expect(plain.canManageViews).toBe(true)
  expect(clamped.canManageFields).toBe(false)
  expect(clamped.canManageViews).toBe(false)
  for (const [key, value] of Object.entries(plain)) {
    if (key === 'canManageFields' || key === 'canManageViews') continue
    expect(clamped[key], key).toBe(value)
  }
  expect(Object.keys(clamped).sort()).toEqual(Object.keys(plain).sort())
}

describe('option B — every non-admin loses field / view management on a registered project sheet, through all three resolvers', () => {
  beforeEach(() => {
    vi.mocked(isAdmin).mockReset()
    vi.mocked(listUserPermissions).mockReset()
  })

  for (const resolver of RESOLVERS) {
    for (const person of CLAMPED_PERSONS) {
      it(`${resolver.name}: ${person.label}`, async () => {
        // Control first: the SAME person on the unregistered derived twin keeps both bits.
        const plain = await resolver.run(TWIN_SHEET, person)
        expect(plain.marker).toBe(false)
        expect(plain.capabilities).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true })
        const project = await resolver.run(PROJECT_SHEET, person)
        expectOnlySchemaBitsRemoved(project.capabilities, plain.capabilities)
        expect(project.marker).toBe(true)
      })
    }

    it(`${resolver.name}: a platform admin keeps everything, with no marker`, async () => {
      const plain = await resolver.run(TWIN_SHEET, ADMIN)
      const project = await resolver.run(PROJECT_SHEET, ADMIN)
      expect(project.capabilities).toEqual(plain.capabilities)
      expect(project.capabilities.canManageFields).toBe(true)
      expect(project.capabilities.canManageViews).toBe(true)
      expect(project.marker).toBe(false)
    })

    it(`${resolver.name}: the canonical main table and another plugin's project-shaped registration are untouched`, async () => {
      const person = CLAMPED_PERSONS[0]!
      for (const sheetId of [MAIN_SHEET, OTHER_PLUGIN_SHEET]) {
        const resolved = await resolver.run(sheetId, person)
        expect(resolved.capabilities.canManageFields, sheetId).toBe(true)
        expect(resolved.capabilities.canManageViews, sheetId).toBe(true)
        expect(resolved.marker, sheetId).toBe(false)
      }
    })

    it(`${resolver.name}: a registry error propagates for a non-admin (fail the request, never resolve open)`, async () => {
      await expect(resolver.run(PROJECT_SHEET, CLAMPED_PERSONS[0]!, { registryFails: true })).rejects.toThrow('registry unavailable')
    })
  }

  it('the overview object id is not a project sheet: its own clamp decides there, this one adds no marker', async () => {
    const resolved = await RESOLVERS[0]!.run(OVERVIEW_SHEET, CLAMPED_PERSONS[1]!)
    expect(resolved.marker).toBe(false)
  })

  it('a non-derived id costs NO registry statement in any resolver, and an admin costs none anywhere', async () => {
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(listUserPermissions).mockResolvedValue(CLAMPED_PERSONS[1]!.permissions)
    for (const sheetId of ['sheet_plain', 'sheet_orders']) {
      const q1 = resolverQuery(sheetId, {})
      await resolveSheetCapabilitiesForAccess(q1, sheetId, accessOf(CLAMPED_PERSONS[1]!.permissions, false))
      const q2 = resolverQuery(sheetId, {})
      await resolveSheetCapabilitiesForUser(q2 as never, sheetId, 'u_b_clamp')
      const q3 = resolverQuery(sheetId, {})
      await resolveSheetCapabilitiesForUserOnQuery(q3, sheetId, 'u_b_clamp', undefined, { isAdminRole: false, permissions: CLAMPED_PERSONS[1]!.permissions })
      for (const q of [q1, q2, q3]) {
        expect(q.mock.calls.filter(([sql]) => /plugin_multitable_object_registry/.test(sql as string)), sheetId).toEqual([])
      }
    }
    const qa = resolverQuery(PROJECT_SHEET, {})
    await resolveSheetCapabilitiesForAccess(qa, PROJECT_SHEET, accessOf([], true))
    expect(qa.mock.calls.filter(([sql]) => /plugin_multitable_object_registry/.test(sql as string))).toEqual([])
  })
})

// ── (c) route matrix ─────────────────────────────────────────────────────────────────────────────

const BASE_ID = 'base_b_clamp'
const TARGET_USER = 'u_b_clamp_target'
const FIELD_OF: Record<string, string> = { [PROJECT_SHEET]: 'fld_b_clamp_project', [TWIN_SHEET]: 'fld_b_clamp_twin' }
const VIEW_OF: Record<string, string> = { [PROJECT_SHEET]: 'view_b_clamp_project', [TWIN_SHEET]: 'view_b_clamp_twin' }
const FORBIDDEN_CODE = 'FORBIDDEN'

type RouteActor = 'floor' | 'schema' | 'admin'
const ROUTE_USER: Record<RouteActor, { id: string; roles: string[]; perms: string[]; sheetCodes: string[] }> = {
  // No global code at all: the G1 sheet grant (role row) is what opens the sheet — perms resolve to [] from rbac.
  floor: { id: 'u_b_clamp_floor', roles: ['member'], perms: [], sheetCodes: ['spreadsheet:write'] },
  schema: { id: 'u_b_clamp_schema', roles: ['member'], perms: ['multitable:read', 'multitable:write', MULTITABLE_MANAGE_SCHEMA_PERMISSION], sheetCodes: [] },
  admin: { id: 'u_b_clamp_admin', roles: ['admin'], perms: [], sheetCodes: [] },
}

function createRoutePool(actor: RouteActor) {
  const user = ROUTE_USER[actor]
  const sheetRow = (id: string) => ({ id, base_id: BASE_ID, name: `Sheet ${id === PROJECT_SHEET ? 'P' : 'T'}`, description: null, deleted_at: null })
  const fieldRow = (sheetId: string) => ({ id: FIELD_OF[sheetId]!, sheet_id: sheetId, name: 'Note', type: 'string', property: {}, order: 0 })
  const viewRow = (sheetId: string) => ({
    id: VIEW_OF[sheetId]!, sheet_id: sheetId, name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {},
  })
  const sheetOfField = (id: string) => Object.keys(FIELD_OF).find((s) => FIELD_OF[s] === id)
  const sheetOfView = (id: string) => Object.keys(VIEW_OF).find((s) => VIEW_OF[s] === id)
  const created = new Map<string, Record<string, unknown>>()

  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount?: number }> => {
    const q = normalize(sql)
    const p = (i: number) => String(params[i] ?? '')
    if (q === STOCK_PREPARATION_PROJECT_SHEET_REGISTRY_SQL) return answerRegistry(params)
    // The plugin-managed probes (sheet-delete guard / managed-field guard): only the project sheet is registered.
    if (q.includes('FROM plugin_multitable_object_registry')) return { rows: p(0) === PROJECT_SHEET ? [{ '?column?': 1 }] : [] }
    if (q.includes('FROM spreadsheet_permissions')) {
      const ids = Array.isArray(params[1]) ? (params[1] as string[]) : [p(0)]
      return { rows: ids.flatMap((sheetId) => user.sheetCodes.map((code) => ({ sheet_id: sheetId, perm_code: code, subject_type: 'role' }))) }
    }
    if (q.includes('FROM field_permissions') || q.includes('FROM record_permissions') || q.includes('FROM meta_view_permissions')) return { rows: [] }
    if (q.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(q)) return { rows: [] }
    if (q === 'SELECT deleted_at FROM meta_sheets WHERE id = $1') {
      return { rows: [PROJECT_SHEET, TWIN_SHEET].includes(p(0)) ? [{ deleted_at: null }] : [] }
    }
    if (q.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return { rows: [PROJECT_SHEET, TWIN_SHEET].includes(p(0)) ? [{ id: p(0) }] : [] }
    }
    if (q.includes('FROM meta_sheets s') && q.includes('LEFT JOIN meta_bases')) {
      return { rows: [PROJECT_SHEET, TWIN_SHEET].includes(p(0)) ? [sheetRow(p(0))] : [] }
    }
    if (q.includes('FROM meta_bases') && q.includes('WHERE id = $1')) {
      return { rows: p(0) === BASE_ID ? [{ id: BASE_ID, name: 'B', icon: 'table', color: '#1677ff', owner_id: 'owner_x', workspace_id: 'ws_x' }] : [] }
    }
    if (/^UPDATE meta_sheets\b/i.test(q)) return { rows: [PROJECT_SHEET, TWIN_SHEET].includes(p(0)) ? [{ ...sheetRow(p(0)), name: p(1) }] : [], rowCount: 1 }
    if (q.includes('FROM meta_sheets') && q.includes('WHERE base_id = $1')) return { rows: [sheetRow(PROJECT_SHEET), sheetRow(TWIN_SHEET)] }
    if (/FROM meta_sheets\b/.test(q) && q.includes('WHERE id = $1')) {
      return { rows: [PROJECT_SHEET, TWIN_SHEET].includes(p(0)) ? [sheetRow(p(0))] : [] }
    }
    if (q.includes('FROM meta_views') && q.includes('WHERE id = $1')) {
      const sheetId = sheetOfView(p(0))
      return { rows: sheetId ? [viewRow(sheetId)] : [] }
    }
    if (q.includes('FROM meta_fields') && q.includes('WHERE id = $1')) {
      const createdRow = created.get(p(0))
      if (createdRow) return { rows: [{ ...createdRow }] }
      const sheetId = sheetOfField(p(0))
      if (!sheetId) return { rows: [] }
      if (q.includes('sheet_id = $2') && p(1) !== sheetId) return { rows: [] }
      return { rows: [fieldRow(sheetId)] }
    }
    if (q.includes('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields')) return { rows: [{ max_order: 0 }] }
    if (q.includes('FROM meta_fields') && q.includes('WHERE sheet_id = $1')) {
      return { rows: FIELD_OF[p(0)] ? [fieldRow(p(0))] : [] }
    }
    if (/^INSERT INTO meta_fields\b/i.test(q)) {
      const [id, sheetId, name, type, , order] = params as [string, string, string, string, string, number]
      created.set(id, { id, sheet_id: sheetId, name, type, property: {}, order })
      return { rows: [{ id, name, type, property: {}, order }] }
    }
    if (/^UPDATE meta_fields\b/i.test(q)) {
      const sheetId = sheetOfField(p(0))
      return { rows: sheetId ? [{ ...fieldRow(sheetId), name: p(1) }] : [] }
    }
    if (/^INSERT INTO meta_views\b/i.test(q)) return { rows: [{ ...viewRow(TWIN_SHEET), id: p(0), sheet_id: p(1), name: p(2) }], rowCount: 1 }
    if (/^UPDATE meta_views\b/i.test(q)) {
      const sheetId = sheetOfView(p(0)) ?? TWIN_SHEET
      return { rows: [viewRow(sheetId)], rowCount: 1 }
    }
    if (q.includes('FROM users') && q.includes('WHERE id = $1')) return { rows: p(0) === TARGET_USER ? [{ id: TARGET_USER }] : [] }
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

let lastRoutePool: ReturnType<typeof createRoutePool> | null = null

/** Every INSERT the seed path can issue (createSeededSheet writes meta_sheets / meta_fields / meta_records). */
function seedInserts(): string[] {
  return (lastRoutePool?.query.mock.calls ?? [])
    .map(([sql]) => normalize(String(sql)))
    .filter((q) => /^INSERT INTO meta_(sheets|fields|records)\b/i.test(q))
}

async function buildRouteApp(actor: RouteActor): Promise<Express> {
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  lastRoutePool = createRoutePool(actor)
  vi.spyOn(poolManager, 'get').mockReturnValue(lastRoutePool as never)
  const app = express()
  app.use(express.json())
  const { sheetCodes: _sheetCodes, ...user } = ROUTE_USER[actor]
  app.use((req, _res, next) => {
    ;(req as unknown as { user: unknown }).user = { ...user }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const pinned = usePinnedServer()
function on(app: Express) {
  pinned.setApp(app)
  return request(pinned.url())
}

/** `ok` = the exact success status the route answers once past its capability gate (this mock pool). */
type RouteCell = { key: string; label: string; ok: number; send: (app: Express, sheetId: string) => request.Test }
const ROUTES: RouteCell[] = [
  { key: 'F1', ok: 201, label: 'POST /fields', send: (app, s) => on(app).post('/api/multitable/fields').send({ sheetId: s, name: 'New column', type: 'string' }) },
  { key: 'F2', ok: 200, label: 'PATCH /fields/:fieldId', send: (app, s) => on(app).patch(`/api/multitable/fields/${FIELD_OF[s]}`).send({ name: 'Renamed' }) },
  { key: 'F3', ok: 200, label: 'PUT /sheets/:sheetId/field-permissions/…', send: (app, s) => on(app).put(`/api/multitable/sheets/${s}/field-permissions/${FIELD_OF[s]}/user/${TARGET_USER}`).send({ readOnly: true }) },
  { key: 'S1', ok: 200, label: 'PATCH /sheets/:sheetId (rename)', send: (app, s) => on(app).patch(`/api/multitable/sheets/${s}`).send({ name: 'Renamed sheet' }) },
  { key: 'V1', ok: 201, label: 'POST /views', send: (app, s) => on(app).post('/api/multitable/views').send({ sheetId: s, name: 'My view' }) },
  { key: 'V2', ok: 200, label: 'PATCH /views/:viewId', send: (app, s) => on(app).patch(`/api/multitable/views/${VIEW_OF[s]}`).send({ name: 'Renamed view' }) },
  { key: 'V3', ok: 200, label: 'DELETE /views/:viewId', send: (app, s) => on(app).delete(`/api/multitable/views/${VIEW_OF[s]}`) },
  { key: 'V4', ok: 200, label: 'PUT /views/:viewId/permissions/…', send: (app, s) => on(app).put(`/api/multitable/views/${VIEW_OF[s]}/permissions/user/${TARGET_USER}`).send({ permission: 'read' }) },
]

const isForbidden = (res: request.Response) => res.status === 403 && res.body?.error?.code === FORBIDDEN_CODE

describe('option B — route matrix (mock pool, pinned server)', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  for (const route of ROUTES) {
    for (const actor of ['floor', 'schema'] as const) {
      it(`${route.key} ${route.label}: ${actor} is refused on the project sheet and passes the gate on the unregistered twin`, async () => {
        const app = await buildRouteApp(actor)
        const twin = await route.send(app, TWIN_SHEET)
        expect(isForbidden(twin), `twin ${twin.status} ${JSON.stringify(twin.body)}`).toBe(false)
        expect(twin.status, `twin ${JSON.stringify(twin.body)}`).toBe(route.ok)
        const project = await route.send(app, PROJECT_SHEET)
        expect(project.status, JSON.stringify(project.body)).toBe(403)
        expect(project.body?.error?.code).toBe(FORBIDDEN_CODE)
      })
    }

    it(`${route.key} ${route.label}: a platform admin passes the gate on the project sheet exactly as on the twin`, async () => {
      const app = await buildRouteApp('admin')
      const twin = await route.send(app, TWIN_SHEET)
      const project = await route.send(app, PROJECT_SHEET)
      expect(isForbidden(project), `project ${project.status} ${JSON.stringify(project.body)}`).toBe(false)
      expect(twin.status, `twin ${JSON.stringify(twin.body)}`).toBe(route.ok)
      expect(project.status, `project ${JSON.stringify(project.body)}`).toBe(route.ok)
    })
  }

  it('GET /context: the floor keeps the record plane on the project sheet and loses only field / view management', async () => {
    const app = await buildRouteApp('floor')
    const twin = await on(app).get(`/api/multitable/context?sheetId=${TWIN_SHEET}`)
    const project = await on(app).get(`/api/multitable/context?sheetId=${PROJECT_SHEET}`)
    expect(twin.status, JSON.stringify(twin.body)).toBe(200)
    expect(project.status, JSON.stringify(project.body)).toBe(200)
    const plain = twin.body.data.capabilities as Record<string, unknown>
    const clamped = project.body.data.capabilities as Record<string, unknown>
    expect(plain).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true, canManageViews: true })
    expect(clamped).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: false, canManageViews: false })
    for (const [key, value] of Object.entries(plain)) {
      if (key === 'canManageFields' || key === 'canManageViews') continue
      expect(clamped[key], key).toEqual(value)
    }
  })

  // GET /view?seed=true on a LIVE sheet runs createSeededSheet (six fresh-id fields + five demo records). Its
  // only gate used to be canRead, so a reader whose field management is clamped could still add columns and
  // rows to the project sheet. A live re-seed now needs canManageFields && canCreateRecord.
  for (const actor of ['floor', 'schema'] as const) {
    it(`SEED GET /view?seed=true: ${actor} reads the live project sheet but seeds nothing; on the unregistered twin the seed still runs`, async () => {
      const project = await on(await buildRouteApp(actor)).get('/api/multitable/view').query({ sheetId: PROJECT_SHEET, seed: 'true' })
      expect(project.status, JSON.stringify(project.body)).toBe(200)
      expect(seedInserts()).toEqual([])

      vi.resetModules()
      const twin = await on(await buildRouteApp(actor)).get('/api/multitable/view').query({ sheetId: TWIN_SHEET, seed: 'true' })
      expect(twin.status, JSON.stringify(twin.body)).toBe(200)
      expect(seedInserts().some((q) => q.startsWith('INSERT INTO meta_fields'))).toBe(true)
      expect(seedInserts().some((q) => q.startsWith('INSERT INTO meta_records'))).toBe(true)
    })
  }

  it('SEED GET /view?seed=true: a platform admin keeps the live re-seed on the project sheet', async () => {
    const project = await on(await buildRouteApp('admin')).get('/api/multitable/view').query({ sheetId: PROJECT_SHEET, seed: 'true' })
    expect(project.status, JSON.stringify(project.body)).toBe(200)
    expect(seedInserts().some((q) => q.startsWith('INSERT INTO meta_fields'))).toBe(true)
  })
})
