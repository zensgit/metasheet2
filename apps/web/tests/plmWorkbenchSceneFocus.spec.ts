import { describe, expect, it } from 'vitest'
import {
  buildWorkbenchSceneFocusQuery,
  readWorkbenchSceneFocus,
} from '../src/views/plm/plmWorkbenchSceneFocus'

describe('plmWorkbenchSceneFocus', () => {
  it('builds a return query snapshot with the transient scene focus', () => {
    expect(buildWorkbenchSceneFocusQuery({
      workbenchTeamView: 'view-1',
      searchQuery: 'motor',
    }, 'scene-1')).toEqual({
      workbenchTeamView: 'view-1',
      searchQuery: 'motor',
      sceneFocus: 'scene-1',
    })
  })

  it('reads the transient scene focus from a query snapshot', () => {
    expect(readWorkbenchSceneFocus({
      sceneFocus: 'scene-2',
    })).toBe('scene-2')
  })

  it('returns an empty string when the transient scene focus is absent', () => {
    expect(readWorkbenchSceneFocus({
      workbenchTeamView: 'view-1',
    })).toBe('')
  })

  it('reads the first scene focus value from multi-value queries', () => {
    expect(readWorkbenchSceneFocus({
      sceneFocus: ['scene-3', 'scene-4'],
    })).toBe('scene-3')
  })
})
