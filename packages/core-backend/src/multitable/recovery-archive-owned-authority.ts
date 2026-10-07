import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Pool, PoolClient } from 'pg'
import { recoveryArchiveOwnedCaptureAuthoritySql, takeRecoveryArchiveCapturedSource,
  type RecoveryArchiveCapturedSource, type RecoveryArchiveCapturedSourceSnapshot } from './recovery-archive-owned-capture'
import type { RecoveryArchiveCommittedClaimSnapshot } from './recovery-archive-owned-claim'
import type { RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import { prepareArchiveWriterBlockCleanupTransaction, prepareArchiveWriterBlockTransaction } from './recovery-archive-writer-block'
import { lockActiveRecoveryArchiveKeyForReference } from './recovery-archive-key-registry'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from './recovery-archive-seals'
import type { RecoveryArchiveNonceReservation } from './recovery-archive-crypto'
import type { RecoveryArchiveObjectReceiptEvidence } from './recovery-archive-object-receipts'

const attemptBrand = Symbol('owned-archive-attempt')
export interface RecoveryArchiveOwnedAttempt { readonly [attemptBrand]: true }
type Attempt = { captured: RecoveryArchiveCapturedSourceSnapshot; available: boolean;
  nonces: readonly RecoveryArchiveNonceReservation[]; payload?: Buffer; receipts: RecoveryArchiveObjectReceiptEvidence[] }
const attempts = new WeakMap<RecoveryArchiveOwnedAttempt, Attempt>()
export function admitRecoveryArchiveOwnedAttempt(token: RecoveryArchiveCapturedSource): RecoveryArchiveOwnedAttempt {
  const captured = takeRecoveryArchiveCapturedSource(token)
  const attempt = Object.freeze({ [attemptBrand]: true as const })
  attempts.set(attempt, { captured, available: false, nonces: [], receipts: [] })
  return attempt
}
export function recoveryArchiveOwnedAttempt(token: RecoveryArchiveOwnedAttempt): Attempt {
  const state = attempts.get(token)
  if (!state) throw new Error('RECOVERY_ARCHIVE_CAPTURE_CAPABILITY_UNAVAILABLE')
  return state
}
export function refuseOwned(): never { throw new Error('RECOVERY_ARCHIVE_OWNED_AUTHORITY_UNAVAILABLE') }

/** One native RC transaction; the caller's first work statement must be the source-free fence prelude. */
export async function runRecoveryArchiveOwnedTransaction<T>(pool: Pick<Pool, 'connect' | 'options'>,
  timeoutMs: number, depth: { value: number }, work: (query: SealQuery) => Promise<T>): Promise<T> {
  let client: PoolClient | undefined
  let released = false
  let poisoned = false
  let begun = false
  const deadline = performance.now() + timeoutMs
  const live = () => { if (poisoned || performance.now() >= deadline) throw new Error('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED') }
  const discard = () => { if (client && !released) { released = true; client.release(true) } }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { poisoned = true; discard(); reject(new Error('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')) }, timeoutMs)
  })
  const execution = (async () => {
    client = await pool.connect()
    if (poisoned) { discard(); live() }
    live()
    const prior = (await client.query('SHOW statement_timeout')).rows[0]?.statement_timeout
    if (typeof prior !== 'string') refuseOwned()
    await client.query("SELECT set_config('statement_timeout',$1,false)", [`${Math.max(1, Math.ceil(deadline - performance.now()))}ms`])
    live()
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    begun = true
    depth.value += 1
    let firstBusinessStatement = true
    const query: SealQuery = async (sql, params) => {
      if (released || !begun) refuseOwned()
      live()
      // Preserve the source-free fence as the first statement, then refresh the absolute
      // server budget for every subsequent statement, including deferred checks at COMMIT.
      if (!firstBusinessStatement) {
        await client!.query("SELECT set_config('statement_timeout',$1,true)", [`${Math.max(1, Math.ceil(deadline - performance.now()))}ms`])
        if (released || !begun) refuseOwned()
        live()
      }
      firstBusinessStatement = false
      const result = await client!.query(sql, params)
      live()
      return result
    }
    try {
      const value = await work(query)
      live()
      await query('COMMIT')
      begun = false
      depth.value -= 1
      live()
      await client.query("SELECT set_config('statement_timeout',$1,false)", [prior])
      live()
      released = true
      client.release()
      live()
      return value
    } catch (error) {
      if (begun) {
        try { if (!released) await client.query('ROLLBACK') } catch { /* Discard below. */ }
        begun = false
        depth.value -= 1
      }
      discard()
      throw error
    }
  })()
  try { return await Promise.race([execution, expiry]) }
  finally { if (timer) clearTimeout(timer); void execution.catch(() => discard()) }
}

