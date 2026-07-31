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
})
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
  return spec
}

function loadStockPreparationRuntimeConfig({
  env = process.env,
} = {}) {
  if (!env || typeof env !== 'object') {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
  if (!featureEnabled(env)) {
    return Object.freeze({ enabled: false })
  }
  const artifactRoot = requiredText(env[ENV.artifactRoot])
  if (!path.isAbsolute(artifactRoot)) {
    failSealedExport('SEALED_EXPORT_INTERNAL_ERROR')
  }
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
  loadStockPreparationProvisioningConfig,
  loadStockPreparationRuntimeConfig,
})
