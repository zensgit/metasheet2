import type { FenceQuery } from './canonical-sheet-fence'
import type { RecoveryArchiveObjectDeletionInput } from './recovery-archive-object-deletions'

export interface RecoveryArchiveObjectClaimInput extends RecoveryArchiveObjectDeletionInput {
  expectedRowVersion: string
  workerOwnerId: string
}

export interface RecoveryArchiveObjectTakeoverInput extends RecoveryArchiveObjectClaimInput {
  previousWorkerOwnerId: string
  previousWorkerFence: string
  previousLeaseUntil: string
}

export interface RecoveryArchiveObjectClaimSnapshot extends RecoveryArchiveObjectDeletionInput {
  state: 'deleting'
  rowVersion: string
  workerOwnerId: string
  workerFence: string
  leaseUntil: string
  attemptCount: string
  storeId: string
  stagingObjectId: string
  keyId: string
  providerVersion: string
  ciphertextSha256: string
  sizeBytes: string
  objectExpiresAt: string
}

export class RecoveryArchiveObjectClaimError extends Error {
  constructor(readonly code: 'RECOVERY_ARCHIVE_OBJECT_CLAIM_INVALID_INPUT'
    | 'RECOVERY_ARCHIVE_OBJECT_CLAIM_TRANSACTION_REQUIRED'
    | 'RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED'
    | 'RECOVERY_ARCHIVE_OBJECT_CLAIM_RESULT_INVALID') {
    super(code)
    this.name = 'RecoveryArchiveObjectClaimError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const OPAQUE = /^[\x21-\x7e]{1,512}$/
const MAX_BIGINT = 9223372036854775807n
function decimal(value: unknown, positive = true): value is string {
  return typeof value === 'string' && (positive ? /^[1-9][0-9]{0,18}$/ : /^(?:0|[1-9][0-9]{0,18})$/).test(value)
    && BigInt(value) <= MAX_BIGINT
}
function timestamp(value: unknown): value is string {
  try { return typeof value === 'string' && new Date(value).toISOString() === value } catch { return false }
}
function opaque(value: unknown): value is string { return typeof value === 'string' && OPAQUE.test(value) }
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value) }

export const RECOVERY_ARCHIVE_OBJECT_CLAIM_COMMAND_SQL = `SELECT
  id::text AS id, generation_id::text AS generation_id, object_id, owner_request_id::text AS owner_request_id,
  provider_operation_key, state, row_version::text AS row_version, worker_owner_id,
  worker_fence::text AS worker_fence, attempt_count::text AS attempt_count,
  to_char(lease_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS lease_until,
  store_id::text AS store_id, staging_object_id::text AS staging_object_id, key_id, provider_version,
  ciphertext_sha256, size_bytes::text AS size_bytes,
  to_char(object_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS object_expires_at,
  pg_current_xact_id()::text AS xid
FROM public.meta_recovery_archive_object_claim_command(
  $1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7, $8, $9::uuid, $10::bigint, $11,
  $12, $13::bigint, $14, $15, $16::bigint, $17::timestamptz
)`

function oneRow(result: Awaited<ReturnType<FenceQuery>>): Record<string, unknown> | null {
  try {
    if (result.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) return null
    const row = result.rows[0]
    return row !== null && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : null
  } catch { return null }
}

