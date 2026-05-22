import { describe, expect, it } from 'vitest'
import {
  calendarHolidaySyncNotice,
  visibleRangeHasHolidayExpectation,
} from '../src/multitable/utils/calendar-holiday-notice'

describe('calendar holiday sync notice', () => {
  it('detects visible ranges that commonly contain synced public-holiday data', () => {
    expect(visibleRangeHasHolidayExpectation({ from: '2026-04-27', to: '2026-06-07' })).toBe(true)
    expect(visibleRangeHasHolidayExpectation({ from: '2026-07-01', to: '2026-08-31' })).toBe(false)
  })

  it('only shows the sync hint after a loaded range has no noteworthy holidays', () => {
    expect(calendarHolidaySyncNotice({
      state: 'empty',
      range: { from: '2026-04-27', to: '2026-06-07' },
      isZh: true,
    })).toContain('节假日')

    expect(calendarHolidaySyncNotice({
      state: 'ready',
      range: { from: '2026-04-27', to: '2026-06-07' },
      isZh: true,
    })).toBeNull()

    expect(calendarHolidaySyncNotice({
      state: 'empty',
      range: { from: '2026-07-01', to: '2026-08-31' },
      isZh: false,
    })).toBeNull()
  })
})
