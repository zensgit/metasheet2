// #3925 S6 — bulk annual-leave balance adjustment — pure-module tests.
//
// Design lock: docs/development/attendance-bulk-balance-adjust-s6-design-lock-20260710.md
//
// These tests exercise `bulkBalanceAdjust.ts` in isolation (fake `submitOne`, no network, no
// Vue mount) — mirroring attendance-schedule-bulk-apply.spec.ts / the batch-anomaly pure-module
// precedent. Full-wire integration coverage (confirm-gate, real component mount, exact POST
// bodies through AttendanceView.vue) lives in apps/web/tests/attendance-admin-regressions.spec.ts.

import { describe, expect, it, vi } from 'vitest'
import {
  BULK_BALANCE_ADJUST_MAX_USERS,
  bulkBalanceAdjustErrorText,
  buildBulkBalanceAdjustRows,
  canRunBulkBalanceAdjust,
  classifyBulkBalanceAdjustErrorCode,
  runBulkBalanceAdjust,
  summarizeBulkBalanceAdjustOutcome,
  type BulkBalanceAdjustRowResult,
  type BulkBalanceAdjustRowSnapshot,
  type BulkBalanceAdjustSubmitOutcome,
} from '../src/views/attendance/bulkBalanceAdjust'

const tr = (en: string, _zh: string) => en

