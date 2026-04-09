import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'

import AfterSalesView from '../src/views/AfterSalesView.vue'

const apiFetchMock = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/api', () => ({
  apiFetch: apiFetchMock,
}))

function createResponse(payload: unknown, options: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: async () => ({
      ok: options.ok ?? true,
      data: payload,
      error:
        payload && typeof payload === 'object' && 'error' in payload
          ? (payload as { error?: unknown }).error
          : undefined,
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
    if (container.textContent?.includes(text)) {
      return
    }
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

function findSection(container: HTMLElement, headingText: string): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h2')).find((item) => item.textContent?.includes(headingText))
  const section = heading?.closest('section')
  if (!section) {
    throw new Error(`Section with heading ${headingText} not found`)
  }
  return section as HTMLElement
}

function findButtonWithin(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes(label))
  if (!button) {
    throw new Error(`Button with label ${label} not found`)
  }
  return button as HTMLButtonElement
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flushUi()
}

async function setSelectValue(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flushUi()
}

describe('AfterSalesView follow-ups panel', () => {
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

  it('loads follow-ups in partial state and supports filters with panel-local refresh', async () => {
    let currentStateCalls = 0
    let ticketCalls = 0
    let followUpBaseCalls = 0
    let followUpFilteredCalls = 0

    apiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/after-sales/app-manifest') {
        return createResponse({
          id: 'after-sales-default',
          displayName: 'After Sales',
          platformDependencies: ['core-backend'],
          objects: [{ id: 'followUp' }],
          workflows: [],
        })
      }

      if (path === '/api/after-sales/projects/current') {
        currentStateCalls += 1
        return createResponse({
          status: 'partial',
          projectId: 'tenant:after-sales',
          displayName: 'After Sales',
          config: {
            defaultSlaHours: 24,
            urgentSlaHours: 4,
            followUpAfterDays: 7,
          },
          installResult: {
            status: 'partial',
            createdObjects: [],
            createdViews: [],
            warnings: ['follow-up queue missing owner coverage'],
            reportRef: 'install-follow-ups-partial',
          },
          reportRef: 'install-follow-ups-partial',
        })
      }

      if (path === '/api/after-sales/tickets') {
        ticketCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          tickets: [],
        })
      }

      if (path === '/api/after-sales/installed-assets') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          installedAssets: [],
        })
      }

      if (path === '/api/after-sales/service-records') {
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 0,
          serviceRecords: [],
        })
      }

      if (path === '/api/after-sales/follow-ups') {
        followUpBaseCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-001',
              version: 1,
              data: {
                ticketNo: 'TK-5001',
                customerName: 'Alice Plant',
                dueAt: '2026-04-10T09:00:00Z',
                followUpType: 'visit',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Call Alice after onsite service',
              },
            },
          ],
        })
      }

      if (path === '/api/after-sales/follow-ups?status=pending&ticketNo=TK-5001&search=alice') {
        followUpFilteredCalls += 1
        return createResponse({
          projectId: 'tenant:after-sales',
          count: 1,
          followUps: [
            {
              id: 'follow-up-001',
              version: 1,
              data: {
                ticketNo: 'TK-5001',
                customerName: 'Alice Plant',
                dueAt: '2026-04-10T09:00:00Z',
                followUpType: 'visit',
                ownerName: 'CSR Chen',
                status: 'pending',
                summary: 'Call Alice after onsite service',
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

    await waitForText(container, 'Follow-up queue')
    await waitForText(container, 'Call Alice after onsite service')

    const section = findSection(container, 'Follow-up queue')
    const statusFilter = section.querySelector<HTMLSelectElement>('#after-sales-follow-up-filter-status')
    const ticketFilter = section.querySelector<HTMLInputElement>('#after-sales-follow-up-filter-ticket-no')
    const searchFilter = section.querySelector<HTMLInputElement>('#after-sales-follow-up-filter-search')
    const applyButton = findButtonWithin(section, 'Apply filters')
    const refreshButton = findButtonWithin(section, 'Refresh list')

    expect(statusFilter).not.toBeNull()
    expect(ticketFilter).not.toBeNull()
    expect(searchFilter).not.toBeNull()

    await setSelectValue(statusFilter!, 'pending')
    await setInputValue(ticketFilter!, 'TK-5001')
    await setInputValue(searchFilter!, 'alice')

    applyButton.click()
    await flushUi(6)

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/after-sales/follow-ups?status=pending&ticketNo=TK-5001&search=alice',
      undefined,
    )

    refreshButton.click()
    await flushUi(6)

    expect(currentStateCalls).toBe(1)
    expect(ticketCalls).toBe(1)
    expect(followUpBaseCalls).toBe(1)
    expect(followUpFilteredCalls).toBe(2)
    expect(section.textContent).toContain('CSR Chen')
  })

  it('skips follow-up loading when after-sales is not installed or failed', async () => {
    for (const status of ['not-installed', 'failed'] as const) {
      apiFetchMock.mockReset()
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/after-sales/app-manifest') {
          return createResponse({
            id: 'after-sales-default',
            displayName: 'After Sales',
            platformDependencies: ['core-backend'],
            objects: [{ id: 'followUp' }],
            workflows: [],
          })
        }

        if (path === '/api/after-sales/projects/current') {
          return createResponse({
            status,
            projectId: 'tenant:after-sales',
            displayName: 'After Sales',
            config: {
              defaultSlaHours: 24,
              urgentSlaHours: 4,
              followUpAfterDays: 7,
            },
            installResult: status === 'failed'
              ? {
                  status: 'failed',
                  createdObjects: [],
                  createdViews: [],
                  warnings: ['follow-up queue is unavailable'],
                  reportRef: 'install-follow-ups-failed',
                }
              : undefined,
            reportRef: status === 'failed' ? 'install-follow-ups-failed' : undefined,
          })
        }

        if (path === '/api/after-sales/follow-ups') {
          throw new Error('follow-ups should not load for non-operational after-sales state')
        }

        throw new Error(`Unexpected request: ${path}`)
      })

      const mounted = mountAfterSalesView()
      app = mounted.app
      container = mounted.container

      await waitForText(
        container,
        status === 'failed' ? 'Initialization failed' : 'Enable the after-sales project shell',
      )

      expect(container.textContent).not.toContain('Follow-up queue')
      expect(apiFetchMock).not.toHaveBeenCalledWith('/api/after-sales/follow-ups', undefined)

      app.unmount()
      container.remove()
      app = null
      container = null
    }
  })
})
