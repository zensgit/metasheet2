export interface AttendanceCalculationHistoryInterval {
  readonly id: string
  readonly groupId: string
  readonly effectiveFrom: string
  readonly effectiveTo: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

export function readAttendanceCalculationMembershipHistory(
  payload: unknown,
  scope: { readonly orgId: string; readonly userId: string },
): readonly AttendanceCalculationHistoryInterval[] | null {
  if (
    typeof scope.orgId !== 'string' || !scope.orgId.trim()
    || typeof scope.userId !== 'string' || !scope.userId.trim()
    || !isRecord(payload) || payload.ok !== true
    || !isRecord(payload.data) || !Array.isArray(payload.data.items)
  ) return null

  const intervals: AttendanceCalculationHistoryInterval[] = []
  const ids = new Set<string>()
  for (const row of payload.data.items) {
    if (!isRecord(row)) return null
    const { id, groupId, effectiveFrom, effectiveTo } = row
    if (
      row.orgId !== scope.orgId || row.userId !== scope.userId
      || typeof id !== 'string' || !UUID_RE.test(id)
      || typeof groupId !== 'string' || !UUID_RE.test(groupId)
      || !isCalendarDate(effectiveFrom)
      || (effectiveTo !== null && !isCalendarDate(effectiveTo))
    ) return null
    if (effectiveTo !== null && effectiveTo < effectiveFrom) return null

    const canonicalId = id.toLowerCase()
    if (ids.has(canonicalId)) return null
    const previous = intervals[intervals.length - 1]
    // Both endpoints are inclusive; an open interval must be the last row.
    if (previous && (
      previous.effectiveTo === null || previous.effectiveTo >= effectiveFrom
    )) return null

    ids.add(canonicalId)
    intervals.push({ id, groupId, effectiveFrom, effectiveTo })
  }
  return intervals
}
