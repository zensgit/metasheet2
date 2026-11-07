import { randomUuid } from '../../utils/uuid'
import { isAttendanceGroupId, normalizeAttendanceGroupReturnTo } from '../../router/attendanceGroupContextRoute'
import type { AttendanceGroupRouteWorkflowStage } from './attendanceGroupRouteHydration'

export type AttendanceGroupReturnIntent = {
  groupId: string
  stage: AttendanceGroupRouteWorkflowStage
  origin: string
  nonce: string
}

function safeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim().startsWith('/') || value.trim().startsWith('//')) return null
  try {
    const url = new URL(value.trim(), 'http://attendance.local')
    const origin = normalizeAttendanceGroupReturnTo(value)
    // Reject the normalizer's fallback for an unsafe input, rather than silently changing origin.
    if (url.origin !== 'http://attendance.local' || origin !== url.pathname + url.search + url.hash || url.pathname !== '/attendance') return null
    return origin.split('#', 1)[0]!
  } catch { return null }
}

function originKey(value: string): string {
  const url = new URL(value, 'http://attendance.local')
  url.searchParams.sort()
  return url.pathname + '?' + url.searchParams.toString()
}

// History carries intent only. Session/tenant comparisons and the current nonce remain private.
export function createAttendanceGroupReturnNavigation(readScope: () => string | null) {
  let scope = readScope()
  let nonce = randomUuid()
  function refresh(): boolean {
    const current = readScope()
    if (current === scope) return false
    scope = current
    nonce = randomUuid()
    return true
  }
  return {
    refresh,
    capture(groupId: unknown, stage: unknown, origin: string): AttendanceGroupReturnIntent | null {
      refresh()
      const source = safeOrigin(origin)
      if (!scope || !source || !isAttendanceGroupId(groupId)
        || (stage !== 'basics' && stage !== 'people' && stage !== 'schedule' && stage !== 'policies')) return null
      return { groupId, stage, origin: source, nonce }
    },
    read(value: unknown, origin?: string, canonicalGroupId?: string): AttendanceGroupReturnIntent | null {
      refresh()
      if (!scope || !value || typeof value !== 'object') return null
      const intent = value as Partial<AttendanceGroupReturnIntent>
      const source = safeOrigin(intent.origin)
      if (intent.nonce !== nonce || !isAttendanceGroupId(intent.groupId) || !source
        || (intent.stage !== 'basics' && intent.stage !== 'people'
          && intent.stage !== 'schedule' && intent.stage !== 'policies')) return null
      if (canonicalGroupId !== undefined && intent.groupId !== canonicalGroupId) return null
      if (origin !== undefined) {
        const destination = safeOrigin(origin)
        if (!destination || originKey(source) !== originKey(destination)) return null
      }
      return { groupId: intent.groupId, stage: intent.stage, origin: source, nonce }
    },
    clear() { scope = readScope(); nonce = randomUuid() },
  }
}
