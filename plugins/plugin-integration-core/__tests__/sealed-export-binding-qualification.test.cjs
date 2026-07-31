'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')

const {
  SealedExportError,
} = require('../lib/sealed-export/failure-vocabulary.cjs')
const {
  probeQualificationWithKey,
  verifyQualificationWithKey,
} = require('../lib/sealed-export/sealed-export-binding-qualification.cjs')
const {
  computeQueryBindingDigest,
  SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
} = require('../lib/sealed-export/sqlserver-sealed-snapshot-action.cjs')

function envelopeKey() {
  return {
    keyId: 's5-envelope-key-1',
    secret: crypto.randomBytes(32),
  }
}

function orderingProof(fieldId = 'rowId') {
  return Object.freeze({
    duplicateKeyGroups: 0,
    fieldId,
    kind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
    nullKeyRows: 0,
    proven: true,
  })
}

function binding(overrides = {}) {
  const objectKey = overrides.objectKey || 'orders.lines'
  const relationId = 'sqlserver.relation.rowid_payload.v1'
  const tableRef = overrides.tableRef || 'dbo.orders_lines'
  return {
    actionProfileVersion: 'sqlserver.sealed_snapshot.v1',
    approvedConfigVersionId: 's5-config-v1',
    bindingVersion: 's5-binding-v1',
    systemContentKey: 's5-system-content',
    configContentKey: 's5-config-content',
    objectKey,
    canonicalObjectVersion: 's5-object-v1',
    queryObjectFilterBindingDigest: computeQueryBindingDigest({
      objectKey,
      relationId,
      tableRef,
    }),
    expectedSourceSchemaFieldMapDigest: SEALED_EXPORT_S5_SOURCE_SCHEMA_DIGEST,
    tenantDomainBinding: 's5-tenant-domain',
    roleBindingFingerprint: 's5-role-binding',
    orderingKeyProof: orderingProof(),
    ...overrides,
  }
}

function expectedBinding(b, overrides = {}) {
  return {
    actionProfileVersion: b.actionProfileVersion,
    approvedConfigVersionId: b.approvedConfigVersionId,
    bindingVersion: b.bindingVersion,
    canonicalObjectVersion: b.canonicalObjectVersion,
    configContentKey: b.configContentKey,
    objectKey: b.objectKey,
    roleBindingFingerprint: b.roleBindingFingerprint,
    systemContentKey: b.systemContentKey,
    tenantDomainBinding: b.tenantDomainBinding,
    ...overrides,
  }
}

function expectReason(fn, reason) {
  let caught
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof SealedExportError)
  assert.equal(caught.reason, reason)
  return caught
}

function positiveProbeAndVerify() {
  const key = envelopeKey()
  const b = binding()
  const qualification = probeQualificationWithKey({
    binding: b,
    envelopeKey: key,
    probedAt: '2026-07-30T00:00:00Z',
    expiresAt: '2026-07-30T01:00:00Z',
  })
  assert.equal(qualification.evidence.orderingKeyProof.proven, true)
  const verified = verifyQualificationWithKey({
    qualification,
    expected: expectedBinding(b),
    envelopeKey: key,
    now: '2026-07-30T00:30:00Z',
  })
  assert.equal(verified.verified, true)
}

