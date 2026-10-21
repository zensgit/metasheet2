import { describe, expect, test, vi } from 'vitest'

import {
  allocateRecoveryArchiveSnapshotIdentities,
  consumeRecoveryArchiveBootstrapReservations,
  persistRecoveryArchiveSnapshotReservations,
  RecoveryArchiveSectionBootstrapError,
  reserveRecoveryArchiveSnapshotIdentities,
  type RecoveryArchiveBootstrapOwnerInput,
  type RecoveryArchiveSnapshotReservationPlan,
} from '../../src/multitable/recovery-archive-section-bootstrap'
import { computeRecoveryArchiveSourceVectorHash } from '../../src/multitable/recovery-archive-source-vector'
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

function reservationRows(startSeq = 101n, sourceVectorHash = SOURCE_VECTOR_HASH) {
  return Array.from({ length: 10 }, (_, index) => ({
    ordinal: index + 1,
    reservation_kind: index === 9 ? 'archive_snapshot' : 'section_bootstrap',
    section_kind: index === 9 ? null : SECTION_CAUSALITY_DATA_SECTION_KINDS[index],
    operation_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    endpoint_seq: String(startSeq + BigInt(index)),
    sheet_id: SHEET_ID,
    source_vector_hash: sourceVectorHash,
    owner_kind: INPUT.ownerKind,
    owner_id: INPUT.ownerId,
    owner_fence: INPUT.ownerFence,
  }))
}

function persistPlanFromRows(rows = reservationRows()) {
  const sections = rows.slice(0, 9).map((row) => ({
    ordinal: row.ordinal,
    sectionKind: row.section_kind as (typeof SECTION_CAUSALITY_DATA_SECTION_KINDS)[number],
    operationId: row.operation_id,
    endpointSeq: row.endpoint_seq,
  }))
  const sourceVectorHash = computeRecoveryArchiveSourceVectorHash(
    sections.map((section) => ({
      sourceHeadKind: 'section_bootstrap',
      sectionKind: section.sectionKind,
      operationId: section.operationId,
      headSeq: section.endpointSeq,
    })),
  ).hash
  return {
    rows: rows.map((row) => ({ ...row, source_vector_hash: sourceVectorHash })),
    persistInput: {
      ...INPUT,
      sourceVectorHash,
      sections,
      snapshotOperationId: rows[9]?.operation_id ?? '',
      snapshotSeq: rows[9]?.endpoint_seq ?? '',
    },
  }
}

function contents() {
  return SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind, index) => ({
    sectionKind,
    rowCount: String(index),
    sourceHash: String(index + 1).repeat(64).slice(0, 64),
  }))
}

