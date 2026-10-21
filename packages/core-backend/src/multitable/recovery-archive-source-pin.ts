import type { FenceQuery } from './canonical-sheet-fence'

export type RecoveryArchiveSourcePinOwner = {
  keyId: string
  ownerKind: string
  ownerId: string
  ownerFence: string
  leaseUntil: string
}

export type RecoveryArchiveSourcePinIntentInput = RecoveryArchiveSourcePinOwner & {
  generationId: string
  attachmentId: string
}

export type RecoveryArchiveSourcePinVerificationInput = RecoveryArchiveSourcePinIntentInput & {
  immutableVersion: string
  contentSha256: string
  contentSizeBytes: string
}

export type RecoveryArchiveSourcePinSnapshot = {
  generationId: string
  attachmentId: string
  availability: 'mutable' | 'available'
  ownerKind: string
  ownerId: string
  ownerFence: string
  leaseUntil: string
  immutableVersion: string | null
  contentSha256: string | null
  contentSizeBytes: string | null
}

export type RecoveryArchiveSourcePinErrorCode =
  | 'RECOVERY_ARCHIVE_SOURCE_PIN_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_SOURCE_PIN_NOT_IN_TRANSACTION'
  | 'RECOVERY_ARCHIVE_SOURCE_PIN_CLAIM_REFUSED'
  | 'RECOVERY_ARCHIVE_SOURCE_PIN_VERIFICATION_REFUSED'
  | 'RECOVERY_ARCHIVE_SOURCE_PIN_RESULT_INVALID'

export class RecoveryArchiveSourcePinError extends Error {
  readonly code: RecoveryArchiveSourcePinErrorCode

  constructor(code: RecoveryArchiveSourcePinErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSourcePinError'
    this.code = code
  }
}

const CLAIM_SOURCE_PIN_SQL = `WITH locked_generation AS (
  SELECT archive.generation_id
    FROM public.meta_recovery_archives archive
   WHERE archive.generation_id = $1::uuid
     AND archive.state = 'building'
     AND archive.build_status = 'active'
     AND archive.coverage_status = 'incomplete'
     AND archive.key_id = $7
     AND archive.owner_kind = $3
     AND archive.owner_id = $4
     AND archive.owner_fence = $5::bigint
     AND archive.lease_expires_at = $6::timestamptz
     AND archive.lease_expires_at > clock_timestamp()
   FOR UPDATE
)
INSERT INTO public.meta_recovery_archive_attachment_refs (
  generation_id,
  attachment_id,
  reference_class,
  reference_state,
  availability,
  content_sha256,
  source_owner_kind,
  source_owner_id,
  source_owner_fence,
  source_lease_until,
  immutable_version,
  content_size_bytes
)
SELECT locked_generation.generation_id,
       $2,
       'source',
       'building',
       'mutable',
       NULL,
       $3,
       $4,
       $5::bigint,
       $6::timestamptz,
       NULL,
       NULL
  FROM locked_generation
RETURNING generation_id::text AS generation_id,
          attachment_id,
          availability,
          source_owner_kind AS owner_kind,
          source_owner_id AS owner_id,
          source_owner_fence::text AS owner_fence,
          source_lease_until::text AS lease_until,
          immutable_version,
          content_sha256,
          content_size_bytes::text AS content_size_bytes`

