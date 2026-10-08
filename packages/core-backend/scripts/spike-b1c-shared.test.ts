import { describe, expect, it } from 'vitest'
import {
  B1C_CAPABILITY_POSTURE,
  B1C_CONSISTENCY_PROOF,
  B1C_CONTINUATION_LIFETIME,
  assertValidB1cSqlServerEvidenceRecord,
  b1cEvidenceFileName,
  classifyPageSequenceMeasurement,
  compareSequence,
  pageSequenceProven,
  type B1cSqlServerEvidenceRecord,
  type PageSequenceMeasurement,
} from './spike-b1c-shared'

const PROVEN_MEASUREMENT: PageSequenceMeasurement = {
  snapshotEnabledReadback: true,
  snapshotIsolationObserved: true,
  activeSnapshotObserved: true,
  sameSessionAcrossPages: true,
  terminalShortPageObserved: true,
  snapshotMatchesOriginal: true,
  freshStateMatchesMutated: true,
  snapshotDisabledRejected: true,
  killedSessionAbsent: true,
  connectionLossRejected: true,
  commitAfterLossRejected: true,
  cleanupComplete: true,
  lossControlTransactionFactoryCalls: 1,
  writerMutationsCommitted: 3,
  pageSize: 3,
  originalRowCount: 8,
  snapshotRowCount: 8,
  snapshotDuplicateCount: 0,
  snapshotMissingCount: 0,
  snapshotUnexpectedCount: 0,
  freshRowCount: 8,
  freshDuplicateCount: 0,
  freshMissingCount: 0,
  freshUnexpectedCount: 0,
  pageCount: 3,
  pageSessionObservationCount: 3,
}

function record(
  overrides: Partial<B1cSqlServerEvidenceRecord> = {},
): B1cSqlServerEvidenceRecord {
  return {
    evidenceSchemaVersion: 1,
    dialect: 'sqlserver',
    engineMajorVersion: '2019',
    capabilityPosture: B1C_CAPABILITY_POSTURE,
    outcome: 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
    consistencyProof: B1C_CONSISTENCY_PROOF,
    continuationLifetime: B1C_CONTINUATION_LIFETIME,
    ...PROVEN_MEASUREMENT,
    controlsTotal: 5,
    controlsPassed: 5,
    observationsTaken: 9,
    recordedAt: '2026-07-28T00:00:00Z',
    ...overrides,
  }
}

describe('B1c page-sequence classifier', () => {
  it('opens only for the complete SOURCE_SNAPSHOT_TXN + CONNECTION_BOUND measurement', () => {
    expect(pageSequenceProven(PROVEN_MEASUREMENT)).toBe(true)
    expect(classifyPageSequenceMeasurement(PROVEN_MEASUREMENT, true)).toBe(
      'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
    )
  })

  it.each([
    ['snapshotEnabledReadback', false],
    ['snapshotIsolationObserved', false],
    ['activeSnapshotObserved', false],
    ['sameSessionAcrossPages', false],
    ['terminalShortPageObserved', false],
    ['snapshotMatchesOriginal', false],
    ['freshStateMatchesMutated', false],
    ['snapshotDisabledRejected', false],
    ['killedSessionAbsent', false],
    ['connectionLossRejected', false],
    ['commitAfterLossRejected', false],
    ['cleanupComplete', false],
    ['lossControlTransactionFactoryCalls', 2],
    ['writerMutationsCommitted', 2],
    ['pageSize', 4],
    ['snapshotRowCount', 7],
    ['snapshotDuplicateCount', 1],
    ['snapshotMissingCount', 1],
    ['snapshotUnexpectedCount', 1],
    ['freshRowCount', 7],
    ['freshDuplicateCount', 1],
    ['freshMissingCount', 1],
    ['freshUnexpectedCount', 1],
    ['pageCount', 1],
    ['pageSessionObservationCount', 2],
  ] as const)('refuses when %s is weakened', (key, value) => {
    const weakened = { ...PROVEN_MEASUREMENT, [key]: value }
    expect(pageSequenceProven(weakened)).toBe(false)
    expect(classifyPageSequenceMeasurement(weakened, true)).toBe(
      'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_UNOBTAINABLE',
    )
  })

  it('uses INCONCLUSIVE for an incomplete harness instead of claiming engine unavailability', () => {
    expect(classifyPageSequenceMeasurement(PROVEN_MEASUREMENT, false)).toBe(
      'INCONCLUSIVE',
    )
  })
})

describe('B1c closed values-free evidence', () => {
  it('accepts a complete opening record and both declared engine versions', () => {
    expect(() => assertValidB1cSqlServerEvidenceRecord(record())).not.toThrow()
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord(
        record({ engineMajorVersion: '2022' }),
      ),
    ).not.toThrow()
  })

  it('rejects unknown fields, accessors, non-plain objects, and undeclared versions', () => {
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord({
        ...record(),
        sourceRowKey: 'customer-value',
      }),
    ).toThrow(/unknown field|closed schema/)
    const accessor = record() as unknown as Record<string, unknown>
    Object.defineProperty(accessor, 'pageCount', {
      enumerable: true,
      get: () => 3,
    })
    expect(() => assertValidB1cSqlServerEvidenceRecord(accessor)).toThrow(
      /data properties/,
    )
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord(
        Object.assign(Object.create(null), record()),
      ),
    ).toThrow(/ordinary object prototype/)
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord(new Proxy(record(), {})),
    ).toThrow(/must not be a Proxy/)
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord({
        ...record(),
        engineMajorVersion: 'latest',
      }),
    ).toThrow(/declared SQL Server matrix version/)
  })

  it('rejects a forged opening outcome when any independent proof leg or control count is missing', () => {
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord(
        record({ activeSnapshotObserved: false }),
      ),
    ).toThrow(/complete page-sequence proof/)
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord(record({ controlsPassed: 3 })),
    ).toThrow(/every declared control/)
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord(
        record({ controlsTotal: 1, controlsPassed: 1 }),
      ),
    ).toThrow(/every declared control/)
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord(record({ observationsTaken: 0 })),
    ).toThrow(/complete page-sequence proof/)
  })

  it('allows a closed non-opening result without pretending that it proved the capability', () => {
    expect(() =>
      assertValidB1cSqlServerEvidenceRecord(
        record({
          outcome: 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_UNOBTAINABLE',
          snapshotEnabledReadback: false,
        }),
      ),
    ).not.toThrow()
  })
})

describe('B1c sequence comparison', () => {
  it('requires exact order and exact multiset equality', () => {
    expect(compareSequence([10, 20, 30], [10, 20, 30])).toEqual({
      matchesExpected: true,
      rowCount: 3,
      duplicateCount: 0,
      missingCount: 0,
      unexpectedCount: 0,
    })
    expect(compareSequence([10, 30, 20], [10, 20, 30]).matchesExpected).toBe(
      false,
    )
    expect(compareSequence([10, 20, 20], [10, 20, 30])).toMatchObject({
      matchesExpected: false,
      duplicateCount: 1,
      missingCount: 1,
    })
    expect(compareSequence([10, 20, 40], [10, 20, 30])).toMatchObject({
      matchesExpected: false,
      missingCount: 1,
      unexpectedCount: 1,
    })
  })

  it('uses a distinct B1c artifact name', () => {
    expect(b1cEvidenceFileName('2019')).toBe(
      'b1c-sqlserver-2019-snapshot-page-sequence.json',
    )
    expect(b1cEvidenceFileName('2022')).toBe(
      'b1c-sqlserver-2022-snapshot-page-sequence.json',
    )
  })
})
