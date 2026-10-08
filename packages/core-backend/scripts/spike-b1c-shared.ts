// B1c SQL Server page-sequence capability spike: closed, values-free evidence schema.
//
// EVIDENCE ONLY. Nothing in this module certifies a profile, registers a runtime
// executor, activates a binding, or makes a customer request reachable. The real-engine
// spike uses synthetic rows in a throwaway database and records only counts, booleans, and
// closed tokens.
import { isProxy } from 'node:util/types'

export const B1C_SQLSERVER_OUTCOMES = Object.freeze([
  'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN',
  'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_UNOBTAINABLE',
  'INCONCLUSIVE',
] as const)
export type B1cSqlServerOutcome = (typeof B1C_SQLSERVER_OUTCOMES)[number]
const OUTCOME_SET: ReadonlySet<string> = new Set(B1C_SQLSERVER_OUTCOMES)

export const B1C_CONSISTENCY_PROOF = 'SOURCE_SNAPSHOT_TXN' as const
export const B1C_CONTINUATION_LIFETIME = 'CONNECTION_BOUND' as const
export const B1C_CAPABILITY_POSTURE = 'explicit_snapshot_transaction' as const

export const B1C_CONTROL_IDS = Object.freeze([
  'B1C-WRITE-OPT-IN',
  'B1C-DEDICATED-DATABASE',
  'B1C-SNAPSHOT-OFF-NEGATIVE',
  'B1C-FOREIGN-SESSION-CONTROL',
  'B1C-SEQUENCE-DISCRIMINATOR',
] as const)

export interface PageSequenceMeasurement {
  readonly snapshotEnabledReadback: boolean
  readonly snapshotIsolationObserved: boolean
  readonly activeSnapshotObserved: boolean
  readonly sameSessionAcrossPages: boolean
  readonly terminalShortPageObserved: boolean
  readonly snapshotMatchesOriginal: boolean
  readonly freshStateMatchesMutated: boolean
  readonly snapshotDisabledRejected: boolean
  readonly killedSessionAbsent: boolean
  readonly connectionLossRejected: boolean
  readonly commitAfterLossRejected: boolean
  readonly cleanupComplete: boolean
  readonly lossControlTransactionFactoryCalls: number
  readonly writerMutationsCommitted: number
  readonly pageSize: number
  readonly originalRowCount: number
  readonly snapshotRowCount: number
  readonly snapshotDuplicateCount: number
  readonly snapshotMissingCount: number
  readonly snapshotUnexpectedCount: number
  readonly freshRowCount: number
  readonly freshDuplicateCount: number
  readonly freshMissingCount: number
  readonly freshUnexpectedCount: number
  readonly pageCount: number
  readonly pageSessionObservationCount: number
}

export interface B1cSqlServerEvidenceRecord extends PageSequenceMeasurement {
  readonly evidenceSchemaVersion: 1
  readonly dialect: 'sqlserver'
  readonly engineMajorVersion: '2019' | '2022'
  readonly capabilityPosture: typeof B1C_CAPABILITY_POSTURE
  readonly outcome: B1cSqlServerOutcome
  readonly consistencyProof: typeof B1C_CONSISTENCY_PROOF
  readonly continuationLifetime: typeof B1C_CONTINUATION_LIFETIME
  readonly controlsTotal: number
  readonly controlsPassed: number
  readonly observationsTaken: number
  readonly recordedAt: string
}

const RECORD_KEYS = Object.freeze([
  'evidenceSchemaVersion',
  'dialect',
  'engineMajorVersion',
  'capabilityPosture',
  'outcome',
  'consistencyProof',
  'continuationLifetime',
  'snapshotEnabledReadback',
  'snapshotIsolationObserved',
  'activeSnapshotObserved',
  'sameSessionAcrossPages',
  'terminalShortPageObserved',
  'snapshotMatchesOriginal',
  'freshStateMatchesMutated',
  'snapshotDisabledRejected',
  'killedSessionAbsent',
  'connectionLossRejected',
  'commitAfterLossRejected',
  'cleanupComplete',
  'lossControlTransactionFactoryCalls',
  'writerMutationsCommitted',
  'pageSize',
  'originalRowCount',
  'snapshotRowCount',
  'snapshotDuplicateCount',
  'snapshotMissingCount',
  'snapshotUnexpectedCount',
  'freshRowCount',
  'freshDuplicateCount',
  'freshMissingCount',
  'freshUnexpectedCount',
  'pageCount',
  'pageSessionObservationCount',
  'controlsTotal',
  'controlsPassed',
  'observationsTaken',
  'recordedAt',
] as const)
const RECORD_KEY_SET: ReadonlySet<string> = new Set(RECORD_KEYS)

