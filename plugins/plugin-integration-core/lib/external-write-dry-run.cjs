'use strict'

// C6 external-write helper for `data-source:sql-write-gated`.
// C6-2 dry-run and C6-3 apply intentionally share one planner so the reviewed
// revision is the same decision surface that apply recomputes before writing.

const crypto = require('node:crypto')

const { transformRecord, getPath } = require('./transform-engine.cjs')
const { validateRecord } = require('./validator.cjs')

const C6_WRITE_DRY_RUN_TOKEN_PREFIX = 'integration:c6-write-dry-run-token:'
const DEFAULT_C6_DRY_RUN_TOKEN_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_ROWS = 100
const MAX_ROWS = 10000
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGES = 100
const TARGET_KIND = 'data-source:sql-write-gated'
const C6_TEST_INJECTED_ROW_FAILURE = 'C6_TEST_INJECTED_ROW_FAILURE'
const C6_TEST_FAILURE_INJECTION_CONFIG_INVALID = 'C6_TEST_FAILURE_INJECTION_CONFIG_INVALID'
const C6_TEST_FAILURE_INJECTION_UNSAFE_TARGET = 'C6_TEST_FAILURE_INJECTION_UNSAFE_TARGET'
const CONSUMING_TOKEN_KEYS = new Set()
const SAFE_WRITE_ERROR_CODES = new Set([
  'AdapterValidationError',
  C6_TEST_INJECTED_ROW_FAILURE,
  'DATA_SOURCE_BRIDGE_CONFIG_ERROR',
  'DATA_SOURCE_GENERIC_QUERY_DISABLED_REQUIRED',
  'DATA_SOURCE_NOT_C6_WRITE_TARGET',
  'DATA_SOURCE_NOT_FOUND',
  'DATA_SOURCE_NOT_VISIBLE',
  'DATA_SOURCE_NOT_WRITABLE',
  'DATA_SOURCE_PRINCIPAL_REQUIRED',
  'DATA_SOURCE_QUERY_INVALID',
  'DataSourceBridgeConfigError',
  'DataSourceNotC6WriteTargetError',
  'DataSourceNotWritableError',
  'DataSourceQueryDisabledError',
  'DataSourceUnavailableError',
  'DUPLICATE_KEY',
])

class ExternalWriteDryRunError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'ExternalWriteDryRunError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_DRY_RUN_CONFIG_INVALID', `${field} is required`, { field })
  }
  return normalized
}

function positiveInteger(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new ExternalWriteDryRunError(400, 'C6_WRITE_DRY_RUN_REQUEST_INVALID', `${field} must be a positive integer`, { field })
  }
  return Math.min(numeric, MAX_ROWS)
}

function positiveConfigInteger(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const numeric = Number(value)
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_CONFIG_INVALID, `${field} must be a positive integer`, { field })
  }
  return numeric
}

function requiredTestFailureString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_CONFIG_INVALID, `${field} is required`, { field })
  }
  return normalized
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

function tokenStoreKey(token) {
  return `${C6_WRITE_DRY_RUN_TOKEN_PREFIX}${token}`
}

function requireTokenStore(tokenStore) {
  if (!tokenStore || typeof tokenStore.get !== 'function' || typeof tokenStore.set !== 'function') {
    throw new ExternalWriteDryRunError(501, 'C6_WRITE_DRY_RUN_TOKEN_STORE_UNAVAILABLE', 'C6 write dry-run requires plugin storage for tokens')
  }
  return tokenStore
}

function requireConsumableTokenStore(tokenStore) {
  const store = requireTokenStore(tokenStore)
  if (typeof store.consume !== 'function' && typeof store.delete !== 'function') {
    throw new ExternalWriteDryRunError(501, 'C6_WRITE_DRY_RUN_TOKEN_STORE_UNAVAILABLE', 'C6 write apply requires consumable plugin storage for tokens')
  }
  return store
}

async function createDryRunToken(tokenStore, record) {
  const store = requireTokenStore(tokenStore)
  const token = crypto.randomBytes(24).toString('base64url')
  await store.set(tokenStoreKey(token), {
    ...record,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + DEFAULT_C6_DRY_RUN_TOKEN_TTL_MS).toISOString(),
  })
  return token
}

