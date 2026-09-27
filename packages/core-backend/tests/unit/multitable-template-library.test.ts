import { describe, expect, it } from 'vitest'

import {
  MultitableTemplateConflictError,
  MultitableTemplateNotFoundError,
  installMultitableTemplate,
  listMultitableTemplates,
  type MultitableTemplate,
  type MultitableTemplateBase,
} from '../../src/multitable/template-library'
import type { MultitableProvisioningQueryFn } from '../../src/multitable/provisioning'

type FakeSheet = {
  id: string
  base_id: string
  name: string
  description: string | null
}

type FakeField = {
  id: string
  sheet_id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

type FakeView = {
  id: string
  sheet_id: string
  name: string
  type: string
  filter_info: Record<string, unknown>
  sort_info: Record<string, unknown>
  group_info: Record<string, unknown>
  hidden_field_ids: string[]
  config: Record<string, unknown>
  // S1 (adversarial review of #6091): epoch ms. Mirrors the DB column's semantics closely enough
  // to reproduce the bug this table exists to catch — every INSERT inside one `installMultitableTemplate`
  // call shares the SAME `sharedNow` unless createView's caller passes an explicit createdAt
  // (COALESCE($10, now()) in provisioning.ts), exactly like every view in one Postgres transaction
  // would see the identical transaction-start `now()`.
  created_at: number
}

function createQuery(seed?: { bases?: MultitableTemplateBase[] }): {
  query: MultitableProvisioningQueryFn
  bases: MultitableTemplateBase[]
  sheets: FakeSheet[]
  fields: FakeField[]
  views: FakeView[]
} {
  const bases = [...(seed?.bases ?? [])]
  const sheets: FakeSheet[] = []
  const fields: FakeField[] = []
  const views: FakeView[] = []
  // S1: captured ONCE per createQuery() call — stands in for "this whole install runs inside one
  // Postgres transaction, so every un-stamped INSERT sees the identical transaction-start now()".
  const sharedNow = Date.now()

  const query: MultitableProvisioningQueryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    // S2 conflict pre-check probe (detectTemplateConflicts) — SELECT-only
    // base-id occupancy; sheet/view probes reuse the SELECT handlers below.
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_bases') && normalized.includes('WHERE id = $1')) {
      const [baseId] = params as [string]
      return { rows: bases.filter((base) => base.id === baseId).map((base) => ({ id: base.id })) }
    }

    if (normalized.startsWith('INSERT INTO meta_bases')) {
      const [id, name, icon, color, ownerId, workspaceId] = params as [string, string, string, string, string | null, string | null]
      if (bases.some((base) => base.id === id)) {
        return { rows: [], rowCount: 0 }
      }
      const base = {
        id,
        name,
        icon,
        color,
        ownerId,
        workspaceId,
      }
      bases.push(base)
      return {
        rows: [{
          id: base.id,
          name: base.name,
          icon: base.icon,
          color: base.color,
          owner_id: base.ownerId,
          workspace_id: base.workspaceId,
        }],
        rowCount: 1,
      }
    }

    if (normalized.startsWith('INSERT INTO meta_sheets')) {
      const [id, baseId, name, description] = params as [string, string, string, string | null]
      if (sheets.some((sheet) => sheet.id === id)) {
        return { rows: [], rowCount: 0 }
      }
      sheets.push({ id, base_id: baseId, name, description })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      const [sheetId] = params as [string]
      return { rows: sheets.filter((sheet) => sheet.id === sheetId) }
    }

    if (normalized.startsWith('INSERT INTO meta_fields')) {
      const [id, sheetId, name, type, propertyJson, order] = params as [
        string,
        string,
        string,
        string,
        string,
        number,
      ]
      const next = {
        id,
        sheet_id: sheetId,
        name,
        type,
        property: JSON.parse(propertyJson),
        order,
      }
      const existing = fields.find((field) => field.id === id)
      if (existing) Object.assign(existing, next)
      else fields.push(next)
      return { rows: [], rowCount: 1 }
    }

    // P0-S S3 destructive-reconcile pre-read. The guard is fail-closed by DEFAULT now, so
    // every ensureFields/ensureObject call issues this SELECT before each upsert; without
    // this branch the fake would fall through to the `Unhandled SQL` throw below.
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
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      }
    }

    if (normalized.startsWith('INSERT INTO meta_views')) {
      const [id, sheetId, name, type, filterInfoJson, sortInfoJson, groupInfoJson, hiddenFieldIdsJson, configJson, createdAtParam] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        (string | null)?,
      ]
      if (views.some((view) => view.id === id)) {
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
        // S1: COALESCE($10::timestamptz, now()) — a real `now()` param mirrors provisioning.ts;
        // omitted (undefined/null, every pre-S1 caller) falls back to the one shared instant.
        created_at: createdAtParam ? Date.parse(createdAtParam) : sharedNow,
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
      const [viewId] = params as [string]
      return { rows: views.filter((view) => view.id === viewId) }
    }

    // S1: the read-back path the save-as-template extraction and the /context route both use —
    // ORDER BY created_at, id, wire-gated the same way the rest of this suite gates on literal SQL
    // text (a mis-authored fixture that always sorts would make this test pass for the wrong reason).
    if (normalized.includes('FROM meta_views') && normalized.includes('sheet_id = ANY($1::text[])')) {
      const [sheetIds] = params as [string[]]
      const idSet = new Set(sheetIds)
      let rows = views.filter((view) => idSet.has(view.sheet_id))
      // N5 (adversarial review of #6091): honor DESC if the SQL actually says so, instead of
      // always sorting ascending — otherwise a mutation to `ORDER BY created_at, id DESC` (still
      // contains the substring being gated on) would silently keep passing.
      if (normalized.includes('ORDER BY created_at, id')) {
        const desc = normalized.includes('ORDER BY created_at, id DESC')
        rows = [...rows].sort((a, b) => {
          const cmp = (a.created_at - b.created_at) || a.id.localeCompare(b.id)
          return desc ? -cmp : cmp
        })
      }
      return { rows }
    }

    throw new Error(`Unhandled SQL in test: ${normalized}`)
  }

  return { query, bases, sheets, fields, views }
}

