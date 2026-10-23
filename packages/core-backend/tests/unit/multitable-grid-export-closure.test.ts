/**
 * 备料分批拉取第一期 step 3 (PR A) — the sheet-level GRID-EXPORT CLOSURE stamp, core side.
 * Mock pool / fake query, no DB; routes through one pinned listener (`request(app)` is banned in tests/unit, #4154).
 * The same guarantees run against PostgreSQL in tests/integration/multitable-grid-export-closure-realdb.cases.ts.
 *
 *   L  the lookup: column-tolerant statement, NO statement for an id that cannot carry the stamp, other errors
 *      propagate; the clamp turns off `canExport` only and returns the same object off a closed sheet.
 *   R  the clamp in EACH of the three resolvers (REST, collab/api-token, transaction-bound), for admin, reader,
 *      writer: on a stamped sheet `canExport` is false and every other capability equals the unstamped result.
 *   E  export-xlsx (xlsx AND csv): a reader / admin / token-shaped identity of a stamped sheet gets 403
 *      MULTITABLE_GRID_EXPORT_CLOSED with the fixed body; a non-reader gets the plain 403 (learns nothing); an
 *      unstamped derived sheet still exports (control). An `mst_` API token cannot reach the route at all.
 *   C  /context: `capabilities.gridExportClosure = { reason }` on a stamped sheet only, `canExport` false, every
 *      other capability unchanged.
 *   K  copy-sheet: WITH data from a stamped source → 403 COPY_SOURCE_GRID_EXPORT_CLOSED; structure-only passes
 *      (and issues no closure lookup).
 *   P  the ports: plugin-integration-core only; wrong objectId / sheet / owner plugin / project refused before the
 *      host runs; no hook → refused; the checked values are what the host receives. NO reopen port exists.
 *   S  the service: derived ids only (no statement otherwise), fence → row lock → set-once UPDATE with the literal,
 *      idempotent (original time/actor kept), 42703 → 503, a dead sheet → no UPDATE; one-writer census over src/.
 *   M  the migration against a fake database: up() statements; down() refuses while any closure exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import express, { type Express } from 'express'
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely'
import request from 'supertest'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  GRID_EXPORT_CLOSURE_DOWN_REFUSED_CODE,
  down as migrationDown,
  up as migrationUp,
} from '../../src/db/migrations/zzzz20261022150000_add_meta_sheets_grid_export_closure'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
import { MultitableProjectNamespaceError, MultitableSheetScopeError, createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'
import { getObjectSheetId } from '../../src/multitable/provisioning'
import {
  GRID_EXPORT_CLOSED_REFUSAL,
  GRID_EXPORT_CLOSED_SHEET_IDS_SQL,
  STOCK_PREPARATION_SHEET_STAMPS_SQL,
  loadStockPreparationSheetStamps,
  MULTITABLE_GRID_EXPORT_CLOSED_CODE,
  MULTITABLE_GRID_EXPORT_CLOSED_MESSAGE,
  SheetGridExportClosureError,
  loadGridExportClosedSheetIds,
  restrictGridExportCapabilities,
} from '../../src/multitable/sheet-grid-export-closure'
import { SheetNotLiveError } from '../../src/multitable/sheet-liveness'
import {
  CLOSE_SHEET_GRID_EXPORT_SQL,
  READ_SHEET_GRID_EXPORT_CLOSURE_SQL,
  closeSheetGridExport,
  readSheetGridExportClosure,
} from '../../src/services/sheet-grid-export-closure-service'
import { usePinnedServer } from '../utils/pinned-server'

const rbacState = vi.hoisted(() => ({ admin: {} as Record<string, boolean>, perms: {} as Record<string, string[]> }))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(async (userId: string) => rbacState.admin[userId] === true),
  userHasPermission: vi.fn(async () => false),
  listUserPermissions: vi.fn(async (userId: string) => rbacState.perms[userId] ?? []),
  invalidateUserPerms: vi.fn(),
  getPermCacheStatus: vi.fn(),
}))

const PLUGIN = 'plugin-integration-core'
const PROJECT_ID = 'tenant_gec:integration-core'
const OBJECT_ID = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'
const OTHER_OBJECT_ID = 'plm_stock_preparation_sandbox_p_fedcba9876543210fedcba98'
const CLOSED = getObjectSheetId(PROJECT_ID, OBJECT_ID)
const OPEN_DERIVED = getObjectSheetId(PROJECT_ID, OTHER_OBJECT_ID)
/** A stamped project sheet that has been soft-deleted (review round 1: liveness answers before the closure). */
const DELETED_CLOSED = getObjectSheetId(PROJECT_ID, 'plm_stock_preparation_sandbox_p_00112233445566778899aabb')
const PLAIN = 'sht_gec_plain'
const BASE_ID = 'base_gec'
const CLOSED_AT = '2026-10-22T06:00:00.000Z'

const USERS = {
  admin: { id: 'u_gec_admin', roles: ['admin'], perms: [] as string[] },
  reader: { id: 'u_gec_reader', roles: [] as string[], perms: ['multitable:read'] },
  writer: { id: 'u_gec_writer', roles: [] as string[], perms: ['multitable:read', 'multitable:write', 'multitable:share'] },
  outsider: { id: 'u_gec_outsider', roles: [] as string[], perms: ['comments:read'] },
} as const
type UserKey = keyof typeof USERS

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()
type Log = Array<{ sql: string; params: unknown[] }>

