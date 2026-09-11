import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  FIELD_RETYPE_EXCLUDED_TYPES,
  FIELD_RETYPE_NOT_LOSSLESS_CODE,
  isLosslessFieldRetype,
  LOSSLESS_FIELD_RETYPE,
  losslessRetypeTargets,
} from '../../src/multitable/field-retype-whitelist'
import { configRevisionNoop } from './config-revision-mock'

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    // SHEET LIVENESS (soft delete). `resolveSheetCapabilities` now reads `meta_sheets.deleted_at`
    // before any sheet-addressed work, and these fixtures predate that query — they answer only the
    // EXISTENCE form. Rather than enumerate sheet ids here (which would let a fixture drift out of
    // sync with what its own handler declares), translate the liveness read into the existence read
    // each test already answers, so every test keeps EXACTLY its original notion of which sheets are
    // there — including the cases that deliberately declare a sheet ABSENT and expect a 404.
    //
    // A handler that answers neither is treated as live: that is precisely the pre-change behaviour
    // (the routes did not ask), so those tests keep their original intent too.
    if (sql.includes('SELECT deleted_at FROM meta_sheets WHERE id = $1')) {
      try {
        const existing = await queryHandler('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', params)
        const found = (existing?.rows ?? []).length > 0
        return { rows: found ? [{ deleted_at: null }] : [], rowCount: found ? 1 : 0 }
      } catch {
        return { rows: [{ deleted_at: null }], rowCount: 1 }
      }
    }
    if (sql.includes('FROM spreadsheet_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM meta_view_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM field_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM record_permissions')) {
      return { rows: [], rowCount: 0 }
    }
    // ②a §2a write-path guards reached before each per-test handler runs (the
    // sheet/field-create chokepoints): the link-target materialization advisory
    // lock (#2578) and the retroactive-cross-base link scan (#2576,
    // validateSheetCreateNoRetroactiveCrossBaseLink). The mock world has no
    // inbound cross-base link, so both no-op cleanly with empty rows.
    if (sql.includes('pg_advisory_xact_lock')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('source_base_id')) {
      return { rows: [], rowCount: 0 }
    }
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: {
  tokenPerms?: string[]
  tokenRoles?: string[]
  requestPermissions?: string[]
  requestRole?: string
  queryHandler?: QueryHandler
  fallbackPermissions?: string[]
  fallbackHasPermission?: boolean
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockImplementation(async (_userId: string, code: string) => {
      if (code === 'multitable:read' || code === 'multitable:write' || code === 'multitable:share') {
        return args.fallbackHasPermission === true
      }
      return false
    }),
    listUserPermissions: vi.fn().mockResolvedValue(args.fallbackPermissions ?? []),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(args.queryHandler ?? (() => ({ rows: [], rowCount: 0 })))
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'user_multitable_1',
      role: args.requestRole,
      permissions: args.requestPermissions,
      roles: args.tokenRoles ?? [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool }
}

