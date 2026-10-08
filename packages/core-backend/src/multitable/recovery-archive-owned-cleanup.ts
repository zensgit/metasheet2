import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { prepareArchiveWriterBlockCleanupTransaction } from './recovery-archive-writer-block'
import { runRecoveryArchiveOwnedTransaction } from './recovery-archive-owned-authority'
import { snapshotRecoveryArchiveCaptureLimits, type RecoveryArchiveCaptureLimits } from './recovery-archive-bounded-source'
import { snapshotRecoveryArchiveManualPolicy, type RecoveryArchiveManualAdmissionPolicy } from './recovery-archive-manual-admission'
import { snapshotRecoveryArchiveObjectStoreId } from './recovery-archive-object-store'
import { admitRecoveryArchiveAbandonedObjectCleanup, cleanupRecoveryArchiveAbandonedObjects } from './recovery-archive-abandoned-object-cleanup'
import type { RecoveryArchiveAbandonedObjectStore } from './recovery-archive-abandoned-object-store'
import type { RecoveryArchiveScopeIdentity } from './recovery-archive-worker-authorization'
import type { RecoveryArchiveTransactionDepthProbe } from './recovery-archive-crypto'
import type { RecoveryArchivePreparedCaptureOwner } from './recovery-archive-prepared-capture'
import type { SealQuery } from './recovery-archive-seals'
import { readOwnedCleanupAdmission, readOwnedEarlyCleanupProof, refuseOwnedCleanup, type OwnedCleanupGeneration } from './recovery-archive-owned-cleanup-proof'

export interface RecoveryArchiveOwnedCleanupInput {
  identity: RecoveryArchiveScopeIdentity
  generationId: string
}
export type RecoveryArchiveOwnedCleanupResult = { outcome: 'complete' | 'retained'; confirmed: number }
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

