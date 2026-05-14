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

async function flushUi(cycles = 5): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('IntegrationWorkbenchView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    apiFetchMock.mockReset()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('loads systems, object schemas, and previews a template payload', async () => {
    const previewBodies: Array<Record<string, unknown>> = []
    const pipelineBodies: Array<Record<string, unknown>> = []
    const runBodies: Array<{ url: string; body: Record<string, unknown> }> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['bidirectional'], supports: ['read', 'upsert'], advanced: false },
          { kind: 'erp:k3-wise-sqlserver', label: 'K3 WISE SQL Server Channel', roles: ['source', 'target'], supports: ['read'], advanced: true },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          { id: 'plm_1', tenantId: 'default', workspaceId: null, name: 'PLM Source', kind: 'http', role: 'source', status: 'active' },
          { id: 'k3_1', tenantId: 'default', workspaceId: null, name: 'K3 Target', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
          { id: 'crm_1', tenantId: 'default', workspaceId: null, name: 'CRM Bidirectional', kind: 'http', role: 'bidirectional', status: 'active' },
          { id: 'k3_sql', tenantId: 'default', workspaceId: null, name: 'K3 SQL Read Channel', kind: 'erp:k3-wise-sqlserver', role: 'source', status: 'active' },
        ])
      }
      if (url === '/api/integration/staging/descriptors') {
        return jsonResponse([
          { id: 'standard_materials', name: 'Standard Materials', fields: ['code', 'name'] },
        ])
      }
      if (url === '/api/integration/external-systems/plm_1/objects?tenantId=default') {
        return jsonResponse([{ name: 'materials', label: 'Materials', operations: ['read'] }])
      }
      if (url === '/api/integration/external-systems/plm_1/schema?tenantId=default&object=materials') {
        return jsonResponse({
          object: 'materials',
          fields: [
            { name: 'code', label: 'Code', type: 'string' },
            { name: 'name', label: 'Name', type: 'string' },
            { name: 'quantity', label: 'Quantity', type: 'number' },
          ],
        })
      }
      if (url === '/api/integration/external-systems/plm_1/test?tenantId=default') {
        return jsonResponse({
          ok: true,
          status: 200,
          system: {
            id: 'plm_1',
            tenantId: 'default',
            workspaceId: null,
            name: 'PLM Source',
            kind: 'http',
            role: 'source',
            status: 'active',
            lastTestedAt: '2026-05-12T00:00:00.000Z',
          },
        })
      }
      if (url === '/api/integration/external-systems/k3_1/objects?tenantId=default') {
        return jsonResponse([
          {
            name: 'material',
            label: 'K3 Material',
            source: 'documentTemplate',
            template: { id: 'k3wise.material.v1', bodyKey: 'Data', endpointPath: '/K3API/Material/Save' },
          },
        ])
      }
      if (url === '/api/integration/external-systems/k3_1/schema?tenantId=default&object=material') {
        return jsonResponse({
          object: 'material',
          template: { id: 'k3wise.material.v1', bodyKey: 'Data' },
          fields: [
            { name: 'FNumber', label: 'Material code', type: 'string', required: true },
            { name: 'FName', label: 'Material name', type: 'string', required: true },
            { name: 'FBaseUnitID', label: 'Base unit', type: 'string' },
            { name: 'FQty', label: 'Quantity', type: 'number', required: true },
          ],
        })
      }
      if (url === '/api/integration/external-systems/k3_1/test?tenantId=default') {
        return jsonResponse({
          ok: false,
          code: 'ERP_DOWN',
          message: 'ERP endpoint unavailable',
          system: {
            id: 'k3_1',
            tenantId: 'default',
            workspaceId: null,
            name: 'K3 Target',
            kind: 'erp:k3-wise-webapi',
            role: 'target',
            status: 'error',
            lastError: 'ERP endpoint unavailable',
          },
        })
      }
      if (url === '/api/integration/templates/preview') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        previewBodies.push(body)
        return jsonResponse({
          valid: true,
          payload: { Data: { FNumber: 'MAT-001', FName: 'Bolt', FBaseUnitID: 'Pcs' } },
          targetRecord: { FNumber: 'MAT-001', FName: 'Bolt', FBaseUnitID: 'Pcs' },
          errors: [],
          transformErrors: [],
          validationErrors: [],
          schemaErrors: [],
        })
      }
      if (url === '/api/integration/pipelines') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        pipelineBodies.push(body)
        return jsonResponse({
          id: 'pipe_1',
          tenantId: 'default',
          workspaceId: null,
          name: body.name || 'Workbench pipeline',
          sourceSystemId: 'plm_1',
          sourceObject: 'materials',
          targetSystemId: 'k3_1',
          targetObject: 'material',
          mode: 'manual',
          idempotencyKeyFields: ['code'],
          options: body.options || {},
          status: 'active',
        })
      }
      if (url === '/api/integration/pipelines/pipe_1/dry-run' || url === '/api/integration/pipelines/pipe_1/run') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        runBodies.push({ url, body })
        return jsonResponse({
          pipelineId: 'pipe_1',
          dryRun: url.endsWith('/dry-run'),
          metrics: url.endsWith('/dry-run')
            ? { rowsRead: 1, rowsCleaned: 1, rowsWritten: 0 }
            : { rowsRead: 1, rowsCleaned: 1, rowsWritten: 1 },
        })
      }
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe_1&limit=5') {
        return jsonResponse([
          {
            id: 'run_1',
            tenantId: 'default',
            workspaceId: null,
            pipelineId: 'pipe_1',
            mode: 'manual',
            status: 'succeeded',
            rowsRead: 1,
            rowsCleaned: 1,
            rowsWritten: 0,
            rowsFailed: 0,
            startedAt: '2026-05-12T00:00:00.000Z',
          },
        ])
      }
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe_1&status=open&limit=5') {
        return jsonResponse([
          {
            id: 'dl_1',
            tenantId: 'default',
            workspaceId: null,
            pipelineId: 'pipe_1',
            runId: 'run_1',
            errorCode: 'VALIDATION_FAILED',
            errorMessage: 'missing required code',
            status: 'open',
            createdAt: '2026-05-12T00:00:01.000Z',
          },
        ])
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      render() {
        return null
      },
    })
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('系统对接')
    expect(container.textContent).toContain('默认的通用系统对接页面')
    expect(container.textContent).toContain('HTTP API')
    expect(container.textContent).not.toContain('K3 WISE SQL Server Channel')
    expect(container.textContent).toContain('已隐藏 1 个高级连接')
    expect((container.querySelector('[data-testid="staging-sheet"]') as HTMLSelectElement).value).toBe('standard_materials')
    expect(Array.from((container.querySelector('[data-testid="source-system"]') as HTMLSelectElement).options).map((option) => option.textContent))
      .not.toContain('K3 SQL Read Channel · erp:k3-wise-sqlserver')

    ;(container.querySelector('[data-testid="show-advanced-connectors"]') as HTMLInputElement).click()
    await flushUi()
    expect(container.textContent).toContain('K3 WISE SQL Server Channel')
    expect(container.textContent).toContain('高级')
    expect(container.textContent).toContain('allowlist 表/视图读取或中间表写入')
    expect(Array.from((container.querySelector('[data-testid="source-system"]') as HTMLSelectElement).options).map((option) => option.textContent))
      .toContain('K3 SQL Read Channel · erp:k3-wise-sqlserver')

    const sourceSystemSelect = container.querySelector('[data-testid="source-system"]') as HTMLSelectElement
    const targetSystemSelect = container.querySelector('[data-testid="target-system"]') as HTMLSelectElement

    sourceSystemSelect.value = 'k3_sql'
    sourceSystemSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container.textContent).toContain('SQL read channel 作为来源，WebAPI Save channel 作为目标')

    sourceSystemSelect.value = 'crm_1'
    sourceSystemSelect.dispatchEvent(new Event('change'))
    targetSystemSelect.value = 'crm_1'
    targetSystemSelect.dispatchEvent(new Event('change'))
    await flushUi()
    expect(container.textContent).toContain('same system, different business object')

    sourceSystemSelect.value = 'plm_1'
    sourceSystemSelect.dispatchEvent(new Event('change'))
    targetSystemSelect.value = 'k3_1'
    targetSystemSelect.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container.textContent).toContain('可用')
    ;(container.querySelector('[data-testid="test-source-system"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(container.textContent).toContain('来源连接测试通过')
    expect(container.textContent).toContain('已连接')

    ;(container.querySelector('[data-testid="test-target-system"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(container.textContent).toContain('目标连接测试失败：ERP endpoint unavailable')
    expect(container.textContent).toContain('异常：ERP endpoint unavailable')

    ;(container.querySelector('[data-testid="load-source-objects"]') as HTMLButtonElement).click()
    await flushUi(8)
    ;(container.querySelector('[data-testid="load-target-objects"]') as HTMLButtonElement).click()
    await flushUi(8)

    expect((container.querySelector('[data-testid="source-field-0"]') as HTMLInputElement).value).toBe('code')
    expect((container.querySelector('[data-testid="target-field-0"]') as HTMLInputElement).value).toBe('FNumber')
    expect((container.querySelector('[data-testid="transform-fn-0"]') as HTMLSelectElement).value).toBe('trim')
    expect((container.querySelector('[data-testid="transform-fn-3"]') as HTMLSelectElement).value).toBe('toNumber')
    expect(container.textContent).toContain('Material code')

    const firstTransform = container.querySelector('[data-testid="transform-fn-0"]') as HTMLSelectElement
    firstTransform.value = 'upper'
    firstTransform.dispatchEvent(new Event('change'))

    const unitTransform = container.querySelector('[data-testid="transform-fn-2"]') as HTMLSelectElement
    unitTransform.value = 'dictMap'
    unitTransform.dispatchEvent(new Event('change'))
    await flushUi()
    const unitDict = container.querySelector('[data-testid="dict-map-2"]') as HTMLTextAreaElement
    unitDict.value = 'EA=Pcs\nKG=Kg'
    unitDict.dispatchEvent(new Event('input'))

    const quantityMin = container.querySelector('[data-testid="validation-min-3"]') as HTMLInputElement
    quantityMin.value = '0.000001'
    quantityMin.dispatchEvent(new Event('input'))
    await flushUi()

    ;(container.querySelector('[data-testid="preview-payload"]') as HTMLButtonElement).click()
    await flushUi()

    expect(previewBodies).toHaveLength(1)
    expect(previewBodies[0]).toMatchObject({
      template: {
        id: 'k3wise.material.v1',
        bodyKey: 'Data',
      },
      fieldMappings: [
        { sourceField: 'code', targetField: 'FNumber', transform: { fn: 'upper' }, validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
        { sourceField: 'uom', targetField: 'FBaseUnitID', transform: { fn: 'dictMap', map: { EA: 'Pcs', KG: 'Kg' } } },
        {
          sourceField: 'quantity',
          targetField: 'FQty',
          transform: { fn: 'toNumber' },
          validation: [{ type: 'required' }, { type: 'min', value: 0.000001 }],
        },
      ],
    })
    expect(container.textContent).toContain('"FNumber": "MAT-001"')
    expect(container.textContent).toContain('Payload 预览通过')

    ;(container.querySelector('[data-testid="save-pipeline"]') as HTMLButtonElement).click()
    await flushUi()

    expect(pipelineBodies).toHaveLength(1)
    expect(pipelineBodies[0]).toMatchObject({
      tenantId: 'default',
      sourceSystemId: 'plm_1',
      sourceObject: 'materials',
      targetSystemId: 'k3_1',
      targetObject: 'material',
      stagingSheetId: 'standard_materials',
      mode: 'manual',
      status: 'active',
      idempotencyKeyFields: ['code'],
      options: {
        target: {
          autoSubmit: false,
          autoAudit: false,
        },
        k3Template: {
          id: 'k3wise.material.v1',
          documentType: 'material',
        },
      },
    })
    expect((container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement).value).toBe('pipe_1')
    expect(container.textContent).toContain('Pipeline 已保存：pipe_1')

    ;(container.querySelector('[data-testid="run-dry-run"]') as HTMLButtonElement).click()
    await flushUi(16)
    expect(runBodies[0]).toEqual({
      url: '/api/integration/pipelines/pipe_1/dry-run',
      body: {
        tenantId: 'default',
        workspaceId: null,
        mode: 'manual',
        sampleLimit: 20,
      },
    })
    expect(container.textContent).toContain('Dry-run 已提交')
    expect(container.textContent).toContain('succeeded')
    expect(container.textContent).toContain('VALIDATION_FAILED')
    expect(container.textContent).toContain('1 runs / 1 open dead letters')

    ;(container.querySelector('[data-testid="allow-save-only-run"]') as HTMLInputElement).click()
    await flushUi()
    ;(container.querySelector('[data-testid="run-save-only"]') as HTMLButtonElement).click()
    await flushUi(16)
    expect(runBodies[1]).toEqual({
      url: '/api/integration/pipelines/pipe_1/run',
      body: {
        tenantId: 'default',
        workspaceId: null,
        mode: 'manual',
        sampleLimit: 20,
      },
    })
    expect(container.textContent).toContain('Save-only 推送已提交')
  })
})
