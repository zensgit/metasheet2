import { describe, expect, it } from 'vitest'
import {
  attendanceGroupManagerCreatorId,
  attendanceGroupManagerCreatorLabel,
  collectAttendanceGroupManagerUserIds,
} from '../src/views/attendance/attendanceGroupManagerIdentity'

describe('attendance owner roster creator identity', () => {
  it('collects owners first, then distinct creators, without changing loaded rows', () => {
    const rows = Object.freeze([
      Object.freeze({ userId: ' owner-a ', createdBy: 'creator-a' }),
      Object.freeze({ user_id: 'owner-b', created_by: 'creator-a' }),
      Object.freeze({ userId: 'owner-a', createdBy: 'owner-b' }),
      Object.freeze({ userId: '', createdBy: 'creator-b' }),
      Object.freeze({ userId: 'owner-c', createdBy: '   ', created_by: 'creator-c' }),
      Object.freeze({ userId: 'owner-b', createdBy: null, created_by: '  ' }),
    ])
    expect(collectAttendanceGroupManagerUserIds(rows)).toEqual([
      'owner-a', 'owner-b', 'owner-c', 'creator-a', 'creator-b', 'creator-c',
    ])
    expect(rows[0]).toEqual({ userId: ' owner-a ', createdBy: 'creator-a' })
    expect(collectAttendanceGroupManagerUserIds([])).toEqual([])
    expect(collectAttendanceGroupManagerUserIds([{ userId: '', createdBy: ' ' }])).toEqual([])
  })

  it.each<{ row: Parameters<typeof attendanceGroupManagerCreatorId>[0]; expected: string }>([
    { row: {}, expected: '' },
    { row: { createdBy: null, created_by: null }, expected: '' },
    { row: { createdBy: '  ', created_by: '' }, expected: '' },
    { row: { createdBy: ' creator-camel ', created_by: 'creator-snake' }, expected: 'creator-camel' },
    { row: { createdBy: '', created_by: ' creator-snake ' }, expected: 'creator-snake' },
  ])('normalizes creator aliases: $expected', ({ row, expected }) => {
    expect(attendanceGroupManagerCreatorId(row)).toBe(expected)
  })

  it('uses only the creator directory entry, preferring name then email', () => {
    const row = { userId: 'owner', createdBy: 'creator' }
    expect(attendanceGroupManagerCreatorLabel(row, {
      owner: { name: 'Synthetic Owner', email: 'owner@example.invalid' },
      creator: { name: ' Synthetic Creator ', email: 'creator@example.invalid' },
    }, 'User')).toBe('Synthetic Creator')
    expect(attendanceGroupManagerCreatorLabel(row, {
      creator: { name: '  ', email: ' creator@example.invalid ' },
    }, 'User')).toBe('creator@example.invalid')
  })

  it.each(['User', '用户'])('uses localized neutral text for unresolved creators: %s', (neutral) => {
    const row = { userId: 'owner', createdBy: 'unresolved-actor' }
    expect(attendanceGroupManagerCreatorLabel(row, {
      owner: { name: 'Synthetic Owner', email: 'owner@example.invalid' },
    }, neutral)).toBe(neutral)
    expect(attendanceGroupManagerCreatorLabel(row, {
      'unresolved-actor': { name: null, email: ' ' },
    }, neutral)).toBe(neutral)
    expect(attendanceGroupManagerCreatorLabel({ userId: 'owner' }, {}, neutral)).toBe('-')
  })

  it('preserves genuine names equal to IDs, including UUID-shaped names', () => {
    for (const id of ['synthetic-actor', '11111111-1111-4111-8111-111111111111']) {
      expect(attendanceGroupManagerCreatorLabel({ createdBy: id }, {
        [id]: { name: id, email: 'synthetic@example.invalid' },
      }, 'User')).toBe(id)
    }
  })
  it('uses only own directory entries for prototype-named creator IDs', () => {
    for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const row = { createdBy: id }
      expect(attendanceGroupManagerCreatorLabel(row, {}, 'User')).toBe('User')
      const inherited = Object.create({ [id]: { name: 'Inherited label' } }) as Record<string, { name: string }>
      expect(attendanceGroupManagerCreatorLabel(row, inherited, 'User')).toBe('User')
      expect(attendanceGroupManagerCreatorLabel(row, Object.fromEntries([[id, { name: 'Actual Creator' }]]), 'User')).toBe('Actual Creator')
    }
  })

})
