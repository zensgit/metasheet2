'use strict'

// Sealed-export S5 — public-key material + 069 lifecycle access (issue #4690).
//
// LATENT.
//
// Single lifecycle truth: integration_sealed_export_authority_state (migration
// 069) owns signer_key_id / signer_status / signer_expires_at. S4
// generation-kernel and S5 sign/verify both consult that row.
//
// integration_sealed_export_signer_public_keys (migration 070) stores ONLY
// public SPKI verification material keyed to the same authority scope +
// signer_key_id. No status/expiry columns. No private keys.

const crypto = require('node:crypto')

const digests = require('./digests.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')

const PUBLIC_KEY_TABLE = 'integration_sealed_export_signer_public_keys'
const AUTHORITY_STATE_TABLE = 'integration_sealed_export_authority_state'
const SIGNATURE_ALGORITHM = 'ED25519'

const SCOPE_FIELDS = Object.freeze([
  'roleBindingFingerprint',
  'systemContentKey',
  'tenantDomainBinding',
  'tenantId',
  'workspaceId',
])

const PUBLIC_ENROLL_FIELDS = Object.freeze(['publicKey', 'signerKeyId'])

function isStrictObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ownDataValue(object, field) {
  const descriptor = Object.getOwnPropertyDescriptor(object, field)
  if (
    !descriptor ||
    descriptor.get ||
    descriptor.set ||
    !descriptor.enumerable
  ) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return descriptor.value
}

function hasExactKeys(object, expectedKeys) {
  if (!isStrictObject(object)) return false
  const actual = Object.keys(object).sort()
  const expected = [...expectedKeys].sort()
  return !(
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  )
}

