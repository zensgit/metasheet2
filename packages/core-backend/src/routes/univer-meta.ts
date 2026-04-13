import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import * as path from 'path'
import { Router } from 'express'
import { z } from 'zod'
import { poolManager } from '../integration/db/connection-pool'
import { eventBus } from '../integration/events/event-bus'
import {
  deriveFieldPermissions,
  deriveViewPermissions,
  type FieldPermissionScope,
  type ViewPermissionScope,
  isFieldAlwaysReadOnly,
  isFieldPermissionHidden,
} from '../multitable/permission-derivation'
import { rbacGuard, rbacGuardAny } from '../rbac/rbac'
import { isAdmin, listUserPermissions } from '../rbac/service'
import {
  queryRecordsWithCursor,
  buildRecordsCacheKey,
  type CursorPaginatedResult,
  type LoadedMultitableRecord,
} from '../multitable/records'
import { StorageServiceImpl } from '../services/StorageService'
import { createUploadMiddleware, loadMulter } from '../types/multer'
import type { RequestWithFile } from '../types/multer'
import { MultitableFormulaEngine } from '../multitable/formula-engine'

const multitableFormulaEngine = new MultitableFormulaEngine()

type UniverMetaField = {
  id: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'formula' | 'select' | 'link' | 'lookup' | 'rollup' | 'attachment'
  options?: Array<{ value: string; color?: string }>
  order?: number
  property?: Record<string, unknown>
}

type UniverMetaRecord = {
  id: string
  version: number
  data: Record<string, unknown>
  createdBy?: string | null
}

type UniverMetaView = {
  id: string
  fields: UniverMetaField[]
  rows: UniverMetaRecord[]
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MultitableAttachment[]>>
  view?: UniverMetaViewConfig
  meta?: {
    warnings?: string[]
    computedFilterSort?: boolean
    ignoredSortFieldIds?: string[]
    ignoredFilterFieldIds?: string[]
    capabilityOrigin?: MultitableCapabilityOrigin
    permissions?: MultitableScopedPermissions
  }
  page?: {
    offset: number
    limit: number
    total: number
    hasMore: boolean
  }
}

type UniverMetaViewConfig = {
  id: string
  sheetId: string
  name: string
  type: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

const DEFAULT_BASE_ID = 'base_legacy'
const DEFAULT_BASE_NAME = 'Migrated Base'
const SYSTEM_PEOPLE_SHEET_NAME = 'People'
const SYSTEM_PEOPLE_SHEET_DESCRIPTION = '__metasheet_system:people__'
const ATTACHMENT_PATH = process.env.ATTACHMENT_PATH || path.join(process.cwd(), 'data', 'attachments')
const ATTACHMENT_UPLOAD_MAX_SIZE = Number.parseInt(process.env.ATTACHMENT_MAX_SIZE ?? '', 10) || 100 * 1024 * 1024
const multitableMulter = loadMulter()
const multitableUpload = createUploadMiddleware(multitableMulter, { fileSize: ATTACHMENT_UPLOAD_MAX_SIZE })

let multitableAttachmentStorage: StorageServiceImpl | null = null
const metaSheetSummaryCache = new Map<string, { id: string; name: string }>()
const metaFieldCache = new Map<string, UniverMetaField[]>()
const metaViewConfigCache = new Map<string, UniverMetaViewConfig>()

// ---------------------------------------------------------------------------
// Lightweight query-result cache for cursor-paginated record queries
// ---------------------------------------------------------------------------
type RecordsCacheEntry = { data: unknown; expiresAt: number }
const recordsQueryCache = new Map<string, RecordsCacheEntry>()
const RECORDS_CACHE_TTL_MS = 30_000

function getRecordsCache(key: string): unknown | null {
  const entry = recordsQueryCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    recordsQueryCache.delete(key)
    return null
  }
  return entry.data
}

function setRecordsCache(key: string, data: unknown): void {
  recordsQueryCache.set(key, { data, expiresAt: Date.now() + RECORDS_CACHE_TTL_MS })
}

function invalidateRecordsCacheForSheet(sheetId: string): void {
  const prefix = `mt:records:${sheetId}:`
  for (const key of recordsQueryCache.keys()) {
    if (key.startsWith(prefix)) {
      recordsQueryCache.delete(key)
    }
  }
}

type UniverMetaBase = {
  id: string
  name: string
  icon: string | null
  color: string | null
  ownerId: string | null
  workspaceId: string | null
}

type MultitableCapabilities = {
  canRead: boolean
  canCreateRecord: boolean
  canEditRecord: boolean
  canDeleteRecord: boolean
  canManageFields: boolean
  canManageSheetAccess: boolean
  canManageViews: boolean
  canComment: boolean
  canManageAutomation: boolean
  canExport: boolean
}

type MultitableCapabilityOrigin = {
  source: 'admin' | 'global-rbac' | 'sheet-grant' | 'sheet-scope'
  hasSheetAssignments: boolean
}

type MultitableFieldPermission = {
  visible: boolean
  readOnly: boolean
}

type MultitableViewPermission = {
  canAccess: boolean
  canConfigure: boolean
  canDelete: boolean
}

type MultitableRowActions = {
  canEdit: boolean
  canDelete: boolean
  canComment: boolean
}

type MultitableScopedPermissions = {
  fieldPermissions?: Record<string, MultitableFieldPermission>
  viewPermissions?: Record<string, MultitableViewPermission>
  rowActions?: MultitableRowActions
  rowActionOverrides?: Record<string, MultitableRowActions>
}

type LinkedRecordSummary = {
  id: string
  display: string
}

type MultitableAttachment = {
  id: string
  filename: string
  mimeType: string
  size: number
  url: string
  thumbnailUrl: string | null
  uploadedAt: string | null
}

type MultitableSheetRealtimePayload = {
  spreadsheetId: string
  actorId?: string | null
  source: 'multitable'
  kind: 'record-created' | 'record-updated' | 'record-deleted' | 'attachment-updated'
  recordId?: string
  recordIds?: string[]
  fieldIds?: string[]
  recordPatches?: Array<{
    recordId: string
    version?: number
    patch: Record<string, unknown>
  }>
}

type RecordSummaryPage = {
  records: LinkedRecordSummary[]
  displayMap: Record<string, string>
  page: {
    offset: number
    limit: number
    total: number
    hasMore: boolean
  }
  displayFieldId: string | null
}

type PeopleSheetPreset = {
  sheet: {
    id: string
    baseId: string | null
    name: string
    description: string | null
  }
  fieldProperty: Record<string, unknown>
}

function buildId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

type FormulaDependencyQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

async function syncFormulaDependencies(
  query: FormulaDependencyQueryFn,
  sheetId: string,
  fieldId: string,
  dependsOnFieldIds: string[],
): Promise<void> {
  // Remove old dependencies for this field
  await query(
    'DELETE FROM formula_dependencies WHERE sheet_id = $1 AND field_id = $2',
    [sheetId, fieldId],
  )
  // Insert new dependencies
  for (const depFieldId of dependsOnFieldIds) {
    await query(
      `INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT ON CONSTRAINT uq_formula_dep DO NOTHING`,
      [sheetId, fieldId, depFieldId],
    )
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (isPlainObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (isPlainObject(parsed)) return parsed
    } catch {
      return {}
    }
  }
  return {}
}

function normalizeJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'string') return v.trim()
        if (typeof v === 'number' && Number.isFinite(v)) return String(v)
        return ''
      })
      .filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return normalizeJsonArray(parsed)
    } catch {
      return []
    }
  }
  return []
}

function isSystemPeopleSheetDescription(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === SYSTEM_PEOPLE_SHEET_DESCRIPTION
}

function filterVisibleSheetRows<T extends { description?: unknown }>(rows: T[]): T[] {
  return rows.filter((row) => !isSystemPeopleSheetDescription(row.description))
}

type LinkFieldConfig = {
  foreignSheetId: string
  limitSingleRecord: boolean
}

type LookupFieldConfig = {
  linkFieldId: string
  targetFieldId: string
  foreignSheetId?: string
}

type RollupAggregation = 'count' | 'sum' | 'avg' | 'min' | 'max'

type RollupFieldConfig = {
  linkFieldId: string
  targetFieldId: string
  aggregation: RollupAggregation
  foreignSheetId?: string
}

function parseLinkFieldConfig(property: unknown): LinkFieldConfig | null {
  const obj = normalizeJson(property)
  const foreign = obj.foreignDatasheetId ?? obj.foreignSheetId ?? obj.datasheetId
  if (typeof foreign !== 'string' || foreign.trim().length === 0) return null

  return {
    foreignSheetId: foreign.trim(),
    limitSingleRecord: obj.limitSingleRecord === true,
  }
}

function parseLookupFieldConfig(property: unknown): LookupFieldConfig | null {
  const obj = normalizeJson(property)
  const linkFieldId = obj.relatedLinkFieldId ?? obj.linkFieldId ?? obj.linkedFieldId ?? obj.sourceFieldId
  const targetFieldId = obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.targetFieldId ?? obj.lookupFieldId
  if (typeof linkFieldId !== 'string' || linkFieldId.trim().length === 0) return null
  if (typeof targetFieldId !== 'string' || targetFieldId.trim().length === 0) return null

  const foreign = obj.datasheetId ?? obj.foreignDatasheetId ?? obj.foreignSheetId
  const foreignSheetId = typeof foreign === 'string' && foreign.trim().length > 0 ? foreign.trim() : undefined

  return {
    linkFieldId: linkFieldId.trim(),
    targetFieldId: targetFieldId.trim(),
    ...(foreignSheetId ? { foreignSheetId } : {}),
  }
}

function parseRollupAggregation(value: unknown): RollupAggregation | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'counta') return 'count'
  if (normalized === 'count' || normalized === 'sum' || normalized === 'avg' || normalized === 'min' || normalized === 'max') {
    return normalized as RollupAggregation
  }
  return null
}

function parseRollupFieldConfig(property: unknown): RollupFieldConfig | null {
  const obj = normalizeJson(property)
  const linkFieldId = obj.linkedFieldId ?? obj.linkFieldId ?? obj.relatedLinkFieldId ?? obj.sourceFieldId
  const targetFieldId = obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId
  if (typeof linkFieldId !== 'string' || linkFieldId.trim().length === 0) return null
  if (typeof targetFieldId !== 'string' || targetFieldId.trim().length === 0) return null

  const aggregation = parseRollupAggregation(obj.aggregation ?? obj.agg ?? obj.function ?? obj.rollupFunction)
  if (!aggregation) return null

  const foreign = obj.datasheetId ?? obj.foreignDatasheetId ?? obj.foreignSheetId
  const foreignSheetId = typeof foreign === 'string' && foreign.trim().length > 0 ? foreign.trim() : undefined

  return {
    linkFieldId: linkFieldId.trim(),
    targetFieldId: targetFieldId.trim(),
    aggregation,
    ...(foreignSheetId ? { foreignSheetId } : {}),
  }
}

async function validateLookupRollupConfig(
  req: Request,
  query: QueryFn,
  sheetId: string,
  type: UniverMetaField['type'],
  property: unknown,
): Promise<string | null> {
  if (type !== 'lookup' && type !== 'rollup') return null

  const config =
    type === 'lookup' ? parseLookupFieldConfig(property) : parseRollupFieldConfig(property)
  if (!config) {
    return type === 'lookup'
      ? 'Lookup 属性需要 relatedLinkFieldId 和 lookUpTargetFieldId'
      : 'Rollup 属性需要 linkedFieldId、targetFieldId 和 aggregation'
  }

  const linkFieldRes = await query(
    'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = $2',
    [sheetId, config.linkFieldId],
  )
  if ((linkFieldRes as any).rows.length === 0) {
    return `Link 字段不存在：${config.linkFieldId}`
  }
  const linkRow = (linkFieldRes as any).rows[0]
  const linkType = mapFieldType(String(linkRow.type ?? ''))
  if (linkType !== 'link') {
    return `字段 ${config.linkFieldId} 不是 Link 类型`
  }
  const linkCfg = parseLinkFieldConfig(linkRow.property)
  if (!linkCfg) {
    return `Link 字段缺少 foreignSheetId：${config.linkFieldId}`
  }

  if (config.foreignSheetId && config.foreignSheetId !== linkCfg.foreignSheetId) {
    return `外表不匹配：Link 字段指向 ${linkCfg.foreignSheetId}，配置为 ${config.foreignSheetId}`
  }

  const targetRes = await query(
    'SELECT id FROM meta_fields WHERE sheet_id = $1 AND id = $2',
    [linkCfg.foreignSheetId, config.targetFieldId],
  )
  if ((targetRes as any).rows.length === 0) {
    return `外表字段不存在：${config.targetFieldId}（sheetId=${linkCfg.foreignSheetId}）`
  }

  const { capabilities } = await resolveSheetCapabilities(req, query, linkCfg.foreignSheetId)
  if (!capabilities.canRead) {
    throw new PermissionError(`Insufficient permissions to read linked sheet: ${linkCfg.foreignSheetId}`)
  }

  return null
}

function normalizeLinkIds(value: unknown): string[] {
  if (value === null || value === undefined) return []

  const raw: string[] = []
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') raw.push(v)
      else if (typeof v === 'number' && Number.isFinite(v)) raw.push(String(v))
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return []
    const jsonParsed = normalizeJsonArray(trimmed)
    if (jsonParsed.length > 0) raw.push(...jsonParsed)
    else if (trimmed.includes(',')) raw.push(...trimmed.split(','))
    else raw.push(trimmed)
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    raw.push(String(value))
  }

  const seen = new Set<string>()
  return raw
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .filter((v) => {
      if (seen.has(v)) return false
      seen.add(v)
      return true
    })
}

function normalizeAttachmentIds(value: unknown): string[] {
  return normalizeLinkIds(value)
}

function normalizeSearchTerm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isSearchableFieldType(type: UniverMetaField['type']): boolean {
  return type === 'string' || type === 'number' || type === 'date' || type === 'select' || type === 'formula'
}

function valueMatchesSearch(value: unknown, search: string): boolean {
  if (!search) return true
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.toLowerCase().includes(search)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase().includes(search)
  if (Array.isArray(value)) return value.some((item) => valueMatchesSearch(item, search))
  return false
}

function recordMatchesSearch(record: UniverMetaRecord, fields: UniverMetaField[], search: string): boolean {
  if (!search) return true
  return fields.some((field) => isSearchableFieldType(field.type) && valueMatchesSearch(record.data[field.id], search))
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function buildRecordSearchPredicateSql(
  fieldIds: string[],
  searchParamIndex: number,
  firstFieldParamIndex: number,
  dataExpression = 'data',
): string {
  if (fieldIds.length === 0) return 'FALSE'
  return fieldIds
    .map((_, index) =>
      `LOWER(COALESCE(${dataExpression} ->> $${firstFieldParamIndex + index}, '')) LIKE $${searchParamIndex} ESCAPE '\\'`,
    )
    .join(' OR ')
}

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as any)?.code === 'string' ? (err as any).code : null
  const msg = typeof (err as any)?.message === 'string' ? (err as any).message : ''
  if (code === '42P01') return msg.includes(tableName)
  return msg.includes(`relation \"${tableName}\" does not exist`)
}

function mapFieldType(type: string): UniverMetaField['type'] {
  const normalized = type.trim().toLowerCase()
  if (normalized === 'number') return 'number'
  if (normalized === 'boolean' || normalized === 'checkbox') return 'boolean'
  if (normalized === 'date' || normalized === 'datetime') return 'date'
  if (normalized === 'formula') return 'formula'
  if (normalized === 'select' || normalized === 'multiselect') return 'select'
  if (normalized === 'link') return 'link'
  if (normalized === 'lookup') return 'lookup'
  if (normalized === 'rollup') return 'rollup'
  if (normalized === 'attachment') return 'attachment'
  return 'string'
}

function extractSelectOptions(property: unknown): Array<{ value: string; color?: string }> | undefined {
  const obj = normalizeJson(property)
  const raw = obj.options
  if (!Array.isArray(raw)) return undefined

  const options: Array<{ value: string; color?: string }> = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const value = item.value
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const color = typeof item.color === 'string' ? item.color : undefined
    options.push({ value: String(value), ...(color ? { color } : {}) })
  }

  return options.length > 0 ? options : undefined
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function sanitizeFieldProperty(type: UniverMetaField['type'], property: unknown): Record<string, unknown> {
  const obj = normalizeJson(property)
  if (type === 'select') {
    const options = extractSelectOptions(obj) ?? []
    return { ...obj, options }
  }

  if (type === 'link') {
    const foreignSheetId = typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
      ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
      : ''
    return {
      ...obj,
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId } : {}),
      limitSingleRecord: obj.limitSingleRecord === true,
      ...(typeof obj.refKind === 'string' && obj.refKind.trim().length > 0 ? { refKind: obj.refKind.trim() } : {}),
    }
  }

  if (type === 'lookup') {
    const linkFieldId = typeof (obj.linkFieldId ?? obj.relatedLinkFieldId ?? obj.linkedFieldId ?? obj.sourceFieldId) === 'string'
      ? String(obj.linkFieldId ?? obj.relatedLinkFieldId ?? obj.linkedFieldId ?? obj.sourceFieldId).trim()
      : ''
    const targetFieldId = typeof (obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId) === 'string'
      ? String(obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId).trim()
      : ''
    const foreignSheetId = typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
      ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
      : ''
    return {
      ...obj,
      ...(linkFieldId ? { linkFieldId, relatedLinkFieldId: linkFieldId } : {}),
      ...(targetFieldId ? { targetFieldId, lookUpTargetFieldId: targetFieldId } : {}),
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId, datasheetId: foreignSheetId } : {}),
    }
  }

  if (type === 'rollup') {
    const linkFieldId = typeof (obj.linkFieldId ?? obj.linkedFieldId ?? obj.relatedLinkFieldId ?? obj.sourceFieldId) === 'string'
      ? String(obj.linkFieldId ?? obj.linkedFieldId ?? obj.relatedLinkFieldId ?? obj.sourceFieldId).trim()
      : ''
    const targetFieldId = typeof (obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId) === 'string'
      ? String(obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId).trim()
      : ''
    const foreignSheetId = typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
      ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
      : ''
    const aggregation = parseRollupAggregation(obj.aggregation ?? obj.agg ?? obj.function ?? obj.rollupFunction) ?? 'count'
    return {
      ...obj,
      ...(linkFieldId ? { linkFieldId, linkedFieldId: linkFieldId } : {}),
      ...(targetFieldId ? { targetFieldId } : {}),
      aggregation,
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId, datasheetId: foreignSheetId } : {}),
    }
  }

  if (type === 'formula') {
    return {
      ...obj,
      expression: typeof obj.expression === 'string' ? obj.expression.trim() : '',
    }
  }

  if (type === 'attachment') {
    const maxFiles = typeof obj.maxFiles === 'number' ? obj.maxFiles : Number(obj.maxFiles)
    return {
      ...obj,
      ...(Number.isFinite(maxFiles) && maxFiles > 0 ? { maxFiles: Math.round(maxFiles) } : {}),
      acceptedMimeTypes: sanitizeStringArray(obj.acceptedMimeTypes),
    }
  }

  return obj
}

function serializeFieldRow(row: any): UniverMetaField {
  const rawType = String(row.type ?? 'string')
  const mappedType = mapFieldType(rawType)
  const property = sanitizeFieldProperty(mappedType, row.property)
  const order = Number(row.order ?? 0)
  return {
    id: String(row.id),
    name: String(row.name),
    type: mappedType,
    ...(mappedType === 'select' ? { options: extractSelectOptions(property) } : {}),
    order: Number.isFinite(order) ? order : 0,
    property,
  }
}

type MetaSortRule = { fieldId: string; desc: boolean }

function isNullishSortValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && value.trim() === '') return true
  return false
}

type MetaFilterConjunction = 'and' | 'or'
type MetaFilterCondition = { fieldId: string; operator: string; value?: unknown }

type MetaFilterInfo = {
  conjunction: MetaFilterConjunction
  conditions: MetaFilterCondition[]
}

function parseMetaSortRules(sortInfo: unknown): MetaSortRule[] {
  if (!sortInfo || typeof sortInfo !== 'object') return []
  const rawRules = (sortInfo as { rules?: unknown }).rules
  if (!Array.isArray(rawRules)) return []

  const rules: MetaSortRule[] = []
  for (const raw of rawRules) {
    if (!isPlainObject(raw)) continue
    const fieldId = raw.fieldId
    if (typeof fieldId !== 'string' || fieldId.trim().length === 0) continue
    rules.push({ fieldId: fieldId.trim(), desc: raw.desc === true })
  }
  return rules
}

function compareMetaSortValue(type: UniverMetaField['type'], valueA: unknown, valueB: unknown, desc: boolean): number {
  const effectiveType = type === 'rollup' ? 'number' : type
  const aNull = isNullishSortValue(valueA)
  const bNull = isNullishSortValue(valueB)
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1

  let cmp = 0
  if (effectiveType === 'number' || effectiveType === 'date') {
    const toComparable = effectiveType === 'date' ? toEpoch : toComparableNumber
    const leftValue = toComparable(valueA)
    const rightValue = toComparable(valueB)
    const aOk = leftValue !== null && Number.isFinite(leftValue)
    const bOk = rightValue !== null && Number.isFinite(rightValue)

    if (aOk && bOk) cmp = leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1
    else if (aOk) cmp = -1
    else if (bOk) cmp = 1
    else cmp = 0
  } else if (effectiveType === 'boolean') {
    const toBool = (v: unknown) => {
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase()
        if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
        if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false
        return s.length > 0
      }
      return Boolean(v)
    }
    const a = toBool(valueA)
    const b = toBool(valueB)
    cmp = a === b ? 0 : a ? 1 : -1
  }

  if (cmp === 0 && effectiveType !== 'boolean') {
    cmp = String(valueA).localeCompare(String(valueB), undefined, { numeric: true, sensitivity: 'base' })
  }

  if (cmp === 0) return 0
  return desc ? -cmp : cmp
}

function normalizeFilterScalar(value: unknown): unknown {
  if (Array.isArray(value)) return value[0]
  return value
}

function parseMetaFilterInfo(filterInfo: unknown): MetaFilterInfo | null {
  if (!filterInfo || typeof filterInfo !== 'object') return null
  const obj = filterInfo as { conjunction?: unknown; conditions?: unknown }
  if (!Array.isArray(obj.conditions)) return null

  const conditions: MetaFilterCondition[] = []
  for (const raw of obj.conditions) {
    if (!isPlainObject(raw)) continue
    const fieldId = raw.fieldId
    const operator = raw.operator
    if (typeof fieldId !== 'string' || fieldId.trim().length === 0) continue
    if (typeof operator !== 'string' || operator.trim().length === 0) continue
    conditions.push({
      fieldId: fieldId.trim(),
      operator: operator.trim(),
      ...(Object.prototype.hasOwnProperty.call(raw, 'value') ? { value: (raw as any).value } : {}),
    })
  }
  if (conditions.length === 0) return null

  const conjunctionRaw = typeof obj.conjunction === 'string' ? obj.conjunction.trim().toLowerCase() : 'and'
  const conjunction: MetaFilterConjunction = conjunctionRaw === 'or' ? 'or' : 'and'
  return { conjunction, conditions }
}

function toComparableString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function toComparableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toComparableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === '') return null
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
    if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false
    return true
  }
  return Boolean(value)
}

type RelationalLinkField = { fieldId: string; cfg: LinkFieldConfig }

async function loadLinkValuesByRecord(
  query: QueryFn,
  recordIds: string[],
  relationalLinkFields: RelationalLinkField[],
): Promise<Map<string, Map<string, string[]>>> {
  const linkValuesByRecord = new Map<string, Map<string, string[]>>()
  if (relationalLinkFields.length === 0 || recordIds.length === 0) return linkValuesByRecord

  const fieldIds = relationalLinkFields.map((l) => l.fieldId)
  const linkRes = await query(
    `SELECT field_id, record_id, foreign_record_id
     FROM meta_links
     WHERE field_id = ANY($1::text[]) AND record_id = ANY($2::text[])`,
    [fieldIds, recordIds],
  )

  for (const raw of linkRes.rows as any[]) {
    const recordId = String(raw.record_id)
    const fieldId = String(raw.field_id)
    const foreignId = String(raw.foreign_record_id)
    const recordMap = linkValuesByRecord.get(recordId) ?? new Map<string, string[]>()
    const list = recordMap.get(fieldId) ?? []
    list.push(foreignId)
    recordMap.set(fieldId, list)
    linkValuesByRecord.set(recordId, recordMap)
  }

  return linkValuesByRecord
}

