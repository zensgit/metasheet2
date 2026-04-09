import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import AfterSalesView from '../src/views/AfterSalesView.vue'

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/api', () => ({
  apiFetch: apiFetchMock,
}))

interface MockResponseOptions {
  ok?: boolean
  status?: number
  statusText?: string
}

function createResponse(payload: unknown, options: MockResponseOptions = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: async () => ({
      ok: options.ok ?? true,
      data: payload,
    }),
  } as Response
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitForText(container: HTMLElement, text: string, cycles = 24): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    if (container.textContent?.includes(text)) return
    await flushUi(1)
  }

  throw new Error(`Timed out waiting for text: ${text}`)
}

function mountAfterSalesView() {
  const container = document.createElement('div')
  document.body.appendChild(container)

  const app = createApp(AfterSalesView)
  app.mount(container)

  return { app, container }
}

describe('AfterSalesView service records', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('loads recent service records once installed', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'installed',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'installed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
            reportRef: 'install-001',
          },
          reportRef: 'install-001',
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          serviceRecords: [
            {
              id: 'sr-1',
              version: 1,
              data: {
                ticketNo: 'AF-201',
                visitType: 'onsite',
                scheduledAt: '2026-04-09',
                technicianName: 'Taylor',
                workSummary: 'Replaced compressor',
                result: 'resolved',
              },
            },
          ],
        })
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, 'AF-201')

    expect(container?.textContent).toContain('Recent visits')
    expect(container?.textContent).toContain('AF-201')
    expect(container?.textContent).toContain('onsite')
    expect(container?.textContent).toContain('resolved')
    expect(container?.textContent).toContain('Taylor')
    expect(apiFetchMock).toHaveBeenCalledWith('/api/after-sales/service-records', undefined)
  })

  it('shows an inline error when service record loading fails', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'installed',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'installed',
            createdObjects: [],
            createdViews: [],
            warnings: [],
            reportRef: 'install-001',
          },
          reportRef: 'install-001',
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse(
          null,
          {
            ok: false,
            status: 404,
            statusText: 'Not Found',
          },
        )
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await waitForText(container, '404 Not Found')

    expect(container?.textContent).toContain('404 Not Found')
    expect(container?.textContent).toContain('Install state')
  })

  it('skips service record loading before install', async () => {
    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        return createResponse({
          status: 'not-installed',
        })
      }

      if (path === '/api/after-sales/service-records') {
        throw new Error('service records should not load before install')
      }

      throw new Error(`Unexpected request: ${path}`)
    })

    const mounted = mountAfterSalesView()
    app = mounted.app
    container = mounted.container

    await flushUi(4)

    expect(container?.textContent).toContain('Enable After Sales')
    expect(container?.textContent).not.toContain('Recent visits')
    expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/service-records', undefined)
  })
})