function isIdentityToken(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function requiredToken(value) {
  if (!isIdentityToken(value)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return value
}

function workspaceScopeKey(workspaceId) {
  if (workspaceId === null || workspaceId === undefined) return ''
  if (!isIdentityToken(workspaceId)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return workspaceId
}

function normalizeScope(raw) {
  if (!hasExactKeys(raw, SCOPE_FIELDS)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const tenantId = requiredToken(ownDataValue(raw, 'tenantId'))
  const systemContentKey = requiredToken(ownDataValue(raw, 'systemContentKey'))
  const tenantDomainBinding = requiredToken(
    ownDataValue(raw, 'tenantDomainBinding'),
  )
  const roleBindingFingerprint = requiredToken(
    ownDataValue(raw, 'roleBindingFingerprint'),
  )
  const workspaceId = ownDataValue(raw, 'workspaceId')
  if (workspaceId !== null && !isIdentityToken(workspaceId)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return Object.freeze({
    tenantId,
    workspaceId,
    workspaceScopeKey: workspaceScopeKey(workspaceId),
    tenantDomainBinding,
    systemContentKey,
    roleBindingFingerprint,
  })
}

function scopeWhere(scope) {
  return {
    tenant_id: scope.tenantId,
    workspace_id: scope.workspaceId,
    tenant_domain_binding: scope.tenantDomainBinding,
    system_content_key: scope.systemContentKey,
    role_binding_fingerprint: scope.roleBindingFingerprint,
  }
}

function normalizePublicKey(value) {
  let key
  try {
    key = value && value.type === 'public' ? value : crypto.createPublicKey(value)
  } catch {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return key
}

function exportPublicSpkiDer(publicKey) {
  let der
  try {
    der = publicKey.export({ format: 'der', type: 'spki' })
  } catch {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  if (!Buffer.isBuffer(der) || der.length === 0 || der.length > 4096) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return der
}

function deriveSignerKeyIdFromDer(der) {
  const digest = digests.digestBytes(der)
  if (!digest.ok) failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  return digest.digest
}

function normalizeStatus(value) {
  if (value !== 'ACTIVE' && value !== 'EXPIRED' && value !== 'REVOKED') {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return value
}

function parseInstantMs(value) {
  if (typeof value !== 'string' || value.length === 0) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return ms
}

function normalizePublicEnrollment(raw) {
  if (!hasExactKeys(raw, PUBLIC_ENROLL_FIELDS)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  // The exact two-field shape excludes lifecycle and private material.
  const signerKeyId = requiredToken(ownDataValue(raw, 'signerKeyId'))
  if (!digests.isLowerHexDigest(signerKeyId) || signerKeyId.length !== 64) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const publicKey = normalizePublicKey(ownDataValue(raw, 'publicKey'))
  const publicKeySpkiDer = exportPublicSpkiDer(publicKey)
  const derivedId = deriveSignerKeyIdFromDer(publicKeySpkiDer)
  if (derivedId !== signerKeyId) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return Object.freeze({
    publicKey,
    publicKeySpkiDer,
    publicKeySpkiSha256: derivedId,
    signerKeyId,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
  })
}

function rowToPublicRecord(row, expectedScope) {
  if (!isStrictObject(row)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  // Refuse rows that still carry lifecycle columns (old dual-write shape).
  if (
    Object.prototype.hasOwnProperty.call(row, 'status') ||
    Object.prototype.hasOwnProperty.call(row, 'expires_at')
  ) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const signerKeyId = row.signer_key_id
  if (row.signature_algorithm !== SIGNATURE_ALGORITHM) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const derRaw = row.public_key_spki_der
  const der = Buffer.isBuffer(derRaw)
    ? derRaw
    : derRaw instanceof Uint8Array
      ? Buffer.from(derRaw)
      : null
  if (der === null) failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  let publicKey
  try {
    publicKey = crypto.createPublicKey({
      key: der,
      format: 'der',
      type: 'spki',
    })
  } catch {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const derived = deriveSignerKeyIdFromDer(der)
  if (
    derived !== signerKeyId ||
    derived !== row.public_key_spki_sha256 ||
    !digests.isLowerHexDigest(signerKeyId)
  ) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const workspaceId =
    row.workspace_id === undefined || row.workspace_id === ''
      ? null
      : row.workspace_id
  const rowScope = normalizeScope({
    roleBindingFingerprint: row.role_binding_fingerprint,
    systemContentKey: row.system_content_key,
    tenantDomainBinding: row.tenant_domain_binding,
    tenantId: row.tenant_id,
    workspaceId,
  })
  for (const field of SCOPE_FIELDS) {
    if (rowScope[field] !== expectedScope[field]) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
  }
  return Object.freeze({
    publicKey,
    publicKeySpkiDer: Buffer.from(der),
    publicKeySpkiSha256: derived,
    roleBindingFingerprint: row.role_binding_fingerprint,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerKeyId,
    systemContentKey: row.system_content_key,
    tenantDomainBinding: row.tenant_domain_binding,
    tenantId: row.tenant_id,
    workspaceId,
    workspaceScopeKey:
      typeof row.workspace_scope_key === 'string'
        ? row.workspace_scope_key
        : workspaceScopeKey(workspaceId),
  })
}

function instantText(value) {
  if (!(value instanceof Date)) return value
  if (!Number.isFinite(value.getTime())) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return value.toISOString()
}

function rowToAuthorityState(row, expectedScope) {
  if (!isStrictObject(row)) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  const workspaceId =
    row.workspace_id === undefined || row.workspace_id === ''
      ? null
      : row.workspace_id
  const rowScope = normalizeScope({
    roleBindingFingerprint: row.role_binding_fingerprint,
    systemContentKey: row.system_content_key,
    tenantDomainBinding: row.tenant_domain_binding,
    tenantId: row.tenant_id,
    workspaceId,
  })
  for (const field of SCOPE_FIELDS) {
    if (rowScope[field] !== expectedScope[field]) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
  }
  if (
    typeof row.binding_current !== 'boolean' ||
    typeof row.qualification_current !== 'boolean'
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const signerKeyId = requiredToken(row.signer_key_id)
  const qualificationDigest = row.qualification_digest
  if (
    !digests.isLowerHexDigest(signerKeyId) ||
    signerKeyId.length !== 64 ||
    !digests.isLowerHexDigest(qualificationDigest) ||
    qualificationDigest.length !== 64
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const signerExpiresAt = instantText(row.signer_expires_at)
  const bindingExpiresAt = instantText(row.binding_expires_at)
  const qualificationExpiresAt = instantText(row.qualification_expires_at)
  return Object.freeze({
    bindingCurrent: row.binding_current,
    bindingExpiresAt,
    bindingExpiresAtMs: parseInstantMs(bindingExpiresAt),
    qualificationCurrent: row.qualification_current,
    qualificationDigest,
    qualificationExpiresAt,
    qualificationExpiresAtMs: parseInstantMs(qualificationExpiresAt),
    roleBindingFingerprint: rowScope.roleBindingFingerprint,
    signerExpiresAt,
    signerExpiresAtMs: parseInstantMs(signerExpiresAt),
    signerKeyId,
    signerStatus: normalizeStatus(row.signer_status),
    systemContentKey: rowScope.systemContentKey,
    tenantDomainBinding: rowScope.tenantDomainBinding,
    tenantId: rowScope.tenantId,
    workspaceId: rowScope.workspaceId,
  })
}

// Unified store: public material (070) + lifecycle (069). Sign/verify must
// join them; lifecycle never lives on the public-key table.
function createSignerAuthorityStore({ db, clock = Date.now } = {}) {
  const required = ['select', 'selectOne', 'insertOne']
  if (!db || required.some((name) => typeof db[name] !== 'function')) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (typeof clock !== 'function') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

  async function getPublicKey(rawScope, signerKeyId) {
    const scope = normalizeScope(rawScope)
    if (!isIdentityToken(signerKeyId)) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    let row
    try {
      row = await db.selectOne(PUBLIC_KEY_TABLE, {
        ...scopeWhere(scope),
        signer_key_id: signerKeyId,
      })
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (row === null || row === undefined) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    return rowToPublicRecord(row, scope)
  }

  async function enrollPublicKey(rawScope, rawEnrollment) {
    const scope = normalizeScope(rawScope)
    const enrollment = normalizePublicEnrollment(rawEnrollment)
    // Omit workspace_scope_key: PG GENERATED ALWAYS AS (COALESCE(workspace_id,'')).
    const row = {
      tenant_id: scope.tenantId,
      workspace_id: scope.workspaceId,
      tenant_domain_binding: scope.tenantDomainBinding,
      system_content_key: scope.systemContentKey,
      role_binding_fingerprint: scope.roleBindingFingerprint,
      signer_key_id: enrollment.signerKeyId,
      signature_algorithm: enrollment.signatureAlgorithm,
      public_key_spki_der: enrollment.publicKeySpkiDer,
      public_key_spki_sha256: enrollment.publicKeySpkiSha256,
    }
    try {
      await db.insertOne(PUBLIC_KEY_TABLE, row)
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    return Object.freeze({
      publicKey: enrollment.publicKey,
      roleBindingFingerprint: scope.roleBindingFingerprint,
      signatureAlgorithm: enrollment.signatureAlgorithm,
      signerKeyId: enrollment.signerKeyId,
      systemContentKey: scope.systemContentKey,
      tenantDomainBinding: scope.tenantDomainBinding,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      workspaceScopeKey: scope.workspaceScopeKey,
    })
  }

  // 069 authority_state is the only lifecycle truth. S5 is read-only here:
  // provisioning and rotation are separate first-party operations.
  async function getAuthorityState(rawScope) {
    const scope = normalizeScope(rawScope)
    let row
    try {
      row = await db.selectOne(AUTHORITY_STATE_TABLE, scopeWhere(scope))
    } catch {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (row === null || row === undefined) {
      failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
    }
    return rowToAuthorityState(row, scope)
  }

  async function resolveAuthority(rawScope, expectedQualificationDigest) {
    normalizeScope(rawScope)
    if (
      !digests.isLowerHexDigest(expectedQualificationDigest) ||
      expectedQualificationDigest.length !== 64
    ) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    const authority = await getAuthorityState(rawScope)
    const nowMs = clock()
    if (!Number.isFinite(nowMs)) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    if (authority.signerStatus === 'REVOKED') {
      failSealedExport('SEALED_EXPORT_SIGNER_REVOKED')
    }
    if (
      authority.signerStatus === 'EXPIRED' ||
      authority.signerStatus !== 'ACTIVE' ||
      nowMs >= authority.signerExpiresAtMs
    ) {
      failSealedExport('SEALED_EXPORT_SIGNER_EXPIRED')
    }
    if (
      authority.bindingCurrent !== true ||
      nowMs >= authority.bindingExpiresAtMs ||
      authority.qualificationCurrent !== true ||
      nowMs >= authority.qualificationExpiresAtMs ||
      !digests.constantTimeEqualDigest(
        authority.qualificationDigest,
        expectedQualificationDigest,
      )
    ) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    const publicRecord = await getPublicKey(
      rawScope,
      authority.signerKeyId,
    )
    return Object.freeze({
      bindingExpiresAt: authority.bindingExpiresAt,
      publicKey: publicRecord.publicKey,
      qualificationDigest: authority.qualificationDigest,
      qualificationExpiresAt: authority.qualificationExpiresAt,
      roleBindingFingerprint: authority.roleBindingFingerprint,
      signerExpiresAt: authority.signerExpiresAt,
      signerKeyId: authority.signerKeyId,
      signerStatus: 'ACTIVE',
      systemContentKey: authority.systemContentKey,
      tenantDomainBinding: authority.tenantDomainBinding,
      tenantId: authority.tenantId,
      workspaceId: authority.workspaceId,
    })
  }

  return Object.freeze({
    enrollPublicKey,
    getAuthorityState,
    getPublicKey,
    resolveAuthority,
  })
}

module.exports = Object.freeze({
  SIGNATURE_ALGORITHM,
  PUBLIC_KEY_TABLE,
  AUTHORITY_STATE_TABLE,
  // Back-compat alias for tests that still import TABLE.
  TABLE: PUBLIC_KEY_TABLE,
  createSignerAuthorityStore,
  workspaceScopeKey,
  deriveSignerKeyIdFromDer,
})
