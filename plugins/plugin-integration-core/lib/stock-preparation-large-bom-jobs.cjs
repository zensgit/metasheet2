'use strict'

const crypto = require('node:crypto')

// #2342 C3/C4 large-BOM job contract.
// This module owns the route-facing job store/projection helpers while
// intentionally leaving dry-run composition and apply to later slices. The
// worker seam below produces the sealed expansion artifact used by those
// later slices while keeping public evidence values-free.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')
const {
  expandPlmProjectBom,
  LARGE_BOM_BOUNDED_ERROR_TYPES,
  summarizeBomExpansionForEvidence,
} = require('./stock-preparation-bom-expansion.cjs')
const {
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
} = require('./stock-preparation-conflict-planner.cjs')
const {
  applyStockPreparationPlan,
  summarizeApplyResultForEvidence,
} = require('./stock-preparation-apply-writer.cjs')

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

const LARGE_BOM_APPLY_PERMISSIONS = Object.freeze(['write', 'admin'])
const LARGE_BOM_APPLY_DEFAULT_CHUNK_SIZE = 100
const LARGE_BOM_APPLY_MAX_CHUNK_SIZE = 1000
const activeCheckpointApplyRuns = new Set()

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

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
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

function defaultApplyJobId() {
  return `large-bom-apply-${crypto.randomUUID()}`
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

function checkpointApplyJobKey(input = {}) {
  const { tenantId, workspaceId } = requiredJobScope(input)
  const safeActionId = safeEvidenceToken(input.actionId, 'actionId')
  const safeApplyJobId = safeEvidenceToken(input.applyJobId, 'applyJobId')
  if (!safeActionId || !safeApplyJobId) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_JOB_ID_INVALID',
      'large-BOM checkpoint apply job id is required',
      { actionIdPresent: Boolean(safeActionId), applyJobIdPresent: Boolean(safeApplyJobId) },
    )
  }
  return `stock-preparation:large-bom:apply:${tenantId}:${workspaceId}:${safeActionId}:${safeApplyJobId}`
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

function publicCheckpointApplyJob(job) {
  return {
    jobId: safeEvidenceToken(job && job.jobId, 'jobId'),
    ...summarizeLargeBomCheckpointApplyJobForEvidence(job),
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

function requireSourceAdapter(adapter) {
  if (!adapter || typeof adapter.read !== 'function') {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_SOURCE_ADAPTER_UNAVAILABLE',
      'large-BOM background expansion requires a source adapter with read()',
      {},
      501,
    )
  }
  return adapter
}

function expansionArtifactRevision({ job, expansion }) {
  return hashJson({
    action: job.actionSnapshot || { actionId: job.actionId },
    parameters: job.parameters || {},
    principal: job.principal,
    expansion: {
      rows: Array.isArray(expansion.rows) ? expansion.rows : [],
      summary: expansion.summary || {},
    },
  })
}

function updateJobFromExpansion(job, expansion, now) {
  const evidence = summarizeBomExpansionForEvidence(expansion)
  const progress = {
    rowsExpanded: Number(evidence.rowsExpanded || 0),
    readCount: Number(evidence.readCount || 0),
    frontierRemaining: 0,
    completedChunks: expansion.valid === true ? 1 : 0,
  }
  const budgets = {
    maxRows: evidence.maxRows,
    maxPages: evidence.maxPages,
    maxReadCount: evidence.maxReadCount,
    maxElapsedMs: evidence.maxElapsedMs,
    maxDepth: evidence.maxDepth,
    maxArtifactChunks: 1,
  }
  for (const key of Object.keys(budgets)) {
    if (budgets[key] === undefined || budgets[key] === null || budgets[key] === '') delete budgets[key]
  }
  job.progress = progress
  job.budgets = budgets
  job.evidence = {
    sourceKind: job.sourceKind,
    readObjects: evidence.readObjects || [],
    errorTypes: evidence.errorTypes || [],
    readDiagnosticShapePresent: Array.isArray(evidence.readDiagnostics) && evidence.readDiagnostics.length > 0,
  }
  job.updatedAt = now
  if (expansion.valid === true) {
    const revision = expansionArtifactRevision({ job, expansion })
    job.status = 'completed'
    job.authoritative = true
    job.artifactRevision = revision
    job.artifact = {
      revision,
      status: expansion.status,
      rows: cloneJson(expansion.rows || []),
      summary: cloneJson(expansion.summary || {}),
      sealedAt: now,
    }
    return
  }
  job.status = 'failed'
  job.authoritative = false
  delete job.artifactRevision
  delete job.artifact
}

function safeErrorType(error) {
  try {
    return safeEvidenceToken(error && (error.code || error.name), 'errorType') || 'read_failed'
  } catch {
    return 'read_failed'
  }
}

async function runLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const sourceAdapter = requireSourceAdapter(input.sourceAdapter)
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
  if (job.status === 'completed') return cloneJson(job)
  if (!['queued', 'running', 'paused', 'failed'].includes(job.status)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_RUN_REJECTED',
      'large-BOM background expansion job cannot be run from this status',
      { status: safeEvidenceToken(job.status, 'status') || undefined },
      409,
    )
  }
  requiredPrincipal(job.principal)
  const runningAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  job.status = 'running'
  job.authoritative = false
  job.updatedAt = runningAt
  await storage.set(key, job)

  let expansion
  try {
    expansion = await expandPlmProjectBom({
      sourceAdapter,
      projectNo: job.parameters && job.parameters.projectNo,
      ...(isPlainObject(input.expansionOptions) ? input.expansionOptions : {}),
    })
  } catch (error) {
    const failedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
    job.status = 'failed'
    job.authoritative = false
    job.progress = {
      rowsExpanded: 0,
      readCount: 0,
      frontierRemaining: 0,
      completedChunks: 0,
    }
    job.evidence = {
      sourceKind: job.sourceKind,
      readObjects: [],
      errorTypes: [safeErrorType(error)],
      readDiagnosticShapePresent: false,
    }
    job.updatedAt = failedAt
    await storage.set(key, job)
    return cloneJson(job)
  }

  const completedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  updateJobFromExpansion(job, expansion, completedAt)
  await storage.set(key, job)
  return cloneJson(job)
}

