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

// jsdom's Blob does not always implement `.text()` — same fallback pattern as
// IntegrationWorkbenchView.spec.ts's readBlobText helper (BA-APPLY-1 checklist download test, below).
async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
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

  // --- BA-UI-2 (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-2):
  // values-free one-click probe — health -> objects -> schema, sequential, early-stop on first
  // failure. Evidence card renders ok/durationBucket/counts/humanized-code per step + overall
  // PASS/FAIL, all through the three EXISTING generic endpoints (zero new routes).

  it('probe: happy path runs health -> objects -> schema sequentially and renders PASS with three ok steps', async () => {
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    expect(root.querySelector(`[data-testid="bridge-agent-probe-evidence-${system.id}"]`)).toBeNull()
    apiFetchMock.mockClear() // isolate the calls the probe itself issues from mount-time auto-load

    q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
    await flushUi()

    const overall = q(root, `bridge-agent-probe-overall-${system.id}`)
    expect(overall.getAttribute('data-result')).toBe('pass')
    expect(overall.textContent).toBe('PASS')

    const healthStep = q(root, `bridge-agent-probe-step-health-${system.id}`)
    const objectsStep = q(root, `bridge-agent-probe-step-objects-${system.id}`)
    const schemaStep = q(root, `bridge-agent-probe-step-schema-${system.id}`)
    expect(healthStep.getAttribute('data-ok')).toBe('true')
    expect(objectsStep.getAttribute('data-ok')).toBe('true')
    expect(schemaStep.getAttribute('data-ok')).toBe('true')
    expect(objectsStep.textContent).toContain('objectCount: 2')
    expect(schemaStep.textContent).toContain('fieldCount: 3')

    // Sequential order through the three EXISTING generic endpoints only, nothing else.
    const orderedUrls = apiFetchMock.mock.calls.map(([url]) => String(url))
    const testIdx = orderedUrls.findIndex((u) => u.includes('/test'))
    const objectsIdx = orderedUrls.findIndex((u) => u.includes('/objects'))
    const schemaIdx = orderedUrls.findIndex((u) => u.includes('/schema'))
    expect(testIdx).toBe(0)
    expect(objectsIdx).toBeGreaterThan(testIdx)
    expect(schemaIdx).toBeGreaterThan(objectsIdx)
    expect(orderedUrls[schemaIdx]).toContain('object=material')
  })

  it('probe: a failure at the objects step early-stops before schema (schema never called) — FAIL badge + step guidance + humanized code', async () => {
    mockRoutes({ objects: () => errorResponse(500, 'BRIDGE_AGENT_REQUEST_FAILED', SENTINEL.errorBody) })
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()
    apiFetchMock.mockClear()

    q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
    await flushUi()

    const overall = q(root, `bridge-agent-probe-overall-${system.id}`)
    expect(overall.getAttribute('data-result')).toBe('fail')
    expect(overall.textContent).toMatch(/FAIL: Objects/)

    expect(q(root, `bridge-agent-probe-step-health-${system.id}`).getAttribute('data-ok')).toBe('true')
    expect(q(root, `bridge-agent-probe-step-objects-${system.id}`).getAttribute('data-ok')).toBe('false')
    // Early-stop: the schema step never even appears (it was never run), and its fetch never fired.
    expect(root.querySelector(`[data-testid="bridge-agent-probe-step-schema-${system.id}"]`)).toBeNull()
    expect(apiFetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('/schema'))).toBe(false)

    // Humanized code: objects failures carry no code client-side, so this degrades to the generic
    // IU-1 unknown-error label — never the raw backend code/message.
    expect(q(root, `bridge-agent-probe-step-error-objects-${system.id}`).textContent).toContain('Unknown error')
    expect(q(root, `bridge-agent-probe-step-guidance-objects-${system.id}`).textContent).toMatch(/retry the objects probe/i)
    expect(root.innerHTML).not.toContain(SENTINEL.errorBody)
    expect(root.innerHTML).not.toContain('BRIDGE_AGENT_REQUEST_FAILED')
  })

  it('probe: objects step returns zero objects -> schema step is SKIPPED (not a failure), overall still PASS', async () => {
    mockRoutes({ objects: () => jsonResponse([]) })
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()
    apiFetchMock.mockClear()

    q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
    await flushUi()

    expect(q(root, `bridge-agent-probe-overall-${system.id}`).getAttribute('data-result')).toBe('pass')
    expect(q(root, `bridge-agent-probe-step-schema-${system.id}`).getAttribute('data-ok')).toBe('true')
    q(root, `bridge-agent-probe-step-skipped-${system.id}`)
    // Nothing to sample -> schema is never fetched (distinct from the early-stop-on-failure path).
    expect(apiFetchMock.mock.calls.some(([url]) => typeof url === 'string' && url.includes('/schema'))).toBe(false)
  })

  it('probe: per-step duration buckets classify short/medium/long elapsed time (<1s / 1-5s / >5s)', async () => {
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    // Fake timers so each mocked fetch resolves after a controlled, real elapsed delay — the
    // component measures with plain `Date.now()`, and vitest's fake-timer install fakes that too, so
    // advancing the clock produces real, deterministic bucket boundaries (no brittle call-count
    // stubbing of Date.now, which can be thrown off by incidental calls elsewhere in the stack).
    vi.useFakeTimers()
    try {
      apiFetchMock.mockImplementation((url: unknown) => {
        const u = String(url)
        if (u.includes('/test')) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(jsonResponse({ ok: true, connected: true, authenticated: true })), 200)
          })
        }
        if (u.includes('/objects')) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(jsonResponse(OBJECTS_PAYLOAD)), 1500)
          })
        }
        if (u.includes('/schema')) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => resolve(jsonResponse(SCHEMA_PAYLOAD)), 6000)
          })
        }
        return Promise.resolve(jsonResponse(null))
      })

      q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
      await vi.advanceTimersByTimeAsync(200) // health resolves: 200ms -> <1s
      await vi.advanceTimersByTimeAsync(1500) // objects resolves: 1500ms later -> 1-5s
      await vi.advanceTimersByTimeAsync(6000) // schema resolves: 6000ms later -> >5s
      await nextTick()
      await nextTick()

      expect(q(root, `bridge-agent-probe-step-health-${system.id}`).textContent).toContain('durationBucket: <1s')
      expect(q(root, `bridge-agent-probe-step-objects-${system.id}`).textContent).toContain('durationBucket: 1-5s')
      expect(q(root, `bridge-agent-probe-step-schema-${system.id}`).textContent).toContain('durationBucket: >5s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('SENTINEL via probe (lock §3 BA-UI-2): no secret-shaped string leaks through the probe evidence path, success or failure', async () => {
    // Success path: the default fixtures already carry hostile extras (OBJECTS_PAYLOAD connectionString
    // key, SCHEMA_PAYLOAD defaultValue/raw.leaked, the test response's SENTINEL-laden message).
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
    await flushUi()

    q(root, `bridge-agent-probe-evidence-${system.id}`)
    for (const [key, sentinel] of Object.entries(SENTINEL)) {
      expect(root.innerHTML.includes(sentinel), `probe (success) sentinel leak html: ${key}`).toBe(false)
      expect((root.textContent || '').includes(sentinel), `probe (success) sentinel leak text: ${key}`).toBe(false)
    }

    // Failure path: hostile/non-closed-set code + secret-laden message on the health step.
    apiFetchMock.mockReset()
    mockRoutes({
      test: () => jsonResponse({ ok: false, connected: false, code: SENTINEL.hostileCode, message: SENTINEL.testMessage }),
    })
    app!.unmount()
    container!.remove()
    const root2 = mountSection([bridgeSystem()])
    await flushUi()
    q<HTMLButtonElement>(root2, `bridge-agent-probe-${system.id}`).click()
    await flushUi()

    for (const [key, sentinel] of Object.entries(SENTINEL)) {
      expect(root2.innerHTML.includes(sentinel), `probe (failure) sentinel leak html: ${key}`).toBe(false)
      expect((root2.textContent || '').includes(sentinel), `probe (failure) sentinel leak text: ${key}`).toBe(false)
    }
    expect(q(root2, `bridge-agent-probe-step-error-health-${system.id}`).textContent).toContain('Unknown error')
  })

  it('zh copy: probe evidence renders bilingual overall/step labels + guidance under zh-CN', async () => {
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      mockRoutes({ objects: () => errorResponse(500, 'BRIDGE_AGENT_REQUEST_FAILED', SENTINEL.errorBody) })
      const system = bridgeSystem()
      const root = mountSection([system])
      await flushUi()

      q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
      await flushUi()

      expect(q(root, `bridge-agent-probe-overall-${system.id}`).textContent).toContain('对象列表')
      expect(q(root, `bridge-agent-probe-step-health-${system.id}`).textContent).toContain('健康检查')
      expect(q(root, `bridge-agent-probe-step-objects-${system.id}`).textContent).toContain('对象列表')
      expect(q(root, `bridge-agent-probe-step-guidance-objects-${system.id}`).textContent).toContain('对象列表探测')
      expect(root.querySelector(`[data-testid="bridge-agent-probe-step-schema-${system.id}"]`)).toBeNull()
    } finally {
      setLocale('en')
    }
  })

  // --- BA-UI-3 (docs/development/bridge-agent-admin-page-design-lock-20260707.md §3 BA-UI-3): config
  // validation checklist + change-suggestion builder. Both cards are purely DERIVED/LOCAL — no new
  // fetch is issued for either (the checklist reuses the already-fetched `objects`; the suggestion
  // builder is a local text generator over operator-typed drafts). ADD-ONLY to this spec file.

  it('config-check card: renders the 6 checklist items derived from the selected instance config + loaded objects', async () => {
    mockRoutes() // default OBJECTS_PAYLOAD = ['material', 'bom'] -- no bom_child
    const system = bridgeSystem() // config.baseUrl = loopback; no authMode; no sampleLimit/maxLimit
    const root = mountSection([system])
    await flushUi()

    q(root, 'bridge-agent-config-check')
    q(root, 'bridge-agent-config-check-list')
    expect(q(root, 'bridge-agent-config-check-item-requiredFields').getAttribute('data-status')).toBe('pass')
    expect(q(root, 'bridge-agent-config-check-item-limits').getAttribute('data-status')).toBe('pass')
    expect(q(root, 'bridge-agent-config-check-item-authMode').getAttribute('data-status')).toBe('warn')
    expect(q(root, 'bridge-agent-config-check-item-localhostBoundary').getAttribute('data-status')).toBe('pass')
    expect(q(root, 'bridge-agent-config-check-item-rawSqlForbidden').getAttribute('data-status')).toBe('pass')
    // material + bom present but not bom_child -> partial (advisory warn, not a hard failure)
    expect(q(root, 'bridge-agent-config-check-item-objectAllowlist').getAttribute('data-status')).toBe('warn')
    expect(q(root, 'bridge-agent-config-check-item-label-authMode').textContent).toMatch(/no auth mode is explicitly declared/i)
  })

  it('config-check card: mutation-relevant per-item branches (fail on missing baseUrl, fail on non-loopback host — never rendering the host)', async () => {
    mockRoutes({ objects: () => jsonResponse([]) })
    const noBaseUrlSystem = bridgeSystem({ config: {} })
    const root = mountSection([noBaseUrlSystem])
    await flushUi()

    expect(q(root, 'bridge-agent-config-check-item-requiredFields').getAttribute('data-status')).toBe('fail')
    expect(q(root, 'bridge-agent-config-check-item-localhostBoundary').getAttribute('data-status')).toBe('warn')
    expect(q(root, 'bridge-agent-config-check-item-objectAllowlist').getAttribute('data-status')).toBe('warn')
    expect(q(root, 'bridge-agent-config-check-item-label-objectAllowlist').textContent).toMatch(/allowlist is currently empty/i)

    app!.unmount()
    container!.remove()
    const hostileHostSystem = bridgeSystem({ config: { baseUrl: 'http://10.0.0.9:19091/' } })
    const root2 = mountSection([hostileHostSystem])
    await flushUi()
    expect(q(root2, 'bridge-agent-config-check-item-localhostBoundary').getAttribute('data-status')).toBe('fail')
    expect(root2.innerHTML).not.toContain('10.0.0.9')
  })

  it('SENTINEL (BA-UI-3 config-check): the default system config sentinels never leak through the checklist card', async () => {
    mockRoutes()
    const system = bridgeSystem() // carries SENTINEL.configSecret / SENTINEL.connectionString in .config
    const root = mountSection([system])
    await flushUi()

    const checklist = q(root, 'bridge-agent-config-check-list')
    for (const [key, sentinel] of Object.entries(SENTINEL)) {
      expect(checklist.innerHTML.includes(sentinel), `config-check sentinel leak: ${key}`).toBe(false)
    }
  })

  it('suggestion builder: shows the IU-6 guided empty state (what + first step) until a valid object name is entered', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    q(root, 'bridge-agent-suggestion-builder')
    q(root, 'bridge-agent-suggestion-empty')
    const what = q(root, 'bridge-agent-suggestion-empty-what')
    const firstStep = q(root, 'bridge-agent-suggestion-empty-first-step')
    expect(what.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(firstStep.textContent).toMatch(/enter at least one object name/i)
    expect(root.querySelector('[data-testid="bridge-agent-suggestion-text"]')).toBeNull()
  })

  it('suggestion builder: typing an object + field names generates the values-free copyable text, including the target-instance name', async () => {
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    const fieldsInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-fields-0')
    objectInput.value = 'material_extra'
    objectInput.dispatchEvent(new Event('input'))
    fieldsInput.value = 'field_a, field_b'
    fieldsInput.dispatchEvent(new Event('input'))
    await flushUi()

    expect(root.querySelector('[data-testid="bridge-agent-suggestion-empty"]')).toBeNull()
    const text = q<HTMLTextAreaElement>(root, 'bridge-agent-suggestion-text')
    expect(text.value).toContain('1. Object: material_extra')
    expect(text.value).toContain('New field mappings: field_a, field_b')
    expect(text.value).toContain(`Target instance: ${system.name}`)
    expect(text.value).toMatch(/this page makes no direct change/i)
  })

  it('suggestion builder: add row / remove row manage independent drafts, and each is reflected in the generated text', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-suggestion-add-row').click()
    await flushUi()
    q(root, 'bridge-agent-suggestion-row-1')

    const object0 = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    object0.value = 'material_extra'
    object0.dispatchEvent(new Event('input'))
    const object1 = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-1')
    object1.value = 'bom_child_extra'
    object1.dispatchEvent(new Event('input'))
    await flushUi()

    const text = q<HTMLTextAreaElement>(root, 'bridge-agent-suggestion-text')
    expect(text.value).toContain('1. Object: material_extra')
    expect(text.value).toContain('2. Object: bom_child_extra')

    q<HTMLButtonElement>(root, 'bridge-agent-suggestion-remove-0').click()
    await flushUi()
    expect(root.querySelector('[data-testid="bridge-agent-suggestion-row-1"]')).toBeNull()
    const textAfterRemove = q<HTMLTextAreaElement>(root, 'bridge-agent-suggestion-text')
    expect(textAfterRemove.value).toContain('1. Object: bom_child_extra')
    expect(textAfterRemove.value).not.toContain('material_extra')
  })

  it('SENTINEL (BA-UI-3 suggestion builder): a secret/host-shaped object or field name typed by the operator is dropped, never echoed', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = `password=${SENTINEL.configSecret}`
    objectInput.dispatchEvent(new Event('input'))
    await flushUi()

    // The only "object" typed is invalid-shaped -> zero valid entries -> guided empty state renders
    // (never the copy/textarea surface), and the sentinel never appears anywhere in the DOM.
    q(root, 'bridge-agent-suggestion-empty')
    expect(root.innerHTML).not.toContain(SENTINEL.configSecret)
    expect(root.innerHTML).not.toContain('password=')

    // A second row: valid object name, but a hostile field key alongside a legit one.
    q<HTMLButtonElement>(root, 'bridge-agent-suggestion-add-row').click()
    await flushUi()
    const object1 = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-1')
    object1.value = 'material_extra'
    object1.dispatchEvent(new Event('input'))
    const fields1 = q<HTMLInputElement>(root, 'bridge-agent-suggestion-fields-1')
    fields1.value = `field_a, token=${SENTINEL.configSecret}, ${SENTINEL.connectionString}`
    fields1.dispatchEvent(new Event('input'))
    await flushUi()

    const text = q<HTMLTextAreaElement>(root, 'bridge-agent-suggestion-text')
    expect(text.value).toContain('field_a')
    expect(text.value).not.toContain(SENTINEL.configSecret)
    expect(text.value).not.toContain(SENTINEL.connectionString)
    expect(text.value).not.toContain('token=')
    expect(root.innerHTML).not.toContain(SENTINEL.configSecret)
    expect(root.innerHTML).not.toContain(SENTINEL.connectionString)
  })

  it('suggestion builder: copy button writes the exact values-free text to the clipboard and shows a copied state', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
      objectInput.value = 'material_extra'
      objectInput.dispatchEvent(new Event('input'))
      await flushUi()

      q<HTMLButtonElement>(root, 'bridge-agent-suggestion-copy').click()
      await flushUi()

      expect(writeText).toHaveBeenCalledTimes(1)
      expect(String(writeText.mock.calls[0][0])).toContain('1. Object: material_extra')
      expect(q(root, 'bridge-agent-suggestion-copy-state').textContent).toMatch(/copied/i)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (navigator as any).clipboard
    }
  })

  it('suggestion builder: a missing/non-functional clipboard API renders a failed-copy fallback message, never throwing', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = 'material_extra'
    objectInput.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-suggestion-copy').click()
    await flushUi()

    expect(q(root, 'bridge-agent-suggestion-copy-state').textContent).toMatch(/copy failed/i)
  })

  // --- BA-APPLY-1 (docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 A,
  // #3876): "导出实施清单" — an ADD-ONLY export button on the suggestion card. Component spec covers:
  // toggle visibility, guided empty state, live JSON generation, add/remove-row reflection, the
  // SENTINEL discipline (independent of the sibling suggestion text), copy + a missing-clipboard
  // fallback, and download (createObjectURL/anchor/revoke). Zero apply endpoint, zero write — the
  // component test setup below never registers a route beyond the existing test/objects/schema mocks.

  it('checklist export: hidden until the export button is clicked; toggling flips the button label', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    expect(root.querySelector('[data-testid="bridge-agent-checklist-output"]')).toBeNull()
    expect(root.querySelector('[data-testid="bridge-agent-checklist-empty"]')).toBeNull()
    const exportButton = q<HTMLButtonElement>(root, 'bridge-agent-checklist-export')
    expect(exportButton.textContent).toMatch(/export implementation checklist/i)

    exportButton.click()
    await flushUi()
    expect(exportButton.textContent).toMatch(/hide implementation checklist/i)
    // no object name typed yet -> the guided empty state, not the JSON preview
    q(root, 'bridge-agent-checklist-empty')
    expect(root.querySelector('[data-testid="bridge-agent-checklist-output"]')).toBeNull()

    exportButton.click()
    await flushUi()
    expect(exportButton.textContent).toMatch(/export implementation checklist/i)
    expect(root.querySelector('[data-testid="bridge-agent-checklist-empty"]')).toBeNull()
  })

  it('checklist export: typing an object + field names renders the exact { schemaVersion, operations } JSON', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    const fieldsInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-fields-0')
    objectInput.value = 'material_extra'
    objectInput.dispatchEvent(new Event('input'))
    fieldsInput.value = 'field_a, field_b'
    fieldsInput.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-checklist-export').click()
    await flushUi()

    const text = q<HTMLTextAreaElement>(root, 'bridge-agent-checklist-text')
    const parsed = JSON.parse(text.value)
    expect(parsed).toEqual({
      schemaVersion: 1,
      operations: [{ op: 'add_readonly_field', objectName: 'material_extra', fieldKeys: ['field_a', 'field_b'] }],
    })
    // no targetLabel/system-name, no free text, no counts — exactly the two keys
    expect(Object.keys(parsed).sort()).toEqual(['operations', 'schemaVersion'])
    expect(text.value).not.toContain(bridgeSystem().name)
  })

  it('checklist export: an object-only row (no field names) yields op=add_readonly_object', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = 'material_extra'
    objectInput.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-checklist-export').click()
    await flushUi()

    const text = q<HTMLTextAreaElement>(root, 'bridge-agent-checklist-text')
    expect(JSON.parse(text.value)).toEqual({
      schemaVersion: 1,
      operations: [{ op: 'add_readonly_object', objectName: 'material_extra', fieldKeys: [] }],
    })
  })

  it('checklist export: add row / remove row are reflected in the live JSON, in order', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-suggestion-add-row').click()
    await flushUi()

    const object0 = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    object0.value = 'material_extra'
    object0.dispatchEvent(new Event('input'))
    const object1 = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-1')
    object1.value = 'bom_child_extra'
    object1.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-checklist-export').click()
    await flushUi()

    let parsed = JSON.parse(q<HTMLTextAreaElement>(root, 'bridge-agent-checklist-text').value)
    expect(parsed.operations.map((op: { objectName: string }) => op.objectName)).toEqual(['material_extra', 'bom_child_extra'])

    q<HTMLButtonElement>(root, 'bridge-agent-suggestion-remove-0').click()
    await flushUi()
    parsed = JSON.parse(q<HTMLTextAreaElement>(root, 'bridge-agent-checklist-text').value)
    expect(parsed.operations.map((op: { objectName: string }) => op.objectName)).toEqual(['bom_child_extra'])
  })

  it('SENTINEL (BA-APPLY-1 checklist export): a secret/host-shaped object or field name is dropped, never echoed into the JSON', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = `password=${SENTINEL.configSecret}`
    objectInput.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-checklist-export').click()
    await flushUi()
    // the hostile-named row is dropped entirely -> back to the guided empty state, not a JSON preview
    q(root, 'bridge-agent-checklist-empty')
    expect(root.querySelector('[data-testid="bridge-agent-checklist-text"]')).toBeNull()
    expect(root.textContent).not.toContain(SENTINEL.configSecret)

    q<HTMLButtonElement>(root, 'bridge-agent-suggestion-add-row').click()
    await flushUi()
    const object1 = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-1')
    object1.value = 'material_extra'
    object1.dispatchEvent(new Event('input'))
    const fields1 = q<HTMLInputElement>(root, 'bridge-agent-suggestion-fields-1')
    fields1.value = `token=${SENTINEL.configSecret}, field_a`
    fields1.dispatchEvent(new Event('input'))
    await flushUi()

    const text = q<HTMLTextAreaElement>(root, 'bridge-agent-checklist-text')
    expect(text.value).not.toContain(SENTINEL.configSecret)
    expect(text.value).not.toContain('password=')
    expect(text.value).not.toContain('token=')
    expect(JSON.parse(text.value)).toEqual({
      schemaVersion: 1,
      operations: [{ op: 'add_readonly_field', objectName: 'material_extra', fieldKeys: ['field_a'] }],
    })
  })

  it('checklist export: copy button writes the exact JSON to the clipboard and shows a copied state', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
      objectInput.value = 'material_extra'
      objectInput.dispatchEvent(new Event('input'))
      await flushUi()

      q<HTMLButtonElement>(root, 'bridge-agent-checklist-export').click()
      await flushUi()
      q<HTMLButtonElement>(root, 'bridge-agent-checklist-copy').click()
      await flushUi()

      expect(writeText).toHaveBeenCalledTimes(1)
      const copiedText = String(writeText.mock.calls[0][0])
      expect(JSON.parse(copiedText)).toEqual({
        schemaVersion: 1,
        operations: [{ op: 'add_readonly_object', objectName: 'material_extra', fieldKeys: [] }],
      })
      expect(q(root, 'bridge-agent-checklist-copy-state').textContent).toMatch(/copied/i)
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (navigator as any).clipboard
    }
  })

  it('checklist export: a missing/non-functional clipboard API renders a failed-copy fallback message, never throwing', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()

    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = 'material_extra'
    objectInput.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-checklist-export').click()
    await flushUi()
    q<HTMLButtonElement>(root, 'bridge-agent-checklist-copy').click()
    await flushUi()

    expect(q(root, 'bridge-agent-checklist-copy-state').textContent).toMatch(/copy failed/i)
  })

  it('checklist export: download button creates an object URL for a values-free JSON blob, clicks a hidden anchor, and revokes the URL', async () => {
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const originalAnchorClick = HTMLAnchorElement.prototype.click
    const createObjectURLMock = vi.fn(() => 'blob:bridge-agent-checklist')
    const revokeObjectURLMock = vi.fn()
    const anchorClickMock = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock })
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: anchorClickMock })
    try {
      mockRoutes()
      const root = mountSection([bridgeSystem()])
      await flushUi()

      const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
      objectInput.value = 'material_extra'
      objectInput.dispatchEvent(new Event('input'))
      await flushUi()

      q<HTMLButtonElement>(root, 'bridge-agent-checklist-export').click()
      await flushUi()
      q<HTMLButtonElement>(root, 'bridge-agent-checklist-download').click()
      await flushUi()

      expect(createObjectURLMock).toHaveBeenCalledTimes(1)
      expect(anchorClickMock).toHaveBeenCalledTimes(1)
      const downloadedBlob = createObjectURLMock.mock.calls[0]?.[0] as Blob
      expect(downloadedBlob.type).toContain('application/json')
      const downloadedText = await readBlobText(downloadedBlob)
      expect(JSON.parse(downloadedText)).toEqual({
        schemaVersion: 1,
        operations: [{ op: 'add_readonly_object', objectName: 'material_extra', fieldKeys: [] }],
      })
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:bridge-agent-checklist')
    } finally {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
      Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: originalAnchorClick })
    }
  })

  it('zh copy: config-check card + suggestion builder render Chinese labels under zh-CN', async () => {
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      mockRoutes()
      const system = bridgeSystem()
      const root = mountSection([system])
      await flushUi()

      expect(root.textContent).toContain('配置校验')
      expect(q(root, 'bridge-agent-config-check-item-label-authMode').textContent).toContain('未显式声明')
      expect(root.textContent).toContain('变更建议 / 实施清单')

      const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
      objectInput.value = 'material_extra'
      objectInput.dispatchEvent(new Event('input'))
      await flushUi()
      const text = q<HTMLTextAreaElement>(root, 'bridge-agent-suggestion-text')
      expect(text.value).toContain('1. 对象：material_extra')

      // BA-APPLY-1: zh label for the export button + the JSON preview content is locale-agnostic
      // (values are identifier strings, not translated copy) but the surrounding hint text is zh.
      const exportButton = q<HTMLButtonElement>(root, 'bridge-agent-checklist-export')
      expect(exportButton.textContent).toContain('导出实施清单')
      exportButton.click()
      await flushUi()
      expect(root.textContent).toContain('机读实施清单')
      const checklistText = q<HTMLTextAreaElement>(root, 'bridge-agent-checklist-text')
      expect(JSON.parse(checklistText.value)).toEqual({
        schemaVersion: 1,
        operations: [{ op: 'add_readonly_object', objectName: 'material_extra', fieldKeys: [] }],
      })
    } finally {
      setLocale('en')
    }
  })

  it('task status: last-check reads 未探测/"Not probed yet" before any probe has run', async () => {
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    const lastCheck = q(root, `bridge-agent-task-last-check-${system.id}`)
    expect(lastCheck.getAttribute('data-result')).toBe('unknown')
    expect(lastCheck.textContent).toMatch(/not probed yet/i)
  })

  it('task status: last-check reflects FAIL after a failed probe, COARSE ONLY (never names the failed step)', async () => {
    mockRoutes({ objects: () => errorResponse(500, 'BRIDGE_AGENT_REQUEST_FAILED', SENTINEL.errorBody) })
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
    await flushUi()

    // The probe-evidence panel elsewhere on the page is allowed to name the step ("FAIL: Objects") —
    // but THIS card's own last-check line is scoped to the coarse PASS/FAIL/未探测 vocabulary only.
    const lastCheck = q(root, `bridge-agent-task-last-check-${system.id}`)
    expect(lastCheck.getAttribute('data-result')).toBe('fail')
    expect(lastCheck.textContent).toContain('FAIL')
    expect(lastCheck.textContent).not.toMatch(/objects/i)
  })

  it('task status: last-check reflects PASS after a successful BA-UI-2 probe run', async () => {
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
    await flushUi()

    const lastCheck = q(root, `bridge-agent-task-last-check-${system.id}`)
    expect(lastCheck.getAttribute('data-result')).toBe('pass')
    expect(lastCheck.textContent).toContain('PASS')
  })

  it('task status: renders the managed-by-scheduled-task guidance and the start/stop pointer, with ZERO control elements', async () => {
    mockRoutes()
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    const card = q<HTMLDivElement>(root, `bridge-agent-task-status-${system.id}`)
    const managed = q(root, `bridge-agent-task-managed-${system.id}`)
    const guidance = q(root, `bridge-agent-task-guidance-${system.id}`)

    expect(managed.textContent).toMatch(/Windows Scheduled Task/i)
    expect(guidance.textContent).toMatch(/runbook/i)
    expect(guidance.textContent).toMatch(/no start\/stop/i)

    // Hard bound: no control of any kind lives inside THIS card (scoped query — the sibling "Check
    // connection" / "One-click probe" buttons live earlier in the same per-system card and must not
    // be mistaken for a control belonging to the task-status surface).
    expect(card.querySelectorAll('button, input[type="button"], input[type="submit"]').length).toBe(0)
    // Belt-and-braces: no start/stop-shaped testid anywhere in the whole rendered tree.
    expect(root.querySelector(`[data-testid="bridge-agent-task-start-${system.id}"]`)).toBeNull()
    expect(root.querySelector(`[data-testid="bridge-agent-task-stop-${system.id}"]`)).toBeNull()
    expect(root.querySelector('[data-testid*="task-start"]')).toBeNull()
    expect(root.querySelector('[data-testid*="task-stop"]')).toBeNull()
  })

  it('task status: SENTINEL — no host/path/secret from mocked system/probe state ever reaches this card, success or failure', async () => {
    mockRoutes({
      test: () => jsonResponse({
        ok: false,
        connected: false,
        code: SENTINEL.hostileCode,
        message: SENTINEL.testMessage,
      }),
    })
    const system = bridgeSystem()
    const root = mountSection([system])
    await flushUi()

    q<HTMLButtonElement>(root, `bridge-agent-card-check-${system.id}`).click()
    await flushUi()
    q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
    await flushUi()

    const card = q<HTMLDivElement>(root, `bridge-agent-task-status-${system.id}`)
    const html = card.innerHTML
    const text = card.textContent || ''
    for (const [key, sentinel] of Object.entries(SENTINEL)) {
      expect(html.includes(sentinel), `task-status sentinel leak html: ${key}`).toBe(false)
      expect(text.includes(sentinel), `task-status sentinel leak text: ${key}`).toBe(false)
    }
    for (const fragment of ['SENTINEL-', 'Password=', 'token=', 'authorityCode=', '192.168.77.66', 'sharedsecret']) {
      expect(html.includes(fragment), `task-status sentinel fragment leaked: ${fragment}`).toBe(false)
    }
    // Coarse result only — this card degrades a hostile/unregistered health code the same as any
    // other failure, it never renders the code or message text.
    expect(q(root, `bridge-agent-task-last-check-${system.id}`).getAttribute('data-result')).toBe('fail')
  })

  it('zh copy: task status card renders bilingual guidance + coarse result labels under zh-CN', async () => {
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      mockRoutes()
      const system = bridgeSystem()
      const root = mountSection([system])
      await flushUi()

      expect(q(root, `bridge-agent-task-managed-${system.id}`).textContent).toContain('计划任务')
      expect(q(root, `bridge-agent-task-guidance-${system.id}`).textContent).toContain('runbook')
      expect(q(root, `bridge-agent-task-last-check-${system.id}`).textContent).toContain('未探测')

      q<HTMLButtonElement>(root, `bridge-agent-probe-${system.id}`).click()
      await flushUi()
      expect(q(root, `bridge-agent-task-last-check-${system.id}`).textContent).toContain('PASS')
    } finally {
      setLocale('en')
    }
  })

  // --- BA-APPLY-3: post-apply auto re-probe confirmation (design-lock §7 terminal state, refs #3746).
  // The FINAL rung. After an operator manually applies the exported checklist (form-A handoff), this
  // card re-reads the connector via the SAME read-only object/schema probe and confirms the expected
  // readonly objects/fields now appear. Read-only: no apply, no write, no start/stop, no credentials,
  // no new fetch. Confirmation is DERIVED from the probe (expected-name ∈ probed names), never assumed.
  it('BA-APPLY-3 re-probe confirm: an object present in the probe shows 已出现; a field absent from the probed schema shows 未出现; overall partial', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()
    // objects auto-load (material, bom); expand material so its schema (FItemID/FNumber/FName) is probed
    q<HTMLButtonElement>(root, 'bridge-agent-object-schema-toggle-material').click()
    await flushUi()
    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = 'material'
    objectInput.dispatchEvent(new Event('input'))
    const fieldsInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-fields-0')
    fieldsInput.value = 'FItemID, ghost_field'
    fieldsInput.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-reprobe-toggle').click()
    await flushUi()

    expect(q(root, 'bridge-agent-reprobe-status').getAttribute('data-status')).toBe('partial')
    expect(q(root, 'bridge-agent-reprobe-object').getAttribute('data-object-present')).toBe('yes')
    const fields = root.querySelectorAll('[data-testid="bridge-agent-reprobe-field"]')
    expect(fields.length).toBe(2)
    const present = Array.from(fields).find((f) => f.textContent?.includes('FItemID'))!
    const absent = Array.from(fields).find((f) => f.textContent?.includes('ghost_field'))!
    expect(present.getAttribute('data-field-present')).toBe('yes')
    expect(absent.getAttribute('data-field-present')).toBe('no')
  })

  it('BA-APPLY-3 re-probe confirm: an expected object NOT in the probe reports 未生效 (absent) — derived from the probe, never assumed applied', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()
    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = 'ghost_object' // absent from OBJECTS_PAYLOAD (material, bom)
    objectInput.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-reprobe-toggle').click()
    await flushUi()

    expect(q(root, 'bridge-agent-reprobe-status').getAttribute('data-status')).toBe('absent')
    expect(q(root, 'bridge-agent-reprobe-object').getAttribute('data-object-present')).toBe('no')
  })

  it('BA-APPLY-3 re-probe confirm: renders object/field names + present/absent only — no probe-payload SENTINEL value leaks', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()
    q<HTMLButtonElement>(root, 'bridge-agent-object-schema-toggle-material').click()
    await flushUi()
    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = 'material'
    objectInput.dispatchEvent(new Event('input'))
    const fieldsInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-fields-0')
    fieldsInput.value = 'FItemID'
    fieldsInput.dispatchEvent(new Event('input'))
    await flushUi()

    q<HTMLButtonElement>(root, 'bridge-agent-reprobe-toggle').click()
    await flushUi()

    const output = q(root, 'bridge-agent-reprobe-output')
    expect(output.textContent).toContain('material')
    expect(output.textContent).toContain('FItemID')
    expect(output.innerHTML).not.toContain(SENTINEL.objectExtra)
    expect(output.innerHTML).not.toContain(SENTINEL.schemaExtra)
  })

  it('BA-APPLY-3 re-probe confirm: pure client-side read of already-probed state — issues no apply/list/write/start-stop route and the confirm card exposes no action button', async () => {
    mockRoutes()
    const root = mountSection([bridgeSystem()])
    await flushUi()
    const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
    objectInput.value = 'material'
    objectInput.dispatchEvent(new Event('input'))
    await flushUi()

    apiFetchMock.mockClear()
    q<HTMLButtonElement>(root, 'bridge-agent-reprobe-toggle').click()
    await flushUi()

    const urls = apiFetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls.some((u) => /apply|checklist|write|start|stop|config/i.test(u))).toBe(false)
    const output = q(root, 'bridge-agent-reprobe-output')
    expect(output.querySelectorAll('button, input[type="button"], input[type="submit"]').length).toBe(0)
  })

  it('BA-APPLY-3 re-probe confirm: zh-CN renders Chinese apply-confirmation labels', async () => {
    const { setLocale } = useLocale()
    setLocale('zh-CN')
    try {
      mockRoutes()
      const root = mountSection([bridgeSystem()])
      await flushUi()
      const objectInput = q<HTMLInputElement>(root, 'bridge-agent-suggestion-object-0')
      objectInput.value = 'ghost_object'
      objectInput.dispatchEvent(new Event('input'))
      await flushUi()

      const toggle = q<HTMLButtonElement>(root, 'bridge-agent-reprobe-toggle')
      expect(toggle.textContent).toContain('复探测确认')
      toggle.click()
      await flushUi()

      expect(q(root, 'bridge-agent-reprobe-status').textContent).toContain('未生效')
      expect(q(root, 'bridge-agent-reprobe-object').textContent).toContain('未出现')
    } finally {
      setLocale('en')
    }
  })
})
