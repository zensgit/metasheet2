export type RecoveryArchiveKeyRegistryQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type RecoveryArchiveKeyReferenceErrorCode =
  | 'RECOVERY_ARCHIVE_KEY_REFERENCE_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_KEY_REFERENCE_NOT_IN_TRANSACTION'
  | 'RECOVERY_ARCHIVE_KEY_REFERENCE_UNAVAILABLE'

export class RecoveryArchiveKeyReferenceError extends Error {
  readonly code: RecoveryArchiveKeyReferenceErrorCode

  constructor(code: RecoveryArchiveKeyReferenceErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveKeyReferenceError'
    this.code = code
  }
}

export interface RecoveryArchiveKeyReferenceInput {
  keyId: string
  expectedRowVersion: string
}

export interface ActiveRecoveryArchiveKeyReference {
  state: 'active'
  rowVersion: string
}

type KeyRow = {
  state?: unknown
  row_version?: unknown
  xid?: unknown
}

const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/

/**
 * Locks one key authority row for reference admission.
 *
 * The caller owns the transaction and must already hold the canonical sheet fence. Keeping the
 * query capability explicit prevents this helper from hiding a transaction boundary between the
 * key lock and the later writer-block/generation operations.
 */
export async function lockActiveRecoveryArchiveKeyForReference(
  query: RecoveryArchiveKeyRegistryQuery,
  input: RecoveryArchiveKeyReferenceInput,
): Promise<ActiveRecoveryArchiveKeyReference> {
  assertInput(input)

  const result = await query(
    `SELECT state, row_version::text AS row_version,
            pg_current_xact_id()::text AS xid
       FROM public.meta_recovery_archive_keys
      WHERE key_id = $1
      FOR UPDATE`,
    [input.keyId],
  )
  const row = result.rows[0] as KeyRow | undefined
  if (
    result.rows.length !== 1 ||
    row?.state !== 'active' ||
    row.row_version !== input.expectedRowVersion
  ) {
    throw new RecoveryArchiveKeyReferenceError('RECOVERY_ARCHIVE_KEY_REFERENCE_UNAVAILABLE')
  }

  const sameTransaction = await query('SELECT pg_current_xact_id()::text AS xid')
  if (
    typeof row.xid !== 'string' ||
    row.xid.length === 0 ||
    (sameTransaction.rows[0] as { xid?: unknown } | undefined)?.xid !== row.xid
  ) {
    throw new RecoveryArchiveKeyReferenceError('RECOVERY_ARCHIVE_KEY_REFERENCE_NOT_IN_TRANSACTION')
  }

  return { state: 'active', rowVersion: input.expectedRowVersion }
}

function assertInput(input: RecoveryArchiveKeyReferenceInput): void {
  if (
    typeof input.keyId !== 'string' ||
    input.keyId.length < 1 ||
    input.keyId.length > 255 ||
    input.keyId.trim() !== input.keyId ||
    hasControlCharacter(input.keyId) ||
    typeof input.expectedRowVersion !== 'string' ||
    !POSITIVE_DECIMAL_PATTERN.test(input.expectedRowVersion)
  ) {
    throw new RecoveryArchiveKeyReferenceError('RECOVERY_ARCHIVE_KEY_REFERENCE_INVALID_INPUT')
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}
