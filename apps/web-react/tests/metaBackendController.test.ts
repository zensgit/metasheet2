import { describe, expect, it, vi } from 'vitest'
import type { IWorkbookData } from '@univerjs/core'
import {
  bootstrapMetaBackendSession,
  createLocalMetaBackendState,
  refreshMetaBackendState,
} from '../src/metaBackendController'

const FALLBACK_WORKBOOK = {
  id: 'fallback',
  appVersion: '0.12.0',
  locale: 'en_US',
  name: 'Fallback',
  sheetOrder: [],
  styles: {},
  sheets: {},
} as unknown as IWorkbookData

describe('metaBackendController', () => {
  it('creates the local reset state from the fallback workbook', () => {
    expect(createLocalMetaBackendState(FALLBACK_WORKBOOK)).toEqual({
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

  it('bootstraps the dev token once and maps token failures to UI state', async () => {
    const okClient = {
      ensureDevToken: vi.fn(async () => 'token-1'),
      fetchViews: vi.fn(),
      fetchMetaView: vi.fn(),
    }

    await expect(
      bootstrapMetaBackendSession({
        client: okClient,
        tokenBootstrapped: false,
      }),
    ).resolves.toEqual({
      ok: true,
      tokenBootstrapped: true,
      clearTokenError: true,
    })

    const failedClient = {
      ensureDevToken: vi.fn(async () => {
        throw new Error('Missing dev token')
      }),
      fetchViews: vi.fn(),
      fetchMetaView: vi.fn(),
    }

    await expect(
      bootstrapMetaBackendSession({
        client: failedClient,
        tokenBootstrapped: false,
        now: new Date('2026-03-06T12:00:00Z'),
      }),
    ).resolves.toEqual({
      ok: false,
      tokenBootstrapped: false,
      status: 'error',
      error: 'Missing dev token',
      lastErrorInfo: {
        scope: 'token',
        message: 'Missing dev token',
        status: undefined,
        url: undefined,
        at: new Date('2026-03-06T12:00:00Z').toLocaleTimeString(),
      },
      viewsStatus: 'error',
      viewsError: 'Missing dev token',
      isRefreshing: false,
    })
  })

  it('refreshes views and workbook data while preserving the latest failing scope', async () => {
    const current = createLocalMetaBackendState(FALLBACK_WORKBOOK)
    current.viewsStatus = 'loading'
    current.status = 'loading'

    const buildWorkbook = vi.fn(() => ({
      ...FALLBACK_WORKBOOK,
      id: 'loaded',
    }))

    const client = {
      ensureDevToken: vi.fn(),
      fetchViews: vi.fn(async () => [{ id: 'view-1', name: 'Main Grid', type: 'grid' }]),
      fetchMetaView: vi.fn(async () => ({
        ok: true,
        data: {
          fields: [{ id: 'name', name: 'Name', type: 'string' }],
          rows: [{ id: 'row-1', data: { name: 'Alice' } }],
        },
      })),
    }

    await expect(
      refreshMetaBackendState({
        client,
        current,
        refreshViews: true,
        fallbackWorkbook: FALLBACK_WORKBOOK,
        buildWorkbook,
        now: new Date('2026-03-06T12:00:00Z'),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'ready',
        error: null,
        views: [{ id: 'view-1', name: 'Main Grid', type: 'grid' }],
        viewsStatus: 'ready',
        viewsError: null,
        dataErrorAt: null,
        workbookData: expect.objectContaining({ id: 'loaded' }),
      }),
    )

    const dataFailureClient = {
      ensureDevToken: vi.fn(),
      fetchViews: vi.fn(async () => [{ id: 'view-2', name: 'Ops', type: 'calendar' }]),
      fetchMetaView: vi.fn(async () => {
        throw new Error('view data failed')
      }),
    }

    await expect(
      refreshMetaBackendState({
        client: dataFailureClient,
        current,
        refreshViews: true,
        fallbackWorkbook: FALLBACK_WORKBOOK,
        buildWorkbook,
        now: new Date('2026-03-06T12:00:00Z'),
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'error',
        error: 'view data failed',
        views: [{ id: 'view-2', name: 'Ops', type: 'calendar' }],
        viewsStatus: 'ready',
        workbookData: FALLBACK_WORKBOOK,
        lastErrorInfo: expect.objectContaining({
          scope: 'data',
          message: 'view data failed',
        }),
      }),
    )
  })
})
