'use strict'

const crypto = require('node:crypto')

const canonicalCodec = require('./canonical-json.cjs')
const {
  failSealedExport,
  isTrustedSealedExportError,
} = require('./failure-vocabulary.cjs')
const {
  AUTHORITY_STATE_TABLE,
} = require('./sealed-export-signer-authority-store.cjs')

const BINDING_TABLE = 'integration_sealed_export_stock_prep_bindings'
const RUN_TABLE = 'integration_sealed_export_stock_prep_runs'
const OBJECT_KEY = 'stock-preparation-bom'
const RELATION_ID = 'sqlserver.relation.rowid_payload.v1'
const RESUMABLE_STATUSES = new Set([
  'CAPTURED',
  'INGESTING',
  'INGESTED',
  'GENERATION_VERIFIED',
  'ACTIVATED',
  'COMPLETED',
])
const STATUS_TRANSITIONS = Object.freeze({
  CAPTURING: Object.freeze(['CAPTURE_FAILED', 'CAPTURED']),
  CAPTURED: Object.freeze(['INGESTING']),
  INGESTING: Object.freeze(['INGESTED']),
  INGESTED: Object.freeze(['GENERATION_VERIFIED']),
  GENERATION_VERIFIED: Object.freeze(['ACTIVATED']),
  ACTIVATED: Object.freeze(['COMPLETED']),
})

function requiredText(value, maxLength) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || value.trim() !== value
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
  }
  return value
}

function requiredToken(value) {
  return requiredText(value, 256)
}

function requiredPath(value) {
  return requiredText(value, 4096)
}