describe('bulkBalanceAdjust', () => {
  describe('canRunBulkBalanceAdjust', () => {
    it('allows 1..MAX_USERS', () => {
      expect(canRunBulkBalanceAdjust(1)).toBe(true)
      expect(canRunBulkBalanceAdjust(BULK_BALANCE_ADJUST_MAX_USERS)).toBe(true)
    })

    it('rejects 0 and negative counts', () => {
      expect(canRunBulkBalanceAdjust(0)).toBe(false)
      expect(canRunBulkBalanceAdjust(-1)).toBe(false)
    })

    it('rejects over-cap counts — the caller must shrink the selection, never silently truncate', () => {
      expect(canRunBulkBalanceAdjust(BULK_BALANCE_ADJUST_MAX_USERS + 1)).toBe(false)
      expect(canRunBulkBalanceAdjust(51)).toBe(false)
    })
  })

  describe('buildBulkBalanceAdjustRows', () => {
    it('builds one row per de-duplicated user, sharing deltaMinutes/reason', () => {
      const rows = buildBulkBalanceAdjustRows(
        ['user-b', 'user-a', 'user-a'],
        { deltaMinutes: 240, reason: 'annual carryover fix' },
        () => 'key-fixed',
      )
      expect(rows).toEqual([
        { userId: 'user-b', deltaMinutes: 240, reason: 'annual carryover fix', idempotencyKey: 'key-fixed' },
        { userId: 'user-a', deltaMinutes: 240, reason: 'annual carryover fix', idempotencyKey: 'key-fixed' },
      ])
    })

    it('blank/whitespace-only userIds are dropped, not turned into rows', () => {
      const rows = buildBulkBalanceAdjustRows(['  ', 'user-a', ''], { deltaMinutes: 60, reason: 'r' }, () => 'k')
      expect(rows).toEqual([{ userId: 'user-a', deltaMinutes: 60, reason: 'r', idempotencyKey: 'k' }])
    })

    it('returns empty for an empty user list', () => {
      expect(buildBulkBalanceAdjustRows([], { deltaMinutes: 60, reason: 'r' }, () => 'k')).toEqual([])
    })

    // Design §G3: every user shares ONE {deltaMinutes, reason} but gets an INDEPENDENT
    // idempotencyKey — the backend derives source_key = 'annual_manual_adjust:' + key per row,
    // so a shared key across users would 409-collide the 2nd..Nth user against the 1st user's
    // row. This is the load-bearing assertion for mutation cut #2 (hoisting the generator call
    // outside the per-row map would make every row share one key and must fail this).
    it('calls the idempotency-key generator once per row, producing pairwise-distinct keys', () => {
      let counter = 0
      const makeKey = vi.fn(() => `key-${counter++}`)
      const rows = buildBulkBalanceAdjustRows(['user-1', 'user-2', 'user-3'], { deltaMinutes: -60, reason: 'r' }, makeKey)
      expect(makeKey).toHaveBeenCalledTimes(3)
      const keys = rows.map(r => r.idempotencyKey)
      expect(new Set(keys).size).toBe(3)
    })
  })

  describe('classifyBulkBalanceAdjustErrorCode / bulkBalanceAdjustErrorText', () => {
    it('classifies each known route responder code distinctly (404/422/409)', () => {
      expect(classifyBulkBalanceAdjustErrorCode('USER_NOT_IN_ORG')).toBe('not_member')
      expect(classifyBulkBalanceAdjustErrorCode('ANNUAL_LEAVE_BALANCE_INSUFFICIENT')).toBe('insufficient')
      expect(classifyBulkBalanceAdjustErrorCode('ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT')).toBe('idempotency_conflict')
    })

    it('enum-strict: unrecognized or missing codes fall back to generic, never a known bucket', () => {
      expect(classifyBulkBalanceAdjustErrorCode('SOME_FUTURE_CODE')).toBe('generic')
      expect(classifyBulkBalanceAdjustErrorCode('FORBIDDEN')).toBe('generic')
      expect(classifyBulkBalanceAdjustErrorCode('VALIDATION_ERROR')).toBe('generic')
      expect(classifyBulkBalanceAdjustErrorCode(undefined)).toBe('generic')
      expect(classifyBulkBalanceAdjustErrorCode(null)).toBe('generic')
      expect(classifyBulkBalanceAdjustErrorCode('')).toBe('generic')
    })

    it('renders distinct, non-empty coarse text for every kind', () => {
      const kinds = ['not_member', 'insufficient', 'idempotency_conflict', 'generic'] as const
      const texts = kinds.map(kind => bulkBalanceAdjustErrorText(kind, tr))
      expect(new Set(texts).size).toBe(kinds.length)
      for (const text of texts) expect(text.length).toBeGreaterThan(0)
    })
  })

  describe('summarizeBulkBalanceAdjustOutcome', () => {
    it('idle when there are no results yet', () => {
      expect(summarizeBulkBalanceAdjustOutcome([])).toBe('idle')
    })

    it('running while any row is still submitting', () => {
      const results: BulkBalanceAdjustRowResult[] = [
        { userId: 'a', state: 'ok' },
        { userId: 'b', state: 'submitting' },
      ]
      expect(summarizeBulkBalanceAdjustOutcome(results)).toBe('running')
    })

    it('completed only when every row is ok', () => {
      const results: BulkBalanceAdjustRowResult[] = [
        { userId: 'a', state: 'ok' },
        { userId: 'b', state: 'ok' },
      ]
      expect(summarizeBulkBalanceAdjustOutcome(results)).toBe('completed')
    })

    it('completed_with_errors when any row failed — never reports full success on a partial failure', () => {
      const results: BulkBalanceAdjustRowResult[] = [
        { userId: 'a', state: 'ok' },
        { userId: 'b', state: 'error', errorKind: 'insufficient' },
      ]
      expect(summarizeBulkBalanceAdjustOutcome(results)).toBe('completed_with_errors')
    })
  })

  describe('runBulkBalanceAdjust', () => {
    function makeRows(n: number): BulkBalanceAdjustRowSnapshot[] {
      return Array.from({ length: n }, (_, i) => ({
        userId: `user-${i}`,
        deltaMinutes: 60,
        reason: 'bulk test',
        idempotencyKey: `key-${i}`,
      }))
    }

    it('submits rows sequentially in order, never concurrently', async () => {
      const rows = makeRows(3)
      const order: string[] = []
      let concurrent = 0
      let maxConcurrent = 0
      const submitOne = vi.fn(async (row: BulkBalanceAdjustRowSnapshot): Promise<BulkBalanceAdjustSubmitOutcome> => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        order.push(row.userId)
        await Promise.resolve()
        concurrent -= 1
        return { ok: true, result: { adjustmentId: `adj-${row.userId}`, applied: true, alreadyApplied: false } }
      })

      const results = await runBulkBalanceAdjust(rows, new Map(), submitOne)

      expect(order).toEqual(['user-0', 'user-1', 'user-2'])
      expect(maxConcurrent).toBe(1)
      expect(submitOne).toHaveBeenCalledTimes(3)
      for (const row of rows) {
        expect(results.get(row.userId)).toEqual({
          userId: row.userId,
          state: 'ok',
          adjustmentId: `adj-${row.userId}`,
          applied: true,
          alreadyApplied: false,
        })
      }
    })

    // Load-bearing assertion for mutation cut #3: dropping the `existing.state === 'ok'` skip
    // guard would resubmit an already-succeeded row on retry — this must go red if that guard
    // is removed.
    it('retry: skips rows already ok in `current`, only resubmits non-ok rows', async () => {
      const rows = makeRows(3)
      const current = new Map<string, BulkBalanceAdjustRowResult>()
      current.set(rows[0].userId, { userId: rows[0].userId, state: 'ok', adjustmentId: 'existing-adj' })
      current.set(rows[1].userId, {
        userId: rows[1].userId,
        state: 'error',
        errorCode: 'ANNUAL_LEAVE_BALANCE_INSUFFICIENT',
        errorKind: 'insufficient',
      })
      const submitOne = vi.fn(async (): Promise<BulkBalanceAdjustSubmitOutcome> => (
        { ok: true, result: { adjustmentId: 'new-adj', applied: true, alreadyApplied: false } }
      ))

      const results = await runBulkBalanceAdjust(rows, current, submitOne)

      // Only rows[1] (previously error) and rows[2] (never attempted) get submitted;
      // rows[0] (already ok) must be skipped.
      expect(submitOne).toHaveBeenCalledTimes(2)
      expect(submitOne.mock.calls.map(call => call[0].userId)).toEqual(['user-1', 'user-2'])
      expect(results.get(rows[0].userId)?.adjustmentId).toBe('existing-adj')
      expect(results.get(rows[1].userId)?.state).toBe('ok')
      expect(results.get(rows[2].userId)?.state).toBe('ok')
    })

    it('a row failure does not stop the others; the batch outcome is completed_with_errors', async () => {
      const rows = makeRows(3)
      const submitOne = async (row: BulkBalanceAdjustRowSnapshot): Promise<BulkBalanceAdjustSubmitOutcome> => {
        if (row.userId === 'user-1') return { ok: false, errorCode: 'USER_NOT_IN_ORG' }
        return { ok: true, result: { adjustmentId: `adj-${row.userId}`, applied: true, alreadyApplied: false } }
      }

      const results = await runBulkBalanceAdjust(rows, new Map(), submitOne)

      expect(results.get('user-0')?.state).toBe('ok')
      expect(results.get('user-1')).toEqual({
        userId: 'user-1',
        state: 'error',
        errorCode: 'USER_NOT_IN_ORG',
        errorKind: 'not_member',
      })
      expect(results.get('user-2')?.state).toBe('ok')
      expect(summarizeBulkBalanceAdjustOutcome([...results.values()])).toBe('completed_with_errors')
    })

    it('classifies 404 not-member / 422 insufficient / 409 idempotency-conflict / unrecognized codes distinctly per row', async () => {
      const rows: BulkBalanceAdjustRowSnapshot[] = [
        { userId: 'user-notmember', deltaMinutes: 60, reason: 'r', idempotencyKey: 'k1' },
        { userId: 'user-insufficient', deltaMinutes: -60, reason: 'r', idempotencyKey: 'k2' },
        { userId: 'user-conflict', deltaMinutes: 60, reason: 'r', idempotencyKey: 'k3' },
        { userId: 'user-unknown', deltaMinutes: 60, reason: 'r', idempotencyKey: 'k4' },
      ]
      const codeByUser: Record<string, string | undefined> = {
        'user-notmember': 'USER_NOT_IN_ORG',
        'user-insufficient': 'ANNUAL_LEAVE_BALANCE_INSUFFICIENT',
        'user-conflict': 'ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT',
        'user-unknown': 'SOME_UNMAPPED_CODE',
      }
      const submitOne = async (row: BulkBalanceAdjustRowSnapshot): Promise<BulkBalanceAdjustSubmitOutcome> => (
        { ok: false, errorCode: codeByUser[row.userId] }
      )

      const results = await runBulkBalanceAdjust(rows, new Map(), submitOne)

      expect(results.get('user-notmember')?.errorKind).toBe('not_member')
      expect(results.get('user-insufficient')?.errorKind).toBe('insufficient')
      expect(results.get('user-conflict')?.errorKind).toBe('idempotency_conflict')
      expect(results.get('user-unknown')?.errorKind).toBe('generic')
    })

    it('fires onProgress for each submitting -> settled transition, in row order', async () => {
      const rows = makeRows(2)
      const progress: Array<{ userId: string; state: string }> = []
      const submitOne = async (): Promise<BulkBalanceAdjustSubmitOutcome> => ({ ok: true, result: {} })

      await runBulkBalanceAdjust(rows, new Map(), submitOne, (userId, result) => {
        progress.push({ userId, state: result.state })
      })

      expect(progress).toEqual([
        { userId: 'user-0', state: 'submitting' },
        { userId: 'user-0', state: 'ok' },
        { userId: 'user-1', state: 'submitting' },
        { userId: 'user-1', state: 'ok' },
      ])
    })

    it('merge: a rerun over a different row set never touches unrelated pre-existing map entries', async () => {
      const unrelatedResult: BulkBalanceAdjustRowResult = { userId: 'unrelated-user', state: 'ok', adjustmentId: 'unrelated-adj' }
      const current = new Map<string, BulkBalanceAdjustRowResult>()
      current.set('unrelated-user', unrelatedResult)

      const rows = makeRows(2) // does not include unrelated-user
      const submitOne = async (row: BulkBalanceAdjustRowSnapshot): Promise<BulkBalanceAdjustSubmitOutcome> => (
        { ok: true, result: { adjustmentId: `new-${row.userId}`, applied: true, alreadyApplied: false } }
      )

      const results = await runBulkBalanceAdjust(rows, current, submitOne)

      expect(results.get('unrelated-user')).toEqual(unrelatedResult)
      expect(results.size).toBe(3) // 1 unrelated + 2 newly submitted
      // The `current` map passed in is never mutated in place — runBulkBalanceAdjust returns a fresh Map.
      expect(current.size).toBe(1)
    })

    it('never calls submitOne when there are no rows (e.g., an empty confirmed selection)', async () => {
      const submitOne = vi.fn(async (): Promise<BulkBalanceAdjustSubmitOutcome> => ({ ok: true, result: {} }))
      const results = await runBulkBalanceAdjust([], new Map(), submitOne)
      expect(submitOne).not.toHaveBeenCalled()
      expect(results.size).toBe(0)
    })
  })
})