const proofSql = `SELECT pg_current_xact_id()::text AS xid,current_setting('transaction_isolation') AS isolation,
  current_setting('transaction_read_only') AS read_only`
export async function recheckRecoveryArchiveOwnedAttempt(query: SealQuery, token: RecoveryArchiveOwnedAttempt,
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>): Promise<void> {
  const state = recoveryArchiveOwnedAttempt(token)
  const claim = state.captured.claim
  await prepareArchiveWriterBlockTransaction(query, claim.identity.sheetId)
  const before = (await query(proofSql)).rows[0] as Record<string, unknown> | undefined
  if (before?.isolation !== 'read committed' || before.read_only !== 'off' || typeof before.xid !== 'string') refuseOwned()
  await lockActiveRecoveryArchiveKeyForReference(query, { keyId: claim.key.keyId, expectedRowVersion: claim.key.rowVersion })
  const block = await query(`SELECT id FROM public.meta_sheets WHERE id=$1 FOR UPDATE`, [claim.identity.sheetId])
  if (block.rows.length !== 1) refuseOwned()
  const generation = await query(`SELECT generation_id FROM public.meta_recovery_archives WHERE generation_id=$1::uuid FOR UPDATE`, [claim.generationOwner.generationId])
  if (generation.rows.length !== 1) refuseOwned()
  if (!await authorize(query, claim.identity)) refuseOwned()
  const after = (await query(proofSql)).rows[0] as Record<string, unknown> | undefined
  if (after?.xid !== before.xid || after.isolation !== 'read committed' || after.read_only !== 'off') refuseOwned()
  const binding = JSON.stringify(claim)
  const hash = createHash('sha256').update(JSON.stringify(['recovery-archive-manual-request', 1, claim.identity.actorId,
    claim.identity.workspaceId, claim.identity.baseId, claim.identity.sheetId])).digest('hex')
  const check = async (sql: string, params: unknown[]) => {
    const row = (await query(sql, params)).rows[0] as { matches?: unknown; xid?: unknown } | undefined
    if (row?.matches !== true || row.xid !== before.xid) refuseOwned()
  }
  await check(recoveryArchiveOwnedCaptureAuthoritySql.binding, [binding, hash])
  await check(recoveryArchiveOwnedCaptureAuthoritySql.heads, [binding, [...SECTION_CAUSALITY_DATA_SECTION_KINDS]])
  const expected = [...claim.reservationPlan.sections.map((section) => ({ ordinal: section.ordinal,
    kind: claim.repeat ? 'section_checkpoint' : 'section_bootstrap', sectionKind: section.sectionKind,
    operationId: section.operationId, seq: section.endpointSeq })), { ordinal: 10, kind: 'archive_snapshot', sectionKind: null,
    operationId: claim.reservationPlan.snapshotOperationId, seq: claim.reservationPlan.snapshotSeq }]
  await check(recoveryArchiveOwnedCaptureAuthoritySql.reservations, [binding, JSON.stringify(expected)])
  // Both identity directions and every captured locator/metadata field must still match.
  // Counts alone cannot detect an equal-count replacement or a same-id source change.
  await check(`WITH b AS (SELECT $1::jsonb AS c), expected AS (SELECT value AS candidate FROM jsonb_array_elements($2::jsonb)),
    actual AS (SELECT jsonb_build_object('attachmentId',a.id,'recordId',a.record_id,'fieldId',a.field_id,
      'storageFileId',a.storage_file_id,'storagePath',a.storage_path,'storageProvider',a.storage_provider,
      'sizeBytes',a.size::text,'mediaType',a.mime_type,'deleted',a.deleted_at IS NOT NULL,
      'blobPurged',a.blob_purged_at IS NOT NULL) AS candidate
      FROM public.multitable_attachments a,b WHERE a.sheet_id=c#>>'{identity,sheetId}')
    SELECT pg_current_xact_id()::text AS xid,NOT EXISTS (
      (SELECT candidate FROM actual EXCEPT ALL SELECT candidate FROM expected)
      UNION ALL (SELECT candidate FROM expected EXCEPT ALL SELECT candidate FROM actual))
      AND NOT EXISTS (SELECT 1 FROM public.multitable_attachments a,b
        WHERE a.sheet_id=c#>>'{identity,sheetId}' AND (a.blob_purged_at IS NOT NULL OR a.blob_purge_claimed_at IS NOT NULL)) AS matches`,
    [binding, JSON.stringify(state.captured.source.attachmentCandidates)])
  if (!state.available) await check(recoveryArchiveOwnedCaptureAuthoritySql.mutablePins, [binding])
  else await check(`WITH b AS (SELECT $1::jsonb AS c), expected AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
      AS e("attachmentId" text,"immutableVersion" text,"contentSha256" text,"contentSizeBytes" text)),
    pins AS (SELECT p.* FROM public.meta_recovery_archive_attachment_refs p,b WHERE p.generation_id=(c#>>'{generationOwner,generationId}')::uuid)
    SELECT pg_current_xact_id()::text AS xid,(SELECT count(*) FROM pins)=(SELECT count(*) FROM expected)
      AND NOT EXISTS (SELECT 1 FROM pins p LEFT JOIN expected e ON e."attachmentId"=p.attachment_id CROSS JOIN b
        WHERE e."attachmentId" IS NULL OR p.reference_class<>'source' OR p.reference_state<>'building' OR p.availability<>'available'
          OR p.immutable_version IS DISTINCT FROM e."immutableVersion" OR p.content_sha256 IS DISTINCT FROM e."contentSha256"
          OR p.content_size_bytes IS DISTINCT FROM e."contentSizeBytes"::bigint
          OR p.source_owner_kind IS DISTINCT FROM c#>>'{generationOwner,ownerKind}'
          OR p.source_owner_id IS DISTINCT FROM c#>>'{generationOwner,ownerId}'
          OR p.source_owner_fence IS DISTINCT FROM (c#>>'{generationOwner,ownerFence}')::bigint
          OR p.source_lease_until IS DISTINCT FROM (c->>'leaseUntil')::timestamptz OR p.source_lease_until<=clock_timestamp())
      AS matches`,
    [binding, JSON.stringify(state.captured.attachmentDescriptors)])
}

