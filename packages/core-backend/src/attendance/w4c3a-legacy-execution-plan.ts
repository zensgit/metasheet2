/**
 * W4C-3a phase 1 (#4556 / OD-W4C-56=(a), OD-W4C-57=(a)) — durable
 * LegacyImportExecutionPlanV1 schema types, exact-key parsers, canonical digests,
 * and fixed 500-row chunker.
 *
 * Authority:
 *  docs/development/attendance-issue-4556-w4c3a-durable-legacy-plan-amendment-20260729.md
 *  (sections 3, 4, 5.1, 6, 7, 8, 9);
 *  docs/development/attendance-issue-4556-w4c3a-byte-parity-field-amendment-20260730.md
 *  (OD-W4C-57=(a) exact union correction for batch source, record timezone,
 *  ensure_group displayName).
 *
 * Scope of this module:
 *  - closed unions and exact-key parsers for the V1 plan root, batch, items,
 *    record writes, group effects, artifact cleanup, terminal async summary, and
 *    frozen public-job envelope;
 *  - logical plan digest, chunk digest, chunk-vector digest, source-ordinal digest;
 *  - dense fixed-size chunking (LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK = 500);
 *  - zero target-only reconstruction (no daily-upsert fallback helpers).
 *
 * Not in this module: worker replay, plugin caller cutover, or lock acquisition.
 */
import crypto from 'node:crypto'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import {
  ATTENDANCE_ACCEPTED_WRITE_POSTURES_V1,
  ATTENDANCE_SOURCE_ENTRYPOINTS_V1,
  type AttendanceAcceptedWritePostureV1,
  type AttendanceSourceEntrypointV1,
} from './w4c0-identity'
import {
  ATTENDANCE_ACTOR_POSTURES_V1,
  type AttendanceActorPostureV1,
} from './w4c0-authorization'
import { W4_MAX_BATCH_ITEMS, W4_MAX_DISTINCT_TARGETS } from './w4c0-operation-contract'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One exported storage constant; changing it requires a storage-contract amendment. */
export const LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK = 500

export const LEGACY_IMPORT_PLAN_VERSION_V1 = 1 as const

export const ATTENDANCE_LEGACY_OPERATIONAL_BRANCHES_V1 = Object.freeze([
  'strict_targeted',
  'operational_only_idempotent_replay',
  'operational_only_no_target',
  'operational_only_batch_limit',
] as const)
export type AttendanceLegacyOperationalBranchV1 =
  (typeof ATTENDANCE_LEGACY_OPERATIONAL_BRANCHES_V1)[number]

export const ATTENDANCE_LEGACY_ROW_SOURCE_KINDS_V1 = Object.freeze([
  'uploaded_csv',
  'inline_csv',
  'direct_rows',
  'entries',
  'dingtalk_tabular',
] as const)
export type AttendanceLegacyRowSourceKindV1 =
  (typeof ATTENDANCE_LEGACY_ROW_SOURCE_KINDS_V1)[number]

export const ATTENDANCE_LEGACY_REPLAY_SELECTORS_V1 = Object.freeze([
  'precheck_hit',
  'locked_race',
] as const)
export type AttendanceLegacyReplaySelectorV1 =
  (typeof ATTENDANCE_LEGACY_REPLAY_SELECTORS_V1)[number]

export const ATTENDANCE_LEGACY_TERMINAL_RESPONSE_VARIANTS_V1 = Object.freeze([
  'first_execution',
  'idempotent_early',
  'idempotent_in_transaction',
] as const)
export type AttendanceLegacyTerminalResponseVariantV1 =
  (typeof ATTENDANCE_LEGACY_TERMINAL_RESPONSE_VARIANTS_V1)[number]

export const ATTENDANCE_LEGACY_IMPORT_ENGINES_V1 = Object.freeze([
  'standard',
  'bulk',
] as const)
export type AttendanceLegacyImportEngineV1 =
  (typeof ATTENDANCE_LEGACY_IMPORT_ENGINES_V1)[number]

export const ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1 = Object.freeze([
  'values',
  'unnest',
  'staging',
] as const)
export type AttendanceLegacyImportWriteStrategyV1 =
  (typeof ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1)[number]

export const ATTENDANCE_LEGACY_IMPORT_SKIP_REASON_CODES_V1 = Object.freeze([
  'validation',
  'duplicate',
] as const)
export type AttendanceLegacyImportSkipReasonCodeV1 =
  (typeof ATTENDANCE_LEGACY_IMPORT_SKIP_REASON_CODES_V1)[number]

export const ATTENDANCE_LEGACY_IMPORT_MERGE_MODES_V1 = Object.freeze([
  'merge',
  'override',
] as const)
export type AttendanceLegacyImportMergeModeV1 =
  (typeof ATTENDANCE_LEGACY_IMPORT_MERGE_MODES_V1)[number]

/**
 * Closed normal-batch source domain (OD-W4C-57=(a)). Null is a distinct digest
 * input; empty string is not a null surrogate.
 */
export const ATTENDANCE_LEGACY_IMPORT_BATCH_SOURCES_V1 = Object.freeze([
  'dingtalk',
  'manual',
  'dingtalk_csv',
  'dingtalk_api',
  'csv',
] as const)
export type AttendanceLegacyImportBatchSourceV1 =
  | (typeof ATTENDANCE_LEGACY_IMPORT_BATCH_SOURCES_V1)[number]
  | null

export const ATTENDANCE_LEGACY_PLAN_FAILURE_REASON_CODES_V1 = Object.freeze([
  'ATTENDANCE_IMPORT_LEGACY_PLAN_MISSING',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_CHUNK_MISSING',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_VERSION_UNSUPPORTED',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_IDENTITY_MISMATCH',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED',
  'ATTENDANCE_IMPORT_LEGACY_PLAN_PRECONDITION_CHANGED',
] as const)
export type AttendanceLegacyPlanFailureReasonCodeV1 =
  (typeof ATTENDANCE_LEGACY_PLAN_FAILURE_REASON_CODES_V1)[number]

const HEX64 = /^[0-9a-f]{64}$/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UTC_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const INT32_MAX = 2147483647

/** Canonical empty W4 item-sequence fingerprint (domain-separated empty array). */
export const ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1 = crypto
  .createHash('sha256')
  .update(
    Buffer.concat([
      Buffer.from('metasheet2:attendance:w4:item-sequence-fingerprint:v1', 'utf8'),
      Buffer.from([0]),
      Buffer.from('[]', 'utf8'),
    ]),
  )
  .digest('hex')

/** Canonical empty W4 item-set fingerprint (domain-separated empty array). */
export const ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1 = crypto
  .createHash('sha256')
  .update(
    Buffer.concat([
      Buffer.from('metasheet2:attendance:w4:item-set-fingerprint:v1', 'utf8'),
      Buffer.from([0]),
      Buffer.from('[]', 'utf8'),
    ]),
  )
  .digest('hex')

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AttendanceLegacyExecutionPlanError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceLegacyExecutionPlanError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceLegacyExecutionPlanError(code)
}

// ---------------------------------------------------------------------------
// Exact-key / scalar helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

function requireExactKeys(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!isPlainObject(value)) fail(code)
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length) fail(code)
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) fail(code)
  }
  return value
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code)
  return value
}

function requireNullableString(value: unknown, code: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') fail(code)
  return value
}

