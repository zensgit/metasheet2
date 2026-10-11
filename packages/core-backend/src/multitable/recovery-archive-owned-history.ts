import { recoveryArchiveOwnedAttempt, refuseOwned, type RecoveryArchiveOwnedAttempt } from './recovery-archive-owned-authority'
import { buildRecoveryArchiveSectionRows, RECOVERY_ARCHIVE_DATA_SECTION_NAMES } from './recovery-archive-section-rows'
import { canonicalizeRecoveryArchiveSectionRows } from './recovery-archive-manifest'
import { buildRecoveryArchiveSnapshotPlan } from './recovery-archive-snapshot-plan'
import type { SealQuery } from './recovery-archive-seals'

/** Pure future-history projection. No revision, seal or membership is persisted here. */
export function planRecoveryArchiveOwnedHistory(token: RecoveryArchiveOwnedAttempt,
  attachmentIndex: Record<string, unknown>[], nonces: Record<string, Uint8Array>) {
  const { captured } = recoveryArchiveOwnedAttempt(token)
  const claim = captured.claim
  const plan = claim.reservationPlan
  const sectionRows = { ...captured.source.sections, attachments_index: attachmentIndex, permission_evidence: [] }
  const contents = RECOVERY_ARCHIVE_DATA_SECTION_NAMES.map((sectionKind) => {
    const canonical = canonicalizeRecoveryArchiveSectionRows(sectionKind, buildRecoveryArchiveSectionRows(sectionKind, sectionRows[sectionKind]))
    return { sectionKind, rowCount: canonical.rowCount, sourceHash: canonical.plaintextSha256 }
  })
  const createdAt = claim.generationCreatedAt
  const kind = claim.repeat ? 'section_checkpoint' : 'section_bootstrap'
  const revisions = plan.sections.map((section, index) => ({ id: section.operationId, sheet_id: plan.sheetId,
    section_kind: section.sectionKind, entity_key: `section/${section.sectionKind}`,
    action: claim.repeat ? 'checkpoint_snapshot' : 'bootstrap_snapshot',
    payload: { row_count: contents[index]!.rowCount, source_hash: contents[index]!.sourceHash }, tombstone: null,
    seq: section.endpointSeq, operation_id: section.operationId, created_at: createdAt }))
  const endpoints = [...plan.sections.map((section) => ({ sheet_id: plan.sheetId, operation_id: section.operationId,
    endpoint_seq: section.endpointSeq, event_count: 1, created_at: createdAt, operation_kind: kind,
    event_contract_version: 2, component_count: null as number | null })),
  { sheet_id: plan.sheetId, operation_id: plan.snapshotOperationId, endpoint_seq: plan.snapshotSeq,
    event_count: 0, created_at: createdAt, operation_kind: 'archive_snapshot', event_contract_version: 2, component_count: 9 }]
  const members = plan.sections.map((section, index) => ({ sheet_id: plan.sheetId, parent_operation_id: plan.snapshotOperationId,
    ordinal: section.ordinal, section_kind: section.sectionKind, source_head_kind: kind,
    source_operation_id: section.operationId, source_head_seq: section.endpointSeq,
    row_count: contents[index]!.rowCount, source_hash: contents[index]!.sourceHash, created_at: createdAt }))
  const coverageCandidates = [
    ...revisions.map((row) => ({ sourceKind: 'section_revision', boundSection: row.section_kind, row, sourceSeq: row.seq })),
    ...endpoints.map((row) => ({ sourceKind: 'sealed_operation_endpoint', boundSection: 'manifest_root', row, sourceSeq: row.endpoint_seq })),
    ...members.map((row) => ({ sourceKind: 'snapshot_membership', boundSection: row.section_kind, row, sourceSeq: row.source_head_seq })),
  ]
  return { contents, sections: buildRecoveryArchiveSnapshotPlan({ sectionRows, coverageCandidates, nonces }) }
}

