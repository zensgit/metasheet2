// W4-1 (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §9 W4-1 / §4.3 / §6.1): fetch + state
// seam between `GET /api/attendance-admin/setup-readiness` (#4541) and the wizard shell
// (`AttendanceSetupReadiness.vue`). This module owns exactly three things:
//   1. loading the aggregate for an org (blank org → plugin DEFAULT_ORG_ID, same normalization as
//      `useAttendanceApprovalDirectoryReadiness`),
//   2. folding the HTTP outcome into the pure discriminator's input union
//      (`403 → forbidden`, `503 DB_NOT_READY → db_not_ready`, `200 valid → ok`; anything else —
//      400/401/500/network/malformed body — is a LOAD ERROR, which the shell renders fail-closed
//      as "unknown, go verify", never as complete (§3.2 / charter L232)), and
//   3. the §6.1 task-home "未完成" badge derivation (readiness-derived, NEVER visit-history):
//      badge ⇔ any of steps ①②③⑤ is non-`ready`; ④/⑥ advisory postures never trigger it
//      ("否则每个部署都会永久挂一个消不掉的红点").
//
// It does NOT touch the pure discriminator's contract (`attendanceSetupReadiness.ts` is consumed
// as-is), holds no DOM, and issues no writes (R1: the wizard is read-only end to end).

import { computed, ref, type Ref } from 'vue'
import { apiFetch as defaultApiFetch } from '../../utils/api'
import {
  ATTENDANCE_SETUP_STEP_IDS,
  deriveAttendanceSetupReadinessSteps,
  type AttendanceSetupReadinessInput,
  type AttendanceSetupReadinessResponse,
  type AttendanceSetupReadinessStepResult,
  type AttendanceSetupStepId,
} from './attendanceSetupReadiness'
import { resolveAttendanceReadinessOrgId } from './useAttendanceApprovalDirectoryReadiness'

type ApiFetchFn = (path: string, options?: RequestInit) => Promise<Response>

export const ATTENDANCE_SETUP_READINESS_ENDPOINT = '/api/attendance-admin/setup-readiness'

/** Router-path (base-free) form of the §3① platform-admin remediation deep link. This is the form
 *  handed to `router.push` — the router prepends its own history base. */
export const ATTENDANCE_SETUP_ADMIN_USERS_ROUTE_PATH = '/admin/users'

/** Resolve the §3① deep-link HREF against the app base (Vite `BASE_URL`, which is also the Vue
 *  Router history base — `createWebHistory(import.meta.env.BASE_URL)` in main.ts, base validated
 *  path-only in vite.config.ts). Under a `VITE_BASE_PATH` sub-path deploy (e.g. `/metasheet/`) a
 *  bare `/admin/users` href escapes the base and lands on the server root (404) — the anchor HREF
 *  must carry the base, while the router-push path must NOT. */
export function resolveAttendanceSetupAdminUsersHref(base: string | null | undefined): string {
  const trimmed = (base ?? '').trim()
  if (!trimmed || trimmed === '/') return ATTENDANCE_SETUP_ADMIN_USERS_ROUTE_PATH
  return `${trimmed.replace(/\/+$/, '')}${ATTENDANCE_SETUP_ADMIN_USERS_ROUTE_PATH}`
}

/** `error` = network failure / unexpected status / malformed body — the shell must render this
 *  fail-closed ("unknown, go verify"), never as ready (§3.2, charter L232). `loaded` covers the
 *  three derivable outcomes (ok / forbidden / db_not_ready): those fold into step rows. */
export type AttendanceSetupReadinessLoadState = 'idle' | 'loading' | 'loaded' | 'error'

const PUNCH_POLICY_POSTURES = new Set(['default', 'customized', 'unknown'])
const DELIVERY_RUNTIMES = new Set(['ready', 'not_ready', 'unknown'])
const EFFECTIVE_TIME_POSTURES = new Set(['immediate', 'scheduled', 'manual_activation', 'undeterminable'])

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** Enum-strict, fail-closed body validation: an out-of-domain enum value or a missing/mistyped key
 *  is MALFORMED (→ load error → "unknown" display), never silently defaulted (contract-bug rule:
 *  silent fallback on enum fields is forbidden). Returns the typed response or null. */
export function parseAttendanceSetupReadinessResponse(raw: unknown): AttendanceSetupReadinessResponse | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (typeof data.directoryLinked !== 'boolean') return null
  if (!isNonNegativeInteger(data.orgActiveMemberCount)) return null
  if (!isNonNegativeInteger(data.groupCount)) return null
  if (!isNonNegativeInteger(data.groupsWithMembers)) return null
  if (!isNonNegativeInteger(data.shiftCount)) return null
  if (!isNonNegativeInteger(data.scheduledShiftGroupCount)) return null
  if (!isNonNegativeInteger(data.activeRotationRuleCount)) return null
  if (typeof data.hasRotationRules !== 'boolean') return null
  if (!isNonNegativeInteger(data.approvalFlowCount)) return null
  if (typeof data.punchPolicyPosture !== 'string' || !PUNCH_POLICY_POSTURES.has(data.punchPolicyPosture)) return null
  if (typeof data.previewReady !== 'boolean') return null

  const notify = data.notify as Record<string, unknown> | null | undefined
  if (!notify || typeof notify !== 'object') return null
  if (typeof notify.deliveryRuntime !== 'string' || !DELIVERY_RUNTIMES.has(notify.deliveryRuntime)) return null
  if (notify.recipientScopeConfig !== 'unsupported') return null
  const binding = notify.orgRecipientBinding as Record<string, unknown> | null | undefined
  if (!binding || typeof binding !== 'object') return null
  if (!isNonNegativeInteger(binding.boundRecipientCount)) return null
  if (typeof binding.hasAnyBoundRecipient !== 'boolean') return null

  const perStep = data.perStep as Record<string, unknown> | null | undefined
  if (!perStep || typeof perStep !== 'object') return null
  for (const stepId of ATTENDANCE_SETUP_STEP_IDS) {
    const entry = perStep[stepId] as Record<string, unknown> | null | undefined
    if (!entry || typeof entry !== 'object') return null
    const effectiveTime = entry.effectiveTime as Record<string, unknown> | null | undefined
    if (!effectiveTime || typeof effectiveTime !== 'object') return null
    if (typeof effectiveTime.source !== 'string') return null
    if (typeof effectiveTime.posture !== 'string' || !EFFECTIVE_TIME_POSTURES.has(effectiveTime.posture)) return null
    // §3.2 four-state contract: `scheduled` MUST carry effectiveAt — a scheduled entry without it
    // is malformed, not "guess the time".
    if (effectiveTime.posture === 'scheduled' && typeof effectiveTime.effectiveAt !== 'string') return null
    if (effectiveTime.effectiveAt !== undefined && typeof effectiveTime.effectiveAt !== 'string') return null
  }

  return data as unknown as AttendanceSetupReadinessResponse
}

