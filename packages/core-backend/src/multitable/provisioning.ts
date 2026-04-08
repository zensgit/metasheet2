import { createHash } from 'crypto'
import type {
  MultitableProvisioningFieldDescriptor,
  MultitableProvisioningFieldType,
  MultitableProvisioningObjectDescriptor,
  MultitableProvisioningViewDescriptor,
} from './contracts'

export type {
  MultitableProvisioningFieldDescriptor,
  MultitableProvisioningFieldType,
  MultitableProvisioningObjectDescriptor,
  MultitableProvisioningViewDescriptor,
} from './contracts'

export type MultitableProvisioningQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type MultitableProvisioningSheet = {
  id: string
  baseId: string | null
  name: string
  description: string | null
}

export type MultitableProvisioningField = {
  id: string
  sheetId: string
  name: string
  type: MultitableProvisioningFieldType
  property: Record<string, unknown>
  order: number
}

export type MultitableProvisioningView = {
  id: string
  sheetId: string
  name: string
  type: string
  filterInfo: Record<string, unknown>
  sortInfo: Record<string, unknown>
  groupInfo: Record<string, unknown>
  hiddenFieldIds: string[]
  config: Record<string, unknown>
}

export type EnsureSheetInput = {
  query: MultitableProvisioningQueryFn
  sheetId: string
  baseId?: string | null
  name: string
  description?: string | null
}

export type CreateSheetResult =
  | { created: true; sheet: MultitableProvisioningSheet }
  | { created: false; sheet: null }

export type EnsureFieldsInput = {
  query: MultitableProvisioningQueryFn
  sheetId: string
  fields: MultitableProvisioningFieldDescriptor[]
}

export type EnsureObjectInput = {
  query: MultitableProvisioningQueryFn
  projectId: string
  baseId?: string | null
  descriptor: MultitableProvisioningObjectDescriptor
}

export type EnsureViewInput = {
  query: MultitableProvisioningQueryFn
  projectId: string
  sheetId: string
  descriptor: MultitableProvisioningViewDescriptor
}

export type CreateViewInput = {
  query: MultitableProvisioningQueryFn
  viewId: string
  sheetId: string
  name: string
  type?: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

export type CreateViewResult =
  | { created: true; view: MultitableProvisioningView }
  | { created: false; view: null }

export const DEFAULT_BASE_ID = 'base_legacy'
export const DEFAULT_BASE_NAME = 'Migrated Base'

function normalizeJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (typeof value === 'string') {
    try {
      return normalizeStringArray(JSON.parse(value))
    } catch {
      return []
    }
  }
  return []
}

function stableMetaId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha1')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 24)
  return `${prefix}_${digest}`.slice(0, 50)
}

export function getObjectSheetId(projectId: string, objectId: string): string {
  return stableMetaId('sheet', projectId, objectId)
}

export function getObjectViewId(projectId: string, objectId: string, viewId: string): string {
  return stableMetaId('view', projectId, objectId, viewId)
}

export function getObjectFieldId(projectId: string, objectId: string, fieldId: string): string {
  return stableMetaId('fld', projectId, objectId, fieldId)
}

function buildFieldProperty(
  field: MultitableProvisioningFieldDescriptor,
): Record<string, unknown> {
  const base = normalizeJson(field.property)
  if (field.type !== 'select' || !Array.isArray(field.options) || field.options.length === 0) {
    return base
  }
  return {
    ...base,
    options: field.options.map((value) => ({ value })),
  }
}