async function consumeDryRunToken(tokenStore, token, expected) {
  const store = requireConsumableTokenStore(tokenStore)
  const dryRunToken = optionalString(token)
  if (!dryRunToken) {
    throw new ExternalWriteDryRunError(400, 'C6_WRITE_DRY_RUN_TOKEN_REQUIRED', 'dryRunToken is required for apply', { field: 'confirm.dryRunToken' })
  }
  const key = tokenStoreKey(dryRunToken)
  if (CONSUMING_TOKEN_KEYS.has(key)) {
    throw new ExternalWriteDryRunError(409, 'C6_WRITE_DRY_RUN_TOKEN_INVALID', 'dryRunToken is missing, expired, or already used')
  }
  CONSUMING_TOKEN_KEYS.add(key)
  try {
    let stored
    if (typeof store.consume === 'function') {
      stored = await store.consume(key)
    } else {
      stored = await store.get(key)
      await store.delete(key)
    }
    if (!isPlainObject(stored)) {
      throw new ExternalWriteDryRunError(409, 'C6_WRITE_DRY_RUN_TOKEN_INVALID', 'dryRunToken is missing, expired, or already used')
    }
    const expiresAt = Date.parse(stored.expiresAt)
    if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
      throw new ExternalWriteDryRunError(409, 'C6_WRITE_DRY_RUN_TOKEN_INVALID', 'dryRunToken is expired')
    }
    const storedWorkspaceId = stored.workspaceId || null
    const expectedWorkspaceId = expected.workspaceId || null
    if (
      stored.pipelineId !== expected.pipelineId ||
      stored.tenantId !== expected.tenantId ||
      storedWorkspaceId !== expectedWorkspaceId ||
      stored.dryRunUser !== expected.dryRunUser ||
      stored.dataSourceOwnerPrincipal !== expected.dataSourceOwnerPrincipal
    ) {
      throw new ExternalWriteDryRunError(409, 'C6_WRITE_DRY_RUN_TOKEN_MISMATCH', 'dryRunToken does not match this pipeline/user scope')
    }
    return stored
  } finally {
    CONSUMING_TOKEN_KEYS.delete(key)
  }
}

function normalizeFieldList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_DRY_RUN_CONFIG_INVALID', `${field} must be a non-empty array`, { field })
  }
  const seen = new Set()
  return value.map((entry, index) => {
    const normalized = requiredString(entry, `${field}[${index}]`)
    if (seen.has(normalized)) {
      throw new ExternalWriteDryRunError(422, 'C6_WRITE_DRY_RUN_CONFIG_INVALID', `${field} must not contain duplicates`, { field })
    }
    seen.add(normalized)
    return normalized
  })
}

// --- Target-write PROFILE (S1b design-lock §3-A: two-interface split) -----------------
// A profile abstracts the two places the C6 safe-write lifecycle was welded to
// `data-source:sql-write-gated`: (1) which target KIND is an accepted write target, and
// (2) what a SAFE capability state looks like. The write PRIMITIVES stay the injected
// `dataSourceWrites` (test/lookupByKey/insertRows/updateRows) — the planner's proven
// classification, token/fence, per-row isolation and dead-letter are UNCHANGED. The default
// profile is the SQL one, so the existing path behaves byte-for-byte as before.
const SQL_WRITE_GATED_PROFILE = {
  kind: TARGET_KIND,
  normalizeCapabilityState(result) {
    const state = result && result.capabilityState
    if (
      !isPlainObject(state) ||
      typeof state.readOnly !== 'boolean' ||
      typeof state.c6WriteTarget !== 'boolean' ||
      typeof state.genericQueryDisabled !== 'boolean'
    ) {
      throw new ExternalWriteDryRunError(501, 'C6_WRITE_CAPABILITY_STATE_UNAVAILABLE', 'C6 write dry-run requires target capability state from context.api.dataSourceWrites.test')
    }
    return {
      success: result.success === true,
      readOnly: state.readOnly,
      c6WriteTarget: state.c6WriteTarget,
      genericQueryDisabled: state.genericQueryDisabled,
    }
  },
  assertSafeCapabilityState(state) {
    if (state.readOnly !== false || state.c6WriteTarget !== true || state.genericQueryDisabled !== true) {
      throw new ExternalWriteDryRunError(422, 'C6_WRITE_TARGET_CAPABILITY_UNSAFE', 'C6 write target capability state is unsafe')
    }
  },
}

