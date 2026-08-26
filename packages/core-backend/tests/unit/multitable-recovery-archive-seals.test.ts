import { describe, expect, test } from 'vitest'

import { isMultitableRecoveryArchiveEnabled } from '../../src/multitable/recovery-archive-contract'
import {
  assertDirectEventOperationKind,
  assertRecordsSectionUsesBootstrap,
  assertSectionCausalityDataSectionKind,
  assertSectionCausalityOperationKind,
  assertSectionCausalitySectionAction,
  bootstrapSectionEntityKey,
  RecoveryArchiveSealError,
  sealArchiveSnapshotOperation,
  sealDirectEventOperation,
  sealRestoreAggregateOperation,
  sealSectionBootstrapOperation,
  SECTION_CAUSALITY_D2C_SNAPSHOT_SOURCE_HEAD_KINDS,
  SECTION_CAUSALITY_DATA_SECTION_KINDS,
  SECTION_CAUSALITY_DIRECT_EVENT_KINDS,
  SECTION_CAUSALITY_EVENT_CONTRACT_V2,
  SECTION_CAUSALITY_GENERIC_SEAL_KINDS,
  SECTION_CAUSALITY_INT4_MAX,
  SECTION_CAUSALITY_OPERATION_KINDS,
  SECTION_CAUSALITY_SECTION_ACTIONS,
  SECTION_CAUSALITY_SOURCE_HEAD_KINDS,
  SECTION_CAUSALITY_ZERO_DIRECT_EVENT_KINDS,
  sumCheckedInt4EventCounts,
  type SealQuery,
} from '../../src/multitable/recovery-archive-seals'

const SHA256 = 'a'.repeat(64)
const TWO_POW_53_PLUS_1 = '9007199254740993'
const PARENT_SEQ = '9007199254741002'
const BOOTSTRAP_ID = '11111111-1111-4111-8111-111111111111'

function expectSealError(fn: () => unknown, code: string) {
  expect(fn).toThrow(RecoveryArchiveSealError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code, message: code })
  }
}

async function expectSealErrorAsync(fn: () => Promise<unknown>, code: string) {
  let caught: unknown
  try {
    await fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RecoveryArchiveSealError)
  expect(caught).toMatchObject({ code, message: code })
}

function unusedQuery(): SealQuery {
  return async () => {
    throw new Error('section_causality_query_must_not_run')
  }
}

function snapshotMembers() {
  return SECTION_CAUSALITY_DATA_SECTION_KINDS.map((sectionKind, index) => ({
    ordinal: index + 1,
    sectionKind,
    sourceHeadKind: 'section_bootstrap' as const,
    sourceOperationId: '11111111-1111-4111-8111-11111111111' + String(index),
    sourceHeadSeq: String(9007199254740993n + BigInt(index)),
    rowCount: index === 0 ? '0' : TWO_POW_53_PLUS_1,
    sourceHash: SHA256,
  }))
}

describe('Time Machine D2c closed causality values', () => {
  test('freezes operation kinds, direct-event union, and zero-direct-event kinds', () => {
    expect(SECTION_CAUSALITY_OPERATION_KINDS).toEqual([
      'ordinary',
      'section_bootstrap',
      'archive_snapshot',
      'restore_chunk',
      'restore_aggregate',
    ])
    expect(SECTION_CAUSALITY_DIRECT_EVENT_KINDS).toEqual(['ordinary', 'section_bootstrap', 'restore_chunk'])
    expect(SECTION_CAUSALITY_GENERIC_SEAL_KINDS).toEqual(['ordinary', 'restore_chunk'])
    expect(SECTION_CAUSALITY_ZERO_DIRECT_EVENT_KINDS).toEqual(['archive_snapshot', 'restore_aggregate'])
    expect([...SECTION_CAUSALITY_DIRECT_EVENT_KINDS, ...SECTION_CAUSALITY_ZERO_DIRECT_EVENT_KINDS].sort()).toEqual(
      [...SECTION_CAUSALITY_OPERATION_KINDS].sort(),
    )
  })

  test('data section kinds are the v1 manifest set minus derived coverage_index', () => {
    expect(SECTION_CAUSALITY_DATA_SECTION_KINDS).toEqual([
      'schema',
      'records',
      'links',
      'field_value_tombstones',
      'link_tombstones',
      'auto_number',
      'attachments_index',
      'permission_evidence',
      'views_config',
    ])
    expect(SECTION_CAUSALITY_SECTION_ACTIONS).toEqual(['bootstrap_snapshot', 'upsert', 'delete'])
    expect(SECTION_CAUSALITY_SOURCE_HEAD_KINDS).toEqual([
      'section_bootstrap',
      'ordinary',
      'restore_chunk',
      'restore_aggregate',
    ])
    expect(SECTION_CAUSALITY_D2C_SNAPSHOT_SOURCE_HEAD_KINDS).toEqual(['section_bootstrap'])
  })

  test('closed enums are case-sensitive and values-free on refusal', () => {
    for (const kind of SECTION_CAUSALITY_OPERATION_KINDS) {
      expect(() => assertSectionCausalityOperationKind(kind)).not.toThrow()
    }
    expectSealError(
      () => assertSectionCausalityOperationKind('ARCHIVE_SNAPSHOT'),
      'SECTION_CAUSALITY_INVALID_OPERATION_KIND',
    )
    expectSealError(
      () => assertSectionCausalityDataSectionKind('coverage_index'),
      'SECTION_CAUSALITY_INVALID_SECTION_KIND',
    )
    expectSealError(() => assertSectionCausalityOperationKind('marker'), 'SECTION_CAUSALITY_INVALID_OPERATION_KIND')
    expectSealError(
      () => assertSectionCausalitySectionAction('BOOTSTRAP_SNAPSHOT'),
      'SECTION_CAUSALITY_INVALID_SECTION_ACTION',
    )
    expectSealError(
      () => assertRecordsSectionUsesBootstrap('records', 'upsert'),
      'SECTION_CAUSALITY_RECORDS_REQUIRES_BOOTSTRAP',
    )
    expect(() => assertRecordsSectionUsesBootstrap('records', 'bootstrap_snapshot')).not.toThrow()
    expect(bootstrapSectionEntityKey('records')).toBe('section/records')
  })
})

