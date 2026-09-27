import { describe, expect, it } from 'vitest'
import {
  applyComplete,
  applyReopen,
  assertAnyModeInvariant,
  computeTaskDone,
  type TaskAssigneeRow,
} from '../../src/tasks/task-completion'

const NOW = new Date('2026-09-15T12:30:00.000Z')

function row(userId: string, completedAt: Date | null): TaskAssigneeRow {
  return { userId, completedAt }
}

describe('task-completion', () => {
  // ---------------------------------------------------------------------------------------------
  // 门 3 — six-cell grid: all×0 / any×0 / all×1 / any×1 / all×n / any×n
  // ---------------------------------------------------------------------------------------------
  describe('computeTaskDone — 门 3 six-cell grid', () => {
    it('all×0: zero rows is false', () => {
      expect(computeTaskDone({ mode: 'all', assigneeRows: [] })).toBe(false)
    })
    it('any×0: zero rows is false', () => {
      expect(computeTaskDone({ mode: 'any', assigneeRows: [] })).toBe(false)
    })
    it('all×1: single row, completed -> true; not completed -> false', () => {
      expect(computeTaskDone({ mode: 'all', assigneeRows: [row('a', NOW)] })).toBe(true)
      expect(computeTaskDone({ mode: 'all', assigneeRows: [row('a', null)] })).toBe(false)
    })
    it('any×1: single row, completed -> true; not completed -> false', () => {
      expect(computeTaskDone({ mode: 'any', assigneeRows: [row('a', NOW)] })).toBe(true)
      expect(computeTaskDone({ mode: 'any', assigneeRows: [row('a', null)] })).toBe(false)
    })
    it('all×n: every row must be completed', () => {
      expect(computeTaskDone({ mode: 'all', assigneeRows: [row('a', NOW), row('b', NOW), row('c', NOW)] })).toBe(
        true,
      )
      expect(computeTaskDone({ mode: 'all', assigneeRows: [row('a', NOW), row('b', null), row('c', NOW)] })).toBe(
        false,
      )
    })
    it('any×n: any one row completed is enough', () => {
      expect(computeTaskDone({ mode: 'any', assigneeRows: [row('a', null), row('b', NOW), row('c', null)] })).toBe(
        true,
      )
      expect(computeTaskDone({ mode: 'any', assigneeRows: [row('a', null), row('b', null)] })).toBe(false)
    })

    it('mutation probe: dropping the "zero rows -> false" branch reds all×0 (per design §5 "删‘零行⇒false’⇒all×0红")', () => {
      // Locally re-declared mutant that skips the empty-array guard — falls straight into `.every()`,
      // which vacuously returns true on an empty array. Not the source function.
      const mutantComputeTaskDone = (input: { mode: 'all' | 'any'; assigneeRows: TaskAssigneeRow[] }): boolean => {
        const { mode, assigneeRows } = input
        if (mode === 'all') return assigneeRows.every((r) => r.completedAt !== null)
        return assigneeRows.some((r) => r.completedAt !== null)
      }
      expect(mutantComputeTaskDone({ mode: 'all', assigneeRows: [] })).toBe(true) // wrongly "done"
      expect(computeTaskDone({ mode: 'all', assigneeRows: [] })).toBe(false) // real: correctly not done
      expect(mutantComputeTaskDone({ mode: 'all', assigneeRows: [] })).not.toBe(
        computeTaskDone({ mode: 'all', assigneeRows: [] }),
      )
    })
  })

  // ---------------------------------------------------------------------------------------------
  // applyComplete
  // ---------------------------------------------------------------------------------------------
  describe('applyComplete', () => {
    it('any mode: completing stamps every OTHER open row to the SAME instant and records completed_by_any', () => {
      const rows = [row('actor', null), row('b', null), row('c', null)]
      const result = applyComplete({ mode: 'any', rows, actorId: 'actor', createdBy: 'creator1', now: NOW })
      expect(result.done).toBe(true)
      expect(result.via).toBe('formula')
      for (const r of result.rows) {
        expect(r.completedAt?.getTime()).toBe(NOW.getTime())
      }
      expect(result.events).toEqual([{ type: 'completed_by_any', userId: 'actor', occurredAt: NOW }])
    })

    it('any mode preserves an already-completed row\'s existing timestamp (idempotent)', () => {
      const earlier = new Date('2026-09-01T00:00:00.000Z')
      const rows = [row('actor', null), row('b', earlier)]
      const result = applyComplete({ mode: 'any', rows, actorId: 'actor', createdBy: 'creator1', now: NOW })
      const bRow = result.rows.find((r) => r.userId === 'b')!
      expect(bRow.completedAt?.getTime()).toBe(earlier.getTime())
    })

    it('all mode: completing stamps ONLY the actor\'s row; task stays open -> self_completed', () => {
      const rows = [row('actor', null), row('b', null)]
      const result = applyComplete({ mode: 'all', rows, actorId: 'actor', createdBy: 'creator1', now: NOW })
      expect(result.done).toBe(false)
      expect(result.via).toBe('formula')
      const actorRow = result.rows.find((r) => r.userId === 'actor')!
      const bRow = result.rows.find((r) => r.userId === 'b')!
      expect(actorRow.completedAt?.getTime()).toBe(NOW.getTime())
      expect(bRow.completedAt).toBeNull()
      expect(result.events).toEqual([{ type: 'self_completed', userId: 'actor', occurredAt: NOW }])
    })

    it('all mode: the LAST completer\'s stamp flips the task done and records "completed" instead of "self_completed"', () => {
      const rows = [row('actor', null), row('b', NOW)]
      const result = applyComplete({ mode: 'all', rows, actorId: 'actor', createdBy: 'creator1', now: NOW })
      expect(result.done).toBe(true)
      expect(result.events).toEqual([{ type: 'completed', userId: 'actor', occurredAt: NOW }])
    })

    it('zero-assignee task: the creator completing it marks done via the creator-direct path, not the formula', () => {
      const result = applyComplete({ mode: 'all', rows: [], actorId: 'creator1', createdBy: 'creator1', now: NOW })
      expect(result.done).toBe(true)
      expect(result.via).toBe('creator-direct')
      expect(result.rows).toEqual([])
      expect(result.events).toEqual([{ type: 'completed', userId: 'creator1', occurredAt: NOW }])
    })

    it('zero-assignee task: a non-creator actor is rejected', () => {
      expect(() =>
        applyComplete({ mode: 'all', rows: [], actorId: 'someone_else', createdBy: 'creator1', now: NOW }),
      ).toThrow()
      expect(() =>
        applyComplete({ mode: 'any', rows: [], actorId: 'someone_else', createdBy: 'creator1', now: NOW }),
      ).toThrow()
    })

    // P2 finding: "all-mode complete by an actor with no assignee row is a silent no-op that still
    // emits self_completed". Both no-op shapes (actor not in `rows` at all; actor's own row already
    // completed) must now report `events: []` — no phantom completion event for a task that did not
    // actually transition.
    describe('all mode: a call that changes NOTHING emits no events (P2 finding fix, choice pinned here)', () => {
      it('actor has NO row at all (e.g. the creator, who can() permits but was never assigned)', () => {
        const rows = [row('other_assignee', null)]
        const result = applyComplete({ mode: 'all', rows, actorId: 'creator1', createdBy: 'creator1', now: NOW })
        expect(result.rows).toEqual(rows)
        expect(result.done).toBe(false)
        expect(result.via).toBe('formula')
        expect(result.events).toEqual([])
      })

      it('actor\'s own row was ALREADY completed (idempotent re-complete)', () => {
        const earlier = new Date('2026-09-01T00:00:00.000Z')
        const rows = [row('actor', earlier), row('b', null)]
        const result = applyComplete({ mode: 'all', rows, actorId: 'actor', createdBy: 'creator1', now: NOW })
        const actorRow = result.rows.find((r) => r.userId === 'actor')!
        expect(actorRow.completedAt?.getTime()).toBe(earlier.getTime()) // untouched, not re-stamped to NOW
        expect(result.done).toBe(false)
        expect(result.events).toEqual([])
      })

      it('control: a genuine transition (actor has an open row) still emits its event', () => {
        const rows = [row('actor', null)]
        const result = applyComplete({ mode: 'all', rows, actorId: 'actor', createdBy: 'creator1', now: NOW })
        expect(result.events).toEqual([{ type: 'completed', userId: 'actor', occurredAt: NOW }])
      })
    })
  })

  // ---------------------------------------------------------------------------------------------
  // applyReopen
  // ---------------------------------------------------------------------------------------------
  describe('applyReopen', () => {
    it('any mode: reopening clears EVERY row regardless of scope, and records reopened', () => {
      const rows = [row('a', NOW), row('b', NOW), row('c', NOW)]
      const result = applyReopen({ mode: 'any', rows, actorId: 'a', createdBy: 'creator1' })
      expect(result.rows.every((r) => r.completedAt === null)).toBe(true)
      expect(result.events).toEqual([{ type: 'reopened', userId: 'a' }])
    })

    it('all mode, scope=self: clears only the actor\'s own row, and records self_reopened', () => {
      const rows = [row('actor', NOW), row('b', NOW)]
      const result = applyReopen({ mode: 'all', rows, actorId: 'actor', scope: 'self', createdBy: 'creator1' })
      const actorRow = result.rows.find((r) => r.userId === 'actor')!
      const bRow = result.rows.find((r) => r.userId === 'b')!
      expect(actorRow.completedAt).toBeNull()
      expect(bRow.completedAt?.getTime()).toBe(NOW.getTime())
      expect(result.events).toEqual([{ type: 'self_reopened', userId: 'actor' }])
    })

    it('all mode, scope=all: clears every row, and records reopened', () => {
      const rows = [row('actor', NOW), row('b', NOW)]
      const result = applyReopen({ mode: 'all', rows, actorId: 'actor', scope: 'all', createdBy: 'creator1' })
      expect(result.rows.every((r) => r.completedAt === null)).toBe(true)
      expect(result.events).toEqual([{ type: 'reopened', userId: 'actor' }])
    })

    it('all mode requires a valid scope', () => {
      const rows = [row('actor', NOW)]
      expect(() =>
        applyReopen({ mode: 'all', rows, actorId: 'actor', createdBy: 'creator1' } as never),
      ).toThrow()
      expect(() =>
        applyReopen({ mode: 'all', rows, actorId: 'actor', scope: 'bogus' as never, createdBy: 'creator1' }),
      ).toThrow()
    })

    it('zero-assignee task: only the creator may reopen it', () => {
      const result = applyReopen({ mode: 'all', rows: [], actorId: 'creator1', scope: 'all', createdBy: 'creator1' })
      expect(result.rows).toEqual([])
      expect(result.events).toEqual([{ type: 'reopened', userId: 'creator1' }])
      expect(() =>
        applyReopen({ mode: 'all', rows: [], actorId: 'someone_else', scope: 'all', createdBy: 'creator1' }),
      ).toThrow()
    })

    // Same no-op-means-no-events choice as `applyComplete`'s all-mode fix (P2 finding, generalized).
    describe('all mode: a reopen that changes NOTHING emits no events', () => {
      it('scope=all on a task that is already fully open', () => {
        const rows = [row('a', null), row('b', null)]
        const result = applyReopen({ mode: 'all', rows, actorId: 'actor', scope: 'all', createdBy: 'creator1' })
        expect(result.rows).toEqual(rows)
        expect(result.events).toEqual([])
      })

      it('scope=self when the actor has NO row at all', () => {
        const rows = [row('other', NOW)]
        const result = applyReopen({ mode: 'all', rows, actorId: 'actor', scope: 'self', createdBy: 'creator1' })
        expect(result.rows).toEqual(rows) // nothing touched — 'other' stays completed
        expect(result.events).toEqual([])
      })

      it('scope=self when the actor\'s own row is already null', () => {
        const rows = [row('actor', null), row('b', NOW)]
        const result = applyReopen({ mode: 'all', rows, actorId: 'actor', scope: 'self', createdBy: 'creator1' })
        expect(result.events).toEqual([])
      })
    })
  })

  // ---------------------------------------------------------------------------------------------
  // assertAnyModeInvariant
  // ---------------------------------------------------------------------------------------------
  describe('assertAnyModeInvariant', () => {
    it('open + any + all rows uncompleted -> holds (true)', () => {
      expect(assertAnyModeInvariant('open', 'any', [row('a', null), row('b', null)])).toBe(true)
    })
    it('open + any + any row completed -> violated (false)', () => {
      expect(assertAnyModeInvariant('open', 'any', [row('a', NOW), row('b', null)])).toBe(false)
    })
    it('open + all mode -> invariant does not apply (true) even with completed rows', () => {
      expect(assertAnyModeInvariant('open', 'all', [row('a', NOW), row('b', null)])).toBe(true)
    })
    it('non-open status -> invariant does not apply (true) regardless of mode/rows', () => {
      expect(assertAnyModeInvariant('done', 'any', [row('a', NOW)])).toBe(true)
    })

    it('holds after every applyComplete/applyReopen transition exercised above (门 3 survival gate)', () => {
      const rows = [row('actor', null), row('b', null)]
      const afterAnyComplete = applyComplete({ mode: 'any', rows, actorId: 'actor', createdBy: 'c1', now: NOW })
      // Task is done after an `any` completion — invariant is scoped to `status='open'`, so it holds
      // trivially once status flips; the pre-condition (nobody completed while still open) also held.
      expect(assertAnyModeInvariant('open', 'any', rows)).toBe(true) // pre-transition rows, still open
      expect(afterAnyComplete.done).toBe(true)

      const afterAnyReopen = applyReopen({ mode: 'any', rows: afterAnyComplete.rows, actorId: 'actor', createdBy: 'c1' })
      expect(assertAnyModeInvariant('open', 'any', afterAnyReopen.rows)).toBe(true)
    })
  })
})

