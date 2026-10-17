import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

const capabilitiesMock = vi.fn()
const getContextMock = vi.fn()
const updateLineMock = vi.fn()
const ecoIntentMock = vi.fn()
vi.mock('../src/services/integration/workbench', () => ({
  getPlmDataSourceCapabilities: (...args: unknown[]) => capabilitiesMock(...args),
  getPlmBomMultitableContext: (...args: unknown[]) => getContextMock(...args),
  updatePlmBomMultitableLine: (...args: unknown[]) => updateLineMock(...args),
  requestPlmBomEcoRevisionIntent: (...args: unknown[]) => ecoIntentMock(...args),
}))

const listBindingsMock = vi.fn()
const managementUrlMock = vi.fn()
const bindGrantMock = vi.fn()
const unbindMock = vi.fn()
const retryRevokeMock = vi.fn()
vi.mock('../src/services/plm/plmBomWriteBindings', () => ({
  listPlmBomWriteBindings: (...args: unknown[]) => listBindingsMock(...args),
  getPlmBomWriteManagementUrl: (...args: unknown[]) => managementUrlMock(...args),
  bindPlmBomWriteGrant: (...args: unknown[]) => bindGrantMock(...args),
  unbindPlmBomWriteBinding: (...args: unknown[]) => unbindMock(...args),
  retryPlmBomWriteRetiredRevocations: (...args: unknown[]) => retryRevokeMock(...args),
  PlmBomWriteBindingError: class PlmBomWriteBindingError extends Error {
    readonly code: string
    constructor(code: string) {
      super('绑定操作未完成。')
      this.code = code
    }
  },
}))

import PlmBomReviewWorkspaceView from '../src/views/PlmBomReviewWorkspaceView.vue'

type QueryValue = string | string[]