function assertTargetWriteProfile(profile) {
  if (
    !profile ||
    typeof profile.kind !== 'string' ||
    profile.kind.length === 0 ||
    typeof profile.normalizeCapabilityState !== 'function' ||
    typeof profile.assertSafeCapabilityState !== 'function'
  ) {
    throw new ExternalWriteDryRunError(501, 'C6_WRITE_PROFILE_INVALID', 'C6 write requires a valid target-write profile (kind + normalizeCapabilityState + assertSafeCapabilityState)')
  }
  return profile
}

// Resolve the write profile for this run. Default = SQL write-gated, so the existing route
// (which passes none) is unchanged; an opt-in target (S1b-2 multitable, S2 K3) supplies its
// own profile via input.targetWriteProfile.
// TRUST BOUNDARY: a profile IS the per-kind safety policy (its assertSafeCapabilityState is
// the gate). targetWriteProfile is TRUSTED server-side planner wiring only — it must never be
// sourced from request/user input. assertTargetWriteProfile validates shape, not strictness.
function resolveTargetWriteProfile(input) {
  return assertTargetWriteProfile(input && input.targetWriteProfile ? input.targetWriteProfile : SQL_WRITE_GATED_PROFILE)
}

function normalizeTargetConfig(system, profile = SQL_WRITE_GATED_PROFILE) {
  if (!system || system.kind !== profile.kind) {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_TARGET_REQUIRED', `C6 write dry-run requires target kind ${profile.kind}`, {
      expectedKind: profile.kind,
      actualKind: system && system.kind,
    })
  }
  const config = isPlainObject(system.config) ? system.config : {}
  return {
    kind: system.kind,
    dataSourceId: requiredString(config.dataSourceId, 'target.config.dataSourceId'),
    object: requiredString(config.object, 'target.config.object'),
    keyFields: normalizeFieldList(config.keyFields, 'target.config.keyFields'),
    writableFields: normalizeFieldList(config.writableFields, 'target.config.writableFields'),
  }
}

function normalizeTestFailureInjectionConfig(input, { pipeline, targetSystem, targetConfig }) {
  const raw = isPlainObject(input) ? input : {}
  const deployEnabled = raw.deployEnabled === true
  const serverConfigEnabled = raw.enabled === true
  const base = {
    deployEnabled,
    serverConfigEnabled,
    active: false,
    reason: !deployEnabled
      ? 'deploy_disabled'
      : (!serverConfigEnabled ? 'server_config_disabled' : 'not_targeted'),
  }

  if (!deployEnabled || !serverConfigEnabled) return base

  const pipelineId = optionalString(raw.pipelineId)
  const targetSystemId = optionalString(raw.targetSystemId)
  if (!pipelineId || !targetSystemId) {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_CONFIG_INVALID, 'C6 test failure injection requires pipelineId and targetSystemId')
  }
  if (pipelineId !== pipeline.id || targetSystemId !== pipeline.targetSystemId) return base
  if (!targetSystem || targetSystem.id !== targetSystemId) {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_CONFIG_INVALID, 'C6 test failure injection target does not match the loaded target system')
  }
  if (optionalString(raw.environment) !== 'sandbox') {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_UNSAFE_TARGET, 'C6 test failure injection requires server config environment=sandbox')
  }
  if (requiredTestFailureString(raw.targetDataSourceId, 'c6TestFailureInjection.targetDataSourceId') !== targetConfig.dataSourceId) {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_UNSAFE_TARGET, 'C6 test failure injection target data source does not match server config')
  }
  if (requiredTestFailureString(raw.targetObject, 'c6TestFailureInjection.targetObject') !== targetConfig.object) {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_UNSAFE_TARGET, 'C6 test failure injection target object does not match server config')
  }
  return {
    deployEnabled,
    serverConfigEnabled,
    active: true,
    reason: 'active',
    failWriteOrdinal: positiveConfigInteger(raw.failWriteOrdinal, 'c6TestFailureInjection.failWriteOrdinal', 1),
  }
}

function publicTestFailureInjectionEvidence(config) {
  return {
    deployEnabled: config && config.deployEnabled === true,
    serverConfigEnabled: config && config.serverConfigEnabled === true,
    active: config && config.active === true,
    reason: config && config.reason ? config.reason : 'disabled',
  }
}

function revisionTestFailureInjection(config) {
  return {
    deployEnabled: config && config.deployEnabled === true,
    serverConfigEnabled: config && config.serverConfigEnabled === true,
    active: config && config.active === true,
    reason: config && config.reason ? config.reason : 'disabled',
    failWriteOrdinal: config && config.active === true ? config.failWriteOrdinal : null,
  }
}

function isWriteDecision(decision) {
  return decision === 'add' || decision === 'update'
}

