/**
 * Time Machine Phase D2a/D2b only: pure recovery-archive contract and flag shape.
 *
 * This module has no production caller. It does not implement archive creation,
 * canonical serialization, MAC/AEAD, storage, database, or prune behavior.
 */

export const RECOVERY_ARCHIVE_FORMAT_VERSION = 1 as const

export const RECOVERY_ARCHIVE_V1_SECTION_NAMES = [
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
] as const

export const RECOVERY_ARCHIVE_PAYLOAD_STATES = ['building', 'verified', 'expired'] as const
export const RECOVERY_ARCHIVE_BUILD_STATUSES = ['active', 'finalized', 'abandoned'] as const
export const RECOVERY_ARCHIVE_COVERAGE_STATUSES = ['incomplete', 'complete'] as const
export const RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS = [
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
] as const
export const RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_CLASSES = [
  'source',
  'archive_object',
] as const
export const RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_STATES = [
  'building',
  'verified',
] as const
export const RECOVERY_ARCHIVE_ATTACHMENT_AVAILABILITY = [
  'available',
  'missing',
  'mutable',
  'drifted',
] as const
export const RECOVERY_ARCHIVE_STAGING_OBJECT_CLASSES = [
  'section',
  'attachment',
  'manifest',
] as const
export const RECOVERY_ARCHIVE_STAGING_OBJECT_STATES = [
  'pending',
  'sealed',
  'deleted',
  'absent',
] as const

export type RecoveryArchiveSectionName = (typeof RECOVERY_ARCHIVE_V1_SECTION_NAMES)[number]
export type RecoveryArchivePayloadState = (typeof RECOVERY_ARCHIVE_PAYLOAD_STATES)[number]
export type RecoveryArchiveBuildStatus = (typeof RECOVERY_ARCHIVE_BUILD_STATUSES)[number]
export type RecoveryArchiveCoverageStatus = (typeof RECOVERY_ARCHIVE_COVERAGE_STATUSES)[number]
export type RecoveryArchiveCoverageSourceKind = (typeof RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS)[number]
export type RecoveryArchiveAttachmentReferenceClass = (typeof RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_CLASSES)[number]
export type RecoveryArchiveAttachmentReferenceState = (typeof RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_STATES)[number]
export type RecoveryArchiveAttachmentAvailability = (typeof RECOVERY_ARCHIVE_ATTACHMENT_AVAILABILITY)[number]
export type RecoveryArchiveStagingObjectClass = (typeof RECOVERY_ARCHIVE_STAGING_OBJECT_CLASSES)[number]
export type RecoveryArchiveStagingObjectState = (typeof RECOVERY_ARCHIVE_STAGING_OBJECT_STATES)[number]

/**
 * D2a-only integrity projection of a v1 section descriptor. Additional
 * descriptor fields are allowed; the complete crypto-bearing manifest
 * descriptor belongs to the later crypto slice.
 */
export interface RecoveryArchiveSectionIntegrityProjection {
  name: RecoveryArchiveSectionName
  row_count: string
  plaintext_sha256: string
  [key: string]: unknown
}

export type RecoveryArchiveContractErrorCode =
  | 'RECOVERY_ARCHIVE_INVALID_NONNEGATIVE_DECIMAL'
  | 'RECOVERY_ARCHIVE_INVALID_POSITIVE_DECIMAL'
  | 'RECOVERY_ARCHIVE_INVALID_SHA256'
  | 'RECOVERY_ARCHIVE_INVALID_PAYLOAD_STATE'
  | 'RECOVERY_ARCHIVE_INVALID_BUILD_STATUS'
  | 'RECOVERY_ARCHIVE_INVALID_COVERAGE_STATUS'
  | 'RECOVERY_ARCHIVE_INVALID_COVERAGE_SOURCE_KIND'
  | 'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_REFERENCE_CLASS'
  | 'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_REFERENCE_STATE'
  | 'RECOVERY_ARCHIVE_INVALID_ATTACHMENT_AVAILABILITY'
  | 'RECOVERY_ARCHIVE_INVALID_STAGING_OBJECT_CLASS'
  | 'RECOVERY_ARCHIVE_INVALID_STAGING_OBJECT_STATE'
  | 'RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS'

