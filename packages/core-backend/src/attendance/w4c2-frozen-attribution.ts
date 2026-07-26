/**
 * W4C-2 (#4556) — V2 frozen work-date attribution builder (lock sections 4.1,
 * 5.1, 5.2; slice 12.3 "freeze W2/context").
 *
 * The W2 resolver (plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs)
 * constructs each candidate's absolute/attribution window with the LEGACY zoned
 * helpers (`buildZonedDate`), which silently fall back on unresolvable local
 * times. A V2 frozen attribution must never inherit that fallback: this module
 * REBUILDS every window boundary with the strict W4 wall-time resolver
 * (`resolveAttendanceLocalWallTimeV1` — no UTC fallback, DST gap/fold made
 * explicit) and requires instant-for-instant equality with the candidate the
 * resolver actually selected. Any divergence — gap/fold boundary, offset drift,
 * an attribution end that neither equals shift-end+tail nor any approved
 * overtime end+tail — refuses to mint V2 (`not_reconstructible`), which the
 * boundary maps to the `unsupported` attribution posture and therefore a
 * review-required calculation. V1/missing/ambiguous/unresolved inputs never
 * reach this module (they never cast to V2; the boundary builds `unsupported`
 * directly).
 *
 * `windowEvidenceFingerprint` freezes the exact window-policy evidence: the
 * bounded attribution tail and the approved-overtime identities/versions/
 * anchors that were eligible to extend the window. Changing tail policy or
 * overtime approvals AFTER the freeze changes nothing here by construction —
 * the fingerprint and both windows are literals in the stored V2 value.
 *
 * Values-free discipline: closed codes only; no caller value is echoed.
 */
import crypto from 'node:crypto'
import type { FrozenWorkDateAttributionV2 } from './w4c0-write-boundary-types'
import { canonicalAttendanceJsonV1 } from './w4c0-fingerprints'
import {
  isAttendanceCalendarDateKeyV1,
  isAttendanceWallTimeHHMMV1,
  parseAttendanceInstantMsV1,
  resolveAttendanceLocalWallTimeV1,
} from './w4c1-strict-time'

export class AttendanceW4FrozenAttributionError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'AttendanceW4FrozenAttributionError'
    this.code = code
  }
}

function fail(code: string): never {
  throw new AttendanceW4FrozenAttributionError(code)
}

const INVALID = 'W4C2_FROZEN_ATTRIBUTION_INPUT_INVALID'

const WINDOW_EVIDENCE_DOMAIN = 'metasheet2:attendance:w4:window-evidence-fingerprint:v1'

/** Resolver version literal recorded inside every V2 value minted here. */
export const ATTENDANCE_W4C2_ATTRIBUTION_RESOLVER_VERSION_V1 =
  'attendance-work-date-resolver-w2+w4c2-strict-rebuild@1'

export interface AttendanceApprovedOvertimeWindowEvidenceV1 {
  /** Approved overtime request row id. */
  readonly requestId: string
  /** Approved end instant (strict ISO with offset/Z). */
  readonly approvedEndAt: string
  /** Creation-frozen anchor value (opaque plain JSON; fingerprinted as-is). */
  readonly anchor: unknown
}

export interface AttendanceFrozenAttributionBuildInputV1 {
  readonly orgId: string
  readonly userId: string
  readonly workDate: string
  readonly shiftId: string
  /** Closed W2 reason code of the winning resolution. */
  readonly reasonCode: string
  /** Freeze instant (strict ISO). Operational audit only — excluded from semantic fingerprints upstream. */
  readonly resolvedAt: string
  /** Strict IANA zone the candidate window was built in. */
  readonly timezone: string
  /** Winning shift wall times (HH:MM) and overnight flag, as resolved. */
  readonly workStartTime: string
  readonly workEndTime: string
  readonly isOvernight: boolean
  /** The windows the W2 resolver actually selected (ISO instants). */
  readonly candidateAbsoluteWindow: { readonly startAt: string; readonly endAt: string }
  readonly candidateAttributionWindow: { readonly startAt: string; readonly endAt: string }
  readonly attributionTailMinutes: number
  /** Approved-overtime windows the resolver considered for this candidate. */
  readonly approvedOvertimeWindows: readonly AttendanceApprovedOvertimeWindowEvidenceV1[]
  readonly source: 'live_resolution' | 'scheduled_resolution'
}