function assertTestFailureInjectionPlanReady(config, planRows) {
  if (!config || config.active !== true) return
  const writableRows = planRows.filter((row) => isWriteDecision(row.decision))
  if (writableRows.length < 2) {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_CONFIG_INVALID, 'C6 test failure injection requires at least two writable plan rows')
  }
  if (config.failWriteOrdinal > writableRows.length) {
    throw new ExternalWriteDryRunError(422, C6_TEST_FAILURE_INJECTION_CONFIG_INVALID, 'C6 test failure injection failWriteOrdinal is outside the writable plan')
  }
}

function createInjectedRowFailure() {
  const error = new Error('C6 test injected row failure')
  error.code = C6_TEST_INJECTED_ROW_FAILURE
  return error
}

function requireDataSourceWritesApi(api) {
  if (
    !api ||
    typeof api.test !== 'function' ||
    typeof api.lookupByKey !== 'function' ||
    typeof api.insertRows !== 'function' ||
    typeof api.updateRows !== 'function'
  ) {
    throw new ExternalWriteDryRunError(501, 'C6_WRITE_FACADE_UNAVAILABLE', 'C6 write dry-run requires context.api.dataSourceWrites')
  }
  return api
}

function statusCounts() {
  return { add: 0, update: 0, skip: 0, held: 0, failed: 0 }
}

function valuesEqual(left, right) {
  if (left === right) return true
  if ((left === undefined || left === null) && (right === undefined || right === null)) return true
  if (typeof left !== typeof right) return false
  if (isPlainObject(left) || Array.isArray(left)) return stableStringify(left) === stableStringify(right)
  return false
}

function keyFromRecord(record, keyFields) {
  const key = {}
  const missing = []
  for (const field of keyFields) {
    const value = getPath(record, field)
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      missing.push(field)
    } else {
      key[field] = value
    }
  }
  return { key, missing }
}

function writableDataFromRecord(record, writableFields) {
  const data = {}
  for (const field of writableFields) {
    const value = getPath(record, field)
    if (value !== undefined) data[field] = value
  }
  return data
}

function writeRowFromRecord(record, targetConfig) {
  const { key } = keyFromRecord(record, targetConfig.keyFields)
  return {
    ...key,
    ...writableDataFromRecord(record, targetConfig.writableFields),
  }
}

function classifyExisting({ existingRows, targetRecord, writableFields }) {
  if (existingRows.length === 0) return 'add'
  if (existingRows.length > 1) return 'held'
  const existing = existingRows[0]
  const allEqual = writableFields.every((field) => valuesEqual(getPath(targetRecord, field), getPath(existing, field)))
  return allEqual ? 'skip' : 'update'
}

async function readSourceRows({ sourceAdapter, object, maxRows }) {
  const records = []
  let cursor = null
  let pagesRead = 0
  let complete = false
  while (records.length < maxRows && pagesRead < MAX_PAGES) {
    pagesRead += 1
    const read = await sourceAdapter.read({
      object,
      limit: Math.min(DEFAULT_PAGE_SIZE, maxRows - records.length),
      cursor,
    })
    const pageRecords = Array.isArray(read && read.records) ? read.records : []
    records.push(...pageRecords.slice(0, Math.max(0, maxRows - records.length)))
    if ((read && read.done === true) || !(read && read.nextCursor)) {
      complete = true
      break
    }
    cursor = read.nextCursor
  }
  return {
    records,
    complete,
    pagesRead,
    truncated: !complete,
  }
}

function buildRevision(input) {
  return hashJson({
    pipelineId: input.pipeline.id,
    tenantId: input.pipeline.tenantId,
    workspaceId: input.pipeline.workspaceId || null,
    dryRunUser: input.dryRunUser || null,
    dataSourceOwnerPrincipal: input.dataSourceOwnerPrincipal || null,
    source: {
      systemId: input.pipeline.sourceSystemId,
      object: input.pipeline.sourceObject,
      kind: input.sourceKind,
    },
    target: {
      systemId: input.pipeline.targetSystemId,
      kind: input.targetConfig.kind,
      dataSourceId: input.targetConfig.dataSourceId,
      object: input.targetConfig.object,
      keyFields: input.targetConfig.keyFields,
      writableFields: input.targetConfig.writableFields,
      capabilityState: input.targetCapabilityState,
    },
    testFailureInjection: revisionTestFailureInjection(input.testFailureInjection),
    fieldMappings: input.pipeline.fieldMappings || [],
    rowFingerprints: input.rowFingerprints,
    counts: input.counts,
    completeSourceRead: input.completeSourceRead,
  })
}

