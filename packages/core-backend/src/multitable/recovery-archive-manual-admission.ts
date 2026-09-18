import { createHash, randomUUID } from 'node:crypto'
import { acquireCanonicalSheetFence, assertNoActiveWriterBlock } from './canonical-sheet-fence'
import { lockActiveRecoveryArchiveKeyForReference } from './recovery-archive-key-registry'
import { bindRecoveryArchiveManualRequest, readRecoveryArchiveManualRequest,
  type RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import { allocateRecoveryArchiveSnapshotIdentities, persistRecoveryArchiveSnapshotReservations,
  consumeRecoveryArchiveBootstrapReservations } from './recovery-archive-section-bootstrap'
import { allocateRecoveryArchiveCheckpointIdentities, persistRecoveryArchiveCheckpointReservations,
  consumeRecoveryArchiveCheckpointReservations } from './recovery-archive-section-checkpoint'
import { computeRecoveryArchiveSourceVectorHash, computeRecoveryArchiveCheckpointVectorHash } from './recovery-archive-source-vector'
import type { RecoveryArchivePreparedUploadInput } from './recovery-archive-prepared-upload'
import type { SealQuery } from './recovery-archive-seals'
import { readRecoveryArchiveCaptureSource, type RecoveryArchiveCaptureSource } from './recovery-archive-relational-source'
import { canonicalizeRecoveryArchiveJson, canonicalizeRecoveryArchiveSectionRows } from './recovery-archive-manifest'
import { buildRecoveryArchiveSectionRows, RECOVERY_ARCHIVE_DATA_SECTION_NAMES } from './recovery-archive-section-rows'
import { readRecoveryArchivePreparedCapture, type RecoveryArchivePreparedCaptureOwner } from './recovery-archive-prepared-capture'
import { claimRecoveryArchiveSourcePinIntent } from './recovery-archive-source-pin'
import type { RecoveryArchiveNonceReservationSink } from './recovery-archive-crypto'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from './recovery-archive-contract'
import { buildRecoveryArchiveSnapshotPlan } from './recovery-archive-snapshot-plan'

const sourceBrand = Symbol('manual-capture-source')
export interface RecoveryArchiveManualSource { readonly [sourceBrand]: true }
export interface RecoveryArchiveManualAdmissionResult {
  generationId: string
  replayed: boolean
  source: RecoveryArchiveManualSource | null
}
const sources = new WeakMap<RecoveryArchiveManualSource, {
  identity: RecoveryArchiveManualRequest
  owner: RecoveryArchivePreparedCaptureOwner
  snapshot: RecoveryArchiveCaptureSource
  hash: string
  binding: RecoveryArchivePreparedUploadInput['binding']
  consumed: boolean
  keyRowVersion: string
  repeat: boolean
}>()

function sourceHash(source: RecoveryArchiveCaptureSource): string {
  return createHash('sha256').update(canonicalizeRecoveryArchiveJson(source)).digest('hex')
}

/** In-memory plaintext for the first attempt only; never a public response or a durable restart proof. */
export function readRecoveryArchiveManualSource(source: RecoveryArchiveManualSource): RecoveryArchiveCaptureSource {
  const entry = sources.get(source)
  if (!entry) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
  return structuredClone(entry.snapshot)
}

/** First encryption attempt only. A lost/consumed source must not be reconstructed from later live data. */
export function takeRecoveryArchiveManualSource(
  source: RecoveryArchiveManualSource, identity: Pick<RecoveryArchiveManualRequest, 'actorId' | 'workspaceId' | 'baseId' | 'sheetId'>,
  owner: RecoveryArchivePreparedCaptureOwner, binding: RecoveryArchivePreparedUploadInput['binding'],
): RecoveryArchiveCaptureSource {
  const entry = sources.get(source)
  if (!entry || entry.consumed) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
  if ((['actorId', 'workspaceId', 'baseId', 'sheetId'] as const).some((key) => identity[key] !== entry.identity[key])
    || (Object.keys(entry.owner) as (keyof RecoveryArchivePreparedCaptureOwner)[]).some((key) => owner[key] !== entry.owner[key])
    || (Object.keys(entry.binding) as (keyof typeof binding)[]).some((key) => binding[key] !== entry.binding[key])) {
    throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_BINDING_MISMATCH')
  }
  entry.consumed = true
  return structuredClone(entry.snapshot)
}

/** Recheck after external preparation, under the same fence, without replacing the original snapshot. */
export function bindRecoveryArchiveManualSourceRecheck(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
) {
  return async (source: RecoveryArchiveManualSource): Promise<void> => {
    await transaction(async (query) => { await recheckManualSource(query, source, authorize) })
  }
}

async function recheckManualSource(
  query: SealQuery, source: RecoveryArchiveManualSource,
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
) {
  const entry = sources.get(source)
  if (!entry) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
  await acquireCanonicalSheetFence(query, entry.identity.sheetId)
  await lockActiveRecoveryArchiveKeyForReference(query, {
    keyId: entry.binding.keyId, expectedRowVersion: entry.keyRowVersion,
  })
  let allowed = false
  try { allowed = await authorize(query, entry.identity) } catch {
    throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
  }
  if (!allowed) throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
  await assertNoActiveWriterBlock(query, entry.identity.sheetId)
  await readRecoveryArchivePreparedCapture(query, entry.owner)
  const current = await readRecoveryArchiveCaptureSource(query, entry.identity)
  if (sourceHash(current) !== entry.hash) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_CHANGED')
  return entry
}

/** Server-owned atomic nonce sink. Never delegates reservation authority to a capture callback. */
export function bindRecoveryArchiveManualNonceReservation(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  source: RecoveryArchiveManualSource,
): RecoveryArchiveNonceReservationSink {
  return async (input) => {
    const rows = input.map((row) => ({ ...row }))
    await transaction(async (query) => {
      const entry = await recheckManualSource(query, source, authorize)
      if (!entry.consumed || rows.length !== RECOVERY_ARCHIVE_V1_SECTION_NAMES.length
        || rows.some((row, index) => row.sectionName !== RECOVERY_ARCHIVE_V1_SECTION_NAMES[index]
          || row.generationId !== entry.binding.generationId || row.formatVersion !== entry.binding.formatVersion
          || row.aeadAlgorithm !== entry.binding.aeadAlgorithm || row.dekFingerprint !== rows[0]!.dekFingerprint)) {
        throw new Error('RECOVERY_ARCHIVE_MANUAL_NONCE_BINDING_MISMATCH')
      }
      if (entry.snapshot.attachmentCandidates.length) throw new Error('RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE')
      try {
        for (const row of rows) await query(`SELECT public.meta_recovery_archive_reserve_nonce($1,$2,$3::uuid,$4,$5,$6)`,
          [row.dekFingerprint, row.nonceHex, row.generationId, row.sectionName, row.aeadAlgorithm, row.formatVersion])
      } catch { throw new Error('RECOVERY_ARCHIVE_MANUAL_NONCE_RESERVATION_REFUSED') }
    })
  }
}

/** Seal captured source and derive coverage from the actual committed-history row shapes. No custody or storage IO. */
export function bindRecoveryArchiveManualSectionPlan(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
) {
  return async (source: RecoveryArchiveManualSource, nonces: Record<string, Uint8Array>) => transaction(async (query) => {
    const entry = await recheckManualSource(query, source, authorize)
    if (!entry.consumed) throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
    if (entry.snapshot.attachmentCandidates.length) throw new Error('RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE')
    const sectionRows = { ...entry.snapshot.sections, attachments_index: [], permission_evidence: [] }
    const sections = RECOVERY_ARCHIVE_DATA_SECTION_NAMES.map((sectionKind) => {
      const canonical = canonicalizeRecoveryArchiveSectionRows(sectionKind,
        buildRecoveryArchiveSectionRows(sectionKind, sectionRows[sectionKind]))
      return { sectionKind, rowCount: canonical.rowCount, sourceHash: canonical.plaintextSha256 }
    })
    const sealInput = { ...entry.owner, sheetId: entry.identity.sheetId, sections }
    const plan = entry.repeat ? await consumeRecoveryArchiveCheckpointReservations(query, sealInput)
      : await consumeRecoveryArchiveBootstrapReservations(query, sealInput)
    const ids = plan.sections.map((section) => section.operationId)
    const revisions = await query(`SELECT id::text, sheet_id, section_kind, entity_key, action, payload,
      tombstone, seq::text, operation_id::text,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM meta_sheet_section_revisions WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[])`, [plan.sheetId, ids])
    const endpoints = await query(`SELECT sheet_id, operation_id::text, endpoint_seq::text, event_count,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
      operation_kind, event_contract_version, component_count
      FROM meta_record_history_operations WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[])`,
    [plan.sheetId, [...ids, plan.snapshotOperationId]])
    const members = await query(`SELECT sheet_id, parent_operation_id::text, ordinal, section_kind,
      source_head_kind, source_operation_id::text, source_head_seq::text, row_count::text, source_hash,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      FROM meta_record_history_snapshot_members WHERE sheet_id=$1 AND parent_operation_id=$2::uuid`,
    [plan.sheetId, plan.snapshotOperationId])
    if (revisions.rows.length !== 9 || endpoints.rows.length !== 10 || members.rows.length !== 9) {
      throw new Error('RECOVERY_ARCHIVE_MANUAL_COVERAGE_INCOMPLETE')
    }
    const coverageCandidates = [
      ...(revisions.rows as Record<string, unknown>[]).map((row) => ({ sourceKind: 'section_revision', boundSection: row.section_kind, row, sourceSeq: row.seq })),
      ...(endpoints.rows as Record<string, unknown>[]).map((row) => ({ sourceKind: 'sealed_operation_endpoint', boundSection: 'manifest_root', row, sourceSeq: row.endpoint_seq })),
      ...(members.rows as Record<string, unknown>[]).map((row) => ({ sourceKind: 'snapshot_membership', boundSection: row.section_kind, row, sourceSeq: row.source_head_seq })),
    ]
    return buildRecoveryArchiveSnapshotPlan({ sectionRows, coverageCandidates, nonces })
  })
}

export interface RecoveryArchiveManualAdmissionPolicy {
  keyId: string
  keyRowVersion: string
  leaseSeconds: number
  expiresAfterSeconds: number
}

/** Internal admission/source snapshot. Policy and identity are server-owned, never HTTP-body aliases.
 * No nonce is reserved, object uploaded or catalog entry published here.
 */
export function bindRecoveryArchiveManualAdmission(
  transaction: RecoveryArchivePreparedUploadInput['transaction'],
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  policyInput: RecoveryArchiveManualAdmissionPolicy,
) {
  const policy = Object.freeze({ ...policyInput })
  if (!Number.isSafeInteger(policy.leaseSeconds) || policy.leaseSeconds <= 0
    || !Number.isSafeInteger(policy.expiresAfterSeconds) || policy.expiresAfterSeconds < policy.leaseSeconds
    || policy.expiresAfterSeconds > 2147483647) throw new Error('RECOVERY_ARCHIVE_MANUAL_POLICY_INVALID')
  return async (input: RecoveryArchiveManualRequest): Promise<RecoveryArchiveManualAdmissionResult> => {
    const identity = Object.freeze({ ...input })
    return transaction(async (query) => {
      await acquireCanonicalSheetFence(query, identity.sheetId)
      // Different-scope requests with the same actor/request key also serialize.
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['recovery-archive-manual', identity.actorId, identity.requestId])])
      let allowed = false
      try { allowed = await authorize(query, identity) } catch {
        throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
      }
      if (!allowed) throw new Error('RECOVERY_ARCHIVE_MANUAL_AUTHORITY_UNAVAILABLE')
      const existing = await readRecoveryArchiveManualRequest(query, identity)
      if (existing !== null) return { generationId: existing, replayed: true, source: null }
      await lockActiveRecoveryArchiveKeyForReference(query, {
        keyId: policy.keyId, expectedRowVersion: policy.keyRowVersion,
      })
      await assertNoActiveWriterBlock(query, identity.sheetId)
      const trust = await query(`SELECT id FROM public.meta_history_trust_checkpoints
        WHERE sheet_id=$1 AND state='active' AND pruned_at IS NULL ORDER BY id FOR SHARE`, [identity.sheetId])
      const checkpointId = (trust.rows[0] as { id?: unknown } | undefined)?.id
      if (trust.rows.length !== 1 || typeof checkpointId !== 'string') {
        throw new Error('RECOVERY_ARCHIVE_MANUAL_TRUST_UNAVAILABLE')
      }
      const marker = await query(`SELECT sheet_id FROM public.meta_recovery_archive_section_bootstrap_markers
        WHERE sheet_id=$1`, [identity.sheetId])
      const repeat = marker.rows.length > 0
      const allocated = repeat ? await allocateRecoveryArchiveCheckpointIdentities(query)
        : await allocateRecoveryArchiveSnapshotIdentities(query)
      const heads = allocated.sections.map((section) => ({
        sourceHeadKind: repeat ? 'section_checkpoint' as const : 'section_bootstrap' as const,
        sectionKind: section.sectionKind, operationId: section.operationId, headSeq: section.endpointSeq,
      }))
      const sourceVectorHash = (repeat ? computeRecoveryArchiveCheckpointVectorHash(heads)
        : computeRecoveryArchiveSourceVectorHash(heads)).hash
      const generationId = randomUUID()
      const plan = { ...allocated, generationId, sheetId: identity.sheetId, sourceVectorHash,
        ownerKind: 'archive_builder', ownerId: generationId, ownerFence: '1' }
      const generation = await query(`INSERT INTO public.meta_recovery_archives (
        generation_id,workspace_id,base_id,sheet_id,anchor_operation_id,anchor_seq,
        checkpoint_id,source_vector_hash,key_id,owner_kind,owner_id,owner_fence,lease_expires_at,expires_at
      ) VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6::bigint,$7,$8,$9,'archive_builder',$1::text,1,
        clock_timestamp()+$10::int*interval '1 second',clock_timestamp()+$11::int*interval '1 second')
        RETURNING lease_expires_at::text AS lease_until`,
      [generationId, identity.workspaceId, identity.baseId, identity.sheetId,
        allocated.snapshotOperationId, allocated.snapshotSeq, checkpointId, sourceVectorHash,
        policy.keyId, policy.leaseSeconds, policy.expiresAfterSeconds])
      if (repeat) await persistRecoveryArchiveCheckpointReservations(query, plan, allocated)
      else await persistRecoveryArchiveSnapshotReservations(query, plan, allocated)
      await bindRecoveryArchiveManualRequest(query, identity, generationId)
      const snapshot = await readRecoveryArchiveCaptureSource(query, identity)
      if (snapshot.attachmentCandidates.some((attachment) => attachment.blobPurged)) {
        throw new Error('RECOVERY_ARCHIVE_MANUAL_ATTACHMENT_UNAVAILABLE')
      }
      const leaseUntil = (generation.rows[0] as { lease_until?: unknown } | undefined)?.lease_until
      if (typeof leaseUntil !== 'string') throw new Error('RECOVERY_ARCHIVE_MANUAL_SOURCE_UNAVAILABLE')
      // Intent only: immutable version/hash/bytes must be verified outside this admission.
      for (const attachment of snapshot.attachmentCandidates) {
        await claimRecoveryArchiveSourcePinIntent(query, { generationId, attachmentId: attachment.attachmentId,
          keyId: policy.keyId, ownerKind: plan.ownerKind, ownerId: plan.ownerId,
          ownerFence: plan.ownerFence, leaseUntil })
      }
      const source: RecoveryArchiveManualSource = Object.freeze({ [sourceBrand]: true as const })
      sources.set(source, { identity, owner: { generationId, ownerKind: plan.ownerKind,
        ownerId: plan.ownerId, ownerFence: plan.ownerFence, sourceVectorHash }, snapshot, hash: sourceHash(snapshot),
      consumed: false, repeat, keyRowVersion: policy.keyRowVersion, binding: { formatVersion: 1, generationId, workspaceId: identity.workspaceId,
        baseId: identity.baseId, sheetId: identity.sheetId, anchorOperationId: allocated.snapshotOperationId,
        anchorSeq: allocated.snapshotSeq, checkpointId, keyId: policy.keyId, aeadAlgorithm: 'aes-256-gcm' } })
      return { generationId, replayed: false, source }
    })
  }
}
