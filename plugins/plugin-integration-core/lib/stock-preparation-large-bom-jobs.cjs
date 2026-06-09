'use strict'

const crypto = require('node:crypto')

// #2342 C3/C4 large-BOM job contract.
// This module owns the route-facing job store/projection helpers while
// intentionally leaving worker execution, dry-run composition, and apply to
// later slices. It defines values-free status/evidence helpers so future
// background expansion and checkpointed apply slices have a narrow contract.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')
const {
  LARGE_BOM_BOUNDED_ERROR_TYPES,
} = require('./stock-preparation-bom-expansion.cjs')

const LARGE_BOM_BACKGROUND_EXPANSION_STATUSES = Object.freeze([
  'queued',
  'running',
  'paused',
  'failed',
  'completed',
  'cancelled',
  'expired',
])

const LARGE_BOM_CHECKPOINT_APPLY_STATUSES = Object.freeze([
  'queued',
  'running',
  'paused',
  'partial',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
])

const BACKGROUND_PROGRESS_FIELDS = Object.freeze([
  'rowsExpanded',
  'readCount',
  'frontierRemaining',
  'completedChunks',
])

const BACKGROUND_BUDGET_FIELDS = Object.freeze([
  'maxRows',
  'maxPages',
  'maxReadCount',
  'maxElapsedMs',
  'maxDepth',
  'maxArtifactChunks',
])

const APPLY_COUNT_FIELDS = Object.freeze([
  'created',
  'updated',
  'inactive',
  'skipped',
  'held',
  'failed',
])

class StockPreparationLargeBomJobError extends Error {
  constructor(code, message, details = {}, status = 422) {
    super(message)
    this.name = 'StockPreparationLargeBomJobError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function isRedactedMarker(value) {
  return /\[redacted[^\]]*\]|<redacted[^>]*>/i.test(value)
}

function safeEvidenceToken(value, field) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_EVIDENCE_INVALID',
      `${field} must be a string`,
      { field },
    )
  }
  const token = optionalString(value)
  if (!token) return ''
  if (isRedactedMarker(token) || /<[^>]+>/.test(token) || scrubSecretStringValue(token) !== token) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_EVIDENCE_UNSAFE',
      `${field} must not be secret, redacted, or placeholder-shaped`,
      { field },
    )
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(token)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_EVIDENCE_UNSAFE',
      `${field} must be a values-free token`,
      { field },
    )
  }
  return token
}

function safeTokenList(value, field) {
  if (!Array.isArray(value)) return []
  const out = []
  for (let index = 0; index < value.length; index += 1) {
    const token = safeEvidenceToken(value[index], `${field}[${index}]`)
    if (token && !out.includes(token)) out.push(token)
  }
  return out
}

function nonNegativeInteger(value, field) {
  if (value === undefined || value === null || value === '') return 0
  const isNumericString = typeof value === 'string' && /^\s*\d+\s*$/.test(value)
  const isSafeNumber = typeof value === 'number' && Number.isInteger(value) && value >= 0
  if (!isNumericString && !isSafeNumber) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_EVIDENCE_INVALID',
      `${field} must be a non-negative integer`,
      { field },
    )
  }
  return Number(value)
}

function nonNegativeProjection(input, fields) {
  const value = isPlainObject(input) ? input : {}
  return Object.fromEntries(fields.map((field) => [field, nonNegativeInteger(value[field], field)]))
}

function normalizeStatus(value, allowed, field) {
  const status = safeEvidenceToken(value, field)
  if (!allowed.includes(status)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_STATUS_INVALID',
      `${field} is not supported`,
      { field, status },
    )
  }
  return status
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function isoNow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  if (!Number.isFinite(date.getTime())) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_TIMESTAMP_INVALID',
      'job timestamp is invalid',
      {},
    )
  }
  return date.toISOString()
}

function defaultJobId() {
  return `large-bom-expansion-${crypto.randomUUID()}`
}

function ensureDurableJobStorage(storage) {
  if (!storage || storage.durable !== true) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_STORE_UNAVAILABLE',
      'large-BOM background expansion requires durable job storage',
      { durable: false },
      501,
    )
  }
  for (const method of ['get', 'set']) {
    if (typeof storage[method] !== 'function') {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_JOB_STORE_UNAVAILABLE',
        `large-BOM job storage is missing ${method}`,
        { method },
        501,
      )
    }
  }
  return storage
}

