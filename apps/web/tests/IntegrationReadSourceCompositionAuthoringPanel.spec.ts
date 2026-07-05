import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationReadSourceCompositionAuthoringPanel from '../src/components/integration/IntegrationReadSourceCompositionAuthoringPanel.vue'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
}

function errorResponse(error: unknown, status = 400): Response {
  return new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitUntil(condition: () => boolean, label: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

const SCOPE = { tenantId: 'default', workspaceId: null }

const APPROVED_RESOLVERS = [
  { id: 'rsc_item_resolver', systemId: 'k3', object: 'material', mode: 'resolver_lookup', version: 1, status: 'approved', contentKey: 'ck1', createdBy: null, updatedAt: null },
  { id: 'rsc_bom_resolver', systemId: 'k3', object: 'bom', mode: 'resolver_lookup', version: 2, status: 'approved', contentKey: 'ck2', createdBy: null, updatedAt: null },
  { id: 'rsc_detail', systemId: 'k3', object: 'material', mode: 'single_record', version: 1, status: 'approved', contentKey: 'ck3', createdBy: null, updatedAt: null },
  { id: 'rsc_draft_resolver', systemId: 'k3', object: 'draft', mode: 'resolver_lookup', version: 1, status: 'draft', contentKey: 'ck4', createdBy: null, updatedAt: null },
]

const COMPOSITIONS = [
  { id: 'rscc_draft', name: 'material-to-bom', version: 1, status: 'draft', contentKey: 'cc1', updatedAt: '2026-07-05' },
  { id: 'rscc_approved', name: 'approved-chain', version: 2, status: 'approved', contentKey: 'cc2', updatedAt: '2026-07-05' },
]

function baseMock(): void {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/integration/read-source-configs?tenantId=default&status=approved') {
      return jsonResponse(APPROVED_RESOLVERS)
    }
    if (url === '/api/integration/read-source-compositions?tenantId=default' && !init) {
      return jsonResponse(COMPOSITIONS)
    }
    return jsonResponse({})
  })
}

