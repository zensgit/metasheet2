import { randomUUID } from 'node:crypto'

import {
  bootstrapSectionEntityKey,
  sealArchiveSnapshotOperation,
  sealSectionBootstrapOperation,
  SECTION_CAUSALITY_DATA_SECTION_KINDS,
  type ArchiveSnapshotMemberInput,
  type SealQuery,
  type SectionCausalityDataSectionKind,
} from './recovery-archive-seals'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/
const RESERVATION_COUNT = SECTION_CAUSALITY_DATA_SECTION_KINDS.length + 1

export type RecoveryArchiveSectionBootstrapErrorCode =
  | 'RECOVERY_ARCHIVE_BOOTSTRAP_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_BOOTSTRAP_GENERATION_UNAVAILABLE'
  | 'RECOVERY_ARCHIVE_BOOTSTRAP_ALREADY_INITIALIZED'
  | 'RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE'
  | 'RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH'
  | 'RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE'

export class RecoveryArchiveSectionBootstrapError extends Error {
  readonly code: RecoveryArchiveSectionBootstrapErrorCode

  constructor(code: RecoveryArchiveSectionBootstrapErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSectionBootstrapError'
    this.code = code
  }
}

export interface RecoveryArchiveBootstrapOwnerInput {
  generationId: string
  sheetId: string
  sourceVectorHash: string
  ownerKind: string
  ownerId: string
  ownerFence: string
}

export interface RecoveryArchiveSectionBootstrapReservation {
  ordinal: number
  sectionKind: SectionCausalityDataSectionKind
  operationId: string
  endpointSeq: string
}

export interface RecoveryArchiveSnapshotReservationPlan extends RecoveryArchiveBootstrapOwnerInput {
  sections: readonly RecoveryArchiveSectionBootstrapReservation[]
  snapshotOperationId: string
  snapshotSeq: string
}

export interface RecoveryArchiveSectionBootstrapContent {
  sectionKind: string
  rowCount: string
  sourceHash: string
}

type GenerationRow = {
  sheet_id: unknown
  source_vector_hash: unknown
  owner_kind: unknown
  owner_id: unknown
  owner_fence: unknown
  state: unknown
  build_status: unknown
  coverage_status: unknown
}

type ReservationRow = {
  ordinal: unknown
  reservation_kind: unknown
  section_kind: unknown
  operation_id: unknown
  endpoint_seq: unknown
  sheet_id: unknown
  source_vector_hash: unknown
  owner_kind: unknown
  owner_id: unknown
  owner_fence: unknown
}

type AllocatedSeqRow = {
  ordinal: unknown
  endpoint_seq: unknown
}

type BootstrapMarkerRow = {
  sheet_id: unknown
  generation_id: unknown
  snapshot_operation_id: unknown
  source_vector_hash: unknown
}

/**
 * Allocates one immutable operation/sequence identity for each data section and a greater parent
 * identity. The caller must provide one database transaction; sequence gaps after rollback are
 * intentional and are never reused.
 */
