/**
 * Time Machine Phase D2d2-PREP-C: pure coverage-index planner.
 *
 * This module has no production caller. It does not implement archive creation,
 * coverage writers, prune, storage, database, source-vector, query, cursor, or
 * any runtime route, and it does not change any flag or enablement.
 *
 * Canonical JSON-domain rows only. Date timestamps refuse here; a later RR
 * DB projector must emit canonical UTC strings rather than passing Date
 * objects through this planner.
 *
 * Row-aware bound_section (in addition to PREP-A's kind/section pairing).
 * The exact source row is snapshotted from own data descriptors before hashing
 * so the discriminator used here is the same projection PREP-B hashes.
 *
 * - section_revision / snapshot_membership: bound_section must equal the
 *   snapshotted `section_kind`. That token is the live data-section root
 *   (`zzzz20260826122000_add_section_causality_substrate.ts:232-243,311`).
 * - config_revision: closed map from `meta_config_revisions.entity_type`
 *   (`zzzz20260624120000_create_meta_config_revisions.ts:16`,
 *   `config-revision-recorder.ts:15` = field|permission|view|sheet_config)
 *   onto D1 v1 payload authorities
 *   (`multitable-timemachine-phase-d1-durable-archive-design-lock-20260826.md:375-386`):
 *     field -> schema (`entity_key=field/<field_id>`)
 *     view -> views_config (`entity_key=view/<view_id>`)
 *     permission -> refuse (`permission_evidence` is audit-only, never a
 *       restorable grant set; PREP-A also does not list it as a
 *       config_revision target)
 *     sheet_config -> refuse (no v1 section payload authority)
 */

import {
  assertRecoveryArchiveCoverageKindBinding,
  RecoveryArchiveContractError,
  type RecoveryArchiveCoverageBindingTarget,
  type RecoveryArchiveCoverageSourceKind,
} from './recovery-archive-contract'
import type { RecoveryArchiveRowEnvelope } from './recovery-archive-manifest'
import {
  computeRecoveryArchiveSourceHash,
  RECOVERY_ARCHIVE_SOURCE_ROW_KEYS,
} from './recovery-archive-source-hash'

const CANDIDATE_KEYS = ['sourceKind', 'boundSection', 'row', 'sourceSeq'] as const
const PAYLOAD_KEYS = [
  'source_kind',
  'source_id',
  'source_seq',
  'source_sha256',
  'bound_section',
] as const

function freezeKeys(keys: readonly string[]): readonly string[] {
  return Object.freeze([...keys])
}

/** Exact candidate admission keys. Additive fields refuse rather than being ignored. */
export const RECOVERY_ARCHIVE_COVERAGE_PLAN_CANDIDATE_KEYS: readonly string[] = freezeKeys(CANDIDATE_KEYS)

/** Exact v1 coverage_index payload keys, in D1 authority order. */
export const RECOVERY_ARCHIVE_COVERAGE_INDEX_PAYLOAD_KEYS: readonly string[] = freezeKeys(PAYLOAD_KEYS)

const CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS = {
  field: 'schema',
  view: 'views_config',
} as const

/**
 * Closed row-aware map for config_revision. permission and sheet_config are
 * intentionally absent: D1 has no restorable v1 payload for either.
 */
export const RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS: Readonly<
  Record<'field' | 'view', RecoveryArchiveCoverageBindingTarget>
> = Object.freeze({ ...CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS })

export type RecoveryArchiveCoveragePlanErrorCode =
  | 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATES'
  | 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE'
  | 'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING'
  | 'RECOVERY_ARCHIVE_COVERAGE_PLAN_DUPLICATE_SOURCE'

/** Values-free failure surface for Phase D2d2-PREP-C coverage-index planning. */
export class RecoveryArchiveCoveragePlanError extends Error {
  readonly code: RecoveryArchiveCoveragePlanErrorCode

  constructor(code: RecoveryArchiveCoveragePlanErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveCoveragePlanError'
    this.code = code
  }
}

