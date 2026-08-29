/**
 * Time Machine Phase D-H2 only: pure/out-of-transaction upload-and-receipt compiler.
 *
 * This module has no production caller. It takes one immutable archive object, performs the
 * external PUT-then-HEAD pair through the existing transaction-guarded object store, and returns
 * one fully normalized RecoveryArchiveObjectReceiptEvidence for the DB receipt authority. It never
 * writes the database: the evidence is handed to `recordRecoveryArchiveObjectUploaded`, which owns
 * the authoritative transaction.
 *
 * Every input is validated and snapshotted synchronously BEFORE the first await, so a caller
 * mutating its own request after invocation cannot change what is uploaded or attested. The
 * returned evidence is derived only from that validated snapshot, never from caller or provider
 * aliases; provider results are checked for exact immutable binding by the guarded store and are
 * otherwise not trusted. No provider receipt bytes or URLs are invented here: this backend-neutral
 * boundary attests only the normalized provider descriptor.
 */

import { createHash } from 'node:crypto'

import {
  isCanonicalNonnegativeDecimalString,
  isLowercaseSha256Hex,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from './recovery-archive-contract'
import {
  isRecoveryArchiveUtcTimestamp,
  type RecoveryArchiveTransactionDepthProbe,
} from './recovery-archive-crypto'
import {
  createTransactionGuardedRecoveryArchiveObjectStore,
  RecoveryArchiveObjectStoreError,
  type RecoveryArchiveObjectPutRequest,
  type RecoveryArchiveObjectStoreProvider,
} from './recovery-archive-object-store'
import {
  RECOVERY_ARCHIVE_OBJECT_CLASSES,
  type RecoveryArchiveObjectClass,
  type RecoveryArchiveObjectReceiptEvidence,
} from './recovery-archive-object-receipts'

const RECOVERY_ARCHIVE_GENERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RECOVERY_ARCHIVE_OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/
const RECOVERY_ARCHIVE_OPAQUE_TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/

/**
 * Domain separators for the three derived digests. They are part of the attested binding, so
 * changing one is a receipt contract change, not a rename. The PUT and HEAD domains deliberately
 * differ so the two receipt digests can never collide for the same binding.
 */
const RECOVERY_ARCHIVE_RECEIPT_IDEMPOTENCY_DOMAIN =
  'metasheet.recovery-archive.object-receipt.idempotency.v1' as const
const RECOVERY_ARCHIVE_RECEIPT_PUT_DOMAIN =
  'metasheet.recovery-archive.object-receipt.put.v1' as const
const RECOVERY_ARCHIVE_RECEIPT_HEAD_DOMAIN =
  'metasheet.recovery-archive.object-receipt.head.v1' as const

const RECOVERY_ARCHIVE_FIELD_TAG_NULL = 0x00
const RECOVERY_ARCHIVE_FIELD_TAG_STRING = 0x01

export type RecoveryArchiveObjectReceiptCompilerErrorCode =
  | 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_TRANSACTION_REFUSED'
  | 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_PROVIDER_FAILED'

/**
 * Values-free failure surface. `message` is the closed code itself and nothing else: no input
 * value, descriptor field, provider text, host detail, or `cause` chain ever reaches a caller or a
 * log through this class.
 */
export class RecoveryArchiveObjectReceiptCompilerError extends Error {
  readonly code: RecoveryArchiveObjectReceiptCompilerErrorCode

  constructor(code: RecoveryArchiveObjectReceiptCompilerErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveObjectReceiptCompilerError'
    this.code = code
  }
}

/**
 * Closed exact-shape input boundary. `provider` and `transactionDepth` must be own DATA properties;
 * they are handed to the existing guarded object-store constructor, which re-checks transaction
 * depth before each of PUT and HEAD independently.
 */
export interface RecoveryArchiveObjectReceiptCompileInput {
  provider: RecoveryArchiveObjectStoreProvider
  transactionDepth: RecoveryArchiveTransactionDepthProbe
  /** Immutable object bytes plus their exact descriptor binding. */
  object: RecoveryArchiveObjectPutRequest
  objectClass: RecoveryArchiveObjectClass
  sectionName: RecoveryArchiveSectionName | null
  attachmentId: string | null
  keyId: string
  plaintextSha256: string
  ownerKind: string
  ownerId: string
  ownerFence: string
}

const COMPILE_INPUT_KEYS = [
  'attachmentId',
  'keyId',
  'object',
  'objectClass',
  'ownerFence',
  'ownerId',
  'ownerKind',
  'plaintextSha256',
  'provider',
  'sectionName',
  'transactionDepth',
] as const

const COMPILE_OBJECT_KEYS = [
  'bytes',
  'expiresAt',
  'generationId',
  'objectId',
  'pinned',
  'sha256',
  'size',
  'version',
] as const

function fail(code: RecoveryArchiveObjectReceiptCompilerErrorCode): never {
  throw new RecoveryArchiveObjectReceiptCompilerError(code)
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  } catch {
    return false
  }
}

