import { describe, expect, test } from 'vitest'

import {
  assertCanonicalNonnegativeDecimalString,
  assertLowercaseSha256Hex,
  assertPositiveDecimalString,
  assertRecoveryArchiveAttachmentAvailability,
  assertRecoveryArchiveAttachmentReferenceClass,
  assertRecoveryArchiveAttachmentReferenceState,
  assertRecoveryArchiveBuildStatus,
  assertRecoveryArchiveCoverageSourceKind,
  assertRecoveryArchiveCoverageStatus,
  assertRecoveryArchivePayloadState,
  assertRecoveryArchiveStagingObjectClass,
  assertRecoveryArchiveStagingObjectState,
  assertRecoveryArchiveV1SectionIntegrityProjection,
  isMultitableRecoveryArchiveEnabled,
  RECOVERY_ARCHIVE_ATTACHMENT_AVAILABILITY,
  RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_CLASSES,
  RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_STATES,
  RECOVERY_ARCHIVE_BUILD_STATUSES,
  RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS,
  RECOVERY_ARCHIVE_COVERAGE_STATUSES,
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_PAYLOAD_STATES,
  RECOVERY_ARCHIVE_STAGING_OBJECT_CLASSES,
  RECOVERY_ARCHIVE_STAGING_OBJECT_STATES,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  RecoveryArchiveContractError,
  type RecoveryArchiveSectionIntegrityProjection,
} from '../../src/multitable/recovery-archive-contract'

const SHA256 = 'a'.repeat(64)
const TWO_POW_53_PLUS_1 = '9007199254740993'

function projection(
  name: (typeof RECOVERY_ARCHIVE_V1_SECTION_NAMES)[number],
  rowCount = '0',
): RecoveryArchiveSectionIntegrityProjection {
  return { name, row_count: rowCount, plaintext_sha256: SHA256 }
}

function validProjections(): RecoveryArchiveSectionIntegrityProjection[] {
  return RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name) => projection(name))
}

function expectContractError(fn: () => void, code: string) {
  expect(fn).toThrow(RecoveryArchiveContractError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code, message: code })
  }
}

function assertClosedEnum(
  accepted: readonly string[],
  assertValue: (value: unknown) => void,
  code: string,
) {
  for (const value of accepted) expect(() => assertValue(value)).not.toThrow()
  expectContractError(() => assertValue(''), code)
  expectContractError(() => assertValue('unknown'), code)
  expectContractError(() => assertValue(accepted[0].toUpperCase()), code)
}

