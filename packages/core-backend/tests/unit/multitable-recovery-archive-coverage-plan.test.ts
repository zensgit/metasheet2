import { describe, expect, test } from 'vitest'

import {
  assertRecoveryArchiveCoverageKindBinding,
  RECOVERY_ARCHIVE_COVERAGE_BINDING_TARGETS,
  RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS,
  RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS,
  type RecoveryArchiveCoverageBindingTarget,
  type RecoveryArchiveCoverageSourceKind,
} from '../../src/multitable/recovery-archive-contract'
import { canonicalizeRecoveryArchiveSectionRows } from '../../src/multitable/recovery-archive-manifest'
import {
  planRecoveryArchiveCoverageIndex,
  RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS,
  RECOVERY_ARCHIVE_COVERAGE_INDEX_PAYLOAD_KEYS,
  RECOVERY_ARCHIVE_COVERAGE_PLAN_CANDIDATE_KEYS,
  RecoveryArchiveCoveragePlanError,
} from '../../src/multitable/recovery-archive-coverage-plan'
import {
  computeRecoveryArchiveSourceHash,
  RecoveryArchiveSourceHashError,
} from '../../src/multitable/recovery-archive-source-hash'

const CREATED_AT = '2026-08-26T00:00:00.000Z'
const SHA256_A = 'a'.repeat(64)
const DATA_SECTIONS = RECOVERY_ARCHIVE_COVERAGE_BINDING_TARGETS.filter(
  (name): name is Exclude<RecoveryArchiveCoverageBindingTarget, 'manifest_root'> =>
    name !== 'manifest_root',
)

const ROWS: Record<RecoveryArchiveCoverageSourceKind, Record<string, unknown>> = {
  record_revision: {
    id: 'rev-0001',
    sheet_id: 'sheet-0001',
    record_id: 'rec-0001',
    version: 3,
    action: 'update',
    source: 'rest',
    actor_id: 'actor-0001',
    changed_field_ids: ['f1'],
    patch: { f1: { before: 1, after: 2 } },
    snapshot: { f1: 2 },
    created_at: CREATED_AT,
    batch_id: 'batch-0001',
    restored_from_version: null,
    seq: '42',
    operation_id: 'op-0001',
  },
  marker: {
    id: 'marker-0001',
    sheet_id: 'sheet-0001',
    record_id: 'rec-0001',
    version: 4,
    kind: 'lock',
    actor_id: 'actor-0001',
    created_at: CREATED_AT,
    seq: '43',
    operation_id: 'op-0001',
  },
  section_revision: {
    id: 'section-0001',
    sheet_id: 'sheet-0001',
    section_kind: 'records',
    entity_key: 'section/records',
    action: 'bootstrap_snapshot',
    payload: { row_count: '0', source_hash: SHA256_A },
    tombstone: null,
    seq: '44',
    operation_id: 'op-0001',
    created_at: CREATED_AT,
  },
  config_revision: {
    id: 'config-0001',
    sheet_id: 'sheet-0001',
    entity_type: 'field',
    entity_id: 'field-0001',
    action: 'update',
    before: { name: 'Old' },
    after: { name: 'New' },
    changed_keys: ['name'],
    batch_id: 'batch-0001',
    actor_id: 'actor-0001',
    created_at: CREATED_AT,
    source: 'mutation',
    restored_from_id: null,
    operation_id: 'op-0001',
  },
  field_tombstone: {
    id: 'ft-0001',
    sheet_id: 'sheet-0001',
    field_id: 'field-0001',
    record_id: 'rec-0001',
    value: { v: 1 },
    reason: 'field_delete',
    config_revision_id: 'config-0001',
    created_at: CREATED_AT,
    operation_id: 'op-0001',
  },
  link_tombstone: {
    id: 'lt-0001',
    sheet_id: 'sheet-0001',
    field_id: 'field-0001',
    record_id: 'rec-0001',
    foreign_record_id: 'rec-0002',
    reason: 'record_delete',
    source_revision_id: 'rev-0001',
    created_at: CREATED_AT,
    operation_id: 'op-0001',
  },
  checkpoint_baseline: {
    id: 'baseline-0001',
    checkpoint_id: 'ckpt-0001',
    sheet_id: 'sheet-0001',
    record_id: 'rec-0001',
    data: { f1: 2 },
    version: 3,
    is_trashed: false,
    created_at: CREATED_AT,
  },
  sealed_operation_endpoint: {
    sheet_id: 'sheet-0001',
    operation_id: 'op-0001',
    endpoint_seq: '45',
    event_count: 2,
    created_at: CREATED_AT,
    operation_kind: 'ordinary',
    event_contract_version: 2,
    component_count: null,
  },
  snapshot_membership: {
    sheet_id: 'sheet-0001',
    parent_operation_id: 'op-snap-0001',
    ordinal: 1,
    section_kind: 'records',
    source_head_kind: 'section_bootstrap',
    source_operation_id: 'op-boot-0001',
    source_head_seq: '46',
    row_count: '0',
    source_hash: SHA256_A,
    created_at: CREATED_AT,
  },
  aggregate_membership: {
    sheet_id: 'sheet-0001',
    parent_operation_id: 'op-agg-0001',
    ordinal: 1,
    child_operation_id: 'op-child-0001',
    child_endpoint_seq: '47',
    child_event_count: 3,
    created_at: CREATED_AT,
  },
}

