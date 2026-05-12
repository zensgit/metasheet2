import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

const apiFetchMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockIntegrationApi(): void {
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/integration/external-systems?')) {
      return jsonResponse([])
    }
    if (url === '/api/integration/staging/descriptors') {
      return jsonResponse([
        {
          id: 'standard_materials',
          name: 'Standard materials',
          fields: ['code', 'name'],
          fieldDetails: [
            { id: 'code', name: 'Code', type: 'text' },
            { id: 'name', name: 'Name', type: 'text' },
          ],
        },
        {
          id: 'bom_cleanse',
          name: 'BOM cleanse',
          fields: ['parentCode', 'childCode'],
          fieldDetails: [
            { id: 'parentCode', name: 'Parent code', type: 'text' },
            { id: 'childCode', name: 'Child code', type: 'text' },
          ],
        },
      ])
    }
    return jsonResponse({})
  })
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('IntegrationK3WiseSetupView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    mockIntegrationApi()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('keeps first-run K3 setup focused while folding expert controls', async () => {
    const View = (await import('../src/views/IntegrationK3WiseSetupView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('1. 接通 K3')
    expect(container.textContent).toContain('2. 准备多维表')
    expect(container.textContent).toContain('基础连接')
    expect(container.textContent).toContain('多维表清洗准备')
    expect(container.textContent).toContain('K3 单据模板')
    expect(container.textContent).toContain('K3 WISE 物料')
    expect(container.textContent).toContain('FNumber')
    expect(container.textContent).toContain('"Data"')
    expect(container.textContent).not.toContain('authorityCode')

    const advancedSections = Array.from(container.querySelectorAll('details.k3-setup__details')) as HTMLDetailsElement[]
    expect(advancedSections).toHaveLength(3)
    expect(advancedSections.every((section) => section.open === false)).toBe(true)

    const sideRailSections = Array.from(container.querySelectorAll('details.k3-setup__collapsible-panel')) as HTMLDetailsElement[]
    expect(sideRailSections).toHaveLength(2)
    expect(sideRailSections.every((section) => section.open === false)).toBe(true)
  })
})
