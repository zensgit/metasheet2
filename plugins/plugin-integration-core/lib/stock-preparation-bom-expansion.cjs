'use strict'

// #2253 C2: projectNo -> PLM BOM dry-run expansion helper.
// Runtime-safe but write-free: reads only through a data-source:sql-readonly-style
// source adapter using object + equality filters, expands the BOM app-side, and
// returns normalized logical stock-preparation rows. No route, UI, MetaSheet
// write, external DB write, raw SQL, stored procedure, or K3 path.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')

const DEFAULT_PAGE_LIMIT = 1000
const DEFAULT_MAX_PAGES = 100
const DEFAULT_MAX_DEPTH = 20
const DEFAULT_MAX_ROWS = 10000
const LARGE_BOM_BOUNDED_ERROR_TYPES = Object.freeze([
  'max_rows_exceeded',
  'read_page_limit_exceeded',
  'read_count_exceeded',
  'read_time_limit_exceeded',
])
const STOCK_PREPARATION_BOM_SOURCE_KINDS = Object.freeze([
  'data-source:sql-readonly',
  'bridge:legacy-sql-readonly',
])

const FORBIDDEN_PLAN_KEYS = Object.freeze([
  'sql',
  'rawSql',
  'query',
  'where',
  'join',
  'joins',
  'cte',
  'recursiveCte',
  'storedProcedure',
  'vendorApi',
  'rows',
  'records',
  'data',
  'values',
  'payload',
])

class StockPreparationBomExpansionError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationBomExpansionError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : value
}

function toKey(value) {
  if (isBlank(value)) return null
  return String(trimString(value))
}

function isSecretShaped(value) {
  return typeof value === 'string' && scrubSecretStringValue(value) !== value
}

function assertNoForbiddenPlanKeys(value, path = 'readPlan') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenPlanKeys(item, `${path}[${index}]`))
    return
  }
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_PLAN_KEYS.includes(key)) {
      throw new StockPreparationBomExpansionError(`${path} must not carry ${key}`, { field: `${path}.${key}` })
    }
    assertNoForbiddenPlanKeys(value[key], `${path}.${key}`)
  }
}

function requiredObject(input, field) {
  if (!isPlainObject(input)) {
    throw new StockPreparationBomExpansionError(`${field} must be an object`, { field })
  }
  return input
}

function optionalObject(input, field) {
  if (input === undefined || input === null) return {}
  return requiredObject(input, field)
}

function requiredString(input, field, { fieldName = false, identifier = true } = {}) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new StockPreparationBomExpansionError(`${field} is required`, { field })
  }
  const value = input.trim()
  if (isSecretShaped(value)) {
    throw new StockPreparationBomExpansionError(`${field} must not be secret-shaped`, { field })
  }
  if (identifier) {
    const pattern = fieldName ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z_][A-Za-z0-9_.]*$/
    if (!pattern.test(value)) {
      throw new StockPreparationBomExpansionError(`${field} must be a safe identifier`, { field, value })
    }
  }
  return value
}

function optionalString(input, field, opts = {}) {
  if (input === undefined || input === null || input === '') return undefined
  return requiredString(input, field, opts)
}

function positiveInteger(input, field, defaultValue) {
  if (input === undefined || input === null || input === '') return defaultValue
  const value = Number(input)
  if (!Number.isInteger(value) || value <= 0) {
    throw new StockPreparationBomExpansionError(`${field} must be a positive integer`, { field, value: input })
  }
  return value
}

function optionalPositiveInteger(input, field) {
  if (input === undefined || input === null || input === '') return undefined
  return positiveInteger(input, field, undefined)
}

function nonNegativeInteger(input, field, defaultValue) {
  if (input === undefined || input === null || input === '') return defaultValue
  const value = Number(input)
  if (!Number.isInteger(value) || value < 0) {
    throw new StockPreparationBomExpansionError(`${field} must be a non-negative integer`, { field, value: input })
  }
  return value
}

