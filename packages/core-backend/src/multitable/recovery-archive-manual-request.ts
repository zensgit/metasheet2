import { createHash } from 'node:crypto'
import type { SealQuery } from './recovery-archive-seals'
import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'

export type RecoveryArchiveManualRequest = RecoveryArchiveScopeIdentity & { requestId: string }

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

function snapshot(input: RecoveryArchiveManualRequest) {
  const identity = { ...input }
  if (!UUID.test(identity.actorId) || !UUID.test(identity.requestId)
    || [identity.workspaceId, identity.baseId, identity.sheetId]
      .some((value) => typeof value !== 'string' || !value || value.trim() !== value)) {
    throw new Error('RECOVERY_ARCHIVE_MANUAL_REQUEST_INVALID')
  }
  return identity
}

async function assertTransaction(query: SealQuery): Promise<void> {
  const first = await query('SELECT pg_current_xact_id()::text AS xid')
  const second = await query('SELECT pg_current_xact_id()::text AS xid')
  const xid = (first.rows[0] as { xid?: unknown } | undefined)?.xid
  if (typeof xid !== 'string' || !xid || xid !== (second.rows[0] as { xid?: unknown } | undefined)?.xid) {
    throw new Error('RECOVERY_ARCHIVE_MANUAL_REQUEST_TRANSACTION_REQUIRED')
  }
}

function requestHash(identity: RecoveryArchiveManualRequest): string {
  return createHash('sha256').update(JSON.stringify([
    'recovery-archive-manual-request', 1, identity.actorId,
    identity.workspaceId, identity.baseId, identity.sheetId,
  ])).digest('hex')
}

/** Durable lookup only: an existing identity never grants upload authority or revives an expired lease. */
export async function readRecoveryArchiveManualRequest(
  query: SealQuery, input: RecoveryArchiveManualRequest,
): Promise<string | null> {
  const identity = snapshot(input)
  await assertTransaction(query)
  const stored = await query(`SELECT workspace_id,base_id,sheet_id,generation_id::text,request_hash
    FROM public.meta_recovery_archive_manual_requests WHERE actor_id=$1::uuid AND request_id=$2::uuid`,
  [identity.actorId, identity.requestId])
  if (stored.rows.length === 0) return null
  const row = stored.rows[0] as Record<string, unknown> | undefined
  if (stored.rows.length !== 1 || !row || row.workspace_id !== identity.workspaceId
    || row.base_id !== identity.baseId || row.sheet_id !== identity.sheetId
    || row.request_hash !== requestHash(identity) || typeof row.generation_id !== 'string'
    || !UUID.test(row.generation_id)) throw new Error('RECOVERY_ARCHIVE_MANUAL_REQUEST_CONFLICT')
  return row.generation_id
}

/** Internal identity binding. Caller must authorize and claim a generation in the same transaction. */
export async function bindRecoveryArchiveManualRequest(
  query: SealQuery, input: RecoveryArchiveManualRequest, generationId: string,
): Promise<string> {
  const identity = snapshot(input)
  if (!UUID.test(generationId)) throw new Error('RECOVERY_ARCHIVE_MANUAL_REQUEST_INVALID')
  const existing = await readRecoveryArchiveManualRequest(query, identity)
  if (existing !== null) {
    if (existing !== generationId) throw new Error('RECOVERY_ARCHIVE_MANUAL_REQUEST_CONFLICT')
    return existing
  }
  const hash = requestHash(identity)
  const params = [identity.actorId, identity.requestId, identity.workspaceId,
    identity.baseId, identity.sheetId, generationId, hash]
  await query(`INSERT INTO public.meta_recovery_archive_manual_requests
    (actor_id,request_id,workspace_id,base_id,sheet_id,generation_id,request_hash)
    VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::uuid,$7)
    ON CONFLICT (actor_id,request_id) DO NOTHING`, params)
  if (await readRecoveryArchiveManualRequest(query, identity) !== generationId) {
    throw new Error('RECOVERY_ARCHIVE_MANUAL_REQUEST_CONFLICT')
  }
  return generationId
}
