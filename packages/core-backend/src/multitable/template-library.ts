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

export type MultitableTemplateConflictKind =
  | 'base_exists'
  | 'sheet_exists'
  | 'view_exists'
  // Plan-level self-collision (review 2026-06-11 F1): a mis-authored template
  // whose sheets/views/fields derive identical ids — invisible to DB-occupancy
  // probes, but install's per-table ON CONFLICT would 409 on the second write.
  | 'template_duplicate_id'

export type MultitableTemplateConflict = {
  severity: 'error'
  kind: MultitableTemplateConflictKind
  id: string
  name: string
  message: string
}

export type MultitableTemplateWouldCreate = {
  base: { id: string; name: string }
  sheets: Array<{ id: string; name: string; fieldCount: number; viewCount: number }>
  fields: Array<{ id: string; sheetId: string; name: string; type: string }>
  views: Array<{ id: string; sheetId: string; name: string; type: string }>
}

export type PreviewMultitableTemplateInstallInput = {
  query: MultitableProvisioningQueryFn
  templateId: string
  baseId?: string
  baseName?: string
  idGenerator?: (prefix: string) => string
}

export type MultitableTemplateInstallPreview = {
  templateId: string
  wouldCreate: MultitableTemplateWouldCreate
  conflicts: MultitableTemplateConflict[]
  installable: boolean
}