describe('multitable template library', () => {
  it('lists built-in templates defensively', () => {
    const first = listMultitableTemplates()
    const second = listMultitableTemplates()

    expect(first.map((template) => template.id)).toEqual([
      'project-tracker',
      'sales-crm',
      'issue-tracker',
      'contract-management',
      'field-inspection',
      'recruitment',
      'meeting-minutes',
      'asset-inventory',
    ])
    first[0].sheets[0].fields[0].name = 'mutated'
    expect(second[0].sheets[0].fields[0].name).toBe('Task')
  })

  it('installs a template as one base with mapped fields and views', async () => {
    const { query, bases, sheets, fields, views } = createQuery()

    const result = await installMultitableTemplate({
      query,
      templateId: 'project-tracker',
      baseName: 'Launch Plan',
      ownerId: 'user_1',
      idGenerator: (prefix) => `${prefix}_fixed`,
    })

    expect(result.base).toMatchObject({
      id: 'base_fixed',
      name: 'Launch Plan',
      ownerId: 'user_1',
    })
    expect(bases).toHaveLength(1)
    expect(sheets).toHaveLength(1)
    expect(fields.map((field) => field.name)).toEqual([
      'Task',
      'Status',
      'Owner',
      'Priority',
      'Due Date',
      'Notes',
    ])
    const statusField = fields.find((field) => field.name === 'Status')
    expect(statusField?.property.options).toEqual([
      { value: 'Not started' },
      { value: 'In progress' },
      { value: 'Blocked' },
      { value: 'Done' },
    ])
    const kanban = views.find((view) => view.type === 'kanban')
    expect(kanban?.group_info).toEqual({ fieldId: statusField?.id })
    const dueDateField = fields.find((field) => field.name === 'Due Date')
    const calendar = views.find((view) => view.type === 'calendar')
    expect(calendar?.config).toEqual(expect.objectContaining({ dateFieldId: dueDateField?.id }))
    expect(result.sheets[0].baseId).toBe('base_fixed')
    expect(result.views).toHaveLength(3)
  })

  // S1 (adversarial review of #6091, 2026-09-26): the returned `result.views` array is ALWAYS in
  // template order (it's built by push()-ing inside the template's own loop) — that was never the
  // bug. The bug only shows up on a SECOND look at the DB, through the exact `ORDER BY created_at,
  // id` query the save-as-template extraction and the /context route both use: pre-fix, every view
  // installMultitableTemplate creates in one call shares createView's DB-default `now()` (one
  // Postgres transaction => one instant), so that query's real sort key degenerates to `id` — a
  // sha1 hash with no relation to template order.
  it('S1: installed views survive a save-again — read back through ORDER BY created_at, id, they come out in template order', async () => {
    const { query, views } = createQuery()
    // Deliberately NOT alphabetical: precomputed sha1 ids (stableChildId) for this exact
    // baseId/templateId/sheetId/viewId tuple sort ascending as v2, v1, v3 — the opposite of
    // template order. If the id-only tie-break ever wins again (fix removed), this test must fail,
    // not pass by accident of hash luck.
    const orderTemplate: MultitableTemplate = {
      id: 'order-check',
      name: 'Order Check',
      description: '',
      category: 'Custom',
      icon: 'table',
      color: '#000000',
      sheets: [{
        id: 's1',
        name: 'Sheet1',
        description: null,
        fields: [{ id: 'f1', name: 'Title', type: 'string', order: 0 }],
        views: [
          { id: 'v1', name: 'View One', type: 'grid' },
          { id: 'v2', name: 'View Two', type: 'grid' },
          { id: 'v3', name: 'View Three', type: 'grid' },
        ],
      }],
    }

    const result = await installMultitableTemplate({
      query,
      templateId: orderTemplate.id,
      template: orderTemplate,
      baseId: 'base_fixed',
      baseName: 'Order Check Base',
      ownerId: 'user_1',
    })
    const sheetId = result.sheets[0].id

    // Sanity check on the precomputed claim above — if this ever fails, the ids changed shape
    // (e.g. stableChildId's algorithm changed) and the "deliberately not alphabetical" premise
    // needs re-deriving, not just re-asserting.
    const idAscendingNames = [...views]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((v) => v.name)
    expect(idAscendingNames).not.toEqual(['View One', 'View Two', 'View Three'])

    // The actual regression check: read the installed views back through the SAME shaped query
    // univer-meta.ts uses (ORDER BY created_at, id) — this must equal template order.
    const readBack = await query(
      'SELECT id, sheet_id, name, type, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = ANY($1::text[]) ORDER BY created_at, id',
      [[sheetId]],
    )
    expect((readBack.rows as Array<{ name: string }>).map((row) => row.name)).toEqual([
      'View One', 'View Two', 'View Three',
    ])
  })

  it('rejects unknown templates', async () => {
    const { query } = createQuery()

    await expect(installMultitableTemplate({
      query,
      templateId: 'missing',
    })).rejects.toBeInstanceOf(MultitableTemplateNotFoundError)
  })

  it('rejects base id conflicts before creating sheets', async () => {
    const { query, sheets } = createQuery({
      bases: [{ id: 'base_fixed', name: 'Existing', icon: null, color: null, ownerId: null, workspaceId: null }],
    })

    await expect(installMultitableTemplate({
      query,
      templateId: 'sales-crm',
      idGenerator: (prefix) => `${prefix}_fixed`,
    })).rejects.toBeInstanceOf(MultitableTemplateConflictError)
    expect(sheets).toHaveLength(0)
  })
})

