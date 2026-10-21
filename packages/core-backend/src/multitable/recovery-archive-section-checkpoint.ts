/**
 * Repeat archive checkpoints are deliberately separate from the one-time bootstrap path.
 *
 * Callers must run allocation/persistence/finalization through one database transaction.
 * This module has no runtime caller and does not authorize capture.  It relies on the
 * checkpoint migration's immutable reservation and bootstrap-marker guards.
 */

import { randomUUID } from 'node:crypto'

import {
  SECTION_CAUSALITY_DATA_SECTION_KINDS,
  type SealQuery,
  type SectionCausalityDataSectionKind,
} from './recovery-archive-seals'
import {
  computeRecoveryArchiveCheckpointVectorHash,
  RecoveryArchiveSourceVectorError,
} from './recovery-archive-source-vector'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/
const NONNEGATIVE_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/
const RESERVATION_COUNT = SECTION_CAUSALITY_DATA_SECTION_KINDS.length + 1
const issuedAllocationProofs = new WeakSet<object>()

export type RecoveryArchiveSectionCheckpointErrorCode =
  | 'RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_CHECKPOINT_GENERATION_UNAVAILABLE'
  | 'RECOVERY_ARCHIVE_CHECKPOINT_BOOTSTRAP_UNAVAILABLE'
  | 'RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_INCOMPLETE'
  | 'RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH'
  | 'RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE'

export class RecoveryArchiveSectionCheckpointError extends Error {
  readonly code: RecoveryArchiveSectionCheckpointErrorCode

  constructor(code: RecoveryArchiveSectionCheckpointErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveSectionCheckpointError'
    this.code = code
  }
}

export interface RecoveryArchiveCheckpointOwnerInput {
  generationId: string
  sheetId: string
  sourceVectorHash: string
  ownerKind: string
  ownerId: string
  ownerFence: string
}

export interface RecoveryArchiveSectionCheckpointReservation {
  ordinal: number
  sectionKind: SectionCausalityDataSectionKind
  operationId: string
  endpointSeq: string
}

export interface RecoveryArchiveCheckpointSnapshotReservationPlan extends RecoveryArchiveCheckpointOwnerInput {
  sections: readonly RecoveryArchiveSectionCheckpointReservation[]
  snapshotOperationId: string
  snapshotSeq: string
}

export interface RecoveryArchiveAllocatedCheckpointIdentities {
  readonly sections: readonly RecoveryArchiveSectionCheckpointReservation[]
  readonly snapshotOperationId: string
  readonly snapshotSeq: string
}

export interface RecoveryArchiveSectionCheckpointContent {
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

type BootstrapMarkerRow = {
  sheet_id: unknown
  generation_id: unknown
  snapshot_operation_id: unknown
  source_vector_hash: unknown
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

type AllocatedSeqRow = { ordinal: unknown; endpoint_seq: unknown }

type CheckpointEndpointRow = {
  operation_id: unknown
  operation_kind: unknown
  endpoint_seq: unknown
  event_count: unknown
  event_contract_version: unknown
  section_kind: unknown
  action: unknown
  payload: unknown
}

const PERSIST_INPUT_KEYS = [
  'generationId',
  'sheetId',
  'sourceVectorHash',
  'ownerKind',
  'ownerId',
  'ownerFence',
  'sections',
  'snapshotOperationId',
  'snapshotSeq',
] as const

const SECTION_RESERVATION_KEYS = ['ordinal', 'sectionKind', 'operationId', 'endpointSeq'] as const

/**
 * Allocates checkpoint-only identities. Sequence gaps after rollback are intentional. The returned
 * object is an in-process proof for the first reservation insert, not a caller-supplied capability.
 */
export async function allocateRecoveryArchiveCheckpointIdentities(
  query: SealQuery,
): Promise<RecoveryArchiveAllocatedCheckpointIdentities> {
  const allocated = await query(
    `SELECT ordinal::int AS ordinal, nextval('meta_record_chain_seq')::text AS endpoint_seq
       FROM generate_series(1, $1::int) AS ordinal
      ORDER BY ordinal`,
    [RESERVATION_COUNT],
  )
  const seqs = normalizeAllocatedSeqs(allocated.rows as AllocatedSeqRow[])
  const operationIds = Array.from({ length: RESERVATION_COUNT }, () => randomUUID())
  if (new Set(operationIds).size !== RESERVATION_COUNT) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
  }
  const snapshotOperationId = operationIds[RESERVATION_COUNT - 1]
  const snapshotSeq = seqs[RESERVATION_COUNT - 1]
  if (snapshotOperationId === undefined || snapshotSeq === undefined) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_INCOMPLETE')
  }
  const sections = SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind, index) => {
    const operationId = operationIds[index]
    const endpointSeq = seqs[index]
    if (operationId === undefined || endpointSeq === undefined) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_INCOMPLETE')
    }
    return { ordinal: index + 1, sectionKind, operationId, endpointSeq }
  })
  const frozen = Object.freeze({
    sections: Object.freeze(sections.map((section) => Object.freeze(section))),
    snapshotOperationId,
    snapshotSeq,
  })
  issuedAllocationProofs.add(frozen)
  return frozen
}

