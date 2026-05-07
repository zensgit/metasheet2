'use strict'

const { getPath, isBlank } = require('./transform-engine.cjs')

const TABLE = 'integration_watermarks'
const VALID_TYPES = new Set(['updated_at', 'monotonic_id'])

class WatermarkError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'WatermarkError'
    this.details = details
  }
}

function normalizeWatermarkConfig(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new WatermarkError('watermark config must be an object')
  }
  const type = config.type || config.watermarkType || 'updated_at'
  if (!VALID_TYPES.has(type)) {
    throw new WatermarkError(`unsupported watermark type: ${type}`, { type })
  }
  const field = config.field || config.watermarkField || (type === 'updated_at' ? 'updated_at' : 'id')
  return {
    type,
    field,
    fallbackFields: type === 'updated_at' ? ['updated_at', 'updatedAt'] : ['id'],
  }
}

function parseWatermarkValue(type, value) {
  if (!VALID_TYPES.has(type)) {
    throw new WatermarkError(`unsupported watermark type: ${type}`, { type })
  }
  if (isBlank(value)) return null
  if (type === 'updated_at') {
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) {
      throw new WatermarkError('updated_at watermark value must be a valid timestamp', { value })
    }
    return parsed
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    throw new WatermarkError('monotonic_id watermark value must be numeric', { value })
  }
  return numeric
}

function compareWatermarkValues(type, left, right) {
  if (isBlank(left)) return -1
  if (isBlank(right)) return 1
  return parseWatermarkValue(type, left) - parseWatermarkValue(type, right)
}

function valueToString(value) {
  return value instanceof Date ? value.toISOString() : String(value)
}

function getWatermarkFieldValue(record, config) {
  const value = getPath(record, config.field)
  if (!isBlank(value)) return value
  for (const field of config.fallbackFields) {
    if (field === config.field) continue
    const fallback = getPath(record, field)
    if (!isBlank(fallback)) return fallback
  }
  return undefined
}

function deriveNextWatermark(records, config = {}) {
  const normalized = normalizeWatermarkConfig(config)
  let next = null
  for (const record of records || []) {
    const value = getWatermarkFieldValue(record, normalized)
    if (isBlank(value)) continue
    if (next === null || compareWatermarkValues(normalized.type, value, next) > 0) {
      next = valueToString(value)
    }
  }
  return next === null ? null : {
    type: normalized.type,
    value: next,
  }
}

function createWatermarkStore({ db } = {}) {
  if (!db || typeof db.selectOne !== 'function' || typeof db.insertOne !== 'function' || typeof db.updateRow !== 'function') {
    throw new Error('createWatermarkStore: scoped db helper is required')
  }

  async function getWatermark(pipelineId) {
    if (isBlank(pipelineId)) throw new WatermarkError('pipelineId is required')
    const row = await db.selectOne(TABLE, { pipeline_id: pipelineId })
    if (!row) return null
    return getWatermarkFromRow(row)
  }

  async function setWatermark(input = {}) {
    const { pipelineId, type, value } = input
    const normalized = normalizeWatermarkConfig({ type })
    if (isBlank(pipelineId)) throw new WatermarkError('pipelineId is required')
    if (isBlank(value)) throw new WatermarkError('watermark value is required')
    parseWatermarkValue(normalized.type, value)
    const existing = await db.selectOne(TABLE, { pipeline_id: pipelineId })
    const row = {
      pipeline_id: pipelineId,
      watermark_type: normalized.type,
      watermark_value: String(value),
    }
    if (existing) {
      const rows = await db.updateRow(TABLE, row, { pipeline_id: pipelineId })
      return getWatermarkFromRow((Array.isArray(rows) ? rows : rows?.rows || [])[0] || { ...existing, ...row })
    }
    const rows = await db.insertOne(TABLE, row)
    return getWatermarkFromRow((Array.isArray(rows) ? rows : rows?.rows || [])[0] || row)
  }

  async function advanceWatermark(input = {}) {
    const { pipelineId, type, value } = input
    const normalized = normalizeWatermarkConfig({ type })
    if (isBlank(pipelineId)) throw new WatermarkError('pipelineId is required')
    if (isBlank(value)) throw new WatermarkError('watermark value is required')
    parseWatermarkValue(normalized.type, value)

    const existing = await db.selectOne(TABLE, { pipeline_id: pipelineId })
    if (
      existing &&
      existing.watermark_type === normalized.type &&
      compareWatermarkValues(normalized.type, value, existing.watermark_value) <= 0
    ) {
      return getWatermarkFromRow(existing)
    }
    return setWatermark({ pipelineId, type: normalized.type, value })
  }

  return {
    advanceWatermark,
    advanceIfGreater: advanceWatermark,
    getWatermark,
    setWatermark,
  }
}

function getWatermarkFromRow(row) {
  return {
    pipelineId: row.pipeline_id,
    type: row.watermark_type,
    value: row.watermark_value,
    updatedAt: row.updated_at ?? null,
  }
}

module.exports = {
  TABLE,
  VALID_TYPES,
  WatermarkError,
  compareWatermarkValues,
  createWatermarkStore,
  deriveNextWatermark,
  getWatermarkFieldValue,
  normalizeWatermarkConfig,
  parseWatermarkValue,
}
