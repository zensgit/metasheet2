/**
 * Frozen-top-rows view.config helper (#5863 follow-on to frozen-columns.ts).
 *
 * `view.config` is freeform JSON (`Record<string, unknown>`); `frozenTopRowCount` is read with a
 * NARROW helper so dirty/invalid config can never reach the sticky-offset math. Strict: only a
 * finite integer in [0, MAX_FROZEN_TOP_ROWS] passes; anything else (string, float, negative,
 * over-cap, NaN, missing) → 0. Mirrors `parseFrozenIds`'s all-or-nothing narrowing (Design §1/§7).
 */
export const MAX_FROZEN_TOP_ROWS = 10

export function parseFrozenTopRowCount(config: Record<string, unknown> | null | undefined): number {
  const value = config?.frozenTopRowCount
  if (typeof value !== 'number' || !Number.isInteger(value)) return 0
  if (value < 0 || value > MAX_FROZEN_TOP_ROWS) return 0
  return value
}
