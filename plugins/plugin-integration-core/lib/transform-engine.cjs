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

// A coded, NON-FATAL notice. "The source record does not carry this key at all" is not the same
// fact as "the source emptied this value": the first says the source never spoke about the field,
// the second says it spoke and said nothing. Writing `undefined` for the first blanks a target
// column out of silence. Mappings whose source path is absent, that carry no defaultValue, and
// whose transform chain produced nothing are therefore left UNWRITTEN, and the fact is reported
// under this code instead of disappearing. It never flips `ok` - a pipeline that runs green today
// keeps running green, it just stops writing holes.
const SOURCE_FIELD_ABSENT = 'SOURCE_FIELD_ABSENT'

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
  return parsePathSegments(path).reduce((current, part) => {
    if (current === undefined || current === null) return undefined
    const value = current[part.key]
    return part.array ? (Array.isArray(value) ? value[0] : undefined) : value
  }, record)
}

// Same traversal as getPath(), and the VALUE it returns is produced by the identical expression, so
// it cannot drift from getPath()'s answer. What it adds is `found`: whether every segment of the
// path was an own property that actually existed. getPath() alone collapses "absent key" and "key
// present holding undefined" into one `undefined`, which is exactly the ambiguity that let an
// absent source column overwrite a correct target value.
//
// getPath() itself is deliberately left byte-identical: it is exported and read by the validator,
// the watermark reader, the idempotency key, the K3 body composer and the reference-mapping
// resolver, none of which are in this change's blast radius.
function resolveSourcePath(record, path) {
  if (!path) return { found: false, value: undefined }
  const parts = parsePathSegments(path)
  if (parts.length === 0) return { found: false, value: undefined }
  let found = true
  const value = parts.reduce((current, part) => {
    if (current === undefined || current === null) {
      found = false
      return undefined
    }
    if (found && !Object.prototype.hasOwnProperty.call(current, part.key)) found = false
    const next = current[part.key]
    if (part.array) {
      // An absent array, a non-array, and an empty array all mean "no element 0 to read".
      if (!Array.isArray(next) || next.length === 0) found = false
      return Array.isArray(next) ? next[0] : undefined
    }
    return next
  }, record)
  return { found, value }
}

function parsePathSegments(path) {
  return String(path || '').split('.').filter(Boolean).map((part) => {
    const array = part.endsWith('[]')
    const key = array ? part.slice(0, -2) : part
    if (!key) {
      throw new TransformError('targetField contains an empty path segment', { segment: part })
    }
    return { key, array }
  })
}

// The write-side path guard, lifted out of setPath() unchanged so that the "do not write" branch in
// transformRecord() can still run it. Skipping the write must not also skip the guard: a mapping
// with an unsafe targetField has to keep failing whether or not its source field happened to be
// absent in this particular record.
function parseTargetPath(path) {
  const parts = parsePathSegments(path)
  if (parts.length === 0) {
    throw new TransformError('targetField is required')
  }
  for (const part of parts) {
    if (DANGEROUS_PATH_SEGMENTS.has(part.key)) {
      throw new TransformError('targetField contains an unsafe path segment', { segment: part.key })
    }
  }
  return parts
}

function setPath(record, path, value) {
  const parts = parseTargetPath(path)

  let current = record
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (part.array) {
      if (!Array.isArray(current[part.key])) current[part.key] = [{}]
      if (!isPlainObject(current[part.key][0])) current[part.key][0] = {}
      current = current[part.key][0]
      continue
    }
    if (!isPlainObject(current[part.key])) current[part.key] = {}
    current = current[part.key]
  }
  const last = parts[parts.length - 1]
  if (last.array) {
    current[last.key] = [value]
    return
  }
  current[last.key] = value
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
  const warnings = []

  fieldMappings.forEach((mapping, index) => {
    const targetField = mapping && mapping.targetField
    try {
      if (!isPlainObject(mapping)) {
        throw new TransformError('field mapping must be an object')
      }
      if (!targetField) throw new TransformError('targetField is required')

      const resolved = resolveSourcePath(sourceRecord, mapping.sourceField)
      let fieldValue = resolved.value
      // Unchanged precedence: a configured defaultValue still fills in for a blank, and it still
      // wins before the transform chain runs. `usedDefault` only records that it DID fill in, so
      // the absent branch below cannot swallow a value the operator asked for.
      const usedDefault = isBlank(fieldValue)
        && Object.prototype.hasOwnProperty.call(mapping, 'defaultValue')
      if (usedDefault) fieldValue = mapping.defaultValue

      const outputValue = transformValue(fieldValue, mapping.transform, sourceRecord)

      // Do not write only when ALL THREE hold: the source path was absent from this record, no
      // defaultValue was applied, and the transform chain produced nothing of its own (a `concat`
      // of literals or a `dictMap` fallback still writes, exactly as before). A path that EXISTS
      // holding null or '' is the source genuinely clearing the value and is written as before.
      if (!resolved.found && !usedDefault && outputValue === undefined) {
        // Run the write-side path guard anyway - see parseTargetPath(). Its throw is caught below
        // and recorded as TRANSFORM_FAILED, exactly as setPath()'s throw was.
        parseTargetPath(targetField)
        warnings.push({
          field: targetField,
          sourceField: mapping.sourceField,
          index,
          code: SOURCE_FIELD_ABSENT,
          message: 'source field is absent from this record; target field left unwritten',
          details: {},
        })
        return
      }

      setPath(value, targetField, outputValue)
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
    // `ok` still means "no TRANSFORM_FAILED". Absent source fields are reported, not failed:
    // making them fail would break pipelines that run green today and would move the watermark
    // question, neither of which belongs in this change.
    ok: errors.length === 0,
    value,
    errors,
    warnings,
  }
}

module.exports = {
  SOURCE_FIELD_ABSENT,
  SUPPORTED_TRANSFORMS,
  TransformError,
  getPath,
  isBlank,
  resolveSourcePath,
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
    parseTargetPath,
  },
}