/** One fake pool for every route and resolver here. `closed` is the set the closure lookup answers. */
function makeAnswer(log: Log, closed: ReadonlySet<string>) {
  const known = (id: unknown) => id === CLOSED || id === OPEN_DERIVED || id === PLAIN
  const sheetRow = (id: string) => ({ id, base_id: BASE_ID, name: `S ${id.slice(-4)}`, description: null, system_kind: null, copied_from_kind: null, copied_at: null, copied_from_sheet_id: null })
  return async (sql: string, params: unknown[] = []) => {
    const q = collapse(sql)
    log.push({ sql: q, params })
    if (q === collapse(GRID_EXPORT_CLOSED_SHEET_IDS_SQL)) {
      const ids = (params[0] as string[]) ?? []
      return { rows: ids.filter((id) => closed.has(id)).map((id) => ({ id })), rowCount: 0 }
    }
    if (q === collapse(STOCK_PREPARATION_SHEET_STAMPS_SQL)) {
      const ids = (params[0] as string[]) ?? []
      return { rows: ids.filter((id) => closed.has(id)).map((id) => ({ id, stock_prep_overview: false, grid_export_closed: true })), rowCount: 0 }
    }
    if (/^SELECT deleted_at FROM meta_sheets WHERE id = \$1( FOR UPDATE)?$/.test(q)) {
      if (params[0] === DELETED_CLOSED) return { rows: [{ deleted_at: new Date('2026-10-22T00:00:00Z') }], rowCount: 1 }
      return { rows: known(params[0]) ? [{ deleted_at: null }] : [], rowCount: 0 }
    }
    if (q.includes('FROM meta_sheets s LEFT JOIN meta_bases b ON b.id = s.base_id')) {
      return known(params[0])
        ? { rows: [{ ...sheetRow(String(params[0])), base_ref_id: BASE_ID, base_name: 'B', base_icon: null, base_color: null, base_owner_id: 'u_gec_owner', base_workspace_id: null }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (/FROM meta_bases WHERE id = \$1 AND deleted_at IS NULL/.test(q)) {
      return params[0] === BASE_ID ? { rows: [{ id: BASE_ID, name: 'B', icon: null, color: null, owner_id: 'u_gec_owner', workspace_id: null }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/FROM meta_sheets WHERE base_id = \$1 AND deleted_at IS NULL/.test(q)) {
      return params[0] === BASE_ID ? { rows: [sheetRow(PLAIN), sheetRow(OPEN_DERIVED), sheetRow(CLOSED)], rowCount: 3 } : { rows: [], rowCount: 0 }
    }
    if (/^SELECT id, base_id, name/.test(q) && /FROM meta_sheets WHERE id = \$1/.test(q)) {
      return known(params[0]) ? { rows: [sheetRow(String(params[0]))], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (/FROM meta_fields WHERE sheet_id = \$1/.test(q) && !/field_permissions/.test(q)) {
      return known(params[0])
        ? { rows: [{ id: `fld_${String(params[0]).slice(-6)}`, sheet_id: params[0], name: 'Title', type: 'string', property: {}, order: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }
}

function makePool(log: Log, closed: ReadonlySet<string>) {
  return {
    query: vi.fn(makeAnswer(log, closed)),
    transaction: vi.fn(async () => { throw Object.assign(new Error('synthetic transaction refusal'), { code: 'SYNTHETIC' }) }),
  }
}

const pinned = usePinnedServer()
let poolManager: typeof import('../../src/integration/db/connection-pool')['poolManager']
let univerMetaRouter: typeof import('../../src/routes/univer-meta')['univerMetaRouter']
let permissionService: typeof import('../../src/multitable/permission-service')
let sheetCapabilities: typeof import('../../src/multitable/sheet-capabilities')
let txnAuth: typeof import('../../src/services/approval-record-link-txn-auth')
let copyService: typeof import('../../src/multitable/copy-sheet-service')

beforeAll(async () => {
  for (const user of Object.values(USERS)) {
    rbacState.admin[user.id] = user.roles.includes('admin')
    rbacState.perms[user.id] = [...user.perms]
  }
  ;({ poolManager } = await import('../../src/integration/db/connection-pool'))
  ;({ univerMetaRouter } = await import('../../src/routes/univer-meta'))
  permissionService = await import('../../src/multitable/permission-service')
  sheetCapabilities = await import('../../src/multitable/sheet-capabilities')
  txnAuth = await import('../../src/services/approval-record-link-txn-auth')
  copyService = await import('../../src/multitable/copy-sheet-service')
}, 180_000)

afterEach(() => { vi.restoreAllMocks() })

/** identity: a session user, or `token` = the synthetic user the api-token middleware installs. */
function mountApp(log: Log, closed: ReadonlySet<string>, identity: { user: UserKey; token?: boolean }) {
  vi.spyOn(poolManager, 'get').mockReturnValue(makePool(log, closed) as never)
  const app: Express = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const user = USERS[identity.user]
    if (identity.token) {
      ;(req as express.Request & { user?: unknown; apiTokenId?: string }).user = { id: user.id, apiToken: true }
      ;(req as express.Request & { apiTokenId?: string }).apiTokenId = 'tok_gec_synthetic'
    } else {
      ;(req as express.Request & { user?: unknown }).user = { id: user.id, roles: [...user.roles], perms: [...user.perms] }
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  pinned.setApp(app)
}

describe('L — the closure lookup and the clamp', () => {
  it('L-01 no statement for ids that cannot carry the stamp; one column-tolerant statement for derived ids', async () => {
    const log: Log = []
    const answer = makeAnswer(log, new Set([CLOSED]))
    expect(await loadGridExportClosedSheetIds(answer, [PLAIN, 'sheet_x', '', null, 42])).toEqual(new Set())
    expect(log).toEqual([])
    expect(await loadGridExportClosedSheetIds(answer, [PLAIN, CLOSED, OPEN_DERIVED, CLOSED])).toEqual(new Set([CLOSED]))
    expect(log).toHaveLength(1)
    expect(log[0].params).toEqual([[CLOSED, OPEN_DERIVED]])
    expect(GRID_EXPORT_CLOSED_SHEET_IDS_SQL).toContain("(to_jsonb(meta_sheets) ->> 'grid_export_closure') IS NOT NULL")
    // The column is only ever named as a to_jsonb KEY, never as a column reference PostgreSQL could reject.
    expect(GRID_EXPORT_CLOSED_SHEET_IDS_SQL.replace(/'grid_export_closure'/g, '')).not.toContain('grid_export_closure')
  })

  it('L-02 a database without the column answers "not closed" for every sheet (no 42703 can block an unrelated sheet); other errors propagate', async () => {
    // The statement never names the column directly, so PostgreSQL has nothing to reject: model the missing
    // column as to_jsonb() simply lacking the key (the fake answers no row), and prove a real error is not eaten.
    const missingColumn = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    expect(await loadGridExportClosedSheetIds(missingColumn, [CLOSED, OPEN_DERIVED])).toEqual(new Set())
    const broken = vi.fn(async () => { throw Object.assign(new Error('connection reset'), { code: '08006' }) })
    await expect(loadGridExportClosedSheetIds(broken, [CLOSED])).rejects.toMatchObject({ code: '08006' })
  })

  it('L-03 the clamp turns off canExport only; off a closed sheet it returns the same object', () => {
    const caps = { canRead: true, canExport: true, canEditRecord: true, canManageSheetAccess: true }
    expect(restrictGridExportCapabilities(caps, false)).toBe(caps)
    expect(restrictGridExportCapabilities(caps, true)).toEqual({ ...caps, canExport: false })
    expect(caps.canExport).toBe(true)
  })

  it('L-04 the refusal body is values-free and carries the fixed copy', () => {
    expect(GRID_EXPORT_CLOSED_REFUSAL).toEqual({
      ok: false,
      error: { code: 'MULTITABLE_GRID_EXPORT_CLOSED', message: MULTITABLE_GRID_EXPORT_CLOSED_MESSAGE, details: { reason: 'stock_prep_pilot' } },
    })
    expect(MULTITABLE_GRID_EXPORT_CLOSED_MESSAGE).toBe('这是试点备料表，通用导出（整表、选中行、CSV、Excel）已关闭。正式交接请用「项目物料导出」；打印和复制选区不能作为交接依据。')
  })
})

describe('R — the clamp in each of the three resolvers', () => {
  for (const userKey of ['admin', 'reader', 'writer'] as const) {
    it(`R-01 ${userKey}: canExport false on the stamped sheet, every other capability as on an unstamped one`, async () => {
      const user = USERS[userKey]
      const access = { userId: user.id, permissions: [...user.perms], isAdminRole: user.roles.includes('admin') }
      const log: Log = []
      const query = makeAnswer(log, new Set([CLOSED]))
      const run = async (sheetId: string) => ({
        rest: await permissionService.resolveSheetCapabilitiesForAccess(query as never, sheetId, access),
        collab: await sheetCapabilities.resolveSheetCapabilitiesForUser(query as never, sheetId, user.id),
        onQuery: await txnAuth.resolveSheetCapabilitiesForUserOnQuery(query as never, sheetId, user.id, undefined, {
          isAdminRole: access.isAdminRole,
          permissions: access.permissions,
        }),
      })
      const closed = await run(CLOSED)
      const open = await run(OPEN_DERIVED)
      for (const lane of ['rest', 'collab', 'onQuery'] as const) {
        expect(open[lane].capabilities.canExport, `${lane} control`).toBe(true)
        expect(closed[lane].capabilities.canExport, lane).toBe(false)
        expect({ ...closed[lane].capabilities, canExport: true }, lane).toEqual(open[lane].capabilities)
        expect((closed[lane] as { gridExportClosed?: true }).gridExportClosed, lane).toBe(true)
        expect(open[lane], lane).not.toHaveProperty('gridExportClosed')
      }
    })
  }
})

describe('Q — query count (review round 1, fix 2): the closure costs NO extra statement', () => {
  for (const userKey of ['admin', 'reader'] as const) {
    it(`Q-01 ${userKey}: an UNCLOSED derived-id sheet costs exactly one stamp statement (overview + closure folded) in each resolver; a client-id sheet none`, async () => {
      const user = USERS[userKey]
      const access = { userId: user.id, permissions: [...user.perms], isAdminRole: user.roles.includes('admin') }
      const lanes = {
        rest: (q: never, s: string) => permissionService.resolveSheetCapabilitiesForAccess(q, s, access),
        collab: (q: never, s: string) => sheetCapabilities.resolveSheetCapabilitiesForUser(q, s, user.id),
        onQuery: (q: never, s: string) => txnAuth.resolveSheetCapabilitiesForUserOnQuery(q, s, user.id, undefined, { isAdminRole: access.isAdminRole, permissions: access.permissions }),
      }
      for (const [lane, run] of Object.entries(lanes)) {
        const derivedLog: Log = []
        await run(makeAnswer(derivedLog, new Set()) as never, OPEN_DERIVED)
        const plainLog: Log = []
        await run(makeAnswer(plainLog, new Set()) as never, PLAIN)
        const stampish = (log: Log) => log.filter((e) => /system_kind|grid_export_closure/.test(e.sql))
        expect(stampish(derivedLog).map((e) => e.sql), lane).toEqual([collapse(STOCK_PREPARATION_SHEET_STAMPS_SQL)])
        expect(stampish(plainLog), lane).toEqual([])
        // The only difference between the two sheets' statement streams is that one folded lookup.
        expect(derivedLog.length, lane).toBe(plainLog.length + 1)
      }
    })
  }

  it('Q-02 the folded loader reads both stamps from one row set; the alias literal the hoisted overview fakes match is the statement prefix', async () => {
    const OVERVIEW_ID = getObjectSheetId(PROJECT_ID, 'plm_stock_preparation_project_overview')
    const query = vi.fn(async () => ({ rows: [
      { id: OVERVIEW_ID, stock_prep_overview: true, grid_export_closed: false },
      { id: CLOSED, stock_prep_overview: false, grid_export_closed: true },
      { id: 7, stock_prep_overview: true, grid_export_closed: true },
    ] }))
    const stamps = await loadStockPreparationSheetStamps(query, [PLAIN, OVERVIEW_ID, CLOSED, OPEN_DERIVED])
    expect(stamps.overviewSheetIds).toEqual(new Set([OVERVIEW_ID]))
    expect(stamps.gridExportClosedSheetIds).toEqual(new Set([CLOSED]))
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]).toEqual([STOCK_PREPARATION_SHEET_STAMPS_SQL, [[OVERVIEW_ID, CLOSED, OPEN_DERIVED], 'stock_prep_overview']])
    expect(STOCK_PREPARATION_SHEET_STAMPS_SQL.startsWith("SELECT id, ((to_jsonb(meta_sheets) ->> 'system_kind') = $2) AS stock_prep_overview,")).toBe(true)
    // The WHERE admits a row for EITHER stamp (a fake cannot evaluate SQL, so the two arms are pinned as text; the
    // real-DB cases GX3 / GX4 prove the closure arm on PostgreSQL).
    expect(STOCK_PREPARATION_SHEET_STAMPS_SQL).toContain(
      "WHERE id = ANY($1::text[]) AND ((to_jsonb(meta_sheets) ->> 'system_kind') = $2 OR (to_jsonb(meta_sheets) ->> 'grid_export_closure') IS NOT NULL)",
    )
    // Both keys are only ever named as to_jsonb KEYS (column-tolerant).
    expect(STOCK_PREPARATION_SHEET_STAMPS_SQL.replace(/'grid_export_closure'|'system_kind'/g, '')).not.toMatch(/grid_export_closure|system_kind/)
    const none = vi.fn(async () => ({ rows: [] }))
    expect(await loadStockPreparationSheetStamps(none, [PLAIN, 'sheet_x'])).toEqual({ overviewSheetIds: new Set(), gridExportClosedSheetIds: new Set() })
    expect(none).not.toHaveBeenCalled()
  })
})

describe('E — the whole-sheet export route (xlsx and csv)', () => {
  const cases: Array<{ label: string; identity: { user: UserKey; token?: boolean } }> = [
    { label: 'ordinary reader', identity: { user: 'reader' } },
    { label: 'platform admin', identity: { user: 'admin' } },
    { label: 'api-token identity (creator = writer)', identity: { user: 'writer', token: true } },
  ]
  for (const { label, identity } of cases) {
    for (const format of ['xlsx', 'csv'] as const) {
      it(`E-01 ${label}, ${format}: 403 MULTITABLE_GRID_EXPORT_CLOSED with the fixed body, before any sheet row is read`, async () => {
        const log: Log = []
        mountApp(log, new Set([CLOSED]), identity)
        const res = await request(pinned.url()).get(`/api/multitable/sheets/${CLOSED}/export-xlsx`).query(format === 'csv' ? { format } : {})
        expect(res.status).toBe(403)
        expect(res.body).toEqual(JSON.parse(JSON.stringify(GRID_EXPORT_CLOSED_REFUSAL)))
        expect(JSON.stringify(res.body)).not.toContain(CLOSED)
        expect(res.headers['content-disposition']).toBeUndefined()
        expect(log.some((entry) => /FROM meta_records/.test(entry.sql))).toBe(false)
      }, 60_000)
    }
  }

  it('E-02 a caller who cannot read the stamped sheet gets the plain 403 and learns nothing about the closure', async () => {
    const log: Log = []
    mountApp(log, new Set([CLOSED]), { user: 'outsider' })
    const res = await request(pinned.url()).get(`/api/multitable/sheets/${CLOSED}/export-xlsx`)
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('FORBIDDEN')
    expect(JSON.stringify(res.body)).not.toContain(MULTITABLE_GRID_EXPORT_CLOSED_CODE)
  }, 60_000)

  for (const format of ['xlsx', 'csv'] as const) {
    it(`E-03 control (${format}): an UNSTAMPED derived sheet and a client-id sheet still export`, async () => {
      for (const sheetId of [OPEN_DERIVED, PLAIN]) {
        const log: Log = []
        mountApp(log, new Set([CLOSED]), { user: 'reader' })
        const res = await request(pinned.url()).get(`/api/multitable/sheets/${sheetId}/export-xlsx`).query(format === 'csv' ? { format } : {})
        expect(res.status, sheetId).toBe(200)
        expect(String(res.headers['content-disposition'] ?? ''), sheetId).toContain('attachment')
      }
    }, 60_000)
  }

  it('E-05 (review round 1) a SOFT-DELETED stamped sheet: a reader gets the values-free 404 SHEET_DELETED (liveness first), a non-reader the plain 403', async () => {
    for (const format of ['xlsx', 'csv'] as const) {
      const log: Log = []
      mountApp(log, new Set([CLOSED, DELETED_CLOSED]), { user: 'reader' })
      const res = await request(pinned.url()).get(`/api/multitable/sheets/${DELETED_CLOSED}/export-xlsx`).query(format === 'csv' ? { format } : {})
      expect(res.status, format).toBe(404)
      expect(res.body?.error?.code, format).toBe('SHEET_DELETED')
      expect(JSON.stringify(res.body)).not.toContain(MULTITABLE_GRID_EXPORT_CLOSED_CODE)
      expect(JSON.stringify(res.body)).not.toContain(DELETED_CLOSED)
    }
    const log: Log = []
    mountApp(log, new Set([CLOSED, DELETED_CLOSED]), { user: 'outsider' })
    const outsider = await request(pinned.url()).get(`/api/multitable/sheets/${DELETED_CLOSED}/export-xlsx`)
    expect(outsider.status).toBe(403)
    expect(outsider.body?.error?.code).toBe('FORBIDDEN')
  }, 60_000)

  it('E-04 an `mst_` API token cannot reach the export route at all (not on the OAPI allowlist)', () => {
    expect(isOapiAllowlistRequest('GET', `/api/multitable/sheets/${CLOSED}/export-xlsx`, 'Bearer mst_synthetic')).toBe(false)
    expect(isOapiAllowlistRequest('GET', '/api/multitable/view', 'Bearer mst_synthetic')).toBe(true)
  })
})

describe('C — /context', () => {
  it('C-01 the stamped sheet carries capabilities.gridExportClosure and canExport false; nothing else differs from an unstamped derived sheet', async () => {
    for (const userKey of ['admin', 'reader', 'writer'] as const) {
      const closedLog: Log = []
      mountApp(closedLog, new Set([CLOSED]), { user: userKey })
      const closed = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: CLOSED })
      expect(closed.status, userKey).toBe(200)
      expect(closed.body.data.capabilities.gridExportClosure, userKey).toEqual({ reason: 'stock_prep_pilot' })
      expect(closed.body.data.capabilities.canExport, userKey).toBe(false)

      // Same sheet id, nothing stamped: the only differences are the marker and canExport.
      const openLog: Log = []
      mountApp(openLog, new Set(), { user: userKey })
      const open = await request(pinned.url()).get('/api/multitable/context').query({ sheetId: CLOSED })
      expect(open.status, userKey).toBe(200)
      expect(open.body.data.capabilities, userKey).not.toHaveProperty('gridExportClosure')
      const { gridExportClosure: _marker, ...closedCaps } = closed.body.data.capabilities
      expect({ ...closedCaps, canExport: open.body.data.capabilities.canExport }, userKey).toEqual(open.body.data.capabilities)
      const { capabilities: _c1, ...closedRest } = closed.body.data
      const { capabilities: _c2, ...openRest } = open.body.data
      expect(closedRest, userKey).toEqual(openRest)
    }
  }, 120_000)

  it('C-02 a sibling of a stamped sheet is not marked', async () => {
    const log: Log = []
    mountApp(log, new Set([CLOSED]), { user: 'reader' })
    for (const sheetId of [OPEN_DERIVED, PLAIN]) {
      const res = await request(pinned.url()).get('/api/multitable/context').query({ sheetId })
      expect(res.status).toBe(200)
      expect(res.body.data.capabilities).not.toHaveProperty('gridExportClosure')
      expect(res.body.data.capabilities.canExport).toBe(true)
    }
  }, 60_000)
})

describe('K — copy-sheet', () => {
  const actor = { access: { userId: USERS.writer.id, permissions: [...USERS.writer.perms], isAdminRole: false }, actorId: USERS.writer.id, tenantId: null }
  const source = (id: string) => ({ id, baseId: BASE_ID, name: 'S', description: null, rowLevelReadEnabled: false, conditionalReadRulesRaw: null, systemKind: null, copiedFromKind: null })

  it('K-01 WITH data from a stamped source → 403 COPY_SOURCE_GRID_EXPORT_CLOSED (dry-run and execute share planCopySheet)', async () => {
    const log: Log = []
    const query = makeAnswer(log, new Set([CLOSED]))
    await expect(copyService.planCopySheet(query as never, { sourceSheetId: CLOSED, name: null, withData: true, permissionMode: 'inherit' }, actor as never, {}, {
      copierCanManageSourceFields: false,
      overLimit: 'report',
      source: source(CLOSED) as never,
    })).rejects.toMatchObject({ statusCode: 403, code: 'COPY_SOURCE_GRID_EXPORT_CLOSED' })
    // Refused before a single record is counted or read.
    expect(log.some((entry) => /FROM meta_records/.test(entry.sql))).toBe(false)
  })

  it('K-02 structure-only from a stamped source is not refused (and issues no closure lookup); with data from an unstamped one is not refused', async () => {
    for (const [sheetId, withData] of [[CLOSED, false], [OPEN_DERIVED, true]] as const) {
      const log: Log = []
      const query = makeAnswer(log, new Set([CLOSED]))
      const outcome = await copyService.planCopySheet(query as never, { sourceSheetId: sheetId, name: null, withData, permissionMode: 'inherit' }, actor as never, {}, {
        copierCanManageSourceFields: false,
        overLimit: 'report',
        source: source(sheetId) as never,
      }).then(() => null, (error: unknown) => error as { code?: string })
      expect(outcome?.code, `${sheetId} withData=${withData}`).not.toBe('COPY_SOURCE_GRID_EXPORT_CLOSED')
      if (!withData) expect(log.some((entry) => entry.sql === collapse(GRID_EXPORT_CLOSED_SHEET_IDS_SQL))).toBe(false)
    }
  })

  it('K-03 the refusal runs in planCopySheet right after the system-sheet refusal (both copy routes and the in-transaction plan pass it)', () => {
    const source = readFileSync(join(__dirname, '../../src/multitable/copy-sheet-service.ts'), 'utf8').replace(/\r\n/g, '\n')
    expect(source).toMatch(/await assertSourceIsNotSystemSheet\(query, source\)\n\s*await assertSourceGridExportOpenForData\(query, source\.id, request\.withData\)/)
  })
})

describe('P — the plugin ports', () => {
  const derived = (projectId: string, objectId: string) => getObjectSheetId(projectId, objectId)
  function build({ pluginName = PLUGIN, withHost = true, assertSheetOwnedByPlugin = vi.fn(async () => {}), isSheetOwnedByProject = vi.fn(async () => true) }: {
    pluginName?: string
    withHost?: boolean
    assertSheetOwnedByPlugin?: ((input: { pluginName: string; sheetId: string }) => Promise<void>) | null
    isSheetOwnedByProject?: (input: { sheetId: string; projectId: string }) => Promise<boolean>
  } = {}) {
    const close = vi.fn(async (input: { sheetId: string }) => ({ sheetId: input.sheetId, present: true, closure: 'stock_prep_pilot' as const, closedAt: CLOSED_AT, closedBy: 'u_x', alreadyClosed: false }))
    const read = vi.fn(async (input: { sheetId: string }) => ({ sheetId: input.sheetId, present: true, closure: null, closedAt: null, closedBy: null }))
    const multitable = {
      provisioning: {
        getObjectSheetId: derived,
        isSheetOwnedByProject: vi.fn(async () => { throw new Error('the hook, not the host, must answer') }),
        ...(withHost ? { closeSheetGridExport: close, getSheetGridExportClosure: read } : {}),
      },
      records: {},
    }
    const hooks = assertSheetOwnedByPlugin === null ? { isSheetOwnedByProject } : { assertSheetOwnedByPlugin, isSheetOwnedByProject }
    const scoped = createPluginScopedMultitableApi(multitable as never, pluginName, hooks)
    return { scoped, close, read, assertSheetOwnedByPlugin, isSheetOwnedByProject }
  }
  const good = { projectId: PROJECT_ID, sheetId: CLOSED, objectId: OBJECT_ID, actorId: ' u_pilot_admin ' }

  it('P-01 handed to plugin-integration-core ONLY, and only when the host has it', () => {
    for (const other of ['plugin-attendance', 'plugin-after-sales', 'plugin-integration-core-fork', 'Plugin-Integration-Core']) {
      const b = build({ pluginName: other })
      expect('closeSheetGridExport' in b.scoped.provisioning, other).toBe(false)
      expect('getSheetGridExportClosure' in b.scoped.provisioning, other).toBe(false)
    }
    expect(typeof build().scoped.provisioning.closeSheetGridExport).toBe('function')
    expect(typeof build().scoped.provisioning.getSheetGridExportClosure).toBe('function')
    expect(build({ withHost: false }).scoped.provisioning.closeSheetGridExport).toBeUndefined()
  })

  for (const port of ['closeSheetGridExport', 'getSheetGridExportClosure'] as const) {
    it(`P-02 ${port} refuses, in order, before the host method runs`, async () => {
      const call = (b: ReturnType<typeof build>, input: typeof good) => (b.scoped.provisioning[port] as (i: typeof good) => Promise<unknown>)(input)
      const hostOf = (b: ReturnType<typeof build>) => (port === 'closeSheetGridExport' ? b.close : b.read)

      let b = build()
      await expect(call(b, { ...good, projectId: 'tenant_gec:attendance' })).rejects.toBeInstanceOf(MultitableProjectNamespaceError)
      expect(hostOf(b)).not.toHaveBeenCalled()

      for (const objectId of ['plm_stock_preparation_main', 'plm_stock_preparation_project_overview', 'plm_stock_preparation_sandbox_p_abc']) {
        b = build()
        await expect(call(b, { ...good, objectId, sheetId: derived(PROJECT_ID, objectId) })).rejects.toMatchObject({ code: 'MULTITABLE_GRID_EXPORT_CLOSURE_OBJECT_NOT_PROJECT_SHEET' })
        expect(hostOf(b)).not.toHaveBeenCalled()
        expect(b.assertSheetOwnedByPlugin).not.toHaveBeenCalled()
      }

      for (const sheetId of [OPEN_DERIVED, PLAIN, '', derived('tenant_other:integration-core', OBJECT_ID)]) {
        b = build()
        await expect(call(b, { ...good, sheetId })).rejects.toMatchObject({ code: 'MULTITABLE_GRID_EXPORT_CLOSURE_SHEET_MISMATCH' })
        expect(hostOf(b)).not.toHaveBeenCalled()
        expect(b.assertSheetOwnedByPlugin).not.toHaveBeenCalled()
      }

      b = build({ assertSheetOwnedByPlugin: vi.fn(async ({ pluginName, sheetId }) => { throw new MultitableSheetScopeError(pluginName, sheetId, 'plugin-attendance') }) })
      await expect(call(b, good)).rejects.toBeInstanceOf(MultitableSheetScopeError)
      expect(hostOf(b)).not.toHaveBeenCalled()
      expect(b.isSheetOwnedByProject).not.toHaveBeenCalled()

      b = build({ assertSheetOwnedByPlugin: null })
      await expect(call(b, good)).rejects.toBeInstanceOf(MultitableSheetScopeError)
      expect(hostOf(b)).not.toHaveBeenCalled()

      b = build({ isSheetOwnedByProject: vi.fn(async () => false) })
      await expect(call(b, good)).rejects.toBeInstanceOf(MultitableSheetScopeError)
      expect(hostOf(b)).not.toHaveBeenCalled()

      b = build()
      await call(b, good)
      expect(hostOf(b)).toHaveBeenCalledTimes(1)
      if (port === 'closeSheetGridExport') {
        expect(b.close).toHaveBeenCalledWith({ projectId: PROJECT_ID, sheetId: CLOSED, objectId: OBJECT_ID, actorId: 'u_pilot_admin' })
      } else {
        expect(b.read).toHaveBeenCalledWith({ projectId: PROJECT_ID, sheetId: CLOSED, objectId: OBJECT_ID })
      }
      expect(b.assertSheetOwnedByPlugin).toHaveBeenCalledWith({ pluginName: PLUGIN, sheetId: CLOSED })
      expect(b.isSheetOwnedByProject).toHaveBeenCalledWith({ sheetId: CLOSED, projectId: PROJECT_ID })
    })
  }

  it('P-03 a getter cannot show the gate one sheet and the host another (values read once)', async () => {
    const b = build()
    let reads = 0
    const input = {
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      get sheetId() { reads += 1; return reads === 1 ? CLOSED : OPEN_DERIVED },
    }
    await b.scoped.provisioning.closeSheetGridExport!(input as never)
    expect(b.close).toHaveBeenCalledWith(expect.objectContaining({ sheetId: CLOSED }))
    expect(reads).toBe(1)
  })

  it('P-04 there is NO reopen / unset port: not on the scoped surface, not in the host type, not in the host binding', () => {
    const scopedKeys = Object.keys(build().scoped.provisioning)
    expect(scopedKeys.filter((key) => /grid ?export/i.test(key)).sort()).toEqual(['closeSheetGridExport', 'getSheetGridExportClosure'])
    expect(scopedKeys.filter((key) => /(reopen|unset|unclose|clear|open)\w*(grid|export)/i.test(key))).toEqual([])
    const src = (rel: string) => readFileSync(join(__dirname, '../../src', rel), 'utf8')
    for (const rel of ['types/plugin.ts', 'multitable/plugin-scope.ts', 'index.ts']) {
      expect(src(rel), rel).not.toMatch(/\b(reopen|unset|unclose|clear|open)\w*GridExport/i)
    }
  })
})

describe('S — the close / read service', () => {
  function fakeQuery(opts: { liveness?: 'live' | 'deleted' | 'missing'; stamped?: { at: string; by: string | null } | null; missingColumn?: boolean } = {}) {
    const statements: Array<{ sql: string; params: unknown[] }> = []
    let stamped = opts.stamped ?? null
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const q = collapse(sql)
      statements.push({ sql: q, params })
      if (q === 'SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE') {
        if (opts.liveness === 'missing') return { rows: [], rowCount: 0 }
        return { rows: [{ deleted_at: opts.liveness === 'deleted' ? new Date() : null }], rowCount: 1 }
      }
      if (q.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
      if (q.includes("table_name = 'meta_sheets' AND column_name = 'recovery_writer_state'")) return { rows: [], rowCount: 0 }
      if (q === collapse(CLOSE_SHEET_GRID_EXPORT_SQL)) {
        if (opts.missingColumn) throw Object.assign(new Error('column "grid_export_closure" does not exist'), { code: '42703' })
        if (stamped) return { rows: [], rowCount: 0 }
        stamped = { at: CLOSED_AT, by: params[2] as string | null }
        return { rows: [{ grid_export_closure: params[1], grid_export_closed_at: new Date(CLOSED_AT), grid_export_closed_by: params[2] }], rowCount: 1 }
      }
      if (q === collapse(READ_SHEET_GRID_EXPORT_CLOSURE_SQL)) {
        if (opts.liveness === 'missing') return { rows: [], rowCount: 0 }
        return { rows: [{ grid_export_closure: stamped ? 'stock_prep_pilot' : null, grid_export_closed_at: stamped?.at ?? null, grid_export_closed_by: stamped?.by ?? null }], rowCount: 1 }
      }
      throw new Error(`Unhandled SQL in test: ${q}`)
    })
    return { query, statements }
  }
  const fenceEnv = process.env.MULTITABLE_ENABLE_WRITER_FENCE
  afterEach(() => {
    if (fenceEnv === undefined) delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    else process.env.MULTITABLE_ENABLE_WRITER_FENCE = fenceEnv
  })

  it('S-01 refuses a non-derived id before any statement', async () => {
    for (const sheetId of [PLAIN, '', 'sheet_ABCDEF0123456789abcdef01', `${CLOSED} `.repeat(2)]) {
      const { query, statements } = fakeQuery()
      await expect(closeSheetGridExport(query, { sheetId })).rejects.toBeInstanceOf(SheetGridExportClosureError)
      await expect(readSheetGridExportClosure(query, { sheetId })).rejects.toMatchObject({ status: 422, code: 'MULTITABLE_GRID_EXPORT_CLOSURE_SHEET_INVALID' })
      expect(statements).toEqual([])
    }
  })

  it('S-02 fence flag off: row lock + liveness, then the ONE set-once UPDATE with the literal reason and the trimmed actor', async () => {
    delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
    const { query, statements } = fakeQuery()
    const result = await closeSheetGridExport(query, { sheetId: CLOSED, actorId: ' u_pilot_admin ' })
    expect(result).toEqual({ sheetId: CLOSED, present: true, closure: 'stock_prep_pilot', closedAt: CLOSED_AT, closedBy: 'u_pilot_admin', alreadyClosed: false })
    expect(statements.map((s) => s.sql)).toEqual(['SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE', collapse(CLOSE_SHEET_GRID_EXPORT_SQL)])
    expect(statements[1].params).toEqual([CLOSED, 'stock_prep_pilot', 'u_pilot_admin'])
    expect(collapse(CLOSE_SHEET_GRID_EXPORT_SQL)).toContain('WHERE id = $1 AND grid_export_closure IS NULL')
  })

  it('S-03 fence flag on: the canonical writer fence is the FIRST statement, then the row lock', async () => {
    process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
    const { query, statements } = fakeQuery()
    await closeSheetGridExport(query, { sheetId: CLOSED, actorId: null })
    expect(statements[0].sql).toBe('SELECT pg_advisory_xact_lock(hashtext($1))')
    expect(statements[0].params).toEqual([`meta:auto-number:sheet:${CLOSED}`])
    expect(statements.findIndex((s) => s.sql.endsWith('FOR UPDATE'))).toBeGreaterThan(0)
    expect(statements.at(-1)?.sql).toBe(collapse(CLOSE_SHEET_GRID_EXPORT_SQL))
  })

  it('S-04 idempotent: an already-stamped sheet is reported with its ORIGINAL time and actor and nothing is moved', async () => {
    const { query, statements } = fakeQuery({ stamped: { at: CLOSED_AT, by: 'u_first' } })
    const result = await closeSheetGridExport(query, { sheetId: CLOSED, actorId: 'u_second' })
    expect(result).toEqual({ sheetId: CLOSED, present: true, closure: 'stock_prep_pilot', closedAt: CLOSED_AT, closedBy: 'u_first', alreadyClosed: true })
    expect(statements.filter((s) => s.sql.startsWith('UPDATE'))).toHaveLength(1)
  })

  it('S-05 a dead sheet is refused with no UPDATE; a missing column is 503, never a silent success', async () => {
    for (const liveness of ['deleted', 'missing'] as const) {
      const { query, statements } = fakeQuery({ liveness })
      await expect(closeSheetGridExport(query, { sheetId: CLOSED })).rejects.toBeInstanceOf(SheetNotLiveError)
      expect(statements.some((s) => s.sql.startsWith('UPDATE'))).toBe(false)
    }
    const { query } = fakeQuery({ missingColumn: true })
    await expect(closeSheetGridExport(query, { sheetId: CLOSED })).rejects.toMatchObject({ status: 503, code: 'MULTITABLE_GRID_EXPORT_CLOSURE_UNAVAILABLE' })
  })

  it('S-06 the read port: no lock, no write; reports open / closed / absent', async () => {
    const open = fakeQuery()
    expect(await readSheetGridExportClosure(open.query, { sheetId: CLOSED })).toEqual({ sheetId: CLOSED, present: true, closure: null, closedAt: null, closedBy: null })
    expect(open.statements.map((s) => s.sql)).toEqual([collapse(READ_SHEET_GRID_EXPORT_CLOSURE_SQL)])
    const closed = fakeQuery({ stamped: { at: CLOSED_AT, by: 'u_first' } })
    expect(await readSheetGridExportClosure(closed.query, { sheetId: CLOSED })).toEqual({ sheetId: CLOSED, present: true, closure: 'stock_prep_pilot', closedAt: CLOSED_AT, closedBy: 'u_first' })
    const absent = fakeQuery({ liveness: 'missing' })
    expect(await readSheetGridExportClosure(absent.query, { sheetId: CLOSED })).toMatchObject({ present: false, closure: null })
  })

  it('S-07 ONE WRITER: across core-backend/src AND plugins/, the host service holds the only statement that writes grid_export_closure, and nothing writes it back to NULL', () => {
    // Review round 1, fix 4: plugins get a raw `database.query` handle, so the census also walks plugins/ — a plugin
    // (PR B included) that wrote the column directly instead of calling the port would red here.
    const repoRoot = join(__dirname, '../../../..')
    const root = join(__dirname, '../../src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist' || name === '.git') continue
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.(ts|cjs|js|mjs|sql)$/.test(name)) files.push(full)
      }
    }
    walk(root)
    const pluginFilesStart = files.length
    walk(join(repoRoot, 'plugins'))
    expect(files.length - pluginFilesStart, 'the plugins/ walk found files (it is not a silent no-op)').toBeGreaterThan(100)
    const writers: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      if (/grid_export_closure\s*=\s*(NULL|\$\d+|'|\?)/i.test(text) || /SET\s+grid_export_closure/i.test(text) || /\bgrid_export_closure\s*:/i.test(text)) {
        writers.push(relative(repoRoot, file).replace(/\\/g, '/'))
      }
    }
    expect(writers).toEqual(['packages/core-backend/src/services/sheet-grid-export-closure-service.ts'])
    const service = readFileSync(join(root, 'services/sheet-grid-export-closure-service.ts'), 'utf8')
    expect(service.match(/\bUPDATE\s+meta_sheets\b/g)).toHaveLength(1)
    expect(service).not.toMatch(/grid_export_closure\s*=\s*NULL/i)
    expect(service).not.toMatch(/\b(DELETE|INSERT)\b/)
  })
})

describe('M — the migration (fake database)', () => {
  function createFakeDb(state: { closed: number }, recorded: string[]): Kysely<unknown> {
    const connection: DatabaseConnection = {
      async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
        const text = collapse(compiled.sql)
        recorded.push(text)
        if (text.startsWith('SELECT count(*)::int AS count FROM meta_sheets WHERE grid_export_closure IS NOT NULL')) {
          return { rows: [{ count: state.closed }] as unknown as R[] }
        }
        if (text.startsWith('ALTER TABLE meta_sheets') || text.startsWith('DO $$')) return { rows: [] }
        throw new Error(`FAKE_DB_UNKNOWN_STATEMENT: ${text}`)
      },
      streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> { throw new Error('unused') },
    }
    const driver: Driver = {
      async init() {}, async acquireConnection() { return connection }, async beginTransaction() {}, async commitTransaction() {},
      async rollbackTransaction() {}, async releaseConnection() {}, async destroy() {},
    }
    return new Kysely<unknown>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    })
  }

  it('M-01 up(): three nullable columns, then the two CHECKs only when absent', async () => {
    const recorded: string[] = []
    await migrationUp(createFakeDb({ closed: 0 }, recorded))
    expect(recorded.slice(0, 3)).toEqual([
      'ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS grid_export_closure text',
      'ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS grid_export_closed_at timestamptz',
      'ALTER TABLE meta_sheets ADD COLUMN IF NOT EXISTS grid_export_closed_by text',
    ])
    expect(recorded[3]).toContain("CHECK (grid_export_closure IS NULL OR grid_export_closure IN ('stock_prep_pilot'))")
    expect(recorded[3]).toContain('CHECK ((grid_export_closure IS NULL) = (grid_export_closed_at IS NULL))')
    expect(recorded).toHaveLength(4)
  })

  it('M-02 down() with no stamped sheet drops the constraints and the columns', async () => {
    const recorded: string[] = []
    await migrationDown(createFakeDb({ closed: 0 }, recorded))
    expect(recorded[0]).toMatch(/^SELECT count\(\*\)::int AS count FROM meta_sheets WHERE grid_export_closure IS NOT NULL/)
    expect(recorded.filter((text) => text.includes('DROP COLUMN'))).toHaveLength(3)
  })

  it('M-03 down() REFUSES while any sheet is stamped: typed code, the count, and no ALTER at all', async () => {
    const recorded: string[] = []
    const error = await migrationDown(createFakeDb({ closed: 2 }, recorded)).then(() => null, (caught: unknown) => caught as Error & { code?: string })
    expect(error?.code).toBe(GRID_EXPORT_CLOSURE_DOWN_REFUSED_CODE)
    expect(error?.message).toContain('2 sheet(s)')
    expect(recorded.some((text) => text.startsWith('ALTER'))).toBe(false)
  })
})