async function command(query: FenceQuery, input: RecoveryArchiveObjectClaimInput | RecoveryArchiveObjectTakeoverInput,
  action: 'claim' | 'takeover'): Promise<RecoveryArchiveObjectClaimSnapshot> {
  let value: RecoveryArchiveObjectClaimInput
  let previous: Pick<RecoveryArchiveObjectTakeoverInput, 'previousWorkerOwnerId' | 'previousWorkerFence' | 'previousLeaseUntil'> | null
  try {
    const { id, generationId, objectId, ownerRequestId, providerOperationKey, workspaceId, baseId, sheetId,
      anchorOperationId, anchorSeq, checkpointId, expectedRowVersion, workerOwnerId } = input
    if (![id, generationId, ownerRequestId, anchorOperationId].every(uuid)
      || ![objectId, providerOperationKey].every(v => typeof v === 'string' && HASH.test(v))
      || ![workspaceId, baseId, sheetId, checkpointId, workerOwnerId].every(opaque)
      || !decimal(anchorSeq) || !decimal(expectedRowVersion) || BigInt(expectedRowVersion) === MAX_BIGINT) throw new Error()
    value = { id, generationId, objectId, ownerRequestId, providerOperationKey, workspaceId, baseId, sheetId,
      anchorOperationId, anchorSeq, checkpointId, expectedRowVersion, workerOwnerId }
    previous = null
    if (action === 'takeover') {
      const { previousWorkerOwnerId, previousWorkerFence, previousLeaseUntil } = input as RecoveryArchiveObjectTakeoverInput
      if (!opaque(previousWorkerOwnerId) || !decimal(previousWorkerFence) || BigInt(previousWorkerFence) === MAX_BIGINT
        || !timestamp(previousLeaseUntil)) throw new Error()
      previous = { previousWorkerOwnerId, previousWorkerFence, previousLeaseUntil }
    }
  } catch { throw new RecoveryArchiveObjectClaimError('RECOVERY_ARCHIVE_OBJECT_CLAIM_INVALID_INPUT') }
  const probe = async (): Promise<string> => {
    try {
      const row = oneRow(await query('SELECT pg_current_xact_id()::text AS xid'))
      if (typeof row?.xid !== 'string' || !row.xid) throw new Error()
      return row.xid
    } catch { throw new RecoveryArchiveObjectClaimError('RECOVERY_ARCHIVE_OBJECT_CLAIM_TRANSACTION_REQUIRED') }
  }
  const xid = await probe()
  if (await probe() !== xid) throw new RecoveryArchiveObjectClaimError('RECOVERY_ARCHIVE_OBJECT_CLAIM_TRANSACTION_REQUIRED')
  let result: Awaited<ReturnType<FenceQuery>>
  try {
    result = await query(RECOVERY_ARCHIVE_OBJECT_CLAIM_COMMAND_SQL, [value.id, value.generationId, value.objectId,
      value.ownerRequestId, value.providerOperationKey, value.workspaceId, value.baseId, value.sheetId,
      value.anchorOperationId, value.anchorSeq, value.checkpointId, action, value.expectedRowVersion, value.workerOwnerId,
      previous?.previousWorkerOwnerId ?? null, previous?.previousWorkerFence ?? null, previous?.previousLeaseUntil ?? null])
  } catch { throw new RecoveryArchiveObjectClaimError('RECOVERY_ARCHIVE_OBJECT_CLAIM_REFUSED') }
  const row = oneRow(result)
  if (!row || row.xid !== xid || row.id !== value.id || row.generation_id !== value.generationId
    || row.object_id !== value.objectId || row.owner_request_id !== value.ownerRequestId
    || row.provider_operation_key !== value.providerOperationKey || row.state !== 'deleting'
    || row.row_version !== (BigInt(value.expectedRowVersion) + 1n).toString() || row.worker_owner_id !== value.workerOwnerId
    || !decimal(row.worker_fence) || !decimal(row.attempt_count)
    || (previous && row.worker_fence !== (BigInt(previous.previousWorkerFence) + 1n).toString())
    || !timestamp(row.lease_until) || !uuid(row.store_id) || !uuid(row.staging_object_id)
    || !opaque(row.key_id) || row.key_id.length > 255 || !opaque(row.provider_version)
    || typeof row.ciphertext_sha256 !== 'string' || !HASH.test(row.ciphertext_sha256)
    || !decimal(row.size_bytes, false) || !timestamp(row.object_expires_at)) {
    throw new RecoveryArchiveObjectClaimError('RECOVERY_ARCHIVE_OBJECT_CLAIM_RESULT_INVALID')
  }
  const { expectedRowVersion: _version, workerOwnerId: _worker, ...identity } = value
  return { ...identity, state: 'deleting', rowVersion: row.row_version as string, workerOwnerId: value.workerOwnerId,
    workerFence: row.worker_fence, attemptCount: row.attempt_count, leaseUntil: row.lease_until,
    storeId: row.store_id, stagingObjectId: row.staging_object_id, keyId: row.key_id,
    providerVersion: row.provider_version, ciphertextSha256: row.ciphertext_sha256,
    sizeBytes: row.size_bytes, objectExpiresAt: row.object_expires_at }
}

/** Internal DB authority; no provider callback or automatic work selection. */
export function claimRecoveryArchiveObjectDeletion(query: FenceQuery, input: RecoveryArchiveObjectClaimInput) {
  return command(query, input, 'claim')
}

export function takeOverRecoveryArchiveObjectDeletion(query: FenceQuery, input: RecoveryArchiveObjectTakeoverInput) {
  return command(query, input, 'takeover')
}
