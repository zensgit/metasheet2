/**
 * 客户反馈 2026-09-24 #4c（日期时间显示），裁定见 PR #6074 — the instance business timezone resolver.
 *
 * Pins: unset / blank → Asia/Shanghai (the owner-ruled default, so a China deployment needs no env);
 * a valid IANA id is honoured (trimmed); anything Intl rejects falls back to the default instead of
 * reaching the web, and is logged ONCE without echoing the value (values-free).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger'
import {
  BUSINESS_TIMEZONE_ENV_KEY,
  DEFAULT_BUSINESS_TIMEZONE,
  resolveMultitableBusinessTimezone,
} from '../../src/multitable/business-timezone'

describe('resolveMultitableBusinessTimezone', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads MULTITABLE_BUSINESS_TIMEZONE and defaults to Asia/Shanghai', () => {
    expect(BUSINESS_TIMEZONE_ENV_KEY).toBe('MULTITABLE_BUSINESS_TIMEZONE')
    expect(DEFAULT_BUSINESS_TIMEZONE).toBe('Asia/Shanghai')
    expect(resolveMultitableBusinessTimezone({})).toBe('Asia/Shanghai')
    expect(resolveMultitableBusinessTimezone({ MULTITABLE_BUSINESS_TIMEZONE: '' })).toBe('Asia/Shanghai')
    expect(resolveMultitableBusinessTimezone({ MULTITABLE_BUSINESS_TIMEZONE: '   ' })).toBe('Asia/Shanghai')
  })

  it('honours a valid IANA zone, trimmed', () => {
    expect(resolveMultitableBusinessTimezone({ MULTITABLE_BUSINESS_TIMEZONE: 'Asia/Tokyo' })).toBe('Asia/Tokyo')
    expect(resolveMultitableBusinessTimezone({ MULTITABLE_BUSINESS_TIMEZONE: '  Europe/Berlin ' })).toBe('Europe/Berlin')
    expect(resolveMultitableBusinessTimezone({ MULTITABLE_BUSINESS_TIMEZONE: 'UTC' })).toBe('UTC')
  })

  it('falls back to the default for a zone Intl rejects, and warns once without the value', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const bad = 'Mars/Olympus_Mons'
    expect(resolveMultitableBusinessTimezone({ MULTITABLE_BUSINESS_TIMEZONE: bad })).toBe('Asia/Shanghai')
    expect(resolveMultitableBusinessTimezone({ MULTITABLE_BUSINESS_TIMEZONE: bad })).toBe('Asia/Shanghai')
    expect(resolveMultitableBusinessTimezone({ MULTITABLE_BUSINESS_TIMEZONE: '+08:00 not a zone' })).toBe('Asia/Shanghai')
    expect(warn).toHaveBeenCalledTimes(2) // once per distinct bad value, not per call
    for (const call of warn.mock.calls) {
      expect(String(call[0])).toContain('MULTITABLE_BUSINESS_TIMEZONE')
      expect(String(call[0])).not.toContain('Mars')
      expect(String(call[0])).not.toContain('not a zone')
    }
  })

  it('reads process.env by default', () => {
    const previous = process.env.MULTITABLE_BUSINESS_TIMEZONE
    try {
      process.env.MULTITABLE_BUSINESS_TIMEZONE = 'America/New_York'
      expect(resolveMultitableBusinessTimezone()).toBe('America/New_York')
      delete process.env.MULTITABLE_BUSINESS_TIMEZONE
      expect(resolveMultitableBusinessTimezone()).toBe('Asia/Shanghai')
    } finally {
      if (previous === undefined) delete process.env.MULTITABLE_BUSINESS_TIMEZONE
      else process.env.MULTITABLE_BUSINESS_TIMEZONE = previous
    }
  })
})
