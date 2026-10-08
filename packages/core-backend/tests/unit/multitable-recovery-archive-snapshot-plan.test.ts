import { createHash } from 'node:crypto'

import { describe, expect, test, vi } from 'vitest'

import {
  RECOVERY_ARCHIVE_V1_SECTION_NAMES,
  type RecoveryArchiveSectionName,
} from '../../src/multitable/recovery-archive-contract'
import { planRecoveryArchiveCoverageIndex } from '../../src/multitable/recovery-archive-coverage-plan'
import { canonicalizeRecoveryArchiveSectionRows } from '../../src/multitable/recovery-archive-manifest'
import {
  buildRecoveryArchiveSnapshotPlan,
  RecoveryArchiveSnapshotPlanError,
  type RecoveryArchiveSnapshotPlanErrorCode,
} from '../../src/multitable/recovery-archive-snapshot-plan'

const CREATED_AT = '2026-08-28T00:00:00.000Z'
const SENTINEL = 'caller-secret-sentinel'
const decoder = new TextDecoder()

function makeSectionRows(): Record<string, unknown> {
  return {
    schema: [],
    records: [],
    links: [],
    field_value_tombstones: [],
    link_tombstones: [],
    auto_number: [],
    attachments_index: [],
    permission_evidence: [],
    views_config: [],
  }
}

function makeNonces(): Record<RecoveryArchiveSectionName, Uint8Array> {
  return Object.fromEntries(
    RECOVERY_ARCHIVE_V1_SECTION_NAMES.map((name, index) => [
      name,
      Uint8Array.from({ length: 12 }, (_, byteIndex) => index * 12 + byteIndex),
    ]),
  ) as Record<RecoveryArchiveSectionName, Uint8Array>
}

function coverageCandidate(): Record<string, unknown> {
  return {
    sourceKind: 'record_revision',
    boundSection: 'records',
    row: {
      id: 'revision-1',
      sheet_id: 'sheet-1',
      record_id: 'record-1',
      version: 3,
      action: 'update',
      source: 'rest',
      actor_id: 'actor-1',
      changed_field_ids: ['field-1'],
      patch: { field: { before: 'old', after: 'new' } },
      snapshot: { field: 'new' },
      created_at: CREATED_AT,
      batch_id: 'batch-1',
      restored_from_version: null,
      seq: '42',
      operation_id: 'operation-1',
    },
    sourceSeq: '42',
  }
}

function makeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sectionRows: makeSectionRows(),
    coverageCandidates: [],
    nonces: makeNonces(),
    ...overrides,
  }
}

function sectionPlaintext(
  plan: ReturnType<typeof buildRecoveryArchiveSnapshotPlan>,
  name: RecoveryArchiveSectionName,
): string {
  const section = plan.find((candidate) => candidate.sectionName === name)
  if (section === undefined) throw new Error('missing-test-section')
  return decoder.decode(section.plaintext)
}

function expectPlanError(
  run: () => unknown,
  code: RecoveryArchiveSnapshotPlanErrorCode,
): void {
  expect(run).toThrow(RecoveryArchiveSnapshotPlanError)
  try {
    run()
  } catch (error) {
    expect(error).toMatchObject({
      name: 'RecoveryArchiveSnapshotPlanError',
      code,
      message: code,
    })
    expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false)
    expect(String(error)).not.toContain(SENTINEL)
    expect(error instanceof Error ? error.stack : '').not.toContain(SENTINEL)
  }
}

