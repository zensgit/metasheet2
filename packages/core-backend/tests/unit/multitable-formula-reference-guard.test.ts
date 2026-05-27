/**
 * A2-defense — formula→formula reference guard (route-level).
 *
 * The product does NOT support a formula field referencing another formula
 * field: the frontend hard-blocks it (the token picker excludes `type ===
 * 'formula'` and the expression validator flags a hand-typed formula ref as an
 * error that disables save), and `recalculateRecord` has no intra-record
 * topological order — so a formula→formula chain would silently compute against
 * stale intermediate values. Two paths can still introduce such an edge past the
 * frontend, and these tests lock both at the real route binding (not a hand-built
 * helper call — see the wire-vs-fixture rule):
 *
 *   1. Forward: creating / updating a formula whose expression references a
 *      formula field (or itself). Rejected with 400.
 *   2. Reverse (conversion): converting a non-formula field INTO a formula while a
 *      live formula already references it. Rejected with 400.
 *
 * Discriminating cases prove we did NOT over-reject:
 *   - formula→lookup / formula→rollup are ALLOWED (the frontend offers them; only
 *     `type === 'formula'` is filtered).
 *   - formula→nonexistent stays ALLOWED (current tolerance; a separate decision).
 *   - the conversion guard must IGNORE stale `formula_dependencies` edges left by a
 *     formula→non-formula conversion (cleanup does not run on that path), because
 *     those edges no longer point at a live formula consumer.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const SHEET_ID = 'sheet_fg'

type StoredField = {
  id: string
  sheet_id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}
type Edge = { fieldId: string; dependsOn: string }
type QueryResult = { rows: any[]; rowCount?: number }

/**
 * In-memory store mirroring the subset of DB interactions the field POST/PATCH
 * paths perform, plus a real `formula_dependencies` edge set so the conversion
 * guard (and the stale-edge case) can be exercised end-to-end. Edge cleanup
 * deliberately matches production: edges for a field are removed ONLY when that
 * field is (re)written as a formula — never on a conversion away from formula.
 */
