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
