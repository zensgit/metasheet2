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
 *       `GET /view?seed=true` on the live project sheet reads but writes no field / record for a clamped person;
 *   (d) R-66 ③ (owner 2026-10-29, R78): 备料主管理员 — `stock-prep:admin` in the effective codes AND held through a
 *       role — keeps the RESOLVED canManageViews on the project sheet (never raised: no grant → still false) and
 *       loses canManageFields like everyone else, in all three resolvers; a direct grant, a `stock-prep:*` wildcard
 *       and the puller codes stay clamped; ordinary sheets are byte-identical and cost no role statement; the view
 *       routes pass and the field / sheet-rename / field-permission routes and the live re-seed stay refused.
 */
import { createRequire } from 'node:module'
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
  STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE,
  STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_NAMESPACE,
  STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL,
  applyStockPreparationProjectSheetSchemaClamp,
  holdsStockPreparationProjectSheetViewManagement,
  loadStockPreparationProjectSheetIds,
  restrictStockPreparationProjectSheetSchemaCapabilities,
} from '../../src/multitable/stock-preparation-project-sheet-schema-clamp'
import { STOCK_PREP_ADMIN_CODE } from '../../src/services/stock-preparation-members'
import { STOCK_PREP_ROLE_TEMPLATES } from '../../src/db/migrations/zzzz20261010124500_seed_stock_prep_role_templates'
import { resolveSheetCapabilitiesForUserOnQuery } from '../../src/services/approval-record-link-txn-auth'
import { isAdmin, listUserPermissions } from '../../src/rbac/service'
import { derivePermissionNamespace } from '../../src/rbac/namespace-admission'
import { usePinnedServer } from '../utils/pinned-server'

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

// R-66 ③: the plugin's own ladder, required live so the code pin below cannot drift from it.
const PLUGIN_WORKBENCH_ACCESS = createRequire(import.meta.url)('../../../../plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs') as {
  STOCK_PREP_PERMISSION_CODES: readonly string[]
  satisfiesStockPrepAccess: (permissions: string[], code: string) => boolean
}

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

const NO_ACTOR = { userId: 'u_b_clamp', permissions: [] as string[] }

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
    await expect(applyStockPreparationProjectSheetSchemaClamp(failing, PROJECT_SHEET, CAPS, true, NO_ACTOR)).resolves.toEqual({ capabilities: CAPS, clamped: false })
    expect(failing).not.toHaveBeenCalled()
    await expect(applyStockPreparationProjectSheetSchemaClamp(failing, PROJECT_SHEET, CAPS, false, NO_ACTOR)).rejects.toThrow('registry unavailable')
  })
})

// ── (b) three-resolver parity ────────────────────────────────────────────────────────────────────

type Premise = { sheetCodes?: string[]; registryFails?: boolean; roleHeld?: boolean; roleFails?: boolean }

