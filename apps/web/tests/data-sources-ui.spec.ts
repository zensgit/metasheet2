import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, nextTick } from 'vue'

import {
  buildCreatePayload,
  buildCredentialRotationPayload,
  buildUpdatePayload,
  type CreateFormState,
} from '../src/data-sources/buildPayload'

// Mock the api client so the store is tested in isolation.
const listMock = vi.hoisted(() => vi.fn())
const getMock = vi.hoisted(() => vi.fn())
const createMock = vi.hoisted(() => vi.fn())
const updateMock = vi.hoisted(() => vi.fn())
const rotateCredentialsMock = vi.hoisted(() => vi.fn())
const deleteMock = vi.hoisted(() => vi.fn())
const testConnectionMock = vi.hoisted(() => vi.fn())
const testDraftMock = vi.hoisted(() => vi.fn())
const getSchemaMock = vi.hoisted(() => vi.fn())
const getTableInfoMock = vi.hoisted(() => vi.fn())
const previewRowsMock = vi.hoisted(() => vi.fn())
vi.mock('../src/data-sources/api', () => ({
  listDataSources: listMock,
  getDataSource: getMock,
  createDataSource: createMock,
  updateDataSource: updateMock,
  rotateDataSourceCredentials: rotateCredentialsMock,
  deleteDataSource: deleteMock,
  testDataSourceConnection: testConnectionMock,
  testDataSourceDraftConnection: testDraftMock,
  getDataSourceSchema: getSchemaMock,
  getDataSourceTableInfo: getTableInfoMock,
  previewDataSourceRows: previewRowsMock,
}))

import { useDataSourcesStore } from '../src/stores/dataSources'
import DataSourcesView from '../src/views/DataSourcesView.vue'
import { DATA_SOURCE_TYPES, DATA_SOURCE_TYPE_LABELS } from '../src/data-sources/types'

function form(overrides: Partial<CreateFormState> = {}): CreateFormState {
  return {
    id: 'db', name: 'DB', type: 'postgres', host: '', server: '', port: undefined, database: '',
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

  it('P2: a SQL Server source can connect by `server` instead of `host`', () => {
    const p = buildCreatePayload(form({ type: 'sqlserver', server: 'sql-prod', database: 'd' }))
    expect(p.connection).toEqual({ server: 'sql-prod', database: 'd' })
    expect(p.connection).not.toHaveProperty('host')
  })

  it('P2 follow-up: Postgres does NOT send `server` (it is sqlserver-only)', () => {
    // A stale `server` (e.g. from switching type) must not let a Postgres source skip host.
    const p = buildCreatePayload(form({ type: 'postgres', server: 'stale', host: '', database: 'd' }))
    expect(p.connection).toEqual({ database: 'd' })
    expect(p.connection).not.toHaveProperty('server')
  })

  it('supports MySQL as an operator-facing SQL type without SQL Server-only fields (#2227)', () => {
    expect(DATA_SOURCE_TYPES).toContain('mysql')
    expect(DATA_SOURCE_TYPE_LABELS.mysql).toContain('MySQL')

    const p = buildCreatePayload(form({
      type: 'mysql',
      host: 'mysql.internal',
      server: 'stale-sqlserver-instance',
      port: 3306,
      database: 'stockorder',
      username: 'readonly',
      password: 'secret',
    }))
    expect(p).toEqual({
      id: 'db',
      name: 'DB',
      type: 'mysql',
      connection: { host: 'mysql.internal', port: 3306, database: 'stockorder' },
      credentials: { username: 'readonly', password: 'secret' },
      options: { readOnly: true },
    })
    expect(p.connection).not.toHaveProperty('server')
  })
})

