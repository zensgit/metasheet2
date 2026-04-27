'use strict'

// ---------------------------------------------------------------------------
// Pipeline registry - plugin-integration-core
//
// Stores pipeline definitions and optional field mappings. This is definition
// state only: no external adapter calls, no run execution, no credential reads.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto')

const PIPELINES_TABLE = 'integration_pipelines'
const FIELD_MAPPINGS_TABLE = 'integration_field_mappings'
const EXTERNAL_SYSTEMS_TABLE = 'integration_external_systems'
const RUNS_TABLE = 'integration_runs'
const VALID_MODES = new Set(['incremental', 'full', 'manual'])
const VALID_RUN_MODES = new Set(['incremental', 'full', 'manual', 'replay'])
const VALID_STATUSES = new Set(['draft', 'active', 'paused', 'disabled'])
const VALID_RUN_STATUSES = new Set(['pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled'])
const VALID_TRIGGERS = new Set(['cron', 'manual', 'api', 'replay'])
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled'])
const SOURCE_ROLES = new Set(['source', 'bidirectional'])
const TARGET_ROLES = new Set(['target', 'bidirectional'])
const RUNNING_RUN_UNIQUE_INDEX = 'uniq_integration_runs_one_running_per_pipeline'

class PipelineValidationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PipelineValidationError'
    this.details = details
  }
}

class PipelineNotFoundError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PipelineNotFoundError'
    this.details = details
  }
}

class PipelineConflictError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'PipelineConflictError'
    this.details = details
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PipelineValidationError(`${field} is required`, { field })
  }
  return value.trim()
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new PipelineValidationError(`${field} must be a string`, { field })
  }
  return value.trim() || null
}

function normalizeWorkspaceId(value) {
  const normalized = optionalString(value, 'workspaceId')
  return normalized === '' ? null : normalized
}

function jsonObject(value, field, fallback = {}) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PipelineValidationError(`${field} must be an object`, { field })
  }
  return { ...value }
}

function jsonArray(value, field, fallback = []) {
  if (value === undefined || value === null) return fallback.slice()
  if (!Array.isArray(value)) {
    throw new PipelineValidationError(`${field} must be an array`, { field })
  }
  return value.slice()
}

function nonNegativeInteger(value, field, fallback = 0) {
  if (value === undefined || value === null) return fallback
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric < 0) {
    throw new PipelineValidationError(`${field} must be a non-negative integer`, { field })
  }
  return numeric
}

function optionalJson(value, field) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') {
    throw new PipelineValidationError(`${field} must be JSON-compatible`, { field })
  }
  return Array.isArray(value) ? value.slice() : { ...value }
}

function validateIsoTimestamp(value, field) {
  if (value === undefined || value === null || value === '') return null
  const text = requiredString(value, field)
  if (Number.isNaN(Date.parse(text))) {
    throw new PipelineValidationError(`${field} must be an ISO timestamp`, { field })
  }
  return text
}

function scopeWhere({ tenantId, workspaceId }) {
  return {
    tenant_id: tenantId,
    workspace_id: workspaceId ?? null,
  }
}

function normalizePipelineInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PipelineValidationError('input must be an object')
  }

  const mode = input.mode === undefined ? 'incremental' : requiredString(input.mode, 'mode')
  if (!VALID_MODES.has(mode)) {
    throw new PipelineValidationError(`mode must be one of ${Array.from(VALID_MODES).join(', ')}`, { field: 'mode' })
  }

  const status = input.status === undefined ? 'draft' : requiredString(input.status, 'status')
  if (!VALID_STATUSES.has(status)) {
    throw new PipelineValidationError(`status must be one of ${Array.from(VALID_STATUSES).join(', ')}`, { field: 'status' })
  }

  const fieldMappings = input.fieldMappings === undefined
    ? undefined
    : normalizeFieldMappings(input.fieldMappings)

  return {
    id: optionalString(input.id, 'id'),
    tenantId: requiredString(input.tenantId, 'tenantId'),
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    projectId: optionalString(input.projectId, 'projectId'),
    name: requiredString(input.name, 'name'),
    description: optionalString(input.description, 'description'),
    sourceSystemId: requiredString(input.sourceSystemId, 'sourceSystemId'),
    sourceObject: requiredString(input.sourceObject, 'sourceObject'),
    targetSystemId: requiredString(input.targetSystemId, 'targetSystemId'),
    targetObject: requiredString(input.targetObject, 'targetObject'),
    stagingSheetId: optionalString(input.stagingSheetId, 'stagingSheetId'),
    mode,
    idempotencyKeyFields: jsonArray(input.idempotencyKeyFields, 'idempotencyKeyFields'),
    options: jsonObject(input.options, 'options'),
    status,
    createdBy: optionalString(input.createdBy, 'createdBy'),
    fieldMappings,
  }
}