describe('buildRecoveryArchiveSnapshotPlan', () => {
  test('emits exact D1 order and preserves every zero-row section', () => {
    const plan = buildRecoveryArchiveSnapshotPlan(makeInput())

    expect(plan.map((section) => section.sectionName)).toEqual(RECOVERY_ARCHIVE_V1_SECTION_NAMES)
    expect(plan).toHaveLength(10)
    for (const section of plan) {
      expect(section.rowCount).toBe('0')
      expect(decoder.decode(section.plaintext)).toBe('[]')
      expect(section.plaintextSha256).toBe(
        canonicalizeRecoveryArchiveSectionRows(section.sectionName, []).plaintextSha256,
      )
    }
  })

  test('builds all nine data sections through their exact D1 row projections', () => {
    const sectionRows = makeSectionRows()
    sectionRows.schema = [{ field_id: 'field-1', name: 'Name', type: 'text', property: {}, order: 1 }]
    sectionRows.records = [{ record_id: 'record-1', exists: true, version: 1, data: {} }]
    sectionRows.links = [{ link_id: 'link-1', field_id: 'field-1', record_id: 'record-1', foreign_record_id: 'record-2' }]
    sectionRows.field_value_tombstones = [{ id: 'ft-1', field_id: 'field-1', record_id: 'record-1', config_revision_id: 'config-1', value: null, reason: 'delete', created_at: CREATED_AT }]
    sectionRows.link_tombstones = [{ id: 'lt-1', source_revision_id: 'revision-1', field_id: 'field-1', record_id: 'record-1', foreign_record_id: 'record-2', reason: 'delete', created_at: CREATED_AT }]
    sectionRows.auto_number = [{ field_id: 'field-1', next_value: '9007199254740993' }]
    sectionRows.attachments_index = [{ attachment_id: 'attachment-1', record_id: 'record-1', field_id: 'field-1', immutable_object_version: 'v1', plaintext_sha256: 'a'.repeat(64), size_bytes: '42', media_type: 'text/plain', deleted: false }]
    sectionRows.permission_evidence = [{ authorized_scope_hash: 'scope-1', policy_epoch_hash: 'policy-1', captured_at_seq: '42' }]
    sectionRows.views_config = [{ view_id: 'view-1', name: 'Grid', type: 'grid', filter_info: null, sort_info: [], group_info: null, hidden_field_ids: [], config: {} }]

    const plan = buildRecoveryArchiveSnapshotPlan(makeInput({ sectionRows }))

    expect(plan.slice(0, 9).map((section) => section.rowCount)).toEqual(Array(9).fill('1'))
    expect(plan.slice(0, 9).map((section) => JSON.parse(decoder.decode(section.plaintext))[0].entity_key)).toEqual([
      'field/field-1',
      'record/record-1',
      'link/link-1',
      'field-tombstone/ft-1',
      'link-tombstone/lt-1',
      'field/field-1',
      'attachment/attachment-1',
      'scope/scope-1',
      'view/view-1',
    ])
  })

  test('emits UTF-8 ordered, key-order-independent canonical bytes', () => {
    const sectionRows = makeSectionRows()
    sectionRows.records = [
      { record_id: 'é', exists: true, version: 2, data: { z: '最後', a: '漢字' } },
      { data: { z: 'é', a: 'first' }, version: 1, exists: true, record_id: 'z' },
    ]

    const plan = buildRecoveryArchiveSnapshotPlan(makeInput({ sectionRows }))

    expect(sectionPlaintext(plan, 'records')).toBe(
      '[{"entity_key":"record/z","payload":{"data":{"a":"first","z":"é"},"exists":true,"record_id":"z","version":1}},{"entity_key":"record/é","payload":{"data":{"a":"漢字","z":"最後"},"exists":true,"record_id":"é","version":2}}]',
    )
  })

  test('derives coverage_index only from coverage candidates', () => {
    const candidates = [coverageCandidate()]
    const expected = canonicalizeRecoveryArchiveSectionRows(
      'coverage_index',
      planRecoveryArchiveCoverageIndex(candidates),
    )

    const plan = buildRecoveryArchiveSnapshotPlan(makeInput({ coverageCandidates: candidates }))
    const coverage = plan[9]

    expect(coverage.sectionName).toBe('coverage_index')
    expect(decoder.decode(coverage.plaintext)).toBe(expected.canonicalJson)
    expect(coverage.rowCount).toBe('1')
    expect(coverage.plaintextSha256).toBe(expected.plaintextSha256)
  })

  test('has no caller-supplied coverage row surface', () => {
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan({ ...makeInput(), coverageRows: [] }),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_INPUT',
    )
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(makeInput({
        sectionRows: { ...makeSectionRows(), coverage_index: [] },
      })),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_SECTION_ROWS',
    )
  })

  test('snapshots source rows and nonces and freezes plan metadata', () => {
    const sectionRows = makeSectionRows()
    const record = { record_id: 'record-1', exists: true, version: 1, data: { nested: ['first'] } }
    sectionRows.records = [record]
    const nonces = makeNonces()
    const originalNonce = Uint8Array.from(nonces.records)

    const plan = buildRecoveryArchiveSnapshotPlan(makeInput({ sectionRows, nonces }))
    record.data.nested.push('later')
    nonces.records.fill(255)

    expect(sectionPlaintext(plan, 'records')).not.toContain('later')
    expect(plan.find((section) => section.sectionName === 'records')?.nonce).toEqual(originalNonce)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(plan.every(Object.isFrozen)).toBe(true)
    expect(Reflect.set(plan[0], 'rowCount', '99')).toBe(false)
    expect(plan[0].rowCount).toBe('0')
  })

  test('returns fresh plaintext and nonce copies across an async mutation boundary', async () => {
    const sectionRows = makeSectionRows()
    sectionRows.records = [
      { record_id: 'record-1', exists: true, version: 1, data: { value: 'canonical' } },
    ]
    const nonces = makeNonces()
    const expectedNonce = Uint8Array.from(nonces.records)
    const plan = buildRecoveryArchiveSnapshotPlan(makeInput({ sectionRows, nonces }))
    const records = plan.find((section) => section.sectionName === 'records')
    if (records === undefined) throw new Error('missing-test-section')

    const expectedPlaintext = Uint8Array.from(records.plaintext)
    const firstPlaintext = records.plaintext
    const secondPlaintext = records.plaintext
    const reservationNonce = records.nonce
    const secondNonce = records.nonce

    expect(firstPlaintext).not.toBe(secondPlaintext)
    expect(reservationNonce).not.toBe(secondNonce)
    firstPlaintext.fill(0)
    reservationNonce.fill(0)
    await Promise.resolve()

    const sealPlaintext = records.plaintext
    const sealNonce = records.nonce
    expect(sealPlaintext).toEqual(expectedPlaintext)
    expect(sealNonce).toEqual(expectedNonce)
    expect(sealPlaintext).not.toBe(firstPlaintext)
    expect(sealNonce).not.toBe(reservationNonce)
    expect(createHash('sha256').update(sealPlaintext).digest('hex')).toBe(records.plaintextSha256)
  })

  test('requires ten exact-length nonces that are unique within the plan', () => {
    const missing = makeNonces()
    delete (missing as Partial<Record<RecoveryArchiveSectionName, Uint8Array>>).schema
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(makeInput({ nonces: missing })),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCES',
    )

    const short = makeNonces()
    short.schema = new Uint8Array(11)
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(makeInput({ nonces: short })),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCE_LENGTH',
    )

    const duplicate = makeNonces()
    duplicate.records = Uint8Array.from(duplicate.schema)
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(makeInput({ nonces: duplicate })),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_DUPLICATE_NONCE',
    )
  })

  test('rejects an oversized nonce before invoking the native byte copy', () => {
    const nonces = makeNonces()
    nonces.schema = new Uint8Array(13)
    const input = makeInput({ nonces })
    const setSpy = vi.spyOn(Uint8Array.prototype, 'set')
    try {
      expectPlanError(
        () => buildRecoveryArchiveSnapshotPlan(input),
        'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCE_LENGTH',
      )
      expect(setSpy).not.toHaveBeenCalled()
    } finally {
      setSpy.mockRestore()
    }
  })

  test('admits only exact enumerable own data descriptors without invoking getters', () => {
    let getterCalls = 0
    const accessorInput = makeInput()
    Object.defineProperty(accessorInput, 'coverageCandidates', {
      enumerable: true,
      get() {
        getterCalls += 1
        return []
      },
    })
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(accessorInput),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_INPUT',
    )
    expect(getterCalls).toBe(0)

    const nonEnumerableRows = makeSectionRows()
    Object.defineProperty(nonEnumerableRows, 'records', { value: [], enumerable: false })
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(makeInput({ sectionRows: nonEnumerableRows })),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_SECTION_ROWS',
    )

    const symbolNonces = makeNonces()
    Object.defineProperty(symbolNonces, Symbol(SENTINEL), { value: new Uint8Array(12), enumerable: true })
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(makeInput({ nonces: symbolNonces })),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_NONCES',
    )
  })

  test('normalizes reflective and adjacent failures to values-free exact errors', () => {
    const hostile = new Proxy(makeInput(), {
      ownKeys() {
        throw new Error(SENTINEL)
      },
    })
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(hostile),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_INPUT',
    )

    const sectionRows = makeSectionRows()
    sectionRows.records = [{ record_id: SENTINEL, exists: false, version: 1, data: {} }]
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(makeInput({ sectionRows })),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_SECTION_ROWS',
    )

    const invalidCoverage = [{ ...coverageCandidate(), sourceKind: SENTINEL }]
    expectPlanError(
      () => buildRecoveryArchiveSnapshotPlan(makeInput({ coverageCandidates: invalidCoverage })),
      'RECOVERY_ARCHIVE_SNAPSHOT_PLAN_INVALID_COVERAGE_CANDIDATES',
    )
  })
})