export async function reserveRecoveryArchiveSnapshotIdentities(
  query: SealQuery,
  input: RecoveryArchiveBootstrapOwnerInput,
): Promise<RecoveryArchiveSnapshotReservationPlan> {
  assertOwnerInput(input)
  await lockAndAssertBuildingGeneration(query, input)

  const existing = await readReservationRows(query, input.generationId)
  if (existing.length > 0) return normalizeReservationPlan(existing, input)
  if (await readBootstrapMarker(query, input.sheetId)) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_ALREADY_INITIALIZED')
  }

  const allocated = await query(
    `SELECT ordinal::int AS ordinal, nextval('meta_record_chain_seq')::text AS endpoint_seq
       FROM generate_series(1, $1::int) AS ordinal
      ORDER BY ordinal`,
    [RESERVATION_COUNT],
  )
  const seqs = normalizeAllocatedSeqs(allocated.rows as AllocatedSeqRow[])
  const operationIds = Array.from({ length: RESERVATION_COUNT }, () => randomUUID())
  const ordinals = Array.from({ length: RESERVATION_COUNT }, (_, index) => index + 1)
  const reservationKinds = ordinals.map((ordinal) =>
    ordinal === RESERVATION_COUNT ? 'archive_snapshot' : 'section_bootstrap',
  )
  const sectionKinds: Array<string | null> = [...SECTION_CAUSALITY_DATA_SECTION_KINDS, null]

  const inserted = await query(
    `INSERT INTO meta_recovery_archive_snapshot_reservations (
       generation_id, sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence,
       ordinal, reservation_kind, section_kind, operation_id, endpoint_seq
     )
     SELECT $1::uuid, $2, $3, $4, $5, $6::bigint,
            row_input.ordinal, row_input.reservation_kind, row_input.section_kind,
            row_input.operation_id, row_input.endpoint_seq
       FROM unnest(
         $7::int[], $8::text[], $9::text[], $10::uuid[], $11::bigint[]
       ) AS row_input(ordinal, reservation_kind, section_kind, operation_id, endpoint_seq)`,
    [
      input.generationId,
      input.sheetId,
      input.sourceVectorHash,
      input.ownerKind,
      input.ownerId,
      input.ownerFence,
      ordinals,
      reservationKinds,
      sectionKinds,
      operationIds,
      seqs,
    ],
  )
  if (inserted.rowCount !== RESERVATION_COUNT) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE')
  }

  return normalizeReservationPlan(await readReservationRows(query, input.generationId), input)
}

/**
 * Low-level consumption primitive for nine bootstrap endpoints plus one snapshot parent LAST.
 * The D-H2 caller must already hold and recheck the canonical fence, active-key ownership, archive
 * writer-block lease, and live source vector in their required order. This function deliberately
 * does not claim that authority. The caller must provide one database transaction. A committed
 * retry is read-only; a partial visible result is refused rather than repaired in place.
 */