function createStore(initial: StoredField[]) {
  const fields = new Map<string, StoredField>()
  for (const f of initial) fields.set(f.id, { ...f, property: { ...f.property } })
  const edges: Edge[] = []

  const handler = (sql: string, params?: unknown[]): QueryResult => {
    if (sql.includes('FROM meta_sheets WHERE id = $1')) {
      return { rows: [{ id: SHEET_ID }] }
    }
    if (sql.includes('MAX("order")')) {
      const max = Math.max(-1, ...[...fields.values()].map((f) => f.order))
      return { rows: [{ max_order: max }] }
    }
    // A2-defense forward guard.
    if (sql.includes('SELECT id, type FROM meta_fields WHERE sheet_id = $1 AND id = ANY')) {
      const ids = (params?.[1] as string[]) ?? []
      const rows = ids
        .map((id) => fields.get(id))
        .filter((f): f is StoredField => Boolean(f))
        .map((f) => ({ id: f.id, type: f.type }))
      return { rows }
    }
    // A2-defense reverse guard (conversion): formula_dependencies JOIN meta_fields.
    if (sql.includes('FROM formula_dependencies fd') && sql.includes('JOIN meta_fields mf')) {
      const target = params?.[1] as string
      const seen = new Set<string>()
      const rows: Array<{ field_id: string; type: string }> = []
      for (const e of edges) {
        if (e.dependsOn !== target || seen.has(e.fieldId)) continue
        const f = fields.get(e.fieldId)
        if (!f) continue // JOIN drops edges whose referencing field was deleted
        seen.add(e.fieldId)
        rows.push({ field_id: f.id, type: f.type })
      }
      return { rows }
    }
    if (sql.includes('DELETE FROM formula_dependencies')) {
      const fieldId = params?.[1] as string
      for (let i = edges.length - 1; i >= 0; i--) {
        if (edges[i].fieldId === fieldId) edges.splice(i, 1)
      }
      return { rows: [] }
    }
    if (sql.includes('INSERT INTO formula_dependencies')) {
      edges.push({ fieldId: params?.[1] as string, dependsOn: params?.[2] as string })
      return { rows: [] }
    }
    if (sql.includes('SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const f = fields.get(params?.[0] as string)
      return { rows: f ? [{ ...f }] : [] }
    }
    if (sql.includes('SELECT id, sheet_id FROM meta_fields WHERE id = $1')) {
      const f = fields.get(params?.[0] as string)
      return { rows: f ? [{ id: f.id, sheet_id: f.sheet_id }] : [] }
    }
    if (sql.includes('INSERT INTO meta_fields')) {
      const [id, sheet_id, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
      const f: StoredField = { id, sheet_id, name, type, property: JSON.parse(propertyJson), order }
      fields.set(id, f)
      return { rows: [{ id, name, type, property: f.property, order }] }
    }
    if (sql.startsWith('UPDATE meta_fields') && sql.includes('SET name = $2')) {
      const [id, name, type, propertyJson, order] = params as [string, string, string, string, number]
      const f = fields.get(id)
      if (!f) return { rows: [] }
      f.name = name
      f.type = type
      f.property = JSON.parse(propertyJson)
      f.order = order
      return { rows: [{ id: f.id, name: f.name, type: f.type, property: f.property, order: f.order }] }
    }
    if (sql.startsWith('UPDATE meta_fields')) return { rows: [] } // order-shuffle no-op
    if (sql.includes('SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1')) {
      const f = fields.get(params?.[0] as string)
      return { rows: f ? [{ id: f.id, name: f.name, type: f.type, property: f.property, order: f.order }] : [] }
    }
    return { rows: [], rowCount: 0 }
  }

  return { fields, edges, handler }
}

function createMockPool(handler: (sql: string, params?: unknown[]) => QueryResult) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (
      sql.includes('FROM spreadsheet_permissions')
      || sql.includes('FROM field_permissions')
      || sql.includes('FROM view_permissions')
      || sql.includes('FROM meta_view_permissions')
      || sql.includes('FROM record_permissions')
    ) {
      return { rows: [], rowCount: 0 }
    }
    return handler(sql, params)
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(handler: (sql: string, params?: unknown[]) => QueryResult) {
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
    req.user = { id: 'user_fg', roles: [], perms: ['multitable:read', 'multitable:write'] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

function field(over: Partial<StoredField> & { id: string; type: string }): StoredField {
  return { sheet_id: SHEET_ID, name: over.id, property: {}, order: 0, ...over }
}

describe('A2-defense — formula reference guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('rejects creating a formula that references another formula field', async () => {
    const { fields, handler } = createStore([
      field({ id: 'fld_a', type: 'formula', property: { expression: '=1+1' } }),
    ])
    const app = await createApp(handler)

    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SHEET_ID,
      id: 'fld_b',
      name: 'B',
      type: 'formula',
      property: { expression: '=SUM({fld_a}, 1)' },
    })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toContain('fld_a')
    expect(fields.has('fld_b')).toBe(false) // transaction rolled back
  })

  it('rejects a formula that references itself', async () => {
    const { handler } = createStore([])
    const app = await createApp(handler)

    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SHEET_ID,
      id: 'fld_self',
      name: 'Self',
      type: 'formula',
      property: { expression: '={fld_self}' },
    })

    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('引用自身')
    expect(res.body.error.message).toContain('fld_self')
  })

  it('ALLOWS a formula that references a lookup field (not over-rejecting computed inputs)', async () => {
    const { fields, handler } = createStore([
      field({ id: 'fld_look', type: 'lookup', property: {} }),
    ])
    const app = await createApp(handler)

    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SHEET_ID,
      id: 'fld_f',
      name: 'F',
      type: 'formula',
      property: { expression: '={fld_look} * 2' },
    })

    expect(res.status).toBe(201)
    expect(fields.has('fld_f')).toBe(true)
  })

  it('ALLOWS a formula that references a nonexistent field (preserves current tolerance)', async () => {
    const { fields, handler } = createStore([])
    const app = await createApp(handler)

    const res = await request(app).post('/api/multitable/fields').send({
      sheetId: SHEET_ID,
      id: 'fld_g',
      name: 'G',
      type: 'formula',
      property: { expression: '={fld_ghost} + 1' },
    })

    expect(res.status).toBe(201)
    expect(fields.has('fld_g')).toBe(true)
  })

  it('rejects updating a formula expression to reference another formula field', async () => {
    const { handler } = createStore([
      field({ id: 'fld_a', type: 'formula', property: { expression: '=2' } }),
      field({ id: 'fld_b', type: 'formula', property: { expression: '=1' } }),
    ])
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_b')
      .send({ property: { expression: '={fld_a} + 1' } })

    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('fld_a')
  })

  it('does NOT re-validate a pre-existing chained formula on a rename-only PATCH (lazy/on-edit)', async () => {
    // Legacy state: B is already stored as a formula referencing formula A (created
    // pre-defense via API/conversion). A rename that does not touch the expression
    // must pass — validation is lazy/on-edit, not on every write. `nextProperty`
    // falls back to the stored expression, so this guards against an over-eager 400.
    const { fields, handler } = createStore([
      field({ id: 'fld_a', type: 'formula', property: { expression: '=2' } }),
      field({ id: 'fld_b', type: 'formula', property: { expression: '={fld_a} + 1' } }),
    ])
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_b')
      .send({ name: 'Renamed B' })

    expect(res.status).toBe(200)
    expect(fields.get('fld_b')?.name).toBe('Renamed B')
    expect((fields.get('fld_b')?.property as any).expression).toBe('={fld_a} + 1') // unchanged
  })

  it('rejects converting a field INTO a formula when a live formula already references it', async () => {
    const { handler } = createStore([
      field({ id: 'fld_x', type: 'string', property: {} }),
    ])
    const app = await createApp(handler)

    // B (formula) references X (string) — allowed, records the B→X edge.
    await request(app).post('/api/multitable/fields').send({
      sheetId: SHEET_ID,
      id: 'fld_b',
      name: 'B',
      type: 'formula',
      property: { expression: '={fld_x} + 1' },
    }).expect(201)

    // Now converting X to a formula would make B→X a formula→formula edge.
    const res = await request(app)
      .patch('/api/multitable/fields/fld_x')
      .send({ type: 'formula', property: { expression: '=5' } })

    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('fld_b')
    expect(res.body.error.message).toContain('转换为公式')
  })

  it('ALLOWS converting a field into a formula when nothing references it', async () => {
    const { fields, handler } = createStore([
      field({ id: 'fld_x', type: 'string', property: {} }),
    ])
    const app = await createApp(handler)

    const res = await request(app)
      .patch('/api/multitable/fields/fld_x')
      .send({ type: 'formula', property: { expression: '=5' } })

    expect(res.status).toBe(200)
    expect(fields.get('fld_x')?.type).toBe('formula')
  })

  it('ALLOWS conversion despite a stale formula_dependencies edge from a since-converted referrer', async () => {
    const { fields, edges, handler } = createStore([
      field({ id: 'fld_x', type: 'string', property: {} }),
    ])
    const app = await createApp(handler)

    // B (formula) references X — records B→X edge.
    await request(app).post('/api/multitable/fields').send({
      sheetId: SHEET_ID,
      id: 'fld_b',
      name: 'B',
      type: 'formula',
      property: { expression: '={fld_x} + 1' },
    }).expect(201)

    // Convert B away from formula → its B→X edge is NOT cleaned up (matches prod).
    await request(app)
      .patch('/api/multitable/fields/fld_b')
      .send({ type: 'string' })
      .expect(200)
    expect(edges.some((e) => e.fieldId === 'fld_b' && e.dependsOn === 'fld_x')).toBe(true) // stale edge lingers

    // Converting X to a formula must SUCCEED: the lingering edge points at B,
    // which is no longer a formula, so it must not block.
    const res = await request(app)
      .patch('/api/multitable/fields/fld_x')
      .send({ type: 'formula', property: { expression: '=9' } })

    expect(res.status).toBe(200)
    expect(fields.get('fld_x')?.type).toBe('formula')
  })
})
