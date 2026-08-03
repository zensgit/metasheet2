/**
 * W4C-3c P05 — immutable manual override helpers (lock §4.2 / §12.6).
 *
 * Manual result editing freezes the override into prepared projection meta in
 * the SAME write as the record upsert. There is no post-write
 * attachManualResultEditMarkerToRecord UPDATE.
 *
 * Survival rule: an existing manual_result_edit marker is preserved across
 * unrelated updates (statusOverride absent). Only an explicit superseding
 * manual edit (statusOverride present with a new marker) replaces it.
 *
 * set/unset/closed validators fail closed — closed payroll cycles reject
 * before any result DML; set/unset operations validate field membership.
 */
import crypto from 'node:crypto'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import type { ManualAttendanceOverrideV1 } from './w4c0-write-boundary-types'

export const ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'W4C3C_MANUAL_OVERRIDE_INPUT_INVALID',
  CLOSED_STATUS: 'ATTENDANCE_RESULT_EDIT_CYCLE_CLOSED',
  SOURCE_NOT_EDITABLE: 'ATTENDANCE_RESULT_EDIT_SOURCE_NOT_EDITABLE',
  FIELD_UNKNOWN: 'W4C3C_MANUAL_OVERRIDE_FIELD_UNKNOWN',
  UNSET_VALUE_NOT_NULL: 'W4C3C_MANUAL_OVERRIDE_UNSET_VALUE_NOT_NULL',
  SET_VALUE_REQUIRED: 'W4C3C_MANUAL_OVERRIDE_SET_VALUE_REQUIRED',
  POST_WRITE_META_PATCH_FORBIDDEN: 'W4C3C_MANUAL_OVERRIDE_POST_WRITE_META_PATCH_FORBIDDEN',
} as const)

export class AttendanceW4ManualOverrideError extends Error {
  readonly code: string
  readonly httpStatus: number

  constructor(code: string, httpStatus = 422) {
    super(code)
    this.name = 'AttendanceW4ManualOverrideError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

function fail(code: string, httpStatus = 422): never {
  throw new AttendanceW4ManualOverrideError(code, httpStatus)
}

/** Closed set of status fields a manual override may set/unset. */
export const ATTENDANCE_MANUAL_OVERRIDE_FIELDS_V1 = Object.freeze([
  'status',
  'workMinutes',
  'lateMinutes',
  'earlyLeaveMinutes',
] as const)

export type AttendanceManualOverrideFieldV1 =
  (typeof ATTENDANCE_MANUAL_OVERRIDE_FIELDS_V1)[number]

export type AttendanceManualOverrideOpV1 = 'set' | 'unset'

export interface AttendanceManualOverrideOperationV1 {
  readonly op: AttendanceManualOverrideOpV1
  readonly field: AttendanceManualOverrideFieldV1
  readonly value: unknown
}

/** Closed daily statuses editable by the legacy AE-1 path. */
export const ATTENDANCE_MANUAL_EDITABLE_SOURCE_STATUSES_V1 = Object.freeze([
  'late',
  'early_leave',
  'late_early',
  'partial',
  'absent',
] as const)

export const ATTENDANCE_MANUAL_CLOSED_TARGET_STATUSES_V1 = Object.freeze([
  'normal',
  'late',
  'early_leave',
  'late_early',
  'partial',
  'absent',
  'adjusted',
] as const)

export function assertManualOverrideOperationsValidV1(
  operations: readonly unknown[],
): AttendanceManualOverrideOperationV1[] {
  if (!Array.isArray(operations) || operations.length === 0) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
  }
  const out: AttendanceManualOverrideOperationV1[] = []
  for (const raw of operations) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
    }
    const entry = raw as Record<string, unknown>
    const op = entry.op
    const field = entry.field
    if (op !== 'set' && op !== 'unset') {
      fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
    }
    if (
      typeof field !== 'string'
      || !(ATTENDANCE_MANUAL_OVERRIDE_FIELDS_V1 as readonly string[]).includes(field)
    ) {
      fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.FIELD_UNKNOWN)
    }
    if (op === 'unset' && entry.value !== null) {
      fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.UNSET_VALUE_NOT_NULL)
    }
    if (op === 'set' && entry.value === null) {
      fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.SET_VALUE_REQUIRED)
    }
    if (op === 'set' && field === 'status') {
      if (
        typeof entry.value !== 'string'
        || !(ATTENDANCE_MANUAL_CLOSED_TARGET_STATUSES_V1 as readonly string[]).includes(entry.value)
      ) {
        fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
      }
    }
    out.push(
      Object.freeze({
        op,
        field: field as AttendanceManualOverrideFieldV1,
        value: op === 'unset' ? null : entry.value,
      }),
    )
  }
  return out
}

export function assertManualEditableSourceStatusV1(status: string): void {
  if (!(ATTENDANCE_MANUAL_EDITABLE_SOURCE_STATUSES_V1 as readonly string[]).includes(status)) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.SOURCE_NOT_EDITABLE)
  }
}

export function assertManualTargetStatusClosedV1(status: string): void {
  if (!(ATTENDANCE_MANUAL_CLOSED_TARGET_STATUSES_V1 as readonly string[]).includes(status)) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
  }
}