/**
 * Persists only an issued allocation onto one building generation. An immutable completed bootstrap
 * marker is mandatory. Exact stored reservations are returned only when the retry supplies the same plan.
 */
export async function persistRecoveryArchiveCheckpointReservations(
  query: SealQuery,
  input: unknown,
  allocated?: RecoveryArchiveAllocatedCheckpointIdentities,
): Promise<RecoveryArchiveCheckpointSnapshotReservationPlan> {
  const plan = snapshotPersistInput(input)
  assertCanonicalCheckpointVectorHash(plan)
  await lockAndAssertBuildingGeneration(query, plan)
  await assertImmutableBootstrapMarker(query, plan.sheetId)

  const existing = await readReservationRows(query, plan.generationId)
  if (existing.length > 0) {
    const stored = normalizeReservationPlan(existing, plan)
    if (!identitiesMatch(stored, plan)) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
    }
    return stored
  }

  if (
    allocated === undefined ||
    !issuedAllocationProofs.has(allocated) ||
    !identitiesMatch(plan, allocated) ||
    !issuedAllocationProofs.delete(allocated)
  ) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
  }
  await insertReservationRows(query, plan)
  return normalizeReservationPlan(await readReservationRows(query, plan.generationId), plan)
}

/**
 * Seals nine checkpoint section endpoints and their archive-snapshot parent. The caller must
 * provide one transaction containing its authority and live-source checks. A visible partial result
 * is refused, never repaired. This function adds no bootstrap marker and has no runtime caller.
 */
export async function consumeRecoveryArchiveCheckpointReservations(
  query: SealQuery,
  input: RecoveryArchiveCheckpointOwnerInput & {
    sections: readonly RecoveryArchiveSectionCheckpointContent[]
  },
): Promise<RecoveryArchiveCheckpointSnapshotReservationPlan> {
  assertOwnerInput(input)
  const contents = normalizeContents(input.sections)
  await lockAndAssertBuildingGeneration(query, input)
  await assertImmutableBootstrapMarker(query, input.sheetId)
  const plan = normalizeReservationPlan(await readReservationRows(query, input.generationId), input)
  assertCanonicalCheckpointVectorHash(plan)

  const parent = await query(
    `SELECT endpoint_seq::text AS endpoint_seq, event_count, operation_kind,
            event_contract_version, component_count
       FROM meta_record_history_operations
      WHERE sheet_id = $1 AND operation_id = $2::uuid`,
    [plan.sheetId, plan.snapshotOperationId],
  )
  if (parent.rows.length > 0) {
    await assertCommittedCheckpointMatches(query, plan, contents, parent.rows[0] as Record<string, unknown>)
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
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE')
  }

  const members: CheckpointSnapshotMember[] = []
  for (const [index, reservation] of plan.sections.entries()) {
    const content = contents[index]
    if (content === undefined) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
    }
    await query(
      `INSERT INTO meta_sheet_section_revisions (
         sheet_id, section_kind, entity_key, action, payload, seq, operation_id
       ) VALUES (
         $1, $2, $3, 'checkpoint_snapshot',
         jsonb_build_object('row_count', $4::text, 'source_hash', $5::text),
         $6::bigint, $7::uuid
       )`,
      [
        plan.sheetId,
        reservation.sectionKind,
        `section/${reservation.sectionKind}`,
        content.rowCount,
        content.sourceHash,
        reservation.endpointSeq,
        reservation.operationId,
      ],
    )
    await sealCheckpointSectionOperation(query, {
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
      sourceOperationId: reservation.operationId,
      sourceHeadSeq: reservation.endpointSeq,
      rowCount: content.rowCount,
      sourceHash: content.sourceHash,
    })
  }
  await sealCheckpointSnapshotOperation(query, {
    sheetId: plan.sheetId,
    operationId: plan.snapshotOperationId,
    endpointSeq: plan.snapshotSeq,
    members,
  })
  return plan
}

