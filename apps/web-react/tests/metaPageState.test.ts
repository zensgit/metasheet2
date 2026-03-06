import { describe, expect, it, vi } from 'vitest'
import {
  clearLastErrorScope,
  copyLastErrorInfo,
  deriveMetaPageState,
  formatAutoRefreshLabel,
  formatLastErrorLabel,
  REFRESH_INTERVAL_OPTIONS,
} from '../src/metaPageState'

describe('metaPageState', () => {
  it('derives retry flags, filtered groups, and labels from the page state', () => {
    expect(REFRESH_INTERVAL_OPTIONS).toEqual([10, 30, 60])

    expect(
      deriveMetaPageState({
        autoRefresh: true,
        isRefreshing: false,
        lastErrorInfo: {
          scope: 'views',
          message: 'HTTP 503',
          status: 503,
          url: 'https://api.example.com/views',
          at: '12:00:00',
        },
        pageVisible: false,
        status: 'error',
        useBackend: true,
        viewId: 'view-2',
        viewSearch: 'ops',
        views: [
          { id: 'view-1', name: 'Main Grid', type: 'grid' },
          { id: 'view-2', name: 'Ops Calendar', type: 'calendar' },
        ],
        viewsStatus: 'error',
        viewTypeFilter: 'calendar',
      }),
    ).toEqual({
      autoRefreshLabel: 'auto: paused',
      canRefresh: true,
      canRetryData: true,
      canRetryViews: true,
      filteredViews: [{ id: 'view-2', name: 'Ops Calendar', type: 'calendar' }],
      groupedViews: [
        {
          type: 'calendar',
          label: 'Calendar',
          views: [{ id: 'view-2', name: 'Ops Calendar', type: 'calendar' }],
        },
      ],
      lastErrorLabel: 'views HTTP 503 https://api.example.com/views @ 12:00:00',
      showViewIdInput: false,
      showViewSelect: true,
      viewTypeLabel: 'type: Calendar',
    })
  })

  it('formats labels and clears matching error scopes', () => {
    expect(formatAutoRefreshLabel(false, true)).toBe('auto: off')
    expect(formatAutoRefreshLabel(true, true)).toBe('auto: on')
    expect(formatLastErrorLabel(null)).toBe('')
    expect(
      clearLastErrorScope(
        {
          scope: 'token',
          message: 'Missing token',
          at: '12:00:00',
        },
        'token',
      ),
    ).toBeNull()
    expect(
      clearLastErrorScope(
        {
          scope: 'views',
          message: 'HTTP 500',
          at: '12:00:00',
        },
        'token',
      ),
    ).toEqual({
      scope: 'views',
      message: 'HTTP 500',
      at: '12:00:00',
    })
  })

  it('copies error details when clipboard access succeeds and reports failures', async () => {
    const lastErrorInfo = {
      scope: 'data' as const,
      message: 'view data failed',
      status: 500,
      url: 'https://api.example.com/view',
      at: '12:00:00',
    }

    await expect(copyLastErrorInfo(null, null)).resolves.toBe('idle')
    await expect(
      copyLastErrorInfo(lastErrorInfo, {
        writeText: vi.fn(async () => undefined),
      }),
    ).resolves.toBe('copied')
    await expect(
      copyLastErrorInfo(lastErrorInfo, {
        writeText: vi.fn(async () => {
          throw new Error('permission denied')
        }),
      }),
    ).resolves.toBe('failed')
  })
})
