'use strict'

// ---------------------------------------------------------------------------
// Yuantus PLM wrapper adapter - plugin-integration-core
//
// Source-side facade over the existing host PLM capability. This keeps the
// integration pipeline on the plugin-local adapter contract without importing
// or deleting the kernel PLMAdapter implementation.
// ---------------------------------------------------------------------------

const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
  createReadResult,
  normalizeExternalSystemForAdapter,
  normalizeReadRequest,
  unsupportedAdapterOperation,
} = require('../contracts.cjs')

const MATERIAL_OBJECTS = new Set(['material', 'materials', 'part', 'parts', 'product', 'products'])
const BOM_OBJECTS = new Set(['bom', 'boms', 'bom_line', 'bom_lines'])

const MATERIAL_SCHEMA = Object.freeze([
  { name: 'sourceId', label: 'PLM source id', type: 'string', required: true },
  { name: 'objectType', label: 'Object type', type: 'string' },
  { name: 'code', label: 'Material code', type: 'string', required: true },
  { name: 'name', label: 'Material name', type: 'string', required: true },
  { name: 'revision', label: 'Revision', type: 'string' },
  { name: 'uom', label: 'Unit of measure', type: 'string' },
  { name: 'category', label: 'Category', type: 'string' },
  { name: 'status', label: 'Status', type: 'string' },
  { name: 'updatedAt', label: 'Updated at', type: 'date' },
])

const BOM_SCHEMA = Object.freeze([
  { name: 'sourceId', label: 'PLM BOM line id', type: 'string', required: true },
  { name: 'parentId', label: 'Parent material id', type: 'string' },
  { name: 'parentCode', label: 'Parent material code', type: 'string', required: true },
  { name: 'childId', label: 'Child material id', type: 'string' },
  { name: 'childCode', label: 'Child material code', type: 'string', required: true },
  { name: 'quantity', label: 'Quantity', type: 'number', required: true },
  { name: 'uom', label: 'Unit of measure', type: 'string' },
  { name: 'sequence', label: 'Sequence', type: 'number' },
  { name: 'revision', label: 'Revision', type: 'string' },
  { name: 'updatedAt', label: 'Updated at', type: 'date' },
])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizeString(value) {
  if (value === undefined || value === null || value === '') return null
  return String(value)
}

function requireString(value, message, details = {}) {
  const normalized = normalizeString(value)
  if (!normalized) throw new AdapterValidationError(message, details)
  return normalized
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

function getPath(value, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined
    return current[key]
  }, value)
}

function unwrapQueryResult(result) {
  if (Array.isArray(result)) {
    return { records: result, metadata: {}, raw: result, error: null }
  }
  if (isPlainObject(result)) {
    const records = Array.isArray(result.data)
      ? result.data
      : Array.isArray(result.records)
        ? result.records
        : Array.isArray(result.items)
          ? result.items
          : []
    return {
      records,
      metadata: isPlainObject(result.metadata) ? result.metadata : {},
      raw: result,
      error: result.error || null,
    }
  }
  return { records: [], metadata: {}, raw: result, error: null }
}

function offsetFromCursor(cursor) {
  if (!cursor) return 0
  const numeric = Number(cursor)
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : 0
}

function nextCursorFrom(result, offset, limit, recordCount) {
  const metadata = result.metadata || {}
  const explicit = firstDefined(
    metadata.nextCursor,
    metadata.next_cursor,
    metadata.cursor,
    getPath(result.raw, 'nextCursor'),
    getPath(result.raw, 'pagination.nextCursor'),
  )
  if (explicit) return String(explicit)
  const total = Number(firstDefined(metadata.totalCount, metadata.total, metadata.count))
  if (Number.isFinite(total) && offset + recordCount < total) return String(offset + limit)
  if (recordCount >= limit && recordCount > 0) return String(offset + limit)
  return null
}

