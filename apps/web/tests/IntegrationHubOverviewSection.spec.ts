import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'

// 对接总览 — the FIRST section of the 数据工厂 workbench.
//
// What this spec pins:
//   1. the card answers the four questions the screen exists for (名称/kind、连接、在用、状态);
//   2. the five connection states each render their own sentence, and a connection someone else
//      owns is reported as 已配置(他人管理) rather than named or blanked;
//   3. the K3 fence sentence 只读·永不写入 is rendered verbatim from the SERVER's notice;
//   4. the buttons are NAVIGATION — they emit, and this component never calls a mutating endpoint;
//   5. the SENTINEL: a backend that regressed and sent a connection string / host / error text
//      must not have it rendered. (The backend refuses to send it; this asserts the front end is
//      not a second place where it could appear.)

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationHubOverviewSection from '../src/components/integration/IntegrationHubOverviewSection.vue'

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
}

const ElCard = defineComponent({
  name: 'ElCard',
  props: { shadow: { type: String, required: false, default: undefined } },
  setup(_props, { slots }) {
    return () => h('div', { class: 'el-card' }, [
      slots.header ? h('div', { class: 'el-card__header' }, slots.header()) : null,
      h('div', { class: 'el-card__body' }, slots.default?.()),
    ])
  },
})

const OVERVIEW_URL = '/api/integration/hub/overview?tenantId=default'

function bilingual(zh: string, en: string) {
  return { zh, en }
}

function hubSystem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sys_1',
    name: 'PLM 只读桥',
    kind: 'data-source:sql-readonly',
    kindLabel: bilingual('只读数据库桥接', 'Read-only database bridge'),
    kindRegistered: true,
    role: 'source',
    status: 'active',
    lastTestedAt: '2026-08-30T02:00:00.000Z',
    hasLastError: false,
    connection: {
      model: 'data-source',
      bound: true,
      dataSourceId: 'ds_plm',
      resolved: true,
      name: 'PLM 生产库(只读)',
      type: 'sqlserver',
      status: 'connected',
      unresolvedReason: null,
    },
    writeCapability: {
      reads: 'real',
      writes: 'none',
      fenced: false,
      notice: bilingual('只读', 'Read-only'),
    },
    consumers: [],
    technical: {
      systemId: 'sys_1',
      kind: 'data-source:sql-readonly',
      role: 'source',
      status: 'active',
      dataSourceId: 'ds_plm',
      workspaceId: null,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-30T02:00:00.000Z',
    },
    ...overrides,
  }
}

function overviewPayload(systems: unknown[], directoryAvailable = true) {
  return { systemCount: systems.length, systems, dataSourceDirectory: { available: directoryAvailable } }
}

