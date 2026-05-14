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
    if (url === '/api/integration/staging/install') {
      return jsonResponse({
        sheetIds: {
          plm_raw_items: 'sheet_plm_raw_items',
          standard_materials: 'sheet_standard_materials',
          bom_cleanse: 'sheet_bom_cleanse',
          integration_exceptions: 'sheet_integration_exceptions',
          integration_run_log: 'sheet_integration_run_log',
        },
        viewIds: {
          plm_raw_items: 'view_plm_raw_items',
          standard_materials: 'view_standard_materials',
          bom_cleanse: 'view_bom_cleanse',
          integration_exceptions: 'view_integration_exceptions',
          integration_run_log: 'view_integration_run_log',
        },
        openLinks: {
          plm_raw_items: '/multitable/sheet_plm_raw_items/view_plm_raw_items?baseId=base_k3',
          standard_materials: '/multitable/sheet_standard_materials/view_standard_materials?baseId=base_k3',
          bom_cleanse: '/multitable/sheet_bom_cleanse/view_bom_cleanse?baseId=base_k3',
          integration_exceptions: '/multitable/sheet_integration_exceptions/view_integration_exceptions?baseId=base_k3',
          integration_run_log: '/multitable/sheet_integration_run_log/view_integration_run_log?baseId=base_k3',
        },
        targets: [
          {
            id: 'standard_materials',
            name: 'Standard Materials',
            sheetId: 'sheet_standard_materials',
            viewId: 'view_standard_materials',
            baseId: 'base_k3',
            openLink: '/multitable/sheet_standard_materials/view_standard_materials?baseId=base_k3',
          },
          {
            id: 'bom_cleanse',
            name: 'BOM Cleanse',
            sheetId: 'sheet_bom_cleanse',
            viewId: 'view_bom_cleanse',
            baseId: 'base_k3',
            openLink: '/multitable/sheet_bom_cleanse/view_bom_cleanse?baseId=base_k3',
          },
        ],
        warnings: [],
      })
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

function registerRouterLinkStub(app: VueApp<Element>): void {
  app.component('router-link', {
    props: ['to'],
    template: '<a :href="to"><slot /></a>',
  })
}

function inputByLabel(container: HTMLElement, labelText: string): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find((item) => item.textContent?.includes(labelText))
  const input = label?.querySelector('input')
  if (!(input instanceof HTMLInputElement)) throw new Error(`input not found for label: ${labelText}`)
  return input
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
    registerRouterLinkStub(app)
    app.mount(container)
    await flushUi()

    const workbenchLink = container.querySelector('[data-testid="generic-workbench-link"]') as HTMLAnchorElement
    expect(workbenchLink?.getAttribute('href')).toBe('/integrations/workbench')
    expect(workbenchLink?.textContent).toContain('进入数据工厂')
    expect(container.textContent).toContain('K3 WISE 是数据工厂里的物料 / BOM 预设模板')
    expect(container.textContent).toContain('1. 接通 K3')
    expect(container.textContent).toContain('2. 准备多维表')
    expect(container.textContent).toContain('基础连接')
    expect(container.textContent).toContain('K3 WebAPI 快速预设')
    expect(container.textContent).toContain('Tenant ID（高级上下文）')
    expect(container.textContent).toContain('普通单租户部署可留空或使用 default')
    expect(container.textContent).toContain('Workspace ID（高级，可选）')
    expect(container.textContent).toContain('endpoint path 在高级设置中维护')
    expect(container.textContent).toContain('WebAPI 状态')
    expect(container.textContent).toContain('not saved')
    expect(container.textContent).toContain('高级 SQL Server 通道')
    expect(container.textContent).toContain('allowlist 表/视图')
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

    expect(container.textContent).toContain('当前 Base URL 和 endpoint path 都含 /K3API')
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
      if (url === '/api/integration/external-systems/k3_sys_1/test?tenantId=default') {
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
    registerRouterLinkStub(app)
    app.mount(container)
    await flushUi()

    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('测试 WebAPI')) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()
    await flushUi(8)

    expect(container.textContent).toContain('connected')
    expect(container.textContent).toContain('WebAPI 连接测试完成')
  })

  it('opens installed staging multitable sheets from the setup page', async () => {
    const View = (await import('../src/views/IntegrationK3WiseSetupView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    registerRouterLinkStub(app)
    app.mount(container)
    await flushUi()

    const projectInput = inputByLabel(container, 'Project ID')
    projectInput.value = 'k3-poc'
    projectInput.dispatchEvent(new Event('input', { bubbles: true }))
    const baseInput = inputByLabel(container, 'Base ID')
    baseInput.value = 'base_k3'
    baseInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('安装 Staging 多维表')) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    button.click()
    await flushUi(8)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/integration/staging/install', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"projectId":"k3-poc"'),
    }))
    expect(container.textContent).toContain('物料清洗')
    expect(container.textContent).toContain('BOM 清洗')
    expect(container.textContent).toContain('业务主要在这里修正物料编码')
    expect(container.textContent).not.toContain('sheet_standard_materials / view_standard_materials')

    const materialLink = container.querySelector('[data-testid="open-staging-standard_materials"]') as HTMLAnchorElement
    const bomLink = container.querySelector('[data-testid="open-staging-bom_cleanse"]') as HTMLAnchorElement
    expect(materialLink?.getAttribute('href')).toBe('/multitable/sheet_standard_materials/view_standard_materials?baseId=base_k3')
    expect(materialLink?.textContent).toContain('打开多维表')
    expect(bomLink?.getAttribute('href')).toBe('/multitable/sheet_bom_cleanse/view_bom_cleanse?baseId=base_k3')
  })
})