function valuesFreeErrorCode(error) {
  if (!error) return 'UNKNOWN_ERROR'
  const raw = error.code || error.name || 'WRITE_FAILED'
  const normalized = String(raw).replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 80)
  return SAFE_WRITE_ERROR_CODES.has(normalized) ? normalized : 'WRITE_FAILED'
}

function publicRowErrorTypes(rowErrors) {
  return Array.from(new Set(rowErrors.map((entry) => entry.errorCode || entry.reason || 'write_failed'))).sort()
}

function publicEvidence({ pipeline, targetConfig, sourceKind, counts, revision, canApply, sourceRead, rowErrorTypes, dryRunToken, testFailureInjection }) {
  return {
    pipelineId: pipeline.id,
    targetKind: targetConfig.kind,
    sourceKind: sourceKind || null,
    operationMode: 'upsert',
    keyFields: targetConfig.keyFields.slice(),
    writableFields: targetConfig.writableFields.slice(),
    counts: cloneJson(counts),
    rowErrorTypes: Array.from(new Set(rowErrorTypes)).sort(),
    sourceRead: {
      complete: sourceRead.complete === true,
      pagesRead: sourceRead.pagesRead,
      truncated: sourceRead.truncated === true,
    },
    dryRunRevision: revision,
    canApply: canApply === true,
    dryRunTokenPresent: typeof dryRunToken === 'string' && dryRunToken.length > 0,
    testFailureInjection: publicTestFailureInjectionEvidence(testFailureInjection),
  }
}

function publicApplyEvidence({ pipeline, targetConfig, sourceKind, status, counts, revision, sourceRead, rowErrors, provenanceEvents, testFailureInjection }) {
  return {
    pipelineId: pipeline.id,
    targetKind: targetConfig.kind,
    sourceKind: sourceKind || null,
    operationMode: 'upsert',
    keyFields: targetConfig.keyFields.slice(),
    writableFields: targetConfig.writableFields.slice(),
    status,
    counts: cloneJson(counts),
    rowErrorTypes: publicRowErrorTypes(rowErrors),
    rowFailureCount: rowErrors.length,
    sourceRead: {
      complete: sourceRead.complete === true,
      pagesRead: sourceRead.pagesRead,
      truncated: sourceRead.truncated === true,
    },
    dryRunRevision: revision,
    dryRunTokenConsumed: true,
    testFailureInjection: publicTestFailureInjectionEvidence(testFailureInjection),
    provenanceEventCounts: provenanceEvents.reduce((acc, event) => {
      acc[event.eventType] = (acc[event.eventType] || 0) + 1
      return acc
    }, {}),
    deadLetterCount: rowErrors.length,
  }
}

function validatePlannerInput(input = {}, phase = 'dry-run') {
  const pipeline = input.pipeline
  if (!pipeline || !pipeline.id) {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_DRY_RUN_CONFIG_INVALID', 'pipeline is required')
  }
  if (typeof input.dataSourceOwnerPrincipal !== 'string' || input.dataSourceOwnerPrincipal.trim() === '') {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_OWNER_PRINCIPAL_REQUIRED', `pipeline.createdBy is required for C6 write ${phase}`)
  }
  if (typeof input.dryRunUser !== 'string' || input.dryRunUser.trim() === '') {
    throw new ExternalWriteDryRunError(401, 'C6_WRITE_DRY_RUN_USER_REQUIRED', `authenticated dry-run user is required for C6 write ${phase}`)
  }
  return pipeline
}