/**
 * Read an exact own-data-property key set. Extra, missing, sparse, or accessor properties refuse;
 * a Proxy reflection failure normalizes to the same closed refusal without invoking user code.
 */
function readExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!isObjectLike(value)) fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.some((key) => typeof key !== 'string')) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
    }
    const actualKeys = (ownKeys as string[]).sort()
    const expectedKeys = [...keys].sort()
    if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
    }
    const result: Record<string, unknown> = {}
    for (const key of expectedKeys) {
      const descriptor = descriptors[key]
      if (!descriptor || !('value' in descriptor)) fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
      result[key] = descriptor.value
    }
    return result
  } catch (error) {
    if (error instanceof RecoveryArchiveObjectReceiptCompilerError) throw error
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
  }
}

function copyBytes(value: unknown): Uint8Array {
  try {
    if (value instanceof Uint8Array) return new Uint8Array(value)
  } catch {
    // Normalize hostile typed-array proxies below.
  }
  fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
}

function isOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && RECOVERY_ARCHIVE_OPAQUE_TOKEN_PATTERN.test(value)
}

interface NormalizedCompileInput {
  provider: RecoveryArchiveObjectStoreProvider
  transactionDepth: RecoveryArchiveTransactionDepthProbe
  object: RecoveryArchiveObjectPutRequest
  objectClass: RecoveryArchiveObjectClass
  sectionName: RecoveryArchiveSectionName | null
  attachmentId: string | null
  keyId: string
  plaintextSha256: string
  ownerKind: string
  ownerId: string
  ownerFence: string
}

/**
 * Validate and snapshot the closed input synchronously. Shape rules mirror the existing receipt
 * authority exactly so any evidence this compiler returns is admissible there: canonical v1
 * section + null attachment for `section`, null section + nonblank opaque attachment id for
 * `attachment`, both null for `manifest`, lowercase hex digests, canonical decimal sizes/fences,
 * opaque owner/key tokens, and a nonzero owner fence.
 */
