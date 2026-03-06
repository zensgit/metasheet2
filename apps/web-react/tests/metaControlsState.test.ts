import { describe, expect, it } from 'vitest'
import {
  applyMetaControlsParams,
  clearMetaControlsState,
  createMetaControlsState,
  deriveMetaControlsCanApply,
  resetMetaControlsParams,
  selectMetaControlsView,
  updateMetaControlsRefreshInterval,
} from '../src/metaControlsState'

describe('metaControlsState', () => {
  it('creates the initial control state from defaults and stored values', () => {
    expect(
      createMetaControlsState({
        defaultSheetId: 'default-sheet',
        defaultViewId: 'default-view',
        storedBackend: true,
        storedConfig: { sheetId: 'stored-sheet', viewId: 'stored-view' },
        storedRefresh: { autoRefresh: true, intervalSec: 30 },
        storedViewFilters: { search: 'ops', type: 'calendar' },
      }),
    ).toEqual({
      autoRefresh: true,
      copyStatus: 'idle',
      refreshIntervalSec: 30,
      sheetId: 'stored-sheet',
      sheetIdInput: 'stored-sheet',
      useBackend: true,
      viewId: 'stored-view',
      viewIdInput: 'stored-view',
      viewSearch: 'ops',
      viewTypeFilter: 'calendar',
    })
  })

  it('applies, resets, and clears params without losing the current sheet', () => {
    const baseState = createMetaControlsState({
      defaultSheetId: 'default-sheet',
      defaultViewId: 'default-view',
      storedBackend: false,
      storedConfig: null,
      storedRefresh: null,
      storedViewFilters: null,
    })

    const appliedState = applyMetaControlsParams(
      {
        ...baseState,
        sheetIdInput: ' next-sheet ',
        viewIdInput: ' next-view ',
      },
      { defaultSheetId: 'default-sheet', defaultViewId: 'default-view' },
    )

    expect(appliedState.sheetId).toBe('next-sheet')
    expect(appliedState.viewId).toBe('next-view')
    expect(deriveMetaControlsCanApply(appliedState)).toBe(false)

    expect(
      clearMetaControlsState(
        {
          ...appliedState,
          copyStatus: 'failed',
          viewSearch: 'ops',
          viewTypeFilter: 'calendar',
        },
        { defaultViewId: 'default-view' },
      ),
    ).toEqual(
      expect.objectContaining({
        copyStatus: 'idle',
        sheetId: 'next-sheet',
        viewId: 'default-view',
        viewIdInput: 'default-view',
        viewSearch: '',
        viewTypeFilter: 'all',
      }),
    )

    expect(
      resetMetaControlsParams(appliedState, {
        defaultSheetId: 'default-sheet',
        defaultViewId: 'default-view',
      }),
    ).toEqual(
      expect.objectContaining({
        sheetId: 'default-sheet',
        sheetIdInput: 'default-sheet',
        viewId: 'default-view',
        viewIdInput: 'default-view',
      }),
    )
  })

  it('selects views and only accepts finite refresh intervals', () => {
    const state = createMetaControlsState({
      defaultSheetId: 'default-sheet',
      defaultViewId: '',
      storedBackend: false,
      storedConfig: null,
      storedRefresh: null,
      storedViewFilters: null,
    })

    expect(selectMetaControlsView(state, 'calendar-view')).toEqual(
      expect.objectContaining({
        viewId: 'calendar-view',
        viewIdInput: 'calendar-view',
      }),
    )

    expect(updateMetaControlsRefreshInterval(state, 60).refreshIntervalSec).toBe(60)
    expect(updateMetaControlsRefreshInterval(state, Number.NaN)).toBe(state)
  })
})