function normalizeMaterial(raw = {}, systemId) {
  const sourceId = normalizeString(firstDefined(raw.sourceId, raw.id, raw.itemId, raw.item_id, raw.productId, raw.product_id, raw.partId, raw.part_id))
  const code = normalizeString(firstDefined(raw.code, raw.number, raw.itemCode, raw.item_code, raw.productCode, raw.product_code, raw.partNumber, raw.part_number))
  const name = normalizeString(firstDefined(raw.name, raw.itemName, raw.item_name, raw.productName, raw.product_name, raw.displayName))
  const revision = normalizeString(firstDefined(raw.revision, raw.rev, raw.version, raw.versionNo, raw.version_no))
  const updatedAt = normalizeString(firstDefined(raw.updatedAt, raw.updated_at, raw.modifiedAt, raw.modified_at, raw.lastModifiedAt))
  const resolvedSourceId = requireString(sourceId || code, 'PLM material sourceId or code is required', {
    object: 'material',
    field: 'sourceId',
  })
  const resolvedCode = requireString(code, 'PLM material code is required', {
    object: 'material',
    field: 'code',
    sourceId: resolvedSourceId,
  })
  return {
    sourceSystemId: systemId || null,
    sourceId: resolvedSourceId,
    objectType: 'material',
    code: resolvedCode,
    name: requireString(name, 'PLM material name is required', {
      object: 'material',
      field: 'name',
      sourceId: resolvedSourceId,
    }),
    revision,
    uom: normalizeString(firstDefined(raw.uom, raw.unit, raw.unitName, raw.unit_name)),
    category: normalizeString(firstDefined(raw.category, raw.categoryName, raw.group, raw.materialGroup)),
    status: normalizeString(firstDefined(raw.status, raw.lifecycleState, raw.state)) || 'active',
    updatedAt,
    rawPayload: raw,
  }
}

function normalizeBomLine(raw = {}, systemId, parent = {}) {
  const parentId = normalizeString(firstDefined(raw.parentId, raw.parent_id, raw.productId, raw.product_id, parent.id, parent.sourceId))
  const parentCode = normalizeString(firstDefined(raw.parentCode, raw.parent_code, raw.productCode, raw.product_code, parent.code, parent.number, parentId))
  const childId = normalizeString(firstDefined(raw.childId, raw.child_id, raw.componentId, raw.component_id, raw.itemId, raw.item_id))
  const childCode = normalizeString(firstDefined(raw.childCode, raw.child_code, raw.componentCode, raw.component_code, raw.itemCode, raw.item_code, raw.code))
  const quantityValue = firstDefined(raw.quantity, raw.qty, raw.FQty, raw.amount)
  const quantity = quantityValue === null ? Number.NaN : Number(quantityValue)
  if (!Number.isFinite(quantity)) {
    throw new AdapterValidationError('PLM BOM quantity is required and must be numeric', {
      object: 'bom',
      field: 'quantity',
      parentCode,
      childCode,
    })
  }
  const resolvedParentCode = requireString(parentCode, 'PLM BOM parentCode is required', {
    object: 'bom',
    field: 'parentCode',
    childCode,
  })
  const resolvedChildCode = requireString(childCode, 'PLM BOM childCode is required', {
    object: 'bom',
    field: 'childCode',
    parentCode: resolvedParentCode,
  })
  const resolvedSourceId = requireString(firstDefined(
    raw.sourceId,
    raw.id,
    raw.bomLineId,
    raw.bom_line_id,
    `${resolvedParentCode}:${resolvedChildCode}`,
  ), 'PLM BOM sourceId is required', {
    object: 'bom',
    field: 'sourceId',
    parentCode: resolvedParentCode,
    childCode: resolvedChildCode,
  })
  return {
    sourceSystemId: systemId || null,
    sourceId: resolvedSourceId,
    objectType: 'bom',
    parentId,
    parentCode: resolvedParentCode,
    childId,
    childCode: resolvedChildCode,
    quantity,
    uom: normalizeString(firstDefined(raw.uom, raw.unit, raw.unitName, raw.unit_name)),
    sequence: firstDefined(raw.sequence, raw.seq, raw.lineNo, raw.line_no) ?? null,
    revision: normalizeString(firstDefined(raw.revision, raw.rev, parent.revision)),
    updatedAt: normalizeString(firstDefined(raw.updatedAt, raw.updated_at, parent.updatedAt)),
    rawPayload: raw,
  }
}

function bomChildren(node) {
  if (!isPlainObject(node)) return []
  if (Array.isArray(node.children)) return node.children
  if (Array.isArray(node.components)) return node.components
  if (Array.isArray(node.items)) return node.items
  return []
}

function isBomTreeRecord(record) {
  return isPlainObject(record) && bomChildren(record).length > 0
}