function requiredJobScope(input = {}) {
  const tenantId = safeEvidenceToken(input.tenantId, 'tenantId')
  const workspaceId = safeEvidenceToken(input.workspaceId, 'workspaceId')
  if (!tenantId || !workspaceId) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_SCOPE_REQUIRED',
      'large-BOM job scope is required',
      { tenantIdPresent: Boolean(tenantId), workspaceIdPresent: Boolean(workspaceId) },
    )
  }
  return { tenantId, workspaceId }
}

function backgroundJobKey(input = {}) {
  const { tenantId, workspaceId } = requiredJobScope(input)
  const safeActionId = safeEvidenceToken(input.actionId, 'actionId')
  const safeJobId = safeEvidenceToken(input.jobId, 'jobId')
  if (!safeActionId || !safeJobId) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_ID_INVALID',
      'large-BOM job id is required',
      { actionIdPresent: Boolean(safeActionId), jobIdPresent: Boolean(safeJobId) },
    )
  }
  return `stock-preparation:large-bom:background:${tenantId}:${workspaceId}:${safeActionId}:${safeJobId}`
}

function requiredPrincipal(value) {
  const principal = optionalString(value)
  if (!principal) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_PRINCIPAL_REQUIRED',
      'large-BOM background expansion requires an authenticated principal',
      {},
    )
  }
  return principal
}

function publicBackgroundExpansionJob(job) {
  return {
    jobId: safeEvidenceToken(job && job.jobId, 'jobId'),
    ...summarizeLargeBomBackgroundExpansionJobForEvidence(job),
  }
}

async function createLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const scope = requiredJobScope(input)
  const principal = requiredPrincipal(input.principal)
  const action = isPlainObject(input.action) ? input.action : {}
  const actionId = safeEvidenceToken(action.actionId || input.actionId, 'actionId')
  if (!actionId) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_ACTION_INVALID',
      'large-BOM job actionId is required',
      { actionIdPresent: false },
    )
  }
  const parameters = isPlainObject(input.parameters) ? cloneJson(input.parameters) : {}
  const jobId = safeEvidenceToken((typeof input.createJobId === 'function' ? input.createJobId() : '') || defaultJobId(), 'jobId')
  const now = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  const job = {
    jobId,
    ...scope,
    actionId,
    status: 'queued',
    authoritative: false,
    projectNoPresent: optionalString(parameters.projectNo) !== '',
    parameters,
    principal,
    actionSnapshot: cloneJson(action),
    sourceKind: safeEvidenceToken(action.source && action.source.kind, 'sourceKind') || undefined,
    progress: {
      rowsExpanded: 0,
      readCount: 0,
      frontierRemaining: 0,
      completedChunks: 0,
    },
    budgets: {},
    evidence: {
      sourceKind: safeEvidenceToken(action.source && action.source.kind, 'sourceKind') || undefined,
      readObjects: [],
      errorTypes: [],
      readDiagnosticShapePresent: false,
    },
    createdAt: now,
    updatedAt: now,
  }
  await storage.set(backgroundJobKey({ ...scope, actionId, jobId }), job)
  return cloneJson(job)
}

async function loadLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const key = backgroundJobKey(input)
  const job = await storage.get(key)
  if (!job) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_NOT_FOUND',
      'large-BOM background expansion job was not found',
      { jobIdPresent: Boolean(optionalString(input.jobId)) },
      404,
    )
  }
  return cloneJson(job)
}

async function cancelLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  requiredPrincipal(input.principal)
  const key = backgroundJobKey(input)
  const job = await storage.get(key)
  if (!job) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_NOT_FOUND',
      'large-BOM background expansion job was not found',
      { jobIdPresent: Boolean(optionalString(input.jobId)) },
      404,
    )
  }
  if (job.status === 'completed') {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_CANCEL_REJECTED',
      'completed large-BOM background expansion job cannot be cancelled',
      { status: 'completed' },
      409,
    )
  }
  if (!['cancelled', 'failed', 'expired'].includes(job.status)) {
    job.status = 'cancelled'
    job.authoritative = false
    job.updatedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
    await storage.set(key, job)
  }
  return cloneJson(job)
}