describe('Multitable context API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('returns base, selected sheet, views, and capability set', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'comments:write', 'workflow:execute'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              id: 'sheet_ops',
              base_id: 'base_ops',
              name: 'Orders',
              description: 'Ops records',
            }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: 'table',
              color: '#1677ff',
              owner_id: 'owner_1',
              workspace_id: 'workspace_1',
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [
              { id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' },
              { id: 'sheet_vendors', base_id: 'base_ops', name: 'Vendors', description: null },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
              { id: 'view_form', sheet_id: 'sheet_ops', name: 'Intake Form', type: 'form', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
            ],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
              { id: 'fld_status', name: 'Status', type: 'select', property: { options: [{ value: 'open' }] }, order: 2 },
            ],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.base).toMatchObject({ id: 'base_ops', name: 'Ops Base' })
    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_ops', baseId: 'base_ops', name: 'Orders' })
    expect(response.body.data.sheets).toHaveLength(2)
    expect(response.body.data.views).toHaveLength(2)
    expect(response.body.data.capabilities).toEqual({
      canRead: true,
      canCreateRecord: false,
      canEditRecord: false,
      canDeleteRecord: false,
      canManageFields: false,
      canManageSheetAccess: false,
      canManageViews: false,
      canComment: true,
      canManageAutomation: true,
      canExport: true,
      canSendNotification: false,
      pitResetEnabled: false,
      sheetRevertEnabled: false,
      personalViewsEnabled: false,
      // whole-sheet delete authority (mirrors DELETE /sheets/:sheetId): a reader has none
      canDeleteSheet: false,
    })
    expect(response.body.data.capabilityOrigin).toEqual({
      source: 'global-rbac',
      hasSheetAssignments: false,
    })
    expect(response.body.data.viewPermissions).toEqual({
      view_grid: {
        canAccess: true,
        canConfigure: false,
        canDelete: false,
      },
      view_form: {
        canAccess: true,
        canConfigure: false,
        canDelete: false,
      },
    })
  })

  test('marks computed and explicitly readonly fields as readOnly in scoped field permissions', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_grid'])
          return {
            rows: [{
              id: 'view_grid',
              sheet_id: 'sheet_ops',
              name: 'Grid',
              type: 'grid',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: ['fld_lookup'],
              config: {},
            }],
          }
        }
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              id: 'sheet_ops',
              base_id: 'base_ops',
              name: 'Orders',
              description: 'Ops records',
            }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: 'table',
              color: '#1677ff',
              owner_id: 'owner_1',
              workspace_id: 'workspace_1',
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [
              { id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: ['fld_lookup'], config: {} },
            ],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
              { id: 'fld_formula', name: 'Total', type: 'formula', property: { expression: '{fld_amount} * 2' }, order: 2 },
              { id: 'fld_lookup', name: 'Vendor Name', type: 'lookup', property: { linkFieldId: 'fld_vendor', targetFieldId: 'fld_name' }, order: 3 },
              { id: 'fld_locked', name: 'Locked', type: 'string', property: { readonly: true }, order: 4 },
              { id: 'fld_secret', name: 'Secret', type: 'string', property: { hidden: true }, order: 5 },
            ],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops', viewId: 'view_grid' })
      .expect(200)

    expect(response.body.data.fieldPermissions).toEqual({
      fld_title: { visible: true, readOnly: false },
      fld_formula: { visible: true, readOnly: true },
      fld_lookup: { visible: false, readOnly: true },
      fld_locked: { visible: true, readOnly: true },
      fld_secret: { visible: false, readOnly: false },
    })
  })

  test('derives multitable capabilities from req.user role and permissions when token roles/perms are absent', async () => {
    const { app } = await createApp({
      requestRole: 'admin',
      requestPermissions: ['*:*'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              id: 'sheet_ops',
              base_id: 'base_ops',
              name: 'Orders',
              description: 'Ops records',
            }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: 'table',
              color: '#1677ff',
              owner_id: 'owner_1',
              workspace_id: 'workspace_1',
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [
              { id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: 'Ops records' },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'view_grid', sheet_id: 'sheet_ops', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
            ],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
            ],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.data.capabilities).toEqual({
      canRead: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canManageViews: true,
      canComment: true,
      canManageAutomation: true,
      canExport: true,
      canSendNotification: true,
      pitResetEnabled: false,
      sheetRevertEnabled: false,
      personalViewsEnabled: false,
      // admin role = global schema authority => may delete the selected sheet
      canDeleteSheet: true,
    })
    // Route-level contract lock for the new FE signal: flag ON + sheet-admin → pitResetEnabled true (its only true source).
    // The flag-off cases (false for both admin and non-admin) are locked by the two capabilities exact-matches above.
    process.env.MULTITABLE_ENABLE_PIT_RESET = 'true'
    try {
      const onResp = await request(app).get('/api/multitable/context').query({ sheetId: 'sheet_ops' }).expect(200)
      expect(onResp.body.data.capabilities.pitResetEnabled).toBe(true)
    } finally { delete process.env.MULTITABLE_ENABLE_PIT_RESET }
    // Interim revert-execute master-gate contract lock (current-risk mitigation): SAME pattern as pitResetEnabled —
    // flag ON + sheet-admin → sheetRevertEnabled true (its only true source). Flag-off (false) locked above.
    process.env.MULTITABLE_ENABLE_SHEET_REVERT = 'true'
    try {
      const onResp = await request(app).get('/api/multitable/context').query({ sheetId: 'sheet_ops' }).expect(200)
      expect(onResp.body.data.capabilities.sheetRevertEnabled).toBe(true)
    } finally { delete process.env.MULTITABLE_ENABLE_SHEET_REVERT }
    // Slice 3 contract lock: flag ON → personalViewsEnabled true (available to every reader, presentation-only —
    // NOT ANDed with a management capability, unlike pitResetEnabled). Flag-off (false) locked by the exact-matches above.
    process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS = 'true'
    try {
      const onResp = await request(app).get('/api/multitable/context').query({ sheetId: 'sheet_ops' }).expect(200)
      expect(onResp.body.data.capabilities.personalViewsEnabled).toBe(true)
    } finally { delete process.env.MULTITABLE_ENABLE_PERSONAL_VIEWS }
    expect(response.body.data.viewPermissions).toEqual({
      view_grid: {
        canAccess: true,
        canConfigure: true,
        canDelete: true,
      },
    })
  })

  test('uses the first sheet in a base when only baseId is provided', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: null,
              color: null,
              owner_id: null,
              workspace_id: null,
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          return {
            rows: [
              { id: 'sheet_a', base_id: 'base_ops', name: 'Alpha', description: null },
              { id: 'sheet_b', base_id: 'base_ops', name: 'Beta', description: null },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_a'])
          return {
            rows: [
              { id: 'view_alpha', sheet_id: 'sheet_a', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
            ],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_a'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
            ],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ baseId: 'base_ops' })
      .expect(200)

    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_a', baseId: 'base_ops', name: 'Alpha' })
    expect(response.body.data.views).toEqual([
      expect.objectContaining({ id: 'view_alpha', sheetId: 'sheet_a', type: 'grid' }),
    ])
  })

  test('resolves context by viewId and returns the target view config', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_calendar'])
          return {
            rows: [{
              id: 'view_calendar',
              sheet_id: 'sheet_ops',
              name: 'Calendar',
              type: 'calendar',
              filter_info: { mode: 'upcoming' },
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: { defaultView: 'week', colorRules: [{ field: 'category', value: 'meeting', color: '#00f' }] },
            }],
          }
        }
        if (sql.includes('FROM meta_sheets s') && sql.includes('LEFT JOIN meta_bases')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              id: 'sheet_ops',
              base_id: 'base_ops',
              name: 'Ops',
              description: 'Ops records',
              base_ref_id: 'base_ops',
              base_name: 'Ops Base',
              base_icon: 'table',
              base_color: '#1677ff',
              base_owner_id: 'owner_1',
              base_workspace_id: 'workspace_1',
            }],
          }
        }
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: 'table',
              color: '#1677ff',
              owner_id: 'owner_1',
              workspace_id: 'workspace_1',
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [
              { id: 'sheet_ops', base_id: 'base_ops', name: 'Ops', description: 'Ops records' },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [{
              id: 'view_calendar',
              sheet_id: 'sheet_ops',
              name: 'Calendar',
              type: 'calendar',
              filter_info: { mode: 'upcoming' },
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: { defaultView: 'week', colorRules: [{ field: 'category', value: 'meeting', color: '#00f' }] },
            }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_ops'])
          return {
            rows: [
              { id: 'fld_due_date', name: 'Due Date', type: 'date', property: {}, order: 1 },
            ],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ viewId: 'view_calendar' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_ops', baseId: 'base_ops', name: 'Ops' })
    expect(response.body.data.views).toEqual([
      expect.objectContaining({
        id: 'view_calendar',
        sheetId: 'sheet_ops',
        type: 'calendar',
        config: expect.objectContaining({ defaultView: 'week' }),
      }),
    ])
  })

  test('creates a sheet under the legacy base when baseId is omitted', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('INSERT INTO meta_bases')) {
          expect(params?.[0]).toBe('base_legacy')
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO meta_sheets')) {
          expect(params).toEqual([
            expect.any(String),
            'base_legacy',
            'Vendor Intake',
            'Main vendor list',
          ])
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO meta_views')) {
          return { rows: [], rowCount: 1 }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/sheets')
      .send({ name: 'Vendor Intake', description: 'Main vendor list' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.sheet.baseId).toBe('base_legacy')
    expect(response.body.data.sheet.seeded).toBe(false)
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)
  })

  test('creates a default Grid view so a plain (un-seeded) sheet is immediately openable (#1670)', async () => {
    let viewInsert: unknown[] | undefined
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('INSERT INTO meta_bases')) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO meta_sheets')) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO meta_views')) {
          viewInsert = params
          return { rows: [], rowCount: 1 }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/sheets')
      .send({ name: 'Plain Base Sheet' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.sheet.seeded).toBe(false)
    // The view must be created at sheet-create time. GET /context does not
    // lazily create one (only GET /views does), so without this the base is
    // unopenable: "这个 Base 还没有可打开的 Sheet 或 View。" (#1670)
    expect(viewInsert).toBeDefined()
    const [viewId, sheetId, viewName, viewType, filterInfo, sortInfo, groupInfo, hiddenFieldIds, config] =
      viewInsert as string[]
    expect(typeof viewId).toBe('string')
    expect(viewId.length).toBeGreaterThan(0)
    expect(sheetId).toBe(response.body.data.sheet.id)
    expect(viewName).toBe('默认视图')
    expect(viewType).toBe('grid')
    expect([filterInfo, sortInfo, groupInfo, hiddenFieldIds, config]).toEqual(['{}', '{}', '{}', '[]', '{}'])
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)
  })

  test('lists the built-in multitable template catalog', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async () => ({ rows: [], rowCount: 0 }),
    })

    const response = await request(app)
      .get('/api/multitable/templates')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.templates.map((template: any) => template.id)).toEqual([
      'project-tracker',
      'sales-crm',
      'issue-tracker',
      'contract-management',
      'field-inspection',
      'recruitment',
      'meeting-minutes',
      'asset-inventory',
    ])
  })

  test('installs a built-in template as a new base in one transaction', async () => {
    const bases: any[] = []
    const sheets: any[] = []
    const fields: any[] = []
    const views: any[] = []
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        // S2 conflict pre-check probe (detectTemplateConflicts) — SELECT-only
        // base-id occupancy; sheet/view probes reuse the SELECT handlers below.
        if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_bases') && normalized.includes('WHERE id = $1')) {
          const [baseId] = params as [string]
          return { rows: bases.filter((base) => base.id === baseId).map((base) => ({ id: base.id })) }
        }
        if (normalized.startsWith('INSERT INTO meta_bases')) {
          const [id, name, icon, color, ownerId, workspaceId] = params as [string, string, string, string, string | null, string | null]
          const base = { id, name, icon, color, owner_id: ownerId, workspace_id: workspaceId }
          bases.push(base)
          return { rows: [base], rowCount: 1 }
        }
        if (normalized.startsWith('INSERT INTO meta_sheets')) {
          const [id, baseId, name, description] = params as [string, string, string, string | null]
          sheets.push({ id, base_id: baseId, name, description })
          return { rows: [], rowCount: 1 }
        }
        if (normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
          const [sheetId] = params as [string]
          return { rows: sheets.filter((sheet) => sheet.id === sheetId) }
        }
        if (normalized.startsWith('INSERT INTO meta_fields')) {
          const [id, sheetId, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
          fields.push({ id, sheet_id: sheetId, name, type, property: JSON.parse(propertyJson), order })
          return { rows: [], rowCount: 1 }
        }
        // P0-S S3 destructive-reconcile pre-read. The guard is fail-closed by DEFAULT now, so
        // every ensureFields/ensureObject call issues this SELECT before each upsert; without
        // this branch the fake would fall through to the `Unhandled SQL` throw below.
        // Reads the same in-memory `fields` array the INSERT above writes, so this models the
        // real transaction: a first install sees no row (=> create), and a genuine re-install
        // of a mutated field would still surface the refusal instead of being masked.
        if (
          normalized.includes('FROM meta_fields') &&
          normalized.includes('WHERE id = $1 AND sheet_id = $2')
        ) {
          const [fieldId, ownerSheetId] = params as [string, string]
          return {
            rows: fields.filter((field) => field.id === fieldId && field.sheet_id === ownerSheetId),
          }
        }

        if (normalized.includes('FROM meta_fields') && normalized.includes('id = ANY($2::text[])')) {
          const [sheetId, ids] = params as [string, string[]]
          const idSet = new Set(ids)
          return {
            rows: fields
              .filter((field) => field.sheet_id === sheetId && idSet.has(field.id))
              .sort((a, b) => a.order - b.order),
          }
        }
        if (normalized.startsWith('INSERT INTO meta_views')) {
          const [id, sheetId, name, type, filterInfoJson, sortInfoJson, groupInfoJson, hiddenFieldIdsJson, configJson] = params as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
          ]
          views.push({
            id,
            sheet_id: sheetId,
            name,
            type,
            filter_info: JSON.parse(filterInfoJson),
            sort_info: JSON.parse(sortInfoJson),
            group_info: JSON.parse(groupInfoJson),
            hidden_field_ids: JSON.parse(hiddenFieldIdsJson),
            config: JSON.parse(configJson),
          })
          return { rows: [], rowCount: 1 }
        }
        if (normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
          const [viewId] = params as [string]
          return { rows: views.filter((view) => view.id === viewId) }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(normalized)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/templates/project-tracker/install')
      .send({ baseName: 'Launch Base' })
      .expect(201)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.base.name).toBe('Launch Base')
    expect(response.body.data.template.id).toBe('project-tracker')
    expect(response.body.data.sheets).toHaveLength(1)
    expect(response.body.data.fields).toHaveLength(6)
    expect(response.body.data.views.map((view: any) => view.type)).toEqual(['grid', 'kanban', 'calendar'])
    expect(bases[0].owner_id).toBe('user_multitable_1')
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)
  })

  // H3 key-path smoke: one new (H3) template through the real install API.
  // The full 5-template install matrix lives in the faster unit suite
  // (multitable-template-library.test.ts); this only proves the HTTP path
  // wires a new-template id end-to-end.
  test('installs an H3 template (contract-management) via the install API', async () => {
    const bases: any[] = []
    const sheets: any[] = []
    const fields: any[] = []
    const views: any[] = []
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        // S2 conflict pre-check probe (detectTemplateConflicts) — SELECT-only
        // base-id occupancy; sheet/view probes reuse the SELECT handlers below.
        if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_bases') && normalized.includes('WHERE id = $1')) {
          const [baseId] = params as [string]
          return { rows: bases.filter((base) => base.id === baseId).map((base) => ({ id: base.id })) }
        }
        if (normalized.startsWith('INSERT INTO meta_bases')) {
          const [id, name, icon, color, ownerId, workspaceId] = params as [string, string, string, string, string | null, string | null]
          const base = { id, name, icon, color, owner_id: ownerId, workspace_id: workspaceId }
          bases.push(base)
          return { rows: [base], rowCount: 1 }
        }
        if (normalized.startsWith('INSERT INTO meta_sheets')) {
          const [id, baseId, name, description] = params as [string, string, string, string | null]
          sheets.push({ id, base_id: baseId, name, description })
          return { rows: [], rowCount: 1 }
        }
        if (normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
          const [sheetId] = params as [string]
          return { rows: sheets.filter((sheet) => sheet.id === sheetId) }
        }
        if (normalized.startsWith('INSERT INTO meta_fields')) {
          const [id, sheetId, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
          fields.push({ id, sheet_id: sheetId, name, type, property: JSON.parse(propertyJson), order })
          return { rows: [], rowCount: 1 }
        }
        // P0-S S3 destructive-reconcile pre-read. The guard is fail-closed by DEFAULT now, so
        // every ensureFields/ensureObject call issues this SELECT before each upsert; without
        // this branch the fake would fall through to the `Unhandled SQL` throw below.
        // Reads the same in-memory `fields` array the INSERT above writes, so this models the
        // real transaction: a first install sees no row (=> create), and a genuine re-install
        // of a mutated field would still surface the refusal instead of being masked.
        if (
          normalized.includes('FROM meta_fields') &&
          normalized.includes('WHERE id = $1 AND sheet_id = $2')
        ) {
          const [fieldId, ownerSheetId] = params as [string, string]
          return {
            rows: fields.filter((field) => field.id === fieldId && field.sheet_id === ownerSheetId),
          }
        }

        if (normalized.includes('FROM meta_fields') && normalized.includes('id = ANY($2::text[])')) {
          const [sheetId, ids] = params as [string, string[]]
          const idSet = new Set(ids)
          return {
            rows: fields
              .filter((field) => field.sheet_id === sheetId && idSet.has(field.id))
              .sort((a, b) => a.order - b.order),
          }
        }
        if (normalized.startsWith('INSERT INTO meta_views')) {
          const [id, sheetId, name, type, filterInfoJson, sortInfoJson, groupInfoJson, hiddenFieldIdsJson, configJson] = params as [
            string, string, string, string, string, string, string, string, string,
          ]
          views.push({
            id,
            sheet_id: sheetId,
            name,
            type,
            filter_info: JSON.parse(filterInfoJson),
            sort_info: JSON.parse(sortInfoJson),
            group_info: JSON.parse(groupInfoJson),
            hidden_field_ids: JSON.parse(hiddenFieldIdsJson),
            config: JSON.parse(configJson),
          })
          return { rows: [], rowCount: 1 }
        }
        if (normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
          const [viewId] = params as [string]
          return { rows: views.filter((view) => view.id === viewId) }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(normalized)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    // createApp() already ran vi.resetModules() + imported univer-meta, so
    // importing core/logger now returns the same post-reset module instance
    // the route's templateInstallLogger was constructed from. A prototype spy
    // installed after construction still intercepts (info() resolves via the
    // prototype at call time).
    const { Logger } = await import('../../src/core/logger')
    const infoSpy = vi.spyOn(Logger.prototype, 'info')

    const response = await request(app)
      .post('/api/multitable/templates/contract-management/install')
      .send({ baseName: 'Q3 Contracts' })
      .expect(201)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.base.name).toBe('Q3 Contracts')
    expect(response.body.data.template.id).toBe('contract-management')
    expect(response.body.data.sheets).toHaveLength(1)
    expect(response.body.data.fields).toHaveLength(8)
    expect(response.body.data.views.map((view: any) => view.type)).toEqual(['grid', 'kanban', 'calendar'])
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)

    // Observation event: success path emits the stable install event with
    // structured fields only (no baseName / body / token / email).
    const successCall = infoSpy.mock.calls.find(([msg]) => msg === '[multitable.template.install]')
    expect(successCall).toBeDefined()
    const successMeta = successCall![1] as Record<string, unknown>
    expect(successMeta).toMatchObject({
      templateId: 'contract-management',
      ok: true,
      userId: 'user_multitable_1',
    })
    expect(successMeta).toHaveProperty('baseId')
    expect(successMeta).toHaveProperty('sheetId')
    expect(successMeta).not.toHaveProperty('baseName')
    expect(JSON.stringify(successMeta)).not.toContain('Q3 Contracts')
  })

  test('logs a failed [multitable.template.install] event for an unknown template', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async () => ({ rows: [], rowCount: 0 }),
    })

    const { Logger } = await import('../../src/core/logger')
    const infoSpy = vi.spyOn(Logger.prototype, 'info')

    await request(app)
      .post('/api/multitable/templates/no-such-template/install')
      .send({ baseName: 'Whatever' })
      .expect(404)

    const failCall = infoSpy.mock.calls.find(([msg]) => msg === '[multitable.template.install]')
    expect(failCall).toBeDefined()
    const failMeta = failCall![1] as Record<string, unknown>
    expect(failMeta).toMatchObject({
      templateId: 'no-such-template',
      ok: false,
      statusCode: 404,
      errorCode: 'NOT_FOUND',
    })
    expect(failMeta).not.toHaveProperty('baseName')
    expect(JSON.stringify(failMeta)).not.toContain('Whatever')
  })

  test('allows create sheet under an owned base without global multitable write', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: [],
      fallbackPermissions: [],
      fallbackHasPermission: false,
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', owner_id: 'user_multitable_1' }],
          }
        }
        if (sql.includes('INSERT INTO meta_sheets')) {
          expect(params).toEqual([
            expect.any(String),
            'base_ops',
            'Owned Sheet',
            'Created by base owner',
          ])
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO meta_views')) {
          return { rows: [], rowCount: 1 }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/sheets')
      .send({ baseId: 'base_ops', name: 'Owned Sheet', description: 'Created by base owner' })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.sheet).toMatchObject({
      baseId: 'base_ops',
      name: 'Owned Sheet',
      description: 'Created by base owner',
      seeded: false,
    })
    expect(mockPool.transaction).toHaveBeenCalledTimes(1)
  })

  test('rejects create sheet under an unowned base without global multitable write', async () => {
    const { app } = await createApp({
      tokenPerms: [],
      fallbackPermissions: [],
      fallbackHasPermission: false,
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{ id: 'base_ops', owner_id: 'someone_else' }],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/sheets')
      .send({ baseId: 'base_ops', name: 'Blocked Sheet' })
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
  })

  // F21 deletion half — this test changed DELIBERATELY, in two ways.
  //  (1) AUTHORITY: `multitable:write` alone no longer deletes a sheet. Deleting a whole table is the
  //      same schema authority as renaming one field header (#5357), so the actor now needs
  //      `multitable:manage-schema`. The old actor's refusal is pinned in the sibling assertion below.
  //  (2) SOFT DELETE: the route sets `deleted_at` instead of `DELETE FROM meta_sheets`, and no longer
  //      destroys inbound `meta_links` — the rows stay so `POST /sheets/:sheetId/restore` is complete.
  //      The old `DELETE FROM meta_links ...` handler is gone because the route no longer issues it;
  //      an unhandled SQL in this harness throws, so a route that still deleted links would fail here.
  test('soft-deletes a multitable sheet by id for a schema-authority actor', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'multitable:manage-schema'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }], rowCount: 1 }
        }
        if (sql.includes('UPDATE meta_sheets SET deleted_at = now()')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [], rowCount: 1 }
        }
        // Managed-sheet guard (src/multitable/sheet-delete-guard.ts), asked AFTER the authority gate and
        // BEFORE the write: an ordinary sheet has no plugin registry row and no server-owned system_kind.
        if (sql.includes('FROM plugin_multitable_object_registry')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [] }
        }
        if (sql.includes('SELECT system_kind, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ system_kind: null, description: null }] }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/sheets/sheet_ops')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data).toEqual({ deleted: 'sheet_ops' })
  })

  // The severe half of the finding: before this change a write-only operator held `canManageViews`,
  // which was all the delete route asked for — so an actor who could not rename ONE field header
  // could destroy the WHOLE sheet. The refusal is the SERVER's, not the UI's.
  test('refuses a sheet delete from a write-only operator, naming the authority that would be accepted', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read', 'multitable:write'],
      queryHandler: async (sql) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          return { rows: [{ id: 'sheet_ops' }], rowCount: 1 }
        }
        if (/^\s*(UPDATE|DELETE)\s+(FROM\s+)?meta_sheets\b/i.test(sql)) {
          throw new Error('the operator must never reach the write')
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/sheets/sheet_ops')
      .expect(403)

    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('FORBIDDEN')
    // Actionable: it says what WOULD be accepted, and it says multitable:write is not it — in
    // EITHER form, since a sheet-scoped `spreadsheet:write` grant does not qualify either.
    expect(response.body.error.message).toContain('multitable:manage-schema')
    expect(response.body.error.message).toContain('sheet-scoped admin grant')
    expect(response.body.error.message).toContain('is not sufficient')
  })

  // AUTHZ-FIRST (real-DB goldens). The actor now needs schema authority to reach the 404 at all:
  // an unauthorized caller must not be able to use 404-vs-403 to discover whether a sheet exists.
  // The write-only actor's refusal is the sibling assertion below.
  test('returns 404 when deleting a missing multitable sheet, for an actor who could have deleted it', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'multitable:manage-schema'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_missing'])
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('DELETE FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_missing'])
          return { rows: [], rowCount: 0 }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/sheets/sheet_missing')
      .expect(404)

    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('NOT_FOUND')
    // VALUES-FREE: the refusal must not echo the requested id back (the #L5-wire no-leak golden).
    expect(JSON.stringify(response.body)).not.toContain('sheet_missing')
  })

  test('ANTI-ORACLE: a write-only operator gets 403 for a MISSING sheet, same as for an existing one', async () => {
    const handler = async (sql: string) => {
      if (sql.includes('FROM meta_sheets') && sql.includes('WHERE id = $1')) return { rows: [], rowCount: 0 }
      if (/^\s*(UPDATE|DELETE)\s+(FROM\s+)?meta_sheets/i.test(sql)) {
        throw new Error('an unauthorized actor must never reach the write')
      }
      { const cr = configRevisionNoop(sql); if (cr) return cr }
      if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
      if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
      return { rows: [], rowCount: 0 }
    }
    const missing = await createApp({ tokenPerms: ['multitable:read', 'multitable:write'], queryHandler: handler })
    const res = await request(missing.app).delete('/api/multitable/sheets/sheet_missing')

    // 403, NOT 404: the operator learns nothing about whether `sheet_missing` exists — identical to
    // the refusal it gets for a sheet that does exist (pinned above).
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
    expect(JSON.stringify(res.body)).not.toContain('sheet_missing')
  })

  test('rejects context access without multitable read permission', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: [],
      fallbackPermissions: [],
      fallbackHasPermission: false,
      queryHandler: async () => ({ rows: [], rowCount: 0 }),
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ baseId: 'base_ops' })
      .expect(403)

    expect(response.body).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
    })
    expect(mockPool.query).toHaveBeenCalledTimes(2)
  })

  test('hides the system people sheet from multitable context selection', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:read'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_bases') && sql.includes('WHERE id = $1')) {
          expect(params).toEqual(['base_ops'])
          return {
            rows: [{
              id: 'base_ops',
              name: 'Ops Base',
              icon: null,
              color: null,
              owner_id: null,
              workspace_id: null,
            }],
          }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          return {
            rows: [
              { id: 'sheet_people', base_id: 'base_ops', name: 'People', description: '__metasheet_system:people__' },
              { id: 'sheet_orders', base_id: 'base_ops', name: 'Orders', description: null },
            ],
          }
        }
        if (sql.includes('FROM meta_views') && sql.includes('WHERE sheet_id = $1')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [
              { id: 'view_orders', sheet_id: 'sheet_orders', name: 'Grid', type: 'grid', filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} },
            ],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC')) {
          expect(params).toEqual(['sheet_orders'])
          return {
            rows: [
              { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 1 },
            ],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .get('/api/multitable/context')
      .query({ baseId: 'base_ops' })
      .expect(200)

    expect(response.body.data.sheet).toMatchObject({ id: 'sheet_orders', name: 'Orders' })
    expect(response.body.data.sheets).toEqual([
      expect.objectContaining({ id: 'sheet_orders', name: 'Orders' }),
    ])
  })

  test('prepares a person field preset by provisioning a people sheet and syncing users', async () => {
    let peopleSheetId = ''
    const fieldIdsByName = new Map<string, string>()

    const { app } = await createApp({
      // canManageFields now requires multitable:manage-schema (src/multitable/manage-schema-permission.ts)
      tokenPerms: ['multitable:write', 'multitable:manage-schema'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: null }] }
        }
        if (sql.includes('FROM meta_sheets') && sql.includes('WHERE base_id = $1')) {
          expect(params).toEqual(['base_ops'])
          return { rows: [{ id: 'sheet_ops', base_id: 'base_ops', name: 'Orders', description: null }] }
        }
        if (sql.includes('INSERT INTO meta_sheets')) {
          peopleSheetId = String(params?.[0] ?? '')
          expect(params).toEqual([
            expect.any(String),
            'base_ops',
            'People',
            '__metasheet_system:people__',
          ])
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT id, name, type, "order" FROM meta_fields WHERE sheet_id = $1')) {
          expect(params).toEqual([peopleSheetId])
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO meta_fields')) {
          const fieldId = String(params?.[0] ?? '')
          const fieldName = String(params?.[2] ?? '')
          fieldIdsByName.set(fieldName, fieldId)
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('SELECT id, email, name, avatar_url') && sql.includes('FROM users')) {
          return {
            rows: [
              { id: 'user_amy', email: 'amy@example.com', name: 'Amy', avatar_url: 'https://cdn.example.com/amy.png' },
            ],
          }
        }
        if (sql.includes('SELECT id, data FROM meta_records WHERE sheet_id = $1')) {
          expect(params).toEqual([peopleSheetId])
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO meta_records')) {
          expect(params?.[1]).toBe(peopleSheetId)
          const payload = JSON.parse(String(params?.[2] ?? '{}'))
          expect(payload).toEqual({
            [fieldIdsByName.get('User ID')!]: 'user_amy',
            [fieldIdsByName.get('Name')!]: 'Amy',
            [fieldIdsByName.get('Email')!]: 'amy@example.com',
            [fieldIdsByName.get('Avatar URL')!]: 'https://cdn.example.com/amy.png',
          })
          return { rows: [], rowCount: 1 }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/person-fields/prepare')
      .send({ sheetId: 'sheet_ops' })
      .expect(200)

    expect(response.body.data.targetSheet).toMatchObject({
      id: peopleSheetId,
      baseId: 'base_ops',
      name: 'People',
      description: '__metasheet_system:people__',
    })
    expect(response.body.data.fieldProperty).toEqual({
      foreignSheetId: peopleSheetId,
      limitSingleRecord: true,
      refKind: 'user',
    })
  })

  // Native person field (人员, design 2026-06-16): `type:'person'` is now a FIRST-CLASS native
  // field stored as `type='person'` (value = userId[]) — it is NO LONGER rewritten to a
  // `link`+refKind:user against a system People sheet. (Legacy link-backed person fields stay
  // `type='link'` and are untouched — coexistence; `ensurePeopleSheetPreset`/`/person-fields/prepare`
  // remain for them + direct API callers.)
  test('creates a native person field stored as type=person (no People-sheet rewrite)', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'multitable:manage-schema'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ max_order: 4 }] }
        }
        if (sql.includes('INSERT INTO meta_fields')) {
          // Native person: persisted as type='person' with ONLY `limitSingleRecord` in property.
          // The spoofed `foreignSheetId` is DROPPED (person sanitize keeps no foreign-sheet key),
          // and NO People sheet is provisioned (no INSERT INTO meta_sheets handler is reachable).
          expect(params).toEqual([
            'fld_owner',
            'sheet_ops',
            'Owner',
            'person',
            JSON.stringify({ limitSingleRecord: false }),
            5,
          ])
          return {
            rows: [{
              id: 'fld_owner',
              name: 'Owner',
              type: 'person',
              property: { limitSingleRecord: false },
              order: 5,
            }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_owner'])
          return {
            rows: [{
              id: 'fld_owner',
              name: 'Owner',
              type: 'person',
              property: { limitSingleRecord: false },
              order: 5,
            }],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/fields')
      .send({
        id: 'fld_owner',
        sheetId: 'sheet_ops',
        name: 'Owner',
        type: 'person',
        property: {
          limitSingleRecord: false,
          // A spoofed foreign-sheet key must NOT survive into a native person field's property.
          foreignSheetId: 'sheet_spoofed',
        },
      })
      .expect(201)

    expect(response.body.data.field).toMatchObject({
      id: 'fld_owner',
      name: 'Owner',
      type: 'person',
      order: 5,
      property: { limitSingleRecord: false },
    })
    expect(response.body.data.field.property).not.toHaveProperty('refKind')
    expect(response.body.data.field.property).not.toHaveProperty('foreignSheetId')
  })

  // PATCH `{type:'person'}` on a NATIVE person field (type='person', userId[]) — property is
  // re-normalized, no People-sheet rewrite. Coexistence note: a legacy person is `type='link'`;
  // editing its config sends `{property}` only (no type), so `requestedType` falls back to 'link'
  // and it can NEVER be silently flipped native (verified by the route's
  // `requestedType ?? mapFieldType(stored)`).
  //
  // F8A (2026-09-11) CONTRACT CHANGE — this case used to start from `type: 'string'`, i.e. it
  // asserted that a plain TEXT column could be converted into a person field through the API.
  // The lossless-retype whitelist (src/multitable/field-retype-whitelist.ts) now refuses that pair
  // with 400 FIELD_RETYPE_NOT_LOSSLESS: retyping converts NOTHING, so the stored names would sit
  // unreadable under a userId[] type. The refusal itself is pinned below in
  // 'F8A lossless retype whitelist'. What this case still owns — and what it always really owned —
  // is the native-person PROPERTY normalization: the spoofed foreignSheetId is dropped,
  // limitSingleRecord survives, and no People sheet is provisioned.
  test('normalizes a native person field on update, dropping a spoofed foreignSheetId (no People-sheet rewrite)', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'multitable:manage-schema'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_assignee'])
          return { rows: [{ id: 'fld_assignee', sheet_id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          expect(params).toEqual(['fld_assignee'])
          return {
            rows: [{
              id: 'fld_assignee',
              sheet_id: 'sheet_ops',
              name: 'Assignee',
              type: 'person',
              property: { limitSingleRecord: false },
              order: 2,
            }],
          }
        }
        if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3, property = $4::jsonb, "order" = $5')) {
          // Native person: type='person', property carries ONLY limitSingleRecord. The spoofed
          // foreignSheetId is DROPPED and NO People sheet is provisioned (no meta_sheets handler hit).
          expect(params).toEqual([
            'fld_assignee',
            'Assignee',
            'person',
            JSON.stringify({ limitSingleRecord: true }),
            2,
          ])
          return {
            rows: [{
              id: 'fld_assignee',
              name: 'Assignee',
              type: 'person',
              property: { limitSingleRecord: true },
              order: 2,
            }],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/fields/fld_assignee')
      .send({
        type: 'person',
        property: {
          foreignSheetId: 'sheet_spoofed',
          limitSingleRecord: true,
        },
      })
      .expect(200)

    expect(response.body.data.field).toMatchObject({
      id: 'fld_assignee',
      name: 'Assignee',
      type: 'person',
      order: 2,
      property: { limitSingleRecord: true },
    })
    expect(response.body.data.field.property).not.toHaveProperty('refKind')
    expect(response.body.data.field.property).not.toHaveProperty('foreignSheetId')
  })

  test('accepts date fields in create and update multitable field contracts', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'multitable:manage-schema'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ max_order: 2 }] }
        }
        if (sql.includes('INSERT INTO meta_fields')) {
          expect(params).toEqual([
            'fld_due_date',
            'sheet_ops',
            'Due Date',
            'date',
            '{}',
            3,
          ])
          return {
            rows: [{
              id: 'fld_due_date',
              name: 'Due Date',
              type: 'date',
              property: {},
              order: 3,
            }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_due_date') {
            return {
              rows: [{
                id: 'fld_due_date',
                name: 'Due Date',
                type: 'date',
                property: {},
                order: 3,
              }],
            }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_due_date') {
            return {
              rows: [{
                id: 'fld_due_date',
                sheet_id: 'sheet_ops',
                name: 'Due Date',
                type: 'date',
                property: {},
                order: 3,
              }],
            }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
          if (params?.[0] === 'fld_due_date') {
            return {
              rows: [{ id: 'fld_due_date', sheet_id: 'sheet_ops' }],
            }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3, property = $4::jsonb, "order" = $5')) {
          expect(params).toEqual([
            'fld_due_date',
            'Due Date',
            'date',
            '{}',
            3,
          ])
          return {
            rows: [{
              id: 'fld_due_date',
              name: 'Due Date',
              type: 'date',
              property: {},
              order: 3,
            }],
          }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const createResponse = await request(app)
      .post('/api/multitable/fields')
      .send({
        id: 'fld_due_date',
        sheetId: 'sheet_ops',
        name: 'Due Date',
        type: 'date',
      })
      .expect(201)

    expect(createResponse.body.data.field).toMatchObject({
      id: 'fld_due_date',
      name: 'Due Date',
      type: 'date',
      order: 3,
    })

    const updateResponse = await request(app)
      .patch('/api/multitable/fields/fld_due_date')
      .send({
        type: 'date',
      })
      .expect(200)

    expect(updateResponse.body.data.field).toMatchObject({
      id: 'fld_due_date',
      name: 'Due Date',
      type: 'date',
      order: 3,
    })
  })

  test('accepts MF2 field types in create and update multitable field contracts', async () => {
    // The rows this test pretends are already in meta_fields. `fld_contact` (email) exists so the
    // update contract can be exercised on an MF2 type without crossing a lossy retype pair (F8A).
    const storedMf2Fields: Record<string, { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }> = {
      fld_amount: { id: 'fld_amount', sheet_id: 'sheet_ops', name: 'Amount', type: 'currency', property: { code: 'usd', decimals: 2 }, order: 4 },
      fld_contact: { id: 'fld_contact', sheet_id: 'sheet_ops', name: 'Contact', type: 'email', property: {}, order: 5 },
    }
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'multitable:manage-schema'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ max_order: 3 }] }
        }
        if (sql.includes('INSERT INTO meta_fields')) {
          expect(params).toEqual([
            'fld_amount',
            'sheet_ops',
            'Amount',
            'currency',
            '{"code":"usd","decimals":2}',
            4,
          ])
          return {
            rows: [{
              id: 'fld_amount',
              name: 'Amount',
              type: 'currency',
              property: { code: 'usd', decimals: 2 },
              order: 4,
            }],
          }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          const stored = storedMf2Fields[String(params?.[0])]
          if (stored) {
            const { sheet_id: _sheetId, ...withoutSheet } = stored
            return { rows: [{ ...withoutSheet }] }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
          const stored = storedMf2Fields[String(params?.[0])]
          if (stored) {
            return { rows: [{ id: stored.id, sheet_id: stored.sheet_id }] }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
          const stored = storedMf2Fields[String(params?.[0])]
          if (stored) {
            return { rows: [{ ...stored }] }
          }
          throw new Error(`Unexpected field lookup params: ${JSON.stringify(params)}`)
        }
        if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3, property = $4::jsonb, "order" = $5')) {
          const [fieldId, name, type, property, order] = params as [string, string, string, string, number]
          if (fieldId === 'fld_amount') {
            // currency -> number: an MF2 type change that IS on the lossless whitelist (the stored
            // digits stay readable), so the F8A guard lets the pre-existing update contract through.
            expect([name, type, property, order]).toEqual(['Amount', 'number', '{"thousands":false}', 4])
          } else if (fieldId === 'fld_contact') {
            expect([name, type, property, order]).toEqual(['Contact', 'email', '{}', 5])
          } else {
            throw new Error(`Unexpected field update params: ${JSON.stringify(params)}`)
          }
          return { rows: [{ id: fieldId, name, type, property: JSON.parse(property), order }] }
        }
        { const cr = configRevisionNoop(sql); if (cr) return cr }
        // A: approval-projection read-guard lookup — no projection sheet in this test
        if (/FROM meta_sheets WHERE id = ANY[\s\S]*base_id/i.test(sql)) return { rows: [] }
        // Slice 3: /context resolves the actor's personal-view overlay when the flag is on. No personal rows
        // in these capability-shape tests ⇒ empty (no overlay; personalViewsEnabled still true from the route).
        if (sql.includes('FROM meta_view_personal_configs')) return { rows: [] }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const createResponse = await request(app)
      .post('/api/multitable/fields')
      .send({
        id: 'fld_amount',
        sheetId: 'sheet_ops',
        name: 'Amount',
        type: 'currency',
        property: { code: 'usd', decimals: 2 },
      })
      .expect(201)

    expect(createResponse.body.data.field).toMatchObject({
      id: 'fld_amount',
      name: 'Amount',
      type: 'currency',
      property: { code: 'usd', decimals: 2 },
      order: 4,
    })

    // F8A (2026-09-11) CONTRACT CHANGE — this leg used to PATCH the currency field straight to
    // `email`. That pair is NOT on the lossless whitelist (currency stores numbers; under an email
    // type they are unreadable and the email write path would never take them back), so the route
    // now answers 400 FIELD_RETYPE_NOT_LOSSLESS — pinned below in 'F8A lossless retype whitelist'.
    // The claim this test actually makes — MF2 field types are accepted by the create AND the
    // update field contract — is kept whole by splitting the leg in two: a whitelisted MF2 type
    // change (currency -> number) and an MF2 type on the update contract itself (email).
    const updateResponse = await request(app)
      .patch('/api/multitable/fields/fld_amount')
      .send({
        type: 'number',
        property: {},
      })
      .expect(200)

    expect(updateResponse.body.data.field).toMatchObject({
      id: 'fld_amount',
      name: 'Amount',
      type: 'number',
      // the route normalizes a number field's property; the currency-only keys are gone
      property: { thousands: false },
      order: 4,
    })

    const emailUpdateResponse = await request(app)
      .patch('/api/multitable/fields/fld_contact')
      .send({
        type: 'email',
        property: {},
      })
      .expect(200)

    expect(emailUpdateResponse.body.data.field).toMatchObject({
      id: 'fld_contact',
      name: 'Contact',
      type: 'email',
      property: {},
      order: 5,
    })
  })
})

