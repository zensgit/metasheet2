/**
 * Time Machine D4: default-inert complete-section archive reader.
 *
 * Promotes the envelope restart path into production code. It authenticates one
 * selected generation/root, unwraps the bound DEK outside any database
 * transaction, AEAD-opens the exact ten canonical section objects, and returns
 * defensive immutable rows. It does not reconstruct live history or read
 * current non-record projections.
 */

import {
  RECOVERY_ARCHIVE_FORMAT_VERSION,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  isCanonicalNonnegativeDecimalString,
  isLowercaseSha256Hex,
} from './recovery-archive-contract'
import type { RecoveryArchiveSectionName } from './recovery-archive-contract'
import {
  RECOVERY_ARCHIVE_AEAD_ALGORITHM,
  RECOVERY_ARCHIVE_AEAD_TAG_BYTES,
  RecoveryArchiveCryptoError,
  assertRecoveryArchiveNonceHex,
  buildRecoveryArchiveManifestMacPreimage,
  assertKeyCustodyCallOutsideTransaction,
  createTransactionGuardedKeyCustody,
  openRecoveryArchiveSection,
  scrubRecoveryArchiveDek,
} from './recovery-archive-crypto'
import type {
  RecoveryArchiveKeyCustodyAdapter,
  RecoveryArchiveTransactionDepthProbe,
} from './recovery-archive-crypto'
import { canonicalizeRecoveryArchiveSectionRows } from './recovery-archive-manifest'
import type {
  RecoveryArchiveManifest,
  RecoveryArchiveRowEnvelope,
} from './recovery-archive-manifest'
import {
  parseRecoveryArchiveManifestObjectEnvelope,
  RecoveryArchiveManifestObjectEnvelopeError,
} from './recovery-archive-manifest-object-envelope'
import {
  RecoveryArchiveObjectStoreError,
  createTransactionGuardedRecoveryArchiveObjectStore,
} from './recovery-archive-object-store'
import type {
  RecoveryArchiveObjectExpectedBinding,
  RecoveryArchiveObjectStoreProvider,
} from './recovery-archive-object-store'
import type { QueryFn } from './permission-service'
import {
  reconstructRecoveryArchiveCompleteSectionsInternal,
  type RecoveryArchiveCompleteSectionState,
} from './recovery-archive-reconstructor'

const INPUT_KEYS = [
  'keyCustody',
  'manifestObject',
  'objectStore',
  'sectionObjects',
  'selectedBinding',
  'transactionDepth',
] as const

const COMPLETE_STATE_INPUT_KEYS = [...INPUT_KEYS, 'query'] as const

const SELECTED_BINDING_KEYS = [
  'anchorOperationId',
  'anchorSeq',
  'baseId',
  'checkpointId',
  'generationId',
  'rootHash',
  'sheetId',
  'sourceVectorHash',
  'workspaceId',
] as const

const OBJECT_BINDING_KEYS = [
  'expectedExpiresAt',
  'expectedSha256',
  'expectedSize',
  'expectedVersion',
  'generationId',
  'objectId',
] as const

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export type RecoveryArchiveReaderErrorCode =
  | 'RECOVERY_ARCHIVE_READER_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_READER_BINDING_MISMATCH'
  | 'RECOVERY_ARCHIVE_READER_ENVELOPE_INVALID'
  | 'RECOVERY_ARCHIVE_READER_MAC_INVALID'
  | 'RECOVERY_ARCHIVE_READER_KEY_CUSTODY_FAILED'
  | 'RECOVERY_ARCHIVE_READER_KEY_CUSTODY_IN_TRANSACTION'
  | 'RECOVERY_ARCHIVE_READER_DEK_FINGERPRINT_MISMATCH'
  | 'RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID'
  | 'RECOVERY_ARCHIVE_READER_AUTH_TAG_INVALID'
  | 'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED'
  | 'RECOVERY_ARCHIVE_READER_PLAINTEXT_INVALID'
  | 'RECOVERY_ARCHIVE_READER_SECTION_INTEGRITY_MISMATCH'
  | 'RECOVERY_ARCHIVE_READER_OBJECT_STORE_FAILED'

/** Values-free D4 reader refusal. Message is the closed code; no DEK, identity, or cause. */
export class RecoveryArchiveReaderError extends Error {
  readonly code: RecoveryArchiveReaderErrorCode

  constructor(code: RecoveryArchiveReaderErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveReaderError'
    this.code = code
  }
}

export interface RecoveryArchiveSelectedBinding {
  readonly generationId: string
  readonly workspaceId: string
  readonly baseId: string
  readonly sheetId: string
  readonly anchorOperationId: string
  readonly anchorSeq: string
  readonly checkpointId: string
  readonly rootHash: string
  readonly sourceVectorHash: string
}

export interface RecoveryArchiveReaderInput {
  readonly selectedBinding: RecoveryArchiveSelectedBinding
  readonly keyCustody: RecoveryArchiveKeyCustodyAdapter
  readonly transactionDepth: RecoveryArchiveTransactionDepthProbe
  readonly objectStore: RecoveryArchiveObjectStoreProvider
  readonly manifestObject: RecoveryArchiveObjectExpectedBinding
  readonly sectionObjects: readonly RecoveryArchiveObjectExpectedBinding[]
}

export interface RecoveryArchiveCompleteStateReaderInput extends RecoveryArchiveReaderInput {
  readonly query: QueryFn
}

export type RecoveryArchiveOpenedSections = Readonly<
  Record<RecoveryArchiveSectionName, readonly RecoveryArchiveRowEnvelope[]>
>

export interface RecoveryArchiveOpenedSnapshot {
  readonly manifest: RecoveryArchiveManifest
  readonly sections: RecoveryArchiveOpenedSections
}

/**
 * The single D4 authority consumed by later preview/apply work. It first opens
 * the authenticated archive outside database transactions, then composes that
 * immutable snapshot with the selected checkpoint and floor-aware hot replay.
 */
export async function readRecoveryArchiveCompleteSectionState(
  input: unknown,
): Promise<RecoveryArchiveCompleteSectionState> {
  const admitted = snapshotExactRecord(
    input,
    COMPLETE_STATE_INPUT_KEYS,
    'RECOVERY_ARCHIVE_READER_INVALID_INPUT',
  )
  if (typeof admitted.query !== 'function') {
    fail('RECOVERY_ARCHIVE_READER_INVALID_INPUT')
  }
  const openedArchive = await readRecoveryArchiveCompleteSectionsInternal({
    selectedBinding: admitted.selectedBinding,
    keyCustody: admitted.keyCustody,
    transactionDepth: admitted.transactionDepth,
    objectStore: admitted.objectStore,
    manifestObject: admitted.manifestObject,
    sectionObjects: admitted.sectionObjects,
  })
  return reconstructRecoveryArchiveCompleteSectionsInternal({
    query: admitted.query as QueryFn,
    openedArchive,
  })
}

/**
 * Authenticate and open one complete v1 archive at the selected binding/root.
 * MAC verification precedes any trust of manifest identity or section plaintext.
 *
 * @internal This is the cryptographic half of the public D4 facade. Production
 * consumers must call readRecoveryArchiveCompleteSectionState so record state
 * cannot bypass checkpoint/floor reconciliation.
 */
