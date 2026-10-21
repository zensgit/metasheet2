'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  deriveSignerKeyId,
} = require('./sealed-export-signer-authority.cjs')
const canonicalCodec = require('./canonical-json.cjs')

const FEATURE_FLAG =
  'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED'
const ENV = Object.freeze({
  artifactRoot:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ARTIFACT_ROOT',
  evidenceKeyFile:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_EVIDENCE_KEY_FILE',
  identityKeyFile:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_IDENTITY_KEY_FILE',
  qualificationKeyFile:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_FILE',
  qualificationKeyId:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_QUALIFICATION_KEY_ID',
  provisioningDatabaseRole:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_DATABASE_ROLE',
  provisioningDatabaseUrl:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_DATABASE_URL',
  provisioningSpecFile:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_PROVISIONING_SPEC_FILE',
  runtimeDatabaseRole:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_ROLE',
  runtimeDatabaseUrl:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_RUNTIME_DATABASE_URL',
  signerPrivateKeyFile:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_SIGNER_PRIVATE_KEY_FILE',
  win32ArtifactAclAttested:
    'MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED',
})
// Exact literal. Deliberately NOT trimmed and NOT lower-cased: an attestation is an
// operator act, so 'TRUE', ' true ' and '1' are refusals, not near-misses.
const WIN32_ARTIFACT_ACL_ATTESTATION = 'true'
const PROVISIONING_SPEC_FIELDS = Object.freeze([
  'binding',
  'externalSystem',
])
const PROVISIONING_BINDING_FIELDS = Object.freeze([
  'approvedConfigVersionId',
  'bindingExpiresAt',
  'bindingId',
  'bindingVersion',
  'externalSystemId',
  'signerExpiresAt',
  'tableRef',
  'tenantId',
  'workspaceId',
])
const EXTERNAL_SYSTEM_FIELDS = Object.freeze([
  'config',
  'credentials',
  'id',
  'kind',
  'role',
  'status',
  'tenantId',
  'workspaceId',
])