export async function consumeRecoveryArchiveBootstrapReservations(
  query: SealQuery,
  input: RecoveryArchiveBootstrapOwnerInput & {
    sections: readonly RecoveryArchiveSectionBootstrapContent[]
  },
): Promise<RecoveryArchiveSnapshotReservationPlan> {
  assertOwnerInput(input)
  const contents = normalizeContents(input.sections)
  await lockAndAssertBuildingGeneration(query, input)
  const plan = normalizeReservationPlan(await readReservationRows(query, input.generationId), input)

  const parent = await query(
    `SELECT endpoint_seq::text AS endpoint_seq, event_count, operation_kind,
            event_contract_version, component_count
       FROM meta_record_history_operations
      WHERE sheet_id = $1 AND operation_id = $2::uuid`,
    [plan.sheetId, plan.snapshotOperationId],
  )
  if (parent.rows.length > 0) {
    await assertBootstrapMarkerMatches(query, plan)
    await assertCommittedSnapshotMatches(query, plan, contents, parent.rows[0] as Record<string, unknown>)
    return plan
  }

  const reservedOperationIds = [...plan.sections.map((section) => section.operationId), plan.snapshotOperationId]
  const partial = await query(
    `SELECT (
       (SELECT count(*) FROM meta_record_history_operations
         WHERE sheet_id = $1 AND operation_id = ANY($2::uuid[])) +
       (SELECT count(*) FROM meta_sheet_section_revisions
         WHERE sheet_id = $1 AND operation_id = ANY($2::uuid[])) +
       (SELECT count(*) FROM meta_record_history_snapshot_members
         WHERE sheet_id = $1 AND parent_operation_id = $3::uuid)
     )::int AS count`,
    [plan.sheetId, reservedOperationIds, plan.snapshotOperationId],
  )
  if (Number((partial.rows[0] as { count?: unknown } | undefined)?.count ?? 0) !== 0) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')
  }

  const insertedMarker = await query(
    `INSERT INTO meta_recovery_archive_section_bootstrap_markers (
       sheet_id, generation_id, snapshot_operation_id, source_vector_hash
     ) VALUES ($1, $2::uuid, $3::uuid, $4)
     ON CONFLICT DO NOTHING`,
    [plan.sheetId, plan.generationId, plan.snapshotOperationId, plan.sourceVectorHash],
  )
  if (insertedMarker.rowCount !== 1) {
    const marker = await readBootstrapMarker(query, plan.sheetId)
    if (markerMatchesPlan(marker, plan)) {
      throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')
    }
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_ALREADY_INITIALIZED')
  }

  const members: ArchiveSnapshotMemberInput[] = []
  for (const [index, reservation] of plan.sections.entries()) {
    const content = contents[index]
    await query(
      `INSERT INTO meta_sheet_section_revisions (
         sheet_id, section_kind, entity_key, action, payload, seq, operation_id
       ) VALUES (
         $1, $2, $3, 'bootstrap_snapshot',
         jsonb_build_object('row_count', $4::text, 'source_hash', $5::text),
         $6::bigint, $7::uuid
       )`,
      [
        plan.sheetId,
        reservation.sectionKind,
        bootstrapSectionEntityKey(reservation.sectionKind),
        content.rowCount,
        content.sourceHash,
        reservation.endpointSeq,
        reservation.operationId,
      ],
    )
    await sealSectionBootstrapOperation(query, {
      sheetId: plan.sheetId,
      operationId: reservation.operationId,
      endpointSeq: reservation.endpointSeq,
      sectionKind: reservation.sectionKind,
      rowCount: content.rowCount,
      sourceHash: content.sourceHash,
    })
    members.push({
      ordinal: reservation.ordinal,
      sectionKind: reservation.sectionKind,
      sourceHeadKind: 'section_bootstrap',
      sourceOperationId: reservation.operationId,
      sourceHeadSeq: reservation.endpointSeq,
      rowCount: content.rowCount,
      sourceHash: content.sourceHash,
    })
  }

  await sealArchiveSnapshotOperation(query, {
    sheetId: plan.sheetId,
    operationId: plan.snapshotOperationId,
    endpointSeq: plan.snapshotSeq,
    members,
  })
  return plan
}

async function lockAndAssertBuildingGeneration(
  query: SealQuery,
  input: RecoveryArchiveBootstrapOwnerInput,
): Promise<void> {
  const result = await query(
    `SELECT sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence::text AS owner_fence,
            state, build_status, coverage_status
       FROM meta_recovery_archives
      WHERE generation_id = $1::uuid
      FOR UPDATE`,
    [input.generationId],
  )
  const row = result.rows[0] as GenerationRow | undefined
  if (
    result.rows.length !== 1 ||
    row?.sheet_id !== input.sheetId ||
    row.source_vector_hash !== input.sourceVectorHash ||
    row.owner_kind !== input.ownerKind ||
    row.owner_id !== input.ownerId ||
    row.owner_fence !== input.ownerFence ||
    row.state !== 'building' ||
    row.build_status !== 'active' ||
    row.coverage_status !== 'incomplete'
  ) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_GENERATION_UNAVAILABLE')
  }
}

async function readReservationRows(query: SealQuery, generationId: string): Promise<ReservationRow[]> {
  const result = await query(
    `SELECT ordinal, reservation_kind, section_kind, operation_id::text AS operation_id,
            endpoint_seq::text AS endpoint_seq, sheet_id, source_vector_hash,
            owner_kind, owner_id, owner_fence::text AS owner_fence
       FROM meta_recovery_archive_snapshot_reservations
      WHERE generation_id = $1::uuid
      ORDER BY ordinal`,
    [generationId],
  )
  return result.rows as ReservationRow[]
}

async function readBootstrapMarker(query: SealQuery, sheetId: string): Promise<BootstrapMarkerRow | undefined> {
  const result = await query(
    `SELECT sheet_id, generation_id::text AS generation_id,
            snapshot_operation_id::text AS snapshot_operation_id, source_vector_hash
       FROM meta_recovery_archive_section_bootstrap_markers
      WHERE sheet_id = $1`,
    [sheetId],
  )
  return result.rows[0] as BootstrapMarkerRow | undefined
}