// =================================================================================================
// F8A (2026-09-11) — the lossless-retype whitelist, SECOND COPY in the real-DB lane.
//
// The full lock for this boundary lives in tests/multitable-field-retype-revert-narrowing.test.ts
// (algebra + route matrix + the revert/backward side). CORRECTION (2026-09-11, same day): an earlier
// version of this header said that file "is named by NO workflow ... so nothing in it executes in CI"
// and presented the duplication below as closing a gap. That was WRONG. plugin-tests.yml:844 runs a
// blanket `pnpm --filter @metasheet/core-backend test` in job `test:` (:174, matrix [18.x, 20.x], no
// paths filter), core-backend's `test` script is plain `vitest`, and vitest.config.ts declares no
// `include` — so the narrowing file is collected by the default glob and DOES run on every PR.
// What is true: it is not named INDIVIDUALLY by any workflow, only glob-collected.
//
// So the copies below are a deliberate REDUNDANT re-pin of the load-bearing claims — the route
// refuses a lossy retype BEFORE any UPDATE, the one direction this cut adds really lands, and the
// server table has not drifted from the shared truth table — in the real-DB lane
// (plugin-tests.yml:1306, same `test` job, 20.x + DATABASE_URL). Both copies read the SAME fixture,
// so they cannot disagree about the table; only about which lane reds first.
//
// Mirror wording (same discipline as permission-match-truth-table.json, #5626): changing ONE
// implementation WITHOUT touching the fixture turns THAT SIDE'S OWN run red; changing the fixture
// turns the OTHER side (apps/web/tests/multitable-field-manager.spec.ts) red too.
// =================================================================================================
const RETYPE_TRUTH_TABLE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/field-retype-truth-table.json',
)