export async function readRecoveryArchiveCompleteSectionsInternal(
  input: unknown,
): Promise<RecoveryArchiveOpenedSnapshot> {
  const admitted = snapshotExactRecord(
    input,
    INPUT_KEYS,
    'RECOVERY_ARCHIVE_READER_INVALID_INPUT',
  )
  const selectedBinding = admitSelectedBinding(admitted.selectedBinding)
  const manifestObject = admitObjectBinding(admitted.manifestObject)
  if (manifestObject.generationId !== selectedBinding.generationId) {
    fail('RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
  }
  const sectionObjects = admitSectionBindings(
    admitted.sectionObjects,
    selectedBinding.generationId,
  )

  const custody = callClosed(
    'RECOVERY_ARCHIVE_READER_INVALID_INPUT',
    () =>
      createTransactionGuardedKeyCustody(
        admitted.keyCustody as RecoveryArchiveKeyCustodyAdapter,
        admitted.transactionDepth as RecoveryArchiveTransactionDepthProbe,
      ),
  )
  callClosed('RECOVERY_ARCHIVE_READER_KEY_CUSTODY_IN_TRANSACTION', () =>
    assertKeyCustodyCallOutsideTransaction(
      admitted.transactionDepth as RecoveryArchiveTransactionDepthProbe,
    ),
  )
  const store = callClosed(
    'RECOVERY_ARCHIVE_READER_INVALID_INPUT',
    () =>
      createTransactionGuardedRecoveryArchiveObjectStore(
        admitted.objectStore as RecoveryArchiveObjectStoreProvider,
        admitted.transactionDepth as RecoveryArchiveTransactionDepthProbe,
      ),
  )

  const envelopeBytes = await readObjectBytes(store, manifestObject)
  const envelope = callClosed(
    'RECOVERY_ARCHIVE_READER_ENVELOPE_INVALID',
    () => parseRecoveryArchiveManifestObjectEnvelope(envelopeBytes),
  )
  const manifest = envelope.manifest
  const first = manifest.sections[0]
  if (first === undefined) fail('RECOVERY_ARCHIVE_READER_ENVELOPE_INVALID')

  const macPreimage = callClosed(
    'RECOVERY_ARCHIVE_READER_ENVELOPE_INVALID',
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
  const macBytes = callClosed(
    'RECOVERY_ARCHIVE_READER_MAC_INVALID',
    () => decodeHex(manifest.manifest_mac, 'RECOVERY_ARCHIVE_READER_MAC_INVALID'),
  )
  const verified = await callCustody(
    () =>
      custody.verifyManifestRootMac({
        keyId: first.key_id,
        preimage: macPreimage,
        mac: macBytes,
      }),
  )
  if (verified !== true) fail('RECOVERY_ARCHIVE_READER_MAC_INVALID')

  assertAuthenticatedBinding(selectedBinding, manifest, first)

  let dek: Uint8Array | undefined
  try {
    const unwrapped = await callCustody(() =>
      custody.unwrapGenerationDek({
        keyId: first.key_id,
        generationId: manifest.archive_generation_id,
        wrappedDekId: first.wrapped_dek_id,
        wrappedDek: envelope.wrappedDek,
      }),
    )
    dek = unwrapped.dek
    const dekFingerprint = await callCustody(() =>
      custody.deriveDekFingerprint({
        keyId: first.key_id,
        dek: unwrapped.dek,
      }),
    )
    if (dekFingerprint !== first.dek_fingerprint) {
      fail('RECOVERY_ARCHIVE_READER_DEK_FINGERPRINT_MISMATCH')
    }

    const opened: Partial<Record<RecoveryArchiveSectionName, readonly RecoveryArchiveRowEnvelope[]>> =
      Object.create(null)
    for (let index = 0; index < RECOVERY_ARCHIVE_V1_SECTION_NAMES.length; index += 1) {
      const descriptor = manifest.sections[index]
      const expectedName = RECOVERY_ARCHIVE_V1_SECTION_NAMES[index]
      const objectBinding = sectionObjects[index]
      if (descriptor === undefined || expectedName === undefined || objectBinding === undefined) {
        fail('RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID')
      }
      const objectBytes = await readObjectBytes(store, objectBinding)
      const { ciphertext, authTag } = splitAuthTag(objectBytes)
      const nonce = callClosed(
        'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED',
        () => {
          assertRecoveryArchiveNonceHex(descriptor.nonce)
          return decodeHex(descriptor.nonce, 'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED')
        },
      )
      const plaintext = callClosed(
        'RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED',
        () =>
          openRecoveryArchiveSection({
            binding: {
              formatVersion: RECOVERY_ARCHIVE_FORMAT_VERSION,
              generationId: manifest.archive_generation_id,
              workspaceId: manifest.workspace_id,
              baseId: manifest.base_id,
              sheetId: manifest.sheet_id,
              anchorOperationId: manifest.anchor_operation_id,
              anchorSeq: manifest.anchor_seq,
              checkpointId: manifest.checkpoint_id,
              keyId: descriptor.key_id,
              wrappedDekId: descriptor.wrapped_dek_id,
              dekFingerprint: descriptor.dek_fingerprint,
              aeadAlgorithm: RECOVERY_ARCHIVE_AEAD_ALGORITHM,
              sectionName: descriptor.name,
              plaintextSha256: descriptor.plaintext_sha256,
            },
            dek: unwrapped.dek,
            nonce,
            ciphertext,
            authTag,
          }),
      )
      const rows = decodeCanonicalSectionRows(expectedName, plaintext, descriptor)
      opened[expectedName] = rows
    }

    return freezeOpenedSnapshot(manifest, opened as RecoveryArchiveOpenedSections)
  } finally {
    scrubRecoveryArchiveDek(dek)
  }
}

function admitSelectedBinding(value: unknown): RecoveryArchiveSelectedBinding {
  const admitted = snapshotExactRecord(
    value,
    SELECTED_BINDING_KEYS,
    'RECOVERY_ARCHIVE_READER_INVALID_INPUT',
  )
  for (const key of SELECTED_BINDING_KEYS) {
    if (typeof admitted[key] !== 'string' || admitted[key].length === 0) {
      fail('RECOVERY_ARCHIVE_READER_INVALID_INPUT')
    }
  }
  if (!isCanonicalNonnegativeDecimalString(admitted.anchorSeq)) {
    fail('RECOVERY_ARCHIVE_READER_INVALID_INPUT')
  }
  if (!isLowercaseSha256Hex(admitted.rootHash) || !isLowercaseSha256Hex(admitted.sourceVectorHash)) {
    fail('RECOVERY_ARCHIVE_READER_INVALID_INPUT')
  }
  return {
    generationId: String(admitted.generationId),
    workspaceId: String(admitted.workspaceId),
    baseId: String(admitted.baseId),
    sheetId: String(admitted.sheetId),
    anchorOperationId: String(admitted.anchorOperationId),
    anchorSeq: String(admitted.anchorSeq),
    checkpointId: String(admitted.checkpointId),
    rootHash: String(admitted.rootHash),
    sourceVectorHash: String(admitted.sourceVectorHash),
  }
}

function admitObjectBinding(value: unknown): RecoveryArchiveObjectExpectedBinding {
  const admitted = snapshotExactRecord(
    value,
    OBJECT_BINDING_KEYS,
    'RECOVERY_ARCHIVE_READER_INVALID_INPUT',
  )
  return {
    generationId: String(admitted.generationId),
    objectId: String(admitted.objectId),
    expectedVersion: String(admitted.expectedVersion),
    expectedSha256: String(admitted.expectedSha256),
    expectedSize: String(admitted.expectedSize),
    expectedExpiresAt: String(admitted.expectedExpiresAt),
  }
}

function admitSectionBindings(
  value: unknown,
  generationId: string,
): readonly RecoveryArchiveObjectExpectedBinding[] {
  const values = snapshotDenseArray(value, 'RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID')
  if (values.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length) {
    fail('RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID')
  }
  const seen = new Set<string>()
  const bindings: RecoveryArchiveObjectExpectedBinding[] = []
  for (const entry of values) {
    const binding = admitObjectBinding(entry)
    if (binding.generationId !== generationId || seen.has(binding.objectId)) {
      fail('RECOVERY_ARCHIVE_READER_SECTION_OBJECTS_INVALID')
    }
    seen.add(binding.objectId)
    bindings.push(binding)
  }
  return bindings
}

function assertAuthenticatedBinding(
  selected: RecoveryArchiveSelectedBinding,
  manifest: RecoveryArchiveManifest,
  first: RecoveryArchiveManifest['sections'][number],
): void {
  if (
    selected.generationId !== manifest.archive_generation_id ||
    selected.workspaceId !== manifest.workspace_id ||
    selected.baseId !== manifest.base_id ||
    selected.sheetId !== manifest.sheet_id ||
    selected.anchorOperationId !== manifest.anchor_operation_id ||
    selected.anchorSeq !== manifest.anchor_seq ||
    selected.checkpointId !== manifest.checkpoint_id ||
    selected.rootHash !== manifest.root_hash ||
    selected.sourceVectorHash !== manifest.source_vector_hash
  ) {
    fail('RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
  }
  for (const section of manifest.sections) {
    if (
      section.aead_algorithm !== first.aead_algorithm ||
      section.key_id !== first.key_id ||
      section.wrapped_dek_id !== first.wrapped_dek_id ||
      section.dek_fingerprint !== first.dek_fingerprint
    ) {
      fail('RECOVERY_ARCHIVE_READER_BINDING_MISMATCH')
    }
  }
}

async function readObjectBytes(
  store: ReturnType<typeof createTransactionGuardedRecoveryArchiveObjectStore>,
  binding: RecoveryArchiveObjectExpectedBinding,
): Promise<Uint8Array> {
  try {
    const result = await store.get(binding)
    return result.bytes
  } catch (error) {
    mapExternalError(error, 'RECOVERY_ARCHIVE_READER_OBJECT_STORE_FAILED')
  }
}

function splitAuthTag(objectBytes: Uint8Array): {
  ciphertext: Uint8Array
  authTag: Uint8Array
} {
  if (objectBytes.byteLength < RECOVERY_ARCHIVE_AEAD_TAG_BYTES) {
    fail('RECOVERY_ARCHIVE_READER_AUTH_TAG_INVALID')
  }
  return {
    ciphertext: objectBytes.slice(0, objectBytes.byteLength - RECOVERY_ARCHIVE_AEAD_TAG_BYTES),
    authTag: objectBytes.slice(objectBytes.byteLength - RECOVERY_ARCHIVE_AEAD_TAG_BYTES),
  }
}

function decodeCanonicalSectionRows(
  sectionName: RecoveryArchiveSectionName,
  plaintext: Uint8Array,
  descriptor: RecoveryArchiveManifest['sections'][number],
): readonly RecoveryArchiveRowEnvelope[] {
  let decoded: string
  try {
    decoded = utf8Decoder.decode(plaintext)
  } catch {
    fail('RECOVERY_ARCHIVE_READER_PLAINTEXT_INVALID')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    fail('RECOVERY_ARCHIVE_READER_PLAINTEXT_INVALID')
  }
  const canonical = callClosed(
    'RECOVERY_ARCHIVE_READER_PLAINTEXT_INVALID',
    () => canonicalizeRecoveryArchiveSectionRows(sectionName, parsed as RecoveryArchiveRowEnvelope[]),
  )
  if (
    canonical.rowCount !== descriptor.row_count ||
    canonical.plaintextSha256 !== descriptor.plaintext_sha256
  ) {
    fail('RECOVERY_ARCHIVE_READER_SECTION_INTEGRITY_MISMATCH')
  }
  try {
    return freezeRows(JSON.parse(canonical.canonicalJson) as RecoveryArchiveRowEnvelope[])
  } catch {
    fail('RECOVERY_ARCHIVE_READER_PLAINTEXT_INVALID')
  }
}

function freezeOpenedSnapshot(
  manifest: RecoveryArchiveManifest,
  sections: RecoveryArchiveOpenedSections,
): RecoveryArchiveOpenedSnapshot {
  const frozenSections = Object.create(null) as Record<
    RecoveryArchiveSectionName,
    readonly RecoveryArchiveRowEnvelope[]
  >
  for (const name of RECOVERY_ARCHIVE_V1_SECTION_NAMES) {
    frozenSections[name] = sections[name]
  }
  return Object.freeze({
    manifest: Object.freeze({
      ...manifest,
      sections: Object.freeze(manifest.sections.map((section) => Object.freeze({ ...section }))),
    }) as RecoveryArchiveManifest,
    sections: Object.freeze(frozenSections),
  })
}

function freezeRows(rows: readonly RecoveryArchiveRowEnvelope[]): readonly RecoveryArchiveRowEnvelope[] {
  return Object.freeze(rows.map((row) => freezeJson(row) as RecoveryArchiveRowEnvelope))
}

function freezeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeJson(item)))
  }
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    snapshot[key] = freezeJson((value as Record<string, unknown>)[key])
  }
  return Object.freeze(snapshot)
}