interface CheckpointSectionSealInput {
  sheetId: string
  operationId: string
  endpointSeq: string
  sectionKind: SectionCausalityDataSectionKind
  rowCount: string
  sourceHash: string
}

interface CheckpointSnapshotMember {
  ordinal: number
  sectionKind: SectionCausalityDataSectionKind
  sourceOperationId: string
  sourceHeadSeq: string
  rowCount: string
  sourceHash: string
}

interface CheckpointSnapshotSealInput {
  sheetId: string
  operationId: string
  endpointSeq: string
  members: readonly CheckpointSnapshotMember[]
}

async function sealCheckpointSectionOperation(query: SealQuery, input: CheckpointSectionSealInput): Promise<void> {
  const captured = await query(
    `SELECT section_kind, action, seq::text AS seq, payload
       FROM meta_sheet_section_revisions
      WHERE sheet_id = $1 AND operation_id = $2::uuid`,
    [input.sheetId, input.operationId],
  )
  const row = captured.rows[0] as Record<string, unknown> | undefined
  if (
    captured.rows.length !== 1 ||
    row?.section_kind !== input.sectionKind ||
    row.action !== 'checkpoint_snapshot' ||
    row.seq !== input.endpointSeq ||
    !isExactCheckpointPayload(row.payload, input.rowCount, input.sourceHash)
  ) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE')
  }
  await query(
    `INSERT INTO meta_record_history_operations (
       sheet_id, operation_id, endpoint_seq, event_count,
       operation_kind, event_contract_version, component_count
     ) VALUES ($1, $2::uuid, $3::bigint, 1, 'section_checkpoint', 2::int, NULL)`,
    [input.sheetId, input.operationId, input.endpointSeq],
  )
}

async function sealCheckpointSnapshotOperation(query: SealQuery, input: CheckpointSnapshotSealInput): Promise<void> {
  assertCheckpointMembers(input.members, input.endpointSeq)
  await assertCheckpointSourcesMatch(query, input.sheetId, input.members)
  for (const member of input.members) {
    await query(
      `INSERT INTO meta_record_history_snapshot_members (
         sheet_id, parent_operation_id, ordinal, section_kind, source_head_kind,
         source_operation_id, source_head_seq, row_count, source_hash
       ) VALUES (
         $1, $2::uuid, $3::int, $4, 'section_checkpoint',
         $5::uuid, $6::bigint, $7::bigint, $8
       )`,
      [
        input.sheetId,
        input.operationId,
        member.ordinal,
        member.sectionKind,
        member.sourceOperationId,
        member.sourceHeadSeq,
        member.rowCount,
        member.sourceHash,
      ],
    )
  }
  await query(
    `INSERT INTO meta_record_history_operations (
       sheet_id, operation_id, endpoint_seq, event_count,
       operation_kind, event_contract_version, component_count
     ) VALUES ($1, $2::uuid, $3::bigint, 0, 'archive_snapshot', 2::int, $4::int)`,
    [input.sheetId, input.operationId, input.endpointSeq, input.members.length],
  )
}

