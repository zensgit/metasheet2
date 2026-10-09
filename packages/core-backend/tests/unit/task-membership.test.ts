import { describe, expect, it } from 'vitest'
import { assertAnyModeInvariant, type TaskAssigneeRow } from '../../src/tasks/task-completion'
import {
  TASK_ASSIGNEE_SOFT_LIMIT,
  TASK_FOLLOWER_SOFT_LIMIT,
  applyAddAssignee,
  applyAddFollower,
  applyRemoveAssignee,
  applyRemoveFollower,
  applySwitchCompletionMode,
  type TaskMembershipStatus,
} from '../../src/tasks/task-membership'

const NOW = new Date('2026-09-28T09:00:00.000Z')
const ACTOR = 'actor'

function row(userId: string, completedAt: Date | null): TaskAssigneeRow {
  return { userId, completedAt }
}

/** §6.2 invariant, asserted after every transition that can touch rows/status/mode. */
function expectInvariant(status: TaskMembershipStatus, mode: 'all' | 'any', rows: TaskAssigneeRow[]): void {
  expect(assertAnyModeInvariant(status, mode, rows)).toBe(true)
}

describe('task-membership', () => {
  describe('applyAddAssignee', () => {
    it('already an assignee -> noop, no event', () => {
      const rows = [row('a', null)]
      const result = applyAddAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'a' })
      expect(result).toEqual({ ok: true, rows: [row('a', null)], status: 'open', events: [] })
      expectInvariant('open', 'all', result.ok ? result.rows : [])
    })
    it('new assignee gets completedAt: null, all mode stays open when task was open', () => {
      const rows = [row('a', NOW)]
      const result = applyAddAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'b' })
      expect(result).toEqual({
        ok: true,
        rows: [row('a', NOW), row('b', null)],
        status: 'open',
        events: [{ type: 'assignee_added', userId: ACTOR, targetUserId: 'b' }],
      })
    })
    it('all mode: adding to an already-done task reopens it (§5-4)', () => {
      const rows = [row('a', NOW)]
      const result = applyAddAssignee({ mode: 'all', status: 'done', rows, now: NOW, actorId: ACTOR, userId: 'b' })
      expect(result).toEqual({
        ok: true,
        rows: [row('a', NOW), row('b', null)],
        status: 'open',
        events: [{ type: 'assignee_added', userId: ACTOR, targetUserId: 'b' }],
      })
    })
    it('A1: any mode: adding to an already-done task leaves it done', () => {
      const rows = [row('a', NOW)]
      const result = applyAddAssignee({ mode: 'any', status: 'done', rows, now: NOW, actorId: ACTOR, userId: 'b' })
      expect(result).toEqual({
        ok: true,
        rows: [row('a', NOW), row('b', null)],
        status: 'done',
        events: [{ type: 'assignee_added', userId: ACTOR, targetUserId: 'b' }],
      })
      // 'done' status means the §6.2 invariant (which only constrains 'open') does not apply.
      expectInvariant('done', 'any', result.ok ? result.rows : [])
    })
    it('limit: at the soft cap, adding a NEW assignee is rejected', () => {
      const rows = Array.from({ length: TASK_ASSIGNEE_SOFT_LIMIT }, (_, i) => row(`u${i}`, null))
      const result = applyAddAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'new' })
      expect(result).toEqual({ ok: false, reason: 'limit' })
    })
    it('limit: one below the cap still allows the add', () => {
      const rows = Array.from({ length: TASK_ASSIGNEE_SOFT_LIMIT - 1 }, (_, i) => row(`u${i}`, null))
      const result = applyAddAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'new' })
      expect(result.ok).toBe(true)
    })
    it('limit: re-adding an EXISTING assignee at the cap is still a noop, not a rejection', () => {
      const rows = Array.from({ length: TASK_ASSIGNEE_SOFT_LIMIT }, (_, i) => row(`u${i}`, null))
      const result = applyAddAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'u0' })
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.events).toEqual([])
    })
    it('does not mutate the input rows array', () => {
      const rows = [row('a', NOW)]
      const before = rows.map((r) => ({ ...r }))
      applyAddAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'b' })
      expect(rows).toEqual(before)
    })
  })

  describe('applyRemoveAssignee', () => {
    it('not an assignee -> noop, no event', () => {
      const rows = [row('a', null)]
      const result = applyRemoveAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'ghost' })
      expect(result).toEqual({ rows: [row('a', null)], status: 'open', events: [] })
    })
    it('all mode: removing the last incomplete row PROMOTES to done', () => {
      const rows = [row('a', NOW), row('b', null)]
      const result = applyRemoveAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'b' })
      expect(result).toEqual({ rows: [row('a', NOW)], status: 'done', events: [{ type: 'assignee_removed', userId: ACTOR, targetUserId: 'b' }] })
      expectInvariant(result.status, 'all', result.rows)
    })
    it('all mode: removing a row while others remain incomplete keeps status as passed (open)', () => {
      const rows = [row('a', null), row('b', null)]
      const result = applyRemoveAssignee({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, userId: 'a' })
      expect(result).toEqual({ rows: [row('b', null)], status: 'open', events: [{ type: 'assignee_removed', userId: ACTOR, targetUserId: 'a' }] })
    })
    it('all mode: removing down to zero rows leaves status UNCHANGED (not forced open or done)', () => {
      const rows = [row('a', NOW)]
      const resultFromDone = applyRemoveAssignee({ mode: 'all', status: 'done', rows, now: NOW, actorId: ACTOR, userId: 'a' })
      expect(resultFromDone).toEqual({ rows: [], status: 'done', events: [{ type: 'assignee_removed', userId: ACTOR, targetUserId: 'a' }] })
      const resultFromOpen = applyRemoveAssignee({
        mode: 'all',
        status: 'open',
        rows: [row('a', null)],
        now: NOW, actorId: ACTOR,
        userId: 'a',
      })
      expect(resultFromOpen).toEqual({ rows: [], status: 'open', events: [{ type: 'assignee_removed', userId: ACTOR, targetUserId: 'a' }] })
    })
    it('any mode: status is never recomputed by this function', () => {
      const rows = [row('a', NOW), row('b', null)]
      const result = applyRemoveAssignee({ mode: 'any', status: 'done', rows, now: NOW, actorId: ACTOR, userId: 'a' })
      // Removing the ONLY completed row leaves [b: null] — an "any" recompute would say NOT done,
      // but this function must not touch status for `any` mode at all.
      expect(result).toEqual({ rows: [row('b', null)], status: 'done', events: [{ type: 'assignee_removed', userId: ACTOR, targetUserId: 'a' }] })
    })
    it('PROMOTE-ONLY regression (advisor-pinned): a done task reached via any->all must not be silently reopened by a later remove', () => {
      // any mode, [a: done, b: done] -> status done.
      let rows: TaskAssigneeRow[] = [row('a', NOW), row('b', NOW)]
      let status: TaskMembershipStatus = 'done'
      expectInvariant(status, 'any', rows) // vacuous: status is 'done', not 'open'

      // Add assignee c (still incomplete) — A1: any-mode done task stays done.
      const added = applyAddAssignee({ mode: 'any', status, rows, now: NOW, actorId: ACTOR, userId: 'c' })
      expect(added.ok).toBe(true)
      if (!added.ok) throw new Error('unreachable')
      rows = added.rows
      status = added.status
      expect(status).toBe('done')

      // Switch any -> all: §5-4 preserves rows and the done status untouched.
      const switched = applySwitchCompletionMode({ mode: 'any', status, rows, now: NOW, actorId: ACTOR, to: 'all' })
      rows = switched.rows
      status = switched.status
      expect(status).toBe('done')
      expect(rows).toEqual([row('a', NOW), row('b', NOW), row('c', null)])

      // Remove the ORIGINAL completed row `a`. Remaining rows [b: done, c: null] are NOT all
      // complete — a naive "recompute unconditionally" reading would silently reopen. Promote-only
      // must leave `status` exactly as passed in ('done').
      const removed = applyRemoveAssignee({ mode: 'all', status, rows, now: NOW, actorId: ACTOR, userId: 'a' })
      expect(removed.status).toBe('done')
      expect(removed.rows).toEqual([row('b', NOW), row('c', null)])
    })
  })

  describe('applySwitchCompletionMode', () => {
    it('same mode -> noop, no event', () => {
      const rows = [row('a', null)]
      const result = applySwitchCompletionMode({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, to: 'all' })
      expect(result).toEqual({ rows: [row('a', null)], status: 'open', events: [] })
    })
    it('all -> any, nobody completed: only completion_mode_changed, task stays open', () => {
      const rows = [row('a', null), row('b', null)]
      const result = applySwitchCompletionMode({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, to: 'any' })
      expect(result).toEqual({
        rows: [row('a', null), row('b', null)],
        status: 'open',
        events: [{ type: 'completion_mode_changed', userId: ACTOR }],
      })
      expectInvariant(result.status, 'any', result.rows)
    })
    it('all -> any, someone completed: stamps every OTHER open row to the SAME now, records both events', () => {
      const earlier = new Date('2026-09-27T08:00:00.000Z')
      const rows = [row('a', earlier), row('b', null), row('c', null)]
      const result = applySwitchCompletionMode({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, to: 'any' })
      expect(result.status).toBe('done')
      // a keeps its own earlier instant; only the open rows are stamped with the switch's now.
      expect(result.rows).toEqual([row('a', earlier), row('b', NOW), row('c', NOW)])
      expect(result.events).toEqual([{ type: 'completion_mode_changed', userId: ACTOR }, { type: 'completed_by_any', userId: ACTOR, occurredAt: NOW }])
    })
    it('all -> any, EVERYONE already completed: suppresses the phantom completed_by_any', () => {
      const earlier = new Date('2026-01-01T00:00:00.000Z')
      const rows = [row('a', earlier), row('b', earlier)]
      const result = applySwitchCompletionMode({ mode: 'all', status: 'done', rows, now: NOW, actorId: ACTOR, to: 'any' })
      expect(result.status).toBe('done')
      // No row is re-stamped — the original (earlier) instants are preserved.
      expect(result.rows).toEqual([row('a', earlier), row('b', earlier)])
      expect(result.events).toEqual([{ type: 'completion_mode_changed', userId: ACTOR }])
    })
    it('any -> all: rows and status are carried over untouched, including a partially-done task', () => {
      const rows = [row('a', NOW), row('b', null)]
      const result = applySwitchCompletionMode({ mode: 'any', status: 'done', rows, now: NOW, actorId: ACTOR, to: 'all' })
      expect(result).toEqual({
        rows: [row('a', NOW), row('b', null)],
        status: 'done',
        events: [{ type: 'completion_mode_changed', userId: ACTOR }],
      })
    })
    it('does not mutate the input rows array', () => {
      const rows = [row('a', null)]
      const before = rows.map((r) => ({ ...r }))
      applySwitchCompletionMode({ mode: 'all', status: 'open', rows, now: NOW, actorId: ACTOR, to: 'any' })
      expect(rows).toEqual(before)
    })
  })

  describe('applyAddFollower', () => {
    it('already following -> noop, no event', () => {
      const result = applyAddFollower({ followers: ['a'], userId: 'a', actorId: ACTOR })
      expect(result).toEqual({ ok: true, followers: ['a'], events: [] })
    })
    it('new follower -> event follower_added', () => {
      const result = applyAddFollower({ followers: ['a'], userId: 'b', actorId: ACTOR })
      expect(result).toEqual({ ok: true, followers: ['a', 'b'], events: [{ type: 'follower_added', userId: ACTOR, targetUserId: 'b' }] })
    })
    it('limit: at the soft cap, adding a NEW follower is rejected', () => {
      const followers = Array.from({ length: TASK_FOLLOWER_SOFT_LIMIT }, (_, i) => `u${i}`)
      const result = applyAddFollower({ followers, userId: 'new', actorId: ACTOR })
      expect(result).toEqual({ ok: false, reason: 'limit' })
    })
    it('limit: re-adding an EXISTING follower at the cap is still a noop', () => {
      const followers = Array.from({ length: TASK_FOLLOWER_SOFT_LIMIT }, (_, i) => `u${i}`)
      const result = applyAddFollower({ followers, userId: 'u0', actorId: ACTOR })
      expect(result).toEqual({ ok: true, followers, events: [] })
    })
  })

  describe('applyRemoveFollower', () => {
    it('not following -> noop, no event', () => {
      const result = applyRemoveFollower({ followers: ['a'], userId: 'ghost', actorId: 'a' })
      expect(result).toEqual({ followers: ['a'], events: [] })
    })
    it('actor removes THEMSELVES -> event left', () => {
      const result = applyRemoveFollower({ followers: ['a', 'b'], userId: 'a', actorId: 'a' })
      expect(result).toEqual({ followers: ['b'], events: [{ type: 'left', userId: 'a', targetUserId: 'a' }] })
    })
    it('actor removes someone else -> event follower_removed', () => {
      const result = applyRemoveFollower({ followers: ['a', 'b'], userId: 'a', actorId: 'admin' })
      expect(result).toEqual({ followers: ['b'], events: [{ type: 'follower_removed', userId: 'admin', targetUserId: 'a' }] })
    })
  })
})

