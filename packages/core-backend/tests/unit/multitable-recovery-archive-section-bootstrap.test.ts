import { describe, expect, test, vi } from 'vitest'

import {
  finalizeRecoveryArchiveBootstrapSnapshot,
  RecoveryArchiveSectionBootstrapError,
  reserveRecoveryArchiveSnapshotIdentities,
  type RecoveryArchiveBootstrapOwnerInput,
} from '../../src/multitable/recovery-archive-section-bootstrap'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from '../../src/multitable/recovery-archive-seals'

const GENERATION_ID = '11111111-1111-4111-8111-111111111111'
const SHEET_ID = 'tm_di0_sheet'
const SOURCE_VECTOR_HASH = 'a'.repeat(64)

const INPUT: RecoveryArchiveBootstrapOwnerInput = {
  generationId: GENERATION_ID,
  sheetId: SHEET_ID,
  sourceVectorHash: SOURCE_VECTOR_HASH,
  ownerKind: 'archive_builder',
  ownerId: 'tm_di0_owner',
  ownerFence: '7',
}

function generationRow(overrides: Record<string, unknown> = {}) {
  return {
    sheet_id: SHEET_ID,
    source_vector_hash: SOURCE_VECTOR_HASH,
    owner_kind: INPUT.ownerKind,
    owner_id: INPUT.ownerId,
    owner_fence: INPUT.ownerFence,
    state: 'building',
    build_status: 'active',
    coverage_status: 'incomplete',
    ...overrides,
  }
}

function reservationRows(startSeq = 101n) {
  return Array.from({ length: 10 }, (_, index) => ({
    ordinal: index + 1,
    reservation_kind: index === 9 ? 'archive_snapshot' : 'section_bootstrap',
    section_kind: index === 9 ? null : SECTION_CAUSALITY_DATA_SECTION_KINDS[index],
    operation_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    endpoint_seq: String(startSeq + BigInt(index)),
    sheet_id: SHEET_ID,
    source_vector_hash: SOURCE_VECTOR_HASH,
    owner_kind: INPUT.ownerKind,
    owner_id: INPUT.ownerId,
    owner_fence: INPUT.ownerFence,
  }))
}

function contents() {
  return SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind, index) => ({
    sectionKind,
    rowCount: String(index),
    sourceHash: String(index + 1).repeat(64).slice(0, 64),
  }))
}

async function errorOf(promise: Promise<unknown>): Promise<RecoveryArchiveSectionBootstrapError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveSectionBootstrapError)
    return error as RecoveryArchiveSectionBootstrapError
  }
  throw new Error('expected_recovery_archive_bootstrap_error')
}

