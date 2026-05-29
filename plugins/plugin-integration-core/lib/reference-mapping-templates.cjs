'use strict'

// DF-T3a: built-in reference-mapping sheet TEMPLATES (schema-only) + a normalizer + a pure
// "create-from-template → empty sheet STRUCTURE" helper. LATENT contract (mirrors T1A/T2a):
// it provisions NO real multitable sheet, holds NO customer rows/values, has NO resolver, and does
// NOT touch from_reference_table runtime or the Save body. Per DF-T3 design (#2036): one row =
// sourceCode → a full K3 reference object; here we only define the empty sheet's columns.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')

const REFERENCE_MAPPING_IDENTIFIERS = Object.freeze(['FNumber', 'FID'])
const COMPLETENESS_BY_IDENTIFIER = Object.freeze({ FNumber: 'require-fnumber-fname', FID: 'require-fid-fname' })
// Column type vocabulary. Intentionally small + decoupled from multitable field-type names; the
// create-runtime slice maps these to real field types.
const COLUMN_TYPES = Object.freeze(['text', 'checkbox'])
// Keys that would carry customer data/content — forbidden on a schema-only manifest.
const FORBIDDEN_CONTENT_KEYS = Object.freeze(['rows', 'records', 'data', 'values', 'content'])

class ReferenceMappingTemplateError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ReferenceMappingTemplateError'
    this.details = details
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReferenceMappingTemplateError(`${field} is required`, { field })
  }
  return value.trim()
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ReferenceMappingTemplateError(`${field} must be a boolean`, { field })
  }
  return value
}

// A string is "secret-shaped" iff the shared scrubber would change it. A schema (column names /
// labels) must never be secret-shaped — reject rather than scrub.
function isSecretShaped(str) {
  return scrubSecretStringValue(str) !== str
}

// The identifier component column name for a domain: BY_NUMBER → fNumber, BY_ID → fID.
function identifierColumn(identifier) {
  return identifier === 'FID' ? 'fID' : 'fNumber'
}

function normalizeColumn(col, index) {
  const at = `columns[${index}]`
  if (!isPlainObject(col)) {
    throw new ReferenceMappingTemplateError(`${at} must be an object`, { field: at })
  }
  // Schema only: a column describes structure, never a value/default (that would smuggle content in).
  for (const contentKey of ['value', 'default', 'values']) {
    if (contentKey in col) {
      throw new ReferenceMappingTemplateError(`${at} must not carry a ${contentKey} (schema only, no content)`, { field: `${at}.${contentKey}` })
    }
  }
  const name = requiredString(col.name, `${at}.name`)
  if (isSecretShaped(name)) {
    throw new ReferenceMappingTemplateError(`${at}.name must not be secret-shaped`, { field: `${at}.name` })
  }
  const type = requiredString(col.type, `${at}.type`)
  if (!COLUMN_TYPES.includes(type)) {
    throw new ReferenceMappingTemplateError(`${at}.type must be one of ${COLUMN_TYPES.join(', ')}`, { field: `${at}.type`, value: type })
  }
  const out = { name, type }
  if (col.required !== undefined) out.required = requiredBoolean(col.required, `${at}.required`)
  if (col.key !== undefined) out.key = requiredBoolean(col.key, `${at}.key`)
  return out
}

