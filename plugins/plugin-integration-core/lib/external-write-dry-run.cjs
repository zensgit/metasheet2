'use strict'

// C6-2: values-free external-write dry-run for `data-source:sql-write-gated`.
// This module reads source rows, transforms them with the existing pipeline
// mapping, performs structured target key lookups through the host write facade,
// and issues a dry-run token only for a complete, apply-eligible plan. It never
// calls insert/update/upsert/delete.

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

function normalizeTargetConfig(system) {
  if (!system || system.kind !== TARGET_KIND) {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_TARGET_REQUIRED', `C6 write dry-run requires target kind ${TARGET_KIND}`, {
      expectedKind: TARGET_KIND,
      actualKind: system && system.kind,
    })
  }
  const config = isPlainObject(system.config) ? system.config : {}
  return {
    dataSourceId: requiredString(config.dataSourceId, 'target.config.dataSourceId'),
    object: requiredString(config.object, 'target.config.object'),
    keyFields: normalizeFieldList(config.keyFields, 'target.config.keyFields'),
    writableFields: normalizeFieldList(config.writableFields, 'target.config.writableFields'),
  }
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

function normalizeTargetCapabilityState(result) {
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
      kind: TARGET_KIND,
      dataSourceId: input.targetConfig.dataSourceId,
      object: input.targetConfig.object,
      keyFields: input.targetConfig.keyFields,
      writableFields: input.targetConfig.writableFields,
      capabilityState: input.targetCapabilityState,
    },
    fieldMappings: input.pipeline.fieldMappings || [],
    rowFingerprints: input.rowFingerprints,
    counts: input.counts,
    completeSourceRead: input.completeSourceRead,
  })
}

function publicEvidence({ pipeline, targetConfig, sourceKind, counts, revision, canApply, sourceRead, rowErrorTypes, dryRunToken }) {
  return {
    pipelineId: pipeline.id,
    targetKind: TARGET_KIND,
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
  }
}

async function dryRunExternalWrite(input = {}) {
  const pipeline = input.pipeline
  if (!pipeline || !pipeline.id) {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_DRY_RUN_CONFIG_INVALID', 'pipeline is required')
  }
  if (typeof input.dataSourceOwnerPrincipal !== 'string' || input.dataSourceOwnerPrincipal.trim() === '') {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_OWNER_PRINCIPAL_REQUIRED', 'pipeline.createdBy is required for C6 write dry-run')
  }
  if (typeof input.dryRunUser !== 'string' || input.dryRunUser.trim() === '') {
    throw new ExternalWriteDryRunError(401, 'C6_WRITE_DRY_RUN_USER_REQUIRED', 'authenticated dry-run user is required')
  }
  const targetConfig = normalizeTargetConfig(input.targetSystem)
  const dataSourceWrites = requireDataSourceWritesApi(input.dataSourceWrites)
  const targetCapabilityState = normalizeTargetCapabilityState(
    await dataSourceWrites.test(targetConfig.dataSourceId, input.dataSourceOwnerPrincipal),
  )
  if (targetCapabilityState.success !== true) {
    throw new ExternalWriteDryRunError(422, 'C6_WRITE_TARGET_TEST_FAILED', 'C6 write target test did not pass')
  }
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
    counts[decision] += 1
    counts.planned += 1
    if (decision === 'held') rowErrorTypes.push('ambiguous_target_key')
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
  const revision = buildRevision({
    pipeline,
    sourceKind: input.sourceSystem && input.sourceSystem.kind,
    targetConfig,
    targetCapabilityState,
    dryRunUser: input.dryRunUser,
    dataSourceOwnerPrincipal: input.dataSourceOwnerPrincipal,
    rowFingerprints,
    counts,
    completeSourceRead: sourceRead.complete === true,
  })
  let dryRunToken = null
  if (canApply) {
    dryRunToken = await createDryRunToken(input.tokenStore, {
      pipelineId: pipeline.id,
      tenantId: pipeline.tenantId,
      workspaceId: pipeline.workspaceId || null,
      dryRunUser: input.dryRunUser,
      dataSourceOwnerPrincipal: input.dataSourceOwnerPrincipal,
      revision,
      counts: cloneJson(counts),
    })
  }
  return {
    pipelineId: pipeline.id,
    status: canApply ? 'ready' : 'not_applyable',
    canApply,
    dryRunToken,
    revision,
    counts,
    evidence: publicEvidence({
      pipeline,
      targetConfig,
      sourceKind: input.sourceSystem && input.sourceSystem.kind,
      counts,
      revision,
      canApply,
      sourceRead,
      rowErrorTypes,
      dryRunToken,
    }),
  }
}

module.exports = {
  ExternalWriteDryRunError,
  dryRunExternalWrite,
  __internals: {
    C6_WRITE_DRY_RUN_TOKEN_PREFIX,
    TARGET_KIND,
    buildRevision,
    normalizeTargetConfig,
    valuesEqual,
  },
}
