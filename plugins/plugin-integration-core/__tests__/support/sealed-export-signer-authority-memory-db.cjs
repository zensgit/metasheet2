'use strict'

const { failSealedExport } = require('../../lib/sealed-export/failure-vocabulary.cjs')
const {
  AUTHORITY_STATE_TABLE,
  PUBLIC_KEY_TABLE,
  workspaceScopeKey,
} = require('../../lib/sealed-export/sealed-export-signer-authority-store.cjs')

function createMemorySignerAuthorityDb() {
  const publicKeys = new Map()
  const authorityStates = new Map()

  function publicKeyRowKey(row) {
    return [
      row.tenant_id,
      row.workspace_scope_key,
      row.tenant_domain_binding,
      row.system_content_key,
      row.role_binding_fingerprint,
      row.signer_key_id,
    ].join('\u0000')
  }

  function authorityRowKey(row) {
    return [
      row.tenant_id,
      row.workspace_scope_key || workspaceScopeKey(row.workspace_id),
      row.tenant_domain_binding,
      row.system_content_key,
      row.role_binding_fingerprint,
    ].join('\u0000')
  }

  function matchesWhere(row, where) {
    for (const col of Object.keys(where)) {
      const expected = where[col]
      const actual = row[col]
      if (expected === null || expected === undefined) {
        if (actual !== null && actual !== undefined) return false
        continue
      }
      if (actual !== expected) return false
    }
    return true
  }

  return Object.freeze({
    async select(table, query) {
      const map =
        table === PUBLIC_KEY_TABLE
          ? publicKeys
          : table === AUTHORITY_STATE_TABLE
            ? authorityStates
            : null
      if (map === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      const where = query && query.where ? query.where : {}
      const out = []
      for (const row of map.values()) {
        if (matchesWhere(row, where)) {
          out.push({
            ...row,
            ...(row.public_key_spki_der
              ? { public_key_spki_der: Buffer.from(row.public_key_spki_der) }
              : {}),
          })
        }
      }
      return out
    },
    async selectOne(table, where) {
      const map =
        table === PUBLIC_KEY_TABLE
          ? publicKeys
          : table === AUTHORITY_STATE_TABLE
            ? authorityStates
            : null
      if (map === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      for (const row of map.values()) {
        if (matchesWhere(row, where)) {
          return {
            ...row,
            ...(row.public_key_spki_der
              ? { public_key_spki_der: Buffer.from(row.public_key_spki_der) }
              : {}),
          }
        }
      }
      return null
    },
    async insertOne(table, row) {
      if (table === PUBLIC_KEY_TABLE) {
        const normalized = {
          ...row,
          workspace_scope_key:
            typeof row.workspace_scope_key === 'string'
              ? row.workspace_scope_key
              : workspaceScopeKey(row.workspace_id),
          public_key_spki_der: Buffer.from(row.public_key_spki_der),
        }
        const key = publicKeyRowKey(normalized)
        if (publicKeys.has(key)) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
        publicKeys.set(key, normalized)
        return normalized
      }
      if (table === AUTHORITY_STATE_TABLE) {
        const normalized = {
          ...row,
          workspace_scope_key:
            typeof row.workspace_scope_key === 'string'
              ? row.workspace_scope_key
              : workspaceScopeKey(row.workspace_id),
        }
        const key = authorityRowKey(normalized)
        if (authorityStates.has(key)) {
          failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
        }
        authorityStates.set(key, normalized)
        return normalized
      }
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    },
    async updateRow(table, where, patch) {
      const map =
        table === PUBLIC_KEY_TABLE
          ? publicKeys
          : table === AUTHORITY_STATE_TABLE
            ? authorityStates
            : null
      if (map === null) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
      for (const [key, row] of map.entries()) {
        if (matchesWhere(row, where)) {
          const next = {
            ...row,
            ...patch,
            ...(row.public_key_spki_der
              ? {
                  public_key_spki_der: Buffer.from(
                    patch.public_key_spki_der || row.public_key_spki_der,
                  ),
                }
              : {}),
          }
          map.set(key, next)
          return [next]
        }
      }
      return []
    },
  })
}

module.exports = Object.freeze({
  createMemorySignerAuthorityDb,
})