/** Only scoped actor + generation; all owner, lease and provider evidence is read internally. */
export function bindRecoveryArchiveOwnedCleanup(options: {
  pool: Pick<Pool, 'connect' | 'options'>
  limits: RecoveryArchiveCaptureLimits
  policy: RecoveryArchiveManualAdmissionPolicy
  provider: RecoveryArchiveAbandonedObjectStore
  transactionDepth: RecoveryArchiveTransactionDepthProbe
}, authorize: (query: SealQuery, identity: RecoveryArchiveScopeIdentity) => Promise<boolean>) {
  const limits = snapshotRecoveryArchiveCaptureLimits(options.limits)
  const policy = snapshotRecoveryArchiveManualPolicy(options.policy)
  const pool = options.pool
  const storeId = snapshotRecoveryArchiveObjectStoreId(options.provider)
  const discard = Object.getOwnPropertyDescriptor(options.provider, 'discard')?.value as RecoveryArchiveAbandonedObjectStore['discard'] | undefined
  const status = Object.getOwnPropertyDescriptor(options.provider, 'status')?.value as RecoveryArchiveAbandonedObjectStore['status'] | undefined
  if (!storeId || typeof discard !== 'function' || typeof status !== 'function' || typeof pool?.connect !== 'function'
    || !Number.isSafeInteger(pool.options.connectionTimeoutMillis) || !pool.options.connectionTimeoutMillis
    || pool.options.connectionTimeoutMillis < 1 || pool.options.connectionTimeoutMillis > limits.timeoutMs) refuseOwnedCleanup()
  // Retain this original namespace and method receiver even if an adapter is later mutated.
  const provider = Object.defineProperty({ discard: discard.bind(options.provider), status: status.bind(options.provider) },
    'storeId', { value: storeId, enumerable: true })
  const inFlight = new Set<Promise<unknown>>()
  const run = async (input: RecoveryArchiveOwnedCleanupInput): Promise<RecoveryArchiveOwnedCleanupResult> => {
    let poisoned = false
    const deadline = performance.now() + limits.timeoutMs
    const live = () => { if (poisoned || performance.now() >= deadline) refuseOwnedCleanup() }
    const remaining = () => { live(); return Math.max(1, Math.ceil(deadline - performance.now())) }
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { poisoned = true; reject(new Error('RECOVERY_ARCHIVE_OWNED_CLEANUP_REFUSED')) }, limits.timeoutMs)
    })
    const execution = (async () => {
      try {
        const identity = Object.freeze({ ...input.identity })
        const generationId = input.generationId
        if (Object.keys(input).sort().join(',') !== 'generationId,identity'
          || Object.keys(identity).sort().join(',') !== 'actorId,baseId,sheetId,workspaceId' || !UUID.test(generationId)
          || !UUID.test(identity.actorId) || Object.values(identity).some(value => typeof value !== 'string' || !value || value.trim() !== value)
          || Buffer.byteLength(JSON.stringify(input)) > limits.maxBytes || options.transactionDepth.currentTransactionDepth() !== 0) refuseOwnedCleanup()
        const depth = { value: 0 }
        const probe = { currentTransactionDepth: () => depth.value + options.transactionDepth.currentTransactionDepth() }
        const transaction = <T>(work: (query: SealQuery) => Promise<T>) => runRecoveryArchiveOwnedTransaction(pool, remaining(), depth,
          async native => {
            const query: SealQuery = async (sql, params) => { live(); const result = await native(sql, params); live(); return result }
            await prepareArchiveWriterBlockCleanupTransaction(query, identity.sheetId)
            return work(query)
          })
        const boundedProvider = Object.defineProperty({
          async status(request: Parameters<typeof provider.status>[0]) { live(); const result = await provider.status(request); live(); return result },
          async discard(request: Parameters<typeof provider.discard>[0]) { live(); const result = await provider.discard(request); live(); return result },
        }, 'storeId', { value: storeId, enumerable: true })
        const lock = async (query: SealQuery) => {
          const key = await query(`SELECT k.key_id,k.state FROM public.meta_recovery_archive_keys k
            JOIN public.meta_recovery_archives a ON a.key_id=k.key_id
            WHERE a.generation_id=$1::uuid AND a.workspace_id=$2 AND a.base_id=$3 AND a.sheet_id=$4 FOR UPDATE OF k`,
          [generationId, identity.workspaceId, identity.baseId, identity.sheetId])
          const keyRow = key.rows[0] as Record<string, unknown> | undefined
          if (key.rows.length !== 1 || !keyRow || !['active', 'retiring'].includes(String(keyRow.state))) refuseOwnedCleanup()
          const sheet = await query(`SELECT recovery_writer_state AS state,recovery_writer_owner_kind AS kind,
            recovery_writer_owner_id AS id,recovery_writer_owner_fence::text AS fence,recovery_writer_lease_until::text AS lease,
            recovery_writer_updated_at::text AS updated,recovery_writer_lease_until<=clock_timestamp() AS expired
            FROM public.meta_sheets WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [identity.sheetId])
          if (sheet.rows.length !== 1) refuseOwnedCleanup()
          const rows = await query(`SELECT generation_id::text,workspace_id,base_id,sheet_id,key_id,state,build_status,coverage_status,
            owner_kind,owner_id,owner_fence::text,source_vector_hash,anchor_operation_id::text,anchor_seq::text,
            created_at::text,lease_expires_at::text,lease_expires_at<=clock_timestamp() AS expired
            FROM public.meta_recovery_archives WHERE generation_id=$1::uuid FOR UPDATE`, [generationId])
          const generation = rows.rows[0] as OwnedCleanupGeneration | undefined
          if (rows.rows.length !== 1 || !generation || generation.workspace_id !== identity.workspaceId || generation.base_id !== identity.baseId
            || generation.sheet_id !== identity.sheetId || generation.key_id !== keyRow.key_id
            || generation.state !== 'building' || generation.coverage_status !== 'incomplete'
            || !['active', 'abandoned'].includes(String(generation.build_status)) || !['archive_builder', 'archive_cleanup'].includes(String(generation.owner_kind))
            || typeof generation.owner_id !== 'string' || !generation.owner_id || typeof generation.owner_fence !== 'string'
            || !/^[1-9][0-9]*$/.test(generation.owner_fence) || typeof generation.source_vector_hash !== 'string'
            || !/^[0-9a-f]{64}$/.test(generation.source_vector_hash) || typeof generation.created_at !== 'string'
            || typeof generation.lease_expires_at !== 'string' || !await authorize(query, identity)) refuseOwnedCleanup()
          const budget = await query(`SELECT COALESCE(sum(bytes),0)<=$2::bigint AS within_budget FROM (
            SELECT octet_length(payload)::bigint AS bytes FROM public.meta_recovery_archive_prepared_captures WHERE generation_id=$1::uuid
            UNION ALL SELECT octet_length(row_to_json(r)::text) FROM public.meta_recovery_archive_snapshot_reservations r WHERE generation_id=$1::uuid
            UNION ALL SELECT octet_length(row_to_json(r)::text) FROM public.meta_recovery_archive_manual_requests r WHERE generation_id=$1::uuid
            UNION ALL SELECT octet_length(row_to_json(r)::text) FROM public.meta_recovery_archive_staging_objects r WHERE generation_id=$1::uuid
            UNION ALL SELECT octet_length(row_to_json(r)::text) FROM public.meta_recovery_archive_attachment_refs r WHERE generation_id=$1::uuid
            UNION ALL SELECT octet_length(row_to_json(r)::text) FROM public.meta_recovery_archive_abandoned_bindings r WHERE generation_id=$1::uuid
            UNION ALL SELECT octet_length(row_to_json(r)::text) FROM public.meta_recovery_archive_objects r WHERE generation_id=$1::uuid
          ) inventory`, [generationId, limits.maxBytes])
          if (budget.rows.length !== 1 || (budget.rows[0] as { within_budget?: unknown }).within_budget !== true) refuseOwnedCleanup()
          return { generation, block: sheet.rows[0] as Record<string, unknown> }
        }
        const claimed = await transaction(async query => {
          const { generation, block } = await lock(query)
          if (generation.expired !== true || (generation.owner_kind === 'archive_builder'
            && (generation.owner_id !== generationId || generation.owner_fence !== '1'))
            || (generation.build_status === 'active' && generation.owner_kind !== 'archive_builder')) refuseOwnedCleanup()
          if (block.fence !== null && (typeof block.fence !== 'string' || !/^[1-9][0-9]*$/.test(block.fence))) refuseOwnedCleanup()
          const clean = block.state === null && block.kind === null && block.id === null && block.lease === null && block.updated === null
          if (!clean && (generation.build_status !== 'active' || block.state !== 'archiving' || block.kind !== 'archive_generation'
            || block.id !== generationId || block.lease !== generation.lease_expires_at || block.expired !== true
            || typeof block.fence !== 'string' || !/^[1-9][0-9]*$/.test(block.fence) || typeof block.updated !== 'string')) refuseOwnedCleanup()
          const admission = await readOwnedCleanupAdmission(query, identity, generation)
          const prepared = await query('SELECT generation_id,octet_length(payload) AS bytes FROM public.meta_recovery_archive_prepared_captures WHERE generation_id=$1::uuid', [generationId])
          if (prepared.rows.length > 1 || (prepared.rows.length && (typeof (prepared.rows[0] as { bytes?: unknown }).bytes !== 'number'
            || Number((prepared.rows[0] as { bytes: number }).bytes) > limits.maxBytes))) refuseOwnedCleanup()
          const early = prepared.rows.length === 0
          if (early) await readOwnedEarlyCleanupProof(query, generation, admission)
          if (generation.build_status === 'active') {
            const abandoned = await query(`UPDATE public.meta_recovery_archives SET build_status='abandoned'
              WHERE generation_id=$1::uuid AND owner_kind=$2 AND owner_id=$3 AND owner_fence=$4::bigint
                AND lease_expires_at=$5::timestamptz AND lease_expires_at<=clock_timestamp()
                AND state='building' AND build_status='active' AND coverage_status='incomplete' RETURNING generation_id`,
            [generationId, generation.owner_kind, generation.owner_id, generation.owner_fence, generation.lease_expires_at])
            if (abandoned.rows.length !== 1) refuseOwnedCleanup()
          }
          if (!clean) {
            const cleared = await query(`UPDATE public.meta_sheets SET recovery_writer_state=NULL,recovery_writer_owner_kind=NULL,
              recovery_writer_owner_id=NULL,recovery_writer_lease_until=NULL,recovery_writer_updated_at=NULL
              WHERE id=$1 AND recovery_writer_state='archiving' AND recovery_writer_owner_kind=$2 AND recovery_writer_owner_id=$3
                AND recovery_writer_owner_fence=$4::bigint AND recovery_writer_lease_until=$5::timestamptz
                AND recovery_writer_updated_at=$6::timestamptz AND recovery_writer_lease_until<=clock_timestamp() RETURNING id`,
            [identity.sheetId, block.kind, block.id, block.fence, block.lease, block.updated])
            if (cleared.rows.length !== 1) refuseOwnedCleanup()
          }
          const owner = { generationId, ownerKind: String(generation.owner_kind), ownerId: String(generation.owner_id),
            ownerFence: String(generation.owner_fence), sourceVectorHash: generation.source_vector_hash }
          if (!early) await admitRecoveryArchiveAbandonedObjectCleanup(query, authorize, { identity, owner }, true, storeId)
          const cleanupOwnerId = randomUUID()
          const taken = await query(`SELECT public.meta_recovery_archive_claim_abandoned_cleanup(
            $1::uuid,$2,$3,$4::bigint,'archive_cleanup',$5,clock_timestamp()+$6::int*interval '1 second')::text AS fence`,
          [generationId, owner.ownerKind, owner.ownerId, owner.ownerFence, cleanupOwnerId, policy.leaseSeconds])
          const fence = (taken.rows[0] as { fence?: unknown } | undefined)?.fence
          if (taken.rows.length !== 1 || typeof fence !== 'string' || !/^[1-9][0-9]*$/.test(fence)
            || BigInt(fence) !== BigInt(owner.ownerFence) + 1n) refuseOwnedCleanup()
          return { early, owner: { ...owner, ownerKind: 'archive_cleanup', ownerId: cleanupOwnerId, ownerFence: fence } }
        })
        if (!claimed.early) return await cleanupRecoveryArchiveAbandonedObjects(transaction, authorize,
          { identity, owner: claimed.owner, provider: boundedProvider, transactionDepth: probe })
        return await transaction(async query => {
          const { generation, block } = await lock(query)
          assertCleanupOwner(generation, claimed.owner)
          if (block.state !== null || block.kind !== null || block.id !== null || block.lease !== null || block.updated !== null) refuseOwnedCleanup()
          const admission = await readOwnedCleanupAdmission(query, identity, generation)
          const intents = await readOwnedEarlyCleanupProof(query, generation, admission)
          for (const intent of intents) {
            const terminal = await query(`UPDATE public.meta_recovery_archive_staging_objects SET object_state='absent',terminal_receipt_sha256=$3,
              cleanup_owner_kind='archive_cleanup',cleanup_owner_id=$4,cleanup_owner_fence=$5::bigint
              WHERE generation_id=$1::uuid AND staging_object_id=$2::uuid AND object_state='pending' RETURNING staging_object_id`,
            [generationId, intent.stagingId, intent.receipt, claimed.owner.ownerId, claimed.owner.ownerFence])
            if (terminal.rows.length !== 1) refuseOwnedCleanup()
          }
          for (const intent of intents) await query(`SELECT public.meta_recovery_archive_release_abandoned_source_pin($1::uuid,$2,'archive_cleanup',$3,$4::bigint)`,
            [generationId, intent.attachmentId, claimed.owner.ownerId, claimed.owner.ownerFence])
          return { outcome: 'complete' as const, confirmed: intents.length }
        })
      } catch { return refuseOwnedCleanup() }
    })()
    inFlight.add(execution)
    void execution.then(() => inFlight.delete(execution), () => inFlight.delete(execution))
    try { return await Promise.race([execution, expiry]) }
    catch { return refuseOwnedCleanup() }
    finally { if (timer) clearTimeout(timer); poisoned = true; void execution.catch(() => {}) }
  }
  return Object.freeze(Object.assign(run, { async drain(): Promise<void> {
    await Promise.allSettled([...inFlight])
  } }))
}

function assertCleanupOwner(generation: OwnedCleanupGeneration, owner: RecoveryArchivePreparedCaptureOwner): void {
  if (generation.build_status !== 'abandoned' || generation.owner_kind !== owner.ownerKind || generation.owner_id !== owner.ownerId
    || generation.owner_fence !== owner.ownerFence || generation.source_vector_hash !== owner.sourceVectorHash || generation.expired !== false) refuseOwnedCleanup()
}
