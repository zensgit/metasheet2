import type { FenceQuery } from './canonical-sheet-fence'

/** Internal storage authority only; caller owns its transaction and owner/tenant authorization. */
export interface RecoveryArchiveObjectDeletionInput {
  id: string
  generationId: string
  objectId: string
  ownerRequestId: string
  providerOperationKey: string
  workspaceId: string
  baseId: string
  sheetId: string
  anchorOperationId: string
  anchorSeq: string
  checkpointId: string
}

export interface RecoveryArchiveObjectDeletionSnapshot extends RecoveryArchiveObjectDeletionInput {
  state: 'requested' | 'ready'
  rowVersion: string
}

export class RecoveryArchiveObjectDeletionError extends Error {
  constructor(readonly code: 'RECOVERY_ARCHIVE_OBJECT_DELETION_INVALID_INPUT'
    | 'RECOVERY_ARCHIVE_OBJECT_DELETION_TRANSACTION_REQUIRED'
    | 'RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED'
    | 'RECOVERY_ARCHIVE_OBJECT_DELETION_RESULT_INVALID') {
    super(code)
    this.name = 'RecoveryArchiveObjectDeletionError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const OPAQUE = /^[\x21-\x7e]{1,512}$/
const POSITIVE_BIGINT = /^[1-9][0-9]{0,18}$/

function validBigint(value: unknown): value is string {
  return typeof value === 'string' && POSITIVE_BIGINT.test(value) && BigInt(value) <= 9223372036854775807n
}

function normalize(input: RecoveryArchiveObjectDeletionInput): RecoveryArchiveObjectDeletionInput {
  try {
    const { id, generationId, objectId, ownerRequestId, providerOperationKey,
      workspaceId, baseId, sheetId, anchorOperationId, anchorSeq, checkpointId } = input
    if (![id, generationId, ownerRequestId, anchorOperationId].every(value => typeof value === 'string' && UUID.test(value))
      || ![objectId, providerOperationKey].every(value => typeof value === 'string' && HASH.test(value))
      || ![workspaceId, baseId, sheetId, checkpointId].every(value => typeof value === 'string' && OPAQUE.test(value))
      || !validBigint(anchorSeq)) throw new Error()
    return { id, generationId, objectId, ownerRequestId, providerOperationKey,
      workspaceId, baseId, sheetId, anchorOperationId, anchorSeq, checkpointId }
  } catch {
    throw new RecoveryArchiveObjectDeletionError('RECOVERY_ARCHIVE_OBJECT_DELETION_INVALID_INPUT')
  }
}

export const RECOVERY_ARCHIVE_OBJECT_DELETION_COMMAND_SQL = `SELECT
  id::text AS id, generation_id::text AS generation_id, object_id,
  owner_request_id::text AS owner_request_id, provider_operation_key,
  workspace_id, base_id, sheet_id, anchor_operation_id::text AS anchor_operation_id,
  anchor_seq::text AS anchor_seq, checkpoint_id, state, row_version::text AS row_version,
  pg_current_xact_id()::text AS xid
FROM public.meta_recovery_archive_object_deletion_command(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9::uuid, $10::bigint, $11, $12, $13::bigint
)`

function oneRow(result: Awaited<ReturnType<FenceQuery>>): Record<string, unknown> | null {
  try {
    if (result.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) return null
    const row = result.rows[0]
    return row !== null && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function command(query: FenceQuery, input: RecoveryArchiveObjectDeletionInput,
  action: 'request' | 'prepare', expectedRowVersion: string | null): Promise<RecoveryArchiveObjectDeletionSnapshot> {
  const normalized = normalize(input)
  if (action === 'prepare' && !validBigint(expectedRowVersion)) {
    throw new RecoveryArchiveObjectDeletionError('RECOVERY_ARCHIVE_OBJECT_DELETION_INVALID_INPUT')
  }
  const transactionProbe = async (): Promise<string> => {
    try {
      const result = await query('SELECT pg_current_xact_id()::text AS xid')
      const row = oneRow(result)
      if (typeof row?.xid !== 'string') throw new Error()
      return row.xid
    } catch {
      throw new RecoveryArchiveObjectDeletionError('RECOVERY_ARCHIVE_OBJECT_DELETION_TRANSACTION_REQUIRED')
    }
  }
  const xid = await transactionProbe()
  if (await transactionProbe() !== xid) {
    throw new RecoveryArchiveObjectDeletionError('RECOVERY_ARCHIVE_OBJECT_DELETION_TRANSACTION_REQUIRED')
  }
  let result: Awaited<ReturnType<FenceQuery>>
  try {
    result = await query(RECOVERY_ARCHIVE_OBJECT_DELETION_COMMAND_SQL, [
      normalized.id, normalized.generationId, normalized.objectId, normalized.ownerRequestId,
      normalized.providerOperationKey, normalized.workspaceId, normalized.baseId, normalized.sheetId,
      normalized.anchorOperationId, normalized.anchorSeq, normalized.checkpointId, action, expectedRowVersion,
    ])
  } catch {
    throw new RecoveryArchiveObjectDeletionError('RECOVERY_ARCHIVE_OBJECT_DELETION_REFUSED')
  }
  const row = oneRow(result)
  const expectedState = action === 'request' ? 'requested' : 'ready'
  const version = action === 'request' ? '1' : (BigInt(expectedRowVersion as string) + 1n).toString()
  if (!row || row.xid !== xid
    || row.id !== normalized.id || row.generation_id !== normalized.generationId || row.object_id !== normalized.objectId
    || row.owner_request_id !== normalized.ownerRequestId || row.provider_operation_key !== normalized.providerOperationKey
    || row.workspace_id !== normalized.workspaceId || row.base_id !== normalized.baseId || row.sheet_id !== normalized.sheetId
    || row.anchor_operation_id !== normalized.anchorOperationId || row.anchor_seq !== normalized.anchorSeq
    || row.checkpoint_id !== normalized.checkpointId || row.state !== expectedState || row.row_version !== version) {
    throw new RecoveryArchiveObjectDeletionError('RECOVERY_ARCHIVE_OBJECT_DELETION_RESULT_INVALID')
  }
  return { ...normalized, state: expectedState, rowVersion: version }
}

export function requestRecoveryArchiveObjectDeletion(query: FenceQuery, input: RecoveryArchiveObjectDeletionInput) {
  return command(query, input, 'request', null)
}

export function prepareRecoveryArchiveObjectDeletion(query: FenceQuery, input: RecoveryArchiveObjectDeletionInput & { expectedRowVersion: string }) {
  return command(query, input, 'prepare', input.expectedRowVersion)
}