describe('template library quality contract', () => {
  const templates = listMultitableTemplates()
  const NEW_TEMPLATE_IDS = [
    'contract-management',
    'field-inspection',
    'recruitment',
    'meeting-minutes',
    'asset-inventory',
  ] as const

  it('has unique template ids', () => {
    const ids = templates.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(templates.map((t) => [t.id, t] as const))(
    'template %s satisfies the structural quality gate',
    (_id, template) => {
      // single sheet
      expect(template.sheets).toHaveLength(1)
      const sheet = template.sheets[0]

      // 5-8 fields
      expect(sheet.fields.length).toBeGreaterThanOrEqual(5)
      expect(sheet.fields.length).toBeLessThanOrEqual(8)

      // field ids unique within the sheet
      const fieldIds = sheet.fields.map((f) => f.id)
      expect(new Set(fieldIds).size).toBe(fieldIds.length)

      // field order is contiguous from 0
      expect(sheet.fields.map((f) => f.order)).toEqual(
        sheet.fields.map((_, i) => i),
      )

      // select / multiSelect must carry non-empty options
      for (const field of sheet.fields) {
        if (field.type === 'select' || field.type === 'multiSelect') {
          expect(Array.isArray(field.options)).toBe(true)
          expect((field.options ?? []).length).toBeGreaterThan(0)
        }
      }

      // >= 2 views, view ids unique, at least one grid
      expect(sheet.views.length).toBeGreaterThanOrEqual(2)
      const viewIds = sheet.views.map((v) => v.id)
      expect(new Set(viewIds).size).toBe(viewIds.length)
      expect(sheet.views.some((v) => v.type === 'grid')).toBe(true)

      // view field references must point at real field ids
      for (const view of sheet.views) {
        if (view.type === 'kanban') {
          expect(fieldIds).toContain(view.groupByFieldId)
        }
        if (view.type === 'calendar' || view.type === 'timeline') {
          expect(view.dateFieldId).toBeTruthy()
          expect(fieldIds).toContain(view.dateFieldId)
          if (view.titleFieldId) {
            expect(fieldIds).toContain(view.titleFieldId)
          }
        }
      }
    },
  )

  it.each(NEW_TEMPLATE_IDS.map((id) => [id] as const))(
    'new template %s installs into one base with mapped fields and views',
    async (templateId) => {
      const { query, bases, sheets, fields, views } = createQuery()
      const source = templates.find((t) => t.id === templateId)
      expect(source).toBeDefined()
      const srcSheet = source!.sheets[0]

      const result = await installMultitableTemplate({
        query,
        templateId,
        baseName: `${templateId} base`,
        ownerId: 'user_q',
        idGenerator: (prefix) => `${prefix}_fixed`,
      })

      expect(bases).toHaveLength(1)
      expect(sheets).toHaveLength(1)
      expect(result.sheets[0].baseId).toBe('base_fixed')

      // fields: count + names + order preserved
      expect(fields.map((f) => f.name)).toEqual(srcSheet.fields.map((f) => f.name))

      // every select/multiSelect option propagated as { value }
      for (const srcField of srcSheet.fields) {
        if (srcField.type === 'select' || srcField.type === 'multiSelect') {
          const installed = fields.find((f) => f.name === srcField.name)
          expect(installed?.property.options).toEqual(
            (srcField.options ?? []).map((value) => ({ value })),
          )
        }
      }

      // views: count matches, kanban -> group_info, calendar/timeline -> config.dateFieldId
      expect(result.views).toHaveLength(srcSheet.views.length)
      for (const srcView of srcSheet.views) {
        if (srcView.type === 'kanban') {
          const kanban = views.find((v) => v.type === 'kanban')
          const groupField = fields.find((f) => f.name === srcSheet.fields.find((sf) => sf.id === srcView.groupByFieldId)?.name)
          expect(kanban?.group_info).toEqual({ fieldId: groupField?.id })
        }
        if (srcView.type === 'calendar' || srcView.type === 'timeline') {
          const dateField = fields.find((f) => f.name === srcSheet.fields.find((sf) => sf.id === srcView.dateFieldId)?.name)
          const tv = views.find((v) => v.type === srcView.type)
          expect(tv?.config).toEqual(expect.objectContaining({ dateFieldId: dateField?.id }))
          if (srcView.titleFieldId) {
            const titleField = fields.find((f) => f.name === srcSheet.fields.find((sf) => sf.id === srcView.titleFieldId)?.name)
            expect(titleField).toBeDefined()
            expect(tv?.config).toEqual(expect.objectContaining({ titleFieldId: titleField?.id }))
          }
        }
      }
    },
  )
})
