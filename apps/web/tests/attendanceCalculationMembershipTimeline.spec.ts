import { describe, expect, it } from 'vitest'
import {
  readAttendanceCalculationMembershipHistory,
  type AttendanceCalculationHistoryInterval,
} from '../src/views/attendance/attendanceCalculationMembershipHistory'

const scope = { orgId: 'history-org', userId: 'history-user' }
const ID_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ID_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const GROUP_A = '11111111-2222-ffff-0000-333333333333'
const GROUP_B = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB'

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...scope,
    id: ID_A,
    groupId: GROUP_A,
    effectiveFrom: '2024-02-01',
    effectiveTo: '2024-02-28',
    ...overrides,
  }
}

function envelope(items: unknown) {
  return { ok: true, data: { items } }
}

describe('readAttendanceCalculationMembershipHistory', () => {
  it('projects inclusive D-1/D intervals and preserves source order and UUID spelling', () => {
    const expected: readonly AttendanceCalculationHistoryInterval[] = [
      { id: ID_B.toUpperCase(), groupId: GROUP_A, effectiveFrom: '2024-02-01', effectiveTo: '2024-02-28' },
      { id: ID_A, groupId: GROUP_B, effectiveFrom: '2024-02-29', effectiveTo: '2024-02-29' },
    ]
    const items = expected.map(interval => ({ ...scope, ...interval }))
    expect(readAttendanceCalculationMembershipHistory(envelope(items), scope)).toEqual(expected)
  })

  it('preserves a future open interval without inferring current activity', () => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row(),
      row({ id: ID_B, effectiveFrom: '2099-01-01', effectiveTo: null }),
    ]), scope)).toEqual([
      { id: ID_A, groupId: GROUP_A, effectiveFrom: '2024-02-01', effectiveTo: '2024-02-28' },
      { id: ID_B, groupId: GROUP_A, effectiveFrom: '2099-01-01', effectiveTo: null },
    ])
  })

  it('accepts a legitimate empty timeline without a default interval', () => {
    expect(readAttendanceCalculationMembershipHistory(envelope([]), scope)).toEqual([])
  })

  it('accepts leap-century dates and preserves calendar strings', () => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row({ effectiveFrom: '2000-02-29', effectiveTo: '2000-03-01' }),
    ]), scope)).toEqual([
      { id: ID_A, groupId: GROUP_A, effectiveFrom: '2000-02-29', effectiveTo: '2000-03-01' },
    ])
  })

  it('ignores audit and secret fields, without mutating input or echoing their values', () => {
    const items = Object.freeze([
      Object.freeze(row({
        assignedBy: 'raw-actor-marker',
        assignedReason: 'raw-reason-marker',
        assignedCorrelationId: 'raw-correlation-marker',
        closedBy: 'raw-closed-marker',
        secret: { authorityCode: 'raw-secret-marker' },
        createdAt: '2099-12-31T23:59:59Z',
      })),
      Object.freeze(row({
        id: ID_B,
        effectiveFrom: '2024-03-01',
        effectiveTo: null,
        createdAt: 'not-a-date',
        active: true,
      })),
    ])
    expect(readAttendanceCalculationMembershipHistory(envelope(items), scope)).toEqual([
      { id: ID_A, groupId: GROUP_A, effectiveFrom: '2024-02-01', effectiveTo: '2024-02-28' },
      { id: ID_B, groupId: GROUP_A, effectiveFrom: '2024-03-01', effectiveTo: null },
    ])
  })

  it.each([
    '2023-02-29', '1900-02-29', '2024-02-30', '2024-04-31',
    '2024-00-01', '2024-13-01', '2024-01-00', '2024-01-32',
    '2024-2-01', '2024-02-1', '0000-01-01', '0099-01-01',
    '2024-02-01T00:00:00Z', ' 2024-02-01', '2024-02-01 ',
    '', null, undefined, 20240201,
  ])('rejects invalid effectiveFrom %j', effectiveFrom => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row({ effectiveFrom, effectiveTo: null }),
    ]), scope)).toBeNull()
  })

  it.each([
    '2023-02-29', '2024-02-30', '2024-04-31', '2024-00-01',
    '2024-13-01', '2024-01-00', '2024-01-32', '2024-2-01',
    '0000-01-01', '0099-01-01', '2024-02-28T00:00:00Z',
    ' 2024-02-28', '2024-02-28 ', '', undefined, 20240228,
  ])('rejects invalid effectiveTo %j', effectiveTo => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row({ effectiveTo }),
    ]), scope)).toBeNull()
  })

  it.each(['id', 'groupId', 'orgId', 'userId', 'effectiveFrom', 'effectiveTo'])('rejects missing required %s', field => {
    const item = row()
    delete item[field]
    expect(readAttendanceCalculationMembershipHistory(envelope([item]), scope)).toBeNull()
  })

  it.each(['id', 'groupId'])('validates %s without trimming or coercion', field => {
    for (const value of [null, undefined, 42, {}, '', 'not-a-uuid', ` ${ID_A}`, `${ID_A} `]) {
      expect(readAttendanceCalculationMembershipHistory(envelope([
        row({ [field]: value }),
      ]), scope)).toBeNull()
    }
  })

  it.each(['orgId', 'userId'])('rejects mismatched %s and never returns a partial timeline', field => {
    for (const value of ['other-scope', ` ${scope[field as keyof typeof scope]}`, null, 42]) {
      expect(readAttendanceCalculationMembershipHistory(envelope([
        row(),
        row({ id: ID_B, effectiveFrom: '2024-03-01', effectiveTo: null, [field]: value }),
      ]), scope)).toBeNull()
    }
  })

  it.each([
    { orgId: '', userId: scope.userId },
    { orgId: '   ', userId: scope.userId },
    { orgId: scope.orgId, userId: '' },
    { orgId: scope.orgId, userId: '   ' },
  ])('rejects empty scope fields even for empty items: %j', invalidScope => {
    expect(readAttendanceCalculationMembershipHistory(envelope([]), invalidScope)).toBeNull()
  })

  it('rejects an end before its start', () => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row({ effectiveTo: '2024-01-31' }),
    ]), scope)).toBeNull()
  })

  it('rejects reverse order rather than sorting', () => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row({ effectiveFrom: '2024-03-01', effectiveTo: '2024-03-31' }),
      row({ id: ID_B }),
    ]), scope)).toBeNull()
  })

  it.each(['2024-02-01', '2024-02-15', '2024-02-28'])('rejects overlap including a shared endpoint at %s', effectiveFrom => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row(),
      row({ id: ID_B, effectiveFrom, effectiveTo: '2024-03-01' }),
    ]), scope)).toBeNull()
  })

  it('rejects any row after an open interval', () => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row({ effectiveTo: null }),
      row({ id: ID_B, effectiveFrom: '2099-01-01', effectiveTo: null }),
    ]), scope)).toBeNull()
  })

  it.each([ID_A, ID_A.toUpperCase()])('rejects duplicate row identity %s case insensitively', id => {
    expect(readAttendanceCalculationMembershipHistory(envelope([
      row(),
      row({ id, effectiveFrom: '2024-03-01', effectiveTo: null }),
    ]), scope)).toBeNull()
  })

  it.each([
    null, undefined, [], 'raw-envelope-marker',
    { data: { items: [] } },
    { ok: false, data: { items: [] } },
    { ok: 'true', data: { items: [] } },
    { ok: 1, data: { items: [] } },
    { ok: true }, { ok: true, data: null }, { ok: true, data: [] },
    { ok: true, data: { items: null } },
    { ok: true, data: { items: {} } },
    { ok: true, data: { items: 'raw-items-marker' } },
    { ok: true, items: [] },
    envelope([null]), envelope([42]), envelope([[]]),
    envelope([row(), 'raw-row-marker']),
  ])('rejects malformed envelopes or rows %j', payload => {
    expect(readAttendanceCalculationMembershipHistory(payload, scope)).toBeNull()
  })
})
