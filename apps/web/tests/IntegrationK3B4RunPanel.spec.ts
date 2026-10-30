import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { createRequire } from 'node:module'
import IntegrationReadSourceConfigPanel from '../src/components/integration/IntegrationReadSourceConfigPanel.vue'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { normalizeReadSourceConfigRow } from '../src/services/integration/readSourceConfigs'
import { K3B4PreviewError, readK3B4Page } from '../src/services/integration/k3B4Runs'
import { integrationErrorCodeDisplayLabel, integrationErrorCodeHint } from '../src/services/integration/errorCodeLabels'
import type { IntegrationScope, WorkbenchExternalSystem } from '../src/services/integration/workbench'

// Real Panel -> service -> apiFetch -> synthetic fetch. No apiFetch/service mocks.
// Response fixtures are produced by the actual backend B4 builder, read runtime, ERP source-run,
// and material persist implementation; only K3 transport and internal records are in memory.
const require = createRequire(import.meta.url)
const { buildK3WiseMaterialListB4Config } = require('../../../plugins/plugin-integration-core/lib/read-source-k3-material-list-b4-contract.cjs')
const { validateReadSourceConfig } = require('../../../plugins/plugin-integration-core/lib/read-source-config.cjs')
const { prepareConfiguredRead, executeConfiguredRead } = require('../../../plugins/plugin-integration-core/lib/read-source-read-runtime.cjs')
const { createK3WiseWebApiAdapter } = require('../../../plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs')
const { runErpMaterialReadonlySource, publicReadonlySourceRunResult } = require('../../../plugins/plugin-integration-core/lib/stock-preparation-readonly-source-run.cjs')
const { persistStockPreparationErpMaterialSync } = require('../../../plugins/plugin-integration-core/lib/stock-preparation-erp-material-sync-persist.cjs')
type Wire = Record<string, unknown>
type K3Response = { ok: boolean; status: number; text: () => Promise<string> }
type K3Transport = (url: string, init: RequestInit) => Promise<K3Response>
const FAILURE_CODES = {
  auth: 'READ_SOURCE_PROBE_AUTH_FAILED',
  network: 'READ_SOURCE_PROBE_NETWORK_FAILED',
  'transport-timeout': 'READ_SOURCE_PROBE_NETWORK_FAILED',
  'runtime-timeout': 'READ_SOURCE_PROBE_TIMEOUT',
  container: 'READ_SOURCE_PROBE_CONTAINER_NOT_FOUND',
  shape: 'READ_SOURCE_PROBE_SHAPE_MISMATCH',
  unrecognized: 'READ_SOURCE_PROBE_RESPONSE_UNRECOGNIZED',
  cap: 'READ_SOURCE_PROBE_CAP_REACHED',
  'transport-error': 'READ_SOURCE_PROBE_NETWORK_FAILED',
  'runtime-failed': 'READ_SOURCE_PROBE_FAILED',
  'runtime-rejected': 'READ_SOURCE_PROBE_REJECTED',
} as const
type FailureKind = keyof typeof FAILURE_CODES
const SYSTEM_ID = 'synthetic-k3'
const PRIVATE = 'SYNTHETIC_PRIVATE_NEVER_RENDER'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function setPath(value: Wire, path: string, replacement: unknown): void {
  const parts = path.split('.')
  let object = value
  for (const key of parts.slice(0, -1)) object = object[key] as Wire
  object[parts.at(-1)!] = replacement
}
function savedRow(version = 7): Wire {
  return {
    id: 'saved-b4', systemId: SYSTEM_ID, version, status: 'approved', contentKey: `synthetic-content-${version}`,
    object: 'material', mode: 'list_page',
    config: { ...buildK3WiseMaterialListB4Config({ systemId: SYSTEM_ID }), version },
  }
}
function rawRow(index: number): Wire {
  return { FItemID: `SYN-ID-${index}`, FNumber: `SYN-MAT-${index}`, FName: `Synthetic material ${index}`, FModel: 'Synthetic model', FUnitID: 'SYN-UNIT', extra: PRIVATE }
}
function backendRuntime(rowCount = 1, effective = 10, transport?: K3Transport) {
  const config = validateReadSourceConfig({ ...buildK3WiseMaterialListB4Config({ systemId: SYSTEM_ID }), version: 7 }).normalized
  const preparedRead = prepareConfiguredRead({ config, inputs: {} })
  const system = { id: SYSTEM_ID, kind: 'erp:k3-wise-webapi', role: 'source', credentials: { sessionId: 'synthetic-session' }, config: { baseUrl: 'https://synthetic-k3.invalid', objects: { material: {} } } }
  const createAdapter = (overlaidSystem: Wire) => createK3WiseWebApiAdapter({
    system: overlaidSystem,
    fetchImpl: transport ?? (async (_url: string, init: RequestInit) => {
      const page = (JSON.parse(String(init.body)) as { Data: { PageIndex: number } }).Data.PageIndex
      const rows = Array.from({ length: Math.min(effective, Math.max(0, rowCount - (page - 1) * effective)) }, (_, i) => rawRow((page - 1) * effective + i + 1))
      return { ok: true, status: 200, text: async () => JSON.stringify({ StatusCode: 200, Data: { PAGEINDEX: page, PAGESIZE: effective, ROWCOUNT: rowCount, DATA: rows } }) }
    }),
  })
  return { preparedRead, system, createAdapter }
}
async function readFixture(rows: number): Promise<Wire> {
  const runtime = backendRuntime(rows)
  return clone(await executeConfiguredRead(runtime.preparedRead, runtime, { rowSource: 'adapter_records' })) as Wire
}
async function failureFixture(kind: FailureKind): Promise<Wire> {
  if (kind === 'runtime-failed' || kind === 'runtime-rejected') {
    // Exercise the real runtime's adapter-rejection classifier separately from the
    // actual K3 adapter transport fixtures below; never fabricate the final envelope.
    const runtime = backendRuntime()
    const result = await executeConfiguredRead(runtime.preparedRead, {
      system: runtime.system,
      createAdapter: () => ({ read: async () => {
        const error = new Error(PRIVATE)
        if (kind === 'runtime-rejected') error.name = 'UnsupportedAdapterOperationError'
        throw error
      } }),
    }, { rowSource: 'adapter_records' })
    return clone(result) as Wire
  }
  const pending = deferred<K3Response>()
  const valid = { StatusCode: 200, Data: { PAGEINDEX: 1, PAGESIZE: 10, ROWCOUNT: 1, DATA: [rawRow(1)] } }
  const transport: K3Transport = async () => {
    if (kind === 'network') throw new TypeError(PRIVATE)
    // The actual K3 adapter wraps transport exceptions as network failures; only the
    // configured-read runtime's independent timeout produces the timeout fixture below.
    if (kind === 'transport-timeout') throw new DOMException(PRIVATE, 'TimeoutError')
    if (kind === 'transport-error') throw new Error(PRIVATE)
    if (kind === 'runtime-timeout') return pending.promise
    const body = clone(valid)
    if (kind === 'container') delete (body.Data as Wire).DATA
    if (kind === 'shape') (body.Data as Wire).DATA = [PRIVATE]
    if (kind === 'unrecognized') body.Data.PAGEINDEX = 99
    if (kind === 'cap') body.Data.DATA = Array.from({ length: 11 }, (_, i) => rawRow(i + 1))
    return { ok: kind !== 'auth', status: kind === 'auth' ? 401 : 200, text: async () => JSON.stringify({ ...body, message: PRIVATE }) }
  }
  const runtime = backendRuntime(1, 10, transport)
  const result = await executeConfiguredRead(runtime.preparedRead, {
    ...runtime, ...(kind === 'runtime-timeout' ? { timeoutMs: 1 } : {}),
  }, { rowSource: 'adapter_records' })
  // Settle the real adapter's pending transport after the runtime timeout, clearing its own timer.
  pending.resolve({ ok: true, status: 200, text: async () => JSON.stringify(valid) })
  return clone(result) as Wire
}
async function sourceFixture(rows = 1, effective = 10): Promise<Wire> {
  const result = await runErpMaterialReadonlySource({ permission: 'admin', syncRunId: 'synthetic-run', ...backendRuntime(rows, effective) })
  return clone(publicReadonlySourceRunResult(result)) as Wire
}
async function persistFixture(zero: boolean, patched = false): Promise<Wire> {
  const autoPersist = await persistStockPreparationErpMaterialSync({
    permission: 'admin', targetProjectId: 'synthetic-staging', syncRunId: 'synthetic-run',
    erpMaterials: zero ? [{}] : [{ erpMaterialId: 'synthetic-material', erpMaterialCode: 'SYN-MAT-1', erpMaterialInternalId: 'SYN-ID-1', erpMaterialName: 'Synthetic material 1' }],
    recordsApi: {
      queryRecords: async () => patched ? [{ id: 'synthetic-record', data: { erpMaterialId: 'synthetic-material', status: 'partial' } }] : [],
      createRecord: async ({ data }: { data: Wire }) => ({ id: 'synthetic-record', data }),
      patchRecord: async () => ({ id: 'synthetic-record' }),
    },
    provisioning: {
      findObjectSheet: async ({ objectId }: { objectId: string }) => ({ id: `synthetic-${objectId}` }),
      resolveFieldIds: async ({ fieldIds }: { fieldIds: string[] }) => Object.fromEntries(fieldIds.map((field) => [field, field])),
    },
  })
  const source = await sourceFixture()
  return { ...source, mode: 'internal_persist', evidence: { ...source.evidence as Wire, internalWriteExecuted: true }, autoPersist }
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), { status, headers: { 'Content-Type': 'application/json' } })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function flush(): Promise<void> {
  for (let i = 0; i < 16; i += 1) { await Promise.resolve(); await nextTick() }
}