function normalizeFieldMappings(value) {
  if (!Array.isArray(value)) {
    throw new PipelineValidationError('fieldMappings must be an array', { field: 'fieldMappings' })
  }
  return value.map((mapping, index) => {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
      throw new PipelineValidationError(`fieldMappings[${index}] must be an object`, { field: 'fieldMappings' })
    }
    const sortOrder = mapping.sortOrder === undefined ? index : Number(mapping.sortOrder)
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      throw new PipelineValidationError(`fieldMappings[${index}].sortOrder must be a non-negative integer`, { field: 'sortOrder' })
    }
    return {
      id: optionalString(mapping.id, `fieldMappings[${index}].id`),
      sourceField: requiredString(mapping.sourceField, `fieldMappings[${index}].sourceField`),
      targetField: requiredString(mapping.targetField, `fieldMappings[${index}].targetField`),
      transform: optionalJson(mapping.transform, `fieldMappings[${index}].transform`),
      validation: mapping.validation === undefined || mapping.validation === null
        ? null
        : jsonArray(mapping.validation, `fieldMappings[${index}].validation`),
      defaultValue: mapping.defaultValue === undefined ? null : mapping.defaultValue,
      sortOrder,
    }
  })
}

function normalizeCreateRunInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PipelineValidationError('input must be an object')
  }

  const mode = input.mode === undefined ? 'manual' : requiredString(input.mode, 'mode')
  if (!VALID_RUN_MODES.has(mode)) {
    throw new PipelineValidationError(`mode must be one of ${Array.from(VALID_RUN_MODES).join(', ')}`, { field: 'mode' })
  }
  const triggeredBy = input.triggeredBy === undefined ? 'manual' : requiredString(input.triggeredBy, 'triggeredBy')
  if (!VALID_TRIGGERS.has(triggeredBy)) {
    throw new PipelineValidationError(`triggeredBy must be one of ${Array.from(VALID_TRIGGERS).join(', ')}`, { field: 'triggeredBy' })
  }
  const status = input.status === undefined ? 'pending' : requiredString(input.status, 'status')
  if (!VALID_RUN_STATUSES.has(status)) {
    throw new PipelineValidationError(`status must be one of ${Array.from(VALID_RUN_STATUSES).join(', ')}`, { field: 'status' })
  }

  return {
    id: optionalString(input.id, 'id'),
    tenantId: requiredString(input.tenantId, 'tenantId'),
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    pipelineId: requiredString(input.pipelineId, 'pipelineId'),
    mode,
    triggeredBy,
    status,
    rowsRead: nonNegativeInteger(input.rowsRead, 'rowsRead'),
    rowsCleaned: nonNegativeInteger(input.rowsCleaned, 'rowsCleaned'),
    rowsWritten: nonNegativeInteger(input.rowsWritten, 'rowsWritten'),
    rowsFailed: nonNegativeInteger(input.rowsFailed, 'rowsFailed'),
    startedAt: validateIsoTimestamp(input.startedAt, 'startedAt'),
    finishedAt: validateIsoTimestamp(input.finishedAt, 'finishedAt'),
    durationMs: input.durationMs === undefined || input.durationMs === null ? null : nonNegativeInteger(input.durationMs, 'durationMs'),
    errorSummary: optionalString(input.errorSummary, 'errorSummary'),
    details: jsonObject(input.details, 'details'),
  }
}