const MEASUREMENT_BOOLEAN_KEYS = Object.freeze([
  'snapshotEnabledReadback',
  'snapshotIsolationObserved',
  'activeSnapshotObserved',
  'sameSessionAcrossPages',
  'terminalShortPageObserved',
  'snapshotMatchesOriginal',
  'freshStateMatchesMutated',
  'snapshotDisabledRejected',
  'killedSessionAbsent',
  'connectionLossRejected',
  'commitAfterLossRejected',
  'cleanupComplete',
] as const)

const MEASUREMENT_COUNT_KEYS = Object.freeze([
  'lossControlTransactionFactoryCalls',
  'writerMutationsCommitted',
  'pageSize',
  'originalRowCount',
  'snapshotRowCount',
  'snapshotDuplicateCount',
  'snapshotMissingCount',
  'snapshotUnexpectedCount',
  'freshRowCount',
  'freshDuplicateCount',
  'freshMissingCount',
  'freshUnexpectedCount',
  'pageCount',
  'pageSessionObservationCount',
] as const)

function assertPlainClosedRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('spike-b1c: evidence record must be a plain object')
  }
  if (isProxy(value)) {
    throw new Error('spike-b1c: evidence record must not be a Proxy')
  }

  let prototype: object | null
  let keys: readonly PropertyKey[]
  let descriptors: PropertyDescriptorMap
  try {
    prototype = Object.getPrototypeOf(value)
    keys = Reflect.ownKeys(value)
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    throw new Error('spike-b1c: evidence record shape is not inspectable')
  }
  if (prototype !== Object.prototype) {
    throw new Error(
      'spike-b1c: evidence record must use the ordinary object prototype',
    )
  }
  if (keys.length !== RECORD_KEYS.length) {
    throw new Error(
      'spike-b1c: evidence record does not match the closed schema',
    )
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !RECORD_KEY_SET.has(key)) {
      throw new Error('spike-b1c: evidence record contains an unknown field')
    }
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error(
        'spike-b1c: evidence fields must be enumerable data properties',
      )
    }
  }
  for (const key of RECORD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(
        `spike-b1c: evidence record is missing required field ${key}`,
      )
    }
  }
}

function assertCanonicalTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 32) {
    throw new Error('spike-b1c: recordedAt must be a canonical UTC timestamp')
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new Error('spike-b1c: recordedAt must be a canonical UTC timestamp')
  }
  const canonical = new Date(parsed).toISOString()
  if (value !== canonical && value !== canonical.replace('.000Z', 'Z')) {
    throw new Error('spike-b1c: recordedAt must be a canonical UTC timestamp')
  }
}

function assertNonNegativeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`spike-b1c: ${field} must be a non-negative integer`)
  }
}

export function pageSequenceProven(
  measurement: PageSequenceMeasurement,
): boolean {
  return (
    measurement.snapshotEnabledReadback &&
    measurement.snapshotIsolationObserved &&
    measurement.activeSnapshotObserved &&
    measurement.sameSessionAcrossPages &&
    measurement.terminalShortPageObserved &&
    measurement.snapshotMatchesOriginal &&
    measurement.freshStateMatchesMutated &&
    measurement.snapshotDisabledRejected &&
    measurement.killedSessionAbsent &&
    measurement.connectionLossRejected &&
    measurement.commitAfterLossRejected &&
    measurement.cleanupComplete &&
    measurement.lossControlTransactionFactoryCalls === 1 &&
    measurement.writerMutationsCommitted === 3 &&
    measurement.pageSize > 0 &&
    measurement.originalRowCount > 0 &&
    measurement.snapshotRowCount === measurement.originalRowCount &&
    measurement.snapshotDuplicateCount === 0 &&
    measurement.snapshotMissingCount === 0 &&
    measurement.snapshotUnexpectedCount === 0 &&
    measurement.freshRowCount === measurement.originalRowCount &&
    measurement.freshDuplicateCount === 0 &&
    measurement.freshMissingCount === 0 &&
    measurement.freshUnexpectedCount === 0 &&
    measurement.pageCount > 1 &&
    measurement.pageSessionObservationCount === measurement.pageCount &&
    measurement.pageCount ===
      Math.ceil(measurement.originalRowCount / measurement.pageSize) &&
    measurement.originalRowCount % measurement.pageSize !== 0
  )
}