function requireDate(value: unknown, code: string): string {
  const text = requireString(value, code)
  if (!DATE_RE.test(text)) fail(code)
  const parsed = new Date(`${text}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail(code)
  return text
}

function requireNullableDate(value: unknown, code: string): string | null {
  if (value === null) return null
  return requireDate(value, code)
}

function requireNullableUtcInstant(value: unknown, code: string): string | null {
  if (value === null) return null
  const text = requireString(value, code)
  if (!UTC_INSTANT_RE.test(text)) fail(code)
  const parsed = new Date(text)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) fail(code)
  return text
}

function requireHex64(value: unknown, code: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) fail(code)
  return value
}

function requireUuid(value: unknown, code: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(code)
  return value.toLowerCase()
}

function requireNonNegInt(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > INT32_MAX) {
    fail(code)
  }
  return value
}

function requirePosInt(value: unknown, code: string): number {
  const n = requireNonNegInt(value, code)
  if (n < 1) fail(code)
  return n
}

function requireNonNegSafeInt(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(code)
  return value
}

function requirePosSafeInt(value: unknown, code: string): number {
  const valueInt = requireNonNegSafeInt(value, code)
  if (valueInt < 1) fail(code)
  return valueInt
}

function requireBool(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') fail(code)
  return value
}

function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(code)
  return value as T
}

/**
 * Opaque JSON leaf: canonicalizable, bounded, no prototype pollution, no
 * non-finite numbers. Bound by plan/chunk digests; never used as control input.
 */
export const LEGACY_PLAN_OPAQUE_LEAF_MAX_ENCODED_BYTES = 64 * 1024
export const LEGACY_PLAN_OPAQUE_LEAF_MAX_DEPTH = 8
export const LEGACY_PLAN_OPAQUE_LEAF_MAX_KEYS = 256
export const LEGACY_PLAN_OPAQUE_LEAF_MAX_ARRAY = 1024
export const LEGACY_PLAN_OPAQUE_LEAF_MAX_STRING = 16 * 1024

function parseOpaqueLeafValue(value: unknown, code: string, depth: number): unknown {
  if (depth > LEGACY_PLAN_OPAQUE_LEAF_MAX_DEPTH) fail(code)
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) fail(code)
      return value
    case 'string':
      if (Buffer.byteLength(value, 'utf8') > LEGACY_PLAN_OPAQUE_LEAF_MAX_STRING) fail(code)
      return value
    case 'object':
      break
    default:
      fail(code)
  }
  if (Array.isArray(value)) {
    if (value.length > LEGACY_PLAN_OPAQUE_LEAF_MAX_ARRAY) fail(code)
    return value.map((entry) => parseOpaqueLeafValue(entry, code, depth + 1))
  }
  if (!isPlainObject(value)) fail(code)
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code)
  const keys = Object.keys(value)
  if (keys.length > LEGACY_PLAN_OPAQUE_LEAF_MAX_KEYS) fail(code)
  const out: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail(code)
    out[key] = parseOpaqueLeafValue(value[key], code, depth + 1)
  }
  return out
}

function parseOpaqueLeaf(value: unknown, code: string): unknown {
  const parsed = parseOpaqueLeafValue(value, code, 0)
  const encoded = Buffer.byteLength(canonicalAttendanceJsonV1(parsed), 'utf8')
  if (encoded > LEGACY_PLAN_OPAQUE_LEAF_MAX_ENCODED_BYTES) fail(code)
  return freezeDeep(parsed)
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry)
    return Object.freeze(value)
  }
  if (Object.getPrototypeOf(value) !== null) Object.setPrototypeOf(value, null)
  for (const key of Object.keys(value as object)) {
    freezeDeep((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

// ---------------------------------------------------------------------------
// Closed child unions
// ---------------------------------------------------------------------------

export type LegacyImportArtifactCleanupV1 =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'uploaded_import_file'
      readonly fileId: string
      readonly expectedOwnerOrgId: string
    }

const ARTIFACT_CLEANUP_NONE_KEYS = ['kind'] as const
const ARTIFACT_CLEANUP_UPLOAD_KEYS = ['kind', 'fileId', 'expectedOwnerOrgId'] as const

export function parseLegacyImportArtifactCleanupV1(
  value: unknown,
): LegacyImportArtifactCleanupV1 {
  const code = 'W4C3A_ARTIFACT_CLEANUP_INVALID'
  if (!isPlainObject(value)) fail(code)
  const kind = value.kind
  if (kind === 'none') {
    requireExactKeys(value, ARTIFACT_CLEANUP_NONE_KEYS, code)
    return freezeDeep({ kind: 'none' as const })
  }
  if (kind === 'uploaded_import_file') {
    const obj = requireExactKeys(value, ARTIFACT_CLEANUP_UPLOAD_KEYS, code)
    return freezeDeep({
      kind: 'uploaded_import_file' as const,
      fileId: requireUuid(obj.fileId, code),
      expectedOwnerOrgId: requireString(obj.expectedOwnerOrgId, code),
    })
  }
  fail(code)
}

export type LegacyImportBatchPlanV1 =
  | {
      readonly kind: 'normal'
      readonly source: AttendanceLegacyImportBatchSourceV1
      readonly ruleSetId: string | null
      readonly mappingSnapshot: unknown
      readonly sourceRowCount: number
      readonly status: string
      readonly idempotencyKey: string | null
      readonly visibilityRule: string
      readonly engine: AttendanceLegacyImportEngineV1
      readonly chunkConfig: unknown
      readonly recordUpsertStrategy: AttendanceLegacyImportWriteStrategyV1
      readonly itemsInsertStrategy: AttendanceLegacyImportWriteStrategyV1
      readonly mappingProfileId: string | null
      readonly compatibilityMetadata: unknown
      readonly groupSync: unknown
      readonly itemReturnPolicy: unknown
      readonly skippedSamplePolicy: unknown
      readonly resultSlots: unknown
    }
  | {
      readonly kind: 'idempotent_replay'
      readonly replayBatchId: string
      readonly replaySelector: AttendanceLegacyReplaySelectorV1
      readonly replayPreconditionDigest: string
      readonly importedCount: number
      readonly skippedCount: number
      readonly totalRowCount: number
      readonly engine: AttendanceLegacyImportEngineV1
      readonly recordUpsertStrategy: AttendanceLegacyImportWriteStrategyV1
      readonly metadata: unknown
      readonly idempotencyKey: string
      readonly requesterVisibility: Readonly<{ readonly kind: 'org' }>
    }

const BATCH_NORMAL_KEYS = [
  'kind',
  'source',
  'ruleSetId',
  'mappingSnapshot',
  'sourceRowCount',
  'status',
  'idempotencyKey',
  'visibilityRule',
  'engine',
  'chunkConfig',
  'recordUpsertStrategy',
  'itemsInsertStrategy',
  'mappingProfileId',
  'compatibilityMetadata',
  'groupSync',
  'itemReturnPolicy',
  'skippedSamplePolicy',
  'resultSlots',
] as const

const BATCH_REPLAY_KEYS = [
  'kind',
  'replayBatchId',
  'replaySelector',
  'replayPreconditionDigest',
  'importedCount',
  'skippedCount',
  'totalRowCount',
  'engine',
  'recordUpsertStrategy',
  'metadata',
  'idempotencyKey',
  'requesterVisibility',
] as const

function requireNullableBatchSource(
  value: unknown,
  code: string,
): AttendanceLegacyImportBatchSourceV1 {
  if (value === null) return null
  return requireOneOf(value, ATTENDANCE_LEGACY_IMPORT_BATCH_SOURCES_V1, code)
}

export function parseLegacyImportBatchPlanV1(value: unknown): LegacyImportBatchPlanV1 {
  const code = 'W4C3A_BATCH_PLAN_INVALID'
  if (!isPlainObject(value)) fail(code)
  if (value.kind === 'normal') {
    const obj = requireExactKeys(value, BATCH_NORMAL_KEYS, code)
    return freezeDeep({
      kind: 'normal' as const,
      source: requireNullableBatchSource(obj.source, code),
      ruleSetId: requireNullableString(obj.ruleSetId, code),
      mappingSnapshot: parseOpaqueLeaf(obj.mappingSnapshot, code),
      sourceRowCount: requireNonNegInt(obj.sourceRowCount, code),
      status: requireString(obj.status, code),
      idempotencyKey: requireNullableString(obj.idempotencyKey, code),
      visibilityRule: requireString(obj.visibilityRule, code),
      engine: requireOneOf(obj.engine, ATTENDANCE_LEGACY_IMPORT_ENGINES_V1, code),
      chunkConfig: parseOpaqueLeaf(obj.chunkConfig, code),
      recordUpsertStrategy: requireOneOf(
        obj.recordUpsertStrategy,
        ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1,
        code,
      ),
      itemsInsertStrategy: requireOneOf(
        obj.itemsInsertStrategy,
        ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1,
        code,
      ),
      mappingProfileId: requireNullableString(obj.mappingProfileId, code),
      compatibilityMetadata: parseOpaqueLeaf(obj.compatibilityMetadata, code),
      groupSync: parseOpaqueLeaf(obj.groupSync, code),
      itemReturnPolicy: parseOpaqueLeaf(obj.itemReturnPolicy, code),
      skippedSamplePolicy: parseOpaqueLeaf(obj.skippedSamplePolicy, code),
      resultSlots: parseOpaqueLeaf(obj.resultSlots, code),
    })
  }
  if (value.kind === 'idempotent_replay') {
    const obj = requireExactKeys(value, BATCH_REPLAY_KEYS, code)
    const totalRowCount = requirePosInt(obj.totalRowCount, code)
    const importedCount = requireNonNegInt(obj.importedCount, code)
    const skippedCount = requireNonNegInt(obj.skippedCount, code)
    if (importedCount + skippedCount !== totalRowCount) fail(code)
    return freezeDeep({
      kind: 'idempotent_replay' as const,
      replayBatchId: requireUuid(obj.replayBatchId, code),
      replaySelector: requireOneOf(obj.replaySelector, ATTENDANCE_LEGACY_REPLAY_SELECTORS_V1, code),
      replayPreconditionDigest: requireHex64(obj.replayPreconditionDigest, code),
      importedCount,
      skippedCount,
      totalRowCount,
      engine: requireOneOf(obj.engine, ATTENDANCE_LEGACY_IMPORT_ENGINES_V1, code),
      recordUpsertStrategy: requireOneOf(
        obj.recordUpsertStrategy,
        ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1,
        code,
      ),
      metadata: parseOpaqueLeaf(obj.metadata, code),
      idempotencyKey: requireString(obj.idempotencyKey, code),
      requesterVisibility: (() => {
        if (!isPlainObject(obj.requesterVisibility)) fail(code)
        const visibility = requireExactKeys(
          obj.requesterVisibility,
          ['kind'] as const,
          code,
        )
        if (visibility.kind !== 'org') fail(code)
        return freezeDeep({ kind: 'org' as const })
      })(),
    })
  }
  fail(code)
}

export type LegacyImportItemPlanV1 =
  | {
      readonly kind: 'apply'
      readonly ordinal: number
      readonly semanticOrdinal: number
      readonly itemId: string
      readonly targetRef: string
      readonly previewSnapshot: unknown
      readonly recordWriteRef: string
    }
  | {
      readonly kind: 'skip'
      readonly ordinal: number
      readonly semanticOrdinal: null
      readonly itemId: string
      readonly resolvedUserId: string | null
      readonly resolvedWorkDate: string | null
      readonly reasonCode: AttendanceLegacyImportSkipReasonCodeV1
      readonly warnings: readonly unknown[]
      readonly previewSnapshot: unknown
    }

const ITEM_APPLY_KEYS = [
  'kind',
  'ordinal',
  'semanticOrdinal',
  'itemId',
  'targetRef',
  'previewSnapshot',
  'recordWriteRef',
] as const

const ITEM_SKIP_KEYS = [
  'kind',
  'ordinal',
  'semanticOrdinal',
  'itemId',
  'resolvedUserId',
  'resolvedWorkDate',
  'reasonCode',
  'warnings',
  'previewSnapshot',
] as const

export function parseLegacyImportItemPlanV1(value: unknown): LegacyImportItemPlanV1 {
  const code = 'W4C3A_ITEM_PLAN_INVALID'
  if (!isPlainObject(value)) fail(code)
  if (value.kind === 'apply') {
    const obj = requireExactKeys(value, ITEM_APPLY_KEYS, code)
    return freezeDeep({
      kind: 'apply' as const,
      ordinal: requireNonNegInt(obj.ordinal, code),
      semanticOrdinal: requireNonNegInt(obj.semanticOrdinal, code),
      itemId: requireUuid(obj.itemId, code),
      targetRef: requireString(obj.targetRef, code),
      previewSnapshot: parseOpaqueLeaf(obj.previewSnapshot, code),
      recordWriteRef: requireString(obj.recordWriteRef, code),
    })
  }
  if (value.kind === 'skip') {
    const obj = requireExactKeys(value, ITEM_SKIP_KEYS, code)
    if (obj.semanticOrdinal !== null) fail(code)
    if (!Array.isArray(obj.warnings)) fail(code)
    const warnings = parseOpaqueLeaf(obj.warnings, code)
    if (!Array.isArray(warnings)) fail(code)
    return freezeDeep({
      kind: 'skip' as const,
      ordinal: requireNonNegInt(obj.ordinal, code),
      semanticOrdinal: null,
      itemId: requireUuid(obj.itemId, code),
      resolvedUserId: requireNullableString(obj.resolvedUserId, code),
      resolvedWorkDate: requireNullableDate(obj.resolvedWorkDate, code),
      reasonCode: requireOneOf(
        obj.reasonCode,
        ATTENDANCE_LEGACY_IMPORT_SKIP_REASON_CODES_V1,
        code,
      ),
      warnings,
      previewSnapshot: parseOpaqueLeaf(obj.previewSnapshot, code),
    })
  }
  fail(code)
}

export type LegacyImportRecordWritePlanV1 = {
  readonly recordWriteId: string
  readonly orgId: string
  readonly userId: string
  readonly workDate: string
  readonly sourceOrdinals: readonly number[]
  readonly mergeMode: AttendanceLegacyImportMergeModeV1
  readonly firstInAt: string | null
  readonly lastOutAt: string | null
  readonly workMinutes: number | null
  readonly lateMinutes: number | null
  readonly earlyLeaveMinutes: number | null
  readonly status: string | null
  readonly isWorkday: boolean | null
  /** Exact resolved timezone frozen at prepare time (OD-W4C-57=(a)). */
  readonly timezone: string
  readonly targetRevision: number
  readonly existingRecordPreconditionFingerprint: string
  readonly expectedSourceOwnership: string | null
  readonly recordId: string
  readonly compatibilityMetadata: unknown
  readonly policySnapshot: unknown
  readonly profileSnapshot: unknown
  readonly multiPunchSnapshot: unknown
  readonly attributionSnapshot: unknown
  readonly sourceBatchId: string
  readonly resultSlots: unknown
}

export type LegacyImportRecordPreconditionV1 = Readonly<{
  readonly exists: boolean
  readonly id: string | null
  readonly orgId: string | null
  readonly userId: string | null
  readonly workDate: string | null
  readonly firstInAt: string | null
  readonly lastOutAt: string | null
  readonly workMinutes: number | null
  readonly lateMinutes: number | null
  readonly earlyLeaveMinutes: number | null
  readonly status: string | null
  readonly isWorkday: boolean | null
  readonly meta: unknown
  readonly sourceBatchId: string | null
}>

const RECORD_PRECONDITION_KEYS = [
  'exists',
  'id',
  'orgId',
  'userId',
  'workDate',
  'firstInAt',
  'lastOutAt',
  'workMinutes',
  'lateMinutes',
  'earlyLeaveMinutes',
  'status',
  'isWorkday',
  'meta',
  'sourceBatchId',
] as const

export function parseLegacyImportRecordPreconditionV1(
  value: unknown,
): LegacyImportRecordPreconditionV1 {
  const code = 'W4C3A_RECORD_PRECONDITION_INVALID'
  const obj = requireExactKeys(value, RECORD_PRECONDITION_KEYS, code)
  const exists = requireBool(obj.exists, code)
  if (!exists) {
    for (const key of RECORD_PRECONDITION_KEYS) {
      if (key !== 'exists' && obj[key] !== null) fail(code)
    }
    return freezeDeep({
      exists: false,
      id: null,
      orgId: null,
      userId: null,
      workDate: null,
      firstInAt: null,
      lastOutAt: null,
      workMinutes: null,
      lateMinutes: null,
      earlyLeaveMinutes: null,
      status: null,
      isWorkday: null,
      meta: null,
      sourceBatchId: null,
    })
  }
  return freezeDeep({
    exists: true,
    id: requireUuid(obj.id, code),
    orgId: requireString(obj.orgId, code),
    userId: requireString(obj.userId, code),
    workDate: requireDate(obj.workDate, code),
    firstInAt: requireNullableUtcInstant(obj.firstInAt, code),
    lastOutAt: requireNullableUtcInstant(obj.lastOutAt, code),
    workMinutes:
      obj.workMinutes === null ? null : requireNonNegInt(obj.workMinutes, code),
    lateMinutes:
      obj.lateMinutes === null ? null : requireNonNegInt(obj.lateMinutes, code),
    earlyLeaveMinutes:
      obj.earlyLeaveMinutes === null
        ? null
        : requireNonNegInt(obj.earlyLeaveMinutes, code),
    status: requireNullableString(obj.status, code),
    isWorkday: obj.isWorkday === null ? null : requireBool(obj.isWorkday, code),
    meta: parseOpaqueLeaf(obj.meta, code),
    sourceBatchId:
      obj.sourceBatchId === null ? null : requireUuid(obj.sourceBatchId, code),
  })
}

const RECORD_WRITE_KEYS = [
  'recordWriteId',
  'orgId',
  'userId',
  'workDate',
  'sourceOrdinals',
  'mergeMode',
  'firstInAt',
  'lastOutAt',
  'workMinutes',
  'lateMinutes',
  'earlyLeaveMinutes',
  'status',
  'isWorkday',
  'timezone',
  'targetRevision',
  'existingRecordPreconditionFingerprint',
  'expectedSourceOwnership',
  'recordId',
  'compatibilityMetadata',
  'policySnapshot',
  'profileSnapshot',
  'multiPunchSnapshot',
  'attributionSnapshot',
  'sourceBatchId',
  'resultSlots',
] as const

export function parseLegacyImportRecordWritePlanV1(
  value: unknown,
): LegacyImportRecordWritePlanV1 {
  const code = 'W4C3A_RECORD_WRITE_PLAN_INVALID'
  const obj = requireExactKeys(value, RECORD_WRITE_KEYS, code)
  if (!Array.isArray(obj.sourceOrdinals) || obj.sourceOrdinals.length < 1) fail(code)
  const sourceOrdinals = obj.sourceOrdinals.map((n) => requireNonNegInt(n, code))
  return freezeDeep({
    recordWriteId: requireUuid(obj.recordWriteId, code),
    orgId: requireString(obj.orgId, code),
    userId: requireString(obj.userId, code),
    workDate: requireDate(obj.workDate, code),
    sourceOrdinals: Object.freeze(sourceOrdinals),
    mergeMode: requireOneOf(
      obj.mergeMode,
      ATTENDANCE_LEGACY_IMPORT_MERGE_MODES_V1,
      code,
    ),
    firstInAt: requireNullableUtcInstant(obj.firstInAt, code),
    lastOutAt: requireNullableUtcInstant(obj.lastOutAt, code),
    workMinutes:
      obj.workMinutes === null ? null : requireNonNegInt(obj.workMinutes, code),
    lateMinutes:
      obj.lateMinutes === null ? null : requireNonNegInt(obj.lateMinutes, code),
    earlyLeaveMinutes:
      obj.earlyLeaveMinutes === null
        ? null
        : requireNonNegInt(obj.earlyLeaveMinutes, code),
    status: requireNullableString(obj.status, code),
    isWorkday: obj.isWorkday === null ? null : requireBool(obj.isWorkday, code),
    timezone: requireString(obj.timezone, code),
    targetRevision: requireNonNegSafeInt(obj.targetRevision, code),
    existingRecordPreconditionFingerprint: requireHex64(
      obj.existingRecordPreconditionFingerprint,
      code,
    ),
    expectedSourceOwnership: requireNullableString(obj.expectedSourceOwnership, code),
    recordId: requireUuid(obj.recordId, code),
    compatibilityMetadata: parseOpaqueLeaf(obj.compatibilityMetadata, code),
    policySnapshot: parseOpaqueLeaf(obj.policySnapshot, code),
    profileSnapshot: parseOpaqueLeaf(obj.profileSnapshot, code),
    multiPunchSnapshot: parseOpaqueLeaf(obj.multiPunchSnapshot, code),
    attributionSnapshot: parseOpaqueLeaf(obj.attributionSnapshot, code),
    sourceBatchId: requireUuid(obj.sourceBatchId, code),
    resultSlots: parseOpaqueLeaf(obj.resultSlots, code),
  })
}

export type LegacyImportGroupEffectPlanV1 =
  | {
      readonly kind: 'ensure_group'
      readonly groupId: string
      readonly normalizedName: string
      /**
       * Exact non-empty trimmed display name written to attendance_groups.name.
       * Must satisfy displayName.trim() === displayName,
       * displayName.toLowerCase() === normalizedName, and not match /^\d+$/
       * (OD-W4C-57=(a)). Never replaced by normalizedName at parse time.
       */
      readonly displayName: string
      readonly code: string | null
      readonly timezone: string
      readonly ruleSetId: string | null
    }
  | {
      readonly kind: 'ensure_member'
      readonly memberId: string
      readonly groupRef: string
      readonly userId: string
    }

const GROUP_ENSURE_KEYS = [
  'kind',
  'groupId',
  'normalizedName',
  'displayName',
  'code',
  'timezone',
  'ruleSetId',
] as const
const MEMBER_ENSURE_KEYS = ['kind', 'memberId', 'groupRef', 'userId'] as const
const NUMERIC_ONLY_GROUP_NAME_RE = /^\d+$/

export function parseLegacyImportGroupEffectPlanV1(
  value: unknown,
): LegacyImportGroupEffectPlanV1 {
  const code = 'W4C3A_GROUP_EFFECT_PLAN_INVALID'
  if (!isPlainObject(value)) fail(code)
  if (value.kind === 'ensure_group') {
    const obj = requireExactKeys(value, GROUP_ENSURE_KEYS, code)
    const normalizedName = requireString(obj.normalizedName, code)
    if (
      normalizedName !== normalizedName.trim().toLowerCase() ||
      normalizedName.length === 0
    ) {
      fail(code)
    }
    const displayName = requireString(obj.displayName, code)
    if (
      displayName.trim() !== displayName ||
      displayName.toLowerCase() !== normalizedName ||
      NUMERIC_ONLY_GROUP_NAME_RE.test(displayName)
    ) {
      fail(code)
    }
    return freezeDeep({
      kind: 'ensure_group' as const,
      groupId: requireUuid(obj.groupId, code),
      normalizedName,
      displayName,
      code: requireNullableString(obj.code, code),
      timezone: requireString(obj.timezone, code),
      ruleSetId:
        obj.ruleSetId === null ? null : requireUuid(obj.ruleSetId, code),
    })
  }
  if (value.kind === 'ensure_member') {
    const obj = requireExactKeys(value, MEMBER_ENSURE_KEYS, code)
    return freezeDeep({
      kind: 'ensure_member' as const,
      memberId: requireUuid(obj.memberId, code),
      groupRef: requireString(obj.groupRef, code),
      userId: requireString(obj.userId, code),
    })
  }
  fail(code)
}

// ---------------------------------------------------------------------------
// Root manifest + chunk
// ---------------------------------------------------------------------------

export type LegacyImportExecutionPlanManifestV1 = {
  readonly schemaVersion: 1
  readonly orgId: string
  readonly jobId: string
  readonly batchId: string
  readonly sourceKind: AttendanceSourceEntrypointV1
  readonly sourceRef: string
  readonly createdBy: string
  readonly actorId: string
  readonly actorPosture: AttendanceActorPostureV1
  readonly tokenSubjectUserId: string | null
  readonly acceptedWritePosture: AttendanceAcceptedWritePostureV1
  readonly identityProofVectorDigest: string
  readonly commandFingerprint: string
  readonly legacyInputFingerprint: string
  readonly operationalBranch: AttendanceLegacyOperationalBranchV1
  readonly legacyRowSourceKind: AttendanceLegacyRowSourceKindV1 | null
  readonly sourceRowCount: number
  readonly sourceOrdinalDigest: string
  readonly w4ItemCount: number
  readonly w4DistinctTargetCount: number
  readonly w4ItemSequenceFingerprint: string
  readonly w4ItemSetFingerprint: string
  readonly legacySourceRowLimit: number | null
  readonly groupRevision: number | null
  readonly groupStateFingerprint: string | null
  readonly chunkVectorDigest: string
  readonly batch: LegacyImportBatchPlanV1
  readonly artifactCleanup: LegacyImportArtifactCleanupV1
}

/** Exact root key set from amendment section 4.1 (no planDigest, no effect arrays). */
export const LEGACY_IMPORT_PLAN_MANIFEST_KEYS_V1 = [
  'schemaVersion',
  'orgId',
  'jobId',
  'batchId',
  'sourceKind',
  'sourceRef',
  'createdBy',
  'actorId',
  'actorPosture',
  'tokenSubjectUserId',
  'acceptedWritePosture',
  'identityProofVectorDigest',
  'commandFingerprint',
  'legacyInputFingerprint',
  'operationalBranch',
  'legacyRowSourceKind',
  'sourceRowCount',
  'sourceOrdinalDigest',
  'w4ItemCount',
  'w4DistinctTargetCount',
  'w4ItemSequenceFingerprint',
  'w4ItemSetFingerprint',
  'legacySourceRowLimit',
  'groupRevision',
  'groupStateFingerprint',
  'chunkVectorDigest',
  'batch',
  'artifactCleanup',
] as const

export type LegacyImportExecutionPlanChunkBodyV1 = {
  readonly items: readonly LegacyImportItemPlanV1[]
  readonly recordWrites: readonly LegacyImportRecordWritePlanV1[]
  readonly groupEffects: readonly LegacyImportGroupEffectPlanV1[]
}

export type LegacyImportExecutionPlanChunkV1 = {
  readonly chunkIndex: number
  readonly firstSourceOrdinal: number
  readonly sourceRowCount: number
  readonly chunkDigest: string
  readonly body: LegacyImportExecutionPlanChunkBodyV1
}

const CHUNK_BODY_KEYS = ['items', 'recordWrites', 'groupEffects'] as const

export function parseLegacyImportExecutionPlanChunkBodyV1(
  value: unknown,
): LegacyImportExecutionPlanChunkBodyV1 {
  const code = 'W4C3A_CHUNK_BODY_INVALID'
  const obj = requireExactKeys(value, CHUNK_BODY_KEYS, code)
  if (!Array.isArray(obj.items) || !Array.isArray(obj.recordWrites) || !Array.isArray(obj.groupEffects)) {
    fail(code)
  }
  return freezeDeep({
    items: Object.freeze(obj.items.map(parseLegacyImportItemPlanV1)),
    recordWrites: Object.freeze(obj.recordWrites.map(parseLegacyImportRecordWritePlanV1)),
    groupEffects: Object.freeze(obj.groupEffects.map(parseLegacyImportGroupEffectPlanV1)),
  })
}

export function parseLegacyImportExecutionPlanManifestV1(
  value: unknown,
): LegacyImportExecutionPlanManifestV1 {
  const code = 'W4C3A_MANIFEST_INVALID'
  const obj = requireExactKeys(value, LEGACY_IMPORT_PLAN_MANIFEST_KEYS_V1, code)
  if (obj.schemaVersion !== 1) fail('W4C3A_PLAN_VERSION_UNSUPPORTED')
  const orgId = requireString(obj.orgId, code)

  const operationalBranch = requireOneOf(
    obj.operationalBranch,
    ATTENDANCE_LEGACY_OPERATIONAL_BRANCHES_V1,
    code,
  )
  const legacyRowSourceKind =
    obj.legacyRowSourceKind === null
      ? null
      : requireOneOf(obj.legacyRowSourceKind, ATTENDANCE_LEGACY_ROW_SOURCE_KINDS_V1, code)
  const legacySourceRowLimit =
    obj.legacySourceRowLimit === null
      ? null
      : requirePosSafeInt(obj.legacySourceRowLimit, code)
  const groupRevision =
    obj.groupRevision === null ? null : requireNonNegSafeInt(obj.groupRevision, code)
  const groupStateFingerprint =
    obj.groupStateFingerprint === null
      ? null
      : requireHex64(obj.groupStateFingerprint, code)

  if ((groupRevision === null) !== (groupStateFingerprint === null)) fail(code)

  const csvKinds: readonly string[] = ['uploaded_csv', 'inline_csv']
  if (legacyRowSourceKind !== null && csvKinds.includes(legacyRowSourceKind)) {
    if (legacySourceRowLimit === null) fail(code)
  } else if (legacySourceRowLimit !== null) {
    // A frozen source-row limit belongs only to a selected CSV source. This
    // also rejects a no-source precheck replay carrying an invented limit.
    fail(code)
  }

  const batch = parseLegacyImportBatchPlanV1(obj.batch)
  const artifactCleanup = parseLegacyImportArtifactCleanupV1(obj.artifactCleanup)
  if (
    artifactCleanup.kind === 'uploaded_import_file' &&
    artifactCleanup.expectedOwnerOrgId !== orgId
  ) {
    fail(code)
  }

  if (operationalBranch === 'operational_only_idempotent_replay') {
    if (batch.kind !== 'idempotent_replay') fail(code)
    if (batch.replaySelector === 'precheck_hit') {
      if (legacyRowSourceKind !== null) fail(code)
      if (artifactCleanup.kind !== 'none') fail(code)
    } else {
      if (legacyRowSourceKind === null) fail(code)
      if (
        artifactCleanup.kind === 'uploaded_import_file' &&
        legacyRowSourceKind !== 'uploaded_csv'
      ) {
        fail(code)
      }
      if (
        artifactCleanup.kind === 'none' &&
        legacyRowSourceKind === 'uploaded_csv'
      ) {
        fail(code)
      }
    }
  } else if (batch.kind !== 'normal') {
    fail(code)
  }

  const sourceRowCount = requireNonNegInt(obj.sourceRowCount, code)
  const w4ItemCount = requireNonNegInt(obj.w4ItemCount, code)
  const w4DistinctTargetCount = requireNonNegInt(obj.w4DistinctTargetCount, code)
  if (w4DistinctTargetCount > w4ItemCount) fail(code)
  if (w4ItemCount > sourceRowCount) fail(code)

  if (operationalBranch === 'operational_only_idempotent_replay') {
    if (sourceRowCount !== 0 || w4ItemCount !== 0 || w4DistinctTargetCount !== 0) fail(code)
    if (
      obj.w4ItemSequenceFingerprint !== ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1 ||
      obj.w4ItemSetFingerprint !== ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1
    ) {
      fail(code)
    }
  } else if (sourceRowCount < 1) {
    fail(code)
  }
  if (batch.kind === 'normal' && batch.sourceRowCount !== sourceRowCount) {
    fail(code)
  }

  if (operationalBranch === 'operational_only_no_target') {
    if (w4ItemCount !== 0 || w4DistinctTargetCount !== 0) fail(code)
    if (
      obj.w4ItemSequenceFingerprint !== ATTENDANCE_W4_EMPTY_ITEM_SEQUENCE_FINGERPRINT_V1 ||
      obj.w4ItemSetFingerprint !== ATTENDANCE_W4_EMPTY_ITEM_SET_FINGERPRINT_V1
    ) {
      fail(code)
    }
  }
  if (operationalBranch === 'strict_targeted') {
    if (w4ItemCount < 1 || w4ItemCount > W4_MAX_BATCH_ITEMS) fail(code)
    if (
      w4DistinctTargetCount < 1 ||
      w4DistinctTargetCount > W4_MAX_DISTINCT_TARGETS
    ) {
      fail(code)
    }
  }
  if (operationalBranch === 'operational_only_batch_limit') {
    if (w4ItemCount < 1) fail(code)
    if (
      !(
        w4ItemCount > W4_MAX_BATCH_ITEMS ||
        w4DistinctTargetCount > W4_MAX_DISTINCT_TARGETS
      )
    ) {
      fail(code)
    }
    const posture = requireOneOf(
      obj.acceptedWritePosture,
      ATTENDANCE_ACCEPTED_WRITE_POSTURES_V1,
      code,
    )
    if (posture !== 'legacy_projection_only' && posture !== 'shadow') fail(code)
  }

  if (
    legacySourceRowLimit !== null &&
    legacyRowSourceKind !== null &&
    csvKinds.includes(legacyRowSourceKind) &&
    sourceRowCount > legacySourceRowLimit
  ) {
    fail(code)
  }

  return freezeDeep({
    schemaVersion: 1 as const,
    orgId,
    jobId: requireUuid(obj.jobId, code),
    batchId: requireUuid(obj.batchId, code),
    sourceKind: (() => {
      const sourceKind = requireOneOf(
        obj.sourceKind,
        ATTENDANCE_SOURCE_ENTRYPOINTS_V1,
        code,
      )
      if (sourceKind !== 'import_batch') fail(code)
      return sourceKind
    })(),
    sourceRef: requireString(obj.sourceRef, code),
    createdBy: requireString(obj.createdBy, code),
    actorId: requireString(obj.actorId, code),
    actorPosture: requireOneOf(obj.actorPosture, ATTENDANCE_ACTOR_POSTURES_V1, code),
    tokenSubjectUserId: requireNullableString(obj.tokenSubjectUserId, code),
    acceptedWritePosture: requireOneOf(
      obj.acceptedWritePosture,
      ATTENDANCE_ACCEPTED_WRITE_POSTURES_V1,
      code,
    ),
    identityProofVectorDigest: requireHex64(obj.identityProofVectorDigest, code),
    commandFingerprint: requireHex64(obj.commandFingerprint, code),
    legacyInputFingerprint: requireHex64(obj.legacyInputFingerprint, code),
    operationalBranch,
    legacyRowSourceKind,
    sourceRowCount,
    sourceOrdinalDigest: requireHex64(obj.sourceOrdinalDigest, code),
    w4ItemCount,
    w4DistinctTargetCount,
    w4ItemSequenceFingerprint: requireHex64(obj.w4ItemSequenceFingerprint, code),
    w4ItemSetFingerprint: requireHex64(obj.w4ItemSetFingerprint, code),
    legacySourceRowLimit,
    groupRevision,
    groupStateFingerprint,
    chunkVectorDigest: requireHex64(obj.chunkVectorDigest, code),
    batch,
    artifactCleanup,
  })
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export function sha256HexOfCanonicalJsonV1(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(canonicalAttendanceJsonV1(value), 'utf8')
    .digest('hex')
}

export function computeLegacyImportChunkDigestV1(
  body: LegacyImportExecutionPlanChunkBodyV1,
): string {
  return sha256HexOfCanonicalJsonV1({
    items: body.items,
    recordWrites: body.recordWrites,
    groupEffects: body.groupEffects,
  })
}

export type LegacyImportChunkDescriptorV1 = {
  readonly chunkIndex: number
  readonly firstSourceOrdinal: number
  readonly sourceRowCount: number
  readonly chunkDigest: string
}

export function computeLegacyImportChunkVectorDigestV1(
  descriptors: readonly LegacyImportChunkDescriptorV1[],
): string {
  return sha256HexOfCanonicalJsonV1(
    descriptors.map((d) => ({
      chunkIndex: d.chunkIndex,
      firstSourceOrdinal: d.firstSourceOrdinal,
      sourceRowCount: d.sourceRowCount,
      chunkDigest: d.chunkDigest,
    })),
  )
}

/**
 * sourceOrdinalDigest binds every source ordinal disposition (snapshots/warnings
 * intentionally excluded — covered by planDigest).
 */
export function computeLegacyImportSourceOrdinalDigestV1(
  items: readonly LegacyImportItemPlanV1[],
): string {
  return sha256HexOfCanonicalJsonV1(
    items.map((item) => {
      if (item.kind === 'apply') {
        return {
          ordinal: item.ordinal,
          semanticOrdinal: item.semanticOrdinal,
          kind: item.kind,
          itemId: item.itemId,
          resolvedUserId: null,
          resolvedWorkDate: null,
          targetRef: item.targetRef,
          recordWriteRef: item.recordWriteRef,
          reasonCode: null,
        }
      }
      return {
        ordinal: item.ordinal,
        semanticOrdinal: null,
        kind: item.kind,
        itemId: item.itemId,
        resolvedUserId: item.resolvedUserId,
        resolvedWorkDate: item.resolvedWorkDate,
        targetRef: null,
        recordWriteRef: null,
        reasonCode: item.reasonCode,
      }
    }),
  )
}

/**
 * Logical plan stream is independent of physical chunk boundaries (section 4.1).
 * Includes all items/recordWrites/groupEffects in their canonical orders.
 */
export function computeLegacyImportPlanDigestV1(input: {
  readonly manifest: LegacyImportExecutionPlanManifestV1
  readonly items: readonly LegacyImportItemPlanV1[]
  readonly recordWrites: readonly LegacyImportRecordWritePlanV1[]
  readonly groupEffects: readonly LegacyImportGroupEffectPlanV1[]
}): string {
  const m = input.manifest
  return sha256HexOfCanonicalJsonV1({
    schemaVersion: m.schemaVersion,
    orgId: m.orgId,
    jobId: m.jobId,
    batchId: m.batchId,
    sourceKind: m.sourceKind,
    sourceRef: m.sourceRef,
    createdBy: m.createdBy,
    actorId: m.actorId,
    actorPosture: m.actorPosture,
    tokenSubjectUserId: m.tokenSubjectUserId,
    acceptedWritePosture: m.acceptedWritePosture,
    identityProofVectorDigest: m.identityProofVectorDigest,
    commandFingerprint: m.commandFingerprint,
    legacyInputFingerprint: m.legacyInputFingerprint,
    operationalBranch: m.operationalBranch,
    legacyRowSourceKind: m.legacyRowSourceKind,
    sourceRowCount: m.sourceRowCount,
    sourceOrdinalDigest: m.sourceOrdinalDigest,
    w4ItemCount: m.w4ItemCount,
    w4DistinctTargetCount: m.w4DistinctTargetCount,
    w4ItemSequenceFingerprint: m.w4ItemSequenceFingerprint,
    w4ItemSetFingerprint: m.w4ItemSetFingerprint,
    legacySourceRowLimit: m.legacySourceRowLimit,
    groupRevision: m.groupRevision,
    groupStateFingerprint: m.groupStateFingerprint,
    batch: m.batch,
    items: input.items,
    recordWrites: input.recordWrites,
    groupEffects: input.groupEffects,
    artifactCleanup: m.artifactCleanup,
  })
}

// ---------------------------------------------------------------------------
// Chunker (fixed 500 source rows per chunk; operational only)
// ---------------------------------------------------------------------------

export type LegacyImportPlanChunkBuildInputV1 = {
  readonly items: readonly LegacyImportItemPlanV1[]
  readonly recordWrites: readonly LegacyImportRecordWritePlanV1[]
  readonly groupEffects: readonly LegacyImportGroupEffectPlanV1[]
  readonly groupEffectPlacements: readonly LegacyImportGroupEffectPlacementV1[]
}

export type LegacyImportGroupEffectPlacementV1 = {
  readonly effectId: string
  readonly firstSourceOrdinal: number
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function compareRecordWrites(
  left: LegacyImportRecordWritePlanV1,
  right: LegacyImportRecordWritePlanV1,
): number {
  return (
    compareUtf8(left.orgId, right.orgId) ||
    compareUtf8(left.userId, right.userId) ||
    compareUtf8(left.workDate, right.workDate) ||
    compareUtf8(left.recordWriteId, right.recordWriteId)
  )
}

function groupEffectIdentity(effect: LegacyImportGroupEffectPlanV1): string {
  return effect.kind === 'ensure_group' ? effect.groupId : effect.memberId
}

function groupEffectSortKey(effect: LegacyImportGroupEffectPlanV1): string {
  return effect.kind === 'ensure_group'
    ? `0\u0000${effect.normalizedName}\u0000${effect.groupId}`
    : `1\u0000${effect.groupRef}\u0000${effect.userId}\u0000${effect.memberId}`
}

function compareGroupEffects(
  left: LegacyImportGroupEffectPlanV1,
  right: LegacyImportGroupEffectPlanV1,
): number {
  return compareUtf8(groupEffectSortKey(left), groupEffectSortKey(right))
}

/**
 * Partition source ordinals into dense fixed-size chunks of at most 500 rows.
 * A recordWrite is stored in the chunk containing its first contributing source
 * ordinal. A groupEffect is stored at the explicit first referencing source
 * ordinal frozen by the planner. This storage helper never guesses that
 * relationship from unrelated IDs or names.
 *
 * Changing chunk size changes chunkVectorDigest only; logical plan digest is
 * independent of physical boundaries.
 */
export function chunkLegacyImportPlanSourceRowsV1(
  input: LegacyImportPlanChunkBuildInputV1,
  maxRowsPerChunk: number = LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK,
): {
  readonly chunks: readonly LegacyImportExecutionPlanChunkV1[]
  readonly descriptors: readonly LegacyImportChunkDescriptorV1[]
  readonly chunkVectorDigest: string
} {
  const code = 'W4C3A_CHUNKER_INVALID'
  if (!Number.isInteger(maxRowsPerChunk) || maxRowsPerChunk < 1) fail(code)
  if (maxRowsPerChunk !== LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK) {
    // Phase-1 storage contract freezes 500; other values require an amendment.
    fail('W4C3A_CHUNK_SIZE_NOT_AMENDED')
  }
  const items = [...input.items]
  if (items.length === 0) {
    return freezeDeep({
      chunks: Object.freeze([]),
      descriptors: Object.freeze([]),
      chunkVectorDigest: computeLegacyImportChunkVectorDigestV1([]),
    })
  }
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].ordinal !== i) fail(code)
  }
  const sourceRowCount = items.length
  const chunkCount = Math.ceil(sourceRowCount / maxRowsPerChunk)

  // Map first source ordinal for record writes / group effects.
  const recordWriteFirstOrdinal = new Map<string, number>()
  for (const rw of input.recordWrites) {
    for (let index = 0; index < rw.sourceOrdinals.length; index += 1) {
      const ordinal = rw.sourceOrdinals[index]
      if (ordinal >= sourceRowCount) fail(code)
      if (index > 0 && ordinal <= rw.sourceOrdinals[index - 1]) fail(code)
    }
    const first = Math.min(...rw.sourceOrdinals)
    if (!Number.isFinite(first) || first < 0 || first >= sourceRowCount) fail(code)
    if (recordWriteFirstOrdinal.has(rw.recordWriteId)) fail(code)
    recordWriteFirstOrdinal.set(rw.recordWriteId, first)
  }

  const placementByEffectId = new Map<string, number>()
  for (const rawPlacement of input.groupEffectPlacements) {
    const obj = requireExactKeys(
      rawPlacement,
      ['effectId', 'firstSourceOrdinal'],
      code,
    )
    const effectId = requireUuid(obj.effectId, code)
    const firstSourceOrdinal = requireNonNegInt(obj.firstSourceOrdinal, code)
    if (firstSourceOrdinal >= sourceRowCount || placementByEffectId.has(effectId)) fail(code)
    placementByEffectId.set(effectId, firstSourceOrdinal)
  }
  if (placementByEffectId.size !== input.groupEffects.length) fail(code)

  const groupEffectFirstOrdinal = new Map<string, number>()
  for (const ge of input.groupEffects) {
    const key = groupEffectIdentity(ge)
    if (groupEffectFirstOrdinal.has(key)) fail(code)
    const first = placementByEffectId.get(key)
    if (first === undefined) fail(code)
    groupEffectFirstOrdinal.set(key, first)
  }

  const chunks: LegacyImportExecutionPlanChunkV1[] = []
  const descriptors: LegacyImportChunkDescriptorV1[] = []

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const firstSourceOrdinal = chunkIndex * maxRowsPerChunk
    const end = Math.min(firstSourceOrdinal + maxRowsPerChunk, sourceRowCount)
    const chunkItems = items.slice(firstSourceOrdinal, end)
    const chunkRecordWrites = input.recordWrites.filter((rw) => {
      const first = recordWriteFirstOrdinal.get(rw.recordWriteId)!
      return first >= firstSourceOrdinal && first < end
    })
    const chunkGroupEffects = input.groupEffects.filter((ge) => {
      const key = groupEffectIdentity(ge)
      const first = groupEffectFirstOrdinal.get(key)!
      return first >= firstSourceOrdinal && first < end
    })
    const body = freezeDeep({
      items: Object.freeze(chunkItems),
      recordWrites: Object.freeze(chunkRecordWrites),
      groupEffects: Object.freeze(chunkGroupEffects),
    })
    const chunkDigest = computeLegacyImportChunkDigestV1(body)
    const chunk: LegacyImportExecutionPlanChunkV1 = freezeDeep({
      chunkIndex,
      firstSourceOrdinal,
      sourceRowCount: end - firstSourceOrdinal,
      chunkDigest,
      body,
    })
    chunks.push(chunk)
    descriptors.push({
      chunkIndex,
      firstSourceOrdinal,
      sourceRowCount: end - firstSourceOrdinal,
      chunkDigest,
    })
  }

  // Reject duplicate definitions across chunks (each write/effect once).
  if (
    chunks.reduce((n, c) => n + c.body.recordWrites.length, 0) !== input.recordWrites.length ||
    chunks.reduce((n, c) => n + c.body.groupEffects.length, 0) !== input.groupEffects.length
  ) {
    fail(code)
  }

  const chunkVectorDigest = computeLegacyImportChunkVectorDigestV1(descriptors)
  return freezeDeep({
    chunks: Object.freeze(chunks),
    descriptors: Object.freeze(descriptors),
    chunkVectorDigest,
  })
}

/**
 * Reassemble dense ordered items/recordWrites/groupEffects from chunks and
 * verify digests + density. Never reconstructs a plan from targets alone.
 */
export function reassembleLegacyImportPlanChunksV1(
  chunks: readonly LegacyImportExecutionPlanChunkV1[],
  expectedSourceRowCount: number,
): {
  readonly items: readonly LegacyImportItemPlanV1[]
  readonly recordWrites: readonly LegacyImportRecordWritePlanV1[]
  readonly groupEffects: readonly LegacyImportGroupEffectPlanV1[]
} {
  const code = 'W4C3A_CHUNK_REASSEMBLY_INVALID'
  if (expectedSourceRowCount === 0) {
    if (chunks.length !== 0) fail(code)
    return freezeDeep({
      items: Object.freeze([]),
      recordWrites: Object.freeze([]),
      groupEffects: Object.freeze([]),
    })
  }
  if (chunks.length < 1) fail(code)
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)
  for (let i = 0; i < ordered.length; i += 1) {
    if (ordered[i].chunkIndex !== i) fail(code)
  }
  const items: LegacyImportItemPlanV1[] = []
  const recordWrites: LegacyImportRecordWritePlanV1[] = []
  const groupEffects: LegacyImportGroupEffectPlanV1[] = []
  const recordWriteIds = new Set<string>()
  const groupEffectIds = new Set<string>()
  let expectedFirst = 0
  for (const chunk of ordered) {
    if (chunk.firstSourceOrdinal !== expectedFirst) fail(code)
    if (chunk.sourceRowCount !== chunk.body.items.length) fail(code)
    if (chunk.sourceRowCount < 1 || chunk.sourceRowCount > LEGACY_IMPORT_PLAN_MAX_SOURCE_ROWS_PER_CHUNK) {
      fail(code)
    }
    const recomputed = computeLegacyImportChunkDigestV1(chunk.body)
    if (recomputed !== chunk.chunkDigest) fail('W4C3A_CHUNK_DIGEST_MISMATCH')
    for (const item of chunk.body.items) {
      if (item.ordinal !== items.length) fail(code)
      items.push(item)
    }
    for (const recordWrite of chunk.body.recordWrites) {
      if (recordWriteIds.has(recordWrite.recordWriteId)) fail(code)
      recordWriteIds.add(recordWrite.recordWriteId)
      recordWrites.push(recordWrite)
    }
    for (const groupEffect of chunk.body.groupEffects) {
      const effectId = groupEffectIdentity(groupEffect)
      if (groupEffectIds.has(effectId)) fail(code)
      groupEffectIds.add(effectId)
      groupEffects.push(groupEffect)
    }
    expectedFirst += chunk.sourceRowCount
  }
  if (items.length !== expectedSourceRowCount) fail(code)
  return freezeDeep({
    items: Object.freeze(items),
    recordWrites: Object.freeze(recordWrites.sort(compareRecordWrites)),
    groupEffects: Object.freeze(groupEffects.sort(compareGroupEffects)),
  })
}

// ---------------------------------------------------------------------------
// Public-job envelope + terminal async summary (closed schemas)
// ---------------------------------------------------------------------------

export type LegacyImportPublicJobEnvelopeV1 = {
  readonly __jobType: 'commit'
  readonly idempotencyKey: string | null
  readonly __importEngine: AttendanceLegacyImportEngineV1
  readonly recordUpsertStrategy: AttendanceLegacyImportWriteStrategyV1
  readonly itemsInsertStrategy: AttendanceLegacyImportWriteStrategyV1
  readonly __w4ContractVersion: 1
}

const PUBLIC_JOB_ENVELOPE_KEYS = [
  '__jobType',
  'idempotencyKey',
  '__importEngine',
  'recordUpsertStrategy',
  'itemsInsertStrategy',
  '__w4ContractVersion',
] as const

export function parseLegacyImportPublicJobEnvelopeV1(
  value: unknown,
): LegacyImportPublicJobEnvelopeV1 {
  const code = 'W4C3A_PUBLIC_JOB_ENVELOPE_INVALID'
  const obj = requireExactKeys(value, PUBLIC_JOB_ENVELOPE_KEYS, code)
  if (obj.__jobType !== 'commit') fail(code)
  if (obj.__w4ContractVersion !== 1) fail(code)
  return freezeDeep({
    __jobType: 'commit' as const,
    idempotencyKey: requireNullableString(obj.idempotencyKey, code),
    __importEngine: requireOneOf(obj.__importEngine, ATTENDANCE_LEGACY_IMPORT_ENGINES_V1, code),
    recordUpsertStrategy: requireOneOf(
      obj.recordUpsertStrategy,
      ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1,
      code,
    ),
    itemsInsertStrategy: requireOneOf(
      obj.itemsInsertStrategy,
      ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1,
      code,
    ),
    __w4ContractVersion: 1 as const,
  })
}

export type LegacyImportAsyncJobSummaryV1 = {
  readonly __jobType: 'commit'
  readonly idempotencyKey: string | null
  readonly __importEngine: AttendanceLegacyImportEngineV1
  readonly recordUpsertStrategy: AttendanceLegacyImportWriteStrategyV1
  readonly itemsInsertStrategy: AttendanceLegacyImportWriteStrategyV1
  readonly summary: {
    readonly processedRows: number
    readonly failedRows: number
    readonly elapsedMs: number
    readonly chunkConfig: unknown
    readonly skippedCount?: number
    readonly skippedRows?: unknown
  }
}

export function parseLegacyImportAsyncJobSummaryV1(
  value: unknown,
): LegacyImportAsyncJobSummaryV1 {
  const code = 'W4C3A_ASYNC_JOB_SUMMARY_INVALID'
  if (!isPlainObject(value)) fail(code)
  const keys = Object.keys(value).sort()
  const required = [
    '__jobType',
    'idempotencyKey',
    '__importEngine',
    'recordUpsertStrategy',
    'itemsInsertStrategy',
    'summary',
  ]
  if (keys.length !== required.length || keys.join(',') !== required.sort().join(',')) {
    fail(code)
  }
  if (value.__jobType !== 'commit') fail(code)
  if (!isPlainObject(value.summary)) fail(code)
  const summaryKeys = Object.keys(value.summary).sort()
  const base = ['chunkConfig', 'elapsedMs', 'failedRows', 'processedRows']
  for (const k of base) {
    if (!summaryKeys.includes(k)) fail(code)
  }
  for (const k of summaryKeys) {
    if (!['chunkConfig', 'elapsedMs', 'failedRows', 'processedRows', 'skippedCount', 'skippedRows'].includes(k)) {
      fail(code)
    }
  }
  const skippedCount = summaryKeys.includes('skippedCount')
    ? requirePosInt(value.summary.skippedCount, code)
    : undefined
  const skippedRows = summaryKeys.includes('skippedRows')
    ? parseOpaqueLeaf(value.summary.skippedRows, code)
    : undefined
  if (skippedRows !== undefined && (!Array.isArray(skippedRows) || skippedRows.length < 1)) {
    fail(code)
  }
  const summary = {
    processedRows: requireNonNegInt(value.summary.processedRows, code),
    failedRows: requireNonNegInt(value.summary.failedRows, code),
    elapsedMs: requireNonNegInt(value.summary.elapsedMs, code),
    chunkConfig: parseOpaqueLeaf(value.summary.chunkConfig, code),
    ...(skippedCount === undefined ? {} : { skippedCount }),
    ...(skippedRows === undefined ? {} : { skippedRows }),
  }
  return freezeDeep({
    __jobType: 'commit' as const,
    idempotencyKey: requireNullableString(value.idempotencyKey, code),
    __importEngine: requireOneOf(
      value.__importEngine,
      ATTENDANCE_LEGACY_IMPORT_ENGINES_V1,
      code,
    ),
    recordUpsertStrategy: requireOneOf(
      value.recordUpsertStrategy,
      ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1,
      code,
    ),
    itemsInsertStrategy: requireOneOf(
      value.itemsInsertStrategy,
      ATTENDANCE_LEGACY_IMPORT_WRITE_STRATEGIES_V1,
      code,
    ),
    summary,
  })
}

export function computeLegacyImportAsyncJobSummaryDigestV1(
  summary: LegacyImportAsyncJobSummaryV1,
): string {
  return sha256HexOfCanonicalJsonV1(summary)
}

/**
 * Existing-record precondition fingerprint (section 4.4) over the exact ordered
 * read set from the enqueue SERIALIZABLE snapshot.
 */
export function computeLegacyImportRecordPreconditionFingerprintV1(
  input: unknown,
): string {
  return sha256HexOfCanonicalJsonV1(
    parseLegacyImportRecordPreconditionV1(input),
  )
}

export type LegacyImportGroupStateV1 = Readonly<{
  readonly groups: readonly Readonly<{
    readonly id: string
    readonly orgId: string
    readonly name: string
    readonly code: string | null
    readonly timezone: string
    readonly ruleSetId: string | null
  }>[]
  readonly memberships: readonly Readonly<{
    readonly orgId: string
    readonly groupId: string
    readonly userId: string
    readonly exists: boolean
  }>[]
}>

function compareUtf8Tuple(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const compared = Buffer.compare(
      Buffer.from(left[index], 'utf8'),
      Buffer.from(right[index], 'utf8'),
    )
    if (compared !== 0) return compared
  }
  return left.length - right.length
}

export function computeLegacyImportGroupStateFingerprintV1(
  input: LegacyImportGroupStateV1,
): string {
  if (!isPlainObject(input)) fail('W4C3A_GROUP_STATE_INVALID')
  const root = requireExactKeys(
    input,
    ['groups', 'memberships'],
    'W4C3A_GROUP_STATE_INVALID',
  )
  if (!Array.isArray(root.groups) || !Array.isArray(root.memberships)) {
    fail('W4C3A_GROUP_STATE_INVALID')
  }
  const groups = root.groups.map((value) => {
    const group = requireExactKeys(
      value,
      ['id', 'orgId', 'name', 'code', 'timezone', 'ruleSetId'],
      'W4C3A_GROUP_STATE_INVALID',
    )
    return {
      id: requireUuid(group.id, 'W4C3A_GROUP_STATE_INVALID'),
      orgId: requireString(group.orgId, 'W4C3A_GROUP_STATE_INVALID'),
      name: requireString(group.name, 'W4C3A_GROUP_STATE_INVALID'),
      code: requireNullableString(group.code, 'W4C3A_GROUP_STATE_INVALID'),
      timezone: requireString(group.timezone, 'W4C3A_GROUP_STATE_INVALID'),
      ruleSetId:
        group.ruleSetId === null
          ? null
          : requireUuid(group.ruleSetId, 'W4C3A_GROUP_STATE_INVALID'),
    }
  })
  const memberships = root.memberships.map((value) => {
    const membership = requireExactKeys(
      value,
      ['orgId', 'groupId', 'userId', 'exists'],
      'W4C3A_GROUP_STATE_INVALID',
    )
    return {
      orgId: requireString(membership.orgId, 'W4C3A_GROUP_STATE_INVALID'),
      groupId: requireUuid(membership.groupId, 'W4C3A_GROUP_STATE_INVALID'),
      userId: requireString(membership.userId, 'W4C3A_GROUP_STATE_INVALID'),
      exists: requireBool(membership.exists, 'W4C3A_GROUP_STATE_INVALID'),
    }
  })
  groups.sort((left, right) =>
    compareUtf8Tuple(
      [left.id, left.orgId, left.name, left.code ?? '', left.timezone, left.ruleSetId ?? ''],
      [right.id, right.orgId, right.name, right.code ?? '', right.timezone, right.ruleSetId ?? ''],
    ),
  )
  memberships.sort((left, right) =>
    compareUtf8Tuple(
      [left.orgId, left.groupId, left.userId],
      [right.orgId, right.groupId, right.userId],
    ),
  )
  return sha256HexOfCanonicalJsonV1({ groups, memberships })
}

/**
 * Build a fully digests-bound plan package from a verified manifest seed and
 * ordered effect arrays. Rejects target-only paths (items must be dense source
 * ordinals; no synthetic reconstruction from recordWrites alone).
 */
export function buildLegacyImportExecutionPlanPackageV1(input: {
  readonly manifestSeed: Omit<
    LegacyImportExecutionPlanManifestV1,
    'sourceOrdinalDigest' | 'chunkVectorDigest'
  >
  readonly items: readonly LegacyImportItemPlanV1[]
  readonly recordWrites: readonly LegacyImportRecordWritePlanV1[]
  readonly groupEffects: readonly LegacyImportGroupEffectPlanV1[]
  readonly groupEffectPlacements: readonly LegacyImportGroupEffectPlacementV1[]
}): {
  readonly manifest: LegacyImportExecutionPlanManifestV1
  readonly chunks: readonly LegacyImportExecutionPlanChunkV1[]
  readonly planDigest: string
} {
  const code = 'W4C3A_PLAN_PACKAGE_INVALID'
  const seed = input.manifestSeed
  const items = input.items.map(parseLegacyImportItemPlanV1)
  const recordWrites = input.recordWrites
    .map(parseLegacyImportRecordWritePlanV1)
    .sort(compareRecordWrites)
  const groupEffects = input.groupEffects
    .map(parseLegacyImportGroupEffectPlanV1)
    .sort(compareGroupEffects)
  const groupNames = new Set<string>()
  const membershipIntents = new Set<string>()
  for (const effect of groupEffects) {
    if (effect.kind === 'ensure_group') {
      if (groupNames.has(effect.normalizedName)) fail(code)
      groupNames.add(effect.normalizedName)
      continue
    }
    const membershipKey = canonicalAttendanceJsonV1([
      effect.groupRef.trim().toLowerCase(),
      effect.userId,
    ])
    if (membershipIntents.has(membershipKey)) fail(code)
    membershipIntents.add(membershipKey)
  }
  if (seed.operationalBranch === 'operational_only_idempotent_replay') {
    if (
      items.length !== 0 ||
      recordWrites.length !== 0 ||
      groupEffects.length !== 0 ||
      input.groupEffectPlacements.length !== 0
    ) {
      fail(code)
    }
    const sourceOrdinalDigest = computeLegacyImportSourceOrdinalDigestV1([])
    const chunkVectorDigest = computeLegacyImportChunkVectorDigestV1([])
    const manifest = parseLegacyImportExecutionPlanManifestV1({
      ...seed,
      sourceOrdinalDigest,
      chunkVectorDigest,
    })
    const planDigest = computeLegacyImportPlanDigestV1({
      manifest,
      items: [],
      recordWrites: [],
      groupEffects: [],
    })
    return freezeDeep({
      manifest,
      chunks: Object.freeze([]),
      planDigest,
    })
  }

  if (items.length !== seed.sourceRowCount) fail(code)
  // Reject target-only fallback: every source ordinal must have an item entry.
  let nextSemanticOrdinal = 0
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item.ordinal !== i) fail(code)
    if (item.kind === 'apply') {
      if (item.semanticOrdinal !== nextSemanticOrdinal) fail(code)
      nextSemanticOrdinal += 1
    }
  }
  const applyCount = nextSemanticOrdinal
  if (applyCount !== seed.w4ItemCount) fail(code)
  if (seed.operationalBranch === 'operational_only_no_target') {
    if (applyCount !== 0) fail(code)
    if (
      recordWrites.length !== 0 ||
      groupEffects.length !== 0 ||
      input.groupEffectPlacements.length !== 0
    ) {
      fail(code)
    }
  }

  const recordWriteIds = new Set<string>()
  const targetKeys = new Set<string>()
  const contributingOrdinals = new Set<number>()
  const targetRefByRecordWriteId = new Map<string, string>()
  for (const recordWrite of recordWrites) {
    if (recordWriteIds.has(recordWrite.recordWriteId)) fail(code)
    recordWriteIds.add(recordWrite.recordWriteId)
    if (
      recordWrite.orgId !== seed.orgId ||
      recordWrite.sourceBatchId !== seed.batchId
    ) {
      fail(code)
    }
    const targetKey = canonicalAttendanceJsonV1([
      recordWrite.orgId,
      recordWrite.userId,
      recordWrite.workDate,
    ])
    if (targetKeys.has(targetKey)) fail(code)
    targetKeys.add(targetKey)
    targetRefByRecordWriteId.set(
      recordWrite.recordWriteId,
      canonicalAttendanceJsonV1([
        recordWrite.orgId,
        recordWrite.userId,
        recordWrite.workDate,
      ]),
    )
    for (const ordinal of recordWrite.sourceOrdinals) {
      const item = items[ordinal]
      if (
        contributingOrdinals.has(ordinal) ||
        item?.kind !== 'apply' ||
        item.recordWriteRef !== recordWrite.recordWriteId
      ) {
        fail(code)
      }
      contributingOrdinals.add(ordinal)
    }
  }
  for (const item of items) {
    if (
      item.kind === 'apply' &&
      (
        !recordWriteIds.has(item.recordWriteRef) ||
        !contributingOrdinals.has(item.ordinal) ||
        targetRefByRecordWriteId.get(item.recordWriteRef) !== item.targetRef
      )
    ) {
      fail(code)
    }
  }
  if (
    contributingOrdinals.size !== applyCount ||
    targetKeys.size !== seed.w4DistinctTargetCount
  ) {
    fail(code)
  }

  if ((groupEffects.length > 0) !== (seed.groupRevision !== null)) fail(code)
  if ((groupEffects.length > 0) !== (seed.groupStateFingerprint !== null)) fail(code)

  const sourceOrdinalDigest = computeLegacyImportSourceOrdinalDigestV1(items)
  const { chunks, chunkVectorDigest } = chunkLegacyImportPlanSourceRowsV1({
    items,
    recordWrites,
    groupEffects,
    groupEffectPlacements: input.groupEffectPlacements,
  })
  const manifest = parseLegacyImportExecutionPlanManifestV1({
    ...seed,
    sourceOrdinalDigest,
    chunkVectorDigest,
  })
  if (chunks.length === 0) fail(code)
  // chunk_count positive outside replay
  const planDigest = computeLegacyImportPlanDigestV1({
    manifest,
    items,
    recordWrites,
    groupEffects,
  })
  return freezeDeep({
    manifest,
    chunks: Object.freeze(chunks),
    planDigest,
  })
}
