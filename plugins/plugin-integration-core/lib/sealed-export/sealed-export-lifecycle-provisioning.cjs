'use strict'

const canonicalCodec = require('./canonical-json.cjs')
const digests = require('./digests.cjs')
const {
  failSealedExport,
  isTrustedSealedExportError,
} = require('./failure-vocabulary.cjs')
const {
  deriveSignerKeyId,
  normalizePublicKey,
} = require('./sealed-export-signer-authority.cjs')
const {
  AUTHORITY_STATE_TABLE,
  PUBLIC_KEY_TABLE,
} = require('./sealed-export-signer-authority-store.cjs')
const {
  BINDING_TABLE,
  OBJECT_KEY,
  RELATION_ID,
} = require('./stock-preparation-runtime-store.cjs')
const {
  CANONICAL_OBJECT_VERSION,
} = require('./stock-preparation-sqlserver-source-authority.cjs')
const {
  assertSafeSqlServerRelation,
} = require('./sqlserver-sealed-snapshot-action.cjs')

const SCOPE_FIELDS = Object.freeze([
  'roleBindingFingerprint',
  'systemContentKey',
  'tenantDomainBinding',
  'tenantId',
  'workspaceId',
])
const ENROLL_FIELDS = Object.freeze([
  'bindingExpiresAt',
  'publicKey',
  'qualificationDigest',
  'qualificationExpiresAt',
  'scope',
  'signerExpiresAt',
])
const TERMINAL_FIELDS = Object.freeze(['scope', 'status'])
const REFRESH_FIELDS = Object.freeze([
  'bindingExpiresAt',
  'qualificationDigest',
  'qualificationExpiresAt',
  'scope',
])
const INITIAL_PROVISION_FIELDS = Object.freeze(['authority', 'binding'])
const BINDING_FIELDS = Object.freeze([
  'approvedConfigVersionId',
  'bindingId',
  'bindingVersion',
  'canonicalObjectVersion',
  'configContentKey',
  'expiresAt',
  'externalSystemId',
  'objectKey',
  'relationId',
  'roleBindingFingerprint',
  'systemContentKey',
  'tableRef',
  'tenantDomainBinding',
  'tenantId',
  'workspaceId',
])
const TERMINAL_STATUSES = new Set(['EXPIRED', 'REVOKED'])
const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function ownDataValue(object, field) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, field)
  } catch {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  if (
    !descriptor
    || descriptor.get
    || descriptor.set
    || !descriptor.enumerable
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return descriptor.value
}

function exactObject(value, fields) {
  if (!canonicalCodec.__internals.isStrictPlainObject(value)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  let actual
  try {
    actual = Object.keys(value).sort()
  } catch {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return value
}

function requiredToken(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || value.trim() !== value
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
  }
  return value
}

function normalizeScope(raw) {
  const scope = exactObject(raw, SCOPE_FIELDS)
  const workspaceId = ownDataValue(scope, 'workspaceId')
  if (workspaceId !== null) requiredToken(workspaceId)
  return Object.freeze({
    tenantId: requiredToken(ownDataValue(scope, 'tenantId')),
    workspaceId,
    tenantDomainBinding: requiredToken(
      ownDataValue(scope, 'tenantDomainBinding'),
    ),
    systemContentKey: requiredToken(
      ownDataValue(scope, 'systemContentKey'),
    ),
    roleBindingFingerprint: requiredToken(
      ownDataValue(scope, 'roleBindingFingerprint'),
    ),
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

function requiredDigest(value) {
  if (
    typeof value !== 'string'
    || value.length !== 64
    || !digests.isLowerHexDigest(value)
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return value
}

function requiredFutureInstant(value, nowMs) {
  const text = requiredToken(value)
  const parsed = Date.parse(text)
  if (
    !ISO_UTC_SECONDS.test(text)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== text.replace(/Z$/, '.000Z')
    || parsed <= nowMs
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return Object.freeze({ ms: parsed, text })
}

function normalizeAuthorityInput(raw, nowMs) {
  const input = exactObject(raw, ENROLL_FIELDS)
  const signerExpiresAt = requiredFutureInstant(
    ownDataValue(input, 'signerExpiresAt'),
    nowMs,
  )
  const bindingExpiresAt = requiredFutureInstant(
    ownDataValue(input, 'bindingExpiresAt'),
    nowMs,
  )
  const qualificationExpiresAt = requiredFutureInstant(
    ownDataValue(input, 'qualificationExpiresAt'),
    nowMs,
  )
  if (
    bindingExpiresAt.ms > signerExpiresAt.ms
    || qualificationExpiresAt.ms > signerExpiresAt.ms
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const publicKey = normalizePublicKey(ownDataValue(input, 'publicKey'))
  return Object.freeze({
    bindingExpiresAt: bindingExpiresAt.text,
    publicKey,
    qualificationDigest: requiredDigest(
      ownDataValue(input, 'qualificationDigest'),
    ),
    qualificationExpiresAt: qualificationExpiresAt.text,
    scope: normalizeScope(ownDataValue(input, 'scope')),
    signerExpiresAt: signerExpiresAt.text,
    signerKeyId: deriveSignerKeyId(publicKey),
  })
}

function normalizeRefreshInput(raw, nowMs) {
  const input = exactObject(raw, REFRESH_FIELDS)
  return Object.freeze({
    bindingExpiresAt: requiredFutureInstant(
      ownDataValue(input, 'bindingExpiresAt'),
      nowMs,
    ).text,
    qualificationDigest: requiredDigest(
      ownDataValue(input, 'qualificationDigest'),
    ),
    qualificationExpiresAt: requiredFutureInstant(
      ownDataValue(input, 'qualificationExpiresAt'),
      nowMs,
    ).text,
    scope: normalizeScope(ownDataValue(input, 'scope')),
  })
}

function normalizeInitialBinding(raw, nowMs) {
  const input = exactObject(raw, BINDING_FIELDS)
  const workspaceId = ownDataValue(input, 'workspaceId')
  if (workspaceId !== null) requiredToken(workspaceId)
  if (
    ownDataValue(input, 'objectKey') !== OBJECT_KEY
    || ownDataValue(input, 'relationId') !== RELATION_ID
    || ownDataValue(input, 'canonicalObjectVersion')
      !== CANONICAL_OBJECT_VERSION
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const tableRef = requiredToken(ownDataValue(input, 'tableRef'))
  try {
    assertSafeSqlServerRelation(tableRef)
  } catch {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return Object.freeze({
    approvedConfigVersionId: requiredToken(
      ownDataValue(input, 'approvedConfigVersionId'),
    ),
    bindingId: requiredToken(ownDataValue(input, 'bindingId')),
    bindingVersion: requiredToken(ownDataValue(input, 'bindingVersion')),
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    configContentKey: requiredDigest(
      ownDataValue(input, 'configContentKey'),
    ),
    expiresAt: requiredFutureInstant(
      ownDataValue(input, 'expiresAt'),
      nowMs,
    ).text,
    externalSystemId: requiredToken(
      ownDataValue(input, 'externalSystemId'),
    ),
    objectKey: OBJECT_KEY,
    relationId: RELATION_ID,
    roleBindingFingerprint: requiredDigest(
      ownDataValue(input, 'roleBindingFingerprint'),
    ),
    systemContentKey: requiredDigest(
      ownDataValue(input, 'systemContentKey'),
    ),
    tableRef,
    tenantDomainBinding: requiredDigest(
      ownDataValue(input, 'tenantDomainBinding'),
    ),
    tenantId: requiredToken(ownDataValue(input, 'tenantId')),
    workspaceId,
  })
}

function bindingRow(binding) {
  return {
    approved_config_version_id: binding.approvedConfigVersionId,
    binding_id: binding.bindingId,
    binding_version: binding.bindingVersion,
    canonical_object_version: binding.canonicalObjectVersion,
    config_content_key: binding.configContentKey,
    expires_at: binding.expiresAt,
    external_system_id: binding.externalSystemId,
    object_key: binding.objectKey,
    relation_id: binding.relationId,
    role_binding_fingerprint: binding.roleBindingFingerprint,
    status: 'ACTIVE',
    system_content_key: binding.systemContentKey,
    table_ref: binding.tableRef,
    tenant_domain_binding: binding.tenantDomainBinding,
    tenant_id: binding.tenantId,
    workspace_id: binding.workspaceId,
  }
}

function initialProvisioningMatches(binding, authority, rows) {
  const expectedBinding = bindingRow(binding)
  const expectedAuthority = authorityRow(authority)
  const expectedPublicKey = publicKeyRow(authority)
  return (
    rows.binding
    && rows.authority
    && rows.publicKey
    && Object.entries(expectedBinding).every(([field, value]) =>
      field.endsWith('_at')
        ? Date.parse(rows.binding[field]) === Date.parse(value)
        : rows.binding[field] === value,
    )
    && Object.entries(expectedAuthority).every(([field, value]) =>
      field.endsWith('_at')
        ? Date.parse(rows.authority[field]) === Date.parse(value)
        : rows.authority[field] === value,
    )
    && Object.entries(expectedPublicKey).every(([field, value]) => {
      const observed = rows.publicKey[field]
      return Buffer.isBuffer(value)
        ? Buffer.isBuffer(observed) && observed.equals(value)
        : observed === value
    })
  )
}

function publicKeyRow(authority) {
  let der
  try {
    der = authority.publicKey.export({ format: 'der', type: 'spki' })
  } catch {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  if (!Buffer.isBuffer(der) || der.length < 1 || der.length > 4096) {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  return {
    ...scopeWhere(authority.scope),
    signer_key_id: authority.signerKeyId,
    signature_algorithm: 'ED25519',
    public_key_spki_der: Buffer.from(der),
    public_key_spki_sha256: authority.signerKeyId,
  }
}

function authorityRow(authority) {
  return {
    ...scopeWhere(authority.scope),
    signer_key_id: authority.signerKeyId,
    signer_status: 'ACTIVE',
    signer_expires_at: authority.signerExpiresAt,
    binding_current: true,
    binding_expires_at: authority.bindingExpiresAt,
    qualification_digest: authority.qualificationDigest,
    qualification_current: true,
    qualification_expires_at: authority.qualificationExpiresAt,
  }
}

function changedRow(result) {
  const rows = Array.isArray(result)
    ? result
    : result && Array.isArray(result.rows)
      ? result.rows
      : []
  if (rows.length !== 1) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  return rows[0]
}

function assertActiveRow(row, nowMs) {
  if (!row || typeof row !== 'object') {
    failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
  }
  if (row.signer_status === 'REVOKED') {
    failSealedExport('SEALED_EXPORT_SIGNER_REVOKED')
  }
  if (
    row.signer_status !== 'ACTIVE'
    || !Number.isFinite(Date.parse(row.signer_expires_at))
    || nowMs >= Date.parse(row.signer_expires_at)
  ) {
    failSealedExport('SEALED_EXPORT_SIGNER_EXPIRED')
  }
  return requiredDigest(row.signer_key_id)
}

function operationEvidence(operation, changed) {
  return Object.freeze({
    changed,
    externalWrite: false,
    operation,
    valuesFree: true,
  })
}

function createSealedExportLifecycleProvisioning({ db, clock = Date.now } = {}) {
  const required = [
    'insertOne',
    'selectOneForUpdate',
    'transaction',
    'updateRow',
  ]
  if (
    !db
    || required.some((name) => typeof db[name] !== 'function')
    || typeof clock !== 'function'
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }

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

  async function dbBoundary(action) {
    try {
      return await action()
    } catch (error) {
      if (isTrustedSealedExportError(error)) return Promise.reject(error)
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
  }

  async function enrollSigner(raw) {
    const authority = normalizeAuthorityInput(raw, nowMs())
    return dbBoundary(async () => {
      await db.transaction(async (trx) => {
        await trx.insertOne(PUBLIC_KEY_TABLE, publicKeyRow(authority))
        await trx.insertOne(AUTHORITY_STATE_TABLE, authorityRow(authority))
      })
      return operationEvidence('ENROLLED', true)
    })
  }

  async function provisionInitialStockPreparationBinding(raw) {
    const input = exactObject(raw, INITIAL_PROVISION_FIELDS)
    const instant = nowMs()
    const authority = normalizeAuthorityInput(
      ownDataValue(input, 'authority'),
      instant,
    )
    const binding = normalizeInitialBinding(
      ownDataValue(input, 'binding'),
      instant,
    )
    if (
      binding.tenantId !== authority.scope.tenantId
      || binding.workspaceId !== authority.scope.workspaceId
      || binding.tenantDomainBinding
        !== authority.scope.tenantDomainBinding
      || binding.systemContentKey !== authority.scope.systemContentKey
      || binding.roleBindingFingerprint
        !== authority.scope.roleBindingFingerprint
      || Date.parse(binding.expiresAt)
        > Date.parse(authority.bindingExpiresAt)
    ) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    return dbBoundary(async () => db.transaction(async (trx) => {
      const activeBinding = await trx.selectOneForUpdate(
        BINDING_TABLE,
        {
          tenant_id: binding.tenantId,
          workspace_id: binding.workspaceId,
          object_key: OBJECT_KEY,
          status: 'ACTIVE',
        },
      )
      const authorityWhere = scopeWhere(authority.scope)
      const existingAuthority = await trx.selectOneForUpdate(
        AUTHORITY_STATE_TABLE,
        authorityWhere,
      )
      const existingPublicKey = await trx.selectOneForUpdate(
        PUBLIC_KEY_TABLE,
        {
          ...authorityWhere,
          signer_key_id: authority.signerKeyId,
        },
      )
      if (activeBinding || existingAuthority || existingPublicKey) {
        if (initialProvisioningMatches(binding, authority, {
          authority: existingAuthority,
          binding: activeBinding,
          publicKey: existingPublicKey,
        })) {
          return operationEvidence('INITIAL_PROVISIONED', false)
        }
        failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
      }
      await trx.insertOne(BINDING_TABLE, bindingRow(binding))
      await trx.insertOne(PUBLIC_KEY_TABLE, publicKeyRow(authority))
      await trx.insertOne(AUTHORITY_STATE_TABLE, authorityRow(authority))
      return operationEvidence('INITIAL_PROVISIONED', true)
    }))
  }

  async function rotateSigner(raw) {
    const authority = normalizeAuthorityInput(raw, nowMs())
    return dbBoundary(async () => {
      await db.transaction(async (trx) => {
        const where = scopeWhere(authority.scope)
        const current = await trx.selectOneForUpdate(
          AUTHORITY_STATE_TABLE,
          where,
        )
        const oldSignerKeyId = assertActiveRow(current, nowMs())
        if (oldSignerKeyId === authority.signerKeyId) {
          failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
        }
        await trx.insertOne(PUBLIC_KEY_TABLE, publicKeyRow(authority))
        changedRow(await trx.updateRow(
          AUTHORITY_STATE_TABLE,
          {
            signer_status: 'REVOKED',
            binding_current: false,
            qualification_current: false,
          },
          { ...where, signer_key_id: oldSignerKeyId, signer_status: 'ACTIVE' },
        ))
        changedRow(await trx.updateRow(
          AUTHORITY_STATE_TABLE,
          authorityRow(authority),
          { ...where, signer_key_id: oldSignerKeyId, signer_status: 'REVOKED' },
        ))
      })
      return operationEvidence('ROTATED', true)
    })
  }

  async function setSignerTerminal(raw) {
    const input = exactObject(raw, TERMINAL_FIELDS)
    const scope = normalizeScope(ownDataValue(input, 'scope'))
    const status = ownDataValue(input, 'status')
    if (!TERMINAL_STATUSES.has(status)) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
    return dbBoundary(async () => {
      let changed = false
      await db.transaction(async (trx) => {
        const where = scopeWhere(scope)
        const current = await trx.selectOneForUpdate(
          AUTHORITY_STATE_TABLE,
          where,
        )
        if (!current || typeof current !== 'object') {
          failSealedExport('SEALED_EXPORT_SIGNER_UNENROLLED')
        }
        if (current.signer_status === status) return
        const signerKeyId = assertActiveRow(current, nowMs())
        changedRow(await trx.updateRow(
          AUTHORITY_STATE_TABLE,
          {
            signer_status: status,
            binding_current: false,
            qualification_current: false,
          },
          { ...where, signer_key_id: signerKeyId, signer_status: 'ACTIVE' },
        ))
        changed = true
      })
      return operationEvidence(status, changed)
    })
  }

  async function refreshBindingQualification(raw) {
    const now = nowMs()
    const input = normalizeRefreshInput(raw, now)
    return dbBoundary(async () => {
      await db.transaction(async (trx) => {
        const where = scopeWhere(input.scope)
        const current = await trx.selectOneForUpdate(
          AUTHORITY_STATE_TABLE,
          where,
        )
        const signerKeyId = assertActiveRow(current, now)
        const signerExpiresAt = Date.parse(current.signer_expires_at)
        if (
          Date.parse(input.bindingExpiresAt) > signerExpiresAt
          || Date.parse(input.qualificationExpiresAt) > signerExpiresAt
        ) {
          failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
        }
        changedRow(await trx.updateRow(
          AUTHORITY_STATE_TABLE,
          {
            binding_current: true,
            binding_expires_at: input.bindingExpiresAt,
            qualification_digest: input.qualificationDigest,
            qualification_current: true,
            qualification_expires_at: input.qualificationExpiresAt,
          },
          { ...where, signer_key_id: signerKeyId, signer_status: 'ACTIVE' },
        ))
      })
      return operationEvidence('QUALIFICATION_REFRESHED', true)
    })
  }

  return Object.freeze({
    enrollSigner,
    provisionInitialStockPreparationBinding,
    refreshBindingQualification,
    rotateSigner,
    setSignerTerminal,
  })
}

module.exports = Object.freeze({
  createSealedExportLifecycleProvisioning,
})
