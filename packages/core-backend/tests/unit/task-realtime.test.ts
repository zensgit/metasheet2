import { describe, expect, it } from 'vitest'
import { countsUpdateRecipients } from '../../src/tasks/task-realtime'

describe('task-realtime', () => {
  describe('countsUpdateRecipients', () => {
    it('both empty -> empty', () => {
      expect(countsUpdateRecipients([], [])).toEqual([])
    })

    it('unchanged assignee set -> that one recipient (still notified, count-affecting write happened)', () => {
      expect(countsUpdateRecipients(['a'], ['a'])).toEqual(['a'])
    })

    it('a newly-added assignee is included', () => {
      expect(countsUpdateRecipients([], ['a'])).toEqual(['a'])
    })

    it('a newly-removed assignee is STILL included (their badge count also changes)', () => {
      expect(countsUpdateRecipients(['a'], [])).toEqual(['a'])
    })

    it('a pure swap (one out, one in) includes BOTH', () => {
      expect(countsUpdateRecipients(['a'], ['b'])).toEqual(['a', 'b'])
    })

    it('someone present on both sides is de-duplicated', () => {
      expect(countsUpdateRecipients(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
    })

    it('output is sorted', () => {
      expect(countsUpdateRecipients(['z'], ['a', 'm'])).toEqual(['a', 'm', 'z'])
    })

    it('duplicate ids within one side are collapsed', () => {
      expect(countsUpdateRecipients(['a', 'a'], ['a'])).toEqual(['a'])
    })

    it('does not mutate its inputs', () => {
      const before = ['a']
      const after = ['b']
      countsUpdateRecipients(before, after)
      expect(before).toEqual(['a'])
      expect(after).toEqual(['b'])
    })
  })
})