export type TemplateConflictDetectionOptions = {
  baseId: string
  baseName: string
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
  {
    id: 'contract-management',
    name: 'Contract Management',
    description: 'Track counterparties, amounts, status, signing and expiry dates.',
    category: 'Contract',
    icon: 'contract',
    color: '#7c3aed',
    sheets: [
      {
        id: 'contracts',
        name: 'Contracts',
        description: 'Contract lifecycle tracking',
        fields: [
          { id: 'name', name: 'Contract Name', type: 'string', order: 0 },
          { id: 'party', name: 'Counterparty', type: 'string', order: 1 },
          { id: 'amount', name: 'Amount', type: 'number', order: 2 },
          { id: 'status', name: 'Status', type: 'select', order: 3, options: ['Draft', 'In review', 'Signed', 'Active', 'Expired', 'Terminated'] },
          { id: 'signedAt', name: 'Signed Date', type: 'date', order: 4 },
          { id: 'expiresAt', name: 'Expiry Date', type: 'date', order: 5 },
          { id: 'owner', name: 'Owner', type: 'string', order: 6 },
          { id: 'notes', name: 'Notes', type: 'longText', order: 7 },
        ],
        views: [
          { id: 'grid', name: 'All Contracts', type: 'grid' },
          { id: 'byStatus', name: 'By Status', type: 'kanban', groupByFieldId: 'status' },
          { id: 'expiry', name: 'Expiry Calendar', type: 'calendar', dateFieldId: 'expiresAt', titleFieldId: 'name' },
        ],
      },
    ],
  },
  {
    id: 'field-inspection',
    name: 'Field Inspection',
    description: 'Log site inspections, findings, severity, and remediation.',
    category: 'Inspection',
    icon: 'inspection',
    color: '#ea580c',
    sheets: [
      {
        id: 'inspections',
        name: 'Inspections',
        description: 'Site inspection and remediation tracking',
        fields: [
          { id: 'site', name: 'Site', type: 'string', order: 0 },
          { id: 'inspector', name: 'Inspector', type: 'string', order: 1 },
          { id: 'inspectedAt', name: 'Inspected Date', type: 'date', order: 2 },
          { id: 'finding', name: 'Finding', type: 'longText', order: 3 },
          { id: 'severity', name: 'Severity', type: 'select', order: 4, options: ['Critical', 'Major', 'Minor', 'Observation'] },
          { id: 'status', name: 'Status', type: 'select', order: 5, options: ['Open', 'In remediation', 'Verified', 'Closed'] },
          { id: 'dueDate', name: 'Remediation Due', type: 'date', order: 6 },
        ],
        views: [
          { id: 'grid', name: 'All Inspections', type: 'grid' },
          { id: 'bySeverity', name: 'By Severity', type: 'kanban', groupByFieldId: 'severity' },
          { id: 'due', name: 'Remediation Timeline', type: 'timeline', dateFieldId: 'dueDate', titleFieldId: 'site' },
        ],
      },
    ],
  },
  {
    id: 'recruitment',
    name: 'Recruitment Pipeline',
    description: 'Track candidates, roles, stage, recruiter, and next steps.',
    category: 'Recruitment',
    icon: 'recruit',
    color: '#0891b2',
    sheets: [
      {
        id: 'candidates',
        name: 'Candidates',
        description: 'Hiring pipeline tracking',
        fields: [
          { id: 'candidate', name: 'Candidate', type: 'string', order: 0 },
          { id: 'role', name: 'Role', type: 'string', order: 1 },
          { id: 'stage', name: 'Stage', type: 'select', order: 2, options: ['Applied', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'] },
          { id: 'recruiter', name: 'Recruiter', type: 'string', order: 3 },
          { id: 'appliedAt', name: 'Applied Date', type: 'date', order: 4 },
          { id: 'nextStep', name: 'Next Step', type: 'longText', order: 5 },
          { id: 'rating', name: 'Rating', type: 'select', order: 6, options: ['Strong hire', 'Hire', 'Hold', 'No'] },
        ],
        views: [
          { id: 'grid', name: 'All Candidates', type: 'grid' },
          { id: 'pipeline', name: 'Pipeline', type: 'kanban', groupByFieldId: 'stage' },
          { id: 'applied', name: 'Applied Calendar', type: 'calendar', dateFieldId: 'appliedAt', titleFieldId: 'candidate' },
        ],
      },
    ],
  },
  {
    id: 'meeting-minutes',
    name: 'Meeting Minutes',
    description: 'Record meeting decisions and track action items to closure.',
    category: 'Operations',
    icon: 'notes',
    color: '#475569',
    sheets: [
      {
        id: 'meetings',
        name: 'Meetings',
        description: 'Meeting records and action items',
        fields: [
          { id: 'topic', name: 'Topic', type: 'string', order: 0 },
          { id: 'meetingDate', name: 'Meeting Date', type: 'date', order: 1 },
          { id: 'attendees', name: 'Attendees', type: 'longText', order: 2 },
          { id: 'decisions', name: 'Decisions', type: 'longText', order: 3 },
          { id: 'actionItem', name: 'Action Item', type: 'string', order: 4 },
          { id: 'assignee', name: 'Assignee', type: 'string', order: 5 },
          { id: 'status', name: 'Status', type: 'select', order: 6, options: ['Open', 'In progress', 'Done'] },
          { id: 'dueDate', name: 'Action Due', type: 'date', order: 7 },
        ],
        views: [
          { id: 'grid', name: 'All Meetings', type: 'grid' },
          { id: 'byStatus', name: 'Action Board', type: 'kanban', groupByFieldId: 'status' },
          { id: 'dueCal', name: 'Action Calendar', type: 'calendar', dateFieldId: 'dueDate', titleFieldId: 'actionItem' },
        ],
      },
    ],
  },
  {
    id: 'asset-inventory',
    name: 'Asset Inventory',
    description: 'Register equipment and assets with location, owner, and status.',
    category: 'Operations',
    icon: 'asset',
    color: '#0d9488',
    sheets: [
      {
        id: 'assets',
        name: 'Assets',
        description: 'Equipment and asset register',
        fields: [
          { id: 'asset', name: 'Asset', type: 'string', order: 0 },
          { id: 'category', name: 'Category', type: 'select', order: 1, options: ['IT', 'Office', 'Vehicle', 'Machinery', 'Other'] },
          { id: 'serialNumber', name: 'Serial Number', type: 'string', order: 2 },
          { id: 'location', name: 'Location', type: 'string', order: 3 },
          { id: 'owner', name: 'Owner', type: 'string', order: 4 },
          { id: 'status', name: 'Status', type: 'select', order: 5, options: ['In use', 'In storage', 'Under repair', 'Retired'] },
          { id: 'purchaseDate', name: 'Purchase Date', type: 'date', order: 6 },
          { id: 'notes', name: 'Notes', type: 'longText', order: 7 },
        ],
        views: [
          { id: 'grid', name: 'All Assets', type: 'grid' },
          { id: 'byStatus', name: 'By Status', type: 'kanban', groupByFieldId: 'status' },
          { id: 'purchase', name: 'Purchase Calendar', type: 'calendar', dateFieldId: 'purchaseDate', titleFieldId: 'asset' },
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

/**
 * S2 — id plan for a template install (design 20260611 §2.1).
 *
 * Derives base/sheet/field/view ids through EXACTLY the same path
 * installMultitableTemplate uses (stableChildId / mapFieldIds keyed off the
 * provided baseId), so a dry-run shows ids shaped like the ones a real install
 * would write. Callers that pass the dry-run base id back into install get the
 * same derived child ids; callers without a planned base id still get a fresh
 * install id.
 * (Derivation parity is locked by multitable-template-dryrun-routes.test.ts.)
 */
export function buildTemplateWouldCreate(
  template: MultitableTemplate,
  opts: TemplateConflictDetectionOptions,
): MultitableTemplateWouldCreate {
  const sheets: MultitableTemplateWouldCreate['sheets'] = []
  const fields: MultitableTemplateWouldCreate['fields'] = []
  const views: MultitableTemplateWouldCreate['views'] = []

  for (const templateSheet of template.sheets) {
    const sheetId = stableChildId('sheet', opts.baseId, template.id, templateSheet.id)
    sheets.push({
      id: sheetId,
      name: templateSheet.name,
      fieldCount: templateSheet.fields.length,
      viewCount: templateSheet.views.length,
    })

    const fieldIds = mapFieldIds(sheetId, template.id, templateSheet)
    for (const field of templateSheet.fields) {
      fields.push({ id: fieldIds[field.id], sheetId, name: field.name, type: field.type })
    }

    for (const templateView of templateSheet.views) {
      views.push({
        id: stableChildId('view', sheetId, template.id, templateSheet.id, templateView.id),
        sheetId,
        name: templateView.name,
        type: templateView.type,
      })
    }
  }

  return { base: { id: opts.baseId, name: opts.baseName }, sheets, fields, views }
}

/**
 * S2 — shared base/sheet/view id-occupancy detection (design 20260611 §2.1).
 *
 * PURE SELECT-only: never opens a transaction, never writes. Single source for
 * conflict semantics — installMultitableTemplate consumes this as its
 * pre-check and the dry-run route consumes it directly, so the two paths
 * cannot drift (wire-vs-fixture discipline).
 *
 * Occupancy probes deliberately do NOT filter on deleted_at: install collides
 * via INSERT ... ON CONFLICT (id), which a soft-deleted row still triggers, and
 * this function must answer exactly the question install asks.
 *
 * Conflicts are collected in install's write order (base, then per sheet: the
 * sheet, then its views), so conflicts[0].message is verbatim the first error
 * install would throw in the same scenario.
 *
 * Before the occupancy probes, the derived plan itself is checked for
 * duplicate ids (review 2026-06-11 F1): DB probes only answer occupancy, so a
 * mis-authored template whose sheets/views derive IDENTICAL ids would
 * otherwise dry-run clean yet 409 on install's per-table ON CONFLICT
 * (duplicate field ids would silently upsert-merge — fewer fields than
 * declared). Pure compute, zero-write invariant untouched.
 */
export async function detectTemplateConflicts(
  query: MultitableProvisioningQueryFn,
  template: MultitableTemplate,
  opts: TemplateConflictDetectionOptions,
): Promise<MultitableTemplateConflict[]> {
  const plan = buildTemplateWouldCreate(template, opts)
  const conflicts: MultitableTemplateConflict[] = []

  // Plan-level duplicate-id self-collision check — BEFORE any DB probe.
  // Per-kind sets: install's collision surface is per table (meta_sheets /
  // meta_fields / meta_views), and the check order mirrors install's per-sheet
  // write order (sheet → fields → views).
  const duplicateProbes: Array<{
    entity: 'sheet' | 'field' | 'view'
    items: Array<{ id: string; name: string }>
  }> = [
    { entity: 'sheet', items: plan.sheets },
    { entity: 'field', items: plan.fields },
    { entity: 'view', items: plan.views },
  ]
  for (const { entity, items } of duplicateProbes) {
    const seen = new Set<string>()
    for (const item of items) {
      if (seen.has(item.id)) {
        conflicts.push({
          severity: 'error',
          kind: 'template_duplicate_id',
          id: item.id,
          name: item.name,
          message: `Template derives duplicate ${entity} id: ${item.id}`,
        })
        continue
      }
      seen.add(item.id)
    }
  }

  const baseResult = await query('SELECT id FROM meta_bases WHERE id = $1', [opts.baseId])
  if (baseResult.rows.length > 0) {
    conflicts.push({
      severity: 'error',
      kind: 'base_exists',
      id: opts.baseId,
      name: opts.baseName,
      message: `Base already exists: ${opts.baseId}`,
    })
  }

  for (const sheet of plan.sheets) {
    const sheetResult = await query('SELECT id FROM meta_sheets WHERE id = $1', [sheet.id])
    if (sheetResult.rows.length > 0) {
      conflicts.push({
        severity: 'error',
        kind: 'sheet_exists',
        id: sheet.id,
        name: sheet.name,
        message: `Sheet already exists: ${sheet.id}`,
      })
    }

    for (const view of plan.views) {
      if (view.sheetId !== sheet.id) continue
      const viewResult = await query('SELECT id FROM meta_views WHERE id = $1', [view.id])
      if (viewResult.rows.length > 0) {
        conflicts.push({
          severity: 'error',
          kind: 'view_exists',
          id: view.id,
          name: view.name,
          message: `View already exists: ${view.id}`,
        })
      }
    }
  }

  return conflicts
}

export async function previewMultitableTemplateInstall(
  input: PreviewMultitableTemplateInstallInput,
): Promise<MultitableTemplateInstallPreview> {
  const template = getMultitableTemplate(input.templateId)
  if (!template) {
    throw new MultitableTemplateNotFoundError(input.templateId)
  }

  const makeId = input.idGenerator ?? generatedId
  const baseId = (input.baseId?.trim() || makeId('base')).slice(0, 50)
  const baseName = (input.baseName?.trim() || template.name).slice(0, 255)
  const wouldCreate = buildTemplateWouldCreate(template, { baseId, baseName })
  const conflicts = await detectTemplateConflicts(input.query, template, { baseId, baseName })

  return {
    templateId: template.id,
    wouldCreate,
    conflicts,
    installable: !conflicts.some((conflict) => conflict.severity === 'error'),
  }
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

  // S2: single-source conflict pre-check (SELECT-only). The write-time
  // rowCount checks below stay as a TOCTOU backstop for ids occupied between
  // this probe and the INSERTs; they throw the same messages this pre-check
  // derives, so external behavior is unchanged.
  const conflicts = await detectTemplateConflicts(input.query, template, { baseId, baseName })
  if (conflicts.length > 0) {
    throw new MultitableTemplateConflictError(conflicts[0].message)
  }

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