/** §6.1 (OD-W4-2(c)): the task-home entry's "未完成" hint. Condition = any of steps ①②③⑤ is
 *  non-`ready` — exactly the previewReady gating set. ④/⑥ advisory postures
 *  (`manual_review_required` / `unsupported` / notify `unknown`) MUST NOT trigger it. */
const SETUP_BADGE_GATING_STEP_IDS: readonly AttendanceSetupStepId[] = [
  'attendance-admin-user-access',
  'attendance-admin-groups',
  'attendance-admin-shifts',
  'attendance-admin-approval-flows',
]

export function deriveAttendanceSetupEntryNeedsAttention(
  steps: readonly AttendanceSetupReadinessStepResult[],
): boolean {
  if (steps.length === 0) return false
  return steps.some(
    (step) => SETUP_BADGE_GATING_STEP_IDS.includes(step.stepId) && step.status !== 'ready',
  )
}

/** Charter §8.3 org 切换 / §6.1: when a readiness-consuming surface (task home badge or wizard)
 *  becomes visible, a load is needed not only on first open (`idle`) but whenever the loaded org
 *  no longer matches the current target — otherwise the badge/matrix keeps showing the PREVIOUS
 *  org's verdict (stale claim about the wrong org). `loadedOrgId` is the composable's `lastOrgId`
 *  (normalized); `targetOrgId` must be normalized by the caller with
 *  `resolveAttendanceReadinessOrgId` before comparing. */
export function shouldReloadSetupReadinessOnSurfaceOpen(
  state: AttendanceSetupReadinessLoadState,
  loadedOrgId: string | null,
  targetOrgId: string,
): boolean {
  return state === 'idle' || loadedOrgId !== targetOrgId
}

interface UseAttendanceSetupReadinessOptions {
  apiFetch?: ApiFetchFn
  endpoint?: string
}

export function useAttendanceSetupReadiness({
  apiFetch = defaultApiFetch,
  endpoint = ATTENDANCE_SETUP_READINESS_ENDPOINT,
}: UseAttendanceSetupReadinessOptions = {}) {
  const state: Ref<AttendanceSetupReadinessLoadState> = ref('idle')
  const input: Ref<AttendanceSetupReadinessInput | null> = ref(null)
  const lastOrgId: Ref<string | null> = ref(null)
  // Monotonic request id: an older in-flight response must not overwrite a newer org's state
  // (same guard as useAttendanceApprovalDirectoryReadiness).
  let requestSeq = 0

  const steps = computed<AttendanceSetupReadinessStepResult[]>(() =>
    input.value ? deriveAttendanceSetupReadinessSteps(input.value) : [],
  )
  const summary = computed<AttendanceSetupReadinessResponse | null>(() =>
    input.value?.kind === 'ok' ? input.value.data : null,
  )
  const needsAttention = computed(() => deriveAttendanceSetupEntryNeedsAttention(steps.value))

  async function loadReadiness(orgId: string | null | undefined): Promise<void> {
    const normalized = resolveAttendanceReadinessOrgId(orgId)
    const seq = ++requestSeq
    lastOrgId.value = normalized
    state.value = 'loading'
    // Drop the previous org's rows immediately — a stale matrix must never render under a new org.
    input.value = null
    try {
      const params = new URLSearchParams({ orgId: normalized })
      const response = await apiFetch(`${endpoint}?${params.toString()}`)
      if (seq !== requestSeq) return
      if (response.status === 403) {
        input.value = { kind: 'forbidden' }
        state.value = 'loaded'
        return
      }
      const body = await response.json().catch(() => null) as
        | { ok?: boolean; data?: unknown; error?: { code?: string } }
        | null
      if (seq !== requestSeq) return
      if (response.status === 503 && body?.error?.code === 'DB_NOT_READY') {
        input.value = { kind: 'db_not_ready' }
        state.value = 'loaded'
        return
      }
      if (!response.ok) {
        state.value = 'error'
        return
      }
      const data = body?.ok ? parseAttendanceSetupReadinessResponse(body.data) : null
      if (!data) {
        state.value = 'error'
        return
      }
      input.value = { kind: 'ok', data }
      state.value = 'loaded'
    } catch {
      if (seq !== requestSeq) return
      input.value = null
      state.value = 'error'
    }
  }

  return {
    state,
    input,
    steps,
    summary,
    needsAttention,
    lastOrgId,
    loadReadiness,
  }
}
