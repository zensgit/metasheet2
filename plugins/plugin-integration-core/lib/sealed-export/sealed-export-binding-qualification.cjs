'use strict'

// Sealed-export S5 — pure qualification digest/MAC helpers (issue #4690).
//
// LATENT. No prober factory, no harness, no __internals, no trust minting.
// The product service owns a keyring-bound prober in its closure. A separate
// first-party activation path verifies candidates before recording their digest
// in 069; execute consumes that live 069 authority state.

const crypto = require('node:crypto')

const canonicalCodec = require('./canonical-json.cjs')
const digests = require('./digests.cjs')
const { failSealedExport } = require('./failure-vocabulary.cjs')
const {
  SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
  SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
  SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
  SQLSERVER_SEALED_SNAPSHOT_PROFILE,
} = require('./sqlserver-sealed-snapshot-profile.cjs')

const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
const ENVELOPE_SECRET_MIN_BYTES = 32
const ENVELOPE_KEY_FIELDS = Object.freeze(['keyId', 'secret'])
const MAC_INPUT_FIELDS = Object.freeze([
  'envelopeKey',
  'expiresAt',
  'qualificationDigest',
  'status',
])
const VERIFY_INPUT_FIELDS = Object.freeze([
  'envelopeKey',
  'expected',
  'now',
  'qualification',
])
const PROBE_INPUT_FIELDS = Object.freeze([
  'binding',
  'envelopeKey',
  'expiresAt',
  'probedAt',
])
const EXPECTED_BINDING_FIELDS = Object.freeze([
  'actionProfileVersion',
  'approvedConfigVersionId',
  'bindingVersion',
  'canonicalObjectVersion',
  'configContentKey',
  'objectKey',
  'roleBindingFingerprint',
  'systemContentKey',
  'tenantDomainBinding',
])
const QUALIFICATION_FIELDS = Object.freeze([
  'actionProfileVersion',
  'approvedConfigVersionId',
  'bindingVersion',
  'canonicalObjectVersion',
  'configContentKey',
  'envelopeKeyId',
  'envelopeMac',
  'evidence',
  'expiresAt',
  'objectKey',
  'probedAt',
  'qualificationDigest',
  'roleBindingFingerprint',
  'status',
  'systemContentKey',
  'tenantDomainBinding',
])

function isStrictObject(value) {
  return canonicalCodec.__internals.isStrictPlainObject(value)
}

function ownDataValue(object, field) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, field)
  } catch {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  if (
    !descriptor ||
    descriptor.get ||
    descriptor.set ||
    !descriptor.enumerable
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return descriptor.value
}

function hasExactKeys(object, expectedKeys) {
  if (!isStrictObject(object)) return false
  let actual
  try {
    actual = Object.keys(object).sort()
  } catch {
    return false
  }
  const expected = [...expectedKeys].sort()
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  )
}

function ownCanonicalObject(value, expectedKeys = null) {
  if (
    !isStrictObject(value) ||
    (expectedKeys !== null && !hasExactKeys(value, expectedKeys))
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const frozen = canonicalCodec.tryFreezeCanonical(value)
  if (!frozen.ok || !isStrictObject(frozen.value)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return frozen.value
}

function requiredToken(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const text = value.trim()
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
    }
  }
  return text
}

