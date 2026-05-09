import { createHash, randomUUID } from 'crypto'

import {
  createSheet,
  createView,
  ensureFields,
  type MultitableProvisioningField,
  type MultitableProvisioningFieldDescriptor,
  type MultitableProvisioningQueryFn,
  type MultitableProvisioningSheet,
  type MultitableProvisioningView,
} from './provisioning'

export type MultitableTemplateField = MultitableProvisioningFieldDescriptor & {
  description?: string
}

export type MultitableTemplateView = {
  id: string
  name: string
  type: string
  groupByFieldId?: string
  dateFieldId?: string
  titleFieldId?: string
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

export type MultitableTemplateSheet = {
  id: string
  name: string
  description?: string | null
  fields: MultitableTemplateField[]
  views: MultitableTemplateView[]
}

export type MultitableTemplate = {
  id: string
  name: string
  description: string
  category: string
  icon: string
  color: string
  sheets: MultitableTemplateSheet[]
}

export type MultitableTemplateBase = {
  id: string
  name: string
  icon: string | null
  color: string | null
  ownerId: string | null
  workspaceId: string | null
}

export type InstallMultitableTemplateInput = {
  query: MultitableProvisioningQueryFn
  templateId: string
  baseId?: string
  baseName?: string
  ownerId?: string | null
  workspaceId?: string | null
  idGenerator?: (prefix: string) => string
}

export type InstallMultitableTemplateResult = {
  template: MultitableTemplate
  base: MultitableTemplateBase
  sheets: MultitableProvisioningSheet[]
  fields: MultitableProvisioningField[]
  views: MultitableProvisioningView[]
}

export class MultitableTemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Template not found: ${templateId}`)
    this.name = 'MultitableTemplateNotFoundError'
  }
}

export class MultitableTemplateConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultitableTemplateConflictError'
  }
}

const TEMPLATE_LIBRARY: MultitableTemplate[] = [
  {
    id: 'project-tracker',
    name: 'Project Tracker',
    description: 'Track owners, priorities, due dates, status, and execution notes.',
    category: 'Project management',
    icon: 'kanban',
    color: '#2563eb',
    sheets: [
      {
        id: 'tasks',
        name: 'Tasks',
        description: 'Project task pipeline',
        fields: [
          { id: 'task', name: 'Task', type: 'string', order: 0 },
          { id: 'status', name: 'Status', type: 'select', order: 1, options: ['Not started', 'In progress', 'Blocked', 'Done'] },
          { id: 'owner', name: 'Owner', type: 'string', order: 2 },
          { id: 'priority', name: 'Priority', type: 'select', order: 3, options: ['P0', 'P1', 'P2'] },
          { id: 'dueDate', name: 'Due Date', type: 'date', order: 4 },
          { id: 'notes', name: 'Notes', type: 'longText', order: 5 },
        ],
        views: [
          { id: 'grid', name: 'All Tasks', type: 'grid' },
          { id: 'kanban', name: 'By Status', type: 'kanban', groupByFieldId: 'status' },
          { id: 'calendar', name: 'Due Calendar', type: 'calendar', dateFieldId: 'dueDate', titleFieldId: 'task' },
        ],
      },
    ],
  },
  {
    id: 'sales-crm',
    name: 'Sales CRM',
    description: 'Manage accounts, contacts, stage, deal value, and next action.',
    category: 'Sales',
    icon: 'pipeline',
    color: '#16a34a',
    sheets: [
      {
        id: 'deals',
        name: 'Deals',
        description: 'Opportunity pipeline',
        fields: [
          { id: 'account', name: 'Account', type: 'string', order: 0 },
          { id: 'contact', name: 'Contact', type: 'string', order: 1 },
          { id: 'stage', name: 'Stage', type: 'select', order: 2, options: ['Lead', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost'] },
          { id: 'value', name: 'Deal Value', type: 'number', order: 3 },
          { id: 'closeDate', name: 'Close Date', type: 'date', order: 4 },
          { id: 'nextAction', name: 'Next Action', type: 'longText', order: 5 },
        ],
        views: [
          { id: 'grid', name: 'All Deals', type: 'grid' },
          { id: 'pipeline', name: 'Pipeline', type: 'kanban', groupByFieldId: 'stage' },
          { id: 'calendar', name: 'Close Calendar', type: 'calendar', dateFieldId: 'closeDate', titleFieldId: 'account' },
        ],
      },
    ],
  },
  {
    id: 'issue-tracker',
    name: 'Issue Tracker',
    description: 'Capture bugs, severity, assignee, due date, and reproduction notes.',
    category: 'Engineering',
    icon: 'bug',
    color: '#dc2626',
    sheets: [
      {
        id: 'issues',
        name: 'Issues',
        description: 'Bug and issue triage',
        fields: [
          { id: 'issue', name: 'Issue', type: 'string', order: 0 },
          { id: 'severity', name: 'Severity', type: 'select', order: 1, options: ['Critical', 'High', 'Medium', 'Low'] },
          { id: 'status', name: 'Status', type: 'select', order: 2, options: ['Open', 'Triaged', 'In progress', 'Resolved'] },
          { id: 'assignee', name: 'Assignee', type: 'string', order: 3 },
          { id: 'dueDate', name: 'Due Date', type: 'date', order: 4 },
          { id: 'reproSteps', name: 'Repro Steps', type: 'longText', order: 5 },
        ],
        views: [
          { id: 'grid', name: 'All Issues', type: 'grid' },
          { id: 'severity', name: 'By Severity', type: 'kanban', groupByFieldId: 'severity' },
          { id: 'timeline', name: 'Due Timeline', type: 'timeline', dateFieldId: 'dueDate', titleFieldId: 'issue' },
        ],
      },
    ],
  },
]

function normalizeTemplate(template: MultitableTemplate): MultitableTemplate {
  return {
    ...template,
    sheets: template.sheets.map((sheet) => ({
      ...sheet,
      fields: sheet.fields.map((field) => ({ ...field, property: { ...(field.property ?? {}) } })),
      views: sheet.views.map((view) => ({ ...view, config: { ...(view.config ?? {}) } })),
    })),
  }
}

function generatedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`.slice(0, 50)
}

