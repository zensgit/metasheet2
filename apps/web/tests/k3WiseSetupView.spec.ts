import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App as VueApp, type Component } from 'vue'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: mocks.apiFetch,
}))

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function setupIntegrationApiMock(): void {
  mocks.apiFetch.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/integration/external-systems?')) return jsonResponse([])
    if (path === '/api/integration/staging/descriptors') return jsonResponse([])
    throw new Error(`Unexpected integration API path: ${path}`)
  })
}

function findField(container: HTMLElement, labelText: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const label = Array.from(container.querySelectorAll('label')).find((candidate) => {
    return candidate.querySelector('span')?.textContent?.trim() === labelText
  })
  expect(label, `label ${labelText}`).not.toBeUndefined()
  const field = label?.querySelector('input, select, textarea') as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null
  expect(field, `field ${labelText}`).not.toBeNull()
  return field as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}

function setFieldValue(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('IntegrationK3WiseSetupView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let K3WiseSetupView: Component

  beforeEach(async () => {
    window.localStorage.clear()
    mocks.apiFetch.mockReset()
    setupIntegrationApiMock()
    K3WiseSetupView = (await import('../src/views/IntegrationK3WiseSetupView.vue')).default as Component
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('imports customer GATE JSON into the visible form without keeping pasted secrets', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)

    app = createApp(K3WiseSetupView)
    app.mount(container)
    await flushUi()

    for (const passwordField of Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[]) {
      setFieldValue(passwordField, 'stale-secret')
    }

    const textarea = container.querySelector('[data-testid="k3-wise-gate-import-textarea"]') as HTMLTextAreaElement | null
    expect(textarea).not.toBeNull()
    setFieldValue(textarea!, JSON.stringify({
      tenantId: 'tenant_customer',
      workspaceId: 'workspace_customer',
      projectId: 'project_customer',
      operator: 'customer-k3-admin',
      k3Wise: {
        version: 'K3 WISE 15.1',
        apiUrl: 'https://k3.example.test/K3API/',
        acctId: 1001,
        environment: '用户验收',
        autoSubmit: '否',
        autoAudit: 0,
        credentials: {
          username: 'k3-user',
          password: 'do-not-import',
        },
      },
      plm: {
        kind: 'plm:third-party',
        readMethod: '数据库',
        baseUrl: 'https://plm.example.test/',
        config: {
          defaultProductId: 'PRODUCT-001',
        },
        credentials: {
          username: 'plm-user',
          token: 'do-not-import-token',
        },
      },
      sqlServer: {
        enabled: '是',
        mode: 'middle table',
        server: 'sql-host',
        database: 'AIS_TEST',
        allowedTables: ['dbo.t_ICItem', 'dbo.t_MeasureUnit'],
        middleTables: 'dbo.integration_material_stage, dbo.integration_bom_stage',
        credentials: {
          username: 'sql-user',
          password: 'do-not-import-sql',
        },
      },
      rollback: {
        owner: 'rollback-owner',
        strategy: 'delete-test-records',
      },
      bom: {
        enabled: 1,
        productId: 'BOM-PRODUCT-001',
      },
    }))
    await flushUi()

    const importButton = container.querySelector('[data-testid="k3-wise-gate-import-button"]') as HTMLButtonElement | null
    expect(importButton).not.toBeNull()
    importButton?.click()
    await flushUi()

    expect(findField(container, 'Tenant ID').value).toBe('tenant_customer')
    expect(findField(container, 'Workspace ID').value).toBe('workspace_customer')
    expect(findField(container, 'K3 WISE 版本').value).toBe('K3 WISE 15.1')
    expect(findField(container, '环境').value).toBe('uat')
    expect(findField(container, 'WebAPI Base URL').value).toBe('https://k3.example.test/K3API/')
    expect(findField(container, 'Acct ID').value).toBe('1001')
    expect(findField(container, '用户名').value).toBe('k3-user')
    expect(findField(container, 'PLM Read Method').value).toBe('database')
    expect(findField(container, 'PLM Default Product ID').value).toBe('PRODUCT-001')
    expect(findField(container, 'PLM 用户名').value).toBe('plm-user')
    expect(findField(container, '模式').value).toBe('middle-table')
    expect(findField(container, 'Server').value).toBe('sql-host')
    expect(findField(container, 'Database').value).toBe('AIS_TEST')
    expect(findField(container, '中间表').value).toBe('dbo.integration_material_stage\ndbo.integration_bom_stage')
    expect(findField(container, 'BOM Product ID').value).toBe('BOM-PRODUCT-001')

    for (const passwordField of Array.from(container.querySelectorAll('input[type="password"]')) as HTMLInputElement[]) {
      expect(passwordField.value).toBe('')
    }

    const warnings = container.querySelector('[data-testid="k3-wise-gate-import-warnings"]')?.textContent || ''
    expect(warnings).toContain('k3Wise.credentials.password ignored')
    expect(warnings).toContain('plm.credentials.token ignored')
    expect(warnings).toContain('sqlServer.credentials.password ignored')
    expect(container.querySelector('[data-testid="k3-wise-status"]')?.textContent).toContain('GATE JSON 已导入')
  })
})