// Normalize/validate a schema-only reference-mapping template manifest. Fails closed on customer
// content, secret-shaped names, a bad identifier/completeness, or a missing required column.
function normalizeReferenceMappingTemplate(input) {
  if (!isPlainObject(input)) {
    throw new ReferenceMappingTemplateError('template must be a plain object')
  }
  // No customer content may ride on a schema-only manifest.
  for (const key of FORBIDDEN_CONTENT_KEYS) {
    if (key in input) {
      throw new ReferenceMappingTemplateError(`template must not carry "${key}" (schema only — no customer rows/content)`, { field: key })
    }
  }
  const identifier = requiredString(input.identifier, 'identifier')
  if (!REFERENCE_MAPPING_IDENTIFIERS.includes(identifier)) {
    throw new ReferenceMappingTemplateError(`identifier must be one of ${REFERENCE_MAPPING_IDENTIFIERS.join(', ')}`, { field: 'identifier', value: identifier })
  }
  const expectedCompleteness = COMPLETENESS_BY_IDENTIFIER[identifier]
  const completeness = input.completeness !== undefined ? requiredString(input.completeness, 'completeness') : expectedCompleteness
  if (completeness !== expectedCompleteness) {
    throw new ReferenceMappingTemplateError(`completeness must be "${expectedCompleteness}" for identifier ${identifier}`, { field: 'completeness', value: completeness })
  }
  if (!Array.isArray(input.columns) || input.columns.length === 0) {
    throw new ReferenceMappingTemplateError('columns must be a non-empty array', { field: 'columns' })
  }
  const columns = input.columns.map((col, index) => normalizeColumn(col, index))
  const names = new Set(columns.map((c) => c.name))
  // Required columns: sourceCode (the key) + the identifier component (fNumber|fID) + fName + enabled.
  for (const required of ['sourceCode', identifierColumn(identifier), 'fName', 'enabled']) {
    if (!names.has(required)) {
      throw new ReferenceMappingTemplateError(`columns must include "${required}"`, { field: 'columns', missing: required })
    }
  }
  const sourceCode = columns.find((c) => c.name === 'sourceCode')
  if (!sourceCode.key) {
    throw new ReferenceMappingTemplateError('the sourceCode column must be the key', { field: 'columns.sourceCode.key' })
  }
  const out = {
    id: requiredString(input.id, 'id'),
    domain: requiredString(input.domain, 'domain'),
    identifier,
    completeness,
    columns,
  }
  if (input.label !== undefined) out.label = requiredString(input.label, 'label')
  return out
}

// create-from-template → the EMPTY sheet STRUCTURE (columns only, ALWAYS zero rows). Pure: it
// provisions no real multitable sheet (that is a later runtime slice) and never returns content.
function buildSheetStructureFromTemplate(template) {
  const normalized = normalizeReferenceMappingTemplate(template)
  return {
    domain: normalized.domain,
    identifier: normalized.identifier,
    completeness: normalized.completeness,
    columns: normalized.columns.map((c) => ({ ...c })),
    rows: [], // ALWAYS empty — create-from-template never seeds customer content
  }
}

function buildTemplate(domain, label, identifier) {
  return normalizeReferenceMappingTemplate({
    id: `k3wise.refmap.${domain}.v1`,
    domain,
    label,
    identifier,
    columns: [
      { name: 'sourceCode', type: 'text', required: true, key: true },
      { name: identifierColumn(identifier), type: 'text', required: true },
      { name: 'fName', type: 'text', required: true },
      { name: 'enabled', type: 'checkbox' },
      { name: 'notes', type: 'text' },
    ],
  })
}

// Built-in schema-only templates covering EVERY reference field in the K3 Material customer profile
// (k3-wise-document-templates.cjs). BY_NUMBER (FNumber): unit family / accounts / warehouse / manager.
// BY_ID (FID): category + use-state / track / planning-strategy / order-strategy / inspection-level /
// inspection-mode — the six FxxChkMde context fields (production/outsourcing/sales/receipt/stock/other)
// share ONE inspection-mode dictionary; the precise field→sheet binding is a T3b resolver concern.
// Schema only — never any customer rows.
const K3_REFERENCE_MAPPING_TEMPLATES = Object.freeze([
  buildTemplate('unit', 'K3 unit dictionary', 'FNumber'),
  buildTemplate('unit-group', 'K3 unit-group dictionary', 'FNumber'),
  buildTemplate('account', 'K3 account dictionary', 'FNumber'),
  buildTemplate('warehouse', 'K3 warehouse dictionary', 'FNumber'),
  buildTemplate('manager', 'K3 stock-manager dictionary', 'FNumber'),
  buildTemplate('category', 'K3 ERP material category dictionary', 'FID'),
  buildTemplate('use-state', 'K3 use-state dictionary', 'FID'),
  buildTemplate('track', 'K3 track-policy dictionary', 'FID'),
  buildTemplate('planning-strategy', 'K3 planning-strategy dictionary', 'FID'),
  buildTemplate('order-strategy', 'K3 order-strategy dictionary', 'FID'),
  buildTemplate('inspection-level', 'K3 inspection-level dictionary', 'FID'),
  buildTemplate('inspection-mode', 'K3 inspection-mode dictionary', 'FID'),
])

module.exports = {
  REFERENCE_MAPPING_IDENTIFIERS,
  COLUMN_TYPES,
  K3_REFERENCE_MAPPING_TEMPLATES,
  ReferenceMappingTemplateError,
  normalizeReferenceMappingTemplate,
  buildSheetStructureFromTemplate,
  __internals: {
    isPlainObject,
    identifierColumn,
    normalizeColumn,
    isSecretShaped,
    FORBIDDEN_CONTENT_KEYS,
  },
}
