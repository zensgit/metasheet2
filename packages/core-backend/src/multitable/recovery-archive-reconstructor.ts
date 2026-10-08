/**
 * Time Machine D4: single complete-section reconstruction authority.
 *
 * Reselects the retained checkpoint for the authenticated archive anchor,
 * replays floor-aware record history through reconstructRecordsAtSeq, overlays
 * the checkpoint baseline, then admits the archive records section as the
 * selected complete snapshot. Non-record sections come from that archive, never
 * from current live projections.
 */

import { composeBaselineOverlay, ExactAnchorHistoryDataError } from './exact-anchor-recovery'
import { selectCheckpointByAnchorSeq, SeqComparatorError } from './history-trust-checkpoint'
import type { QueryFn } from './permission-service'
import { RECOVERY_ARCHIVE_V1_SECTION_NAMES } from './recovery-archive-contract'
import type { RecoveryArchiveSectionName } from './recovery-archive-contract'
import { canonicalizeRecoveryArchiveJson } from './recovery-archive-manifest'
import type {
  RecoveryArchiveManifest,
  RecoveryArchiveRowEnvelope,
} from './recovery-archive-manifest'
import type {
  RecoveryArchiveOpenedSections,
  RecoveryArchiveOpenedSnapshot,
} from './recovery-archive-reader'
import { reconstructRecordsAtSeq } from './record-reconstructor'
import type { RecordStateAtT } from './record-reconstructor'

const INPUT_KEYS = ['openedArchive', 'query'] as const
const OPENED_KEYS = ['manifest', 'sections'] as const
const RECORD_PAYLOAD_KEYS = ['data', 'exists', 'record_id', 'version'] as const

export type RecoveryArchiveReconstructorErrorCode =
  | 'RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_RECONSTRUCTOR_NO_COVERING_CHECKPOINT'
  | 'RECOVERY_ARCHIVE_RECONSTRUCTOR_CHECKPOINT_MISMATCH'
  | 'RECOVERY_ARCHIVE_RECONSTRUCTOR_HISTORY_INCOMPLETE'
  | 'RECOVERY_ARCHIVE_RECONSTRUCTOR_OVERLAP_MISMATCH'
  | 'RECOVERY_ARCHIVE_RECONSTRUCTOR_ARCHIVE_INCOMPLETE'
  | 'RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID'

/** Values-free D4 reconstructor refusal. Message is the closed code; no identity or cause. */
export class RecoveryArchiveReconstructorError extends Error {
  readonly code: RecoveryArchiveReconstructorErrorCode

  constructor(code: RecoveryArchiveReconstructorErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveReconstructorError'
    this.code = code
  }
}

export interface RecoveryArchiveReconstructorInput {
  readonly query: QueryFn
  readonly openedArchive: RecoveryArchiveOpenedSnapshot
}

export interface RecoveryArchiveCompleteSectionState {
  readonly records: Map<string, RecordStateAtT>
  readonly schema: readonly RecoveryArchiveRowEnvelope[]
  readonly links: readonly RecoveryArchiveRowEnvelope[]
  readonly field_value_tombstones: readonly RecoveryArchiveRowEnvelope[]
  readonly link_tombstones: readonly RecoveryArchiveRowEnvelope[]
  readonly auto_number: readonly RecoveryArchiveRowEnvelope[]
  readonly attachments_index: readonly RecoveryArchiveRowEnvelope[]
  readonly permission_evidence: readonly RecoveryArchiveRowEnvelope[]
  readonly views_config: readonly RecoveryArchiveRowEnvelope[]
  readonly coverage_index: readonly RecoveryArchiveRowEnvelope[]
}

/**
 * Reconstruct one complete archive-selected section state at the manifest
 * exact decimal-string anchor. Overlapping hot/checkpoint records must equal
 * the archive snapshot; archive rows fill records no longer hot; a composed
 * record missing from the complete archive refuses.
 *
 * @internal This is the reconciliation half of the public D4 facade. It is
 * exported only for focused unit/real-DB evidence; production consumers are
 * mechanically restricted to readRecoveryArchiveCompleteSectionState.
 */