function requiredInstant(value) {
  let text
  try {
    text = value instanceof Date ? value.toISOString() : value
  } catch {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const parsed = Date.parse(text)
  if (
    typeof text !== 'string'
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== text
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return text
}

function requiredDigest(value) {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{64}$/.test(value)
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return value
}

function normalizeWorkspaceId(value) {
  if (value === null) return null
  return requiredToken(value)
}

function strictCanonical(value) {
  const result = canonicalCodec.tryFreezeCanonical(value)
  if (!result.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return result.value
}

function rowFromResult(result) {
  const rows = Array.isArray(result)
    ? result
    : result && Array.isArray(result.rows)
      ? result.rows
      : []
  if (rows.length !== 1) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return rows[0]
}

function normalizeBinding(row, scope, nowMs) {
  if (
    !row
    || typeof row !== 'object'
    || row.tenant_id !== scope.tenantId
    || (row.workspace_id ?? null) !== scope.workspaceId
    || row.object_key !== OBJECT_KEY
    || row.relation_id !== RELATION_ID
    || row.status !== 'ACTIVE'
    || !Number.isFinite(Date.parse(row.expires_at))
    || Date.parse(row.expires_at) <= nowMs
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return Object.freeze({
    approvedConfigVersionId: requiredToken(row.approved_config_version_id),
    bindingId: requiredToken(row.binding_id),
    bindingVersion: requiredToken(row.binding_version),
    canonicalObjectVersion: requiredToken(row.canonical_object_version),
    configContentKey: requiredToken(row.config_content_key),
    expiresAt: new Date(row.expires_at).toISOString(),
    externalSystemId: requiredToken(row.external_system_id),
    objectKey: OBJECT_KEY,
    relationId: RELATION_ID,
    roleBindingFingerprint: requiredToken(row.role_binding_fingerprint),
    systemContentKey: requiredToken(row.system_content_key),
    tableRef: requiredToken(row.table_ref),
    tenantDomainBinding: requiredToken(row.tenant_domain_binding),
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
}

function normalizeRun(row, scope, operationId) {
  if (
    !row
    || typeof row !== 'object'
    || row.tenant_id !== scope.tenantId
    || (row.workspace_id ?? null) !== scope.workspaceId
    || row.operation_id !== operationId
    || row.source_read_count !== 1
    || (
      row.status !== 'CAPTURING'
      && row.status !== 'CAPTURE_FAILED'
      && !RESUMABLE_STATUSES.has(row.status)
    )
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const captured = RESUMABLE_STATUSES.has(row.status)
  if (captured) {
    const envelope = canonicalCodec.tryFreezeCanonical(
      row.export_request_envelope,
    )
    const manifest = canonicalCodec.tryFreezeCanonical(row.manifest)
    const chunkPaths = canonicalCodec.tryFreezeCanonical(row.chunk_paths)
    if (
      !envelope.ok
      || !manifest.ok
      || !chunkPaths.ok
      || !canonicalCodec.__internals.isStrictPlainObject(envelope.value)
      || !canonicalCodec.__internals.isStrictPlainObject(manifest.value)
      || !Array.isArray(chunkPaths.value)
      || chunkPaths.value.length < 1
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    requiredDigest(row.manifest_digest)
    requiredPath(row.artifact_directory)
    requiredInstant(row.captured_at)
  } else if (
    row.export_request_envelope !== null
    || row.manifest !== null
    || row.manifest_digest !== null
    || row.artifact_directory !== null
    || row.chunk_paths !== null
    || row.captured_at !== null
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const ingested = new Set([
    'INGESTED',
    'INGESTING',
    'GENERATION_VERIFIED',
    'ACTIVATED',
    'COMPLETED',
  ]).has(row.status)
  if (ingested) {
    requiredToken(row.ingestion_session_id)
    requiredInstant(row.ingested_at)
  } else if (
    row.ingestion_session_id !== null
    || row.ingested_at !== null
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const generated = new Set([
    'GENERATION_VERIFIED',
    'ACTIVATED',
    'COMPLETED',
  ]).has(row.status)
  if (generated) {
    requiredToken(row.generation_id)
    requiredInstant(row.generation_verified_at)
  } else if (
    row.generation_id !== null
    || row.generation_verified_at !== null
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (row.status === 'ACTIVATED' || row.status === 'COMPLETED') {
    requiredInstant(row.activated_at)
  } else if (row.activated_at !== null) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  let businessLineCount = null
  if (row.status === 'COMPLETED') {
    requiredToken(row.stock_preparation_run_id)
    requiredInstant(row.completed_at)
    if (
      !Number.isInteger(row.business_line_count)
      || row.business_line_count < 1
      || row.business_line_count > 24999
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    businessLineCount = row.business_line_count
  } else if (
    row.stock_preparation_run_id !== null
    || row.completed_at !== null
    || row.business_line_count !== null
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (row.status === 'CAPTURE_FAILED') {
    requiredToken(row.failure_reason)
  } else if (row.failure_reason !== null) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return Object.freeze({
    actor: requiredToken(row.actor_id),
    bindingId: requiredToken(row.binding_id),
    businessLineCount,
    createdAt: requiredInstant(row.created_at),
    runId: requiredToken(row.run_id),
    status: row.status,
  })
}

function createStockPreparationRuntimeStore({
  clock = Date.now,
  db,
  idGenerator = crypto.randomUUID,
} = {}) {
  if (
    !db
    || typeof db.selectOne !== 'function'
    || typeof db.transaction !== 'function'
    || typeof clock !== 'function'
    || typeof idGenerator !== 'function'
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const runHandles = new WeakMap()

  function nowMs() {
    let value
    try {
      value = clock()
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (!Number.isFinite(value)) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return value
  }

  function nowIso() {
    return new Date(nowMs()).toISOString()
  }

  async function dbBoundary(action, replayConflict = false) {
    try {
      return await action()
    } catch (error) {
      if (isTrustedSealedExportError(error)) return Promise.reject(error)
      if (replayConflict) {
        failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
      }
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
  }

  function normalizeScope(raw) {
    if (
      !canonicalCodec.__internals.isStrictPlainObject(raw)
      || Object.keys(raw).sort().join('\n') !== 'tenantId\nworkspaceId'
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return Object.freeze({
      tenantId: requiredToken(raw.tenantId),
      workspaceId: normalizeWorkspaceId(raw.workspaceId),
    })
  }

  async function loadActiveBinding(rawScope) {
    const scope = normalizeScope(rawScope)
    return dbBoundary(async () => {
      const row = await db.selectOne(BINDING_TABLE, {
        tenant_id: scope.tenantId,
        workspace_id: scope.workspaceId,
        object_key: OBJECT_KEY,
        status: 'ACTIVE',
      })
      return normalizeBinding(row, scope, nowMs())
    })
  }

  async function loadCurrentAuthority(binding) {
    if (!binding || typeof binding !== 'object') {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    return dbBoundary(async () => {
      const row = await db.selectOne(AUTHORITY_STATE_TABLE, {
        tenant_id: binding.tenantId,
        workspace_id: binding.workspaceId,
        tenant_domain_binding: binding.tenantDomainBinding,
        system_content_key: binding.systemContentKey,
        role_binding_fingerprint: binding.roleBindingFingerprint,
      })
      const instant = nowMs()
      if (!row || typeof row !== 'object') {
        failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
      }
      if (row.signer_status === 'REVOKED') {
        failSealedExport('SEALED_EXPORT_SIGNER_REVOKED')
      }
      const signerExpiresAt = Date.parse(row.signer_expires_at)
      if (
        row.signer_status !== 'ACTIVE'
        || !Number.isFinite(signerExpiresAt)
        || signerExpiresAt <= instant
      ) {
        failSealedExport('SEALED_EXPORT_SIGNER_EXPIRED')
      }
      const bindingExpiresAt = Date.parse(row.binding_expires_at)
      const qualificationExpiresAt = Date.parse(row.qualification_expires_at)
      if (
        row.binding_current !== true
        || !Number.isFinite(bindingExpiresAt)
        || bindingExpiresAt <= instant
        || row.qualification_current !== true
        || !Number.isFinite(qualificationExpiresAt)
        || qualificationExpiresAt <= instant
      ) {
        failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
      }
      return Object.freeze({
        bindingExpiresAt: new Date(bindingExpiresAt).toISOString(),
        qualificationDigest: requiredDigest(row.qualification_digest),
        qualificationExpiresAt: new Date(
          qualificationExpiresAt,
        ).toISOString(),
        signerExpiresAt: new Date(signerExpiresAt).toISOString(),
        signerKeyId: requiredDigest(row.signer_key_id),
      })
    })
  }

  function mintHandle(row, scope, operationId) {
    const normalized = normalizeRun(row, scope, operationId)
    const handle = Object.freeze({
      ...(normalized.status === 'COMPLETED'
        ? { businessLineCount: normalized.businessLineCount }
        : {}),
      externalWrite: false,
      resumable: RESUMABLE_STATUSES.has(normalized.status),
      status: normalized.status,
      valuesFree: true,
    })
    runHandles.set(handle, Object.freeze({
      ...normalized,
      operationId,
      scope,
    }))
    return handle
  }

  async function openRun({
    actor: rawActor,
    binding,
    operationId: rawOperationId,
    scope: rawScope,
  } = {}) {
    const scope = normalizeScope(rawScope)
    const actor = requiredToken(rawActor)
    const operationId = requiredToken(rawOperationId)
    if (
      !binding
      || typeof binding !== 'object'
      || binding.tenantId !== scope.tenantId
      || binding.workspaceId !== scope.workspaceId
    ) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    return dbBoundary(async () => db.transaction(async (trx) => {
      const where = {
        tenant_id: scope.tenantId,
        workspace_id: scope.workspaceId,
        operation_id: operationId,
      }
      const existing = await trx.selectOneForUpdate(RUN_TABLE, where)
      if (existing) {
        const normalized = normalizeRun(existing, scope, operationId)
        if (
          normalized.bindingId !== binding.bindingId
          || normalized.status === 'CAPTURING'
          || normalized.status === 'CAPTURE_FAILED'
        ) {
          failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
        }
        return mintHandle(existing, scope, operationId)
      }
      const runId = requiredToken(idGenerator())
      const created = rowFromResult(await trx.insertOne(RUN_TABLE, {
        binding_id: binding.bindingId,
        actor_id: actor,
        operation_id: operationId,
        run_id: runId,
        source_read_count: 1,
        status: 'CAPTURING',
        tenant_id: scope.tenantId,
        workspace_id: scope.workspaceId,
      }))
      return mintHandle(created, scope, operationId)
    }), true)
  }

  function requireHandle(handle, expectedStatus) {
    const binding = runHandles.get(handle)
    if (!binding || binding.status !== expectedStatus) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return binding
  }

  async function advance(handle, expectedStatus, nextStatus, patch) {
    const binding = requireHandle(handle, expectedStatus)
    if (!STATUS_TRANSITIONS[expectedStatus]?.includes(nextStatus)) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return dbBoundary(async () => db.transaction(async (trx) => {
      const row = await trx.selectOneForUpdate(RUN_TABLE, {
        run_id: binding.runId,
        tenant_id: binding.scope.tenantId,
        workspace_id: binding.scope.workspaceId,
      })
      const current = normalizeRun(row, binding.scope, binding.operationId)
      if (
        current.bindingId !== binding.bindingId
        || current.status !== expectedStatus
      ) {
        failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
      }
      const updated = rowFromResult(await trx.updateRow(
        RUN_TABLE,
        { ...patch, status: nextStatus },
        { run_id: binding.runId, status: expectedStatus },
      ))
      return mintHandle(updated, binding.scope, binding.operationId)
    }))
  }

  async function markCaptureFailed(handle, reason) {
    return advance(handle, 'CAPTURING', 'CAPTURE_FAILED', {
      failure_reason: requiredToken(reason),
    })
  }

  async function markCaptured(handle, rawCapture) {
    if (
      !canonicalCodec.__internals.isStrictPlainObject(rawCapture)
      || Object.keys(rawCapture).sort().join('\n')
        !== [
          'artifactDirectory',
          'chunkPaths',
          'envelope',
          'manifest',
          'manifestDigest',
        ].sort().join('\n')
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    const chunkPaths = strictCanonical(rawCapture.chunkPaths)
    if (!Array.isArray(chunkPaths) || chunkPaths.length < 1) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return advance(handle, 'CAPTURING', 'CAPTURED', {
      artifact_directory: requiredPath(rawCapture.artifactDirectory),
      captured_at: nowIso(),
      chunk_paths: chunkPaths,
      export_request_envelope: strictCanonical(rawCapture.envelope),
      manifest: strictCanonical(rawCapture.manifest),
      manifest_digest: requiredDigest(rawCapture.manifestDigest),
    })
  }

  async function markIngestionStarted(handle, ingestionSessionId) {
    return advance(handle, 'CAPTURED', 'INGESTING', {
      ingested_at: nowIso(),
      ingestion_session_id: requiredToken(ingestionSessionId),
    })
  }

  async function markIngested(handle) {
    return advance(handle, 'INGESTING', 'INGESTED', {})
  }

  async function markGenerationVerified(handle, generationId) {
    return advance(handle, 'INGESTED', 'GENERATION_VERIFIED', {
      generation_id: requiredToken(generationId),
      generation_verified_at: nowIso(),
    })
  }

  async function markActivated(handle) {
    return advance(handle, 'GENERATION_VERIFIED', 'ACTIVATED', {
      activated_at: nowIso(),
    })
  }

  async function markCompleted(
    handle,
    stockPreparationRunId,
    businessLineCount,
  ) {
    if (
      !Number.isInteger(businessLineCount)
      || businessLineCount < 1
      || businessLineCount > 24999
    ) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return advance(handle, 'ACTIVATED', 'COMPLETED', {
      business_line_count: businessLineCount,
      completed_at: nowIso(),
      stock_preparation_run_id: requiredToken(stockPreparationRunId),
    })
  }

  async function readPrivateCheckpoint(handle) {
    const binding = runHandles.get(handle)
    if (!binding || !RESUMABLE_STATUSES.has(binding.status)) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return dbBoundary(async () => {
      const row = await db.selectOne(RUN_TABLE, {
        run_id: binding.runId,
        tenant_id: binding.scope.tenantId,
        workspace_id: binding.scope.workspaceId,
      })
      const current = normalizeRun(row, binding.scope, binding.operationId)
      if (
        current.bindingId !== binding.bindingId
        || current.status !== binding.status
      ) {
        failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
      }
      return strictCanonical({
        actor: current.actor,
        artifactDirectory: row.artifact_directory,
        chunkPaths: row.chunk_paths,
        envelope: row.export_request_envelope,
        generationId: row.generation_id,
        ingestionSessionId: row.ingestion_session_id,
        manifest: row.manifest,
        manifestDigest: row.manifest_digest,
        status: row.status,
        startedAt: current.createdAt,
        stockPreparationRunId: row.stock_preparation_run_id,
      })
    })
  }

  return Object.freeze({
    loadActiveBinding,
    loadCurrentAuthority,
    openRun,
    markCaptureFailed,
    markCaptured,
    markIngestionStarted,
    markIngested,
    markGenerationVerified,
    markActivated,
    markCompleted,
    readPrivateCheckpoint,
  })
}

module.exports = Object.freeze({
  BINDING_TABLE,
  OBJECT_KEY,
  RELATION_ID,
  RUN_TABLE,
  createStockPreparationRuntimeStore,
})