describe('task-c review round 1', () => {
  it('applySwitchCompletionMode rejects an invalid target mode', () => {
    expect(() =>
      applySwitchCompletionMode({ mode: 'all', status: 'open', rows: [], now: NOW, actorId: ACTOR, to: 'bogus' as never }),
    ).toThrow(TypeError)
  })
  it('follower limit: 49 existing -> add ok, 50 existing -> add rejected', () => {
    const below = Array.from({ length: TASK_FOLLOWER_SOFT_LIMIT - 1 }, (_, i) => `u${i}`)
    const okResult = applyAddFollower({ followers: below, userId: 'new', actorId: ACTOR })
    expect(okResult.ok).toBe(true)
    const full = Array.from({ length: TASK_FOLLOWER_SOFT_LIMIT }, (_, i) => `u${i}`)
    expect(applyAddFollower({ followers: full, userId: 'new', actorId: ACTOR })).toEqual({ ok: false, reason: 'limit' })
  })
  it('done any task + added assignee -> switch to all -> switch back to any: no second completed_by_any, no stamping', () => {
    const start = [row('a', NOW)]
    const added = applyAddAssignee({ mode: 'any', status: 'done', rows: start, now: NOW, actorId: ACTOR, userId: 'b' })
    if (!added.ok) throw new Error('add failed')
    const toAll = applySwitchCompletionMode({ mode: 'any', status: added.status, rows: added.rows, now: NOW, actorId: ACTOR, to: 'all' })
    expect(toAll.status).toBe('done')
    const later = new Date('2026-09-28T10:00:00.000Z')
    const backToAny = applySwitchCompletionMode({ mode: 'all', status: toAll.status, rows: toAll.rows, now: later, actorId: ACTOR, to: 'any' })
    expect(backToAny.events).toEqual([{ type: 'completion_mode_changed', userId: ACTOR }])
    expect(backToAny.rows).toEqual([row('a', NOW), row('b', null)])
    expect(backToAny.status).toBe('done')
  })
  it('stuck-done path: done any task + added assignee still reopens and can complete again', async () => {
    const { applyReopen: reopen, applyComplete: complete } = await import('../../src/tasks/task-completion')
    const added = applyAddAssignee({ mode: 'any', status: 'done', rows: [], now: NOW, actorId: ACTOR, userId: 'b' })
    expect(added.ok && added.status).toBe('done')
    if (!added.ok) return
    const reopened = reopen({ mode: 'any', rows: added.rows, actorId: 'creator1', createdBy: 'creator1', wasDone: true })
    expect(reopened.events).toEqual([{ type: 'reopened', userId: 'creator1' }])
    const completedAgain = complete({ mode: 'any', rows: reopened.rows, actorId: 'b', createdBy: 'creator1', now: NOW, wasDone: false })
    expect(completedAgain.events).toEqual([{ type: 'completed_by_any', userId: 'b', occurredAt: NOW }])
  })
})
