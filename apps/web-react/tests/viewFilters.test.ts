import { describe, expect, it } from 'vitest'
import { filterViews, getViewTypeLabel, groupViews, normalizeViewType, type ViewOption } from '../src/viewFilters'

describe('viewFilters helpers', () => {
  const views: ViewOption[] = [
    { id: 'v-1', name: 'Release Board', type: 'kanban' },
    { id: 'v-2', name: 'Calendar Ops', type: 'calendar' },
    { id: 'v-3', name: 'Alpha Grid', type: 'grid' },
    { id: 'v-4', name: 'Untyped Board' },
  ]

  it('filters views by type and search keyword', () => {
    expect(filterViews(views, 'alpha', 'all')).toEqual([
      expect.objectContaining({ id: 'v-3' }),
    ])
    expect(filterViews(views, '', 'calendar')).toEqual([
      expect.objectContaining({ id: 'v-2' }),
    ])
    expect(filterViews(views, 'board', 'other')).toEqual([
      expect.objectContaining({ id: 'v-4' }),
    ])
  })

  it('groups views by normalized type and sorts names inside each group', () => {
    const groups = groupViews([
      { id: '2', name: 'Zulu', type: 'grid' },
      { id: '1', name: 'Alpha', type: 'grid' },
      { id: '3', name: 'Canvas' },
    ])

    expect(groups).toEqual([
      {
        type: 'grid',
        label: 'Grid',
        views: [
          expect.objectContaining({ id: '1', name: 'Alpha' }),
          expect.objectContaining({ id: '2', name: 'Zulu' }),
        ],
      },
      {
        type: 'other',
        label: 'Other',
        views: [
          expect.objectContaining({ id: '3', name: 'Canvas' }),
        ],
      },
    ])
  })

  it('normalizes and labels unknown view types as other', () => {
    expect(normalizeViewType('timeline')).toBe('other')
    expect(getViewTypeLabel('timeline')).toBe('Other')
  })
})
