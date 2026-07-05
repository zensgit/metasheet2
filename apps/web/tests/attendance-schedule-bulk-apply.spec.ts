// #3616 bulk-apply schedule assignment — pure-module tests.
//
// Design lock: docs/development/attendance-schedule-bulk-apply-design-lock-20260705.md
//
// These tests exercise `scheduleBulkApply.ts` in isolation (fake `submitOne`, no network, no
// Vue mount) — mirroring how batch anomaly resolution's pure module is designed to be
// unit-tested without mounting the 29k-line AttendanceView.vue SFC. Full-wire integration
// coverage (confirm-gate, real component mount, exact fetch calls through AttendanceView.vue)
// lives in apps/web/tests/attendance-admin-regressions.spec.ts, which already carries the
// mock-fetch scaffolding needed to mount AttendanceView.

import { describe, expect, it, vi } from 'vitest'
import {
  BULK_APPLY_MAX_CELLS,
  bulkApplyCellErrorText,
  bulkApplyCellKey,
  buildBulkApplyAssignmentPayload,
  canRunBulkApply,
  classifyBulkApplyErrorCode,
  expandTargets,
  runBulkApply,
  summarizeBulkApplyOutcome,
  type BulkApplyCell,
  type BulkApplyCellResult,
  type BulkApplySubmitOutcome,
} from '../src/views/attendance/scheduleBulkApply'

const tr = (en: string, _zh: string) => en

