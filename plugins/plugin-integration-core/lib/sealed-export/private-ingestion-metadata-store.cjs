'use strict'

const { failSealedExport } = require('./failure-vocabulary.cjs')

const SESSION_TABLE = 'integration_sealed_export_ingestion_sessions'
const RECEIPT_TABLE = 'integration_sealed_export_ingestion_receipts'
const TOMBSTONE_TABLE = 'integration_sealed_export_ingestion_tombstones'

function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  return []
}

function firstRow(result) {
  const rows = rowsOf(result)
  return rows.length > 0 ? rows[0] : null
}

function authorityWhere(binding) {
  return {
    tenant_id: binding.tenantId,
    workspace_id: binding.workspaceId,
    tenant_domain_binding: binding.tenantDomainBinding,
    system_content_key: binding.systemContentKey,
    role_binding_fingerprint: binding.roleBindingFingerprint,
  }
}

function scopedWhere(binding) {
  return Object.assign({ session_id: binding.sessionId }, authorityWhere(binding))
}

function receiptWhere(binding) {
  return {
    session_id: binding.sessionId,
    tenant_id: binding.tenantId,
    workspace_id: binding.workspaceId,
    tenant_domain_binding: binding.tenantDomainBinding,
    system_content_key: binding.systemContentKey,
    role_binding_fingerprint: binding.roleBindingFingerprint,
  }
}