function normalizeExistingRows(rows) {
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_PLAN_EXISTING_ROWS_INVALID',
      'existingRows must be an array',
      { field: 'existingRows' },
    )
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (!isPlainObject(rows[index])) {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_PLAN_EXISTING_ROWS_INVALID',
        'existingRows entries must be objects',
        { field: 'existingRows', index },
      )
    }
  }
  return rows.map(cloneJson)
}

function largeBomPlanRevision({ job, plan, existingRows, conflictPolicyReview }) {
  return hashJson({
    artifactRevision: job.artifactRevision || (job.artifact && job.artifact.revision),
    existingRows,
    conflictPolicyReview: conflictPolicyReview || null,
    plan: {
      valid: plan.valid === true,
      counts: plan.counts || {},
      conflictTypes: plan.summary && plan.summary.conflictTypes,
      duplicateExpandedKeyDiagnostics: plan.summary && plan.summary.duplicateExpandedKeyDiagnostics,
      duplicateExpandedKeyResolution: plan.summary && plan.summary.duplicateExpandedKeyResolution,
    },
  })
}

function isAuthoritativeLargeBomPlan(job = {}) {
  if (!isAuthoritativeLargeBomExpansion(job)) return false
  const planArtifact = isPlainObject(job.planArtifact) ? job.planArtifact : {}
  const plan = isPlainObject(planArtifact.plan) ? planArtifact.plan : {}
  return Boolean(optionalString(job.planRevision || planArtifact.revision)) &&
    Array.isArray(plan.decisions)
}

function assertAuthoritativeLargeBomPlan(job = {}) {
  if (!isAuthoritativeLargeBomPlan(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_PLAN_ARTIFACT_NOT_AUTHORITATIVE',
      'large-BOM apply requires a completed authoritative conflict plan artifact',
      {
        status: isPlainObject(job) ? optionalString(job.status) || undefined : undefined,
        authoritative: isPlainObject(job) ? job.authoritative === true : false,
        artifactRevisionPresent: isPlainObject(job)
          ? Boolean(optionalString(job.artifactRevision || (job.artifact && job.artifact.revision)))
          : false,
        planRevisionPresent: isPlainObject(job)
          ? Boolean(optionalString(job.planRevision || (job.planArtifact && job.planArtifact.revision)))
          : false,
      },
    )
  }
  return job
}

function requireApplyPermission(value) {
  const permission = optionalString(value)
  if (!LARGE_BOM_APPLY_PERMISSIONS.includes(permission)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_PERMISSION_REQUIRED',
      'large-BOM checkpoint apply requires Data Factory write/admin permission',
      { permission: permission || undefined },
      403,
    )
  }
  return permission
}

