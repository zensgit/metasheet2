import { describe, expect, it, vi } from 'vitest'

import {
  ensureObjectDefaultView,
  getObjectSheetId,
  getObjectViewId,
} from '../../src/multitable/provisioning'
import { createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'

/**
 * A managed table with ZERO views cannot be opened, and one unopenable sheet blocks the
 * whole multitable base. Measured on the first real deployment: the pack-installed sandbox
 * carried 3 pack-created role views and opened; the confirmation ledger, the canonical main
 * table and a second sandbox each had 0 views, and the base stayed unopenable until three
 * grid views were inserted by hand.
 *
 * The guarantee this primitive is shaped around is the negative one: a sheet that already
 * has ANY view is left COMPLETELY alone.
 */
type ViewRow = { id: string; sheet_id: string; name: string; type: string }

function createFakeDb(options: { sheetIds: string[]; views?: ViewRow[]; forceZeroCount?: boolean }) {
  const views: ViewRow[] = (options.views ?? []).map((view) => ({ ...view }))
  const statements: string[] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    statements.push(normalized)
    if (normalized.startsWith('SELECT count(*)::int AS view_count')) {
      const [sheetId] = params as [string]
      if (options.forceZeroCount) return { rows: [{ view_count: 0 }] }
      return { rows: [{ view_count: views.filter((view) => view.sheet_id === sheetId).length }] }
    }
    if (normalized.startsWith('SELECT id, base_id, name, description')) {
      const [sheetId] = params as [string]
      if (!options.sheetIds.includes(sheetId)) return { rows: [] }
      return { rows: [{ id: sheetId, base_id: 'base_legacy', name: 'sheet', description: null }] }
    }
    if (normalized.startsWith('INSERT INTO meta_views')) {
      const [id, sheetId, name, type] = params as [string, string, string, string]
      const existing = views.find((view) => view.id === id)
      if (existing) {
        // HONOR THE SQL, do not hard-code the safe semantics into the fake: the first
        // version of this handler always refused the write on an id collision, which made
        // the DO-NOTHING guarantee a tautology -- mutating the real SQL to ON CONFLICT DO
        // UPDATE left every test green (caught by adversarial mutation M2). A fake that
        // vouches for the code must behave like the database would.
        if (/ON CONFLICT \(id\) DO UPDATE/i.test(normalized)) {
          existing.name = name
          existing.type = type
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      views.push({ id, sheet_id: sheetId, name, type })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.startsWith('SELECT id, sheet_id, name, type, filter_info')) {
      const [viewId] = params as [string]
      const found = views.find((view) => view.id === viewId)
      return {
        rows: found
          ? [{ ...found, filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {} }]
          : [],
      }
    }
    // fenceWriterEntry and anything else the primitive's neighbours do.
    return { rows: [], rowCount: 0 }
  })
  return { query, views, statements }
}

const PROJECT_ID = 'tenant_1:integration-core'
const OBJECT_ID = 'plm_stock_preparation_main'
const SHEET_ID = getObjectSheetId(PROJECT_ID, OBJECT_ID)

describe('ensureObjectDefaultView', () => {
  it('creates one grid view on a fresh sheet that has none', async () => {
    const db = createFakeDb({ sheetIds: [SHEET_ID] })
    const result = await ensureObjectDefaultView({
      query: db.query,
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      name: 'All Records',
    })
    expect(result).toEqual({
      created: true,
      viewId: getObjectViewId(PROJECT_ID, OBJECT_ID, 'default'),
      existingViewCount: 0,
    })
    expect(db.views).toHaveLength(1)
    expect(db.views[0]).toMatchObject({ sheet_id: SHEET_ID, name: 'All Records', type: 'grid' })
  })

  it('leaves a sheet that already has views COMPLETELY alone (the pack-installed sandbox)', async () => {
    // Stands in for the live pack-installed sandbox: three role views the customer pack
    // created. They must not be touched, duplicated, renamed or reordered.
    const packViews: ViewRow[] = [
      { id: 'view_pack_reader', sheet_id: SHEET_ID, name: 'reader', type: 'grid' },
      { id: 'view_pack_operator', sheet_id: SHEET_ID, name: 'operator', type: 'grid' },
      { id: 'view_pack_admin', sheet_id: SHEET_ID, name: 'admin', type: 'grid' },
    ]
    const before = JSON.stringify(packViews)
    const db = createFakeDb({ sheetIds: [SHEET_ID], views: packViews })

    const result = await ensureObjectDefaultView({
      query: db.query,
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      name: 'All Records',
    })

    expect(result).toEqual({ created: false, viewId: null, existingViewCount: 3 })
    // Byte-identical view list, same order.
    expect(JSON.stringify(db.views)).toBe(before)
    // And CONSTRUCTIVELY: no INSERT, no UPDATE, no DELETE against meta_views was issued.
    const touched = db.statements.filter(
      (sql) => /^(INSERT|UPDATE|DELETE)/.test(sql) && sql.includes('meta_views'),
    )
    expect(touched).toEqual([])
  })

  it('is idempotent: a re-ensure after it created the view creates nothing', async () => {
    const db = createFakeDb({ sheetIds: [SHEET_ID] })
    const first = await ensureObjectDefaultView({
      query: db.query,
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      name: 'All Records',
    })
    expect(first.created).toBe(true)
    const second = await ensureObjectDefaultView({
      query: db.query,
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      name: 'All Records',
    })
    expect(second).toEqual({ created: false, viewId: null, existingViewCount: 1 })
    expect(db.views).toHaveLength(1)
  })

  it('an id collision mutates nothing: ON CONFLICT DO NOTHING is load-bearing (TOCTOU race)', async () => {
    // Simulates the check-then-act window: the count SELECT sees zero views, but by the
    // time the INSERT lands, a row with the SAME deterministic id already exists (two
    // concurrent ensures). DO NOTHING must leave that row byte-identical; the DO-UPDATE
    // mutation of this statement must fail HERE, not survive on a vouching fake.
    const viewId = getObjectViewId(PROJECT_ID, OBJECT_ID, 'default')
    const db = createFakeDb({
      sheetIds: [SHEET_ID],
      views: [{ id: viewId, sheet_id: SHEET_ID, name: 'winner of the race', type: 'grid' }],
      forceZeroCount: true,
    })
    const result = await ensureObjectDefaultView({
      query: db.query,
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      name: 'loser default',
    })
    expect(result.created).toBe(false)
    expect(db.views).toHaveLength(1)
    expect(db.views[0]).toMatchObject({ id: viewId, name: 'winner of the race', type: 'grid' })
    const insert = db.statements.find((sql) => sql.startsWith('INSERT INTO meta_views'))
    expect(insert).toContain('ON CONFLICT (id) DO NOTHING')
    expect(insert).not.toMatch(/DO UPDATE/i)
  })

  it('refuses an empty name and a missing sheet, and writes nothing either way', async () => {
    const db = createFakeDb({ sheetIds: [SHEET_ID] })
    await expect(
      ensureObjectDefaultView({ query: db.query, projectId: PROJECT_ID, objectId: OBJECT_ID, name: '   ' }),
    ).rejects.toThrow(/non-empty view name/)
    const absent = createFakeDb({ sheetIds: [] })
    await expect(
      ensureObjectDefaultView({ query: absent.query, projectId: PROJECT_ID, objectId: OBJECT_ID, name: 'All Records' }),
    ).rejects.toThrow(/missing sheet/)
    expect(db.views).toEqual([])
    expect(absent.views).toEqual([])
  })
})

describe('plugin-scoped ensureObjectDefaultView', () => {
  it('is a WRITE capability: project namespace THEN object scope, never bare-forwarded', async () => {
    const inner = vi.fn(async () => ({ created: true, viewId: 'view_x', existingViewCount: 0 }))
    const assertObjectScope = vi.fn(async () => {})
    const scoped = createPluginScopedMultitableApi(
      { provisioning: { ensureObjectDefaultView: inner }, records: {} } as never,
      'plugin-integration-core',
      { assertObjectScope },
    )

    await scoped.provisioning.ensureObjectDefaultView({
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
      name: 'All Records',
    })
    expect(assertObjectScope).toHaveBeenCalledWith({
      pluginName: 'plugin-integration-core',
      projectId: PROJECT_ID,
      objectId: OBJECT_ID,
    })
    expect(inner).toHaveBeenCalledTimes(1)

    // Foreign project namespace: refused before the hook and before the host call.
    inner.mockClear()
    assertObjectScope.mockClear()
    await expect(
      scoped.provisioning.ensureObjectDefaultView({
        projectId: 'tenant_1:other-plugin',
        objectId: OBJECT_ID,
        name: 'All Records',
      }),
    ).rejects.toThrow()
    expect(assertObjectScope).not.toHaveBeenCalled()
    expect(inner).not.toHaveBeenCalled()

    // A rejecting object-scope hook aborts before the host write.
    const denied = new Error('scope denied')
    assertObjectScope.mockImplementation(async () => {
      throw denied
    })
    await expect(
      scoped.provisioning.ensureObjectDefaultView({
        projectId: PROJECT_ID,
        objectId: OBJECT_ID,
        name: 'All Records',
      }),
    ).rejects.toBe(denied)
    expect(inner).not.toHaveBeenCalled()
  })
})
