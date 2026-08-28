/**
 * Time Machine D-H2: authenticate one already-sealed snapshot manifest.
 *
 * This module snapshots and revalidates the unsigned bundle, obtains the
 * manifest/root MAC through the transaction-guarded key-custody boundary, and
 * emits the signed canonical manifest. It performs no database, provider,
 * receipt, route, flag, or production-caller work.
 */

import { createHash } from 'node:crypto'

import {
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
} from './recovery-archive-contract'
import {
  buildRecoveryArchiveManifestMacPreimage,
  createTransactionGuardedKeyCustody,
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
  RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
  type RecoveryArchiveKeyCustodyAdapter,
  type RecoveryArchiveTransactionDepthProbe,
} from './recovery-archive-crypto'
import {
  canonicalizeRecoveryArchiveJson,
  validateRecoveryArchiveManifest,
  type RecoveryArchiveManifest,
  type RecoveryArchiveManifestBody,
} from './recovery-archive-manifest'
import { buildRecoveryArchiveManifestObjectEnvelope } from './recovery-archive-manifest-object-envelope'
import type {
  RecoveryArchiveSealedSnapshotManifestResult,
  RecoveryArchiveSealedSnapshotSection,
} from './recovery-archive-sealed-snapshot-manifest'

const INPUT_KEYS = ['keyCustody', 'sealedManifest', 'transactionDepth'] as const
const SEALED_MANIFEST_KEYS = [
  'bodyJson',
  'macPreimage',
  'manifest',
  'manifestJson',
  'sealedSections',
  'wrappedDek',
] as const
const SEALED_SECTION_KEYS = [
  'aeadAlgorithm',
  'authTag',
  'ciphertext',
  'ciphertextSha256',
  'ciphertextSizeBytes',
  'nonce',
  'plaintextSha256',
  'sectionName',
] as const

export type RecoveryArchiveAuthenticatedManifestErrorCode =
  | 'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST'
  | 'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH'
  | 'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED'

/** Values-free authenticated-manifest refusal with no external cause. */
export class RecoveryArchiveAuthenticatedManifestError extends Error {
  readonly code: RecoveryArchiveAuthenticatedManifestErrorCode

  constructor(code: RecoveryArchiveAuthenticatedManifestErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveAuthenticatedManifestError'
    this.code = code
  }
}

export interface RecoveryArchiveAuthenticatedManifestInput {
  readonly sealedManifest: RecoveryArchiveSealedSnapshotManifestResult
  readonly keyCustody: RecoveryArchiveKeyCustodyAdapter
  readonly transactionDepth: RecoveryArchiveTransactionDepthProbe
}

export interface RecoveryArchiveAuthenticatedManifestResult {
  readonly manifest: RecoveryArchiveManifest
  readonly bodyJson: string
  readonly manifestJson: string
  readonly manifestMacBytes: Uint8Array
  readonly macPreimage: Uint8Array
  readonly sealedSections: readonly RecoveryArchiveSealedSnapshotSection[]
  /** Canonical v1 envelope bytes. Emitted only after the manifest/root MAC is attached. */
  readonly envelopeBytes: Uint8Array
  /** Lowercase SHA-256 of `envelopeBytes`, suitable for the existing manifest object descriptor. */
  readonly envelopeSha256: string
}

type SnapshotBundle = {
  readonly manifest: RecoveryArchiveManifest
  readonly bodyJson: string
  readonly manifestJson: string
  readonly macPreimage: Uint8Array
  readonly sealedSections: readonly RecoveryArchiveSealedSnapshotSection[]
  readonly wrappedDek: Uint8Array
  readonly keyId: string
}

/**
 * Produce the authenticated canonical manifest. `manifest_mac` is the unique
 * lowercase even-length hex encoding of the raw MAC bytes returned separately
 * for the future `bytea` finalize column.
 */