function bomNodeKey(node) {
  if (!isPlainObject(node)) return null
  return normalizeString(firstDefined(
    node.sourceId,
    node.id,
    node.itemId,
    node.item_id,
    node.componentId,
    node.component_id,
    node.code,
    node.number,
    node.itemCode,
    node.item_code,
    node.componentCode,
    node.component_code,
  ))
}

function flattenBomNode(node, parent = {}, acc = [], state = {}) {
  if (!isPlainObject(node)) return acc
  const depth = Number.isInteger(state.depth) ? state.depth : 0
  const maxDepth = Number.isInteger(state.maxDepth) ? state.maxDepth : 100
  if (depth > maxDepth) {
    throw new AdapterValidationError('PLM BOM tree exceeded maximum depth', {
      object: 'bom',
      maxDepth,
    })
  }
  const nodeKey = bomNodeKey(node)
  const path = state.path instanceof Set ? state.path : new Set()
  if (nodeKey && path.has(nodeKey)) return acc
  const nextPath = new Set(path)
  if (nodeKey) nextPath.add(nodeKey)
  const children = bomChildren(node)
  const currentParent = {
    id: firstDefined(node.id, node.itemId, node.item_id, parent.id),
    code: firstDefined(node.code, node.number, node.itemCode, node.item_code, parent.code),
    revision: firstDefined(node.revision, node.rev, parent.revision),
    updatedAt: firstDefined(node.updatedAt, node.updated_at, parent.updatedAt),
  }
  for (const child of children) {
    const childKey = bomNodeKey(child)
    if (childKey && nextPath.has(childKey)) continue
    acc.push({
      ...child,
      parentId: firstDefined(child.parentId, child.parent_id, currentParent.id),
      parentCode: firstDefined(child.parentCode, child.parent_code, currentParent.code),
    })
    flattenBomNode(child, {
      id: firstDefined(child.id, child.itemId, child.item_id, child.componentId, child.component_id),
      code: firstDefined(child.code, child.number, child.itemCode, child.item_code, child.componentCode, child.component_code),
      revision: firstDefined(child.revision, child.rev, currentParent.revision),
      updatedAt: firstDefined(child.updatedAt, child.updated_at, currentParent.updatedAt),
    }, acc, {
      path: nextPath,
      depth: depth + 1,
      maxDepth,
    })
  }
  return acc
}

function resolveClient({ plmClient, context, system }) {
  if (plmClient) return plmClient
  return context && context.api && context.api.plm ? context.api.plm : null
}

