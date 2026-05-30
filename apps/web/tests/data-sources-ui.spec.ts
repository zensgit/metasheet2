import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, nextTick } from 'vue'

import { buildCreatePayload, type CreateFormState } from '../src/data-sources/buildPayload'

// Mock the api client so the store is tested in isolation.
const listMock = vi.hoisted(() => vi.fn())
const createMock = vi.hoisted(() => vi.fn())
const deleteMock = vi.hoisted(() => vi.fn())
const testConnectionMock = vi.hoisted(() => vi.fn())
vi.mock('../src/data-sources/api', () => ({
  listDataSources: listMock,
  createDataSource: createMock,
  deleteDataSource: deleteMock,
  testDataSourceConnection: testConnectionMock,
}))

import { useDataSourcesStore } from '../src/stores/dataSources'
import DataSourcesView from '../src/views/DataSourcesView.vue'

function form(overrides: Partial<CreateFormState> = {}): CreateFormState {
  return {
    id: 'db', name: 'DB', type: 'postgres', host: '', port: undefined, database: '',
    username: '', password: '', baseURL: '', apiKey: '', readOnly: true, ...overrides,
  }
}

describe('buildCreatePayload — credential safety (omit blank, never send empty)', () => {
  it('omits credentials entirely when none are filled', () => {
    const p = buildCreatePayload(form({ host: 'h', database: 'd' }))
    expect(p.credentials).toBeUndefined()
    expect(p.connection).toEqual({ host: 'h', database: 'd' })
    expect(p.options).toEqual({ readOnly: true })
  })

  it('includes only the filled credential keys (blank password is OMITTED, not "")', () => {
    const p = buildCreatePayload(form({ host: 'h', username: 'u', password: '' }))
    expect(p.credentials).toEqual({ username: 'u' })
    expect(p.credentials).not.toHaveProperty('password')
  })

  it('coerces port and respects readOnly=false', () => {
    const p = buildCreatePayload(form({ type: 'sqlserver', host: 'h', port: 1433, readOnly: false }))
    expect(p.connection.port).toBe(1433)
    expect(p.options).toEqual({ readOnly: false })
  })

  it('omits a blank numeric port instead of sending port: ""', () => {
    const p = buildCreatePayload(form({ type: 'sqlserver', host: 'h', port: '' }))
    expect(p.connection).toEqual({ host: 'h' })
    expect(p.connection).not.toHaveProperty('port')
  })

  it('http type uses baseURL + apiKey, ignores SQL fields', () => {
    const p = buildCreatePayload(form({ type: 'http', host: 'ignored', baseURL: 'https://x', apiKey: 'k' }))
    expect(p.connection).toEqual({ baseURL: 'https://x' })
    expect(p.credentials).toEqual({ apiKey: 'k' })
  })
})

describe('useDataSourcesStore (UI-1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('fetchAll populates items and clears loading/error', async () => {
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: true }])
    const store = useDataSourcesStore()
    expect(store.items).toEqual([])
    await store.fetchAll()
    expect(store.items).toHaveLength(1)
    expect(store.items[0].id).toBe('a')
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('fetchAll surfaces the error message without throwing', async () => {
    listMock.mockRejectedValue(new Error('boom'))
    const store = useDataSourcesStore()
    await store.fetchAll()
    expect(store.error).toBe('boom')
    expect(store.loading).toBe(false)
  })

  it('create posts, refetches, returns true', async () => {
    createMock.mockResolvedValue(undefined)
    listMock.mockResolvedValue([{ id: 'new', name: 'New', type: 'sqlserver', connected: false }])
    const store = useDataSourcesStore()
    const ok = await store.create({ id: 'new', name: 'New', type: 'sqlserver', connection: { host: 'h' } })
    expect(ok).toBe(true)
    expect(createMock).toHaveBeenCalledOnce()
    expect(store.items).toHaveLength(1)
  })

  it('create returns false and surfaces the backend message on failure', async () => {
    createMock.mockRejectedValue(new Error('Unsupported data source type'))
    const store = useDataSourcesStore()
    const ok = await store.create({ id: 'x', name: 'X', type: 'postgres', connection: {} })
    expect(ok).toBe(false)
    expect(store.error).toBe('Unsupported data source type')
  })

  it('remove deletes by id and refetches', async () => {
    deleteMock.mockResolvedValue(undefined)
    listMock.mockResolvedValue([])
    const store = useDataSourcesStore()
    const ok = await store.remove('a')
    expect(ok).toBe(true)
    expect(deleteMock).toHaveBeenCalledWith('a')
    expect(store.items).toEqual([])
  })

  it('testConnection stores the per-source result and refetches connection state', async () => {
    testConnectionMock.mockResolvedValue({ id: 'a', success: true, latency: '12ms' })
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: true }])
    const store = useDataSourcesStore()
    const ok = await store.testConnection('a')
    expect(ok).toBe(true)
    expect(testConnectionMock).toHaveBeenCalledWith('a')
    expect(store.testResults.a).toEqual({ id: 'a', success: true, latency: '12ms' })
    expect(store.items[0].connected).toBe(true)
    expect(store.isTesting('a')).toBe(false)
  })

  it('testConnection keeps connection failure as a row result, not a global load error', async () => {
    testConnectionMock.mockResolvedValue({ id: 'a', success: false, error: { message: 'timeout' } })
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: false }])
    const store = useDataSourcesStore()
    const ok = await store.testConnection('a')
    expect(ok).toBe(false)
    expect(store.error).toBeNull()
    expect(store.testResults.a.success).toBe(false)
    expect(store.testResults.a.error?.message).toBe('timeout')
  })
})

describe('DataSourcesView (UI-2 connection test reachability)', () => {
  let cleanup: (() => void) | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
    document.body.innerHTML = ''
  })

  async function flush(): Promise<void> {
    await Promise.resolve()
    await nextTick()
    await Promise.resolve()
    await nextTick()
  }

  async function mountView(): Promise<HTMLElement> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp(DataSourcesView)
    app.use(createPinia())
    app.mount(container)
    cleanup = () => app.unmount()
    await flush()
    return container
  }

  it('clicking a row test button calls the test endpoint and renders the row result', async () => {
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: false }])
    testConnectionMock.mockResolvedValue({
      id: 'a',
      success: false,
      latency: '24ms',
      error: { message: 'timeout' },
    })

    const container = await mountView()
    const testButton = container.querySelector('[data-testid="ds-test"]') as HTMLButtonElement | null
    expect(testButton).not.toBeNull()

    testButton!.click()
    await flush()
    await flush()
    await flush()

    expect(testConnectionMock).toHaveBeenCalledWith('a')
    const result = container.querySelector('[data-testid="ds-test-result"]')
    expect(result?.textContent).toContain('失败')
    expect(result?.textContent).toContain('timeout')
  })
})