function normalizeChunkSize(value) {
  if (value === undefined || value === null || value === '') return LARGE_BOM_APPLY_DEFAULT_CHUNK_SIZE
  const parsed = nonNegativeInteger(value, 'maxDecisionsPerChunk')
  if (parsed < 1 || parsed > LARGE_BOM_APPLY_MAX_CHUNK_SIZE) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_CHUNK_SIZE_INVALID',
      'large-BOM checkpoint apply chunk size is out of range',
      { min: 1, max: LARGE_BOM_APPLY_MAX_CHUNK_SIZE },
    )
  }
  return parsed
}

function emptyApplyCounts() {
  return Object.fromEntries(APPLY_COUNT_FIELDS.map((field) => [field, 0]))
}

function mergeCounts(left = {}, right = {}) {
  const out = emptyApplyCounts()
  for (const field of APPLY_COUNT_FIELDS) {
    out[field] = nonNegativeInteger(left[field], field) + nonNegativeInteger(right[field], field)
  }
  return out
}

function mergeTokenList(left = [], right = []) {
  const out = []
  for (const token of [...left, ...right]) {
    if (typeof token === 'string' && token && !out.includes(token)) out.push(token)
  }
  return out.sort()
}

function countManualConfirmDecisions(plan = {}) {
  return Array.isArray(plan.decisions)
    ? plan.decisions.filter((decision) => decision && decision.decision === 'manual_confirm').length
    : 0
}

function requireTargetSnapshot(job = {}) {
  const target = job.actionSnapshot && job.actionSnapshot.target
  if (!isPlainObject(target)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_TARGET_REQUIRED',
      'large-BOM checkpoint apply requires a server-configured target binding',
      { targetPresent: false },
    )
  }
  return cloneJson(target)
}

function requireCheckpointRecordsApi(recordsApi) {
  if (
    !recordsApi ||
    typeof recordsApi.queryRecords !== 'function' ||
    typeof recordsApi.createRecord !== 'function' ||
    typeof recordsApi.patchRecord !== 'function'
  ) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_RECORDS_API_UNAVAILABLE',
      'large-BOM checkpoint apply requires queryRecords/createRecord/patchRecord records API',
      { field: 'recordsApi' },
      501,
    )
  }
  return recordsApi
}

async function createLargeBomCheckpointApplyJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const scope = requiredJobScope(input)
  const principal = requiredPrincipal(input.principal)
  const permission = requireApplyPermission(input.permission)
  const sourceJob = await loadLargeBomBackgroundExpansionJob({
    storage,
    ...scope,
    actionId: input.actionId,
    jobId: input.jobId,
  })
  assertAuthoritativeLargeBomPlan(sourceJob)
  const planArtifact = sourceJob.planArtifact
  const plan = cloneJson(planArtifact.plan)
  const manualConfirmCount = countManualConfirmDecisions(plan)
  if (manualConfirmCount > 0 && input.acceptManualConfirmHold !== true) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_MANUAL_CONFIRM_ACK_REQUIRED',
      'large-BOM checkpoint apply requires explicit acknowledgement for held manual-confirm rows',
      { manualConfirmCount },
      409,
    )
  }
  const target = requireTargetSnapshot(sourceJob)
  const applyJobId = safeEvidenceToken(
    (typeof input.createApplyJobId === 'function' ? input.createApplyJobId() : '') ||
      optionalString(input.applyJobId) ||
      defaultApplyJobId(),
    'applyJobId',
  )
  const now = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  const job = {
    jobId: applyJobId,
    ...scope,
    actionId: sourceJob.actionId,
    sourceJobId: sourceJob.jobId,
    status: 'queued',
    planRevision: sourceJob.planRevision || planArtifact.revision,
    targetRevision: hashJson(target),
    approvalPresent: true,
    approval: {
      principal,
      permission,
      acceptManualConfirmHold: input.acceptManualConfirmHold === true,
      approvedAt: now,
    },
    permission,
    target,
    template: sourceJob.actionSnapshot && sourceJob.actionSnapshot.template
      ? cloneJson(sourceJob.actionSnapshot.template)
      : undefined,
    plan,
    totalDecisions: Array.isArray(plan.decisions) ? plan.decisions.length : 0,
    checkpoint: {
      nextDecisionIndex: 0,
      completedChunks: 0,
    },
    counts: emptyApplyCounts(),
    evidence: {
      resultStatuses: [],
      errorCodes: [],
      fieldCategories: ['plm_system'],
    },
    createdAt: now,
    updatedAt: now,
  }
  await storage.set(checkpointApplyJobKey({ ...scope, actionId: sourceJob.actionId, applyJobId }), job)
  return cloneJson(job)
}

async function loadLargeBomCheckpointApplyJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const key = checkpointApplyJobKey({ ...input, applyJobId: input.applyJobId || input.jobId })
  const job = await storage.get(key)
  if (!job) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_JOB_NOT_FOUND',
      'large-BOM checkpoint apply job was not found',
      { applyJobIdPresent: Boolean(optionalString(input.applyJobId || input.jobId)) },
      404,
    )
  }
  return cloneJson(job)
}

function nextDecisionIndex(job = {}) {
  return nonNegativeInteger(job.checkpoint && job.checkpoint.nextDecisionIndex, 'checkpoint.nextDecisionIndex')
}

function completedChunks(job = {}) {
  return nonNegativeInteger(job.checkpoint && job.checkpoint.completedChunks, 'checkpoint.completedChunks')
}

function mergeApplyEvidence(job, applyResult) {
  const publicResult = summarizeApplyResultForEvidence(applyResult)
  const evidence = isPlainObject(job.evidence) ? job.evidence : {}
  job.evidence = {
    resultStatuses: mergeTokenList(evidence.resultStatuses, publicResult.resultStatuses),
    errorCodes: mergeTokenList(evidence.errorCodes, publicResult.errorCodes),
    fieldCategories: mergeTokenList(evidence.fieldCategories, ['plm_system']),
  }
}

function terminalApplyStatus(counts = {}) {
  if (nonNegativeInteger(counts.failed, 'failed') > 0 || nonNegativeInteger(counts.held, 'held') > 0) return 'partial'
  return 'succeeded'
}

function acquireCheckpointApplyRun(key) {
  if (activeCheckpointApplyRuns.has(key)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_RUN_IN_PROGRESS',
      'large-BOM checkpoint apply job already has a running chunk',
      { status: 'running' },
      409,
    )
  }
  activeCheckpointApplyRuns.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    activeCheckpointApplyRuns.delete(key)
  }
}

async function runLargeBomCheckpointApplyJobChunk(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const key = checkpointApplyJobKey({ ...input, applyJobId: input.applyJobId || input.jobId })
  const release = acquireCheckpointApplyRun(key)
  try {
    const job = await storage.get(key)
    if (!job) {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_APPLY_JOB_NOT_FOUND',
        'large-BOM checkpoint apply job was not found',
        { applyJobIdPresent: Boolean(optionalString(input.applyJobId || input.jobId)) },
        404,
      )
    }
    if (['succeeded', 'partial'].includes(job.status)) return cloneJson(job)
    if (job.status === 'running') {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_APPLY_RUN_IN_PROGRESS',
        'large-BOM checkpoint apply job already has a running chunk',
        { status: 'running' },
        409,
      )
    }
    if (!['queued', 'paused', 'failed'].includes(job.status)) {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_APPLY_RUN_REJECTED',
        'large-BOM checkpoint apply job cannot be run from this status',
        { status: safeEvidenceToken(job.status, 'status') || undefined },
        409,
      )
    }
    const plan = isPlainObject(job.plan) && Array.isArray(job.plan.decisions) ? job.plan : null
    if (!plan) {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_APPLY_PLAN_INVALID',
        'large-BOM checkpoint apply job is missing a private conflict plan',
        { planPresent: false },
      )
    }
    const chunkSize = normalizeChunkSize(input.maxDecisionsPerChunk)
    const recordsApi = requireCheckpointRecordsApi(input.recordsApi)
    const start = nextDecisionIndex(job)
    const decisions = plan.decisions
    if (start >= decisions.length) {
      job.status = terminalApplyStatus(job.counts)
      job.updatedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
      await storage.set(key, job)
      return cloneJson(job)
    }

    const runningAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
    job.status = 'running'
    job.updatedAt = runningAt
    await storage.set(key, job)

    const end = Math.min(start + chunkSize, decisions.length)
    const chunkPlan = {
      ...plan,
      decisions: decisions.slice(start, end).map(cloneJson),
    }
    const applyResult = await applyStockPreparationPlan({
      permission: job.permission,
      plan: chunkPlan,
      target: job.target,
      template: job.template,
      recordsApi,
    })

    job.counts = mergeCounts(job.counts, applyResult.counts)
    mergeApplyEvidence(job, applyResult)
    job.checkpoint = {
      nextDecisionIndex: end,
      completedChunks: completedChunks(job) + 1,
    }
    job.status = end >= decisions.length ? terminalApplyStatus(job.counts) : 'paused'
    job.updatedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
    await storage.set(key, job)
    return cloneJson(job)
  } finally {
    release()
  }
}