const SOURCE_SEQ: Record<RecoveryArchiveCoverageSourceKind, string | null> = {
  record_revision: '42',
  marker: '43',
  section_revision: '44',
  config_revision: null,
  field_tombstone: null,
  link_tombstone: null,
  checkpoint_baseline: null,
  sealed_operation_endpoint: '45',
  snapshot_membership: '46',
  aggregate_membership: '47',
}

const FIXED_BINDINGS: Record<RecoveryArchiveCoverageSourceKind, RecoveryArchiveCoverageBindingTarget> =
  {
    record_revision: 'records',
    marker: 'records',
    section_revision: 'records',
    config_revision: 'schema',
    field_tombstone: 'field_value_tombstones',
    link_tombstone: 'link_tombstones',
    checkpoint_baseline: 'records',
    sealed_operation_endpoint: 'manifest_root',
    snapshot_membership: 'records',
    aggregate_membership: 'manifest_root',
  }

const FIXED_KINDS = RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS.filter(
  (kind) => RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS[kind].length === 1,
)
const POLYMORPHIC_KINDS = RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS.filter(
  (kind) => RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS[kind].length > 1,
)

function cloneRow(kind: RecoveryArchiveCoverageSourceKind): Record<string, unknown> {
  return { ...ROWS[kind] }
}

function candidate(
  kind: RecoveryArchiveCoverageSourceKind,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sourceKind: kind,
    boundSection: FIXED_BINDINGS[kind],
    row: cloneRow(kind),
    sourceSeq: SOURCE_SEQ[kind],
    ...overrides,
  }
}

function allKindCandidates(): Record<string, unknown>[] {
  return RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS.map((kind) => candidate(kind))
}

function plan(candidates: unknown) {
  return planRecoveryArchiveCoverageIndex(candidates)
}

function canonicalCoverage(candidates: unknown) {
  return canonicalizeRecoveryArchiveSectionRows('coverage_index', plan(candidates))
}

function expectPlanError(fn: () => void, code: string) {
  expect(fn).toThrow(RecoveryArchiveCoveragePlanError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code, message: code })
  }
}

function expectHashError(fn: () => void, code: string) {
  expect(fn).toThrow(RecoveryArchiveSourceHashError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code, message: code })
  }
}