async function callCustody<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    mapExternalError(error, 'RECOVERY_ARCHIVE_READER_KEY_CUSTODY_FAILED')
  }
}

function mapExternalError(
  error: unknown,
  fallbackCode: RecoveryArchiveReaderErrorCode,
): never {
  const code = errorCodeOf(error)
  if (code === 'RECOVERY_ARCHIVE_CRYPTO_KEY_CUSTODY_CALL_IN_TRANSACTION') {
    fail('RECOVERY_ARCHIVE_READER_KEY_CUSTODY_IN_TRANSACTION')
  }
  if (
    code === 'RECOVERY_ARCHIVE_CRYPTO_INVALID_DEK_FINGERPRINT' ||
    code === 'RECOVERY_ARCHIVE_READER_DEK_FINGERPRINT_MISMATCH'
  ) {
    fail('RECOVERY_ARCHIVE_READER_DEK_FINGERPRINT_MISMATCH')
  }
  if (
    code === 'RECOVERY_ARCHIVE_CRYPTO_AEAD_OPEN_FAILED' ||
    code === 'RECOVERY_ARCHIVE_CRYPTO_INVALID_AAD_BINDING' ||
    code === 'RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_ENCODING' ||
    code === 'RECOVERY_ARCHIVE_CRYPTO_INVALID_NONCE_LENGTH' ||
    code === 'RECOVERY_ARCHIVE_CRYPTO_UNKNOWN_AEAD_ALGORITHM' ||
    code === 'RECOVERY_ARCHIVE_CRYPTO_INVALID_CIPHERTEXT' ||
    code === 'RECOVERY_ARCHIVE_CRYPTO_PLAINTEXT_DIGEST_MISMATCH'
  ) {
    fail('RECOVERY_ARCHIVE_READER_AEAD_OPEN_FAILED')
  }
  if (code === 'RECOVERY_ARCHIVE_CRYPTO_INVALID_AUTH_TAG_LENGTH') {
    fail('RECOVERY_ARCHIVE_READER_AUTH_TAG_INVALID')
  }
  if (
    error instanceof RecoveryArchiveManifestObjectEnvelopeError ||
    code?.startsWith('RECOVERY_ARCHIVE_MANIFEST_OBJECT_ENVELOPE_')
  ) {
    fail('RECOVERY_ARCHIVE_READER_ENVELOPE_INVALID')
  }
  if (code?.startsWith('RECOVERY_ARCHIVE_MANIFEST_')) {
    fail('RECOVERY_ARCHIVE_READER_PLAINTEXT_INVALID')
  }
  if (
    error instanceof RecoveryArchiveObjectStoreError ||
    code?.startsWith('RECOVERY_ARCHIVE_OBJECT_STORE_')
  ) {
    fail('RECOVERY_ARCHIVE_READER_OBJECT_STORE_FAILED')
  }
  if (error instanceof RecoveryArchiveReaderError) throw error
  if (error instanceof RecoveryArchiveCryptoError) {
    fail('RECOVERY_ARCHIVE_READER_KEY_CUSTODY_FAILED')
  }
  fail(fallbackCode)
}