/**
 * Closed pure daily-overlay helper from frozen ManualAttendanceOverrideV1 operations.
 *
 * Manual override is a **daily projection overlay only**:
 * - applies set/unset to status / workMinutes / lateMinutes / earlyLeaveMinutes
 * - never invents first/last, segments, or physical punch evidence
 * - unset keeps null (does not silently coerce metrics to zero)
 *
 * Used by manual_edit apply and by frozen_prior / current_policy recompute so a
 * surviving manual_override_snapshot continues to shape daily projection/parent
 * while physical segment rows remain the canonical calculator output.
 */
export interface AttendanceDailyProjectionBaseV1 {
  readonly status: string
  readonly firstInAt: string | null
  readonly lastOutAt: string | null
  readonly workMinutes: number | null
  readonly lateMinutes: number | null
  readonly earlyLeaveMinutes: number | null
}

export interface AttendanceDailyProjectionOverlayResultV1 {
  readonly status: string
  readonly firstInAt: string | null
  readonly lastOutAt: string | null
  readonly workMinutes: number | null
  readonly lateMinutes: number | null
  readonly earlyLeaveMinutes: number | null
}

function parseNonNegativeIntegerOrFail(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
  }
  return n
}

export function applyManualOverrideDailyOverlayV1(
  base: AttendanceDailyProjectionBaseV1,
  operations: readonly AttendanceManualOverrideOperationV1[],
): AttendanceDailyProjectionOverlayResultV1 {
  const next: {
    status: string
    firstInAt: string | null
    lastOutAt: string | null
    workMinutes: number | null
    lateMinutes: number | null
    earlyLeaveMinutes: number | null
  } = {
    status: base.status,
    firstInAt: base.firstInAt,
    lastOutAt: base.lastOutAt,
    workMinutes: base.workMinutes,
    lateMinutes: base.lateMinutes,
    earlyLeaveMinutes: base.earlyLeaveMinutes,
  }
  for (const op of operations) {
    if (op.op === 'unset') {
      if (op.field === 'status') fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
      if (op.field === 'workMinutes') next.workMinutes = null
      if (op.field === 'lateMinutes') next.lateMinutes = null
      if (op.field === 'earlyLeaveMinutes') next.earlyLeaveMinutes = null
      continue
    }
    if (op.field === 'status') {
      assertManualTargetStatusClosedV1(String(op.value))
      next.status = String(op.value)
    } else if (op.field === 'workMinutes') {
      next.workMinutes = parseNonNegativeIntegerOrFail(op.value)
    } else if (op.field === 'lateMinutes') {
      next.lateMinutes = parseNonNegativeIntegerOrFail(op.value)
    } else if (op.field === 'earlyLeaveMinutes') {
      next.earlyLeaveMinutes = parseNonNegativeIntegerOrFail(op.value)
    }
  }
  return Object.freeze(next)
}

/**
 * Apply a frozen ManualAttendanceOverrideV1 snapshot as a daily projection
 * overlay. Null means no override. A present malformed snapshot fails closed so
 * recompute cannot silently discard an immutable administrator correction.
 */
export function applyFrozenManualOverrideSnapshotToDailyProjectionV1(
  base: AttendanceDailyProjectionBaseV1,
  manualOverrideSnapshot: unknown,
): AttendanceDailyProjectionOverlayResultV1 {
  if (manualOverrideSnapshot === null || manualOverrideSnapshot === undefined) {
    return Object.freeze({ ...base })
  }
  if (typeof manualOverrideSnapshot !== 'object' || Array.isArray(manualOverrideSnapshot)) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
  }
  const opsRaw = (manualOverrideSnapshot as { operations?: unknown }).operations
  if (!Array.isArray(opsRaw) || opsRaw.length === 0) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
  }
  const operations = assertManualOverrideOperationsValidV1(opsRaw)
  return applyManualOverrideDailyOverlayV1(base, operations)
}

/**
 * Build the durable ManualAttendanceOverrideV1 snapshot frozen into the
 * calculation's manual_override_snapshot (and/or projection meta).
 */
export function buildManualAttendanceOverrideSnapshotV1(input: {
  editId: string
  before: unknown
  reason: string
  operations: readonly AttendanceManualOverrideOperationV1[]
}): ManualAttendanceOverrideV1 {
  if (typeof input.editId !== 'string' || input.editId.length === 0) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
  }
  if (typeof input.reason !== 'string' || input.reason.length === 0) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.INPUT_INVALID)
  }
  const operations = assertManualOverrideOperationsValidV1([...input.operations])
  const beforeFingerprint = crypto
    .createHash('sha256')
    .update(canonicalAttendanceJsonV1(input.before ?? null), 'utf8')
    .digest('hex')
  return Object.freeze({
    editId: input.editId,
    beforeFingerprint,
    reason: input.reason,
    actorPosture: 'attendance_admin',
    operations: operations.map((op) =>
      Object.freeze({ op: op.op, field: op.field, value: op.value }),
    ),
  })
}