function tokenFor(sub: string): string {
  const body = btoa(JSON.stringify({ sub }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `eyJhbGciOiJub25lIn0.${body}.sig`
}

function ecoManifest(dataSourceId: string, actions: string[] = ['eco_revision_intent'], supported = true, entitled = true) {
  return {
    data_source_id: dataSourceId,
    available: true,
    manifest: {
      schema_version: '1',
      provider: 'plm',
      advisory: true,
      features: {
        bom_eco_revision: { supported, entitled, actions },
      },
    },
  }
}

function contextNamed(dataSourceId: string, partId: string, name: string) {
  return {
    data_source_id: dataSourceId,
    available: true,
    entitled: true,
    context: {
      part: { part_id: partId, item_number: partId, name, state: 'Draft', generation: 1 },
      lines: [],
      source_version: 1,
      source_updated_at: '2026-06-05T00:00:00',
      sync_status: 'snapshot',
      template_key: 'bom_review',
    },
  }
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

let app: VueApp | null = null
let router: Router | null = null
let container: HTMLDivElement | null = null

function historyAt(query: Record<string, QueryValue>): ReturnType<typeof createMemoryHistory> {
  const history = createMemoryHistory()
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, item)
  }
  const qs = search.toString()
  history.replace(`/plm/bom-review${qs ? `?${qs}` : ''}`)
  return history
}

async function show(query: Record<string, QueryValue> = {}): Promise<void> {
  router = createRouter({
    history: historyAt(query),
    routes: [{ path: '/plm/bom-review', component: PlmBomReviewWorkspaceView }],
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  const root = defineComponent({
    name: 'BomWorkspaceRoot',
    setup() {
      return () => h(RouterView)
    },
  })
  app = createApp(root)
  app.use(router)
  app.mount(container)
  await router.isReady()
  await flushUi()
}

function reason(): string | null {
  return container?.querySelector('[data-testid="plm-bom-review-workspace-hint"]')?.getAttribute('data-reason') ?? null
}

function advisory(): string | null {
  return container?.querySelector('[data-testid="plm-bom-review-workspace"]')?.getAttribute('data-eco-advisory') ?? null
}

function panel() {
  return container?.querySelector('[data-testid="plm-bom-review-panel"]') ?? null
}

beforeEach(() => {
  capabilitiesMock.mockResolvedValue({ data_source_id: '', available: false, reason: 'unavailable' })
  getContextMock.mockResolvedValue({ data_source_id: '', available: false, reason: 'unavailable' })
  updateLineMock.mockResolvedValue({ ok: false, status: 500 })
  ecoIntentMock.mockResolvedValue({ ok: false, status: 500 })
  listBindingsMock.mockResolvedValue([])
  managementUrlMock.mockResolvedValue('')
  bindGrantMock.mockResolvedValue(null)
  unbindMock.mockResolvedValue(null)
  retryRevokeMock.mockResolvedValue(undefined)
})

afterEach(() => {
  app?.unmount()
  app = null
  router = null
  container?.remove()
  container = null
  capabilitiesMock.mockReset()
  getContextMock.mockReset()
  updateLineMock.mockReset()
  ecoIntentMock.mockReset()
  listBindingsMock.mockReset()
  managementUrlMock.mockReset()
  bindGrantMock.mockReset()
  unbindMock.mockReset()
  retryRevokeMock.mockReset()
  localStorage.removeItem('auth_token')
  localStorage.removeItem('jwt')
  localStorage.removeItem('devToken')
})

describe('PLM BOM review workspace host', () => {
  it('shows a safe hint and calls nothing when the source is missing, blank, repeated, or padded', async () => {
    await show()
    expect(reason()).toBe('source-missing')
    expect(panel()).toBeNull()
    expect(container?.querySelector('select')).toBeNull()
    expect(container?.textContent).not.toContain('创建数据源')

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: '   ', partId: 'P1' } })
    await flushUi()
    expect(reason()).toBe('source-blank')
    expect(panel()).toBeNull()

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: '' } })
    await flushUi()
    expect(reason()).toBe('source-blank')

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: ['src-a', 'src-b'], partId: 'P1' } })
    await flushUi()
    expect(reason()).toBe('source-array')
    expect(panel()).toBeNull()

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: ' src-a', partId: 'P1' } })
    await flushUi()
    expect(reason()).toBe('source-ambiguous')
    expect(panel()).toBeNull()

    expect(capabilitiesMock).not.toHaveBeenCalled()
    expect(getContextMock).not.toHaveBeenCalled()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
  })

  it('mounts the panel for a valid source and does not coerce an invalid part into a read', async () => {
    await show({ dataSourceId: 'src-a' })
    expect(reason()).toBeNull()
    expect(panel()).not.toBeNull()
    expect(container?.querySelector('[data-testid="plm-bom-review-workspace-source"]')?.textContent).toContain('src-a')
    expect(container?.querySelector('[data-testid="plm-bom-write-bindings-open"]')).not.toBeNull()
    expect(container?.querySelector('select')).toBeNull()
    expect((container?.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement).value).toBe('')
    expect(capabilitiesMock).toHaveBeenCalledTimes(1)
    expect(capabilitiesMock).toHaveBeenCalledWith('src-a')
    expect(getContextMock).not.toHaveBeenCalled()

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-a', partId: '   ' } })
    await flushUi()
    expect(reason()).toBe('part-blank')
    expect(panel()).not.toBeNull()
    expect(getContextMock).not.toHaveBeenCalled()

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-a', partId: ['P1', 'P2'] } })
    await flushUi()
    expect(reason()).toBe('part-array')
    expect(getContextMock).not.toHaveBeenCalled()

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-a', partId: ' P9' } })
    await flushUi()
    expect(reason()).toBe('part-ambiguous')
    expect(panel()).not.toBeNull()
    expect(getContextMock).not.toHaveBeenCalled()
    expect(capabilitiesMock.mock.calls.map((call) => call[0])).toEqual(['src-a'])
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
  })

  it('auto-reads a supplied part and does not mutate', async () => {
    getContextMock.mockResolvedValue(contextNamed('src-a', 'P1', 'Assembly'))
    await show({ dataSourceId: 'src-a', partId: 'P1' })

    expect(getContextMock).toHaveBeenCalledTimes(1)
    expect(getContextMock).toHaveBeenCalledWith('src-a', 'P1', expect.any(AbortSignal))
    expect(container?.textContent).toContain('Assembly')
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(bindGrantMock).not.toHaveBeenCalled()
  })

  it('keeps the panel and its binding cleanup when the capability manifest fails', async () => {
    capabilitiesMock.mockRejectedValueOnce(new Error('manifest down'))
    getContextMock.mockResolvedValue(contextNamed('src-a', 'P1', 'Assembly'))
    await show({ dataSourceId: 'src-a', partId: 'P1' })

    expect(advisory()).toBe('off')
    expect(panel()).not.toBeNull()
    expect(container?.textContent).toContain('Assembly')
    ;(container?.querySelector('[data-testid="plm-bom-write-bindings-open"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container?.querySelector('[data-testid="plm-bom-write-bindings"]')).not.toBeNull()
    expect(listBindingsMock).toHaveBeenCalled()
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(bindGrantMock).not.toHaveBeenCalled()
  })

  it('turns the ECO advisory on only for supported, entitled eco_revision_intent, never from the query', async () => {
    const pending: Array<(value: unknown) => void> = []
    capabilitiesMock.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve)
    }))
    await show({
      dataSourceId: 'src-a',
      ecoIntent: 'true',
      supported: 'true',
      entitled: 'true',
    })
    expect(advisory()).toBe('off')
    expect(capabilitiesMock).toHaveBeenCalledTimes(1)
    expect(capabilitiesMock).toHaveBeenCalledWith('src-a')

    pending[0]?.({ data_source_id: 'src-a', available: false, reason: 'unavailable' })
    await flushUi()
    expect(advisory()).toBe('off')

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-b', ecoIntent: 'true' } })
    await flushUi()
    pending[1]?.(ecoManifest('src-b', ['read']))
    await flushUi()
    expect(advisory()).toBe('off')

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-c' } })
    await flushUi()
    pending[2]?.(ecoManifest('src-c', ['eco_revision_intent'], false, true))
    await flushUi()
    expect(advisory()).toBe('off')

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-d' } })
    await flushUi()
    pending[3]?.(ecoManifest('src-d', ['eco_revision_intent'], true, false))
    await flushUi()
    expect(advisory()).toBe('off')

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-e' } })
    await flushUi()
    pending[4]?.(ecoManifest('src-e', ['eco_revision_intent'], true, true))
    await flushUi()
    expect(advisory()).toBe('on')
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
    expect(getContextMock).not.toHaveBeenCalled()
  })

  it('drops delayed capabilities across source A, B, then A', async () => {
    const pending: Array<(value: unknown) => void> = []
    capabilitiesMock.mockImplementation((dataSourceId: string) => new Promise((resolve) => {
      pending.push(resolve)
      return dataSourceId
    }))
    await show({ dataSourceId: 'src-a' })
    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-b' } })
    await flushUi()
    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-a' } })
    await flushUi()
    expect(capabilitiesMock.mock.calls.map((call) => call[0])).toEqual(['src-a', 'src-b', 'src-a'])

    pending[0]?.(ecoManifest('src-a'))
    await flushUi()
    expect(advisory()).toBe('off')
    pending[1]?.(ecoManifest('src-b'))
    await flushUi()
    expect(advisory()).toBe('off')
    expect(container?.textContent).toContain('src-a')
    pending[2]?.(ecoManifest('src-a'))
    await flushUi()
    expect(advisory()).toBe('on')
    expect(getContextMock).not.toHaveBeenCalled()
  })

  it('drops a capability resolved for the previous session and keeps the panel', async () => {
    const pending: Array<(value: unknown) => void> = []
    capabilitiesMock.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve)
    }))
    await show({ dataSourceId: 'src-a', partId: 'P1' })
    expect(pending).toHaveLength(1)
    expect(panel()).not.toBeNull()

    localStorage.setItem('auth_token', tokenFor('user-b'))
    notifyAuthPrincipalChange()
    await flushUi()
    expect(pending).toHaveLength(2)

    pending[0]?.(ecoManifest('src-a'))
    await flushUi()
    expect(advisory()).toBe('off')
    pending[1]?.({ data_source_id: 'src-a', available: false, reason: 'unavailable' })
    await flushUi()
    expect(advisory()).toBe('off')
    expect(panel()).not.toBeNull()
    expect(capabilitiesMock.mock.calls.map((call) => call[0])).toEqual(['src-a', 'src-a'])
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
  })

  it('drops a capability after another tab changes the session', async () => {
    const pending: Array<(value: unknown) => void> = []
    capabilitiesMock.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve)
    }))
    await show({ dataSourceId: 'src-a' })
    localStorage.setItem('auth_token', tokenFor('user-c'))
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    await flushUi()
    expect(pending).toHaveLength(2)

    pending[0]?.(ecoManifest('src-a'))
    await flushUi()
    expect(advisory()).toBe('off')
    pending[1]?.(ecoManifest('src-a'))
    await flushUi()
    expect(advisory()).toBe('on')
    expect(panel()).not.toBeNull()
  })

  it('remounts across source and part changes so a late read cannot land on the next target', async () => {
    const pending: Array<{ partId: string; resolve: (value: unknown) => void }> = []
    getContextMock.mockImplementation((dataSourceId: string, partId: string) => new Promise((resolve) => {
      pending.push({
        partId,
        resolve: (value) => resolve(value ?? contextNamed(dataSourceId, partId, `Name-${partId}`)),
      })
    }))
    await show({ dataSourceId: 'src-a', partId: 'P1' })
    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-a', partId: 'P2' } })
    await flushUi()

    pending[0]?.resolve(contextNamed('src-a', 'P1', 'Name-P1'))
    await flushUi()
    expect(container?.textContent).not.toContain('Name-P1')
    expect((container?.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement).value).toBe('P2')

    pending[1]?.resolve(contextNamed('src-a', 'P2', 'Name-P2'))
    await flushUi()
    expect(container?.textContent).toContain('Name-P2')
    expect(container?.textContent).not.toContain('Name-P1')

    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: 'src-b', partId: 'P9' } })
    await flushUi()
    pending[1]?.resolve(contextNamed('src-a', 'P2', 'Name-P2-late'))
    await flushUi()
    expect(container?.textContent).not.toContain('Name-P2')
    expect((container?.querySelector('[data-testid="plm-bom-review-part-input"]') as HTMLInputElement).value).toBe('P9')
    pending[2]?.resolve(contextNamed('src-b', 'P9', 'Name-P9'))
    await flushUi()
    expect(container?.textContent).toContain('Name-P9')

    expect(getContextMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['src-a', 'P1'],
      ['src-a', 'P2'],
      ['src-b', 'P9'],
    ])
    expect(capabilitiesMock.mock.calls.map((call) => call[0])).toEqual(['src-a', 'src-b'])
    expect(updateLineMock).not.toHaveBeenCalled()
    expect(ecoIntentMock).not.toHaveBeenCalled()
  })

  it('ignores a late capability after the source hint becomes unusable', async () => {
    const pending: Array<(value: unknown) => void> = []
    capabilitiesMock.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve)
    }))
    getContextMock.mockResolvedValue(contextNamed('src-a', 'P1', 'Assembly'))
    await show({ dataSourceId: 'src-a', partId: 'P1' })
    await router!.push({ path: '/plm/bom-review', query: { dataSourceId: '   ' } })
    await flushUi()

    pending[0]?.(ecoManifest('src-a'))
    await flushUi()
    expect(reason()).toBe('source-blank')
    expect(panel()).toBeNull()
    expect(advisory()).toBe('off')
    expect(capabilitiesMock).toHaveBeenCalledTimes(1)
    expect(getContextMock).toHaveBeenCalledTimes(1)
    expect(updateLineMock).not.toHaveBeenCalled()
  })
})