function createPrivateIngestionMetadataStore({ db } = {}) {
  const required = [
    'select',
    'selectOne',
    'insertOne',
    'updateRow',
    'deleteRows',
    'transaction',
  ]
  if (!db || required.some((name) => typeof db[name] !== 'function')) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  async function readState(binding) {
    let session
    let tombstone
    try {
      session = await db.selectOne(SESSION_TABLE, scopedWhere(binding))
      if (session === null) {
        tombstone = await db.selectOne(TOMBSTONE_TABLE, scopedWhere(binding))
      }
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (session !== null) return Object.freeze({ kind: 'SESSION', session })
    if (tombstone !== null) return Object.freeze({ kind: 'TOMBSTONE', tombstone })
    return Object.freeze({ kind: 'MISSING' })
  }

  async function listReceipts(binding) {
    const rows = []
    let offset = 0
    while (true) {
      let result
      try {
        result = await db.select(RECEIPT_TABLE, {
          where: receiptWhere(binding),
          orderBy: ['chunk_index', 'ASC'],
          limit: 10000,
          offset,
        })
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
      const page = rowsOf(result)
      rows.push(...page)
      if (page.length < 10000) break
      offset += page.length
    }
    return Object.freeze(rows)
  }

  async function loadAfterCreateConflict(binding) {
    const state = await readState(binding)
    if (state.kind === 'TOMBSTONE') {
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    if (state.kind !== 'SESSION') {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (
      state.session.status === 'UPLOAD_COMPLETE'
      || state.session.status === 'CLEANING'
    ) {
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    return state.session
  }

  async function createSession(row) {
    let outcome
    try {
      outcome = await db.transaction(async (trx) => {
        const where = scopedWhere({
          sessionId: row.session_id,
          tenantId: row.tenant_id,
          workspaceId: row.workspace_id,
          tenantDomainBinding: row.tenant_domain_binding,
          systemContentKey: row.system_content_key,
          roleBindingFingerprint: row.role_binding_fingerprint,
        })
        const tombstone = await trx.selectOne(TOMBSTONE_TABLE, where)
        if (tombstone !== null) return { kind: 'TOMBSTONE' }
        const existing = await trx.selectOne(SESSION_TABLE, where)
        if (existing !== null) return { kind: 'EXISTING', row: existing }
        return { kind: 'CREATED', row: firstRow(await trx.insertOne(SESSION_TABLE, row)) }
      })
    } catch {
      return loadAfterCreateConflict({
        sessionId: row.session_id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        tenantDomainBinding: row.tenant_domain_binding,
        systemContentKey: row.system_content_key,
        roleBindingFingerprint: row.role_binding_fingerprint,
      })
    }
    if (outcome.kind === 'TOMBSTONE') {
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    if (outcome.row === null) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (outcome.row.status === 'UPLOAD_COMPLETE') {
      failSealedExport('SEALED_EXPORT_MANIFEST_REPLAYED')
    }
    return outcome.row
  }

  async function beginChunkWrite(binding, pending) {
    let updated
    try {
      updated = firstRow(await db.updateRow(
        SESSION_TABLE,
        {
          status: 'CHUNK_WRITING',
          pending_chunk_index: pending.chunkIndex,
          pending_chunk_digest: pending.chunkDigest,
          pending_byte_count: pending.byteCount,
          pending_write_token: pending.writeToken,
        },
        Object.assign({}, scopedWhere(binding), {
          status: 'UPLOADING',
          accepted_chunk_count: pending.chunkIndex,
          pending_chunk_index: null,
          pending_chunk_digest: null,
          pending_byte_count: null,
          pending_write_token: null,
        }),
      ))
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (updated === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return updated
  }

  async function releaseChunkWrite(binding, writeToken) {
    let updated
    try {
      updated = firstRow(await db.updateRow(
        SESSION_TABLE,
        {
          status: 'UPLOADING',
          pending_chunk_index: null,
          pending_chunk_digest: null,
          pending_byte_count: null,
          pending_write_token: null,
        },
        Object.assign({}, scopedWhere(binding), {
          status: 'CHUNK_WRITING',
          pending_write_token: writeToken,
        }),
      ))
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (updated === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return updated
  }

  async function finishChunkWrite(binding, row, writeToken) {
    let recorded
    try {
      recorded = await db.transaction(async (trx) => {
        const updated = firstRow(await trx.updateRow(
          SESSION_TABLE,
          {
            status: 'UPLOADING',
            accepted_chunk_count: row.chunk_index + 1,
            pending_chunk_index: null,
            pending_chunk_digest: null,
            pending_byte_count: null,
            pending_write_token: null,
          },
          Object.assign({}, scopedWhere(binding), {
            status: 'CHUNK_WRITING',
            pending_chunk_index: row.chunk_index,
            pending_chunk_digest: row.chunk_digest,
            pending_byte_count: row.byte_count,
            pending_write_token: writeToken,
          }),
        ))
        if (updated === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
        const inserted = firstRow(await trx.insertOne(RECEIPT_TABLE, row))
        if (inserted === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
        return { inserted, updated }
      })
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return recorded.inserted
  }

  async function markComplete(binding, completedAt, expectedChunkCount) {
    let updated
    try {
      updated = firstRow(await db.updateRow(
        SESSION_TABLE,
        {
          status: 'UPLOAD_COMPLETE',
          completed_at: completedAt,
        },
        Object.assign({}, scopedWhere(binding), {
          status: 'UPLOADING',
          accepted_chunk_count: expectedChunkCount,
        }),
      ))
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (updated === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    return updated
  }

  async function claimCompletedSession(binding, generationId, claimedAt) {
    let updated
    try {
      updated = firstRow(await db.updateRow(
        SESSION_TABLE,
        {
          generation_claim_id: generationId,
          generation_claimed_at: claimedAt,
        },
        Object.assign({}, scopedWhere(binding), {
          status: 'UPLOAD_COMPLETE',
          generation_claim_id: null,
          generation_claimed_at: null,
        }),
      ))
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (updated !== null) return updated

    const state = await readState(binding)
    if (
      state.kind === 'SESSION'
      && state.session.status === 'UPLOAD_COMPLETE'
      && state.session.generation_claim_id === generationId
      && state.session.generation_claimed_at !== null
    ) {
      return state.session
    }
    failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
  }

  async function releaseGenerationClaim(binding, generationId) {
    let updated
    try {
      updated = firstRow(await db.updateRow(
        SESSION_TABLE,
        {
          generation_claim_id: null,
          generation_claimed_at: null,
        },
        Object.assign({}, scopedWhere(binding), {
          status: 'UPLOAD_COMPLETE',
          generation_claim_id: generationId,
        }),
      ))
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (updated !== null) return updated
    const state = await readState(binding)
    if (
      state.kind === 'SESSION'
      && state.session.status === 'UPLOAD_COMPLETE'
      && state.session.generation_claim_id === null
      && state.session.generation_claimed_at === null
    ) {
      return state.session
    }
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  async function beginCleanup(binding, expectedStatus, supportsGenerationClaims) {
    let updated
    try {
      const where = Object.assign({}, scopedWhere(binding), {
        status: expectedStatus,
      })
      if (supportsGenerationClaims) {
        where.generation_claim_id = null
      }
      updated = firstRow(await db.updateRow(
        SESSION_TABLE,
        {
          status: 'CLEANING',
          pending_chunk_index: null,
          pending_chunk_digest: null,
          pending_byte_count: null,
          pending_write_token: null,
        },
        where,
      ))
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return updated
  }

  async function listExpiredSessions(binding, expiresAt, limit) {
    let result
    try {
      result = await db.select(SESSION_TABLE, {
        where: authorityWhere(binding),
        range: { expires_at: { lte: expiresAt } },
        orderBy: ['expires_at', 'ASC'],
        limit,
      })
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return Object.freeze(rowsOf(result).slice())
  }

  async function tombstoneAndDelete(binding, cleanupReason, cleanedAt) {
    let outcome
    try {
      outcome = await db.transaction(async (trx) => {
        const where = scopedWhere(binding)
        const existingTombstone = await trx.selectOne(TOMBSTONE_TABLE, where)
        if (existingTombstone !== null) {
          return { kind: 'TOMBSTONE', row: existingTombstone }
        }
        const session = await trx.selectOne(SESSION_TABLE, where)
        if (session === null) return { kind: 'MISSING' }
        if (session.status !== 'CLEANING') {
          failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
        }
        const tombstone = firstRow(await trx.insertOne(TOMBSTONE_TABLE, {
          session_id: binding.sessionId,
          tenant_id: binding.tenantId,
          workspace_id: binding.workspaceId,
          tenant_domain_binding: session.tenant_domain_binding,
          system_content_key: binding.systemContentKey,
          role_binding_fingerprint: binding.roleBindingFingerprint,
          manifest_digest: session.manifest_digest,
          cleanup_reason: cleanupReason,
          cleaned_at: cleanedAt,
        }))
        await trx.deleteRows(RECEIPT_TABLE, receiptWhere(binding))
        await trx.deleteRows(SESSION_TABLE, where)
        return { kind: 'CREATED', row: tombstone }
      })
    } catch {
      const state = await readState(binding)
      if (state.kind === 'TOMBSTONE') return state.tombstone
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (outcome.kind === 'MISSING' || outcome.row === null) {
      failSealedExport('SEALED_EXPORT_UPLOAD_SESSION_INVALID')
    }
    return outcome.row
  }

  return Object.freeze({
    createSession,
    readState,
    listReceipts,
    beginChunkWrite,
    releaseChunkWrite,
    finishChunkWrite,
    markComplete,
    claimCompletedSession,
    releaseGenerationClaim,
    beginCleanup,
    listExpiredSessions,
    tombstoneAndDelete,
  })
}

module.exports = Object.freeze({
  createPrivateIngestionMetadataStore,
  SESSION_TABLE,
  RECEIPT_TABLE,
  TOMBSTONE_TABLE,
})