async function applyLookupRollup(
  req: Request,
  query: QueryFn,
  fields: UniverMetaField[],
  rows: UniverMetaRecord[],
  relationalLinkFields: RelationalLinkField[],
  linkValuesByRecord: Map<string, Map<string, string[]>>,
): Promise<void> {
  const lookupFieldIds = fields.filter((f) => f.type === 'lookup').map((f) => f.id)
  const rollupFieldIds = fields.filter((f) => f.type === 'rollup').map((f) => f.id)
  if ((lookupFieldIds.length === 0 && rollupFieldIds.length === 0) || rows.length === 0) return

  const lookupConfigs = new Map<string, LookupFieldConfig | null>()
  for (const f of fields) {
    if (f.type !== 'lookup') continue
    lookupConfigs.set(f.id, parseLookupFieldConfig(f.property))
  }

  const rollupConfigs = new Map<string, RollupFieldConfig | null>()
  for (const f of fields) {
    if (f.type !== 'rollup') continue
    rollupConfigs.set(f.id, parseRollupFieldConfig(f.property))
  }

  const linkConfigById = new Map<string, LinkFieldConfig>()
  for (const { fieldId, cfg } of relationalLinkFields) {
    linkConfigById.set(fieldId, cfg)
  }

  const getLinkIds = (record: UniverMetaRecord, linkFieldId: string) => {
    const recordMap = linkValuesByRecord.get(record.id)
    const cached = recordMap?.get(linkFieldId)
    if (cached) return cached
    return normalizeLinkIds(record.data[linkFieldId])
  }

  const foreignIdsBySheet = new Map<string, Set<string>>()
  const ensureSheetSet = (sheetId: string) => {
    const set = foreignIdsBySheet.get(sheetId) ?? new Set<string>()
    foreignIdsBySheet.set(sheetId, set)
    return set
  }

  for (const row of rows) {
    for (const cfg of lookupConfigs.values()) {
      if (!cfg) continue
      const foreignSheetId = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
      if (!foreignSheetId) continue
      const ids = getLinkIds(row, cfg.linkFieldId)
      if (ids.length === 0) continue
      const set = ensureSheetSet(foreignSheetId)
      for (const id of ids) set.add(id)
    }
    for (const cfg of rollupConfigs.values()) {
      if (!cfg) continue
      const foreignSheetId = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
      if (!foreignSheetId) continue
      const ids = getLinkIds(row, cfg.linkFieldId)
      if (ids.length === 0) continue
      const set = ensureSheetSet(foreignSheetId)
      for (const id of ids) set.add(id)
    }
  }

  const readableForeignSheetIds = await resolveReadableSheetIds(req, query, foreignIdsBySheet.keys())

  const foreignRecordsBySheet = new Map<string, Map<string, Record<string, unknown>>>()
  for (const [foreignSheetId, ids] of foreignIdsBySheet.entries()) {
    if (!readableForeignSheetIds.has(foreignSheetId)) continue
    if (ids.size === 0) continue
    const idList = Array.from(ids)
    const foreignRes = await query(
      'SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
      [foreignSheetId, idList],
    )
    const recordMap = new Map<string, Record<string, unknown>>()
    for (const raw of foreignRes.rows as any[]) {
      recordMap.set(String(raw.id), normalizeJson(raw.data))
    }
    foreignRecordsBySheet.set(foreignSheetId, recordMap)
  }

  const resolveLookupValues = (record: UniverMetaRecord, cfg: LookupFieldConfig): unknown[] => {
    const foreignSheetId = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
    if (!foreignSheetId) return []
    if (!readableForeignSheetIds.has(foreignSheetId)) return []
    const linkIds = getLinkIds(record, cfg.linkFieldId)
    if (linkIds.length === 0) return []
    const foreignMap = foreignRecordsBySheet.get(foreignSheetId)
    if (!foreignMap) return []
    const values: unknown[] = []
    for (const id of linkIds) {
      const data = foreignMap.get(id)
      if (!data) continue
      const value = data[cfg.targetFieldId]
      if (value === null || value === undefined) continue
      values.push(value)
    }
    return values
  }

  const aggregateRollup = (values: unknown[], aggregation: RollupAggregation): number | null => {
    if (aggregation === 'count') return values.length
    const nums = values
      .map((v) => toComparableNumber(v))
      .filter((v): v is number => v !== null && Number.isFinite(v))
    if (nums.length === 0) return null
    if (aggregation === 'sum') return nums.reduce((sum, v) => sum + v, 0)
    if (aggregation === 'avg') return nums.reduce((sum, v) => sum + v, 0) / nums.length
    if (aggregation === 'min') return Math.min(...nums)
    if (aggregation === 'max') return Math.max(...nums)
    return null
  }

  for (const row of rows) {
    for (const [fieldId, cfg] of lookupConfigs.entries()) {
      if (!cfg) {
        row.data[fieldId] = []
        continue
      }
      row.data[fieldId] = resolveLookupValues(row, cfg)
    }

    for (const [fieldId, cfg] of rollupConfigs.entries()) {
      if (!cfg) {
        row.data[fieldId] = null
        continue
      }
      const values = resolveLookupValues(row, cfg)
      row.data[fieldId] = aggregateRollup(values, cfg.aggregation)
    }
  }
}

function extractLookupRollupData(fields: UniverMetaField[], rowData: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.type !== 'lookup' && field.type !== 'rollup') continue
    data[field.id] = rowData[field.id]
  }
  return data
}

type RelatedComputedRecord = {
  sheetId: string
  recordId: string
  data: Record<string, unknown>
}

function mergeComputedRecords(
  base: Array<{ recordId: string; data: Record<string, unknown> }> | undefined,
  extra: Array<{ recordId: string; data: Record<string, unknown> }>,
): Array<{ recordId: string; data: Record<string, unknown> }> | undefined {
  if ((!base || base.length === 0) && extra.length === 0) return undefined
  const merged = new Map<string, { recordId: string; data: Record<string, unknown> }>()
  if (base) {
    for (const record of base) {
      merged.set(record.recordId, record)
    }
  }
  for (const record of extra) {
    const existing = merged.get(record.recordId)
    if (existing) {
      merged.set(record.recordId, {
        recordId: record.recordId,
        data: { ...existing.data, ...record.data },
      })
    } else {
      merged.set(record.recordId, record)
    }
  }
  return Array.from(merged.values())
}

async function computeDependentLookupRollupRecords(
  req: Request,
  query: QueryFn,
  updatedRecordIds: string[],
): Promise<RelatedComputedRecord[]> {
  if (updatedRecordIds.length === 0) return []

  let linkRes: { rows: unknown[] }
  try {
    linkRes = await query(
      'SELECT record_id FROM meta_links WHERE foreign_record_id = ANY($1::text[])',
      [updatedRecordIds],
    )
  } catch (err) {
    if (isUndefinedTableError(err, 'meta_links')) return []
    throw err
  }
  const recordIds = Array.from(new Set((linkRes.rows as any[]).map((row) => String(row.record_id))))
  if (recordIds.length === 0) return []

  const recordRes = await query(
    'SELECT id, sheet_id, data FROM meta_records WHERE id = ANY($1::text[])',
    [recordIds],
  )
  if (recordRes.rows.length === 0) return []

  const rowsBySheet = new Map<string, UniverMetaRecord[]>()
  for (const row of recordRes.rows as any[]) {
    const sheetId = String(row.sheet_id)
    const list = rowsBySheet.get(sheetId) ?? []
    list.push({
      id: String(row.id),
      version: 0,
      data: normalizeJson(row.data),
    })
    rowsBySheet.set(sheetId, list)
  }

  const sheetIds = Array.from(rowsBySheet.keys())
  if (sheetIds.length === 0) return []

  const fieldRes = await query(
    'SELECT id, sheet_id, name, type, property, \"order\" FROM meta_fields WHERE sheet_id = ANY($1::text[]) ORDER BY \"order\" ASC',
    [sheetIds],
  )

  const fieldsBySheet = new Map<string, UniverMetaField[]>()
  for (const row of fieldRes.rows as any[]) {
    const sheetId = String(row.sheet_id)
    const list = fieldsBySheet.get(sheetId) ?? []
    list.push(serializeFieldRow(row))
    fieldsBySheet.set(sheetId, list)
  }

  const results: RelatedComputedRecord[] = []
  const readableSheetIds = await resolveReadableSheetIds(req, query, rowsBySheet.keys())
  for (const [sheetId, rows] of rowsBySheet.entries()) {
    if (!readableSheetIds.has(sheetId)) continue
    const fields = fieldsBySheet.get(sheetId) ?? []
    if (fields.length === 0) continue
    const hasComputed = fields.some((f) => f.type === 'lookup' || f.type === 'rollup')
    if (!hasComputed) continue

    const relationalLinkFields = fields
      .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: parseLinkFieldConfig(f.property) } : null))
      .filter((v): v is { fieldId: string; cfg: LinkFieldConfig } => !!v && !!v.cfg)

    const linkValuesByRecord = await loadLinkValuesByRecord(
      query,
      rows.map((r) => r.id),
      relationalLinkFields,
    )

    await applyLookupRollup(req, query, fields, rows, relationalLinkFields, linkValuesByRecord)

    for (const row of rows) {
      results.push({
        sheetId,
        recordId: row.id,
        data: extractLookupRollupData(fields, row.data),
      })
    }
  }

  return results
}

function evaluateMetaFilterCondition(
  type: UniverMetaField['type'],
  cellValue: unknown,
  condition: MetaFilterCondition,
): boolean {
  const effectiveType = type === 'rollup' ? 'number' : type
  const op = condition.operator.trim()
  const opNorm = op.toLowerCase()
  const value = normalizeFilterScalar(condition.value)

  if (opNorm === 'isempty') return isNullishSortValue(cellValue)
  if (opNorm === 'isnotempty') return !isNullishSortValue(cellValue)

  if (effectiveType === 'number' || effectiveType === 'date') {
    const toComparable = effectiveType === 'date' ? toEpoch : toComparableNumber
    const left = toComparable(cellValue)
    const right = toComparable(value)

    if (opNorm === 'is' || opNorm === 'equal') return left !== null && right !== null && left === right
    if (opNorm === 'isnot' || opNorm === 'notequal') return left === null || right === null ? left !== right : left !== right
    if (opNorm === 'greater' || opNorm === 'isgreater') return left !== null && right !== null && left > right
    if (opNorm === 'greaterequal' || opNorm === 'isgreaterequal') return left !== null && right !== null && left >= right
    if (opNorm === 'less' || opNorm === 'isless') return left !== null && right !== null && left < right
    if (opNorm === 'lessequal' || opNorm === 'islessequal') return left !== null && right !== null && left <= right
    return true
  }

  if (effectiveType === 'boolean') {
    const left = toComparableBoolean(cellValue)
    const right = toComparableBoolean(value)
    if (opNorm === 'is' || opNorm === 'equal') return left !== null && right !== null && left === right
    if (opNorm === 'isnot' || opNorm === 'notequal') return left === null || right === null ? left !== right : left !== right
    return true
  }

  const left = toComparableString(cellValue)
  const right = toComparableString(value)
  const leftNorm = left.trim().toLowerCase()
  const rightNorm = right.trim().toLowerCase()

  if (opNorm === 'is' || opNorm === 'equal') return leftNorm === rightNorm
  if (opNorm === 'isnot' || opNorm === 'notequal') return leftNorm !== rightNorm
  if (opNorm === 'contains') return rightNorm === '' ? true : leftNorm.includes(rightNorm)
  if (opNorm === 'doesnotcontain') return rightNorm === '' ? true : !leftNorm.includes(rightNorm)
  return true
}

function toEpoch(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function getDbNotReadyMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const relationMissing = msg.includes('relation') && msg.includes('does not exist')
  const columnMissing = msg.includes('column') && msg.includes('does not exist')
  if (!relationMissing && !columnMissing) return null

  if (
    msg.includes('meta_bases') ||
    msg.includes('meta_sheets') ||
    msg.includes('meta_fields') ||
    msg.includes('meta_records') ||
    msg.includes('meta_views') ||
    msg.includes('meta_links') ||
    msg.includes('base_id')
  ) {
    return 'Database schema not ready (meta tables missing). Run `pnpm --filter @metasheet/core-backend migrate` and ensure `DATABASE_URL` points to the dev DB.'
  }

  return null
}

function invalidateSheetSummaryCache(sheetId: string): void {
  metaSheetSummaryCache.delete(sheetId)
}

function invalidateFieldCache(sheetId: string): void {
  metaFieldCache.delete(sheetId)
}

function invalidateViewConfigCache(viewId?: string): void {
  if (typeof viewId === 'string' && viewId.trim().length > 0) {
    metaViewConfigCache.delete(viewId.trim())
    return
  }
  metaViewConfigCache.clear()
}

async function loadSheetSummary(
  pool: { query: QueryFn },
  sheetId: string,
): Promise<{ id: string; name: string } | null> {
  const cached = metaSheetSummaryCache.get(sheetId)
  if (cached) return cached

  const result = await pool.query(
    'SELECT id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
    [sheetId],
  )
  if (result.rows.length === 0) return null

  const row: any = result.rows[0]
  const sheet = {
    id: String(row.id),
    name: String(row.name),
  }
  metaSheetSummaryCache.set(sheetId, sheet)
  return sheet
}

async function loadSheetFields(
  pool: { query: QueryFn },
  sheetId: string,
): Promise<UniverMetaField[]> {
  const cached = metaFieldCache.get(sheetId)
  if (cached) return cached

  const fieldRes = await pool.query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC',
    [sheetId],
  )
  const fields = fieldRes.rows.map((f: any) => serializeFieldRow(f))
  metaFieldCache.set(sheetId, fields)
  return fields
}

async function tryResolveView(pool: { query: QueryFn }, viewId: string): Promise<UniverMetaViewConfig | null> {
  const cached = metaViewConfigCache.get(viewId)
  if (cached) return cached

  const result = await pool.query(
    'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1',
    [viewId],
  )
  if (result.rows.length === 0) return null

  const row: any = result.rows[0]
  const view = {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    name: String(row.name),
    type: String(row.type ?? 'grid'),
    filterInfo: normalizeJson(row.filter_info),
    sortInfo: normalizeJson(row.sort_info),
    groupInfo: normalizeJson(row.group_info),
    hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
    config: normalizeJson(row.config),
  }
  metaViewConfigCache.set(viewId, view)
  return view
}

function normalizePermissionCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0)
}

type ResolvedRequestAccess = {
  userId: string
  permissions: string[]
  isAdminRole: boolean
}

type SheetPermissionScope = {
  hasAssignments: boolean
  canRead: boolean
  canWrite: boolean
  canWriteOwn: boolean
  canAdmin: boolean
}

type MultitableSheetPermissionSubjectType = 'user' | 'role'
type MultitableSheetAccessLevel = 'read' | 'write' | 'write-own' | 'admin'

type MultitableSheetPermissionEntry = {
  subjectType: MultitableSheetPermissionSubjectType
  subjectId: string
  accessLevel: MultitableSheetAccessLevel
  permissions: string[]
  label: string
  subtitle: string | null
  isActive: boolean
}

type MultitableSheetPermissionCandidate = {
  subjectType: MultitableSheetPermissionSubjectType
  subjectId: string
  label: string
  subtitle: string | null
  isActive: boolean
  accessLevel: MultitableSheetAccessLevel | null
}

const SHEET_READ_PERMISSION_CODES = new Set([
  'spreadsheet:read',
  'spreadsheet:write',
  'spreadsheet:write-own',
  'spreadsheet:admin',
  'spreadsheets:read',
  'spreadsheets:write',
  'spreadsheets:write-own',
  'spreadsheets:admin',
  'multitable:read',
  'multitable:write',
  'multitable:write-own',
  'multitable:admin',
])

const SHEET_WRITE_PERMISSION_CODES = new Set([
  'spreadsheet:write',
  'spreadsheet:admin',
  'spreadsheets:write',
  'spreadsheets:admin',
  'multitable:write',
  'multitable:admin',
])

const SHEET_OWN_WRITE_PERMISSION_CODES = new Set([
  'spreadsheet:write-own',
  'spreadsheets:write-own',
  'multitable:write-own',
])

const SHEET_ADMIN_PERMISSION_CODES = new Set([
  'spreadsheet:admin',
  'spreadsheets:admin',
  'multitable:admin',
])

const MANAGED_SHEET_PERMISSION_CODES = [
  'spreadsheet:read',
  'spreadsheet:write',
  'spreadsheet:write-own',
  'spreadsheet:admin',
  'spreadsheets:read',
  'spreadsheets:write',
  'spreadsheets:write-own',
  'spreadsheets:admin',
  'multitable:read',
  'multitable:write',
  'multitable:write-own',
  'multitable:admin',
]

const CANONICAL_SHEET_PERMISSION_CODE_BY_ACCESS_LEVEL: Record<MultitableSheetAccessLevel, string> = {
  read: 'spreadsheet:read',
  write: 'spreadsheet:write',
  'write-own': 'spreadsheet:write-own',
  admin: 'spreadsheet:admin',
}

function isSheetPermissionSubjectType(value: unknown): value is MultitableSheetPermissionSubjectType {
  return value === 'user' || value === 'role'
}

async function resolveRequestAccess(req: Request): Promise<ResolvedRequestAccess> {
  const userId = req.user?.id?.toString() ?? req.user?.sub?.toString() ?? req.user?.userId?.toString() ?? ''
  const tokenRoles = normalizePermissionCodes(req.user?.roles)
  const tokenPerms = normalizePermissionCodes(req.user?.perms)
  const resolvedPermissions = normalizePermissionCodes((req.user as { permissions?: unknown } | undefined)?.permissions)
  const role = typeof req.user?.role === 'string' ? req.user.role.trim() : ''
  const isAdminRole = role === 'admin' || tokenRoles.includes('admin')
  const directPermissions = tokenPerms.length > 0 ? tokenPerms : resolvedPermissions
  if (!userId) {
    return { userId, permissions: directPermissions, isAdminRole }
  }

  if (isAdminRole) {
    return { userId, permissions: directPermissions, isAdminRole: true }
  }

  if (directPermissions.length > 0) {
    return { userId, permissions: directPermissions, isAdminRole: false }
  }

  return {
    userId,
    permissions: await listUserPermissions(userId),
    isAdminRole: await isAdmin(userId),
  }
}

function hasPermission(permissions: string[], code: string): boolean {
  if (permissions.includes(code)) return true
  const [resource] = code.split(':')
  return permissions.includes(`${resource}:*`) || permissions.includes('*:*')
}

function deriveCapabilities(permissions: string[], isAdminRole: boolean): MultitableCapabilities {
  const canRead = isAdminRole || hasPermission(permissions, 'multitable:read') || hasPermission(permissions, 'multitable:write')
  const canWrite = isAdminRole || hasPermission(permissions, 'multitable:write')
  const canManageSheetAccess = isAdminRole || hasPermission(permissions, 'multitable:share')
  const canComment = isAdminRole || hasPermission(permissions, 'comments:write') || hasPermission(permissions, 'comments:read')
  const canManageAutomation =
    isAdminRole ||
    hasPermission(permissions, 'workflow:all') ||
    hasPermission(permissions, 'workflow:write') ||
    hasPermission(permissions, 'workflow:create') ||
    hasPermission(permissions, 'workflow:execute')

  return {
    canRead,
    canCreateRecord: canWrite,
    canEditRecord: canWrite,
    canDeleteRecord: canWrite,
    canManageFields: canWrite,
    canManageSheetAccess,
    canManageViews: canWrite,
    canComment,
    canManageAutomation,
    canExport: canRead,
  }
}

function summarizeSheetPermissionCodes(codes: string[]): SheetPermissionScope {
  return {
    hasAssignments: codes.length > 0,
    canRead: codes.some((code) => SHEET_READ_PERMISSION_CODES.has(code)),
    canWrite: codes.some((code) => SHEET_WRITE_PERMISSION_CODES.has(code)),
    canWriteOwn: codes.some((code) => SHEET_OWN_WRITE_PERMISSION_CODES.has(code)),
    canAdmin: codes.some((code) => SHEET_ADMIN_PERMISSION_CODES.has(code)),
  }
}

function deriveSheetAccessLevel(codes: string[]): MultitableSheetAccessLevel | null {
  const normalized = normalizePermissionCodes(codes)
  if (normalized.some((code) => SHEET_ADMIN_PERMISSION_CODES.has(code))) return 'admin'
  if (normalized.some((code) => SHEET_WRITE_PERMISSION_CODES.has(code))) return 'write'
  if (normalized.some((code) => SHEET_OWN_WRITE_PERMISSION_CODES.has(code))) return 'write-own'
  if (normalized.some((code) => SHEET_READ_PERMISSION_CODES.has(code))) return 'read'
  return null
}

async function listSheetPermissionEntries(
  query: QueryFn,
  sheetId: string,
): Promise<MultitableSheetPermissionEntry[]> {
  const result = await query(
    `SELECT
        sp.subject_type,
        sp.subject_id,
        ARRAY_AGG(sp.perm_code ORDER BY sp.perm_code) AS permission_codes,
        u.name AS user_name,
        u.email AS user_email,
        u.is_active AS user_is_active,
        r.name AS role_name
     FROM spreadsheet_permissions sp
     LEFT JOIN users u
       ON sp.subject_type = 'user'
      AND u.id = sp.subject_id
     LEFT JOIN roles r
       ON sp.subject_type = 'role'
      AND r.id = sp.subject_id
     WHERE sp.sheet_id = $1
     GROUP BY sp.subject_type, sp.subject_id, u.name, u.email, u.is_active, r.name
     ORDER BY
       CASE WHEN sp.subject_type = 'user' THEN 0 ELSE 1 END,
       CASE WHEN sp.subject_type = 'user' AND COALESCE(u.is_active, true) THEN 0 WHEN sp.subject_type = 'user' THEN 1 ELSE 0 END,
       COALESCE(NULLIF(u.name, ''), NULLIF(u.email, ''), NULLIF(r.name, ''), sp.subject_id) ASC`,
    [sheetId],
  )

  return (result.rows as Array<{
    subject_type: string
    subject_id: string
    permission_codes?: string[]
    user_name?: string | null
    user_email?: string | null
    user_is_active?: boolean | null
    role_name?: string | null
  }>)
    .map((row) => {
      const subjectType = isSheetPermissionSubjectType(row.subject_type) ? row.subject_type : 'user'
      const subjectId = String(row.subject_id)
      const permissions = normalizePermissionCodes(row.permission_codes)
      const accessLevel = deriveSheetAccessLevel(permissions)
      if (!accessLevel) return null
      const userName = typeof row.user_name === 'string' ? row.user_name.trim() : ''
      const userEmail = typeof row.user_email === 'string' ? row.user_email.trim() : ''
      const roleName = typeof row.role_name === 'string' ? row.role_name.trim() : ''
      return {
        subjectType,
        subjectId,
        accessLevel,
        permissions,
        label: subjectType === 'user'
          ? userName || userEmail || subjectId
          : roleName || subjectId,
        subtitle: subjectType === 'user'
          ? (userEmail || (userName && userName !== subjectId ? subjectId : null))
          : (roleName && roleName !== subjectId ? subjectId : 'Role'),
        isActive: subjectType === 'user' ? row.user_is_active !== false : true,
      } satisfies MultitableSheetPermissionEntry
    })
    .filter((entry): entry is MultitableSheetPermissionEntry => !!entry)
}

async function listSheetPermissionCandidates(
  query: QueryFn,
  sheetId: string,
  params: { q?: string; limit: number },
): Promise<MultitableSheetPermissionCandidate[]> {
  const q = params.q?.trim() ?? ''
  const term = q ? `%${q}%` : '%'
  const result = await query(
    `WITH user_candidates AS (
        SELECT
          'user'::text AS subject_type,
          u.id AS subject_id,
          u.name AS user_name,
          u.email AS user_email,
          u.is_active AS user_is_active,
          NULL::text AS role_name,
          COALESCE(
            ARRAY_AGG(sp.perm_code ORDER BY sp.perm_code) FILTER (WHERE sp.perm_code IS NOT NULL),
            ARRAY[]::text[]
          ) AS permission_codes
        FROM users u
        LEFT JOIN spreadsheet_permissions sp
          ON sp.sheet_id = $1
         AND sp.subject_type = 'user'
         AND sp.subject_id = u.id
        WHERE ($2 = '' OR u.id ILIKE $3 OR u.email ILIKE $3 OR COALESCE(u.name, '') ILIKE $3)
        GROUP BY u.id, u.name, u.email, u.is_active
      ),
      role_candidates AS (
        SELECT
          'role'::text AS subject_type,
          r.id AS subject_id,
          NULL::text AS user_name,
          NULL::text AS user_email,
          true AS user_is_active,
          r.name AS role_name,
          COALESCE(
            ARRAY_AGG(sp.perm_code ORDER BY sp.perm_code) FILTER (WHERE sp.perm_code IS NOT NULL),
            ARRAY[]::text[]
          ) AS permission_codes
        FROM roles r
        LEFT JOIN spreadsheet_permissions sp
          ON sp.sheet_id = $1
         AND sp.subject_type = 'role'
         AND sp.subject_id = r.id
        WHERE ($2 = '' OR r.id ILIKE $3 OR COALESCE(r.name, '') ILIKE $3)
        GROUP BY r.id, r.name
      )
      SELECT *
      FROM (
        SELECT * FROM user_candidates
        UNION ALL
        SELECT * FROM role_candidates
      ) candidates
      ORDER BY
        CASE WHEN subject_type = 'user' THEN 0 ELSE 1 END,
        CASE WHEN user_is_active THEN 0 ELSE 1 END,
        COALESCE(NULLIF(user_name, ''), NULLIF(user_email, ''), NULLIF(role_name, ''), subject_id) ASC
      LIMIT $4`,
    [sheetId, q, term, params.limit],
  )

  const candidates = (result.rows as Array<{
    subject_type: string
    subject_id: string
    user_name?: string | null
    user_email?: string | null
    user_is_active?: boolean | null
    role_name?: string | null
    permission_codes?: string[]
  }>)
    .map((row) => {
      const subjectType = isSheetPermissionSubjectType(row.subject_type) ? row.subject_type : 'user'
      const subjectId = String(row.subject_id)
      const name = typeof row.user_name === 'string' ? row.user_name.trim() : ''
      const email = typeof row.user_email === 'string' ? row.user_email.trim() : ''
      const roleName = typeof row.role_name === 'string' ? row.role_name.trim() : ''
      return {
        subjectType,
        subjectId,
        label: subjectType === 'user'
          ? (name || email || subjectId)
          : (roleName || subjectId),
        subtitle: subjectType === 'user'
          ? (email || (name && name !== subjectId ? subjectId : null))
          : (roleName && roleName !== subjectId ? subjectId : 'Role'),
        isActive: subjectType === 'user' ? row.user_is_active !== false : true,
        accessLevel: deriveSheetAccessLevel(normalizePermissionCodes(row.permission_codes)),
      } satisfies MultitableSheetPermissionCandidate
    })

  const eligibility = await Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.subjectType === 'role') {
        if (candidate.subjectId === 'admin') return true
        const result = await query(
          'SELECT permission_code FROM role_permissions WHERE role_id = $1',
          [candidate.subjectId],
        )
        const permissions = normalizePermissionCodes(
          (result.rows as Array<{ permission_code?: string | null }>).map((row) => row.permission_code ?? ''),
        )
        return hasPermission(permissions, 'multitable:read') || hasPermission(permissions, 'multitable:write')
      }

      const [permissions, admin] = await Promise.all([
        listUserPermissions(candidate.subjectId),
        isAdmin(candidate.subjectId),
      ])
      return admin || hasPermission(permissions, 'multitable:read') || hasPermission(permissions, 'multitable:write')
    }),
  )

  return candidates.filter((_candidate, index) => eligibility[index])
}