async function computeExternalWritePlan(input = {}) {
  const pipeline = validatePlannerInput(input, input.phase || 'dry-run')
  const profile = resolveTargetWriteProfile(input)
  const targetConfig = normalizeTargetConfig(input.targetSystem, profile)
  const testFailureInjection = normalizeTestFailureInjectionConfig(input.testFailureInjection, {
    pipeline,
    targetSystem: input.targetSystem,
    targetConfig,
  })
  const dataSourceWrites = requireDataSourceWritesApi(input.dataSourceWrites)
  const targetCapabilityState = profile.normalizeCapabilityState(
    await dataSourceWrites.test(targetConfig.dataSourceId, input.dataSourceOwnerPrincipal),
  )
  if (targetCapabilityState.success !== true) {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_TARGET_TEST_FAILED', 'C6 write target test did not pass')
  }
  profile.assertSafeCapabilityState(targetCapabilityState)
  if (!input.sourceAdapter || typeof input.sourceAdapter.read !== 'function') {
    throw new ExternalWriteDryRunError(501, 'C6_WRITE_SOURCE_ADAPTER_UNAVAILABLE', 'source adapter read is required')
  }
  const maxRows = positiveInteger(input.maxRows, 'maxRows', DEFAULT_MAX_ROWS)
  const sourceRead = await readSourceRows({
    sourceAdapter: input.sourceAdapter,
    object: pipeline.sourceObject,
    maxRows,
  })
  const counts = {
    sourceRows: sourceRead.records.length,
    planned: 0,
    ...statusCounts(),
  }
  const rowErrorTypes = []
  const rowFingerprints = []
  const planRows = []
  const policy = {
    keyFields: targetConfig.keyFields,
    writableFields: targetConfig.writableFields,
  }

  for (const sourceRecord of sourceRead.records) {
    const transformed = transformRecord(sourceRecord, pipeline.fieldMappings || [])
    if (!transformed.ok) {
      counts.failed += 1
      rowErrorTypes.push('transform_failed')
      rowFingerprints.push({ status: 'failed', reason: 'transform_failed', source: hashJson(sourceRecord) })
      continue
    }
    const validation = validateRecord(transformed.value, pipeline.fieldMappings || [])
    if (!validation.ok) {
      counts.failed += 1
      rowErrorTypes.push('validation_failed')
      rowFingerprints.push({ status: 'failed', reason: 'validation_failed', source: hashJson(sourceRecord) })
      continue
    }
    const { key, missing } = keyFromRecord(transformed.value, targetConfig.keyFields)
    if (missing.length > 0) {
      counts.held += 1
      rowErrorTypes.push('missing_key')
      rowFingerprints.push({ status: 'held', reason: 'missing_key', fields: missing, source: hashJson(sourceRecord) })
      continue
    }

    const lookup = await dataSourceWrites.lookupByKey(
      targetConfig.dataSourceId,
      targetConfig.object,
      key,
      policy,
      input.dataSourceOwnerPrincipal,
    )
    const existingRows = Array.isArray(lookup && lookup.data) ? lookup.data : []
    const decision = classifyExisting({
      existingRows,
      targetRecord: transformed.value,
      writableFields: targetConfig.writableFields,
    })
    const writeRow = writeRowFromRecord(transformed.value, targetConfig)
    counts[decision] += 1
    counts.planned += 1
    if (decision === 'held') rowErrorTypes.push('ambiguous_target_key')
    planRows.push({
      decision,
      key,
      keyFingerprint: hashJson(key),
      row: writeRow,
    })
    rowFingerprints.push({
      status: decision,
      key: hashJson(key),
      target: hashJson({
        key,
        data: writableDataFromRecord(transformed.value, targetConfig.writableFields),
      }),
      lookup: hashJson({ count: existingRows.length }),
    })
  }

  if (sourceRead.truncated) {
    rowErrorTypes.push('source_read_truncated')
  }
  const canApply = sourceRead.complete === true && counts.failed === 0 && counts.held === 0
  if (canApply) {
    assertTestFailureInjectionPlanReady(testFailureInjection, planRows)
  }
  const revision = buildRevision({
    pipeline,
    sourceKind: input.sourceSystem && input.sourceSystem.kind,
    targetConfig,
    targetCapabilityState,
    testFailureInjection,
    dryRunUser: input.dryRunUser,
    dataSourceOwnerPrincipal: input.dataSourceOwnerPrincipal,
    rowFingerprints,
    counts,
    completeSourceRead: sourceRead.complete === true,
  })
  return {
    pipeline,
    targetConfig,
    dataSourceWrites,
    targetCapabilityState,
    sourceKind: input.sourceSystem && input.sourceSystem.kind,
    sourceRead,
    counts,
    rowErrorTypes,
    rowFingerprints,
    planRows,
    policy,
    canApply,
    revision,
    testFailureInjection,
    maxRows,
  }
}

