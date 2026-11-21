/* eslint-disable vue/one-component-per-file -- Only presentation wrappers are registered for this parent/child integration test. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createPinia } from 'pinia'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import View from '../src/views/IntegrationWorkbenchView.vue'

// Composition authoring reads the same collection for its own picker. Its lifecycle is
// unrelated to this ConfigPanel startup, so keep that second reader out of this proof.
vi.mock('../src/components/integration/IntegrationReadSourceCompositionAuthoringPanel.vue', () => ({ default: { render: () => null } }))
vi.mock('../src/components/integration/IntegrationReadSourceCompositionPanel.vue', () => ({ default: { render: () => null } }))

// Real Workbench -> ConfigPanel -> list service -> apiFetch. Only browser transport and
// presentation wrappers are replaced; auth snapshots and both K3 run children are real.
const require = createRequire(import.meta.url)
const { buildK3WiseMaterialListB4Config } = require('../../../plugins/plugin-integration-core/lib/read-source-k3-material-list-b4-contract.cjs')
const { validateReadSourceConfig } = require('../../../plugins/plugin-integration-core/lib/read-source-config.cjs')
const SYSTEM_ID = 'synthetic-startup-k3'
const rows = [
  {
    id: 'startup-b4', systemId: SYSTEM_ID, object: 'material', mode: 'list_page',
    version: 7, status: 'approved', contentKey: 'synthetic-startup-b4',
    config: { ...buildK3WiseMaterialListB4Config({ systemId: SYSTEM_ID }), version: 7 },
  },
  {
    id: 'startup-bl2', systemId: SYSTEM_ID, object: 'material-bom-list', mode: 'resolver_lookup',
    version: 8, status: 'approved', contentKey: 'synthetic-startup-bl2',
    config: validateReadSourceConfig({
      version: 8, systemId: SYSTEM_ID, requiredKind: 'erp:k3-wise-webapi',
      object: 'material-bom-list', mode: 'resolver_lookup', readPath: '/K3API/BOM/GetList',
      readMethod: 'POST', operations: ['read'], keyField: 'FPercentItemID', keyEncoding: 'numeric_id',
      containerPaths: ['Data.DATA'], resolverRule: 'exactly_one',
      fieldMap: [{ source: 'FBOMNumber', target: 'bom_number' }],
    }).normalized,
  },
]

function response(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) { await Promise.resolve(); await nextTick() }
}

describe('real K3 workbench startup', () => {
  let app: App | undefined
  let root: HTMLDivElement
  let resolveFirstList: (value: Response) => void
  let listCalls: number
  const calls: Array<{ path: string; method: string }> = []
  const q = (id: string) => root.querySelector(`[data-testid="${id}"]`)
  const posts = () => calls.filter(({ method }) => method === 'POST')

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('auth_token', `synthetic.${btoa(JSON.stringify({ sub: 'synthetic-startup', tenantId: 'default' }))}.signature`)
    listCalls = 0
    calls.length = 0
    const firstList = new Promise<Response>((resolve) => { resolveFirstList = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input)
      calls.push({ path: url.pathname, method: init.method || 'GET' })
      if (url.pathname === '/api/integration/read-source-configs') {
        listCalls += 1
        return listCalls === 1 ? firstList : response(rows)
      }
      if (url.pathname === '/api/integration/external-systems') return response([{
        id: SYSTEM_ID, tenantId: 'default', workspaceId: null, name: 'Synthetic startup K3',
        kind: 'erp:k3-wise-webapi', role: 'source', status: 'active',
      }])
      return response([])
    }))
    root = document.createElement('div')
    document.body.appendChild(root)
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    root.remove()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  async function mount(permissions: string[], roles: string[] = []): Promise<void> {
    localStorage.setItem('user_permissions', JSON.stringify(permissions))
    localStorage.setItem('user_roles', JSON.stringify(roles))
    app = createApp(View)
    app.config.warnHandler = () => {}
    app.use(createPinia())
    app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: View }] }))
    app.component('ElCard', defineComponent({ setup(_props, { slots }) {
      return () => h('section', [slots.header?.(), slots.default?.()])
    } }))
    app.mount(root)
    await flush()
    expect(q('read-source-panel')).not.toBeNull()
    expect(listCalls).toBe(1)
    expect(q('rsc-row-startup-b4')).toBeNull()
  }

  function expectApprovedRows(admin: boolean): void {
    expect(q('rsc-row-startup-b4')).not.toBeNull()
    expect(q('rsc-row-startup-bl2')).not.toBeNull()
    expect(q('k3-b4-run-startup-b4')).not.toBeNull()
    expect(q('k3-bl2-run-startup-bl2')).not.toBeNull()
    expect((q('k3-b4-preview') as HTMLButtonElement).disabled).toBe(false)
    expect(Boolean(q('k3-b4-sync'))).toBe(admin)
    expect(listCalls).toBe(1)
    expect(posts()).toEqual([])
  }

  it.each([
    ['integration admin', ['integration:admin'], [], true],
    ['literal admin role', [], ['admin'], true],
    ['reader', ['integration:read'], [], false],
    ['broad user administration', ['users:write'], [], false],
  ] as const)('retains delayed initial approved B4/BL2 rows for %s without running POSTs', async (_name, permissions, roles, admin) => {
    await mount([...permissions], [...roles])
    resolveFirstList(response(rows))
    await flush()
    expectApprovedRows(admin)
  })

  it.each(['pending', 'displayed'] as const)('clears %s rows on admin withdrawal without automatically reading again', async (state) => {
    await mount(['integration:admin'])
    if (state === 'displayed') {
      resolveFirstList(response(rows))
      await flush()
      expectApprovedRows(true)
    }
    localStorage.setItem('user_permissions', JSON.stringify(['integration:read']))
    window.dispatchEvent(new StorageEvent('storage', { key: 'user_permissions' }))
    await flush()
    if (state === 'pending') { resolveFirstList(response(rows)); await flush() }
    expect(q('rsc-row-startup-b4')).toBeNull()
    expect(q('rsc-row-startup-bl2')).toBeNull()
    expect(q('k3-b4-sync')).toBeNull()
    expect(listCalls).toBe(1)
    expect(posts()).toEqual([])
  })
})