/** Values-free failure surface for Phase D2a contract validation. */
export class RecoveryArchiveContractError extends Error {
  readonly code: RecoveryArchiveContractErrorCode

  constructor(code: RecoveryArchiveContractErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveContractError'
    this.code = code
  }
}

/** D2a only: no production caller currently makes archive behavior reachable. */
export function isMultitableRecoveryArchiveEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.MULTITABLE_RECOVERY_ARCHIVE_ENABLED === 'true'
}

export function isCanonicalNonnegativeDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
}

export function assertCanonicalNonnegativeDecimalString(value: unknown): asserts value is string {
  if (!isCanonicalNonnegativeDecimalString(value)) {
    throw new RecoveryArchiveContractError('RECOVERY_ARCHIVE_INVALID_NONNEGATIVE_DECIMAL')
  }
}

export function isPositiveDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
}

export function assertPositiveDecimalString(value: unknown): asserts value is string {
  if (!isPositiveDecimalString(value)) {
    throw new RecoveryArchiveContractError('RECOVERY_ARCHIVE_INVALID_POSITIVE_DECIMAL')
  }
}

export function isLowercaseSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function assertLowercaseSha256Hex(value: unknown): asserts value is string {
  if (!isLowercaseSha256Hex(value)) {
    throw new RecoveryArchiveContractError('RECOVERY_ARCHIVE_INVALID_SHA256')
  }
}

export function isRecoveryArchivePayloadState(value: unknown): value is RecoveryArchivePayloadState {
  return isClosedValue(RECOVERY_ARCHIVE_PAYLOAD_STATES, value)
}

export function assertRecoveryArchivePayloadState(value: unknown): asserts value is RecoveryArchivePayloadState {
  if (!isRecoveryArchivePayloadState(value)) throwContractError('RECOVERY_ARCHIVE_INVALID_PAYLOAD_STATE')
}

export function isRecoveryArchiveBuildStatus(value: unknown): value is RecoveryArchiveBuildStatus {
  return isClosedValue(RECOVERY_ARCHIVE_BUILD_STATUSES, value)
}

export function assertRecoveryArchiveBuildStatus(value: unknown): asserts value is RecoveryArchiveBuildStatus {
  if (!isRecoveryArchiveBuildStatus(value)) throwContractError('RECOVERY_ARCHIVE_INVALID_BUILD_STATUS')
}

export function isRecoveryArchiveCoverageStatus(value: unknown): value is RecoveryArchiveCoverageStatus {
  return isClosedValue(RECOVERY_ARCHIVE_COVERAGE_STATUSES, value)
}

export function assertRecoveryArchiveCoverageStatus(value: unknown): asserts value is RecoveryArchiveCoverageStatus {
  if (!isRecoveryArchiveCoverageStatus(value)) throwContractError('RECOVERY_ARCHIVE_INVALID_COVERAGE_STATUS')
}

export function isRecoveryArchiveCoverageSourceKind(value: unknown): value is RecoveryArchiveCoverageSourceKind {
  return isClosedValue(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS, value)
}

export function assertRecoveryArchiveCoverageSourceKind(value: unknown): asserts value is RecoveryArchiveCoverageSourceKind {
  if (!isRecoveryArchiveCoverageSourceKind(value)) throwContractError('RECOVERY_ARCHIVE_INVALID_COVERAGE_SOURCE_KIND')
}

export function isRecoveryArchiveAttachmentReferenceClass(value: unknown): value is RecoveryArchiveAttachmentReferenceClass {
  return isClosedValue(RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_CLASSES, value)
}

