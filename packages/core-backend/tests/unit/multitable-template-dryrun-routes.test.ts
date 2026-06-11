/**
 * S2 — template install dry-run (route-level) + shared conflict detection.
 * Design: docs/development/multitable-template-dryrun-detail-s2-design-20260611.md §2.1/§3.
 *
 * Matrix coverage:
 *   S2-T1 clean store → installable=true, wouldCreate counts match the descriptor.
 *   S2-T2 base/sheet/view occupancy → matching conflict entries + installable=false,
 *         AND the real install route 409s in the SAME scenario (shared-source parity);
 *         plus an exact-message parity assertion against installMultitableTemplate
 *         with pinned ids, and an id-derivation parity lock between
 *         buildTemplateWouldCreate and the ids install actually writes.
 *   S2-T3 ZERO-WRITE proof: the dry-run request issues SELECTs only — no INSERT/
 *         UPDATE/DELETE, no transaction.
 *   S2-T4 RBAC: read-only user → 403; unknown template → 404 (install-shaped body).
 *
 * Harness follows the mock-pool route precedent
 * (multitable-formula-reference-guard.test.ts): real express app + real
 * univerMetaRouter, poolManager.get() stubbed with an in-memory store.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

import {
  buildTemplateWouldCreate,
  detectTemplateConflicts,
  getMultitableTemplate,
  installMultitableTemplate,
  type MultitableTemplate,
} from '../../src/multitable/template-library'
import type { MultitableProvisioningQueryFn } from '../../src/multitable/provisioning'

type QueryResult = { rows: any[]; rowCount?: number }

type StoreOptions = {
  /** Pretend EVERY base id is taken (dry-run base ids are random, so occupancy
   * is simulated id-agnostically). */
  occupyAllBases?: boolean
  occupyAllSheets?: boolean
  occupyAllViews?: boolean
  /** Seed concrete ids (used with pinned idGenerator in library-level tests). */
  baseIds?: string[]
  sheetIds?: string[]
  viewIds?: string[]
}

/**
 * In-memory store covering the full install SQL surface (INSERT + readback)
 * plus the SELECT-only occupancy probes detectTemplateConflicts issues.
 */
