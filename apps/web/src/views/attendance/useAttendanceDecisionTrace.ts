// W5-1 (Wave 5 explainability design-lock, RATIFIED §4/§6/§9 W5-1): fetch + state seam between the
// W5-0 dual-host decision-trace endpoints (#4557) and the display component. Owns exactly:
//   1. canonical request-path construction for BOTH hosts (admin carries orgId+userId; self NEVER
//      carries userId — §4.1 "绝不接受 userId 参数" is enforced by construction here: there is no
//      code path that can put a userId on the self URL),
//   2. folding the HTTP outcome into a closed error-kind set (403 → forbidden; 404
//      DECISION_TRACE_TARGET_NOT_FOUND → not_found; 503 DB_NOT_READY → db_not_ready; 400
//      ORG_ID_REQUIRED → org_required (self multi-org leg 3); anything else → error, rendered
//      fail-closed — never as a fabricated explanation),
//   3. strict whitelist parse via the pure module (malformed body → error, never partial render).
//
// R1 (read-only): this composable issues EXACTLY ONE GET per load and nothing else — no writes,
// no config calls. R3 (no reassembly): it NEVER fetches a second endpoint to join/enrich masked
// fields — the trace response is rendered as-is (the wiring spec asserts the single-fetch contract
// at the mock layer; adding an enrichment fetch here must turn that leg red).

import { ref, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../../utils/api'
import {
  isAttendanceDecisionTraceCategory,
  parseAttendanceDecisionTraceResponse,
  type AttendanceDecisionTraceCategory,
  type AttendanceDecisionTraceParsed,
} from './attendanceDecisionTrace'

type ApiFetchFn = (path: string, options?: RequestInit) => Promise<Response>

export const ATTENDANCE_ADMIN_DECISION_TRACE_ENDPOINT = '/api/attendance-admin/decision-trace'
export const ATTENDANCE_SELF_DECISION_TRACE_ENDPOINT = '/api/attendance/decision-trace'

export type AttendanceDecisionTraceHost = 'admin' | 'self'
export type AttendanceDecisionTraceLoadState = 'idle' | 'loading' | 'loaded' | 'error'
export type AttendanceDecisionTraceErrorKind =
  | 'invalid_target'
  | 'forbidden'
  | 'not_found'
  | 'db_not_ready'
  | 'org_required'
  | 'error'

export interface AttendanceDecisionTraceTarget {
  category: AttendanceDecisionTraceCategory
  workDate?: string
  requestId?: string
  instanceId?: string
}

const TRACE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// Mirrors the backend's `UUID_RE` requirement for ④ requestId (route parse, `attendance-admin.ts`).
const TRACE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Canonical QUERY-form request path (R2: zero hash — the R2 spec leg asserts no `#` can ever
 *  appear in a built path). Returns null when the target is invalid — an invalid target is NEVER
 *  sent to the wire (UI-side self-validation), the caller surfaces `invalid_target` instead. */
export function buildAttendanceDecisionTraceRequestPath(
  host: AttendanceDecisionTraceHost,
  target: AttendanceDecisionTraceTarget,
  scope: { orgId?: string; userId?: string } = {},
): string | null {
  if (!isAttendanceDecisionTraceCategory(target.category)) return null
  const params = new URLSearchParams()
  if (host === 'admin') {
    const orgId = (scope.orgId ?? '').trim()
    const userId = (scope.userId ?? '').trim()
    if (!orgId || !userId) return null
    params.set('orgId', orgId)
    params.set('userId', userId)
  }
  params.set('category', target.category)
  if (target.category === 'today_status' || target.category === 'late_early' || target.category === 'missing_punch') {
    const workDate = (target.workDate ?? '').trim()
    if (!TRACE_DATE_RE.test(workDate)) return null
    params.set('workDate', workDate)
  } else if (target.category === 'overtime_segmentation') {
    const requestId = (target.requestId ?? '').trim()
    if (!TRACE_UUID_RE.test(requestId)) return null
    params.set('requestId', requestId)
  } else if (target.category === 'approver_source') {
    const instanceId = (target.instanceId ?? '').trim()
    if (!instanceId) return null
    params.set('instanceId', instanceId)
  }
  // comp_time_balance carries no extra target (org+user scoped server-side).
  if (host === 'self') {
    // §4.1 self multi-org leg 4: orgId is an OPTIONAL validated selection — appended last, only
    // when the caller provides one. `userId` is structurally impossible on this branch.
    const orgId = (scope.orgId ?? '').trim()
    if (orgId) params.set('orgId', orgId)
    return `${ATTENDANCE_SELF_DECISION_TRACE_ENDPOINT}?${params.toString()}`
  }
  return `${ATTENDANCE_ADMIN_DECISION_TRACE_ENDPOINT}?${params.toString()}`
}

interface UseAttendanceDecisionTraceOptions {
  apiFetch?: ApiFetchFn
}

export function useAttendanceDecisionTrace({ apiFetch = defaultApiFetch }: UseAttendanceDecisionTraceOptions = {}) {
  const state: Ref<AttendanceDecisionTraceLoadState> = ref('idle')
  const trace: Ref<AttendanceDecisionTraceParsed | null> = ref(null)
  const errorKind: Ref<AttendanceDecisionTraceErrorKind | null> = ref(null)
  // Monotonic request id — an older in-flight response must not overwrite a newer target's state
  // (same guard as useAttendanceSetupReadiness).
  let requestSeq = 0

  async function loadTrace(
    host: AttendanceDecisionTraceHost,
    target: AttendanceDecisionTraceTarget,
    scope: { orgId?: string; userId?: string } = {},
  ): Promise<void> {
    const seq = ++requestSeq
    const path = buildAttendanceDecisionTraceRequestPath(host, target, scope)
    if (!path) {
      // Invalid target: fail closed locally, ZERO wire traffic.
      trace.value = null
      errorKind.value = 'invalid_target'
      state.value = 'error'
      return
    }
    state.value = 'loading'
    trace.value = null
    errorKind.value = null
    try {
      const response = await apiFetch(path)
      if (seq !== requestSeq) return
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: unknown; error?: { code?: string } }
        | null
      if (seq !== requestSeq) return
      if (response.status === 403) {
        errorKind.value = 'forbidden'
        state.value = 'error'
        return
      }
      if (response.status === 404) {
        errorKind.value = 'not_found'
        state.value = 'error'
        return
      }
      if (response.status === 503 && body?.error?.code === 'DB_NOT_READY') {
        errorKind.value = 'db_not_ready'
        state.value = 'error'
        return
      }
      if (response.status === 400 && body?.error?.code === 'ORG_ID_REQUIRED') {
        errorKind.value = 'org_required'
        state.value = 'error'
        return
      }
      if (!response.ok) {
        errorKind.value = 'error'
        state.value = 'error'
        return
      }
      const parsed = body?.ok ? parseAttendanceDecisionTraceResponse(body.data) : null
      if (!parsed || parsed.category !== target.category) {
        // Malformed body OR a category mismatch (a response claiming a different category than
        // requested is a contract violation) — fail closed, never partial render.
        errorKind.value = 'error'
        state.value = 'error'
        return
      }
      trace.value = parsed
      errorKind.value = null
      state.value = 'loaded'
    } catch {
      if (seq !== requestSeq) return
      trace.value = null
      errorKind.value = 'error'
      state.value = 'error'
    }
  }

  function resetTrace(): void {
    requestSeq += 1
    state.value = 'idle'
    trace.value = null
    errorKind.value = null
  }

  return { state, trace, errorKind, loadTrace, resetTrace }
}
