import { describe, expect, test, vi } from 'vitest'

import {
  allocateRecoveryArchiveCheckpointIdentities,
  consumeRecoveryArchiveCheckpointReservations,
  persistRecoveryArchiveCheckpointReservations,
  RecoveryArchiveSectionCheckpointError,
  type RecoveryArchiveCheckpointOwnerInput,
  type RecoveryArchiveCheckpointSnapshotReservationPlan,
} from '../../src/multitable/recovery-archive-section-checkpoint'
import { computeRecoveryArchiveCheckpointVectorHash } from '../../src/multitable/recovery-archive-source-vector'
import { SECTION_CAUSALITY_DATA_SECTION_KINDS, type SealQuery } from '../../src/multitable/recovery-archive-seals'

const GENERATION_ID = '11111111-1111-4111-8111-111111111111'
const SHEET_ID = 'tm_checkpoint_sheet'
const BOOTSTRAP_GENERATION_ID = '22222222-2222-4222-8222-222222222222'
const BOOTSTRAP_PARENT_ID = '33333333-3333-4333-8333-333333333333'

const OWNER: Omit<RecoveryArchiveCheckpointOwnerInput, 'sourceVectorHash'> = {
  generationId: GENERATION_ID,
  sheetId: SHEET_ID,
  ownerKind: 'archive_builder',
  ownerId: 'tm_checkpoint_owner',
  ownerFence: '9',
}

function rows(startSeq = 101n) {
  return Array.from({ length: 10 }, (_, index) => ({
    ordinal: index + 1,
    reservation_kind: index === 9 ? 'archive_snapshot' : 'section_checkpoint',
    section_kind: index === 9 ? null : SECTION_CAUSALITY_DATA_SECTION_KINDS[index],
    operation_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    endpoint_seq: String(startSeq + BigInt(index)),
    sheet_id: SHEET_ID,
    source_vector_hash: '',
    owner_kind: OWNER.ownerKind,
    owner_id: OWNER.ownerId,
    owner_fence: OWNER.ownerFence,
  }))
}

function planFromRows(sourceRows = rows()): { plan: RecoveryArchiveCheckpointSnapshotReservationPlan; rows: ReturnType<typeof rows> } {
  const sections = sourceRows.slice(0, 9).map((row) => ({
    ordinal: row.ordinal,
    sectionKind: row.section_kind as (typeof SECTION_CAUSALITY_DATA_SECTION_KINDS)[number],
    operationId: row.operation_id,
    endpointSeq: row.endpoint_seq,
  }))
  const sourceVectorHash = computeRecoveryArchiveCheckpointVectorHash(
    sections.map((section) => ({
      sourceHeadKind: 'section_checkpoint',
      sectionKind: section.sectionKind,
      operationId: section.operationId,
      headSeq: section.endpointSeq,
    })),
  ).hash
  return {
    plan: {
      ...OWNER,
      sourceVectorHash,
      sections,
      snapshotOperationId: sourceRows[9]?.operation_id ?? '',
      snapshotSeq: sourceRows[9]?.endpoint_seq ?? '',
    },
    rows: sourceRows.map((row) => ({ ...row, source_vector_hash: sourceVectorHash })),
  }
}

function generation(sourceVectorHash: string) {
  return {
    sheet_id: SHEET_ID,
    source_vector_hash: sourceVectorHash,
    owner_kind: OWNER.ownerKind,
    owner_id: OWNER.ownerId,
    owner_fence: OWNER.ownerFence,
    state: 'building',
    build_status: 'active',
    coverage_status: 'incomplete',
  }
}

function marker() {
  return {
    sheet_id: SHEET_ID,
    generation_id: BOOTSTRAP_GENERATION_ID,
    snapshot_operation_id: BOOTSTRAP_PARENT_ID,
    source_vector_hash: 'a'.repeat(64),
  }
}

