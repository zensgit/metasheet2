import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_ADMIN_LIST_MAX_PAGES,
  ATTENDANCE_ADMIN_LIST_PAGE_SIZE,
  applyAttendanceAdminListPage,
  attendanceAdminListPageParams,
  attendanceAdminListTruncationKind,
  attendanceListCanLoadMore,
  beginAttendanceAdminListRequest,
  createAttendanceAdminListCursor,
  storeAttendanceAdminListPage,
} from '../src/views/attendance/attendanceAdminListPage'

describe('attendanceAdminListPage', () => {
  it('requests the API max page size and reads total', () => {
    expect(attendanceAdminListPageParams(1)).toEqual({
      page: '1',
      pageSize: String(ATTENDANCE_ADMIN_LIST_PAGE_SIZE),
    })
    expect(ATTENDANCE_ADMIN_LIST_PAGE_SIZE).toBe(200)

    const applied = applyAttendanceAdminListPage({
      current: [],
      incoming: [{ id: 'a' }],
      payload: { total: 3 },
      page: 1,
      append: false,
      idOf: (item) => item.id,
    })
    expect(applied.items.map((item) => item.id)).toEqual(['a'])
    expect(applied.total).toBe(3)
    expect(applied.received).toBe(1)
    expect(attendanceAdminListTruncationKind({
      loaded: applied.items.length,
      total: applied.total,
      page: applied.page,
      lastPageCount: applied.received,
    })).toBe('more')
  })

  it('appends the next page and stops when ids repeat or the cap is hit', () => {
    const cursor = createAttendanceAdminListCursor()
    const first = storeAttendanceAdminListPage(cursor, [], {
      incoming: [{ id: 'a' }],
      payload: { total: 3 },
      page: 1,
      append: false,
      idOf: (item) => item.id,
    })
    expect(beginAttendanceAdminListRequest(cursor, first.length, true)).toBe(2)

    const second = storeAttendanceAdminListPage(cursor, first, {
      incoming: [{ id: 'a' }, { id: 'b' }],
      payload: { total: 3 },
      page: 2,
      append: true,
      idOf: (item) => item.id,
    })
    expect(second.map((item) => item.id)).toEqual(['a', 'b'])

    const stalled = storeAttendanceAdminListPage(cursor, second, {
      incoming: [{ id: 'a' }, { id: 'b' }],
      payload: { total: 3 },
      page: 3,
      append: true,
      idOf: (item) => item.id,
    })
    expect(stalled).toHaveLength(2)
    expect(cursor.lastPageCount).toBe(0)
    expect(attendanceListCanLoadMore({
      loaded: stalled.length,
      total: cursor.total,
      page: cursor.page,
      lastPageCount: cursor.lastPageCount,
    })).toBe(false)
    expect(attendanceAdminListTruncationKind({
      loaded: stalled.length,
      total: cursor.total,
      page: cursor.page,
      lastPageCount: cursor.lastPageCount,
    })).toBe('stalled')

    const capped = attendanceAdminListTruncationKind({
      loaded: 1,
      total: 9999,
      page: ATTENDANCE_ADMIN_LIST_MAX_PAGES,
      lastPageCount: 1,
    })
    expect(capped).toBe('capped')
    expect(beginAttendanceAdminListRequest({
      total: 9999,
      page: ATTENDANCE_ADMIN_LIST_MAX_PAGES,
      lastPageCount: 1,
    }, 1, true)).toBeNull()
    expect(beginAttendanceAdminListRequest({
      total: 9999,
      page: ATTENDANCE_ADMIN_LIST_MAX_PAGES,
      lastPageCount: 1,
    }, 1, false)).toBe(1)
  })

  it('falls back to the loaded length when total is missing', () => {
    const applied = applyAttendanceAdminListPage({
      current: [],
      incoming: [{ id: 'only' }],
      payload: {},
      page: 1,
      append: false,
      idOf: (item) => item.id,
    })
    expect(applied.total).toBe(1)
    expect(attendanceAdminListTruncationKind({
      loaded: 1,
      total: applied.total,
      page: 1,
      lastPageCount: 1,
    })).toBe('complete')
  })
})