export type AttendanceFrozenAttributionBuildResultV1 =
  | {
      readonly kind: 'resolved_v2'
      readonly attribution: { readonly posture: 'resolved_v2'; readonly value: FrozenWorkDateAttributionV2 }
    }
  | {
      /**
       * The candidate window is not strictly reconstructible (DST gap/fold on a
       * boundary, legacy-helper drift, or an unexplained attribution end). The
       * boundary maps this to the `unsupported` attribution posture, which the
       * calculator turns into a review-required outcome — never a completed V2.
       */
      readonly kind: 'not_reconstructible'
      readonly code:
        | 'W4C2_ATTRIBUTION_START_NOT_UNIQUE'
        | 'W4C2_ATTRIBUTION_END_NOT_UNIQUE'
        | 'W4C2_ATTRIBUTION_START_MISMATCH'
        | 'W4C2_ATTRIBUTION_END_MISMATCH'
        | 'W4C2_ATTRIBUTION_WINDOW_START_MISMATCH'
        | 'W4C2_ATTRIBUTION_WINDOW_END_UNEXPLAINED'
    }

function requireNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(code)
  return value
}

function strictInstantMs(value: unknown): number {
  return parseAttendanceInstantMsV1(value)
}

/**
 * Window-policy evidence fingerprint: tail minutes + ordered approved-overtime
 * identity evidence. Entries are ordered by requestId so caller array order can
 * never change the hash.
 */
export function computeAttendanceWindowEvidenceFingerprintV1(input: {
  readonly attributionTailMinutes: number
  readonly approvedOvertimeWindows: readonly AttendanceApprovedOvertimeWindowEvidenceV1[]
}): string {
  const code = 'W4C2_WINDOW_EVIDENCE_INVALID'
  if (
    typeof input !== 'object' ||
    input === null ||
    !Number.isInteger(input.attributionTailMinutes) ||
    input.attributionTailMinutes < 0
  ) {
    fail(code)
  }
  if (!Array.isArray(input.approvedOvertimeWindows)) fail(code)
  const entries = input.approvedOvertimeWindows.map((entry) => {
    if (typeof entry !== 'object' || entry === null) fail(code)
    return {
      requestId: requireNonEmptyString(entry.requestId, code),
      approvedEndAt: new Date(strictInstantMs(entry.approvedEndAt)).toISOString(),
      anchor: entry.anchor === undefined ? null : entry.anchor,
    }
  })
  entries.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0))
  const projection = { attributionTailMinutes: input.attributionTailMinutes, approvedOvertimeWindows: entries }
  return crypto
    .createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from(WINDOW_EVIDENCE_DOMAIN, 'utf8'),
        Buffer.from([0]),
        Buffer.from(canonicalAttendanceJsonV1(JSON.parse(JSON.stringify(projection))), 'utf8'),
      ]),
    )
    .digest('hex')
}

/**
 * Strict rebuild + freeze. Input-shape violations THROW (they are boundary
 * programming errors, not business outcomes); business non-reconstructibility
 * returns `not_reconstructible` for the boundary's review mapping.
 */
