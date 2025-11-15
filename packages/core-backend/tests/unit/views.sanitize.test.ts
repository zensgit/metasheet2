import { describe, it, expect } from 'vitest'
import { sanitizeViews } from '../../src/utils/views'

describe('sanitizeViews', () => {
  it('returns empty array for non-array input', () => {
    expect(sanitizeViews(null as any)).toEqual([])
    expect(sanitizeViews(undefined as any)).toEqual([])
    expect(sanitizeViews(123 as any)).toEqual([])
    expect(sanitizeViews({} as any)).toEqual([])
  })

  it('filters out malformed items and preserves valid ones', () => {
    const input = [
      { id: 'a', name: 'A', component: 'CompA' },
      { id: 'b', name: 'B' },
      { id: 1, name: 'Bad' },
      { id: 'c', name: null },
      null,
      'string'
    ] as any

    const out = sanitizeViews(input)
    expect(out).toEqual([
      { id: 'a', name: 'A', component: 'CompA' },
      { id: 'b', name: 'B' }
    ])
  })
})

