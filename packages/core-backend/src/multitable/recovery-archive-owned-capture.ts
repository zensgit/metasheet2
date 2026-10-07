import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Pool, PoolClient } from 'pg'

import { readRecoveryArchiveBoundedCaptureSource, RecoveryArchiveBoundedSourceError,
  snapshotRecoveryArchiveCaptureLimits, type RecoveryArchiveCaptureLimits } from './recovery-archive-bounded-source'
import { takeRecoveryArchiveCommittedClaim, type RecoveryArchiveCommittedClaim,
  type RecoveryArchiveCommittedClaimSnapshot } from './recovery-archive-owned-claim'
import type { RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import type { RecoveryArchiveCaptureSource } from './recovery-archive-relational-source'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from './recovery-archive-seals'

const capturedBrand = Symbol('owned-recovery-archive-capture')
export interface RecoveryArchiveCapturedSource { readonly [capturedBrand]: true }
export interface RecoveryArchiveCapturedSourceSnapshot {
  claim: RecoveryArchiveCommittedClaimSnapshot
  source: RecoveryArchiveCaptureSource
  attachmentDescriptors: Array<{ attachmentId: string; storageKey: string; immutableVersion: string;
    contentSha256: string; contentSizeBytes: string }>
  snapshotXid: string
}
const captures = new WeakMap<RecoveryArchiveCapturedSource, RecoveryArchiveCapturedSourceSnapshot>()
const TRANSACTION_SQL = `/* owned-capture:transaction */ SELECT pg_current_xact_id()::text AS xid,
  current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only,
  EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted) AS advisory_held`

// These authority queries transfer only a boolean and xid. The private binding is an input, never a DB aggregate.
const BINDING_SQL = `/* owned-capture:binding */ WITH binding AS (SELECT $1::jsonb AS c)
  SELECT pg_current_xact_id()::text AS xid, EXISTS (
    SELECT 1 FROM binding b JOIN public.meta_sheets s ON s.id=c#>>'{identity,sheetId}'
    JOIN public.meta_bases base ON base.id=s.base_id
    JOIN public.meta_recovery_archives a ON a.generation_id=(c#>>'{generationOwner,generationId}')::uuid
    JOIN public.meta_recovery_archive_keys k ON k.key_id=a.key_id
    JOIN public.meta_history_trust_checkpoints t ON t.id=a.checkpoint_id
    JOIN public.meta_recovery_archive_manual_requests r ON r.generation_id=a.generation_id
    WHERE s.base_id=c#>>'{identity,baseId}' AND base.workspace_id=c#>>'{identity,workspaceId}'
      AND s.deleted_at IS NULL AND base.deleted_at IS NULL
      AND s.recovery_writer_state='archiving'
      AND s.recovery_writer_owner_kind=c#>>'{writerBlock,ownerKind}'
      AND s.recovery_writer_owner_id=c#>>'{writerBlock,ownerId}'
      AND s.recovery_writer_owner_fence=(c#>>'{writerBlock,fence}')::bigint
      AND s.recovery_writer_lease_until=(c#>>'{writerBlock,leaseUntil}')::timestamptz
      AND s.recovery_writer_updated_at=(c#>>'{writerBlock,updatedAt}')::timestamptz
      AND s.recovery_writer_lease_until>clock_timestamp()
      AND k.key_id=c#>>'{key,keyId}' AND k.state='active' AND k.row_version=(c#>>'{key,rowVersion}')::bigint
      AND a.workspace_id=c#>>'{identity,workspaceId}' AND a.base_id=s.base_id AND a.sheet_id=s.id
      AND a.anchor_operation_id=(c#>>'{reservationPlan,snapshotOperationId}')::uuid
      AND a.anchor_seq=(c#>>'{reservationPlan,snapshotSeq}')::bigint
      AND a.source_vector_hash=c#>>'{generationOwner,sourceVectorHash}' AND a.format_version=1
      AND a.owner_kind=c#>>'{generationOwner,ownerKind}' AND a.owner_id=c#>>'{generationOwner,ownerId}'
      AND a.owner_fence=(c#>>'{generationOwner,ownerFence}')::bigint
      AND a.lease_expires_at=(c->>'leaseUntil')::timestamptz AND a.lease_expires_at>clock_timestamp()
      AND a.expires_at=(c->>'expiresAt')::timestamptz AND a.expires_at>clock_timestamp()
      AND a.created_at=(c->>'generationClaimedAt')::timestamptz
      AND a.state='building' AND a.build_status='active' AND a.coverage_status='incomplete'
      AND a.root_hash IS NULL AND a.coverage_section_hash IS NULL AND a.coverage_row_count IS NULL
      AND a.manifest_mac IS NULL AND a.superseded_by_generation_id IS NULL
      AND t.sheet_id=s.id AND t.state='active' AND t.pruned_at IS NULL
      AND (SELECT count(*) FROM public.meta_history_trust_checkpoints WHERE sheet_id=s.id AND state='active' AND pruned_at IS NULL)=1
      AND r.actor_id=(c#>>'{identity,actorId}')::uuid AND r.request_id=(c#>>'{identity,requestId}')::uuid
      AND r.workspace_id=a.workspace_id AND r.base_id=a.base_id AND r.sheet_id=s.id AND r.request_hash=$2
      AND EXISTS (SELECT 1 FROM public.meta_recovery_archive_section_bootstrap_markers WHERE sheet_id=s.id)=(c->>'repeat')::boolean
  ) AS matches`

const HEADS_SQL = `/* owned-capture:heads */ WITH binding AS (SELECT $1::jsonb AS c),
  expected AS (SELECT h."sectionKind" AS section_kind,h."operationId"::uuid AS operation_id,h.seq::bigint AS seq
    FROM binding,jsonb_to_recordset(c#>'{observedHeads,sectionHeads}') AS h("sectionKind" text,"operationId" text,seq text)),
  actual AS (SELECT DISTINCT ON (section_kind) section_kind,operation_id,seq FROM public.meta_sheet_section_revisions,binding
    WHERE sheet_id=c#>>'{identity,sheetId}' AND section_kind=ANY($2::text[]) ORDER BY section_kind,seq DESC)
  SELECT pg_current_xact_id()::text AS xid,
    NOT EXISTS ((SELECT * FROM actual EXCEPT ALL SELECT * FROM expected) UNION ALL
      (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual))
    AND (SELECT jsonb_build_object('operationId',operation_id::text,'endpointSeq',endpoint_seq::text)
      FROM public.meta_record_history_operations,binding WHERE sheet_id=c#>>'{identity,sheetId}' ORDER BY endpoint_seq DESC LIMIT 1)
      IS NOT DISTINCT FROM (SELECT NULLIF(c#>'{observedHeads,operationHead}','null'::jsonb) FROM binding) AS matches`

const RESERVATIONS_SQL = `/* owned-capture:reservations */ WITH binding AS (SELECT $1::jsonb AS c),
  expected AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
    AS e(ordinal integer,kind text,"sectionKind" text,"operationId" uuid,seq bigint)),
  actual AS (SELECT r.* FROM public.meta_recovery_archive_snapshot_reservations r,binding
    WHERE r.generation_id=(c#>>'{generationOwner,generationId}')::uuid)
  SELECT pg_current_xact_id()::text AS xid, (SELECT count(*) FROM actual)=10 AND NOT EXISTS (
    SELECT 1 FROM actual r LEFT JOIN expected e ON e.ordinal=r.ordinal CROSS JOIN binding
    WHERE e.ordinal IS NULL OR ROW(r.reservation_kind,r.section_kind,r.operation_id,r.endpoint_seq)
      IS DISTINCT FROM ROW(e.kind,e."sectionKind",e."operationId",e.seq)
      OR r.sheet_id IS DISTINCT FROM c#>>'{identity,sheetId}'
      OR r.source_vector_hash IS DISTINCT FROM c#>>'{generationOwner,sourceVectorHash}'
      OR r.owner_kind IS DISTINCT FROM c#>>'{generationOwner,ownerKind}'
      OR r.owner_id IS DISTINCT FROM c#>>'{generationOwner,ownerId}'
      OR r.owner_fence IS DISTINCT FROM (c#>>'{generationOwner,ownerFence}')::bigint
      OR r.created_at IS DISTINCT FROM (c->>'generationClaimedAt')::timestamptz
  ) AS matches`

const PINS_SQL = `/* owned-capture:pins */ WITH binding AS (SELECT $1::jsonb AS c),
  expected AS (SELECT jsonb_array_elements_text(c->'sourcePinIds') AS id FROM binding),
  pins AS (SELECT r.* FROM public.meta_recovery_archive_attachment_refs r,binding
    WHERE r.generation_id=(c#>>'{generationOwner,generationId}')::uuid),
  attachments AS (SELECT a.* FROM public.multitable_attachments a,binding WHERE a.sheet_id=c#>>'{identity,sheetId}')
  SELECT pg_current_xact_id()::text AS xid,
    (SELECT count(*) FROM pins)=(SELECT count(*) FROM expected)
    AND (SELECT count(*) FROM attachments)=(SELECT count(*) FROM expected)
    AND NOT EXISTS (SELECT 1 FROM pins p CROSS JOIN binding WHERE NOT EXISTS (SELECT 1 FROM expected WHERE id=p.attachment_id)
      OR p.reference_class<>'source' OR p.reference_state<>'building' OR p.availability<>'mutable'
      OR p.source_owner_kind IS DISTINCT FROM c#>>'{generationOwner,ownerKind}'
      OR p.source_owner_id IS DISTINCT FROM c#>>'{generationOwner,ownerId}'
      OR p.source_owner_fence IS DISTINCT FROM (c#>>'{generationOwner,ownerFence}')::bigint
      OR p.source_lease_until IS DISTINCT FROM (c->>'leaseUntil')::timestamptz OR p.source_lease_until<=clock_timestamp()
      OR p.immutable_version IS NOT NULL OR p.content_sha256 IS NOT NULL OR p.content_size_bytes IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM attachments a WHERE NOT EXISTS (SELECT 1 FROM expected WHERE id=a.id)
      OR a.blob_purged_at IS NOT NULL OR a.blob_purge_claimed_at IS NOT NULL) AS matches`

function unavailable(): never { throw new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE') }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Detached readback conveys no object, crypto, finalize, or reconstructed claim authority. */
export function readRecoveryArchiveCapturedSource(token: RecoveryArchiveCapturedSource): RecoveryArchiveCapturedSourceSnapshot {
  const value = captures.get(token)
  if (!value) unavailable()
  return freeze(structuredClone(value))
}

/** Internal single-attempt phase handoff; no HTTP caller, provider port, or arbitrary transaction callback. */
export function bindRecoveryArchiveOwnedCapture(
  pool: Pick<Pool, 'connect' | 'options'>,
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  limitsInput: RecoveryArchiveCaptureLimits,
) {
  const limits = snapshotRecoveryArchiveCaptureLimits(limitsInput)
  return async (token: RecoveryArchiveCommittedClaim): Promise<RecoveryArchiveCapturedSource> => {
    const claim = takeRecoveryArchiveCommittedClaim(token)
    const deadline = performance.now() + limits.timeoutMs
    const acquisitionTimeout = pool?.options?.connectionTimeoutMillis
    if (typeof acquisitionTimeout !== 'number' || !Number.isSafeInteger(acquisitionTimeout)
      || acquisitionTimeout <= 0 || acquisitionTimeout > limits.timeoutMs) {
      throw new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID')
    }
    let client: PoolClient | undefined
    let released = false
    let poisoned = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = () => new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
    const assertLive = () => { if (poisoned || performance.now() >= deadline) throw timeout() }
    const discard = () => { if (client && !released) { released = true; client.release(true) } }
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { poisoned = true; try { discard() } finally { reject(timeout()) } }, limits.timeoutMs)
    })
    const execution = (async (): Promise<RecoveryArchiveCapturedSourceSnapshot> => {
      client = await pool.connect()
      assertLive()
      let inTransaction = false
      const remainingTimeout = () => `${Math.max(1, Math.ceil(deadline - performance.now()))}ms`
      const query: SealQuery = async (sql, params) => {
        if (released) unavailable()
        assertLive()
        if (inTransaction) {
          await client!.query("SELECT set_config('statement_timeout',$1,true)", [remainingTimeout()])
          assertLive()
        }
        const result = await client!.query(sql, params)
        assertLive()
        return result
      }
      // An acquired connection may carry a leaked old transaction. End it before reading session
      // settings: ROLLBACK also restores any previous transaction-local timeout.
      await query('ROLLBACK')
      const setting = await query('SHOW statement_timeout')
      const priorTimeout = (setting.rows[0] as { statement_timeout?: unknown } | undefined)?.statement_timeout
      if (typeof priorTimeout !== 'string') unavailable()
      await query("SELECT set_config('statement_timeout',$1,false)", [remainingTimeout()])
      await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      inTransaction = true
      let snapshotXid: string | undefined
      const assertTransaction = async () => {
        const result = await query(TRANSACTION_SQL)
        const row = result.rows[0] as Record<string, unknown> | undefined
        if (result.rows.length !== 1 || row?.isolation !== 'repeatable read' || row.read_only !== 'on'
          || typeof row.xid !== 'string' || !row.xid || (snapshotXid !== undefined && row.xid !== snapshotXid)) {
          throw new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_TRANSACTION_REQUIRED')
        }
        if (row.advisory_held !== false) throw new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_FENCE_HELD')
        snapshotXid = row.xid
      }
      await assertTransaction()
      if (!await authorize(query, claim.identity)) unavailable()
      await assertTransaction()
      const binding = JSON.stringify(claim)
      const hash = createHash('sha256').update(JSON.stringify(['recovery-archive-manual-request', 1, claim.identity.actorId,
        claim.identity.workspaceId, claim.identity.baseId, claim.identity.sheetId])).digest('hex')
      const check = async (sql: string, params: unknown[]) => {
        const result = await query(sql, params)
        const row = result.rows[0] as { xid?: unknown; matches?: unknown } | undefined
        if (result.rows.length !== 1 || row?.xid !== snapshotXid || row.matches !== true) unavailable()
      }
      await check(BINDING_SQL, [binding, hash])
      await check(HEADS_SQL, [binding, [...SECTION_CAUSALITY_DATA_SECTION_KINDS]])
      const expected = [...claim.reservationPlan.sections.map((section) => ({ ordinal: section.ordinal,
        kind: claim.repeat ? 'section_checkpoint' : 'section_bootstrap', sectionKind: section.sectionKind,
        operationId: section.operationId, seq: section.endpointSeq })),
      { ordinal: 10, kind: 'archive_snapshot', sectionKind: null,
        operationId: claim.reservationPlan.snapshotOperationId, seq: claim.reservationPlan.snapshotSeq }]
      await check(RESERVATIONS_SQL, [binding, JSON.stringify(expected)])
      await check(PINS_SQL, [binding])
      const source = await readRecoveryArchiveBoundedCaptureSource(query, claim.identity,
        { maxBytes: limits.maxBytes, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) })
      const attachmentDescriptors = source.attachmentCandidates.map((candidate) => {
        const match = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sha256-([0-9a-f]{64})$/.exec(candidate.storagePath)
        if (candidate.storageProvider !== 'local' || candidate.blobPurged || !match) unavailable()
        return { attachmentId: candidate.attachmentId, storageKey: candidate.storagePath,
          immutableVersion: `sha256:${match[1]}`, contentSha256: match[1]!, contentSizeBytes: candidate.sizeBytes }
      })
      // Same snapshot, current clock only: later committed owner changes still require a fresh RC recheck downstream.
      await check(BINDING_SQL, [binding, hash])
      await check(PINS_SQL, [binding])
      await assertTransaction()
      await query('COMMIT')
      inTransaction = false
      await query("SELECT set_config('statement_timeout',$1,false)", [priorTimeout])
      assertLive()
      released = true
      client.release()
      assertLive()
      return { claim, source, attachmentDescriptors, snapshotXid: snapshotXid! }
    })()
    try {
      const result = freeze(await Promise.race([execution, expiry]))
      assertLive()
      const captured = Object.freeze({ [capturedBrand]: true as const })
      assertLive()
      captures.set(captured, result)
      return captured
    } catch (error) {
      poisoned = true
      discard()
      if (error instanceof RecoveryArchiveBoundedSourceError) throw error
      if ((error as { code?: unknown } | null)?.code === '57014') throw timeout()
      unavailable()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      void execution.catch(() => { discard() })
    }
  }
}