export async function authenticateRecoveryArchiveSealedSnapshotManifest(
  input: unknown,
): Promise<RecoveryArchiveAuthenticatedManifestResult> {
  const admitted = snapshotExactRecord(
    input,
    INPUT_KEYS,
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_INPUT',
  )
  const snapshot = snapshotUnsignedBundle(admitted.sealedManifest)

  const custody = callClosed(
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_INPUT',
    () =>
      createTransactionGuardedKeyCustody(
        admitted.keyCustody as RecoveryArchiveKeyCustodyAdapter,
        admitted.transactionDepth as RecoveryArchiveTransactionDepthProbe,
      ),
  )
  const kmsPreimage = new Uint8Array(snapshot.macPreimage)
  let manifestMac: Uint8Array
  try {
    const returned = await custody.macManifestRoot({
      keyId: snapshot.keyId,
      preimage: kmsPreimage,
    })
    manifestMac = snapshotBytes(
      returned,
      undefined,
      'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED',
    )
  } catch {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED')
  }
  if (!bytesEqual(kmsPreimage, snapshot.macPreimage)) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_KEY_CUSTODY_FAILED')
  }

  const manifestMacHex = bytesToLowercaseHex(manifestMac)
  const signedManifest = callClosed(
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    () =>
      validateRecoveryArchiveManifest({
        ...snapshot.manifest,
        sections: snapshot.manifest.sections,
        manifest_mac: manifestMacHex,
      }),
  )
  const manifestJson = callClosed(
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    () => canonicalizeRecoveryArchiveJson(signedManifest),
  )
  if (!bytesEqual(hexToBytes(signedManifest.manifest_mac), manifestMac)) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH')
  }

  const envelope = callClosed(
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH',
    () =>
      buildRecoveryArchiveManifestObjectEnvelope({
        manifestJson,
        wrappedDek: snapshot.wrappedDek,
      }),
  )

  return createResult({
    manifest: signedManifest,
    bodyJson: snapshot.bodyJson,
    manifestJson,
    manifestMacBytes: manifestMac,
    macPreimage: snapshot.macPreimage,
    sealedSections: snapshot.sealedSections,
    envelopeBytes: envelope.envelopeBytes,
    envelopeSha256: envelope.envelopeSha256,
  })
}

function snapshotUnsignedBundle(value: unknown): SnapshotBundle {
  const admitted = snapshotExactRecord(
    value,
    SEALED_MANIFEST_KEYS,
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    new Set(['macPreimage', 'wrappedDek']),
  )
  const manifest = callClosed(
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    () => validateRecoveryArchiveManifest(admitted.manifest),
  )
  if (manifest.manifest_mac !== null) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST')
  }
  if (
    typeof admitted.bodyJson !== 'string' ||
    typeof admitted.manifestJson !== 'string'
  ) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST')
  }

  const body = manifestBody(manifest)
  const bodyJson = callClosed(
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    () => canonicalizeRecoveryArchiveJson(body),
  )
  const manifestJson = callClosed(
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
    () => canonicalizeRecoveryArchiveJson(manifest),
  )
  if (
    admitted.bodyJson !== bodyJson ||
    admitted.manifestJson !== manifestJson
  ) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH')
  }

  const sections = snapshotSealedSections(admitted.sealedSections, manifest)
  const first = manifest.sections[0]
  if (first === undefined) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH')
  }
  for (const section of manifest.sections) {
    if (
      section.aead_algorithm !== first.aead_algorithm ||
      section.key_id !== first.key_id ||
      section.wrapped_dek_id !== first.wrapped_dek_id ||
      section.dek_fingerprint !== first.dek_fingerprint
    ) {
      fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH')
    }
  }

  const expectedPreimage = callClosed(
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH',
    () =>
      buildRecoveryArchiveManifestMacPreimage({
        formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
        generationId: manifest.archive_generation_id,
        workspaceId: manifest.workspace_id,
        baseId: manifest.base_id,
        sheetId: manifest.sheet_id,
        anchorOperationId: manifest.anchor_operation_id,
        anchorSeq: manifest.anchor_seq,
        checkpointId: manifest.checkpoint_id,
        keyId: first.key_id,
        wrappedDekId: first.wrapped_dek_id,
        dekFingerprint: first.dek_fingerprint,
        aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
        rootHash: manifest.root_hash,
        createdAt: manifest.created_at,
        expiresAt: manifest.expires_at,
        sourceVectorHash: manifest.source_vector_hash,
      }),
  )
  const suppliedPreimage = snapshotBytes(
    admitted.macPreimage,
    undefined,
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
  )
  if (!bytesEqual(suppliedPreimage, expectedPreimage)) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH')
  }
  const wrappedDek = snapshotBytes(
    admitted.wrappedDek,
    undefined,
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
  )

  return Object.freeze({
    manifest: freezeManifest(manifest),
    bodyJson,
    manifestJson,
    macPreimage: expectedPreimage,
    sealedSections: sections,
    wrappedDek,
    keyId: first.key_id,
  })
}

