'use strict'

const {
  failSealedExport,
  isTrustedSealedExportError,
} = require('./failure-vocabulary.cjs')

const GENERATION_TABLE = 'integration_sealed_export_generations'
const STAGING_ROW_TABLE = 'integration_sealed_export_generation_staging_rows'
const GENERATION_ROW_TABLE = 'integration_sealed_export_generation_rows'
const AUTHORITY_STATE_TABLE = 'integration_sealed_export_authority_state'
const ACTIVE_POINTER_TABLE = 'integration_sealed_export_active_pointers'
const AUDIT_TABLE = 'integration_sealed_export_generation_audit'

const TRUSTED_STORES = new WeakSet()

function rowsOf(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.rows)) return result.rows
  return []
}

function firstRow(result) {
  const rows = rowsOf(result)
  return rows.length > 0 ? rows[0] : null
}

function authorityWhere(scope) {
  return {
    tenant_id: scope.tenantId,
    workspace_id: scope.workspaceId,
    tenant_domain_binding: scope.tenantDomainBinding,
    system_content_key: scope.systemContentKey,
    role_binding_fingerprint: scope.roleBindingFingerprint,
  }
}

function generationWhere(scope, generationId) {
  return Object.assign(
    { generation_id: generationId },
    authorityWhere(scope),
  )
}

function generationIdentityWhere(scope, manifestDigest) {
  return Object.assign(
    { manifest_digest: manifestDigest },
    authorityWhere(scope),
  )
}

function childScopeRow(generation) {
  return {
    generation_id: generation.generation_id,
    tenant_id: generation.tenant_id,
    workspace_id: generation.workspace_id,
    tenant_domain_binding: generation.tenant_domain_binding,
    system_content_key: generation.system_content_key,
    role_binding_fingerprint: generation.role_binding_fingerprint,
    manifest_digest: generation.manifest_digest,
  }
}

function leaseWhere(generation, lease) {
  return Object.assign({}, generationWhere({
    tenantId: generation.tenant_id,
    workspaceId: generation.workspace_id,
    tenantDomainBinding: generation.tenant_domain_binding,
    systemContentKey: generation.system_content_key,
    roleBindingFingerprint: generation.role_binding_fingerprint,
  }, generation.generation_id), {
    status: generation.status,
    lease_token: lease.token,
    lease_fence: lease.fence,
  })
}

function normalizeFence(value) {
  const normalized = typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
    ? Number(value)
    : value
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return normalized
}