describe('Time Machine D2d2-PREP-C coverage-index planner', () => {
  test('pins exact candidate and payload key registries and freezes them', () => {
    expect(RECOVERY_ARCHIVE_COVERAGE_PLAN_CANDIDATE_KEYS).toEqual([
      'sourceKind',
      'boundSection',
      'row',
      'sourceSeq',
    ])
    expect(RECOVERY_ARCHIVE_COVERAGE_INDEX_PAYLOAD_KEYS).toEqual([
      'source_kind',
      'source_id',
      'source_seq',
      'source_sha256',
      'bound_section',
    ])
    expect(Object.isFrozen(RECOVERY_ARCHIVE_COVERAGE_PLAN_CANDIDATE_KEYS)).toBe(true)
    expect(Object.isFrozen(RECOVERY_ARCHIVE_COVERAGE_INDEX_PAYLOAD_KEYS)).toBe(true)
    expect(() => {
      ;(RECOVERY_ARCHIVE_COVERAGE_PLAN_CANDIDATE_KEYS as unknown as string[]).pop()
    }).toThrow(TypeError)
    expect(() => {
      ;(RECOVERY_ARCHIVE_COVERAGE_INDEX_PAYLOAD_KEYS as unknown as string[]).push('extra')
    }).toThrow(TypeError)
    expect(RECOVERY_ARCHIVE_COVERAGE_PLAN_CANDIDATE_KEYS).toHaveLength(4)
    expect(RECOVERY_ARCHIVE_COVERAGE_INDEX_PAYLOAD_KEYS).toHaveLength(5)
    expect(RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS).toEqual({
      field: 'schema',
      view: 'views_config',
    })
    expect(Object.keys(RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS)).toEqual([
      'field',
      'view',
    ])
    expect(
      (RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS as Record<string, string>)
        .permission,
    ).toBeUndefined()
    expect(
      (RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS as Record<string, string>)
        .sheet_config,
    ).toBeUndefined()
    expect(Object.isFrozen(RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS)).toBe(true)
    expect(() => {
      ;(RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS as { field: string }).field =
        'records'
    }).toThrow(TypeError)
  })

  test.each(RECOVERY_ARCHIVE_COVERAGE_SOURCE_KINDS)(
    'emits the exact coverage_index envelope for %s',
    (kind) => {
      const hashed = computeRecoveryArchiveSourceHash(kind, ROWS[kind], SOURCE_SEQ[kind])
      const rows = plan([candidate(kind)])
      expect(rows).toHaveLength(1)
      expect(Object.keys(rows[0])).toEqual(['entity_key', 'payload'])
      expect(rows[0].entity_key).toBe(`coverage/${kind}/${hashed.sourceId}`)
      expect(rows[0].entity_key.split('/')).toHaveLength(3)
      expect(Object.keys(rows[0].payload)).toEqual([...RECOVERY_ARCHIVE_COVERAGE_INDEX_PAYLOAD_KEYS])
      expect(rows[0].payload).toEqual({
        source_kind: kind,
        source_id: hashed.sourceId,
        source_seq: hashed.sourceSeq,
        source_sha256: hashed.hash,
        bound_section: FIXED_BINDINGS[kind],
      })
    },
  )

  test.each(FIXED_KINDS)('fixed PREP-A binding is accepted for %s', (kind) => {
    const boundSection = RECOVERY_ARCHIVE_COVERAGE_KIND_BINDING_TARGETS[kind][0]
    const rows = plan([candidate(kind, { boundSection })])
    expect(rows[0].payload.bound_section).toBe(boundSection)
    expect(rows[0].payload.source_kind).toBe(kind)
  })

  test('polymorphic config_revision binds field to schema and view to views_config', () => {
    const schema = candidate('config_revision', {
      boundSection: 'schema',
      row: { ...ROWS.config_revision, id: 'config-schema', entity_type: 'field' },
    })
    const views = candidate('config_revision', {
      boundSection: 'views_config',
      row: { ...ROWS.config_revision, id: 'config-views', entity_type: 'view' },
    })
    const rows = plan([schema, views])
    expect(rows.map((row) => row.payload.bound_section).sort()).toEqual(['schema', 'views_config'])
    expect(new Set(rows.map((row) => row.payload.source_id)).size).toBe(2)
    expect(rows.find((row) => row.payload.bound_section === 'schema')?.payload.source_kind).toBe(
      'config_revision',
    )
  })

  test.each(POLYMORPHIC_KINDS.filter((kind) => kind !== 'config_revision'))(
    'polymorphic %s binds to every data section only when row.section_kind matches',
    (kind) => {
      const candidates = DATA_SECTIONS.map((boundSection, index) => {
        if (kind === 'section_revision') {
          return candidate(kind, {
            boundSection,
            row: {
              ...ROWS.section_revision,
              id: `section-${String(index + 1).padStart(4, '0')}`,
              section_kind: boundSection,
              entity_key: `section/${boundSection}`,
            },
          })
        }
        return candidate(kind, {
          boundSection,
          row: { ...ROWS.snapshot_membership, ordinal: index + 1, section_kind: boundSection },
        })
      })
      const rows = plan(candidates)
      expect(rows).toHaveLength(DATA_SECTIONS.length)
      expect(rows.map((row) => row.payload.bound_section).sort()).toEqual([...DATA_SECTIONS].sort())
    },
  )

  test('wrong PREP-A pairings and coverage_index refuse', () => {
    expectPlanError(
      () => plan([candidate('sealed_operation_endpoint', { boundSection: 'records' })]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
    expectPlanError(
      () => plan([candidate('record_revision', { boundSection: 'manifest_root' })]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
    expectPlanError(
      () => plan([candidate('config_revision', { boundSection: 'permission_evidence' })]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
    expectPlanError(
      () => plan([candidate('section_revision', { boundSection: 'manifest_root' })]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
    expectPlanError(
      () => plan([candidate('record_revision', { boundSection: 'coverage_index' })]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
    expectPlanError(
      () => plan([candidate('record_revision', { sourceKind: 'coverage_index' })]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
  })

  test('section_revision refuses boundSection that disagrees with row.section_kind', () => {
    const mismatch = candidate('section_revision', { boundSection: 'schema' })
    expect((mismatch.row as Record<string, unknown>).section_kind).toBe('records')
    expectPlanError(() => plan([mismatch]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
  })

  test('snapshot_membership refuses boundSection that disagrees with row.section_kind', () => {
    const mismatch = candidate('snapshot_membership', { boundSection: 'schema' })
    expect((mismatch.row as Record<string, unknown>).section_kind).toBe('records')
    expectPlanError(() => plan([mismatch]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
  })

  test('config_revision maps field->schema and view->views_config, and fail-closes the rest', () => {
    expect(plan([candidate('config_revision')])[0].payload.bound_section).toBe('schema')
    expect(
      plan([
        candidate('config_revision', {
          boundSection: 'views_config',
          row: { ...ROWS.config_revision, entity_type: 'view' },
        }),
      ])[0].payload.bound_section,
    ).toBe('views_config')

    expectPlanError(
      () =>
        plan([
          candidate('config_revision', {
            boundSection: 'views_config',
            row: { ...ROWS.config_revision, entity_type: 'field' },
          }),
        ]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
    expectPlanError(
      () =>
        plan([
          candidate('config_revision', {
            boundSection: 'schema',
            row: { ...ROWS.config_revision, entity_type: 'view' },
          }),
        ]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
    for (const entityType of ['permission', 'sheet_config', 'unknown']) {
      expectPlanError(
        () =>
          plan([
            candidate('config_revision', {
              boundSection: 'schema',
              row: { ...ROWS.config_revision, entity_type: entityType },
            }),
          ]),
        'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
      )
      expectPlanError(
        () =>
          plan([
            candidate('config_revision', {
              boundSection: 'views_config',
              row: { ...ROWS.config_revision, entity_type: entityType },
            }),
          ]),
        'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
      )
    }
  })

  test('removing the section_revision row-aware check would green the records/schema mismatch', () => {
    const mismatch = candidate('section_revision', { boundSection: 'schema' })
    expectPlanError(() => plan([mismatch]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
    // Mutation proof: PREP-A still admits section_revision+schema, and PREP-B hashes
    // the records row. Without the section_kind equality check this candidate is green.
    expect(() => assertRecoveryArchiveCoverageKindBinding('section_revision', 'schema')).not.toThrow()
    expect(() =>
      computeRecoveryArchiveSourceHash('section_revision', mismatch.row, SOURCE_SEQ.section_revision),
    ).not.toThrow()
  })

  test('removing the snapshot_membership row-aware check would green the records/schema mismatch', () => {
    const mismatch = candidate('snapshot_membership', { boundSection: 'schema' })
    expectPlanError(() => plan([mismatch]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
    expect(() =>
      assertRecoveryArchiveCoverageKindBinding('snapshot_membership', 'schema'),
    ).not.toThrow()
    expect(() =>
      computeRecoveryArchiveSourceHash(
        'snapshot_membership',
        mismatch.row,
        SOURCE_SEQ.snapshot_membership,
      ),
    ).not.toThrow()
  })

  test('removing the config_revision row-aware check would green permission->schema', () => {
    const permissionRow = { ...ROWS.config_revision, entity_type: 'permission' }
    const mismatch = candidate('config_revision', {
      boundSection: 'schema',
      row: permissionRow,
    })
    expectPlanError(() => plan([mismatch]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
    // Mutation proof: PREP-A allows config_revision+schema, and PREP-B hashes a
    // permission entity_type row. Mapping permission onto schema or
    // permission_evidence would be a silent guess against D1.
    expect(() => assertRecoveryArchiveCoverageKindBinding('config_revision', 'schema')).not.toThrow()
    expect(() => computeRecoveryArchiveSourceHash('config_revision', permissionRow, null)).not.toThrow()
  })

  test('exact source-row snapshot pins section_kind from data descriptors, not property get', () => {
    const target = { ...ROWS.section_revision, section_kind: 'records' }
    const hostile = new Proxy(target, {
      get(object, key, receiver) {
        if (key === 'section_kind') return 'records'
        return Reflect.get(object, key, receiver)
      },
      getOwnPropertyDescriptor(object, key) {
        if (key === 'section_kind') {
          return { configurable: true, enumerable: true, writable: true, value: 'schema' }
        }
        return Reflect.getOwnPropertyDescriptor(object, key)
      },
    })
    expect(hostile.section_kind).toBe('records')
    expect(Object.getOwnPropertyDescriptor(hostile, 'section_kind')?.value).toBe('schema')
    // Descriptor snapshot sees schema, so boundSection=records refuses. A bypass that
    // binds against ordinary get (`admitted.row.section_kind`) would incorrectly pass.
    expectPlanError(
      () => plan([candidate('section_revision', { boundSection: 'records', row: hostile })]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING',
    )
  })

  test('the same descriptor snapshot feeds row-aware binding and source hashing', () => {
    const target = { ...ROWS.section_revision, section_kind: 'records' }
    let sectionKindDescriptorReads = 0
    const hostile = new Proxy(target, {
      getOwnPropertyDescriptor(object, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
        if (key !== 'section_kind' || descriptor === undefined || !('value' in descriptor)) {
          return descriptor
        }
        sectionKindDescriptorReads += 1
        return {
          ...descriptor,
          value: sectionKindDescriptorReads === 1 ? 'records' : 'schema',
        }
      },
    })
    const rows = plan([
      candidate('section_revision', { boundSection: 'records', row: hostile }),
    ])
    const expected = computeRecoveryArchiveSourceHash(
      'section_revision',
      { ...ROWS.section_revision, section_kind: 'records' },
      SOURCE_SEQ.section_revision,
    )
    expect(rows[0].payload.source_sha256).toBe(expected.hash)
    expect(sectionKindDescriptorReads).toBe(1)
  })

  test('duplicate (kind, sourceId) refuses even when bound section differs', () => {
    expectPlanError(
      () =>
        plan([
          candidate('section_revision', {
            boundSection: 'records',
            row: { ...ROWS.section_revision, section_kind: 'records' },
          }),
          candidate('section_revision', {
            boundSection: 'schema',
            row: { ...ROWS.section_revision, section_kind: 'schema', entity_key: 'section/schema' },
          }),
        ]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_DUPLICATE_SOURCE',
    )
    expectPlanError(
      () => plan([candidate('record_revision'), candidate('record_revision')]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_DUPLICATE_SOURCE',
    )
  })

  test('the same encoded sourceId is allowed across kinds', () => {
    const rows = plan([
      candidate('record_revision', { row: { ...ROWS.record_revision, id: 'shared-0001' } }),
      candidate('marker', { row: { ...ROWS.marker, id: 'shared-0001' } }),
    ])
    expect(rows[0].payload.source_id).toBe(rows[1].payload.source_id)
    expect(rows[0].entity_key).not.toBe(rows[1].entity_key)
    expect(rows.map((row) => row.payload.source_kind).sort()).toEqual(['marker', 'record_revision'])
  })

  test('result is UTF-8 byte sorted and input reordering is byte-identical', () => {
    const forward = allKindCandidates()
    const reversed = [...forward].reverse()
    expect(reversed.map((row) => row.sourceKind)).not.toEqual(forward.map((row) => row.sourceKind))

    const planned = plan(reversed)
    const entityKeys = planned.map((row) => row.entity_key)
    expect(entityKeys).toEqual([...entityKeys].sort((left, right) => {
      const leftBytes = new TextEncoder().encode(left)
      const rightBytes = new TextEncoder().encode(right)
      const shared = Math.min(leftBytes.length, rightBytes.length)
      for (let index = 0; index < shared; index += 1) {
        if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index]
      }
      return leftBytes.length - rightBytes.length
    }))

    const first = canonicalCoverage(forward)
    const second = canonicalCoverage(reversed)
    expect(second.canonicalJson).toBe(first.canonicalJson)
    expect(second.plaintextSha256).toBe(first.plaintextSha256)
    expect(second.rowCount).toBe('10')
    expect(first.plaintextSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('bound_section, source_sha256, and candidate membership are load-bearing', () => {
    const base = canonicalCoverage(allKindCandidates())

    // Mutation 1: matching section_kind+bound_section change alters the coverage payload.
    const boundMutant = allKindCandidates()
    boundMutant[2] = candidate('section_revision', {
      boundSection: 'schema',
      row: { ...ROWS.section_revision, section_kind: 'schema', entity_key: 'section/schema' },
    })
    const boundHash = canonicalCoverage(boundMutant)
    expect(boundHash.plaintextSha256).not.toBe(base.plaintextSha256)
    expect(boundHash.canonicalJson).toContain('"bound_section":"schema"')

    // Mutation 2: one row field change alters delegated source_sha256.
    const rowMutant = allKindCandidates()
    rowMutant[0] = candidate('record_revision', {
      row: { ...ROWS.record_revision, action: 'delete' },
    })
    const rowHash = canonicalCoverage(rowMutant)
    expect(rowHash.plaintextSha256).not.toBe(base.plaintextSha256)
    const baseRecordSha = plan(allKindCandidates()).find(
      (row) => row.payload.source_kind === 'record_revision',
    )?.payload.source_sha256
    const mutantRecordSha = plan(rowMutant).find(
      (row) => row.payload.source_kind === 'record_revision',
    )?.payload.source_sha256
    expect(mutantRecordSha).not.toBe(baseRecordSha)

    // Mutation 3: dropping a candidate changes row_count and the section hash.
    const dropped = allKindCandidates().slice(1)
    const droppedHash = canonicalCoverage(dropped)
    expect(droppedHash.rowCount).toBe('9')
    expect(droppedHash.plaintextSha256).not.toBe(base.plaintextSha256)
  })

  test('Date timestamp input refuses rather than being coerced to a UTC string', () => {
    expectHashError(
      () =>
        plan([
          candidate('record_revision', {
            row: { ...ROWS.record_revision, created_at: new Date('2026-08-26T00:00:00.000Z') },
          }),
        ]),
      'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_ROW',
    )
  })

  test('source-row key failures preserve PREP-B values-free error ownership', () => {
    expectHashError(
      () =>
        plan([
          candidate('record_revision', {
            row: { ...ROWS.record_revision, unexpected: true },
          }),
        ]),
      'RECOVERY_ARCHIVE_SOURCE_HASH_INVALID_KEYS',
    )
  })

  test('non-plain, accessor, symbol, proxy, and unknown-key candidates refuse', () => {
    class Candidate {
      sourceKind = 'record_revision'
      boundSection = 'records'
      row = ROWS.record_revision
      sourceSeq = '42'
    }
    for (const bad of [null, undefined, 1, 'candidate', [], new Date(0), new Map(), new Candidate()]) {
      expectPlanError(() => plan([bad]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE')
    }

    const accessor = candidate('record_revision')
    Object.defineProperty(accessor, 'sourceKind', { enumerable: true, get: () => 'record_revision' })
    expectPlanError(() => plan([accessor]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE')

    const symbolCandidate = candidate('record_revision')
    ;(symbolCandidate as Record<symbol, unknown>)[Symbol('extra')] = 'x'
    expectPlanError(() => plan([symbolCandidate]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE')

    expectPlanError(
      () => plan([candidate('record_revision', { extra: true })]),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE',
    )
    const missing = candidate('record_revision')
    delete missing.sourceSeq
    expectPlanError(() => plan([missing]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE')

    const revoked = Proxy.revocable(candidate('record_revision'), {})
    revoked.revoke()
    expectPlanError(() => plan([revoked.proxy]), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE')

    for (const bad of [null, undefined, 1, {}, 'candidates']) {
      expectPlanError(() => plan(bad), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATES')
    }
    const hole = [candidate('record_revision'), candidate('marker')]
    delete hole[1]
    expectPlanError(() => plan(hole), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATES')
    const extraIndex = [candidate('record_revision')] as unknown as Record<string, unknown>
    extraIndex.extra = candidate('marker')
    expectPlanError(
      () => plan(extraIndex),
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATES',
    )
  })

  test('input mutation after admission does not change the planned envelopes', () => {
    const input = [candidate('record_revision'), candidate('marker')]
    const first = plan(input)
    const originalRecordSha = first.find((row) => row.payload.source_kind === 'record_revision')
      ?.payload.source_sha256
    input.reverse()
    ;(input[0] as Record<string, unknown>).boundSection = 'schema'
    ;(input[0] as { row: Record<string, unknown> }).row.action = 'delete'
    expect(first.map((row) => row.payload.source_kind)).toEqual(['marker', 'record_revision'])
    expect(first.find((row) => row.payload.source_kind === 'record_revision')?.payload.bound_section).toBe(
      'records',
    )
    expect(first.find((row) => row.payload.source_kind === 'record_revision')?.payload.source_sha256).toBe(
      originalRecordSha,
    )
    expectPlanError(() => plan(input), 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
  })

  test('planned rows and payloads are runtime immutable', () => {
    const rows = plan(allKindCandidates())
    expect(Object.isFrozen(rows)).toBe(true)
    expect(rows.every((row) => Object.isFrozen(row) && Object.isFrozen(row.payload))).toBe(true)
    expect(() => {
      ;(rows as unknown as RecoveryArchiveCoveragePlanError[]).pop()
    }).toThrow(TypeError)
    expect(() => {
      ;(rows[0] as { entity_key: string }).entity_key = 'coverage/tampered/x'
    }).toThrow(TypeError)
    expect(() => {
      ;(rows[0].payload as { bound_section: string }).bound_section = 'schema'
    }).toThrow(TypeError)
    expect(rows).toHaveLength(10)
  })

  test('empty candidates yield a frozen zero-row coverage section', () => {
    const rows = plan([])
    expect(rows).toEqual([])
    expect(Object.isFrozen(rows)).toBe(true)
    const canonical = canonicalizeRecoveryArchiveSectionRows('coverage_index', rows)
    expect(canonical.rowCount).toBe('0')
  })

  test('delegated source-hash seq mismatch still surfaces', () => {
    expectHashError(
      () => plan([candidate('record_revision', { sourceSeq: '99' })]),
      'RECOVERY_ARCHIVE_SOURCE_HASH_SEQ_MISMATCH',
    )
  })

  test('null-prototype ordinary candidate descriptors still plan', () => {
    const nullProto = Object.assign(Object.create(null), candidate('checkpoint_baseline'))
    expect(plan([nullProto])).toEqual(plan([candidate('checkpoint_baseline')]))
  })
})
