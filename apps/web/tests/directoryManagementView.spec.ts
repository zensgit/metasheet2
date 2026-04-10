import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import DirectoryManagementView from '../src/views/DirectoryManagementView.vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

async function flushUi(cycles = 6): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function createJsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

describe('DirectoryManagementView', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('loads integrations and recent runs on mount', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'dir-1',
              name: 'DingTalk CN',
              corpId: 'dingcorp',
              status: 'active',
              syncEnabled: true,
              scheduleCron: null,
              defaultDeprovisionPolicy: 'mark_inactive',
              lastSyncAt: '2026-04-08T01:00:00.000Z',
              lastSuccessAt: '2026-04-08T01:00:00.000Z',
              lastError: null,
              config: {
                appKey: 'ding-app-key',
                appSecretConfigured: true,
                rootDepartmentId: '1',
                baseUrl: null,
                pageSize: 50,
              },
              stats: {
                departmentCount: 12,
                accountCount: 98,
                pendingLinkCount: 4,
                linkedCount: 88,
                lastRunStatus: 'completed',
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'run-1',
              status: 'completed',
              startedAt: '2026-04-08T01:00:00.000Z',
              finishedAt: '2026-04-08T01:05:00.000Z',
              stats: {
                departmentsSynced: 12,
                accountsSynced: 98,
                pendingCount: 4,
                linkedCount: 88,
              },
              errorMessage: null,
            },
          ],
        },
      }))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    expect(apiFetchMock).toHaveBeenNthCalledWith(1, '/api/admin/directory/integrations')
    expect(apiFetchMock).toHaveBeenNthCalledWith(2, '/api/admin/directory/integrations/dir-1/runs?page=1&pageSize=10')
    expect(container?.textContent).toContain('DingTalk CN')
    expect(container?.textContent).toContain('账号 98')
    expect(container?.textContent).toContain('completed')
  })

  it('posts manual sync and refreshes the selected integration', async () => {
    apiFetchMock
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'dir-1',
              name: 'DingTalk CN',
              corpId: 'dingcorp',
              status: 'active',
              syncEnabled: true,
              scheduleCron: null,
              defaultDeprovisionPolicy: 'mark_inactive',
              lastSyncAt: '2026-04-08T01:00:00.000Z',
              lastSuccessAt: '2026-04-08T01:00:00.000Z',
              lastError: null,
              config: {
                appKey: 'ding-app-key',
                appSecretConfigured: true,
                rootDepartmentId: '1',
                baseUrl: null,
                pageSize: 50,
              },
              stats: {
                departmentCount: 12,
                accountCount: 98,
                pendingLinkCount: 4,
                linkedCount: 88,
                lastRunStatus: 'completed',
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: { items: [] },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          integration: { id: 'dir-1' },
          run: { id: 'run-2', status: 'completed' },
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'dir-1',
              name: 'DingTalk CN',
              corpId: 'dingcorp',
              status: 'active',
              syncEnabled: true,
              scheduleCron: null,
              defaultDeprovisionPolicy: 'mark_inactive',
              lastSyncAt: '2026-04-08T02:00:00.000Z',
              lastSuccessAt: '2026-04-08T02:00:00.000Z',
              lastError: null,
              config: {
                appKey: 'ding-app-key',
                appSecretConfigured: true,
                rootDepartmentId: '1',
                baseUrl: null,
                pageSize: 50,
              },
              stats: {
                departmentCount: 13,
                accountCount: 99,
                pendingLinkCount: 3,
                linkedCount: 89,
                lastRunStatus: 'completed',
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(createJsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: 'run-2',
              status: 'completed',
              startedAt: '2026-04-08T02:00:00.000Z',
              finishedAt: '2026-04-08T02:05:00.000Z',
              stats: {
                departmentsSynced: 13,
                accountsSynced: 99,
                pendingCount: 3,
                linkedCount: 89,
              },
              errorMessage: null,
            },
          ],
        },
      }))

    app = createApp(DirectoryManagementView)
    app.component('RouterLink', {
      props: ['to'],
      template: '<a><slot /></a>',
    })
    app.mount(container!)
    await flushUi()

    const buttons = Array.from(container!.querySelectorAll('button'))
    const syncButton = buttons.find((button) => button.textContent?.includes('手动同步'))
    expect(syncButton).toBeTruthy()

    syncButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/admin/directory/integrations/dir-1/sync',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(container?.textContent).toContain('目录同步已完成')
    expect(container?.textContent).toContain('账号 99')
  })
})