function normalizeObjectFields(input, field, requiredFields, optionalFields = []) {
  const value = requiredObject(input, field)
  const out = {}
  for (const key of requiredFields) {
    out[key] = requiredString(value[key], `${field}.${key}`, { fieldName: key !== 'object' })
  }
  for (const key of optionalFields) {
    const normalized = optionalString(value[key], `${field}.${key}`, { fieldName: key !== 'object' })
    if (normalized !== undefined) out[key] = normalized
  }
  return out
}

const PLM_STOCK_PREPARATION_BOM_READ_PLAN = Object.freeze({
  id: 'plm.stock-preparation.bom-read.dn-pdm.v1',
  sourceKind: 'data-source:sql-readonly',
  matchField: 'FileCode',
  pathExAttr: {
    object: 'DN_PDM_PathExAttrInfo',
    matchField: 'FileCode',
    pathIdField: 'Parent_OBJ_ID',
  },
  pathInfo: {
    object: 'DN_PDM_PathInfo',
    idField: 'OBJ_ID',
  },
  orderHead: {
    object: 'DN_PDM_OrderHeadInfo',
    idField: 'OBJ_ID',
    pathIdField: 'path_id',
  },
  orderDetail: {
    object: 'DN_PDM_OrderDetailInfo',
    orderIdField: 'order_id',
    componentIdField: 'part_id',
    quantityField: 'quantity',
    sortField: 'sort_id',
  },
  part: {
    object: 'DN_PDM_PartLibraryInfo',
    idField: 'OBJ_ID',
    codeField: 'IdentityNo',
    nameField: 'IdentityName',
    materialField: 'Material',
    versionField: 'SysVer',
  },
  bomHead: {
    object: 'DN_PDM_BomHeadInfo',
    parentPartField: 'part_id',
    bomIdField: 'bom_id',
    versionField: 'SysVer',
    activeField: 'bom_able',
  },
  bomDetail: {
    object: 'DN_PDM_BomDetailsInfo',
    bomParentField: 'bom_pid',
    componentIdField: 'part_id',
    quantityField: 'Bom_ExAttr1',
    sortField: 'sort_id',
  },
})

function normalizeStockPreparationBomReadPlan(input = PLM_STOCK_PREPARATION_BOM_READ_PLAN) {
  const source = input || PLM_STOCK_PREPARATION_BOM_READ_PLAN
  assertNoForbiddenPlanKeys(source)
  const plan = requiredObject(source, 'readPlan')
  const sourceKind = requiredString(plan.sourceKind || 'data-source:sql-readonly', 'readPlan.sourceKind', { identifier: false })
  if (!STOCK_PREPARATION_BOM_SOURCE_KINDS.includes(sourceKind)) {
    throw new StockPreparationBomExpansionError('readPlan.sourceKind must be data-source:sql-readonly or bridge:legacy-sql-readonly', {
      field: 'readPlan.sourceKind',
      value: sourceKind,
    })
  }
  const out = {
    id: optionalString(plan.id, 'readPlan.id', { identifier: false }) || PLM_STOCK_PREPARATION_BOM_READ_PLAN.id,
    sourceKind,
    matchField: requiredString(plan.matchField || 'FileCode', 'readPlan.matchField', { fieldName: true }),
    pathExAttr: normalizeObjectFields(plan.pathExAttr, 'readPlan.pathExAttr', ['object', 'matchField', 'pathIdField']),
    pathInfo: normalizeObjectFields(plan.pathInfo, 'readPlan.pathInfo', ['object', 'idField']),
    orderHead: normalizeObjectFields(plan.orderHead, 'readPlan.orderHead', ['object', 'idField', 'pathIdField']),
    orderDetail: normalizeObjectFields(plan.orderDetail, 'readPlan.orderDetail', ['object', 'orderIdField', 'componentIdField', 'quantityField'], ['sortField']),
    part: normalizeObjectFields(plan.part, 'readPlan.part', ['object', 'idField'], ['codeField', 'nameField', 'materialField', 'versionField']),
    bomHead: normalizeObjectFields(plan.bomHead, 'readPlan.bomHead', ['object', 'parentPartField', 'bomIdField'], ['versionField', 'activeField']),
    bomDetail: normalizeObjectFields(plan.bomDetail, 'readPlan.bomDetail', ['object', 'bomParentField', 'componentIdField', 'quantityField'], ['sortField']),
  }
  if (out.matchField !== out.pathExAttr.matchField) {
    throw new StockPreparationBomExpansionError('readPlan.matchField must match readPlan.pathExAttr.matchField', {
      field: 'readPlan.matchField',
    })
  }
  return out
}

