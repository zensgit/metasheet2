import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp, type Component } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import type { WorkbenchExternalSystem } from '../src/services/integration/workbench'

// BA-UI-1 (docs/development/bridge-agent-admin-page-design-lock-20260707.md): structural spec for
// the read-only Bridge Agent observability section + the lock §2.1 SENTINEL test — plant
// secret-shaped strings in every backend-supplied surface the component receives (system config /
// credentials / lastError, test-connection message/code, objects/schema payload extras, error
// bodies) and assert none of them ever reaches the rendered DOM.

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationBridgeAgentSection from '../src/components/integration/IntegrationBridgeAgentSection.vue'

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

// ElCard stub — same pattern as IntegrationMonitoringSection.spec.ts (real Element Plus is not
// globally installed in this createApp() instance).
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

// --- sentinel vocabulary (secret-shaped strings that must NEVER render) -------------------------
const SENTINEL = {
  configSecret: 'SENTINEL-CONFIG-sk-a1b2c3d4e5',
  credentialSecret: 'SENTINEL-CRED-sharedsecret-9f8e7d',
  connectionString: 'Server=10.0.0.9;Database=K3;Password=SENTINEL-PW-x7y8z9;',
  lastError: 'connect failed: token=SENTINEL-TOKEN-11aa22bb host=192.168.77.66',
  testMessage: 'Bridge secret SENTINEL-MSG-deadbeef rejected at http://127.0.0.1:19091',
  hostileCode: 'FAILED secret=SENTINEL-CODE-cafe0001',
  objectExtra: 'SENTINEL-OBJECT-EXTRA-3355',
  schemaExtra: 'SENTINEL-SCHEMA-EXTRA-7788',
  errorBody: 'schema blew up: authorityCode=SENTINEL-AUTH-4433',
} as const

const BRIDGE_KIND = 'bridge:legacy-sql-readonly'

function bridgeSystem(overrides: Partial<WorkbenchExternalSystem> = {}): WorkbenchExternalSystem {
  return {
    id: 'sys_bridge_1',
    tenantId: 'default',
    workspaceId: null,
    name: 'Legacy SQL Bridge',
    kind: BRIDGE_KIND,
    role: 'source',
    status: 'active',
    // Secret-shaped values a hostile/legacy backend response could carry — the component must
    // never render ANY of config/credentials/lastError (lock §2.1).
    config: {
      baseUrl: 'http://127.0.0.1:19091/',
      sharedSecretEnvVar: SENTINEL.configSecret,
      connectionString: SENTINEL.connectionString,
    },
    hasCredentials: true,
    lastTestedAt: null,
    lastError: SENTINEL.lastError,
    ...overrides,
  } as WorkbenchExternalSystem
}

function httpSystem(): WorkbenchExternalSystem {
  return {
    id: 'sys_http_1',
    tenantId: 'default',
    workspaceId: null,
    name: 'Plain HTTP System',
    kind: 'http',
    role: 'source',
    status: 'active',
  } as WorkbenchExternalSystem
}

const OBJECTS_PAYLOAD = [
  {
    name: 'material',
    label: 'Material',
    operations: ['read'],
    source: 'bridge:legacy-sql-readonly',
    readonly: true,
    fieldCount: 4,
    // hostile extra key — must not render
    connectionString: SENTINEL.objectExtra,
  },
  { name: 'bom', label: 'BOM Header', operations: ['read'], readonly: true, fieldCount: 3 },
]

const SCHEMA_PAYLOAD = {
  object: 'material',
  fields: [
    { name: 'FItemID', type: 'number', required: false, defaultValue: SENTINEL.schemaExtra },
    { name: 'FNumber', type: 'string', required: true },
    { name: 'FName', type: 'string', required: true },
  ],
  raw: { source: 'bridge:legacy-sql-readonly', leaked: SENTINEL.schemaExtra },
}

type RouteOverrides = {
  test?: () => Response
  objects?: () => Response
  schema?: () => Response
}

