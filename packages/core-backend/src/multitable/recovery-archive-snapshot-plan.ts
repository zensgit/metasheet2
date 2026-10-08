/**
 * Time Machine D2: pure canonical plaintext planning for one format-v1 snapshot.
 *
 * This module only composes admitted rows, derived coverage, canonical bytes,
 * and caller-generated nonces. It has no source-vector, IO, database, KMS,
 * storage, route, flag, finalize, or production-caller responsibility.
 */

import {
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from './recovery-archive-contract'
import {
  RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
  type RecoveryArchiveSectionPlan,
} from './recovery-archive-crypto'
import { planRecoveryArchiveCoverageIndex } from './recovery-archive-coverage-plan'
import {
  canonicalizeRecoveryArchiveSectionRows,
  type RecoveryArchiveRowEnvelope,
} from './recovery-archive-manifest'
import {
  buildRecoveryArchiveSectionRows,
  RECOVERY_ARCHIVE_DATA_SECTION_NAMES,
  type RecoveryArchiveDataSectionName,
} from './recovery-archive-section-rows'

const INPUT_KEYS = ['sectionRows', 'coverageCandidates', 'nonces'] as const

export type RecoveryArchiveSnapshotPlanErrorCode =
  | 'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_SECTION_ROWS'
  | 'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_COVERAGE_CANDIDATES'
  | 'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCES'
  | 'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCE_LENGTH'
  | 'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_DUPLICATE_NONCE'

/** Values-free refusal surface for pure snapshot plaintext planning. */
export class RecoveryArchiveSnapshotPlanError extends Error {
  readonly code: RecoveryArchiveSnapshotPlanErrorCode

  constructor(code: RecoveryArchiveSnapshotPlanErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSnapshotPlanError'
    this.code = code
  }
}

export type RecoveryArchiveSnapshotSectionRows = Readonly<
  Record<RecoveryArchiveDataSectionName, unknown>
>

export type RecoveryArchiveSnapshotNonces = Readonly<
  Record<RecoveryArchiveSectionName, Uint8Array>
>

export interface RecoveryArchiveSnapshotPlanInput {
  readonly sectionRows: RecoveryArchiveSnapshotSectionRows
  readonly coverageCandidates: unknown
  readonly nonces: RecoveryArchiveSnapshotNonces
}

/** Canonical bytes plus immutable metadata for one crypto section plan. */
export interface RecoveryArchiveCanonicalSectionPlan extends RecoveryArchiveSectionPlan {
  readonly sectionName: RecoveryArchiveSectionName
  readonly plaintext: Uint8Array
  readonly nonce: Uint8Array
  readonly rowCount: string
  readonly plaintextSha256: string
}

const utf8Encoder = new TextEncoder()

/**
 * Build the exact ten-section D1 plaintext plan. Coverage rows are always
 * derived from coverage candidates; no caller-supplied coverage row surface
 * exists. Cross-archive nonce uniqueness remains the DB reservation authority.
 */
export function buildRecoveryArchiveSnapshotPlan(
  input: unknown,
): readonly RecoveryArchiveCanonicalSectionPlan[] {
  const admitted = snapshotExactDataRecord(
    input,
    INPUT_KEYS,
    'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_INPUT',
  )
  const sectionRows = snapshotExactDataRecord(
    admitted.sectionRows,
    RECOVERY_ARCHIVE_DATA_SECTION_NAMES,
    'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_SECTION_ROWS',
  )
  const nonceInputs = snapshotExactDataRecord(
    admitted.nonces,
    RECOVERY_ARCHIVE_V1_SECTION_NAMES,
    'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCES',
  )
  const nonces = snapshotNonces(nonceInputs)

  const rowsBySection = new Map<
    RecoveryArchiveSectionName,
    readonly RecoveryArchiveRowEnvelope[]
  >()
  for (const sectionName of RECOVERY_ARCHIVE_DATA_SECTION_NAMES) {
    const rows = callClosed(
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_SECTION_ROWS',
      () => buildRecoveryArchiveSectionRows(sectionName, sectionRows[sectionName]),
    )
    rowsBySection.set(sectionName, rows)
  }
  rowsBySection.set(
    'coverage_index',
    callClosed(
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_COVERAGE_CANDIDATES',
      () => planRecoveryArchiveCoverageIndex(admitted.coverageCandidates),
    ),
  )

  const plans = RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((sectionName) => {
    const rows = rowsBySection.get(sectionName)
    if (rows === undefined) {
      fail('RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_SECTION_ROWS')
    }
    const canonical = callClosed(
      sectionName === 'coverage_index'
        ? 'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_COVERAGE_CANDIDATES'
        : 'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_SECTION_ROWS',
      () => canonicalizeRecoveryArchiveSectionRows(sectionName, rows),
    )
    return createCanonicalSectionPlan({
      sectionName,
      plaintext: utf8Encoder.encode(canonical.canonicalJson),
      nonce: nonces[sectionName],
      rowCount: canonical.rowCount,
      plaintextSha256: canonical.plaintextSha256,
    })
  })

  return Object.freeze(plans)
}

function createCanonicalSectionPlan(
  input: RecoveryArchiveCanonicalSectionPlan,
): RecoveryArchiveCanonicalSectionPlan {
  const plaintext = new Uint8Array(input.plaintext)
  const nonce = new Uint8Array(input.nonce)
  return Object.freeze({
    sectionName: input.sectionName,
    get plaintext() {
      return new Uint8Array(plaintext)
    },
    get nonce() {
      return new Uint8Array(nonce)
    },
    rowCount: input.rowCount,
    plaintextSha256: input.plaintextSha256,
  })
}

function snapshotNonces(
  nonceInputs: Record<string, unknown>,
): Record<RecoveryArchiveSectionName, Uint8Array> {
  const snapshots = Object.create(null) as Record<RecoveryArchiveSectionName, Uint8Array>
  const seen = new Set<string>()

  for (const sectionName of RECOVERY_ARCHIVE_V1_SECTION_NAMES) {
    const nonce = snapshotNonce(nonceInputs[sectionName])
    const identity = nonceIdentity(nonce)
    if (seen.has(identity)) {
      fail('RECOVERY_ARCHIVE_SNAPSHOT_PLAN_DUPLICATE_NONCE')
    }
    seen.add(identity)
    snapshots[sectionName] = nonce
  }

  return snapshots
}

function snapshotNonce(value: unknown): Uint8Array {
  let byteLength: number
  try {
    if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value)) {
      fail('RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCES')
    }
    byteLength = value.byteLength
  } catch {
    fail('RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCES')
  }
  if (byteLength !== RECOVERY_ARCHIVE_AEAD_NONCE_BYTES) {
    fail('RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCE_LENGTH')
  }

  try {
    const snapshot = new Uint8Array(RECOVERY_ARCHIVE_AEAD_NONCE_BYTES)
    Uint8Array.prototype.set.call(snapshot, value)
    return snapshot
  } catch {
    fail('RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCES')
  }
}

function nonceIdentity(nonce: Uint8Array): string {
  let identity = ''
  for (const byte of nonce) identity += byte.toString(16).padStart(2, '0')
  return identity
}

function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  errorCode: RecoveryArchiveSnapshotPlanErrorCode,
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(errorCode)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail(errorCode)

    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedKeys.length) fail(errorCode)
    const expected = new Set(expectedKeys)
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      if (typeof key === 'symbol' || !expected.has(key)) fail(errorCode)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail(errorCode)
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    fail(errorCode)
  }
}

function callClosed<T>(
  code: RecoveryArchiveSnapshotPlanErrorCode,
  run: () => T,
): T {
  try {
    return run()
  } catch {
    fail(code)
  }
}

function fail(code: RecoveryArchiveSnapshotPlanErrorCode): never {
  throw new RecoveryArchiveSnapshotPlanError(code)
}
