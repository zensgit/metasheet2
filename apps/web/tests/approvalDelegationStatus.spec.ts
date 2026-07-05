import { describe, expect, it } from 'vitest'
import {
  delegationDisplayStatus,
  DELEGATION_STATUS_TAG_TYPE,
  type DelegationStatusRow,
} from '../src/approvals/delegationStatus'

// B2-05 — PURE-LOGIC tests (no .vue / no Element Plus) for the time-aware delegation status
// matrix. A `DelegationRecord` only carries a raw `active` boolean (server-side: "not manually
// disabled"); neither DelegationSettingsView nor MyDelegationView previously consulted the
// startAt/endAt window, so an expired (or not-yet-started) delegation still showed a flat "生效"
// tag. See delegationStatus.ts for the full rationale; this file locks the matrix: before-start /
// active / expired / disabled (+ disabled-overrides-window precedence) / expiringSoon boundaries /
// inclusive window edges / malformed-input defensiveness / the default-`now` path.

const NOW = new Date('2026-07-04T12:00:00Z')
const HOUR = 60 * 60 * 1000

function row(overrides: Partial<DelegationStatusRow> = {}): DelegationStatusRow {
  return {
    active: true,
    startAt: new Date(NOW.getTime() - HOUR).toISOString(),
    endAt: new Date(NOW.getTime() + HOUR).toISOString(),
    ...overrides,
  }
}

describe('delegationDisplayStatus', () => {
  it('未开始: now before startAt (active window not yet reached)', () => {
    const r = row({ startAt: new Date(NOW.getTime() + HOUR).toISOString(), endAt: new Date(NOW.getTime() + 2 * HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '未开始', expiringSoon: false })
  })

  it('生效中: now strictly inside the window, far from expiry', () => {
    const r = row({ startAt: new Date(NOW.getTime() - HOUR).toISOString(), endAt: new Date(NOW.getTime() + 200 * HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '生效中', expiringSoon: false })
  })

  it('已过期: now after endAt', () => {
    const r = row({ startAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(), endAt: new Date(NOW.getTime() - HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '已过期', expiringSoon: false })
  })

  it('已停用: active === false reads 已停用 even though the window is currently 生效中', () => {
    const r = row({ active: false, startAt: new Date(NOW.getTime() - HOUR).toISOString(), endAt: new Date(NOW.getTime() + HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '已停用', expiringSoon: false })
  })

  it('已停用 takes precedence over an otherwise-已过期 window (disabled always wins)', () => {
    const r = row({ active: false, startAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(), endAt: new Date(NOW.getTime() - HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '已停用', expiringSoon: false })
  })

  it('已停用 takes precedence over an otherwise-未开始 window (disabled always wins)', () => {
    const r = row({ active: false, startAt: new Date(NOW.getTime() + HOUR).toISOString(), endAt: new Date(NOW.getTime() + 2 * HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '已停用', expiringSoon: false })
  })

  it('window boundaries are INCLUSIVE: now === startAt is already 生效中', () => {
    const r = row({ startAt: NOW.toISOString(), endAt: new Date(NOW.getTime() + HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW).status).toBe('生效中')
  })

  it('window boundaries are INCLUSIVE: now === endAt is still 生效中 (not yet 已过期)', () => {
    const r = row({ startAt: new Date(NOW.getTime() - HOUR).toISOString(), endAt: NOW.toISOString() })
    expect(delegationDisplayStatus(r, NOW).status).toBe('生效中')
  })

  it('expiringSoon: true exactly at the 72h boundary (inclusive)', () => {
    const r = row({ endAt: new Date(NOW.getTime() + 72 * HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '生效中', expiringSoon: true })
  })

  it('expiringSoon: false just past the 72h boundary', () => {
    const r = row({ endAt: new Date(NOW.getTime() + 72 * HOUR + 60_000).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '生效中', expiringSoon: false })
  })

  it('expiringSoon: false when 已停用, even if the window would otherwise be within 72h', () => {
    const r = row({ active: false, endAt: new Date(NOW.getTime() + HOUR).toISOString() })
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '已停用', expiringSoon: false })
  })

  it('is defensive against unparseable startAt/endAt: does not throw, degrades to 生效中', () => {
    const r = row({ startAt: 'not-a-date', endAt: 'also-not-a-date' })
    expect(() => delegationDisplayStatus(r, NOW)).not.toThrow()
    expect(delegationDisplayStatus(r, NOW)).toEqual({ status: '生效中', expiringSoon: false })
  })

  it('defaults `now` to the current time when omitted', () => {
    const r = row({
      startAt: new Date(Date.now() - HOUR).toISOString(),
      endAt: new Date(Date.now() + 200 * HOUR).toISOString(),
    })
    expect(delegationDisplayStatus(r).status).toBe('生效中')
  })

  it('DELEGATION_STATUS_TAG_TYPE maps one distinct el-tag type per status', () => {
    expect(DELEGATION_STATUS_TAG_TYPE).toEqual({
      未开始: 'info',
      生效中: 'success',
      已过期: 'warning',
      已停用: 'danger',
    })
  })
})