describe('approved B4 run through real Panel, service and apiFetch', () => {
  let app: App | undefined
  let root: HTMLDivElement
  let listed: Wire[]
  let preview: Wire
  let previewZero: Wire
  let previewTen: Wire
  let off: Wire
  let on: Wire
  let onZero: Wire
  let onPatched: Wire
  let smallPage: Wire
  let failures: Record<FailureKind, Wire>
  let confirm: MockInstance<[message?: string], boolean>
  let nextRun: () => Promise<Response>
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const posts = () => calls.filter(({ init, url }) => init.method === 'POST' && (url.pathname.endsWith('/read') || url.pathname.endsWith('/erp-materials')))
  let state: { scope: IntegrationScope; systems: WorkbenchExternalSystem[]; admin?: boolean }
  const query = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = root.querySelector(`[data-testid="${id}"]`)
    if (!element) throw new Error(`missing test element ${id}`)
    return element as T
  }
  const click = async (id: string) => { query<HTMLButtonElement>(id).click(); await flush() }
  function mount(): void {
    app = createApp({ render: () => h(IntegrationReadSourceConfigPanel, { scope: state.scope, systems: state.systems, hasIntegrationAdmin: state.admin, initialViewMode: 'expert' }) })
    app.config.warnHandler = () => {}
    app.mount(root)
  }
  beforeAll(async () => {
    ;[preview, previewZero, previewTen, off, on, onZero, onPatched, smallPage] = await Promise.all([
      readFixture(1), readFixture(0), readFixture(10), sourceFixture(), persistFixture(false), persistFixture(true), persistFixture(false, true), sourceFixture(7, 5),
    ])
    const kinds = Object.keys(FAILURE_CODES) as FailureKind[]
    failures = Object.fromEntries(await Promise.all(kinds.map(async (kind) => [kind, await failureFixture(kind)]))) as Record<FailureKind, Wire>
  })
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('auth_token', `synthetic.${btoa(JSON.stringify({ sub: 'synthetic-admin', tenantId: 'synthetic-tenant' }))}.signature`)
    localStorage.setItem('tenantId', 'FORGED-HEADER-HINT')
    calls.length = 0
    listed = [savedRow()]
    nextRun = async () => response(preview)
    state = reactive({ scope: { tenantId: 'synthetic-tenant', workspaceId: 'synthetic-workspace' }, systems: [{ id: SYSTEM_ID, tenantId: 'synthetic-tenant', workspaceId: 'synthetic-workspace', name: 'Synthetic K3', kind: 'erp:k3-wise-webapi', role: 'source' as const, status: 'active' as const }], admin: true })
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url)
      calls.push({ url: parsed, init })
      if (parsed.pathname.endsWith('/read') || parsed.pathname.endsWith('/erp-materials')) return nextRun()
      if (parsed.pathname.endsWith('/retire')) return response({ ...listed[0], status: 'retired' })
      return response(listed)
    }))
    confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    root = document.createElement('div')
    document.body.appendChild(root)
  })
  afterEach(() => {
    app?.unmount(); app = undefined
    root.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('canonical server B4 config accepts stored version 7 and key reordering, rejecting drift and client flags', () => {
    const row = savedRow()
    row.config = Object.fromEntries(Object.entries(row.config as Wire).reverse())
    ;(row.config as Wire).fieldMap = [{ target: 'baseUnit', source: 'FUnitID' }]
    expect(normalizeReadSourceConfigRow(row)?.k3B4Eligible).toBe(true)
    for (const [path, value] of [
      ['config.version', 1], ['version', 0], ['config.systemId', 'other'], ['systemId', 'other'],
      ['config.readPath', '/arbitrary'], ['config.operations', ['read', 'write']], ['config.extra', true],
      ['config.fieldMap', [{ source: 'FUnitID', target: 'other' }]], ['config.containerPaths', ['Data']],
      ['config.keyField', 'FNumber'], ['config.actionProfileVersion', 'fake'], ['config', null],
    ] as Array<[string, unknown]>) {
      const fake = savedRow(); setPath(fake, path, value); fake.k3B4Eligible = true
      expect(normalizeReadSourceConfigRow(fake)?.k3B4Eligible, path).toBe(false)
    }
  })

  it('loads, expands, changes draft and cancels both confirmations without running POSTs', async () => {
    mount(); await flush()
    const details = query<HTMLDetailsElement>('k3-b4-run-saved-b4')
    details.open = true
    const draft = query<HTMLInputElement>('rsc-object')
    draft.value = PRIVATE; draft.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    expect(posts()).toHaveLength(0)
    confirm.mockReturnValue(false)
    await click('k3-b4-preview'); await click('k3-b4-sync')
    expect(posts()).toHaveLength(0)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('reads only approved saved id with a fixed wire body, workspace query, and no actual tenant hint header', async () => {
    mount(); await flush()
    const draft = query<HTMLInputElement>('rsc-object')
    draft.value = 'draft-must-not-run'; draft.dispatchEvent(new Event('input', { bubbles: true }))
    await click('k3-b4-preview')
    expect(posts()).toHaveLength(1)
    const request = posts()[0]
    expect(request.url.pathname).toBe('/api/integration/read-source-configs/saved-b4/read')
    expect([...request.url.searchParams.entries()]).toEqual([['workspaceId', 'synthetic-workspace']])
    expect(JSON.parse(String(request.init.body))).toEqual({ inputs: {}, rowSource: 'adapter_records' })
    expect(new Headers(request.init.headers).has('x-tenant-id')).toBe(false)
    expect(new Headers(request.init.headers).has('authorization')).toBe(true)
    // Establish apiFetch really had a header to remove: legacy list still carries the synthetic hint.
    expect(new Headers(calls[0].init.headers).get('x-tenant-id')).toBe('FORGED-HEADER-HINT')
    expect(query('k3-b4-preview-result').textContent).toContain('单页，不代表全量')
    expect(query('k3-b4-preview-table').textContent).toContain('Synthetic material 1')
    expect(root.textContent).not.toContain(PRIVATE)
    expect(query('k3-b4-preview-table').querySelectorAll('th')).toHaveLength(5)
  })

  it.each(['missing', 'false'] as const)('hides sync when exact current admin hint is %s', async (kind) => {
    state.admin = kind === 'missing' ? undefined : false
    mount(); await flush()
    expect(root.querySelector('[data-testid="k3-b4-sync"]')).toBeNull()
    await click('k3-b4-preview')
    expect(posts()).toHaveLength(1)
  })

  it('omits an absent workspace rather than submitting a tenant or null scope override', async () => {
    state.scope.workspaceId = null
    mount(); await flush(); await click('k3-b4-preview')
    expect(posts()[0].url.search).toBe('')
    nextRun = async () => response(off)
    await click('k3-b4-sync')
    expect(JSON.parse(String(posts()[1].init.body))).toEqual({ readSourceConfigId: 'saved-b4', inputs: {}, syncRunId: expect.any(String) })
    expect(new Headers(posts()[1].init.headers).has('x-tenant-id')).toBe(false)
  })

  it.each(['draft', 'retired', 'fake', 'wrong-system', 'inactive'] as const)('does not execute %s saved source', async (kind) => {
    if (kind === 'draft' || kind === 'retired') listed[0].status = kind
    if (kind === 'fake') delete listed[0].config
    if (kind === 'wrong-system') state.systems[0].kind = 'http'
    if (kind === 'inactive') state.systems[0].status = 'inactive'
    mount(); await flush()
    const button = root.querySelector<HTMLButtonElement>('[data-testid="k3-b4-preview"]')
    expect(button === null || button.disabled).toBe(true)
    button?.click(); await flush()
    expect(posts()).toHaveLength(0)
  })

  it.each(['empty', 'capped'] as const)('labels %s single page honestly', async (kind) => {
    nextRun = async () => response(kind === 'empty' ? previewZero : previewTen)
    mount(); await flush(); await click('k3-b4-preview')
    expect(query('k3-b4-preview-result').textContent).toContain(kind === 'empty' ? '本页为空' : '已达单页 10 行上限')
    expect(query('k3-b4-preview-result').textContent).toContain('不代表全量')
  })

  it('drops response extras from both successful result surfaces', async () => {
    const page = clone(preview)
    setPath(page, 'data.containers.primary.records.0.credentials', PRIVATE)
    page.credentials = PRIVATE
    nextRun = async () => response(page)
    mount(); await flush(); await click('k3-b4-preview')
    expect(query('k3-b4-preview-table').textContent).toContain('Synthetic material 1')
    expect(root.textContent).not.toContain(PRIVATE)
    nextRun = async () => response({ ...on, intake: { rows: [PRIVATE] }, credentials: PRIVATE })
    await click('k3-b4-sync')
    expect(query('k3-b4-sync-result').textContent).toContain('本次已写入内部物料缓存')
    expect(root.textContent).not.toContain(PRIVATE)
  })

  it('rejects oversized arrays and aggregate preview text instead of silently truncating', async () => {
    const oversized = clone(previewTen)
    const rows = ((oversized.data as Wire).containers as Wire).primary as { records: Wire[] }
    rows.records.push(rawRow(11))
    nextRun = async () => response(oversized)
    mount(); await flush(); await click('k3-b4-preview')
    expect(query('k3-b4-error').textContent).toContain('K3_B4_READ_FAILED')
    const huge = clone(previewTen)
    const hugeRows = (((huge.data as Wire).containers as Wire).primary as { records: Wire[] }).records
    for (const row of hugeRows) for (const field of ['FItemID', 'FNumber', 'FName', 'FModel', 'baseUnit']) row[field] = 'x'.repeat(2000)
    nextRun = async () => response(huge)
    await click('k3-b4-preview')
    expect(query('k3-b4-error').textContent).toContain('K3_B4_READ_FAILED')
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
  })

  it.each([
    ['evidence.ok', false], ['evidence.ok', 'true'], ['evidence.recordCount', 2],
    ['data.recordCount', 2], ['evidence.containers.primary.arrayLength', 2], ['evidence.mode', 'single_record'],
    ['evidence.object', PRIVATE], ['data.containers.primary.records.0.FName', { secret: PRIVATE }],
    ['data.containers.primary.records.0.FName', 'x'.repeat(4097)], ['evidence.capReached', true],
    ['evidence.timeoutReached', true], ['evidence.boundedSmokeExecuted', false], ['evidence.boundedSmoke', false],
    ['evidence.ok', undefined], ['data.containers.primary.records', null],
  ])('rejects invalid preview %s without rows or raw errors', async (path, value) => {
    const bad = clone(preview); setPath(bad, String(path), value)
    nextRun = async () => response(bad)
    mount(); await flush(); await click('k3-b4-preview')
    expect(query('k3-b4-error').textContent).toContain('K3_B4_READ_FAILED')
    expect(root.querySelector('[data-testid="k3-b4-preview-table"]')).toBeNull()
    expect(root.textContent).not.toContain(PRIVATE)
    expect(posts()).toHaveLength(1)
  })

  it.each(Object.keys(FAILURE_CODES) as FailureKind[])('shows only registered diagnostics from actual %s failure producers', async (kind) => {
    const code = FAILURE_CODES[kind]
    const failure = failures[kind]
    expect(failure.data).toBeNull()
    expect(failure.evidence).toMatchObject({ ok: false, object: 'material', mode: 'list_page', boundedSmoke: true, errorCode: code })
    if (kind === 'runtime-timeout') expect((failure.evidence as Wire).timeoutReached).toBe(true)
    mount(); await flush(); await click('k3-b4-preview')
    nextRun = async () => response({ ...failure, message: PRIVATE, details: { secret: PRIVATE } })
    await click('k3-b4-preview')
    const text = query('k3-b4-error').textContent
    expect(text).toContain(code)
    expect(text).toContain(integrationErrorCodeDisplayLabel(code, 'zh-CN'))
    const hint = integrationErrorCodeHint(code, 'zh-CN')
    if (hint) expect(text).toContain(hint)
    expect(text).toContain('未展示业务行；未自动重试')
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
    expect(root.textContent).not.toContain(PRIVATE)
    expect(posts()).toHaveLength(2)
  })

  it.each([
    ['evidence.errorCode', PRIVATE], ['evidence.errorCode', 'READ_SOURCE_PROBE_AUTH_FAILED_EXTRA'],
    ['evidence.errorCode', 'READ_SOURCE_RESOLVER_FAILED'], ['evidence.errorCode', 'K3_WISE_BOM_LIST_BY_MATERIAL_FAILED'],
    ['evidence.errorCode', 'READ_SOURCE_PROBE_CONTRACT_INVALID'], ['evidence.errorCode', 'READ_SOURCE_PROBE_CONFIG_INVALID'],
    ['evidence.errorCode', null], ['evidence', null], ['data', {}], ['data', undefined],
    ['evidence.ok', true], ['evidence.ok', 'false'], ['evidence.ok', undefined],
    ['evidence.object', 'bom'], ['evidence.mode', 'single_record'],
    ['evidence.boundedSmoke', false], ['evidence.boundedSmoke', 'true'], ['evidence.boundedSmoke', undefined],
    ['evidence.boundedSmokeExecuted', true], ['evidence.boundedSmokeExecuted', 'false'],
    ['evidence.timeoutReached', true], ['evidence.timeoutReached', 'false'],
    ['evidence.containerLocated', true], ['evidence.containerLocated', 'false'],
    ['evidence.capReached', true], ['evidence.recordCount', 1],
  ])('keeps foreign or malformed failure %s generic', async (path, value) => {
    const bad = clone(failures.auth); setPath(bad, String(path), value)
    bad.message = PRIVATE
    nextRun = async () => response(bad)
    mount(); await flush(); await click('k3-b4-preview')
    expect(query('k3-b4-error').textContent).toContain('K3_B4_READ_FAILED')
    expect(query('k3-b4-error').textContent).not.toContain('READ_SOURCE_PROBE_')
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
    expect(root.textContent).not.toContain(PRIVATE)
    expect(posts()).toHaveLength(1)
  })

  it('rejects an unknown failure code at the service boundary independently of display filtering', async () => {
    const bad = clone(failures.auth)
    setPath(bad, 'evidence.errorCode', 'READ_SOURCE_PROBE_AUTH_FAILED_EXTRA')
    nextRun = async () => response(bad)
    const failure: unknown = await readK3B4Page('saved-b4', 'synthetic-workspace').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(K3B4PreviewError)
    expect(failure).toMatchObject({ message: 'K3_B4_READ_FAILED' })
    expect(failure).not.toHaveProperty('code')
    expect(posts()).toHaveLength(1)
  })

  it.each(['non-2xx', 'outer-failure', 'malformed-json', 'code-shaped', 'constructed', 'json-constructed'] as const)('keeps %s transport/response failures generic even with a known code', async (kind) => {
    const code = 'READ_SOURCE_PROBE_AUTH_FAILED'
    nextRun = async () => {
      if (kind === 'code-shaped') throw { code, message: PRIVATE, details: { secret: PRIVATE } }
      if (kind === 'constructed') throw new K3B4PreviewError(code)
      if (kind === 'json-constructed') return Object.assign(new Response(), { json: async () => { throw new K3B4PreviewError(code) } })
      if (kind === 'malformed-json') return new Response(PRIVATE)
      if (kind === 'outer-failure') return new Response(JSON.stringify({ ok: false, data: failures.auth, error: { code, message: PRIVATE } }))
      return response(failures.auth, 403)
    }
    mount(); await flush(); await click('k3-b4-preview')
    expect(query('k3-b4-error').textContent).toContain('K3_B4_READ_FAILED')
    expect(query('k3-b4-error').textContent).not.toContain(code)
    expect(root.textContent).not.toContain(PRIVATE)
    expect(posts()).toHaveLength(1)
  })

  it.each(Object.keys(FAILURE_CODES) as FailureKind[])('keeps sync result unknown for a %s read failure envelope', async (kind) => {
    nextRun = async () => response(failures[kind])
    mount(); await flush(); await click('k3-b4-sync')
    const text = query('k3-b4-error').textContent
    expect(text).toContain('K3_B4_SYNC_RESULT_UNKNOWN')
    expect(text).toContain('内部缓存或运行记录可能已部分更新')
    expect(text).toContain('请先核查运行记录；未自动重试')
    expect(text).not.toContain(FAILURE_CODES[kind])
    expect(root.querySelector('[data-testid="k3-b4-sync-result"]')).toBeNull()
    expect(posts()).toHaveLength(1)
  })

  it.each(['off', 'on', 'zero', 'patched', 'small-page'] as const)('normalizes actual backend %s sync response and fixed request', async (mode) => {
    nextRun = async () => response(({ off, on, zero: onZero, patched: onPatched, 'small-page': smallPage })[mode])
    mount(); await flush(); await click('k3-b4-sync')
    expect(posts()).toHaveLength(1)
    const request = posts()[0]
    const body = JSON.parse(String(request.init.body))
    expect(body).toEqual({ readSourceConfigId: 'saved-b4', workspaceId: 'synthetic-workspace', inputs: {}, syncRunId: expect.stringMatching(/^k3-b4-/) })
    expect(request.url.search).toBe('')
    expect(new Headers(request.init.headers).has('x-tenant-id')).toBe(false)
    const text = query('k3-b4-sync-result').textContent
    expect(text).toContain(mode === 'on' || mode === 'patched' ? '本次已写入内部物料缓存' : mode === 'zero' ? '本次物料缓存未落库' : '只读验证成功')
    if (mode === 'zero') expect(text).toContain('运行记录新增 1')
    if (mode === 'patched') expect(text).toContain('物料新增 0、更新 1')
    if (mode === 'small-page') expect(text).toContain('读取 2 页 / 7 行')
    expect(text).not.toContain('Synthetic material')
  })

  it.each([
    ['sourceRun', PRIVATE], ['status', 'partial'], ['mode', 'fake'], ['evidence.externalWriteExecuted', true],
    ['evidence.k3SaveSubmitAudit', 'false'], ['evidence.internalWriteExecuted', false], ['autoPersist.persisted', 'true'],
    ['autoPersist.persisted', false], ['autoPersist.created.materials', 2], ['autoPersist.evidence.persisted', false],
    ['autoPersist.evidence.runSyncMode', 'patched'], ['autoPersist', null],
    ['evidence.externalWriteExecuted', undefined], ['evidence.k3SaveSubmitAudit', undefined],
  ])('refuses contradictory sync %s and exposes no private data', async (path, value) => {
    const bad = clone(on); setPath(bad, String(path), value)
    bad.message = PRIVATE; bad.intake = { secret: PRIVATE }
    nextRun = async () => response(bad)
    mount(); await flush(); await click('k3-b4-sync')
    expect(query('k3-b4-error').textContent).toContain('结果未确认')
    expect(query('k3-b4-error').textContent).toContain('可能已部分更新')
    expect(root.querySelector('[data-testid="k3-b4-sync-result"]')).toBeNull()
    expect(root.textContent).not.toContain(PRIVATE)
    expect(posts()).toHaveLength(1)
  })

  it('refuses OFF results with autoPersist or ON flags', async () => {
    const bad = { ...clone(off), autoPersist: {} }
    nextRun = async () => response(bad)
    mount(); await flush(); await click('k3-b4-sync')
    expect(query('k3-b4-error').textContent).toContain('结果未确认')
    delete (bad as Wire).autoPersist
    setPath(bad, 'evidence.internalWriteExecuted', true)
    await click('k3-b4-sync')
    expect(query('k3-b4-error').textContent).toContain('结果未确认')
  })

  it.each(['network', 'timeout', 'http', 'malformed-json'] as const)('clears prior rows on %s error without retry or upstream details', async (kind) => {
    mount(); await flush(); await click('k3-b4-preview')
    nextRun = async () => {
      if (kind === 'network') throw new TypeError('Failed to fetch')
      if (kind === 'timeout') throw new DOMException(PRIVATE, 'TimeoutError')
      if (kind === 'malformed-json') return new Response(PRIVATE)
      return new Response(JSON.stringify({ ok: false, data: preview, error: { code: PRIVATE, message: PRIVATE } }), { status: 403 })
    }
    await click('k3-b4-sync')
    expect(posts()).toHaveLength(2)
    expect(query('k3-b4-error').textContent).toContain('核查运行记录')
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
    expect(root.textContent).not.toContain(PRIVATE)
  })

  it.each(['tenant', 'workspace', 'system-kind', 'system-status', 'admin', 'refresh', 'retire', 'session', 'silent-token', 'unmount'] as const)('discards late preview on %s change and keeps one request in flight', async (change) => {
    const pending = deferred<Response>()
    nextRun = () => pending.promise
    mount(); await flush(); await click('k3-b4-preview')
    expect(query<HTMLButtonElement>('k3-b4-sync').disabled).toBe(true)
    if (change === 'tenant') state.scope.tenantId = 'other-tenant'
    if (change === 'workspace') state.scope.workspaceId = 'other-workspace'
    if (change === 'system-kind') state.systems[0].kind = 'http'
    if (change === 'system-status') state.systems[0].status = 'inactive'
    if (change === 'admin') state.admin = false
    if (change === 'refresh') await click('rsc-refresh')
    if (change === 'retire') await click('rsc-retire-saved-b4')
    if (change === 'session') { notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic-next-session') }
    if (change === 'silent-token') localStorage.setItem('auth_token', 'synthetic-next-session')
    if (change === 'unmount') { app!.unmount(); app = undefined }
    await flush()
    pending.resolve(response(preview)); await flush()
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
    expect(posts()).toHaveLength(1)
  })

  it.each(['scope', 'admin', 'refresh', 'principal', 'silent-token', 'permission', 'unmount'] as const)('discards late trusted failure diagnostics after %s changes', async (change) => {
    const pending = deferred<Response>()
    nextRun = () => pending.promise
    mount(); await flush(); await click('k3-b4-preview')
    const owningButton = query<HTMLButtonElement>('k3-b4-preview')
    if (change === 'scope') state.scope.workspaceId = 'next-workspace'
    if (change === 'admin') state.admin = false
    if (change === 'refresh') await click('rsc-refresh')
    if (change === 'principal') notifyAuthPrincipalChange()
    if (change === 'silent-token') localStorage.setItem('auth_token', 'synthetic-next-session')
    if (change === 'permission') { localStorage.setItem('user_permissions', '[]'); window.dispatchEvent(new Event('storage')) }
    if (change === 'unmount') { app!.unmount(); app = undefined }
    await flush()
    if (change !== 'unmount') {
      const button = root.querySelector<HTMLButtonElement>('[data-testid="k3-b4-preview"]')
      if (change === 'scope') {
        // A workspace change removes the old row and mounts a new run-panel instance.
        // Its busy state is not a cross-instance lock; only the old result must be discarded.
        expect(owningButton.isConnected).toBe(false)
        expect(button).not.toBe(owningButton)
      } else if (button) {
        expect(button.disabled).toBe(true)
        button.click(); await flush()
      }
      expect(posts()).toHaveLength(1)
    }
    pending.resolve(response(failures.auth)); await flush()
    expect(root.querySelector('[data-testid="k3-b4-error"]')).toBeNull()
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
    expect(posts()).toHaveLength(1)
    if (['scope', 'admin', 'refresh', 'silent-token'].includes(change)) {
      const button = root.querySelector<HTMLButtonElement>('[data-testid="k3-b4-preview"]')
      if (button) expect(button.disabled).toBe(false)
    }
  })

  it('clears already-rendered rows on principal/token changes and ignores stale list completion', async () => {
    mount(); await flush(); await click('k3-b4-preview')
    notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic-new-token')
    await flush()
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
    await click('rsc-refresh')
    await click('k3-b4-preview')
    localStorage.setItem('auth_token', 'synthetic-third-token')
    window.dispatchEvent(new Event('storage')); await flush()
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
  })

  it.each(['scope', 'admin', 'refresh', 'principal'] as const)('discards delayed sync completion after %s changes', async (change) => {
    const pending = deferred<Response>()
    nextRun = () => pending.promise
    mount(); await flush(); await click('k3-b4-sync')
    if (change === 'scope') state.scope.workspaceId = 'next-workspace'
    if (change === 'admin') state.admin = false
    if (change === 'refresh') await click('rsc-refresh')
    if (change === 'principal') notifyAuthPrincipalChange()
    await flush()
    pending.resolve(response(on)); await flush()
    expect(root.querySelector('[data-testid="k3-b4-sync-result"]')).toBeNull()
    expect(posts()).toHaveLength(1)
  })

  it('rechecks current auth after confirmation before POST', async () => {
    mount(); await flush()
    confirm.mockImplementation(() => { notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'synthetic-new-token'); return true })
    await click('k3-b4-sync')
    expect(posts()).toHaveLength(0)
  })

  it.each(['displayed', 'pending'] as const)('clears %s non-admin data on same-token read permission revocation', async (mode) => {
    state.admin = false
    localStorage.setItem('user_permissions', JSON.stringify(['integration:read']))
    const pending = deferred<Response>()
    if (mode === 'pending') nextRun = () => pending.promise
    mount(); await flush(); await click('k3-b4-preview')
    localStorage.setItem('user_permissions', '[]')
    window.dispatchEvent(new Event('storage'))
    await flush()
    if (mode === 'pending') { pending.resolve(response(preview)); await flush() }
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
    expect(posts()).toHaveLength(1)
  })

  it.each(['version', 'contentKey', 'status', 'systemId'] as const)('refresh invalidates existing results when saved %s changes', async (field) => {
    mount(); await flush(); await click('k3-b4-preview')
    if (field === 'version') listed = [savedRow(8)]
    if (field === 'contentKey') listed[0].contentKey = 'new-content'
    if (field === 'status') listed[0].status = 'retired'
    if (field === 'systemId') listed[0].systemId = 'other'
    await click('rsc-refresh')
    expect(root.querySelector('[data-testid="k3-b4-preview-result"]')).toBeNull()
    expect(posts()).toHaveLength(1)
  })
})
