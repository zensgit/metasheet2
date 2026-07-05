/**
 * B1-03: 已等待 aging + severity — pure `relativeWait` module contract.
 *
 * `now` is always passed explicitly here so the matrix is independent of wall-clock time.
 */
import { describe, expect, it } from 'vitest'
import { formatRelativeWait, waitSeverity } from '../src/approvals/relativeWait'

const NOW = new Date('2026-07-05T12:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000).toISOString()
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString()
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString()

describe('approvals/relativeWait', () => {
  describe('formatRelativeWait', () => {
    it('renders 刚刚 under an hour (boundary: 59m)', () => {
      expect(formatRelativeWait(minutesAgo(59), NOW)).toBe('刚刚')
    })

    it('renders whole hours from 1h up to (not including) 24h', () => {
      expect(formatRelativeWait(hoursAgo(1), NOW)).toBe('1 小时')
      expect(formatRelativeWait(hoursAgo(23), NOW)).toBe('23 小时')
    })

    it('renders whole days (rounded down) from 24h onward (boundary: 24h -> 1 天)', () => {
      expect(formatRelativeWait(hoursAgo(24), NOW)).toBe('1 天')
      expect(formatRelativeWait(daysAgo(3), NOW)).toBe('3 天')
      expect(formatRelativeWait(daysAgo(7), NOW)).toBe('7 天')
    })

    it('rounds a partial day down (e.g. 3 天 5 小时 -> 3 天)', () => {
      expect(formatRelativeWait(hoursAgo(3 * 24 + 5), NOW)).toBe('3 天')
    })

    it('returns "" for an invalid/unparseable createdAt', () => {
      expect(formatRelativeWait('not-a-date', NOW)).toBe('')
      expect(formatRelativeWait('', NOW)).toBe('')
    })

    it('treats a future createdAt (clock skew) as 刚刚 rather than a negative duration', () => {
      expect(formatRelativeWait(minutesAgo(-5), NOW)).toBe('刚刚')
    })

    it('defaults `now` to the current wall clock when omitted', () => {
      expect(formatRelativeWait(new Date().toISOString())).toBe('刚刚')
    })
  })

  describe('waitSeverity', () => {
    it('is normal at and under 3 days', () => {
      expect(waitSeverity(hoursAgo(1), NOW)).toBe('normal')
      expect(waitSeverity(daysAgo(3), NOW)).toBe('normal')
    })

    it('is warn beyond 3 days and at/under 7 days (boundary: 3d+1ms, 7d)', () => {
      expect(waitSeverity(new Date(NOW.getTime() - (3 * 24 * 60 * 60 * 1000 + 1)).toISOString(), NOW)).toBe('warn')
      expect(waitSeverity(daysAgo(7), NOW)).toBe('warn')
    })

    it('is urgent beyond 7 days (boundary: 7d+1ms)', () => {
      expect(waitSeverity(new Date(NOW.getTime() - (7 * 24 * 60 * 60 * 1000 + 1)).toISOString(), NOW)).toBe('urgent')
      expect(waitSeverity(daysAgo(30), NOW)).toBe('urgent')
    })

    it('is normal for an invalid/unparseable createdAt (fail-quiet, pairs with formatRelativeWait\'s "")', () => {
      expect(waitSeverity('not-a-date', NOW)).toBe('normal')
    })
  })
})