function createGenerationStore({ db } = {}) {
  const required = [
    'select',
    'selectOne',
    'selectOneForUpdate',
    'insertOne',
    'insertMany',
    'updateRow',
    'deleteRows',
    'countRows',
    'transaction',
  ]
  if (!db || required.some((name) => typeof db[name] !== 'function')) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  function build(scopedDb) {
    async function readGeneration(scope, generationId) {
      try {
        return await scopedDb.selectOne(
          GENERATION_TABLE,
          generationWhere(scope, generationId),
        )
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function readGenerationByManifest(scope, manifestDigest) {
      try {
        return await scopedDb.selectOne(
          GENERATION_TABLE,
          generationIdentityWhere(scope, manifestDigest),
        )
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function createGeneration(row, pointerRow, scope) {
      try {
        return await scopedDb.transaction(async (trx) => {
          const existing = await trx.selectOne(
            GENERATION_TABLE,
            generationWhere(scope, row.generation_id),
          )
          if (existing !== null) return existing
          const byManifest = await trx.selectOne(
            GENERATION_TABLE,
            generationIdentityWhere(scope, row.manifest_digest),
          )
          if (byManifest !== null) return byManifest
          const created = firstRow(await trx.insertOne(GENERATION_TABLE, row))
          if (created === null) return null
          const pointer = await trx.selectOne(
            ACTIVE_POINTER_TABLE,
            { pointer_id: pointerRow.pointer_id },
          )
          if (pointer === null) {
            const insertedPointer = firstRow(
              await trx.insertOne(ACTIVE_POINTER_TABLE, pointerRow),
            )
            if (insertedPointer === null) return null
          }
          return created
        })
      } catch {
        const existing = await readGeneration(scope, row.generation_id)
          || await readGenerationByManifest(scope, row.manifest_digest)
        if (existing !== null) return existing
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function acquireLease(
      scope,
      generationId,
      allowedStatuses,
      targetStatus,
      token,
      expiresAt,
      nowMs,
    ) {
      try {
        return await scopedDb.transaction(async (trx) => {
          const current = await trx.selectOne(
            GENERATION_TABLE,
            generationWhere(scope, generationId),
          )
          if (current === null || allowedStatuses.indexOf(current.status) < 0) {
            return null
          }
          const leaseExpiry = current.lease_expires_at === null
            ? null
            : Date.parse(current.lease_expires_at)
          if (
            current.lease_token !== null
            && Number.isFinite(leaseExpiry)
            && leaseExpiry > nowMs
          ) {
            return null
          }
          const nextFence = Number(current.lease_fence) + 1
          const updated = firstRow(await trx.updateRow(
            GENERATION_TABLE,
            {
              status: targetStatus,
              lease_token: token,
              lease_fence: nextFence,
              lease_expires_at: expiresAt,
            },
            Object.assign({}, generationWhere(scope, generationId), {
              status: current.status,
              lease_token: current.lease_token,
              lease_fence: current.lease_fence,
              lease_expires_at: current.lease_expires_at,
            }),
          ))
          return updated
        })
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function resetStaging(generation, lease) {
      try {
        return await scopedDb.transaction(async (trx) => {
          const updated = firstRow(await trx.updateRow(
            GENERATION_TABLE,
            { staged_row_count: 0 },
            Object.assign({}, leaseWhere(generation, lease), {
              staged_row_count: generation.staged_row_count,
            }),
          ))
          if (updated === null) return null
          await trx.deleteRows(STAGING_ROW_TABLE, {
            generation_id: generation.generation_id,
          })
          return updated
        })
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function appendStagingRows(generation, lease, startIndex, rows) {
      const endIndex = startIndex + rows.length
      try {
        return await scopedDb.transaction(async (trx) => {
          const updated = firstRow(await trx.updateRow(
            GENERATION_TABLE,
            { staged_row_count: endIndex },
            Object.assign({}, leaseWhere(generation, lease), {
              staged_row_count: startIndex,
            }),
          ))
          if (updated === null) return null
          if (rows.length > 0) await trx.insertMany(STAGING_ROW_TABLE, rows)
          return updated
        })
      } catch {
        failSealedExport('SEALED_EXPORT_STAGING_WRITE_FAILED')
      }
    }

    async function listStagingRows(generationId, orderBy, limit, offset) {
      try {
        return rowsOf(await scopedDb.select(STAGING_ROW_TABLE, {
          where: { generation_id: generationId },
          orderBy,
          limit,
          offset,
        }))
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function listGenerationRows(generationId, orderBy, limit, offset) {
      try {
        return rowsOf(await scopedDb.select(GENERATION_ROW_TABLE, {
          where: { generation_id: generationId },
          orderBy,
          limit,
          offset,
        }))
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function countStagingRows(generationId) {
      try {
        return await scopedDb.countRows(STAGING_ROW_TABLE, { generation_id: generationId })
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function countGenerationRows(generationId) {
      try {
        return await scopedDb.countRows(GENERATION_ROW_TABLE, { generation_id: generationId })
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function sealGeneration(generation, lease, seal, audit) {
      try {
        return await scopedDb.transaction(async (trx) => {
          const updated = firstRow(await trx.updateRow(
            GENERATION_TABLE,
            {
              status: 'SEALED',
              sealed_row_count: seal.rowCount,
              sealed_byte_count: seal.byteCount,
              sealed_chunk_count: seal.chunkCount,
              sealed_artifact_digest: seal.artifactDigest,
              sealed_rowset_digest: seal.rowsetDigest,
              sealed_receipt_set_digest: seal.receiptSetDigest,
              sealed_at: seal.sealedAt,
              lease_token: null,
              lease_expires_at: null,
            },
            Object.assign({}, leaseWhere(generation, lease), {
              staged_row_count: seal.rowCount,
            }),
          ))
          if (updated === null) return null
          const inserted = firstRow(await trx.insertOne(AUDIT_TABLE, audit))
          if (inserted === null) return null
          return updated
        })
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function appendGenerationRows(generation, lease, startIndex, rows) {
      const endIndex = startIndex + rows.length
      try {
        return await scopedDb.transaction(async (trx) => {
          const updated = firstRow(await trx.updateRow(
            GENERATION_TABLE,
            { applied_row_count: endIndex },
            Object.assign({}, leaseWhere(generation, lease), {
              applied_row_count: startIndex,
            }),
          ))
          if (updated === null) return null
          if (rows.length > 0) await trx.insertMany(GENERATION_ROW_TABLE, rows)
          return updated
        })
      } catch {
        failSealedExport('SEALED_EXPORT_APPLY_INCOMPLETE')
      }
    }

    async function markVerified(generation, lease, digest, verifiedAt, audit) {
      try {
        return await scopedDb.transaction(async (trx) => {
          const updated = firstRow(await trx.updateRow(
            GENERATION_TABLE,
            {
              status: 'VERIFIED',
              applied_rowset_digest: digest,
              verified_at: verifiedAt,
              lease_token: null,
              lease_expires_at: null,
            },
            Object.assign({}, leaseWhere(generation, lease), {
              applied_row_count: generation.sealed_row_count,
            }),
          ))
          if (updated === null) return null
          const inserted = firstRow(await trx.insertOne(AUDIT_TABLE, audit))
          if (inserted === null) return null
          return updated
        })
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function readAuthorityState(scope) {
      try {
        return await scopedDb.selectOne(AUTHORITY_STATE_TABLE, authorityWhere(scope))
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function readAuthorityStateForUpdate(scope) {
      try {
        return await scopedDb.selectOneForUpdate(
          AUTHORITY_STATE_TABLE,
          authorityWhere(scope),
        )
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function transitionToQuarantined(
      generation,
      quarantinedAt,
      audit,
      lease = null,
    ) {
      try {
        const scope = {
          tenantId: generation.tenant_id,
          workspaceId: generation.workspace_id,
          tenantDomainBinding: generation.tenant_domain_binding,
          systemContentKey: generation.system_content_key,
          roleBindingFingerprint: generation.role_binding_fingerprint,
        }
        const update = {
          status: 'QUARANTINED',
          quarantined_at: quarantinedAt,
          lease_token: null,
          lease_expires_at: null,
        }
        if (generation.lease_token !== null) {
          const nextFence = normalizeFence(generation.lease_fence) + 1
          if (!Number.isSafeInteger(nextFence)) {
            failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
          }
          update.lease_fence = nextFence
        }
        let where
        if (lease === null) {
          where = Object.assign({}, generationWhere(scope, generation.generation_id), {
            status: generation.status,
            lease_token: generation.lease_token,
            lease_fence: generation.lease_fence,
            lease_expires_at: generation.lease_expires_at,
          })
        } else {
          where = leaseWhere(generation, lease)
        }
        const updated = firstRow(await scopedDb.updateRow(
          GENERATION_TABLE,
          update,
          where,
        ))
        if (updated === null) return null
        const inserted = firstRow(await scopedDb.insertOne(AUDIT_TABLE, audit))
        if (inserted === null) return null
        return updated
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function quarantineGeneration(
      generation,
      quarantinedAt,
      audit,
      lease = null,
    ) {
      try {
        return await scopedDb.transaction(async (trx) => (
          build(trx).transitionToQuarantined(
            generation,
            quarantinedAt,
            audit,
            lease,
          )
        ))
      } catch (error) {
        if (isTrustedSealedExportError(error)) return Promise.reject(error)
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function readPointer(pointerId) {
      try {
        return await scopedDb.selectOne(ACTIVE_POINTER_TABLE, { pointer_id: pointerId })
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function insertPointer(row) {
      try {
        return firstRow(await scopedDb.insertOne(ACTIVE_POINTER_TABLE, row))
      } catch {
        return null
      }
    }

    async function updatePointer(pointerId, expectedGenerationId, expectedVersion, set) {
      try {
        return firstRow(await scopedDb.updateRow(
          ACTIVE_POINTER_TABLE,
          set,
          {
            pointer_id: pointerId,
            active_generation_id: expectedGenerationId,
            pointer_version: expectedVersion,
          },
        ))
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    async function activateGeneration(generation, activatedAt, audit) {
      try {
        const updated = firstRow(await scopedDb.updateRow(
          GENERATION_TABLE,
          {
            status: 'ACTIVE',
            activated_at: activatedAt,
          },
          Object.assign({}, generationWhere({
            tenantId: generation.tenant_id,
            workspaceId: generation.workspace_id,
            tenantDomainBinding: generation.tenant_domain_binding,
            systemContentKey: generation.system_content_key,
            roleBindingFingerprint: generation.role_binding_fingerprint,
          }, generation.generation_id), {
            status: 'VERIFIED',
            applied_row_count: generation.applied_row_count,
            applied_rowset_digest: generation.applied_rowset_digest,
          }),
        ))
        if (updated === null) return null
        const inserted = firstRow(await scopedDb.insertOne(AUDIT_TABLE, audit))
        if (inserted === null) return null
        return updated
      } catch {
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    }

    return Object.freeze({
      readGeneration,
      readGenerationByManifest,
      createGeneration,
      acquireLease,
      resetStaging,
      appendStagingRows,
      listStagingRows,
      listGenerationRows,
      countStagingRows,
      countGenerationRows,
      sealGeneration,
      appendGenerationRows,
      markVerified,
      readAuthorityState,
      readAuthorityStateForUpdate,
      transitionToQuarantined,
      quarantineGeneration,
      readPointer,
      insertPointer,
      updatePointer,
      activateGeneration,
    })
  }

  const store = Object.assign({}, build(db), {
    async transaction(callback) {
      if (typeof callback !== 'function') failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      try {
        return await db.transaction(async (trx) => callback(build(trx)))
      } catch (error) {
        if (isTrustedSealedExportError(error)) return Promise.reject(error)
        failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      }
    },
  })
  Object.freeze(store)
  TRUSTED_STORES.add(store)
  return store
}

function isTrustedGenerationStore(value) {
  return value !== null && typeof value === 'object' && TRUSTED_STORES.has(value)
}

module.exports = Object.freeze({
  createGenerationStore,
  isTrustedGenerationStore,
  GENERATION_TABLE,
  STAGING_ROW_TABLE,
  GENERATION_ROW_TABLE,
  AUTHORITY_STATE_TABLE,
  ACTIVE_POINTER_TABLE,
  AUDIT_TABLE,
})
