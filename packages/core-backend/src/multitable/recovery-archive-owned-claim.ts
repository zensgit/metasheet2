import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Pool, PoolClient } from 'pg'

import { snapshotRecoveryArchiveCaptureLimits, type RecoveryArchiveCaptureLimits } from './recovery-archive-bounded-source'
import { lockActiveRecoveryArchiveKeyForReference } from './recovery-archive-key-registry'
import { snapshotRecoveryArchiveManualPolicy, type RecoveryArchiveManualAdmissionPolicy } from './recovery-archive-manual-admission'
import { bindRecoveryArchiveManualRequest, readRecoveryArchiveManualRequest, type RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import { allocateRecoveryArchiveSnapshotIdentities, persistRecoveryArchiveSnapshotReservations,
  type RecoveryArchiveSnapshotReservationPlan } from './recovery-archive-section-bootstrap'
import { allocateRecoveryArchiveCheckpointIdentities, persistRecoveryArchiveCheckpointReservations } from './recovery-archive-section-checkpoint'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from './recovery-archive-seals'
import { claimRecoveryArchiveSourcePinIntent } from './recovery-archive-source-pin'
import { computeRecoveryArchiveCheckpointVectorHash, computeRecoveryArchiveSourceVectorHash } from './recovery-archive-source-vector'
import { claimArchiveWriterBlockPrepared, checkArchiveWriterBlockOwnerExact,
  prepareArchiveWriterBlockTransaction, type ArchiveWriterBlockSnapshot } from './recovery-archive-writer-block'

const claimBrand = Symbol('committed-recovery-archive-claim')
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/
export interface RecoveryArchiveCommittedClaim { readonly [claimBrand]: true }
export type RecoveryArchiveCommittedClaimSnapshot = {
  identity: Readonly<RecoveryArchiveManualRequest>
  generationOwner: { generationId: string; ownerKind: 'archive_builder'; ownerId: string; ownerFence: '1'; sourceVectorHash: string }
  writerBlock: ArchiveWriterBlockSnapshot
  key: { keyId: string; rowVersion: string }
  reservationPlan: RecoveryArchiveSnapshotReservationPlan
  observedHeads: {
    operationHead: { operationId: string; endpointSeq: string } | null
    sectionHeads: Array<{ sectionKind: string; operationId: string; seq: string }>
  }
  sourcePinIds: string[]
  leaseUntil: string
  expiresAt: string
  checkpointId: string
  generationClaimedAt: string
  generationCreatedAt: string
  repeat: boolean
}
const claims = new WeakMap<RecoveryArchiveCommittedClaim, RecoveryArchiveCommittedClaimSnapshot>()
const consumedClaims = new WeakSet<RecoveryArchiveCommittedClaim>()

export type RecoveryArchiveClaimErrorCode =
  | 'RECOVERY_ARCHIVE_CLAIM_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_CLAIM_POLICY_INVALID'
  | 'RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE'
  | 'RECOVERY_ARCHIVE_CLAIM_AUTHORITY_UNAVAILABLE'
  | 'RECOVERY_ARCHIVE_CLAIM_ATTACHMENT_UNAVAILABLE'
  | 'RECOVERY_ARCHIVE_CLAIM_BYTE_LIMIT_EXCEEDED'
  | 'RECOVERY_ARCHIVE_CLAIM_TIME_EXCEEDED'
  | 'RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE'

export class RecoveryArchiveClaimError extends Error {
  constructor(readonly code: RecoveryArchiveClaimErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveClaimError'
  }
}

function fail(code: RecoveryArchiveClaimErrorCode): never { throw new RecoveryArchiveClaimError(code) }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** A copy of the issued binding, never an entry point for constructing authority from a DTO. */
export function readRecoveryArchiveCommittedClaim(token: RecoveryArchiveCommittedClaim): RecoveryArchiveCommittedClaimSnapshot {
  const entry = claims.get(token)
  if (!entry) fail('RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE')
  return freeze(structuredClone(entry))
}

/** Internal phase handoff. Consumption is synchronous, permanent, and never reconstructible from a copy. */
export function takeRecoveryArchiveCommittedClaim(token: RecoveryArchiveCommittedClaim): RecoveryArchiveCommittedClaimSnapshot {
  const entry = claims.get(token)
  if (!entry || consumedClaims.has(token)) fail('RECOVERY_ARCHIVE_CLAIM_CAPABILITY_UNAVAILABLE')
  consumedClaims.add(token)
  return entry
}

function snapshotIdentity(input: RecoveryArchiveManualRequest): Readonly<RecoveryArchiveManualRequest> {
  const identity = { ...input }
  if (Object.keys(identity).sort().join(',') !== 'actorId,baseId,requestId,sheetId,workspaceId'
    || !UUID.test(identity.actorId) || !UUID.test(identity.requestId)
    || [identity.workspaceId, identity.baseId, identity.sheetId]
      .some((value) => typeof value !== 'string' || !value || value.trim() !== value)) {
    fail('RECOVERY_ARCHIVE_CLAIM_INVALID_INPUT')
  }
  return freeze(identity)
}

async function claimInTransaction(
  query: SealQuery, identity: Readonly<RecoveryArchiveManualRequest>,
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  policy: Readonly<RecoveryArchiveManualAdmissionPolicy>, limits: Readonly<RecoveryArchiveCaptureLimits>,
): Promise<{ generationId: string; candidate: RecoveryArchiveCommittedClaimSnapshot | null }> {
  const prepared = await prepareArchiveWriterBlockTransaction(query, identity.sheetId)
  // Match the existing manual path: a cross-sheet request must never hold the key while waiting
  // for the request lock held by a manual admission that is itself waiting for that key.
  await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [JSON.stringify(['recovery-archive-manual', identity.actorId, identity.requestId])])
  await lockActiveRecoveryArchiveKeyForReference(query, { keyId: policy.keyId, expectedRowVersion: policy.keyRowVersion })
  let allowed = false
  try { allowed = await authorize(query, identity) } catch { fail('RECOVERY_ARCHIVE_CLAIM_AUTHORITY_UNAVAILABLE') }
  if (!allowed) fail('RECOVERY_ARCHIVE_CLAIM_AUTHORITY_UNAVAILABLE')
  const scope = await query(`SELECT s.id FROM public.meta_sheets s
    JOIN public.meta_bases b ON b.id=s.base_id
    WHERE s.id=$1 AND s.base_id=$2 AND b.workspace_id=$3
      AND s.deleted_at IS NULL AND b.deleted_at IS NULL`, [identity.sheetId, identity.baseId, identity.workspaceId])
  if (scope.rows.length !== 1) fail('RECOVERY_ARCHIVE_CLAIM_AUTHORITY_UNAVAILABLE')
  const existing = await readRecoveryArchiveManualRequest(query, identity)
  if (existing !== null) return { generationId: existing, candidate: null }

  const trust = await query(`SELECT id FROM public.meta_history_trust_checkpoints
    WHERE sheet_id=$1 AND state='active' AND pruned_at IS NULL ORDER BY id`, [identity.sheetId])
  const checkpointId = (trust.rows[0] as { id?: unknown } | undefined)?.id
  if (trust.rows.length !== 1 || typeof checkpointId !== 'string') fail('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
  const operation = await query(`SELECT operation_id::text AS "operationId", endpoint_seq::text AS "endpointSeq"
    FROM public.meta_record_history_operations WHERE sheet_id=$1 ORDER BY endpoint_seq DESC LIMIT 1`, [identity.sheetId])
  const sections = await query(`SELECT DISTINCT ON (section_kind) section_kind AS "sectionKind",
    operation_id::text AS "operationId", seq::text AS seq FROM public.meta_sheet_section_revisions
    WHERE sheet_id=$1 AND section_kind=ANY($2::text[]) ORDER BY section_kind,seq DESC`,
  [identity.sheetId, [...SECTION_CAUSALITY_DATA_SECTION_KINDS]])
  const observedHeads = { operationHead: (operation.rows[0] ?? null) as RecoveryArchiveCommittedClaimSnapshot['observedHeads']['operationHead'],
    sectionHeads: sections.rows as RecoveryArchiveCommittedClaimSnapshot['observedHeads']['sectionHeads'] }
  const marker = await query('SELECT sheet_id FROM public.meta_recovery_archive_section_bootstrap_markers WHERE sheet_id=$1', [identity.sheetId])
  const repeat = marker.rows.length === 1
  const clock = await query(`WITH t AS MATERIALIZED (SELECT clock_timestamp() AS claimed_at)
    SELECT claimed_at::text AS claimed_at,
      (claimed_at+$1::int*interval '1 second')::text AS lease_until,
      (claimed_at+$2::int*interval '1 second')::text AS expires_at FROM t`, [policy.leaseSeconds, policy.expiresAfterSeconds])
  const times = clock.rows[0] as { claimed_at?: unknown; lease_until?: unknown; expires_at?: unknown } | undefined
  if (clock.rows.length !== 1 || [times?.claimed_at, times?.lease_until, times?.expires_at].some((value) => typeof value !== 'string')) {
    fail('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
  }
  const claimedAt = times!.claimed_at as string
  const leaseUntil = times!.lease_until as string
  const expiresAt = times!.expires_at as string
  const generationId = randomUUID()
  const expired = await query(`SELECT recovery_writer_state AS state,
    recovery_writer_owner_kind AS "ownerKind",recovery_writer_owner_id AS "ownerId",
    recovery_writer_owner_fence::text AS fence,recovery_writer_lease_until::text AS "leaseUntil",
    recovery_writer_updated_at::text AS "updatedAt" FROM public.meta_sheets
    WHERE id=$1 AND recovery_writer_state='archiving' AND recovery_writer_lease_until<=clock_timestamp()`, [identity.sheetId])
  // An expired tuple permits only a newer exact-owner CAS, never an implicit clear or revival.
  const previousBlock = expired.rows[0] as ArchiveWriterBlockSnapshot | undefined
  const writerBlock = await claimArchiveWriterBlockPrepared(prepared, {
    ownerKind: 'archive_generation', ownerId: generationId, leaseUntil, previous: previousBlock,
  })
  const allocated = repeat ? await allocateRecoveryArchiveCheckpointIdentities(query) : await allocateRecoveryArchiveSnapshotIdentities(query)
  const heads = allocated.sections.map((section) => ({ sourceHeadKind: repeat ? 'section_checkpoint' as const : 'section_bootstrap' as const,
    sectionKind: section.sectionKind, operationId: section.operationId, headSeq: section.endpointSeq }))
  const sourceVectorHash = (repeat ? computeRecoveryArchiveCheckpointVectorHash(heads) : computeRecoveryArchiveSourceVectorHash(heads)).hash
  const generationOwner = { generationId, ownerKind: 'archive_builder' as const, ownerId: generationId, ownerFence: '1' as const, sourceVectorHash }
  const plan = { ...allocated, ...generationOwner, sheetId: identity.sheetId }
  const generation = await query(`INSERT INTO public.meta_recovery_archives (
    generation_id,workspace_id,base_id,sheet_id,anchor_operation_id,anchor_seq,checkpoint_id,
    source_vector_hash,key_id,owner_kind,owner_id,owner_fence,lease_expires_at,expires_at,created_at
  ) VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6::bigint,$7,$8,$9,'archive_builder',$1::text,1,
    $10::timestamptz,$11::timestamptz,$12::timestamptz)
  RETURNING to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`,
  [generationId, identity.workspaceId, identity.baseId, identity.sheetId, allocated.snapshotOperationId,
    allocated.snapshotSeq, checkpointId, sourceVectorHash, policy.keyId, leaseUntil, expiresAt, claimedAt])

  // Owned-only immutable timestamps are explicit. The existing persist APIs then audit the exact
  // allocated plan; their legacy INSERT and consume/seal behavior remains unchanged.
  const reservations = [...allocated.sections.map((section) => ({ ordinal: section.ordinal,
    kind: repeat ? 'section_checkpoint' : 'section_bootstrap', sectionKind: section.sectionKind,
    operationId: section.operationId, seq: section.endpointSeq })),
  { ordinal: 10, kind: 'archive_snapshot', sectionKind: null, operationId: allocated.snapshotOperationId, seq: allocated.snapshotSeq }]
  for (const reservation of reservations) await query(`INSERT INTO public.meta_recovery_archive_snapshot_reservations
    (generation_id,sheet_id,ordinal,reservation_kind,section_kind,operation_id,endpoint_seq,
     source_vector_hash,owner_kind,owner_id,owner_fence,created_at)
    VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,$7::bigint,$8,'archive_builder',$1::text,1,$9::timestamptz)`,
  [generationId, identity.sheetId, reservation.ordinal, reservation.kind, reservation.sectionKind,
    reservation.operationId, reservation.seq, sourceVectorHash, claimedAt])
  const reservationPlan = repeat ? await persistRecoveryArchiveCheckpointReservations(query, plan, allocated)
    : await persistRecoveryArchiveSnapshotReservations(query, plan, allocated)

  const sourcePinIds: string[] = []
  let previous: string | null = null
  let remainingBytes = limits.maxBytes
  while (true) {
    const result = await query(`WITH candidate AS (
      SELECT id::text AS entity_key, jsonb_build_object('attachmentId',id,
        'purged',blob_purged_at IS NOT NULL,'purgeClaimed',blob_purge_claimed_at IS NOT NULL)::text AS payload
      FROM public.multitable_attachments WHERE sheet_id=$1
        AND ($2::text IS NULL OR id::text COLLATE "C">$2::text COLLATE "C")
      ORDER BY id::text COLLATE "C" LIMIT 1)
      SELECT octet_length(payload) AS payload_bytes,
        CASE WHEN octet_length(payload)<=$3 THEN entity_key END AS entity_key,
        CASE WHEN octet_length(payload)<=$3 THEN payload END AS payload FROM candidate`, [identity.sheetId, previous, remainingBytes])
    if (!result.rows.length) break
    const row = result.rows[0] as { payload_bytes?: unknown; entity_key?: unknown; payload?: unknown }
    if (result.rows.length !== 1 || !Number.isSafeInteger(row.payload_bytes) || Number(row.payload_bytes) <= 0) fail('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
    if (Number(row.payload_bytes) > remainingBytes) fail('RECOVERY_ARCHIVE_CLAIM_BYTE_LIMIT_EXCEEDED')
    if (typeof row.payload !== 'string' || typeof row.entity_key !== 'string'
      || Buffer.byteLength(row.payload) !== row.payload_bytes) fail('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
    const pin = JSON.parse(row.payload) as { attachmentId?: unknown; purged?: unknown; purgeClaimed?: unknown }
    if (Object.keys(pin).sort().join(',') !== 'attachmentId,purgeClaimed,purged'
      || pin.attachmentId !== row.entity_key || !row.entity_key || row.entity_key.trim() !== row.entity_key
      || typeof pin.purged !== 'boolean' || typeof pin.purgeClaimed !== 'boolean') fail('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
    if (pin.purged || pin.purgeClaimed) fail('RECOVERY_ARCHIVE_CLAIM_ATTACHMENT_UNAVAILABLE')
    await claimRecoveryArchiveSourcePinIntent(query, { ...generationOwner, attachmentId: row.entity_key, keyId: policy.keyId, leaseUntil })
    sourcePinIds.push(row.entity_key)
    previous = row.entity_key
    remainingBytes -= Number(row.payload_bytes)
  }
  await bindRecoveryArchiveManualRequest(query, identity, generationId)
  await checkArchiveWriterBlockOwnerExact(query, identity.sheetId, writerBlock)
  const generationCreatedAt = (generation.rows[0] as { created_at?: unknown } | undefined)?.created_at
  if (generation.rows.length !== 1 || typeof generationCreatedAt !== 'string') fail('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
  return { generationId, candidate: { identity, generationOwner, writerBlock, key: { keyId: policy.keyId, rowVersion: policy.keyRowVersion },
    reservationPlan, observedHeads, sourcePinIds, leaseUntil, expiresAt, checkpointId, generationClaimedAt: claimedAt, generationCreatedAt, repeat } }
}

/** No runtime caller: one new owned claim, confirmed COMMIT, then private authority issuance. */
export function bindRecoveryArchiveOwnedClaim(
  pool: Pick<Pool, 'connect' | 'options'>,
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  policyInput: RecoveryArchiveManualAdmissionPolicy, limitsInput: RecoveryArchiveCaptureLimits,
) {
  let policy: Readonly<RecoveryArchiveManualAdmissionPolicy>
  let limits: Readonly<RecoveryArchiveCaptureLimits>
  try { policy = snapshotRecoveryArchiveManualPolicy(policyInput); limits = snapshotRecoveryArchiveCaptureLimits(limitsInput) } catch {
    fail('RECOVERY_ARCHIVE_CLAIM_POLICY_INVALID')
  }
  return async (input: RecoveryArchiveManualRequest): Promise<{ generationId: string; replayed: boolean; claim: RecoveryArchiveCommittedClaim | null }> => {
    const identity = snapshotIdentity(input)
    const acquisitionTimeout = pool?.options?.connectionTimeoutMillis
    if (typeof acquisitionTimeout !== 'number' || !Number.isSafeInteger(acquisitionTimeout)
      || acquisitionTimeout <= 0 || acquisitionTimeout > limits.timeoutMs) fail('RECOVERY_ARCHIVE_CLAIM_POLICY_INVALID')
    const deadline = performance.now() + limits.timeoutMs
    let client: PoolClient | undefined
    let released = false
    let poisoned = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = () => new RecoveryArchiveClaimError('RECOVERY_ARCHIVE_CLAIM_TIME_EXCEEDED')
    const discard = () => { if (client && !released) { released = true; client.release(true) } }
    const assertLive = () => { if (poisoned || performance.now() >= deadline) throw timeout() }
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { poisoned = true; try { discard() } finally { reject(timeout()) } }, limits.timeoutMs)
    })
    const execution = (async () => {
      client = await pool.connect()
      assertLive()
      let inTransaction = false
      let firstBusinessStatement = true
      const remainingTimeout = () => `${Math.max(1, Math.ceil(deadline - performance.now()))}ms`
      const query: SealQuery = async (sql, params) => {
        if (released) fail('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
        assertLive()
        if (inTransaction && !firstBusinessStatement) {
          await client!.query("SELECT set_config('statement_timeout',$1,true)", [remainingTimeout()])
          assertLive()
        }
        const result = await client!.query(sql, params)
        assertLive()
        if (inTransaction) firstBusinessStatement = false
        return result
      }
      // Configure only this owned session before BEGIN. The first transaction business SQL stays
      // the source-free canonical fence; its server timeout also ends a blocked PG waiter after
      // client destruction, since a backend waiting on a lock need not notice a closed socket.
      const setting = await query('SHOW statement_timeout')
      const priorTimeout = (setting.rows[0] as { statement_timeout?: unknown } | undefined)?.statement_timeout
      if (typeof priorTimeout !== 'string') fail('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
      await query("SELECT set_config('statement_timeout',$1,false)", [remainingTimeout()])
      await query('BEGIN ISOLATION LEVEL READ COMMITTED')
      inTransaction = true
      const candidate = await claimInTransaction(query, identity, authorize, policy, limits)
      await query('COMMIT')
      inTransaction = false
      await query("SELECT set_config('statement_timeout',$1,false)", [priorTimeout])
      assertLive()
      released = true
      client.release()
      assertLive()
      return candidate
    })()
    try {
      const { generationId, candidate } = await Promise.race([execution, expiry])
      if (!candidate) return { generationId, replayed: true, claim: null }
      const binding = freeze(candidate)
      assertLive()
      const token: RecoveryArchiveCommittedClaim = Object.freeze({ [claimBrand]: true as const })
      claims.set(token, binding)
      return { generationId, replayed: false, claim: token }
    } catch (error) {
      poisoned = true
      discard()
      if (error instanceof RecoveryArchiveClaimError) throw error
      throw new RecoveryArchiveClaimError('RECOVERY_ARCHIVE_CLAIM_UNAVAILABLE')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      void execution.catch(() => { discard() })
    }
  }
}