/**
 * Compatibility meta marker written in the SAME upsert as the projection.
 * Replaces the removed post-write attachManualResultEditMarkerToRecord UPDATE.
 */
export function buildManualResultEditMarkerInWriteV1(input: {
  auditId: string | null
  idempotencyKey: string | null
  targetStatus: string
  workMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  workDate: string
  firstInAt: string | null
  lastOutAt: string | null
  isWorkday: boolean
  actorUserId: string | null
  editedAt?: string
}): Record<string, unknown> {
  return Object.freeze({
    version: 1,
    auditId: input.auditId,
    idempotencyKey: input.idempotencyKey,
    targetStatus: input.targetStatus,
    correctedMetrics: Object.freeze({
      workMinutes: Math.max(0, Math.floor(Number(input.workMinutes) || 0)),
      lateMinutes: Math.max(0, Math.floor(Number(input.lateMinutes) || 0)),
      earlyLeaveMinutes: Math.max(0, Math.floor(Number(input.earlyLeaveMinutes) || 0)),
    }),
    correctedAgainst: Object.freeze({
      workDate: input.workDate,
      firstInAt: input.firstInAt,
      lastOutAt: input.lastOutAt,
      isWorkday: input.isWorkday !== false,
    }),
    editedAt: input.editedAt ?? new Date().toISOString(),
    actorUserId: input.actorUserId,
    reviewConflict: null,
  })
}

/**
 * Merge incoming meta with an existing manual marker under the survival rule.
 * - statusOverride present + incoming marker → supersede (caller supplies marker)
 * - statusOverride absent + existing marker → preserve (may attach reviewConflict)
 * - statusOverride present without marker → clear (explicit non-manual supersession path)
 */
export function mergeManualResultEditMetaForUpsertV1(input: {
  existingMeta: Record<string, unknown> | null | undefined
  incomingMeta: Record<string, unknown> | null | undefined
  statusOverride: string | null | undefined
  derivedStatus?: string | null
  latestFacts?: {
    workDate?: string
    firstInAt?: string | null
    lastOutAt?: string | null
    isWorkday?: boolean
  }
}): Record<string, unknown> {
  const base = {
    ...(input.existingMeta && typeof input.existingMeta === 'object' ? input.existingMeta : {}),
    ...(input.incomingMeta && typeof input.incomingMeta === 'object' ? input.incomingMeta : {}),
  } as Record<string, unknown>

  const incomingHasMarker =
    input.incomingMeta != null
    && Object.prototype.hasOwnProperty.call(input.incomingMeta, 'manual_result_edit')
  const existingMarker = base.manual_result_edit
  const hasExisting =
    existingMarker && typeof existingMarker === 'object' && !Array.isArray(existingMarker)

  if (input.statusOverride != null && incomingHasMarker) {
    // Explicit supersession: keep the incoming marker as provided.
    return base
  }
  if (input.statusOverride != null && !incomingHasMarker) {
    delete base.manual_result_edit
    return base
  }
  if (hasExisting && input.statusOverride == null) {
    const marker = { ...(existingMarker as Record<string, unknown>) }
    if (input.derivedStatus && input.latestFacts) {
      const corrected = marker.correctedAgainst as Record<string, unknown> | undefined
      const factsChanged =
        corrected
        && (String(corrected.workDate ?? '') !== String(input.latestFacts.workDate ?? '')
          || String(corrected.firstInAt ?? '') !== String(input.latestFacts.firstInAt ?? '')
          || String(corrected.lastOutAt ?? '') !== String(input.latestFacts.lastOutAt ?? ''))
      if (factsChanged || String(marker.targetStatus ?? '') !== String(input.derivedStatus)) {
        marker.reviewConflict = Object.freeze({
          state: 'needs_review',
          detectedAt: new Date().toISOString(),
          source: 'derived_recompute',
          attemptedDerivedStatus: input.derivedStatus,
          latestFacts: Object.freeze({
            workDate: input.latestFacts.workDate ?? null,
            firstInAt: input.latestFacts.firstInAt ?? null,
            lastOutAt: input.latestFacts.lastOutAt ?? null,
            isWorkday: input.latestFacts.isWorkday !== false,
          }),
        })
      }
    }
    base.manual_result_edit = marker
  }
  return base
}

/**
 * Guard: production code must not call a post-write meta patch for the marker.
 * Tests mutate by reintroducing attachManualResultEditMarkerToRecord usage.
 */
export function assertNoPostWriteManualMetaPatchV1(source: string): void {
  if (/async function attachManualResultEditMarkerToRecord\b/.test(source)) {
    fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.POST_WRITE_META_PATCH_FORBIDDEN, 500)
  }
  if (
    /attachManualResultEditMarkerToRecord\s*\(/.test(source)
    && !/assertNoPostWriteManualMetaPatchV1/.test(source)
  ) {
    // Allow the name only inside this assertion helper's own tests via negative control.
    if (/await attachManualResultEditMarkerToRecord\s*\(/.test(source)) {
      fail(ATTENDANCE_MANUAL_OVERRIDE_ERROR_CODES.POST_WRITE_META_PATCH_FORBIDDEN, 500)
    }
  }
}