function createStore(opts: StoreOptions = {}) {
  const bases: Array<Record<string, unknown>> = (opts.baseIds ?? []).map((id) => ({
    id, name: 'seeded', icon: null, color: null, owner_id: null, workspace_id: null,
  }))
  const sheets: Array<Record<string, unknown>> = (opts.sheetIds ?? []).map((id) => ({
    id, base_id: 'base_seed', name: 'seeded', description: null,
  }))
  const fields: Array<Record<string, unknown>> = []
  const views: Array<Record<string, unknown>> = (opts.viewIds ?? []).map((id) => ({
    id, sheet_id: 'sheet_seed', name: 'seeded', type: 'grid',
    filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {},
  }))

  const handler = (sql: string, params: unknown[] = []): QueryResult => {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_bases') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      if (opts.occupyAllBases) return { rows: [{ id }] }
      return { rows: bases.filter((base) => base.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_bases')) {
      const [id, name, icon, color, ownerId, workspaceId] = params as [string, string, string, string, string | null, string | null]
      if (opts.occupyAllBases || bases.some((base) => base.id === id)) {
        return { rows: [], rowCount: 0 }
      }
      const base = { id, name, icon, color, owner_id: ownerId, workspace_id: workspaceId }
      bases.push(base)
      return { rows: [base], rowCount: 1 }
    }

    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      if (opts.occupyAllSheets) return { rows: [{ id, base_id: 'base_other', name: 'occupied', description: null }] }
      return { rows: sheets.filter((sheet) => sheet.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_sheets')) {
      const [id, baseId, name, description] = params as [string, string, string, string | null]
      if (opts.occupyAllSheets || sheets.some((sheet) => sheet.id === id)) {
        return { rows: [], rowCount: 0 }
      }
      sheets.push({ id, base_id: baseId, name, description })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('INSERT INTO meta_fields')) {
      const [id, sheetId, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
      fields.push({ id, sheet_id: sheetId, name, type, property: JSON.parse(propertyJson), order })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('FROM meta_fields') && normalized.includes('id = ANY($2::text[])')) {
      const [sheetId, ids] = params as [string, string[]]
      const idSet = new Set(ids)
      return {
        rows: fields
          .filter((field) => field.sheet_id === sheetId && idSet.has(field.id as string))
          .sort((a, b) => (a.order as number) - (b.order as number)),
      }
    }

    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      if (opts.occupyAllViews) {
        return {
          rows: [{
            id, sheet_id: 'sheet_other', name: 'occupied', type: 'grid',
            filter_info: {}, sort_info: {}, group_info: {}, hidden_field_ids: [], config: {},
          }],
        }
      }
      return { rows: views.filter((view) => view.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_views')) {
      const [id, sheetId, name, type, filterInfoJson, sortInfoJson, groupInfoJson, hiddenFieldIdsJson, configJson] = params as [
        string, string, string, string, string, string, string, string, string,
      ]
      if (opts.occupyAllViews || views.some((view) => view.id === id)) {
        return { rows: [], rowCount: 0 }
      }
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

    throw new Error(`Unhandled SQL in test: ${normalized}`)
  }

  const query: MultitableProvisioningQueryFn = async (sql, params = []) => handler(sql, params)

  return { bases, sheets, fields, views, handler, query }
}

function createMockPool(handler: (sql: string, params?: unknown[]) => QueryResult) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params))
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

async function createApp(
  handler: (sql: string, params?: unknown[]) => QueryResult,
  opts: { perms?: string[] } = {},
) {
  const perms = opts.perms ?? ['multitable:read', 'multitable:write']
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(perms),
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
    // rbacGuard reads user.permissions; the install route's
    // resolveRequestAccess reads user.perms — set both.
    req.user = { id: 'user_s2', roles: [], permissions: perms, perms } as Express.Request['user']
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

describe('S2 — POST /templates/:templateId/dry-run (route)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('S2-T1: clean store → installable=true, wouldCreate matches the descriptor', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)

    const res = await request(app)
      .post('/api/multitable/templates/project-tracker/dry-run')
      .send({ baseName: 'Launch Plan' })

    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const data = res.body.data
    expect(data.templateId).toBe('project-tracker')
    expect(data.installable).toBe(true)
    expect(data.conflicts).toEqual([])

    const descriptor = getMultitableTemplate('project-tracker')!
    expect(data.wouldCreate.base.name).toBe('Launch Plan')
    expect(data.wouldCreate.base.id).toMatch(/^base_/)
    expect(data.wouldCreate.sheets).toHaveLength(descriptor.sheets.length)
    expect(data.wouldCreate.sheets[0]).toMatchObject({
      name: 'Tasks',
      fieldCount: descriptor.sheets[0].fields.length,
      viewCount: descriptor.sheets[0].views.length,
    })
    expect(data.wouldCreate.sheets[0].id).toMatch(/^sheet_/)
    expect(data.wouldCreate.fields).toHaveLength(6)
    expect(data.wouldCreate.fields.map((f: any) => f.name)).toEqual([
      'Task', 'Status', 'Owner', 'Priority', 'Due Date', 'Notes',
    ])
    for (const field of data.wouldCreate.fields) {
      expect(field.id).toMatch(/^fld_/)
      expect(field.sheetId).toBe(data.wouldCreate.sheets[0].id)
      expect(typeof field.type).toBe('string')
    }
    expect(data.wouldCreate.views).toHaveLength(3)
    expect(data.wouldCreate.views.map((v: any) => v.type)).toEqual(['grid', 'kanban', 'calendar'])
    for (const view of data.wouldCreate.views) {
      expect(view.id).toMatch(/^view_/)
      expect(view.sheetId).toBe(data.wouldCreate.sheets[0].id)
    }
  })

  it('S2-T1: baseName defaults to the template name (install parity)', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)

    const res = await request(app)
      .post('/api/multitable/templates/sales-crm/dry-run')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body.data.wouldCreate.base.name).toBe('Sales CRM')
  })

  it('S2-T2: base occupancy → base_exists conflict AND install 409s in the same scenario', async () => {
    const store = createStore({ occupyAllBases: true })
    const { app } = await createApp(store.handler)

    const dryRun = await request(app)
      .post('/api/multitable/templates/project-tracker/dry-run')
      .send({ baseName: 'Launch Plan' })

    expect(dryRun.status).toBe(200)
    expect(dryRun.body.data.installable).toBe(false)
    const conflict = dryRun.body.data.conflicts[0]
    expect(conflict).toMatchObject({ severity: 'error', kind: 'base_exists', name: 'Launch Plan' })
    expect(conflict.message).toMatch(/^Base already exists: base_/)
    expect(conflict.message).toContain(conflict.id)

    const install = await request(app)
      .post('/api/multitable/templates/project-tracker/install')
      .send({ baseName: 'Launch Plan' })

    expect(install.status).toBe(409)
    expect(install.body.error.code).toBe('CONFLICT')
    expect(install.body.error.message).toMatch(/^Base already exists: base_/)
  })

  it('S2-T2: sheet occupancy → sheet_exists conflict AND install 409s in the same scenario', async () => {
    const store = createStore({ occupyAllSheets: true })
    const { app } = await createApp(store.handler)

    const dryRun = await request(app)
      .post('/api/multitable/templates/project-tracker/dry-run')
      .send({})

    expect(dryRun.status).toBe(200)
    expect(dryRun.body.data.installable).toBe(false)
    const conflict = dryRun.body.data.conflicts[0]
    expect(conflict).toMatchObject({ severity: 'error', kind: 'sheet_exists', name: 'Tasks' })
    expect(conflict.message).toMatch(/^Sheet already exists: sheet_/)

    const install = await request(app)
      .post('/api/multitable/templates/project-tracker/install')
      .send({})

    expect(install.status).toBe(409)
    expect(install.body.error.code).toBe('CONFLICT')
    expect(install.body.error.message).toMatch(/^Sheet already exists: sheet_/)
  })

  it('S2-T2: view occupancy → view_exists conflicts (one per view) AND install 409s in the same scenario', async () => {
    const store = createStore({ occupyAllViews: true })
    const { app } = await createApp(store.handler)

    const dryRun = await request(app)
      .post('/api/multitable/templates/project-tracker/dry-run')
      .send({})

    expect(dryRun.status).toBe(200)
    expect(dryRun.body.data.installable).toBe(false)
    expect(dryRun.body.data.conflicts).toHaveLength(3)
    expect(dryRun.body.data.conflicts.map((c: any) => c.kind)).toEqual([
      'view_exists', 'view_exists', 'view_exists',
    ])
    expect(dryRun.body.data.conflicts[0].message).toMatch(/^View already exists: view_/)

    const install = await request(app)
      .post('/api/multitable/templates/project-tracker/install')
      .send({})

    expect(install.status).toBe(409)
    expect(install.body.error.code).toBe('CONFLICT')
    expect(install.body.error.message).toMatch(/^View already exists: view_/)
  })

  it('S2-T3: ZERO-WRITE proof — dry-run issues SELECTs only, no transaction', async () => {
    const store = createStore({ occupyAllSheets: true })
    const { app, mockPool } = await createApp(store.handler)

    const res = await request(app)
      .post('/api/multitable/templates/contract-management/dry-run')
      .send({ baseName: 'Q3 Contracts' })

    expect(res.status).toBe(200)
    expect(mockPool.transaction).not.toHaveBeenCalled()
    const sqls = mockPool.query.mock.calls.map(([sql]) => String(sql).trim().toUpperCase())
    expect(sqls.length).toBeGreaterThan(0)
    for (const sql of sqls) {
      expect(sql.startsWith('SELECT')).toBe(true)
      expect(sql).not.toContain('INSERT')
      expect(sql).not.toContain('UPDATE')
      expect(sql).not.toContain('DELETE')
    }
  })

  // Review 2026-06-11 F5: dry-run emits structured observability events
  // symmetric to install's `[multitable.template.install]` (distinct token —
  // the H-series SOP grep stays single-counted). Structured fields only.
  it('F5: emits [multitable.template.dry-run] events on success and failure paths', async () => {
    const store = createStore({ occupyAllSheets: true })
    const { app } = await createApp(store.handler)
    const { Logger } = await import('../../src/core/logger')
    const infoSpy = vi.spyOn(Logger.prototype, 'info')

    await request(app)
      .post('/api/multitable/templates/project-tracker/dry-run')
      .send({ baseName: 'Launch Plan' })
      .expect(200)

    const successCall = infoSpy.mock.calls.find(
      ([msg, meta]) => msg === '[multitable.template.dry-run]' && (meta as Record<string, unknown>)?.ok === true,
    )
    expect(successCall).toBeDefined()
    const successMeta = successCall![1] as Record<string, unknown>
    expect(successMeta).toMatchObject({
      templateId: 'project-tracker',
      ok: true,
      userId: 'user_s2',
      installable: false,
      conflictCount: 1,
    })
    // Never the baseName / request body (install-event privacy contract).
    expect(successMeta).not.toHaveProperty('baseName')
    expect(JSON.stringify(successMeta)).not.toContain('Launch Plan')

    await request(app)
      .post('/api/multitable/templates/no-such-template/dry-run')
      .send({})
      .expect(404)

    const failCall = infoSpy.mock.calls.find(
      ([msg, meta]) => msg === '[multitable.template.dry-run]' && (meta as Record<string, unknown>)?.ok === false,
    )
    expect(failCall).toBeDefined()
    expect(failCall![1]).toMatchObject({
      templateId: 'no-such-template',
      ok: false,
      userId: 'user_s2',
      statusCode: 404,
      errorCode: 'NOT_FOUND',
    })
  })

  it('S2-T4: read-only user gets 403', async () => {
    const store = createStore()
    const { app, mockPool } = await createApp(store.handler, { perms: ['multitable:read'] })

    const res = await request(app)
      .post('/api/multitable/templates/project-tracker/dry-run')
      .send({})

    expect(res.status).toBe(403)
    expect(mockPool.query).not.toHaveBeenCalled()
  })

  it('S2-T4: unknown template → 404 with the install-shaped error body, no DB queries', async () => {
    const store = createStore()
    const { app, mockPool } = await createApp(store.handler)

    const res = await request(app)
      .post('/api/multitable/templates/no-such-template/dry-run')
      .send({})

    expect(res.status).toBe(404)
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Template not found: no-such-template' },
    })
    expect(mockPool.query).not.toHaveBeenCalled()
  })

  it('rejects an invalid body (empty baseName) like install does', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)

    const res = await request(app)
      .post('/api/multitable/templates/project-tracker/dry-run')
      .send({ baseName: '' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('S2 — shared conflict detection (library-level, pinned ids)', () => {
  it('id-derivation parity: buildTemplateWouldCreate ids === ids a real install writes', async () => {
    const store = createStore()
    await installMultitableTemplate({
      query: store.query,
      templateId: 'project-tracker',
      baseName: 'Launch Plan',
      idGenerator: (prefix) => `${prefix}_fixed`,
    })

    const template = getMultitableTemplate('project-tracker')!
    const plan = buildTemplateWouldCreate(template, { baseId: 'base_fixed', baseName: 'Launch Plan' })

    expect(plan.base.id).toBe('base_fixed')
    expect(store.sheets.map((sheet) => sheet.id)).toEqual(plan.sheets.map((sheet) => sheet.id))
    expect(store.fields.map((field) => field.id).sort()).toEqual(plan.fields.map((field) => field.id).sort())
    expect(store.views.map((view) => view.id)).toEqual(plan.views.map((view) => view.id))
  })

  it('exact-message parity: install throws conflicts[0].message verbatim (base conflict)', async () => {
    const store = createStore({ baseIds: ['base_fixed'] })
    const template = getMultitableTemplate('project-tracker')!

    const conflicts = await detectTemplateConflicts(store.query, template, {
      baseId: 'base_fixed',
      baseName: 'Launch Plan',
    })
    expect(conflicts[0]).toMatchObject({ severity: 'error', kind: 'base_exists', id: 'base_fixed' })

    await expect(installMultitableTemplate({
      query: store.query,
      templateId: 'project-tracker',
      baseName: 'Launch Plan',
      idGenerator: (prefix) => `${prefix}_fixed`,
    })).rejects.toThrow(conflicts[0].message)
  })

  it('exact-message parity: sheet conflict (occupied sheet id learned from a real install)', async () => {
    // Learn the real derived sheet id by running a clean install with pinned ids.
    const clean = createStore()
    await installMultitableTemplate({
      query: clean.query,
      templateId: 'project-tracker',
      idGenerator: (prefix) => `${prefix}_fixed`,
    })
    const occupiedSheetId = clean.sheets[0].id as string

    const store = createStore({ sheetIds: [occupiedSheetId] })
    const template = getMultitableTemplate('project-tracker')!
    const conflicts = await detectTemplateConflicts(store.query, template, {
      baseId: 'base_fixed',
      baseName: 'Project Tracker',
    })
    expect(conflicts[0]).toMatchObject({ severity: 'error', kind: 'sheet_exists', id: occupiedSheetId, name: 'Tasks' })

    await expect(installMultitableTemplate({
      query: store.query,
      templateId: 'project-tracker',
      idGenerator: (prefix) => `${prefix}_fixed`,
    })).rejects.toThrow(conflicts[0].message)
    // Pre-check fires before any write: the occupied store stays write-free.
    expect(store.bases).toHaveLength(0)
  })

  // Review 2026-06-11 F1 — the reviewer's probe, kept as a real test: a
  // (mis-authored) template whose two sheets share the SAME template-sheet id
  // derives IDENTICAL sheet ids (stableChildId is deterministic on identical
  // inputs), so install's second `INSERT INTO meta_sheets ... ON CONFLICT (id)
  // DO NOTHING` would hit rowCount=0 → 409 — while DB-occupancy probes alone
  // see an EMPTY store and would report clean. The plan-level duplicate-id
  // check must surface this before any probe.
  it('F1: intra-template duplicate sheet ids → template_duplicate_id conflict on a CLEAN store', async () => {
    const template: MultitableTemplate = {
      id: 'synthetic-duplicate',
      name: 'Synthetic Duplicate',
      description: 'two sheets colliding on the same template-sheet id',
      category: 'test',
      icon: 'kanban',
      color: '#000000',
      sheets: [
        {
          id: 'dup',
          name: 'Sheet One',
          fields: [{ id: 'a', name: 'A', type: 'text', order: 0 }],
          views: [{ id: 'v1', name: 'Grid', type: 'grid' }],
        },
        {
          id: 'dup',
          name: 'Sheet Two',
          fields: [{ id: 'b', name: 'B', type: 'text', order: 0 }],
          views: [{ id: 'v2', name: 'Grid 2', type: 'grid' }],
        },
      ],
    }

    // The self-collision install's ON CONFLICT would hit:
    const plan = buildTemplateWouldCreate(template, { baseId: 'base_fixed', baseName: 'Synthetic' })
    expect(plan.sheets).toHaveLength(2)
    expect(plan.sheets[0].id).toBe(plan.sheets[1].id)

    const store = createStore() // EMPTY — occupancy probes find nothing
    const conflicts = await detectTemplateConflicts(store.query, template, {
      baseId: 'base_fixed',
      baseName: 'Synthetic',
    })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      severity: 'error',
      kind: 'template_duplicate_id',
      id: plan.sheets[1].id,
      name: 'Sheet Two',
    })
    expect(conflicts[0].message).toBe(`Template derives duplicate sheet id: ${plan.sheets[1].id}`)
  })

  it('F1: duplicate field/view ids within a sheet are reported per entity, BEFORE occupancy conflicts', async () => {
    const template: MultitableTemplate = {
      id: 'synthetic-duplicate-children',
      name: 'Synthetic Duplicate Children',
      description: 'one sheet with colliding field ids and colliding view ids',
      category: 'test',
      icon: 'kanban',
      color: '#000000',
      sheets: [
        {
          id: 'main',
          name: 'Main',
          fields: [
            { id: 'f', name: 'First', type: 'text', order: 0 },
            { id: 'f', name: 'Second', type: 'text', order: 1 },
          ],
          views: [
            { id: 'v', name: 'Grid', type: 'grid' },
            { id: 'v', name: 'Grid Copy', type: 'grid' },
          ],
        },
      ],
    }

    const store = createStore({ occupyAllBases: true })
    const conflicts = await detectTemplateConflicts(store.query, template, {
      baseId: 'base_fixed',
      baseName: 'Synthetic',
    })

    // Plan-level duplicates come FIRST (emitted before any DB probe) in
    // sheet → field → view order; the occupied base follows them.
    expect(conflicts.map((conflict) => conflict.kind)).toEqual([
      'template_duplicate_id', 'template_duplicate_id', 'base_exists',
    ])
    expect(conflicts[0].message).toMatch(/^Template derives duplicate field id: fld_/)
    expect(conflicts[1].message).toMatch(/^Template derives duplicate view id: view_/)
  })
})
