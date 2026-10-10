export const ATTENDANCE_CLOCK_MAX_RTT_MS = 5_000
export const ATTENDANCE_CLOCK_FRESHNESS_MS = 300_000
export const ATTENDANCE_CLOCK_RESAMPLE_MS = 60_000

// A response-receive anchor. Wall time is deliberately not an input.
export function createAttendanceServerClock() {
  let version = 0
  let anchor: { instant: number; received: number } | null = null

  function invalidate(): void {
    version += 1
    anchor = null
  }

  function accept(request: number, resolvedAt: unknown, sent: number, received: number): boolean {
    if (request !== version) return false
    const instant = typeof resolvedAt === 'string' ? Date.parse(resolvedAt) : NaN
    if (!Number.isFinite(instant) || new Date(instant).toISOString() !== resolvedAt
      || !Number.isFinite(sent) || !Number.isFinite(received) || sent < 0
      || received < sent || received - sent > ATTENDANCE_CLOCK_MAX_RTT_MS) {
      anchor = null
      return false
    }
    anchor = { instant, received }
    return true
  }

  function now(monotonicNow: number): Date | null {
    if (!anchor) return null
    const elapsed = monotonicNow - anchor.received
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= ATTENDANCE_CLOCK_FRESHNESS_MS) {
      anchor = null
      return null
    }
    const result = new Date(anchor.instant + elapsed)
    return Number.isFinite(result.getTime()) ? result : null
  }

  return {
    beginSample: () => ++version,
    accept,
    now,
    invalidate,
    fail: (request: number) => { if (request === version) anchor = null },
  }
}