describe('Time Machine D2a recovery archive flag', () => {
  test('is exact-literal and case-sensitive: only true is on', () => {
    expect(isMultitableRecoveryArchiveEnabled({ MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true' })).toBe(true)
    for (const value of [undefined, 'false', 'TRUE', ' true ', 'true ', ' true']) {
      expect(isMultitableRecoveryArchiveEnabled({ MULTITABLE_RECOVERY_ARCHIVE_ENABLED: value })).toBe(false)
    }
  })
})

describe('Time Machine D2a closed contract values', () => {
  test('freezes format version and exact v1 section order', () => {
    expect(RECOVERY_ARCHIVE_FORMAT_VERSION).toBe(1)
    expect(RECOVERY_ARCHIVE_V1_SECTION_NAMES).toEqual([
      'schema',
      'records',
      'links',
      'field_value_tombstones',
      'link_tombstones',
      'auto_number',
      'attachments_index',
      'permission_evidence',
      'views_config',
      'coverage_index',
    ])
  })

  test('payload state is closed and case-sensitive', () => {
    assertClosedEnum(RECOVERY_ARCHIVE_PAYLOAD_STATES, assertRecoveryArchivePayloadState, 'RECOVERY_ARCHIVE_INVALID_PAYLOAD_STATE')
  })

  test('build status is closed and case-sensitive', () => {
    assertClosedEnum(RECOVERY_ARCHIVE_BUILD_STATUSES, assertRecoveryArchiveBuildStatus, 'RECOVERY_ARCHIVE_INVALID_BUILD_STATUS')
  })

  test('coverage status is closed and case-sensitive', () => {
    assertClosedEnum(RECOVERY_ARCHIVE_COVERAGE_STATUSES, assertRecoveryArchiveCoverageStatus, 'RECOVERY_ARCHIVE_INVALID_COVERAGE_STATUS')
  })

  test('pins the exact ordered coverage source-kind DB tokens', () => {
    expect(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS).toEqual([
      'record_revision',
      'marker',
      'section_revision',
      'config_revision',
      'field_tombstone',
      'link_tombstone',
      'checkpoint_baseline',
      'sealed_operation_endpoint',
      'snapshot_membership',
      'aggregate_membership',
    ])
  })

  test('coverage source kind is closed and case-sensitive', () => {
    assertClosedEnum(
      RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS,
      assertRecoveryArchiveCoverageSourceKind,
      'RECOVERY_ARCHIVE_INVALID_COVERAGE_SOURCE_KIND',
    )
  })

  test('pins exact attachment reference class, state, and availability tokens', () => {
    expect(RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_CLASSES).toEqual(['source', 'archive_object'])
    expect(RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_STATES).toEqual(['building', 'verified'])
    expect(RECOVERY_ARCHIVE_ATTACHMENT_AVAILABILITY).toEqual(['available', 'missing', 'mutable', 'drifted'])
  })

  test('attachment reference class is closed and case-sensitive', () => {
    assertClosedEnum(
      RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_CLASSES,
      assertRecoveryArchiveAttachmentReferenceClass,
      'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_REFERENCE_CLASS',
    )
    expectContractError(
      () => assertRecoveryArchiveAttachmentReferenceClass('source_building'),
      'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_REFERENCE_CLASS',
    )
    expectContractError(
      () => assertRecoveryArchiveAttachmentReferenceClass('archive_object_verified'),
      'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_REFERENCE_CLASS',
    )
  })

  test('attachment reference state is closed and case-sensitive', () => {
    assertClosedEnum(
      RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_STATES,
      assertRecoveryArchiveAttachmentReferenceState,
      'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_REFERENCE_STATE',
    )
  })

  test('attachment availability is closed and case-sensitive', () => {
    assertClosedEnum(
      RECOVERY_ARCHIVE_ATTACHMENT_AVAILABILITY,
      assertRecoveryArchiveAttachmentAvailability,
      'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_AVAILABILITY',
    )
    expectContractError(
      () => assertRecoveryArchiveAttachmentAvailability('hash_mismatch'),
      'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_AVAILABILITY',
    )
  })

  test('pins exact staging object class and lifecycle tokens', () => {
    expect(RECOVERY_ARCHIVE_STAGING_OBJECT_CLASSES).toEqual([
      'section',
      'attachment',
      'manifest',
    ])
    expect(RECOVERY_ARCHIVE_STAGING_OBJECT_STATES).toEqual([
      'pending',
      'sealed',
      'deleted',
      'absent',
    ])
    assertClosedEnum(
      RECOVERY_ARCHIVE_STAGING_OBJECT_CLASSES,
      assertRecoveryArchiveStagingObjectClass,
      'RECOVERY_ARCHIVE_INVALID_STAGING_OBJECT_CLASS',
    )
    assertClosedEnum(
      RECOVERY_ARCHIVE_STAGING_OBJECT_STATES,
      assertRecoveryArchiveStagingObjectState,
      'RECOVERY_ARCHIVE_INVALID_STAGING_OBJECT_STATE',
    )
  })
})

describe('Time Machine D2a decimal and hash assertions', () => {
  test('canonical nonnegative decimals preserve values above 2^53 as strings', () => {
    expect(() => assertCanonicalNonnegativeDecimalString('0')).not.toThrow()
    expect(() => assertCanonicalNonnegativeDecimalString(TWO_POW_53_PLUS_1)).not.toThrow()
    expectContractError(() => assertCanonicalNonnegativeDecimalString('00'), 'RECOVERY_ARCHIVE_INVALID_NONNEGATIVE_DECIMAL')
    expectContractError(() => assertCanonicalNonnegativeDecimalString('-1'), 'RECOVERY_ARCHIVE_INVALID_NONNEGATIVE_DECIMAL')
    expectContractError(() => assertCanonicalNonnegativeDecimalString('+1'), 'RECOVERY_ARCHIVE_INVALID_NONNEGATIVE_DECIMAL')
    expectContractError(() => assertCanonicalNonnegativeDecimalString('1.0'), 'RECOVERY_ARCHIVE_INVALID_NONNEGATIVE_DECIMAL')
    expectContractError(() => assertCanonicalNonnegativeDecimalString(1), 'RECOVERY_ARCHIVE_INVALID_NONNEGATIVE_DECIMAL')
  })

  test('positive decimals reject zero and every non-canonical shape', () => {
    expect(() => assertPositiveDecimalString(TWO_POW_53_PLUS_1)).not.toThrow()
    for (const value of ['0', '01', '-1', '+1', '1.0', '']) {
      expectContractError(() => assertPositiveDecimalString(value), 'RECOVERY_ARCHIVE_INVALID_POSITIVE_DECIMAL')
    }
  })

  test('SHA-256 must be exactly lowercase 64-hex', () => {
    expect(() => assertLowercaseSha256Hex(SHA256)).not.toThrow()
    expectContractError(() => assertLowercaseSha256Hex(SHA256.toUpperCase()), 'RECOVERY_ARCHIVE_INVALID_SHA256')
    expectContractError(() => assertLowercaseSha256Hex('b'.repeat(63)), 'RECOVERY_ARCHIVE_INVALID_SHA256')
    expectContractError(() => assertLowercaseSha256Hex('g'.repeat(64)), 'RECOVERY_ARCHIVE_INVALID_SHA256')
  })
})

describe('Time Machine D2a section integrity projection', () => {
  test('accepts the exact ordered v1 projection and validates decimal row counts and hashes', () => {
    const projections = validProjections()
    projections[1] = projection('records', TWO_POW_53_PLUS_1)
    expect(() => assertRecoveryArchiveV1SectionIntegrityProjection(projections)).not.toThrow()
  })

  test('allows additional complete-descriptor fields without validating the crypto slice', () => {
    const projections = validProjections()
    projections[0] = {
      ...projections[0],
      aead_algorithm: 'future-crypto-slice',
      key_id: 'future-crypto-slice',
      wrapped_dek_id: 'future-crypto-slice',
      dek_fingerprint: 'future-crypto-slice',
      nonce: 'future-crypto-slice',
    }
    expect(() => assertRecoveryArchiveV1SectionIntegrityProjection(projections)).not.toThrow()
  })

  test('refuses unknown, missing, duplicate, and re-ordered sections', () => {
    const unknown = validProjections()
    unknown[0] = { ...unknown[0], name: 'unknown' as never }
    expectContractError(() => assertRecoveryArchiveV1SectionIntegrityProjection(unknown), 'RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS')

    const missing = validProjections().slice(1)
    expectContractError(() => assertRecoveryArchiveV1SectionIntegrityProjection(missing), 'RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS')

    const duplicate = validProjections()
    duplicate[1] = projection('schema')
    expectContractError(() => assertRecoveryArchiveV1SectionIntegrityProjection(duplicate), 'RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS')

    const reordered = validProjections()
    ;[reordered[0], reordered[1]] = [reordered[1], reordered[0]]
    expectContractError(() => assertRecoveryArchiveV1SectionIntegrityProjection(reordered), 'RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS')
  })

  test('refuses non-canonical section row counts and hashes without exposing raw values', () => {
    const badRowCount = validProjections()
    badRowCount[0] = projection('schema', '01')
    expectContractError(() => assertRecoveryArchiveV1SectionIntegrityProjection(badRowCount), 'RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS')

    const badHash = validProjections()
    badHash[0] = { ...badHash[0], plaintext_sha256: SHA256.toUpperCase() }
    expectContractError(() => assertRecoveryArchiveV1SectionIntegrityProjection(badHash), 'RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS')
  })
})