async function loadSheetPermissionScopeMap(
  query: QueryFn,
  sheetIds: string[],
  userId: string,
): Promise<Map<string, SheetPermissionScope>> {
  if (!userId || sheetIds.length === 0) return new Map()
  try {
    const result = await query(
      `SELECT sp.sheet_id, sp.perm_code, sp.subject_type
       FROM spreadsheet_permissions sp
       WHERE sp.sheet_id = ANY($2::text[])
         AND (
           (sp.subject_type = 'user' AND sp.subject_id = $1)
           OR (
             sp.subject_type = 'role'
             AND EXISTS (
               SELECT 1
               FROM user_roles ur
               WHERE ur.user_id = $1
                 AND ur.role_id = sp.subject_id
             )
           )
         )`,
      [userId, sheetIds],
    )
    const grouped = new Map<string, { direct: string[]; role: string[] }>()
    for (const row of result.rows as Array<{ sheet_id: string; perm_code: string; subject_type?: string }>) {
      const sheetId = typeof row.sheet_id === 'string' ? row.sheet_id : ''
      const code = typeof row.perm_code === 'string' ? row.perm_code.trim() : ''
      if (!sheetId || !code) continue
      const current = grouped.get(sheetId) ?? { direct: [], role: [] }
      if (row.subject_type === 'user') current.direct.push(code)
      else current.role.push(code)
      grouped.set(sheetId, current)
    }
    return new Map(
      Array.from(grouped.entries()).map(([sheetId, codes]) => [
        sheetId,
        summarizeSheetPermissionCodes(codes.direct.length > 0 ? codes.direct : codes.role),
      ]),
    )
  } catch (err) {
    if (isUndefinedTableError(err, 'spreadsheet_permissions') || isUndefinedTableError(err, 'user_roles')) return new Map()
    throw err
  }
}

async function loadViewPermissionScopeMap(
  query: QueryFn,
  viewIds: string[],
  userId: string,
): Promise<Map<string, ViewPermissionScope>> {
  if (!userId || viewIds.length === 0) return new Map()
  try {
    const result = await query(
      `WITH assigned_views AS (
         SELECT DISTINCT vp.view_id
         FROM meta_view_permissions vp
         WHERE vp.view_id = ANY($2::text[])
       ),
       effective_permissions AS (
         SELECT vp.view_id, vp.permission
         FROM meta_view_permissions vp
         WHERE vp.view_id = ANY($2::text[])
           AND (
             (vp.subject_type = 'user' AND vp.subject_id = $1)
             OR (
               vp.subject_type = 'role'
               AND EXISTS (
                 SELECT 1 FROM user_roles ur
                 WHERE ur.user_id = $1 AND ur.role_id = vp.subject_id
               )
             )
           )
       )
       SELECT av.view_id,
              COALESCE(
                array_agg(DISTINCT ep.permission) FILTER (WHERE ep.permission IS NOT NULL),
                ARRAY[]::text[]
              ) AS permissions
       FROM assigned_views av
       LEFT JOIN effective_permissions ep ON ep.view_id = av.view_id
       GROUP BY av.view_id`,
      [userId, viewIds],
    )
    return new Map(
      (result.rows as Array<{ view_id: string; permissions: string[] | null }>).flatMap((row) => {
        const viewId = typeof row.view_id === 'string' ? row.view_id : ''
        if (!viewId) return []
        const perms = Array.isArray(row.permissions)
          ? row.permissions.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean)
          : []
        return [[
          viewId,
          {
            hasAssignments: true,
            canRead: perms.includes('read') || perms.includes('write') || perms.includes('admin'),
            canWrite: perms.includes('write') || perms.includes('admin'),
            canAdmin: perms.includes('admin'),
          },
        ] as const]
      }),
    )
  } catch (err) {
    if (isUndefinedTableError(err, 'meta_view_permissions') || isUndefinedTableError(err, 'user_roles')) return new Map()
    throw err
  }
}

async function loadFieldPermissionScopeMap(
  query: QueryFn,
  sheetId: string,
  userId: string,
): Promise<Map<string, FieldPermissionScope>> {
  if (!userId || !sheetId) return new Map()
  try {
    const result = await query(
      `SELECT fp.field_id, fp.visible, fp.read_only
       FROM field_permissions fp
       WHERE fp.sheet_id = $2
         AND (
           (fp.subject_type = 'user' AND fp.subject_id = $1)
           OR (
             fp.subject_type = 'role'
             AND EXISTS (
               SELECT 1 FROM user_roles ur
               WHERE ur.user_id = $1 AND ur.role_id = fp.subject_id
             )
           )
         )`,
      [userId, sheetId],
    )
    const scopes = new Map<string, FieldPermissionScope>()
    for (const row of result.rows as Array<{ field_id: string; visible: boolean; read_only: boolean }>) {
      const fieldId = typeof row.field_id === 'string' ? row.field_id : ''
      if (!fieldId) continue
      const existing = scopes.get(fieldId)
      if (existing) {
        // Most restrictive wins: AND for visible, OR for readOnly
        existing.visible = existing.visible && row.visible !== false
        existing.readOnly = existing.readOnly || row.read_only === true
      } else {
        scopes.set(fieldId, {
          visible: row.visible !== false,
          readOnly: row.read_only === true,
        })
      }
    }
    return scopes
  } catch (err) {
    if (isUndefinedTableError(err, 'field_permissions') || isUndefinedTableError(err, 'user_roles')) return new Map()
    throw err
  }
}

function applySheetPermissionScope(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  if (isAdminRole) return capabilities
  if (!scope?.hasAssignments) {
    return {
      ...capabilities,
      canManageSheetAccess: capabilities.canManageSheetAccess && capabilities.canRead,
      canExport: capabilities.canExport ?? capabilities.canRead,
    }
  }
  const canWriteAnyRecord = scope.canWrite || scope.canWriteOwn
  const scopedCanRead = capabilities.canRead && scope.canRead
  return {
    canRead: scopedCanRead,
    canCreateRecord: capabilities.canCreateRecord && canWriteAnyRecord,
    canEditRecord: capabilities.canEditRecord && canWriteAnyRecord,
    canDeleteRecord: capabilities.canDeleteRecord && canWriteAnyRecord,
    canManageFields: capabilities.canManageFields && scope.canWrite,
    canManageSheetAccess: scope.canAdmin,
    canManageViews: capabilities.canManageViews && scope.canWrite,
    canComment: capabilities.canComment && scope.canRead,
    canManageAutomation: capabilities.canManageAutomation && scope.canWrite,
    canExport: scopedCanRead,
  }
}

function canReadWithSheetGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): boolean {
  if (applySheetPermissionScope(capabilities, scope, isAdminRole).canRead) return true
  return !isAdminRole && !capabilities.canRead && scope?.canRead === true
}

function applyContextSheetReadGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  const scoped = applySheetPermissionScope(capabilities, scope, isAdminRole)
  if (scoped.canRead || !scope?.canRead || isAdminRole || capabilities.canRead) return scoped
  return {
    ...scoped,
    canRead: true,
  }
}

function applyContextSheetRecordWriteGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  const scoped = applyContextSheetReadGrant(capabilities, scope, isAdminRole)
  if (isAdminRole || !scope?.hasAssignments) return scoped
  const canWriteAnyRecord = scope.canRead && (scope.canWrite || scope.canWriteOwn)
  if (!canWriteAnyRecord) return scoped
  return {
    ...scoped,
    canCreateRecord: true,
    canEditRecord: true,
    canDeleteRecord: true,
  }
}

function applyContextSheetSchemaWriteGrant(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilities {
  const scoped = applyContextSheetRecordWriteGrant(capabilities, scope, isAdminRole)
  if (isAdminRole || !scope?.hasAssignments) return scoped
  const canManageSchema = scope.canRead && scope.canWrite
  if (!canManageSchema) return scoped
  return {
    ...scoped,
    canManageFields: true,
    canManageViews: true,
    ...(scope.canAdmin ? { canManageSheetAccess: true } : {}),
  }
}

const MULTITABLE_CAPABILITY_KEYS: Array<keyof MultitableCapabilities> = [
  'canRead',
  'canCreateRecord',
  'canEditRecord',
  'canDeleteRecord',
  'canManageFields',
  'canManageSheetAccess',
  'canManageViews',
  'canComment',
  'canManageAutomation',
]

function deriveCapabilityOrigin(
  baseCapabilities: MultitableCapabilities,
  effectiveCapabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableCapabilityOrigin {
  const hasSheetAssignments = !!scope?.hasAssignments
  if (isAdminRole) {
    return { source: 'admin', hasSheetAssignments }
  }
  if (!hasSheetAssignments) {
    return { source: 'global-rbac', hasSheetAssignments: false }
  }
  const expandsBaseCapabilities = MULTITABLE_CAPABILITY_KEYS.some(
    (key) => !baseCapabilities[key] && effectiveCapabilities[key],
  )
  return {
    source: expandsBaseCapabilities ? 'sheet-grant' : 'sheet-scope',
    hasSheetAssignments: true,
  }
}

async function filterReadableSheetRowsForAccess<T extends { id: string }>(
  query: QueryFn,
  sheetRows: T[],
  access: ResolvedRequestAccess,
  baseCapabilities?: MultitableCapabilities,
): Promise<T[]> {
  if (sheetRows.length === 0 || access.isAdminRole) return sheetRows
  const effectiveCapabilities = baseCapabilities ?? deriveCapabilities(access.permissions, access.isAdminRole)
  const scopeMap = await loadSheetPermissionScopeMap(
    query,
    sheetRows.map((row) => String(row.id)),
    access.userId,
  )
  return sheetRows.filter((row) =>
    canReadWithSheetGrant(
      effectiveCapabilities,
      scopeMap.get(String(row.id)),
      access.isAdminRole,
    ),
  )
}

async function resolveSheetCapabilities(
  req: Request,
  query: QueryFn,
  sheetId: string,
): Promise<{
  access: ResolvedRequestAccess
  capabilities: MultitableCapabilities
  capabilityOrigin: MultitableCapabilityOrigin
  sheetScope?: SheetPermissionScope
}> {
  const access = await resolveRequestAccess(req)
  const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)
  const scopeMap = await loadSheetPermissionScopeMap(query, [sheetId], access.userId)
  const sheetScope = scopeMap.get(sheetId)
  const capabilities = applyContextSheetSchemaWriteGrant(baseCapabilities, sheetScope, access.isAdminRole)
  return {
    access,
    capabilities,
    capabilityOrigin: deriveCapabilityOrigin(baseCapabilities, capabilities, sheetScope, access.isAdminRole),
    ...(sheetScope ? { sheetScope } : {}),
  }
}

async function resolveSheetReadableCapabilities(
  req: Request,
  query: QueryFn,
  sheetId: string,
): Promise<{
  access: ResolvedRequestAccess
  capabilities: MultitableCapabilities
  capabilityOrigin: MultitableCapabilityOrigin
  sheetScope?: SheetPermissionScope
}> {
  const access = await resolveRequestAccess(req)
  const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)
  const scopeMap = await loadSheetPermissionScopeMap(query, [sheetId], access.userId)
  const sheetScope = scopeMap.get(sheetId)
  const capabilities = applyContextSheetSchemaWriteGrant(baseCapabilities, sheetScope, access.isAdminRole)
  return {
    access,
    capabilities,
    capabilityOrigin: deriveCapabilityOrigin(baseCapabilities, capabilities, sheetScope, access.isAdminRole),
    ...(sheetScope ? { sheetScope } : {}),
  }
}

async function resolveReadableSheetIds(
  req: Request,
  query: QueryFn,
  sheetIds: Iterable<string>,
): Promise<Set<string>> {
  const uniqueSheetIds = Array.from(new Set(Array.from(sheetIds).filter((sheetId) => sheetId.trim().length > 0)))
  if (uniqueSheetIds.length === 0) return new Set()

  const access = await resolveRequestAccess(req)
  if (access.isAdminRole) {
    return new Set(uniqueSheetIds)
  }

  const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)
  const scopeMap = await loadSheetPermissionScopeMap(query, uniqueSheetIds, access.userId)
  const readableSheetIds = new Set<string>()
  for (const sheetId of uniqueSheetIds) {
    if (canReadWithSheetGrant(baseCapabilities, scopeMap.get(sheetId), access.isAdminRole)) {
      readableSheetIds.add(sheetId)
    }
  }
  return readableSheetIds
}

function sendForbidden(res: Response, message = 'Insufficient permissions') {
  return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message } })
}

function deriveRowActions(capabilities: MultitableCapabilities): MultitableRowActions {
  return {
    canEdit: capabilities.canEditRecord,
    canDelete: capabilities.canDeleteRecord,
    canComment: capabilities.canComment,
  }
}

function requiresOwnWriteRowPolicy(
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): boolean {
  return !isAdminRole && !!scope?.hasAssignments && scope.canWriteOwn && !scope.canWrite
}

function deriveDefaultRowActions(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  isAdminRole: boolean,
): MultitableRowActions {
  if (!requiresOwnWriteRowPolicy(scope, isAdminRole)) {
    return deriveRowActions(capabilities)
  }
  return {
    canEdit: false,
    canDelete: false,
    canComment: capabilities.canComment,
  }
}

function deriveRecordRowActions(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  access: ResolvedRequestAccess,
  createdBy: string | null | undefined,
): MultitableRowActions {
  if (!requiresOwnWriteRowPolicy(scope, access.isAdminRole)) {
    return deriveRowActions(capabilities)
  }

  const isCreator = !!createdBy && !!access.userId && createdBy === access.userId
  return {
    canEdit: capabilities.canEditRecord && isCreator,
    canDelete: capabilities.canDeleteRecord && isCreator,
    canComment: capabilities.canComment,
  }
}

async function loadRecordCreatorMap(
  query: QueryFn,
  sheetId: string,
  recordIds: string[],
): Promise<Map<string, string | null>> {
  if (recordIds.length === 0) return new Map()
  try {
    const result = await query(
      'SELECT id, created_by FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
      [sheetId, recordIds],
    )
    return new Map(
      (result.rows as Array<{ id: string; created_by: string | null }>).map((row) => [
        String(row.id),
        typeof row.created_by === 'string' ? row.created_by : null,
      ]),
    )
  } catch (err) {
    if (err instanceof Error && err.message.includes('column') && err.message.includes('created_by')) {
      return new Map()
    }
    throw err
  }
}

function buildRowActionOverrides(
  records: Array<Pick<UniverMetaRecord, 'id'>>,
  creatorMap: Map<string, string | null>,
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  access: ResolvedRequestAccess,
): Record<string, MultitableRowActions> | undefined {
  if (!requiresOwnWriteRowPolicy(scope, access.isAdminRole)) return undefined
  const overrides: Record<string, MultitableRowActions> = {}
  for (const record of records) {
    const rowActions = deriveRecordRowActions(capabilities, scope, access, creatorMap.get(record.id))
    if (rowActions.canEdit || rowActions.canDelete || rowActions.canComment !== capabilities.canComment) {
      overrides[record.id] = rowActions
    }
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

function ensureRecordWriteAllowed(
  capabilities: MultitableCapabilities,
  scope: SheetPermissionScope | undefined,
  access: ResolvedRequestAccess,
  createdBy: string | null | undefined,
  action: 'edit' | 'delete',
): boolean {
  const rowActions = deriveRecordRowActions(capabilities, scope, access, createdBy)
  return action === 'edit' ? rowActions.canEdit : rowActions.canDelete
}

type FieldMutationGuard = {
  type: UniverMetaField['type']
  options?: string[]
  readOnly: boolean
  hidden: boolean
  link?: LinkFieldConfig | null
}

function buildFieldMutationGuardMap(fields: UniverMetaField[]): Map<string, FieldMutationGuard> {
  return new Map(
    fields.map((field) => {
      const property = normalizeJson(field.property)
      const base: FieldMutationGuard = {
        type: field.type,
        readOnly: isFieldAlwaysReadOnly(field),
        hidden: isFieldPermissionHidden(field),
      }
      if (field.type === 'select') {
        return [field.id, { ...base, options: field.options?.map((option) => option.value) ?? [] }] as const
      }
      if (field.type === 'link') {
        return [field.id, { ...base, link: parseLinkFieldConfig(property) }] as const
      }
      return [field.id, base] as const
    }),
  )
}

function filterVisiblePropertyFields(fields: UniverMetaField[]): UniverMetaField[] {
  return fields.filter((field) => !isFieldPermissionHidden(field))
}

function filterRecordDataByFieldIds(data: unknown, allowedFieldIds: Set<string>): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(([fieldId]) => allowedFieldIds.has(fieldId)),
  )
}

function filterRecordFieldSummaryMap<T>(
  summaryMap: Record<string, Record<string, T>> | undefined,
  allowedFieldIds: Set<string>,
): Record<string, Record<string, T>> | undefined {
  if (!summaryMap) return undefined
  return Object.fromEntries(
    Object.entries(summaryMap).map(([recordId, fieldSummaries]) => [
      recordId,
      Object.fromEntries(
        Object.entries(fieldSummaries).filter(([fieldId]) => allowedFieldIds.has(fieldId)),
      ),
    ]),
  )
}

function filterSingleRecordFieldSummaryMap<T>(
  summaryMap: Record<string, T> | undefined,
  allowedFieldIds: Set<string>,
): Record<string, T> | undefined {
  if (!summaryMap) return undefined
  return Object.fromEntries(
    Object.entries(summaryMap).filter(([fieldId]) => allowedFieldIds.has(fieldId)),
  )
}

function toSummaryDisplay(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

function getAttachmentStorageService(): StorageServiceImpl {
  if (!multitableAttachmentStorage) {
    const baseUrl = process.env.ATTACHMENT_STORAGE_BASE_URL || 'http://localhost:8900/files'
    multitableAttachmentStorage = StorageServiceImpl.createLocalService(ATTACHMENT_PATH, baseUrl)
  }
  return multitableAttachmentStorage
}

function buildAttachmentUrl(req: Request, attachmentId: string, thumbnail: boolean = false): string {
  const protocol = req.protocol || 'http'
  const host = req.get('host') || 'localhost:8900'
  const query = thumbnail ? '?thumbnail=true' : ''
  return `${protocol}://${host}/api/multitable/attachments/${encodeURIComponent(attachmentId)}${query}`
}

function getRequestActorId(req: Request): string | null {
  const actorId = req.user?.id
  return typeof actorId === 'string' && actorId.trim().length > 0 ? actorId.trim() : null
}

function publishMultitableSheetRealtime(payload: MultitableSheetRealtimePayload): void {
  if (!payload.spreadsheetId) return
  // Invalidate cursor-paginated record cache on any record mutation
  invalidateRecordsCacheForSheet(payload.spreadsheetId)
  try {
    eventBus.publish('spreadsheet.cell.updated', payload)
  } catch (err) {
    console.warn('[univer-meta] failed to publish multitable sheet realtime update', err)
  }
}

function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/')
}

function serializeAttachmentRow(req: Request, row: any): MultitableAttachment {
  const id = String(row.id)
  const mimeType = typeof row.mime_type === 'string' ? row.mime_type : 'application/octet-stream'
  return {
    id,
    filename: typeof row.filename === 'string' ? row.filename : typeof row.original_name === 'string' ? row.original_name : id,
    mimeType,
    size: Number(row.size ?? 0),
    url: buildAttachmentUrl(req, id),
    thumbnailUrl: isImageMimeType(mimeType) ? buildAttachmentUrl(req, id, true) : null,
    uploadedAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : typeof row.created_at === 'string'
        ? row.created_at
        : null,
  }
}

function serializeBaseRow(row: any): UniverMetaBase {
  return {
    id: String(row.id),
    name: String(row.name),
    icon: typeof row.icon === 'string' ? row.icon : null,
    color: typeof row.color === 'string' ? row.color : null,
    ownerId: typeof row.owner_id === 'string' ? row.owner_id : null,
    workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : null,
  }
}