function contents() {
  return SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind, index) => ({
    sectionKind,
    rowCount: String(index),
    sourceHash: String(index + 1).repeat(64).slice(0, 64),
  }))
}

async function errorOf(promise: Promise<unknown>): Promise<RecoveryArchiveSectionCheckpointError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(RecoveryArchiveSectionCheckpointError)
    return error as RecoveryArchiveSectionCheckpointError
  }
  throw new Error('expected_checkpoint_error')
}

describe('repeat recovery archive checkpoint reservations', () => {
  test('allocates and persists fresh checkpoint identities only from its private allocation proof', async () => {
    let persisted: ReturnType<typeof rows> = []
    let sourceVectorHash = ''
    const query = vi.fn<SealQuery>(async (sql, params = []) => {
      if (sql.includes("nextval('meta_record_chain_seq')")) {
        return { rows: Array.from({ length: 10 }, (_, index) => ({ ordinal: index + 1, endpoint_seq: String(501 + index) })) }
      }
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation(sourceVectorHash)] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [marker()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: persisted }
      if (sql.includes('INSERT INTO meta_recovery_archive_snapshot_reservations')) {
        const ordinals = params[6] as number[]
        const kinds = params[7] as string[]
        const sectionKinds = params[8] as Array<string | null>
        const operationIds = params[9] as string[]
        const seqs = params[10] as string[]
        persisted = ordinals.map((ordinal, index) => ({
          ordinal,
          reservation_kind: kinds[index] ?? '',
          section_kind: sectionKinds[index] ?? null,
          operation_id: operationIds[index] ?? '',
          endpoint_seq: seqs[index] ?? '',
          sheet_id: SHEET_ID,
          source_vector_hash: params[2] as string,
          owner_kind: OWNER.ownerKind,
          owner_id: OWNER.ownerId,
          owner_fence: OWNER.ownerFence,
        }))
        return { rows: [], rowCount: 10 }
      }
      throw new Error('unexpected_query')
    })

    const allocated = await allocateRecoveryArchiveCheckpointIdentities(query)
    sourceVectorHash = computeRecoveryArchiveCheckpointVectorHash(
      allocated.sections.map((section) => ({
        sourceHeadKind: 'section_checkpoint',
        sectionKind: section.sectionKind,
        operationId: section.operationId,
        headSeq: section.endpointSeq,
      })),
    ).hash
    const plan = await persistRecoveryArchiveCheckpointReservations(
      query,
      { ...OWNER, sourceVectorHash, ...allocated },
      allocated,
    )

    expect(plan.sourceVectorHash).toBe(sourceVectorHash)
    expect(persisted.map((row) => row.reservation_kind)).toEqual([
      ...Array(9).fill('section_checkpoint'),
      'archive_snapshot',
    ])
    expect(persisted.map((row) => row.section_kind)).toEqual([...SECTION_CAUSALITY_DATA_SECTION_KINDS, null])
    expect(BigInt(plan.snapshotSeq)).toBeGreaterThan(BigInt(plan.sections[8]?.endpointSeq ?? '0'))
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO meta_recovery_archive_section_bootstrap_markers'))).toBe(false)
  })

  test('refuses caller-fabricated first reservations and an exact-retry identity mismatch', async () => {
    const canonical = planFromRows()
    const noProof = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation(canonical.plan.sourceVectorHash)] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [marker()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: [] }
      throw new Error('insert_must_not_run')
    })
    const noProofError = await errorOf(persistRecoveryArchiveCheckpointReservations(noProof, canonical.plan))
    expect(noProofError.code).toBe('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
    expect(noProof.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)

    const retry = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation(canonical.plan.sourceVectorHash)] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [marker()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: canonical.rows }
      throw new Error('unexpected_query')
    })
    await expect(persistRecoveryArchiveCheckpointReservations(retry, canonical.plan)).resolves.toEqual(canonical.plan)
    const error = await errorOf(
      persistRecoveryArchiveCheckpointReservations(retry, {
        ...canonical.plan,
        snapshotOperationId: '99999999-9999-4999-8999-999999999999',
      }),
    )
    expect(error.code).toBe('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_MISMATCH')
    expect(retry.mock.calls.some(([sql]) => sql.includes('INSERT'))).toBe(false)
  })

  test('reads every generation reservation and refuses an extra row instead of filtering it away', async () => {
    const canonical = planFromRows()
    const extra = {
      ...canonical.rows[0],
      ordinal: 11,
      operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      endpoint_seq: '111',
    }
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation(canonical.plan.sourceVectorHash)] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [marker()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations')) return { rows: [...canonical.rows, extra] }
      throw new Error('unexpected_query')
    })

    const error = await errorOf(persistRecoveryArchiveCheckpointReservations(query, canonical.plan))

    expect(error.code).toBe('RECOVERY_ARCHIVE_CHECKPOINT_RESERVATION_INCOMPLETE')
    const read = query.mock.calls.find(([sql]) => sql.includes('FROM meta_recovery_archive_snapshot_reservations'))?.[0]
    expect(read).not.toContain('reservation_kind IN')
  })

  test('requires a live exact generation lease and an immutable bootstrap marker before reservations', async () => {
    const canonical = planFromRows()
    const expired = vi.fn<SealQuery>(async () => ({ rows: [] }))
    const expiredError = await errorOf(
      consumeRecoveryArchiveCheckpointReservations(expired, { ...OWNER, sourceVectorHash: canonical.plan.sourceVectorHash, sections: contents() }),
    )
    expect(expiredError.code).toBe('RECOVERY_ARCHIVE_CHECKPOINT_GENERATION_UNAVAILABLE')
    expect(expired.mock.calls[0]?.[0]).toContain('lease_expires_at > clock_timestamp()')
    expect(expired.mock.calls[0]?.[0]).toContain('expires_at > clock_timestamp()')

    const missingMarker = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation(canonical.plan.sourceVectorHash)] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [] }
      throw new Error('reservations_must_not_be_read')
    })
    const markerError = await errorOf(
      consumeRecoveryArchiveCheckpointReservations(missingMarker, { ...OWNER, sourceVectorHash: canonical.plan.sourceVectorHash, sections: contents() }),
    )
    expect(markerError.code).toBe('RECOVERY_ARCHIVE_CHECKPOINT_BOOTSTRAP_UNAVAILABLE')
  })

  test('seals exactly nine checkpoint heads and one archive snapshot without a generic operation fallback', async () => {
    const canonical = planFromRows()
    const sectionContents = contents()
    const query = vi.fn<SealQuery>(async (sql, params = []) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation(canonical.plan.sourceVectorHash)] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [marker()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations') && !sql.includes('JOIN')) return { rows: canonical.rows }
      if (sql.includes('SELECT section_kind, action, seq::text AS seq, payload')) {
        const operationId = params[1]
        const index = canonical.plan.sections.findIndex((section) => section.operationId === operationId)
        const content = sectionContents[index]
        const section = canonical.plan.sections[index]
        return {
          rows: [{
            section_kind: section?.sectionKind,
            action: 'checkpoint_snapshot',
            seq: section?.endpointSeq,
            payload: { row_count: content?.rowCount, source_hash: content?.sourceHash },
          }],
        }
      }
      if (sql.includes('FROM meta_record_history_operations') && sql.includes('WHERE sheet_id = $1 AND operation_id = $2::uuid')) {
        return { rows: [] }
      }
      if (sql.includes('SELECT (')) return { rows: [{ count: 0 }] }
      if (sql.includes('LEFT JOIN meta_sheet_section_revisions')) {
        return {
          rows: canonical.plan.sections.map((section, index) => ({
            operation_id: section.operationId,
            operation_kind: 'section_checkpoint',
            endpoint_seq: section.endpointSeq,
            event_count: 1,
            event_contract_version: 2,
            section_kind: section.sectionKind,
            action: 'checkpoint_snapshot',
            payload: { row_count: sectionContents[index]?.rowCount, source_hash: sectionContents[index]?.sourceHash },
          })),
        }
      }
      if (sql.trimStart().startsWith('INSERT')) return { rows: [], rowCount: 1 }
      throw new Error('unexpected_query')
    })

    const result = await consumeRecoveryArchiveCheckpointReservations(query, {
      ...OWNER,
      sourceVectorHash: canonical.plan.sourceVectorHash,
      sections: sectionContents,
    })

    expect(result).toEqual(canonical.plan)
    const operationInserts = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO meta_record_history_operations'))
    expect(operationInserts).toHaveLength(10)
    expect(operationInserts.slice(0, 9).every(([sql]) => sql.includes("'section_checkpoint'"))).toBe(true)
    expect(operationInserts[9]?.[0]).toContain("'archive_snapshot'")
    expect(query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO meta_record_history_snapshot_members'))).toHaveLength(9)
    expect(query.mock.calls.some(([sql]) => sql.includes("'ordinary'"))).toBe(false)
  })

  test('committed retry verifies every source and member payload without writes, and rejects a payload extra key', async () => {
    const canonical = planFromRows()
    const sectionContents = contents()
    let payloadExtra = false
    const query = vi.fn<SealQuery>(async (sql) => {
      if (sql.includes('FROM meta_recovery_archives')) return { rows: [generation(canonical.plan.sourceVectorHash)] }
      if (sql.includes('FROM meta_recovery_archive_section_bootstrap_markers')) return { rows: [marker()] }
      if (sql.includes('FROM meta_recovery_archive_snapshot_reservations') && !sql.includes('JOIN')) return { rows: canonical.rows }
      if (sql.includes('WHERE sheet_id = $1 AND operation_id = $2::uuid')) {
        return {
          rows: [{
            endpoint_seq: canonical.plan.snapshotSeq,
            event_count: 0,
            operation_kind: 'archive_snapshot',
            event_contract_version: 2,
            component_count: 9,
          }],
        }
      }
      if (sql.includes('JOIN meta_record_history_operations source')) {
        return {
          rows: canonical.plan.sections.map((section, index) => ({
            ordinal: section.ordinal,
            section_kind: section.sectionKind,
            source_operation_id: section.operationId,
            source_endpoint_seq: section.endpointSeq,
            source_operation_kind: 'section_checkpoint',
            source_event_count: 1,
            source_event_contract_version: 2,
            action: 'checkpoint_snapshot',
            payload: payloadExtra && index === 0
              ? { row_count: sectionContents[index]?.rowCount, source_hash: sectionContents[index]?.sourceHash, extra: true }
              : { row_count: sectionContents[index]?.rowCount, source_hash: sectionContents[index]?.sourceHash },
            source_head_kind: 'section_checkpoint',
            member_operation_id: section.operationId,
            member_head_seq: section.endpointSeq,
            member_row_count: sectionContents[index]?.rowCount,
            member_source_hash: sectionContents[index]?.sourceHash,
          })),
        }
      }
      throw new Error('unexpected_query')
    })
    const input = { ...OWNER, sourceVectorHash: canonical.plan.sourceVectorHash, sections: sectionContents }

    await expect(consumeRecoveryArchiveCheckpointReservations(query, input)).resolves.toEqual(canonical.plan)
    expect(query.mock.calls.some(([sql]) => sql.trimStart().startsWith('INSERT'))).toBe(false)
    payloadExtra = true
    const error = await errorOf(consumeRecoveryArchiveCheckpointReservations(query, input))
    expect(error.code).toBe('RECOVERY_ARCHIVE_CHECKPOINT_PARTIAL_FINALIZE')
  })
})
