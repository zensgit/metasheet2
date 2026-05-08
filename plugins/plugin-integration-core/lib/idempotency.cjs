'use strict'

const crypto = require('node:crypto')
const { getPath, isBlank } = require('./transform-engine.cjs')

function stableStringify(value) {
  if (value === undefined) return '"__undefined__"'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function normalizePart(value, field) {
  if (isBlank(value)) {
    throw new Error(`computeIdempotencyKey: ${field} is required`)
  }
  return String(value)
}

function normalizeRevision(value) {
  if (value === undefined || value === null) return ''
  return String(value)
}

function normalizeDimensions(value) {
  if (value === undefined || value === null) return undefined
  if (!isPlainObject(value)) {
    throw new Error('computeIdempotencyKey: dimensions must be an object')
  }
  const normalized = Object.create(null)
  for (const [field, part] of Object.entries(value)) {
    normalized[field] = normalizePart(part, `dimensions.${field}`)
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeIdempotencyInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('computeIdempotencyKey: input must be an object')
  }
  const normalized = {
    sourceSystem: normalizePart(input.sourceSystem ?? input.sourceSystemId, 'sourceSystem'),
    objectType: normalizePart(input.objectType ?? input.sourceObject, 'objectType'),
    sourceId: normalizePart(input.sourceId, 'sourceId'),
    revision: normalizeRevision(input.revision),
    targetSystem: normalizePart(input.targetSystem ?? input.targetSystemId, 'targetSystem'),
  }
  const dimensions = normalizeDimensions(input.dimensions)
  if (dimensions) normalized.dimensions = dimensions
  return normalized
}

function computeIdempotencyKey(input = {}) {
  const raw = stableStringify(normalizeIdempotencyInput(input))
  return `idem_${crypto.createHash('sha256').update(raw).digest('hex')}`
}

function computeRecordIdempotencyKey({ record, pipeline, sourceSystem, targetSystem } = {}) {
  if (!pipeline || typeof pipeline !== 'object') {
    throw new Error('computeRecordIdempotencyKey: pipeline is required')
  }
  const keyFields = Array.isArray(pipeline.idempotencyKeyFields) ? pipeline.idempotencyKeyFields : []
  const sourceIdField = keyFields[0] || 'id'
  const revisionField = keyFields[1] || 'revision'
  const dimensions = Object.create(null)
  for (const field of keyFields.slice(2)) {
    dimensions[field] = getPath(record, field)
  }
  return computeIdempotencyKey({
    sourceSystemId: (sourceSystem && sourceSystem.id) || pipeline.sourceSystemId,
    objectType: pipeline.sourceObject,
    sourceId: getPath(record, sourceIdField),
    revision: getPath(record, revisionField),
    dimensions,
    targetSystemId: (targetSystem && targetSystem.id) || pipeline.targetSystemId,
  })
}

module.exports = {
  computeIdempotencyKey,
  computeRecordIdempotencyKey,
  normalizeIdempotencyInput,
  stableStringify,
}