function requiredUtcInstant(value) {
  const text = requiredToken(value)
  const parsed = Date.parse(text)
  if (
    !ISO_UTC_SECONDS.test(text) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== text.replace(/Z$/, '.000Z')
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return text
}

function stableCanonical(value) {
  const result = canonicalCodec.tryCanonicalJson(value)
  if (!result.ok) failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  return result.text
}

function computeQualificationDigest(material) {
  return crypto
    .createHash('sha256')
    .update(stableCanonical(material), 'utf8')
    .digest('hex')
}

function normalizeEnvelopeKeyMaterial(envelopeKey) {
  if (!hasExactKeys(envelopeKey, ENVELOPE_KEY_FIELDS)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const keyId = requiredToken(ownDataValue(envelopeKey, 'keyId'))
  const secret = ownDataValue(envelopeKey, 'secret')
  const secretBytes = Buffer.isBuffer(secret)
    ? secret
    : secret instanceof Uint8Array
      ? Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)
      : null
  if (secretBytes === null || secretBytes.length < ENVELOPE_SECRET_MIN_BYTES) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return Object.freeze({ keyId, secret: Buffer.from(secretBytes) })
}

function computeEnvelopeMac(raw) {
  if (!hasExactKeys(raw, MAC_INPUT_FIELDS)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const envelopeKey = ownDataValue(raw, 'envelopeKey')
  const qualificationDigest = ownDataValue(raw, 'qualificationDigest')
  const status = ownDataValue(raw, 'status')
  const expiresAt = ownDataValue(raw, 'expiresAt')
  const key = normalizeEnvelopeKeyMaterial(envelopeKey)
  return crypto
    .createHmac('sha256', key.secret)
    .update(
      stableCanonical({
        expiresAt,
        keyId: key.keyId,
        qualificationDigest,
        status,
      }),
    )
    .digest('hex')
}

function sealedExportQualificationEvidence(binding) {
  binding = ownCanonicalObject(binding)
  const orderingKeyProof = binding.orderingKeyProof
  if (
    !orderingKeyProof ||
    typeof orderingKeyProof !== 'object' ||
    orderingKeyProof.kind !== 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER' ||
    orderingKeyProof.proven !== true ||
    orderingKeyProof.nullKeyRows !== 0 ||
    orderingKeyProof.duplicateKeyGroups !== 0
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return Object.freeze({
    acquisitionMode:
      SQLSERVER_SEALED_SNAPSHOT_PROFILE.certificate.acquisitionMode,
    actionId: SQLSERVER_SEALED_SNAPSHOT_ACTION_ID,
    connectorKind: SQLSERVER_SEALED_SNAPSHOT_PROFILE.connectorKind,
    continuationLifetime:
      SQLSERVER_SEALED_SNAPSHOT_PROFILE.certificate.continuationLifetime,
    expectedSourceSchemaFieldMapDigest:
      binding.expectedSourceSchemaFieldMapDigest,
    implementationVersion: SQLSERVER_SEALED_SNAPSHOT_IMPLEMENTATION_VERSION,
    orderingKeyProof: Object.freeze({
      duplicateKeyGroups: 0,
      fieldId: orderingKeyProof.fieldId,
      kind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
      nullKeyRows: 0,
      proven: true,
    }),
    profileId: SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID,
    queryObjectFilterBindingDigest: binding.queryObjectFilterBindingDigest,
    supportedCompletenessProofs: [
      ...SQLSERVER_SEALED_SNAPSHOT_PROFILE.certificate
        .supportedCompletenessProofs,
    ],
    supportedConsistencyProofs: [
      ...SQLSERVER_SEALED_SNAPSHOT_PROFILE.certificate
        .supportedConsistencyProofs,
    ],
    tenantDomainBinding: binding.tenantDomainBinding,
  })
}

// Pure verify: recomputes digest/MAC with the supplied key material. Does not
// mint trust. The product service only calls this with its closure-owned key.
function verifyQualificationWithKey(raw) {
  if (!hasExactKeys(raw, VERIFY_INPUT_FIELDS)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const qualification = ownCanonicalObject(
    ownDataValue(raw, 'qualification'),
    QUALIFICATION_FIELDS,
  )
  const expected = ownCanonicalObject(
    ownDataValue(raw, 'expected'),
    EXPECTED_BINDING_FIELDS,
  )
  const envelopeKey = ownDataValue(raw, 'envelopeKey')
  const now = ownDataValue(raw, 'now')
  if (qualification.status === 'revoked') {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', { state: 'REVOKED' })
  }
  if (qualification.status !== 'candidate') {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const expectedActionProfileVersion = requiredToken(
    expected.actionProfileVersion,
  )
  const expectedApprovedConfigVersionId = requiredToken(
    expected.approvedConfigVersionId,
  )
  const expectedBindingVersion = requiredToken(expected.bindingVersion)
  const expectedSystemContentKey = requiredToken(expected.systemContentKey)
  const expectedConfigContentKey = requiredToken(expected.configContentKey)
  const expectedObjectKey = requiredToken(expected.objectKey)
  const expectedRoleBindingFingerprint = requiredToken(
    expected.roleBindingFingerprint,
  )
  const expectedTenantDomainBinding = requiredToken(
    expected.tenantDomainBinding,
  )
  const expectedCanonicalObjectVersion = requiredToken(
    expected.canonicalObjectVersion,
  )
  if (qualification.actionProfileVersion !== expectedActionProfileVersion) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'actionProfileVersion',
    })
  }
  if (
    qualification.approvedConfigVersionId !== expectedApprovedConfigVersionId
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'approvedConfigVersionId',
    })
  }
  if (qualification.bindingVersion !== expectedBindingVersion) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'bindingVersion',
    })
  }
  if (qualification.systemContentKey !== expectedSystemContentKey) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'systemContentKey',
    })
  }
  if (qualification.configContentKey !== expectedConfigContentKey) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'configContentKey',
    })
  }
  if (qualification.objectKey !== expectedObjectKey) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  if (
    qualification.canonicalObjectVersion !== expectedCanonicalObjectVersion
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'canonicalObjectVersion',
    })
  }
  if (
    qualification.roleBindingFingerprint !== expectedRoleBindingFingerprint
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'roleBindingFingerprint',
    })
  }
  if (qualification.tenantDomainBinding !== expectedTenantDomainBinding) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'tenantDomainBinding',
    })
  }
  const nowText = requiredUtcInstant(now)
  const probedAt = requiredUtcInstant(qualification.probedAt)
  const expiresAt = requiredUtcInstant(qualification.expiresAt)
  if (
    Date.parse(probedAt) > Date.parse(nowText) ||
    Date.parse(nowText) >= Date.parse(expiresAt)
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', { state: 'EXPIRED' })
  }
  if (!isStrictObject(qualification.evidence)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const recomputedDigest = computeQualificationDigest({
    actionProfileVersion: qualification.actionProfileVersion,
    approvedConfigVersionId: qualification.approvedConfigVersionId,
    bindingVersion: qualification.bindingVersion,
    canonicalObjectVersion: qualification.canonicalObjectVersion,
    configContentKey: qualification.configContentKey,
    evidence: qualification.evidence,
    objectKey: qualification.objectKey,
    probedAt,
    roleBindingFingerprint: qualification.roleBindingFingerprint,
    systemContentKey: qualification.systemContentKey,
    tenantDomainBinding: qualification.tenantDomainBinding,
  })
  if (
    !digests.constantTimeEqualDigest(
      recomputedDigest,
      qualification.qualificationDigest,
    )
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED', {
      field: 'qualificationDigest',
    })
  }
  const ownedKey = normalizeEnvelopeKeyMaterial(envelopeKey)
  const expectedMac = computeEnvelopeMac({
    envelopeKey: ownedKey,
    qualificationDigest: qualification.qualificationDigest,
    status: qualification.status,
    expiresAt: qualification.expiresAt,
  })
  if (
    !digests.constantTimeEqualDigest(expectedMac, qualification.envelopeMac)
  ) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  if (qualification.envelopeKeyId !== ownedKey.keyId) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  return Object.freeze({
    verified: true,
    qualificationDigest: qualification.qualificationDigest,
    status: qualification.status,
  })
}