function markerMatchesPlan(
  marker: BootstrapMarkerRow | undefined,
  plan: RecoveryArchiveSnapshotReservationPlan,
): boolean {
  return (
    marker?.sheet_id === plan.sheetId &&
    marker.generation_id === plan.generationId &&
    marker.snapshot_operation_id === plan.snapshotOperationId &&
    marker.source_vector_hash === plan.sourceVectorHash
  )
}

async function assertBootstrapMarkerMatches(
  query: SealQuery,
  plan: RecoveryArchiveSnapshotReservationPlan,
): Promise<void> {
  if (!markerMatchesPlan(await readBootstrapMarker(query, plan.sheetId), plan)) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')
  }
}

function normalizeReservationPlan(
  rows: readonly ReservationRow[],
  input: RecoveryArchiveBootstrapOwnerInput,
): RecoveryArchiveSnapshotReservationPlan {
  if (rows.length !== RESERVATION_COUNT) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE')
  }
  const sections: RecoveryArchiveSectionBootstrapReservation[] = []
  const seenOperations = new Set<string>()
  const seenSeqs = new Set<string>()

  for (const [index, row] of rows.entries()) {
    const ordinal = index + 1
    const operationId = String(row.operation_id ?? '')
    const endpointSeq = String(row.endpoint_seq ?? '')
    if (
      row.ordinal !== ordinal ||
      row.sheet_id !== input.sheetId ||
      row.source_vector_hash !== input.sourceVectorHash ||
      row.owner_kind !== input.ownerKind ||
      row.owner_id !== input.ownerId ||
      row.owner_fence !== input.ownerFence ||
      !UUID_PATTERN.test(operationId) ||
      !POSITIVE_DECIMAL_PATTERN.test(endpointSeq) ||
      seenOperations.has(operationId) ||
      seenSeqs.has(endpointSeq)
    ) {
      throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    }
    seenOperations.add(operationId)
    seenSeqs.add(endpointSeq)

    if (ordinal <= SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
      const sectionKind = SECTION_CAUSALITY_DATA_SECTION_KINDS[index]
      if (row.reservation_kind !== 'section_bootstrap' || row.section_kind !== sectionKind) {
        throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
      }
      sections.push({ ordinal, sectionKind, operationId, endpointSeq })
      continue
    }

    if (row.reservation_kind !== 'archive_snapshot' || row.section_kind !== null) {
      throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    }
    if (sections.some((section) => BigInt(section.endpointSeq) >= BigInt(endpointSeq))) {
      throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    }
    return {
      ...input,
      sections,
      snapshotOperationId: operationId,
      snapshotSeq: endpointSeq,
    }
  }

  throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE')
}

function normalizeAllocatedSeqs(rows: readonly AllocatedSeqRow[]): string[] {
  if (rows.length !== RESERVATION_COUNT) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE')
  }
  return rows.map((row, index) => {
    const endpointSeq = String(row.endpoint_seq ?? '')
    if (row.ordinal !== index + 1 || !POSITIVE_DECIMAL_PATTERN.test(endpointSeq)) {
      throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    }
    return endpointSeq
  })
}

function normalizeContents(
  contents: readonly RecoveryArchiveSectionBootstrapContent[],
): Array<{ sectionKind: SectionCausalityDataSectionKind; rowCount: string; sourceHash: string }> {
  if (contents.length !== SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_INVALID_INPUT')
  }
  return contents.map((content, index) => {
    const sectionKind = SECTION_CAUSALITY_DATA_SECTION_KINDS[index]
    if (
      content.sectionKind !== sectionKind ||
      !/^(0|[1-9][0-9]*)$/.test(content.rowCount) ||
      !SHA256_PATTERN.test(content.sourceHash)
    ) {
      throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_INVALID_INPUT')
    }
    return { sectionKind, rowCount: content.rowCount, sourceHash: content.sourceHash }
  })
}