function createYuantusPlmWrapperAdapter({ system, plmClient, context, logger } = {}) {
  const normalizedSystem = normalizeExternalSystemForAdapter(system)
  const client = resolveClient({ plmClient, context, system: normalizedSystem })

  function requireClient() {
    if (!client) {
      throw new AdapterValidationError('Yuantus PLM wrapper requires context.api.plm or injected plmClient', {
        field: 'plmClient',
      })
    }
    return client
  }

  async function testConnection(input = {}) {
    try {
      const resolved = requireClient()
      if (typeof resolved.isConnected === 'function') {
        return { ok: Boolean(resolved.isConnected()), connected: Boolean(resolved.isConnected()) }
      }
      if (typeof resolved.getProducts === 'function') {
        await resolved.getProducts({ limit: input.limit || 1 })
        return { ok: true }
      }
      return { ok: false, code: 'PLM_CLIENT_UNSUPPORTED', message: 'PLM client does not expose getProducts()' }
    } catch (error) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(`[plugin-integration-core] Yuantus PLM wrapper testConnection failed: ${error && error.message ? error.message : error}`)
      }
      return {
        ok: false,
        code: error && error.details && error.details.field === 'plmClient' ? 'PLM_CLIENT_MISSING' : 'PLM_TEST_FAILED',
        message: error && error.message ? error.message : String(error),
      }
    }
  }

  async function listObjects() {
    return [
      { name: 'materials', label: 'PLM Materials', operations: ['read'], schema: MATERIAL_SCHEMA.map((field) => ({ ...field })) },
      { name: 'bom', label: 'PLM BOM Lines', operations: ['read'], schema: BOM_SCHEMA.map((field) => ({ ...field })) },
    ]
  }

  async function getSchema(input = {}) {
    const object = String(typeof input === 'string' ? input : input.object || '').toLowerCase()
    if (MATERIAL_OBJECTS.has(object)) return { object, fields: MATERIAL_SCHEMA.map((field) => ({ ...field })) }
    if (BOM_OBJECTS.has(object)) return { object, fields: BOM_SCHEMA.map((field) => ({ ...field })) }
    throw new AdapterValidationError(`Yuantus PLM object is not configured: ${object}`, { object })
  }

  async function read(input = {}) {
    const request = normalizeReadRequest(input)
    const object = request.object.toLowerCase()
    const resolved = requireClient()
    const offset = offsetFromCursor(request.cursor)
    const commonOptions = {
      ...request.filters,
      ...request.options,
      limit: request.limit,
      offset,
      cursor: request.cursor,
      watermark: request.watermark,
    }

    if (MATERIAL_OBJECTS.has(object)) {
      if (typeof resolved.getProducts !== 'function') {
        throw new AdapterValidationError('PLM client does not expose getProducts()', { method: 'getProducts' })
      }
      const queryResult = unwrapQueryResult(await resolved.getProducts(commonOptions))
      const records = queryResult.records.map((record) => normalizeMaterial(record, normalizedSystem.id))
      return createReadResult({
        records,
        nextCursor: nextCursorFrom(queryResult, offset, request.limit, records.length),
        done: nextCursorFrom(queryResult, offset, request.limit, records.length) === null,
        raw: queryResult.raw,
        metadata: {
          object: request.object,
          source: 'plm-wrapper',
          count: records.length,
        },
      })
    }

    if (BOM_OBJECTS.has(object)) {
      if (typeof resolved.getProductBOM !== 'function') {
        throw new AdapterValidationError('PLM client does not expose getProductBOM()', { method: 'getProductBOM' })
      }
      const productId = firstDefined(
        request.filters.productId,
        request.filters.product_id,
        request.options.productId,
        request.options.product_id,
        normalizedSystem.config.productId,
        normalizedSystem.config.defaultProductId,
      )
      if (!productId) {
        throw new AdapterValidationError('BOM read requires filters.productId or config.defaultProductId', {
          field: 'filters.productId',
        })
      }
      const queryResult = unwrapQueryResult(await resolved.getProductBOM(String(productId), commonOptions))
      const treeMode = queryResult.records.length === 1 && isBomTreeRecord(queryResult.records[0])
      const rawLines = treeMode ? flattenBomNode(queryResult.records[0]) : queryResult.records
      const pageLines = treeMode ? rawLines.slice(offset, offset + request.limit) : rawLines
      const parent = {
        id: normalizeString(productId),
        code: normalizeString(firstDefined(request.filters.parentCode, request.options.parentCode)),
        revision: normalizeString(firstDefined(request.filters.revision, request.options.revision)),
      }
      const records = pageLines.map((record) => normalizeBomLine(record, normalizedSystem.id, parent))
      const nextCursor = treeMode
        ? (offset + records.length < rawLines.length ? String(offset + request.limit) : null)
        : nextCursorFrom(queryResult, offset, request.limit, records.length)
      return createReadResult({
        records,
        nextCursor,
        done: nextCursor === null,
        raw: queryResult.raw,
        metadata: {
          object: request.object,
          source: 'plm-wrapper',
          productId: String(productId),
          count: records.length,
        },
      })
    }

    throw new UnsupportedAdapterOperationError(`${normalizedSystem.kind} object ${request.object} does not support read`, {
      kind: normalizedSystem.kind,
      object: request.object,
      operation: 'read',
    })
  }

  return {
    kind: normalizedSystem.kind,
    systemId: normalizedSystem.id,
    testConnection,
    listObjects,
    getSchema,
    read,
    upsert: unsupportedAdapterOperation(normalizedSystem.kind, 'upsert'),
  }
}

function createYuantusPlmWrapperAdapterFactory(defaults = {}) {
  return (input = {}) => createYuantusPlmWrapperAdapter({ ...defaults, ...input })
}

module.exports = {
  createYuantusPlmWrapperAdapter,
  createYuantusPlmWrapperAdapterFactory,
  __internals: {
    flattenBomNode,
    isBomTreeRecord,
    normalizeBomLine,
    normalizeMaterial,
    unwrapQueryResult,
  },
}