export interface RecoveryArchiveCoverageIndexPayload {
  source_kind: RecoveryArchiveCoverageSourceKind
  source_id: string
  source_seq: string | null
  source_sha256: string
  bound_section: RecoveryArchiveCoverageBindingTarget
}

/**
 * D2d2-PREP-C only: no production caller currently makes coverage-index planner
 * behavior reachable. Accepts an unknown dense candidate array and emits
 * canonical coverage_index row envelopes.
 */
export function planRecoveryArchiveCoverageIndex(
  candidates: unknown,
): readonly RecoveryArchiveRowEnvelope[] {
  const snapshot = snapshotDenseArrayValues(
    candidates,
    'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATES',
  )
  const seen = new Set<string>()
  const envelopes: RecoveryArchiveRowEnvelope[] = []

  for (const candidate of snapshot) {
    const admitted = snapshotPlainRecordWithExactKeys(
      candidate,
      CANDIDATE_KEYS,
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE',
    )
    assertPrepABinding(admitted.sourceKind, admitted.boundSection)
    const sourceKind = admitted.sourceKind as RecoveryArchiveCoverageSourceKind
    const boundSection = admitted.boundSection as RecoveryArchiveCoverageBindingTarget
    const rowSnapshot = snapshotExactSourceRow(sourceKind, admitted.row, admitted.sourceSeq)
    assertRowAwareBinding(sourceKind, boundSection, rowSnapshot)
    const hashed = computeRecoveryArchiveSourceHash(sourceKind, rowSnapshot, admitted.sourceSeq)
    const entityKey = `coverage/${sourceKind}/${hashed.sourceId}`
    if (seen.has(entityKey)) {
      throwCoveragePlanError('RECOVERY_ARCHIVE_COVERAGE_PLAN_DUPLICATE_SOURCE')
    }
    seen.add(entityKey)
    envelopes.push({
      entity_key: entityKey,
      payload: {
        source_kind: sourceKind,
        source_id: hashed.sourceId,
        source_seq: hashed.sourceSeq,
        source_sha256: hashed.hash,
        bound_section: boundSection,
      },
    })
  }

  envelopes.sort((left, right) => compareUtf8Bytes(left.entity_key, right.entity_key))
  return Object.freeze(envelopes.map(freezeEnvelope))
}

function assertPrepABinding(sourceKind: unknown, boundSection: unknown): void {
  try {
    assertRecoveryArchiveCoverageKindBinding(sourceKind, boundSection)
  } catch (error) {
    if (error instanceof RecoveryArchiveContractError) {
      throwCoveragePlanError('RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
    }
    throw error
  }
}

/**
 * Snapshot the exact PREP-B source-row key set from own data descriptors
 * before hashing. Shape/key failures are delegated to PREP-B so id/seq/hash
 * admission stays in computeRecoveryArchiveSourceHash.
 */
function snapshotExactSourceRow(
  sourceKind: RecoveryArchiveCoverageSourceKind,
  row: unknown,
  sourceSeq: unknown,
): Record<string, unknown> {
  try {
    return snapshotPlainRecordWithExactKeys(
      row,
      RECOVERY_ARCHIVE_SOURCE_ROW_KEYS[sourceKind],
      'RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_CANDIDATE',
    )
  } catch (error) {
    if (error instanceof RecoveryArchiveCoveragePlanError) {
      computeRecoveryArchiveSourceHash(sourceKind, row, sourceSeq)
    }
    throw error
  }
}

function assertRowAwareBinding(
  sourceKind: RecoveryArchiveCoverageSourceKind,
  boundSection: RecoveryArchiveCoverageBindingTarget,
  row: Record<string, unknown>,
): void {
  if (sourceKind === 'section_revision' || sourceKind === 'snapshot_membership') {
    if (row.section_kind !== boundSection) {
      throwCoveragePlanError('RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
    }
    return
  }
  if (sourceKind === 'config_revision') {
    const mapped =
      row.entity_type === 'field' || row.entity_type === 'view'
        ? RECOVERY_ARCHIVE_CONFIG_REVISION_ENTITY_TYPE_BOUND_SECTIONS[row.entity_type]
        : undefined
    if (mapped !== boundSection) {
      throwCoveragePlanError('RECOVERY_ARCHIVE_COVERAGE_PLAN_INVALID_BINDING')
    }
  }
}

function freezeEnvelope(envelope: RecoveryArchiveRowEnvelope): RecoveryArchiveRowEnvelope {
  return Object.freeze({
    entity_key: envelope.entity_key,
    payload: Object.freeze({ ...envelope.payload }),
  })
}

function compareUtf8Bytes(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left)
  const rightBytes = utf8Encoder.encode(right)
  const shared = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < shared; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index]
  }
  return leftBytes.length - rightBytes.length
}