describe('Time Machine D2c generic helper cannot mint synthetic kinds or bootstrap', () => {
  test('archive flag remains exact-literal OFF in this slice', () => {
    expect(isMultitableRecoveryArchiveEnabled({})).toBe(false)
    expect(
      isMultitableRecoveryArchiveEnabled({
        MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
      }),
    ).toBe(true)
    expect(
      isMultitableRecoveryArchiveEnabled({
        MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'TRUE',
      }),
    ).toBe(false)
  })

  test('assertDirectEventOperationKind refuses synthetic kinds and section_bootstrap', () => {
    expectSealError(
      () => assertDirectEventOperationKind('archive_snapshot'),
      'SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN',
    )
    expectSealError(
      () => assertDirectEventOperationKind('restore_aggregate'),
      'SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN',
    )
    expectSealError(
      () => assertDirectEventOperationKind('section_bootstrap'),
      'SECTION_CAUSALITY_BOOTSTRAP_HELPER_REQUIRED',
    )
    expect(() => assertDirectEventOperationKind('ordinary')).not.toThrow()
    expect(() => assertDirectEventOperationKind('restore_chunk')).not.toThrow()
  })

  test('sealDirectEventOperation refuses synthetic kinds and section_bootstrap before any SQL', async () => {
    await expectSealErrorAsync(
      () =>
        sealDirectEventOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: TWO_POW_53_PLUS_1,
          eventCount: 1,
          operationKind: 'archive_snapshot',
        }),
      'SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN',
    )
    await expectSealErrorAsync(
      () =>
        sealDirectEventOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: TWO_POW_53_PLUS_1,
          eventCount: 1,
          operationKind: 'restore_aggregate',
        }),
      'SECTION_CAUSALITY_SYNTHETIC_KIND_FORBIDDEN',
    )
    await expectSealErrorAsync(
      () =>
        sealDirectEventOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: TWO_POW_53_PLUS_1,
          eventCount: 1,
          operationKind: 'section_bootstrap',
        }),
      'SECTION_CAUSALITY_BOOTSTRAP_HELPER_REQUIRED',
    )
  })

  test('dedicated snapshot helper refuses a truncated or reordered membership before SQL', async () => {
    const members = snapshotMembers()
    await expectSealErrorAsync(
      () =>
        sealArchiveSnapshotOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: PARENT_SEQ,
          members: members.slice(1),
        }),
      'SECTION_CAUSALITY_INVALID_MEMBERSHIP',
    )
    members[0] = { ...members[0], sectionKind: 'links' }
    await expectSealErrorAsync(
      () =>
        sealArchiveSnapshotOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: PARENT_SEQ,
          members,
        }),
      'SECTION_CAUSALITY_INVALID_SECTION_KIND',
    )
  })

  test('helper refuses a bootstrap member whose source_head_seq is not the child endpoint', async () => {
    const members = snapshotMembers()
    const childEndpoint = members[2]!.sourceHeadSeq
    members[2] = { ...members[2]!, sourceHeadSeq: members[8]!.sourceHeadSeq }
    const query: SealQuery = async (sql) => {
      if (sql.includes('FROM meta_record_history_operations')) {
        return {
          rows: members.map((member) => ({
            operation_id: member.sourceOperationId,
            operation_kind: 'section_bootstrap',
            endpoint_seq: member.sectionKind === 'links' ? childEndpoint : member.sourceHeadSeq,
            section_kind: member.sectionKind,
          })),
        }
      }
      throw new Error('section_causality_query_must_not_run')
    }
    await expectSealErrorAsync(
      () =>
        sealArchiveSnapshotOperation(query, {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: PARENT_SEQ,
          members,
        }),
      'SECTION_CAUSALITY_SOURCE_HEAD_MISMATCH',
    )
  })

  test('helper refuses a bootstrap member whose section_kind is not the captured event', async () => {
    const members = snapshotMembers()
    const query: SealQuery = async (sql) => {
      if (sql.includes('FROM meta_record_history_operations')) {
        return {
          rows: members.map((member) => ({
            operation_id: member.sourceOperationId,
            operation_kind: 'section_bootstrap',
            endpoint_seq: member.sourceHeadSeq,
            section_kind: member.sectionKind === 'records' ? 'schema' : member.sectionKind,
          })),
        }
      }
      throw new Error('section_causality_query_must_not_run')
    }
    await expectSealErrorAsync(
      () =>
        sealArchiveSnapshotOperation(query, {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: PARENT_SEQ,
          members,
        }),
      'SECTION_CAUSALITY_SOURCE_HEAD_MISMATCH',
    )
  })

  test('dedicated snapshot seal refuses every non-bootstrap source kind before SQL', async () => {
    for (const sourceHeadKind of ['ordinary', 'restore_chunk', 'restore_aggregate'] as const) {
      const members = snapshotMembers()
      members[1] = {
        ...members[1],
        sourceHeadKind,
        sourceHash: SHA256,
        rowCount: '1',
      }
      await expectSealErrorAsync(
        () =>
          sealArchiveSnapshotOperation(unusedQuery(), {
            sheetId: 'sheet',
            operationId: BOOTSTRAP_ID,
            endpointSeq: PARENT_SEQ,
            members,
          }),
        'SECTION_CAUSALITY_SNAPSHOT_SOURCE_UNFINALIZED',
      )
    }
    const members = snapshotMembers()
    members[1] = { ...members[1], sourceHeadKind: 'marker' }
    await expectSealErrorAsync(
      () =>
        sealArchiveSnapshotOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: PARENT_SEQ,
          members,
        }),
      'SECTION_CAUSALITY_INVALID_SOURCE_HEAD_KIND',
    )
  })

  test('snapshot seal snapshots caller-owned members before awaited SQL', async () => {
    const members = snapshotMembers()
    const originalHash = members[0]!.sourceHash
    const insertedHashes: unknown[] = []
    const insertedParents: unknown[][] = []
    const input = {
      sheetId: 'sheet',
      operationId: BOOTSTRAP_ID,
      endpointSeq: PARENT_SEQ,
      members,
    }
    const query: SealQuery = async (sql, params = []) => {
      if (sql.includes('FROM meta_record_history_operations')) {
        members[0]!.sourceHash = 'b'.repeat(64)
        input.sheetId = 'mutated-sheet'
        input.operationId = '22222222-2222-4222-8222-222222222222'
        input.endpointSeq = '999'
        return {
          rows: members.map((member) => ({
            operation_id: member.sourceOperationId,
            operation_kind: 'section_bootstrap',
            endpoint_seq: member.sourceHeadSeq,
            section_kind: member.sectionKind,
          })),
        }
      }
      if (sql.includes('INSERT INTO meta_record_history_snapshot_members')) {
        insertedHashes.push(params[8])
        insertedParents.push(params)
      }
      if (sql.includes('INSERT INTO meta_record_history_operations')) {
        insertedParents.push(params)
      }
      return { rows: [] }
    }

    await sealArchiveSnapshotOperation(query, input)

    expect(insertedHashes[0]).toBe(originalHash)
    expect(insertedParents.every((params) => params[0] === 'sheet' && params[1] === BOOTSTRAP_ID)).toBe(true)
    expect(insertedParents.at(-1)?.[2]).toBe(PARENT_SEQ)
    expect(members[0]!.sourceHash).not.toBe(originalHash)
  })

  test('snapshot parent seq must be strictly greater than every source head', async () => {
    const members = snapshotMembers()
    members[8] = { ...members[8], sourceHeadSeq: PARENT_SEQ }
    await expectSealErrorAsync(
      () =>
        sealArchiveSnapshotOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: PARENT_SEQ,
          members,
        }),
      'SECTION_CAUSALITY_PARENT_SEQ_NOT_GREATER',
    )
  })

  test('aggregate helper refuses an empty membership and a parent seq that is not the child max', async () => {
    await expectSealErrorAsync(
      () =>
        sealRestoreAggregateOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: PARENT_SEQ,
          members: [],
        }),
      'SECTION_CAUSALITY_INVALID_MEMBERSHIP',
    )
    await expectSealErrorAsync(
      () =>
        sealRestoreAggregateOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: PARENT_SEQ,
          members: [
            {
              ordinal: 1,
              childOperationId: BOOTSTRAP_ID,
              childEndpointSeq: TWO_POW_53_PLUS_1,
              childEventCount: 2,
            },
          ],
        }),
      'SECTION_CAUSALITY_PARENT_SEQ_NOT_GREATER',
    )
  })

  test('aggregate seal snapshots later members before the first awaited INSERT', async () => {
    const members = [
      {
        ordinal: 1,
        childOperationId: '11111111-1111-4111-8111-111111111111',
        childEndpointSeq: '2',
        childEventCount: 1,
      },
      {
        ordinal: 2,
        childOperationId: '22222222-2222-4222-8222-222222222222',
        childEndpointSeq: '3',
        childEventCount: 2,
      },
    ]
    const insertedCounts: unknown[] = []
    const insertedParents: unknown[][] = []
    const input = {
      sheetId: 'sheet',
      operationId: BOOTSTRAP_ID,
      endpointSeq: '3',
      members,
    }
    const query: SealQuery = async (sql, params = []) => {
      if (sql.includes('INSERT INTO meta_record_history_operation_members')) {
        insertedCounts.push(params[5])
        insertedParents.push(params)
        if (params[2] === 1) {
          members[1]!.childEventCount = 99
          input.sheetId = 'mutated-sheet'
          input.operationId = '33333333-3333-4333-8333-333333333333'
          input.endpointSeq = '999'
        }
      }
      if (sql.includes('INSERT INTO meta_record_history_operations')) {
        insertedParents.push(params)
      }
      return { rows: [] }
    }

    await sealRestoreAggregateOperation(query, input)

    expect(insertedCounts).toEqual([1, 2])
    expect(insertedParents.every((params) => params[0] === 'sheet' && params[1] === BOOTSTRAP_ID)).toBe(true)
    expect(insertedParents.at(-1)?.[2]).toBe('3')
    expect(members[1]!.childEventCount).toBe(99)
  })
})