export function buildFrozenWorkDateAttributionV2(
  input: AttendanceFrozenAttributionBuildInputV1,
): AttendanceFrozenAttributionBuildResultV1 {
  const orgId = requireNonEmptyString(input.orgId, INVALID)
  const userId = requireNonEmptyString(input.userId, INVALID)
  if (!isAttendanceCalendarDateKeyV1(input.workDate)) fail(INVALID)
  const shiftId = requireNonEmptyString(input.shiftId, INVALID)
  const reasonCode = requireNonEmptyString(input.reasonCode, INVALID)
  const resolvedAtMs = strictInstantMs(input.resolvedAt)
  const timezone = requireNonEmptyString(input.timezone, INVALID)
  if (!isAttendanceWallTimeHHMMV1(input.workStartTime) || !isAttendanceWallTimeHHMMV1(input.workEndTime)) {
    fail(INVALID)
  }
  if (typeof input.isOvernight !== 'boolean') fail(INVALID)
  if (input.source !== 'live_resolution' && input.source !== 'scheduled_resolution') fail(INVALID)
  if (!Number.isInteger(input.attributionTailMinutes) || input.attributionTailMinutes < 0) fail(INVALID)
  if (!Array.isArray(input.approvedOvertimeWindows)) fail(INVALID)

  const candidateAbsoluteStartMs = strictInstantMs(input.candidateAbsoluteWindow?.startAt)
  const candidateAbsoluteEndMs = strictInstantMs(input.candidateAbsoluteWindow?.endAt)
  const candidateAttributionStartMs = strictInstantMs(input.candidateAttributionWindow?.startAt)
  const candidateAttributionEndMs = strictInstantMs(input.candidateAttributionWindow?.endAt)
  if (candidateAbsoluteEndMs <= candidateAbsoluteStartMs) fail(INVALID)

  // 1. Strict rebuild of the absolute shift window (no buildZonedDate, no UTC fallback).
  const startResolution = resolveAttendanceLocalWallTimeV1(input.workDate, input.workStartTime, 0, timezone)
  if (startResolution.posture !== 'unique') {
    return { kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_START_NOT_UNIQUE' }
  }
  const endResolution = resolveAttendanceLocalWallTimeV1(
    input.workDate,
    input.workEndTime,
    input.isOvernight ? 1 : 0,
    timezone,
  )
  if (endResolution.posture !== 'unique') {
    return { kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_END_NOT_UNIQUE' }
  }

  // 2. Instant-for-instant equality with the candidate the resolver selected.
  if (startResolution.epochMs !== candidateAbsoluteStartMs) {
    return { kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_START_MISMATCH' }
  }
  if (endResolution.epochMs !== candidateAbsoluteEndMs) {
    return { kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_END_MISMATCH' }
  }

  // 3. Attribution window: same start; end = shift end + tail, or exactly one
  //    approved overtime end + tail (the extension must be explained by named
  //    approved evidence — never by an arbitrary caller-supplied instant).
  if (candidateAttributionStartMs !== candidateAbsoluteStartMs) {
    return { kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_WINDOW_START_MISMATCH' }
  }
  const tailMs = input.attributionTailMinutes * 60_000
  const baseEndMs = candidateAbsoluteEndMs + tailMs
  let extendedByApprovedOvertime = false
  if (candidateAttributionEndMs === baseEndMs) {
    extendedByApprovedOvertime = false
  } else if (candidateAttributionEndMs > baseEndMs) {
    const explained = input.approvedOvertimeWindows.some((entry) => {
      try {
        return strictInstantMs(entry.approvedEndAt) + tailMs === candidateAttributionEndMs
      } catch {
        return false
      }
    })
    if (!explained) {
      return { kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_WINDOW_END_UNEXPLAINED' }
    }
    extendedByApprovedOvertime = true
  } else {
    return { kind: 'not_reconstructible', code: 'W4C2_ATTRIBUTION_WINDOW_END_UNEXPLAINED' }
  }

  const windowEvidenceFingerprint = computeAttendanceWindowEvidenceFingerprintV1({
    attributionTailMinutes: input.attributionTailMinutes,
    approvedOvertimeWindows: input.approvedOvertimeWindows,
  })

  const value: FrozenWorkDateAttributionV2 = {
    schemaVersion: 2,
    resolverVersion: ATTENDANCE_W4C2_ATTRIBUTION_RESOLVER_VERSION_V1,
    orgId,
    userId,
    workDate: input.workDate,
    shiftId,
    reasonCode,
    resolvedAt: new Date(resolvedAtMs).toISOString(),
    absoluteWindow: {
      startAt: new Date(candidateAbsoluteStartMs).toISOString(),
      endAt: new Date(candidateAbsoluteEndMs).toISOString(),
    },
    attributionWindow: {
      startAt: new Date(candidateAttributionStartMs).toISOString(),
      endAt: new Date(candidateAttributionEndMs).toISOString(),
    },
    attributionTailMinutes: input.attributionTailMinutes,
    extendedByApprovedOvertime,
    windowEvidenceFingerprint,
    source: input.source,
  }
  return { kind: 'resolved_v2', attribution: { posture: 'resolved_v2', value } }
}