export function classifyPageSequenceMeasurement(
  measurement: PageSequenceMeasurement,
  harnessComplete: boolean,
): B1cSqlServerOutcome {
  if (!harnessComplete) return 'INCONCLUSIVE'
  return pageSequenceProven(measurement)
    ? 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN'
    : 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_UNOBTAINABLE'
}

export function assertValidB1cSqlServerEvidenceRecord(
  value: unknown,
): asserts value is B1cSqlServerEvidenceRecord {
  assertPlainClosedRecord(value)
  const record = value as unknown as B1cSqlServerEvidenceRecord
  if (record.evidenceSchemaVersion !== 1) {
    throw new Error('spike-b1c: unsupported evidenceSchemaVersion')
  }
  if (record.dialect !== 'sqlserver') {
    throw new Error('spike-b1c: evidence dialect must be sqlserver')
  }
  if (
    record.engineMajorVersion !== '2019' &&
    record.engineMajorVersion !== '2022'
  ) {
    throw new Error(
      'spike-b1c: engineMajorVersion must be a declared SQL Server matrix version',
    )
  }
  if (record.capabilityPosture !== B1C_CAPABILITY_POSTURE) {
    throw new Error(
      'spike-b1c: capabilityPosture is outside the closed vocabulary',
    )
  }
  if (!OUTCOME_SET.has(record.outcome)) {
    throw new Error('spike-b1c: outcome is outside the closed vocabulary')
  }
  if (record.consistencyProof !== B1C_CONSISTENCY_PROOF) {
    throw new Error('spike-b1c: evidence must identify SOURCE_SNAPSHOT_TXN')
  }
  if (record.continuationLifetime !== B1C_CONTINUATION_LIFETIME) {
    throw new Error('spike-b1c: evidence must identify CONNECTION_BOUND')
  }
  for (const key of MEASUREMENT_BOOLEAN_KEYS) {
    if (typeof record[key] !== 'boolean') {
      throw new Error(`spike-b1c: ${key} must be boolean`)
    }
  }
  for (const key of MEASUREMENT_COUNT_KEYS) {
    assertNonNegativeInteger(record[key], key)
  }
  assertNonNegativeInteger(record.controlsTotal, 'controlsTotal')
  assertNonNegativeInteger(record.controlsPassed, 'controlsPassed')
  assertNonNegativeInteger(record.observationsTaken, 'observationsTaken')
  if (record.controlsPassed > record.controlsTotal) {
    throw new Error('spike-b1c: controlsPassed cannot exceed controlsTotal')
  }
  assertCanonicalTimestamp(record.recordedAt)

  if (record.outcome === 'SQLSERVER_SNAPSHOT_PAGE_SEQUENCE_PROVEN') {
    if (
      record.controlsTotal !== B1C_CONTROL_IDS.length ||
      record.controlsPassed !== record.controlsTotal
    ) {
      throw new Error(
        'spike-b1c: opening evidence requires every declared control to pass',
      )
    }
    if (record.observationsTaken < 1 || !pageSequenceProven(record)) {
      throw new Error(
        'spike-b1c: opening evidence lacks the complete page-sequence proof',
      )
    }
  }
}

export interface SequenceCounts {
  readonly matchesExpected: boolean
  readonly rowCount: number
  readonly duplicateCount: number
  readonly missingCount: number
  readonly unexpectedCount: number
}

export function compareSequence(
  observed: readonly number[],
  expected: readonly number[],
): SequenceCounts {
  const observedSet = new Set(observed)
  const expectedSet = new Set(expected)
  const duplicateCount = observed.length - observedSet.size
  const missingCount = expected.filter(
    (value) => !observedSet.has(value),
  ).length
  const unexpectedCount = [...observedSet].filter(
    (value) => !expectedSet.has(value),
  ).length
  const matchesExpected =
    duplicateCount === 0 &&
    missingCount === 0 &&
    unexpectedCount === 0 &&
    observed.length === expected.length &&
    observed.every((value, index) => value === expected[index])
  return {
    matchesExpected,
    rowCount: observed.length,
    duplicateCount,
    missingCount,
    unexpectedCount,
  }
}

export function b1cEvidenceFileName(
  engineMajorVersion: '2019' | '2022',
): string {
  return `b1c-sqlserver-${engineMajorVersion}-snapshot-page-sequence.json`
}
