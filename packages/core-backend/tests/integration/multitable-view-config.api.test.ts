import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { configRevisionNoop } from './config-revision-mock'

// ---------------------------------------------------------------------------
// MOCK-POOL CONTRACT (read before editing — this is a hand-rolled SQL matcher).
//
// POST /views and PATCH /views/:viewId each fan out to a fixed set of queries.
// Every query the handler issues MUST have a matching `if (sql.includes(...))`
// branch in the test's queryHandler, or the route's try/catch swallows the
// "Unhandled SQL in test" throw and returns 500 (silent regression — see #2052
// / #2068 redaction wiring that this net guards). The branches a handler needs:
//
//   POST /views (create):
//     1. SELECT sp.sheet_id, sp.perm_code, sp.subject_type ...   (sheet ACL → capabilities)
//     2. SELECT id FROM meta_sheets WHERE id = $1 ...            (sheet existence)
//     3. SELECT id, name, type, property, "order" FROM meta_fields
//          WHERE sheet_id = $1 AND id = $2                       (gantt/hierarchy dep field, gantt/hierarchy only)
//     4. SELECT id, name, type, property, "order" FROM meta_fields
//          WHERE sheet_id = $1 ORDER BY ...                      (loadFieldsForSheet — #2052 allowed-field set)
//     5. SELECT fp.field_id, fp.visible, fp.read_only FROM field_permissions fp
//          WHERE fp.sheet_id = $2 ...                            (loadFieldPermissionScopeMap — #2052)
//     6. INSERT INTO meta_views ...
//
//   PATCH /views/:viewId (update):
//     1. SELECT sp.sheet_id, sp.perm_code, sp.subject_type ...   (sheet ACL → capabilities)
//     2. SELECT id, sheet_id, name, type, filter_info, ... FROM meta_views WHERE id = $1  (current row)
//     3. + 4. the same two loadAllowedFieldIds queries as POST (4 & 5 above) — run UP FRONT,
//             before validateGanttDependencyConfig, so a malformed mock 500s before the 400.
//     5. SELECT id, name, type, property, "order" FROM meta_fields
//          WHERE sheet_id = $1 AND id = $2                       (gantt/hierarchy dep field, gantt/hierarchy only)
//     6. UPDATE meta_views ...
//
// `matchAllowedFieldQueries` below satisfies branches (4) & (5); callers supply
// the sheet's field rows so the redaction path genuinely runs over a real field
// set. field_permissions returns [] (no per-field denials) → all fields allowed
// → redactViewConfigFilterLiterals is a no-op (none of these configs carry
// filterInfo.conditions literals), so assertions stay exact.
// ---------------------------------------------------------------------------

type QueryResult = {
  rows: any[]
  rowCount?: number
}

type QueryHandler = (sql: string, params?: unknown[]) => QueryResult | Promise<QueryResult>