function summarizeLargeBomBackgroundExpansionJobForEvidence(job = {}) {
  if (!isPlainObject(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_INVALID',
      'background expansion job must be an object',
      { field: 'job' },
    )
  }
  const evidence = isPlainObject(job.evidence) ? job.evidence : {}
  const status = normalizeStatus(job.status, LARGE_BOM_BACKGROUND_EXPANSION_STATUSES, 'status')
  const errorTypes = safeTokenList(evidence.errorTypes || job.errorTypes, 'errorTypes')
  return {
    jobIdPresent: Boolean(optionalString(job.jobId)),
    actionId: safeEvidenceToken(job.actionId, 'actionId') || undefined,
    status,
    largeBom: true,
    authoritative: status === 'completed' && job.authoritative === true,
    projectNoPresent: job.projectNoPresent === true,
    progress: nonNegativeProjection(job.progress, BACKGROUND_PROGRESS_FIELDS),
    budgets: nonNegativeProjection(job.budgets, BACKGROUND_BUDGET_FIELDS),
    evidence: {
      sourceKind: safeEvidenceToken(evidence.sourceKind || job.sourceKind, 'sourceKind') || undefined,
      readObjects: safeTokenList(evidence.readObjects || job.readObjects, 'readObjects'),
      errorTypes,
      scaleErrorTypes: errorTypes.filter((errorType) => LARGE_BOM_BOUNDED_ERROR_TYPES.includes(errorType)),
      readDiagnosticShapePresent: evidence.readDiagnosticShapePresent === true || job.readDiagnosticShapePresent === true,
    },
  }
}

function isAuthoritativeLargeBomExpansion(job = {}) {
  if (!isPlainObject(job)) return false
  return job.status === 'completed' && job.authoritative === true
}

function assertAuthoritativeLargeBomExpansion(job = {}) {
  if (!isAuthoritativeLargeBomExpansion(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE',
      'large-BOM apply requires a completed authoritative expansion artifact',
      {
        status: isPlainObject(job) ? optionalString(job.status) || undefined : undefined,
        authoritative: isPlainObject(job) ? job.authoritative === true : false,
      },
    )
  }
  return job
}

function summarizeLargeBomCheckpointApplyJobForEvidence(job = {}) {
  if (!isPlainObject(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_INVALID',
      'checkpoint apply job must be an object',
      { field: 'job' },
    )
  }
  const evidence = isPlainObject(job.evidence) ? job.evidence : {}
  return {
    jobIdPresent: Boolean(optionalString(job.jobId)),
    status: normalizeStatus(job.status, LARGE_BOM_CHECKPOINT_APPLY_STATUSES, 'status'),
    planRevisionPresent: Boolean(optionalString(job.planRevision)),
    targetRevisionPresent: Boolean(optionalString(job.targetRevision)),
    approvalPresent: job.approvalPresent === true,
    counts: nonNegativeProjection(job.counts, APPLY_COUNT_FIELDS),
    evidence: {
      resultStatuses: safeTokenList(evidence.resultStatuses || job.resultStatuses, 'resultStatuses'),
      errorCodes: safeTokenList(evidence.errorCodes || job.errorCodes, 'errorCodes'),
      fieldCategories: safeTokenList(evidence.fieldCategories || job.fieldCategories, 'fieldCategories'),
    },
  }
}

module.exports = {
  LARGE_BOM_BACKGROUND_EXPANSION_STATUSES,
  LARGE_BOM_CHECKPOINT_APPLY_STATUSES,
  StockPreparationLargeBomJobError,
  cancelLargeBomBackgroundExpansionJob,
  createLargeBomBackgroundExpansionJob,
  loadLargeBomBackgroundExpansionJob,
  publicBackgroundExpansionJob,
  summarizeLargeBomBackgroundExpansionJobForEvidence,
  summarizeLargeBomCheckpointApplyJobForEvidence,
  isAuthoritativeLargeBomExpansion,
  assertAuthoritativeLargeBomExpansion,
  __internals: {
    backgroundJobKey,
    ensureDurableJobStorage,
    safeEvidenceToken,
    safeTokenList,
    nonNegativeInteger,
  },
}