function probeQualificationWithKey(raw) {
  if (!hasExactKeys(raw, PROBE_INPUT_FIELDS)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const binding = ownCanonicalObject(ownDataValue(raw, 'binding'))
  const envelopeKey = ownDataValue(raw, 'envelopeKey')
  const probedAt = ownDataValue(raw, 'probedAt')
  const expiresAt = ownDataValue(raw, 'expiresAt')
  if (binding.actionProfileVersion !== SQLSERVER_SEALED_SNAPSHOT_PROFILE_ID) {
    failSealedExport('SEALED_EXPORT_PROFILE_UNCERTIFIED')
  }
  const ownedKey = normalizeEnvelopeKeyMaterial(envelopeKey)
  const probedAtText = requiredUtcInstant(probedAt)
  const expiresAtText = requiredUtcInstant(expiresAt)
  if (Date.parse(expiresAtText) <= Date.parse(probedAtText)) {
    failSealedExport('SEALED_EXPORT_BINDING_UNQUALIFIED')
  }
  const evidence = sealedExportQualificationEvidence(binding)
  const qualificationDigest = computeQualificationDigest({
    actionProfileVersion: binding.actionProfileVersion,
    approvedConfigVersionId: binding.approvedConfigVersionId,
    bindingVersion: binding.bindingVersion,
    canonicalObjectVersion: binding.canonicalObjectVersion,
    configContentKey: binding.configContentKey,
    evidence,
    objectKey: binding.objectKey,
    probedAt: probedAtText,
    roleBindingFingerprint: binding.roleBindingFingerprint,
    systemContentKey: binding.systemContentKey,
    tenantDomainBinding: binding.tenantDomainBinding,
  })
  const status = 'candidate'
  const envelopeMac = computeEnvelopeMac({
    envelopeKey: ownedKey,
    qualificationDigest,
    status,
    expiresAt: expiresAtText,
  })
  return Object.freeze({
    actionProfileVersion: binding.actionProfileVersion,
    approvedConfigVersionId: binding.approvedConfigVersionId,
    bindingVersion: binding.bindingVersion,
    canonicalObjectVersion: binding.canonicalObjectVersion,
    configContentKey: binding.configContentKey,
    envelopeKeyId: ownedKey.keyId,
    envelopeMac,
    evidence,
    expiresAt: expiresAtText,
    objectKey: binding.objectKey,
    probedAt: probedAtText,
    qualificationDigest,
    roleBindingFingerprint: binding.roleBindingFingerprint,
    status,
    systemContentKey: binding.systemContentKey,
    tenantDomainBinding: binding.tenantDomainBinding,
  })
}

module.exports = Object.freeze({
  computeQualificationDigest,
  computeEnvelopeMac,
  sealedExportQualificationEvidence,
  verifyQualificationWithKey,
  probeQualificationWithKey,
  ENVELOPE_SECRET_MIN_BYTES,
})
