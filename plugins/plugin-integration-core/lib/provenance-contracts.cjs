'use strict'

const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')

const PROVENANCE_EVENT_TYPES = Object.freeze([
  'source_read',
  'row_imported',
  'row_edited',
  'mapping_applied',
  'validation_failed',
  'dry_run_previewed',
  'target_write_attempted',
  'target_write_succeeded',
  'target_write_failed',
  'row_retried',
  'row_exported',
])

const PROVENANCE_EVENT_TYPE_SET = new Set(PROVENANCE_EVENT_TYPES)

class ProvenanceContractValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'ProvenanceContractValidationError'
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
    throw new ProvenanceContractValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function normalizeEventType(value) {
  const eventType = requiredString(value, 'eventType')
  if (!PROVENANCE_EVENT_TYPE_SET.has(eventType)) {
    throw new ProvenanceContractValidationError(`eventType must be one of ${PROVENANCE_EVENT_TYPES.join(', ')}`, {
      field: 'eventType',
      value: eventType,
    })
  }
  return eventType
}

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    const ms = value.getTime()
    if (!Number.isFinite(ms)) {
      throw new ProvenanceContractValidationError('at must be a valid date-time', { field: 'at' })
    }
    return value.toISOString()
  }

  const raw = requiredString(value, 'at')
  const parsed = new Date(raw)
  const ms = parsed.getTime()
  if (!Number.isFinite(ms)) {
    throw new ProvenanceContractValidationError('at must be a valid date-time', { field: 'at', value: raw })
  }
  return parsed.toISOString()
}

function normalizeAttrs(value) {
  if (!isPlainObject(value)) {
    throw new ProvenanceContractValidationError('attrs must be a plain object', { field: 'attrs' })
  }
  return sanitizeIntegrationPayload(value)
}

function normalizeProvenanceEvent(input) {
  if (!isPlainObject(input)) {
    throw new ProvenanceContractValidationError('input must be a plain object')
  }

  return {
    runId: requiredString(input.runId, 'runId'),
    rowId: requiredString(input.rowId, 'rowId'),
    eventType: normalizeEventType(input.eventType),
    at: normalizeTimestamp(input.at),
    attrs: normalizeAttrs(input.attrs),
  }
}

function normalizeProvenanceEvents(input) {
  if (!Array.isArray(input)) {
    throw new ProvenanceContractValidationError('input must be an array')
  }
  return input.map((event, index) => {
    try {
      return normalizeProvenanceEvent(event)
    } catch (error) {
      if (error instanceof ProvenanceContractValidationError) {
        error.details = {
          index,
          ...(error.details || {}),
        }
      }
      throw error
    }
  })
}

module.exports = {
  PROVENANCE_EVENT_TYPES,
  ProvenanceContractValidationError,
  normalizeProvenanceEvent,
  normalizeProvenanceEvents,
  __internals: {
    isPlainObject,
    normalizeAttrs,
    normalizeEventType,
    normalizeTimestamp,
  },
}
