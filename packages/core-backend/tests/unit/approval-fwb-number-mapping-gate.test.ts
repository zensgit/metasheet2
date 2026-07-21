import { describe, expect, test } from 'vitest'

import { hasUnavailableFwbNumberMapping } from '../../src/multitable/approval-fwb-activation'

describe('FWB exact-number activation stop rule', () => {
  test('rejects any number target while preserving non-numeric mappings', () => {
    expect(hasUnavailableFwbNumberMapping([
      { targetType: 'text' },
      { targetType: 'date' },
      { targetType: 'select' },
    ])).toBe(false)
    expect(hasUnavailableFwbNumberMapping([
      { targetType: 'text' },
      { targetType: 'number' },
    ])).toBe(true)
  })
})
