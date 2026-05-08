'use strict'

// ---------------------------------------------------------------------------
// Transform engine - plugin-integration-core
//
// Only fixed, built-in transforms are supported. This module must never run
// user-provided JavaScript from pipeline configuration.
// ---------------------------------------------------------------------------

const SUPPORTED_TRANSFORMS = new Set([
  'trim',
  'upper',
  'lower',
  'toNumber',
  'toDate',
  'defaultValue',
  'concat',
  'dictMap',
])
const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

class TransformError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'TransformError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getPath(record, path) {
  if (!path) return undefined
  return String(path).split('.').reduce((current, key) => {
    if (current === undefined || current === null) return undefined
    return current[key]
  }, record)
}

function setPath(record, path, value) {
  const parts = String(path || '').split('.').filter(Boolean)
  if (parts.length === 0) {
    throw new TransformError('targetField is required')
  }
  for (const part of parts) {
    if (DANGEROUS_PATH_SEGMENTS.has(part)) {
      throw new TransformError('targetField contains an unsafe path segment', { segment: part })
    }
  }

  let current = record
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    if (!isPlainObject(current[key])) current[key] = {}
    current = current[key]
  }
  current[parts[parts.length - 1]] = value
}

function isBlank(value) {
  return value === undefined || value === null || value === ''
}

function isBlankAfterTrim(value) {
  return typeof value === 'string' && value.trim() === ''
}

function normalizeFiniteNumber(value) {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    throw new TransformError('toNumber failed', { value })
  }
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '')
    if (normalized === '') return ''
    const numeric = Number(normalized)
    if (Number.isFinite(numeric)) return numeric
  }
  throw new TransformError('toNumber failed', { value })
}

function normalizeTransformList(transform) {
  if (transform === undefined || transform === null) return []
  if (Array.isArray(transform)) return transform
  if (isPlainObject(transform) && Array.isArray(transform.steps)) return transform.steps
  return [transform]
}

function normalizeTransformStep(step) {
  if (typeof step === 'string') return { fn: step.trim(), args: {} }
  if (!isPlainObject(step)) {
    throw new TransformError('transform step must be a string or object', { stepType: typeof step })
  }

  const fn = typeof step.fn === 'string'
    ? step.fn
    : typeof step.type === 'string'
      ? step.type
      : ''
  const normalizedFn = fn.trim()
  if (!normalizedFn) {
    throw new TransformError('transform step fn is required', { step })
  }

  const args = isPlainObject(step.args) ? { ...step.args } : { ...step }
  delete args.fn
  delete args.type
  delete args.args

  return {
    fn: normalizedFn,
    args,
  }
}

function applyTransform(value, step, sourceRecord) {
  const { fn, args } = normalizeTransformStep(step)
  if (!SUPPORTED_TRANSFORMS.has(fn)) {
    throw new TransformError(`unsupported transform: ${fn}`, { fn })
  }

  switch (fn) {
    case 'trim':
      return value === undefined || value === null ? value : String(value).trim()
    case 'upper':
      return value === undefined || value === null ? value : String(value).toUpperCase()
    case 'lower':
      return value === undefined || value === null ? value : String(value).toLowerCase()
    case 'toNumber': {
      if (isBlank(value)) return value
      return normalizeFiniteNumber(value)
    }
    case 'toDate': {
      if (isBlank(value)) return value
      const normalized = typeof value === 'string' ? value.trim() : value
      if (normalized === '') return ''
      const date = value instanceof Date ? value : new Date(normalized)
      if (Number.isNaN(date.getTime())) {
        throw new TransformError('toDate failed', { value })
      }
      return args.format === 'date' ? date.toISOString().slice(0, 10) : date.toISOString()
    }
    case 'defaultValue': {
      const fallback = Object.prototype.hasOwnProperty.call(args, 'value') ? args.value : args.defaultValue
      return isBlank(value) || isBlankAfterTrim(value) ? fallback : value
    }
    case 'concat': {
      if (args.fields !== undefined && !Array.isArray(args.fields)) {
        throw new TransformError('concat fields must be an array', { fields: args.fields })
      }
      if (args.values !== undefined && !Array.isArray(args.values)) {
        throw new TransformError('concat values must be an array', { values: args.values })
      }

      const separator = args.separator === undefined ? '' : String(args.separator)
      const parts = []
      if (args.includeCurrent !== false) parts.push(value)
      for (const field of args.fields || []) parts.push(getPath(sourceRecord, field))
      for (const literal of args.values || []) parts.push(literal)

      return parts
        .filter((part) => !isBlank(part) && !isBlankAfterTrim(part))
        .map((part) => String(part))
        .join(separator)
    }
    case 'dictMap': {
      if (!isPlainObject(args.map)) {
        throw new TransformError('dictMap map must be an object', { map: args.map })
      }
      const key = String(value)
      if (Object.prototype.hasOwnProperty.call(args.map, key)) return args.map[key]
      if (Object.prototype.hasOwnProperty.call(args.map, value)) return args.map[value]
      if (Object.prototype.hasOwnProperty.call(args, 'defaultValue')) return args.defaultValue
      return value
    }
    default:
      throw new TransformError(`unsupported transform: ${fn}`, { fn })
  }
}

function transformValue(value, transform, sourceRecord = {}) {
  return normalizeTransformList(transform).reduce(
    (current, step) => applyTransform(current, step, sourceRecord),
    value,
  )
}

function transformRecord(sourceRecord, fieldMappings = []) {
  if (!isPlainObject(sourceRecord)) {
    throw new TransformError('sourceRecord must be an object')
  }
  if (!Array.isArray(fieldMappings)) {
    throw new TransformError('fieldMappings must be an array')
  }

  const value = {}
  const errors = []

  fieldMappings.forEach((mapping, index) => {
    const targetField = mapping && mapping.targetField
    try {
      if (!isPlainObject(mapping)) {
        throw new TransformError('field mapping must be an object')
      }
      if (!targetField) throw new TransformError('targetField is required')

      let fieldValue = getPath(sourceRecord, mapping.sourceField)
      if (isBlank(fieldValue) && Object.prototype.hasOwnProperty.call(mapping, 'defaultValue')) {
        fieldValue = mapping.defaultValue
      }

      setPath(value, targetField, transformValue(fieldValue, mapping.transform, sourceRecord))
    } catch (error) {
      errors.push({
        field: targetField || null,
        sourceField: mapping && mapping.sourceField,
        index,
        code: 'TRANSFORM_FAILED',
        message: error.message,
        details: error.details || {},
      })
    }
  })

  return {
    ok: errors.length === 0,
    value,
    errors,
  }
}

module.exports = {
  SUPPORTED_TRANSFORMS,
  TransformError,
  getPath,
  isBlank,
  setPath,
  transformValue,
  transformRecord,
  __internals: {
    applyTransform,
    DANGEROUS_PATH_SEGMENTS,
    isPlainObject,
    normalizeTransformList,
    normalizeTransformStep,
    normalizeFiniteNumber,
  },
}
