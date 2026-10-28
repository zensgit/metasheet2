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

// The transform chain runs with no context in every case but one, so this frozen empty object is
// the shape every other caller sees.
const EMPTY_TRANSFORM_CONTEXT = Object.freeze({})

// Compatibility key for the "source path absent" branch of transformRecord(), and ONLY for that
// branch. Before this cut the chain never saw `undefined` for an absent path: the value fill-in
// handed it `mapping.defaultValue`, which for every registry-stored mapping is `null`
// (`pipelines.cjs:318` / `:201`). `dictMap` is a LOOKUP TABLE, so a map carrying a "null" key is
// an operator writing down "and if the source says nothing here, write this" - and before this
// cut that key really did fire and really did write a non-empty value. This returns the key the
// pre-change engine would have looked up, so that answer stays writable.
//
// It returns a KEY, never a value, and only `dictMap` consults it. Normalising `undefined` to
// `null` for the whole chain instead would hand `trim`/`upper`/`lower`/`toNumber`/`toDate` a
// `null` to pass through as their own answer; `outputValue` would stop being `undefined`, and the
// blanking write this cut removes would come straight back.
function absentSourceLookupKey(mapping) {
  return Object.prototype.hasOwnProperty.call(mapping, 'defaultValue')
    ? String(mapping.defaultValue)
    : 'undefined'
}

function applyTransform(value, step, sourceRecord, context = EMPTY_TRANSFORM_CONTEXT) {
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
      // `context.absentSourceKey` is set only by transformRecord()'s absent-source branch
      // (see absentSourceLookupKey()); with no context this is byte-for-byte the previous lookup.
      // It swaps the LOOKUP KEY, never the value: on a MISS the chain still carries `undefined`,
      // so `outputValue === undefined` still holds and the target still goes unwritten.
      const lookup = value === undefined && typeof context.absentSourceKey === 'string'
        ? context.absentSourceKey
        : value
      const key = String(lookup)
      if (Object.prototype.hasOwnProperty.call(args.map, key)) return args.map[key]
      if (Object.prototype.hasOwnProperty.call(args.map, lookup)) return args.map[lookup]
      if (Object.prototype.hasOwnProperty.call(args, 'defaultValue')) return args.defaultValue
      return value
    }
    default:
      throw new TransformError(`unsupported transform: ${fn}`, { fn })
  }
}

function transformValue(value, transform, sourceRecord = {}, context = EMPTY_TRANSFORM_CONTEXT) {
  return normalizeTransformList(transform).reduce(
    (current, step) => applyTransform(current, step, sourceRecord, context),
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
      // wins before the transform chain runs. `usedDefault` drives ONLY that value precedence and
      // is byte-identical to the pre-change condition (919582e71 `:233`).
      const usedDefault = isBlank(fieldValue)
        && Object.prototype.hasOwnProperty.call(mapping, 'defaultValue')
      // ...but "the key is present" is NOT "the operator supplied a default", and gating the
      // no-write branch on the key made that branch unreachable on every stored pipeline: the
      // registry puts a `defaultValue` key on EVERY mapping it hands back - `pipelines.cjs:318`
      // `parseJsonbValue(row.default_value, null)` for a SQL NULL column, `pipelines.cjs:201`
      // `mapping.defaultValue === undefined ? null : ...` on the write side. `null` is exactly how
      // the registry encodes "unset", and `:201` collapses `undefined` into that same `null`, so
      // neither can mean "a default supplied this value".
      const defaultApplied = usedDefault
        && mapping.defaultValue !== null
        && mapping.defaultValue !== undefined
      // Fill in EXACTLY as before whenever the source path existed (a present-but-blank value
      // keeps collapsing to the configured default, byte-for-byte as pre-change) and whenever a
      // real default was supplied. The single case left out is "path absent AND the default is
      // itself unset", where the fill-in would manufacture a null out of nothing and then hand
      // that null to the chain - which is what made the no-write branch unreachable a second,
      // independent time (outputValue became null, never undefined).
      if (defaultApplied || (usedDefault && resolved.found)) fieldValue = mapping.defaultValue

      // Built for EXACTLY the branch that would otherwise skip the write, and consulted by
      // `dictMap` alone (absentSourceLookupKey()). A mapping whose dictionary answers the key the
      // pre-change engine looked up still produces that answer, so the promise below - "a pipeline
      // that writes a non-empty value today keeps writing it" - holds for dictMaps too.
      const transformContext = !resolved.found && !defaultApplied
        ? { absentSourceKey: absentSourceLookupKey(mapping) }
        : EMPTY_TRANSFORM_CONTEXT
      const outputValue = transformValue(fieldValue, mapping.transform, sourceRecord, transformContext)

      // Do not write only when ALL THREE hold: the source path was absent from this record, no
      // default actually supplied a value, and the transform chain produced nothing of its own.
      // A `concat` that produced a NON-EMPTY value, a `dictMap` fallback, or a `dictMap` whose
      // dictionary carries the pre-change lookup key (its "null" entry - see
      // absentSourceLookupKey()) still writes exactly as before - a bare `concat` whose parts
      // are all absent still produces '' and is still written; widening this condition to
      // isBlank() would stop writing values a chain was asked
      // to manufacture (`{fn:'defaultValue', value:''}`), which is the one thing this cut refuses
      // to do. A path that EXISTS holding null or '' is the source genuinely clearing the value
      // and is written as before.
      if (!resolved.found && !defaultApplied && outputValue === undefined) {
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
    absentSourceLookupKey,
    applyTransform,
    DANGEROUS_PATH_SEGMENTS,
    isPlainObject,
    normalizeTransformList,
    normalizeTransformStep,
    normalizeFiniteNumber,
    parseTargetPath,
  },
}