describe('scheduleBulkApply', () => {
  describe('expandTargets', () => {
    it('expands a user multi-select x date range into sorted, deduped (user,date) cells', () => {
      const cells = expandTargets(['user-b', 'user-a', 'user-a'], '2026-07-06', '2026-07-07')
      expect(cells).toEqual([
        { userId: 'user-a', date: '2026-07-06' },
        { userId: 'user-b', date: '2026-07-06' },
        { userId: 'user-a', date: '2026-07-07' },
        { userId: 'user-b', date: '2026-07-07' },
      ])
    })

    it('returns a single cell when startDate === endDate', () => {
      expect(expandTargets(['user-a'], '2026-07-06', '2026-07-06')).toEqual([
        { userId: 'user-a', date: '2026-07-06' },
      ])
    })

    it('returns empty for an empty user list', () => {
      expect(expandTargets([], '2026-07-06', '2026-07-07')).toEqual([])
    })

    it('returns empty for an inverted range (endDate < startDate) rather than throwing', () => {
      expect(expandTargets(['user-a'], '2026-07-07', '2026-07-06')).toEqual([])
    })

    it('returns empty for malformed or missing dates rather than throwing', () => {
      expect(expandTargets(['user-a'], 'not-a-date', '2026-07-07')).toEqual([])
      expect(expandTargets(['user-a'], '2026-07-06', '')).toEqual([])
      expect(expandTargets(['user-a'], '', '')).toEqual([])
    })

    it('spans a month boundary correctly', () => {
      const cells = expandTargets(['user-a'], '2026-06-29', '2026-07-01')
      expect(cells.map(c => c.date)).toEqual(['2026-06-29', '2026-06-30', '2026-07-01'])
    })

    it('blank/whitespace-only userIds are dropped, not turned into cells', () => {
      expect(expandTargets(['  ', 'user-a', ''], '2026-07-06', '2026-07-06')).toEqual([
        { userId: 'user-a', date: '2026-07-06' },
      ])
    })
  })

  describe('canRunBulkApply', () => {
    it('allows 1..MAX_CELLS', () => {
      expect(canRunBulkApply(1)).toBe(true)
      expect(canRunBulkApply(BULK_APPLY_MAX_CELLS)).toBe(true)
    })

    it('rejects 0 and negative counts', () => {
      expect(canRunBulkApply(0)).toBe(false)
      expect(canRunBulkApply(-1)).toBe(false)
    })

    it('rejects over-cap counts — the caller must shrink the selection, never silently truncate', () => {
      expect(canRunBulkApply(BULK_APPLY_MAX_CELLS + 1)).toBe(false)
      expect(canRunBulkApply(51)).toBe(false)
    })
  })

  describe('buildBulkApplyAssignmentPayload', () => {
    it('builds the exact single-day draft-route body with the caller-supplied idempotencyKey', () => {
      const cell: BulkApplyCell = { userId: 'user-1', date: '2026-07-10' }
      const payload = buildBulkApplyAssignmentPayload(cell, {
        shiftId: 'shift-1',
        orgId: 'org-1',
        idempotencyKey: 'key-abc',
      })
      expect(payload).toEqual({
        userId: 'user-1',
        shiftId: 'shift-1',
        startDate: '2026-07-10',
        endDate: '2026-07-10',
        isActive: true,
        orgId: 'org-1',
        idempotencyKey: 'key-abc',
      })
    })

    it('two different cells from the same expansion get distinct bodies (distinct dates/users)', () => {
      const cells = expandTargets(['user-1', 'user-2'], '2026-07-10', '2026-07-10')
      const payloads = cells.map((cell, i) =>
        buildBulkApplyAssignmentPayload(cell, { shiftId: 'shift-1', orgId: 'org-1', idempotencyKey: `key-${i}` }),
      )
      expect(payloads).toHaveLength(2)
      expect(new Set(payloads.map(p => p.userId)).size).toBe(2)
      expect(new Set(payloads.map(p => p.idempotencyKey)).size).toBe(2)
    })
  })

  describe('classifyBulkApplyErrorCode / bulkApplyCellErrorText', () => {
    it('classifies each known route responder code distinctly (409/422/422/403)', () => {
      expect(classifyBulkApplyErrorCode('ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT')).toBe('conflict')
      expect(classifyBulkApplyErrorCode('SHIFT_COMPLIANCE_CAP_EXCEEDED')).toBe('compliance_cap')
      expect(classifyBulkApplyErrorCode('SHIFT_EDIT_WINDOW_EXCEEDED')).toBe('edit_window')
      expect(classifyBulkApplyErrorCode('SCHEDULER_SCOPE_FORBIDDEN')).toBe('scope_forbidden')
    })

    it('enum-strict: unrecognized or missing codes fall back to generic, never a known bucket', () => {
      expect(classifyBulkApplyErrorCode('SOME_FUTURE_CODE')).toBe('generic')
      expect(classifyBulkApplyErrorCode(undefined)).toBe('generic')
      expect(classifyBulkApplyErrorCode(null)).toBe('generic')
      expect(classifyBulkApplyErrorCode('')).toBe('generic')
    })

    it('renders distinct, non-empty coarse text for every kind', () => {
      const kinds = ['conflict', 'compliance_cap', 'edit_window', 'scope_forbidden', 'generic'] as const
      const texts = kinds.map(kind => bulkApplyCellErrorText(kind, tr))
      expect(new Set(texts).size).toBe(kinds.length)
      for (const text of texts) expect(text.length).toBeGreaterThan(0)
    })
  })

  describe('summarizeBulkApplyOutcome', () => {
    it('idle when there are no results yet', () => {
      expect(summarizeBulkApplyOutcome([])).toBe('idle')
    })

    it('running while any cell is still submitting', () => {
      const results: BulkApplyCellResult[] = [
        { userId: 'a', date: 'd', state: 'ok' },
        { userId: 'b', date: 'd', state: 'submitting' },
      ]
      expect(summarizeBulkApplyOutcome(results)).toBe('running')
    })

    it('completed only when every cell is ok', () => {
      const results: BulkApplyCellResult[] = [
        { userId: 'a', date: 'd', state: 'ok' },
        { userId: 'b', date: 'd', state: 'ok' },
      ]
      expect(summarizeBulkApplyOutcome(results)).toBe('completed')
    })

    it('completed_with_errors when any cell failed — never reports full success on a partial failure', () => {
      const results: BulkApplyCellResult[] = [
        { userId: 'a', date: 'd', state: 'ok' },
        { userId: 'b', date: 'd', state: 'error', errorKind: 'conflict' },
      ]
      expect(summarizeBulkApplyOutcome(results)).toBe('completed_with_errors')
    })
  })

  describe('runBulkApply', () => {
    function makeCells(n: number): BulkApplyCell[] {
      return Array.from({ length: n }, (_, i) => ({ userId: `user-${i}`, date: '2026-07-10' }))
    }

    it('submits cells sequentially in order, never concurrently', async () => {
      const cells = makeCells(3)
      const order: string[] = []
      let concurrent = 0
      let maxConcurrent = 0
      const submitOne = vi.fn(async (cell: BulkApplyCell): Promise<BulkApplySubmitOutcome> => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        order.push(cell.userId)
        await Promise.resolve()
        concurrent -= 1
        return { ok: true, result: { assignmentId: `assignment-${cell.userId}` } }
      })

      const results = await runBulkApply(cells, new Map(), submitOne)

      expect(order).toEqual(['user-0', 'user-1', 'user-2'])
      expect(maxConcurrent).toBe(1)
      expect(submitOne).toHaveBeenCalledTimes(3)
      for (const cell of cells) {
        expect(results.get(bulkApplyCellKey(cell))).toEqual({
          userId: cell.userId,
          date: cell.date,
          state: 'ok',
          assignmentId: `assignment-${cell.userId}`,
        })
      }
    })

    it('retry: skips cells already ok in `current`, only resubmits non-ok cells', async () => {
      const cells = makeCells(3)
      const current = new Map<string, BulkApplyCellResult>()
      current.set(bulkApplyCellKey(cells[0]), {
        userId: cells[0].userId,
        date: cells[0].date,
        state: 'ok',
        assignmentId: 'existing-assignment',
      })
      current.set(bulkApplyCellKey(cells[1]), {
        userId: cells[1].userId,
        date: cells[1].date,
        state: 'error',
        errorCode: 'ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT',
        errorKind: 'conflict',
      })
      const submitOne = vi.fn(async (): Promise<BulkApplySubmitOutcome> => ({ ok: true, result: { assignmentId: 'new-assignment' } }))

      const results = await runBulkApply(cells, current, submitOne)

      // Only cells[1] (previously error) and cells[2] (never attempted) get submitted;
      // cells[0] (already ok) must be skipped.
      expect(submitOne).toHaveBeenCalledTimes(2)
      expect(submitOne.mock.calls.map(call => call[0].userId)).toEqual(['user-1', 'user-2'])
      expect(results.get(bulkApplyCellKey(cells[0]))?.assignmentId).toBe('existing-assignment')
      expect(results.get(bulkApplyCellKey(cells[1]))?.state).toBe('ok')
      expect(results.get(bulkApplyCellKey(cells[2]))?.state).toBe('ok')
    })

    it('a cell failure does not stop the others; the batch outcome is completed_with_errors', async () => {
      const cells = makeCells(3)
      const submitOne = async (cell: BulkApplyCell): Promise<BulkApplySubmitOutcome> => {
        if (cell.userId === 'user-1') return { ok: false, errorCode: 'SHIFT_COMPLIANCE_CAP_EXCEEDED' }
        return { ok: true, result: { assignmentId: `assignment-${cell.userId}` } }
      }

      const results = await runBulkApply(cells, new Map(), submitOne)

      expect(results.get(bulkApplyCellKey(cells[0]))?.state).toBe('ok')
      expect(results.get(bulkApplyCellKey(cells[1]))).toEqual({
        userId: 'user-1',
        date: '2026-07-10',
        state: 'error',
        errorCode: 'SHIFT_COMPLIANCE_CAP_EXCEEDED',
        errorKind: 'compliance_cap',
      })
      expect(results.get(bulkApplyCellKey(cells[2]))?.state).toBe('ok')
      expect(summarizeBulkApplyOutcome([...results.values()])).toBe('completed_with_errors')
    })

    it('classifies 409 conflict / 422 edit-window / 403 scope / unrecognized codes distinctly per cell', async () => {
      const cells: BulkApplyCell[] = [
        { userId: 'user-conflict', date: '2026-07-10' },
        { userId: 'user-window', date: '2026-07-10' },
        { userId: 'user-scope', date: '2026-07-10' },
        { userId: 'user-unknown', date: '2026-07-10' },
      ]
      const codeByUser: Record<string, string | undefined> = {
        'user-conflict': 'ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT',
        'user-window': 'SHIFT_EDIT_WINDOW_EXCEEDED',
        'user-scope': 'SCHEDULER_SCOPE_FORBIDDEN',
        'user-unknown': 'SOME_UNMAPPED_CODE',
      }
      const submitOne = async (cell: BulkApplyCell): Promise<BulkApplySubmitOutcome> => (
        { ok: false, errorCode: codeByUser[cell.userId] }
      )

      const results = await runBulkApply(cells, new Map(), submitOne)

      expect(results.get(bulkApplyCellKey(cells[0]))?.errorKind).toBe('conflict')
      expect(results.get(bulkApplyCellKey(cells[1]))?.errorKind).toBe('edit_window')
      expect(results.get(bulkApplyCellKey(cells[2]))?.errorKind).toBe('scope_forbidden')
      expect(results.get(bulkApplyCellKey(cells[3]))?.errorKind).toBe('generic')
    })

    it('fires onProgress for each submitting -> settled transition, in cell order', async () => {
      const cells = makeCells(2)
      const progress: Array<{ key: string; state: string }> = []
      const submitOne = async (): Promise<BulkApplySubmitOutcome> => ({ ok: true })

      await runBulkApply(cells, new Map(), submitOne, (key, result) => {
        progress.push({ key, state: result.state })
      })

      expect(progress).toEqual([
        { key: bulkApplyCellKey(cells[0]), state: 'submitting' },
        { key: bulkApplyCellKey(cells[0]), state: 'ok' },
        { key: bulkApplyCellKey(cells[1]), state: 'submitting' },
        { key: bulkApplyCellKey(cells[1]), state: 'ok' },
      ])
    })

    it('merge: a rerun over a different cell set never touches unrelated pre-existing map entries', async () => {
      const unrelatedCell: BulkApplyCell = { userId: 'unrelated-user', date: '2026-01-01' }
      const unrelatedResult: BulkApplyCellResult = {
        userId: unrelatedCell.userId,
        date: unrelatedCell.date,
        state: 'ok',
        assignmentId: 'unrelated-assignment',
      }
      const current = new Map<string, BulkApplyCellResult>()
      current.set(bulkApplyCellKey(unrelatedCell), unrelatedResult)

      const cells = makeCells(2) // does not include unrelatedCell
      const submitOne = async (cell: BulkApplyCell): Promise<BulkApplySubmitOutcome> => (
        { ok: true, result: { assignmentId: `new-${cell.userId}` } }
      )

      const results = await runBulkApply(cells, current, submitOne)

      expect(results.get(bulkApplyCellKey(unrelatedCell))).toEqual(unrelatedResult)
      expect(results.size).toBe(3) // 1 unrelated + 2 newly submitted
      // The `current` map passed in is never mutated in place — runBulkApply returns a fresh Map.
      expect(current.size).toBe(1)
    })

    it('never calls submitOne when there are no cells (e.g., an empty confirmed selection)', async () => {
      const submitOne = vi.fn(async (): Promise<BulkApplySubmitOutcome> => ({ ok: true }))
      const results = await runBulkApply([], new Map(), submitOne)
      expect(submitOne).not.toHaveBeenCalled()
      expect(results.size).toBe(0)
    })
  })
})
