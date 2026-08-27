/**
 * Time Machine D2: pure sealed-section manifest compiler.
 *
 * This module binds an already-built canonical snapshot plan to an already
 * sealed D2h result, then emits the unsigned canonical manifest/root and the
 * MAC preimage for a later outside-transaction key-custody call. It performs
 * no database, KMS, provider, route, flag, or production-caller work.
 */

import { createHash } from 'node:crypto'

import {
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from './recovery-archive-contract'
import {
  buildRecoveryArchiveManifestMacPreimage,
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
  RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
  recoveryArchivePlaintextSha256,
  toRecoveryArchiveNonceHex,
  type RecoveryArchiveCryptoBinding,
  type RecoveryArchiveReserveThenSealResult,
} from './recovery-archive-crypto'
import {
  buildRecoveryArchiveManifest,
  canonicalizeRecoveryArchiveSectionRows,
  type RecoveryArchiveManifest,
  type RecoveryArchiveManifestBinding,
  type RecoveryArchiveRowEnvelope,
  type RecoveryArchiveSectionBuildInput,
} from './recovery-archive-manifest'
import type { RecoveryArchiveCanonicalSectionPlan } from './recovery-archive-snapshot-plan'

const INPUT_KEYS = ['binding', 'keyId', 'plan', 'sealResult'] as const
const BINDING_KEYS = [
  'archive_generation_id',
  'workspace_id',
  'base_id',
  'sheet_id',
  'anchor_operation_id',
  'anchor_seq',
  'checkpoint_id',
  'created_at',
  'expires_at',
  'source_vector_hash',
] as const
const SEAL_RESULT_KEYS = [
  'binding',
  'dekFingerprint',
  'wrappedDekId',
  'reservations',
  'sealedSections',
] as const
const SEAL_BINDING_KEYS = [
  'formatVersion',
  'generationId',
  'workspaceId',
  'baseId',
  'sheetId',
  'anchorOperationId',
  'anchorSeq',
  'checkpointId',
  'keyId',
  'wrappedDekId',
  'dekFingerprint',
  'aeadAlgorithm',
] as const
const PLAN_SECTION_KEYS = ['sectionName', 'plaintext', 'nonce', 'rowCount', 'plaintextSha256'] as const
const RESERVATION_KEYS = [
  'dekFingerprint',
  'nonceHex',
  'generationId',
  'sectionName',
  'aeadAlgorithm',
  'formatVersion',
] as const
const SEALED_SECTION_KEYS = [
  'sectionName',
  'aeadAlgorithm',
  'nonce',
  'ciphertext',
  'authTag',
  'plaintextSha256',
] as const

export type RecoveryArchiveSealedSnapshotManifestErrorCode =
  | 'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_BINDING'
  | 'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN'
  | 'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_CANONICAL_BYTES'
  | 'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT'
  | 'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH'

/** Values-free refusal surface for the pure section-seal to manifest boundary. */
export class RecoveryArchiveSealedSnapshotManifestError extends Error {
  readonly code: RecoveryArchiveSealedSnapshotManifestErrorCode

  constructor(code: RecoveryArchiveSealedSnapshotManifestErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSealedSnapshotManifestError'
    this.code = code
  }
}

export interface RecoveryArchiveSealedSnapshotManifestInput {
  readonly binding: RecoveryArchiveManifestBinding
  readonly keyId: string
  readonly plan: readonly RecoveryArchiveCanonicalSectionPlan[]
  readonly sealResult: RecoveryArchiveReserveThenSealResult
}

export interface RecoveryArchiveSealedSnapshotSection {
  readonly sectionName: RecoveryArchiveSectionName
  readonly aeadAlgorithm: typeof RECOVERY_ARCHIVE_AEAD_ALGORITHM
  readonly plaintextSha256: string
  readonly ciphertextSha256: string
  readonly ciphertextSizeBytes: string
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authTag: Uint8Array
}

export interface RecoveryArchiveSealedSnapshotManifestResult {
  /** Unsigned canonical manifest. `manifest_mac` is intentionally null in this pure slice. */
  readonly manifest: RecoveryArchiveManifest
  readonly bodyJson: string
  readonly manifestJson: string
  readonly macPreimage: Uint8Array
  readonly sealedSections: readonly RecoveryArchiveSealedSnapshotSection[]
}

type NormalizedPlanSection = {
  readonly sectionName: RecoveryArchiveSectionName
  readonly rows: readonly RecoveryArchiveRowEnvelope[]
  readonly nonce: Uint8Array
  readonly nonceHex: string
  readonly plaintextSha256: string
}

type NormalizedSealResult = {
  readonly binding: RecoveryArchiveCryptoBinding
  readonly dekFingerprint: string
  readonly wrappedDekId: string
  readonly reservations: readonly Record<string, unknown>[]
  readonly sealedSections: readonly Record<string, unknown>[]
}

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

/**
 * Compile exactly one complete format-v1 sealed snapshot into an unsigned
 * canonical manifest and its MAC preimage. A later D-H2 caller owns MACing,
 * provider receipts, persistence, and the final fenced transition.
 */
export function buildRecoveryArchiveSealedSnapshotManifest(
  input: unknown,
): RecoveryArchiveSealedSnapshotManifestResult {
  const admitted = snapshotExactRecord(
    input,
    INPUT_KEYS,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_INPUT',
  )
  const binding = snapshotExactRecord(
    admitted.binding,
    BINDING_KEYS,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_BINDING',
  ) as unknown as RecoveryArchiveManifestBinding
  const keyId = admitted.keyId
  if (typeof keyId !== 'string' || keyId.trim().length === 0) {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_BINDING')
  }

  const plan = normalizePlan(admitted.plan)
  const sealResult = normalizeSealResult(admitted.sealResult)
  assertSealBindingMatchesManifest(binding, keyId, sealResult)
  const sectionInputs = bindPlanAndSeal(plan, sealResult, binding, keyId)

  const built = callClosed('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_BINDING', () =>
    buildRecoveryArchiveManifest(binding, sectionInputs),
  )
  const macPreimage = callClosed('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_BINDING', () =>
    buildRecoveryArchiveManifestMacPreimage({
      formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
      generationId: binding.archive_generation_id,
      workspaceId: binding.workspace_id,
      baseId: binding.base_id,
      sheetId: binding.sheet_id,
      anchorOperationId: binding.anchor_operation_id,
      anchorSeq: binding.anchor_seq,
      checkpointId: binding.checkpoint_id,
      keyId: sealResult.binding.keyId,
      wrappedDekId: sealResult.binding.wrappedDekId,
      dekFingerprint: sealResult.binding.dekFingerprint,
      aeadAlgorithm: sealResult.binding.aeadAlgorithm,
      rootHash: built.manifest.root_hash,
      createdAt: binding.created_at,
      expiresAt: binding.expires_at,
      sourceVectorHash: binding.source_vector_hash,
    }),
  )

  return createResult({
    manifest: built.manifest,
    bodyJson: built.bodyJson,
    manifestJson: built.manifestJson,
    macPreimage,
    sealedSections: plan.map((section, index) => {
      const sealed = sealResult.sealedSections[index]
      if (sealed === undefined) {
        fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT')
      }
      return snapshotSealedSection(section.sectionName, sealed)
    }),
  })
}

function normalizePlan(value: unknown): readonly NormalizedPlanSection[] {
  const sections = snapshotDenseArray(
    value,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN',
  )
  if (sections.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length) {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN')
  }

  const normalized: NormalizedPlanSection[] = []
  for (const [index, sectionValue] of sections.entries()) {
    const expectedName = RECOVERY_ARCHIVE_V1_SECTION_NAMES[index]
    if (expectedName === undefined) {
      fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN')
    }
    const section = snapshotExactRecord(
      sectionValue,
      PLAN_SECTION_KEYS,
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN',
      new Set(['plaintext', 'nonce']),
    )
    if (
      section.sectionName !== expectedName
      || typeof section.rowCount !== 'string'
      || typeof section.plaintextSha256 !== 'string'
    ) {
      fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN')
    }

    const plaintext = snapshotBytes(
      section.plaintext,
      undefined,
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN',
    )
    const nonce = snapshotBytes(
      section.nonce,
      RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN',
    )
    const rows = decodeCanonicalRows(expectedName, plaintext, section.rowCount, section.plaintextSha256)
    normalized.push({
      sectionName: expectedName,
      rows,
      nonce,
      nonceHex: callClosed('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_PLAN', () =>
        toRecoveryArchiveNonceHex(nonce),
      ),
      plaintextSha256: section.plaintextSha256,
    })
  }
  return Object.freeze(normalized)
}

function decodeCanonicalRows(
  sectionName: RecoveryArchiveSectionName,
  plaintext: Uint8Array,
  rowCount: string,
  plaintextSha256: string,
): readonly RecoveryArchiveRowEnvelope[] {
  try {
    const decoded = utf8Decoder.decode(plaintext)
    const parsed: unknown = JSON.parse(decoded)
    if (!Array.isArray(parsed)) {
      fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_CANONICAL_BYTES')
    }
    const canonical = canonicalizeRecoveryArchiveSectionRows(sectionName, parsed)
    if (
      !bytesEqual(plaintext, utf8Encoder.encode(canonical.canonicalJson))
      || canonical.rowCount !== rowCount
      || canonical.plaintextSha256 !== plaintextSha256
      || recoveryArchivePlaintextSha256(plaintext) !== plaintextSha256
    ) {
      fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_CANONICAL_BYTES')
    }
    return Object.freeze(parsed.map((row) => row as RecoveryArchiveRowEnvelope))
  } catch {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_CANONICAL_BYTES')
  }
}

function normalizeSealResult(value: unknown): NormalizedSealResult {
  const result = snapshotExactRecord(
    value,
    SEAL_RESULT_KEYS,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  )
  const binding = snapshotExactRecord(
    result.binding,
    SEAL_BINDING_KEYS,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  ) as unknown as RecoveryArchiveCryptoBinding
  if (typeof result.dekFingerprint !== 'string' || typeof result.wrappedDekId !== 'string') {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT')
  }
  const reservations = snapshotDenseArray(
    result.reservations,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  ).map((reservation) =>
    snapshotExactRecord(
      reservation,
      RESERVATION_KEYS,
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
    ),
  )
  const sealedSections = snapshotDenseArray(
    result.sealedSections,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  ).map((section) =>
    snapshotExactRecord(
      section,
      SEALED_SECTION_KEYS,
      'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
    ),
  )
  if (
    reservations.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length
    || sealedSections.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length
  ) {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT')
  }
  return Object.freeze({
    binding: Object.freeze(binding),
    dekFingerprint: result.dekFingerprint,
    wrappedDekId: result.wrappedDekId,
    reservations: Object.freeze(reservations),
    sealedSections: Object.freeze(sealedSections),
  })
}

function assertSealBindingMatchesManifest(
  manifest: RecoveryArchiveManifestBinding,
  keyId: string,
  sealResult: NormalizedSealResult,
): void {
  const binding = sealResult.binding
  if (
    binding.formatVersion !== RECOVERY_ARCHIVE_FORMAT_VERSION
    || binding.generationId !== manifest.archive_generation_id
    || binding.workspaceId !== manifest.workspace_id
    || binding.baseId !== manifest.base_id
    || binding.sheetId !== manifest.sheet_id
    || binding.anchorOperationId !== manifest.anchor_operation_id
    || binding.anchorSeq !== manifest.anchor_seq
    || binding.checkpointId !== manifest.checkpoint_id
    || binding.keyId !== keyId
    || binding.wrappedDekId !== sealResult.wrappedDekId
    || binding.dekFingerprint !== sealResult.dekFingerprint
    || binding.aeadAlgorithm !== RECOVERY_ARCHIVE_AEAD_ALGORITHM
  ) {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH')
  }
}

function bindPlanAndSeal(
  plan: readonly NormalizedPlanSection[],
  sealResult: NormalizedSealResult,
  binding: RecoveryArchiveManifestBinding,
  keyId: string,
): RecoveryArchiveSectionBuildInput[] {
  return plan.map((section, index) => {
    const reservation = sealResult.reservations[index]
    const sealed = sealResult.sealedSections[index]
    if (reservation === undefined || sealed === undefined) {
      fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT')
    }
    assertReservationMatches(section, reservation, sealResult, binding)
    assertSealedSectionMatches(section, sealed)
    return {
      name: section.sectionName,
      rows: section.rows,
      aead_algorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
      key_id: keyId,
      wrapped_dek_id: sealResult.wrappedDekId,
      dek_fingerprint: sealResult.dekFingerprint,
      nonce: section.nonceHex,
    }
  })
}

function assertReservationMatches(
  section: NormalizedPlanSection,
  reservation: Record<string, unknown>,
  sealResult: NormalizedSealResult,
  binding: RecoveryArchiveManifestBinding,
): void {
  if (
    reservation.dekFingerprint !== sealResult.dekFingerprint
    || reservation.nonceHex !== section.nonceHex
    || reservation.generationId !== binding.archive_generation_id
    || reservation.sectionName !== section.sectionName
    || reservation.aeadAlgorithm !== RECOVERY_ARCHIVE_AEAD_ALGORITHM
    || reservation.formatVersion !== RECOVERY_ARCHIVE_FORMAT_VERSION
  ) {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH')
  }
}

function assertSealedSectionMatches(
  section: NormalizedPlanSection,
  sealed: Record<string, unknown>,
): void {
  const nonce = snapshotBytes(
    sealed.nonce,
    RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  )
  snapshotBytes(
    sealed.ciphertext,
    undefined,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  )
  snapshotBytes(
    sealed.authTag,
    RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  )
  if (
    sealed.sectionName !== section.sectionName
    || sealed.aeadAlgorithm !== RECOVERY_ARCHIVE_AEAD_ALGORITHM
    || sealed.plaintextSha256 !== section.plaintextSha256
    || !bytesEqual(nonce, section.nonce)
  ) {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_BINDING_MISMATCH')
  }
}

function snapshotSealedSection(
  sectionName: RecoveryArchiveSectionName,
  sealed: Record<string, unknown>,
): RecoveryArchiveSealedSnapshotSection {
  const nonce = snapshotBytes(
    sealed.nonce,
    RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  )
  const ciphertext = snapshotBytes(
    sealed.ciphertext,
    undefined,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  )
  const authTag = snapshotBytes(
    sealed.authTag,
    RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
    'RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT',
  )
  if (typeof sealed.plaintextSha256 !== 'string') {
    fail('RECOVERY_ARCHIVE_SEALED_SNAPSHOT_MANIFEST_INVALID_SEAL_RESULT')
  }
  const ciphertextSha256 = createHash('sha256').update(ciphertext).digest('hex')
  return Object.freeze({
    sectionName,
    aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
    plaintextSha256: sealed.plaintextSha256,
    ciphertextSha256,
    ciphertextSizeBytes: String(ciphertext.byteLength),
    get nonce() {
      return new Uint8Array(nonce)
    },
    get ciphertext() {
      return new Uint8Array(ciphertext)
    },
    get authTag() {
      return new Uint8Array(authTag)
    },
  })
}

function createResult(input: {
  manifest: RecoveryArchiveManifest
  bodyJson: string
  manifestJson: string
  macPreimage: Uint8Array
  sealedSections: readonly RecoveryArchiveSealedSnapshotSection[]
}): RecoveryArchiveSealedSnapshotManifestResult {
  const macPreimage = new Uint8Array(input.macPreimage)
  const manifest = Object.freeze({
    ...input.manifest,
    sections: Object.freeze(input.manifest.sections.map((section) => Object.freeze({ ...section }))),
  }) as RecoveryArchiveManifest
  return Object.freeze({
    manifest,
    bodyJson: input.bodyJson,
    manifestJson: input.manifestJson,
    get macPreimage() {
      return new Uint8Array(macPreimage)
    },
    sealedSections: Object.freeze([...input.sealedSections]),
  })
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  errorCode: RecoveryArchiveSealedSnapshotManifestErrorCode,
  accessorKeys: ReadonlySet<string> = new Set(),
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
      if (typeof key !== 'string' || !expected.has(key)) fail(errorCode)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable) fail(errorCode)
      if ('value' in descriptor) {
        snapshot[key] = descriptor.value
      } else if (accessorKeys.has(key) && typeof descriptor.get === 'function' && descriptor.set === undefined) {
        snapshot[key] = Reflect.get(value, key)
      } else {
        fail(errorCode)
      }
    }
    return snapshot
  } catch {
    fail(errorCode)
  }
}