function snapshotSealedSections(
  value: unknown,
  manifest: RecoveryArchiveManifest,
): readonly RecoveryArchiveSealedSnapshotSection[] {
  const values = snapshotDenseArray(
    value,
    'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
  )
  if (values.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST')
  }

  return Object.freeze(
    values.map((sectionValue, index) => {
      const section = snapshotExactRecord(
        sectionValue,
        SEALED_SECTION_KEYS,
        'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
        new Set(['authTag', 'ciphertext', 'nonce']),
      )
      const descriptor = manifest.sections[index]
      const expectedName = RECOVERY_ARCHIVE_V1_SECTION_NAMES[index]
      if (descriptor === undefined || expectedName === undefined) {
        fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH')
      }
      const nonce = snapshotBytes(
        section.nonce,
        RECOVERY_ARCHIVE_AEAD_NONCE_BYTES,
        'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
      )
      const ciphertext = snapshotBytes(
        section.ciphertext,
        undefined,
        'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
      )
      const authTag = snapshotBytes(
        section.authTag,
        RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
        'RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_INVALID_UNSIGNED_MANIFEST',
      )
      const ciphertextSha256 = createHash('sha256')
        .update(ciphertext)
        .digest('hex')
      if (
        section.sectionName !== expectedName ||
        descriptor.name !== expectedName ||
        descriptor.aead_algorithm !== RECOVERY_ARCHIVE_AEAD_ALGORITHM ||
        section.aeadAlgorithm !== RECOVERY_ARCHIVE_AEAD_ALGORITHM ||
        section.plaintextSha256 !== descriptor.plaintext_sha256 ||
        section.ciphertextSha256 !== ciphertextSha256 ||
        section.ciphertextSizeBytes !== String(ciphertext.byteLength) ||
        bytesToLowercaseHex(nonce) !== descriptor.nonce
      ) {
        fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH')
      }
      return freezeSealedSection({
        sectionName: expectedName,
        aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
        plaintextSha256: descriptor.plaintext_sha256,
        ciphertextSha256,
        ciphertextSizeBytes: String(ciphertext.byteLength),
        nonce,
        ciphertext,
        authTag,
      })
    }),
  )
}

function manifestBody(
  manifest: RecoveryArchiveManifest,
): RecoveryArchiveManifestBody {
  return {
    format_version: manifest.format_version,
    archive_generation_id: manifest.archive_generation_id,
    workspace_id: manifest.workspace_id,
    base_id: manifest.base_id,
    sheet_id: manifest.sheet_id,
    anchor_operation_id: manifest.anchor_operation_id,
    anchor_seq: manifest.anchor_seq,
    checkpoint_id: manifest.checkpoint_id,
    created_at: manifest.created_at,
    expires_at: manifest.expires_at,
    source_vector_hash: manifest.source_vector_hash,
    sections: manifest.sections,
  }
}