describe('buildUpdatePayload — non-secret update safety', () => {
  it('updates name / connection / options without sending id, type, or credentials', () => {
    const p = buildUpdatePayload(form({
      id: 'db',
      name: 'Renamed',
      type: 'postgres',
      host: 'h',
      port: 5432,
      database: 'd',
      username: 'u',
      password: 'secret',
      readOnly: false,
    }))
    expect(p).toEqual({
      name: 'Renamed',
      connection: { host: 'h', port: 5432, database: 'd' },
      options: { readOnly: false },
    })
    expect(p).not.toHaveProperty('id')
    expect(p).not.toHaveProperty('type')
    expect(p).not.toHaveProperty('credentials')
  })

  it('omits a blank update port instead of sending port: ""', () => {
    const p = buildUpdatePayload(form({ type: 'sqlserver', host: 'h', port: '', database: 'd' }))
    expect(p.connection).toEqual({ host: 'h', database: 'd' })
  })

  it('P2: update can carry `server` (no host) for a server-only source', () => {
    const p = buildUpdatePayload(form({ type: 'sqlserver', server: 'sql-prod', database: 'd' }))
    expect(p.connection).toEqual({ server: 'sql-prod', database: 'd' })
  })
})

describe('buildCredentialRotationPayload — write-only credential safety', () => {
  it('sends only filled SQL credential fields and omits blank secrets', () => {
    const p = buildCredentialRotationPayload(form({
      type: 'postgres',
      username: 'new-user',
      password: '',
      host: 'ignored',
      database: 'ignored',
    }))
    expect(p).toEqual({ credentials: { username: 'new-user' } })
    expect(p.credentials).not.toHaveProperty('password')
  })

  it('sends only filled HTTP credential fields', () => {
    const p = buildCredentialRotationPayload(form({
      type: 'http',
      apiKey: 'new-key',
      username: 'ignored',
      password: 'ignored',
    }))
    expect(p).toEqual({ credentials: { apiKey: 'new-key' } })
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

  it('loadDetail returns a sanitized data source detail', async () => {
    getMock.mockResolvedValue({
      id: 'a',
      name: 'A',
      type: 'postgres',
      connected: false,
      hasCredentials: true,
      connection: { host: 'h', database: 'd' },
      options: { readOnly: true },
    })
    const store = useDataSourcesStore()
    const detail = await store.loadDetail('a')
    expect(getMock).toHaveBeenCalledWith('a')
    expect(detail?.hasCredentials).toBe(true)
    expect(detail).not.toHaveProperty('credentials')
  })

  it('update posts non-secret config, clears stale test result, and refetches', async () => {
    updateMock.mockResolvedValue(undefined)
    listMock.mockResolvedValue([{ id: 'a', name: 'Renamed', type: 'postgres', connected: false }])
    const store = useDataSourcesStore()
    store.testResults.a = { id: 'a', success: false }

    const payload = {
      name: 'Renamed',
      connection: { host: 'h', database: 'd' },
      options: { readOnly: true },
    }
    const ok = await store.update('a', payload)
    expect(ok).toBe(true)
    expect(updateMock).toHaveBeenCalledWith('a', payload)
    expect(store.testResults.a).toBeUndefined()
    expect(store.items[0].name).toBe('Renamed')
  })

  it('rotateCredentials posts write-only credentials, clears stale test result, and refetches', async () => {
    rotateCredentialsMock.mockResolvedValue(undefined)
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: false }])
    const store = useDataSourcesStore()
    store.testResults.a = { id: 'a', success: false }

    const payload = { credentials: { password: 'new-secret' } }
    const ok = await store.rotateCredentials('a', payload)
    expect(ok).toBe(true)
    expect(rotateCredentialsMock).toHaveBeenCalledWith('a', payload)
    expect(store.testResults.a).toBeUndefined()
    expect(store.items[0].id).toBe('a')
  })

  it('rotateCredentials returns false and surfaces the backend message on failure', async () => {
    rotateCredentialsMock.mockRejectedValue(new Error('credentials: at least one credential field is required'))
    const store = useDataSourcesStore()
    const ok = await store.rotateCredentials('a', { credentials: {} })
    expect(ok).toBe(false)
    expect(store.error).toBe('credentials: at least one credential field is required')
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

  it('loads schema and previews rows through the bounded structured select path', async () => {
    getSchemaMock.mockResolvedValue({
      tables: [{ name: 'items', schema: 'public', columns: [{ name: 'id', type: 'int' }] }],
    })
    previewRowsMock.mockResolvedValue({
      data: [{ id: 1, name: 'Widget' }],
      metadata: { columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }] },
    })
    const store = useDataSourcesStore()

    const schema = await store.loadSchema('pg')
    const result = await store.previewRows('pg', { table: 'public.items', limit: 100 })

    expect(schema?.tables?.[0].name).toBe('items')
    expect(result?.data[0].name).toBe('Widget')
    expect(getSchemaMock).toHaveBeenCalledWith('pg')
    expect(previewRowsMock).toHaveBeenCalledWith('pg', { table: 'public.items', limit: 100 })
    expect(store.previewErrors.pg).toBe('')
  })

  it('loads table details through schema-scoped table info', async () => {
    getTableInfoMock.mockResolvedValue({
      name: 'items',
      schema: 'public',
      columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }],
    })
    const store = useDataSourcesStore()

    const detail = await store.loadTableInfo('pg', 'items', 'public')

    expect(getTableInfoMock).toHaveBeenCalledWith('pg', 'items', 'public')
    expect(detail?.columns?.[0].primaryKey).toBe(true)
    expect(store.tableDetails[store.tableDetailKey('pg', 'items', 'public')].columns?.[0].name).toBe('id')
    expect(store.schemaErrors.pg).toBe('')
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

  it('opens edit mode from a sanitized detail and submits a credential-free update payload', async () => {
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: false }])
    getMock.mockResolvedValue({
      id: 'a',
      name: 'A',
      type: 'postgres',
      connected: false,
      hasCredentials: true,
      connection: { host: 'db.internal', port: 5432, database: 'erp' },
      options: { readOnly: true },
    })
    updateMock.mockResolvedValue(undefined)

    const container = await mountView()
    const editButton = container.querySelector('[data-testid="ds-edit"]') as HTMLButtonElement | null
    expect(editButton).not.toBeNull()

    editButton!.click()
    await flush()
    await flush()
    await flush()

    expect(getMock).toHaveBeenCalledWith('a')
    expect(container.querySelector('[data-testid="ds-field-password"]')).toBeNull()
    expect(container.querySelector('[data-testid="ds-field-id"]')?.getAttribute('disabled')).not.toBeNull()

    const nameInput = container.querySelector('[data-testid="ds-field-name"]') as HTMLInputElement
    nameInput.value = 'Renamed'
    nameInput.dispatchEvent(new Event('input'))
    await flush()

    const submit = container.querySelector('[data-testid="ds-submit"]') as HTMLButtonElement
    submit.click()
    await flush()
    await flush()
    await flush()

    expect(updateMock).toHaveBeenCalledWith('a', {
      name: 'Renamed',
      connection: { host: 'db.internal', port: 5432, database: 'erp' },
      options: { readOnly: true },
    })
    expect(updateMock.mock.calls[0][1]).not.toHaveProperty('credentials')
  })

  it('opens credential mode and submits only filled credential fields', async () => {
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: false }])
    getMock.mockResolvedValue({
      id: 'a',
      name: 'A',
      type: 'postgres',
      connected: false,
      hasCredentials: true,
      connection: { host: 'db.internal', port: 5432, database: 'erp' },
      options: { readOnly: true },
    })
    rotateCredentialsMock.mockResolvedValue(undefined)

    const container = await mountView()
    const credentialsButton = container.querySelector('[data-testid="ds-credentials"]') as HTMLButtonElement | null
    expect(credentialsButton).not.toBeNull()

    credentialsButton!.click()
    await flush()
    await flush()
    await flush()

    expect(getMock).toHaveBeenCalledWith('a')
    expect(container.querySelector('[data-testid="ds-credential-fields"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="ds-field-id"]')?.getAttribute('disabled')).not.toBeNull()
    expect(container.querySelector('[data-testid="ds-field-type"]')?.getAttribute('disabled')).not.toBeNull()
    expect(container.querySelector('[data-testid="ds-field-host"]')).toBeNull()
    expect(container.querySelector('[data-testid="ds-field-readonly"]')).toBeNull()

    const submit = container.querySelector('[data-testid="ds-submit"]') as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    const passwordInput = container.querySelector('[data-testid="ds-field-password"]') as HTMLInputElement
    passwordInput.value = 'new-password'
    passwordInput.dispatchEvent(new Event('input'))
    await flush()
    expect(submit.disabled).toBe(false)

    submit.click()
    await flush()
    await flush()
    await flush()

    expect(rotateCredentialsMock).toHaveBeenCalledWith('a', {
      credentials: { password: 'new-password' },
    })
    expect(rotateCredentialsMock.mock.calls[0][1]).not.toHaveProperty('connection')
    expect(rotateCredentialsMock.mock.calls[0][1]).not.toHaveProperty('options')
  })

  it('opens a SQL schema browser and renders table columns without previewing rows', async () => {
    listMock.mockResolvedValue([
      { id: 'pg', name: 'Warehouse DB', type: 'postgres', connected: true },
      { id: 'api', name: 'API', type: 'http', connected: true },
    ])
    getSchemaMock.mockResolvedValue({
      tables: [{
        name: 'items',
        schema: 'public',
        columns: [{ name: 'id', type: 'int' }],
      }],
      views: [{ name: 'active_items', schema: 'public', columns: [] }],
    })
    getTableInfoMock.mockResolvedValue({
      name: 'items',
      schema: 'public',
      columns: [
        { name: 'id', type: 'int', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: true },
      ],
    })

    const container = await mountView()
    const schemaButtons = container.querySelectorAll('[data-testid="ds-schema"]')
    expect(schemaButtons).toHaveLength(1)

    ;(schemaButtons[0] as HTMLButtonElement).click()
    await flush()
    await flush()
    await flush()

    expect(getSchemaMock).toHaveBeenCalledWith('pg')
    expect(getTableInfoMock).toHaveBeenCalledWith('pg', 'items', 'public')
    expect(previewRowsMock).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="ds-schema-panel"]')?.textContent).toContain('库表结构')
    expect(container.querySelector('[data-testid="ds-schema-detail"]')?.textContent).toContain('public.items')
    expect(container.querySelector('[data-testid="ds-schema-detail"]')?.textContent).toContain('NOT NULL')
    expect(container.querySelectorAll('[data-testid="ds-schema-column"]')).toHaveLength(2)
  })

  it('treats MySQL as a SQL source in the UI: create option, default port, schema, and preview (#2227)', async () => {
    listMock.mockResolvedValue([
      { id: 'my', name: 'Stockorder MySQL', type: 'mysql', connected: true },
      { id: 'api', name: 'API', type: 'http', connected: true },
    ])
    getSchemaMock.mockResolvedValue({
      tables: [{ name: 'stock_info', schema: 'stockorder', columns: [{ name: 'id', type: 'int' }] }],
      views: [],
    })
    previewRowsMock.mockResolvedValue({
      data: [{ id: 1 }],
      metadata: { columns: [{ name: 'id', type: 'int' }] },
    })

    const container = await mountView()

    const newButton = container.querySelector('[data-testid="ds-new-button"]') as HTMLButtonElement
    newButton.click()
    await flush()
    const typeSelect = container.querySelector('[data-testid="ds-field-type"]') as HTMLSelectElement
    expect([...typeSelect.options].map((option) => option.value)).toContain('mysql')
    typeSelect.value = 'mysql'
    typeSelect.dispatchEvent(new Event('change'))
    await flush()
    expect((container.querySelector('[data-testid="ds-field-port"]') as HTMLInputElement).placeholder).toBe('3306')
    expect(container.querySelector('[data-testid="ds-field-server"]')).toBeNull()

    const schemaButtons = container.querySelectorAll('[data-testid="ds-schema"]')
    const previewButtons = container.querySelectorAll('[data-testid="ds-preview"]')
    expect(schemaButtons).toHaveLength(1)
    expect(previewButtons).toHaveLength(1)

    ;(schemaButtons[0] as HTMLButtonElement).click()
    await flush()
    await flush()
    await flush()
    expect(getSchemaMock).toHaveBeenCalledWith('my')
    expect(getTableInfoMock).toHaveBeenCalledWith('my', 'stock_info', 'stockorder')

    ;(previewButtons[0] as HTMLButtonElement).click()
    await flush()
    await flush()
    await flush()
    expect(previewRowsMock).toHaveBeenCalledWith('my', { table: 'stockorder.stock_info', limit: 100 })
  })

  it('drops a stale schema response: a fast A→B switch keeps B and never loads A table info', async () => {
    listMock.mockResolvedValue([
      { id: 'a', name: 'Alpha DB', type: 'postgres', connected: true },
      { id: 'b', name: 'Bravo DB', type: 'postgres', connected: true },
    ])
    // A's schema load is parked (slow); B's resolves immediately (fast). This is the out-of-order
    // race: the user clicks A then B before A returns, and A's response arrives last.
    let resolveA: ((schema: unknown) => void) | null = null
    const aSchema = new Promise<unknown>((resolve) => {
      resolveA = resolve
    })
    getSchemaMock.mockImplementation((id: string) =>
      id === 'a'
        ? aSchema
        : Promise.resolve({
            tables: [{ name: 'b_orders', schema: 'public', columns: [{ name: 'id', type: 'int' }] }],
          }),
    )
    getTableInfoMock.mockResolvedValue({
      name: 'b_orders',
      schema: 'public',
      columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }],
    })

    const container = await mountView()
    const schemaButtons = container.querySelectorAll('[data-testid="ds-schema"]')
    expect(schemaButtons).toHaveLength(2)

    // Click A (parks on the pending schema), then B (resolves fast) before A returns.
    ;(schemaButtons[0] as HTMLButtonElement).click()
    await flush()
    ;(schemaButtons[1] as HTMLButtonElement).click()
    await flush()
    await flush()

    // B is the active panel and only B's table info loaded.
    const select = container.querySelector('[data-testid="ds-schema-table"]') as HTMLSelectElement
    expect(select.value).toBe('public.b_orders')
    expect(getTableInfoMock).toHaveBeenCalledWith('b', 'b_orders', 'public')

    // A's slow response now arrives last — the stale-response guard must drop it.
    resolveA?.({
      tables: [{ name: 'a_items', schema: 'public', columns: [{ name: 'id', type: 'int' }] }],
    })
    await flush()
    await flush()

    // Still B: schemaTable not clobbered to A's table, and A's table info was never loaded.
    expect(select.value).toBe('public.b_orders')
    expect(getTableInfoMock).not.toHaveBeenCalledWith('a', 'a_items', 'public')
    expect(container.querySelector('[data-testid="ds-schema-detail"]')?.textContent).toContain('public.b_orders')
  })

  it('opens a read-only SQL table preview via schema + bounded select and renders rows', async () => {
    listMock.mockResolvedValue([
      { id: 'pg', name: 'Warehouse DB', type: 'postgres', connected: true },
      { id: 'api', name: 'API', type: 'http', connected: true },
    ])
    getSchemaMock.mockResolvedValue({
      tables: [{
        name: 'items',
        schema: 'public',
        columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }],
      }],
    })
    previewRowsMock.mockResolvedValue({
      data: [{ id: 1, name: 'Widget' }],
      metadata: { columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }] },
    })

    const container = await mountView()
    const previewButtons = container.querySelectorAll('[data-testid="ds-preview"]')
    expect(previewButtons).toHaveLength(1)

    ;(previewButtons[0] as HTMLButtonElement).click()
    await flush()
    await flush()
    await flush()

    expect(getSchemaMock).toHaveBeenCalledWith('pg')
    expect(previewRowsMock).toHaveBeenCalledWith('pg', { table: 'public.items', limit: 100 })
    expect(container.querySelector('[data-testid="ds-preview-panel"]')?.textContent).toContain('只读数据预览')
    expect(container.querySelector('[data-testid="ds-preview-result"]')?.textContent).toContain('Widget')
    expect(container.querySelector('[data-testid="ds-preview-panel"]')?.textContent).toContain('limit=100')
  })

  it('drops a stale preview schema response: a fast A→B switch never queries A table against B', async () => {
    listMock.mockResolvedValue([
      { id: 'a', name: 'Alpha DB', type: 'postgres', connected: true },
      { id: 'b', name: 'Bravo DB', type: 'postgres', connected: true },
    ])
    // A's schema load is parked (slow); B's resolves immediately (fast).
    let resolveA: ((schema: unknown) => void) | null = null
    const aSchema = new Promise<unknown>((resolve) => {
      resolveA = resolve
    })
    getSchemaMock.mockImplementation((id: string) =>
      id === 'a'
        ? aSchema
        : Promise.resolve({
            tables: [{ name: 'b_orders', schema: 'public', columns: [{ name: 'id', type: 'int' }] }],
          }),
    )
    previewRowsMock.mockResolvedValue({
      data: [{ id: 1, name: 'BravoWidget' }],
      metadata: { columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }] },
    })

    const container = await mountView()
    const previewButtons = container.querySelectorAll('[data-testid="ds-preview"]')
    expect(previewButtons).toHaveLength(2)

    // Click preview A (parks on the pending schema), then preview B (resolves fast) before A returns.
    ;(previewButtons[0] as HTMLButtonElement).click()
    await flush()
    ;(previewButtons[1] as HTMLButtonElement).click()
    await flush()
    await flush()

    // Only B's bounded select ran.
    expect(previewRowsMock).toHaveBeenCalledWith('b', { table: 'public.b_orders', limit: 100 })
    expect(previewRowsMock).toHaveBeenCalledTimes(1)

    // A's slow response now arrives last. Without the guard it would set previewTable to A's table
    // and runActivePreview() would query previewRows('b', { table: 'public.a_items' }) — a
    // cross-source wrong query. The guard must drop it.
    resolveA?.({
      tables: [{ name: 'a_items', schema: 'public', columns: [{ name: 'id', type: 'int' }] }],
    })
    await flush()
    await flush()

    expect(previewRowsMock).toHaveBeenCalledTimes(1)
    expect(previewRowsMock).not.toHaveBeenCalledWith('b', { table: 'public.a_items', limit: 100 })
    expect(container.querySelector('[data-testid="ds-preview-result"]')?.textContent).toContain('BravoWidget')
  })

  it('clears stale preview errors through the cached empty-schema preview path', async () => {
    listMock.mockResolvedValue([{ id: 'pg', name: 'Warehouse DB', type: 'postgres', connected: true }])

    const container = await mountView()
    const store = useDataSourcesStore()
    store.schemas.pg = { tables: [], views: [] }
    store.previewErrors.pg = 'previous schema error'

    ;(container.querySelector('[data-testid="ds-preview"]') as HTMLButtonElement).click()
    await flush()
    await flush()

    expect(getSchemaMock).not.toHaveBeenCalled()
    expect(previewRowsMock).not.toHaveBeenCalled()
    expect(store.previewErrors.pg).toBe('')
    expect(container.querySelector('[data-testid="ds-preview-empty-schema"]')?.textContent).toContain('没有可预览')
  })

  it('create form: 测试连接 posts the built payload and renders inline success with latency', async () => {
    listMock.mockResolvedValue([])
    testDraftMock.mockResolvedValue({ success: true, latency: '12ms' })

    const container = await mountView()
    ;(container.querySelector('[data-testid="ds-new-button"]') as HTMLButtonElement).click()
    await flush()

    const host = container.querySelector('[data-testid="ds-field-host"]') as HTMLInputElement
    host.value = 'db.internal'; host.dispatchEvent(new Event('input'))
    const db = container.querySelector('[data-testid="ds-field-database"]') as HTMLInputElement
    db.value = 'erp'; db.dispatchEvent(new Event('input'))
    await flush()

    const testBtn = container.querySelector('[data-testid="ds-test-draft"]') as HTMLButtonElement
    expect(testBtn).not.toBeNull()
    testBtn.click()
    await flush()
    await flush()

    expect(testDraftMock).toHaveBeenCalledTimes(1)
    // wire check: the button posts the SAME create-payload builder used by submit (anti wire-drift).
    expect(testDraftMock.mock.calls[0][0]).toMatchObject({
      type: 'postgres',
      connection: { host: 'db.internal', database: 'erp' },
      options: { readOnly: true },
    })
    const ok = container.querySelector('[data-testid="ds-test-draft-ok"]')
    expect(ok?.textContent).toContain('连接成功')
    expect(ok?.textContent).toContain('12ms')
    // a passing test must NOT auto-submit / create the source (no hard gate, advisory only)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('create form: a failed draft test renders inline failure with the (already redacted) message', async () => {
    listMock.mockResolvedValue([])
    testDraftMock.mockResolvedValue({ success: false, error: { message: 'authentication failed' } })

    const container = await mountView()
    ;(container.querySelector('[data-testid="ds-new-button"]') as HTMLButtonElement).click()
    await flush()
    const host = container.querySelector('[data-testid="ds-field-host"]') as HTMLInputElement
    host.value = 'h'; host.dispatchEvent(new Event('input'))
    await flush()
    ;(container.querySelector('[data-testid="ds-test-draft"]') as HTMLButtonElement).click()
    await flush()
    await flush()

    const fail = container.querySelector('[data-testid="ds-test-draft-fail"]')
    expect(fail?.textContent).toContain('连接失败')
    expect(fail?.textContent).toContain('authentication failed')
    expect(container.querySelector('[data-testid="ds-test-draft-ok"]')).toBeNull()
  })

  it('edit mode hides the draft 测试连接 button (no secret available → would false-fail)', async () => {
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: false }])
    getMock.mockResolvedValue({
      id: 'a', name: 'A', type: 'postgres', connected: false, hasCredentials: true,
      connection: { host: 'db.internal', port: 5432, database: 'erp' }, options: { readOnly: true },
    })
    const container = await mountView()
    ;(container.querySelector('[data-testid="ds-edit"]') as HTMLButtonElement).click()
    await flush()
    await flush()
    await flush()
    expect(container.querySelector('[data-testid="ds-create-form"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="ds-test-draft"]')).toBeNull()
  })

  it('credential mode shows the draft test only after a new secret is entered', async () => {
    listMock.mockResolvedValue([{ id: 'a', name: 'A', type: 'postgres', connected: false }])
    getMock.mockResolvedValue({
      id: 'a', name: 'A', type: 'postgres', connected: false, hasCredentials: true,
      connection: { host: 'db.internal', port: 5432, database: 'erp' }, options: { readOnly: true },
    })
    const container = await mountView()
    ;(container.querySelector('[data-testid="ds-credentials"]') as HTMLButtonElement).click()
    await flush()
    await flush()
    await flush()
    expect(container.querySelector('[data-testid="ds-test-draft"]')).toBeNull() // no new secret yet
    const pw = container.querySelector('[data-testid="ds-field-password"]') as HTMLInputElement
    pw.value = 'newpw'; pw.dispatchEvent(new Event('input'))
    await flush()
    expect(container.querySelector('[data-testid="ds-test-draft"]')).not.toBeNull()
  })
})