function mockRoutes(overrides: RouteOverrides = {}): void {
  apiFetchMock.mockImplementation(async (url: string) => {
    if (typeof url !== 'string') return jsonResponse(null)
    if (url.includes('/test')) {
      return overrides.test
        ? overrides.test()
        : jsonResponse({ ok: true, connected: true, authenticated: true, message: SENTINEL.testMessage })
    }
    if (url.includes('/objects')) {
      return overrides.objects ? overrides.objects() : jsonResponse(OBJECTS_PAYLOAD)
    }
    if (url.includes('/schema')) {
      return overrides.schema ? overrides.schema() : jsonResponse(SCHEMA_PAYLOAD)
    }
    return jsonResponse(null)
  })
}

describe('IntegrationBridgeAgentSection', () => {
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
  })

  function mountSection(systems: WorkbenchExternalSystem[]): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(IntegrationBridgeAgentSection as unknown as Component, {
        systems,
        scope: { tenantId: 'default', workspaceId: null },
      }),
    })
    app.component('ElCard', ElCard)
    app.mount(container)
    return container
  }

  function q<T extends HTMLElement>(root: HTMLElement, testid: string): T {
    const el = root.querySelector<T>(`[data-testid="${testid}"]`)
    if (!el) throw new Error(`missing [data-testid=${testid}]`)
    return el
  }

  it('renders the guided empty state (what-this-is + first-step) when no bridge-agent system is registered', async () => {
    mockRoutes()
    const root = mountSection([httpSystem()])
    await flushUi()

    expect(root.querySelector('#int-sec-bridge-agent')).not.toBeNull()
    q(root, 'bridge-agent-empty-state')
    const what = q(root, 'bridge-agent-empty-what')
    const firstStep = q(root, 'bridge-agent-empty-first-step')
    expect(what.textContent).toContain(BRIDGE_KIND)
    expect(firstStep.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    // Default test-env locale is 'en' — the first step names the concrete action (add a connection).
    expect(firstStep.textContent).toMatch(/add a connection/i)
    // No status card / instance table for a non-bridge kind (the section filters by kind).
    expect(root.querySelector('[data-testid="bridge-agent-cards"]')).toBeNull()
    // Filtering also means no objects fetch was issued for the http system.
    expect(apiFetchMock).not.toHaveBeenCalled()

    // zh variant coverage — flip via the composable setter, remount, assert the zh copy.
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      app!.unmount()
      container!.remove()
      const zhRoot = mountSection([httpSystem()])
      await flushUi()
      expect(q(zhRoot, 'bridge-agent-empty-first-step').textContent).toContain('连接管理')
      expect(q(zhRoot, 'bridge-agent-empty-what').textContent).toContain('在线状态')
    } finally {
      setLocale('en')
    }
  })

  it('status card: renders online after a successful mocked testConnection, with readonly badge and client-side timestamp', async () => {
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    // Pre-check state
    expect(q(root, `bridge-agent-card-status-${system.id}`).getAttribute('data-status')).toBe('unknown')
    expect(q(root, `bridge-agent-card-checked-at-${system.id}`).textContent).toMatch(/never/i)
    // Read-only badge is unconditional (lock: the page must carry the 只读 mark).
    expect(q(root, `bridge-agent-card-readonly-${system.id}`).textContent?.trim().length ?? 0).toBeGreaterThan(0)

    q<HTMLButtonElement>(root, `bridge-agent-card-check-${system.id}`).click()
    await flushUi()

    const status = q(root, `bridge-agent-card-status-${system.id}`)
    expect(status.getAttribute('data-status')).toBe('online')
    expect(status.textContent).toMatch(/online/i)
    expect(q(root, `bridge-agent-card-checked-at-${system.id}`).textContent).not.toMatch(/never/i)
    // The POST hit the existing generic test route — no new backend route.
    const testCall = apiFetchMock.mock.calls.find(([url]) => typeof url === 'string' && (url as string).includes('/test'))
    expect(testCall?.[0]).toContain(`/api/integration/external-systems/${system.id}/test`)
  })

  it('status card: a failed check renders offline + the IU-1 display label — never the raw code, never the raw message', async () => {
    mockRoutes({
      test: () => jsonResponse({
        ok: false,
        connected: false,
        code: 'BRIDGE_AGENT_UNREACHABLE',
        message: SENTINEL.testMessage,
      }),
    })
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    q<HTMLButtonElement>(root, `bridge-agent-card-check-${system.id}`).click()
    await flushUi()

    expect(q(root, `bridge-agent-card-status-${system.id}`).getAttribute('data-status')).toBe('offline')
    const error = q(root, `bridge-agent-card-error-${system.id}`)
    // IU-1 label for the registered code (en) — the human label, not the enum.
    expect(error.textContent).toContain('Cannot reach the Bridge Agent.')
    const html = root.innerHTML
    expect(html).not.toContain('BRIDGE_AGENT_UNREACHABLE')
    expect(html).not.toContain(SENTINEL.testMessage)
  })

  it('status card: an UNREGISTERED (agent-supplied) code degrades to the generic unknown label, never rendering the code text', async () => {
    mockRoutes({
      test: () => jsonResponse({ ok: false, connected: false, code: SENTINEL.hostileCode }),
    })
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    q<HTMLButtonElement>(root, `bridge-agent-card-check-${system.id}`).click()
    await flushUi()

    const error = q(root, `bridge-agent-card-error-${system.id}`)
    expect(error.textContent).toContain('Unknown error')
    expect(root.innerHTML).not.toContain(SENTINEL.hostileCode)
  })

  it('instance list: name + role + coarse status + credential BOOLEAN only', async () => {
    mockRoutes()
    const configured = bridgeSystem()
    const unconfigured = bridgeSystem({ id: 'sys_bridge_2', name: 'Second Bridge', hasCredentials: false, status: 'inactive' })
    const root = mountSection([configured, unconfigured, httpSystem()])
    await flushUi()

    q(root, 'bridge-agent-instance-list')
    // Only the two bridge-kind systems appear.
    expect(root.querySelectorAll('[data-testid^="bridge-agent-instance-row-"]').length).toBe(2)
    expect(root.innerHTML).not.toContain('Plain HTTP System')

    expect(q(root, `bridge-agent-instance-name-${configured.id}`).textContent).toBe('Legacy SQL Bridge')
    expect(q(root, `bridge-agent-instance-credential-${configured.id}`).textContent).toMatch(/configured/i)
    expect(q(root, 'bridge-agent-instance-credential-sys_bridge_2').textContent).toMatch(/not configured/i)
    expect(q(root, 'bridge-agent-instance-status-sys_bridge_2').textContent).toMatch(/inactive/i)
  })

  it('objects + schema: renders the mocked listObjects result and, on toggle, the getSchema field shapes', async () => {
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    // objects auto-load for the selected instance via the existing generic objects route
    const objectsCall = apiFetchMock.mock.calls.find(([url]) => typeof url === 'string' && (url as string).includes('/objects'))
    expect(objectsCall?.[0]).toContain(`/api/integration/external-systems/${system.id}/objects`)

    q(root, 'bridge-agent-objects-list')
    expect(q(root, 'bridge-agent-object-row-material').textContent).toContain('material')
    expect(q(root, 'bridge-agent-object-field-count-material').textContent).toBe('4')
    expect(q(root, 'bridge-agent-object-row-bom').textContent).toContain('BOM Header')

    // schema preview on demand
    q<HTMLButtonElement>(root, 'bridge-agent-object-schema-toggle-material').click()
    await flushUi()

    const schemaCall = apiFetchMock.mock.calls.find(([url]) => typeof url === 'string' && (url as string).includes('/schema'))
    expect(schemaCall?.[0]).toContain(`/api/integration/external-systems/${system.id}/schema`)
    expect(schemaCall?.[0]).toContain('object=material')

    const schemaTable = q(root, 'bridge-agent-schema-material')
    expect(q(root, 'bridge-agent-schema-field-material-FNumber').textContent).toContain('FNumber')
    expect(q(root, 'bridge-agent-schema-field-material-FNumber').textContent).toMatch(/yes/i)
    expect(q(root, 'bridge-agent-schema-field-material-FItemID').textContent).toMatch(/no/i)
    expect(schemaTable.textContent).toContain('number')

    // Lock §4: the data plane is NEVER touched — no /query call, and every call the section made is
    // one of the three read-only generic endpoints.
    for (const [url] of apiFetchMock.mock.calls) {
      expect(String(url)).not.toContain('/query')
      expect(String(url)).toMatch(/\/api\/integration\/external-systems\/[^/]+\/(test|objects|schema)/)
    }
  })

  it('objects: renders the guided allowlist-empty state when the agent exposes zero objects', async () => {
    mockRoutes({ objects: () => jsonResponse([]) })
    const root = mountSection([bridgeSystem()])
    await flushUi()

    q(root, 'bridge-agent-objects-empty')
    const what = q(root, 'bridge-agent-objects-empty-what')
    const firstStep = q(root, 'bridge-agent-objects-empty-first-step')
    expect(what.textContent).toMatch(/allowlist/i)
    expect(firstStep.textContent).toMatch(/reload objects/i)
  })

  it('objects/schema failures render fixed values-free copy — never the backend error body', async () => {
    mockRoutes({
      objects: () => errorResponse(500, 'BRIDGE_AGENT_REQUEST_FAILED', SENTINEL.errorBody),
    })
    const root = mountSection([bridgeSystem()])
    await flushUi()

    q(root, 'bridge-agent-objects-error')
    expect(root.innerHTML).not.toContain(SENTINEL.errorBody)
    expect(root.innerHTML).not.toContain('SENTINEL-AUTH-4433')

    // schema failure branch, same discipline
    apiFetchMock.mockReset()
    mockRoutes({
      schema: () => errorResponse(500, 'BRIDGE_AGENT_REQUEST_FAILED', SENTINEL.errorBody),
    })
    app!.unmount()
    container!.remove()
    const root2 = mountSection([bridgeSystem()])
    await flushUi()
    q<HTMLButtonElement>(root2, 'bridge-agent-object-schema-toggle-material').click()
    await flushUi()
    q(root2, 'bridge-agent-schema-error-material')
    expect(root2.innerHTML).not.toContain(SENTINEL.errorBody)
  })

  it('SENTINEL (lock §2.1): no secret-shaped string from system config/credentials/lastError/test message/payload extras ever reaches the DOM', async () => {
    mockRoutes({
      test: () => jsonResponse({
        ok: false,
        connected: false,
        code: 'BRIDGE_AGENT_UNREACHABLE',
        message: SENTINEL.testMessage,
        system: {
          ...bridgeSystem(),
          config: { sharedSecret: SENTINEL.credentialSecret },
        },
      }),
    })
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    // exercise every render path: check + objects (auto) + schema
    q<HTMLButtonElement>(root, `bridge-agent-card-check-${system.id}`).click()
    await flushUi()
    q<HTMLButtonElement>(root, 'bridge-agent-object-schema-toggle-material').click()
    await flushUi()

    const html = root.innerHTML
    const text = root.textContent || ''
    for (const [key, sentinel] of Object.entries(SENTINEL)) {
      expect(html.includes(sentinel), `sentinel leaked into DOM html: ${key}`).toBe(false)
      expect(text.includes(sentinel), `sentinel leaked into DOM text: ${key}`).toBe(false)
    }
    // Sub-fragments too (a partial render of a connection string is still a leak).
    for (const fragment of ['SENTINEL-', 'Password=', 'token=', 'authorityCode=', '192.168.77.66', 'sharedsecret']) {
      expect(html.includes(fragment), `sentinel fragment leaked into DOM: ${fragment}`).toBe(false)
    }
    // The coarse credential boolean is the ONLY credential-adjacent output.
    expect(q(root, `bridge-agent-instance-credential-${system.id}`).textContent).toMatch(/configured/i)
  })

  it('zh copy: section heading + core labels render in Chinese under zh-CN', async () => {
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      mockRoutes()
      const system = bridgeSystem()
      const root = mountSection([system])
      await flushUi()

      expect(root.textContent).toContain('Bridge Agent 观测')
      expect(root.textContent).toContain('只读')
      expect(root.textContent).toContain('实例列表')
      expect(root.textContent).toContain('对象列表')
      expect(q(root, `bridge-agent-card-status-${system.id}`).textContent).toContain('尚未检查')
      expect(q(root, `bridge-agent-instance-credential-${system.id}`).textContent).toContain('已配置')

      q<HTMLButtonElement>(root, `bridge-agent-card-check-${system.id}`).click()
      await flushUi()
      expect(q(root, `bridge-agent-card-status-${system.id}`).textContent).toContain('在线')
    } finally {
      setLocale('en')
    }
  })
})