export function assertRecoveryArchiveAttachmentReferenceClass(
  value: unknown,
): asserts value is RecoveryArchiveAttachmentReferenceClass {
  if (!isRecoveryArchiveAttachmentReferenceClass(value)) {
    throwContractError('RECOVERY_ARCHIVE_INVALID_ATTACHMENT_REFERENCE_CLASS')
  }
}

export function isRecoveryArchiveAttachmentReferenceState(value: unknown): value is RecoveryArchiveAttachmentReferenceState {
  return isClosedValue(RECOVERY_ARCHIVE_ATTACHMENT_REFERENCE_STATES, value)
}

export function assertRecoveryArchiveAttachmentReferenceState(
  value: unknown,
): asserts value is RecoveryArchiveAttachmentReferenceState {
  if (!isRecoveryArchiveAttachmentReferenceState(value)) {
    throwContractError('RECOVERY_ARCHIVE_INVALID_ATTACHMENT_REFERENCE_STATE')
  }
}

export function isRecoveryArchiveAttachmentAvailability(value: unknown): value is RecoveryArchiveAttachmentAvailability {
  return isClosedValue(RECOVERY_ARCHIVE_ATTACHMENT_AVAILABILITY, value)
}

export function assertRecoveryArchiveAttachmentAvailability(
  value: unknown,
): asserts value is RecoveryArchiveAttachmentAvailability {
  if (!isRecoveryArchiveAttachmentAvailability(value)) {
    throwContractError('RECOVERY_ARCHIVE_INVALID_ATTACHMENT_AVAILABILITY')
  }
}

export function isRecoveryArchiveStagingObjectClass(value: unknown): value is RecoveryArchiveStagingObjectClass {
  return isClosedValue(RECOVERY_ARCHIVE_STAGING_OBJECT_CLASSES, value)
}

export function assertRecoveryArchiveStagingObjectClass(
  value: unknown,
): asserts value is RecoveryArchiveStagingObjectClass {
  if (!isRecoveryArchiveStagingObjectClass(value)) {
    throwContractError('RECOVERY_ARCHIVE_INVALID_STAGING_OBJECT_CLASS')
  }
}

export function isRecoveryArchiveStagingObjectState(value: unknown): value is RecoveryArchiveStagingObjectState {
  return isClosedValue(RECOVERY_ARCHIVE_STAGING_OBJECT_STATES, value)
}

export function assertRecoveryArchiveStagingObjectState(
  value: unknown,
): asserts value is RecoveryArchiveStagingObjectState {
  if (!isRecoveryArchiveStagingObjectState(value)) {
    throwContractError('RECOVERY_ARCHIVE_INVALID_STAGING_OBJECT_STATE')
  }
}

/**
 * D2a only: validates only the ordered name + row_count + plaintext_sha256
 * integrity projection. It allows additional complete-descriptor fields and
 * does not serialize, authenticate, store, or read archive bytes.
 */
export function assertRecoveryArchiveV1SectionIntegrityProjection(
  projections: readonly unknown[],
): asserts projections is readonly RecoveryArchiveSectionIntegrityProjection[] {
  if (projections.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length) {
    throwContractError('RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS')
  }

  for (let index = 0; index < RECOVERY_ARCHIVE_V1_SECTION_NAMES.length; index += 1) {
    const projection = projections[index]
    if (!isSectionIntegrityProjectionAtIndex(projection, index)) {
      throwContractError('RECOVERY_ARCHIVE_INVALID_SECTION_DESCRIPTORS')
    }
  }
}

function isClosedValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

function isSectionIntegrityProjectionAtIndex(value: unknown, index: number): value is RecoveryArchiveSectionIntegrityProjection {
  if (!isRecord(value)) return false
  return (
    value.name === RECOVERY_ARCHIVE_V1_SECTION_NAMES[index] &&
    isCanonicalNonnegativeDecimalString(value.row_count) &&
    isLowercaseSha256Hex(value.plaintext_sha256)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function throwContractError(code: RecoveryArchiveContractErrorCode): never {
  throw new RecoveryArchiveContractError(code)
}