function normalizeUpdateRunInput(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PipelineValidationError('input must be an object')
  }
  const status = requiredString(input.status, 'status')
  if (!VALID_RUN_STATUSES.has(status)) {
    throw new PipelineValidationError(`status must be one of ${Array.from(VALID_RUN_STATUSES).join(', ')}`, { field: 'status' })
  }

  const startedAt = validateIsoTimestamp(input.startedAt, 'startedAt')
  const finishedAt = validateIsoTimestamp(input.finishedAt, 'finishedAt') || (TERMINAL_RUN_STATUSES.has(status) ? now() : null)
  const set = {
    status,
    rows_read: nonNegativeInteger(input.rowsRead, 'rowsRead', undefined),
    rows_cleaned: nonNegativeInteger(input.rowsCleaned, 'rowsCleaned', undefined),
    rows_written: nonNegativeInteger(input.rowsWritten, 'rowsWritten', undefined),
    rows_failed: nonNegativeInteger(input.rowsFailed, 'rowsFailed', undefined),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: input.durationMs === undefined || input.durationMs === null ? null : nonNegativeInteger(input.durationMs, 'durationMs'),
    error_summary: optionalString(input.errorSummary, 'errorSummary'),
    details: input.details === undefined ? undefined : jsonObject(input.details, 'details'),
  }
  for (const key of Object.keys(set)) {
    if (set[key] === undefined || set[key] === null) delete set[key]
  }
  return {
    tenantId: requiredString(input.tenantId, 'tenantId'),
    workspaceId: normalizeWorkspaceId(input.workspaceId),
    id: requiredString(input.id, 'id'),
    set,
  }
}

function rowToPipeline(row, fieldMappings) {
  if (!row) return null
  const result = {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    projectId: row.project_id ?? null,
    name: row.name,
    description: row.description ?? null,
    sourceSystemId: row.source_system_id,
    sourceObject: row.source_object,
    targetSystemId: row.target_system_id,
    targetObject: row.target_object,
    stagingSheetId: row.staging_sheet_id ?? null,
    mode: row.mode,
    idempotencyKeyFields: row.idempotency_key_fields ?? [],
    options: row.options ?? {},
    status: row.status,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
  if (fieldMappings !== undefined) result.fieldMappings = fieldMappings
  return result
}

function rowToFieldMapping(row) {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    sourceField: row.source_field,
    targetField: row.target_field,
    transform: row.transform ?? null,
    validation: row.validation ?? null,
    defaultValue: row.default_value ?? null,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at ?? null,
  }
}

function rowToPipelineRun(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id ?? null,
    pipelineId: row.pipeline_id,
    mode: row.mode,
    triggeredBy: row.triggered_by,
    status: row.status,
    rowsRead: row.rows_read ?? 0,
    rowsCleaned: row.rows_cleaned ?? 0,
    rowsWritten: row.rows_written ?? 0,
    rowsFailed: row.rows_failed ?? 0,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    durationMs: row.duration_ms ?? null,
    errorSummary: row.error_summary ?? null,
    details: row.details ?? {},
    createdAt: row.created_at ?? null,
  }
}

function unwrapRows(result) {
  return Array.isArray(result) ? result : result?.rows ?? []
}

function pipelineRunLockKey(input) {
  return `${input.tenantId}\u0000${input.workspaceId || ''}\u0000${input.pipelineId}`
}

function uniqueViolationMetadata(error) {
  let current = error
  while (current && typeof current === 'object') {
    if (current.code === '23505') {
      return {
        constraint: current.constraint,
        message: current.message || '',
        detail: current.detail || '',
      }
    }
    current = current.cause
  }
  return null
}

function isRunningRunUniqueViolation(error) {
  const meta = uniqueViolationMetadata(error)
  if (!meta) return false
  const text = `${meta.constraint || ''}\n${meta.message}\n${meta.detail}`
  return text.includes(RUNNING_RUN_UNIQUE_INDEX)
}

async function selectPipeline(db, input) {
  if (input.id) {
    return db.selectOne(PIPELINES_TABLE, {
      ...scopeWhere(input),
      id: input.id,
    })
  }
  return db.selectOne(PIPELINES_TABLE, {
    ...scopeWhere(input),
    name: input.name,
  })
}

async function conflictFromRunningRun(db, normalized, details = {}) {
  const runningRows = unwrapRows(await db.select(RUNS_TABLE, {
    where: {
      ...scopeWhere(normalized),
      pipeline_id: normalized.pipelineId,
      status: 'running',
    },
    limit: 1,
  }))
  return new PipelineConflictError('pipeline already has a run in progress', {
    pipelineId: normalized.pipelineId,
    runningRunId: runningRows[0]?.id || null,
    ...details,
  })
}