export async function reconstructRecoveryArchiveCompleteSectionsInternal(
  input: unknown,
): Promise<RecoveryArchiveCompleteSectionState> {
  const admitted = snapshotExactRecord(
    input,
    INPUT_KEYS,
    'RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT',
  )
  if (typeof admitted.query !== 'function') {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT')
  }
  const opened = admitOpenedArchive(admitted.openedArchive)
  const query = admitted.query as QueryFn
  const manifest = opened.manifest
  const archiveRecords = admitArchiveRecords(opened.sections.records)

  let checkpoint
  try {
    checkpoint = await selectCheckpointByAnchorSeq(query, manifest.sheet_id, manifest.anchor_seq)
  } catch (error) {
    mapHistoryError(error)
  }
  if (checkpoint === null) fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_NO_COVERING_CHECKPOINT')
  if (checkpoint.id !== manifest.checkpoint_id) {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_CHECKPOINT_MISMATCH')
  }

  let replayMap: Map<string, RecordStateAtT>
  try {
    replayMap = await reconstructRecordsAtSeq(
      query,
      manifest.sheet_id,
      manifest.anchor_seq,
      undefined,
      checkpoint.trustedSinceSeq,
      checkpoint.id,
    )
  } catch (error) {
    mapHistoryError(error)
  }

  let composed: Map<string, RecordStateAtT>
  try {
    composed = await composeBaselineOverlay(query, {
      sheetId: manifest.sheet_id,
      checkpointId: checkpoint.id,
      stateMap: replayMap,
    })
  } catch (error) {
    mapHistoryError(error)
  }

  const records = new Map<string, RecordStateAtT>()
  for (const [recordId, state] of composed) {
    const archived = archiveRecords.get(recordId)
    if (archived === undefined) fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_ARCHIVE_INCOMPLETE')
    if (!statesCanonicallyEqual(state, archived)) {
      fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_OVERLAP_MISMATCH')
    }
    records.set(recordId, freezeRecordState(state))
  }
  for (const [recordId, state] of archiveRecords) {
    if (!records.has(recordId)) records.set(recordId, freezeRecordState(state))
  }

  return Object.freeze({
    records,
    schema: copyRows(opened.sections.schema),
    links: copyRows(opened.sections.links),
    field_value_tombstones: copyRows(opened.sections.field_value_tombstones),
    link_tombstones: copyRows(opened.sections.link_tombstones),
    auto_number: copyRows(opened.sections.auto_number),
    attachments_index: copyRows(opened.sections.attachments_index),
    permission_evidence: copyRows(opened.sections.permission_evidence),
    views_config: copyRows(opened.sections.views_config),
    coverage_index: copyRows(opened.sections.coverage_index),
  })
}

function admitOpenedArchive(value: unknown): RecoveryArchiveOpenedSnapshot {
  const admitted = snapshotExactRecord(
    value,
    OPENED_KEYS,
    'RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT',
  )
  const manifest = admitted.manifest as RecoveryArchiveManifest
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    typeof manifest.sheet_id !== 'string' ||
    manifest.sheet_id.length === 0 ||
    typeof manifest.anchor_seq !== 'string' ||
    typeof manifest.checkpoint_id !== 'string' ||
    manifest.checkpoint_id.length === 0
  ) {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT')
  }
  const sections = snapshotExactRecord(
    admitted.sections,
    RECOVERY_ARCHIVE_V1_SECTION_NAMES,
    'RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT',
  )
  const frozenSections = Object.create(null) as Record<
    RecoveryArchiveSectionName,
    readonly RecoveryArchiveRowEnvelope[]
  >
  for (const name of RECOVERY_ARCHIVE_V1_SECTION_NAMES) {
    frozenSections[name] = copyRows(sections[name] as RecoveryArchiveRowEnvelope[])
  }
  return {
    manifest,
    sections: Object.freeze(frozenSections) as RecoveryArchiveOpenedSections,
  }
}