export async function ensureLegacyBase(
  query: MultitableProvisioningQueryFn,
): Promise<string> {
  await query(
    `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_BASE_ID, DEFAULT_BASE_NAME, 'table', '#1677ff', null, null],
  )
  return DEFAULT_BASE_ID
}

async function loadActiveSheet(
  query: MultitableProvisioningQueryFn,
  sheetId: string,
): Promise<MultitableProvisioningSheet | null> {
  const result = await query(
    `SELECT id, base_id, name, description
     FROM meta_sheets
     WHERE id = $1 AND deleted_at IS NULL`,
    [sheetId],
  )
  const row = (result.rows as any[])[0]
  if (!row) return null
  return {
    id: String(row.id),
    baseId: typeof row.base_id === 'string' ? row.base_id : null,
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
  }
}

async function loadActiveView(
  query: MultitableProvisioningQueryFn,
  viewId: string,
): Promise<MultitableProvisioningView | null> {
  const result = await query(
    `SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config
     FROM meta_views
     WHERE id = $1`,
    [viewId],
  )
  const row = (result.rows as any[])[0]
  if (!row) return null
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    name: String(row.name),
    type: String(row.type ?? 'grid'),
    filterInfo: normalizeJson(row.filter_info),
    sortInfo: normalizeJson(row.sort_info),
    groupInfo: normalizeJson(row.group_info),
    hiddenFieldIds: normalizeStringArray(row.hidden_field_ids),
    config: normalizeJson(row.config),
  }
}

export async function createSheet(
  input: EnsureSheetInput,
): Promise<CreateSheetResult> {
  const query = input.query
  const baseId = input.baseId ?? await ensureLegacyBase(query)
  const insert = await query(
    `INSERT INTO meta_sheets (id, base_id, name, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [input.sheetId, baseId, input.name.trim(), input.description ?? null],
  )

  if ((insert.rowCount ?? 0) === 0) {
    return { created: false, sheet: null }
  }

  const sheet = await loadActiveSheet(query, input.sheetId)
  if (!sheet) {
    throw new Error(`Failed to create sheet: ${input.sheetId}`)
  }
  return { created: true, sheet }
}

export async function ensureSheet(
  input: EnsureSheetInput,
): Promise<MultitableProvisioningSheet> {
  const query = input.query
  const baseId = input.baseId ?? await ensureLegacyBase(query)

  await query(
    `INSERT INTO meta_sheets (id, base_id, name, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [input.sheetId, baseId, input.name.trim(), input.description ?? null],
  )

  const sheet = await loadActiveSheet(query, input.sheetId)
  if (!sheet) {
    throw new Error(`Failed to ensure sheet: ${input.sheetId}`)
  }
  return sheet
}

export async function ensureFields(
  input: EnsureFieldsInput,
): Promise<MultitableProvisioningField[]> {
  const fields = input.fields ?? []
  for (const [index, field] of fields.entries()) {
    const order = typeof field.order === 'number' ? field.order : index
    await input.query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         type = EXCLUDED.type,
         property = EXCLUDED.property,
         "order" = EXCLUDED."order"`,
      [
        field.id,
        input.sheetId,
        field.name.trim(),
        field.type,
        JSON.stringify(buildFieldProperty(field)),
        order,
      ],
    )
  }

  const ids = fields.map((field) => field.id)
  if (ids.length === 0) return []

  const result = await input.query(
    `SELECT id, sheet_id, name, type, property, "order"
     FROM meta_fields
     WHERE sheet_id = $1 AND id = ANY($2::text[])
     ORDER BY "order" ASC, id ASC`,
    [input.sheetId, ids],
  )

  return (result.rows as any[]).map((row) => ({
    id: String(row.id),
    sheetId: String(row.sheet_id),
    name: String(row.name),
    type: String(row.type) as MultitableProvisioningFieldType,
    property: normalizeJson(row.property),
    order: Number(row.order ?? 0),
  }))
}

export async function ensureView(
  input: EnsureViewInput,
): Promise<MultitableProvisioningView> {
  const descriptor = input.descriptor
  const viewId = getObjectViewId(input.projectId, descriptor.objectId, descriptor.id)
  await input.query(
    `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       type = EXCLUDED.type,
       filter_info = EXCLUDED.filter_info,
       sort_info = EXCLUDED.sort_info,
       group_info = EXCLUDED.group_info,
       hidden_field_ids = EXCLUDED.hidden_field_ids,
       config = EXCLUDED.config`,
    [
      viewId,
      input.sheetId,
      descriptor.name.trim(),
      descriptor.type || 'grid',
      JSON.stringify(normalizeJson(descriptor.filterInfo)),
      JSON.stringify(normalizeJson(descriptor.sortInfo)),
      JSON.stringify(normalizeJson(descriptor.groupInfo)),
      JSON.stringify(Array.isArray(descriptor.hiddenFieldIds) ? descriptor.hiddenFieldIds : []),
      JSON.stringify(normalizeJson(descriptor.config)),
    ],
  )

  const view = await loadActiveView(input.query, viewId)
  if (!view) {
    throw new Error(`Failed to ensure view: ${descriptor.id}`)
  }
  return view
}

export async function createView(
  input: CreateViewInput,
): Promise<CreateViewResult> {
  const insert = await input.query(
    `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.viewId,
      input.sheetId,
      input.name.trim(),
      input.type || 'grid',
      JSON.stringify(normalizeJson(input.filterInfo)),
      JSON.stringify(normalizeJson(input.sortInfo)),
      JSON.stringify(normalizeJson(input.groupInfo)),
      JSON.stringify(Array.isArray(input.hiddenFieldIds) ? input.hiddenFieldIds : []),
      JSON.stringify(normalizeJson(input.config)),
    ],
  )

  if ((insert.rowCount ?? 0) === 0) {
    return { created: false, view: null }
  }

  const view = await loadActiveView(input.query, input.viewId)
  if (!view) {
    throw new Error(`Failed to create view: ${input.viewId}`)
  }
  return { created: true, view }
}

export async function ensureObject(
  input: EnsureObjectInput,
): Promise<{
  baseId: string
  sheet: MultitableProvisioningSheet
  fields: MultitableProvisioningField[]
}> {
  const baseId = input.baseId ?? await ensureLegacyBase(input.query)
  const sheetId = getObjectSheetId(input.projectId, input.descriptor.id)
  const sheet = await ensureSheet({
    query: input.query,
    sheetId,
    baseId,
    name: input.descriptor.name,
    description: input.descriptor.description ?? null,
  })

  const fields = await ensureFields({
    query: input.query,
    sheetId,
    fields: (input.descriptor.fields ?? []).map((field) => ({
      ...field,
      id: stableMetaId('fld', input.projectId, input.descriptor.id, field.id),
    })),
  })

  return {
    baseId,
    sheet,
    fields,
  }
}
