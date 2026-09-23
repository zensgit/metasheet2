import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_CATALOG_PAGE_SIZE,
  attendanceCatalogHasMore,
  attendanceCatalogListQuery,
  mergeAttendanceCatalogItems,
  readAttendanceCatalogPageNumber,
  readAttendanceCatalogTotal,
} from '../src/views/attendance/attendanceCatalogPage'

describe('attendance catalog page', () => {
  it('requests the parsePagination cap instead of the default page of 50', () => {
    expect(ATTENDANCE_CATALOG_PAGE_SIZE).toBe(200)
    expect(attendanceCatalogListQuery(1)).toEqual({ page: '1', pageSize: '200' })
    expect(attendanceCatalogListQuery(0)).toEqual({ page: '1', pageSize: '200' })
    expect(attendanceCatalogListQuery(2.9)).toEqual({ page: '2', pageSize: '200' })
  })

  it('keeps a server total that is larger than the loaded page', () => {
    expect(readAttendanceCatalogTotal(51, 50)).toBe(51)
    expect(readAttendanceCatalogTotal('240', 200)).toBe(240)
    expect(attendanceCatalogHasMore(50, 51)).toBe(true)
    expect(attendanceCatalogHasMore(200, 240)).toBe(true)
    expect(attendanceCatalogHasMore(51, 51)).toBe(false)
  })

  it('falls back to the loaded count when total is missing, and ignores a total smaller than the rows in hand', () => {
    expect(readAttendanceCatalogTotal(undefined, 3)).toBe(3)
    expect(readAttendanceCatalogTotal('nope', 2)).toBe(2)
    expect(readAttendanceCatalogTotal(-1, 4)).toBe(4)
    expect(readAttendanceCatalogTotal(0, 2)).toBe(2)
    expect(readAttendanceCatalogTotal(0, 0)).toBe(0)
    expect(readAttendanceCatalogPageNumber(undefined, 2)).toBe(2)
    expect(readAttendanceCatalogPageNumber('3', 1)).toBe(3)
    expect(readAttendanceCatalogPageNumber(0, 4)).toBe(4)
  })

  it('appends later pages by id and drops blank or duplicate ids', () => {
    const merged = mergeAttendanceCatalogItems(
      [{ id: 'a' }, { id: '' }],
      [{ id: 'a' }, { id: 'b' }, { id: '' }, { id: 'c' }],
      (item) => item.id,
    )
    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })
})