async function requireExternalSystem(db, normalized, systemId, expectedRoles, field) {
  const row = await db.selectOne(EXTERNAL_SYSTEMS_TABLE, {
    ...scopeWhere(normalized),
    id: systemId,
  })
  if (!row) {
    throw new PipelineValidationError(`${field} does not exist in this tenant/workspace`, { field, systemId })
  }
  if (!expectedRoles.has(row.role)) {
    throw new PipelineValidationError(`${field} role must be one of ${Array.from(expectedRoles).join(', ')}`, {
      field,
      systemId,
      role: row.role,
    })
  }
  return row
}

async function replaceFieldMappings(db, pipelineId, mappings, idGenerator) {
  await db.deleteRows(FIELD_MAPPINGS_TABLE, { pipeline_id: pipelineId })
  if (!mappings || mappings.length === 0) return []

  const rows = mappings.map((mapping) => ({
    id: mapping.id || idGenerator(),
    pipeline_id: pipelineId,
    source_field: mapping.sourceField,
    target_field: mapping.targetField,
    transform: mapping.transform,
    validation: mapping.validation,
    default_value: mapping.defaultValue,
    sort_order: mapping.sortOrder,
  }))
  return unwrapRows(await db.insertMany(FIELD_MAPPINGS_TABLE, rows)).map(rowToFieldMapping)
}

async function loadFieldMappings(db, pipelineId) {
  const rows = unwrapRows(await db.select(FIELD_MAPPINGS_TABLE, {
    where: { pipeline_id: pipelineId },
    orderBy: ['sort_order', 'ASC'],
    limit: 10000,
  }))
  return rows.map(rowToFieldMapping)
}