describe('IntegrationHubOverviewSection (对接总览)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  const emitted: Array<[string, unknown]> = []

  beforeEach(() => {
    apiFetchMock.mockReset()
    emitted.length = 0
    if (typeof localStorage?.clear === 'function') localStorage.clear()
    // `useLocale`'s state is a MODULE-level ref seeded once at import, so writing localStorage here
    // would be too late — go through the setter, as the app itself does.
    useLocale().setLocale('zh-CN')
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  async function mount(): Promise<HTMLDivElement> {
    container = document.createElement('div')
    document.body.appendChild(container)
    const Host = defineComponent({
      setup() {
        return () => h(IntegrationHubOverviewSection as unknown as Component, {
          scope: { tenantId: 'default', workspaceId: null },
          onOpenConnection: (systemId: string) => emitted.push(['open-connection', systemId]),
          onOpenConnections: () => emitted.push(['open-connections', undefined]),
        })
      },
    })
    app = createApp(Host)
    app.component('ElCard', ElCard)
    app.mount(container)
    await flushUi()
    return container
  }

  it('renders one card per system answering 名称 / kind / 连接 / 在用 / 状态', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === OVERVIEW_URL) {
        return jsonResponse(overviewPayload([
          hubSystem({
            consumers: [
              { type: 'table-action', id: 'plm.stock-preparation.pull-bom.v1', name: null, label: bilingual('BOM备料·同步', 'BOM stock-prep · sync'), role: 'source', count: 1 },
              { type: 'pipeline', id: 'pipe_1', name: '物料同步', label: bilingual('流程(源)', 'Pipeline (source)'), role: 'source', count: 1 },
              { type: 'read-source-config', id: null, name: null, label: bilingual('已审批读取源', 'Approved read sources'), role: 'source', count: 3 },
            ],
          }),
        ]))
      }
      throw new Error(`unexpected URL ${url}`)
    })
    const root = await mount()

    expect(root.querySelector('[data-testid="hub-overview-card-sys_1"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="hub-overview-name-sys_1"]')?.textContent).toBe('PLM 只读桥')
    expect(root.querySelector('[data-testid="hub-overview-kind-sys_1"]')?.textContent).toContain('只读数据库桥接')
    // 连接: the operator-authored data source name, joined server-side, with its type.
    expect(root.querySelector('[data-testid="hub-overview-connection-sys_1"]')?.textContent)
      .toBe('PLM 生产库(只读) · sqlserver')
    // 在用: the 备料 action named in plain words, plus the pipeline by its own name and a count.
    const consumers = root.querySelector('[data-testid="hub-overview-consumers-sys_1"]')?.textContent ?? ''
    expect(consumers).toContain('BOM备料·同步')
    expect(consumers).toContain('流程(源):物料同步')
    expect(consumers).toContain('已审批读取源 ×3')
    // 状态: a dot carrying the state plus the last-tested stamp.
    const status = root.querySelector('[data-testid="hub-overview-status-sys_1"]')
    expect(status?.getAttribute('data-status')).toBe('active')
    expect(status?.textContent).toContain('已启用')
    expect(status?.textContent).toContain('2026-08-30 02:00')
    expect(root.querySelector('.hub-overview__dot')?.getAttribute('data-status')).toBe('active')
  })

  it('says 暂无 when nothing consumes the system', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(overviewPayload([hubSystem()])))
    const root = await mount()
    expect(root.querySelector('[data-testid="hub-overview-consumers-sys_1"]')?.textContent).toBe('暂无')
  })

  it('renders each of the five connection states in plain words', async () => {
    const systems = [
      hubSystem({ id: 'resolved' }),
      hubSystem({
        id: 'foreign',
        connection: { model: 'data-source', bound: true, dataSourceId: 'ds_theirs', resolved: false, name: null, type: null, status: null, unresolvedReason: 'not_visible' },
      }),
      hubSystem({
        id: 'unbound',
        connection: { model: 'data-source', bound: false, dataSourceId: null, resolved: false, name: null, type: null, status: null, unresolvedReason: 'not_bound' },
      }),
      hubSystem({
        id: 'selfcontained',
        connection: { model: 'self-contained', bound: true, dataSourceId: null, resolved: false, name: null, type: null, status: null, unresolvedReason: null },
      }),
      hubSystem({
        id: 'internal',
        connection: { model: 'internal', bound: false, dataSourceId: null, resolved: false, name: null, type: null, status: null, unresolvedReason: null },
      }),
      hubSystem({
        id: 'nodirectory',
        connection: { model: 'data-source', bound: true, dataSourceId: 'ds_x', resolved: false, name: null, type: null, status: null, unresolvedReason: 'directory_unavailable' },
      }),
    ]
    apiFetchMock.mockImplementation(async () => jsonResponse(overviewPayload(systems)))
    const root = await mount()

    const text = (id: string) => root.querySelector(`[data-testid="hub-overview-connection-${id}"]`)?.textContent
    expect(text('resolved')).toBe('PLM 生产库(只读) · sqlserver')
    // Owned by someone else: acknowledged, never named, never blank.
    expect(text('foreign')).toBe('已配置(他人管理)')
    expect(text('unbound')).toBe('未绑定')
    expect(text('selfcontained')).toBe('自带连接')
    expect(text('internal')).toContain('本系统内部表')
    expect(text('nodirectory')).toBe('已配置(名称不可见)')
  })

  it('renders the K3 fence sentence verbatim from the server notice', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(overviewPayload([
      hubSystem({
        id: 'k3',
        kind: 'erp:k3-wise-webapi',
        kindLabel: bilingual('金蝶 K3 WISE 接口', 'Kingdee K3 WISE WebAPI'),
        writeCapability: { reads: 'real', writes: 'fenced', fenced: true, notice: bilingual('只读·永不写入', 'Read-only · never writes') },
        connection: { model: 'self-contained', bound: true, dataSourceId: null, resolved: false, name: null, type: null, status: null, unresolvedReason: null },
      }),
    ])))
    const root = await mount()
    expect(root.querySelector('[data-testid="hub-overview-fence-k3"]')?.textContent).toBe('只读·永不写入')
    expect(root.querySelector('[data-testid="hub-overview-write-k3"]')?.getAttribute('data-fenced')).toBe('true')
    // A non-fenced system gets no fence line at all.
    expect(root.querySelector('[data-testid="hub-overview-fence-sys_1"]')).toBeNull()
  })

  it('carries the raw kind and ids verbatim in the 技术详情 disclosure', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(overviewPayload([
      hubSystem({
        id: 'sys_1',
        kind: 'some:kind-nobody-registered',
        kindLabel: bilingual('自定义连接器', 'Custom connector'),
        kindRegistered: false,
        technical: { systemId: 'sys_1', kind: 'some:kind-nobody-registered', role: 'source', status: 'active', dataSourceId: 'ds_plm', workspaceId: 'ws_1', createdAt: null, updatedAt: null },
      }),
    ])))
    const root = await mount()
    const disclosure = root.querySelector('[data-testid="hub-overview-technical-sys_1"]')
    expect(disclosure?.tagName.toLowerCase()).toBe('details')
    // The plain-word label is what the card shows; the RAW token lives only in the disclosure.
    expect(root.querySelector('[data-testid="hub-overview-kind-sys_1"]')?.textContent).toContain('自定义连接器')
    expect(root.querySelector('[data-testid="hub-overview-technical-sys_1-kind"]')?.textContent)
      .toBe('some:kind-nobody-registered')
    expect(root.querySelector('[data-testid="hub-overview-technical-sys_1-dataSourceId"]')?.textContent).toBe('ds_plm')
    expect(root.querySelector('[data-testid="hub-overview-technical-sys_1-workspaceId"]')?.textContent).toBe('ws_1')
  })

  it('renders the empty state pointing at the top-right button', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(overviewPayload([])))
    const root = await mount()
    expect(root.querySelector('[data-testid="hub-overview-empty"]')?.textContent)
      .toContain('尚未接入任何系统，右上角新增。')
    expect(root.querySelector('[data-testid="hub-overview-add-connection"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="hub-overview-cards"]')).toBeNull()
  })

  it('LINKS to the existing editor instead of building one — every button is an emit', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(overviewPayload([hubSystem()])))
    const root = await mount()

    ;(root.querySelector('[data-testid="hub-overview-edit-sys_1"]') as HTMLElement).click()
    await flushUi(1)
    expect(emitted).toContainEqual(['open-connection', 'sys_1'])

    ;(root.querySelector('[data-testid="hub-overview-add-connection"]') as HTMLElement).click()
    await flushUi(1)
    expect(emitted).toContainEqual(['open-connections', undefined])

    // No mutating call was made — the only request this section ever issues is its own GET.
    const urls = apiFetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.every((url) => url.startsWith('/api/integration/hub/overview'))).toBe(true)
    for (const call of apiFetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.method === undefined || init.method === 'GET').toBe(true)
    }
  })

  it('SENTINEL: a regressed backend payload carrying connection detail is still never rendered', async () => {
    const secrets = {
      connectionString: 'Server=10.20.30.40,1433;Database=PLMDB;User Id=svc_plm;Password=hunter2;',
      host: '10.20.30.40',
      baseUrl: 'https://k3.internal.corp:8080/K3API',
      lastError: "connect ECONNREFUSED sqlserver://svc_plm@10.20.30.40:1433/PLMDB",
    }
    apiFetchMock.mockImplementation(async () => jsonResponse(overviewPayload([
      {
        ...hubSystem({ hasLastError: true }),
        // Fields the contract does NOT have. If the component ever spread its input into the DOM,
        // these would surface.
        config: secrets,
        lastError: secrets.lastError,
        credentials: { password: 'hunter2' },
        connection: {
          model: 'data-source', bound: true, dataSourceId: 'ds_plm', resolved: true,
          name: 'PLM 生产库(只读)', type: 'sqlserver', status: 'connected', unresolvedReason: null,
          host: secrets.host, connectionString: secrets.connectionString,
        },
      },
    ])))
    const root = await mount()
    const rendered = root.textContent ?? ''
    for (const [key, value] of Object.entries(secrets)) {
      expect(rendered, `${key} must not be rendered`).not.toContain(value)
    }
    expect(rendered).not.toContain('hunter2')
    // The COARSE failure signal is shown — that is the whole point of sending a boolean instead.
    expect(root.querySelector('[data-testid="hub-overview-status-sys_1"]')?.textContent).toContain('上次测试有报错')
  })

  it('surfaces a load failure without wiping the section', async () => {
    apiFetchMock.mockImplementation(async () => errorResponse(403, 'FORBIDDEN', 'Insufficient integration permissions'))
    const root = await mount()
    expect(root.querySelector('[data-testid="hub-overview-error"]')?.textContent)
      .toContain('Insufficient integration permissions')
    expect(root.querySelector('[data-testid="hub-overview-section"]')).toBeTruthy()
    expect(root.querySelector('[data-testid="hub-overview-cards"]')).toBeNull()
  })

  it('re-reads on refresh', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse(overviewPayload([hubSystem()])))
    const root = await mount()
    const before = apiFetchMock.mock.calls.length
    ;(root.querySelector('[data-testid="hub-overview-refresh"]') as HTMLElement).click()
    await flushUi()
    expect(apiFetchMock.mock.calls.length).toBe(before + 1)
  })
})