type FieldRow = {
  id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

// Satisfies the #2052 loadAllowedFieldIds query pair (loadFieldsForSheet +
// loadFieldPermissionScopeMap). Returns the matching QueryResult, or null when
// `sql` is some other query the caller must handle itself.
function matchAllowedFieldQueries(
  sql: string,
  params: unknown[] | undefined,
  fieldsBySheet: Record<string, FieldRow[]>,
): QueryResult | null {
  // loadFieldsForSheet — full field list, ORDER BY (distinct from the gantt
  // single-field lookup which has `AND id = $2`).
  if (sql.includes('FROM meta_fields') && sql.includes('ORDER BY') && !sql.includes('AND id = $2')) {
    const sheetId = String((params ?? [])[0] ?? '')
    return { rows: fieldsBySheet[sheetId] ?? [] }
  }
  // loadFieldPermissionScopeMap — no per-field denials → empty set → all fields allowed.
  if (sql.includes('FROM field_permissions fp')) {
    return { rows: [] }
  }
  return null
}

const SHEET_OPS_FIELDS: FieldRow[] = [
  { id: 'fld_title', name: 'Title', type: 'string', property: {}, order: 0 },
  { id: 'fld_owner', name: 'Owner', type: 'string', property: {}, order: 1 },
  { id: 'fld_status', name: 'Status', type: 'singleSelect', property: {}, order: 2 },
]

function createMockPool(queryHandler: QueryHandler) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const cr = configRevisionNoop(sql); if (cr) return cr // narrowed INSERT-only match (shared helper)
    return queryHandler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(args: {
  tokenPerms?: string[]
  queryHandler?: QueryHandler
  fallbackPermissions?: string[]
  fallbackHasPermission?: boolean
}) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockImplementation(async (_userId: string, code: string) => {
      if (code === 'multitable:read' || code === 'multitable:write') {
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
      roles: [],
      perms: args.tokenPerms ?? [],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())

  return { app, mockPool }
}

describe('Multitable view config API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  test('creates a view with persisted config payload', async () => {
    let insertParams: unknown[] | undefined

    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT sp.sheet_id, sp.perm_code, sp.subject_type')) {
          expect(params).toEqual(['user_multitable_1', ['sheet_ops']])
          return { rows: [] }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        const allowed = matchAllowedFieldQueries(sql, params, { sheet_ops: SHEET_OPS_FIELDS })
        if (allowed) return allowed
        if (sql.includes('INSERT INTO meta_views')) {
          insertParams = params
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/views')
      .send({
        sheetId: 'sheet_ops',
        name: 'Gallery',
        type: 'gallery',
        config: {
          titleFieldId: 'fld_title',
          columns: 4,
          cardSize: 'large',
        },
      })
      .expect(201)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.view).toMatchObject({
      sheetId: 'sheet_ops',
      name: 'Gallery',
      type: 'gallery',
      config: {
        titleFieldId: 'fld_title',
        columns: 4,
        cardSize: 'large',
      },
    })
    expect(insertParams?.[1]).toBe('sheet_ops')
    expect(insertParams?.[2]).toBe('Gallery')
    expect(insertParams?.[3]).toBe('gallery')
    expect(insertParams?.[8]).toBe(JSON.stringify({
      titleFieldId: 'fld_title',
      columns: 4,
      cardSize: 'large',
    }))
  })

  test('updates view config and groupInfo through PATCH /views/:viewId', async () => {
    let updateParams: unknown[] | undefined
    // NIT-1: positively assert the #2052/#2068 redaction wiring actually runs on
    // this path — a future refactor that deletes the loadAllowedFieldIds call would
    // otherwise leave the mock branch unused and these tests silently green.
    let sawFieldPermissionQuery = false

    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM field_permissions fp')) sawFieldPermissionQuery = true
        if (sql.includes('SELECT sp.sheet_id, sp.perm_code, sp.subject_type')) {
          expect(params).toEqual(['user_multitable_1', ['sheet_ops']])
          return { rows: [] }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_kanban'])
          return {
            rows: [{
              id: 'view_kanban',
              sheet_id: 'sheet_ops',
              name: 'Kanban',
              type: 'kanban',
              filter_info: {},
              sort_info: {},
              group_info: { fieldId: 'fld_status_old' },
              hidden_field_ids: [],
              config: { groupFieldId: 'fld_status_old', cardFieldIds: ['fld_title'] },
            }],
          }
        }
        const allowed = matchAllowedFieldQueries(sql, params, { sheet_ops: SHEET_OPS_FIELDS })
        if (allowed) return allowed
        if (sql.includes('UPDATE meta_views')) {
          updateParams = params
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/views/view_kanban')
      .send({
        groupInfo: { fieldId: 'fld_status' },
        config: {
          groupFieldId: 'fld_status',
          cardFieldIds: ['fld_title', 'fld_owner'],
        },
      })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.view).toMatchObject({
      id: 'view_kanban',
      sheetId: 'sheet_ops',
      type: 'kanban',
      groupInfo: { fieldId: 'fld_status' },
      config: {
        groupFieldId: 'fld_status',
        cardFieldIds: ['fld_title', 'fld_owner'],
      },
    })
    expect(updateParams?.[0]).toBe('view_kanban')
    expect(updateParams?.[5]).toBe(JSON.stringify({ fieldId: 'fld_status' }))
    // The redaction wiring (loadAllowedFieldIds → loadFieldPermissionScopeMap) ran.
    expect(sawFieldPermissionQuery).toBe(true)
    expect(updateParams?.[7]).toBe(JSON.stringify({
      groupFieldId: 'fld_status',
      cardFieldIds: ['fld_title', 'fld_owner'],
    }))
  })

  test('rejects Gantt dependency config when dependency field links to another sheet', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT sp.sheet_id, sp.perm_code, sp.subject_type')) {
          expect(params).toEqual(['user_multitable_1', ['sheet_ops']])
          return { rows: [] }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_gantt'])
          return {
            rows: [{
              id: 'view_gantt',
              sheet_id: 'sheet_ops',
              name: 'Gantt',
              type: 'gantt',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
          }
        }
        const allowed = matchAllowedFieldQueries(sql, params, { sheet_ops: SHEET_OPS_FIELDS })
        if (allowed) return allowed
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 AND id = $2')) {
          expect(params).toEqual(['sheet_ops', 'fld_cross_sheet'])
          return {
            rows: [{
              id: 'fld_cross_sheet',
              name: 'External dependency',
              type: 'link',
              property: { foreignSheetId: 'sheet_other' },
              order: 3,
            }],
          }
        }
        if (sql.includes('UPDATE meta_views')) {
          throw new Error('UPDATE should not run for invalid Gantt dependency config')
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/views/view_gantt')
      .send({
        config: {
          startFieldId: 'fld_start',
          endFieldId: 'fld_end',
          dependencyFieldId: 'fld_cross_sheet',
        },
      })
      .expect(400)

    expect(response.body.ok).toBe(false)
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Gantt dependency field must be a self-table link field: fld_cross_sheet',
    })
    expect(mockPool.query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE meta_views'), expect.anything())
  })

  test('allows Gantt dependency config when dependency field links to the same sheet', async () => {
    let updateParams: unknown[] | undefined

    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT sp.sheet_id, sp.perm_code, sp.subject_type')) {
          expect(params).toEqual(['user_multitable_1', ['sheet_ops']])
          return { rows: [] }
        }
        if (sql.includes('SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_gantt'])
          return {
            rows: [{
              id: 'view_gantt',
              sheet_id: 'sheet_ops',
              name: 'Gantt',
              type: 'gantt',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
          }
        }
        const allowed = matchAllowedFieldQueries(sql, params, { sheet_ops: SHEET_OPS_FIELDS })
        if (allowed) return allowed
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 AND id = $2')) {
          expect(params).toEqual(['sheet_ops', 'fld_deps'])
          return {
            rows: [{
              id: 'fld_deps',
              name: 'Dependencies',
              type: 'link',
              property: { foreignSheetId: 'sheet_ops' },
              order: 3,
            }],
          }
        }
        if (sql.includes('UPDATE meta_views')) {
          updateParams = params
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .patch('/api/multitable/views/view_gantt')
      .send({
        config: {
          startFieldId: 'fld_start',
          endFieldId: 'fld_end',
          dependencyFieldId: 'fld_deps',
        },
      })
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data.view.config).toMatchObject({
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      dependencyFieldId: 'fld_deps',
    })
    expect(updateParams?.[7]).toBe(JSON.stringify({
      startFieldId: 'fld_start',
      endFieldId: 'fld_end',
      dependencyFieldId: 'fld_deps',
    }))
  })

  test('rejects Gantt dependency config on view creation when dependency field is not self-table', async () => {
    const { app, mockPool } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('SELECT sp.sheet_id, sp.perm_code, sp.subject_type')) {
          expect(params).toEqual(['user_multitable_1', ['sheet_ops']])
          return { rows: [] }
        }
        if (sql.includes('SELECT id FROM meta_sheets WHERE id = $1')) {
          expect(params).toEqual(['sheet_ops'])
          return { rows: [{ id: 'sheet_ops' }] }
        }
        if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 AND id = $2')) {
          expect(params).toEqual(['sheet_ops', 'fld_notes'])
          return {
            rows: [{
              id: 'fld_notes',
              name: 'Notes',
              type: 'string',
              property: {},
              order: 3,
            }],
          }
        }
        if (sql.includes('INSERT INTO meta_views')) {
          throw new Error('INSERT should not run for invalid Gantt dependency config')
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .post('/api/multitable/views')
      .send({
        sheetId: 'sheet_ops',
        name: 'Gantt',
        type: 'gantt',
        config: {
          dependencyFieldId: 'fld_notes',
        },
      })
      .expect(400)

    expect(response.body.ok).toBe(false)
    expect(response.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Gantt dependency field must be a self-table link field: fld_notes',
    })
    expect(mockPool.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO meta_views'), expect.anything())
  })

  test('deletes a view by id through DELETE /views/:viewId', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_kanban'])
          return {
            rows: [{
              id: 'view_kanban',
              sheet_id: 'sheet_ops',
              name: 'Kanban',
              type: 'kanban',
              filter_info: {},
              sort_info: {},
              group_info: {},
              hidden_field_ids: [],
              config: {},
            }],
            rowCount: 1,
          }
        }
        if (sql.includes('SELECT sp.sheet_id, sp.perm_code, sp.subject_type')) {
          expect(params).toEqual(['user_multitable_1', ['sheet_ops']])
          return { rows: [] }
        }
        if (sql.includes('DELETE FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_kanban'])
          return { rows: [], rowCount: 1 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/views/view_kanban')
      .expect(200)

    expect(response.body.ok).toBe(true)
    expect(response.body.data).toEqual({ deleted: 'view_kanban' })
  })

  test('returns 404 when deleting a missing view through DELETE /views/:viewId', async () => {
    const { app } = await createApp({
      tokenPerms: ['multitable:write'],
      queryHandler: async (sql, params) => {
        if (sql.includes('FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_missing'])
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('DELETE FROM meta_views WHERE id = $1')) {
          expect(params).toEqual(['view_missing'])
          return { rows: [], rowCount: 0 }
        }
        throw new Error(`Unhandled SQL in test: ${sql}`)
      },
    })

    const response = await request(app)
      .delete('/api/multitable/views/view_missing')
      .expect(404)

    expect(response.body.ok).toBe(false)
    expect(response.body.error.code).toBe('NOT_FOUND')
    expect(response.body.error.message).toBe('View not found: view_missing')
  })
})