describe('Time Machine D2c bootstrap helper binds the captured event', () => {
  function matchingEventQuery(overrides: Partial<BootstrapRow> = {}): SealQuery {
    const row = {
      section_kind: 'schema',
      action: 'bootstrap_snapshot',
      seq: TWO_POW_53_PLUS_1,
      row_count: '0',
      source_hash: SHA256,
      ...overrides,
    }
    return async (sql) => {
      if (sql.includes('FROM meta_sheet_section_revisions')) return { rows: [row] }
      throw new Error('section_causality_unexpected_sql')
    }
  }

  type BootstrapRow = {
    section_kind: string
    action: string
    seq: string
    row_count: string
    source_hash: string
  }

  const input = {
    sheetId: 'sheet',
    operationId: BOOTSTRAP_ID,
    endpointSeq: TWO_POW_53_PLUS_1,
    sectionKind: 'schema' as const,
    rowCount: '0',
    sourceHash: SHA256,
  }

  test('each bound value is load-bearing against the captured event', async () => {
    await expectSealErrorAsync(
      () => sealSectionBootstrapOperation(matchingEventQuery({ section_kind: 'links' }), input),
      'SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH',
    )
    await expectSealErrorAsync(
      () => sealSectionBootstrapOperation(matchingEventQuery({ row_count: '1' }), input),
      'SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH',
    )
    await expectSealErrorAsync(
      () => sealSectionBootstrapOperation(matchingEventQuery({ source_hash: 'b'.repeat(64) }), input),
      'SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH',
    )
    await expectSealErrorAsync(
      () =>
        sealSectionBootstrapOperation(matchingEventQuery(), {
          ...input,
          sectionKind: 'links',
        }),
      'SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH',
    )
    await expectSealErrorAsync(
      () =>
        sealSectionBootstrapOperation(matchingEventQuery(), {
          ...input,
          rowCount: '1',
        }),
      'SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH',
    )
    await expectSealErrorAsync(
      () =>
        sealSectionBootstrapOperation(matchingEventQuery(), {
          ...input,
          sourceHash: 'b'.repeat(64),
        }),
      'SECTION_CAUSALITY_BOOTSTRAP_EVENT_MISMATCH',
    )
  })

  test('matching captured event is required before the endpoint INSERT', async () => {
    const calls: string[] = []
    const query: SealQuery = async (sql) => {
      calls.push(sql.includes('FROM meta_sheet_section_revisions') ? 'select' : 'insert')
      if (sql.includes('FROM meta_sheet_section_revisions')) {
        return {
          rows: [
            {
              section_kind: 'schema',
              action: 'bootstrap_snapshot',
              seq: TWO_POW_53_PLUS_1,
              row_count: '0',
              source_hash: SHA256,
            },
          ],
        }
      }
      return { rows: [] }
    }
    await sealSectionBootstrapOperation(query, input)
    expect(calls).toEqual(['select', 'insert'])
  })

  test('bootstrap seal snapshots caller-owned scalar fields before awaited SQL', async () => {
    const mutableInput = { ...input }
    let insertedParams: unknown[] | undefined
    const query: SealQuery = async (sql, params = []) => {
      if (sql.includes('FROM meta_sheet_section_revisions')) {
        mutableInput.sheetId = 'mutated-sheet'
        mutableInput.operationId = '44444444-4444-4444-8444-444444444444'
        mutableInput.endpointSeq = '999'
        mutableInput.sectionKind = 'links'
        mutableInput.rowCount = '1'
        mutableInput.sourceHash = 'b'.repeat(64)
        return {
          rows: [
            {
              section_kind: 'schema',
              action: 'bootstrap_snapshot',
              seq: TWO_POW_53_PLUS_1,
              row_count: '0',
              source_hash: SHA256,
            },
          ],
        }
      }
      insertedParams = params
      return { rows: [] }
    }

    await sealSectionBootstrapOperation(query, mutableInput)

    expect(insertedParams).toEqual(['sheet', BOOTSTRAP_ID, TWO_POW_53_PLUS_1, SECTION_CAUSALITY_EVENT_CONTRACT_V2])
  })
})

