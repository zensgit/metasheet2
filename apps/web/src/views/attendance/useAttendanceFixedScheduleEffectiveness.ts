// #4709 FSER-4 §3 (amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md` §3, RATIFIED
// `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): the ONE strict shared
// client/composable. It owns:
//   1. request-path construction for BOTH routes — GET only, groupId in the path, ZERO query
//      string and ZERO body. The `/me` route 400s on a body/query `userId`/`orgId` selector
//      (`resolveAttendanceFixedScheduleSelfRouteIdentity`, plugins/plugin-attendance/lib/
//      attendance-fixed-schedule-self-route-identity.cjs) — this composable structurally cannot
//      construct one, the same discipline `useAttendanceDecisionTrace.ts` uses for its self host.
//      (This also disposes of the amendment's §2 open item for this slice: a GET with no body and
//      no selector is unaffected by either reading of "no body".)
//   2. stale-response suppression (a monotonic request generation — an older in-flight response
//      must never overwrite a newer target's state),
//   3. folding the HTTP outcome + strict parse into a closed `unavailableReason` set — 401/403/404/
//      503/malformed JSON/unknown enum value/response-shape mismatch all become an explicit
//      unavailable posture; NONE of them is ever rendered as one of the four states (amendment §3).
//
// It exposes two load methods and NO status derivation beyond the closed parse in
// `attendanceFixedScheduleEffectiveness.ts` — `state`/`reasonCodes`/`applicability` are forwarded
// verbatim. Every surface must go through this composable (or the pure parse functions it wraps)
// rather than re-deriving the four-state contract (gate 7).

import { ref, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../../utils/api'
import {
  parseAttendanceGroupFixedScheduleAdminResponse,
  parseAttendanceGroupFixedScheduleSelfResponse,
  type AttendanceGroupFixedScheduleAdminResult,
  type AttendanceGroupFixedScheduleSelfResult,
} from './attendanceFixedScheduleEffectiveness'

type ApiFetchFn = (path: string, options?: RequestInit) => Promise<Response>

export type AttendanceFixedScheduleEffectivenessLoadState = 'idle' | 'loading' | 'loaded' | 'error'

/** Closed unavailable-posture set (amendment §3). `error` is the generic fail-closed catch-all
 *  (network failure, unexpected HTTP status, or any outcome not covered by a named leg). */
export type AttendanceFixedScheduleEffectivenessUnavailableReason =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'db_not_ready'
  | 'malformed'
  | 'shape_mismatch'
  | 'error'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Path-only request URL — no query string, no body, ever. Returns null for a non-UUID groupId
 *  (fail closed locally, zero wire traffic — mirrors the decision-trace composable's discipline). */
export function buildAttendanceGroupFixedScheduleAdminPath(groupId: string): string | null {
  const trimmed = groupId.trim()
  if (!UUID_RE.test(trimmed)) return null
  return `/api/attendance/groups/${trimmed}/fixed-schedule/effectiveness`
}

export function buildAttendanceGroupFixedScheduleSelfPath(groupId: string): string | null {
  const trimmed = groupId.trim()
  if (!UUID_RE.test(trimmed)) return null
  return `/api/attendance/groups/${trimmed}/fixed-schedule/effectiveness/me`
}

interface UseAttendanceFixedScheduleEffectivenessOptions {
  apiFetch?: ApiFetchFn
}

export function useAttendanceFixedScheduleEffectiveness({
  apiFetch = defaultApiFetch,
}: UseAttendanceFixedScheduleEffectivenessOptions = {}) {
  const state: Ref<AttendanceFixedScheduleEffectivenessLoadState> = ref('idle')
  const admin: Ref<AttendanceGroupFixedScheduleAdminResult | null> = ref(null)
  const self: Ref<AttendanceGroupFixedScheduleSelfResult | null> = ref(null)
  const unavailableReason: Ref<AttendanceFixedScheduleEffectivenessUnavailableReason | null> = ref(null)
  let requestSeq = 0

  function resolveUnavailableReasonFromStatus(
    status: number,
    body: { ok?: boolean; error?: { code?: string } } | null,
  ): AttendanceFixedScheduleEffectivenessUnavailableReason {
    if (status === 401) return 'unauthorized'
    if (status === 403) return 'forbidden'
    if (status === 404) return 'not_found'
    if (status === 503 && body?.error?.code === 'DB_NOT_READY') return 'db_not_ready'
    return 'error'
  }

  async function load(
    path: string | null,
    parse: (data: unknown) => unknown,
    assign: (result: any) => void,
  ): Promise<void> {
    const seq = ++requestSeq
    if (!path) {
      admin.value = null
      self.value = null
      unavailableReason.value = 'malformed'
      state.value = 'error'
      return
    }
    state.value = 'loading'
    admin.value = null
    self.value = null
    unavailableReason.value = null
    try {
      const response = await apiFetch(path)
      if (seq !== requestSeq) return
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: unknown; error?: { code?: string } }
        | null
      if (seq !== requestSeq) return
      if (!response.ok) {
        unavailableReason.value = resolveUnavailableReasonFromStatus(response.status, body)
        state.value = 'error'
        return
      }
      if (!body || body.ok !== true) {
        unavailableReason.value = 'malformed'
        state.value = 'error'
        return
      }
      const parsed = parse(body.data)
      if (!parsed) {
        // Strict parse failure covers: malformed JSON already handled above, an unknown
        // state/reasonCode/applicability value, and a response-shape mismatch (missing/mistyped
        // field, or — self shape — a forbidden key at any depth). All fold to the same posture:
        // amendment §3 forbids ever rendering an error as one of the four states.
        unavailableReason.value = 'shape_mismatch'
        state.value = 'error'
        return
      }
      assign(parsed)
      unavailableReason.value = null
      state.value = 'loaded'
    } catch {
      if (seq !== requestSeq) return
      admin.value = null
      self.value = null
      unavailableReason.value = 'error'
      state.value = 'error'
    }
  }

  async function loadGroupEffectiveness(groupId: string): Promise<void> {
    await load(
      buildAttendanceGroupFixedScheduleAdminPath(groupId),
      parseAttendanceGroupFixedScheduleAdminResponse,
      (result: AttendanceGroupFixedScheduleAdminResult) => { admin.value = result },
    )
  }

  async function loadSelfEffectiveness(groupId: string): Promise<void> {
    await load(
      buildAttendanceGroupFixedScheduleSelfPath(groupId),
      parseAttendanceGroupFixedScheduleSelfResponse,
      (result: AttendanceGroupFixedScheduleSelfResult) => { self.value = result },
    )
  }

  function reset(): void {
    requestSeq += 1
    state.value = 'idle'
    admin.value = null
    self.value = null
    unavailableReason.value = null
  }

  return { state, admin, self, unavailableReason, loadGroupEffectiveness, loadSelfEffectiveness, reset }
}
