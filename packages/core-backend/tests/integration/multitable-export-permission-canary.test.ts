/**
 * Export permission projection regression tests (benchmark v2 #3 / Gap 7, D3c).
 *
 * These guard the D3c fix to the export-xlsx route (univer-meta.ts GET
 * /sheets/:sheetId/export-xlsx): exported fields must mirror the view path's masking
 * — subject-scoped `field_permissions` AND `view.hidden_field_ids`, not only static
 * `property.hidden`. Authored as RED canaries against pre-fix main (the field leaked
 * in header + cells); now GREEN regression guards that ship WITH the fix.
 * See docs/development/multitable-d3-permission-matrix-design-20260525.md §3.
 *
 * Record-scope is intentionally NOT covered here: tracing the view-path filter
 * (univer-meta.ts record-permission filtering) shows it is a no-op for hiding —
 * deriveRecordPermissions defaults to allow and treats access_level ∈
 * {read,write,admin} all as canRead, so no per-record read-deny exists anywhere.
 * An export-projection-only fix cannot enforce a record-read restriction that the
 * product model doesn't have; that is a separate model question (out of D3c scope).
 *
 * Harness note: route-level integration with a mocked pool (the gap is in route
 * LOGIC, exercised for real). The full 5-class golden matrix (D3d) will use a real
 * DB with real seeded permission rows.
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { XlsxModule } from '../../src/multitable/xlsx-service'

type QueryResult = { rows: any[]; rowCount?: number }
type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

const SHEET_ID = 'sheet_canary'
// fld_secret has property {} — NOT statically hidden, so filterVisiblePropertyFields
// keeps it. It is hidden ONLY via subject-scoped field_permissions / view hidden list.
const FIELD_ROWS = [
  { id: 'fld_name', name: 'Name', type: 'string', property: {}, order: 1 },
  { id: 'fld_amount', name: 'Amount', type: 'number', property: {}, order: 2 },
  { id: 'fld_secret', name: 'Secret', type: 'string', property: {}, order: 3 },
]
const RECORD_ROWS = [
  { id: 'rec_1', sheet_id: SHEET_ID, version: 1, data: { fld_name: 'Alpha', fld_amount: 12, fld_secret: 'topsecret' } },
]

const xlsx = await import('xlsx') as unknown as XlsxModule

function createMockPool(opts: {
  fieldPermissionRows?: Array<{ field_id: string; visible: boolean; read_only: boolean }>
  viewRow?: Record<string, unknown> | null
}) {
  const handler: QueryHandler = (sql, params) => {
    // --- seeded permission/view data (the shapes a D3c fix would consume) ---
    if (sql.includes('FROM field_permissions')) {
      return { rows: opts.fieldPermissionRows ?? [], rowCount: (opts.fieldPermissionRows ?? []).length }
    }
    if (sql.includes('FROM meta_views WHERE id = $1')) {
      return { rows: opts.viewRow ? [opts.viewRow] : [], rowCount: opts.viewRow ? 1 : 0 }
    }
    // --- other permission tables: empty (no extra restriction) ---
    if (sql.includes('FROM spreadsheet_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM view_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM meta_view_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM record_permissions')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM formula_dependencies')) return { rows: [], rowCount: 0 }
    // --- sheet / fields / records ---
    if (sql.includes('SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID, base_id: 'base_canary', name: 'Canary Sheet', description: null }] }
    }
    if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL')) {
      return { rows: [{ id: SHEET_ID }] }
    }
    if (sql.includes('FROM meta_fields WHERE sheet_id = $1')) {
      return { rows: FIELD_ROWS }
    }
    if (sql.includes('FROM meta_records') && sql.includes('SELECT id, sheet_id, version, data')) {
      expect(params?.[0]).toBe(SHEET_ID)
      return { rows: RECORD_ROWS }
    }
    return { rows: [], rowCount: 0 }
  }
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params))
  const transaction = vi.fn(async (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(mockArgs: Parameters<typeof createMockPool>[0]) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue([]),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))
  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(mockArgs)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = { id: 'user_canary', roles: [], perms: ['multitable:read'], permissions: ['multitable:read'] } as any
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

async function exportRows(
  app: express.Express,
  viewId?: string,
  fieldIds?: string,
): Promise<string[][]> {
  const params = new URLSearchParams()
  if (viewId) params.set('viewId', viewId)
  if (fieldIds !== undefined) params.set('fieldIds', fieldIds)
  const qs = params.toString()
  const url = `/api/multitable/sheets/${SHEET_ID}/export-xlsx${qs ? `?${qs}` : ''}`
  const response = await request(app)
    .get(url)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    })
    .expect(200)
  const parsed = xlsx.read(response.body, { type: 'buffer' })
  return xlsx.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]], { header: 1, raw: false, defval: '' }) as string[][]
}

describe('multitable export permission projection (D3c regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('CANARY field-scope: field hidden via field_permissions.visible=false must NOT appear in export header or cells', async () => {
    // user has sheet read+export; field_permissions hides fld_secret for this user.
    const app = await createApp({
      fieldPermissionRows: [{ field_id: 'fld_secret', visible: false, read_only: false }],
    })
    const rows = await exportRows(app)
    const header = rows[0] ?? []
    const flat = rows.flat()
    // export must apply field_permissions (D3c): 'Secret' + 'topsecret' masked.
    expect(header).not.toContain('Secret')
    expect(flat).not.toContain('topsecret')
  })

  test('CANARY view-scope: field in view.hidden_field_ids must NOT appear in export header or cells', async () => {
    const app = await createApp({
      viewRow: {
        id: 'view_secret',
        sheet_id: SHEET_ID,
        name: 'Secret View',
        type: 'grid',
        filter_info: null,
        sort_info: null,
        group_info: null,
        hidden_field_ids: ['fld_secret'],
        config: null,
      },
    })
    const rows = await exportRows(app, 'view_secret')
    const header = rows[0] ?? []
    const flat = rows.flat()
    // export must apply view.hidden_field_ids (D3c), not just validate viewId existence.
    expect(header).not.toContain('Secret')
    expect(flat).not.toContain('topsecret')
  })
})

describe('multitable export column selection (fieldIds intersection, mask-preserving)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('fieldIds=[Name,Secret] subset → only Name+Amount? no — exports requested INTERSECT visible (Name only of the two has no extra restriction)', async () => {
    // No extra restriction: all 3 are visible. Selecting a subset narrows the export.
    const app = await createApp({})
    const rows = await exportRows(app, undefined, 'fld_name,fld_secret')
    const header = rows[0] ?? []
    // Field order is preserved (sheet order), Amount excluded (not requested).
    expect(header).toEqual(['Name', 'Secret'])
    expect(header).not.toContain('Amount')
  })

  test('SECURITY CANARY: fieldIds including a DENIED field must STILL exclude it (selection cannot bypass field_permissions mask)', async () => {
    // user is denied fld_secret via field_permissions; caller requests it explicitly.
    const app = await createApp({
      fieldPermissionRows: [{ field_id: 'fld_secret', visible: false, read_only: false }],
    })
    // request BOTH a permitted field and the denied one — selection must not widen.
    const rows = await exportRows(app, undefined, 'fld_name,fld_secret')
    const header = rows[0] ?? []
    const flat = rows.flat()
    // The load-bearing invariant: fieldIds intersects ON TOP of the mask, never bypasses it.
    expect(header).toEqual(['Name'])
    expect(header).not.toContain('Secret')
    expect(flat).not.toContain('topsecret')
  })

  test('SECURITY CANARY (view-hidden): fieldIds including a view.hidden_field_ids field must STILL exclude it', async () => {
    const app = await createApp({
      viewRow: {
        id: 'view_secret',
        sheet_id: SHEET_ID,
        name: 'Secret View',
        type: 'grid',
        filter_info: null,
        sort_info: null,
        group_info: null,
        hidden_field_ids: ['fld_secret'],
        config: null,
      },
    })
    const rows = await exportRows(app, 'view_secret', 'fld_name,fld_secret')
    const header = rows[0] ?? []
    const flat = rows.flat()
    expect(header).toEqual(['Name'])
    expect(flat).not.toContain('topsecret')
  })

  test('REGRESSION: no fieldIds → unchanged behavior (all permitted columns exported)', async () => {
    const app = await createApp({})
    const rows = await exportRows(app)
    const header = rows[0] ?? []
    expect(header).toEqual(['Name', 'Amount', 'Secret'])
  })

  test('foreign/unknown id in fieldIds → ignored (intersection drops it)', async () => {
    const app = await createApp({})
    const rows = await exportRows(app, undefined, 'fld_name,fld_does_not_exist')
    const header = rows[0] ?? []
    expect(header).toEqual(['Name'])
  })

  test('all-foreign fieldIds (selection resolves to zero exportable columns) → 400, not an empty/200 file', async () => {
    const app = await createApp({})
    const response = await request(app)
      .get(`/api/multitable/sheets/${SHEET_ID}/export-xlsx?fieldIds=nope1,nope2`)
      .expect(400)
    expect(response.body?.error?.code).toBe('VALIDATION_ERROR')
  })
})
