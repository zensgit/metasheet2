// Punch outcome clarity (frontend-only, 2026-07-05 design-lock): pure
// classification of what a `/api/attendance/punch` response means for the
// user. `AttendanceView.vue`'s `punch()` calls these so the three dead-ends
// below are shown clearly instead of falling into the generic status-error
// path (which was built for admin/import/settings flows, not punch).
//
// See docs/development/attendance-punch-outcome-clarity-design-lock-20260705.md.
// Current-state anchors (2026-07-05, `plugins/plugin-attendance/index.cjs`):
//   - G1 202 pendingApproval: the outdoor-approval punch branch, ~L24202-24296.
//     `requireApproval === true` + outside-fence (or an explicit
//     `meta.outdoor`/`meta.outdoorPunch` marker, which this slice never sends)
//     creates a pending `outdoor_punch` request and responds
//     `202 { ok:true, data:{ pendingApproval:true, request } }` — NO
//     `attendance_events`/`attendance_records` row is written.
//   - G2 OUTDOOR_NOTE_REQUIRED 422: same branch, ~L24207-24211. The accepted
//     note field is `meta.note` (`punchMeta.note` at ~L24203/24207) — a string
//     inside the punch payload's existing `meta` record, NOT a new top-level
//     field. The punch schema (~L21548-21557) already accepts an optional
//     `meta: z.record(z.unknown())`, so the retry payload below needs no
//     backend change.
//   - G3 LOCATION_RESTRICTED 403: `enforcePunchConstraints`, ~L19535-19541 —
//     thrown BEFORE the outdoor branch runs, only when
//     `requireApproval !== true` (the default/no-outdoor-approval org).
//
// Hard boundaries (carried over from the design-lock, enforced by the caller):
// no geolocation collection, no injected `meta.outdoor` marker, no new/changed
// backend behavior. The only extra field this module ever adds to a retry
// payload is the already-accepted `meta.note` string.

export type PunchEventType = 'check_in' | 'check_out'

export type TranslateFn = (en: string, zh: string) => string

/** Parsed `data` of a 2xx `/api/attendance/punch` response body. */
export interface PunchSuccessData {
  pendingApproval?: boolean
}

export type PunchSuccessOutcomeKind = 'recorded' | 'pendingApproval'

export interface PunchSuccessOutcome {
  kind: PunchSuccessOutcomeKind
  /** Status-bar message. Always non-empty for a 2xx response. */
  message: string
  /**
   * `pendingApproval` writes NO attendance fact — only the requests list
   * changed (a new pending `outdoor_punch` request), so the caller should
   * refresh that list instead of the full overview. A normal recorded punch
   * keeps the caller's existing full-refresh behavior.
   */
  shouldRefreshRequests: boolean
}

/**
 * Classify a successful (2xx, `data.ok !== false`) `/api/attendance/punch`
 * response. `data.pendingApproval === true` MUST NOT read as "recorded" — the
 * punch fact was not written server-side; it is pending approval instead.
 */
export function classifyPunchSuccessOutcome(
  eventType: PunchEventType,
  data: PunchSuccessData | null | undefined,
  tr: TranslateFn,
): PunchSuccessOutcome {
  if (data && data.pendingApproval === true) {
    return {
      kind: 'pendingApproval',
      message: tr(
        'Outdoor punch submitted for approval; it will count once approved.',
        '外勤打卡已提交审批，通过后计入考勤',
      ),
      shouldRefreshRequests: true,
    }
  }
  return {
    kind: 'recorded',
    message: tr(
      `${eventType === 'check_in' ? 'Check in' : 'Check out'} recorded.`,
      `${eventType === 'check_in' ? '上班打卡' : '下班打卡'}已记录。`,
    ),
    shouldRefreshRequests: false,
  }
}

/** Minimal shape read off the thrown `AttendanceApiError`-like error. */
export interface PunchErrorInput {
  status?: number
  code?: string
}

export type PunchErrorOutcomeKind = 'noteRequired' | 'locationRestricted'

export interface PunchErrorOutcome {
  kind: PunchErrorOutcomeKind
  message: string
  /** Structured status code, kept so the banner can still surface it (existing `meta.code` convention). */
  code: string
  /** Whether the caller should show the inline outdoor-note input + one-click retry affordance. */
  showNoteRetry: boolean
}

/**
 * Classify an errored `/api/attendance/punch` response for the two dead-ends
 * this slice fixes (G2/G3). Returns `null` for every other code/status —
 * enum-strict: the caller MUST fall through to its existing generic
 * error-status handling unchanged (this function makes no other decision).
 */
export function classifyPunchErrorOutcome(
  error: PunchErrorInput | null | undefined,
  tr: TranslateFn,
): PunchErrorOutcome | null {
  const code = String(error?.code || '').trim().toUpperCase()
  if (code === 'OUTDOOR_NOTE_REQUIRED') {
    return {
      kind: 'noteRequired',
      message: tr(
        'Outdoor punch needs a note before it can be submitted. Add one below and retry.',
        '外勤打卡需要填写备注后才能提交，请在下方补充后重试。',
      ),
      code: 'OUTDOOR_NOTE_REQUIRED',
      showNoteRetry: true,
    }
  }
  if (code === 'LOCATION_RESTRICTED') {
    return {
      kind: 'locationRestricted',
      message: tr(
        'Your current location is outside the allowed punch range, and outdoor-punch approval is not enabled for this organization. Contact an administrator if you need to punch outdoors.',
        '当前位置在允许打卡范围外，且本组织未启用外勤审批；如需外勤打卡请联系管理员',
      ),
      code: 'LOCATION_RESTRICTED',
      showNoteRetry: false,
    }
  }
  return null
}

/** The fields a normal (non-retry) punch already sends. */
export interface PunchRetryBasePayload {
  eventType: PunchEventType
  timezone: string
  orgId?: string
}

export interface PunchRetryWithNotePayload extends PunchRetryBasePayload {
  meta: { note: string }
}

/**
 * Build the retry payload for an `OUTDOOR_NOTE_REQUIRED` retry: exactly the
 * fields the initial punch sent, plus the backend-accepted `meta.note`
 * string — nothing else (no `location`, no `meta.outdoor`). Pure so the exact
 * wire shape is unit-testable without a network mock.
 */
export function buildPunchRetryWithNotePayload(
  base: PunchRetryBasePayload,
  note: string,
): PunchRetryWithNotePayload {
  return {
    ...base,
    meta: { note: note.trim() },
  }
}