function requireSourceAdapter(adapter) {
  if (!adapter || typeof adapter.read !== 'function') {
    throw new StockPreparationBomExpansionError('C2 BOM expansion requires a source adapter with read()', {
      field: 'sourceAdapter',
    })
  }
  return adapter
}

function normalizeFilters(filters) {
  const out = {}
  for (const [key, value] of Object.entries(filters || {})) {
    const normalizedKey = requiredString(key, `filters.${key}`, { fieldName: true })
    if (value === undefined || value === null || value === '') continue
    if (!['string', 'number', 'boolean'].includes(typeof value)) {
      throw new StockPreparationBomExpansionError('filters support equality primitives only', {
        field: `filters.${normalizedKey}`,
      })
    }
    out[normalizedKey] = value
  }
  if (Object.keys(out).length === 0) {
    throw new StockPreparationBomExpansionError('read filters must not be empty', { field: 'filters' })
  }
  return out
}

function isLargeBomBoundedErrorType(type) {
  return LARGE_BOM_BOUNDED_ERROR_TYPES.includes(type)
}

function isReadLimitError(error) {
  return Boolean(
    error &&
    error.name === 'StockPreparationBomExpansionError' &&
    error.details &&
    isLargeBomBoundedErrorType(error.details.code),
  )
}

function readLimitErrorDetails(error, fallbackObject) {
  if (!isReadLimitError(error)) return null
  const details = error.details || {}
  const { code, ...rest } = details
  return {
    type: code,
    ...(fallbackObject && !rest.object ? { object: fallbackObject } : {}),
    ...rest,
  }
}

function assertReadBudget(options, readStats, object) {
  if (options.maxReadCount !== undefined && readStats.length >= options.maxReadCount) {
    throw new StockPreparationBomExpansionError('PLM read exceeded maxReadCount', {
      code: 'read_count_exceeded',
      object,
      maxReadCount: options.maxReadCount,
    })
  }
  if (options.maxElapsedMs !== undefined && options.now() - options.startedAtMs > options.maxElapsedMs) {
    throw new StockPreparationBomExpansionError('PLM read exceeded maxElapsedMs', {
      code: 'read_time_limit_exceeded',
      object,
      maxElapsedMs: options.maxElapsedMs,
    })
  }
}

async function readAll(adapter, object, filters, options, readStats) {
  const normalizedFilters = normalizeFilters(filters)
  const rows = []
  let cursor
  for (let page = 0; ; page += 1) {
    if (page >= options.maxPages) {
      throw new StockPreparationBomExpansionError('PLM read exceeded maxPages', {
        code: 'read_page_limit_exceeded',
        object,
        maxPages: options.maxPages,
      })
    }
    assertReadBudget(options, readStats, object)
    const input = { object, filters: normalizedFilters, limit: options.pageLimit }
    if (cursor) input.cursor = cursor
    const stat = {
      object,
      filterFields: Object.keys(normalizedFilters).sort(),
      cursor: cursor || null,
      status: 'attempted',
      filtersSent: true,
    }
    readStats.push(stat)
    let result
    try {
      result = await adapter.read(input)
      stat.status = 'ok'
    } catch (error) {
      stat.status = 'failed'
      stat.errorCode = safeErrorCode(error)
      throw error
    }
    if (isPlainObject(result) && isPlainObject(result.metadata)) {
      stat.source = typeof result.metadata.source === 'string' ? result.metadata.source : undefined
      stat.filtersApplied = result.metadata.filtersApplied
      if (Array.isArray(result.metadata.filterFields)) stat.filterFields = result.metadata.filterFields.slice().sort()
    }
    const records = isPlainObject(result) && Array.isArray(result.records) ? result.records : []
    stat.count = records.length
    for (const record of records) {
      if (isPlainObject(record)) rows.push(record)
    }
    if (!isPlainObject(result) || result.done === true || !result.nextCursor) break
    cursor = result.nextCursor
  }
  return rows
}