const VERIFY_SOURCE_PIN_SQL = `WITH locked_generation AS (
  SELECT archive.generation_id
    FROM public.meta_recovery_archives archive
   WHERE archive.generation_id = $1::uuid
     AND archive.state = 'building'
     AND archive.build_status = 'active'
     AND archive.coverage_status = 'incomplete'
     AND archive.key_id = $10
     AND archive.owner_kind = $3
     AND archive.owner_id = $4
     AND archive.owner_fence = $5::bigint
     AND archive.lease_expires_at = $6::timestamptz
     AND archive.lease_expires_at > clock_timestamp()
   FOR UPDATE
)
UPDATE public.meta_recovery_archive_attachment_refs source_pin
   SET availability = 'available',
       immutable_version = $7,
       content_sha256 = $8,
       content_size_bytes = $9::bigint,
       updated_at = clock_timestamp()
  FROM locked_generation
 WHERE source_pin.generation_id = locked_generation.generation_id
   AND source_pin.attachment_id = $2
   AND source_pin.reference_class = 'source'
   AND source_pin.reference_state = 'building'
   AND source_pin.availability = 'mutable'
   AND source_pin.content_sha256 IS NULL
   AND source_pin.immutable_version IS NULL
   AND source_pin.content_size_bytes IS NULL
   AND source_pin.source_owner_kind = $3
   AND source_pin.source_owner_id = $4
   AND source_pin.source_owner_fence = $5::bigint
   AND source_pin.source_lease_until = $6::timestamptz
RETURNING source_pin.generation_id::text AS generation_id,
          source_pin.attachment_id,
          source_pin.availability,
          source_pin.source_owner_kind AS owner_kind,
          source_pin.source_owner_id AS owner_id,
          source_pin.source_owner_fence::text AS owner_fence,
          source_pin.source_lease_until::text AS lease_until,
          source_pin.immutable_version,
          source_pin.content_sha256,
          source_pin.content_size_bytes::text AS content_size_bytes`

function invalidInput(): never {
  throw new RecoveryArchiveSourcePinError('RECOVERY_ARCHIVE_SOURCE_PIN_INVALID_INPUT')
}

function requireOpaque(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalidInput()
  return value
}

function requireFence(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) invalidInput()
  return value
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalidInput()
  if (Number.isNaN(new Date(value).getTime())) invalidInput()
  return value
}

function requireHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalidInput()
  return value
}

function requireSize(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) invalidInput()
  return value
}

function validateOwner(input: RecoveryArchiveSourcePinOwner): RecoveryArchiveSourcePinOwner {
  return {
    keyId: requireOpaque(input.keyId),
    ownerKind: requireOpaque(input.ownerKind),
    ownerId: requireOpaque(input.ownerId),
    ownerFence: requireFence(input.ownerFence),
    leaseUntil: requireTimestamp(input.leaseUntil),
  }
}

function snapshotFromRow(row: unknown): RecoveryArchiveSourcePinSnapshot | null {
  if (!row || typeof row !== 'object') return null
  const value = row as Record<string, unknown>
  if (value.availability !== 'mutable' && value.availability !== 'available') return null
  if (typeof value.generation_id !== 'string' || typeof value.attachment_id !== 'string') return null
  if (typeof value.owner_kind !== 'string' || typeof value.owner_id !== 'string') return null
  if (typeof value.owner_fence !== 'string' || !/^[1-9][0-9]*$/.test(value.owner_fence)) return null
  if (typeof value.lease_until !== 'string') return null
  if (value.immutable_version !== null && typeof value.immutable_version !== 'string') return null
  if (value.content_sha256 !== null && typeof value.content_sha256 !== 'string') return null
  if (value.content_size_bytes !== null && typeof value.content_size_bytes !== 'string') return null
  const immutableVersion = typeof value.immutable_version === 'string' ? value.immutable_version : null
  const contentSha256 = typeof value.content_sha256 === 'string' ? value.content_sha256 : null
  const contentSizeBytes = typeof value.content_size_bytes === 'string'
    ? value.content_size_bytes
    : null
  return {
    generationId: value.generation_id,
    attachmentId: value.attachment_id,
    availability: value.availability,
    ownerKind: value.owner_kind,
    ownerId: value.owner_id,
    ownerFence: value.owner_fence,
    leaseUntil: value.lease_until,
    immutableVersion,
    contentSha256,
    contentSizeBytes,
  }
}

