import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'
import { poolManager } from '../integration/db/connection-pool'

type UniverMetaField = {
  id: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link' | 'lookup' | 'rollup'
  options?: Array<{ value: string; color?: string }>
  order?: number
  property?: Record<string, unknown>
}

type UniverMetaRecord = {
  id: string
  version: number
  data: Record<string, unknown>
}

type UniverMetaView = {
  id: string
  fields: UniverMetaField[]
  rows: UniverMetaRecord[]
  view?: UniverMetaViewConfig
  meta?: {
    warnings?: string[]
    computedFilterSort?: boolean
    ignoredSortFieldIds?: string[]
    ignoredFilterFieldIds?: string[]
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
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

const DEFAULT_SHEET_ID = 'univer_demo_meta'

const DEMO_FIELDS: Array<{
  id: string
  name: string
  type: UniverMetaField['type']
  property?: Record<string, unknown>
  order: number
}> = [
  { id: 'fld_udm_name', name: '产品名称', type: 'string', order: 1 },
  { id: 'fld_udm_qty', name: '数量', type: 'number', order: 2 },
  { id: 'fld_udm_price', name: '单价', type: 'number', order: 3 },
  { id: 'fld_udm_total', name: '总价', type: 'formula', order: 4 },
  {
    id: 'fld_udm_priority',
    name: '优先级',
    type: 'select',
    property: {
      options: [
        { label: 'P0', value: 'P0', color: '#ff4d4f' },
        { label: 'P1', value: 'P1', color: '#faad14' },
        { label: 'P2', value: 'P2', color: '#1677ff' },
        { label: 'Done', value: 'Done', color: '#52c41a' },
      ],
    },
    order: 5,
  },
  { id: 'fld_udm_related', name: '关联', type: 'link', order: 6 },
]

const DEMO_RECORDS: Array<{ id: string; version: number; data: Record<string, unknown> }> = [
  {
    id: 'rec_udm_1',
    version: 1,
    data: {
      fld_udm_name: '产品A',
      fld_udm_qty: 10,
      fld_udm_price: 100,
      fld_udm_total: '=B1*C1',
      fld_udm_priority: 'P0',
      fld_udm_related: 'PLM#6',
    },
  },
  {
    id: 'rec_udm_2',
    version: 1,
    data: {
      fld_udm_name: '产品B',
      fld_udm_qty: 20,
      fld_udm_price: 150,
      fld_udm_total: '=B2*C2',
      fld_udm_priority: 'P1',
      fld_udm_related: 'PLM#7',
    },
  },
  {
    id: 'rec_udm_3',
    version: 1,
    data: {
      fld_udm_name: '产品C',
      fld_udm_qty: 15,
      fld_udm_price: 200,
      fld_udm_total: '=B3*C3',
      fld_udm_priority: 'P2',
      fld_udm_related: 'PLM#8',
    },
  },
  {
    id: 'rec_udm_4',
    version: 1,
    data: {
      fld_udm_name: '产品D',
      fld_udm_qty: 25,
      fld_udm_price: 120,
      fld_udm_total: '=B4*C4',
      fld_udm_priority: 'P1',
      fld_udm_related: 'PLM#9',
    },
  },
  {
    id: 'rec_udm_5',
    version: 1,
    data: {
      fld_udm_name: '合计',
      fld_udm_qty: '',
      fld_udm_price: '',
      fld_udm_total: '=SUM(D1:D4)',
      fld_udm_priority: '',
      fld_udm_related: '',
    },
  },
]

function buildId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
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
  if (normalized === 'formula') return 'formula'
  if (normalized === 'select' || normalized === 'multiselect') return 'select'
  if (normalized === 'link') return 'link'
  if (normalized === 'lookup') return 'lookup'
  if (normalized === 'rollup') return 'rollup'
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

function sanitizeFieldProperty(type: UniverMetaField['type'], property: unknown): Record<string, unknown> {
  const obj = normalizeJson(property)
  if (type !== 'select') return obj

  const options = extractSelectOptions(obj) ?? []
  return { ...obj, options }
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
  if (effectiveType === 'number') {
    const numA = typeof valueA === 'number' ? valueA : Number(valueA)
    const numB = typeof valueB === 'number' ? valueB : Number(valueB)
    const aOk = Number.isFinite(numA)
    const bOk = Number.isFinite(numB)

    if (aOk && bOk) cmp = numA === numB ? 0 : numA > numB ? 1 : -1
    else if (aOk) cmp = -1
    else if (bOk) cmp = 1
    else cmp = 0
  }

  if (effectiveType === 'boolean') {
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

  const foreignRecordsBySheet = new Map<string, Map<string, Record<string, unknown>>>()
  for (const [foreignSheetId, ids] of foreignIdsBySheet.entries()) {
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
  for (const [sheetId, rows] of rowsBySheet.entries()) {
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

    await applyLookupRollup(query, fields, rows, relationalLinkFields, linkValuesByRecord)

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

  if (effectiveType === 'number') {
    const left = toComparableNumber(cellValue)
    const right = toComparableNumber(value)

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
  if (!relationMissing) return null

  if (
    msg.includes('meta_sheets') ||
    msg.includes('meta_fields') ||
    msg.includes('meta_records') ||
    msg.includes('meta_views') ||
    msg.includes('meta_links')
  ) {
    return 'Database schema not ready (meta tables missing). Run `pnpm --filter @metasheet/core-backend migrate` and ensure `DATABASE_URL` points to the dev DB.'
  }

  return null
}

async function tryResolveView(pool: { query: QueryFn }, viewId: string): Promise<UniverMetaViewConfig | null> {
  const result = await pool.query(
    'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids FROM meta_views WHERE id = $1',
    [viewId],
  )
  if (result.rows.length === 0) return null

  const row: any = result.rows[0]
  return {
    id: String(row.id),
    sheetId: String(row.sheet_id),
    name: String(row.name),
    type: String(row.type ?? 'grid'),
    filterInfo: normalizeJson(row.filter_info),
    sortInfo: normalizeJson(row.sort_info),
    groupInfo: normalizeJson(row.group_info),
    hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
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

  if (!viewId) return { sheetId: DEFAULT_SHEET_ID, view: null }

  const view = await tryResolveView(pool, viewId)
  if (view) return { sheetId: view.sheetId, view }

  // Backward-compatible fallback: treat viewId as a sheetId when no view exists.
  return { sheetId: viewId, view: null }
}

async function ensureDemoSheet(sheetId: string): Promise<void> {
  const pool = poolManager.get()

  await pool.transaction(async ({ query }) => {
    await query(
      `INSERT INTO meta_sheets (id, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [sheetId, 'Univer Demo (Meta)', 'DB-backed Univer demo sheet'],
    )

    for (const field of DEMO_FIELDS) {
      await query(
        `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          field.id,
          sheetId,
          field.name,
          field.type,
          JSON.stringify(field.property ?? {}),
          field.order,
        ],
      )
    }

    for (const record of DEMO_RECORDS) {
      await query(
        `INSERT INTO meta_records (id, sheet_id, data, version)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, sheetId, JSON.stringify(record.data), record.version],
      )
    }
  })
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
    await query(
      `INSERT INTO meta_sheets (id, name, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [args.sheetId, args.name, args.description ?? null],
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

export function univerMetaRouter(): Router {
  const router = Router()

  router.get('/sheets', async (_req: Request, res: Response) => {
    try {
      const pool = poolManager.get()
      const result = await pool.query(
        'SELECT id, name, description FROM meta_sheets WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 200',
      )
      const sheets = result.rows.map((r: any) => ({
        id: String(r.id),
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

  router.get('/fields', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId : DEFAULT_SHEET_ID
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      if (sheetId === DEFAULT_SHEET_ID) {
        await ensureDemoSheet(sheetId)
      }

      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

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
      sheetId: z.string().min(1).max(50).optional(),
      name: z.string().min(1).max(255),
      type: z.enum(['string', 'number', 'boolean', 'formula', 'select', 'link', 'lookup', 'rollup']).default('string'),
      property: z.record(z.unknown()).optional(),
      order: z.number().int().nonnegative().optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const sheetId = parsed.data.sheetId ?? DEFAULT_SHEET_ID
    const fieldId = parsed.data.id ?? buildId('fld').slice(0, 50)
    const name = parsed.data.name.trim()
    const type = parsed.data.type
    const property = sanitizeFieldProperty(type, parsed.data.property ?? {})
    const desiredOrder = parsed.data.order

    try {
      if (sheetId === DEFAULT_SHEET_ID) {
        await ensureDemoSheet(sheetId)
      }

      const pool = poolManager.get()
      await pool.transaction(async ({ query }) => {
        const sheetRes = await query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
        if ((sheetRes as any).rows.length === 0) {
          throw new NotFoundError(`Sheet not found: ${sheetId}`)
        }

        const configError = await validateLookupRollupConfig(query, sheetId, type, property)
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
      })

      const fieldRes = await pool.query(
        'SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1',
        [fieldId],
      )
      return res.status(201).json({ ok: true, data: { field: serializeFieldRow((fieldRes as any).rows[0]) } })
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
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

  router.patch('/fields/:fieldId', async (req: Request, res: Response) => {
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId : ''
    if (!fieldId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'fieldId is required' } })
    }

    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      type: z.enum(['string', 'number', 'boolean', 'formula', 'select', 'link', 'lookup', 'rollup']).optional(),
      property: z.record(z.unknown()).optional(),
      order: z.number().int().nonnegative().optional(),
    }).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be updated' })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const updated = await pool.transaction(async ({ query }) => {
        const existing = await query(
          'SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1',
          [fieldId],
        )
        if ((existing as any).rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)

        const row = (existing as any).rows[0]
        const sheetId = String(row.sheet_id)
        const currentOrder = Number(row.order ?? 0)

        const nextName = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : String(row.name)
        const nextType = (parsed.data.type ?? mapFieldType(String(row.type))) as UniverMetaField['type']
        const nextProperty = sanitizeFieldProperty(
          nextType,
          typeof parsed.data.property !== 'undefined' ? parsed.data.property : row.property,
        )
        const desiredOrder = parsed.data.order

        const configError = await validateLookupRollupConfig(query, sheetId, nextType, nextProperty)
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
        return serializeFieldRow(updatedRow)
      })

      return res.json({ ok: true, data: { field: updated } })
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
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

        return { deleted: fieldId }
      })

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
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId : DEFAULT_SHEET_ID
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      if (sheetId === DEFAULT_SHEET_ID) {
        await ensureDemoSheet(sheetId)
      }

      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      let result = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC LIMIT 200',
        [sheetId],
      )

      if (result.rows.length === 0) {
        const defaultId = buildId('view')
        await pool.query(
          `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [defaultId, sheetId, '默认视图', 'grid', '{}', '{}', '{}', '[]'],
        )
        result = await pool.query(
          'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC LIMIT 200',
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
      if (sheetId === DEFAULT_SHEET_ID) {
        await ensureDemoSheet(sheetId)
      }

      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      await pool.query(
        `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)`,
        [
          viewId,
          sheetId,
          name,
          type,
          JSON.stringify(parsed.data.filterInfo ?? {}),
          JSON.stringify(parsed.data.sortInfo ?? {}),
          JSON.stringify(parsed.data.groupInfo ?? {}),
          JSON.stringify(parsed.data.hiddenFieldIds ?? []),
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
      }

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
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const current = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids FROM meta_views WHERE id = $1',
        [viewId],
      )
      if (current.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }

      const row: any = current.rows[0]
      const nextName = parsed.data.name ?? String(row.name)
      const nextType = parsed.data.type ?? String(row.type ?? 'grid')
      const nextFilter = parsed.data.filterInfo ?? normalizeJson(row.filter_info)
      const nextSort = parsed.data.sortInfo ?? normalizeJson(row.sort_info)
      const nextGroup = parsed.data.groupInfo ?? normalizeJson(row.group_info)
      const nextHiddenFieldIds = parsed.data.hiddenFieldIds ?? normalizeJsonArray(row.hidden_field_ids)

      await pool.query(
        `UPDATE meta_views
         SET name = $2, type = $3, filter_info = $4::jsonb, sort_info = $5::jsonb, group_info = $6::jsonb, hidden_field_ids = $7::jsonb
         WHERE id = $1`,
        [
          viewId,
          nextName,
          nextType,
          JSON.stringify(nextFilter ?? {}),
          JSON.stringify(nextSort ?? {}),
          JSON.stringify(nextGroup ?? {}),
          JSON.stringify(nextHiddenFieldIds ?? []),
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
      }

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
      const del = await pool.query('DELETE FROM meta_views WHERE id = $1', [viewId])
      if ((del as any).rowCount === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }
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
      const del = await pool.query('DELETE FROM meta_sheets WHERE id = $1', [sheetId])
      if ((del as any).rowCount === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
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
    const seed = parsed.data.seed !== false

    try {
      const pool = poolManager.get()
      await pool.transaction(async ({ query }) => {
        const insert = await query(
          `INSERT INTO meta_sheets (id, name, description)
           VALUES ($1, $2, $3)
           ON CONFLICT (id) DO NOTHING`,
          [sheetId, name, description],
        )
        if ((insert as any).rowCount === 0) {
          throw new ConflictError(`Sheet already exists: ${sheetId}`)
        }

        if (seed) {
          await createSeededSheet({ sheetId, name, description, query: query as unknown as QueryFn })
        }
      })

      return res.json({ ok: true, data: { sheet: { id: sheetId, name, description, seeded: seed } } })
    } catch (err) {
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
    const sheetIdParam = typeof req.query.sheetId === 'string' ? req.query.sheetId : undefined
    const viewIdParam = typeof req.query.viewId === 'string' ? req.query.viewId : undefined
    const seed = req.query.seed === 'true'
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
      const rawSortRules = viewConfig ? parseMetaSortRules(viewConfig.sortInfo) : []
      const rawFilterInfo = viewConfig ? parseMetaFilterInfo(viewConfig.filterInfo) : null
      const allowSeed = seed || sheetId === DEFAULT_SHEET_ID

      if (allowSeed) {
        await ensureDemoSheet(sheetId)
      }

      const sheet = await pool.query(
        'SELECT id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
        [sheetId],
      )
      if (sheet.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const fieldRes = await pool.query(
        'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC',
        [sheetId],
      )

      const fields: UniverMetaField[] = fieldRes.rows.map((f: any) => serializeFieldRow(f))

      const fieldTypeById = new Map(fields.map((f) => [f.id, f.type] as const))
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
      const computedFieldIdSet = new Set(
        fields.filter((f) => f.type === 'lookup' || f.type === 'rollup').map((f) => f.id),
      )

      let rows: UniverMetaRecord[] = []
      let page: UniverMetaView['page'] | undefined

      const hasFilterOrSort = sortRules.length > 0 || !!filterInfo

      let computedFilterSort = false

      if (hasFilterOrSort) {
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
            pool.query.bind(pool),
            fields,
            all,
            relationalLinkFields,
            linkValuesByRecord,
          )
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
        const recordSql = limit
          ? 'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3'
          : 'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC'
        const recordParams = limit ? [sheetId, limit, offset] : [sheetId]
        const recordRes = await pool.query(recordSql, recordParams)

        rows = recordRes.rows.map((r: any) => ({
          id: String(r.id),
          version: Number(r.version ?? 1),
          data: normalizeJson(r.data),
        }))

        if (limit) {
          const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1', [sheetId])
          const total = Number((countRes.rows[0] as any)?.total ?? 0)
          page = { offset, limit, total, hasMore: offset + rows.length < total }
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
        pool.query.bind(pool),
        fields,
        rows,
        relationalLinkFields,
        linkValuesByRecord,
      )

      const meta = warnings.length > 0 || hasFilterOrSort
        ? {
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(hasFilterOrSort ? { computedFilterSort } : {}),
            ...(ignoredSortFieldIds.length > 0 ? { ignoredSortFieldIds } : {}),
            ...(ignoredFilterFieldIds.length > 0 ? { ignoredFilterFieldIds } : {}),
          }
        : undefined

      const view: UniverMetaView = {
        id: sheetId,
        fields,
        rows,
        ...(viewConfig ? { view: viewConfig } : {}),
        ...(meta ? { meta } : {}),
        ...(page ? { page } : {}),
      }
      return res.json({ ok: true, data: view })
    } catch (err) {
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load meta view' } })
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

      // Get fields to determine display field
      const fieldRes = await pool.query(
        'SELECT id, name, type FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
        [sheetId],
      )
      const fields = fieldRes.rows as Array<{ id: string; name: string; type: string }>

      // Determine display field: use provided displayFieldId or fall back to first string field
      let effectiveDisplayFieldId = displayFieldId
      if (!effectiveDisplayFieldId && fields.length > 0) {
        const stringField = fields.find((f) => mapFieldType(f.type) === 'string')
        effectiveDisplayFieldId = stringField?.id ?? fields[0]?.id ?? null
      }

      // Fetch all records (we apply search filter in-memory for flexibility)
      const recordRes = await pool.query(
        'SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
        [sheetId],
      )

      // Map records to {id, display}
      let summaries = (recordRes.rows as Array<{ id: string; data: unknown }>).map((r) => {
        const data = normalizeJson(r.data)
        let display = ''
        if (effectiveDisplayFieldId && Object.prototype.hasOwnProperty.call(data, effectiveDisplayFieldId)) {
          const val = data[effectiveDisplayFieldId]
          if (typeof val === 'string') display = val
          else if (typeof val === 'number' || typeof val === 'boolean') display = String(val)
          else if (val !== null && val !== undefined) display = JSON.stringify(val)
        }
        return { id: String(r.id), display }
      })

      // Apply search filter if provided
      if (search) {
        summaries = summaries.filter((s) => s.display.toLowerCase().includes(search))
      }

      const total = summaries.length
      const paged = summaries.slice(offset, offset + limit)
      const hasMore = offset + paged.length < total

      // Build displayMap for quick lookup (id -> display) - useful for Link field display
      const displayMap: Record<string, string> = {}
      for (const s of summaries) {
        displayMap[s.id] = s.display
      }

      return res.json({
        ok: true,
        data: {
          records: paged,
          displayMap,
          page: { offset, limit, total, hasMore },
        },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] records-summary failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load records summary' } })
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

      if (sheetId === DEFAULT_SHEET_ID) {
        await ensureDemoSheet(sheetId)
      }

      const sheetRes = await pool.query(
        'SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
        [sheetId],
      )
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

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

        if (field.type === 'formula') {
          if (typeof value !== 'string') continue
          if (value !== '' && !value.startsWith('=')) continue
        }

        patch[fieldId] = value
      }

      const recordId = `rec_${randomUUID()}`
      const recordRes = await pool.transaction(async ({ query }) => {
        const inserted = await query(
          `INSERT INTO meta_records (id, sheet_id, data, version)
           VALUES ($1, $2, $3::jsonb, 1)
           RETURNING version`,
          [recordId, sheetId, JSON.stringify(patch)],
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
      return res.json({ ok: true, data: { record: { id: recordId, version, data: patch } } })
    } catch (err) {
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
      await pool.transaction(async ({ query }) => {
        const recordRes = await query('SELECT id, version FROM meta_records WHERE id = $1 FOR UPDATE', [recordId])
        if ((recordRes as any).rows.length === 0) {
          throw new NotFoundError(`Record not found: ${recordId}`)
        }

        const serverVersion = Number((recordRes as any).rows[0]?.version ?? 1)
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

      if (sheetId === DEFAULT_SHEET_ID) {
        await ensureDemoSheet(sheetId)
      }

      const fieldRes = await pool.query(
        'SELECT id, name, type, property FROM meta_fields WHERE sheet_id = $1',
        [sheetId],
      )
      if (fieldRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const fields = (fieldRes.rows as any[]).map(serializeFieldRow)
      const fieldById = new Map<string, { type: UniverMetaField['type']; options?: string[]; readonly?: boolean; link?: LinkFieldConfig | null }>()
      for (const f of fields) {
        const prop = normalizeJson(f.property)
        const isReadonly = prop.readonly === true
        if (f.type === 'select') {
          const options = f.options?.map((o) => o.value) ?? []
          fieldById.set(String(f.id), { type: f.type, options, readonly: isReadonly })
          continue
        }
        if (f.type === 'link') {
          fieldById.set(String(f.id), { type: f.type, readonly: isReadonly, link: parseLinkFieldConfig(f.property) })
          continue
        }
        fieldById.set(String(f.id), { type: f.type, readonly: isReadonly })
      }

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

          // P0.3: Field-level readonly permission check
          if (field.readonly === true) {
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
        }
      }

      const updates = await pool.transaction(async ({ query }) => {
        const updated: Array<{ recordId: string; version: number }> = []

        for (const [recordId, changes] of changesByRecord.entries()) {
          const expectedVersion = Array.from(new Set(changes.map(c => c.expectedVersion).filter((v): v is number => typeof v === 'number')))[0]
          const recordRes = await query(
            'SELECT id, version FROM meta_records WHERE sheet_id = $1 AND id = $2 FOR UPDATE',
            [sheetId, recordId],
          )
          if (recordRes.rows.length === 0) {
            throw new NotFoundError(`Record not found: ${recordId}`)
          }

          const serverVersion = Number((recordRes.rows[0] as any).version ?? 1)
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
      const computedFieldIds = fields.filter((f) => f.type === 'lookup' || f.type === 'rollup')
      if (updates.length > 0 && computedFieldIds.length > 0) {
        const recordIds = updates.map((u) => u.recordId)
        const recordRes = await pool.query(
          'SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
          [sheetId, recordIds],
        )
        const rows = (recordRes.rows as any[]).map((row) => ({
          id: String(row.id),
          version: 0,
          data: normalizeJson(row.data),
        })) as UniverMetaRecord[]

        const relationalLinkFields = fields
          .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: parseLinkFieldConfig(f.property) } : null))
          .filter((v): v is { fieldId: string; cfg: LinkFieldConfig } => !!v && !!v.cfg)

        const linkValuesByRecord = await loadLinkValuesByRecord(
          pool.query.bind(pool),
          rows.map((r) => r.id),
          relationalLinkFields,
        )

        await applyLookupRollup(
          pool.query.bind(pool),
          fields,
          rows,
          relationalLinkFields,
          linkValuesByRecord,
        )

        computedRecords = rows.map((row) => ({
          recordId: row.id,
          data: extractLookupRollupData(fields, row.data),
        }))
      }

      const relatedRecords = updates.length > 0
        ? await computeDependentLookupRollupRecords(
            pool.query.bind(pool),
            updates.map((u) => u.recordId),
          )
        : []
      const sameSheetRelated = relatedRecords
        .filter((record) => record.sheetId === sheetId)
        .map((record) => ({ recordId: record.recordId, data: record.data }))
      const crossSheetRelated = relatedRecords.filter((record) => record.sheetId !== sheetId)
      const mergedRecords = mergeComputedRecords(computedRecords, sameSheetRelated)

      return res.json({
        ok: true,
        data: {
          updated: updates,
          ...(mergedRecords ? { records: mergedRecords } : {}),
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
