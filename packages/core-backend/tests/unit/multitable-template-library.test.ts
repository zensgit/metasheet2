import { describe, expect, it } from 'vitest'

import {
  MultitableTemplateConflictError,
  MultitableTemplateNotFoundError,
  installMultitableTemplate,
  listMultitableTemplates,
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
      })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
      const [viewId] = params as [string]
      return { rows: views.filter((view) => view.id === viewId) }
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