/**
 * Snapshot a dense array from own data descriptors exactly once. The returned
 * plain array is the only value source used after admission, so a Proxy `get`
 * trap cannot substitute a later value after validation.
 */
function snapshotDenseArrayValues(
  value: unknown,
  errorCode: RecoveryArchiveCoveragePlanErrorCode,
): unknown[] {
  try {
    if (!Array.isArray(value)) throwCoveragePlanError(errorCode)
    const keys = Reflect.ownKeys(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (
      lengthDescriptor === undefined ||
      !('value' in lengthDescriptor) ||
      typeof lengthDescriptor.value !== 'number' ||
      !Number.isInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throwCoveragePlanError(errorCode)
    }
    const length = lengthDescriptor.value
    const elements = new Array<unknown>(length)
    const seenIndices = new Set<number>()
    for (const key of keys) {
      if (key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwCoveragePlanError(errorCode)
      if (typeof key === 'symbol') {
        if (descriptor.enumerable) throwCoveragePlanError(errorCode)
        continue
      }
      if (!descriptor.enumerable) continue
      const index = Number(key)
      if (
        !Number.isInteger(index) ||
        String(index) !== key ||
        index < 0 ||
        index >= length ||
        !('value' in descriptor) ||
        seenIndices.has(index)
      ) {
        throwCoveragePlanError(errorCode)
      }
      seenIndices.add(index)
      elements[index] = descriptor.value
    }
    if (seenIndices.size !== length) throwCoveragePlanError(errorCode)
    return elements
  } catch (error) {
    if (error instanceof RecoveryArchiveCoveragePlanError) throw error
    throwCoveragePlanError(errorCode)
  }
}

/**
 * Schema-boundary snapshot: exact enumerable own key set and ordinary data
 * descriptors only. All values are copied once from those descriptors before
 * validation or projection.
 */
function snapshotPlainRecordWithExactKeys(
  value: unknown,
  expected: readonly string[],
  errorCode: RecoveryArchiveCoveragePlanErrorCode,
): Record<string, unknown> {
  const snapshot = snapshotEnumerableDataRecord(value, errorCode)
  const keys = Object.keys(snapshot)
  if (keys.length !== expected.length) throwCoveragePlanError(errorCode)
  const expectedSet = new Set<string>(expected)
  if (!keys.every((key) => expectedSet.has(key))) throwCoveragePlanError(errorCode)
  return snapshot
}

function snapshotEnumerableDataRecord(
  value: unknown,
  errorCode: RecoveryArchiveCoveragePlanErrorCode,
): Record<string, unknown> {
  try {
    if (!isRecord(value)) throwCoveragePlanError(errorCode)
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throwCoveragePlanError(errorCode)
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined) throwCoveragePlanError(errorCode)
      if (!descriptor.enumerable) continue
      if (typeof key === 'symbol' || !('value' in descriptor)) throwCoveragePlanError(errorCode)
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof RecoveryArchiveCoveragePlanError) throw error
    throwCoveragePlanError(errorCode)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  try {
    return !Array.isArray(value)
  } catch {
    return false
  }
}

function throwCoveragePlanError(code: RecoveryArchiveCoveragePlanErrorCode): never {
  throw new RecoveryArchiveCoveragePlanError(code)
}

const utf8Encoder = new TextEncoder()
