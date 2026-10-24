import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { MultitableApiClient } from '../src/multitable/api/client'
import type { MetaField, MetaRecord } from '../src/multitable/types'

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
vi.mock('../src/services/plm/plmBomWriteBindings', () => ({
  listPlmBomWriteBindings: (...args: unknown[]) => listBindingsMock(...args),
  getPlmBomWriteManagementUrl: vi.fn(),
  bindPlmBomWriteGrant: vi.fn(),
  unbindPlmBomWriteBinding: vi.fn(),
  retryPlmBomWriteRetiredRevocations: vi.fn(),
  PlmBomWriteBindingError: class PlmBomWriteBindingError extends Error {
    readonly code: string
    constructor(code: string) {
      super('绑定操作未完成。')
      this.code = code
    }
  },
}))

import PlmBomReviewWorkspaceView from '../src/views/PlmBomReviewWorkspaceView.vue'
import PlmCollaborationSnapshotsPanel, {
  PLM_COLLABORATION_CONFIRM_STORAGE_KEY,
  readPlmCollaborationSnapshotHint,
} from '../src/components/plm/PlmCollaborationSnapshotsPanel.vue'

const TOKEN = 'bearer-secret-9f3a'
const PREVIEW_ID = '99999999-9999-4999-8999-999999999999'
const BINDING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const READY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const LOCAL_FIELDS = ['collaboration_owner', 'followup_due_at', 'review_note']
const VISIBLE_FIELD_ID = '11111111-2222-4333-8444-555555555555'
const HIDDEN_FIELD_ID = '22222222-3333-4444-8555-666666666666'
let panelVm: { confirm: () => Promise<void>; refresh: () => Promise<void> } | null = null

interface Call {
  url: string
  init?: RequestInit
}

const calls: Call[] = []
const resolvers: Array<(value: Response) => void> = []
let responder: (url: string, init?: RequestInit) => Promise<Response> | Response = () => jsonResponse({ ok: true, data: {} })

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return responder(url, init)
  }))
}

function installLocks(): void {
  const locks = {
    request: (_name: string, _options: { mode: 'exclusive' }, callback: () => unknown) => Promise.resolve().then(callback),
  }
  Object.defineProperty(navigator, 'locks', { configurable: true, value: locks })
}

function installSessionStorage(): void {
  const store: Record<string, string> = {}
  const storage = {
    get length() {
      return Object.keys(store).length
    },
    clear() {
      for (const key of Object.keys(store)) delete store[key]
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null
    },
    removeItem(key: string) {
      delete store[key]
    },
    setItem(key: string, value: string) {
      store[key] = String(value)
    },
  }
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: storage })
  Object.defineProperty(window, 'sessionStorage', { configurable: true, writable: true, value: storage })
}

function snapshotCalls(): Call[] {
  return calls.filter((call) => call.url.includes('/api/plm-collaboration-snapshots'))
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init?.body ?? '{}')) as Record<string, unknown>
}

function previewPayload(currentVersionId: string | null, name = 'ECO plain') {
  return {
    ok: true,
    data: {
      previewId: PREVIEW_ID,
      expiresAt: '2026-10-24T00:00:00.000Z',
      businessHash: 'hash',
      capturedAt: '2026-10-24T00:00:00.000Z',
      rowKey: ['src-a', 'tenant', 'org', 'eco-1'],
      baseId: 'base-2',
      name: '协作表',
      anchor: {
        dataSourceId: 'src-a',
        tenantId: 'tenant',
        orgId: 'org',
        itemId: 'item-1',
        currentVersionId,
        ecoId: 'eco-1',
      },
      eco: { id: 'eco-1', name },
    },
  }
}

function publishedPayload() {
  return {
    ok: true,
    data: {
      bindingId: BINDING_ID,
      sheetId: 'sheet-1',
      viewId: 'view-1',
      version: 1,
      status: 'active',
      recordId: 'record-1',
      noop: false,
      replayed: false,
    },
  }
}

function loadedPayload(kind: 'eco' | 'readiness', extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      id: kind === 'eco' ? BINDING_ID : READY_ID,
      status: 'active',
      version: 4,
      name: '协作表',
      baseId: 'base-2',
      sheetId: 'sheet-1',
      viewId: 'view-1',
      sourceKind: kind,
      anchor: {
        dataSourceId: 'src-a',
        tenantId: 'tenant',
        orgId: 'org',
        itemId: 'item-1',
        currentVersionId: 'ver-locked',
      },
      canRefresh: kind === 'eco',
      row: kind === 'eco'
        ? {
          recordId: 'record-9',
          rowKey: ['src-a', 'tenant', 'org', 'eco-9'],
          businessHash: 'h',
          capturedAt: 't',
          cells: { [VISIBLE_FIELD_ID]: 'ROOT_VISIBLE_SOURCE_A' },
        }
        : null,
      ...extra,
    },
  }
}

let app: VueApp | null = null
let router: Router | null = null
let container: HTMLDivElement | null = null

async function flush(cycles = 20): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
  // crypto.subtle.digest completes on the libuv poll phase, after setTimeout.
  // setImmediate runs after that poll, so confirm storage and navigation are
  // visible before the assertion and before afterEach unmounts the router.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setImmediate(resolve))
}

function panel(): HTMLElement {
  const element = container?.querySelector('[data-testid="plm-collaboration-snapshots-panel"]')
  if (!(element instanceof HTMLElement)) throw new Error('missing panel')
  return element
}

function click(testId: string): void {
  const element = container?.querySelector(`[data-testid="${testId}"]`)
  if (!(element instanceof HTMLElement)) throw new Error(`missing ${testId}`)
  element.click()
}

