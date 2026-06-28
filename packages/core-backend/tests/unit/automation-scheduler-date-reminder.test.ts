/**
 * DR-A/DR-B fake-timer GOLDEN for `schedule.date_field` scheduling.
 *
 * Closes the timing gap the owner found: `timeOfDay` must drive WHEN the scan runs, not just gate the
 * due-predicate. Before this, the scan was a boot-anchored `setInterval` — a rule for 09:00 fired whenever
 * the daily tick landed relative to server boot (up to ~18h late) and the cadence was untested. These pin:
 *   G1/G2 — boot 03:00 + rule 09:00: NOT fired at register; fires once exactly at 09:00 (no boot anchor).
 *   G3    — restart at 10:00 (today's 09:00 already passed): ONE immediate bounded catch-up scan.
 *   G4    — after the 09:00 fire it re-arms for the NEXT day: no same-day double; fires again at next 09:00.
 *   G5    — unregister cancels the pending aligned timer.
 *
 * Scope: this is the TIMING axis (a counting callback). The owner's "no duplicate across restart" and
 * "fresh rule never backfills" are SERVICE-level guarantees (the claim-ledger + the firing-window predicate)
 * and stay locked by the real-DB integration (DR-2 dedup / DR-3 backfill) + the pure firing-window unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AutomationScheduler } from '../../src/multitable/automation-scheduler'
import type { AutomationRule } from '../../src/multitable/automation-executor'

const H = 60 * 60 * 1000

function makeDateFieldRule(id: string, timeOfDay = '09:00'): AutomationRule {
  return {
    id,
    name: `rule ${id}`,
    sheetId: 'sht_test',
    trigger: {
      type: 'schedule.date_field',
      config: { dateFieldId: 'fld_due', offsetDays: 3, direction: 'before', timeOfDay },
    },
    actions: [],
    enabled: true,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('AutomationScheduler — schedule.date_field timeOfDay alignment (DR-A/DR-B fake-timer golden)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('G1+G2: boot 03:00 UTC + rule 09:00 → NOT fired at register; fires once AT 09:00 (no boot anchor)', () => {
    vi.setSystemTime(new Date('2026-06-25T03:00:00.000Z'))
    const cb = vi.fn()
    const s = new AutomationScheduler(cb) // no leaderOptions ⇒ leader
    s.register(makeDateFieldRule('r1', '09:00'))

    expect(cb).not.toHaveBeenCalled() // 03:00 < 09:00 → no catch-up; armed for today 09:00
    vi.advanceTimersByTime(5 * H + 59 * 60 * 1000) // → 08:59 — still nothing
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60 * 1000) // → 09:00
    expect(cb).toHaveBeenCalledTimes(1)
    s.destroy()
  })

  it('G3: restart at 10:00 (today 09:00 already passed) → ONE immediate bounded catch-up scan', () => {
    vi.setSystemTime(new Date('2026-06-25T10:00:00.000Z'))
    const cb = vi.fn()
    const s = new AutomationScheduler(cb)
    s.register(makeDateFieldRule('r2', '09:00'))

    expect(cb).toHaveBeenCalledTimes(1) // catch-up; the firing-window predicate bounds what it actually fires
    s.destroy()
  })

  it('G4: after the 09:00 fire it re-arms for the NEXT day — no same-day double; fires again at next 09:00', () => {
    vi.setSystemTime(new Date('2026-06-25T03:00:00.000Z'))
    const cb = vi.fn()
    const s = new AutomationScheduler(cb)
    s.register(makeDateFieldRule('r3', '09:00'))

    vi.advanceTimersByTime(6 * H) // → 09:00, fire #1
    expect(cb).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(12 * H) // → 21:00 same day — re-armed for next day, no fire
    expect(cb).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(12 * H) // → next day 09:00, fire #2
    expect(cb).toHaveBeenCalledTimes(2)
    s.destroy()
  })

  it('G5: unregister cancels the pending aligned timer — never fires after', () => {
    vi.setSystemTime(new Date('2026-06-25T03:00:00.000Z'))
    const cb = vi.fn()
    const s = new AutomationScheduler(cb)
    s.register(makeDateFieldRule('r4', '09:00'))
    s.unregister('r4')

    vi.advanceTimersByTime(48 * H) // two days
    expect(cb).not.toHaveBeenCalled()
    s.destroy()
  })

  it('non-leader never arms a date_field timer (leader owns execution)', () => {
    vi.setSystemTime(new Date('2026-06-25T10:00:00.000Z'))
    const cb = vi.fn()
    const s = new AutomationScheduler(cb)
    // Force follower: the date_field branch guards on isLeader before catch-up + arm.
    ;(s as unknown as { isLeader: boolean }).isLeader = false
    s.register(makeDateFieldRule('r5', '09:00'))

    expect(cb).not.toHaveBeenCalled() // no catch-up
    vi.advanceTimersByTime(24 * H)
    expect(cb).not.toHaveBeenCalled() // no armed timer
    s.destroy()
  })
})