describe('IntegrationReadSourceCompositionAuthoringPanel', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.restoreAllMocks()
  })

  function mountPanel(): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(IntegrationReadSourceCompositionAuthoringPanel, {
        scope: SCOPE,
      }),
    })
    app.mount(container)
    return container
  }

  function q<T extends HTMLElement>(root: HTMLElement, testid: string): T {
    const el = root.querySelector<T>(`[data-testid="${testid}"]`)
    if (!el) throw new Error(`missing [data-testid=${testid}]`)
    return el
  }

  function setInput(root: HTMLElement, testid: string, value: string): void {
    const input = q<HTMLInputElement>(root, testid)
    input.value = value
    input.dispatchEvent(new Event('input'))
  }

  function setSelect(root: HTMLElement, testid: string, value: string): void {
    const select = q<HTMLSelectElement>(root, testid)
    select.value = value
    select.dispatchEvent(new Event('change'))
  }

  it('lists only approved resolver_lookup configs as composition steps', async () => {
    baseMock()
    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rsc_item_resolver"]') !== null, 'resolver configs load')

    expect(root.querySelector('option[value="rsc_item_resolver"]')).not.toBeNull()
    expect(root.querySelector('option[value="rsc_bom_resolver"]')).not.toBeNull()
    expect(root.querySelector('option[value="rsc_detail"]')).toBeNull()
    expect(root.querySelector('option[value="rsc_draft_resolver"]')).toBeNull()
    expect(root.querySelector('[data-testid="rscomp-author-row-rscc_draft"]')).not.toBeNull()
  })

  it('saves exactly the pinned composition config and cannot submit runtime keys or write-shaped fields', async () => {
    const postedBodies: Array<Record<string, unknown>> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/read-source-configs?tenantId=default&status=approved') return jsonResponse(APPROVED_RESOLVERS)
      if (url === '/api/integration/read-source-compositions?tenantId=default' && !init) return jsonResponse(COMPOSITIONS)
      if (url === '/api/integration/read-source-compositions?tenantId=default' && init?.method === 'POST') {
        postedBodies.push(JSON.parse(String(init.body || '{}')))
        return jsonResponse({ id: 'rscc_new', name: 'material-to-bom', version: 1, status: 'draft', contentKey: 'cc-new', updatedAt: '2026-07-05', reused: false }, 201)
      }
      return jsonResponse({})
    })

    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rsc_item_resolver"]') !== null, 'resolver configs load')
    setInput(root, 'rscomp-author-name', ' material-to-bom ')
    setSelect(root, 'rscomp-author-step1', 'rsc_item_resolver')
    setSelect(root, 'rscomp-author-step2', 'rsc_bom_resolver')
    setInput(root, 'rscomp-author-source-target', ' itemId ')
    await flushUi()

    q<HTMLButtonElement>(root, 'rscomp-author-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-author-save-result"]') !== null, 'save result')

    expect(postedBodies).toHaveLength(1)
    expect(Object.keys(postedBodies[0])).toEqual(['config'])
    expect(postedBodies[0]).toEqual({
      config: {
        version: 1,
        name: 'material-to-bom',
        operations: ['read'],
        steps: [
          { id: 'step-1', readSourceConfigId: 'rsc_item_resolver' },
          { id: 'step-2', readSourceConfigId: 'rsc_bom_resolver', input: { fromStep: 'step-1', sourceTarget: 'itemId', toInput: 'key' } },
        ],
      },
    })
    expect(JSON.stringify(postedBodies[0])).not.toContain('MAT-001')
    expect(JSON.stringify(postedBodies[0])).not.toContain('write')
  })

  it('renders CONFIG_INVALID field errors through the clamped values-free channel', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/read-source-configs?tenantId=default&status=approved') return jsonResponse(APPROVED_RESOLVERS)
      if (url === '/api/integration/read-source-compositions?tenantId=default' && !init) return jsonResponse(COMPOSITIONS)
      if (url === '/api/integration/read-source-compositions?tenantId=default' && init?.method === 'POST') {
        return errorResponse({
          code: 'READ_SOURCE_COMPOSITION_CONFIG_INVALID',
          message: 'bad config near MAT-001 SECRET',
          details: {
            reason: 'invalid_config',
            errors: [
              { code: 'READ_SOURCE_COMPOSITION_NAME_INVALID', field: 'name', reason: 'invalid_identifier' },
              { code: 'READ_SOURCE_COMPOSITION_STEP_INVALID', field: 'MAT-001 field', reason: 'invalid_reference' },
              { code: 'READ_SOURCE_COMPOSITION_STEP_REF_INVALID', field: 'steps.0.readSourceConfigId', reason: 'material MAT-001 SECRET' },
            ],
          },
        }, 400)
      }
      return jsonResponse({})
    })

    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rsc_item_resolver"]') !== null, 'resolver configs load')
    setInput(root, 'rscomp-author-name', 'material-to-bom')
    setSelect(root, 'rscomp-author-step1', 'rsc_item_resolver')
    setSelect(root, 'rscomp-author-step2', 'rsc_bom_resolver')
    setInput(root, 'rscomp-author-source-target', 'itemId')
    await flushUi()

    q<HTMLButtonElement>(root, 'rscomp-author-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-author-field-errors"]') !== null, 'field errors')

    expect(q(root, 'rscomp-author-error').textContent).toContain('READ_SOURCE_COMPOSITION_CONFIG_INVALID')
    expect(q(root, 'rscomp-author-field-errors').textContent).toContain('READ_SOURCE_COMPOSITION_NAME_INVALID')
    const text = root.textContent ?? ''
    expect(text).not.toContain('bad config near MAT-001 SECRET')
    expect(text).not.toContain('MAT-001 field')
    expect(text).not.toContain('material MAT-001 SECRET')
  })

  it('coarsens unexpected thrown errors instead of rendering raw messages', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/read-source-configs?tenantId=default&status=approved') return jsonResponse(APPROVED_RESOLVERS)
      if (url === '/api/integration/read-source-compositions?tenantId=default' && !init) return jsonResponse(COMPOSITIONS)
      if (url === '/api/integration/read-source-compositions?tenantId=default' && init?.method === 'POST') {
        throw new Error('transport failed near MAT-001 SECRET')
      }
      return jsonResponse({})
    })

    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rsc_item_resolver"]') !== null, 'resolver configs load')
    setInput(root, 'rscomp-author-name', 'material-to-bom')
    setSelect(root, 'rscomp-author-step1', 'rsc_item_resolver')
    setSelect(root, 'rscomp-author-step2', 'rsc_bom_resolver')
    setInput(root, 'rscomp-author-source-target', 'itemId')
    await flushUi()

    q<HTMLButtonElement>(root, 'rscomp-author-save').click()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-author-error"]')?.textContent?.includes('组合配置请求失败') === true, 'generic error')

    const text = root.textContent ?? ''
    expect(text).toContain('组合配置请求失败')
    expect(text).not.toContain('transport failed')
    expect(text).not.toContain('MAT-001 SECRET')
  })

  it('approves, retires, and renders audit rows without surfacing version or smuggled detail', async () => {
    const urls: string[] = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      urls.push(`${init?.method || 'GET'} ${url}`)
      if (url === '/api/integration/read-source-configs?tenantId=default&status=approved') return jsonResponse(APPROVED_RESOLVERS)
      if (url === '/api/integration/read-source-compositions?tenantId=default' && !init) return jsonResponse(COMPOSITIONS)
      if (url.endsWith('/approve?tenantId=default')) return jsonResponse({ ...COMPOSITIONS[0], status: 'approved' })
      if (url.endsWith('/retire?tenantId=default')) return jsonResponse({ ...COMPOSITIONS[1], status: 'retired' })
      if (url.endsWith('/audit?tenantId=default')) {
        return jsonResponse([
          { action: 'status_change', actor: 'user-1', detail: { from: 'draft', to: 'approved', secret: 'MAT-001 SECRET' }, createdAt: '2026-07-05T00:00:00Z' },
          { action: 'save_version', actor: null, detail: { version: 9, secret: 'LEAK' }, createdAt: '2026-07-05T00:01:00Z' },
          { action: 'raw_action', actor: 'x', detail: { secret: 'LEAK2' }, createdAt: '2026-07-05T00:02:00Z' },
        ])
      }
      return jsonResponse({})
    })

    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-author-row-rscc_draft"]') !== null, 'composition rows')

    q<HTMLButtonElement>(root, 'rscomp-author-approve-rscc_draft').click()
    await waitUntil(() => urls.some((url) => url.includes('/rscc_draft/approve')), 'approve call')
    q<HTMLButtonElement>(root, 'rscomp-author-retire-rscc_approved').click()
    await waitUntil(() => urls.some((url) => url.includes('/rscc_approved/retire')), 'retire call')
    q<HTMLButtonElement>(root, 'rscomp-author-audit-toggle-rscc_approved').click()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-author-audit-list"]')?.textContent?.includes('状态变更') === true, 'audit renders')

    const text = root.textContent ?? ''
    expect(text).toContain('draft→approved')
    expect(text).toContain('保存版本')
    for (const leak of ['MAT-001 SECRET', 'version', 'LEAK', 'LEAK2', 'raw_action']) {
      expect(text).not.toContain(leak)
    }
  })
})