function readField(row, field) {
  if (!isPlainObject(row) || field === undefined) return undefined
  return row[field]
}

function matchesByField(rows, field, value) {
  const key = toKey(value)
  if (key === null) return []
  return rows.filter((row) => toKey(readField(row, field)) === key)
}

function parseQuantity(value, context) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return {
      ok: false,
      error: {
        type: 'invalid_quantity',
        field: context.field,
        depth: context.depth,
        relation: context.relation,
      },
    }
  }
  return { ok: true, value: numeric }
}

function isActiveBomHead(row, activeField) {
  if (!activeField) return true
  const value = readField(row, activeField)
  if (value === undefined || value === null || value === '') return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['0', 'false', 'n', 'no', 'disabled', 'inactive'].includes(normalized)) return false
  }
  return true
}

function makePath(pathTokens) {
  return JSON.stringify(pathTokens)
}

function makeIdempotencyKey(projectNo, componentSourceId, parentSourceId, pathTokens) {
  return JSON.stringify({
    projectNo,
    componentSourceId,
    parentSourceId: parentSourceId || null,
    path: pathTokens,
  })
}

function makeActions(rowsExpanded) {
  return {
    add: 0,
    update: 0,
    skip: 0,
    inactive: 0,
    manualConfirm: 0,
    candidateRows: rowsExpanded,
    plannerPending: true,
  }
}

function safeErrorCode(error) {
  if (!error) return undefined
  if (typeof error.code === 'string' && error.code.trim()) return error.code.trim()
  if (typeof error.name === 'string' && error.name.trim()) return error.name.trim()
  return undefined
}

function readDiagnostic(entry = {}) {
  const diagnostic = {
    object: entry.object,
    filterFields: Array.isArray(entry.filterFields) ? entry.filterFields.slice().sort() : [],
    cursor: entry.cursor || null,
    status: entry.status || 'attempted',
  }
  if (entry.filtersSent !== undefined) diagnostic.filtersSent = entry.filtersSent === true
  if (entry.source) diagnostic.source = entry.source
  if (entry.filtersApplied !== undefined) diagnostic.filtersApplied = entry.filtersApplied === true
  if (Number.isInteger(entry.count)) diagnostic.count = entry.count
  if (entry.errorCode) diagnostic.errorCode = entry.errorCode
  return diagnostic
}

function scaleErrorTypes(errors = []) {
  return Array.from(new Set(errors.map((entry) => entry.type).filter(isLargeBomBoundedErrorType))).sort()
}

function isLargeBomBoundedExpansion(result = {}) {
  const errors = Array.isArray(result.errors) ? result.errors : []
  const rowErrors = Array.isArray(result.rowErrors) ? result.rowErrors : []
  return errors.length > 0 && rowErrors.length === 0 && errors.every((entry) => isLargeBomBoundedErrorType(entry.type))
}

function boundedPreviewSummary(summary = {}, errorTypes = []) {
  if (errorTypes.length === 0) return undefined
  const out = {
    complete: false,
    authoritative: false,
    rowsExpanded: Number(summary.rowsExpanded || 0),
    readCount: Number(summary.readCount || 0),
    errorTypes: errorTypes.slice(),
  }
  if (summary.maxRows !== undefined) out.maxRows = summary.maxRows
  if (summary.maxPages !== undefined) out.maxPages = summary.maxPages
  if (summary.maxReadCount !== undefined) out.maxReadCount = summary.maxReadCount
  if (summary.maxElapsedMs !== undefined) out.maxElapsedMs = summary.maxElapsedMs
  return out
}

