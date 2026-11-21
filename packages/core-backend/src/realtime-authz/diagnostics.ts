/**
 * In-process record of realtime admission state for administrators.
 *
 * Holds reason codes, counters and timestamps only: no user id, no credential, no business value.
 * It is read through an authenticated, administrator-only route. Nothing recorded here is reflected
 * in the public health endpoint, whose status and fields are unchanged by any notice.
 */
import type { AdmissionDecision, AdmissionNotice, AdmissionRow } from './admission'

export type RealtimeDiagnosticEvent =
  | 'authority-read-unknown'
  | 'handshake-refused'
  | 'handshake-held'
  | 'connection-terminated'
  | 'delivery-withheld'
  | 'inbound-withheld'
  | 'installation-probe-undetermined'
  | 'listener-interrupted'
  | 'full-revalidation'
  | 'database-identity-changed'

export interface RealtimeDiagnosticsSnapshot {
  readonly admission: {
    readonly row: AdmissionRow
    readonly ordinaryHandshake: string
    readonly strictHandshake: string
    readonly established: string
    readonly listenerRequired: boolean
    readonly decidedAt: string | null
  }
  readonly notices: ReadonlyArray<{
    readonly code: AdmissionNotice
    readonly active: boolean
    readonly count: number
    readonly firstSeenAt: string
    readonly lastSeenAt: string
  }>
  readonly events: ReadonlyArray<{ readonly code: RealtimeDiagnosticEvent; readonly count: number; readonly lastAt: string }>
}

type NoticeState = { active: boolean; count: number; firstSeenAt: string; lastSeenAt: string }
type EventState = { count: number; lastAt: string }

export interface RealtimeDiagnostics {
  recordDecision(decision: AdmissionDecision): void
  recordEvent(event: RealtimeDiagnosticEvent, count?: number): void
  snapshot(): RealtimeDiagnosticsSnapshot
}

export function createRealtimeDiagnostics(now: () => Date = () => new Date()): RealtimeDiagnostics {
  let decision: AdmissionDecision | null = null
  let decidedAt: string | null = null
  const notices = new Map<AdmissionNotice, NoticeState>()
  const events = new Map<RealtimeDiagnosticEvent, EventState>()

  return {
    recordDecision(next) {
      const at = now().toISOString()
      decision = next
      decidedAt = at
      const current = new Set(next.notices)
      for (const [code, state] of notices) state.active = current.has(code)
      for (const code of current) {
        const state = notices.get(code)
        if (state) {
          state.count += 1
          state.lastSeenAt = at
          state.active = true
        } else {
          notices.set(code, { active: true, count: 1, firstSeenAt: at, lastSeenAt: at })
        }
      }
    },
    recordEvent(event, count = 1) {
      const at = now().toISOString()
      const state = events.get(event)
      if (state) {
        state.count += count
        state.lastAt = at
      } else {
        events.set(event, { count, lastAt: at })
      }
    },
    snapshot() {
      return {
        admission: {
          row: decision?.row ?? 'undetermined',
          ordinaryHandshake: decision?.ordinaryHandshake ?? 'refuse',
          strictHandshake: decision?.strictHandshake ?? 'refuse',
          established: decision?.established ?? 'suspend',
          listenerRequired: decision?.listenerRequired ?? false,
          decidedAt,
        },
        notices: [...notices.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([code, state]) => ({ code, ...state })),
        events: [...events.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([code, state]) => ({ code, ...state })),
      }
    },
  }
}

/** Process-wide instance read by the administrator route and written by the realtime runtime. */
export const realtimeDiagnostics: RealtimeDiagnostics = createRealtimeDiagnostics()
