import { describe, expect, it } from 'vitest'
import { resolveRouteDocumentTitle } from '../src/router/routeTitles'

describe('resolveRouteDocumentTitle', () => {
  it('prefers localized route titles for zh', () => {
    expect(resolveRouteDocumentTitle({ title: 'Attendance', titleZh: '考勤' }, true)).toBe('考勤 - MetaSheet')
  })

  it('falls back to the default route title for non-zh', () => {
    expect(resolveRouteDocumentTitle({ title: 'Attendance', titleZh: '考勤' }, false)).toBe('Attendance - MetaSheet')
  })

  it('returns the shell title when no route title exists', () => {
    expect(resolveRouteDocumentTitle(undefined, true)).toBe('MetaSheet')
  })
})