function markerRow(rows = reservationRows()) {
  return {
    sheet_id: SHEET_ID,
    generation_id: GENERATION_ID,
    snapshot_operation_id: rows[9]?.operation_id,
    source_vector_hash: rows[0]?.source_vector_hash ?? SOURCE_VECTOR_HASH,
  }
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
    const { rows, persistInput } = persistPlanFromRows()
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) {
        return { rows: [generationRow({ source_vector_hash: persistInput.sourceVectorHash })] }
      }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows }
      throw new Error('unexpected_query')
    })

    const plan = await reserveRecoveryArchiveSnapshotIdentities(query, persistInput)

    expect(plan.sections).toHaveLength(9)
    expect(plan.sections.map((section) => section.sectionKind)).toEqual(SECTION_CAUSALITY_DATA_SECTION_KINDS)
    expect(plan.snapshotOperationId).toBe(rows[9]?.operation_id)
    expect(plan.snapshotSeq).toBe(rows[9]?.endpoint_seq)
    expect(query.mock.calls.some(([sql]) => sql.includes("nextval('meta_record_chain_seq')"))).toBe(false)
  })

  test('compatibility read refuses a stored plan whose source-vector hash is not canonical', async () => {
    const rows = reservationRows()
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generationRow()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows }
      throw new Error('unexpected_query')
    })

    const error = await errorOf(reserveRecoveryArchiveSnapshotIdentities(query, INPUT))

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    expect(query.mock.calls.some(([sql]) => sql.includes("nextval('meta_record_chain_seq')"))).toBe(false)
  })

  test('consume refuses a stored plan whose source-vector hash is not canonical before sealing', async () => {
    const rows = reservationRows()
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generationRow()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows }
      throw new Error('seal_must_not_be_reached')
    })

    const error = await errorOf(
      consumeRecoveryArchiveBootstrapReservations(query, { ...INPUT, sections: contents() }),
    )

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    expect(query).toHaveBeenCalledTimes(2)
  })

  test('compatibility read refuses an empty plan instead of allocating identities', async () => {
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generationRow()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: [] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [] }
      throw new Error('unexpected_query')
    })

    const error = await errorOf(reserveRecoveryArchiveSnapshotIdentities(query, INPUT))

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE')
    expect(query.mock.calls.some(([sql]) => sql.includes("nextval('meta_record_chain_seq')"))).toBe(false)
  })

  test('allocates exactly nine ordered bootstrap identities and one greater parent', async () => {
    let persisted: ReturnType<typeof reservationRows> = []
    let sourceVectorHash = SOURCE_VECTOR_HASH
    const query = vi.fn<SealQuery>(async (sql, params = []) => {
      if (sql.includes('FROM meta_recovery_archives')) {
        return { rows: [generationRow({ source_vector_hash: sourceVectorHash })] }
      }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: persisted }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [] }
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
          source_vector_hash: params[2] as string,
          owner_kind: INPUT.ownerKind,
          owner_id: INPUT.ownerId,
          owner_fence: INPUT.ownerFence,
        }))
        return { rows: [], rowCount: 10 }
      }
      throw new Error('unexpected_query')
    })

    const allocated = await allocateRecoveryArchiveSnapshotIdentities(query)
    const vector = computeRecoveryArchiveSourceVectorHash(
      allocated.sections.map((section) => ({
        sourceHeadKind: 'section_bootstrap',
        sectionKind: section.sectionKind,
        operationId: section.operationId,
        headSeq: section.endpointSeq,
      })),
    )
    sourceVectorHash = vector.hash
    const plan = await persistRecoveryArchiveSnapshotReservations(
      query,
      {
        ...INPUT,
        sourceVectorHash,
        ...allocated,
      },
      allocated,
    )

    expect(persisted.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(persisted.map((row) => row.section_kind)).toEqual([...SECTION_CAUSALITY_DATA_SECTION_KINDS, null])
    expect(new Set(persisted.map((row) => row.operation_id)).size).toBe(10)
    expect(persisted[0]?.source_vector_hash).toBe(vector.hash)
    expect(BigInt(plan.snapshotSeq)).toBeGreaterThan(
      plan.sections.reduce((max, section) => (BigInt(section.endpointSeq) > max ? BigInt(section.endpointSeq) : max), 0n),
    )
  })

  test('refuses to allocate a second generation after the sheet bootstrap marker exists', async () => {
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generationRow()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: [] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) {
        return { rows: [{ ...markerRow(), generation_id: '22222222-2222-4222-8222-222222222222' }] }
      }
      throw new Error('unexpected_query')
    })

    const error = await errorOf(reserveRecoveryArchiveSnapshotIdentities(query, INPUT))

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_ALREADY_INITIALIZED')
    expect(query.mock.calls.some(([sql]) => sql.includes("nextval('meta_record_chain_seq')"))).toBe(false)
  })

  test('refuses generation owner or source-vector drift before reading reservations', async () => {
    const query = vi.fn<SealQuery>(async () => ({ rows: [generationRow({ owner_fence: '8' })] }))

    const error = await errorOf(reserveRecoveryArchiveSnapshotIdentities(query, INPUT))

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_GENERATION_UNAVAILABLE')
    expect(query).toHaveBeenCalledTimes(1)
  })

  test('refuses incomplete, reordered, or non-parent-last stored reservations', async () => {
    const canonical = persistPlanFromRows()
    for (const rows of [
      canonical.rows.slice(0, 9),
      canonical.rows.map((row, index) => (index === 0 ? { ...row, section_kind: 'records' } : row)),
      canonical.rows.map((row, index) => (index === 9 ? { ...row, endpoint_seq: '100' } : row)),
    ]) {
      const query: SealQuery = async (sql) => {
        if (sql.includes('FROM meta_recovery_archives')) {
          return { rows: [generationRow({ source_vector_hash: canonical.persistInput.sourceVectorHash })] }
        }
        return { rows }
      }
      const error = await errorOf(reserveRecoveryArchiveSnapshotIdentities(query, canonical.persistInput))
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
      const error = await errorOf(consumeRecoveryArchiveBootstrapReservations(query, { ...INPUT, sections }))
      expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_INVALID_INPUT')
      expect(query).not.toHaveBeenCalled()
    }
  })

  test('a committed retry verifies the exact parent, sources, revisions, and memberships without writes', async () => {
    const canonical = persistPlanFromRows()
    const rows = canonical.rows
    const sectionContents = contents()
    let corruptSourceHash = false
    let corruptMarker = false
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) {
        return { rows: [generationRow({ source_vector_hash: canonical.persistInput.sourceVectorHash })] }
      }
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
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) {
        return {
          rows: [
            corruptMarker
              ? { ...markerRow(rows), snapshot_operation_id: '22222222-2222-4222-8222-222222222222' }
              : markerRow(rows),
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

    const plan = await consumeRecoveryArchiveBootstrapReservations(query, {
      ...canonical.persistInput,
      sections: sectionContents,
    })

    expect(plan.snapshotOperationId).toBe(rows[9]?.operation_id)
    expect(query.mock.calls.some(([sql]) => sql.trimStart().startsWith('INSERT'))).toBe(false)

    corruptSourceHash = true
    const error = await errorOf(
      consumeRecoveryArchiveBootstrapReservations(query, { ...canonical.persistInput, sections: sectionContents }),
    )
    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')

    corruptSourceHash = false
    corruptMarker = true
    const markerError = await errorOf(
      consumeRecoveryArchiveBootstrapReservations(query, { ...canonical.persistInput, sections: sectionContents }),
    )
    expect(markerError.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_PARTIAL_FINALIZE')
  })

  test('allocate does not require a generation row and retains bigint decimal seq strings', async () => {
    const start = 9007199254740993n
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) throw new Error('generation_must_not_be_read')
      if (sql.includes("nextval('meta_record_chain_seq')")) {
        return {
          rows: Array.from({ length: 10 }, (_, index) => ({
            ordinal: index + 1,
            endpoint_seq: String(start + BigInt(index)),
          })),
        }
      }
      throw new Error('unexpected_query')
    })

    const allocated = await allocateRecoveryArchiveSnapshotIdentities(query)

    expect(allocated.sections).toHaveLength(9)
    expect(allocated.sections.map((section) => section.sectionKind)).toEqual(SECTION_CAUSALITY_DATA_SECTION_KINDS)
    expect(allocated.sections[0]?.endpointSeq).toBe(String(start))
    expect(allocated.sections[0]?.endpointSeq).not.toBe(String(Number(String(start))))
    expect(BigInt(allocated.snapshotSeq)).toBeGreaterThan(
      allocated.sections.reduce(
        (max, section) => (BigInt(section.endpointSeq) > max ? BigInt(section.endpointSeq) : max),
        0n,
      ),
    )
    expect(Object.isFrozen(allocated)).toBe(true)
    expect(query.mock.calls).toHaveLength(1)
  })

  test('allocate refuses partial, numeric, duplicate, or non-parent-last seq results', async () => {
    for (const rows of [
      Array.from({ length: 9 }, (_, index) => ({ ordinal: index + 1, endpoint_seq: String(201 + index) })),
      Array.from({ length: 10 }, (_, index) => ({ ordinal: index + 1, endpoint_seq: 201 + index })),
      Array.from({ length: 10 }, (_, index) => ({
        ordinal: index + 1,
        endpoint_seq: index === 9 ? '201' : String(201 + index),
      })),
      Array.from({ length: 10 }, (_, index) => ({
        ordinal: index + 1,
        endpoint_seq: index === 1 ? '201' : String(201 + index),
      })),
    ]) {
      const query: SealQuery = async () => ({ rows })
      const error = await errorOf(allocateRecoveryArchiveSnapshotIdentities(query))
      expect([
        'RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE',
        'RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH',
      ]).toContain(error.code)
    }
  })

  test('one caller transaction can allocate, hash, then persist exact reservations', async () => {
    let persisted: ReturnType<typeof reservationRows> = []
    let sourceVectorHash = SOURCE_VECTOR_HASH
    const query = vi.fn<SealQuery>(async (sql, params = []) => {
      if (sql.includes("nextval('meta_record_chain_seq')")) {
        return {
          rows: Array.from({ length: 10 }, (_, index) => ({ ordinal: index + 1, endpoint_seq: String(301 + index) })),
        }
      }
      if (sql.includes('FROM meta_recovery_archives')) {
        return { rows: [generationRow({ source_vector_hash: sourceVectorHash })] }
      }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: persisted }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [] }
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
          source_vector_hash: params[2] as string,
          owner_kind: INPUT.ownerKind,
          owner_id: INPUT.ownerId,
          owner_fence: INPUT.ownerFence,
        }))
        return { rows: [], rowCount: 10 }
      }
      throw new Error('unexpected_query')
    })

    const allocated = await allocateRecoveryArchiveSnapshotIdentities(query)
    expect(query.mock.calls.every(([sql]) => !sql.includes('FROM meta_recovery_archives'))).toBe(true)

    const vector = computeRecoveryArchiveSourceVectorHash(
      allocated.sections.map((section) => ({
        sourceHeadKind: 'section_bootstrap',
        sectionKind: section.sectionKind,
        operationId: section.operationId,
        headSeq: section.endpointSeq,
      })),
    )
    sourceVectorHash = vector.hash
    const persistInput: RecoveryArchiveSnapshotReservationPlan = {
      ...INPUT,
      sourceVectorHash,
      ...allocated,
    }
    const plan = await persistRecoveryArchiveSnapshotReservations(query, persistInput, allocated)

    expect(vector.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(vector.heads.map((head) => head.operationId)).toEqual(allocated.sections.map((section) => section.operationId))
    expect(plan.sourceVectorHash).toBe(vector.hash)
    expect(plan.snapshotOperationId).toBe(allocated.snapshotOperationId)
    expect(plan.sections.map((section) => section.endpointSeq)).toEqual(
      allocated.sections.map((section) => section.endpointSeq),
    )
    expect(persisted).toHaveLength(10)
    expect(persisted[0]?.source_vector_hash).toBe(vector.hash)
  })

  test('first persist refuses caller-fabricated identities without an issued allocation proof', async () => {
    const { persistInput } = persistPlanFromRows()
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) {
        return { rows: [generationRow({ source_vector_hash: persistInput.sourceVectorHash })] }
      }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: [] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [] }
      throw new Error('insert_must_not_be_reached')
    })

    const error = await errorOf(persistRecoveryArchiveSnapshotReservations(query, persistInput))

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
  })

  test('first persist refuses identities that differ from the issued allocation proof', async () => {
    let sourceVectorHash = SOURCE_VECTOR_HASH
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes("nextval('meta_record_chain_seq')")) {
        return {
          rows: Array.from({ length: 10 }, (_, index) => ({ ordinal: index + 1, endpoint_seq: String(501 + index) })),
        }
      }
      if (sql.includes('FROM meta_recovery_archives')) {
        return { rows: [generationRow({ source_vector_hash: sourceVectorHash })] }
      }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: [] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [] }
      throw new Error('insert_must_not_be_reached')
    })
    const allocated = await allocateRecoveryArchiveSnapshotIdentities(query)
    const tamperedSections = allocated.sections.map((section, index) =>
      index === 0 ? { ...section, endpointSeq: '499' } : section,
    )
    sourceVectorHash = computeRecoveryArchiveSourceVectorHash(
      tamperedSections.map((section) => ({
        sourceHeadKind: 'section_bootstrap',
        sectionKind: section.sectionKind,
        operationId: section.operationId,
        headSeq: section.endpointSeq,
      })),
    ).hash

    const error = await errorOf(
      persistRecoveryArchiveSnapshotReservations(
        query,
        { ...INPUT, sourceVectorHash, ...allocated, sections: tamperedSections },
        allocated,
      ),
    )

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
  })

  test('persist returns exact existing identities and refuses a mismatch or partial insert', async () => {
    const { rows, persistInput } = persistPlanFromRows()
    const generation = generationRow({ source_vector_hash: persistInput.sourceVectorHash })

    const matchingQuery = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows }
      throw new Error('unexpected_query')
    })
    const matched = await persistRecoveryArchiveSnapshotReservations(matchingQuery, persistInput)
    expect(matched.snapshotOperationId).toBe(rows[9]?.operation_id)
    expect(matchingQuery.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)

    const mismatchQuery = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows }
      throw new Error('unexpected_query')
    })
    const mismatch = await errorOf(
      persistRecoveryArchiveSnapshotReservations(mismatchQuery, {
        ...persistInput,
        snapshotOperationId: '22222222-2222-4222-8222-222222222222',
      }),
    )
    expect(mismatch.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')

    let partialSourceVectorHash = SOURCE_VECTOR_HASH
    const partialQuery = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes("nextval('meta_record_chain_seq')")) {
        return {
          rows: Array.from({ length: 10 }, (_, index) => ({ ordinal: index + 1, endpoint_seq: String(301 + index) })),
        }
      }
      if (sql.includes('FROM meta_recovery_archives')) {
        return { rows: [generationRow({ source_vector_hash: partialSourceVectorHash })] }
      }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: [] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [] }
      if (sql.includes('INSERT INTO meta_recovery_archive_snapshot_reservations')) return { rows: [], rowCount: 9 }
      throw new Error('unexpected_query')
    })
    const partialAllocated = await allocateRecoveryArchiveSnapshotIdentities(partialQuery)
    partialSourceVectorHash = computeRecoveryArchiveSourceVectorHash(
      partialAllocated.sections.map((section) => ({
        sourceHeadKind: 'section_bootstrap',
        sectionKind: section.sectionKind,
        operationId: section.operationId,
        headSeq: section.endpointSeq,
      })),
    ).hash
    const partial = await errorOf(
      persistRecoveryArchiveSnapshotReservations(
        partialQuery,
        { ...INPUT, sourceVectorHash: partialSourceVectorHash, ...partialAllocated },
        partialAllocated,
      ),
    )
    expect(partial.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_INCOMPLETE')

    const burnedProof = await errorOf(
      persistRecoveryArchiveSnapshotReservations(
        partialQuery,
        { ...INPUT, sourceVectorHash: partialSourceVectorHash, ...partialAllocated },
        partialAllocated,
      ),
    )
    expect(burnedProof.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
  })

  test('persist refuses a syntactically valid wrong source-vector hash before SQL', async () => {
    const { persistInput } = persistPlanFromRows()
    const wrongHash = persistInput.sourceVectorHash === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64)
    expect(wrongHash).toMatch(/^[0-9a-f]{64}$/)
    expect(wrongHash).not.toBe(persistInput.sourceVectorHash)

    let persisted: ReturnType<typeof reservationRows> = []
    const query = vi.fn<SealQuery>(async (sql, params = []) => {
      if (sql.includes('FROM meta_recovery_archives')) {
        return { rows: [generationRow({ source_vector_hash: wrongHash })] }
      }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: persisted }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [] }
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
          source_vector_hash: params[2] as string,
          owner_kind: INPUT.ownerKind,
          owner_id: INPUT.ownerId,
          owner_fence: INPUT.ownerFence,
        }))
        return { rows: [], rowCount: 10 }
      }
      throw new Error('unexpected_query')
    })

    const error = await errorOf(
      persistRecoveryArchiveSnapshotReservations(query, { ...persistInput, sourceVectorHash: wrongHash }),
    )

    expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_RESERVATION_MISMATCH')
    expect(query).not.toHaveBeenCalled()
    expect(persisted).toHaveLength(0)
  })

  test('persist refuses partial, reordered, numeric-seq, or hostile caller identities before SQL', async () => {
    const rows = reservationRows()
    const valid = {
      ...INPUT,
      sections: rows.slice(0, 9).map((row) => ({
        ordinal: row.ordinal,
        sectionKind: row.section_kind as (typeof SECTION_CAUSALITY_DATA_SECTION_KINDS)[number],
        operationId: row.operation_id,
        endpointSeq: row.endpoint_seq,
      })),
      snapshotOperationId: rows[9]?.operation_id ?? '',
      snapshotSeq: rows[9]?.endpoint_seq ?? '',
    }
    const invalidSets = [
      { ...valid, sections: valid.sections.slice(0, 8) },
      {
        ...valid,
        sections: valid.sections.map((section, index) =>
          index === 0 ? { ...section, sectionKind: 'records' as const } : section,
        ),
      },
      {
        ...valid,
        sections: valid.sections.map((section, index) => (index === 0 ? { ...section, endpointSeq: 101 } : section)),
      },
      { ...valid, snapshotSeq: '100' },
      { ...valid, extra: 'x' },
    ]

    for (const input of invalidSets) {
      const query = vi.fn<SealQuery>()
      const error = await errorOf(persistRecoveryArchiveSnapshotReservations(query, input))
      expect(error.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_INVALID_INPUT')
      expect(query).not.toHaveBeenCalled()
    }

    const accessor = {
      ...valid,
      sections: valid.sections.map((section, index) => {
        if (index !== 0) return section
        const hostile = { ...section }
        Object.defineProperty(hostile, 'endpointSeq', { enumerable: true, get: () => section.endpointSeq })
        return hostile
      }),
    }
    const query = vi.fn<SealQuery>()
    const accessorError = await errorOf(persistRecoveryArchiveSnapshotReservations(query, accessor))
    expect(accessorError.code).toBe('RECOVERY_ARCHIVE_BOOTSTRAP_INVALID_INPUT')
    expect(query).not.toHaveBeenCalled()
  })
})