function snapshotDenseArray(
  value: unknown,
  errorCode: RecoveryArchiveSealedSnapshotManifestErrorCode,
): unknown[] {
  try {
    if (!Array.isArray(value)) fail(errorCode)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      fail(errorCode)
    }
    const length = lengthDescriptor.value
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1) fail(errorCode)

    const entries: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const key = String(index)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail(errorCode)
      }
      entries.push(descriptor.value)
    }
    for (const key of keys) {
      if (key === 'length') continue
      if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
        fail(errorCode)
      }
    }
    return entries
  } catch {
    fail(errorCode)
  }
}

function snapshotBytes(
  value: unknown,
  expectedLength: number | undefined,
  errorCode: RecoveryArchiveSealedSnapshotManifestErrorCode,
): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value)) fail(errorCode)
    const byteLength = value.byteLength
    if (expectedLength !== undefined && byteLength !== expectedLength) fail(errorCode)
    const snapshot = new Uint8Array(byteLength)
    Uint8Array.prototype.set.call(snapshot, value)
    return snapshot
  } catch {
    fail(errorCode)
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function callClosed<T>(
  errorCode: RecoveryArchiveSealedSnapshotManifestErrorCode,
  run: () => T,
): T {
  try {
    return run()
  } catch {
    fail(errorCode)
  }
}

function fail(code: RecoveryArchiveSealedSnapshotManifestErrorCode): never {
  throw new RecoveryArchiveSealedSnapshotManifestError(code)
}