function missingOrderingProofFails() {
  expectReason(
    () =>
      probeQualificationWithKey({
        binding: binding({ orderingKeyProof: undefined }),
        envelopeKey: envelopeKey(),
        probedAt: '2026-07-30T00:00:00Z',
        expiresAt: '2026-07-30T01:00:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
  expectReason(
    () =>
      probeQualificationWithKey({
        binding: binding({
          orderingKeyProof: {
            kind: 'STABLE_UNIQUE_NON_NULL_TOTAL_ORDER',
            proven: true,
            nullKeyRows: 1,
            duplicateKeyGroups: 0,
            fieldId: 'rowId',
          },
        }),
        envelopeKey: envelopeKey(),
        probedAt: '2026-07-30T00:00:00Z',
        expiresAt: '2026-07-30T01:00:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
}

function crossBindingAndStaleFailClosed() {
  const key = envelopeKey()
  const b = binding()
  const qualification = probeQualificationWithKey({
    binding: b,
    envelopeKey: key,
    probedAt: '2026-07-30T00:00:00Z',
    expiresAt: '2026-07-30T01:00:00Z',
  })
  for (const mutation of [
    { systemContentKey: 'other-system' },
    { configContentKey: 'other-config' },
    { objectKey: 'other-object' },
    { canonicalObjectVersion: 'other-version' },
    { actionProfileVersion: 'sqlserver.other.v1' },
    { approvedConfigVersionId: 'other-config-version' },
    { bindingVersion: 'other-binding-version' },
    { roleBindingFingerprint: 'other-role-binding' },
    { tenantDomainBinding: 'other-tenant-domain' },
  ]) {
    expectReason(
      () =>
        verifyQualificationWithKey({
          qualification,
          expected: expectedBinding(b, mutation),
          envelopeKey: key,
          now: '2026-07-30T00:30:00Z',
        }),
      'SEALED_EXPORT_BINDING_UNQUALIFIED',
    )
  }
  expectReason(
    () =>
      verifyQualificationWithKey({
        qualification,
        expected: expectedBinding(b),
        envelopeKey: envelopeKey(),
        now: '2026-07-30T00:30:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
  expectReason(
    () =>
      verifyQualificationWithKey({
        qualification,
        expected: expectedBinding(b),
        envelopeKey: key,
        now: '2026-07-30T01:00:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
}

function hostileInputsAndProbeTimeFailClosed() {
  const key = envelopeKey()
  const b = binding()
  const qualification = probeQualificationWithKey({
    binding: b,
    envelopeKey: key,
    probedAt: '2026-07-30T00:00:00Z',
    expiresAt: '2026-07-30T01:00:00Z',
  })

  const rawEscape = new Error('RAW_FOREIGN_ESCAPE')
  const accessorQualification = { ...qualification }
  Object.defineProperty(accessorQualification, 'status', {
    enumerable: true,
    get() {
      throw rawEscape
    },
  })
  const accessorError = expectReason(
    () =>
      verifyQualificationWithKey({
        qualification: accessorQualification,
        expected: expectedBinding(b),
        envelopeKey: key,
        now: '2026-07-30T00:30:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
  assert.notEqual(accessorError, rawEscape)

  expectReason(
    () =>
      probeQualificationWithKey({
        binding: new Proxy(b, {}),
        envelopeKey: key,
        probedAt: '2026-07-30T00:00:00Z',
        expiresAt: '2026-07-30T01:00:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )

  const hostileKey = {}
  Object.defineProperties(hostileKey, {
    keyId: { enumerable: true, value: key.keyId },
    secret: {
      enumerable: true,
      get() {
        throw rawEscape
      },
    },
  })
  const keyError = expectReason(
    () =>
      verifyQualificationWithKey({
        qualification,
        expected: expectedBinding(b),
        envelopeKey: hostileKey,
        now: '2026-07-30T00:30:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
  assert.notEqual(keyError, rawEscape)

  expectReason(
    () =>
      verifyQualificationWithKey({
        qualification: { ...qualification, unexpected: true },
        expected: expectedBinding(b),
        envelopeKey: key,
        now: '2026-07-30T00:30:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
  expectReason(
    () =>
      verifyQualificationWithKey({
        qualification: {
          ...qualification,
          probedAt: '2026-07-30T00:00:01Z',
        },
        expected: expectedBinding(b),
        envelopeKey: key,
        now: '2026-07-30T00:30:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )

  const futureQualification = probeQualificationWithKey({
    binding: b,
    envelopeKey: key,
    probedAt: '2026-07-30T00:40:00Z',
    expiresAt: '2026-07-30T01:00:00Z',
  })
  expectReason(
    () =>
      verifyQualificationWithKey({
        qualification: futureQualification,
        expected: expectedBinding(b),
        envelopeKey: key,
        now: '2026-07-30T00:30:00Z',
      }),
    'SEALED_EXPORT_BINDING_UNQUALIFIED',
  )
}

function main() {
  positiveProbeAndVerify()
  missingOrderingProofFails()
  crossBindingAndStaleFailClosed()
  hostileInputsAndProbeTimeFailClosed()
  console.log('sealed-export-binding-qualification.test.cjs OK')
}

main()