describe('generation-bound recovery archive bootstrap reservations', () => {
  test('returns an existing exact reservation without allocating new identities', async () => {
    const rows = reservationRows()
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generationRow()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows }
      throw new Error('unexpected_query')
    })

    const plan = await reserveRecoveryArchiveSnapshotIdentities(query, INPUT)

    expect(plan.sections).toHaveLength(9)
    expect(plan.sections.map((section) => section.sectionKind)).toEqual(SECTION_CAUSALITY_DATA_SECTION_KINDS)
    expect(plan.snapshotOperationId).toBe(rows[9]?.operation_id)
    expect(plan.snapshotSeq).toBe(rows[9]?.endpoint_seq)
    expect(query.mock.calls.some(([sql]) => sql.includes("nextval('meta_record_chain_seq')"))).toBe(false)
  })

  test('allocates exactly nine ordered bootstrap identities and one greater parent', async () => {
    let persisted: ReturnType<typeof reservationRows> = []
    const query = vi.fn<SealQuery>(async (sql, params = []) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generationRow()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: persisted }
      if (sql.includes("nextval('meta_record_chain_seq')")) {
        return {
          rows: Array.from({ length: 10 }, (_, index) => ({ ordinal: index + 1, endpoint_seq: String(201 + index) })),
        }
      }
      if (sql.includes('INSERT INTO meta_recovery_archive_snapshot_reservations')) {
        const ordinals = params[6] as number[]
        const kinds = params[7] as string[]
        const sections = params[8] as Array<string | null>
        const operationIds = params[9] as string[]
        const seqs = params[10] as string[]
        persisted = ordinals.map((ordinal, index) => ({
          ordinal,
          reservation_kind: kinds[index],
          section_kind: sections[index],
          operation_id: operationIds[index],
          endpoint_seq: seqs[index],
          sheet_id: SHEET_ID,
          source_vector_hash: SOURCE_VECTOR_HASH,
          owner_kind: INPUT.ownerKind,
          owner_id: INPUT.ownerId,
          owner_fence: INPUT.ownerFence,
        }))
        return { rows: [], rowCount: 10 }
      }
      throw new Error('unexpected_query')
    })

    const plan = await reserveRecoveryArchiveSnapshotIdentities(query, INPUT)

    expect(persisted.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(persisted.map((row) => row.section_kind)).toEqual([...SECTION_CAUSALITY_DATA_SECTION_KINDS, null])
    expect(new Set(persisted.map((row) => row.operation_id)).size).toBe(10)
    expect(BigInt(plan.snapshotSeq)).toBeGreaterThan(
      plan.sections.reduce((max, section) => (BigInt(section.endpointSeq) > max ? BigInt(section.endpointSeq) : max), 0n),
    )
  })

  test('refuses generation owner or source-vector drift before reading reservations', async () => {
    const query = vi.fn<SealQuery>(async () => ({ rows: [generationRow({ owner_fence: '8' })] }))

    const error = await errorOf(reserveRecoveryArchiveSnapshotIdentities(query, INPUT))

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_GENERATION_UNAVAILABLE')
    expect(query).toHaveBeenCalledTimes(1)
  })

  test('refuses incomplete, reordered, or non-parent-last stored reservations', async () => {
    for (const rows of [
      reservationRows().slice(0, 9),
      reservationRows().map((row, index) => (index === 0 ? { ...row, section_kind: 'records' } : row)),
      reservationRows().map((row, index) => (index === 9 ? { ...row, endpoint_seq: '100' } : row)),
    ]) {
      const query: SealQuery = async (sql) => {
        if (sql.includes('FROM meta_recovery_archives')) return { rows: [generationRow()] }
        return { rows }
      }
      const error = await errorOf(reserveRecoveryArchiveSnapshotIdentities(query, INPUT))
      expect([
        'RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE',
        'RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH',
      ]).toContain(error.code)
    }
  })

  test('refuses missing, reordered, noncanonical-count, and bad-hash finalize contents before SQL', async () => {
    const valid = contents()
    const invalidSets = [
      valid.slice(0, 8),
      valid.map((entry, index) => (index === 0 ? { ...entry, sectionKind: 'records' } : entry)),
      valid.map((entry, index) => (index === 0 ? { ...entry, rowCount: '01' } : entry)),
      valid.map((entry, index) => (index === 0 ? { ...entry, sourceHash: 'A'.repeat(64) } : entry)),
    ]

    for (const sections of invalidSets) {
      const query = vi.fn<SealQuery>()
      const error = await errorOf(finalizeRecoveryArchiveBootstrapSnapshot(query, { ...INPUT, sections }))
      expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_INVALID_INPUT')
      expect(query).not.toHaveBeenCalled()
    }
  })

  test('a committed retry verifies the exact parent, sources, revisions, and memberships without writes', async () => {
    const rows = reservationRows()
    const sectionContents = contents()
    let corruptSourceHash = false
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generationRow()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations') && !sql.includes('JOIN')) {
        return { rows }
      }
      if (sql.includes('WHERE sheet_id = $1 AND operation_id = $2::uuid')) {
        return {
          rows: [
            {
              endpoint_seq: rows[9]?.endpoint_seq,
              event_count: 0,
              operation_kind: 'archive_snapshot',
              event_contract_version: 2,
              component_count: 9,
            },
          ],
        }
      }
      if (sql.includes('JOIN meta_record_history_operations source')) {
        return {
          rows: rows.slice(0, 9).map((row, index) => ({
            ordinal: row.ordinal,
            section_kind: row.section_kind,
            source_operation_id: row.operation_id,
            source_endpoint_seq: row.endpoint_seq,
            source_operation_kind: 'section_bootstrap',
            source_event_count: 1,
            action: 'bootstrap_snapshot',
            row_count: sectionContents[index]?.rowCount,
            source_hash: corruptSourceHash && index === 0 ? 'f'.repeat(64) : sectionContents[index]?.sourceHash,
            source_head_kind: 'section_bootstrap',
            member_operation_id: row.operation_id,
            member_head_seq: row.endpoint_seq,
            member_row_count: sectionContents[index]?.rowCount,
            member_source_hash: sectionContents[index]?.sourceHash,
          })),
        }
      }
      throw new Error('unexpected_query')
    })

    const plan = await finalizeRecoveryArchiveBootstrapSnapshot(query, { ...INPUT, sections: sectionContents })

    expect(plan.snapshotOperationId).toBe(rows[9]?.operation_id)
    expect(query.mock.calls.some(([sql]) => sql.trimStart().startsWith('INSERT'))).toBe(false)

    corruptSourceHash = true
    const error = await errorOf(finalizeRecoveryArchiveBootstrapSnapshot(query, { ...INPUT, sections: sectionContents }))
    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')
  })
})