async function dryRunExternalWrite(input = {}) {
  const plan = await computeExternalWritePlan(input)
  let dryRunToken = null
  if (plan.canApply) {
    dryRunToken = await createDryRunToken(input.tokenStore, {
      pipelineId: plan.pipeline.id,
      tenantId: plan.pipeline.tenantId,
      workspaceId: plan.pipeline.workspaceId || null,
      dryRunUser: input.dryRunUser,
      dataSourceOwnerPrincipal: input.dataSourceOwnerPrincipal,
      revision: plan.revision,
      counts: cloneJson(plan.counts),
      maxRows: plan.maxRows,
    })
  }
  return {
    pipelineId: plan.pipeline.id,
    status: plan.canApply ? 'ready' : 'not_applyable',
    canApply: plan.canApply,
    dryRunToken,
    revision: plan.revision,
    counts: plan.counts,
    evidence: publicEvidence({
      pipeline: plan.pipeline,
      targetConfig: plan.targetConfig,
      sourceKind: plan.sourceKind,
      counts: plan.counts,
      revision: plan.revision,
      canApply: plan.canApply,
      sourceRead: plan.sourceRead,
      rowErrorTypes: plan.rowErrorTypes,
      dryRunToken,
      testFailureInjection: plan.testFailureInjection,
    }),
  }
}

function applyStatus(counts) {
  if (counts.failed === 0) return 'succeeded'
  if (counts.add > 0 || counts.update > 0 || counts.skip > 0) return 'partial'
  return 'failed'
}

function syntheticRunId(pipeline, revision) {
  return `c6-external-write:${pipeline.id}:${revision}`
}

function provenanceEvent({ pipeline, revision, runId, row, eventType, targetKind = TARGET_KIND, attrs = {} }) {
  return {
    runId: runId || syntheticRunId(pipeline, revision),
    rowId: row && row.keyFingerprint ? row.keyFingerprint : hashJson({ pipelineId: pipeline.id, eventType, attrs }),
    eventType,
    at: new Date().toISOString(),
    attrs: {
      targetKind,
      dryRunRevision: revision,
      ...attrs,
    },
  }
}

function deadLetterForRowFailure({ pipeline, revision, runId, rowError }) {
  return {
    tenantId: pipeline.tenantId,
    workspaceId: pipeline.workspaceId || null,
    runId: runId || syntheticRunId(pipeline, revision),
    pipelineId: pipeline.id,
    idempotencyKey: rowError.keyFingerprint,
    sourcePayload: {
      c6ExternalWrite: true,
      keyFingerprint: rowError.keyFingerprint,
      decision: rowError.decision,
    },
    transformedPayload: null,
    errorCode: rowError.errorCode || 'WRITE_FAILED',
    errorMessage: rowError.errorCode || 'WRITE_FAILED',
    status: 'open',
  }
}

async function persistDeadLetters({ deadLetterStore, pipeline, revision, runId, rowErrors }) {
  if (!deadLetterStore || typeof deadLetterStore.createDeadLetter !== 'function') return []
  const persisted = []
  for (const rowError of rowErrors) {
    persisted.push(await deadLetterStore.createDeadLetter(deadLetterForRowFailure({
      pipeline,
      revision,
      runId,
      rowError,
    })))
  }
  return persisted
}

