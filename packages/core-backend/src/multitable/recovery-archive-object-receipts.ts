/**
 * Phase D2 receipt authority only. External PUT/HEAD calls happen before these helpers are entered;
 * both helpers accept an existing database query capability and perform no provider or KMS I/O.
 */

import {
  assertCanonicalNonnegativeDecimalString,
  assertLowercaseSha256Hex,
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from './recovery-archive-contract'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OPAQUE_OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/
const OPAQUE_TOKEN_PATTERN = /^[\x21-\x7e]{1,512}$/

export const RECOVERY_ARCHIVE_OBJECT_CLASSES = ['section', 'attachment', 'manifest'] as const
export const RECOVERY_ARCHIVE_OBJECT_RECEIPT_STATES = ['uploaded', 'verified'] as const

export type RecoveryArchiveObjectClass = (typeof RECOVERY_ARCHIVE_OBJECT_CLASSES)[number]
export type RecoveryArchiveObjectReceiptState = (typeof RECOVERY_ARCHIVE_OBJECT_RECEIPT_STATES)[number]

export type RecoveryArchiveObjectReceiptQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type RecoveryArchiveObjectReceiptErrorCode =
  | 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_NOT_IN_TRANSACTION'
  | 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED'
  | 'RECOVERY_ARCHIVE_OBJECT_RECEIPT_STALE'

export class RecoveryArchiveObjectReceiptError extends Error {
  readonly code: RecoveryArchiveObjectReceiptErrorCode

  constructor(code: RecoveryArchiveObjectReceiptErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveObjectReceiptError'
    this.code = code
  }
}

interface RecoveryArchiveObjectReceiptIdentity {
  generationId: string
  objectId: string
  objectClass: RecoveryArchiveObjectClass
  sectionName: RecoveryArchiveSectionName | null
  attachmentId: string | null
}

export interface RecoveryArchiveObjectReceiptEvidence extends RecoveryArchiveObjectReceiptIdentity {
  keyId: string
  providerVersion: string
  plaintextSha256: string
  ciphertextSha256: string
  sizeBytes: string
  idempotencyKey: string
  putReceiptSha256: string
  headReceiptSha256: string
  ownerKind: string
  ownerId: string
  ownerFence: string
}

export interface RecoveryArchiveObjectReceiptResult extends RecoveryArchiveObjectReceiptIdentity {
  state: RecoveryArchiveObjectReceiptState
}

function fail(code: RecoveryArchiveObjectReceiptErrorCode): never {
  throw new RecoveryArchiveObjectReceiptError(code)
}

function assertOpaqueToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !OPAQUE_TOKEN_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT')
  }
}

function normalizeEvidence(input: RecoveryArchiveObjectReceiptEvidence): RecoveryArchiveObjectReceiptEvidence {
  let candidate: RecoveryArchiveObjectReceiptEvidence
  try {
    candidate = {
      generationId: input.generationId,
      objectId: input.objectId,
      objectClass: input.objectClass,
      sectionName: input.sectionName,
      attachmentId: input.attachmentId,
      keyId: input.keyId,
      providerVersion: input.providerVersion,
      plaintextSha256: input.plaintextSha256,
      ciphertextSha256: input.ciphertextSha256,
      sizeBytes: input.sizeBytes,
      idempotencyKey: input.idempotencyKey,
      putReceiptSha256: input.putReceiptSha256,
      headReceiptSha256: input.headReceiptSha256,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      ownerFence: input.ownerFence,
    }
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT')
  }

  try {
    assertLowercaseSha256Hex(candidate.plaintextSha256)
    assertLowercaseSha256Hex(candidate.ciphertextSha256)
    assertLowercaseSha256Hex(candidate.idempotencyKey)
    assertLowercaseSha256Hex(candidate.putReceiptSha256)
    assertLowercaseSha256Hex(candidate.headReceiptSha256)
    assertCanonicalNonnegativeDecimalString(candidate.sizeBytes)
    assertCanonicalNonnegativeDecimalString(candidate.ownerFence)
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT')
  }

  if (
    !UUID_PATTERN.test(candidate.generationId) ||
    !OPAQUE_OBJECT_ID_PATTERN.test(candidate.objectId) ||
    !RECOVERY_ARCHIVE_OBJECT_CLASSES.includes(candidate.objectClass)
  ) {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT')
  }

  assertOpaqueToken(candidate.keyId)
  assertOpaqueToken(candidate.providerVersion)
  assertOpaqueToken(candidate.ownerKind)
  assertOpaqueToken(candidate.ownerId)
  if (candidate.ownerFence === '0') fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT')

  if (candidate.objectClass === 'section') {
    if (
      candidate.attachmentId !== null ||
      candidate.sectionName === null ||
      !RECOVERY_ARCHIVE_V1_SECTION_NAMES.includes(candidate.sectionName)
    ) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT')
    }
    return candidate
  }

  if (candidate.objectClass === 'attachment') {
    if (candidate.sectionName !== null || candidate.attachmentId === null) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT')
    }
    assertOpaqueToken(candidate.attachmentId)
    return candidate
  }

  if (candidate.sectionName !== null || candidate.attachmentId !== null) {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_INVALID_INPUT')
  }
  return candidate
}

