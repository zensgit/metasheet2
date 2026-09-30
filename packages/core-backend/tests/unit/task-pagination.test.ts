import { describe, expect, it } from 'vitest'
import {
  TASK_PAGE_LIMIT_DEFAULT,
  TASK_PAGE_LIMIT_MAX,
  TASK_PAGE_LIMIT_MIN,
  TASK_PAGE_OFFSET_DEFAULT,
  TASK_PAGE_SORT_KEY,
  parsePageParams,
} from '../../src/tasks/task-pagination'

describe('task-pagination', () => {
  it('TASK_PAGE_SORT_KEY is the D9 stable tiebreak', () => {
    expect(TASK_PAGE_SORT_KEY).toBe('(updated_at DESC, id DESC)')
  })

  describe('parsePageParams', () => {
    it('empty input -> defaults (limit 100, offset 0) — v2 R15', () => {
      expect(parsePageParams({})).toEqual({ ok: true, params: { limit: 100, offset: 0 } })
      expect(TASK_PAGE_LIMIT_DEFAULT).toBe(100)
      expect(TASK_PAGE_OFFSET_DEFAULT).toBe(0)
    })

    it('null/undefined limit and offset both fall back to defaults', () => {
      expect(parsePageParams({ limit: null, offset: undefined })).toEqual({
        ok: true,
        params: { limit: 100, offset: 0 },
      })
    })

    it('accepts a JS number', () => {
      expect(parsePageParams({ limit: 25, offset: 10 })).toEqual({ ok: true, params: { limit: 25, offset: 10 } })
    })

    it('accepts a canonical numeric string (HTTP query value)', () => {
      expect(parsePageParams({ limit: '25', offset: '10' })).toEqual({ ok: true, params: { limit: 25, offset: 10 } })
    })

    it('boundary: limit === 1 (min) is accepted', () => {
      expect(parsePageParams({ limit: TASK_PAGE_LIMIT_MIN })).toEqual({
        ok: true,
        params: { limit: 1, offset: 0 },
      })
    })

    it('boundary: limit === 0 is rejected', () => {
      expect(parsePageParams({ limit: 0 })).toEqual({ ok: false, reason: 'invalid_limit' })
    })

    it('boundary: limit === 100 (max) is accepted', () => {
      expect(parsePageParams({ limit: TASK_PAGE_LIMIT_MAX })).toEqual({
        ok: true,
        params: { limit: 100, offset: 0 },
      })
    })

    it('boundary: limit === 101 is rejected', () => {
      expect(parsePageParams({ limit: 101 })).toEqual({ ok: false, reason: 'invalid_limit' })
    })

    it('negative limit is rejected', () => {
      expect(parsePageParams({ limit: -1 })).toEqual({ ok: false, reason: 'invalid_limit' })
    })

    it('float limit is rejected, not silently truncated', () => {
      expect(parsePageParams({ limit: 5.5 })).toEqual({ ok: false, reason: 'invalid_limit' })
      expect(parsePageParams({ limit: '5.5' })).toEqual({ ok: false, reason: 'invalid_limit' })
    })

    it('non-numeric limit string is rejected', () => {
      expect(parsePageParams({ limit: 'abc' })).toEqual({ ok: false, reason: 'invalid_limit' })
      expect(parsePageParams({ limit: '' })).toEqual({ ok: false, reason: 'invalid_limit' })
      expect(parsePageParams({ limit: '  5' })).toEqual({ ok: false, reason: 'invalid_limit' })
      expect(parsePageParams({ limit: '+5' })).toEqual({ ok: false, reason: 'invalid_limit' })
    })

    it('boundary: offset === 0 is accepted', () => {
      expect(parsePageParams({ offset: 0 })).toEqual({ ok: true, params: { limit: 100, offset: 0 } })
    })

    it('negative offset is rejected', () => {
      expect(parsePageParams({ offset: -1 })).toEqual({ ok: false, reason: 'invalid_offset' })
    })

    it('offset has no upper bound (any non-negative integer is accepted)', () => {
      expect(parsePageParams({ offset: 100000 })).toEqual({ ok: true, params: { limit: 100, offset: 100000 } })
    })

    it('float offset is rejected', () => {
      expect(parsePageParams({ offset: 1.5 })).toEqual({ ok: false, reason: 'invalid_offset' })
    })

    it('non-numeric offset string is rejected', () => {
      expect(parsePageParams({ offset: 'abc' })).toEqual({ ok: false, reason: 'invalid_offset' })
    })

    it('never silently clamps: an out-of-range limit does NOT fall back to the default or the max', () => {
      const result = parsePageParams({ limit: 999 })
      expect(result).toEqual({ ok: false, reason: 'invalid_limit' })
    })

    it('both limit and offset invalid -> reports the limit failure first', () => {
      expect(parsePageParams({ limit: 0, offset: -1 })).toEqual({ ok: false, reason: 'invalid_limit' })
    })
  })
})