/** Answers every statement the three resolvers issue for one sheet. */
function resolverQuery(sheetId: string, premise: Premise): QueryFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (sql: string, params: unknown[] = []) => {
    const q = normalize(sql)
    if (q === STOCK_PREPARATION_PROJECT_SHEET_REGISTRY_SQL) {
      if (premise.registryFails) throw new Error('registry unavailable')
      return answerRegistry(params)
    }
    if (q === STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL) {
      if (premise.roleFails) throw new Error('role lookup unavailable')
      return { rows: premise.roleHeld === true && params[1] === 'stock-prep:admin' && params[2] === 'stock-prep' ? [{ '?column?': 1 }] : [] }
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

type Person = { label: string; permissions: string[]; isAdminRole: boolean; sheetCodes: string[]; roleHeld?: boolean }
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
      const r = await resolveSheetCapabilitiesForAccess(resolverQuery(sheetId, { sheetCodes: person.sheetCodes, roleHeld: person.roleHeld, ...premise }), sheetId, accessOf(person.permissions, person.isAdminRole))
      return { capabilities: r.capabilities as unknown as Record<string, unknown>, marker: r.stockPrepProjectSheetSchemaClamped === true }
    },
  },
  {
    name: 'resolveSheetCapabilitiesForUser (Yjs / collab / API token)',
    run: async (sheetId, person, premise = {}) => {
      vi.mocked(isAdmin).mockResolvedValue(person.isAdminRole)
      vi.mocked(listUserPermissions).mockResolvedValue(person.permissions)
      const r = await resolveSheetCapabilitiesForUser(resolverQuery(sheetId, { sheetCodes: person.sheetCodes, roleHeld: person.roleHeld, ...premise }) as never, sheetId, 'u_b_clamp')
      return { capabilities: r.capabilities as unknown as Record<string, unknown>, marker: r.stockPrepProjectSheetSchemaClamped === true }
    },
  },
  {
    name: 'resolveSheetCapabilitiesForUserOnQuery (automation FWB / record-permission routes)',
    run: async (sheetId, person, premise = {}) => {
      const r = await resolveSheetCapabilitiesForUserOnQuery(
        resolverQuery(sheetId, { sheetCodes: person.sheetCodes, roleHeld: person.roleHeld, ...premise }),
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

type RouteActor = 'floor' | 'schema' | 'admin' | 'spadmin' | 'spadminDirect'
const ROUTE_USER: Record<RouteActor, { id: string; roles: string[]; perms: string[]; sheetCodes: string[]; roleHeld?: boolean }> = {
  // No global code at all: the G1 sheet grant (role row) is what opens the sheet — perms resolve to [] from rbac.
  floor: { id: 'u_b_clamp_floor', roles: ['member'], perms: [], sheetCodes: ['spreadsheet:write'] },
  schema: { id: 'u_b_clamp_schema', roles: ['member'], perms: ['multitable:read', 'multitable:write', MULTITABLE_MANAGE_SCHEMA_PERMISSION], sheetCodes: [] },
  admin: { id: 'u_b_clamp_admin', roles: ['admin'], perms: [], sheetCodes: [] },
  // R-66 ③: 备料主管理员 — `stock-prep:admin` held through a role (the stock-prep_admin template) plus the G1 grant.
  spadmin: { id: 'u_b_clamp_spadmin', roles: ['member'], perms: ['stock-prep:admin'], sheetCodes: ['spreadsheet:write'], roleHeld: true },
  // The same effective code and G1 grant, but NOT from a role (a direct user_permissions row): clamped like the floor.
  spadminDirect: { id: 'u_b_clamp_spadmin_direct', roles: ['member'], perms: ['stock-prep:admin'], sheetCodes: ['spreadsheet:write'], roleHeld: false },
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
    if (q === STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL) {
      return { rows: user.roleHeld === true && p(0) === user.id && p(1) === 'stock-prep:admin' && p(2) === 'stock-prep' ? [{ '?column?': 1 }] : [] }
    }
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
  const { sheetCodes: _sheetCodes, roleHeld: _roleHeld, ...user } = ROUTE_USER[actor]
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
    for (const actor of ['floor', 'schema', 'spadminDirect'] as const) {
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
  for (const actor of ['floor', 'schema', 'spadmin', 'spadminDirect'] as const) {
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

// ── (d) R-66 ③ (owner 2026-10-29, R78): 备料主管理员 manages VIEWS (not fields) on a registered project sheet ──

describe('R-66 ③ — the pure rule, the code pin and the role condition', () => {
  const CAPS = {
    canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true,
    canManageFields: true, canManageViews: true, canComment: true, canSendNotification: true,
    canExport: true, canManageSheetAccess: true, canManageAutomation: true,
  }

  it('the code is byte-equal to the members port, the plugin ladder and the 备料主管理员 role template', () => {
    expect(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE).toBe('stock-prep:admin')
    expect(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE).toBe(STOCK_PREP_ADMIN_CODE)
    const template = STOCK_PREP_ROLE_TEMPLATES.find((t) => t.id === 'stock-prep_admin')
    expect(template?.name).toBe('备料主管理员')
    expect(template?.permissions).toEqual([STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE])
    expect(PLUGIN_WORKBENCH_ACCESS.STOCK_PREP_PERMISSION_CODES).toContain(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE)
    expect(PLUGIN_WORKBENCH_ACCESS.satisfiesStockPrepAccess([STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE], 'stock-prep:admin')).toBe(true)
  })

  it('condition 2 carries the admission rule: the namespace is the helper\'s, the statement needs an ENABLED admission row', () => {
    expect(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_NAMESPACE).toBe('stock-prep')
    expect(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_NAMESPACE).toBe(derivePermissionNamespace(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_CODE))
    const sql = normalize(STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL)
    expect(sql).toContain('FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id')
    expect(sql).toContain('EXISTS (SELECT 1 FROM user_namespace_admissions una WHERE una.user_id = $1 AND una.namespace = $3 AND una.enabled = true)')
    expect(sql).not.toContain('user_permissions')
    expect(sql).not.toContain('users.permissions')
  })

  it('condition 1 is an exact literal: no wildcard, no non-array', () => {
    expect(holdsStockPreparationProjectSheetViewManagement(['stock-prep:admin'])).toBe(true)
    expect(holdsStockPreparationProjectSheetViewManagement(['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'])).toBe(false)
    expect(holdsStockPreparationProjectSheetViewManagement(['stock-prep:*'])).toBe(false)
    expect(holdsStockPreparationProjectSheetViewManagement(['*:*'])).toBe(false)
    expect(holdsStockPreparationProjectSheetViewManagement([' stock-prep:admin'])).toBe(false)
    expect(holdsStockPreparationProjectSheetViewManagement('stock-prep:admin')).toBe(false)
    expect(holdsStockPreparationProjectSheetViewManagement(undefined)).toBe(false)
  })

  it('the pure clamp with keep=true: fields still false, views exactly as resolved — never raised', () => {
    expect(restrictStockPreparationProjectSheetSchemaCapabilities(CAPS, true, false, true)).toEqual({ ...CAPS, canManageFields: false })
    const noViews = { ...CAPS, canManageViews: false }
    expect(restrictStockPreparationProjectSheetSchemaCapabilities(noViews, true, false, true)).toEqual({ ...noViews, canManageFields: false })
    // Only the literal true keeps: a truthy non-boolean does not.
    expect(restrictStockPreparationProjectSheetSchemaCapabilities(CAPS, true, false, 1 as unknown as boolean).canManageViews).toBe(false)
    // Off a project sheet / for an admin: still the same object.
    expect(restrictStockPreparationProjectSheetSchemaCapabilities(CAPS, false, false, true)).toBe(CAPS)
  })

  type Call = [string, unknown[]]
  const helperQuery = (roleRows: unknown[] | Error) => {
    const calls: Call[] = []
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const q = normalize(sql)
      calls.push([q, params])
      if (q === STOCK_PREPARATION_PROJECT_SHEET_REGISTRY_SQL) return answerRegistry(params)
      if (q === STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL) {
        if (roleRows instanceof Error) throw roleRows
        return { rows: roleRows }
      }
      throw new Error(`unexpected statement: ${q}`)
    })
    return { query, calls }
  }
  const roleCalls = (calls: Call[]) => calls.filter(([q]) => q === STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL)

  it('a role-held code keeps the view bit (one role statement, bound to the actor and the literal); fields are false', async () => {
    const { query, calls } = helperQuery([{ '?column?': 1 }])
    const out = await applyStockPreparationProjectSheetSchemaClamp(query, PROJECT_SHEET, CAPS, false, { userId: ' u_sp ', permissions: ['stock-prep:admin'] })
    expect(out).toEqual({ capabilities: { ...CAPS, canManageFields: false }, clamped: true })
    expect(roleCalls(calls)).toEqual([[STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL, ['u_sp', 'stock-prep:admin', 'stock-prep']]])
  })

  it('the code without a role row (a direct grant) keeps nothing', async () => {
    const { query, calls } = helperQuery([])
    const out = await applyStockPreparationProjectSheetSchemaClamp(query, PROJECT_SHEET, CAPS, false, { userId: 'u_sp', permissions: ['stock-prep:admin'] })
    expect(out).toEqual({ capabilities: { ...CAPS, canManageFields: false, canManageViews: false }, clamped: true })
    expect(roleCalls(calls)).toHaveLength(1)
  })

  it('no role statement when there is nothing to keep, no code, a blank actor, an ordinary sheet or an admin', async () => {
    const cases: Array<{ sheetId: string; caps: typeof CAPS; isAdmin: boolean; actor: { userId: string; permissions: string[] } }> = [
      { sheetId: PROJECT_SHEET, caps: { ...CAPS, canManageViews: false }, isAdmin: false, actor: { userId: 'u_sp', permissions: ['stock-prep:admin'] } },
      { sheetId: PROJECT_SHEET, caps: CAPS, isAdmin: false, actor: { userId: 'u_sp', permissions: ['stock-prep:read', 'stock-prep:operate'] } },
      { sheetId: PROJECT_SHEET, caps: CAPS, isAdmin: false, actor: { userId: '  ', permissions: ['stock-prep:admin'] } },
      { sheetId: TWIN_SHEET, caps: CAPS, isAdmin: false, actor: { userId: 'u_sp', permissions: ['stock-prep:admin'] } },
      { sheetId: 'sheet_plain', caps: CAPS, isAdmin: false, actor: { userId: 'u_sp', permissions: ['stock-prep:admin'] } },
      { sheetId: PROJECT_SHEET, caps: CAPS, isAdmin: true, actor: { userId: 'u_sp', permissions: ['stock-prep:admin'] } },
    ]
    for (const c of cases) {
      const { query, calls } = helperQuery(new Error('must not be asked'))
      const out = await applyStockPreparationProjectSheetSchemaClamp(query, c.sheetId, c.caps, c.isAdmin, c.actor)
      expect(roleCalls(calls), JSON.stringify(c)).toEqual([])
      if (c.sheetId === PROJECT_SHEET && !c.isAdmin) expect(out.capabilities.canManageViews, JSON.stringify(c)).toBe(false)
      else expect(out.capabilities, JSON.stringify(c)).toBe(c.caps)
    }
  })

  it('a role-lookup error propagates (fail the request, never keep the bit open)', async () => {
    const { query } = helperQuery(new Error('role lookup unavailable'))
    await expect(applyStockPreparationProjectSheetSchemaClamp(query, PROJECT_SHEET, CAPS, false, { userId: 'u_sp', permissions: ['stock-prep:admin'] }))
      .rejects.toThrow('role lookup unavailable')
  })
})

describe('R-66 ③ — three-resolver parity for 备料主管理员', () => {
  beforeEach(() => {
    vi.mocked(isAdmin).mockReset()
    vi.mocked(listUserPermissions).mockReset()
  })

  const SPADMIN: Person = { label: '备料主管理员 (stock-prep:admin through a role) with the G1 grant', permissions: ['stock-prep:admin'], isAdminRole: false, sheetCodes: ['spreadsheet:write'], roleHeld: true }
  const FLOOR = CLAMPED_PERSONS[0]!
  const OTHERS: Person[] = [
    { label: 'stock-prep:admin as a DIRECT grant (no role row) with the G1 grant', permissions: ['stock-prep:admin'], isAdminRole: false, sheetCodes: ['spreadsheet:write'], roleHeld: false },
    { label: 'a stock-prep:* wildcard holder with a role row and the G1 grant', permissions: ['stock-prep:*'], isAdminRole: false, sheetCodes: ['spreadsheet:write'], roleHeld: true },
    { label: 'the puller codes with a role row and the G1 grant', permissions: ['stock-prep:pull', 'stock-prep:operate', 'stock-prep:read'], isAdminRole: false, sheetCodes: ['spreadsheet:write'], roleHeld: true },
  ]

  for (const resolver of RESOLVERS) {
    it(`${resolver.name}: keeps view management, loses field management, everything else as on the twin`, async () => {
      const plain = await resolver.run(TWIN_SHEET, SPADMIN)
      expect(plain.marker).toBe(false)
      expect(plain.capabilities).toMatchObject({ canManageFields: true, canManageViews: true })
      const project = await resolver.run(PROJECT_SHEET, SPADMIN)
      expect(project.capabilities.canManageViews).toBe(true)
      expect(project.capabilities.canManageFields).toBe(false)
      for (const [key, value] of Object.entries(plain.capabilities)) {
        if (key === 'canManageFields') continue
        expect(project.capabilities[key], key).toBe(value)
      }
      expect(Object.keys(project.capabilities).sort()).toEqual(Object.keys(plain.capabilities).sort())
      expect(project.marker).toBe(true)
    })

    for (const person of OTHERS) {
      it(`${resolver.name}: ${person.label} is clamped like the floor`, async () => {
        const plain = await resolver.run(TWIN_SHEET, person)
        const project = await resolver.run(PROJECT_SHEET, person)
        expectOnlySchemaBitsRemoved(project.capabilities, plain.capabilities)
        expect(project.marker).toBe(true)
      })
    }

    it(`${resolver.name}: without a sheet grant the code raises nothing (views stay false) and asks no role statement`, async () => {
      const noGrant: Person = { ...SPADMIN, sheetCodes: [] }
      const project = await resolver.run(PROJECT_SHEET, noGrant, { roleFails: true })
      expect(project.capabilities.canManageViews).toBe(false)
      expect(project.capabilities.canManageFields).toBe(false)
      expect(project.capabilities.canRead).toBe(false)
    })

    it(`${resolver.name}: a role-lookup error propagates`, async () => {
      await expect(resolver.run(PROJECT_SHEET, SPADMIN, { roleFails: true })).rejects.toThrow('role lookup unavailable')
    })

    it(`${resolver.name}: ordinary sheets are byte-identical to the floor's and cost no role statement`, async () => {
      for (const sheetId of [TWIN_SHEET, MAIN_SHEET, OTHER_PLUGIN_SHEET, 'sheet_plain']) {
        const asFloor = await resolver.run(sheetId, FLOOR)
        const asSpadmin = await resolver.run(sheetId, SPADMIN, { roleFails: true })
        expect(asSpadmin, sheetId).toEqual(asFloor)
      }
    })
  }

  it('the role statement is asked once on the project sheet, with the actor id, in every resolver', async () => {
    const lanes: Array<[string, (q: QueryFn) => Promise<unknown>]> = [
      ['rest', (q) => resolveSheetCapabilitiesForAccess(q, PROJECT_SHEET, accessOf(SPADMIN.permissions, false))],
      ['collab', (q) => resolveSheetCapabilitiesForUser(q as never, PROJECT_SHEET, 'u_b_clamp')],
      ['onQuery', (q) => resolveSheetCapabilitiesForUserOnQuery(q, PROJECT_SHEET, 'u_b_clamp', undefined, { isAdminRole: false, permissions: SPADMIN.permissions })],
    ]
    vi.mocked(isAdmin).mockResolvedValue(false)
    vi.mocked(listUserPermissions).mockResolvedValue(SPADMIN.permissions)
    for (const [lane, run] of lanes) {
      const q = resolverQuery(PROJECT_SHEET, { sheetCodes: SPADMIN.sheetCodes, roleHeld: true })
      await run(q)
      const roleAsks = q.mock.calls.filter(([sql]) => normalize(sql as string) === STOCK_PREPARATION_PROJECT_SHEET_VIEW_MANAGER_ROLE_SQL)
      expect(roleAsks.map(([, params]) => params), lane).toEqual([['u_b_clamp', 'stock-prep:admin', 'stock-prep']])
    }
  })
})

describe('R-66 ③ — route matrix for 备料主管理员 (mock pool, pinned server)', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  const VIEW_ROUTES = new Set(['V1', 'V2', 'V3', 'V4'])
  for (const route of ROUTES) {
    if (VIEW_ROUTES.has(route.key)) {
      it(`${route.key} ${route.label}: 备料主管理员 passes the gate on the project sheet exactly as on the twin`, async () => {
        const app = await buildRouteApp('spadmin')
        const twin = await route.send(app, TWIN_SHEET)
        const project = await route.send(app, PROJECT_SHEET)
        expect(twin.status, `twin ${JSON.stringify(twin.body)}`).toBe(route.ok)
        expect(project.status, `project ${JSON.stringify(project.body)}`).toBe(route.ok)
      })
    } else {
      it(`${route.key} ${route.label}: 备料主管理员 is refused on the project sheet (fields / sheet name stay admin-only) and passes on the twin`, async () => {
        const app = await buildRouteApp('spadmin')
        const twin = await route.send(app, TWIN_SHEET)
        expect(twin.status, `twin ${JSON.stringify(twin.body)}`).toBe(route.ok)
        const project = await route.send(app, PROJECT_SHEET)
        expect(project.status, JSON.stringify(project.body)).toBe(403)
        expect(project.body?.error?.code).toBe(FORBIDDEN_CODE)
      })
    }
  }

  it('GET /context: 备料主管理员 sees canManageViews=true, canManageFields=false on the project sheet; the rest as on the twin', async () => {
    const app = await buildRouteApp('spadmin')
    const twin = await on(app).get(`/api/multitable/context?sheetId=${TWIN_SHEET}`)
    const project = await on(app).get(`/api/multitable/context?sheetId=${PROJECT_SHEET}`)
    expect(twin.status, JSON.stringify(twin.body)).toBe(200)
    expect(project.status, JSON.stringify(project.body)).toBe(200)
    const plain = twin.body.data.capabilities as Record<string, unknown>
    const kept = project.body.data.capabilities as Record<string, unknown>
    expect(plain).toMatchObject({ canManageFields: true, canManageViews: true })
    expect(kept).toMatchObject({ canRead: true, canCreateRecord: true, canManageFields: false, canManageViews: true })
    for (const [key, value] of Object.entries(plain)) {
      if (key === 'canManageFields') continue
      expect(kept[key], key).toEqual(value)
    }
  })
})
