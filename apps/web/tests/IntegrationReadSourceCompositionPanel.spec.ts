import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp } from 'vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: vi.fn(),
}))

import IntegrationReadSourceCompositionPanel from '../src/components/integration/IntegrationReadSourceCompositionPanel.vue'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), { status, headers: { 'Content-Type': 'application/json' } })
}
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'Content-Type': 'application/json' } })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

async function waitUntil(condition: () => boolean, label: string, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()
  }
  throw new Error(`waitUntil timed out: ${label}`)
}

describe('IntegrationReadSourceCompositionPanel', () => {
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

  function mountPanel(): HTMLDivElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp({
      render: () => h(IntegrationReadSourceCompositionPanel, {
        scope: { tenantId: 'default', workspaceId: null },
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

  it('lists ONLY approved compositions on mount and disables run until a composition + key are set', async () => {
    const listUrls: string[] = []
    apiFetchMock.mockImplementation(async (url: string) => {
      listUrls.push(url)
      return jsonResponse([
        { id: 'rscc_1', name: 'material-to-bom', version: 2, status: 'approved', contentKey: 'ck', updatedAt: '2026-07-05' },
      ])
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rscc_1"]') !== null, 'composition list loads')

    expect(listUrls[0]).toBe('/api/integration/read-source-compositions?tenantId=default&status=approved')
    expect(q<HTMLButtonElement>(root, 'rscomp-run').disabled).toBe(true)

    setSelect(root, 'rscomp-select', 'rscc_1')
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'rscomp-run').disabled).toBe(true) // key still empty

    setInput(root, 'rscomp-key', 'MAT-001')
    await flushUi()
    expect(q<HTMLButtonElement>(root, 'rscomp-run').disabled).toBe(false)
  })

  it('renders the empty state when there are no approved compositions', async () => {
    apiFetchMock.mockImplementation(async () => jsonResponse([]))
    const root = mountPanel()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-empty"]') !== null, 'empty state renders')
    expect(q(root, 'rscomp-empty')).toBeTruthy()
  })

  it('run posts ONLY { inputs: { key } } and renders values-free success evidence + last-hop output', async () => {
    const runBodies: Array<Record<string, unknown>> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/read-source-compositions') && url.includes('/run')) {
        runBodies.push(JSON.parse(String(init?.body || '{}')))
        return jsonResponse({
          evidence: {
            ok: true,
            failedStep: null,
            steps: [
              { step: 0, ok: true, rule: 'exactly_one' },
              { step: 1, ok: true, rule: 'first_when_sorted' },
            ],
          },
          data: { resolver: { target: 'bom_number', value: 'BOM-2026-X' } },
        })
      }
      return jsonResponse([{ id: 'rscc_1', name: 'material-to-bom', version: 2, status: 'approved', contentKey: 'ck', updatedAt: '2026-07-05' }])
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rscc_1"]') !== null, 'composition list loads')
    setSelect(root, 'rscomp-select', 'rscc_1')
    setInput(root, 'rscomp-key', ' MAT-001 ')
    await flushUi()

    q<HTMLButtonElement>(root, 'rscomp-run').click()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-result"]') !== null, 'run result appears')

    expect(runBodies).toHaveLength(1)
    expect(runBodies[0]).toEqual({ inputs: { key: 'MAT-001' } })
    expect(Object.keys(runBodies[0])).toEqual(['inputs'])

    expect(q(root, 'rscomp-evidence-ok').textContent).toContain('ok: true')
    expect(q(root, 'rscomp-step-0').textContent).toContain('rule=exactly_one')
    expect(q(root, 'rscomp-step-1').textContent).toContain('rule=first_when_sorted')
    expect(q(root, 'rscomp-output-value').textContent).toContain('bom_number = BOM-2026-X')
  })

  it('renders a fail-closed run outcome values-free (failedStep + coarse errorCode + per-step vector)', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/run')) {
        return jsonResponse({
          evidence: {
            ok: false,
            failedStep: 0,
            steps: [
              { step: 0, ok: false, rule: 'exactly_one', errorCode: 'READ_SOURCE_RESOLVER_AMBIGUOUS' },
              { step: 1, ok: false, errorCode: 'READ_SOURCE_COMPOSITION_STEP_NOT_RUN' },
            ],
            errorCode: 'READ_SOURCE_COMPOSITION_STEP_FAILED',
          },
          data: null,
        })
      }
      return jsonResponse([{ id: 'rscc_1', name: 'material-to-bom', version: 2, status: 'approved', contentKey: 'ck', updatedAt: '2026-07-05' }])
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rscc_1"]') !== null, 'composition list loads')
    setSelect(root, 'rscomp-select', 'rscc_1')
    setInput(root, 'rscomp-key', 'MAT-001')
    await flushUi()

    q<HTMLButtonElement>(root, 'rscomp-run').click()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-result"]') !== null, 'run result appears')

    expect(q(root, 'rscomp-evidence-ok').textContent).toContain('ok: false')
    expect(q(root, 'rscomp-evidence-failed-step').textContent).toContain('failedStep: 0')
    expect(q(root, 'rscomp-evidence-error-code').textContent).toContain('READ_SOURCE_COMPOSITION_STEP_FAILED')
    expect(q(root, 'rscomp-step-1').textContent).toContain('READ_SOURCE_COMPOSITION_STEP_NOT_RUN')
    expect(root.querySelector('[data-testid="rscomp-output"]')).toBeNull()
  })

  it('surfaces a 409 approved-only gate as a coarse error without echoing the key', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/run')) return errorResponse(409, 'READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED', 'not approved')
      return jsonResponse([{ id: 'rscc_1', name: 'material-to-bom', version: 2, status: 'approved', contentKey: 'ck', updatedAt: '2026-07-05' }])
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rscc_1"]') !== null, 'composition list loads')
    setSelect(root, 'rscomp-select', 'rscc_1')
    setInput(root, 'rscomp-key', 'MAT-001')
    await flushUi()

    q<HTMLButtonElement>(root, 'rscomp-run').click()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-error"]') !== null, 'run error appears')

    const message = q(root, 'rscomp-error').textContent ?? ''
    expect(message).toContain('READ_SOURCE_COMPOSITION_CONFIG_NOT_APPROVED')
    expect(message.includes('MAT-001')).toBe(false)
  })

  it('switching the selected composition clears stale run results and errors', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/run')) {
        return jsonResponse({ evidence: { ok: true, failedStep: null, steps: [] }, data: { resolver: { target: 't', value: 'V' } } })
      }
      return jsonResponse([
        { id: 'rscc_1', name: 'a', version: 1, status: 'approved', contentKey: 'ck1', updatedAt: null },
        { id: 'rscc_2', name: 'b', version: 1, status: 'approved', contentKey: 'ck2', updatedAt: null },
      ])
    })
    const root = mountPanel()
    await waitUntil(() => root.querySelector('option[value="rscc_1"]') !== null, 'composition list loads')
    setSelect(root, 'rscomp-select', 'rscc_1')
    setInput(root, 'rscomp-key', 'MAT-001')
    await flushUi()

    q<HTMLButtonElement>(root, 'rscomp-run').click()
    await waitUntil(() => root.querySelector('[data-testid="rscomp-result"]') !== null, 'run result appears')

    setSelect(root, 'rscomp-select', 'rscc_2')
    await flushUi()
    expect(root.querySelector('[data-testid="rscomp-result"]')).toBeNull()
  })
})