async function assertCommittedSnapshotMatches(
  query: SealQuery,
  plan: RecoveryArchiveSnapshotReservationPlan,
  contents: readonly { sectionKind: SectionCausalityDataSectionKind; rowCount: string; sourceHash: string }[],
  parent: Record<string, unknown>,
): Promise<void> {
  if (
    parent.endpoint_seq !== plan.snapshotSeq ||
    parent.event_count !== 0 ||
    parent.operation_kind !== 'archive_snapshot' ||
    parent.event_contract_version !== 2 ||
    parent.component_count !== SECTION_CAUSALITY_DATA_SECTION_KINDS.length
  ) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')
  }

  const rows = await query(
    `SELECT reservation.ordinal, reservation.section_kind,
            source.operation_id::text AS source_operation_id,
            source.endpoint_seq::text AS source_endpoint_seq,
            source.operation_kind AS source_operation_kind,
            source.event_count AS source_event_count,
            revision.action, revision.payload->>'row_count' AS row_count,
            revision.payload->>'source_hash' AS source_hash,
            member.source_head_kind, member.source_operation_id::text AS member_operation_id,
            member.source_head_seq::text AS member_head_seq,
            member.row_count::text AS member_row_count, member.source_hash AS member_source_hash
       FROM meta_recovery_archive_snapshot_reservations reservation
       JOIN meta_record_history_operations source
         ON source.sheet_id = reservation.sheet_id AND source.operation_id = reservation.operation_id
       JOIN meta_sheet_section_revisions revision
         ON revision.sheet_id = reservation.sheet_id AND revision.operation_id = reservation.operation_id
       JOIN meta_record_history_snapshot_members member
         ON member.sheet_id = reservation.sheet_id
        AND member.parent_operation_id = $2::uuid
        AND member.ordinal = reservation.ordinal
      WHERE reservation.generation_id = $1::uuid
        AND reservation.reservation_kind = 'section_bootstrap'
      ORDER BY reservation.ordinal`,
    [plan.generationId, plan.snapshotOperationId],
  )
  if (rows.rows.length !== SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')
  }

  for (const [index, raw] of (rows.rows as Array<Record<string, unknown>>).entries()) {
    const reservation = plan.sections[index]
    const content = contents[index]
    if (
      raw.ordinal !== reservation.ordinal ||
      raw.section_kind !== reservation.sectionKind ||
      raw.source_operation_id !== reservation.operationId ||
      raw.source_endpoint_seq !== reservation.endpointSeq ||
      raw.source_operation_kind !== 'section_bootstrap' ||
      raw.source_event_count !== 1 ||
      raw.action !== 'bootstrap_snapshot' ||
      raw.row_count !== content.rowCount ||
      raw.source_hash !== content.sourceHash ||
      raw.source_head_kind !== 'section_bootstrap' ||
      raw.member_operation_id !== reservation.operationId ||
      raw.member_head_seq !== reservation.endpointSeq ||
      raw.member_row_count !== content.rowCount ||
      raw.member_source_hash !== content.sourceHash
    ) {
      throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')
    }
  }
}

function assertOwnerInput(input: RecoveryArchiveBootstrapOwnerInput): void {
  if (
    !UUID_PATTERN.test(input.generationId) ||
    input.sheetId.trim().length === 0 ||
    input.sheetId.trim() !== input.sheetId ||
    !SHA256_PATTERN.test(input.sourceVectorHash) ||
    input.ownerKind.trim().length === 0 ||
    input.ownerKind.trim() !== input.ownerKind ||
    input.ownerId.trim().length === 0 ||
    input.ownerId.trim() !== input.ownerId ||
    !POSITIVE_DECIMAL_PATTERN.test(input.ownerFence)
  ) {
    throw new RecoveryArchiveSectionBootstrapError('RECOVERY_ARCHIVE_BOOTSTRAP_INVALID_INPUT')
  }
}