function admitArchiveRecords(
  rows: readonly RecoveryArchiveRowEnvelope[],
): Map<string, RecordStateAtT> {
  const records = new Map<string, RecordStateAtT>()
  if (!Array.isArray(rows)) fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
  for (const row of rows) {
    const state = admitArchiveRecord(row)
    if (records.has(state.recordId)) fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
    records.set(state.recordId, state)
  }
  return records
}

function admitArchiveRecord(row: unknown): RecordStateAtT {
  const envelope = snapshotExactRecord(
    row,
    ['entity_key', 'payload'],
    'RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID',
  )
  const payload = snapshotExactRecord(
    envelope.payload,
    RECORD_PAYLOAD_KEYS,
    'RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID',
  )
  const recordId = payload.record_id
  if (typeof recordId !== 'string' || recordId.length === 0) {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
  }
  if (envelope.entity_key !== `record/${recordId}`) {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
  }
  if (typeof payload.exists !== 'boolean') fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
  let version: number | null
  if (payload.version === null) {
    version = null
  } else if (
    typeof payload.version === 'number' &&
    Number.isSafeInteger(payload.version) &&
    payload.version >= 0
  ) {
    version = payload.version
  } else {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
  }
  if (payload.exists) {
    if (payload.data === null || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
    }
    return {
      recordId,
      exists: true,
      data: freezeJson(payload.data) as Record<string, unknown>,
      version,
    }
  }
  if (payload.data !== null) fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
  return { recordId, exists: false, data: null, version }
}

function statesCanonicallyEqual(left: RecordStateAtT, right: RecordStateAtT): boolean {
  try {
    return (
      canonicalizeRecoveryArchiveJson(recordPayload(left)) ===
      canonicalizeRecoveryArchiveJson(recordPayload(right))
    )
  } catch {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_OVERLAP_MISMATCH')
  }
}

function recordPayload(state: RecordStateAtT): Record<string, unknown> {
  return {
    data: state.data,
    exists: state.exists,
    record_id: state.recordId,
    version: state.version,
  }
}

function freezeRecordState(state: RecordStateAtT): RecordStateAtT {
  try {
    return Object.freeze({
      recordId: state.recordId,
      exists: state.exists,
      data: state.data === null ? null : (freezeJson(state.data) as Record<string, unknown>),
      version: state.version,
    })
  } catch (error) {
    if (error instanceof RecoveryArchiveReconstructorError) throw error
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_RECORDS_INVALID')
  }
}

function copyRows(rows: readonly RecoveryArchiveRowEnvelope[]): readonly RecoveryArchiveRowEnvelope[] {
  if (!Array.isArray(rows)) fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT')
  try {
    return Object.freeze(rows.map((row) => freezeJson(row) as RecoveryArchiveRowEnvelope))
  } catch (error) {
    if (error instanceof RecoveryArchiveReconstructorError) throw error
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT')
  }
}

function freezeJson(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeJson(item)))
  const snapshot: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    snapshot[key] = freezeJson((value as Record<string, unknown>)[key])
  }
  return Object.freeze(snapshot)
}

function mapHistoryError(error: unknown): never {
  if (error instanceof RecoveryArchiveReconstructorError) throw error
  if (error instanceof ExactAnchorHistoryDataError) {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_HISTORY_INCOMPLETE')
  }
  if (error instanceof SeqComparatorError) {
    fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_INVALID_INPUT')
  }
  fail('RECOVERY_ARCHIVE_RECONSTRUCTOR_HISTORY_INCOMPLETE')
}

function snapshotExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  errorCode: RecoveryArchiveReconstructorErrorCode,
): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(errorCode)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) fail(errorCode)
    const keys = Reflect.ownKeys(value)
    if (keys.length !== expectedKeys.length) fail(errorCode)
    const expected = new Set(expectedKeys)
    const snapshot: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      if (typeof key !== 'string' || !expected.has(key)) fail(errorCode)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        fail(errorCode)
      }
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch (error) {
    if (error instanceof RecoveryArchiveReconstructorError) throw error
    fail(errorCode)
  }
}

function fail(code: RecoveryArchiveReconstructorErrorCode): never {
  throw new RecoveryArchiveReconstructorError(code)
}