function normalizeCompileInput(input: RecoveryArchiveObjectReceiptCompileInput): NormalizedCompileInput {
  const read = readExactRecord(input, COMPILE_INPUT_KEYS)
  if (!isObjectLike(read.provider) || !isObjectLike(read.transactionDepth)) {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
  }

  const objectRead = readExactRecord(read.object, COMPILE_OBJECT_KEYS)
  const generationId = objectRead.generationId
  const objectId = objectRead.objectId
  const version = objectRead.version
  const sha256 = objectRead.sha256
  const size = objectRead.size
  const expiresAt = objectRead.expiresAt
  const pinned = objectRead.pinned
  const objectClass = read.objectClass
  const sectionName = read.sectionName
  const attachmentId = read.attachmentId
  const keyId = read.keyId
  const plaintextSha256 = read.plaintextSha256
  const ownerKind = read.ownerKind
  const ownerId = read.ownerId
  const ownerFence = read.ownerFence

  if (
    typeof generationId !== 'string' ||
    !RECOVERY_ARCHIVE_GENERATION_ID_PATTERN.test(generationId) ||
    typeof objectId !== 'string' ||
    !RECOVERY_ARCHIVE_OBJECT_ID_PATTERN.test(objectId) ||
    !isOpaqueToken(version) ||
    !isLowercaseSha256Hex(sha256) ||
    !isCanonicalNonnegativeDecimalString(size) ||
    typeof expiresAt !== 'string' ||
    !isRecoveryArchiveUtcTimestamp(expiresAt) ||
    typeof pinned !== 'boolean' ||
    typeof objectClass !== 'string' ||
    !(RECOVERY_ARCHIVE_OBJECT_CLASSES as readonly string[]).includes(objectClass) ||
    !isOpaqueToken(keyId) ||
    !isLowercaseSha256Hex(plaintextSha256) ||
    !isOpaqueToken(ownerKind) ||
    !isOpaqueToken(ownerId) ||
    !isCanonicalNonnegativeDecimalString(ownerFence) ||
    ownerFence === '0'
  ) {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
  }

  const bytes = copyBytes(objectRead.bytes)
  if (createHash('sha256').update(bytes).digest('hex') !== sha256 || String(bytes.byteLength) !== size) {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
  }

  let validSectionName: RecoveryArchiveSectionName | null = null
  let validAttachmentId: string | null = null
  if (objectClass === 'section') {
    if (
      attachmentId !== null ||
      typeof sectionName !== 'string' ||
      !(RECOVERY_ARCHIVE_V1_SECTION_NAMES as readonly string[]).includes(sectionName)
    ) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
    }
    validSectionName = sectionName as RecoveryArchiveSectionName
  } else if (objectClass === 'attachment') {
    if (sectionName !== null || !isOpaqueToken(attachmentId)) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
    }
    validAttachmentId = attachmentId
  } else if (sectionName !== null || attachmentId !== null) {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_INVALID_INPUT')
  }

  return {
    provider: read.provider as unknown as RecoveryArchiveObjectStoreProvider,
    transactionDepth: read.transactionDepth as unknown as RecoveryArchiveTransactionDepthProbe,
    object: {
      generationId,
      objectId,
      version,
      sha256,
      size,
      expiresAt,
      pinned,
      bytes,
    },
    objectClass: objectClass as RecoveryArchiveObjectClass,
    sectionName: validSectionName,
    attachmentId: validAttachmentId,
    keyId,
    plaintextSha256,
    ownerKind,
    ownerId,
    ownerFence,
  }
}

/**
 * Run one guarded-store verb and normalize its failure. Only the store's own transaction-depth
 * refusals map to the transaction code; every provider throw - including a typed-looking hostile
 * one - has already been flattened by the guarded store and maps to the provider code.
 */
async function callStore<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    let code: unknown
    try {
      code = error instanceof RecoveryArchiveObjectStoreError ? error.code : undefined
    } catch {
      code = undefined
    }
    if (
      code === 'RECOVERY_ARCHIVE_OBJECT_STORE_TRANSACTION_DEPTH_UNKNOWN' ||
      code === 'RECOVERY_ARCHIVE_OBJECT_STORE_CALL_IN_TRANSACTION'
    ) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_TRANSACTION_REFUSED')
    }
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_PROVIDER_FAILED')
  }
}

function encodeField(field: string | null): Buffer {
  if (field === null) {
    return Buffer.concat([Buffer.from([RECOVERY_ARCHIVE_FIELD_TAG_NULL]), uint32(0)])
  }
  const bytes = Buffer.from(field, 'utf8')
  return Buffer.concat([Buffer.from([RECOVERY_ARCHIVE_FIELD_TAG_STRING]), uint32(bytes.length), bytes])
}

function uint32(value: number): Buffer {
  const prefix = Buffer.allocUnsafe(4)
  prefix.writeUInt32BE(value, 0)
  return prefix
}

