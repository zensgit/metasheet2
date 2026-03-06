import { describe, expect, it } from 'vitest'
import type { IWorkbookData } from '@univerjs/core'
import {
  applyBootstrapFailureState,
  applyMetaBackendLoadingState,
  applyMetaBackendSnapshot,
  clearMetaBackendErrors,
  createMetaBackendState,
  toMetaBackendSnapshot,
} from '../src/metaBackendState'

const FALLBACK_WORKBOOK = {
  id: 'fallback',
  appVersion: '0.12.0',
  locale: 'en_US',
  name: 'Fallback',
  sheetOrder: [],
  styles: {},
  sheets: {},
} as unknown as IWorkbookData

describe('metaBackendState', () => {
  it('creates the local backend state and strips runtime-only fields from snapshots', () => {
    const state = createMetaBackendState(FALLBACK_WORKBOOK)

    expect(state).toEqual({
      status: 'local',
      error: null,
      lastErrorInfo: null,
      views: [],
      viewsStatus: 'idle',
      viewsError: null,
      viewsErrorAt: null,
      lastViewsAt: null,
      lastRefreshAt: null,
      dataErrorAt: null,
      workbookData: FALLBACK_WORKBOOK,
      isRefreshing: false,
    })
    expect(toMetaBackendSnapshot(state)).toEqual({
      status: 'local',
      error: null,
      lastErrorInfo: null,
      views: [],
      viewsStatus: 'idle',
      viewsError: null,
      viewsErrorAt: null,
      lastViewsAt: null,
      lastRefreshAt: null,
      dataErrorAt: null,
      workbookData: FALLBACK_WORKBOOK,
    })
  })

  it('applies loading and bootstrap failure transitions without dropping existing fields', () => {
    const loadingState = applyMetaBackendLoadingState(
      {
        ...createMetaBackendState(FALLBACK_WORKBOOK),
        error: 'old error',
        viewsError: 'old views error',
      },
      { quiet: false, refreshViews: true },
    )

    expect(loadingState).toEqual(
      expect.objectContaining({
        status: 'loading',
        error: null,
        viewsStatus: 'loading',
        viewsError: null,
        isRefreshing: true,
      }),
    )

    expect(
      applyBootstrapFailureState(loadingState, {
        error: 'Missing dev token',
        lastErrorInfo: {
          scope: 'token',
          message: 'Missing dev token',
          at: '12:00:00',
        },
        status: 'error',
        viewsError: 'Missing dev token',
        viewsStatus: 'error',
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'error',
        error: 'Missing dev token',
        viewsStatus: 'error',
        viewsError: 'Missing dev token',
        isRefreshing: false,
      }),
    )
  })

  it('clears transient errors and applies refresh snapshots while preserving runtime flags', () => {
    const state = {
      ...createMetaBackendState(FALLBACK_WORKBOOK),
      error: 'HTTP 500',
      lastErrorInfo: {
        scope: 'data' as const,
        message: 'HTTP 500',
        at: '12:00:00',
      },
      viewsError: 'HTTP 503',
      viewsErrorAt: '12:01:00',
      dataErrorAt: '12:02:00',
      isRefreshing: true,
    }

    expect(clearMetaBackendErrors(state)).toEqual(
      expect.objectContaining({
        error: null,
        lastErrorInfo: null,
        viewsError: null,
        viewsErrorAt: null,
        dataErrorAt: null,
        isRefreshing: true,
      }),
    )

    expect(
      applyMetaBackendSnapshot(state, {
        ...toMetaBackendSnapshot(state),
        status: 'ready',
        error: null,
        lastErrorInfo: null,
        views: [{ id: 'view-1', name: 'Main Grid', type: 'grid' }],
        viewsStatus: 'ready',
        viewsError: null,
        viewsErrorAt: null,
        lastViewsAt: '12:03:00',
        lastRefreshAt: '12:03:00',
        dataErrorAt: null,
        workbookData: { ...FALLBACK_WORKBOOK, id: 'loaded' },
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'ready',
        viewsStatus: 'ready',
        workbookData: expect.objectContaining({ id: 'loaded' }),
        isRefreshing: false,
      }),
    )
  })
})
