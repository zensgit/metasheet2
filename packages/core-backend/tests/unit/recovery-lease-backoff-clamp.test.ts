/**
 * O2-A2 (adversarial gate P3-2) — recoveryLeaseBackoffDelayMs clamp negatives.
 *
 * The clamp (`Number.isFinite(value) && value > 0 ? Math.floor(value) : 0`) defended
 * against non-finite/≤0 rungs but had no negative-input test — a dead defence. These
 * are exact positive equalities (never notEqual): a poisoned rung must clamp to
 * EXACTLY 0 (sleep(0) — no hang, no NaN timer), and well-formed rungs must be
 * untouched. Deleting the clamp turns the negatives red (mutation-proven in the O2-A
 * evidence log: `return Math.floor(value)` reds the NaN/-1/0/Infinity cases).
 */

import { describe, expect, it } from 'vitest'
import {
  RECOVERY_LEASE_BACKOFF_DELAYS_MS,
  recoveryLeaseBackoffDelayMs,
} from '../../src/multitable/exact-anchor-recovery-execute'

describe('recoveryLeaseBackoffDelayMs — poisoned-rung clamp (exact equalities)', () => {
  it('a NaN rung clamps to exactly 0', () => {
    expect(recoveryLeaseBackoffDelayMs(1, [Number.NaN])).toBe(0)
  })

  it('a negative rung clamps to exactly 0', () => {
    expect(recoveryLeaseBackoffDelayMs(1, [-1])).toBe(0)
  })

  it('a zero rung clamps to exactly 0 (zero is not a positive delay)', () => {
    expect(recoveryLeaseBackoffDelayMs(1, [0])).toBe(0)
  })

  it('an Infinity rung clamps to exactly 0 (never an unbounded sleep)', () => {
    expect(recoveryLeaseBackoffDelayMs(1, [Number.POSITIVE_INFINITY])).toBe(0)
  })

  it('a poisoned MIDDLE rung clamps to 0 while its healthy neighbours are untouched', () => {
    const delays = [50, Number.NaN, 200]
    expect(recoveryLeaseBackoffDelayMs(1, delays)).toBe(50)
    expect(recoveryLeaseBackoffDelayMs(2, delays)).toBe(0)
    expect(recoveryLeaseBackoffDelayMs(3, delays)).toBe(200)
  })

  it('a fractional positive rung floors (still a positive, finite ms count)', () => {
    expect(recoveryLeaseBackoffDelayMs(1, [50.9])).toBe(50)
  })

  it('POSITIVE CONTROL: healthy rungs pass through exactly (the clamp is not a blanket zero)', () => {
    expect(recoveryLeaseBackoffDelayMs(1, [50, 100, 200])).toBe(50)
    expect(recoveryLeaseBackoffDelayMs(2, [50, 100, 200])).toBe(100)
    // Attempt beyond the ladder repeats the last rung.
    expect(recoveryLeaseBackoffDelayMs(99, [50, 100, 200])).toBe(200)
    // And the REAL module constant ladder is healthy end-to-end.
    for (let attempt = 1; attempt <= RECOVERY_LEASE_BACKOFF_DELAYS_MS.length + 1; attempt++) {
      const expected = RECOVERY_LEASE_BACKOFF_DELAYS_MS[
        Math.min(attempt, RECOVERY_LEASE_BACKOFF_DELAYS_MS.length) - 1
      ]
      expect(recoveryLeaseBackoffDelayMs(attempt)).toBe(expected)
    }
  })

  it('poisoned ATTEMPT indexes never produce a poisoned delay (NaN/0/negative/Infinity attempts)', () => {
    const delays = [50, 100, 200]
    // Attempt < 1 clamps up to the first rung.
    expect(recoveryLeaseBackoffDelayMs(0, delays)).toBe(50)
    expect(recoveryLeaseBackoffDelayMs(-5, delays)).toBe(50)
    // Attempt = Infinity clamps down to the last rung.
    expect(recoveryLeaseBackoffDelayMs(Number.POSITIVE_INFINITY, delays)).toBe(200)
    // Attempt = NaN indexes nothing — the clamp returns exactly 0, never NaN.
    expect(recoveryLeaseBackoffDelayMs(Number.NaN, delays)).toBe(0)
  })

  it('an empty ladder yields exactly 0 (pre-existing pin, kept here with the negatives)', () => {
    expect(recoveryLeaseBackoffDelayMs(1, [])).toBe(0)
  })
})
