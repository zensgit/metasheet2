'use strict'

const crypto = require('node:crypto')
const { sanitizeIntegrationPayload } = require('./payload-redaction.cjs')

const TABLE = 'integration_dead_letters'
const VALID_STATUSES = new Set(['open', 'replayed', 'discarded'])
const DEAD_LETTER_PAYLOAD_MAX_BYTES = 32 * 1024

class DeadLetterError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'DeadLetterError'
    this.details = details
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DeadLetterError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new DeadLetterError(`${field} must be a string`, { field })
  }
  return value.trim() || null
}

function normalizeWorkspaceId(value) {
  return value === undefined || value === null || value === '' ? null : String(value)
}

function normalizeNonNegativeInteger(value, field, fallback = 0) {
  if (value === undefined || value === null) return fallback
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new DeadLetterError(`${field} must be a non-negative integer`, { field })
  }
  return numeric
}

function normalizeStatus(value = 'open') {
  const status = requiredString(value, 'status')
  if (!VALID_STATUSES.has(status)) {
    throw new DeadLetterError(`status must be one of ${Array.from(VALID_STATUSES).join(', ')}`, {
      field: 'status',
      status,
    })
  }
  return status
}

function normalizeJsonPayload(value, field, { nullable = false } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null
    throw new DeadLetterError(`${field} is required`, { field })
  }
  return sanitizeIntegrationPayload(value, { maxBytes: DEAD_LETTER_PAYLOAD_MAX_BYTES })
}

function unwrapRows(result) {
  return Array.isArray(result) ? result : result?.rows ?? []
}

function rowToDeadLetter(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    runId: row.run_id,
    pipelineId: row.pipeline_id,
    idempotencyKey: row.idempotency_key ?? null,
    sourcePayload: row.source_payload,
    transformedPayload: row.transformed_payload ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryCount: row.retry_count ?? 0,
    status: row.status,
    lastReplayRunId: row.last_replay_run_id ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function createDeadLetterStore({ db, idGenerator = crypto.randomUUID } = {}) {
  if (!db || typeof db.insertOne !== 'function' || typeof db.select !== 'function' || typeof db.updateRow !== 'function') {
    throw new Error('createDeadLetterStore: scoped db helper is required')
  }

  async function createDeadLetter(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DeadLetterError('input must be an object')
    }
    const row = {
      id: input.id || idGenerator(),
      tenant_id: requiredString(input.tenantId, 'tenantId'),
      workspace_id: normalizeWorkspaceId(input.workspaceId),
      run_id: requiredString(input.runId, 'runId'),
      pipeline_id: requiredString(input.pipelineId, 'pipelineId'),
      idempotency_key: optionalString(input.idempotencyKey, 'idempotencyKey'),
      source_payload: normalizeJsonPayload(input.sourcePayload, 'sourcePayload'),
      transformed_payload: normalizeJsonPayload(input.transformedPayload, 'transformedPayload', { nullable: true }),
      error_code: requiredString(input.errorCode || 'VALIDATION_FAILED', 'errorCode'),
      error_message: requiredString(input.errorMessage, 'errorMessage'),
      retry_count: normalizeNonNegativeInteger(input.retryCount, 'retryCount'),
      status: normalizeStatus(input.status),
      last_replay_run_id: optionalString(input.lastReplayRunId, 'lastReplayRunId'),
    }
    const rows = unwrapRows(await db.insertOne(TABLE, row))
    return rowToDeadLetter(rows[0] || row)
  }

  async function listDeadLetters(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DeadLetterError('input must be an object')
    }
    const where = {
      tenant_id: requiredString(input.tenantId, 'tenantId'),
      workspace_id: normalizeWorkspaceId(input.workspaceId),
    }
    if (input.pipelineId) where.pipeline_id = requiredString(input.pipelineId, 'pipelineId')
    if (input.runId) where.run_id = requiredString(input.runId, 'runId')
    if (input.idempotencyKey) where.idempotency_key = requiredString(input.idempotencyKey, 'idempotencyKey')
    if (input.status) where.status = normalizeStatus(input.status)
    const rows = unwrapRows(await db.select(TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: input.limit,
      offset: input.offset,
    }))
    return rows.map(rowToDeadLetter)
  }

  async function getDeadLetter(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DeadLetterError('input must be an object')
    }
    const rows = unwrapRows(await db.select(TABLE, {
      where: {
        tenant_id: requiredString(input.tenantId, 'tenantId'),
        workspace_id: normalizeWorkspaceId(input.workspaceId),
        id: requiredString(input.id, 'id'),
      },
      limit: 1,
    }))
    return rows[0] ? rowToDeadLetter(rows[0]) : null
  }

  async function markReplayed(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new DeadLetterError('input must be an object')
    }
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const id = requiredString(input.id, 'id')
    const replayRunId = requiredString(input.replayRunId || input.lastReplayRunId, 'replayRunId')
    const retryCount = normalizeNonNegativeInteger(input.retryCount, 'retryCount', 1)
    const rows = unwrapRows(await db.updateRow(TABLE, {
      status: 'replayed',
      retry_count: retryCount,
      last_replay_run_id: replayRunId,
    }, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      id,
    }))
    if (!rows[0]) throw new DeadLetterError('dead letter not found', { id, tenantId, workspaceId })
    return rowToDeadLetter(rows[0])
  }

  return {
    create: createDeadLetter,
    createDeadLetter,
    get: getDeadLetter,
    getDeadLetter,
    list: listDeadLetters,
    listDeadLetters,
    markReplayed,
  }
}

module.exports = {
  TABLE,
  VALID_STATUSES,
  DEAD_LETTER_PAYLOAD_MAX_BYTES,
  DeadLetterError,
  createDeadLetterStore,
  rowToDeadLetter,
}