function makeSummary({ projectNoPresent, matchField, status, rowsExpanded, rootMatches, maxDepth, maxRows, maxPages, maxReadCount, maxElapsedMs, readStats, errors, rowErrors }) {
  const summary = {
    projectNoPresent,
    matchField,
    status,
    rowsExpanded,
    rootMatches,
    maxDepth,
    maxRows,
    maxPages,
    maxReadCount,
    maxElapsedMs,
    readObjects: Array.from(new Set(readStats.map((entry) => entry.object))).sort(),
    readCount: readStats.length,
    readDiagnostics: readStats.map(readDiagnostic),
    errorTypes: Array.from(new Set([...(errors || []), ...(rowErrors || [])].map((entry) => entry.type || entry.code).filter(Boolean))).sort(),
    actions: makeActions(status === 'expanded' ? rowsExpanded : 0),
  }
  if (status === 'not_found') {
    summary.actions = {
      add: 0,
      update: 0,
      skip: 0,
      inactive: 0,
      manualConfirm: 0,
    }
  }
  return summary
}

function createRow({ projectNo, parentSourceId, pathTokens, depth, partRow, rawQuantity, totalQuantity, active, sortLine }) {
  const componentSourceId = toKey(readField(partRow, 'OBJ_ID'))
  const path = makePath(pathTokens)
  const row = {
    projectNo,
    idempotencyKey: makeIdempotencyKey(projectNo, componentSourceId, parentSourceId, pathTokens),
    componentSourceId,
    parentSourceId: parentSourceId || null,
    path,
    depth,
    componentCode: readField(partRow, 'IdentityNo'),
    componentName: readField(partRow, 'IdentityName'),
    material: readField(partRow, 'Material'),
    sourceVersion: readField(partRow, 'SysVer'),
    rawQuantity,
    totalQuantity,
    active,
  }
  if (!isBlank(sortLine)) row.sortLine = sortLine
  return row
}

function rowFromPart(plan, { projectNo, parentSourceId, pathTokens, depth, partRow, rawQuantity, totalQuantity, active, sortLine }) {
  const componentSourceId = toKey(readField(partRow, plan.part.idField))
  if (componentSourceId === null) {
    return {
      error: { type: 'missing_component_source_id', depth, field: plan.part.idField },
    }
  }
  const normalizedPart = {
    OBJ_ID: componentSourceId,
    IdentityNo: plan.part.codeField ? readField(partRow, plan.part.codeField) : undefined,
    IdentityName: plan.part.nameField ? readField(partRow, plan.part.nameField) : undefined,
    Material: plan.part.materialField ? readField(partRow, plan.part.materialField) : undefined,
    SysVer: plan.part.versionField ? readField(partRow, plan.part.versionField) : undefined,
  }
  return {
    row: createRow({
      projectNo,
      parentSourceId,
      pathTokens,
      depth,
      partRow: normalizedPart,
      rawQuantity,
      totalQuantity,
      active,
      sortLine,
    }),
    componentSourceId,
    sourceVersion: normalizedPart.SysVer,
  }
}

function failureResult({ projectNoPresent, matchField, status = 'failed', rows, errors, rowErrors, readStats, rootMatches, maxDepth, maxRows, maxPages, maxReadCount, maxElapsedMs }) {
  return {
    valid: false,
    status,
    rows,
    errors,
    rowErrors,
    summary: makeSummary({
      projectNoPresent,
      matchField,
      status,
      rowsExpanded: rows.length,
      rootMatches,
      maxDepth,
      maxRows,
      maxPages,
      maxReadCount,
      maxElapsedMs,
      readStats,
      errors,
      rowErrors,
    }),
  }
}