async function ensureLegacyBase(query: QueryFn): Promise<string> {
  await query(
    `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_BASE_ID, DEFAULT_BASE_NAME, 'table', '#1677ff', null, null],
  )
  return DEFAULT_BASE_ID
}

async function ensurePeopleSheetPreset(query: QueryFn, baseId: string): Promise<PeopleSheetPreset> {
  const existingSheets = await query(
    `SELECT id, base_id, name, description
     FROM meta_sheets
     WHERE base_id = $1 AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [baseId],
  )

  let peopleSheetRow = (existingSheets.rows as any[]).find((row) => isSystemPeopleSheetDescription(row.description)) ?? null
  let peopleSheetId = typeof peopleSheetRow?.id === 'string' ? String(peopleSheetRow.id) : buildId('sheet').slice(0, 50)

  if (!peopleSheetRow) {
    await query(
      `INSERT INTO meta_sheets (id, base_id, name, description)
       VALUES ($1, $2, $3, $4)`,
      [peopleSheetId, baseId, SYSTEM_PEOPLE_SHEET_NAME, SYSTEM_PEOPLE_SHEET_DESCRIPTION],
    )
    peopleSheetRow = {
      id: peopleSheetId,
      base_id: baseId,
      name: SYSTEM_PEOPLE_SHEET_NAME,
      description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
    }
  }

  const fieldRows = await query(
    'SELECT id, name, type, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [peopleSheetId],
  )
  const fieldIdByName = new Map<string, string>()
  for (const row of fieldRows.rows as any[]) {
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const id = typeof row.id === 'string' ? row.id : ''
    if (name && id && !fieldIdByName.has(name)) fieldIdByName.set(name, id)
  }

  const ensureField = async (name: string, order: number): Promise<string> => {
    const existingId = fieldIdByName.get(name)
    if (existingId) return existingId
    const id = buildId('fld').slice(0, 50)
    await query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, $3, 'string', '{}'::jsonb, $4)`,
      [id, peopleSheetId, name, order],
    )
    fieldIdByName.set(name, id)
    return id
  }

  const userIdFieldId = await ensureField('User ID', 0)
  const nameFieldId = await ensureField('Name', 1)
  const emailFieldId = await ensureField('Email', 2)
  const avatarFieldId = await ensureField('Avatar URL', 3)

  let userRows: Array<{ id: string; email: string; name: string | null; avatar_url: string | null }> = []
  try {
    const result = await query(
      `SELECT id, email, name, avatar_url
       FROM users
       WHERE is_active = TRUE
       ORDER BY created_at ASC, id ASC`,
    )
    userRows = (result.rows as any[]).map((row) => ({
      id: String(row.id),
      email: String(row.email),
      name: typeof row.name === 'string' ? row.name : null,
      avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    }))
  } catch (err: any) {
    if (!(typeof err?.code === 'string' && err.code === '42P01')) {
      throw err
    }
  }

  if (userRows.length > 0) {
    const existingRecords = await query(
      'SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
      [peopleSheetId],
    )
    const recordByUserId = new Map<string, { id: string; data: Record<string, unknown> }>()
    for (const row of existingRecords.rows as any[]) {
      const data = normalizeJson(row.data)
      const userId = typeof data[userIdFieldId] === 'string' ? String(data[userIdFieldId]) : ''
      if (userId) {
        recordByUserId.set(userId, { id: String(row.id), data })
      }
    }

    for (const user of userRows) {
      const nextData = {
        [userIdFieldId]: user.id,
        [nameFieldId]: user.name?.trim() || user.email,
        [emailFieldId]: user.email,
        [avatarFieldId]: user.avatar_url ?? '',
      }
      const existing = recordByUserId.get(user.id)
      if (!existing) {
        await query(
          `INSERT INTO meta_records (id, sheet_id, data, version)
           VALUES ($1, $2, $3::jsonb, 1)`,
          [buildId('rec').slice(0, 50), peopleSheetId, JSON.stringify(nextData)],
        )
        continue
      }

      const changed =
        existing.data[userIdFieldId] !== nextData[userIdFieldId] ||
        existing.data[nameFieldId] !== nextData[nameFieldId] ||
        existing.data[emailFieldId] !== nextData[emailFieldId] ||
        existing.data[avatarFieldId] !== nextData[avatarFieldId]

      if (changed) {
        await query(
          `UPDATE meta_records
           SET data = $1::jsonb, version = version + 1, updated_at = now()
           WHERE id = $2`,
          [JSON.stringify(nextData), existing.id],
        )
      }
    }
  }

  return {
    sheet: {
      id: peopleSheetId,
      baseId,
      name: SYSTEM_PEOPLE_SHEET_NAME,
      description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
    },
    fieldProperty: {
      foreignSheetId: peopleSheetId,
      limitSingleRecord: true,
      refKind: 'user',
    },
  }
}

async function loadSheetRow(
  query: QueryFn,
  sheetId: string,
): Promise<{ id: string; baseId: string | null; name: string; description: string | null } | null> {
  const result = await query(
    'SELECT id, base_id, name, description FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
    [sheetId],
  )
  const row: any = result.rows[0]
  if (!row) return null
  return {
    id: String(row.id),
    baseId: typeof row.base_id === 'string' ? row.base_id : null,
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
  }
}

async function loadFieldsForSheet(query: QueryFn, sheetId: string): Promise<UniverMetaField[]> {
  const result = await query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [sheetId],
  )
  return result.rows.map((row: any) => serializeFieldRow(row))
}

async function ensureAttachmentIdsExist(
  query: QueryFn,
  sheetId: string,
  fieldId: string,
  attachmentIds: string[],
): Promise<string | null> {
  if (attachmentIds.length === 0) return null

  const result = await query(
    `SELECT id, field_id
     FROM multitable_attachments
     WHERE sheet_id = $1
       AND deleted_at IS NULL
       AND id = ANY($2::text[])`,
    [sheetId, attachmentIds],
  )
  const rows = result.rows as Array<{ id: string; field_id: string | null }>
  const found = new Set(rows.map((row) => String(row.id)))
  const missing = attachmentIds.filter((id) => !found.has(id))
  if (missing.length > 0) {
    return `Attachment(s) not found: ${missing.join(', ')}`
  }
  const mismatchedField = rows.find((row) => row.field_id && String(row.field_id) !== fieldId)
  if (mismatchedField) {
    return `Attachment belongs to a different field: ${mismatchedField.id}`
  }
  return null
}

async function buildLinkSummaries(
  req: Request,
  query: QueryFn,
  rows: UniverMetaRecord[],
  relationalLinkFields: RelationalLinkField[],
  linkValuesByRecord: Map<string, Map<string, string[]>>,
): Promise<Map<string, Map<string, LinkedRecordSummary[]>>> {
  const result = new Map<string, Map<string, LinkedRecordSummary[]>>()
  if (rows.length === 0 || relationalLinkFields.length === 0) return result

  const idsBySheet = new Map<string, Set<string>>()
  for (const { cfg } of relationalLinkFields) {
    idsBySheet.set(cfg.foreignSheetId, idsBySheet.get(cfg.foreignSheetId) ?? new Set<string>())
  }

  for (const row of rows) {
    const recordLinks = linkValuesByRecord.get(row.id)
    if (!recordLinks) continue
    for (const { fieldId, cfg } of relationalLinkFields) {
      const ids = recordLinks.get(fieldId) ?? []
      const set = idsBySheet.get(cfg.foreignSheetId) ?? new Set<string>()
      for (const id of ids) set.add(id)
      idsBySheet.set(cfg.foreignSheetId, set)
    }
  }

  const readableSheetIds = await resolveReadableSheetIds(req, query, idsBySheet.keys())

  const displayFieldBySheet = new Map<string, string | null>()
  for (const [sheetId] of idsBySheet.entries()) {
    if (!readableSheetIds.has(sheetId)) continue
    const fields = await loadFieldsForSheet(query, sheetId)
    const stringField = fields.find((field) => field.type === 'string')
    displayFieldBySheet.set(sheetId, stringField?.id ?? fields[0]?.id ?? null)
  }

  const foreignRecordsBySheet = new Map<string, Map<string, Record<string, unknown>>>()
  for (const [sheetId, ids] of idsBySheet.entries()) {
    if (!readableSheetIds.has(sheetId)) continue
    const idList = Array.from(ids)
    if (idList.length === 0) continue
    const recordRes = await query(
      'SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
      [sheetId, idList],
    )
    const recordMap = new Map<string, Record<string, unknown>>()
    for (const row of recordRes.rows as any[]) {
      recordMap.set(String(row.id), normalizeJson(row.data))
    }
    foreignRecordsBySheet.set(sheetId, recordMap)
  }

  for (const row of rows) {
    const byField = new Map<string, LinkedRecordSummary[]>()
    const recordLinks = linkValuesByRecord.get(row.id) ?? new Map<string, string[]>()
    for (const { fieldId, cfg } of relationalLinkFields) {
      const ids = recordLinks.get(fieldId) ?? []
      if (!readableSheetIds.has(cfg.foreignSheetId)) {
        byField.set(fieldId, [])
        continue
      }
      const foreignMap = foreignRecordsBySheet.get(cfg.foreignSheetId)
      const displayFieldId = displayFieldBySheet.get(cfg.foreignSheetId) ?? null
      const summaries: LinkedRecordSummary[] = ids.map((id) => {
        const data = foreignMap?.get(id) ?? {}
        const displayValue = displayFieldId ? data[displayFieldId] : undefined
        return {
          id,
          display: toSummaryDisplay(displayValue),
        }
      })
      byField.set(fieldId, summaries)
    }
    result.set(row.id, byField)
  }

  return result
}

function serializeLinkSummaryMap(
  linkSummaries: Map<string, Map<string, LinkedRecordSummary[]>>,
): Record<string, Record<string, LinkedRecordSummary[]>> {
  return Object.fromEntries(
    Array.from(linkSummaries.entries()).map(([recordId, fieldMap]) => [
      recordId,
      Object.fromEntries(Array.from(fieldMap.entries()).map(([fieldId, summaries]) => [fieldId, summaries])),
    ]),
  )
}

async function buildAttachmentSummaries(
  query: QueryFn,
  req: Request,
  sheetId: string,
  rows: UniverMetaRecord[],
  attachmentFields: UniverMetaField[],
): Promise<Map<string, Map<string, MultitableAttachment[]>>> {
  const result = new Map<string, Map<string, MultitableAttachment[]>>()
  if (rows.length === 0 || attachmentFields.length === 0) return result

  const attachmentFieldIds = new Set(attachmentFields.map((field) => field.id))
  const attachmentIds = new Set<string>()

  for (const row of rows) {
    for (const field of attachmentFields) {
      for (const attachmentId of normalizeAttachmentIds(row.data[field.id])) {
        attachmentIds.add(attachmentId)
      }
    }
  }

  const idList = Array.from(attachmentIds)
  if (idList.length === 0) return result

  const attachmentRes = await query(
    `SELECT id, sheet_id, record_id, field_id, filename, original_name, mime_type, size, created_at
     FROM multitable_attachments
     WHERE sheet_id = $1
       AND deleted_at IS NULL
       AND id = ANY($2::text[])`,
    [sheetId, idList],
  )

  const attachmentById = new Map<string, any>()
  for (const row of attachmentRes.rows as any[]) {
    attachmentById.set(String(row.id), row)
  }

  for (const row of rows) {
    const byField = new Map<string, MultitableAttachment[]>()
    for (const field of attachmentFields) {
      const summaries = normalizeAttachmentIds(row.data[field.id])
        .map((attachmentId) => attachmentById.get(attachmentId))
        .filter((attachmentRow): attachmentRow is any => {
          if (!attachmentRow) return false
          if (attachmentRow.field_id && !attachmentFieldIds.has(String(attachmentRow.field_id))) return false
          return !attachmentRow.field_id || String(attachmentRow.field_id) === field.id
        })
        .map((attachmentRow) => serializeAttachmentRow(req, attachmentRow))

      if (summaries.length > 0) {
        byField.set(field.id, summaries)
      }
    }

    if (byField.size > 0) {
      result.set(row.id, byField)
    }
  }

  return result
}

function serializeAttachmentSummaryMap(
  attachmentSummaries: Map<string, Map<string, MultitableAttachment[]>>,
): Record<string, Record<string, MultitableAttachment[]>> {
  return Object.fromEntries(
    Array.from(attachmentSummaries.entries()).map(([recordId, fieldMap]) => [
      recordId,
      Object.fromEntries(Array.from(fieldMap.entries()).map(([fieldId, summaries]) => [fieldId, summaries])),
    ]),
  )
}

async function loadRecordSummaries(
  query: QueryFn,
  sheetId: string,
  args: {
    displayFieldId?: string | null
    search?: string
    limit?: number
    offset?: number
  },
): Promise<RecordSummaryPage> {
  const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : ''
  const limit = typeof args.limit === 'number' ? args.limit : 50
  const offset = typeof args.offset === 'number' ? args.offset : 0

  const fieldRes = await query(
    'SELECT id, name, type FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [sheetId],
  )
  const fields = fieldRes.rows as Array<{ id: string; name: string; type: string }>

  let effectiveDisplayFieldId = args.displayFieldId ?? null
  if (!effectiveDisplayFieldId && fields.length > 0) {
    const stringField = fields.find((field) => mapFieldType(field.type) === 'string')
    effectiveDisplayFieldId = stringField?.id ?? fields[0]?.id ?? null
  }

  const recordRes = await query(
    'SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
    [sheetId],
  )

  let summaries = (recordRes.rows as Array<{ id: string; data: unknown }>).map((row) => {
    const data = normalizeJson(row.data)
    const displayValue = effectiveDisplayFieldId ? data[effectiveDisplayFieldId] : undefined
    return {
      id: String(row.id),
      display: toSummaryDisplay(displayValue),
    }
  })

  if (search) {
    summaries = summaries.filter((summary) => summary.display.toLowerCase().includes(search))
  }

  const total = summaries.length
  const records = summaries.slice(offset, offset + limit)
  const hasMore = offset + records.length < total
  const displayMap: Record<string, string> = {}
  for (const summary of summaries) {
    displayMap[summary.id] = summary.display
  }

  return {
    records,
    displayMap,
    page: { offset, limit, total, hasMore },
    displayFieldId: effectiveDisplayFieldId,
  }
}

async function resolveMetaSheetId(
  pool: { query: QueryFn },
  args: { sheetId?: string | null; viewId?: string | null },
): Promise<{ sheetId: string; view: UniverMetaViewConfig | null }> {
  const sheetId = typeof args.sheetId === 'string' && args.sheetId.trim().length > 0 ? args.sheetId.trim() : null
  const viewId = typeof args.viewId === 'string' && args.viewId.trim().length > 0 ? args.viewId.trim() : null

  if (sheetId) {
    if (!viewId) return { sheetId, view: null }
    const view = await tryResolveView(pool, viewId)
    if (!view) return { sheetId, view: null }
    if (view.sheetId !== sheetId) {
      throw new ConflictError(`View ${viewId} does not belong to sheet ${sheetId}`)
    }
    return { sheetId, view }
  }

  if (!viewId) {
    throw new ValidationError('sheetId or viewId is required')
  }

  const view = await tryResolveView(pool, viewId)
  if (view) return { sheetId: view.sheetId, view }

  // Backward-compatible fallback: treat viewId as a sheetId when no view exists.
  return { sheetId: viewId, view: null }
}

async function createSeededSheet(args: { sheetId: string; name: string; description?: string | null; query?: QueryFn }): Promise<void> {
  const pool = poolManager.get()

  const fields = [
    { id: buildId('fld'), name: '产品名称', type: 'string' as const, order: 1, property: {} },
    { id: buildId('fld'), name: '数量', type: 'number' as const, order: 2, property: {} },
    { id: buildId('fld'), name: '单价', type: 'number' as const, order: 3, property: {} },
    { id: buildId('fld'), name: '总价', type: 'formula' as const, order: 4, property: {} },
    {
      id: buildId('fld'),
      name: '优先级',
      type: 'select' as const,
      order: 5,
      property: {
        options: [
          { value: 'P0', color: '#ff4d4f' },
          { value: 'P1', color: '#faad14' },
          { value: 'P2', color: '#1677ff' },
          { value: 'Done', color: '#52c41a' },
        ],
      },
    },
    { id: buildId('fld'), name: '关联', type: 'link' as const, order: 6, property: {} },
  ]

  const byName = new Map(fields.map(f => [f.name, f.id] as const))
  const nameId = byName.get('产品名称')!
  const qtyId = byName.get('数量')!
  const priceId = byName.get('单价')!
  const totalId = byName.get('总价')!
  const priorityId = byName.get('优先级')!
  const relatedId = byName.get('关联')!

  const records: Array<{ id: string; version: number; data: Record<string, unknown> }> = [
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '产品A',
        [qtyId]: 10,
        [priceId]: 100,
        [totalId]: '=B1*C1',
        [priorityId]: 'P0',
        [relatedId]: 'PLM#6',
      },
    },
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '产品B',
        [qtyId]: 20,
        [priceId]: 150,
        [totalId]: '=B2*C2',
        [priorityId]: 'P1',
        [relatedId]: 'PLM#7',
      },
    },
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '产品C',
        [qtyId]: 15,
        [priceId]: 200,
        [totalId]: '=B3*C3',
        [priorityId]: 'P2',
        [relatedId]: 'PLM#8',
      },
    },
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '产品D',
        [qtyId]: 25,
        [priceId]: 120,
        [totalId]: '=B4*C4',
        [priorityId]: 'P1',
        [relatedId]: 'PLM#9',
      },
    },
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '合计',
        [qtyId]: '',
        [priceId]: '',
        [totalId]: '=SUM(D1:D4)',
        [priorityId]: '',
        [relatedId]: '',
      },
    },
  ]

  const run = async (query: QueryFn) => {
    const baseId = await ensureLegacyBase(query)
    await query(
      `INSERT INTO meta_sheets (id, base_id, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [args.sheetId, baseId, args.name, args.description ?? null],
    )

    for (const field of fields) {
      await query(
        `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (id) DO NOTHING`,
        [field.id, args.sheetId, field.name, field.type, JSON.stringify(field.property ?? {}), field.order],
      )
    }

    for (const record of records) {
      await query(
        `INSERT INTO meta_records (id, sheet_id, data, version)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, args.sheetId, JSON.stringify(record.data), record.version],
      )
    }
  }

  if (args.query) {
    await run(args.query)
    return
  }

  await pool.transaction(async ({ query }) => {
    await run(query as unknown as QueryFn)
  })
}

class VersionConflictError extends Error {
  constructor(
    public recordId: string,
    public serverVersion: number,
  ) {
    super(`Version conflict for ${recordId}`)
    this.name = 'VersionConflictError'
  }
}

class NotFoundError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

class ConflictError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

class ValidationError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

class PermissionError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}

export function univerMetaRouter(): Router {
  const router = Router()

  router.get('/bases', async (req: Request, res: Response) => {
    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const result = await pool.query(
        `SELECT id, name, icon, color, owner_id, workspace_id
         FROM meta_bases
         WHERE deleted_at IS NULL
         ORDER BY created_at ASC
         LIMIT 200`,
      )
      const visibleSheetRows = filterVisibleSheetRows((
        await pool.query(
          'SELECT id, base_id, name, description FROM meta_sheets WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 200',
        )
      ).rows as any[])
      const readableSheetRows = await filterReadableSheetRowsForAccess(
        pool.query.bind(pool),
        visibleSheetRows.map((row: any) => ({
          id: String(row.id),
          base_id: typeof row.base_id === 'string' ? row.base_id : null,
        })),
        access,
      )
      const readableBaseIds = new Set(
        readableSheetRows
          .map((row) => row.base_id)
          .filter((baseId): baseId is string => typeof baseId === 'string' && baseId.length > 0),
      )
      const bases = result.rows
        .filter((row: any) => readableBaseIds.has(String(row.id)))
        .map((row: any) => serializeBaseRow(row))
      return res.json({ ok: true, data: { bases } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list bases failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list bases' } })
    }
  })

  router.post('/bases', rbacGuard('multitable', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().min(1).max(50).optional(),
      name: z.string().min(1).max(255),
      icon: z.string().min(1).max(64).optional(),
      color: z.string().min(1).max(32).optional(),
      ownerId: z.string().min(1).max(100).optional(),
      workspaceId: z.string().min(1).max(100).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const baseId = parsed.data.id ?? buildId('base').slice(0, 50)
    const ownerId = parsed.data.ownerId ?? req.user?.id?.toString() ?? null

    try {
      const pool = poolManager.get()
      const insert = await pool.query(
        `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, icon, color, owner_id, workspace_id`,
        [
          baseId,
          parsed.data.name.trim(),
          parsed.data.icon ?? null,
          parsed.data.color ?? null,
          ownerId,
          parsed.data.workspaceId ?? null,
        ],
      )
      return res.status(201).json({ ok: true, data: { base: serializeBaseRow((insert as any).rows[0]) } })
    } catch (err: any) {
      if (typeof err?.code === 'string' && err.code === '23505') {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: `Base already exists: ${baseId}` } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create base failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create base' } })
    }
  })

  router.get('/context', async (req: Request, res: Response) => {
    const baseId = typeof req.query.baseId === 'string' ? req.query.baseId.trim() : ''
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    const viewId = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : ''
    if (!baseId && !sheetId && !viewId) {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'baseId, sheetId, or viewId is required' },
      })
    }

    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)

      let resolvedBaseId = baseId || null
      let resolvedSheetId = sheetId || null
      if (resolvedSheetId || viewId) {
        const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
          sheetId: resolvedSheetId,
          viewId: viewId || undefined,
        })
        resolvedSheetId = resolved.sheetId
      }

      const sheetRowResult = resolvedSheetId
        ? await pool.query(
          `SELECT s.id, s.base_id, s.name, s.description, b.id AS base_ref_id, b.name AS base_name, b.icon AS base_icon,
                  b.color AS base_color, b.owner_id AS base_owner_id, b.workspace_id AS base_workspace_id
           FROM meta_sheets s
           LEFT JOIN meta_bases b ON b.id = s.base_id
           WHERE s.id = $1 AND s.deleted_at IS NULL`,
          [resolvedSheetId],
        )
        : { rows: [] }

      const sheetRow = (sheetRowResult as any).rows?.[0]
      if (resolvedSheetId && !sheetRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${resolvedSheetId}` } })
      }

      if (!resolvedBaseId) {
        resolvedBaseId = typeof sheetRow?.base_id === 'string' ? sheetRow.base_id : null
      }

      const baseRowResult = resolvedBaseId
        ? await pool.query(
          `SELECT id, name, icon, color, owner_id, workspace_id
           FROM meta_bases
           WHERE id = $1 AND deleted_at IS NULL`,
          [resolvedBaseId],
        )
        : { rows: [] }

      const baseRow = (baseRowResult as any).rows?.[0]
      const sheetListResult = resolvedBaseId
        ? await pool.query(
          `SELECT id, base_id, name, description
           FROM meta_sheets
           WHERE base_id = $1 AND deleted_at IS NULL
           ORDER BY created_at ASC`,
          [resolvedBaseId],
        )
        : { rows: [] }
      const visibleSheetRows = filterVisibleSheetRows(((sheetListResult as any).rows ?? []) as any[])
      const sheetPermissionScopeMap = await loadSheetPermissionScopeMap(
        pool.query.bind(pool),
        visibleSheetRows.map((row) => String(row.id)),
        access.userId,
      )
      const readableSheetRows = visibleSheetRows.filter((row) =>
        canReadWithSheetGrant(
          baseCapabilities,
          sheetPermissionScopeMap.get(String(row.id)),
          access.isAdminRole,
        ),
      )

      const effectiveSheetId =
        resolvedSheetId ??
        (typeof readableSheetRows[0]?.id === 'string' ? String(readableSheetRows[0].id) : null)
      if (resolvedSheetId && !readableSheetRows.some((row) => String(row.id) === resolvedSheetId)) {
        return sendForbidden(res)
      }
      if (!baseCapabilities.canRead && !effectiveSheetId) {
        return sendForbidden(res)
      }
      const selectedSheetScope = effectiveSheetId
        ? sheetPermissionScopeMap.get(effectiveSheetId)
        : undefined
      const capabilities = effectiveSheetId
        ? applyContextSheetSchemaWriteGrant(
            baseCapabilities,
            selectedSheetScope,
            access.isAdminRole,
          )
        : baseCapabilities
      const capabilityOrigin = deriveCapabilityOrigin(
        baseCapabilities,
        capabilities,
        selectedSheetScope,
        access.isAdminRole,
      )
      const selectedSheet =
        (!isSystemPeopleSheetDescription(sheetRow?.description) ? sheetRow : null) ??
        readableSheetRows.find((row) => String(row.id) === effectiveSheetId) ??
        null

      const viewsResult = effectiveSheetId
        ? await pool.query(
          `SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config
           FROM meta_views
           WHERE sheet_id = $1
           ORDER BY created_at ASC`,
          [effectiveSheetId],
        )
        : { rows: [] }

      const activeFields = effectiveSheetId
        ? await loadFieldsForSheet(pool.query.bind(pool), effectiveSheetId)
        : []
      const serializedViews = (viewsResult as any).rows.map((row: any) => ({
        id: String(row.id),
        sheetId: String(row.sheet_id),
        name: String(row.name),
        type: String(row.type ?? 'grid'),
        filterInfo: normalizeJson(row.filter_info),
        sortInfo: normalizeJson(row.sort_info),
        groupInfo: normalizeJson(row.group_info),
        hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
        config: normalizeJson(row.config),
      }))
      const selectedView = viewId
        ? serializedViews.find((view: UniverMetaViewConfig) => view.id === viewId) ?? null
        : serializedViews[0] ?? null
      const viewIds = serializedViews.map((v: UniverMetaViewConfig) => v.id)
      const viewScopeMap = access.userId ? await loadViewPermissionScopeMap(pool.query.bind(pool), viewIds, access.userId) : new Map()
      const fieldScopeMap = (access.userId && resolvedSheetId) ? await loadFieldPermissionScopeMap(pool.query.bind(pool), resolvedSheetId, access.userId) : new Map()
      const fieldPermissions = deriveFieldPermissions(activeFields, capabilities, {
        hiddenFieldIds: selectedView?.hiddenFieldIds ?? [],
        fieldScopeMap,
      })
      const viewPermissions = deriveViewPermissions(serializedViews, capabilities, viewScopeMap)

      return res.json({
        ok: true,
        data: {
          base: baseRow ? serializeBaseRow(baseRow) : null,
          sheet: selectedSheet
            ? {
              id: String(selectedSheet.id),
              baseId: typeof selectedSheet.base_id === 'string' ? selectedSheet.base_id : null,
              name: String(selectedSheet.name),
              description: typeof selectedSheet.description === 'string' ? selectedSheet.description : null,
            }
            : null,
          sheets: (sheetListResult as any).rows.map((row: any) => ({
            id: String(row.id),
            baseId: typeof row.base_id === 'string' ? row.base_id : null,
            name: String(row.name),
            description: typeof row.description === 'string' ? row.description : null,
          })).filter((row: any) =>
            !isSystemPeopleSheetDescription(row.description)
            && readableSheetRows.some((visibleRow) => String(visibleRow.id) === String(row.id)),
          ),
          views: serializedViews,
          capabilities,
          capabilityOrigin,
          fieldPermissions,
          viewPermissions,
        },
      })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] load context failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load multitable context' } })
    }
  })

  router.get('/sheets', async (req: Request, res: Response) => {
    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const result = await pool.query(
        'SELECT id, base_id, name, description FROM meta_sheets WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 200',
      )
      const readableSheetRows = await filterReadableSheetRowsForAccess(
        pool.query.bind(pool),
        filterVisibleSheetRows((result.rows ?? []) as any[]),
        access,
      )
      const sheets = readableSheetRows.map((r: any) => ({
        id: String(r.id),
        baseId: typeof r.base_id === 'string' ? r.base_id : null,
        name: String(r.name),
        description: typeof r.description === 'string' ? r.description : null,
      }))
      return res.json({ ok: true, data: { sheets } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list sheets failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list sheets' } })
    }
  })

  router.get('/sheets/:sheetId/permissions', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      const items = await listSheetPermissionEntries(pool.query.bind(pool), sheetId)
      return res.json({ ok: true, data: { items } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list sheet permissions failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list sheet permissions' } })
    }
  })

  router.get('/sheets/:sheetId/permission-candidates', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit as number))) : 20

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      const items = await listSheetPermissionCandidates(pool.query.bind(pool), sheetId, { q, limit })
      return res.json({ ok: true, data: { items, total: items.length, limit, query: q } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list sheet permission candidates failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list sheet permission candidates' } })
    }
  })

  router.put('/sheets/:sheetId/permissions/:subjectType/:subjectId', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const subjectType = typeof req.params.subjectType === 'string' ? req.params.subjectType.trim() : ''
    const subjectId = typeof req.params.subjectId === 'string' ? req.params.subjectId.trim() : ''
    if (!sheetId || !subjectId || !isSheetPermissionSubjectType(subjectType)) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId, subjectType, and subjectId are required' } })
    }

    const schema = z.object({
      accessLevel: z.enum(['read', 'write', 'write-own', 'admin', 'none']),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      if (subjectType === 'role' && parsed.data.accessLevel === 'write-own') {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'write-own is only supported for direct user grants' } })
      }

      if (subjectType === 'user') {
        const userResult = await pool.query(
          'SELECT id FROM users WHERE id = $1',
          [subjectId],
        )
        if (userResult.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `User not found: ${subjectId}` } })
        }
      } else {
        const roleResult = await pool.query(
          'SELECT id FROM roles WHERE id = $1',
          [subjectId],
        )
        if (roleResult.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Role not found: ${subjectId}` } })
        }
      }

      await pool.transaction(async ({ query }) => {
        await query(
          `DELETE FROM spreadsheet_permissions
           WHERE sheet_id = $1
             AND subject_type = $2
             AND subject_id = $3
             AND perm_code = ANY($4::text[])`,
          [sheetId, subjectType, subjectId, MANAGED_SHEET_PERMISSION_CODES],
        )
        if (parsed.data.accessLevel !== 'none') {
          await query(
            `INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              sheetId,
              subjectType === 'user' ? subjectId : null,
              subjectType,
              subjectId,
              CANONICAL_SHEET_PERMISSION_CODE_BY_ACCESS_LEVEL[parsed.data.accessLevel],
            ],
          )
        }
      })

      const items = await listSheetPermissionEntries(pool.query.bind(pool), sheetId)
      const entry = items.find((item) => item.subjectType === subjectType && item.subjectId === subjectId) ?? null
      return res.json({
        ok: true,
        data: {
          subjectType,
          subjectId,
          accessLevel: parsed.data.accessLevel,
          entry,
        },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update sheet permission failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update sheet permission' } })
    }
  })

  // ── View permission authoring ──

  router.get('/views/:viewId/permissions', async (req: Request, res: Response) => {
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    if (!viewId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required' } })
    }

    try {
      const pool = poolManager.get()
      const viewRow = await pool.query('SELECT id, sheet_id FROM meta_views WHERE id = $1', [viewId])
      if (viewRow.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }
      const sheetId = String((viewRow.rows[0] as any).sheet_id)
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      const result = await pool.query(
        `SELECT id, view_id, subject_type, subject_id, permission, created_at, created_by
         FROM meta_view_permissions WHERE view_id = $1 ORDER BY created_at ASC`,
        [viewId],
      )
      const items = (result.rows as any[]).map((row) => ({
        id: String(row.id),
        viewId: String(row.view_id),
        subjectType: String(row.subject_type),
        subjectId: String(row.subject_id),
        permission: String(row.permission),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
      }))
      return res.json({ ok: true, data: { items } })
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_view_permissions')) {
        return res.json({ ok: true, data: { items: [] } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list view permissions failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list view permissions' } })
    }
  })

  router.put('/views/:viewId/permissions/:subjectType/:subjectId', async (req: Request, res: Response) => {
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    const subjectType = typeof req.params.subjectType === 'string' ? req.params.subjectType.trim() : ''
    const subjectId = typeof req.params.subjectId === 'string' ? req.params.subjectId.trim() : ''
    if (!viewId || !subjectId || (subjectType !== 'user' && subjectType !== 'role')) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId, subjectType (user|role), and subjectId are required' } })
    }

    const schema = z.object({
      permission: z.enum(['read', 'write', 'admin', 'none']),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const viewRow = await pool.query('SELECT id, sheet_id FROM meta_views WHERE id = $1', [viewId])
      if (viewRow.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }
      const sheetId = String((viewRow.rows[0] as any).sheet_id)
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      if (subjectType === 'user') {
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [subjectId])
        if (userCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `User not found: ${subjectId}` } })
        }
      } else {
        const roleCheck = await pool.query('SELECT id FROM roles WHERE id = $1', [subjectId])
        if (roleCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Role not found: ${subjectId}` } })
        }
      }

      await pool.transaction(async ({ query }) => {
        await query(
          `DELETE FROM meta_view_permissions WHERE view_id = $1 AND subject_type = $2 AND subject_id = $3`,
          [viewId, subjectType, subjectId],
        )
        if (parsed.data.permission !== 'none') {
          await query(
            `INSERT INTO meta_view_permissions(view_id, subject_type, subject_id, permission)
             VALUES ($1, $2, $3, $4)`,
            [viewId, subjectType, subjectId, parsed.data.permission],
          )
        }
      })

      return res.json({ ok: true, data: { viewId, subjectType, subjectId, permission: parsed.data.permission } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update view permission failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update view permission' } })
    }
  })

  // ── Field permission authoring ──

  router.get('/sheets/:sheetId/field-permissions', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)

      const result = await pool.query(
        `SELECT id, sheet_id, field_id, subject_type, subject_id, visible, read_only, created_at
         FROM field_permissions WHERE sheet_id = $1 ORDER BY field_id ASC, created_at ASC`,
        [sheetId],
      )
      const items = (result.rows as any[]).map((row) => ({
        id: String(row.id),
        sheetId: String(row.sheet_id),
        fieldId: String(row.field_id),
        subjectType: String(row.subject_type),
        subjectId: String(row.subject_id),
        visible: row.visible !== false,
        readOnly: row.read_only === true,
      }))
      return res.json({ ok: true, data: { items } })
    } catch (err) {
      if (isUndefinedTableError(err, 'field_permissions')) {
        return res.json({ ok: true, data: { items: [] } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list field permissions failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list field permissions' } })
    }
  })

  router.put('/sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId.trim() : ''
    const subjectType = typeof req.params.subjectType === 'string' ? req.params.subjectType.trim() : ''
    const subjectId = typeof req.params.subjectId === 'string' ? req.params.subjectId.trim() : ''
    if (!sheetId || !fieldId || !subjectId || (subjectType !== 'user' && subjectType !== 'role')) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId, fieldId, subjectType (user|role), and subjectId are required' } })
    }

    const schema = z.object({
      visible: z.boolean().optional(),
      readOnly: z.boolean().optional(),
      remove: z.boolean().optional(),
    }).refine((v) => v.remove || v.visible !== undefined || v.readOnly !== undefined, { message: 'visible, readOnly, or remove required' })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)

      const fieldCheck = await pool.query('SELECT id FROM meta_fields WHERE id = $1 AND sheet_id = $2', [fieldId, sheetId])
      if (fieldCheck.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field ${fieldId} not found in sheet ${sheetId}` } })
      }

      if (subjectType === 'user') {
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [subjectId])
        if (userCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `User not found: ${subjectId}` } })
        }
      } else {
        const roleCheck = await pool.query('SELECT id FROM roles WHERE id = $1', [subjectId])
        if (roleCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Role not found: ${subjectId}` } })
        }
      }

      if (parsed.data.remove) {
        await pool.query(
          `DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2 AND subject_type = $3 AND subject_id = $4`,
          [sheetId, fieldId, subjectType, subjectId],
        )
        return res.json({ ok: true, data: { sheetId, fieldId, subjectType, subjectId, removed: true } })
      }

      await pool.query(
        `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sheet_id, field_id, subject_type, subject_id)
         DO UPDATE SET visible = EXCLUDED.visible, read_only = EXCLUDED.read_only`,
        [sheetId, fieldId, subjectType, subjectId, parsed.data.visible ?? true, parsed.data.readOnly ?? false],
      )

      return res.json({
        ok: true,
        data: { sheetId, fieldId, subjectType, subjectId, visible: parsed.data.visible ?? true, readOnly: parsed.data.readOnly ?? false },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update field permission failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update field permission' } })
    }
  })

  router.get('/fields', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canRead) return sendForbidden(res)

      const result = await pool.query(
        'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC LIMIT 500',
        [sheetId],
      )
      const fields = result.rows.map((r: any) => serializeFieldRow(r))
      return res.json({ ok: true, data: { fields } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list fields failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list fields' } })
    }
  })

  router.post('/fields', async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().min(1).max(50).optional(),
      sheetId: z.string().min(1).max(50),
      name: z.string().min(1).max(255),
      type: z.enum(['string', 'number', 'boolean', 'date', 'formula', 'select', 'link', 'lookup', 'rollup', 'attachment']).default('string'),
      property: z.record(z.unknown()).optional(),
      order: z.number().int().nonnegative().optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const sheetId = parsed.data.sheetId
    const fieldId = parsed.data.id ?? buildId('fld').slice(0, 50)
    const name = parsed.data.name.trim()
    const type = parsed.data.type
    const property = sanitizeFieldProperty(type, parsed.data.property ?? {})
    const desiredOrder = parsed.data.order

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        throw new NotFoundError(`Sheet not found: ${sheetId}`)
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)
      await pool.transaction(async ({ query }) => {
        const configError = await validateLookupRollupConfig(req, query, sheetId, type, property)
        if (configError) {
          throw new ValidationError(configError)
        }

        let order = desiredOrder
        if (typeof order !== 'number') {
          const maxRes = await query('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields WHERE sheet_id = $1', [sheetId])
          const maxOrder = Number((maxRes as any).rows?.[0]?.max_order ?? -1)
          order = Number.isFinite(maxOrder) ? maxOrder + 1 : 0
        } else {
          await query('UPDATE meta_fields SET "order" = "order" + 1 WHERE sheet_id = $1 AND "order" >= $2', [sheetId, order])
        }

        const insert = await query(
          `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING id, name, type, property, "order"`,
          [fieldId, sheetId, name, type, JSON.stringify(property), order],
        )
        const row = (insert as any).rows?.[0]
        if (!row) throw new Error('Insert returned no rows')

        // Track formula dependencies
        if (type === 'formula' && property?.expression) {
          const refs = multitableFormulaEngine.extractFieldReferences(String(property.expression))
          await syncFormulaDependencies(query, sheetId, fieldId, refs)
        }
      })

      const fieldRes = await pool.query(
        'SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1',
        [fieldId],
      )
      invalidateFieldCache(sheetId)
      return res.status(201).json({ ok: true, data: { field: serializeFieldRow((fieldRes as any).rows[0]) } })
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof PermissionError) {
        return sendForbidden(res, err.message)
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (typeof err?.code === 'string' && err.code === '23505') {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: 'Field name already exists in this sheet' } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create field failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create field' } })
    }
  })

  router.post('/person-fields/prepare', async (req: Request, res: Response) => {
    const schema = z.object({
      sheetId: z.string().min(1).max(50),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const sourceSheet = await loadSheetRow(pool.query.bind(pool), parsed.data.sheetId)
      if (!sourceSheet) throw new NotFoundError(`Sheet not found: ${parsed.data.sheetId}`)
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), parsed.data.sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)
      const preset = await pool.transaction(async ({ query }) => {
        const baseId = sourceSheet.baseId ?? await ensureLegacyBase(query as unknown as QueryFn)
        return ensurePeopleSheetPreset(query as unknown as QueryFn, baseId)
      })

      return res.json({ ok: true, data: { targetSheet: preset.sheet, fieldProperty: preset.fieldProperty } })
    } catch (err) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] prepare person field failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to prepare person field preset' } })
    }
  })

  router.get('/people-search', async (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 10)))
    const baseId = typeof req.query.baseId === 'string' ? req.query.baseId.trim() : ''

    if (!baseId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'baseId is required' } })
    }

    try {
      const pool = poolManager.get()
      const query = pool.query.bind(pool)

      const sheetsRes = await query(
        `SELECT id FROM meta_sheets WHERE base_id = $1 AND description = $2 AND deleted_at IS NULL LIMIT 1`,
        [baseId, SYSTEM_PEOPLE_SHEET_DESCRIPTION],
      )
      const peopleSheetId = (sheetsRes.rows[0] as any)?.id

      if (!peopleSheetId) {
        return res.json({ ok: true, data: { items: [] } })
      }

      const { capabilities } = await resolveSheetReadableCapabilities(req, query, peopleSheetId)
      if (!capabilities.canRead) return sendForbidden(res)

      const summary = await loadRecordSummaries(query, peopleSheetId, { search: q, limit, offset: 0 })
      return res.json({ ok: true, data: { items: summary.records } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] people-search failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'People search failed' } })
    }
  })

  router.patch('/fields/:fieldId', async (req: Request, res: Response) => {
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId : ''
    if (!fieldId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'fieldId is required' } })
    }

    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      type: z.enum(['string', 'number', 'boolean', 'date', 'formula', 'select', 'link', 'lookup', 'rollup', 'attachment']).optional(),
      property: z.record(z.unknown()).optional(),
      order: z.number().int().nonnegative().optional(),
    }).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be updated' })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const existing = await pool.query(
        'SELECT id, sheet_id FROM meta_fields WHERE id = $1',
        [fieldId],
      )
      if (existing.rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)
      const preflightSheetId = String((existing.rows[0] as any).sheet_id ?? '')
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), preflightSheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)
      let sheetId = ''
      const updated = await pool.transaction(async ({ query }) => {
        const existing = await query(
          'SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1',
          [fieldId],
        )
        if ((existing as any).rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)

        const row = (existing as any).rows[0]
        sheetId = String(row.sheet_id)
        const currentOrder = Number(row.order ?? 0)

        const nextName = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : String(row.name)
        const nextType = (parsed.data.type ?? mapFieldType(String(row.type))) as UniverMetaField['type']
        const nextProperty = sanitizeFieldProperty(
          nextType,
          typeof parsed.data.property !== 'undefined' ? parsed.data.property : row.property,
        )
        const desiredOrder = parsed.data.order

        const configError = await validateLookupRollupConfig(req, query, sheetId, nextType, nextProperty)
        if (configError) {
          throw new ValidationError(configError)
        }

        if (typeof desiredOrder === 'number' && desiredOrder !== currentOrder) {
          if (desiredOrder < currentOrder) {
            await query(
              'UPDATE meta_fields SET "order" = "order" + 1 WHERE sheet_id = $1 AND "order" >= $2 AND "order" < $3 AND id <> $4',
              [sheetId, desiredOrder, currentOrder, fieldId],
            )
          } else {
            await query(
              'UPDATE meta_fields SET "order" = "order" - 1 WHERE sheet_id = $1 AND "order" > $2 AND "order" <= $3 AND id <> $4',
              [sheetId, currentOrder, desiredOrder, fieldId],
            )
          }
        }

        const nextOrder = typeof desiredOrder === 'number' ? desiredOrder : currentOrder

        const update = await query(
          `UPDATE meta_fields
           SET name = $2, type = $3, property = $4::jsonb, "order" = $5, updated_at = now()
           WHERE id = $1
           RETURNING id, name, type, property, "order"`,
          [fieldId, nextName, nextType, JSON.stringify(nextProperty), nextOrder],
        )
        const updatedRow = (update as any).rows?.[0]
        if (!updatedRow) throw new Error('Update returned no rows')

        // Track formula dependencies on update
        if (nextType === 'formula' && nextProperty?.expression) {
          const refs = multitableFormulaEngine.extractFieldReferences(String(nextProperty.expression))
          await syncFormulaDependencies(query, sheetId, fieldId, refs)
        }

        return serializeFieldRow(updatedRow)
      })

      invalidateFieldCache(sheetId)
      return res.json({ ok: true, data: { field: updated } })
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof PermissionError) {
        return sendForbidden(res, err.message)
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (typeof err?.code === 'string' && err.code === '23505') {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: 'Field name already exists in this sheet' } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update field failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update field' } })
    }
  })

  router.delete('/fields/:fieldId', async (req: Request, res: Response) => {
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId : ''
    if (!fieldId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'fieldId is required' } })
    }

    const cleanupViewConfig = (args: {
      filterInfo: Record<string, unknown>
      sortInfo: Record<string, unknown>
      groupInfo: Record<string, unknown>
      hiddenFieldIds: string[]
    }) => {
      const nextHidden = args.hiddenFieldIds.filter((id) => id !== fieldId)

      const rawSortRules = Array.isArray(args.sortInfo.rules) ? args.sortInfo.rules : []
      const nextSortRules = rawSortRules.filter((r) => isPlainObject(r) && r.fieldId !== fieldId)
      const nextSortInfo = nextSortRules.length > 0 ? { ...args.sortInfo, rules: nextSortRules } : {}

      const nextGroupInfo = args.groupInfo.fieldId === fieldId ? {} : args.groupInfo

      const rawConditions = Array.isArray(args.filterInfo.conditions) ? args.filterInfo.conditions : []
      const nextConditions = rawConditions.filter((c) => isPlainObject(c) && c.fieldId !== fieldId)
      const nextFilterInfo = nextConditions.length > 0 ? { ...args.filterInfo, conditions: nextConditions } : {}

      return { nextHidden, nextSortInfo, nextGroupInfo, nextFilterInfo }
    }

    try {
      const pool = poolManager.get()
      const existing = await pool.query('SELECT id, sheet_id FROM meta_fields WHERE id = $1', [fieldId])
      if (existing.rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)
      const sheetId = String((existing.rows[0] as any).sheet_id ?? '')
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)
      const result = await pool.transaction(async ({ query }) => {
        const existing = await query('SELECT id, sheet_id, "order" FROM meta_fields WHERE id = $1', [fieldId])
        if ((existing as any).rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)
        const row = (existing as any).rows[0]
        const sheetId = String(row.sheet_id)
        const order = Number(row.order ?? 0)

        await query('DELETE FROM meta_fields WHERE id = $1', [fieldId])

        try {
          await query('DELETE FROM meta_links WHERE field_id = $1', [fieldId])
        } catch (err) {
          if (!isUndefinedTableError(err, 'meta_links')) throw err
        }

        await query('UPDATE meta_records SET data = data - $1 WHERE sheet_id = $2', [fieldId, sheetId])
        await query('UPDATE meta_fields SET "order" = "order" - 1 WHERE sheet_id = $1 AND "order" > $2', [sheetId, order])

        const views = await query(
          'SELECT id, filter_info, sort_info, group_info, hidden_field_ids FROM meta_views WHERE sheet_id = $1',
          [sheetId],
        )
        for (const v of (views as any).rows as any[]) {
          const filterInfo = normalizeJson(v.filter_info)
          const sortInfo = normalizeJson(v.sort_info)
          const groupInfo = normalizeJson(v.group_info)
          const hiddenFieldIds = normalizeJsonArray(v.hidden_field_ids)

          const { nextHidden, nextSortInfo, nextGroupInfo, nextFilterInfo } = cleanupViewConfig({
            filterInfo,
            sortInfo,
            groupInfo,
            hiddenFieldIds,
          })

          const changed =
            nextHidden.length !== hiddenFieldIds.length ||
            JSON.stringify(nextSortInfo) !== JSON.stringify(sortInfo) ||
            JSON.stringify(nextGroupInfo) !== JSON.stringify(groupInfo) ||
            JSON.stringify(nextFilterInfo) !== JSON.stringify(filterInfo)
          if (!changed) continue

          await query(
            'UPDATE meta_views SET filter_info = $2::jsonb, sort_info = $3::jsonb, group_info = $4::jsonb, hidden_field_ids = $5::jsonb WHERE id = $1',
            [String(v.id), JSON.stringify(nextFilterInfo), JSON.stringify(nextSortInfo), JSON.stringify(nextGroupInfo), JSON.stringify(nextHidden)],
          )
        }

        return { deleted: fieldId, sheetId }
      })

      invalidateFieldCache(result.sheetId)
      invalidateViewConfigCache()
      return res.json({ ok: true, data: result })
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete field failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete field' } })
    }
  })

  router.get('/views', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canRead) return sendForbidden(res)

      let result = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC LIMIT 200',
        [sheetId],
      )

      if (result.rows.length === 0 && capabilities.canManageViews) {
        const defaultId = buildId('view')
        await pool.query(
          `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [defaultId, sheetId, '默认视图', 'grid', '{}', '{}', '{}', '[]', '{}'],
        )
        result = await pool.query(
          'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC LIMIT 200',
          [sheetId],
        )
      }

      const views: UniverMetaViewConfig[] = result.rows.map((r: any) => ({
        id: String(r.id),
        sheetId: String(r.sheet_id),
        name: String(r.name),
        type: String(r.type ?? 'grid'),
        filterInfo: normalizeJson(r.filter_info),
        sortInfo: normalizeJson(r.sort_info),
        groupInfo: normalizeJson(r.group_info),
        hiddenFieldIds: normalizeJsonArray(r.hidden_field_ids),
        config: normalizeJson(r.config),
      }))

      return res.json({ ok: true, data: { views } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list views failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list views' } })
    }
  })

  router.post('/views', async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().min(1).max(50).optional(),
      sheetId: z.string().min(1).max(50),
      name: z.string().min(1).max(255),
      type: z.string().min(1).max(50).optional(),
      filterInfo: z.record(z.unknown()).optional(),
      sortInfo: z.record(z.unknown()).optional(),
      groupInfo: z.record(z.unknown()).optional(),
      hiddenFieldIds: z.array(z.string().min(1)).optional(),
      config: z.record(z.unknown()).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const viewId = parsed.data.id ?? buildId('view')
    const sheetId = parsed.data.sheetId
    const name = parsed.data.name
    const type = parsed.data.type ?? 'grid'

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      await pool.query(
        `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
        [
          viewId,
          sheetId,
          name,
          type,
          JSON.stringify(parsed.data.filterInfo ?? {}),
          JSON.stringify(parsed.data.sortInfo ?? {}),
          JSON.stringify(parsed.data.groupInfo ?? {}),
          JSON.stringify(parsed.data.hiddenFieldIds ?? []),
          JSON.stringify(parsed.data.config ?? {}),
        ],
      )

      const view: UniverMetaViewConfig = {
        id: viewId,
        sheetId,
        name,
        type,
        filterInfo: parsed.data.filterInfo ?? {},
        sortInfo: parsed.data.sortInfo ?? {},
        groupInfo: parsed.data.groupInfo ?? {},
        hiddenFieldIds: parsed.data.hiddenFieldIds ?? [],
        config: parsed.data.config ?? {},
      }

      metaViewConfigCache.set(viewId, view)
      return res.status(201).json({ ok: true, data: { view } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create view' } })
    }
  })

  router.patch('/views/:viewId', async (req: Request, res: Response) => {
    const viewId = req.params.viewId
    if (!viewId || typeof viewId !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required' } })
    }

    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      type: z.string().min(1).max(50).optional(),
      filterInfo: z.record(z.unknown()).optional(),
      sortInfo: z.record(z.unknown()).optional(),
      groupInfo: z.record(z.unknown()).optional(),
      hiddenFieldIds: z.array(z.string().min(1)).optional(),
      config: z.record(z.unknown()).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const current = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1',
        [viewId],
      )
      if (current.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }

      const row: any = current.rows[0]
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), String(row.sheet_id))
      if (!capabilities.canManageViews) return sendForbidden(res)
      const nextName = parsed.data.name ?? String(row.name)
      const nextType = parsed.data.type ?? String(row.type ?? 'grid')
      const nextFilter = parsed.data.filterInfo ?? normalizeJson(row.filter_info)
      const nextSort = parsed.data.sortInfo ?? normalizeJson(row.sort_info)
      const nextGroup = parsed.data.groupInfo ?? normalizeJson(row.group_info)
      const nextHiddenFieldIds = parsed.data.hiddenFieldIds ?? normalizeJsonArray(row.hidden_field_ids)
      const nextConfig = parsed.data.config ?? normalizeJson(row.config)

      await pool.query(
        `UPDATE meta_views
         SET name = $2, type = $3, filter_info = $4::jsonb, sort_info = $5::jsonb, group_info = $6::jsonb, hidden_field_ids = $7::jsonb, config = $8::jsonb
         WHERE id = $1`,
        [
          viewId,
          nextName,
          nextType,
          JSON.stringify(nextFilter ?? {}),
          JSON.stringify(nextSort ?? {}),
          JSON.stringify(nextGroup ?? {}),
          JSON.stringify(nextHiddenFieldIds ?? []),
          JSON.stringify(nextConfig ?? {}),
        ],
      )

      const view: UniverMetaViewConfig = {
        id: viewId,
        sheetId: String(row.sheet_id),
        name: nextName,
        type: nextType,
        filterInfo: nextFilter ?? {},
        sortInfo: nextSort ?? {},
        groupInfo: nextGroup ?? {},
        hiddenFieldIds: nextHiddenFieldIds ?? [],
        config: nextConfig ?? {},
      }

      metaViewConfigCache.set(viewId, view)
      return res.json({ ok: true, data: { view } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update view' } })
    }
  })

  router.delete('/views/:viewId', async (req: Request, res: Response) => {
    const viewId = req.params.viewId
    if (!viewId || typeof viewId !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required' } })
    }

    try {
      const pool = poolManager.get()
      const current = await pool.query('SELECT id, sheet_id FROM meta_views WHERE id = $1', [viewId])
      if (current.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), String((current.rows[0] as any).sheet_id ?? ''))
      if (!capabilities.canManageViews) return sendForbidden(res)
      await pool.query('DELETE FROM meta_views WHERE id = $1', [viewId])
      invalidateViewConfigCache(viewId)
      return res.json({ ok: true, data: { deleted: viewId } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete view' } })
    }
  })

  router.delete('/sheets/:sheetId', async (req: Request, res: Response) => {
    const sheetId = req.params.sheetId
    if (!sheetId || typeof sheetId !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (sheetScope?.hasAssignments) {
        if (!capabilities.canManageSheetAccess) return sendForbidden(res)
      } else if (!capabilities.canManageViews) {
        return sendForbidden(res)
      }
      const del = await pool.query('DELETE FROM meta_sheets WHERE id = $1', [sheetId])
      invalidateSheetSummaryCache(sheetId)
      invalidateFieldCache(sheetId)
      invalidateViewConfigCache()
      return res.json({ ok: true, data: { deleted: sheetId } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete sheet failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete sheet' } })
    }
  })

  router.post('/sheets', async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().min(1).max(50).optional(),
      baseId: z.string().min(1).max(50).optional(),
      name: z.string().min(1).max(255).optional(),
      description: z.string().max(2000).optional(),
      seed: z.boolean().optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const sheetId = parsed.data.id ?? buildId('sheet').slice(0, 50)
    const name = parsed.data.name ?? `Univer Sheet ${new Date().toISOString()}`
    const description = parsed.data.description ?? null
    const requestedBaseId = parsed.data.baseId?.trim()
    const seed = parsed.data.seed === true

    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)
      let baseId = requestedBaseId ?? null
      await pool.transaction(async ({ query }) => {
        if (!baseId) {
          if (!baseCapabilities.canManageViews) {
            throw new ValidationError('Insufficient permissions')
          }
          baseId = await ensureLegacyBase(query as unknown as QueryFn)
        } else {
          const baseRes = await query(
            'SELECT id, owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL',
            [baseId],
          )
          if ((baseRes as any).rows.length === 0) {
            throw new NotFoundError(`Base not found: ${baseId}`)
          }
          const baseRow = (baseRes as any).rows[0] as { owner_id?: unknown }
          const baseOwnerId = typeof baseRow.owner_id === 'string' ? baseRow.owner_id : null
          const canCreateInBase = baseCapabilities.canManageViews || (baseOwnerId !== null && baseOwnerId === access.userId)
          if (!canCreateInBase) {
            throw new ValidationError('Insufficient permissions')
          }
        }

        const insert = await query(
          `INSERT INTO meta_sheets (id, base_id, name, description)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [sheetId, baseId, name, description],
        )
        if ((insert as any).rowCount === 0) {
          throw new ConflictError(`Sheet already exists: ${sheetId}`)
        }

        if (seed) {
          await createSeededSheet({ sheetId, name, description, query: query as unknown as QueryFn })
        }
      })

      return res.json({ ok: true, data: { sheet: { id: sheetId, baseId, name, description, seeded: seed } } })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: err.message } })
      }
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create sheet failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create sheet' } })
    }
  })

  router.get('/view', async (req: Request, res: Response) => {
    const sheetIdParam = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : undefined
    const viewIdParam = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : undefined
    const seed = req.query.seed === 'true'
    const includeLinkSummaries = req.query.includeLinkSummaries === 'true'
    const search = normalizeSearchTerm(req.query.search)
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined
    const offsetParam = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : undefined
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam!, 1), 5000) : undefined
    const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam!, 0) : 0

    try {
      const pool = poolManager.get()
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: sheetIdParam,
        viewId: viewIdParam,
      })
      const sheetId = resolved.sheetId
      const viewConfig = resolved.view
      const { access, capabilities, capabilityOrigin, sheetScope } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)
      const rawSortRules = viewConfig ? parseMetaSortRules(viewConfig.sortInfo) : []
      const rawFilterInfo = viewConfig ? parseMetaFilterInfo(viewConfig.filterInfo) : null
      if (seed) {
        await createSeededSheet({ sheetId, name: `Seed ${sheetId}` })
      }

      const [sheet, fields] = await Promise.all([
        loadSheetSummary(pool as unknown as { query: QueryFn }, sheetId),
        loadSheetFields(pool as unknown as { query: QueryFn }, sheetId),
      ])

      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      const visiblePropertyFieldIds = new Set(visiblePropertyFields.map((field) => field.id))
      const fieldTypeById = new Map(visiblePropertyFields.map((f) => [f.id, f.type] as const))
      const searchableFieldIds = visiblePropertyFields
        .filter((field) => isSearchableFieldType(field.type))
        .map((field) => field.id)
      const warnings: string[] = []

      const ignoredSortFieldIds = rawSortRules
        .filter((rule) => !fieldTypeById.has(rule.fieldId))
        .map((rule) => rule.fieldId)
      const sortRules = rawSortRules.filter((rule) => fieldTypeById.has(rule.fieldId))

      const ignoredFilterFieldIds = rawFilterInfo
        ? rawFilterInfo.conditions.filter((condition) => !fieldTypeById.has(condition.fieldId)).map((c) => c.fieldId)
        : []
      const filteredConditions = rawFilterInfo
        ? rawFilterInfo.conditions.filter((condition) => fieldTypeById.has(condition.fieldId))
        : []
      const filterInfo = filteredConditions.length > 0 && rawFilterInfo
        ? { ...rawFilterInfo, conditions: filteredConditions }
        : null

      if (ignoredSortFieldIds.length > 0) {
        warnings.push(`排序字段不存在，已忽略: ${ignoredSortFieldIds.join(', ')}`)
      }
      if (ignoredFilterFieldIds.length > 0) {
        warnings.push(`筛选字段不存在，已忽略: ${ignoredFilterFieldIds.join(', ')}`)
      }

      const relationalLinkFields = fields
        .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: parseLinkFieldConfig(f.property) } : null))
        .filter((v): v is { fieldId: string; cfg: LinkFieldConfig } => !!v && !!v.cfg)
      const attachmentFields = visiblePropertyFields.filter((field) => field.type === 'attachment')
      const computedFieldIdSet = new Set(
        visiblePropertyFields.filter((f) => f.type === 'lookup' || f.type === 'rollup').map((f) => f.id),
      )

      let rows: UniverMetaRecord[] = []
      let page: UniverMetaView['page'] | undefined

      const hasSearch = search.length > 0
      const hasFilterOrSort = sortRules.length > 0 || !!filterInfo
      const hasSimpleSearchFastPath = hasSearch && !hasFilterOrSort
      const hasInMemoryProcessing = hasFilterOrSort || hasSearch

      let computedFilterSort = false

      if (hasSimpleSearchFastPath) {
        if (searchableFieldIds.length === 0) {
          rows = []
          if (limit) page = { offset, limit, total: 0, hasMore: false }
        } else {
          const searchLike = `%${escapeSqlLikePattern(search)}%`
          const firstFieldParamIndex = 3
          const predicate = buildRecordSearchPredicateSql(searchableFieldIds, 2, firstFieldParamIndex)

          if (limit) {
            const limitParamIndex = firstFieldParamIndex + searchableFieldIds.length
            const offsetParamIndex = limitParamIndex + 1
            const recordRes = await pool.query(
              `SELECT id, version, data, COUNT(*) OVER()::int AS total
               FROM meta_records
               WHERE sheet_id = $1 AND (${predicate})
               ORDER BY created_at ASC, id ASC
               LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
              [sheetId, searchLike, ...searchableFieldIds, limit, offset],
            )

            rows = recordRes.rows.map((r: any) => ({
              id: String(r.id),
              version: Number(r.version ?? 1),
              data: normalizeJson(r.data),
            }))

            let total = Number((recordRes.rows[0] as any)?.total ?? 0)
            if (rows.length === 0 && offset > 0) {
              const countRes = await pool.query(
                `SELECT COUNT(*)::int AS total
                 FROM meta_records
                 WHERE sheet_id = $1 AND (${predicate})`,
                [sheetId, searchLike, ...searchableFieldIds],
              )
              total = Number((countRes.rows[0] as any)?.total ?? 0)
            }
            page = { offset, limit, total, hasMore: offset + rows.length < total }
          } else {
            const recordRes = await pool.query(
              `SELECT id, version, data
               FROM meta_records
               WHERE sheet_id = $1 AND (${predicate})
               ORDER BY created_at ASC, id ASC`,
              [sheetId, searchLike, ...searchableFieldIds],
            )

            rows = recordRes.rows.map((r: any) => ({
              id: String(r.id),
              version: Number(r.version ?? 1),
              data: normalizeJson(r.data),
            }))
          }
        }
      } else if (hasInMemoryProcessing) {
        const recordRes = await pool.query(
          'SELECT id, version, data, created_at FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
          [sheetId],
        )

        let all = recordRes.rows.map((r: any) => ({
          id: String(r.id),
          version: Number(r.version ?? 1),
          data: normalizeJson(r.data),
          createdAt: (r as any).created_at as unknown,
        }))

        const needsComputedFilterSort =
          computedFieldIdSet.size > 0 &&
          (sortRules.some((rule) => computedFieldIdSet.has(rule.fieldId)) ||
            (filterInfo?.conditions ?? []).some((condition) => computedFieldIdSet.has(condition.fieldId)))

        if (needsComputedFilterSort) {
          warnings.push('筛选/排序包含 Lookup/Rollup，当前为内存计算，数据量大时较慢。')
        }
        computedFilterSort = needsComputedFilterSort

        if (needsComputedFilterSort) {
          const linkValuesByRecord = await loadLinkValuesByRecord(
            pool.query.bind(pool),
            all.map((r) => r.id),
            relationalLinkFields,
          )
          await applyLookupRollup(
            req,
            pool.query.bind(pool),
            fields,
            all,
            relationalLinkFields,
            linkValuesByRecord,
          )
        }

        if (hasSearch) {
          all = all.filter((record) => recordMatchesSearch(record, visiblePropertyFields, search))
        }

        if (filterInfo) {
          const conditions = filterInfo.conditions.filter((c) => fieldTypeById.has(c.fieldId))
          if (conditions.length > 0) {
            all = all.filter((record) => {
              const matches = (condition: MetaFilterCondition) => {
                const fieldType = fieldTypeById.get(condition.fieldId)
                if (!fieldType) return true
                return evaluateMetaFilterCondition(fieldType, record.data[condition.fieldId], condition)
              }

              if (filterInfo.conjunction === 'or') return conditions.some(matches)
              return conditions.every(matches)
            })
          }
        }

        const sorted = sortRules.length > 0 ? [...all].sort((a, b) => {
          for (const rule of sortRules) {
            const fieldType = fieldTypeById.get(rule.fieldId) ?? 'string'
            const cmp = compareMetaSortValue(fieldType, a.data[rule.fieldId], b.data[rule.fieldId], rule.desc)
            if (cmp !== 0) return cmp
          }

          const aEpoch = toEpoch(a.createdAt)
          const bEpoch = toEpoch(b.createdAt)
          if (aEpoch !== null && bEpoch !== null && aEpoch !== bEpoch) {
            return aEpoch > bEpoch ? 1 : -1
          }
          return a.id.localeCompare(b.id)
        }) : all

        const total = sorted.length
        const paged = limit ? sorted.slice(offset, offset + limit) : sorted
        rows = paged.map((r) => ({ id: r.id, version: r.version, data: r.data }))
        if (limit) page = { offset, limit, total, hasMore: offset + rows.length < total }
      } else {
        if (limit) {
          const recordRes = await pool.query(
            `SELECT id, version, data, COUNT(*) OVER()::int AS total
             FROM meta_records
             WHERE sheet_id = $1
             ORDER BY created_at ASC, id ASC
             LIMIT $2 OFFSET $3`,
            [sheetId, limit, offset],
          )

          rows = recordRes.rows.map((r: any) => ({
            id: String(r.id),
            version: Number(r.version ?? 1),
            data: normalizeJson(r.data),
          }))

          let total = Number((recordRes.rows[0] as any)?.total ?? 0)
          if (rows.length === 0 && offset > 0) {
            const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1', [sheetId])
            total = Number((countRes.rows[0] as any)?.total ?? 0)
          }
          page = { offset, limit, total, hasMore: offset + rows.length < total }
        } else {
          const recordRes = await pool.query(
            'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
            [sheetId],
          )

          rows = recordRes.rows.map((r: any) => ({
            id: String(r.id),
            version: Number(r.version ?? 1),
            data: normalizeJson(r.data),
          }))
        }
      }

      const linkValuesByRecord = await loadLinkValuesByRecord(
        pool.query.bind(pool),
        rows.map((r) => r.id),
        relationalLinkFields,
      )

      if (relationalLinkFields.length > 0 && rows.length > 0) {
        for (const row of rows) {
          for (const { fieldId } of relationalLinkFields) {
            row.data[fieldId] = []
          }
        }

        for (const row of rows) {
          const recordMap = linkValuesByRecord.get(row.id)
          if (!recordMap) continue
          for (const { fieldId } of relationalLinkFields) {
            const list = recordMap.get(fieldId)
            if (list && list.length > 0) row.data[fieldId] = list
          }
        }
      }

      await applyLookupRollup(
        req,
        pool.query.bind(pool),
        fields,
        rows,
        relationalLinkFields,
        linkValuesByRecord,
      )
      for (const row of rows) {
        row.data = filterRecordDataByFieldIds(row.data, visiblePropertyFieldIds)
      }
      const linkSummaries = includeLinkSummaries
        ? filterRecordFieldSummaryMap(
            serializeLinkSummaryMap(
              await buildLinkSummaries(
                req,
                pool.query.bind(pool),
                rows,
                relationalLinkFields,
                linkValuesByRecord,
              ),
            ),
            visiblePropertyFieldIds,
          )
        : undefined
      const attachmentSummaries = attachmentFields.length > 0
        ? filterRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                rows,
                attachmentFields,
              ),
            ),
            visiblePropertyFieldIds,
          )
        : undefined
      const rowActionOverrides = buildRowActionOverrides(
        rows,
        requiresOwnWriteRowPolicy(sheetScope, access.isAdminRole)
          ? await loadRecordCreatorMap(pool.query.bind(pool), sheetId, rows.map((row) => row.id))
          : new Map(),
        capabilities,
        sheetScope,
        access,
      )
      const fieldScopeMap = access.userId ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId) : new Map()
      const viewScopeMap = (access.userId && viewConfig) ? await loadViewPermissionScopeMap(pool.query.bind(pool), [viewConfig.id], access.userId) : new Map()
      const permissions: MultitableScopedPermissions = {
        fieldPermissions: deriveFieldPermissions(fields, capabilities, {
          hiddenFieldIds: viewConfig?.hiddenFieldIds ?? [],
          fieldScopeMap,
        }),
        rowActions: deriveDefaultRowActions(capabilities, sheetScope, access.isAdminRole),
        ...(rowActionOverrides ? { rowActionOverrides } : {}),
        ...(viewConfig ? { viewPermissions: deriveViewPermissions([viewConfig], capabilities, viewScopeMap) } : {}),
      }

      const meta = warnings.length > 0 || hasFilterOrSort
        ? {
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(hasFilterOrSort ? { computedFilterSort } : {}),
            ...(ignoredSortFieldIds.length > 0 ? { ignoredSortFieldIds } : {}),
            ...(ignoredFilterFieldIds.length > 0 ? { ignoredFilterFieldIds } : {}),
            capabilityOrigin,
            permissions,
          }
        : { capabilityOrigin, permissions }

      const view: UniverMetaView = {
        id: sheetId,
        fields: visiblePropertyFields,
        rows,
        ...(linkSummaries ? { linkSummaries } : {}),
        ...(attachmentSummaries ? { attachmentSummaries } : {}),
        ...(viewConfig ? { view: viewConfig } : {}),
        ...(meta ? { meta } : {}),
        ...(page ? { page } : {}),
      }
      return res.json({ ok: true, data: view })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load meta view' } })
    }
  })

  router.get('/form-context', async (req: Request, res: Response) => {
    const sheetIdParam = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : undefined
    const viewIdParam = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : undefined
    const recordIdParam = typeof req.query.recordId === 'string' ? req.query.recordId.trim() : undefined

    try {
      const pool = poolManager.get()
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: sheetIdParam,
        viewId: viewIdParam,
      })
      const sheetId = resolved.sheetId
      const { access, capabilities, capabilityOrigin, sheetScope } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const fields = await loadFieldsForSheet(pool.query.bind(pool), sheetId)

      let record: UniverMetaRecord | undefined
      if (recordIdParam) {
        const recordRes = await pool.query(
          'SELECT id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordIdParam, sheetId],
        )
        const row: any = recordRes.rows[0]
        if (!row) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordIdParam}` } })
        }
        record = {
          id: String(row.id),
          version: Number(row.version ?? 1),
          data: normalizeJson(row.data),
          createdBy: typeof row.created_by === 'string' ? row.created_by : null,
        }
      }

      const hiddenFieldIds = new Set(resolved.view?.hiddenFieldIds ?? [])
      const visibleFields = fields.filter((field) => !hiddenFieldIds.has(field.id) && !isFieldPermissionHidden(field))
      const visibleFieldIds = new Set(visibleFields.map((field) => field.id))
      const fieldScopeMap = access.userId ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId) : new Map()
      const viewScopeMap = (access.userId && resolved.view) ? await loadViewPermissionScopeMap(pool.query.bind(pool), [resolved.view.id], access.userId) : new Map()
      const fieldPermissions = deriveFieldPermissions(fields, capabilities, {
        hiddenFieldIds: resolved.view?.hiddenFieldIds ?? [],
        allowCreateOnly: !record,
        fieldScopeMap,
      })
      const viewPermissions = resolved.view ? deriveViewPermissions([resolved.view], capabilities, viewScopeMap) : {}
      const rowActions = record
        ? deriveRecordRowActions(capabilities, sheetScope, access, record.createdBy)
        : deriveRecordRowActions({
            ...capabilities,
            canEditRecord: capabilities.canCreateRecord,
            canDeleteRecord: false,
          }, sheetScope, access, null)
      const attachmentFields = visibleFields.filter((field) => field.type === 'attachment')
      const attachmentSummaries = record && attachmentFields.length > 0
        ? filterSingleRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                [record],
                attachmentFields,
              ),
            )[record.id] ?? {},
            visibleFieldIds,
          )
        : undefined
      if (record) {
        record.data = filterRecordDataByFieldIds(record.data, visibleFieldIds)
      }

      return res.json({
        ok: true,
        data: {
          mode: 'form',
          readOnly: !capabilities.canCreateRecord,
          submitPath: resolved.view ? `/api/multitable/views/${resolved.view.id}/submit` : '/api/multitable/records',
          sheet,
          ...(resolved.view ? { view: resolved.view } : {}),
          fields: visibleFields,
          capabilities,
          capabilityOrigin,
          fieldPermissions,
          ...(resolved.view ? { viewPermissions } : {}),
          ...(record ? { rowActions } : {}),
          ...(record ? { record } : {}),
          ...(attachmentSummaries ? { attachmentSummaries } : {}),
          ...(record
            ? {
              commentsScope: {
                targetType: 'meta_record',
                targetId: record.id,
                baseId: sheet.baseId ?? null,
                sheetId: sheet.id,
                viewId: resolved.view?.id ?? null,
                recordId: record.id,
                containerType: 'meta_sheet',
                containerId: sheet.id,
              },
            }
            : {}),
        },
      })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] form-context failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load form context' } })
    }
  })

  router.post('/views/:viewId/submit', async (req: Request, res: Response) => {
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    if (!viewId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required' } })
    }

    const schema = z.object({
      recordId: z.string().min(1).optional(),
      expectedVersion: z.number().int().nonnegative().optional(),
      data: z.record(z.unknown()).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const view = await tryResolveView(pool as unknown as { query: QueryFn }, viewId)
      if (!view) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }

      const sheet = await loadSheetRow(pool.query.bind(pool), view.sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${view.sheetId}` } })
      }
      const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), view.sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const canWriteFormRecord = parsed.data.recordId ? capabilities.canEditRecord : capabilities.canCreateRecord
      if (!canWriteFormRecord) return sendForbidden(res)

      const fields = await loadFieldsForSheet(pool.query.bind(pool), view.sheetId)
      const fieldById = buildFieldMutationGuardMap(fields)

      const hiddenFieldIds = new Set(view.hiddenFieldIds ?? [])
      const data = parsed.data.data ?? {}
      const fieldErrors: Record<string, string> = {}
      const patch: Record<string, unknown> = {}
      const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()

      for (const [fieldId, value] of Object.entries(data)) {
        const field = fieldById.get(fieldId)
        if (!field) {
          fieldErrors[fieldId] = 'Unknown field'
          continue
        }
        if (field.hidden) {
          fieldErrors[fieldId] = 'Field is hidden'
          continue
        }
        if (hiddenFieldIds.has(fieldId)) {
          fieldErrors[fieldId] = 'Field is not available in this form'
          continue
        }
        if (field.readOnly === true || field.type === 'lookup' || field.type === 'rollup') {
          fieldErrors[fieldId] = 'Field is readonly'
          continue
        }

        if (field.type === 'select') {
          if (typeof value !== 'string') {
            fieldErrors[fieldId] = 'Select value must be a string'
            continue
          }
          const allowed = new Set(field.options ?? [])
          if (value !== '' && !allowed.has(value)) {
            fieldErrors[fieldId] = 'Invalid select option'
            continue
          }
        }

        if (field.type === 'link') {
          if (!field.link) {
            fieldErrors[fieldId] = 'Link field is missing foreign sheet configuration'
            continue
          }
          const ids = normalizeLinkIds(value)
          if (field.link.limitSingleRecord && ids.length > 1) {
            fieldErrors[fieldId] = 'Only one linked record is allowed'
            continue
          }
          const tooLong = ids.find((id) => id.length > 50)
          if (tooLong) {
            fieldErrors[fieldId] = `Link id too long: ${tooLong}`
            continue
          }
          if (ids.length > 0) {
            const exists = await pool.query(
              'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
              [field.link.foreignSheetId, ids],
            )
            const found = new Set((exists.rows as any[]).map((row: any) => String(row.id)))
            const missing = ids.filter((id) => !found.has(id))
            if (missing.length > 0) {
              fieldErrors[fieldId] = `Linked record not found: ${missing.join(', ')}`
              continue
            }
          }
          patch[fieldId] = ids
          linkUpdates.set(fieldId, { ids, cfg: field.link })
          continue
        }

        if (field.type === 'attachment') {
          const ids = normalizeAttachmentIds(value)
          const tooLong = ids.find((id) => id.length > 100)
          if (tooLong) {
            fieldErrors[fieldId] = `Attachment id too long: ${tooLong}`
            continue
          }
          const attachmentError = await ensureAttachmentIdsExist(pool.query.bind(pool), view.sheetId, fieldId, ids)
          if (attachmentError) {
            fieldErrors[fieldId] = attachmentError
            continue
          }
          patch[fieldId] = ids
          continue
        }

        if (field.type === 'formula') {
          if (typeof value !== 'string') {
            fieldErrors[fieldId] = 'Formula value must be a string'
            continue
          }
          if (value !== '' && !value.startsWith('=')) {
            fieldErrors[fieldId] = 'Formula must start with ='
            continue
          }
        }

        patch[fieldId] = value
      }

      if (Object.keys(fieldErrors).length > 0) {
        const hiddenOnly = Object.values(fieldErrors).every((message) => message === 'Field is hidden')
        const readonlyOnly = Object.values(fieldErrors).every((message) => message === 'Field is readonly')
        return res.status(hiddenOnly || readonlyOnly ? 403 : 400).json({
          ok: false,
          error: {
            code: hiddenOnly ? 'FIELD_HIDDEN' : readonlyOnly ? 'FIELD_READONLY' : 'VALIDATION_ERROR',
            message: hiddenOnly ? 'Hidden field update rejected' : readonlyOnly ? 'Readonly field update rejected' : 'Validation failed',
            fieldErrors,
          },
        })
      }

      const recordId = parsed.data.recordId
      let resultRecordId = recordId ?? buildId('rec')
      let nextVersion = 1

      await pool.transaction(async ({ query }) => {
        if (recordId) {
          const currentRes = await query(
            'SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
            [recordId, view.sheetId],
          )
          if ((currentRes as any).rows.length === 0) {
            throw new NotFoundError(`Record not found: ${recordId}`)
          }
          const currentRow: any = (currentRes as any).rows[0]
          if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, typeof currentRow?.created_by === 'string' ? currentRow.created_by : null, 'edit')) {
            throw new ValidationError('Record editing is not allowed for this row')
          }
          const serverVersion = Number(currentRow?.version ?? 1)
          if (typeof parsed.data.expectedVersion === 'number' && parsed.data.expectedVersion !== serverVersion) {
            throw new VersionConflictError(recordId, serverVersion)
          }

          if (Object.keys(patch).length > 0) {
            const updateRes = await query(
              `UPDATE meta_records
               SET data = data || $1::jsonb, updated_at = now(), version = version + 1
               WHERE id = $2 AND sheet_id = $3
               RETURNING version`,
              [JSON.stringify(patch), recordId, view.sheetId],
            )
            nextVersion = Number((updateRes as any).rows[0]?.version ?? serverVersion)
          } else {
            nextVersion = serverVersion
          }

          for (const [fieldId, { ids }] of linkUpdates.entries()) {
            const currentLinks = await query(
              'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
              [fieldId, recordId],
            )
            const existingIds = (currentLinks as any).rows.map((row: any) => String(row.foreign_record_id))
            const existing = new Set(existingIds)
            const next = new Set(ids)
            const toDelete = existingIds.filter((id) => !next.has(id))
            const toInsert = ids.filter((id) => !existing.has(id))

            if (toDelete.length > 0) {
              await query(
                'DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])',
                [fieldId, recordId, toDelete],
              )
            }
            for (const foreignId of toInsert) {
              await query(
                `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT DO NOTHING`,
                [buildId('lnk').slice(0, 50), fieldId, recordId, foreignId],
              )
            }
            if (ids.length === 0) {
              await query('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [fieldId, recordId])
            }
          }
          return
        }

        const insertRes = await query(
          `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
           VALUES ($1, $2, $3::jsonb, 1, $4)
           RETURNING id, version`,
          [resultRecordId, view.sheetId, JSON.stringify(patch), getRequestActorId(req)],
        )
        resultRecordId = String((insertRes as any).rows[0]?.id ?? resultRecordId)
        nextVersion = Number((insertRes as any).rows[0]?.version ?? 1)

        for (const [fieldId, { ids }] of linkUpdates.entries()) {
          for (const foreignId of ids) {
            await query(
              `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [buildId('lnk').slice(0, 50), fieldId, resultRecordId, foreignId],
            )
          }
        }
      })

      const recordRes = await pool.query(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [resultRecordId, view.sheetId],
      )
      const row: any = recordRes.rows[0]
      if (!row) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${resultRecordId}` } })
      }

      const record: UniverMetaRecord = {
        id: String(row.id),
        version: Number(row.version ?? nextVersion),
        data: normalizeJson(row.data),
      }
      const visibleFormFields = fields.filter((field) => !hiddenFieldIds.has(field.id) && !isFieldPermissionHidden(field))
      const visibleFormFieldIds = new Set(visibleFormFields.map((field) => field.id))

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const attachmentFields = visibleFormFields.filter((field) => field.type === 'attachment')
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
      record.data = filterRecordDataByFieldIds(record.data, visibleFormFieldIds)
      const attachmentSummaries = attachmentFields.length > 0
        ? filterSingleRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                view.sheetId,
                [record],
                attachmentFields,
              ),
            )[record.id] ?? {},
            visibleFormFieldIds,
          )
        : undefined

      // Recalculate dependent formula fields after record update
      try {
        const changedFieldIds = Object.keys(patch)
        if (changedFieldIds.length > 0) {
          const depRes = await pool.query(
            `SELECT DISTINCT field_id FROM formula_dependencies
             WHERE (depends_on_field_id = ANY($1::text[]))
               AND (depends_on_sheet_id IS NULL OR depends_on_sheet_id = $2)
               AND sheet_id = $2`,
            [changedFieldIds, view.sheetId],
          )
          if (depRes.rows.length > 0) {
            await multitableFormulaEngine.recalculateRecord(
              pool.query.bind(pool),
              view.sheetId,
              record.id,
              fields,
            )
          }
        }
      } catch (recalcErr) {
        console.error('[univer-meta] formula recalculation failed:', recalcErr)
      }

      publishMultitableSheetRealtime({
        spreadsheetId: view.sheetId,
        actorId: getRequestActorId(req),
        source: 'multitable',
        kind: 'record-updated',
        recordId: record.id,
        recordIds: [record.id],
        fieldIds: Object.keys(patch),
        recordPatches: [{
          recordId: record.id,
          version: record.version,
          patch,
        }],
      })

      return res.json({
        ok: true,
        data: {
          mode: recordId ? 'update' : 'create',
          record,
          ...(attachmentSummaries ? { attachmentSummaries } : {}),
          commentsScope: {
            targetType: 'meta_record',
            targetId: record.id,
            baseId: sheet.baseId ?? null,
            sheetId: sheet.id,
            viewId: view.id,
            recordId: record.id,
            containerType: 'meta_sheet',
            containerId: sheet.id,
          },
        },
      })
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: err.message,
            serverVersion: err.serverVersion,
          },
        })
      }
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] view submit failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to submit multitable view form' } })
    }
  })

  router.patch('/records/:recordId', async (req: Request, res: Response) => {
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }

    const schema = z.object({
      sheetId: z.string().min(1).optional(),
      viewId: z.string().min(1).optional(),
      expectedVersion: z.number().int().nonnegative().optional(),
      data: z.record(z.unknown()).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      let sheetId = parsed.data.sheetId
      if (parsed.data.sheetId || parsed.data.viewId) {
        const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
          sheetId: parsed.data.sheetId,
          viewId: parsed.data.viewId,
        })
        sheetId = resolved.sheetId
      }

      const recordLookup = sheetId
        ? await pool.query('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
        : await pool.query('SELECT id, sheet_id FROM meta_records WHERE id = $1', [recordId])
      const recordRow: any = recordLookup.rows[0]
      if (!recordRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }
      sheetId = String(recordRow.sheet_id)

      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canEditRecord) return sendForbidden(res)

      const fields = await loadFieldsForSheet(pool.query.bind(pool), sheetId)
      const fieldById = buildFieldMutationGuardMap(fields)

      const data = parsed.data.data ?? {}
      const fieldErrors: Record<string, string> = {}
      const patch: Record<string, unknown> = {}
      const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()

      for (const [fieldId, value] of Object.entries(data)) {
        const field = fieldById.get(fieldId)
        if (!field) {
          fieldErrors[fieldId] = 'Unknown field'
          continue
        }
        if (field.hidden) {
          fieldErrors[fieldId] = 'Field is hidden'
          continue
        }
        if (field.readOnly === true || field.type === 'lookup' || field.type === 'rollup') {
          fieldErrors[fieldId] = 'Field is readonly'
          continue
        }
        if (field.type === 'select') {
          if (typeof value !== 'string') {
            fieldErrors[fieldId] = 'Select value must be a string'
            continue
          }
          const allowed = new Set(field.options ?? [])
          if (value !== '' && !allowed.has(value)) {
            fieldErrors[fieldId] = 'Invalid select option'
            continue
          }
        }
        if (field.type === 'link') {
          if (!field.link) {
            fieldErrors[fieldId] = 'Link field is missing foreign sheet configuration'
            continue
          }
          const ids = normalizeLinkIds(value)
          if (field.link.limitSingleRecord && ids.length > 1) {
            fieldErrors[fieldId] = 'Only one linked record is allowed'
            continue
          }
          const tooLong = ids.find((id) => id.length > 50)
          if (tooLong) {
            fieldErrors[fieldId] = `Link id too long: ${tooLong}`
            continue
          }
          if (ids.length > 0) {
            const exists = await pool.query(
              'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
              [field.link.foreignSheetId, ids],
            )
            const found = new Set((exists.rows as any[]).map((row: any) => String(row.id)))
            const missing = ids.filter((id) => !found.has(id))
            if (missing.length > 0) {
              fieldErrors[fieldId] = `Linked record not found: ${missing.join(', ')}`
              continue
            }
          }
          patch[fieldId] = ids
          linkUpdates.set(fieldId, { ids, cfg: field.link })
          continue
        }
        if (field.type === 'attachment') {
          const ids = normalizeAttachmentIds(value)
          const tooLong = ids.find((id) => id.length > 100)
          if (tooLong) {
            fieldErrors[fieldId] = `Attachment id too long: ${tooLong}`
            continue
          }
          const attachmentError = await ensureAttachmentIdsExist(pool.query.bind(pool), sheetId, fieldId, ids)
          if (attachmentError) {
            fieldErrors[fieldId] = attachmentError
            continue
          }
          patch[fieldId] = ids
          continue
        }
        if (field.type === 'formula') {
          if (typeof value !== 'string') {
            fieldErrors[fieldId] = 'Formula value must be a string'
            continue
          }
          if (value !== '' && !value.startsWith('=')) {
            fieldErrors[fieldId] = 'Formula must start with ='
            continue
          }
        }
        patch[fieldId] = value
      }

      if (Object.keys(fieldErrors).length > 0) {
        const hiddenOnly = Object.values(fieldErrors).every((message) => message === 'Field is hidden')
        const readonlyOnly = Object.values(fieldErrors).every((message) => message === 'Field is readonly')
        return res.status(hiddenOnly || readonlyOnly ? 403 : 400).json({
          ok: false,
          error: {
            code: hiddenOnly ? 'FIELD_HIDDEN' : readonlyOnly ? 'FIELD_READONLY' : 'VALIDATION_ERROR',
            message: hiddenOnly ? 'Hidden field update rejected' : readonlyOnly ? 'Readonly field update rejected' : 'Validation failed',
            fieldErrors,
          },
        })
      }

      let nextVersion = 1
      await pool.transaction(async ({ query }) => {
        const currentRes = await query(
          'SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
          [recordId, sheetId],
        )
        if ((currentRes as any).rows.length === 0) {
          throw new NotFoundError(`Record not found: ${recordId}`)
        }
        const currentRow: any = (currentRes as any).rows[0]
        if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, typeof currentRow?.created_by === 'string' ? currentRow.created_by : null, 'edit')) {
          throw new PermissionError('Record editing is not allowed for this row')
        }
        const serverVersion = Number(currentRow?.version ?? 1)
        if (typeof parsed.data.expectedVersion === 'number' && parsed.data.expectedVersion !== serverVersion) {
          throw new VersionConflictError(recordId, serverVersion)
        }

        if (Object.keys(patch).length > 0) {
          const updateRes = await query(
            `UPDATE meta_records
             SET data = data || $1::jsonb, updated_at = now(), version = version + 1
             WHERE id = $2 AND sheet_id = $3
             RETURNING version`,
            [JSON.stringify(patch), recordId, sheetId],
          )
          nextVersion = Number((updateRes as any).rows[0]?.version ?? serverVersion)
        } else {
          nextVersion = serverVersion
        }

        for (const [fieldId, { ids }] of linkUpdates.entries()) {
          const currentLinks = await query(
            'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
            [fieldId, recordId],
          )
          const existingIds = (currentLinks as any).rows.map((row: any) => String(row.foreign_record_id))
          const existing = new Set(existingIds)
          const next = new Set(ids)
          const toDelete = existingIds.filter((id) => !next.has(id))
          const toInsert = ids.filter((id) => !existing.has(id))

          if (toDelete.length > 0) {
            await query(
              'DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])',
              [fieldId, recordId, toDelete],
            )
          }
          for (const foreignId of toInsert) {
            await query(
              `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [buildId('lnk').slice(0, 50), fieldId, recordId, foreignId],
            )
          }
          if (ids.length === 0) {
            await query('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [fieldId, recordId])
          }
        }
      })

      const recordRes = await pool.query(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [recordId, sheetId],
      )
      const row: any = recordRes.rows[0]
      if (!row) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      const record: UniverMetaRecord = {
        id: String(row.id),
        version: Number(row.version ?? nextVersion),
        data: normalizeJson(row.data),
      }
      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      const visiblePropertyFieldIds = new Set(visiblePropertyFields.map((field) => field.id))

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const attachmentFields = visiblePropertyFields.filter((field) => field.type === 'attachment')
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
      record.data = filterRecordDataByFieldIds(record.data, visiblePropertyFieldIds)
      const attachmentSummaries = attachmentFields.length > 0
        ? filterSingleRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                [record],
                attachmentFields,
              ),
            )[record.id] ?? {},
            visiblePropertyFieldIds,
          )
        : undefined

      return res.json({
        ok: true,
        data: {
          record,
          ...(attachmentSummaries ? { attachmentSummaries } : {}),
          commentsScope: {
            targetType: 'meta_record',
            targetId: record.id,
            baseId: sheet.baseId ?? null,
            sheetId: sheet.id,
            viewId: parsed.data.viewId ?? null,
            recordId: record.id,
            containerType: 'meta_sheet',
            containerId: sheet.id,
          },
        },
      })
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: err.message,
            serverVersion: err.serverVersion,
          },
        })
      }
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof PermissionError) {
        return sendForbidden(res, err.message)
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] patch record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to patch meta record' } })
    }
  })

  /**
   * GET /records - Cursor-based paginated record listing.
   *
   * Query params:
   *   sheetId   (required)  - sheet to query
   *   cursor    (optional)  - opaque cursor from previous response
   *   limit     (optional)  - page size (default 100, max 5000)
   *   sortField (optional)  - field id to sort by
   *   sortDir   (optional)  - 'asc' | 'desc'
   *   filter.*  (optional)  - field-level equality filters (e.g. filter.status=active)
   *
   * When `cursor` is absent the first page is returned.
   * When `cursor` is present, offset-based params are ignored.
   */
  router.get('/records', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined
    const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw!, 1), 5000) : 100
    const sortField = typeof req.query.sortField === 'string' ? req.query.sortField.trim() : undefined
    const sortDir = req.query.sortDir === 'desc' ? 'desc' as const : 'asc' as const

    // Collect filter.* query params
    const filter: Record<string, string> = {}
    for (const [key, val] of Object.entries(req.query)) {
      if (key.startsWith('filter.') && typeof val === 'string') {
        filter[key.slice(7)] = val
      }
    }

    try {
      const pool = poolManager.get()

      // Check cache first
      const sort = sortField ? { fieldId: sortField, direction: sortDir } : undefined
      const cacheKey = buildRecordsCacheKey(sheetId, { filter, sort, cursor })
      const cached = getRecordsCache(cacheKey)
      if (cached) {
        return res.json(cached)
      }

      const result: CursorPaginatedResult<LoadedMultitableRecord> = await queryRecordsWithCursor({
        query: pool.query.bind(pool),
        sheetId,
        cursor: cursor || undefined,
        limit,
        sort,
        filter,
      })

      const body = {
        ok: true,
        data: {
          records: result.items.map((r) => ({ id: r.id, version: r.version, data: r.data })),
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        },
      }
      setRecordsCache(cacheKey, body)
      return res.json(body)
    } catch (err: any) {
      if (err?.code === 'VALIDATION_ERROR') {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err?.code === 'NOT_FOUND') {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] cursor records query failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to query records' } })
    }
  })

  router.get('/records/:recordId', async (req: Request, res: Response) => {
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    const sheetIdParam = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : undefined
    const viewIdParam = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : undefined
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }

    try {
      const pool = poolManager.get()
      let sheetId = sheetIdParam
      let viewConfig: UniverMetaViewConfig | null = null
      if (sheetIdParam || viewIdParam) {
        const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
          sheetId: sheetIdParam,
          viewId: viewIdParam,
        })
        sheetId = resolved.sheetId
        viewConfig = resolved.view
      }

      const recordRes = sheetId
        ? await pool.query(
          'SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordId, sheetId],
        )
        : await pool.query(
          'SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1',
          [recordId],
        )
      const row: any = recordRes.rows[0]
      if (!row) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      sheetId = String(row.sheet_id)
      const { access, capabilities, capabilityOrigin, sheetScope } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const fields = await loadFieldsForSheet(pool.query.bind(pool), sheetId)
      const record: UniverMetaRecord = {
        id: String(row.id),
        version: Number(row.version ?? 1),
        data: normalizeJson(row.data),
        createdBy: typeof row.created_by === 'string' ? row.created_by : null,
      }

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
      await applyLookupRollup(req, pool.query.bind(pool), fields, [record], relationalLinkFields, linkValuesByRecord)
      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      const visiblePropertyFieldIds = new Set(visiblePropertyFields.map((field) => field.id))
      record.data = filterRecordDataByFieldIds(record.data, visiblePropertyFieldIds)
      const linkSummaries = filterSingleRecordFieldSummaryMap(
        Object.fromEntries(
          Array.from((await buildLinkSummaries(req, pool.query.bind(pool), [record], relationalLinkFields, linkValuesByRecord)).get(record.id)?.entries() ?? []),
        ),
        visiblePropertyFieldIds,
      )
      const attachmentSummaries = visiblePropertyFields.some((field) => field.type === 'attachment')
        ? filterSingleRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                [record],
                visiblePropertyFields.filter((field) => field.type === 'attachment'),
              ),
            )[record.id] ?? {},
            visiblePropertyFieldIds,
          )
        : undefined

      const fieldScopeMap = access.userId ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId) : new Map()
      const viewScopeMap = (access.userId && viewConfig) ? await loadViewPermissionScopeMap(pool.query.bind(pool), [viewConfig.id], access.userId) : new Map()
      const fieldPermissions = deriveFieldPermissions(fields, capabilities, {
        hiddenFieldIds: viewConfig?.hiddenFieldIds ?? [],
        fieldScopeMap,
      })
      const viewPermissions = viewConfig ? deriveViewPermissions([viewConfig], capabilities, viewScopeMap) : {}
      const rowActions = deriveRecordRowActions(capabilities, sheetScope, access, record.createdBy)

      return res.json({
        ok: true,
        data: {
          sheet,
          ...(viewConfig ? { view: viewConfig } : {}),
          fields: visiblePropertyFields,
          record,
          capabilities,
          capabilityOrigin,
          fieldPermissions,
          ...(viewConfig ? { viewPermissions } : {}),
          rowActions,
          commentsScope: {
            targetType: 'meta_record',
            targetId: record.id,
            baseId: sheet.baseId ?? null,
            sheetId: sheet.id,
            viewId: viewConfig?.id ?? null,
            recordId: record.id,
            containerType: 'meta_sheet',
            containerId: sheet.id,
          },
          linkSummaries,
          ...(attachmentSummaries ? { attachmentSummaries } : {}),
        },
      })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] record context failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load record context' } })
    }
  })

  /**
   * GET /records-summary - Lightweight record summaries for Link selector
   *
   * Query params:
   *   - sheetId (required): target sheet to query
   *   - displayFieldId (optional): field ID to use for display value; if not provided, first string field is used
   *   - search (optional): case-insensitive substring filter on display value
   *   - limit (optional): max records to return (default 50, max 200)
   *   - offset (optional): pagination offset (default 0)
   *
   * Returns: { ok: true, data: { records: [{id, display}], page: {offset, limit, total, hasMore} } }
   */
  router.get('/records-summary', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    const displayFieldId = typeof req.query.displayFieldId === 'string' ? req.query.displayFieldId.trim() : null
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : ''
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50
    const offsetParam = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50
    const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0

    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()

      // Verify sheet exists
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { access, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)

      const summary = await loadRecordSummaries(pool.query.bind(pool), sheetId, {
        displayFieldId,
        search,
        limit,
        offset,
      })

      return res.json({
        ok: true,
        data: {
          records: summary.records,
          displayMap: summary.displayMap,
          page: summary.page,
        },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] records-summary failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load records summary' } })
    }
  })

  router.get('/fields/:fieldId/link-options', async (req: Request, res: Response) => {
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId.trim() : ''
    const recordId = typeof req.query.recordId === 'string' ? req.query.recordId.trim() : undefined
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : ''
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
    const offsetParam = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 20
    const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0

    if (!fieldId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'fieldId is required' } })
    }

    try {
      const pool = poolManager.get()
      const fieldRes = await pool.query(
        'SELECT id, sheet_id, name, type, property FROM meta_fields WHERE id = $1',
        [fieldId],
      )
      const fieldRow: any = fieldRes.rows[0]
      if (!fieldRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${fieldId}` } })
      }
      const field = serializeFieldRow(fieldRow)
      if (field.type !== 'link') {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: `Field is not a link field: ${fieldId}` } })
      }
      const { access: sourceAccess, capabilities: sourceCapabilities } = await resolveSheetReadableCapabilities(
        req,
        pool.query.bind(pool),
        String(fieldRow.sheet_id),
      )
      if (!sourceAccess.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!sourceCapabilities.canRead) return sendForbidden(res)

      const linkConfig = parseLinkFieldConfig(field.property)
      if (!linkConfig) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: `Link field is missing foreignSheetId: ${fieldId}` } })
      }

      const targetSheet = await loadSheetRow(pool.query.bind(pool), linkConfig.foreignSheetId)
      if (!targetSheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Target sheet not found: ${linkConfig.foreignSheetId}` } })
      }
      const { capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), linkConfig.foreignSheetId)
      if (!capabilities.canRead) return sendForbidden(res)

      let selected: LinkedRecordSummary[] = []
      if (recordId) {
        const sourceRecordRes = await pool.query(
          'SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordId, String(fieldRow.sheet_id)],
        )
        if (sourceRecordRes.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
        }

        const linkValuesByRecord = await loadLinkValuesByRecord(
          pool.query.bind(pool),
          [recordId],
          [{ fieldId, cfg: linkConfig }],
        )
        const linkSummaries = await buildLinkSummaries(
          req,
          pool.query.bind(pool),
          [{ id: recordId, version: 0, data: {} }],
          [{ fieldId, cfg: linkConfig }],
          linkValuesByRecord,
        )
        selected = linkSummaries.get(recordId)?.get(fieldId) ?? []
      }

      const summary = await loadRecordSummaries(pool.query.bind(pool), linkConfig.foreignSheetId, {
        search,
        limit,
        offset,
      })

      return res.json({
        ok: true,
        data: {
          field: {
            id: field.id,
            name: field.name,
            type: field.type,
          },
          targetSheet,
          selected,
          records: summary.records,
          page: summary.page,
        },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] link-options failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load link options' } })
    }
  })

  router.post('/attachments', async (req: Request, res: Response) => {
    try {
      if (!multitableUpload) {
        return res.status(500).json({ ok: false, error: { code: 'UPLOAD_UNAVAILABLE', message: 'Attachment upload not available - multer not installed' } })
      }

      multitableUpload.single('file')(req, res, async (uploadErr: unknown) => {
        if (uploadErr) {
          return res.status(400).json({ ok: false, error: { code: 'UPLOAD_FAILED', message: String(uploadErr) } })
        }

        const multerReq = req as RequestWithFile
        const file = multerReq.file
        if (!file) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No file provided. Use "file" as the form field name.' } })
        }

        const sheetId = typeof req.body.sheetId === 'string' ? req.body.sheetId.trim() : ''
        const recordId = typeof req.body.recordId === 'string' && req.body.recordId.trim().length > 0 ? req.body.recordId.trim() : null
        const fieldId = typeof req.body.fieldId === 'string' && req.body.fieldId.trim().length > 0 ? req.body.fieldId.trim() : null
        if (!sheetId) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
        }

        const pool = poolManager.get()
        try {
          const sheetRes = await pool.query(
            'SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
            [sheetId],
          )
          if (sheetRes.rows.length === 0) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
          }
          const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
          if (!capabilities.canEditRecord) return sendForbidden(res)

          if (fieldId) {
            const fieldRes = await pool.query(
              'SELECT id, type FROM meta_fields WHERE id = $1 AND sheet_id = $2',
              [fieldId, sheetId],
            )
            const fieldRow: any = fieldRes.rows[0]
            if (!fieldRow) {
              return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${fieldId}` } })
            }
            if (mapFieldType(String(fieldRow.type ?? 'string')) !== 'attachment') {
              return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: `Field is not an attachment field: ${fieldId}` } })
            }
          }

          if (recordId) {
            const recordRes = await pool.query(
              'SELECT id, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
              [recordId, sheetId],
            )
            const recordRow: any = recordRes.rows[0]
            if (!recordRow) {
              return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
            }
            if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, typeof recordRow?.created_by === 'string' ? recordRow.created_by : null, 'edit')) {
              return sendForbidden(res, 'Record editing is not allowed for this row')
            }
          }

          const storage = getAttachmentStorageService()
          const extension = path.extname(file.originalname || '')
          const storageFilename = `${randomUUID()}${extension}`
          const userId = req.user?.sub || req.user?.userId || req.user?.id || 'anonymous'
          const uploaded = await storage.upload(file.buffer, {
            filename: storageFilename,
            contentType: file.mimetype,
            path: path.join(sheetId, fieldId ?? 'unassigned'),
            metadata: {
              originalName: file.originalname,
              sheetId,
              ...(recordId ? { recordId } : {}),
              ...(fieldId ? { fieldId } : {}),
            },
          })

          try {
            const attachmentId = buildId('att').slice(0, 50)
            const insert = await pool.query(
              `INSERT INTO multitable_attachments
                 (id, sheet_id, record_id, field_id, storage_file_id, filename, original_name, mime_type, size, storage_path, storage_provider, metadata, created_by)
               VALUES
                 ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
               RETURNING id, filename, original_name, mime_type, size, created_at`,
              [
                attachmentId,
                sheetId,
                recordId,
                fieldId,
                uploaded.id,
                file.originalname || storageFilename,
                file.originalname || null,
                file.mimetype || 'application/octet-stream',
                file.size,
                uploaded.path,
                'local',
                JSON.stringify({
                  storageFileId: uploaded.id,
                  storageUrl: uploaded.url,
                }),
                userId,
              ],
            )
            const attachmentRow = (insert.rows as any[])[0]
            return res.status(201).json({
              ok: true,
              data: {
                attachment: serializeAttachmentRow(req, attachmentRow),
              },
            })
          } catch (dbErr) {
            try {
              await storage.delete(uploaded.id)
            } catch {
              // best-effort cleanup after DB failure
            }
            throw dbErr
          }
        } catch (err) {
          if (err instanceof ValidationError) {
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
          }
          if (err instanceof NotFoundError) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
          }
          const hint = getDbNotReadyMessage(err)
          if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
          console.error('[univer-meta] attachment upload failed:', err)
          return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to upload attachment' } })
        }
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] attachment middleware failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to upload attachment' } })
    }
  })

  router.get('/attachments/:attachmentId', async (req: Request, res: Response) => {
    const attachmentId = typeof req.params.attachmentId === 'string' ? req.params.attachmentId.trim() : ''
    if (!attachmentId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'attachmentId is required' } })
    }

    try {
      const pool = poolManager.get()
      const attachmentRes = await pool.query(
        `SELECT id, sheet_id, storage_file_id, filename, original_name, mime_type, size
         FROM multitable_attachments
         WHERE id = $1 AND deleted_at IS NULL`,
        [attachmentId],
      )
      const row: any = attachmentRes.rows[0]
      if (!row) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Attachment not found: ${attachmentId}` } })
      }
      const sheetId = typeof row.sheet_id === 'string' ? row.sheet_id : ''
      if (sheetId) {
        const { access, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
        if (!access.userId) {
          return res.status(401).json({ error: 'Authentication required' })
        }
        if (!capabilities.canRead) return sendForbidden(res)
      }

      const storage = getAttachmentStorageService()
      const buffer = await storage.download(String(row.storage_file_id))
      const mimeType = typeof row.mime_type === 'string' ? row.mime_type : 'application/octet-stream'
      const fileName = typeof row.filename === 'string' ? row.filename : typeof row.original_name === 'string' ? row.original_name : attachmentId
      const forceInline = req.query.thumbnail === 'true' || isImageMimeType(mimeType)

      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Disposition', `${forceInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`)
      res.setHeader('Content-Length', buffer.length)
      return res.send(buffer)
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] attachment download failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to download attachment' } })
    }
  })

  router.delete('/attachments/:attachmentId', async (req: Request, res: Response) => {
    const attachmentId = typeof req.params.attachmentId === 'string' ? req.params.attachmentId.trim() : ''
    if (!attachmentId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'attachmentId is required' } })
    }

    try {
      const pool = poolManager.get()
      let updatedRecordRealtimeScope: {
        sheetId: string
        recordId: string
        fieldId: string
        version: number
        patch: Record<string, unknown>
      } | null = null
      const attachmentRes = await pool.query(
        `SELECT id, sheet_id, record_id, field_id, storage_file_id, created_by
         FROM multitable_attachments
         WHERE id = $1 AND deleted_at IS NULL`,
        [attachmentId],
      )
      const attachmentRow: any = attachmentRes.rows[0]
      if (!attachmentRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Attachment not found: ${attachmentId}` } })
      }
      const access = await resolveRequestAccess(req)
      const sheetCapabilities = await resolveSheetCapabilities(req, pool.query.bind(pool), String(attachmentRow.sheet_id))
      if (!sheetCapabilities.capabilities.canEditRecord) return sendForbidden(res)
      if (typeof attachmentRow.record_id === 'string' && attachmentRow.record_id) {
        const creatorMap = await loadRecordCreatorMap(
          pool.query.bind(pool),
          String(attachmentRow.sheet_id),
          [String(attachmentRow.record_id)],
        )
        if (!ensureRecordWriteAllowed(
          sheetCapabilities.capabilities,
          sheetCapabilities.sheetScope,
          access,
          creatorMap.get(String(attachmentRow.record_id)),
          'edit',
        )) return sendForbidden(res, 'Record editing is not allowed for this row')
      } else if (!ensureRecordWriteAllowed(
        sheetCapabilities.capabilities,
        sheetCapabilities.sheetScope,
        access,
        typeof attachmentRow.created_by === 'string' ? attachmentRow.created_by : null,
        'edit',
      )) {
        return sendForbidden(res, 'Attachment deletion is not allowed for this draft attachment')
      }

      await pool.transaction(async ({ query }) => {
        const recordId = typeof attachmentRow.record_id === 'string' ? attachmentRow.record_id : null
        const fieldId = typeof attachmentRow.field_id === 'string' ? attachmentRow.field_id : null
        const sheetId = String(attachmentRow.sheet_id)

        if (recordId && fieldId) {
          const recordRes = await query(
            'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
            [recordId, sheetId],
          )
          const recordRow: any = recordRes.rows[0]
          if (recordRow) {
            const data = normalizeJson(recordRow.data)
            const currentIds = normalizeAttachmentIds(data[fieldId])
            const nextIds = currentIds.filter((id) => id !== attachmentId)
            if (nextIds.length !== currentIds.length) {
              const updateRes = await query(
                `UPDATE meta_records
                 SET data = data || $1::jsonb, updated_at = now(), version = version + 1
                 WHERE id = $2 AND sheet_id = $3
                 RETURNING version`,
                [JSON.stringify({ [fieldId]: nextIds }), recordId, sheetId],
              )
              updatedRecordRealtimeScope = {
                sheetId,
                recordId,
                fieldId,
                version: Number((updateRes.rows[0] as any)?.version ?? Number(recordRow?.version ?? 0) + 1),
                patch: { [fieldId]: nextIds },
              }
            }
          }
        }

        await query(
          'UPDATE multitable_attachments SET deleted_at = now(), updated_at = now() WHERE id = $1',
          [attachmentId],
        )
      })

      const storage = getAttachmentStorageService()
      try {
        await storage.delete(String(attachmentRow.storage_file_id))
      } catch {
        // best-effort storage cleanup
      }

      if (updatedRecordRealtimeScope) {
        publishMultitableSheetRealtime({
          spreadsheetId: updatedRecordRealtimeScope.sheetId,
          actorId: getRequestActorId(req),
          source: 'multitable',
          kind: 'attachment-updated',
          recordId: updatedRecordRealtimeScope.recordId,
          recordIds: [updatedRecordRealtimeScope.recordId],
          fieldIds: [updatedRecordRealtimeScope.fieldId],
          recordPatches: [{
            recordId: updatedRecordRealtimeScope.recordId,
            version: updatedRecordRealtimeScope.version,
            patch: updatedRecordRealtimeScope.patch,
          }],
        })
      }

      return res.json({ ok: true, data: { deleted: attachmentId } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] attachment delete failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete attachment' } })
    }
  })

  router.post('/records', async (req: Request, res: Response) => {
    const schema = z.object({
      viewId: z.string().min(1).optional(),
      sheetId: z.string().min(1).optional(),
      data: z.record(z.unknown()).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const data = parsed.data.data ?? {}

    try {
      const pool = poolManager.get()
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: parsed.data.sheetId,
        viewId: parsed.data.viewId,
      })
      const sheetId = resolved.sheetId

      const sheetRes = await pool.query(
        'SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
        [sheetId],
      )
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { access, capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canCreateRecord) return sendForbidden(res)

      const fieldRes = await pool.query(
        'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1',
        [sheetId],
      )
      if (fieldRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const fieldById = new Map<string, { type: UniverMetaField['type']; options?: string[]; link?: LinkFieldConfig | null }>()
      for (const f of fieldRes.rows as any[]) {
        const type = mapFieldType(String(f.type ?? 'string'))
        if (type === 'select') {
          const options = extractSelectOptions(f.property)?.map(o => o.value) ?? []
          fieldById.set(String(f.id), { type, options })
          continue
        }
        if (type === 'link') {
          fieldById.set(String(f.id), { type, link: parseLinkFieldConfig(f.property) })
          continue
        }
        fieldById.set(String(f.id), { type })
      }

      const patch: Record<string, unknown> = {}
      const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()
      for (const [fieldId, value] of Object.entries(data)) {
        const field = fieldById.get(fieldId)
        if (!field) {
          return res.status(400).json({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: `Unknown fieldId: ${fieldId}` },
          })
        }

        if (field.type === 'lookup' || field.type === 'rollup') {
          return res.status(403).json({
            ok: false,
            error: { code: 'FIELD_READONLY', message: `Field is readonly: ${fieldId}` },
          })
        }

        if (field.type === 'select') {
          if (typeof value !== 'string') {
            return res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: `Select value must be string: ${fieldId}` },
            })
          }
          const allowed = new Set(field.options ?? [])
          if (value !== '' && !allowed.has(value)) {
            return res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: `Invalid select option for ${fieldId}: ${value}` },
            })
          }
        }

        if (field.type === 'link') {
          if (field.link) {
            const ids = normalizeLinkIds(value)
            if (field.link.limitSingleRecord && ids.length > 1) {
              return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION_ERROR', message: `Link field only allows a single record: ${fieldId}` },
              })
            }
            const tooLong = ids.find((id) => id.length > 50)
            if (tooLong) {
              return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION_ERROR', message: `Link id too long (>50): ${tooLong}` },
              })
            }

            if (ids.length > 0) {
              const exists = await pool.query(
                'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
                [field.link.foreignSheetId, ids],
              )
              const found = new Set((exists as any).rows.map((r: any) => String(r.id)))
              const missing = ids.filter((id) => !found.has(id))
              if (missing.length > 0) {
                return res.status(400).json({
                  ok: false,
                  error: {
                    code: 'VALIDATION_ERROR',
                    message: `Linked record(s) not found in sheet ${field.link.foreignSheetId}: ${missing.join(', ')}`,
                  },
                })
              }
            }

            patch[fieldId] = ids
            linkUpdates.set(fieldId, { ids, cfg: field.link })
            continue
          }

          if (typeof value !== 'string') {
            return res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: `Link value must be string: ${fieldId}` },
            })
          }
        }

        if (field.type === 'attachment') {
          const ids = normalizeAttachmentIds(value)
          const tooLong = ids.find((id) => id.length > 100)
          if (tooLong) {
            return res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: `Attachment id too long: ${tooLong}` },
            })
          }
          const attachmentError = await ensureAttachmentIdsExist(pool.query.bind(pool), sheetId, fieldId, ids)
          if (attachmentError) {
            return res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: attachmentError },
            })
          }
          patch[fieldId] = ids
          continue
        }

        if (field.type === 'formula') {
          if (typeof value !== 'string') continue
          if (value !== '' && !value.startsWith('=')) continue
        }

        patch[fieldId] = value
      }

      const recordId = `rec_${randomUUID()}`
      const recordRes = await pool.transaction(async ({ query }) => {
        const inserted = await query(
          `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
           VALUES ($1, $2, $3::jsonb, 1, $4)
           RETURNING version`,
          [recordId, sheetId, JSON.stringify(patch), getRequestActorId(req)],
        )

        if (linkUpdates.size > 0) {
          for (const [fieldId, { ids }] of linkUpdates.entries()) {
            for (const foreignId of ids) {
              await query(
                `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT DO NOTHING`,
                [buildId('lnk').slice(0, 50), fieldId, recordId, foreignId],
              )
            }
          }
        }

        return inserted
      })

      const version = Number((recordRes.rows[0] as any)?.version ?? 1)
      publishMultitableSheetRealtime({
        spreadsheetId: sheetId,
        actorId: getRequestActorId(req),
        source: 'multitable',
        kind: 'record-created',
        recordId,
        recordIds: [recordId],
        fieldIds: Object.keys(patch),
        recordPatches: [{
          recordId,
          version,
          patch,
        }],
      })
      return res.json({ ok: true, data: { record: { id: recordId, version, data: patch } } })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create meta record' } })
    }
  })

  router.delete('/records/:recordId', async (req: Request, res: Response) => {
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId : ''
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }

    const expectedRaw = typeof req.query.expectedVersion === 'string' ? Number.parseInt(req.query.expectedVersion, 10) : Number.NaN
    const expectedVersion = Number.isFinite(expectedRaw) ? expectedRaw : undefined

    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      let deletedSheetId: string | null = null
      const recordRes = await pool.query('SELECT id, sheet_id, created_by FROM meta_records WHERE id = $1', [recordId])
      if (recordRes.rows.length === 0) {
        throw new NotFoundError(`Record not found: ${recordId}`)
      }
      deletedSheetId = typeof (recordRes.rows[0] as any)?.sheet_id === 'string' ? String((recordRes.rows[0] as any).sheet_id) : null
      if (deletedSheetId) {
        const { capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), deletedSheetId)
        if (!capabilities.canDeleteRecord) return sendForbidden(res)
        if (!ensureRecordWriteAllowed(
          capabilities,
          sheetScope,
          access,
          typeof (recordRes.rows[0] as any)?.created_by === 'string' ? String((recordRes.rows[0] as any).created_by) : null,
          'delete',
        )) return sendForbidden(res, 'Record deletion is not allowed for this row')
      }
      await pool.transaction(async ({ query }) => {
        const recordRes = await query('SELECT id, sheet_id, version FROM meta_records WHERE id = $1 FOR UPDATE', [recordId])
        if ((recordRes as any).rows.length === 0) {
          throw new NotFoundError(`Record not found: ${recordId}`)
        }

        const currentRow: any = (recordRes as any).rows[0]
        deletedSheetId = typeof currentRow?.sheet_id === 'string' ? currentRow.sheet_id : null
        const serverVersion = Number(currentRow?.version ?? 1)
        if (typeof expectedVersion === 'number' && expectedVersion !== serverVersion) {
          throw new VersionConflictError(recordId, serverVersion)
        }

        try {
          await query('DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1', [recordId])
        } catch (err) {
          if (!isUndefinedTableError(err, 'meta_links')) throw err
        }

        await query('DELETE FROM meta_records WHERE id = $1', [recordId])
      })

      if (deletedSheetId) {
        publishMultitableSheetRealtime({
          spreadsheetId: deletedSheetId,
          actorId: getRequestActorId(req),
          source: 'multitable',
          kind: 'record-deleted',
          recordId,
          recordIds: [recordId],
        })
      }

      return res.json({ ok: true, data: { deleted: recordId } })
    } catch (err) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof VersionConflictError) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: err.message,
            serverVersion: err.serverVersion,
          },
        })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete record' } })
    }
  })

  router.post('/patch', async (req: Request, res: Response) => {
    const schema = z.object({
      viewId: z.string().min(1).optional(),
      sheetId: z.string().min(1).optional(),
      changes: z.array(z.object({
        recordId: z.string().min(1),
        fieldId: z.string().min(1),
        value: z.unknown(),
        expectedVersion: z.number().int().nonnegative().optional(),
      })).min(1),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: parsed.data.sheetId,
        viewId: parsed.data.viewId,
      })
      const sheetId = resolved.sheetId
      const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canEditRecord) return sendForbidden(res)

      const fieldRes = await pool.query(
        'SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1',
        [sheetId],
      )
      if (fieldRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const fields = (fieldRes.rows as any[]).map(serializeFieldRow)
      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      const visiblePropertyFieldIds = new Set(visiblePropertyFields.map((field) => field.id))
      const attachmentFields = visiblePropertyFields.filter((field) => field.type === 'attachment')
      const fieldById = buildFieldMutationGuardMap(fields)

      const changesByRecord = new Map<string, typeof parsed.data.changes>()
      for (const change of parsed.data.changes) {
        const list = changesByRecord.get(change.recordId)
        if (list) list.push(change)
        else changesByRecord.set(change.recordId, [change])
      }

      for (const [recordId, changes] of changesByRecord.entries()) {
        const expectedVersions = Array.from(new Set(changes.map(c => c.expectedVersion).filter((v): v is number => typeof v === 'number')))
        if (expectedVersions.length > 1) {
          return res.status(400).json({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: `Multiple expectedVersion values provided for ${recordId}` },
          })
        }

        for (const change of changes) {
          const field = fieldById.get(change.fieldId)
          if (!field) {
            return res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: `Unknown fieldId: ${change.fieldId}` },
            })
          }

          if (field.hidden) {
            return res.status(403).json({
              ok: false,
              error: { code: 'FIELD_HIDDEN', message: `Field is hidden: ${change.fieldId}` },
            })
          }

          // P0.3: Field-level readonly permission check
          if (field.readOnly === true) {
            return res.status(403).json({
              ok: false,
              error: { code: 'FIELD_READONLY', message: `Field is readonly: ${change.fieldId}` },
            })
          }

          if (field.type === 'lookup' || field.type === 'rollup') {
            return res.status(403).json({
              ok: false,
              error: { code: 'FIELD_READONLY', message: `Field is readonly: ${change.fieldId}` },
            })
          }

          if (field.type === 'select') {
            if (typeof change.value !== 'string') {
              return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION_ERROR', message: `Select value must be string: ${change.fieldId}` },
              })
            }
            const allowed = new Set(field.options ?? [])
            if (change.value !== '' && !allowed.has(change.value)) {
              return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION_ERROR', message: `Invalid select option for ${change.fieldId}: ${change.value}` },
              })
            }
          }

          if (field.type === 'link') {
            if (field.link) {
              const ids = normalizeLinkIds(change.value)
              if (field.link.limitSingleRecord && ids.length > 1) {
                return res.status(400).json({
                  ok: false,
                  error: { code: 'VALIDATION_ERROR', message: `Link field only allows a single record: ${change.fieldId}` },
                })
              }
              const tooLong = ids.find((id) => id.length > 50)
              if (tooLong) {
                return res.status(400).json({
                  ok: false,
                  error: { code: 'VALIDATION_ERROR', message: `Link id too long (>50): ${tooLong}` },
                })
              }
            } else if (typeof change.value !== 'string') {
              return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION_ERROR', message: `Link value must be string: ${change.fieldId}` },
              })
            }
          }

          if (field.type === 'attachment') {
            const ids = normalizeAttachmentIds(change.value)
            const tooLong = ids.find((id) => id.length > 100)
            if (tooLong) {
              return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION_ERROR', message: `Attachment id too long: ${tooLong}` },
              })
            }
            const attachmentError = await ensureAttachmentIdsExist(pool.query.bind(pool), sheetId, change.fieldId, ids)
            if (attachmentError) {
              return res.status(400).json({
                ok: false,
                error: { code: 'VALIDATION_ERROR', message: attachmentError },
              })
            }
          }
        }
      }

      const updates = await pool.transaction(async ({ query }) => {
        const updated: Array<{ recordId: string; version: number }> = []

        for (const [recordId, changes] of changesByRecord.entries()) {
          const expectedVersion = Array.from(new Set(changes.map(c => c.expectedVersion).filter((v): v is number => typeof v === 'number')))[0]
          const recordRes = await query(
            'SELECT id, version, created_by FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE',
            [sheetId, recordId],
          )
          if (recordRes.rows.length === 0) {
            throw new NotFoundError(`Record not found: ${recordId}`)
          }
          const recordRow: any = recordRes.rows[0]
          if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, typeof recordRow?.created_by === 'string' ? recordRow.created_by : null, 'edit')) {
            throw new ValidationError(`Record editing is not allowed for ${recordId}`)
          }
          const serverVersion = Number(recordRow?.version ?? 1)
          if (typeof expectedVersion === 'number' && expectedVersion !== serverVersion) {
            throw new VersionConflictError(recordId, serverVersion)
          }

          const patch: Record<string, unknown> = {}
          const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()
          let applied = 0
          for (const change of changes) {
            const field = fieldById.get(change.fieldId)
            if (!field) continue

            if (field.type === 'formula') {
              if (typeof change.value !== 'string') continue
              if (change.value !== '' && !change.value.startsWith('=')) continue
            }

            if (field.type === 'link' && field.link) {
              const ids = normalizeLinkIds(change.value)
              patch[change.fieldId] = ids
              linkUpdates.set(change.fieldId, { ids, cfg: field.link })
              applied += 1
              continue
            }

            if (field.type === 'attachment') {
              patch[change.fieldId] = normalizeAttachmentIds(change.value)
              applied += 1
              continue
            }

            patch[change.fieldId] = change.value
            applied += 1
          }

          if (applied === 0) continue

          for (const { ids, cfg } of linkUpdates.values()) {
            if (ids.length === 0) continue
            const exists = await query(
              'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
              [cfg.foreignSheetId, ids],
            )
            const found = new Set((exists as any).rows.map((r: any) => String(r.id)))
            const missing = ids.filter((id) => !found.has(id))
            if (missing.length > 0) {
              throw new ValidationError(`Linked record(s) not found in sheet ${cfg.foreignSheetId}: ${missing.join(', ')}`)
            }
          }

          const updateRes = await query(
            `UPDATE meta_records
             SET data = data || $1::jsonb, updated_at = now(), version = version + 1
             WHERE sheet_id = $2 AND id = $3
             RETURNING version`,
            [JSON.stringify(patch), sheetId, recordId],
          )
          if (updateRes.rows.length === 0) {
            throw new NotFoundError(`Record not found: ${recordId}`)
          }

          if (linkUpdates.size > 0) {
            for (const [fieldId, { ids }] of linkUpdates.entries()) {
              if (ids.length === 0) {
                try {
                  await query('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [fieldId, recordId])
                } catch (err) {
                  throw err
                }
                continue
              }

              let existingIds: string[] = []
              try {
                const current = await query(
                  'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
                  [fieldId, recordId],
                )
                existingIds = (current as any).rows.map((r: any) => String(r.foreign_record_id))
              } catch (err) {
                throw err
              }

              const existing = new Set(existingIds)
              const next = new Set(ids)
              const toDelete = existingIds.filter((id) => !next.has(id))
              const toInsert = ids.filter((id) => !existing.has(id))

              if (toDelete.length > 0) {
                try {
                  await query(
                    'DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])',
                    [fieldId, recordId, toDelete],
                  )
                } catch (err) {
                  throw err
                }
              }

              for (const foreignId of toInsert) {
                try {
                  await query(
                    `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
                     VALUES ($1, $2, $3, $4)
                     ON CONFLICT DO NOTHING`,
                    [buildId('lnk').slice(0, 50), fieldId, recordId, foreignId],
                  )
                } catch (err) {
                  throw err
                }
              }
            }
          }

          updated.push({ recordId, version: Number((updateRes.rows[0] as any).version) })
        }

        return updated
      })

      let computedRecords: Array<{ recordId: string; data: Record<string, unknown> }> | undefined
      let updatedRowsForSummaries: UniverMetaRecord[] = []
      const computedFieldIds = visiblePropertyFields.filter((f) => f.type === 'lookup' || f.type === 'rollup')
      if (updates.length > 0 && (computedFieldIds.length > 0 || attachmentFields.length > 0)) {
        const recordIds = updates.map((u) => u.recordId)
        const recordRes = await pool.query(
          'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
          [sheetId, recordIds],
        )
        const rows = (recordRes.rows as any[]).map((row) => ({
          id: String(row.id),
          version: Number(row.version ?? 0),
          data: normalizeJson(row.data),
        })) as UniverMetaRecord[]
        updatedRowsForSummaries = rows

        const relationalLinkFields = fields
          .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: parseLinkFieldConfig(f.property) } : null))
          .filter((v): v is { fieldId: string; cfg: LinkFieldConfig } => !!v && !!v.cfg)

        const linkValuesByRecord = await loadLinkValuesByRecord(
          pool.query.bind(pool),
          rows.map((r) => r.id),
          relationalLinkFields,
        )

        await applyLookupRollup(
          req,
          pool.query.bind(pool),
          fields,
          rows,
          relationalLinkFields,
          linkValuesByRecord,
        )
        for (const row of rows) {
          row.data = filterRecordDataByFieldIds(row.data, visiblePropertyFieldIds)
        }

        if (computedFieldIds.length > 0) {
          computedRecords = rows.map((row) => ({
            recordId: row.id,
            data: extractLookupRollupData(visiblePropertyFields, row.data),
          }))
        }
      }

      const relatedRecords = updates.length > 0
        ? await computeDependentLookupRollupRecords(
            req,
            pool.query.bind(pool),
            updates.map((u) => u.recordId),
          )
        : []
      const sameSheetRelated = relatedRecords
        .filter((record) => record.sheetId === sheetId)
        .map((record) => ({ recordId: record.recordId, data: filterRecordDataByFieldIds(record.data, visiblePropertyFieldIds) }))
      const crossSheetRelated = relatedRecords.filter((record) => record.sheetId !== sheetId)
      const mergedRecords = mergeComputedRecords(computedRecords, sameSheetRelated)
      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const patchLinkSummaries = relationalLinkFields.length > 0 && updates.length > 0
        ? filterRecordFieldSummaryMap(
            serializeLinkSummaryMap(
              await buildLinkSummaries(
                req,
                pool.query.bind(pool),
                updates.map((update) => ({ id: update.recordId, version: 0, data: {} })),
                relationalLinkFields,
                await loadLinkValuesByRecord(
                  pool.query.bind(pool),
                  updates.map((update) => update.recordId),
                  relationalLinkFields,
                ),
              ),
            ),
            visiblePropertyFieldIds,
          )
        : undefined
      const patchAttachmentSummaries = attachmentFields.length > 0 && updatedRowsForSummaries.length > 0
        ? filterRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                updatedRowsForSummaries,
                attachmentFields,
              ),
            ),
            visiblePropertyFieldIds,
          )
        : undefined

      if (updates.length > 0) {
        publishMultitableSheetRealtime({
          spreadsheetId: sheetId,
          actorId: getRequestActorId(req),
          source: 'multitable',
          kind: 'record-updated',
          recordIds: updates.map((update) => update.recordId),
          fieldIds: [...new Set(Array.from(changesByRecord.values()).flatMap((changes) => changes.map((change) => change.fieldId)))],
          recordPatches: updates.map((update) => ({
            recordId: update.recordId,
            version: update.version,
            patch: Object.fromEntries(
              (changesByRecord.get(update.recordId) ?? []).map((change) => [change.fieldId, change.value]),
            ),
          })),
        })
      }

      return res.json({
        ok: true,
        data: {
          updated: updates,
          ...(mergedRecords ? { records: mergedRecords } : {}),
          ...(patchLinkSummaries ? { linkSummaries: patchLinkSummaries } : {}),
          ...(patchAttachmentSummaries ? { attachmentSummaries: patchAttachmentSummaries } : {}),
          ...(crossSheetRelated.length > 0 ? { relatedRecords: crossSheetRelated } : {}),
        },
      })
    } catch (err) {
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      if (err instanceof VersionConflictError) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: err.message,
            serverVersion: err.serverVersion,
          },
        })
      }
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] patch failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to patch meta records' } })
    }
  })

  return router
}