/**
 * Domain-separated, length-prefixed, type-tagged canonical encoding. A NULL classification field
 * is unreachable by any string, so `section`/`attachment`/`manifest` preimages can never collide.
 */
function digestFields(domain: string, fields: readonly (string | null)[]): string {
  const parts: Buffer[] = [encodeField(domain), uint32(fields.length)]
  for (const field of fields) parts.push(encodeField(field))
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex')
}

/**
 * Immutable object identity/binding/classification fields, in a fixed order. Owner kind/id/fence
 * are deliberately EXCLUDED from every digest: an owner/fence takeover reuses the same object
 * idempotency key. The PUT outcome is likewise excluded, so a retry that observes `existing`
 * returns byte-identical evidence.
 */
function bindingFields(snapshot: NormalizedCompileInput): readonly (string | null)[] {
  return [
    snapshot.object.generationId,
    snapshot.object.objectId,
    snapshot.object.version,
    snapshot.object.sha256,
    snapshot.object.size,
    snapshot.object.expiresAt,
    String(snapshot.object.pinned),
    snapshot.keyId,
    snapshot.plaintextSha256,
    snapshot.objectClass,
    snapshot.sectionName,
    snapshot.attachmentId,
  ]
}

/**
 * Upload one immutable archive object (PUT then HEAD, each independently transaction-guarded) and
 * compile the normalized receipt evidence for the DB receipt authority. HEAD returning null,
 * drifting from the exact expected binding, or throwing fails closed. The returned frozen object
 * carries only the validated immutable snapshot and derived digests - never caller or provider
 * aliases, never provider receipt bytes or URLs.
 */
export async function compileRecoveryArchiveObjectReceipt(
  input: RecoveryArchiveObjectReceiptCompileInput,
): Promise<RecoveryArchiveObjectReceiptEvidence> {
  const snapshot = normalizeCompileInput(input)
  const store = createTransactionGuardedRecoveryArchiveObjectStore(snapshot.provider, snapshot.transactionDepth)

  await callStore(() =>
    store.put({
      generationId: snapshot.object.generationId,
      objectId: snapshot.object.objectId,
      version: snapshot.object.version,
      sha256: snapshot.object.sha256,
      size: snapshot.object.size,
      expiresAt: snapshot.object.expiresAt,
      pinned: snapshot.object.pinned,
      bytes: new Uint8Array(snapshot.object.bytes),
    }),
  )

  const head = await callStore(() =>
    store.head({
      generationId: snapshot.object.generationId,
      objectId: snapshot.object.objectId,
      expectedVersion: snapshot.object.version,
      expectedSha256: snapshot.object.sha256,
      expectedSize: snapshot.object.size,
      expectedExpiresAt: snapshot.object.expiresAt,
    }),
  )
  if (head === null) fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_PROVIDER_FAILED')
  if (head.pinned !== snapshot.object.pinned) {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_COMPILER_PROVIDER_FAILED')
  }

  const fields = bindingFields(snapshot)
  return Object.freeze({
    generationId: snapshot.object.generationId,
    objectId: snapshot.object.objectId,
    objectClass: snapshot.objectClass,
    sectionName: snapshot.sectionName,
    attachmentId: snapshot.attachmentId,
    keyId: snapshot.keyId,
    providerVersion: snapshot.object.version,
    plaintextSha256: snapshot.plaintextSha256,
    ciphertextSha256: snapshot.object.sha256,
    sizeBytes: snapshot.object.size,
    idempotencyKey: digestFields(RECOVERY_ARCHIVE_RECEIPT_IDEMPOTENCY_DOMAIN, fields),
    putReceiptSha256: digestFields(RECOVERY_ARCHIVE_RECEIPT_PUT_DOMAIN, fields),
    headReceiptSha256: digestFields(RECOVERY_ARCHIVE_RECEIPT_HEAD_DOMAIN, fields),
    ownerKind: snapshot.ownerKind,
    ownerId: snapshot.ownerId,
    ownerFence: snapshot.ownerFence,
  })
}