async function expandPlmProjectBom(input = {}) {
  const sourceAdapter = requireSourceAdapter(input.sourceAdapter)
  const projectNo = typeof input.projectNo === 'string' ? input.projectNo.trim() : ''
  if (!projectNo) {
    throw new StockPreparationBomExpansionError('projectNo is required', { field: 'projectNo' })
  }
  const plan = normalizeStockPreparationBomReadPlan(input.readPlan || PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  const options = {
    pageLimit: positiveInteger(input.pageLimit, 'pageLimit', DEFAULT_PAGE_LIMIT),
    maxPages: positiveInteger(input.maxPages, 'maxPages', DEFAULT_MAX_PAGES),
    maxDepth: nonNegativeInteger(input.maxDepth, 'maxDepth', DEFAULT_MAX_DEPTH),
    maxRows: positiveInteger(input.maxRows, 'maxRows', DEFAULT_MAX_ROWS),
    maxReadCount: optionalPositiveInteger(input.maxReadCount, 'maxReadCount'),
    maxElapsedMs: optionalPositiveInteger(input.maxElapsedMs, 'maxElapsedMs'),
    startedAtMs: Number.isFinite(input.startedAtMs) ? Number(input.startedAtMs) : Date.now(),
    now: typeof input.now === 'function' ? input.now : Date.now,
  }
  const readStats = []
  const errors = []
  const rowErrors = []
  const rows = []

  const read = (object, filters) => readAll(sourceAdapter, object, filters, options, readStats)
  const addGlobalError = (type, details = {}) => {
    errors.push({ type, ...details })
  }
  const addReadError = (err, object) => {
    const bounded = readLimitErrorDetails(err, object)
    if (bounded) {
      addGlobalError(bounded.type, bounded)
      return
    }
    addGlobalError('read_failed', { object, message: err && err.message })
  }
  const addRowError = (error) => {
    rowErrors.push(error)
  }
  const pushRow = (row) => {
    if (rows.length + 1 > options.maxRows) {
      addGlobalError('max_rows_exceeded', { maxRows: options.maxRows })
      return false
    }
    rows.push(row)
    return true
  }

  let pathMatches = []
  try {
    pathMatches = await read(plan.pathExAttr.object, { [plan.pathExAttr.matchField]: projectNo })
  } catch (err) {
    addReadError(err, plan.pathExAttr.object)
    return failureResult({
      projectNoPresent: true,
      matchField: plan.matchField,
      rows,
      errors,
      rowErrors,
      readStats,
      rootMatches: 0,
      maxDepth: options.maxDepth,
      maxRows: options.maxRows,
      maxPages: options.maxPages,
      maxReadCount: options.maxReadCount,
      maxElapsedMs: options.maxElapsedMs,
    })
  }

  if (pathMatches.length === 0) {
    return {
      valid: true,
      status: 'not_found',
      rows: [],
      errors: [],
      rowErrors: [],
      summary: makeSummary({
        projectNoPresent: true,
        matchField: plan.matchField,
        status: 'not_found',
        rowsExpanded: 0,
        rootMatches: 0,
        maxDepth: options.maxDepth,
        maxRows: options.maxRows,
        maxPages: options.maxPages,
        maxReadCount: options.maxReadCount,
        maxElapsedMs: options.maxElapsedMs,
        readStats,
        errors: [],
        rowErrors: [],
      }),
    }
  }

  async function readPart(componentSourceId, depth) {
    const matches = await read(plan.part.object, { [plan.part.idField]: componentSourceId })
    const candidates = matchesByField(matches, plan.part.idField, componentSourceId)
    if (candidates.length > 1) {
      addRowError({ type: 'ambiguous_component', field: plan.part.idField, depth })
      return undefined
    }
    const row = candidates[0]
    if (!row) {
      addRowError({ type: 'missing_component', field: plan.part.idField, depth })
      return undefined
    }
    return row
  }

  async function expandChildren(parentRow, pathTokens) {
    if (errors.length > 0) return
    const parentSourceId = parentRow.componentSourceId
    const nextDepth = parentRow.depth + 1
    const headFilters = { [plan.bomHead.parentPartField]: parentSourceId }
    if (plan.bomHead.versionField && !isBlank(parentRow.sourceVersion)) {
      headFilters[plan.bomHead.versionField] = parentRow.sourceVersion
    }
    let heads
    try {
      heads = (await read(plan.bomHead.object, headFilters)).filter((head) => isActiveBomHead(head, plan.bomHead.activeField))
    } catch (err) {
      addReadError(err, plan.bomHead.object)
      return
    }
    if (nextDepth > options.maxDepth && heads.length > 0) {
      addGlobalError('max_depth_exceeded', { maxDepth: options.maxDepth, parentDepth: parentRow.depth })
      return
    }
    for (const head of heads) {
      if (errors.length > 0) return
      const bomId = readField(head, plan.bomHead.bomIdField)
      if (isBlank(bomId)) {
        addRowError({ type: 'missing_bom_id', field: plan.bomHead.bomIdField, depth: parentRow.depth })
        continue
      }
      let details
      try {
        details = await read(plan.bomDetail.object, { [plan.bomDetail.bomParentField]: bomId })
      } catch (err) {
        addReadError(err, plan.bomDetail.object)
        return
      }
      for (const detail of details) {
        if (errors.length > 0) return
        const childSourceId = toKey(readField(detail, plan.bomDetail.componentIdField))
        if (childSourceId === null) {
          addRowError({ type: 'missing_component_source_id', field: plan.bomDetail.componentIdField, depth: nextDepth })
          continue
        }
        if (pathTokens.includes(childSourceId)) {
          addGlobalError('cycle_detected', { depth: nextDepth })
          return
        }
        const qty = parseQuantity(readField(detail, plan.bomDetail.quantityField), {
          field: plan.bomDetail.quantityField,
          depth: nextDepth,
          relation: 'child',
        })
        if (!qty.ok) {
          addRowError(qty.error)
          continue
        }
        const partRow = await readPart(childSourceId, nextDepth)
        if (!partRow) continue
        const childTokens = pathTokens.concat(childSourceId)
        const rowResult = rowFromPart(plan, {
          projectNo,
          parentSourceId,
          pathTokens: childTokens,
          depth: nextDepth,
          partRow,
          rawQuantity: qty.value,
          totalQuantity: parentRow.totalQuantity * qty.value,
          active: true,
          sortLine: plan.bomDetail.sortField ? readField(detail, plan.bomDetail.sortField) : undefined,
        })
        if (rowResult.error) {
          addRowError(rowResult.error)
          continue
        }
        if (!pushRow(rowResult.row)) return
        await expandChildren(rowResult.row, childTokens)
      }
    }
  }

  try {
    for (const pathRow of pathMatches) {
      if (errors.length > 0) break
      const pathId = readField(pathRow, plan.pathExAttr.pathIdField)
      if (isBlank(pathId)) {
        addRowError({ type: 'missing_path_id', field: plan.pathExAttr.pathIdField, depth: 0 })
        continue
      }
      const pathInfoMatches = await read(plan.pathInfo.object, { [plan.pathInfo.idField]: pathId })
      const pathInfoCandidates = matchesByField(pathInfoMatches, plan.pathInfo.idField, pathId)
      if (pathInfoCandidates.length > 1) {
        addRowError({ type: 'ambiguous_path', field: plan.pathInfo.idField, depth: 0 })
        continue
      }
      if (!pathInfoCandidates[0]) {
        addRowError({ type: 'missing_path', field: plan.pathInfo.idField, depth: 0 })
        continue
      }
      const orderHeads = await read(plan.orderHead.object, { [plan.orderHead.pathIdField]: pathId })
      for (const orderHead of orderHeads) {
        if (errors.length > 0) break
        const orderId = readField(orderHead, plan.orderHead.idField)
        if (isBlank(orderId)) {
          addRowError({ type: 'missing_order_id', field: plan.orderHead.idField, depth: 0 })
          continue
        }
        const details = await read(plan.orderDetail.object, { [plan.orderDetail.orderIdField]: orderId })
        for (const detail of details) {
          if (errors.length > 0) break
          const componentSourceId = toKey(readField(detail, plan.orderDetail.componentIdField))
          if (componentSourceId === null) {
            addRowError({ type: 'missing_component_source_id', field: plan.orderDetail.componentIdField, depth: 0 })
            continue
          }
          const qty = parseQuantity(readField(detail, plan.orderDetail.quantityField), {
            field: plan.orderDetail.quantityField,
            depth: 0,
            relation: 'root',
          })
          if (!qty.ok) {
            addRowError(qty.error)
            continue
          }
          const partRow = await readPart(componentSourceId, 0)
          if (!partRow) continue
          const pathTokens = [componentSourceId]
          const rowResult = rowFromPart(plan, {
            projectNo,
            parentSourceId: null,
            pathTokens,
            depth: 0,
            partRow,
            rawQuantity: qty.value,
            totalQuantity: qty.value,
            active: true,
            sortLine: plan.orderDetail.sortField ? readField(detail, plan.orderDetail.sortField) : undefined,
          })
          if (rowResult.error) {
            addRowError(rowResult.error)
            continue
          }
          if (!pushRow(rowResult.row)) break
          await expandChildren(rowResult.row, pathTokens)
        }
      }
    }
  } catch (err) {
    const bounded = readLimitErrorDetails(err)
    if (bounded) addGlobalError(bounded.type, bounded)
    else addGlobalError('read_failed', { message: err && err.message })
  }

  const status = errors.length > 0 || rowErrors.length > 0 ? 'failed' : 'expanded'
  return {
    valid: status === 'expanded',
    status,
    rows,
    errors,
    rowErrors,
    summary: makeSummary({
      projectNoPresent: true,
      matchField: plan.matchField,
      status,
      rowsExpanded: rows.length,
      rootMatches: pathMatches.length,
      maxDepth: options.maxDepth,
      maxRows: options.maxRows,
      maxPages: options.maxPages,
      maxReadCount: options.maxReadCount,
      maxElapsedMs: options.maxElapsedMs,
      readStats,
      errors,
      rowErrors,
    }),
  }
}

function summarizeBomExpansionForEvidence(result = {}) {
  const summary = isPlainObject(result.summary) ? result.summary : {}
  return {
    valid: result.valid === true,
    status: typeof result.status === 'string' ? result.status : summary.status,
    projectNoPresent: summary.projectNoPresent === true,
    matchField: summary.matchField,
    rowsExpanded: Number(summary.rowsExpanded || 0),
    rootMatches: Number(summary.rootMatches || 0),
    maxDepth: summary.maxDepth,
    maxRows: summary.maxRows,
    maxPages: summary.maxPages,
    maxReadCount: summary.maxReadCount,
    maxElapsedMs: summary.maxElapsedMs,
    readObjects: Array.isArray(summary.readObjects) ? summary.readObjects.slice() : [],
    readCount: Number(summary.readCount || 0),
    readDiagnostics: Array.isArray(summary.readDiagnostics) ? summary.readDiagnostics.map(readDiagnostic) : [],
    errorTypes: Array.isArray(summary.errorTypes) ? summary.errorTypes.slice() : [],
    largeBom: isLargeBomBoundedExpansion(result),
    boundedPreview: isLargeBomBoundedExpansion(result) ? boundedPreviewSummary(summary, scaleErrorTypes(result.errors)) : undefined,
    actions: isPlainObject(summary.actions) ? { ...summary.actions } : undefined,
  }
}

module.exports = {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ROWS,
  LARGE_BOM_BOUNDED_ERROR_TYPES,
  FORBIDDEN_PLAN_KEYS,
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  STOCK_PREPARATION_BOM_SOURCE_KINDS,
  StockPreparationBomExpansionError,
  normalizeStockPreparationBomReadPlan,
  expandPlmProjectBom,
  isLargeBomBoundedExpansion,
  summarizeBomExpansionForEvidence,
  __internals: {
    isBlank,
    isActiveBomHead,
    matchesByField,
    makeIdempotencyKey,
    makePath,
    parseQuantity,
    readAll,
    toKey,
    nonNegativeInteger,
  },
}