export async function releaseRecoveryArchiveOwnedBlock(query: SealQuery, claim: RecoveryArchiveCommittedClaimSnapshot): Promise<number> {
  const block = claim.writerBlock
  const result = await query(`UPDATE public.meta_sheets SET recovery_writer_state=NULL,recovery_writer_owner_kind=NULL,
    recovery_writer_owner_id=NULL,recovery_writer_lease_until=NULL,recovery_writer_updated_at=NULL
    WHERE id=$1 AND recovery_writer_state='archiving' AND recovery_writer_owner_kind=$2 AND recovery_writer_owner_id=$3
      AND recovery_writer_owner_fence=$4::bigint AND recovery_writer_lease_until=$5::timestamptz AND recovery_writer_updated_at=$6::timestamptz`,
  [claim.identity.sheetId, block.ownerKind, block.ownerId, block.fence, block.leaseUntil, block.updatedAt])
  return result.rowCount ?? 0
}
export async function abandonRecoveryArchiveOwnedClaim(query: SealQuery, claim: RecoveryArchiveCommittedClaimSnapshot): Promise<void> {
  await prepareArchiveWriterBlockCleanupTransaction(query, claim.identity.sheetId)
  await query('SELECT id FROM public.meta_sheets WHERE id=$1 FOR UPDATE', [claim.identity.sheetId])
  const owner = claim.generationOwner
  await query(`UPDATE public.meta_recovery_archives SET build_status='abandoned'
    WHERE generation_id=$1::uuid AND state='building' AND build_status='active' AND coverage_status='incomplete'
      AND owner_kind=$2 AND owner_id=$3 AND owner_fence=$4::bigint AND source_vector_hash=$5
      AND created_at=$6::timestamptz AND lease_expires_at=$7::timestamptz AND expires_at=$8::timestamptz`,
  [owner.generationId, owner.ownerKind, owner.ownerId, owner.ownerFence, owner.sourceVectorHash,
    claim.generationClaimedAt, claim.leaseUntil, claim.expiresAt])
  await releaseRecoveryArchiveOwnedBlock(query, claim)
}
