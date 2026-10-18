import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

const startMock = vi.fn()
const statusMock = vi.fn()
const unlinkMock = vi.fn()
const followMock = vi.fn()

vi.mock('../src/services/plm/plmManagedCompanion', () => ({
  startManagedLogin: (...args: unknown[]) => startMock(...args),
  readManagedStatus: (...args: unknown[]) => statusMock(...args),
  unlinkManagedSource: (...args: unknown[]) => unlinkMock(...args),
  followManagedNavigation: (...args: unknown[]) => followMock(...args),
  PlmManagedCompanionError: class PlmManagedCompanionError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'PlmManagedCompanionError'
    }
  },
}))

vi.mock('../src/services/integration/workbench', () => ({
  getPlmDataSourceCapabilities: vi.fn(async () => ({ available: false, reason: 'unavailable' })),
  getPlmBomMultitableContext: vi.fn(async () => ({ available: false, reason: 'unavailable' })),
  updatePlmBomMultitableLine: vi.fn(),
  requestPlmBomEcoRevisionIntent: vi.fn(),
}))

vi.mock('../src/services/plm/plmBomWriteBindings', () => ({
  listPlmBomWriteBindings: vi.fn(async () => []),
  getPlmBomWriteManagementUrl: vi.fn(async () => ''),
  bindPlmBomWriteGrant: vi.fn(),
  unbindPlmBomWriteBinding: vi.fn(),
  retryPlmBomWriteRetiredRevocations: vi.fn(),
  PlmBomWriteBindingError: class PlmBomWriteBindingError extends Error {},
}))

import PlmBomReviewWorkspaceView from '../src/views/PlmBomReviewWorkspaceView.vue'

let app: VueApp | null = null
let router: Router | null = null
let container: HTMLDivElement | null = null

async function show(search: string): Promise<void> {
  const history = createMemoryHistory()
  history.replace(`/plm/bom-review${search}`)
  router = createRouter({
    history,
    routes: [{ path: '/plm/bom-review', component: PlmBomReviewWorkspaceView }],
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = defineComponent({ setup: () => () => h(RouterView) })
  app = createApp(root)
  app.use(router)
  app.mount(container)
  await router.isReady()
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

afterEach(() => {
  app?.unmount()
  app = null
  router = null
  container?.remove()
  container = null
  startMock.mockReset()
  statusMock.mockReset()
  unlinkMock.mockReset()
  followMock.mockReset()
})

describe('managed companion customer entry', () => {
  it('does not fetch on mount and strips a callback code from the address', async () => {
    await show('?dataSourceId=source-1&partId=part&code=one-use&state=browser-state')
    expect(startMock).not.toHaveBeenCalled()
    expect(statusMock).not.toHaveBeenCalled()
    expect(unlinkMock).not.toHaveBeenCalled()
    expect(followMock).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(router?.currentRoute.value.query.code).toBeUndefined())
    expect(router?.currentRoute.value.query.state).toBeUndefined()
    expect(router?.currentRoute.value.query.dataSourceId).toBe('source-1')
    expect(window.localStorage.getItem('plm-managed-code')).toBeNull()
  })

  it('starts only from the button and keeps status and unlink on their own clicks', async () => {
    startMock.mockResolvedValue({ navigationUrl: 'https://native.example.test/managed-login?client_id=managed-fixture' })
    statusMock.mockResolvedValue({ linked: true, pendingRevoke: false, generation: 2 })
    unlinkMock.mockResolvedValue({ state: 'pending' })
    await show('?dataSourceId=source-1&partId=part&managed=ready')
    expect(container?.querySelector('[data-testid="plm-managed-ready"]')?.textContent).toContain('元图读取会话已建立')
    expect(startMock).not.toHaveBeenCalled()
    expect(followMock).not.toHaveBeenCalled()
    ;(container?.querySelector('[data-testid="plm-managed-start"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(startMock).toHaveBeenCalledWith('source-1', 'part'))
    await vi.waitFor(() => expect(followMock).toHaveBeenCalledWith('https://native.example.test/managed-login?client_id=managed-fixture'))
    expect(statusMock).not.toHaveBeenCalled()
    ;(container?.querySelector('[data-testid="plm-managed-status-button"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(container?.textContent).toContain('第 2 代有效'))
    ;(container?.querySelector('[data-testid="plm-managed-unlink"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(container?.textContent).toContain('等待元图确认'))
  })
})