async function planLargeBomBackgroundExpansionJob(input = {}) {
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
  assertAuthoritativeLargeBomExpansion(job)
  const artifact = isPlainObject(job.artifact) ? job.artifact : {}
  const expandedRows = Array.isArray(artifact.rows) ? artifact.rows.map(cloneJson) : []
  const existingRows = normalizeExistingRows(input.existingRows)
  const conflictPolicyReview = isPlainObject(input.conflictPolicyReview) ? cloneJson(input.conflictPolicyReview) : undefined
  const plan = planStockPreparationConflicts({
    template: job.actionSnapshot && job.actionSnapshot.template,
    conflictStrategy: job.actionSnapshot && job.actionSnapshot.conflictStrategy,
    expandedRows,
    existingRows,
    rowErrors: [],
    runId: input.runId || `large-bom:${job.jobId}`,
    plannedAt: input.plannedAt,
    duplicatePolicyReview: conflictPolicyReview,
  })
  const revision = largeBomPlanRevision({ job, plan, existingRows, conflictPolicyReview })
  job.planRevision = revision
  job.planArtifact = {
    revision,
    artifactRevision: job.artifactRevision || artifact.revision,
    plan: cloneJson(plan),
    existingRowCount: existingRows.length,
    plannedAt: plan.plannedAt,
  }
  job.planEvidence = summarizeConflictPlanForEvidence(plan)
  job.updatedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  await storage.set(key, job)
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
  const publicEvidence = {
    sourceKind: safeEvidenceToken(evidence.sourceKind || job.sourceKind, 'sourceKind') || undefined,
    readObjects: safeTokenList(evidence.readObjects || job.readObjects, 'readObjects'),
    errorTypes,
    scaleErrorTypes: errorTypes.filter((errorType) => LARGE_BOM_BOUNDED_ERROR_TYPES.includes(errorType)),
    readDiagnosticShapePresent: evidence.readDiagnosticShapePresent === true || job.readDiagnosticShapePresent === true,
  }
  if (isPlainObject(job.planEvidence)) publicEvidence.plan = cloneJson(job.planEvidence)
  return {
    jobIdPresent: Boolean(optionalString(job.jobId)),
    actionId: safeEvidenceToken(job.actionId, 'actionId') || undefined,
    status,
    largeBom: true,
    authoritative: status === 'completed' && job.authoritative === true,
    artifactRevisionPresent: Boolean(optionalString(job.artifactRevision || (job.artifact && job.artifact.revision))),
    planRevisionPresent: Boolean(optionalString(job.planRevision || (job.planArtifact && job.planArtifact.revision))),
    projectNoPresent: job.projectNoPresent === true,
    progress: nonNegativeProjection(job.progress, BACKGROUND_PROGRESS_FIELDS),
    budgets: nonNegativeProjection(job.budgets, BACKGROUND_BUDGET_FIELDS),
    evidence: publicEvidence,
  }
}

function isAuthoritativeLargeBomExpansion(job = {}) {
  if (!isPlainObject(job)) return false
  return job.status === 'completed' &&
    job.authoritative === true &&
    Boolean(optionalString(job.artifactRevision || (job.artifact && job.artifact.revision)))
}

function assertAuthoritativeLargeBomExpansion(job = {}) {
  if (!isAuthoritativeLargeBomExpansion(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE',
      'large-BOM apply requires a completed authoritative expansion artifact',
      {
        status: isPlainObject(job) ? optionalString(job.status) || undefined : undefined,
        authoritative: isPlainObject(job) ? job.authoritative === true : false,
        artifactRevisionPresent: isPlainObject(job)
          ? Boolean(optionalString(job.artifactRevision || (job.artifact && job.artifact.revision)))
          : false,
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
  createLargeBomCheckpointApplyJob,
  loadLargeBomBackgroundExpansionJob,
  loadLargeBomCheckpointApplyJob,
  planLargeBomBackgroundExpansionJob,
  publicBackgroundExpansionJob,
  publicCheckpointApplyJob,
  runLargeBomBackgroundExpansionJob,
  runLargeBomCheckpointApplyJobChunk,
  summarizeLargeBomBackgroundExpansionJobForEvidence,
  summarizeLargeBomCheckpointApplyJobForEvidence,
  isAuthoritativeLargeBomExpansion,
  assertAuthoritativeLargeBomExpansion,
  isAuthoritativeLargeBomPlan,
  assertAuthoritativeLargeBomPlan,
  __internals: {
    backgroundJobKey,
    checkpointApplyJobKey,
    ensureDurableJobStorage,
    hashJson,
    safeEvidenceToken,
    safeTokenList,
    nonNegativeInteger,
    normalizeChunkSize,
    requireCheckpointRecordsApi,
  },
}