function setField(testId: string, value: string, eventName: 'change' | 'input'): void {
  const element = container?.querySelector(`[data-testid="${testId}"]`)
  if (!(element instanceof HTMLInputElement)) throw new Error(`missing ${testId}`)
  element.value = value
  element.dispatchEvent(new Event(eventName))
}

async function mountPanel(options: {
  dataSourceId?: string
  itemId?: string
  hint?: unknown
  rows?: MetaRecord[]
  fields?: MetaField[]
} = {}): Promise<ReturnType<typeof reactive<{
  dataSourceId: string
  itemId: string
  hint: unknown
  rows: MetaRecord[]
  fields: MetaField[]
}>>> {
  const state = reactive({
    dataSourceId: options.dataSourceId ?? 'src-a',
    itemId: options.itemId ?? 'item-1',
    hint: options.hint ?? null,
    rows: options.rows ?? [],
    fields: options.fields ?? [],
  })
  const client = {
    listBases: vi.fn(async () => ({
      bases: [
        { id: 'base-1', name: '第一库' },
        { id: 'base-2', name: '第二库' },
      ],
    })),
  }
  const Root = defineComponent({
    name: 'CollaborationPanelRoot',
    setup() {
      return () => h(PlmCollaborationSnapshotsPanel, {
        ref: (vm: unknown) => {
          panelVm = vm as { confirm: () => Promise<void>; refresh: () => Promise<void> } | null
        },
        dataSourceId: state.dataSourceId,
        itemId: state.itemId,
        hint: state.hint,
        visibleRows: state.rows,
        visibleFields: state.fields,
        client,
      })
    },
  })
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Root },
      { path: '/multitable/:sheetId/:viewId', name: 'multitable', component: { template: '<div data-testid="dest" />' } },
    ],
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(defineComponent({ setup: () => () => h(RouterView) }))
  app.use(router)
  app.mount(container)
  await router.isReady()
  await flush()
  return state
}

async function mountHost(query: Record<string, string> = {}): Promise<void> {
  const history = createMemoryHistory()
  const search = new URLSearchParams(query).toString()
  history.replace(`/plm/bom-review${search ? `?${search}` : ''}`)
  router = createRouter({
    history,
    routes: [{ path: '/plm/bom-review', component: PlmBomReviewWorkspaceView }],
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(defineComponent({ setup: () => () => h(RouterView) }))
  app.use(router)
  app.mount(container)
  await router.isReady()
  await flush()
}

function cleanup(): void {
  app?.unmount()
  app = null
  router = null
  panelVm = null
  container?.remove()
  container = null
}

function gateNextRealDigest(): { entered: Promise<void>; release: () => void; restore: () => void } {
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const releasedPromise = new Promise<void>((resolve) => { release = resolve })
  const real = crypto.subtle.digest.bind(crypto.subtle)
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
    entered()
    await releasedPromise
    return await real(algorithm, data)
  })
  return { entered: enteredPromise, release, restore: () => spy.mockRestore() }
}

async function lostPrincipalConfirm(): Promise<string> {
  localStorage.setItem('auth_token', 'root-meta-principal-A')
  responder = (url) => {
    if (url.endsWith('/preview')) return jsonResponse(previewPayload(null))
    if (url.endsWith('/confirm')) throw new TypeError('controlled response loss')
    return jsonResponse(loadedPayload('eco'))
  }
  await mountPanel()
  await fillEco('none')
  click('preview')
  await flush()
  await panelVm!.confirm()
  const raw = sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
  expect(raw).not.toBeNull()
  return raw ?? ''
}

function replacementPending(raw: string): string {
  const value = JSON.parse(raw) as {
    body: { requestId: string; previewId: string }
    context: { previewId: string }
  }
  value.body.requestId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
  value.body.previewId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
  value.context.previewId = value.body.previewId
  return JSON.stringify(value)
}

function trackUnhandled(): { stop: () => unknown[] } {
  const reasons: unknown[] = []
  const onRejection = (reason: unknown) => { reasons.push(reason) }
  let stopped = false
  process.on('unhandledRejection', onRejection)
  return {
    stop() {
      if (!stopped) {
        stopped = true
        process.off('unhandledRejection', onRejection)
      }
      return reasons.slice()
    },
  }
}

async function fillEco(version: 'unset' | 'none' | string): Promise<void> {
  click('plm-collaboration-snapshots-toggle')
  await flush()
  click('kind-eco')
  click('base-list')
  await flush()
  const bases = [...(container?.querySelectorAll('[data-testid="base-option"]') ?? [])]
  expect(bases).toHaveLength(2)
  expect(container?.textContent).not.toContain('已选数据表库')
  ;(bases[1] as HTMLButtonElement).click()
  await flush()
  setField('name', '协作表', 'change')
  setField('eco', 'eco-1', 'change')
  if (version === 'none') click('version-none')
  else if (version !== 'unset') {
    setField('version-input', version, 'input')
    click('version-use')
  }
  await flush()
}