async function applyExternalWrite(input = {}) {
  const applyUser = optionalString(input.applyUser)
  if (!applyUser) {
    throw new ExternalWriteDryRunError(401, 'C6_WRITE_APPLY_USER_REQUIRED', 'authenticated apply user is required')
  }
  const pipeline = validatePlannerInput({
    ...input,
    dryRunUser: applyUser,
  }, 'apply')
  const tokenRecord = await consumeDryRunToken(input.tokenStore, input.dryRunToken, {
    pipelineId: pipeline.id,
    tenantId: pipeline.tenantId,
    workspaceId: pipeline.workspaceId || null,
    dryRunUser: applyUser,
    dataSourceOwnerPrincipal: input.dataSourceOwnerPrincipal,
  })
  const plan = await computeExternalWritePlan({
    ...input,
    dryRunUser: tokenRecord.dryRunUser,
    maxRows: tokenRecord.maxRows || input.maxRows,
    phase: 'apply',
  })
  if (tokenRecord.revision !== plan.revision) {
    throw new ExternalWriteDryRunError(409, 'C6_WRITE_DRY_RUN_TOKEN_MISMATCH', 'dryRunToken does not match the current dry-run revision')
  }
  if (!plan.canApply) {
    throw new ExternalWriteDryRunError(409, 'C6_WRITE_DRY_RUN_NOT_APPLYABLE', 'current dry-run is not applyable')
  }

  const counts = {
    sourceRows: plan.counts.sourceRows,
    planned: plan.counts.planned,
    add: 0,
    update: 0,
    skip: 0,
    held: 0,
    failed: 0,
    written: 0,
  }
  const rowErrors = []
  const provenanceEvents = []
  const runId = optionalString(input.runId) || syntheticRunId(plan.pipeline, plan.revision)
  let writeOrdinal = 0
  for (const row of plan.planRows) {
    if (row.decision === 'skip') {
      counts.skip += 1
      provenanceEvents.push(provenanceEvent({
        pipeline: plan.pipeline,
        revision: plan.revision,
        runId,
        targetKind: plan.targetConfig.kind,
        row,
        eventType: 'target_write_succeeded',
        attrs: { decision: 'skip', writePerformed: false },
      }))
      continue
    }
    if (row.decision === 'held') {
      counts.held += 1
      provenanceEvents.push(provenanceEvent({
        pipeline: plan.pipeline,
        revision: plan.revision,
        runId,
        targetKind: plan.targetConfig.kind,
        row,
        eventType: 'target_write_failed',
        attrs: { decision: 'held', errorCode: 'C6_WRITE_ROW_HELD' },
      }))
      continue
    }
    try {
      writeOrdinal += 1
      if (plan.testFailureInjection && plan.testFailureInjection.active === true && writeOrdinal === plan.testFailureInjection.failWriteOrdinal) {
        throw createInjectedRowFailure()
      }
      if (row.decision === 'add') {
        await plan.dataSourceWrites.insertRows(
          plan.targetConfig.dataSourceId,
          plan.targetConfig.object,
          [row.row],
          plan.policy,
          input.dataSourceOwnerPrincipal,
        )
        counts.add += 1
      } else if (row.decision === 'update') {
        await plan.dataSourceWrites.updateRows(
          plan.targetConfig.dataSourceId,
          plan.targetConfig.object,
          [row.row],
          plan.policy,
          input.dataSourceOwnerPrincipal,
        )
        counts.update += 1
      } else {
        counts.held += 1
        continue
      }
      counts.written += 1
      provenanceEvents.push(provenanceEvent({
        pipeline: plan.pipeline,
        revision: plan.revision,
        runId,
        targetKind: plan.targetConfig.kind,
        row,
        eventType: 'target_write_succeeded',
        attrs: { decision: row.decision, writePerformed: true },
      }))
    } catch (error) {
      counts.failed += 1
      const errorCode = valuesFreeErrorCode(error)
      rowErrors.push({ decision: row.decision, errorCode, keyFingerprint: row.keyFingerprint })
      provenanceEvents.push(provenanceEvent({
        pipeline: plan.pipeline,
        revision: plan.revision,
        runId,
        targetKind: plan.targetConfig.kind,
        row,
        eventType: 'target_write_failed',
        attrs: { decision: row.decision, errorCode },
      }))
    }
  }
  const status = applyStatus(counts)
  const persistedDeadLetters = await persistDeadLetters({
    deadLetterStore: input.deadLetterStore,
    pipeline: plan.pipeline,
    revision: plan.revision,
    runId,
    rowErrors,
  })
  return {
    pipelineId: plan.pipeline.id,
    status,
    dryRunRevision: plan.revision,
    counts,
    rowErrors: rowErrors.map((entry) => ({
      decision: entry.decision,
      errorCode: entry.errorCode,
      keyFingerprint: entry.keyFingerprint,
    })),
    provenanceEvents,
    deadLetters: {
      attempted: rowErrors.length,
      persisted: persistedDeadLetters.length,
    },
    evidence: publicApplyEvidence({
      pipeline: plan.pipeline,
      targetConfig: plan.targetConfig,
      sourceKind: plan.sourceKind,
      status,
      counts,
      revision: plan.revision,
      sourceRead: plan.sourceRead,
      rowErrors,
      provenanceEvents,
      testFailureInjection: plan.testFailureInjection,
    }),
  }
}

module.exports = {
  ExternalWriteDryRunError,
  applyExternalWrite,
  dryRunExternalWrite,
  __internals: {
    C6_WRITE_DRY_RUN_TOKEN_PREFIX,
    C6_TEST_INJECTED_ROW_FAILURE,
    TARGET_KIND,
    SQL_WRITE_GATED_PROFILE,
    resolveTargetWriteProfile,
    assertTargetWriteProfile,
    buildRevision,
    computeExternalWritePlan,
    consumeDryRunToken,
    normalizeTargetConfig,
    normalizeTestFailureInjectionConfig,
    valuesEqual,
  },
}