interface RetypeTruthTable {
  excludedTargetTypes: string[]
  table: Record<string, string[]>
  targetCases: Array<{ name: string; sourceType: string; property?: unknown; expected: string[] }>
  pairCases: Array<{ name: string; sourceType: string; property?: unknown; targetType: string; lossless: boolean }>
}

const retypeTruthTable = JSON.parse(fs.readFileSync(RETYPE_TRUTH_TABLE_PATH, 'utf8')) as RetypeTruthTable

describe('F8A lossless retype whitelist (server-authoritative, real-DB-lane copy)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const RETYPE_SHEET = 'sheet_retype_ci'

  type StoredField = { id: string; sheet_id: string; name: string; type: string; property: Record<string, unknown>; order: number }

  /** A one-field mock world that REMEMBERS whether the field row was actually written. */
  function retypeWorld(stored: Partial<StoredField>) {
    const row: StoredField = {
      id: 'fld_retype_ci', sheet_id: RETYPE_SHEET, name: 'F', type: 'string', property: {}, order: 0,
      ...stored,
    }
    const updates: Array<{ name: string; type: string; property: string; order: number }> = []
    const queryHandler = (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) return { rows: [{ id: RETYPE_SHEET }] }
      if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
        return { rows: params?.[0] === row.id ? [{ id: row.id, sheet_id: row.sheet_id }] : [] }
      }
      if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
        return { rows: params?.[0] === row.id ? [{ ...row }] : [] }
      }
      if (sql.includes('UPDATE meta_fields') && sql.includes('SET name = $2, type = $3')) {
        const [, name, type, property, order] = params as [string, string, string, string, number]
        updates.push({ name, type, property, order })
        row.name = name
        row.type = type
        row.property = JSON.parse(property)
        row.order = order
        return { rows: [{ id: row.id, name, type, property: row.property, order }] }
      }
      { const cr = configRevisionNoop(sql); if (cr) return cr }
      return { rows: [], rowCount: 0 }
    }
    return { row, updates, queryHandler }
  }

  const patchType = async (world: ReturnType<typeof retypeWorld>, body: Record<string, unknown>) => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write', 'multitable:manage-schema'],
      queryHandler: world.queryHandler,
    })
    return request(app).patch('/api/multitable/fields/fld_retype_ci').send(body)
  }

  test('refuses a lossy retype with 400 + the stable code, BEFORE any UPDATE reaches the table', async () => {
    const world = retypeWorld({ type: 'string' })
    const res = await patchType(world, { type: 'number' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(FIELD_RETYPE_NOT_LOSSLESS_CODE)
    // values-free: no field id, no sheet id in the message the user sees
    expect(String(res.body.error.message)).not.toMatch(/fld[_-]/)
    expect(String(res.body.error.message)).not.toContain(RETYPE_SHEET)
    // fail-closed: the guard runs before the write, so the row was never touched
    expect(world.updates).toEqual([])
    expect(world.row.type).toBe('string')
  })

  test('refuses text -> person: a stored name is not a userId (this pair used to be a 200)', async () => {
    const world = retypeWorld({ type: 'string' })
    const res = await patchType(world, { type: 'person', property: { limitSingleRecord: true } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(FIELD_RETYPE_NOT_LOSSLESS_CODE)
    expect(world.updates).toEqual([])
    expect(world.row.type).toBe('string')
  })

  test('refuses RICH long text -> text, judging the STORED property and not the request body', async () => {
    const world = retypeWorld({ type: 'longText', property: { rich: true } })
    // turning rich off in the same request must not buy the caller a pass
    const res = await patchType(world, { type: 'string', property: { rich: false } })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe(FIELD_RETYPE_NOT_LOSSLESS_CODE)
    expect(world.updates).toEqual([])
    expect(world.row.type).toBe('longText')
  })

  test('POSITIVE CONTROL: plain long text -> text is accepted and really lands', async () => {
    const world = retypeWorld({ type: 'longText', property: {} })
    const res = await patchType(world, { type: 'string' })

    expect(res.status).toBe(200)
    expect(res.body.data.field.type).toBe('string')
    expect(world.updates.map((u) => u.type)).toEqual(['string'])
    expect(world.row.type).toBe('string')
  })

  test('same type -> same type is not a retype at all: a rename carrying `type` still passes', async () => {
    const world = retypeWorld({ type: 'date', name: 'D' })
    const res = await patchType(world, { type: 'date', name: 'Delivery' })

    expect(res.status).toBe(200)
    expect(world.row.name).toBe('Delivery')
    expect(world.row.type).toBe('date')
  })

  test('the pre-existing side-effect path is untouched: text -> link still gets ITS specific code', async () => {
    const world = retypeWorld({ type: 'string' })
    const res = await patchType(world, { type: 'link' })

    expect(res.status).toBe(400)
    // the older guard's reason is more specific; the whitelist only backstops when nobody else objects
    expect(res.body.error.code).toBe('LINK_FIELD_FOREIGN_SHEET_REQUIRED')
    expect(world.updates).toEqual([])
  })

  // CHARACTERIZATION, not an endorsement. The whitelist passes through any pair with an endpoint in
  // FIELD_RETYPE_EXCLUDED_TYPES, and the two ends are NOT symmetric:
  //   target in the set -> a pre-existing guard really takes over (the link case above);
  //   SOURCE in the set -> nobody takes over. Grep the PATCH body: there is no
  //   `currentType === 'attachment' | 'lookup' | 'rollup' | 'button' | 'createdTime'` branch at all
  //   (validateHierarchyParentFieldMutation only covers a same-sheet single-value parent LINK, and the
  //   autoNumber sequence cleanup runs AFTER the `UPDATE meta_fields` — a side effect, not a guard).
  // So `attachment -> text` is a plain 200 today, exactly as it was before this cut, even though the
  // browser offers no such option (apps/web losslessRetypeTargets returns [] for an excluded source).
  // This test exists so the seam is VISIBLE and so closing it later is a deliberate, owner-approved
  // product tightening (attachment/link -> text would become 400) rather than an accident.
  test('KNOWN SEAM (characterization): an EXCLUDED SOURCE is unguarded — attachment -> text is still 200', async () => {
    const world = retypeWorld({ type: 'attachment' })
    const res = await patchType(world, { type: 'string' })

    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    expect(world.updates.map((u) => u.type)).toEqual(['string'])
    expect(world.row.type).toBe('string')
  })

  test('the server table IS the shared fixture table, row for row', () => {
    expect(retypeTruthTable.targetCases.length).toBeGreaterThanOrEqual(20)
    expect(retypeTruthTable.pairCases.length).toBeGreaterThanOrEqual(20)
    expect(LOSSLESS_FIELD_RETYPE).toEqual(retypeTruthTable.table)
    expect(Array.from(FIELD_RETYPE_EXCLUDED_TYPES).sort()).toEqual([...retypeTruthTable.excludedTargetTypes].sort())
  })

  test.each(retypeTruthTable.targetCases.map((row) => [row.name, row] as const))(
    'losslessRetypeTargets: %s',
    (_name, row) => {
      expect(losslessRetypeTargets(row.sourceType, row.property)).toEqual(row.expected)
    },
  )

  test.each(retypeTruthTable.pairCases.map((row) => [row.name, row] as const))(
    'isLosslessFieldRetype: %s',
    (_name, row) => {
      expect(isLosslessFieldRetype(row.sourceType, row.targetType, row.property)).toBe(row.lossless)
    },
  )
})