function errorCodeOf(error: unknown): string | null {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  if (error instanceof Error) return error.message
  return null
}

function decodeHex(value: unknown, errorCode: RecoveryArchiveReaderErrorCode): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) {
    fail(errorCode)
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
  errorCode: RecoveryArchiveReaderErrorCode,
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
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail(errorCode)
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof RecoveryArchiveReaderError) throw error
    fail(errorCode)
  }
}

function snapshotDenseArray(
  value: unknown,
  errorCode: RecoveryArchiveReaderErrorCode,
): unknown[] {
  try {
    if (!Array.isArray(value)) fail(errorCode)
    const keys = Reflect.ownKeys(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      fail(errorCode)
    }
    const length = lengthDescriptor.value
    const items = new Array<unknown>(length)
    const seen = new Set<number>()
    for (const key of keys) {
      if (key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (
        descriptor === undefined ||
        typeof key === 'symbol' ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        fail(errorCode)
      }
      const index = Number(key)
      if (
        !Number.isInteger(index) ||
        String(index) !== key ||
        index < 0 ||
        index >= length ||
        seen.has(index)
      ) {
        fail(errorCode)
      }
      seen.add(index)
      items[index] = descriptor.value
    }
    if (seen.size !== length) fail(errorCode)
    return items
  } catch (error) {
    if (error instanceof RecoveryArchiveReaderError) throw error
    fail(errorCode)
  }
}

function callClosed<T>(errorCode: RecoveryArchiveReaderErrorCode, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof RecoveryArchiveReaderError) throw error
    mapExternalError(error, errorCode)
  }
}

function fail(code: RecoveryArchiveReaderErrorCode): never {
  throw new RecoveryArchiveReaderError(code)
}