describe('task-completion — review round 2 fixes', () => {
  it('a missing completedAt (undefined) is NOT a completion', () => {
    const rows = [{ userId: 'u1' } as unknown as TaskAssigneeRow]
    expect(computeTaskDone({ mode: 'all', assigneeRows: rows })).toBe(false)
    expect(computeTaskDone({ mode: 'any', assigneeRows: rows })).toBe(false)
    expect(assertAnyModeInvariant('open', 'any', rows)).toBe(true)
  })

  it('any mode: completing an already-done task changes nothing and emits no event', () => {
    const rows = [row('u1', NOW), row('u2', NOW)]
    const later = new Date('2026-09-15T13:00:00.000Z')
    const r = applyComplete({ mode: 'any', rows, actorId: 'u1', createdBy: 'c1', now: later })
    expect(r.events).toEqual([])
    expect(r.rows.map((x) => x.completedAt)).toEqual([NOW, NOW])
    expect(r.done).toBe(true)
  })

  it('any mode: completing an open task stamps every row with the same instant and emits one event', () => {
    const r = applyComplete({ mode: 'any', rows: [row('u1', null), row('u2', null)], actorId: 'u1', createdBy: 'c1', now: NOW })
    expect(r.rows.map((x) => x.completedAt)).toEqual([NOW, NOW])
    expect(r.events).toEqual([{ type: 'completed_by_any', userId: 'u1', occurredAt: NOW }])
  })

  it('any mode: reopening an already-open task changes nothing and emits no event', () => {
    const r = applyReopen({ mode: 'any', rows: [row('u1', null), row('u2', null)], actorId: 'u1', createdBy: 'c1' })
    expect(r.events).toEqual([])
  })

  it('any mode: reopening a done task clears every row and emits one reopened event', () => {
    const r = applyReopen({ mode: 'any', rows: [row('u1', NOW), row('u2', NOW)], actorId: 'u1', createdBy: 'c1' })
    expect(r.rows.every((x) => x.completedAt === null)).toBe(true)
    expect(r.events).toEqual([{ type: 'reopened', userId: 'u1' }])
  })
})