/** Called only by atomic owned finalization; native seals and deferred composite FKs remain armed. */
export async function consumeRecoveryArchiveOwnedHistory(query: SealQuery, token: RecoveryArchiveOwnedAttempt,
  contents: ReturnType<typeof planRecoveryArchiveOwnedHistory>['contents']): Promise<void> {
  const { captured } = recoveryArchiveOwnedAttempt(token)
  const { claim } = captured
  const plan = claim.reservationPlan
  const ids = [...plan.sections.map((section) => section.operationId), plan.snapshotOperationId]
  const partial = await query(`SELECT ((SELECT count(*) FROM public.meta_sheet_section_revisions WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[]))
    +(SELECT count(*) FROM public.meta_record_history_operations WHERE sheet_id=$1 AND operation_id=ANY($2::uuid[]))
    +(SELECT count(*) FROM public.meta_record_history_snapshot_members WHERE sheet_id=$1 AND parent_operation_id=$3::uuid))::int AS count`,
  [plan.sheetId, ids, plan.snapshotOperationId])
  if ((partial.rows[0] as { count?: unknown } | undefined)?.count !== 0) refuseOwned()
  const insert = async (sql: string, params: unknown[]) => { if ((await query(sql, params)).rowCount !== 1) refuseOwned() }
  if (!claim.repeat) await insert(`INSERT INTO public.meta_recovery_archive_section_bootstrap_markers
    (sheet_id,generation_id,snapshot_operation_id,source_vector_hash) VALUES ($1,$2::uuid,$3::uuid,$4)`,
  [plan.sheetId, plan.generationId, plan.snapshotOperationId, plan.sourceVectorHash])
  for (const [index, reservation] of plan.sections.entries()) {
    const content = contents[index]!
    await insert(`INSERT INTO public.meta_sheet_section_revisions
      (id,sheet_id,section_kind,entity_key,action,payload,tombstone,seq,operation_id,created_at)
      SELECT r.operation_id,r.sheet_id,r.section_kind,'section/'||r.section_kind,
        CASE r.reservation_kind WHEN 'section_checkpoint' THEN 'checkpoint_snapshot' ELSE 'bootstrap_snapshot' END,
        jsonb_build_object('row_count',$3::text,'source_hash',$4::text),NULL,r.endpoint_seq,r.operation_id,r.created_at
      FROM public.meta_recovery_archive_snapshot_reservations r WHERE r.generation_id=$1::uuid AND r.ordinal=$2::int`,
    [plan.generationId, reservation.ordinal, content.rowCount, content.sourceHash])
    await insert(`INSERT INTO public.meta_record_history_operations
      (sheet_id,operation_id,endpoint_seq,event_count,operation_kind,event_contract_version,component_count,created_at)
      SELECT r.sheet_id,r.operation_id,r.endpoint_seq,1,r.reservation_kind,2,NULL,r.created_at
      FROM public.meta_recovery_archive_snapshot_reservations r WHERE r.generation_id=$1::uuid AND r.ordinal=$2::int`,
    [plan.generationId, reservation.ordinal])
  }
  for (const [index, reservation] of plan.sections.entries()) {
    const content = contents[index]!
    await insert(`INSERT INTO public.meta_record_history_snapshot_members
      (sheet_id,parent_operation_id,ordinal,section_kind,source_head_kind,source_operation_id,source_head_seq,row_count,source_hash,created_at)
      SELECT s.sheet_id,p.operation_id,s.ordinal,s.section_kind,s.reservation_kind,s.operation_id,s.endpoint_seq,$3::bigint,$4,p.created_at
      FROM public.meta_recovery_archive_snapshot_reservations s JOIN public.meta_recovery_archive_snapshot_reservations p
        ON p.generation_id=s.generation_id AND p.ordinal=10 WHERE s.generation_id=$1::uuid AND s.ordinal=$2::int`,
    [plan.generationId, reservation.ordinal, content.rowCount, content.sourceHash])
  }
  await insert(`INSERT INTO public.meta_record_history_operations
    (sheet_id,operation_id,endpoint_seq,event_count,operation_kind,event_contract_version,component_count,created_at)
    SELECT p.sheet_id,p.operation_id,p.endpoint_seq,0,'archive_snapshot',2,9,p.created_at
    FROM public.meta_recovery_archive_snapshot_reservations p WHERE p.generation_id=$1::uuid AND p.ordinal=10`, [plan.generationId])
}