describe('Time Machine D2c checked int4 event-count sum', () => {
  test('accepts nonnegative int4 values including zero and INT4_MAX', () => {
    expect(sumCheckedInt4EventCounts([])).toBe(0)
    expect(sumCheckedInt4EventCounts([0, 1, 2])).toBe(3)
    expect(sumCheckedInt4EventCounts([SECTION_CAUSALITY_INT4_MAX])).toBe(SECTION_CAUSALITY_INT4_MAX)
  })

  test('refuses non-integers, negatives, int4 overflow, and unsafe sums', () => {
    expectSealError(() => sumCheckedInt4EventCounts([-1]), 'SECTION_CAUSALITY_INVALID_EVENT_COUNT')
    expectSealError(() => sumCheckedInt4EventCounts([1.5]), 'SECTION_CAUSALITY_INVALID_EVENT_COUNT')
    expectSealError(
      () => sumCheckedInt4EventCounts([SECTION_CAUSALITY_INT4_MAX + 1]),
      'SECTION_CAUSALITY_INVALID_EVENT_COUNT',
    )
    expectSealError(
      () => sumCheckedInt4EventCounts([SECTION_CAUSALITY_INT4_MAX, 1]),
      'SECTION_CAUSALITY_INVALID_EVENT_COUNT',
    )
    expectSealError(
      () =>
        sumCheckedInt4EventCounts([
          Math.floor(SECTION_CAUSALITY_INT4_MAX / 2) + 1,
          Math.floor(SECTION_CAUSALITY_INT4_MAX / 2) + 1,
        ]),
      'SECTION_CAUSALITY_INVALID_EVENT_COUNT',
    )
  })

  test('aggregate helper uses the checked sum before any SQL on overflow', async () => {
    await expectSealErrorAsync(
      () =>
        sealRestoreAggregateOperation(unusedQuery(), {
          sheetId: 'sheet',
          operationId: BOOTSTRAP_ID,
          endpointSeq: TWO_POW_53_PLUS_1,
          members: [
            {
              ordinal: 1,
              childOperationId: '11111111-1111-4111-8111-111111111110',
              childEndpointSeq: '9007199254740992',
              childEventCount: SECTION_CAUSALITY_INT4_MAX,
            },
            {
              ordinal: 2,
              childOperationId: '11111111-1111-4111-8111-111111111112',
              childEndpointSeq: TWO_POW_53_PLUS_1,
              childEventCount: 1,
            },
          ],
        }),
      'SECTION_CAUSALITY_INVALID_EVENT_COUNT',
    )
  })
})