function normalizeResult(
  row: unknown,
  input: RecoveryArchiveObjectReceiptEvidence,
): RecoveryArchiveObjectReceiptResult {
  try {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED')
    }
    const candidate = row as Record<string, unknown>
    if (
      candidate.generation_id !== input.generationId ||
      candidate.object_id !== input.objectId ||
      candidate.object_class !== input.objectClass ||
      candidate.section_name !== input.sectionName ||
      candidate.attachment_id !== input.attachmentId ||
      !RECOVERY_ARCHIVE_OBJECT_RECEIPT_STATES.includes(
        candidate.state as RecoveryArchiveObjectReceiptState,
      )
    ) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED')
    }
    return {
      generationId: input.generationId,
      objectId: input.objectId,
      objectClass: input.objectClass,
      sectionName: input.sectionName,
      attachmentId: input.attachmentId,
      state: candidate.state as RecoveryArchiveObjectReceiptState,
    }
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED')
  }
}

async function queryOne(
  query: RecoveryArchiveObjectReceiptQuery,
  sqlText: string,
  params: unknown[],
  emptyCode: RecoveryArchiveObjectReceiptErrorCode,
  input: RecoveryArchiveObjectReceiptEvidence,
): Promise<RecoveryArchiveObjectReceiptResult> {
  let result: Awaited<ReturnType<RecoveryArchiveObjectReceiptQuery>>
  try {
    result = await query(sqlText, params)
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED')
  }

  let row: unknown
  let hasExactlyOneRow = false
  try {
    hasExactlyOneRow = result.rowCount === 1 && Array.isArray(result.rows) && result.rows.length === 1
    if (hasExactlyOneRow) {
      row = result.rows[0]
    }
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED')
  }
  if (!hasExactlyOneRow) fail(emptyCode)
  return normalizeResult(row, input)
}

async function assertStableTransaction(query: RecoveryArchiveObjectReceiptQuery): Promise<void> {
  let first: Awaited<ReturnType<RecoveryArchiveObjectReceiptQuery>>
  let second: Awaited<ReturnType<RecoveryArchiveObjectReceiptQuery>>
  try {
    first = await query('SELECT pg_current_xact_id()::text AS xid')
    second = await query('SELECT pg_current_xact_id()::text AS xid')
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_NOT_IN_TRANSACTION')
  }

  try {
    const firstXid = (first.rows[0] as { xid?: unknown } | undefined)?.xid
    const secondXid = (second.rows[0] as { xid?: unknown } | undefined)?.xid
    if (
      first.rowCount !== 1 ||
      second.rowCount !== 1 ||
      typeof firstXid !== 'string' ||
      firstXid.length === 0 ||
      secondXid !== firstXid
    ) {
      fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_NOT_IN_TRANSACTION')
    }
  } catch {
    fail('RECOVERY_ARCHIVE_OBJECT_RECEIPT_NOT_IN_TRANSACTION')
  }
}

const RECORD_UPLOADED_SQL = `WITH inserted AS (
  INSERT INTO meta_recovery_archive_objects (
    generation_id, object_id, object_class, section_name, attachment_id,
    key_id, provider_version, plaintext_sha256, ciphertext_sha256, size_bytes,
    idempotency_key, put_receipt_sha256, head_receipt_sha256,
    owner_kind, owner_id, owner_fence, state
  ) VALUES (
    $1::uuid, $2, $3, $4, $5,
    $6, $7, $8, $9, $10::bigint,
    $11, $12, $13,
    $14, $15, $16::bigint, 'uploaded'
  )
  ON CONFLICT DO NOTHING
  RETURNING generation_id::text, object_id, object_class, section_name, attachment_id, state
), existing AS (
  SELECT generation_id::text, object_id, object_class, section_name, attachment_id, state
    FROM meta_recovery_archive_objects
   WHERE generation_id = $1::uuid
     AND object_id = $2
     AND object_class = $3
     AND section_name IS NOT DISTINCT FROM $4::text
     AND attachment_id IS NOT DISTINCT FROM $5::text
     AND key_id = $6
     AND provider_version = $7
     AND plaintext_sha256 = $8
     AND ciphertext_sha256 = $9
     AND size_bytes = $10::bigint
     AND idempotency_key = $11
     AND put_receipt_sha256 = $12
     AND head_receipt_sha256 = $13
     AND owner_kind = $14
     AND owner_id = $15
     AND owner_fence = $16::bigint
     AND state IN ('uploaded', 'verified')
)
SELECT * FROM inserted
UNION ALL
SELECT * FROM existing WHERE NOT EXISTS (SELECT 1 FROM inserted)
LIMIT 1`