function createPipelineRegistry({ db, idGenerator = crypto.randomUUID } = {}) {
  if (!db || typeof db.selectOne !== 'function' || typeof db.insertOne !== 'function' || typeof db.updateRow !== 'function' || typeof db.select !== 'function') {
    throw new Error('createPipelineRegistry: scoped db helper is required')
  }
  const runLocks = new Map()

  async function withPipelineRunLock(key, task) {
    const previous = runLocks.get(key) || Promise.resolve()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => gate)
    runLocks.set(key, tail)

    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
      if (runLocks.get(key) === tail) {
        runLocks.delete(key)
      }
    }
  }

  async function upsertPipeline(input) {
    const normalized = normalizePipelineInput(input)

    const write = async (scopedDb) => {
      await requireExternalSystem(scopedDb, normalized, normalized.sourceSystemId, SOURCE_ROLES, 'sourceSystemId')
      await requireExternalSystem(scopedDb, normalized, normalized.targetSystemId, TARGET_ROLES, 'targetSystemId')

      const existing = await selectPipeline(scopedDb, normalized)
      const baseRow = {
        tenant_id: normalized.tenantId,
        workspace_id: normalized.workspaceId,
        project_id: normalized.projectId,
        name: normalized.name,
        description: normalized.description,
        source_system_id: normalized.sourceSystemId,
        source_object: normalized.sourceObject,
        target_system_id: normalized.targetSystemId,
        target_object: normalized.targetObject,
        staging_sheet_id: normalized.stagingSheetId,
        mode: normalized.mode,
        idempotency_key_fields: normalized.idempotencyKeyFields,
        options: normalized.options,
        status: normalized.status,
      }

      let row
      if (existing) {
        const updateRow = { ...baseRow }
        const rows = unwrapRows(await scopedDb.updateRow(PIPELINES_TABLE, updateRow, {
          ...scopeWhere(normalized),
          id: existing.id,
        }))
        row = rows[0] || { ...existing, ...updateRow }
      } else {
        const insertRow = {
          id: normalized.id || idGenerator(),
          ...baseRow,
          created_by: normalized.createdBy,
        }
        const rows = unwrapRows(await scopedDb.insertOne(PIPELINES_TABLE, insertRow))
        row = rows[0] || insertRow
      }

      let fieldMappings
      if (normalized.fieldMappings !== undefined) {
        fieldMappings = await replaceFieldMappings(scopedDb, row.id, normalized.fieldMappings, idGenerator)
      }
      return rowToPipeline(row, fieldMappings)
    }

    if (normalized.fieldMappings !== undefined) {
      if (typeof db.transaction !== 'function') {
        throw new Error('createPipelineRegistry: db.transaction is required when fieldMappings are provided')
      }
      return db.transaction(write)
    }
    return write(db)
  }

  async function getPipeline(input) {
    const tenantId = requiredString(input?.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input?.workspaceId)
    const id = requiredString(input?.id, 'id')
    const row = await db.selectOne(PIPELINES_TABLE, {
      tenant_id: tenantId,
      workspace_id: workspaceId,
      id,
    })
    if (!row) {
      throw new PipelineNotFoundError('pipeline not found', { id, tenantId, workspaceId })
    }
    const includeFieldMappings = input?.includeFieldMappings !== false
    const fieldMappings = includeFieldMappings ? await loadFieldMappings(db, row.id) : undefined
    return rowToPipeline(row, fieldMappings)
  }

  async function listPipelines(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const where = scopeWhere({ tenantId, workspaceId })
    if (input.status) {
      const status = requiredString(input.status, 'status')
      if (!VALID_STATUSES.has(status)) {
        throw new PipelineValidationError(`status must be one of ${Array.from(VALID_STATUSES).join(', ')}`, { field: 'status' })
      }
      where.status = status
    }
    if (input.sourceSystemId) where.source_system_id = requiredString(input.sourceSystemId, 'sourceSystemId')
    if (input.targetSystemId) where.target_system_id = requiredString(input.targetSystemId, 'targetSystemId')

    const rows = unwrapRows(await db.select(PIPELINES_TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: input.limit,
      offset: input.offset,
    }))
    return rows.map(row => rowToPipeline(row))
  }

  async function createPipelineRun(input) {
    const normalized = normalizeCreateRunInput(input)
    return withPipelineRunLock(pipelineRunLockKey(normalized), async () => {
      const pipeline = await db.selectOne(PIPELINES_TABLE, {
        ...scopeWhere(normalized),
        id: normalized.pipelineId,
      })
      if (!pipeline) {
        throw new PipelineNotFoundError('pipeline not found', {
          id: normalized.pipelineId,
          tenantId: normalized.tenantId,
          workspaceId: normalized.workspaceId,
        })
      }
      if (pipeline.status === 'disabled') {
        throw new PipelineValidationError('disabled pipeline cannot create runs', {
          pipelineId: normalized.pipelineId,
          status: pipeline.status,
        })
      }
      // Reject concurrent runs early for a friendly error. The DB partial unique
      // index remains the authoritative cross-process guard for true races.
      const runningRows = unwrapRows(await db.select(RUNS_TABLE, {
        where: {
          ...scopeWhere(normalized),
          pipeline_id: normalized.pipelineId,
          status: 'running',
        },
        limit: 1,
      }))
      if (runningRows.length > 0) {
        throw new PipelineConflictError('pipeline already has a run in progress', {
          pipelineId: normalized.pipelineId,
          runningRunId: runningRows[0].id,
        })
      }
      const insertRow = {
        id: normalized.id || idGenerator(),
        tenant_id: normalized.tenantId,
        workspace_id: normalized.workspaceId,
        pipeline_id: normalized.pipelineId,
        mode: normalized.mode,
        triggered_by: normalized.triggeredBy,
        status: normalized.status,
        rows_read: normalized.rowsRead,
        rows_cleaned: normalized.rowsCleaned,
        rows_written: normalized.rowsWritten,
        rows_failed: normalized.rowsFailed,
        started_at: normalized.startedAt,
        finished_at: normalized.finishedAt,
        duration_ms: normalized.durationMs,
        error_summary: normalized.errorSummary,
        details: normalized.details,
      }
      try {
        const rows = unwrapRows(await db.insertOne(RUNS_TABLE, insertRow))
        return rowToPipelineRun(rows[0] || insertRow)
      } catch (error) {
        if (isRunningRunUniqueViolation(error)) {
          throw await conflictFromRunningRun(db, normalized, { constraint: RUNNING_RUN_UNIQUE_INDEX })
        }
        throw error
      }
    })
  }

  async function updatePipelineRun(input) {
    const normalized = normalizeUpdateRunInput(input, () => new Date().toISOString())
    const rows = unwrapRows(await db.updateRow(RUNS_TABLE, normalized.set, {
      tenant_id: normalized.tenantId,
      workspace_id: normalized.workspaceId,
      id: normalized.id,
    }))
    const row = rows[0]
    if (!row) {
      throw new PipelineNotFoundError('pipeline run not found', {
        id: normalized.id,
        tenantId: normalized.tenantId,
        workspaceId: normalized.workspaceId,
      })
    }
    return rowToPipelineRun(row)
  }

  async function listPipelineRuns(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const where = scopeWhere({ tenantId, workspaceId })
    if (input.pipelineId) where.pipeline_id = requiredString(input.pipelineId, 'pipelineId')
    if (input.status) {
      const status = requiredString(input.status, 'status')
      if (!VALID_RUN_STATUSES.has(status)) {
        throw new PipelineValidationError(`status must be one of ${Array.from(VALID_RUN_STATUSES).join(', ')}`, { field: 'status' })
      }
      where.status = status
    }
    const rows = unwrapRows(await db.select(RUNS_TABLE, {
      where,
      orderBy: ['created_at', 'DESC'],
      limit: input.limit,
      offset: input.offset,
    }))
    return rows.map(rowToPipelineRun)
  }

  // Marks 'running' runs that started more than `olderThanMs` milliseconds ago as 'failed'.
  // Called on plugin startup or before creating a new run to recover from crashed runner processes
  // that never called failRun(). Without this, a crash between startRun and finishRun permanently
  // blocks future runs of the same pipeline.
  async function abandonStaleRuns(input = {}) {
    const tenantId = requiredString(input.tenantId, 'tenantId')
    const workspaceId = normalizeWorkspaceId(input.workspaceId)
    const olderThanMs = Number.isInteger(input.olderThanMs) && input.olderThanMs > 0
      ? input.olderThanMs
      : 4 * 60 * 60 * 1000 // 4 hours default
    const nowMs = typeof input.now === 'function' ? input.now() : Date.now()
    const cutoffMs = nowMs - olderThanMs

    const where = { ...scopeWhere({ tenantId, workspaceId }), status: 'running' }
    if (input.pipelineId) where.pipeline_id = requiredString(input.pipelineId, 'pipelineId')
    const runningRows = unwrapRows(await db.select(RUNS_TABLE, { where }))

    const stale = runningRows.filter((row) => {
      const startedMs = row.started_at ? Date.parse(row.started_at) : NaN
      return !Number.isNaN(startedMs) && startedMs < cutoffMs
    })

    const abandoned = []
    for (const row of stale) {
      const finishedAt = new Date(nowMs).toISOString()
      await db.updateRow(
        RUNS_TABLE,
        {
          status: 'failed',
          finished_at: finishedAt,
          error_summary: 'abandoned: run exceeded stale threshold and was automatically failed',
        },
        { tenant_id: row.tenant_id, workspace_id: row.workspace_id, id: row.id }
      )
      abandoned.push(rowToPipelineRun({ ...row, status: 'failed', finished_at: finishedAt }))
    }
    return abandoned
  }

  return {
    upsertPipeline,
    getPipeline,
    listPipelines,
    createPipelineRun,
    updatePipelineRun,
    listPipelineRuns,
    abandonStaleRuns,
  }
}

module.exports = {
  createPipelineRegistry,
  PipelineValidationError,
  PipelineNotFoundError,
  PipelineConflictError,
  __internals: {
    PIPELINES_TABLE,
    FIELD_MAPPINGS_TABLE,
    EXTERNAL_SYSTEMS_TABLE,
    RUNS_TABLE,
    VALID_MODES,
    VALID_RUN_MODES,
    VALID_STATUSES,
    VALID_RUN_STATUSES,
    VALID_TRIGGERS,
    RUNNING_RUN_UNIQUE_INDEX,
    normalizePipelineInput,
    normalizeFieldMappings,
    normalizeCreateRunInput,
    normalizeUpdateRunInput,
    rowToPipeline,
    rowToFieldMapping,
    rowToPipelineRun,
    pipelineRunLockKey,
    isRunningRunUniqueViolation,
  },
}