beforeEach(() => {
  calls.length = 0
  resolvers.length = 0
  responder = () => jsonResponse({ ok: true, data: {} })
  installFetch()
  installLocks()
  installSessionStorage()
  localStorage.clear()
  sessionStorage.clear()
  capabilitiesMock.mockResolvedValue({ data_source_id: '', available: false, reason: 'unavailable' })
  getContextMock.mockResolvedValue({ data_source_id: '', available: false, reason: 'unavailable' })
  updateLineMock.mockResolvedValue({ ok: false, status: 500 })
  ecoIntentMock.mockResolvedValue({ ok: false, status: 500 })
  listBindingsMock.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('collaboration snapshot navigation hint passthrough', () => {
  it('keeps a finite hint on list and context sheets and leaves an unmarked sheet unmarked', async () => {
    const hint = { bindingId: BINDING_ID, sourceKind: 'eco' as const }
    const sheets = [
      { id: 'sheet-1', name: '有提示', plmCollaborationSnapshot: hint },
      { id: 'sheet-2', name: '无提示' },
    ]
    const fetchFn = async (input: string) => jsonResponse(input.includes('/context')
      ? { ok: true, data: { sheets, sheet: sheets[0], businessTimezone: 'Asia/Shanghai', views: [] } }
      : { ok: true, data: { sheets } })
    const client = new MultitableApiClient({ fetchFn })
    const listed = await client.listSheets()
    const context = await client.loadContext({ baseId: 'base-2' })
    expect(listed.sheets[0]?.plmCollaborationSnapshot).toEqual(hint)
    expect(listed.sheets[1]?.plmCollaborationSnapshot).toBeUndefined()
    expect(context.sheets[0]?.plmCollaborationSnapshot).toEqual(hint)
    expect(context.sheet?.plmCollaborationSnapshot).toEqual(hint)
    expect(context.sheets[1]?.plmCollaborationSnapshot).toBeUndefined()
  })

  it('ignores malformed and extra-key hints', () => {
    expect(readPlmCollaborationSnapshotHint(null)).toBeNull()
    expect(readPlmCollaborationSnapshotHint({ bindingId: 'not-a-uuid', sourceKind: 'eco' })).toBeNull()
    expect(readPlmCollaborationSnapshotHint({ bindingId: BINDING_ID, sourceKind: 'cad' })).toBeNull()
    expect(readPlmCollaborationSnapshotHint({ bindingId: BINDING_ID, sourceKind: 'eco', ownerId: 'x' })).toBeNull()
    expect(readPlmCollaborationSnapshotHint({ bindingId: BINDING_ID, sourceKind: 'readiness' })).toEqual({
      bindingId: BINDING_ID,
      sourceKind: 'readiness',
    })
  })
})

describe('BOM host collaboration entry', () => {
  it('stays absent without a source and collapsed without a snapshot fetch', async () => {
    await mountHost()
    expect(container?.querySelector('[data-testid="plm-collaboration-snapshots-panel"]')).toBeNull()
    cleanup()
    await mountHost({ dataSourceId: 'src-a' })
    const toggle = container?.querySelector('[data-testid="plm-collaboration-snapshots-toggle"]')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(container?.querySelector('select')).toBeNull()
    expect(snapshotCalls()).toEqual([])
    toggle?.dispatchEvent(new MouseEvent('click'))
    await flush()
    expect(snapshotCalls()).toEqual([])
    expect(container?.querySelector('select')).toBeNull()
  })
})

describe('PlmCollaborationSnapshotsPanel', () => {
  it('does not show an open action for an extra-key hint', async () => {
    localStorage.setItem('auth_token', TOKEN)
    await mountPanel({ hint: { bindingId: BINDING_ID, sourceKind: 'eco', extra: true } })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    expect(container?.querySelector('[data-testid="hint-open"]')).toBeNull()
    expect(snapshotCalls()).toEqual([])
  })

  it('sends a fixed nullable version only after an explicit choice', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = () => jsonResponse(previewPayload(null))
    await mountPanel()
    await fillEco('unset')
    click('preview')
    await flush()
    expect(snapshotCalls()).toEqual([])
    setField('version-input', '   ', 'input')
    click('version-use')
    click('preview')
    await flush()
    expect(snapshotCalls()).toEqual([])
    click('version-none')
    await flush()
    click('preview')
    await flush()
    expect(bodyOf(snapshotCalls().at(-1)).currentVersionId).toBeNull()
    expect(Object.keys(bodyOf(snapshotCalls().at(-1))).sort()).toEqual(
      ['baseId', 'currentVersionId', 'dataSourceId', 'ecoId', 'itemId', 'name', 'sourceKind'],
    )
    setField('version-input', 'ver-distinct', 'input')
    click('version-use')
    await flush()
    click('preview')
    await flush()
    expect(bodyOf(snapshotCalls().at(-1)).currentVersionId).toBe('ver-distinct')
    expect(bodyOf(snapshotCalls().at(-1)).baseId).toBe('base-2')
  })

  it('does not default or retarget either ruleset control', async () => {
    localStorage.setItem('auth_token', TOKEN)
    const fields: MetaField[] = [
      { id: 'visible-rule', name: 'ruleset_id', type: 'string' },
      { id: 'hidden-rule', name: 'ruleset_id', type: 'string' },
    ]
    const rows: MetaRecord[] = [
      { id: 'r1', version: 1, data: { 'visible-rule': 'rule-a', 'hidden-rule': 'rule-hidden' } },
      { id: 'r2', version: 1, data: { 'visible-rule': 'rule-b' } },
    ]
    const state = await mountPanel({
      fields: [fields[0]!],
      rows,
      hint: { bindingId: READY_ID, sourceKind: 'readiness' },
    })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('kind-readiness')
    await flush()
    expect(panel().getAttribute('data-ruleset')).toBe('')
    const options = [...(container?.querySelectorAll('[data-testid="ruleset-option"]') ?? [])]
    expect(options.map((item) => item.getAttribute('data-ruleset-id'))).toEqual(['rule-a', 'rule-b'])
    ;(options[1] as HTMLButtonElement).click()
    await flush()
    expect(panel().getAttribute('data-ruleset')).toBe('rule-b')
    state.rows = [{ id: 'r3', version: 1, data: { 'visible-rule': 'rule-a' } }]
    state.fields = [{ id: 'visible-rule', name: 'ruleset_id', type: 'string' }]
    await flush()
    expect(panel().getAttribute('data-ruleset')).toBe('rule-b')
    setField('ruleset-draft', 'rule-c', 'input')
    await flush()
    expect(panel().getAttribute('data-ruleset')).toBe('rule-b')
    click('ruleset-commit')
    await flush()
    expect(panel().getAttribute('data-ruleset')).toBe('rule-c')
    expect(container?.textContent).not.toContain('rule-hidden')
  })

  it('keeps one confirm body across a lost response, a conflict, and a reload', async () => {
    localStorage.setItem('auth_token', TOKEN)
    let previewCount = 0
    responder = (url, init) => {
      if (url.endsWith('/preview')) {
        previewCount += 1
        return jsonResponse(previewPayload(null))
      }
      if (url.endsWith('/confirm') && init?.method === 'POST') return Promise.reject(new Error('network down'))
      return jsonResponse({ ok: true, data: {} })
    }
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    click('confirm')
    await flush()
    const stored = sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY) ?? ''
    expect(stored).not.toContain(TOKEN)
    const first = JSON.parse(stored) as { body: { requestId: string; expectedVersion: number; targetBindingId?: string } }
    expect(first.body.expectedVersion).toBe(0)
    expect(first.body.targetBindingId).toBeUndefined()
    expect(container?.textContent).toContain('结果未知。同一次确认仍保留，需要明确重试。')
    click('retry')
    await flush()
    const confirmBodies = snapshotCalls().filter((call) => call.url.endsWith('/confirm')).map((call) => bodyOf(call))
    expect(confirmBodies).toHaveLength(2)
    expect(confirmBodies[1]).toEqual(confirmBodies[0])
    expect(previewCount).toBe(1)

    responder = (url) => jsonResponse(
      url.endsWith('/confirm') ? { ok: false, error: { code: 'VERSION_CONFLICT' } } : previewPayload(null),
      url.endsWith('/confirm') ? 409 : 200,
    )
    click('retry')
    await flush()
    expect(container?.textContent).toContain('未解决的冲突。不会把这次确认当成成功，也不会自动换一个版本号。')
    const afterConflict = snapshotCalls().filter((call) => call.url.endsWith('/confirm')).map((call) => bodyOf(call))
    expect(afterConflict.at(-1)?.requestId).toBe(first.body.requestId)
    expect(previewCount).toBe(1)
    expect(router?.currentRoute.value.name).not.toBe('multitable')

    const saved = sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
    cleanup()
    calls.length = 0
    sessionStorage.setItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY, saved ?? '')
    await mountPanel()
    await flush()
    expect(snapshotCalls().filter((call) => call.url.endsWith('/confirm'))).toEqual([])
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('retry')
    await flush()
    expect(bodyOf(snapshotCalls().find((call) => call.url.endsWith('/confirm')))).toEqual(first.body)
  })

  it('blocks a new mutation when confirm storage fails, the digest differs, or the record is malformed', async () => {
    localStorage.setItem('auth_token', TOKEN)
    let storedAtPost: string | null = null
    responder = (url) => {
      if (url.endsWith('/confirm')) storedAtPost = sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
      if (url.endsWith('/preview')) return jsonResponse(previewPayload(null))
      return jsonResponse(publishedPayload())
    }
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    const originalSet = sessionStorage.setItem.bind(sessionStorage)
    sessionStorage.setItem = () => { throw new Error('storage full') }
    click('confirm')
    await flush()
    expect(snapshotCalls().some((call) => call.url.endsWith('/confirm'))).toBe(false)
    expect(container?.textContent).toContain('无法记下这次确认，因此没有提交。')
    sessionStorage.setItem = originalSet
    click('confirm')
    await flush()
    const sent = snapshotCalls().filter((call) => call.url.endsWith('/confirm')).map((call) => bodyOf(call))
    expect(sent).toHaveLength(1)
    expect(typeof sent[0]?.requestId).toBe('string')

    const record = JSON.parse(storedAtPost ?? 'null') as { digest?: string } | null
    expect(record?.digest).toMatch(/^[0-9a-f]{64}$/)
    cleanup()
    record!.digest = '0'.repeat(64)
    sessionStorage.setItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY, JSON.stringify(record))
    calls.length = 0
    await mountPanel()
    await flush()
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('preview')
    await flush()
    expect(snapshotCalls()).toEqual([])
    expect(container?.textContent).toContain('结果未知')
    click('abandon')
    await flush()
    expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBeNull()

    sessionStorage.setItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY, '{')
    cleanup()
    calls.length = 0
    await mountPanel()
    await flush()
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('kind-eco')
    click('preview')
    await flush()
    expect(snapshotCalls()).toEqual([])
    const originalGet = sessionStorage.getItem.bind(sessionStorage)
    sessionStorage.getItem = () => { throw new Error('storage blocked') }
    click('confirm')
    await flush()
    expect(snapshotCalls()).toEqual([])
    sessionStorage.getItem = originalGet
  })

  it('drops a late preview after the item or the session changes', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = () => new Promise<Response>((resolve) => { resolvers.push(resolve) })
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    expect(calls.length).toBe(1)
    setField('item', 'item-2', 'change')
    await flush()
    resolvers.shift()?.(jsonResponse(previewPayload(null)))
    await flush()
    expect(container?.querySelector('[data-testid="anchor"]')).toBeNull()
    expect(panel().getAttribute('data-busy')).toBe('no')

    click('preview')
    await flush()
    expect(panel().getAttribute('data-busy')).toBe('yes')
    setField('item', 'item-3', 'change')
    click('preview')
    await flush()
    resolvers.shift()?.(jsonResponse(previewPayload(null)))
    await flush()
    expect(panel().getAttribute('data-busy')).toBe('yes')
    expect(container?.querySelector('[data-testid="anchor"]')).toBeNull()
    resolvers.shift()?.(jsonResponse(previewPayload(null)))
    await flush()
    expect(container?.querySelector('[data-testid="anchor"]')?.textContent).toContain('item-1')
    expect(panel().getAttribute('data-busy')).toBe('no')

    responder = () => new Promise<Response>((resolve) => { resolvers.push(resolve) })
    setField('item', 'item-4', 'change')
    click('preview')
    await flush()
    localStorage.setItem('auth_token', 'bearer-secret-other')
    notifyAuthPrincipalChange()
    await Promise.resolve()
    await flush()
    const pendingKey = sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
    resolvers.shift()?.(jsonResponse(previewPayload(null)))
    await flush()
    expect(container?.querySelector('[data-testid="anchor"]')).toBeNull()
    expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBe(pendingKey)
    expect(snapshotCalls().filter((call) => call.url.endsWith('/confirm'))).toEqual([])
  })

  it('refuses a managed entry and allows an ordinary bearer', async () => {
    localStorage.setItem('auth_token', TOKEN)
    localStorage.setItem('metasheet_managed_probe', '1')
    await mountPanel()
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('base-list')
    await flush()
    expect(container?.querySelector('[data-testid="base-option"]')).toBeNull()
    click('preview')
    await flush()
    expect(snapshotCalls()).toEqual([])
    expect(container?.textContent).toContain('当前是托管入口。协作快照只使用普通 Meta 登录，不会改用托管 cookie。')
    cleanup()
    localStorage.removeItem('metasheet_managed_probe')
    calls.length = 0
    responder = () => jsonResponse(previewPayload(null))
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    expect(snapshotCalls().some((call) => call.url.endsWith('/preview'))).toBe(true)
  })

  it('opens the canonical sheet after confirm and does not write source-local fields', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = (url) => {
      if (url.endsWith('/preview')) return jsonResponse(previewPayload(null, '<img src=x onerror=alert(1)>'))
      if (url.endsWith('/confirm')) return jsonResponse(publishedPayload())
      return jsonResponse({ ok: false, error: { code: 'NOT_FOUND' } }, 404)
    }
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    expect(container?.querySelector('img')).toBeNull()
    expect(container?.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container?.querySelector('[data-testid="coverage"]')).toBeNull()
    click('confirm')
    await flush()
    expect(router?.currentRoute.value.name).toBe('multitable')
    expect(router?.currentRoute.value.params).toMatchObject({ sheetId: 'sheet-1', viewId: 'view-1' })
    expect(router?.currentRoute.value.query).toMatchObject({ baseId: 'base-2', recordId: 'record-1' })
    const serialized = JSON.stringify(snapshotCalls().map((call) => ({ url: call.url, body: call.init?.body ?? null })))
    for (const field of LOCAL_FIELDS) expect(serialized).not.toContain(field)
    expect(serialized).not.toContain('/records')
    expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBeNull()
  })

  it('shows a server coverage status exactly and does not invent one', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = () => jsonResponse({
      ok: true,
      data: {
        previewId: PREVIEW_ID,
        expiresAt: '2026-10-24T00:00:00.000Z',
        businessHash: 'hash',
        capturedAt: '2026-10-24T00:00:00.000Z',
        rowKey: ['src-a', 'tenant', 'org', 'item-1', 'rule-a'],
        baseId: 'base-2',
        name: '协作表',
        anchor: {
          dataSourceId: 'src-a',
          tenantId: 'tenant',
          orgId: 'org',
          itemId: 'item-1',
          currentVersionId: null,
          rulesetId: 'rule-a',
        },
        readiness: {
          item_id: 'item-1',
          coverage_status: 'bounded_not_proven_complete',
        },
      },
    })
    await mountPanel()
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('kind-readiness')
    click('base-list')
    await flush()
    const bases = [...(container?.querySelectorAll('[data-testid="base-option"]') ?? [])]
    ;(bases[1] as HTMLButtonElement).click()
    await flush()
    setField('name', '协作表', 'change')
    setField('ruleset-draft', 'rule-a', 'input')
    click('ruleset-commit')
    click('version-none')
    await flush()
    click('preview')
    await flush()
    expect(container?.querySelector('[data-testid="coverage"]')?.textContent).toBe('bounded_not_proven_complete')
    expect(container?.querySelector('img')).toBeNull()
  })

  it('refreshes only a visible row key and selects a readiness row without sourceKind', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = (url, init) => {
      if (url.endsWith('/refresh')) return jsonResponse(publishedPayload())
      if (url.includes(READY_ID)) return jsonResponse(loadedPayload('readiness'))
      return jsonResponse(loadedPayload('eco'))
    }
    await mountPanel({ hint: { bindingId: BINDING_ID, sourceKind: 'eco' } })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await flush()
    const opened = snapshotCalls().at(-1)
    expect(opened?.url).toContain(`/api/plm-collaboration-snapshots/${BINDING_ID}`)
    expect(opened?.url).not.toContain('sourceKind')
    expect(opened?.url).not.toContain('rowKey')
    const refresh = container?.querySelector('[data-testid="refresh"]')
    expect(refresh).toBeInstanceOf(HTMLButtonElement)
    expect((refresh as HTMLButtonElement).disabled).toBe(false)
    click('refresh')
    await flush()
    expect(bodyOf(snapshotCalls().find((call) => call.url.endsWith('/refresh')))).toEqual({
      expectedVersion: 4,
      rowKey: ['src-a', 'tenant', 'org', 'eco-9'],
    })
    expect(router?.currentRoute.value.name).toBe('multitable')

    cleanup()
    calls.length = 0
    await mountPanel({
      hint: { bindingId: READY_ID, sourceKind: 'readiness' },
      fields: [{ id: 'visible-rule', name: 'ruleset_id', type: 'string' }],
      rows: [{ id: 'r1', version: 1, data: { 'visible-rule': 'rule-a' } }],
    })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await flush()
    expect(container?.textContent).toContain('没有选中的行')
    expect(container?.textContent).toContain('不能刷新')
    expect((container?.querySelector('[data-testid="refresh"]') as HTMLButtonElement).disabled).toBe(true)
    click('ruleset-option')
    await flush()
    const selected = snapshotCalls().at(-1)
    const parsed = new URL(selected?.url ?? '/', 'http://localhost')
    expect([...parsed.searchParams.keys()]).toEqual(['rowKey'])
    expect(JSON.parse(parsed.searchParams.get('rowKey') ?? 'null')).toEqual(['src-a', 'tenant', 'org', 'item-1', 'rule-a'])
    expect(selected?.url).not.toContain('sourceKind')
  })

  it('completes a same-principal confirm with the real digest and the captured bearer', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = (url) => {
      if (url.endsWith('/preview')) return jsonResponse(previewPayload(null))
      if (url.endsWith('/confirm')) return jsonResponse(publishedPayload())
      return jsonResponse(loadedPayload('eco'))
    }
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    await panelVm!.confirm()
    const confirm = snapshotCalls().filter((call) => call.url.endsWith('/confirm'))
    expect(confirm).toHaveLength(1)
    expect(bodyOf(confirm[0]).previewId).toBe(PREVIEW_ID)
    expect(new Headers(confirm[0]?.init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('does not submit an A preview under a B bearer after the real digest await', async () => {
    localStorage.setItem('auth_token', 'root-meta-principal-A')
    responder = (url) => {
      if (url.endsWith('/preview')) return jsonResponse(previewPayload(null))
      if (url.endsWith('/confirm')) return jsonResponse(publishedPayload())
      return jsonResponse(loadedPayload('eco'))
    }
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    const gate = gateNextRealDigest()
    const operation = panelVm!.confirm()
    await gate.entered
    localStorage.setItem('auth_token', 'root-meta-principal-B')
    notifyAuthPrincipalChange()
    await nextTick()
    await Promise.resolve()
    gate.release()
    await operation
    gate.restore()
    expect(snapshotCalls().filter((call) => call.url.endsWith('/confirm'))).toEqual([])
    expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBeNull()
  })

  it('does not submit old Item A after the parent Item changes during the real digest await', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = (url) => {
      if (url.endsWith('/preview')) return jsonResponse(previewPayload(null))
      if (url.endsWith('/confirm')) return jsonResponse(publishedPayload())
      return jsonResponse(loadedPayload('eco'))
    }
    const state = await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    const gate = gateNextRealDigest()
    const operation = panelVm!.confirm()
    await gate.entered
    state.itemId = 'item-2'
    await nextTick()
    gate.release()
    await operation
    gate.restore()
    expect(snapshotCalls().filter((call) => call.url.endsWith('/confirm'))).toEqual([])
    expect((container?.querySelector('[data-testid="item"]') as HTMLInputElement).value).toBe('item-2')
    expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBeNull()
  })

  it('refreshes the loaded row, then does not refresh it after the parent Item, Source, or hint changes', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = (url) => url.endsWith('/refresh') ? jsonResponse(publishedPayload()) : jsonResponse(loadedPayload('eco'))
    const state = await mountPanel({
      hint: { bindingId: BINDING_ID, sourceKind: 'eco' },
      fields: [{ id: VISIBLE_FIELD_ID, name: 'name', type: 'string' }],
    })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await flush()
    expect((container?.querySelector('[data-testid="refresh"]') as HTMLButtonElement).disabled).toBe(false)
    expect(panel().getAttribute('data-version-choice')).toBe('id')
    await panelVm!.refresh()
    expect(snapshotCalls().filter((call) => call.url.endsWith('/refresh'))).toHaveLength(1)
    cleanup()
    calls.length = 0
    const switched = await mountPanel({ hint: { bindingId: BINDING_ID, sourceKind: 'eco' } })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await flush()
    switched.itemId = 'item-2'
    await nextTick()
    expect(panel().getAttribute('data-version-choice')).toBe('id')
    expect((container?.querySelector('[data-testid="refresh"]') as HTMLButtonElement).disabled).toBe(true)
    expect((container?.querySelector('[data-testid="disable"]') as HTMLButtonElement).disabled).toBe(true)
    await panelVm!.refresh()
    expect(snapshotCalls().filter((call) => call.url.endsWith('/refresh'))).toEqual([])
    switched.itemId = 'item-1'
    await nextTick()
    switched.dataSourceId = 'src-b'
    await nextTick()
    await panelVm!.refresh()
    expect(snapshotCalls().filter((call) => call.url.endsWith('/refresh'))).toEqual([])
    switched.dataSourceId = 'src-a'
    await nextTick()
    switched.hint = { bindingId: READY_ID, sourceKind: 'readiness' }
    await nextTick()
    await panelVm!.refresh()
    expect(snapshotCalls().filter((call) => call.url.endsWith('/refresh'))).toEqual([])
    expect(state.itemId).toBe('item-1')
  })

  it('keeps an incompatible pending record opaque when the parent Item differs', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = (url) => {
      if (url.endsWith('/preview')) return jsonResponse(previewPayload(null))
      if (url.endsWith('/confirm')) throw new TypeError('controlled response loss')
      return jsonResponse(loadedPayload('eco'))
    }
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    await panelVm!.confirm()
    const saved = sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
    expect(saved).not.toBeNull()
    cleanup()
    calls.length = 0
    await mountPanel({ dataSourceId: 'src-a', itemId: 'item-2' })
    click('plm-collaboration-snapshots-toggle')
    await vi.waitFor(() => expect(container?.querySelector('[data-testid="pending"]')).not.toBeNull())
    expect((container?.querySelector('[data-testid="item"]') as HTMLInputElement).value).toBe('item-2')
    expect((container?.querySelector('[data-testid="name"]') as HTMLInputElement).value).toBe('')
    expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBe(saved)
    expect(snapshotCalls().filter((call) => call.url.endsWith('/confirm'))).toEqual([])
  })

  it('does not hydrate a restore that started under A after the session becomes B', async () => {
    localStorage.setItem('auth_token', 'root-meta-principal-A')
    responder = (url) => {
      if (url.endsWith('/preview')) return jsonResponse(previewPayload(null))
      if (url.endsWith('/confirm')) throw new TypeError('controlled response loss')
      return jsonResponse(loadedPayload('eco'))
    }
    await mountPanel()
    await fillEco('none')
    click('preview')
    await flush()
    await panelVm!.confirm()
    const saved = sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)
    expect(saved).not.toBeNull()
    cleanup()
    calls.length = 0
    const gate = gateNextRealDigest()
    const mounted = mountPanel({ itemId: 'item-1' })
    await gate.entered
    localStorage.setItem('auth_token', 'root-meta-principal-B')
    notifyAuthPrincipalChange()
    await nextTick()
    await Promise.resolve()
    gate.release()
    await mounted
    click('plm-collaboration-snapshots-toggle')
    await flush()
    expect((container?.querySelector('[data-testid="name"]') as HTMLInputElement).value).toBe('')
    expect((container?.querySelector('[data-testid="source"]') as HTMLInputElement).value).toBe('src-a')
    expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBe(saved)
    expect(container?.textContent).not.toContain('协作表')
  })

  it('renders whitelisted UUID cells and leaves hidden and unknown cells absent', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = () => jsonResponse(loadedPayload('eco', {
      row: {
        recordId: 'record-9',
        rowKey: ['src-a', 'tenant', 'org', 'eco-9'],
        cells: {
          [VISIBLE_FIELD_ID]: 'ROOT_VISIBLE_SOURCE_A<img src=x onerror=alert(1)>',
          [HIDDEN_FIELD_ID]: 'HIDDEN_LOCAL_OWNER',
          name: 'NAME_KEY_NOT_A_FIELD',
          leaked: 'RAW_UNKNOWN_CELL',
        },
      },
    }))
    await mountPanel({
      hint: { bindingId: BINDING_ID, sourceKind: 'eco' },
      fields: [
        { id: VISIBLE_FIELD_ID, name: 'name', type: 'string' },
        { id: HIDDEN_FIELD_ID, name: 'collaboration_owner', type: 'string' },
      ],
    })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await vi.waitFor(() => expect(container?.querySelector('[data-testid="open-sheet"]')).not.toBeNull())
    expect(container?.textContent).toContain('ROOT_VISIBLE_SOURCE_A<img src=x onerror=alert(1)>')
    expect(container?.querySelector('img')).toBeNull()
    expect(container?.textContent).not.toContain('HIDDEN_LOCAL_OWNER')
    expect(container?.textContent).not.toContain('NAME_KEY_NOT_A_FIELD')
    expect(container?.textContent).not.toContain('RAW_UNKNOWN_CELL')
    cleanup()
    calls.length = 0
    await mountPanel({ hint: { bindingId: BINDING_ID, sourceKind: 'eco' } })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await flush()
    expect(container?.textContent).not.toContain('ROOT_VISIBLE_SOURCE_A')
  })

  it('does not resurrect an A pending anchor after B finishes storage inspection while A is still held', async () => {
    const raw = await lostPrincipalConfirm()
    cleanup()
    calls.length = 0
    const gate = gateNextRealDigest()
    const unhandled = trackUnhandled()
    try {
      const mounting = mountPanel()
      await gate.entered
      localStorage.setItem('auth_token', 'root-meta-principal-B')
      notifyAuthPrincipalChange()
      await flush()
      gate.release()
      await mounting
      await flush()
      click('plm-collaboration-snapshots-toggle')
      await flush()
      expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBe(raw)
      expect(container?.querySelector('[data-testid="anchor"]')).toBeNull()
      expect(container?.querySelector('[data-testid="retry"]')).toBeNull()
      expect(unhandled.stop()).toEqual([])
    } finally {
      gate.restore()
      unhandled.stop()
    }
  })

  it('clears the rendered A pending anchor while B storage inspection is still held', async () => {
    const raw = await lostPrincipalConfirm()
    expect(container?.querySelector('[data-testid="anchor"]')).not.toBeNull()
    const gate = gateNextRealDigest()
    const unhandled = trackUnhandled()
    try {
      localStorage.setItem('auth_token', 'root-meta-principal-B')
      notifyAuthPrincipalChange()
      await gate.entered
      await nextTick()
      const oldAnchorVisible = container?.querySelector('[data-testid="anchor"]') != null
      const oldRetryVisible = container?.querySelector('[data-testid="retry"]') != null
      gate.release()
      await flush()
      expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBe(raw)
      expect(oldAnchorVisible).toBe(false)
      expect(oldRetryVisible).toBe(false)
      expect(unhandled.stop()).toEqual([])
    } finally {
      gate.restore()
      unhandled.stop()
    }
  })

  it('resolves loaded refresh without rejection or POST when the principal changes before the storage await returns', async () => {
    localStorage.setItem('auth_token', 'root-meta-principal-A')
    responder = () => jsonResponse(loadedPayload('eco'))
    await mountPanel({ hint: { bindingId: BINDING_ID, sourceKind: 'eco' } })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await vi.waitFor(() => expect(container?.querySelector('[data-testid="refresh"]')?.hasAttribute('disabled')).toBe(false))
    const unhandled = trackUnhandled()
    try {
      const operation = panelVm!.refresh()
      localStorage.setItem('auth_token', 'root-meta-principal-B')
      notifyAuthPrincipalChange()
      await expect(operation).resolves.toBeUndefined()
      await flush()
      expect(snapshotCalls().filter((call) => call.url.endsWith('/refresh'))).toEqual([])
      expect(unhandled.stop()).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('does not post or replace a newer unknown record that lands during the retry storage digest', async () => {
    const raw = await lostPrincipalConfirm()
    const original = JSON.parse(raw) as { body: { requestId: string; previewId: string } }
    const replacement = replacementPending(raw)
    calls.length = 0
    responder = (url) => url.endsWith('/confirm') ? jsonResponse(publishedPayload()) : jsonResponse(loadedPayload('eco'))
    const gate = gateNextRealDigest()
    const unhandled = trackUnhandled()
    try {
      const operation = panelVm!.confirm()
      await gate.entered
      sessionStorage.setItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY, replacement)
      gate.release()
      await operation
      const posts = snapshotCalls().filter((call) => call.url.endsWith('/confirm'))
      expect(posts).toEqual([])
      expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBe(replacement)
      expect(replacement).not.toContain(original.body.requestId)
      expect(unhandled.stop()).toEqual([])
    } finally {
      gate.restore()
      unhandled.stop()
    }
  })

  it('does not clear a newer unknown record when an earlier retry acknowledgement arrives', async () => {
    const raw = await lostPrincipalConfirm()
    const original = JSON.parse(raw) as { body: { requestId: string; previewId: string } }
    const replacement = replacementPending(raw)
    calls.length = 0
    let respond!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { respond = resolve })
    responder = (url) => url.endsWith('/confirm') ? response : jsonResponse(loadedPayload('eco'))
    const unhandled = trackUnhandled()
    try {
      const operation = panelVm!.confirm()
      await vi.waitFor(() => expect(snapshotCalls().filter((call) => call.url.endsWith('/confirm'))).toHaveLength(1))
      sessionStorage.setItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY, replacement)
      respond(jsonResponse(publishedPayload()))
      await operation
      const posts = snapshotCalls().filter((call) => call.url.endsWith('/confirm'))
      expect(posts).toHaveLength(1)
      expect(bodyOf(posts[0]).requestId).toBe(original.body.requestId)
      expect(bodyOf(posts[0]).previewId).toBe(original.body.previewId)
      expect(sessionStorage.getItem(PLM_COLLABORATION_CONFIRM_STORAGE_KEY)).toBe(replacement)
      expect(unhandled.stop()).toEqual([])
    } finally {
      unhandled.stop()
    }
  })

  it('opens an authorized binding from the hint-only Workbench call when outer Source and Item are absent', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = () => jsonResponse(loadedPayload('eco'))
    await mountPanel({
      dataSourceId: '',
      itemId: '',
      hint: { bindingId: BINDING_ID, sourceKind: 'eco' },
      rows: [],
      fields: [],
    })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await vi.waitFor(() => expect(snapshotCalls()).toHaveLength(1))
    await flush()
    const opened = snapshotCalls()[0]
    expect(new URL(opened?.url ?? '/', 'http://localhost').pathname).toBe(`/api/plm-collaboration-snapshots/${BINDING_ID}`)
    expect(opened?.url).not.toContain('sourceKind')
    expect(opened?.url).not.toContain('rowKey')
    expect(container?.querySelector('[data-testid="open-sheet"]')).not.toBeNull()
    expect((container?.querySelector('[data-testid="source"]') as HTMLInputElement).value).toBe('src-a')
    expect((container?.querySelector('[data-testid="item"]') as HTMLInputElement).value).toBe('item-1')
    expect(panel().getAttribute('data-version-choice')).toBe('id')
    expect(container?.querySelector('[data-testid="error"]')).toBeNull()
  })

  it('refuses a provided parent Source or Item that disagrees with the authorized binding anchor', async () => {
    localStorage.setItem('auth_token', TOKEN)
    responder = () => jsonResponse(loadedPayload('eco'))
    await mountPanel({
      dataSourceId: 'src-b',
      itemId: 'item-2',
      hint: { bindingId: BINDING_ID, sourceKind: 'eco' },
      rows: [{ id: 'r1', version: 1, data: { 'visible-rule': 'src-a' } }],
      fields: [{ id: 'visible-rule', name: 'data_source_id', type: 'string' }],
    })
    click('plm-collaboration-snapshots-toggle')
    await flush()
    click('hint-open')
    await vi.waitFor(() => expect(snapshotCalls()).toHaveLength(1))
    await flush()
    expect(new URL(snapshotCalls()[0]?.url ?? '/', 'http://localhost').pathname).toBe(`/api/plm-collaboration-snapshots/${BINDING_ID}`)
    expect(container?.querySelector('[data-testid="open-sheet"]')).toBeNull()
    expect((container?.querySelector('[data-testid="source"]') as HTMLInputElement).value).toBe('src-b')
    expect((container?.querySelector('[data-testid="item"]') as HTMLInputElement).value).toBe('item-2')
    expect(panel().getAttribute('data-version-choice')).toBe('unset')
    expect(container?.querySelector('[data-testid="error"]')?.textContent).toBe('ECO_REQUEST_INVALID')
  })
})
