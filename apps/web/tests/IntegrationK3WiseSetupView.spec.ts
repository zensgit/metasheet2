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
    expect(container.textContent).toContain('Tenant ID（作用域）')
    expect(container.textContent).toContain('单租户实体机测试使用 default')
    expect(container.textContent).toContain('Workspace ID（可选）')
    expect(container.textContent).toContain('不要带 /K3API')
    expect(container.textContent).toContain('WebAPI 状态')
    expect(container.textContent).toContain('not saved')
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

    const baseUrlInput = Array.from(container.querySelectorAll('input')).find((input) => input.placeholder === 'http://k3-server:port') as HTMLInputElement
    baseUrlInput.value = 'http://k3.local/K3API/'
    baseUrlInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(container.textContent).toContain('当前 Base URL 含 /K3API')
  })

  it('sends tenant scope when testing the saved WebAPI system', async () => {
    const system = {
      id: 'k3_sys_1',
      tenantId: 'default',
      workspaceId: null,
      name: 'K3 WISE WebAPI',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
      hasCredentials: true,
      config: {
        version: 'K3 WISE 15.x',
        baseUrl: 'http://k3.local',
      },
      capabilities: {},
    }
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/integration/external-systems?kind=erp%3Ak3-wise-webapi')) {
        return jsonResponse([system])
      }
      if (url.startsWith('/api/integration/external-systems?kind=erp%3Ak3-wise-sqlserver')) {
        return jsonResponse([])
      }
      if (url === '/api/integration/external-systems/k3_sys_1/test') {
        const body = JSON.parse(String(init?.body || '{}'))
        expect(body).toMatchObject({
          tenantId: 'default',
          workspaceId: null,
          skipHealth: true,
        })
        return jsonResponse({
          ok: true,
          status: 200,
          authenticated: true,
          system: {
            ...system,
            lastTestedAt: '2026-05-12T10:00:00.000Z',
            lastError: null,
          },
        })
      }
      if (url === '/api/integration/staging/descriptors') {
        return jsonResponse([])
      }
      return jsonResponse({})
    })

    const View = (await import('../src/views/IntegrationK3WiseSetupView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.mount(container)
    await flushUi()

    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('测试 WebAPI')) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()
    await flushUi(8)

    expect(container.textContent).toContain('connected')
    expect(container.textContent).toContain('WebAPI 连接测试完成')
  })
})