async function oneRow(
  query: FenceQuery,
  sqlText: string,
  params: unknown[],
  keyId: string,
  refusedCode: RecoveryArchiveSourcePinErrorCode,
): Promise<RecoveryArchiveSourcePinSnapshot> {
  await assertStableTransaction(query)
  let result: Awaited<ReturnType<FenceQuery>>
  try {
    const lockedKey = await query(
      `SELECT key_id
        FROM public.meta_recovery_archive_keys
        WHERE key_id = $1
          AND state = 'active'
        FOR UPDATE`,
      [keyId],
    )
    if (
      lockedKey.rowCount !== 1 ||
      lockedKey.rows.length !== 1 ||
      (lockedKey.rows[0] as { key_id?: unknown } | undefined)?.key_id !== keyId
    ) {
      throw new Error('recovery_archive_source_pin_key_unavailable')
    }
    result = await query(sqlText, params)
  } catch {
    throw new RecoveryArchiveSourcePinError(refusedCode)
  }
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    throw new RecoveryArchiveSourcePinError(refusedCode)
  }
  const snapshot = snapshotFromRow(result.rows[0])
  if (!snapshot) throw new RecoveryArchiveSourcePinError('RECOVERY_ARCHIVE_SOURCE_PIN_RESULT_INVALID')
  return snapshot
}

async function assertStableTransaction(query: FenceQuery): Promise<void> {
  let first: Awaited<ReturnType<FenceQuery>>
  let second: Awaited<ReturnType<FenceQuery>>
  try {
    first = await query('SELECT pg_current_xact_id()::text AS xid')
    second = await query('SELECT pg_current_xact_id()::text AS xid')
  } catch {
    throw new RecoveryArchiveSourcePinError('RECOVERY_ARCHIVE_SOURCE_PIN_NOT_IN_TRANSACTION')
  }
  const firstXid = (first.rows[0] as { xid?: unknown } | undefined)?.xid
  const secondXid = (second.rows[0] as { xid?: unknown } | undefined)?.xid
  if (
    typeof firstXid !== 'string' ||
    firstXid.length === 0 ||
    secondXid !== firstXid
  ) {
    throw new RecoveryArchiveSourcePinError('RECOVERY_ARCHIVE_SOURCE_PIN_NOT_IN_TRANSACTION')
  }
}

/**
 * Persist a non-authorizing source-pin intent in the caller's already-open transaction.
 * The caller owns the canonical fence and lock order; this helper never opens a transaction or
 * performs provider/KMS work.
 */
export async function claimRecoveryArchiveSourcePinIntent(
  query: FenceQuery,
  input: RecoveryArchiveSourcePinIntentInput,
): Promise<RecoveryArchiveSourcePinSnapshot> {
  const owner = validateOwner(input)
  return oneRow(
    query,
    CLAIM_SOURCE_PIN_SQL,
    [
      requireOpaque(input.generationId),
      requireOpaque(input.attachmentId),
      owner.ownerKind,
      owner.ownerId,
      owner.ownerFence,
      owner.leaseUntil,
      owner.keyId,
    ],
    owner.keyId,
    'RECOVERY_ARCHIVE_SOURCE_PIN_CLAIM_REFUSED',
  )
}

/** Mark an existing intent available only under the same current generation ownership tuple. */
export async function verifyRecoveryArchiveSourcePin(
  query: FenceQuery,
  input: RecoveryArchiveSourcePinVerificationInput,
): Promise<RecoveryArchiveSourcePinSnapshot> {
  const owner = validateOwner(input)
  return oneRow(
    query,
    VERIFY_SOURCE_PIN_SQL,
    [
      requireOpaque(input.generationId),
      requireOpaque(input.attachmentId),
      owner.ownerKind,
      owner.ownerId,
      owner.ownerFence,
      owner.leaseUntil,
      requireOpaque(input.immutableVersion),
      requireHash(input.contentSha256),
      requireSize(input.contentSizeBytes),
      owner.keyId,
    ],
    owner.keyId,
    'RECOVERY_ARCHIVE_SOURCE_PIN_VERIFICATION_REFUSED',
  )
}
