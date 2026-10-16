import { describe, expect, it } from 'vitest'
import { applySetMilestone, parseMilestoneFlag } from '../../src/tasks/task-milestone'

const NOW = new Date('2026-10-07T08:00:00.000Z')

describe('task-milestone', () => {
  describe('parseMilestoneFlag', () => {
    it('accepts real booleans', () => {
      expect(parseMilestoneFlag(true)).toEqual({ ok: true, value: true })
      expect(parseMilestoneFlag(false)).toEqual({ ok: true, value: false })
    })
    it('refuses everything else as invalid_milestone', () => {
      for (const raw of ['true', 'false', 1, 0, null, undefined, {}, [], 'x']) {
        expect(parseMilestoneFlag(raw), String(raw)).toEqual({ ok: false, reason: 'invalid_milestone' })
      }
    })
  })

  describe('applySetMilestone', () => {
    it('false → true emits milestone_set', () => {
      expect(applySetMilestone({ current: false, next: true, actorId: 'u1', now: NOW })).toEqual({
        isMilestone: true,
        noop: false,
        events: [{ type: 'milestone_set', userId: 'u1', occurredAt: NOW }],
      })
    })
    it('true → false emits milestone_cleared', () => {
      expect(applySetMilestone({ current: true, next: false, actorId: 'u1', now: NOW })).toEqual({
        isMilestone: false,
        noop: false,
        events: [{ type: 'milestone_cleared', userId: 'u1', occurredAt: NOW }],
      })
    })
    it('same value is a no-op with no event (both directions)', () => {
      expect(applySetMilestone({ current: true, next: true, actorId: 'u1', now: NOW })).toEqual({ isMilestone: true, noop: true, events: [] })
      expect(applySetMilestone({ current: false, next: false, actorId: 'u1', now: NOW })).toEqual({ isMilestone: false, noop: true, events: [] })
    })
    // RULED(2026-10-09): [S13] — a task without a due date can still be made a milestone.
    it('a task with no due date can be made a milestone', () => {
      const input = { current: false, next: true, actorId: 'u1', now: NOW, dueDate: null }
      expect(applySetMilestone(input).events).toEqual([{ type: 'milestone_set', userId: 'u1', occurredAt: NOW }])
    })
    it('rejects non-boolean flags, a blank actor and an invalid Date with TypeError', () => {
      expect(() => applySetMilestone({ current: 'false' as never, next: true, actorId: 'u1', now: NOW })).toThrow(TypeError)
      expect(() => applySetMilestone({ current: false, next: 1 as never, actorId: 'u1', now: NOW })).toThrow(TypeError)
      expect(() => applySetMilestone({ current: false, next: true, actorId: '', now: NOW })).toThrow(TypeError)
      expect(() => applySetMilestone({ current: false, next: true, actorId: 'u1', now: new Date(Number.NaN) })).toThrow(TypeError)
      expect(() => applySetMilestone('x' as never)).toThrow(TypeError)
    })
  })
})
