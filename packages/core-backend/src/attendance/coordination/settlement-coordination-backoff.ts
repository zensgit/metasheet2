/**
 * Attendance settlement coordination — backoff after a lost try (§3.2 step 3).
 *
 * 25 ms for the first retry, doubling each time, capped at 200 ms; then ±50% jitter; then clamped
 * to the remaining budget. The steps are applied in the order the lock lists them, so a capped
 * delay ranges over [100 ms, 300 ms) before the clamp. Randomness is injected.
 */
export const SETTLEMENT_COORDINATION_BACKOFF_START_MS = 25
export const SETTLEMENT_COORDINATION_BACKOFF_CAP_MS = 200

/** `retry` counts from 1; `random` returns values in [0, 1). */
export function settlementCoordinationBackoffMsV1(retry: number, random: () => number, remainingMs: number): number {
  const exponent = Math.max(0, Math.min(30, Math.floor(retry) - 1))
  const base = Math.min(SETTLEMENT_COORDINATION_BACKOFF_CAP_MS, SETTLEMENT_COORDINATION_BACKOFF_START_MS * 2 ** exponent)
  const jittered = base * (0.5 + Math.min(Math.max(random(), 0), 0.999_999))
  return Math.max(0, Math.min(jittered, remainingMs))
}