function requiredText(value, maxLength = 4096) {
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

function readRegularFile(fileName, maximumBytes) {
  const absolute = path.resolve(requiredText(fileName))
  let stat
  let bytes
  try {
    stat = fs.statSync(absolute)
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) {
      failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
    }
    bytes = fs.readFileSync(absolute)
  } catch {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return Buffer.from(bytes)
}

function readSymmetricKey(fileName) {
  const bytes = readRegularFile(fileName, 128)
  if (bytes.byteLength < 32 || bytes.byteLength > 128) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return bytes
}

function readSignerMaterial(fileName) {
  const pem = readRegularFile(fileName, 16 * 1024)
  let privateKey
  let publicKey
  try {
    privateKey = crypto.createPrivateKey(pem)
    publicKey = crypto.createPublicKey(privateKey)
  } catch {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (
    privateKey.type !== 'private'
    || privateKey.asymmetricKeyType !== 'ed25519'
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return Object.freeze({
    privateKey,
    signerKeyId: deriveSignerKeyId(publicKey),
  })
}

function featureEnabled(env) {
  return String(env[FEATURE_FLAG] ?? '').trim().toLowerCase() === 'true'
}

function exactKeys(value, fields) {
  if (!canonicalCodec.__internals.isStrictPlainObject(value)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const actual = Object.keys(value).sort()
  const expected = [...fields].sort()
  if (
    actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return value
}

function readProvisioningSpec(fileName) {
  const bytes = readRegularFile(fileName, 64 * 1024)
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const owned = canonicalCodec.tryFreezeCanonical(parsed)
  if (!owned.ok) failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  const spec = exactKeys(owned.value, PROVISIONING_SPEC_FIELDS)
  exactKeys(spec.binding, PROVISIONING_BINDING_FIELDS)
  exactKeys(spec.externalSystem, EXTERNAL_SYSTEM_FIELDS)
  if (
    spec.binding.workspaceId !== null
    || spec.externalSystem.workspaceId !== null
  ) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return spec
}

// The sealed-export artifact tree asserts its confidentiality with POSIX modes:
// mkdir({ mode: 0o700 }) / chmod(0o700) on the artifact and staging directories and
// chmod(0o600) on every chunk and artifact file. On win32 those calls SUCCEED and
// then no-op — the mode reads back 0o666 — so the control the code claims is simply
// absent at runtime, and nothing in this package applies the NTFS equivalent
// (`icacls <root> /inheritance:r /grant:r "<svc>:(OI)(CI)F"`).
//
// This gate refuses to boot the S6-A runtime on win32 unless an operator has
// explicitly attested that the artifact root carries an equivalent NTFS ACL. The
// chmod calls stay exactly where they are: they remain the POSIX control, and this
// is the win32 substitute for the assurance they cannot give there.
//
// The refusal rides SEALED_EXPORT_PROFILE_UNCERTIFIED — the §10 reason for "this
// deployment is not certified to produce sealed exports" — because the §10 failure
// vocabulary was RATIFIED and frozen at exactly 30 tokens on 2026-07-27 and no
// reason may be added, removed or renamed without a fresh owner ruling. The specific
// unmet control is named in the details field instead, which IS an open surface.
function assertArtifactRootModeEnforceable(env, platform) {
  if (platform !== 'win32') return
  if (env[ENV.win32ArtifactAclAttested] !== WIN32_ARTIFACT_ACL_ATTESTATION) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED', {
      field: 'win32ArtifactAclAttested',
    })
  }
}

function loadStockPreparationRuntimeConfig({
  env = process.env,
  platform = process.platform,
} = {}) {
  if (!env || typeof env !== 'object') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (typeof platform !== 'string' || platform.length < 1) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (!featureEnabled(env)) {
    return Object.freeze({ enabled: false })
  }
  const artifactRoot = requiredText(env[ENV.artifactRoot])
  if (!path.isAbsolute(artifactRoot)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  assertArtifactRootModeEnforceable(env, platform)
  const privateSignerMaterial = readSignerMaterial(
    env[ENV.signerPrivateKeyFile],
  )
  return Object.freeze({
    artifactRoot: path.resolve(artifactRoot),
    enabled: true,
    evidenceKey: readSymmetricKey(env[ENV.evidenceKeyFile]),
    identityKey: readSymmetricKey(env[ENV.identityKeyFile]),
    privateSignerMaterials: Object.freeze([privateSignerMaterial]),
    qualificationKeyring: Object.freeze({
      keyId: requiredText(env[ENV.qualificationKeyId], 128),
      secret: readSymmetricKey(env[ENV.qualificationKeyFile]),
    }),
    runtimeDatabaseRole: requiredText(env[ENV.runtimeDatabaseRole], 128),
    runtimeDatabaseUrl: requiredText(env[ENV.runtimeDatabaseUrl]),
  })
}

function loadStockPreparationProvisioningConfig({
  env = process.env,
} = {}) {
  if (!env || typeof env !== 'object') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  const artifactRoot = requiredText(env[ENV.artifactRoot])
  if (!path.isAbsolute(artifactRoot)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  return Object.freeze({
    artifactRoot: path.resolve(artifactRoot),
    identityKey: readSymmetricKey(env[ENV.identityKeyFile]),
    privateSignerMaterial: readSignerMaterial(
      env[ENV.signerPrivateKeyFile],
    ),
    provisioningDatabaseRole:
      requiredText(env[ENV.provisioningDatabaseRole], 128),
    provisioningDatabaseUrl:
      requiredText(env[ENV.provisioningDatabaseUrl]),
    qualificationKeyring: Object.freeze({
      keyId: requiredText(env[ENV.qualificationKeyId], 128),
      secret: readSymmetricKey(env[ENV.qualificationKeyFile]),
    }),
    spec: readProvisioningSpec(env[ENV.provisioningSpecFile]),
  })
}

module.exports = Object.freeze({
  ENV,
  FEATURE_FLAG,
  WIN32_ARTIFACT_ACL_ATTESTATION,
  loadStockPreparationProvisioningConfig,
  loadStockPreparationRuntimeConfig,
})