async function lockAndAssertBuildingGeneration(query: SealQuery, input: RecoveryArchiveCheckpointOwnerInput): Promise<void> {
  const result = await query(
    `SELECT sheet_id, source_vector_hash, owner_kind, owner_id, owner_fence::text AS owner_fence,
            state, build_status, coverage_status
       FROM meta_recovery_archives
      WHERE generation_id = $1::uuid
        AND lease_expires_at > clock_timestamp()
        AND expires_at > clock_timestamp()
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
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_GENERATION_UNAVAILABLE')
  }
}

async function assertImmutableBootstrapMarker(query: SealQuery, sheetId: string): Promise<void> {
  const result = await query(
    `SELECT sheet_id, generation_id::text AS generation_id,
            snapshot_operation_id::text AS snapshot_operation_id, source_vector_hash
       FROM meta_recovery_archive_section_bootstrap_markers
      WHERE sheet_id = $1`,
    [sheetId],
  )
  const marker = result.rows[0] as BootstrapMarkerRow | undefined
  if (
    result.rows.length !== 1 ||
    marker?.sheet_id !== sheetId ||
    typeof marker.generation_id !== 'string' ||
    !UUID_PATTERN.test(marker.generation_id) ||
    typeof marker.snapshot_operation_id !== 'string' ||
    !UUID_PATTERN.test(marker.snapshot_operation_id) ||
    typeof marker.source_vector_hash !== 'string' ||
    !SHA256_PATTERN.test(marker.source_vector_hash)
  ) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_BOOTSTRAP_UNAVAILABLE')
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

async function insertReservationRows(query: SealQuery, plan: RecoveryArchiveCheckpointSnapshotReservationPlan): Promise<void> {
  const ordinals = Array.from({ length: RESERVATION_COUNT }, (_, index) => index + 1)
  const reservationKinds = ordinals.map((ordinal) =>
    ordinal === RESERVATION_COUNT ? 'archive_snapshot' : 'section_checkpoint',
  )
  const sectionKinds: Array<string | null> = [...SECTION_CAUSALITY_DATA_SECTION_KINDS, null]
  const operationIds = [...plan.sections.map((section) => section.operationId), plan.snapshotOperationId]
  const seqs = [...plan.sections.map((section) => section.endpointSeq), plan.snapshotSeq]
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
      plan.generationId,
      plan.sheetId,
      plan.sourceVectorHash,
      plan.ownerKind,
      plan.ownerId,
      plan.ownerFence,
      ordinals,
      reservationKinds,
      sectionKinds,
      operationIds,
      seqs,
    ],
  )
  if (inserted.rowCount !== RESERVATION_COUNT) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_INCOMPLETE')
  }
}

function normalizeReservationPlan(
  rows: readonly ReservationRow[],
  input: RecoveryArchiveCheckpointOwnerInput,
): RecoveryArchiveCheckpointSnapshotReservationPlan {
  if (rows.length !== RESERVATION_COUNT) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_INCOMPLETE')
  }
  const sections: RecoveryArchiveSectionCheckpointReservation[] = []
  const seenOperations = new Set<string>()
  const seenSeqs = new Set<string>()
  for (const [index, row] of rows.entries()) {
    const ordinal = index + 1
    const operationId = row.operation_id
    const endpointSeq = row.endpoint_seq
    if (
      row.ordinal !== ordinal ||
      row.sheet_id !== input.sheetId ||
      row.source_vector_hash !== input.sourceVectorHash ||
      row.owner_kind !== input.ownerKind ||
      row.owner_id !== input.ownerId ||
      row.owner_fence !== input.ownerFence ||
      typeof operationId !== 'string' ||
      !UUID_PATTERN.test(operationId) ||
      typeof endpointSeq !== 'string' ||
      !POSITIVE_DECIMAL_PATTERN.test(endpointSeq) ||
      seenOperations.has(operationId) ||
      seenSeqs.has(endpointSeq)
    ) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
    }
    seenOperations.add(operationId)
    seenSeqs.add(endpointSeq)
    if (ordinal <= SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
      const sectionKind = SECTION_CAUSALITY_DATA_SECTION_KINDS[index]
      if (sectionKind === undefined || row.reservation_kind !== 'section_checkpoint' || row.section_kind !== sectionKind) {
        throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
      }
      sections.push({ ordinal, sectionKind, operationId, endpointSeq })
      continue
    }
    if (
      row.reservation_kind !== 'archive_snapshot' ||
      row.section_kind !== null ||
      sections.some((section) => BigInt(section.endpointSeq) >= BigInt(endpointSeq))
    ) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
    }
    return { ...input, sections, snapshotOperationId: operationId, snapshotSeq: endpointSeq }
  }
  throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_INCOMPLETE')
}

function normalizeAllocatedSeqs(rows: readonly AllocatedSeqRow[]): string[] {
  if (rows.length !== RESERVATION_COUNT) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_INCOMPLETE')
  }
  const seqs = rows.map((row, index) => {
    if (row.ordinal !== index + 1 || typeof row.endpoint_seq !== 'string' || !POSITIVE_DECIMAL_PATTERN.test(row.endpoint_seq)) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
    }
    return row.endpoint_seq
  })
  if (
    new Set(seqs).size !== RESERVATION_COUNT ||
    seqs.slice(0, SECTION_CAUSALITY_DATA_SECTION_KINDS.length).some((seq) => BigInt(seq) >= BigInt(seqs[RESERVATION_COUNT - 1] ?? '0'))
  ) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
  }
  return seqs
}

function snapshotPersistInput(value: unknown): RecoveryArchiveCheckpointSnapshotReservationPlan {
  const snapshot = snapshotExactRecord(value, PERSIST_INPUT_KEYS)
  const owner: RecoveryArchiveCheckpointOwnerInput = {
    generationId: asUuid(snapshot.generationId),
    sheetId: asNonEmptyString(snapshot.sheetId),
    sourceVectorHash: asSha256(snapshot.sourceVectorHash),
    ownerKind: asNonEmptyString(snapshot.ownerKind),
    ownerId: asNonEmptyString(snapshot.ownerId),
    ownerFence: asPositiveDecimal(snapshot.ownerFence),
  }
  const values = snapshotDenseArray(snapshot.sections)
  if (values.length !== SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
  const seenOperations = new Set<string>()
  const seenSeqs = new Set<string>()
  const sections = values.map((value, index) => {
    const section = snapshotExactRecord(value, SECTION_RESERVATION_KEYS)
    const sectionKind = SECTION_CAUSALITY_DATA_SECTION_KINDS[index]
    const operationId = asUuid(section.operationId)
    const endpointSeq = asPositiveDecimal(section.endpointSeq)
    if (
      section.ordinal !== index + 1 ||
      section.sectionKind !== sectionKind ||
      seenOperations.has(operationId) ||
      seenSeqs.has(endpointSeq)
    ) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
    }
    seenOperations.add(operationId)
    seenSeqs.add(endpointSeq)
    return { ordinal: index + 1, sectionKind: sectionKind as SectionCausalityDataSectionKind, operationId, endpointSeq }
  })
  const snapshotOperationId = asUuid(snapshot.snapshotOperationId)
  const snapshotSeq = asPositiveDecimal(snapshot.snapshotSeq)
  if (
    seenOperations.has(snapshotOperationId) ||
    seenSeqs.has(snapshotSeq) ||
    sections.some((section) => BigInt(section.endpointSeq) >= BigInt(snapshotSeq))
  ) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
  return { ...owner, sections, snapshotOperationId, snapshotSeq }
}

function assertCanonicalCheckpointVectorHash(plan: RecoveryArchiveCheckpointSnapshotReservationPlan): void {
  try {
    const hash = computeRecoveryArchiveCheckpointVectorHash(
      plan.sections.map((section) => ({
        sourceHeadKind: 'section_checkpoint',
        sectionKind: section.sectionKind,
        operationId: section.operationId,
        headSeq: section.endpointSeq,
      })),
    ).hash
    if (hash !== plan.sourceVectorHash) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
    }
  } catch (error) {
    if (error instanceof RecoveryArchiveSourceVectorError) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
    }
    throw error
  }
}

function identitiesMatch(
  plan: RecoveryArchiveCheckpointSnapshotReservationPlan,
  identities: RecoveryArchiveAllocatedCheckpointIdentities | RecoveryArchiveCheckpointSnapshotReservationPlan,
): boolean {
  return (
    plan.snapshotOperationId === identities.snapshotOperationId &&
    plan.snapshotSeq === identities.snapshotSeq &&
    plan.sections.length === identities.sections.length &&
    plan.sections.every((section, index) => {
      const expected = identities.sections[index]
      return (
        expected !== undefined &&
        section.ordinal === expected.ordinal &&
        section.sectionKind === expected.sectionKind &&
        section.operationId === expected.operationId &&
        section.endpointSeq === expected.endpointSeq
      )
    })
  )
}

function normalizeContents(
  contents: readonly RecoveryArchiveSectionCheckpointContent[],
): Array<{ sectionKind: SectionCausalityDataSectionKind; rowCount: string; sourceHash: string }> {
  if (contents.length !== SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
  return contents.map((content, index) => {
    const sectionKind = SECTION_CAUSALITY_DATA_SECTION_KINDS[index]
    if (
      sectionKind === undefined ||
      content.sectionKind !== sectionKind ||
      !NONNEGATIVE_DECIMAL_PATTERN.test(content.rowCount) ||
      !SHA256_PATTERN.test(content.sourceHash)
    ) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
    }
    return { sectionKind, rowCount: content.rowCount, sourceHash: content.sourceHash }
  })
}

function assertCheckpointMembers(members: readonly CheckpointSnapshotMember[], parentSeq: string): void {
  if (members.length !== SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
  for (const [index, member] of members.entries()) {
    if (
      member.ordinal !== index + 1 ||
      member.sectionKind !== SECTION_CAUSALITY_DATA_SECTION_KINDS[index] ||
      !UUID_PATTERN.test(member.sourceOperationId) ||
      !POSITIVE_DECIMAL_PATTERN.test(member.sourceHeadSeq) ||
      BigInt(member.sourceHeadSeq) >= BigInt(parentSeq) ||
      !NONNEGATIVE_DECIMAL_PATTERN.test(member.rowCount) ||
      !SHA256_PATTERN.test(member.sourceHash)
    ) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
    }
  }
}

async function assertCheckpointSourcesMatch(
  query: SealQuery,
  sheetId: string,
  members: readonly CheckpointSnapshotMember[],
): Promise<void> {
  const result = await query(
    `SELECT operation_row.operation_id::text AS operation_id, operation_row.operation_kind,
            operation_row.endpoint_seq::text AS endpoint_seq, operation_row.event_count,
            operation_row.event_contract_version, revision_row.section_kind, revision_row.action,
            revision_row.payload
       FROM meta_record_history_operations operation_row
       LEFT JOIN meta_sheet_section_revisions revision_row
         ON revision_row.sheet_id = operation_row.sheet_id
        AND revision_row.operation_id = operation_row.operation_id
      WHERE operation_row.sheet_id = $1 AND operation_row.operation_id = ANY($2::uuid[])`,
    [sheetId, members.map((member) => member.sourceOperationId)],
  )
  const byId = new Map((result.rows as CheckpointEndpointRow[]).map((row) => [String(row.operation_id), row]))
  if (byId.size !== members.length || result.rows.length !== members.length) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE')
  }
  for (const member of members) {
    const row = byId.get(member.sourceOperationId)
    if (
      row?.operation_kind !== 'section_checkpoint' ||
      row.endpoint_seq !== member.sourceHeadSeq ||
      row.event_count !== 1 ||
      row.event_contract_version !== 2 ||
      row.section_kind !== member.sectionKind ||
      row.action !== 'checkpoint_snapshot' ||
      !isExactCheckpointPayload(row.payload, member.rowCount, member.sourceHash)
    ) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE')
    }
  }
}

async function assertCommittedCheckpointMatches(
  query: SealQuery,
  plan: RecoveryArchiveCheckpointSnapshotReservationPlan,
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
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE')
  }
  const result = await query(
    `SELECT reservation.ordinal, reservation.section_kind,
            source.operation_id::text AS source_operation_id, source.endpoint_seq::text AS source_endpoint_seq,
            source.operation_kind AS source_operation_kind, source.event_count AS source_event_count,
            source.event_contract_version AS source_event_contract_version,
            revision.action, revision.payload,
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
        AND reservation.reservation_kind = 'section_checkpoint'
      ORDER BY reservation.ordinal`,
    [plan.generationId, plan.snapshotOperationId],
  )
  if (result.rows.length !== SECTION_CAUSALITY_DATA_SECTION_KINDS.length) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE')
  }
  for (const [index, raw] of (result.rows as Array<Record<string, unknown>>).entries()) {
    const reservation = plan.sections[index]
    const content = contents[index]
    if (
      reservation === undefined ||
      content === undefined ||
      raw.ordinal !== reservation.ordinal ||
      raw.section_kind !== reservation.sectionKind ||
      raw.source_operation_id !== reservation.operationId ||
      raw.source_endpoint_seq !== reservation.endpointSeq ||
      raw.source_operation_kind !== 'section_checkpoint' ||
      raw.source_event_count !== 1 ||
      raw.source_event_contract_version !== 2 ||
      raw.action !== 'checkpoint_snapshot' ||
      !isExactCheckpointPayload(raw.payload, content.rowCount, content.sourceHash) ||
      raw.source_head_kind !== 'section_checkpoint' ||
      raw.member_operation_id !== reservation.operationId ||
      raw.member_head_seq !== reservation.endpointSeq ||
      raw.member_row_count !== content.rowCount ||
      raw.member_source_hash !== content.sourceHash
    ) {
      throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE')
    }
  }
}

function isExactCheckpointPayload(value: unknown, rowCount: string, sourceHash: string): boolean {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const keys = Object.keys(value)
    return (
      keys.length === 2 &&
      keys.includes('row_count') &&
      keys.includes('source_hash') &&
      Object.getOwnPropertyDescriptor(value, 'row_count')?.value === rowCount &&
      Object.getOwnPropertyDescriptor(value, 'source_hash')?.value === sourceHash
    )
  } catch {
    return false
  }
}

function snapshotDenseArray(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value) || Object.keys(value).length !== value.length) throw new Error('invalid')
    return value.map((entry) => entry)
  } catch {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
}

function snapshotExactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid')
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || typeof key === 'symbol' || !('value' in descriptor)) {
        throw new Error('invalid')
      }
      result[key] = descriptor.value
    }
    const keys = Object.keys(result)
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) throw new Error('invalid')
    return result
  } catch {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
}

function asNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim() !== value) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
  return value
}

function asUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
  return value
}

function asSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
  return value
}

function asPositiveDecimal(value: unknown): string {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    throw new RecoveryArchiveSectionCheckpointError('RECOVERY_ARCHIVE_CHECKPOINT_INVALID_INPUT')
  }
  return value
}

function assertOwnerInput(input: RecoveryArchiveCheckpointOwnerInput): void {
  asUuid(input.generationId)
  asNonEmptyString(input.sheetId)
  asSha256(input.sourceVectorHash)
  asNonEmptyString(input.ownerKind)
  asNonEmptyString(input.ownerId)
  asPositiveDecimal(input.ownerFence)
}
