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
    expect(TASK_PAGE_SORT_KEY).toBe('tasks.updated_at DESC, tasks.id DESC')
  })

  it('TASK_PAGE_SORT_KEY interpolates into ORDER BY as a plain, qualified column list', () => {
    const sql = `SELECT tasks.id FROM tasks ORDER BY ${TASK_PAGE_SORT_KEY} LIMIT $1 OFFSET $2`
    expect(sql).toMatch(/ORDER BY tasks\.updated_at DESC, tasks\.id DESC LIMIT/)
    // A parenthesised row constructor rejects DESC in PostgreSQL ("syntax error at or near DESC").
    expect(TASK_PAGE_SORT_KEY).not.toMatch(/[()]/)
    for (const term of TASK_PAGE_SORT_KEY.split(',').map((t) => t.trim())) {
      expect(term).toMatch(/^tasks\.[a-z_]+ DESC$/)
    }
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

    // item 11 (independent review): confirmed bug — the NUMBER branch used `Number.isInteger`,
    // which is TRUE for `1e300` (no fractional part, but astronomically outside any real
    // row-count/offset range and far beyond `Number.MAX_SAFE_INTEGER`). Before the fix,
    // `parsePageParams({ offset: 1e300 })` returned `{ ok: true, params: { offset: 1e+300 } }` — a
    // value that would silently corrupt a downstream SQL `OFFSET` bind. `offset` has no UPPER
    // bound check of its own (unlike `limit`), so this is the case that actually discriminates the
    // fix — `limit: 1e300` would already be rejected by the `> TASK_PAGE_LIMIT_MAX` bound alone,
    // whether or not `Number.isSafeInteger` is used.
    it('offset as the NUMBER 1e300 is rejected -> invalid_offset (not silently accepted as an unsafe "integer")', () => {
      expect(parsePageParams({ offset: 1e300 })).toEqual({ ok: false, reason: 'invalid_offset' })
    })

    it('limit as the NUMBER 1e300 is also rejected -> invalid_limit', () => {
      expect(parsePageParams({ limit: 1e300 })).toEqual({ ok: false, reason: 'invalid_limit' })
    })

    it('an unsafe-integer digit STRING is rejected (the string branch already used isSafeInteger; this is a regression pin, not a new discriminator)', () => {
      expect(parsePageParams({ offset: '99999999999999999999' })).toEqual({ ok: false, reason: 'invalid_offset' })
    })

    // "canonical" (the docstring's own word) means no leading zeros except the bare digit "0"
    // itself — `"007"`/`"00"` are non-canonical spellings of 7/0 and must be rejected, not silently
    // parsed. Before the fix, `^\d+$` accepted them.
    it('a leading-zero digit string ("007") is rejected, not silently parsed as 7', () => {
      expect(parsePageParams({ offset: '007' })).toEqual({ ok: false, reason: 'invalid_offset' })
      expect(parsePageParams({ limit: '007' })).toEqual({ ok: false, reason: 'invalid_limit' })
    })

    it('"00" is rejected (not a canonical spelling of 0)', () => {
      expect(parsePageParams({ offset: '00' })).toEqual({ ok: false, reason: 'invalid_offset' })
    })

    it('the bare digit "0" itself is still accepted (canonical spelling of zero)', () => {
      expect(parsePageParams({ offset: '0' })).toEqual({ ok: true, params: { limit: 100, offset: 0 } })
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
