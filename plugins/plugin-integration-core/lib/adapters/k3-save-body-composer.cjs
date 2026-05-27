'use strict'

// Single source of truth for K3 WISE Save-body composition (DF-T1-0).
//
// Both the adapter Save path (`k3-wise-webapi-adapter.cjs` `buildSaveBody`) and the no-write
// template preview (`http-routes.cjs` `buildTemplatePreview`) compose through THIS module, so
// a preview is byte-identical to what the adapter would actually Save. Previously each side
// had its own copy (`applyReferenceShape` vs `applyPreviewReferenceShape`, `projectRecordForBody`
// vs `projectRecordForTemplate`) and they had drifted (fail-closed + customer preset lived only
// in the adapter), which made the preview a false-confidence surface.
//
// Ownership boundary: this module owns SHAPING + PROJECTION + placeholder DETECTION only. It
// does NOT own disposition — the adapter Save throws on unfilled placeholders
// (`K3_WISE_PRESET_PLACEHOLDER_UNFILLED`); the preview reports them as a validation error. Both
// consume `findUnfilledPlaceholders()`, so detection is identical and disposition is the caller's.

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBlankValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function normalizeReferenceIdentifier(field) {
  const reference = field && isPlainObject(field.reference) ? field.reference : null
  const identifier = firstDefined(
    reference && reference.identifier,
    reference && reference.identifierField,
    reference && reference.key,
  )
  return typeof identifier === 'string' && identifier.trim() ? identifier.trim() : null
}

// Scalar reference values are wrapped as `{ [identifier]: value }`; values that are already
// objects pass through verbatim (two-field `{FNumber,FName}` / `{FID,FName}` are preserved).
function applyReferenceShape(value, field) {
  const identifier = normalizeReferenceIdentifier(field)
  if (!identifier || isBlankValue(value) || isPlainObject(value)) return value
  return { [identifier]: value }
}

// Project an already field-mapped/transformed record into the schema's fields, applying the
// per-field reference shape and dropping blank values. Pure: no placeholder enforcement here.
function projectRecordForBody(record, objectConfig) {
  if (objectConfig && objectConfig.passThroughBody === true) return record
  if (!isPlainObject(record)) return record
  const schema = Array.isArray(objectConfig && objectConfig.schema) ? objectConfig.schema : []
  const hasNamedField = schema.some((field) => field && typeof field.name === 'string' && field.name.trim().length > 0)
  if (!hasNamedField) return record
  const projected = {}
  for (const field of schema) {
    const fieldName = field && field.name
    if (typeof fieldName !== 'string' || fieldName.trim().length === 0) continue
    if (Object.prototype.hasOwnProperty.call(record, fieldName)) {
      const value = applyReferenceShape(record[fieldName], field)
      if (!isBlankValue(value)) projected[fieldName] = value
    }
  }
  return projected
}

// Wrap the projected record under the configured bodyKey, merging an optional bodyTemplate
// base. Mirrors the adapter's schema-driven Save body. Function-style bodies (objectConfig.
// buildBody) and passThroughBody stay the adapter's concern; this covers the schema-driven case.
function composeSchemaBody(record, objectConfig) {
  const bodyKey = (objectConfig && objectConfig.bodyKey) || 'Data'
  const base = isPlainObject(objectConfig && objectConfig.bodyTemplate)
    ? JSON.parse(JSON.stringify(objectConfig.bodyTemplate))
    : {}
  const projected = projectRecordForBody(record, objectConfig)
  base[bodyKey] = isPlainObject(base[bodyKey]) && isPlainObject(projected)
    ? { ...base[bodyKey], ...projected }
    : projected
  return base
}

// A value that IS exactly a `<…>` token (template placeholder), not one that merely contains
// angle brackets — so a legitimate value like "<M6>" is not over-matched unless it is a bare
// sentinel.
const PLACEHOLDER_SENTINEL = /^<[^>]+>$/

// Detection only: return the dotted paths of every unfilled `<…>` placeholder in `value`
// (reference shapes nest the placeholder one level down). Callers own disposition — the
// adapter Save throws, the preview reports `valid: false`.
function findUnfilledPlaceholders(value, basePath = '') {
  const found = []
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (PLACEHOLDER_SENTINEL.test(node.trim())) found.push(path || '(root)')
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`))
      return
    }
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        walk(child, path ? `${path}.${key}` : key)
      }
    }
  }
  walk(value, basePath)
  return found
}

module.exports = {
  isPlainObject,
  isBlankValue,
  normalizeReferenceIdentifier,
  applyReferenceShape,
  projectRecordForBody,
  composeSchemaBody,
  PLACEHOLDER_SENTINEL,
  findUnfilledPlaceholders,
}