function createResult(input: {
  manifest: RecoveryArchiveManifest
  bodyJson: string
  manifestJson: string
  manifestMacBytes: Uint8Array
  macPreimage: Uint8Array
  sealedSections: readonly RecoveryArchiveSealedSnapshotSection[]
  envelopeBytes: Uint8Array
  envelopeSha256: string
}): RecoveryArchiveAuthenticatedManifestResult {
  const manifestMacBytes = new Uint8Array(input.manifestMacBytes)
  const macPreimage = new Uint8Array(input.macPreimage)
  const envelopeBytes = new Uint8Array(input.envelopeBytes)
  return Object.freeze({
    manifest: freezeManifest(input.manifest),
    bodyJson: input.bodyJson,
    manifestJson: input.manifestJson,
    get manifestMacBytes() {
      return new Uint8Array(manifestMacBytes)
    },
    get macPreimage() {
      return new Uint8Array(macPreimage)
    },
    sealedSections: Object.freeze([...input.sealedSections]),
    get envelopeBytes() {
      return new Uint8Array(envelopeBytes)
    },
    envelopeSha256: input.envelopeSha256,
  })
}

function freezeManifest(
  manifest: RecoveryArchiveManifest,
): RecoveryArchiveManifest {
  return Object.freeze({
    ...manifest,
    sections: Object.freeze(
      manifest.sections.map((section) => Object.freeze({ ...section })),
    ),
  }) as RecoveryArchiveManifest
}

function freezeSealedSection(
  section: RecoveryArchiveSealedSnapshotSection,
): RecoveryArchiveSealedSnapshotSection {
  const nonce = new Uint8Array(section.nonce)
  const ciphertext = new Uint8Array(section.ciphertext)
  const authTag = new Uint8Array(section.authTag)
  return Object.freeze({
    sectionName: section.sectionName,
    aeadAlgorithm: section.aeadAlgorithm,
    plaintextSha256: section.plaintextSha256,
    ciphertextSha256: section.ciphertextSha256,
    ciphertextSizeBytes: section.ciphertextSizeBytes,
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

function bytesToLowercaseHex(value: Uint8Array): string {
  let result = ''
  for (const byte of value) result += byte.toString(16).padStart(2, '0')
  return result
}

function hexToBytes(value: string | null): Uint8Array {
  if (value === null || !/^(?:[0-9a-f]{2})+$/.test(value)) {
    fail('RECOVERY_ARCHIVE_AUTHENTICATED_MANIFEST_BINDING_MISMATCH')
  }
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  errorCode: RecoveryArchiveAuthenticatedManifestErrorCode,
  accessorKeys: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      fail(errorCode)
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
      if ('value' in descriptor) snapshot[key] = descriptor.value
      else if (
        accessorKeys.has(key) &&
        typeof descriptor.get === 'function' &&
        descriptor.set === undefined
      ) {
        snapshot[key] = Reflect.get(value, key)
      } else fail(errorCode)
    }
    return snapshot
  } catch {
    fail(errorCode)
  }
}

function snapshotDenseArray(
  value: unknown,
  errorCode: RecoveryArchiveAuthenticatedManifestErrorCode,
): unknown[] {
  try {
    if (!Array.isArray(value)) fail(errorCode)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    )
      fail(errorCode)
    const length = lengthDescriptor.value
    const keys = Reflect.ownKeys(value)
    if (keys.length !== length + 1) fail(errorCode)

    const entries: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        fail(errorCode)
      entries.push(descriptor.value)
    }
    for (const key of keys) {
      if (key === 'length') continue
      if (
        typeof key !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= length
      )
        fail(errorCode)
    }
    return entries
  } catch {
    fail(errorCode)
  }
}

function snapshotBytes(
  value: unknown,
  expectedLength: number | undefined,
  errorCode: RecoveryArchiveAuthenticatedManifestErrorCode,
): Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value))
      fail(errorCode)
    if (expectedLength !== undefined && value.byteLength !== expectedLength)
      fail(errorCode)
    const snapshot = new Uint8Array(value.byteLength)
    Uint8Array.prototype.set.call(snapshot, value)
    if (snapshot.byteLength === 0) fail(errorCode)
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
  errorCode: RecoveryArchiveAuthenticatedManifestErrorCode,
  run: () => T,
): T {
  try {
    return run()
  } catch {
    fail(errorCode)
  }
}

function fail(code: RecoveryArchiveAuthenticatedManifestErrorCode): never {
  throw new RecoveryArchiveAuthenticatedManifestError(code)
}
