import { describe, expect, it } from 'vitest'
import { isGridRangeFillEnabled } from '../src/multitable/utils/grid-range-fill-flags'

describe('isGridRangeFillEnabled', () => {
  it('enables only for the exact string true', () => {
    expect(isGridRangeFillEnabled('true')).toBe(true)
  })

  it.each([undefined, false, 'false', 'TRUE', '1', true, ' true '])(
    'stays disabled for %j',
    (value) => {
      expect(isGridRangeFillEnabled(value)).toBe(false)
    },
  )

  it('uses the build-time value when no value is supplied', () => {
    expect(isGridRangeFillEnabled()).toBe(false)
  })
})