function stableChildId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha1')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 24)
  return `${prefix}_${digest}`.slice(0, 50)
}

function normalizeBaseRow(row: Record<string, unknown>): MultitableTemplateBase {
  return {
    id: String(row.id),
    name: String(row.name),
    icon: typeof row.icon === 'string' ? row.icon : null,
    color: typeof row.color === 'string' ? row.color : null,
    ownerId: typeof row.owner_id === 'string' ? row.owner_id : null,
    workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : null,
  }
}

function mapFieldIds(sheetId: string, templateId: string, sheet: MultitableTemplateSheet): Record<string, string> {
  const next: Record<string, string> = {}
  for (const field of sheet.fields) {
    next[field.id] = stableChildId('fld', templateId, sheetId, field.id)
  }
  return next
}

function buildViewConfig(view: MultitableTemplateView, fieldIds: Record<string, string>): Record<string, unknown> {
  const config = { ...(view.config ?? {}) }
  if (view.dateFieldId) config.dateFieldId = fieldIds[view.dateFieldId]
  if (view.titleFieldId) config.titleFieldId = fieldIds[view.titleFieldId]
  return config
}

function buildGroupInfo(view: MultitableTemplateView, fieldIds: Record<string, string>): Record<string, unknown> {
  if (!view.groupByFieldId) return {}
  return { fieldId: fieldIds[view.groupByFieldId] }
}

export function listMultitableTemplates(): MultitableTemplate[] {
  return TEMPLATE_LIBRARY.map(normalizeTemplate)
}

export function getMultitableTemplate(templateId: string): MultitableTemplate | null {
  const template = TEMPLATE_LIBRARY.find((item) => item.id === templateId)
  return template ? normalizeTemplate(template) : null
}

export async function installMultitableTemplate(
  input: InstallMultitableTemplateInput,
): Promise<InstallMultitableTemplateResult> {
  const template = getMultitableTemplate(input.templateId)
  if (!template) {
    throw new MultitableTemplateNotFoundError(input.templateId)
  }

  const makeId = input.idGenerator ?? generatedId
  const baseId = (input.baseId?.trim() || makeId('base')).slice(0, 50)
  const baseName = (input.baseName?.trim() || template.name).slice(0, 255)
  const baseInsert = await input.query(
    `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING
     RETURNING id, name, icon, color, owner_id, workspace_id`,
    [baseId, baseName, template.icon, template.color, input.ownerId ?? null, input.workspaceId ?? null],
  )
  if ((baseInsert.rowCount ?? 0) === 0) {
    throw new MultitableTemplateConflictError(`Base already exists: ${baseId}`)
  }

  const base = normalizeBaseRow((baseInsert.rows as Record<string, unknown>[])[0] ?? {
    id: baseId,
    name: baseName,
    icon: template.icon,
    color: template.color,
    owner_id: input.ownerId ?? null,
    workspace_id: input.workspaceId ?? null,
  })

  const sheets: MultitableProvisioningSheet[] = []
  const fields: MultitableProvisioningField[] = []
  const views: MultitableProvisioningView[] = []

  for (const templateSheet of template.sheets) {
    const sheetId = stableChildId('sheet', baseId, template.id, templateSheet.id)
    const sheetResult = await createSheet({
      query: input.query,
      sheetId,
      baseId,
      name: templateSheet.name,
      description: templateSheet.description ?? null,
    })
    if (!sheetResult.created || !sheetResult.sheet) {
      throw new MultitableTemplateConflictError(`Sheet already exists: ${sheetId}`)
    }
    sheets.push(sheetResult.sheet)

    const fieldIds = mapFieldIds(sheetId, template.id, templateSheet)
    const installedFields = await ensureFields({
      query: input.query,
      sheetId,
      fields: templateSheet.fields.map((field) => ({
        ...field,
        id: fieldIds[field.id],
      })),
    })
    fields.push(...installedFields)

    for (const templateView of templateSheet.views) {
      const viewId = stableChildId('view', sheetId, template.id, templateSheet.id, templateView.id)
      const hiddenFieldIds = (templateView.hiddenFieldIds ?? [])
        .map((fieldId) => fieldIds[fieldId])
        .filter((fieldId): fieldId is string => typeof fieldId === 'string' && fieldId.length > 0)
      const viewResult = await createView({
        query: input.query,
        viewId,
        sheetId,
        name: templateView.name,
        type: templateView.type,
        groupInfo: buildGroupInfo(templateView, fieldIds),
        hiddenFieldIds,
        config: buildViewConfig(templateView, fieldIds),
      })
      if (!viewResult.created || !viewResult.view) {
        throw new MultitableTemplateConflictError(`View already exists: ${viewId}`)
      }
      views.push(viewResult.view)
    }
  }

  return {
    template,
    base,
    sheets,
    fields,
    views,
  }
}
