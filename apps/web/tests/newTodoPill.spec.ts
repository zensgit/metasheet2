/**
 * G-B2-11: pure `newTodoPillState` contract — "新待办到达刷新 pill".
 *
 * Deliberately does NOT mount ApprovalCenterView.vue (1100+ lines); this covers only the decision
 * function that the view's computed wraps. See src/approvals/newTodoPill.ts for the design
 * rationale (why comparing count-vs-loaded-rows is wrong, why no auto-refresh).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newTodoPillState } from '../src/approvals/newTodoPill'

describe('approvals/newTodoPill', () => {
  it('shows the pill with the correct delta when count rose since the load snapshot (pending tab)', () => {
    expect(newTodoPillState({
      activeTab: 'pending',
      pendingCountAtLoad: 3,
      currentPendingCount: 5,
    })).toEqual({ visible: true, delta: 2 })
  })

  it('hides when count is unchanged since the snapshot (no new arrivals)', () => {
    expect(newTodoPillState({
      activeTab: 'pending',
      pendingCountAtLoad: 3,
      currentPendingCount: 3,
    })).toEqual({ visible: false, delta: 0 })
  })

  it('hides — and never reports a negative delta — when count fell (someone else actioned a row)', () => {
    expect(newTodoPillState({
      activeTab: 'pending',
      pendingCountAtLoad: 5,
      currentPendingCount: 2,
    })).toEqual({ visible: false, delta: 0 })
  })

  it('hides on a non-pending tab even if count rose — pill is 待我处理-only', () => {
    for (const activeTab of ['mine', 'cc', 'completed'] as const) {
      expect(newTodoPillState({
        activeTab,
        pendingCountAtLoad: 3,
        currentPendingCount: 9,
      })).toEqual({ visible: false, delta: 0 })
    }
  })

  it('hides before the first load has ever completed (snapshot is null)', () => {
    expect(newTodoPillState({
      activeTab: 'pending',
      pendingCountAtLoad: null,
      currentPendingCount: 9,
    })).toEqual({ visible: false, delta: 0 })
  })

  it('hides when the live count is not a finite number (defensive)', () => {
    expect(newTodoPillState({
      activeTab: 'pending',
      pendingCountAtLoad: 3,
      currentPendingCount: Number.NaN,
    })).toEqual({ visible: false, delta: 0 })
  })

  it('does NOT compare against loaded-row counts — paging to a later page must never look like new arrivals', () => {
    // Simulates: pending queue has 30 total, operator pages to page 3 (10 rows/page: only 10 rows
    // rendered), no new server-side arrivals since the load. The snapshot IS the server total (30),
    // not "10 rows on screen", so the delta is correctly zero regardless of page size/position.
    expect(newTodoPillState({
      activeTab: 'pending',
      pendingCountAtLoad: 30,
      currentPendingCount: 30,
    })).toEqual({ visible: false, delta: 0 })
  })

  it('boundary: delta of exactly +1 is visible', () => {
    expect(newTodoPillState({
      activeTab: 'pending',
      pendingCountAtLoad: 0,
      currentPendingCount: 1,
    })).toEqual({ visible: true, delta: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Static tripwire: the pill's re-baseline must live at the ONE place every list
// reload passes through (`loadCurrentTab`), never at individual call sites.
//
// It originally sat at six call sites — and `handleSearch()` / `handlePageChange()`
// were both missed, leaving a pill still urging "N 条新待办 · 点击刷新" for todos the
// reload had already fetched. A choke point cannot be forgotten by the next caller.
// ─────────────────────────────────────────────────────────────────────────────
describe('G-B2-11 re-baseline choke point (static tripwire)', () => {
  const source = readFileSync(join(__dirname, '..', 'src/views/approval/ApprovalCenterView.vue'), 'utf8')

  it('resnapshot is requested exactly once in the whole view', () => {
    const occurrences = source.split('refreshPendingBadgeCount({ resnapshot: true })').length - 1
    expect(occurrences).toBe(1)
  })

  it('that single occurrence sits inside loadCurrentTab()', () => {
    const start = source.indexOf('function loadCurrentTab()')
    expect(start).toBeGreaterThan(-1)
    // end of the function = the first line that closes it at column 0 indent
    const body = source.slice(start, source.indexOf('\n}', start) + 2)
    expect(body).toContain('refreshPendingBadgeCount({ resnapshot: true })')
  })
})