const VERIFY_RECEIPT_SQL = `WITH updated AS (
  UPDATE meta_recovery_archive_objects
     SET state = 'verified', verified_at = clock_timestamp()
   WHERE generation_id = $1::uuid
     AND object_id = $2
     AND object_class = $3
     AND section_name IS NOT DISTINCT FROM $4::text
     AND attachment_id IS NOT DISTINCT FROM $5::text
     AND key_id = $6
     AND provider_version = $7
     AND plaintext_sha256 = $8
     AND ciphertext_sha256 = $9
     AND size_bytes = $10::bigint
     AND idempotency_key = $11
     AND put_receipt_sha256 = $12
     AND head_receipt_sha256 = $13
     AND owner_kind = $14
     AND owner_id = $15
     AND owner_fence = $16::bigint
     AND state = 'uploaded'
  RETURNING generation_id::text, object_id, object_class, section_name, attachment_id, state
), existing AS (
  SELECT generation_id::text, object_id, object_class, section_name, attachment_id, state
    FROM meta_recovery_archive_objects
   WHERE generation_id = $1::uuid
     AND object_id = $2
     AND object_class = $3
     AND section_name IS NOT DISTINCT FROM $4::text
     AND attachment_id IS NOT DISTINCT FROM $5::text
     AND key_id = $6
     AND provider_version = $7
     AND plaintext_sha256 = $8
     AND ciphertext_sha256 = $9
     AND size_bytes = $10::bigint
     AND idempotency_key = $11
     AND put_receipt_sha256 = $12
     AND head_receipt_sha256 = $13
     AND owner_kind = $14
     AND owner_id = $15
     AND owner_fence = $16::bigint
     AND state = 'verified'
)
SELECT * FROM updated
UNION ALL
SELECT * FROM existing WHERE NOT EXISTS (SELECT 1 FROM updated)
LIMIT 1`

function evidenceParams(input: RecoveryArchiveObjectReceiptEvidence): unknown[] {
  return [
    input.generationId,
    input.objectId,
    input.objectClass,
    input.sectionName,
    input.attachmentId,
    input.keyId,
    input.providerVersion,
    input.plaintextSha256,
    input.ciphertextSha256,
    input.sizeBytes,
    input.idempotencyKey,
    input.putReceiptSha256,
    input.headReceiptSha256,
    input.ownerKind,
    input.ownerId,
    input.ownerFence,
  ]
}

/** Records already-completed external PUT and HEAD evidence as an immutable uploaded row. */
export async function recordRecoveryArchiveObjectUploaded(
  query: RecoveryArchiveObjectReceiptQuery,
  input: RecoveryArchiveObjectReceiptEvidence,
): Promise<RecoveryArchiveObjectReceiptResult> {
  const evidence = normalizeEvidence(input)
  return queryOne(
    query,
    RECORD_UPLOADED_SQL,
    evidenceParams(evidence),
    'RECOVERY_ARCHIVE_OBJECT_RECEIPT_WRITE_REFUSED',
    evidence,
  )
}

/**
 * Promotes one uploaded row only when every immutable PUT/HEAD field and the current owner tuple
 * still match. The caller must retain this transaction through the parent finalize transition; the
 * database trigger independently rechecks the parent lease and source pin at COMMIT.
 */
export async function verifyRecoveryArchiveObjectReceipt(
  query: RecoveryArchiveObjectReceiptQuery,
  input: RecoveryArchiveObjectReceiptEvidence,
): Promise<RecoveryArchiveObjectReceiptResult> {
  const evidence = normalizeEvidence(input)
  await assertStableTransaction(query)
  return queryOne(
    query,
    VERIFY_RECEIPT_SQL,
    evidenceParams(evidence),
    'RECOVERY_ARCHIVE_OBJECT_RECEIPT_STALE',
    evidence,
  )
}
