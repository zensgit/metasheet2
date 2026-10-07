import { recoveryArchiveOwnedAttempt, recheckRecoveryArchiveOwnedAttempt, releaseRecoveryArchiveOwnedBlock,
  refuseOwned, type RecoveryArchiveOwnedAttempt } from './recovery-archive-owned-authority'
import { consumeRecoveryArchiveOwnedHistory, type planRecoveryArchiveOwnedHistory } from './recovery-archive-owned-history'
import { readRecoveryArchiveManualSnapshotPlan } from './recovery-archive-manual-admission'
import { readRecoveryArchivePreparedCapture } from './recovery-archive-prepared-capture'
import { decodeRecoveryArchivePreparedEnvelope } from './recovery-archive-prepared-upload'
import { parseRecoveryArchiveManifestObjectEnvelope } from './recovery-archive-manifest-object-envelope'
import { verifyRecoveryArchiveObjectReceipt } from './recovery-archive-object-receipts'
import type { RecoveryArchiveCoverageIndexPayload } from './recovery-archive-coverage-plan'
import type { RecoveryArchiveManualRequest } from './recovery-archive-manual-request'
import type { SealQuery } from './recovery-archive-seals'

/** No custody/provider calls. History, receipt verification, publication and block release commit together. */
export async function finalizeRecoveryArchiveOwnedAttempt(query: SealQuery, token: RecoveryArchiveOwnedAttempt,
  authorize: (query: SealQuery, identity: RecoveryArchiveManualRequest) => Promise<boolean>,
  planned: ReturnType<typeof planRecoveryArchiveOwnedHistory>, attachmentIndex: Record<string, unknown>[]): Promise<void> {
  await recheckRecoveryArchiveOwnedAttempt(query, token, authorize)
  const state = recoveryArchiveOwnedAttempt(token)
  const { claim, source } = state.captured
  const owner = claim.generationOwner
  const payload = await readRecoveryArchivePreparedCapture(query, owner)
  if (!state.payload || !payload?.equals(state.payload)) refuseOwned()
  const envelope = decodeRecoveryArchivePreparedEnvelope(payload)
  if (!envelope.manifestEnvelope) refuseOwned()
  const manifest = parseRecoveryArchiveManifestObjectEnvelope(envelope.manifestEnvelope).manifest
  const expectedNonces = state.nonces.map((nonce) => ({ fingerprint: nonce.dekFingerprint, nonce: nonce.nonceHex,
    generation: nonce.generationId, section: nonce.sectionName, algorithm: nonce.aeadAlgorithm, version: nonce.formatVersion }))
  const nonceCheck = await query(`WITH expected AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
    AS e(fingerprint text,nonce text,generation uuid,section text,algorithm text,version integer)),
    actual AS (SELECT * FROM public.meta_recovery_archive_nonce_reservations WHERE generation_id=$1::uuid)
    SELECT (SELECT count(*) FROM actual)=(SELECT count(*) FROM expected) AND NOT EXISTS (
      SELECT 1 FROM expected e LEFT JOIN actual a ON a.section_name=e.section WHERE a.section_name IS NULL
      OR ROW(a.dek_fingerprint,a.nonce,a.generation_id,a.aead_algorithm,a.format_version)
        IS DISTINCT FROM ROW(e.fingerprint,e.nonce,e.generation,e.algorithm,e.version)) AS matches`,
  [owner.generationId, JSON.stringify(expectedNonces)])
  if ((nonceCheck.rows[0] as { matches?: unknown } | undefined)?.matches !== true
    || state.nonces.length !== 10 + state.captured.attachmentDescriptors.length) refuseOwned()
  const count = await query('SELECT count(*)::int AS count FROM public.meta_recovery_archive_objects WHERE generation_id=$1::uuid', [owner.generationId])
  if ((count.rows[0] as { count?: unknown } | undefined)?.count !== 11 + state.captured.attachmentDescriptors.length
    || state.receipts.length !== 11 + state.captured.attachmentDescriptors.length) refuseOwned()
  for (const receipt of state.receipts) await verifyRecoveryArchiveObjectReceipt(query, receipt)
  await consumeRecoveryArchiveOwnedHistory(query, token, planned.contents)
  const nonces = Object.fromEntries(envelope.sections.map((section) => [section.sectionName, section.nonce]))
  const actualPlan = await readRecoveryArchiveManualSnapshotPlan(query, claim.identity.sheetId,
    claim.reservationPlan.snapshotOperationId, source, nonces, attachmentIndex)
  if (actualPlan.some((section, index) => section.rowCount !== planned.sections[index]?.rowCount
    || section.plaintextSha256 !== planned.sections[index]?.plaintextSha256
    || !Buffer.from(section.plaintext).equals(Buffer.from(planned.sections[index]!.plaintext))
    || section.rowCount !== manifest.sections[index]?.row_count || section.plaintextSha256 !== manifest.sections[index]?.plaintext_sha256)) refuseOwned()
  // Raw authority retains microseconds, separately from millisecond v1 canonical history projections.
  const raw = await query(`SELECT NOT EXISTS (SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations r
    JOIN public.meta_record_history_operations o ON o.sheet_id=r.sheet_id AND o.operation_id=r.operation_id
    WHERE r.generation_id=$1::uuid AND o.created_at IS DISTINCT FROM r.created_at)
    AND NOT EXISTS (SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations r
      JOIN public.meta_sheet_section_revisions v ON v.sheet_id=r.sheet_id AND v.operation_id=r.operation_id
      WHERE r.generation_id=$1::uuid AND (v.created_at IS DISTINCT FROM r.created_at OR v.id IS DISTINCT FROM r.operation_id))
    AND NOT EXISTS (SELECT 1 FROM public.meta_recovery_archive_snapshot_reservations p
      JOIN public.meta_record_history_snapshot_members m ON m.sheet_id=p.sheet_id AND m.parent_operation_id=p.operation_id
      WHERE p.generation_id=$1::uuid AND p.ordinal=10 AND m.created_at IS DISTINCT FROM p.created_at) AS matches`, [owner.generationId])
  if ((raw.rows[0] as { matches?: unknown } | undefined)?.matches !== true) refuseOwned()
  for (const attachment of envelope.attachments ?? []) {
    const receipt = state.receipts.find((item) => item.objectClass === 'attachment' && item.attachmentId === attachment.attachmentId)
    if (!receipt) refuseOwned()
    const inserted = await query(`INSERT INTO public.meta_recovery_archive_attachment_refs
      (generation_id,attachment_id,reference_class,reference_state,availability,content_sha256,immutable_version,content_size_bytes)
      VALUES ($1::uuid,$2,'archive_object','verified','available',$3,$4,$5::bigint)`,
    [owner.generationId, attachment.attachmentId, attachment.plaintextSha256, receipt.providerVersion, String(attachment.sizeBytes)])
    if (inserted.rowCount !== 1) refuseOwned()
    const removed = await query(`DELETE FROM public.meta_recovery_archive_attachment_refs
      WHERE generation_id=$1::uuid AND attachment_id=$2 AND reference_class='source'`, [owner.generationId, attachment.attachmentId])
    if (removed.rowCount !== 1) refuseOwned()
  }
  const coverageSection = planned.sections.find((section) => section.sectionName === 'coverage_index')!
  const coverage = JSON.parse(Buffer.from(coverageSection.plaintext).toString('utf8')) as { payload: RecoveryArchiveCoverageIndexPayload }[]
  if (coverage.length !== 28) refuseOwned()
  for (const { payload: item } of coverage) {
    const result = await query(`INSERT INTO public.meta_recovery_archive_coverage_items
      (generation_id,source_kind,source_id,source_seq,source_sha256,bound_section) VALUES ($1::uuid,$2,$3,$4::bigint,$5,$6)`,
    [owner.generationId, item.source_kind, item.source_id, item.source_seq, item.source_sha256, item.bound_section])
    if (result.rowCount !== 1) refuseOwned()
  }
  const result = await query(`UPDATE public.meta_recovery_archives SET state='verified',build_status='finalized',coverage_status='complete',
    root_hash=$2,coverage_section_hash=$3,coverage_row_count=$4::bigint,manifest_mac=$5::bytea
    WHERE generation_id=$1::uuid AND state='building' AND build_status='active' AND coverage_status='incomplete'
      AND owner_kind=$6 AND owner_id=$7 AND owner_fence=$8::bigint AND source_vector_hash=$9
      AND lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp()`,
  [owner.generationId, manifest.root_hash, coverageSection.plaintextSha256, coverageSection.rowCount,
    Buffer.from(manifest.manifest_mac!, 'hex'), owner.ownerKind, owner.ownerId, owner.ownerFence, owner.sourceVectorHash])
  if (result.rowCount !== 1 || await releaseRecoveryArchiveOwnedBlock(query, claim) !== 1) refuseOwned()
}
