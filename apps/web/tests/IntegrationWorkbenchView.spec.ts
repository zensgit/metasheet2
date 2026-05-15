import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'

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

async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

describe('IntegrationWorkbenchView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalCreateObjectURL: typeof URL.createObjectURL | undefined
  let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined
  let originalAnchorClick: typeof HTMLAnchorElement.prototype.click | undefined
  let createObjectURLMock: ReturnType<typeof vi.fn>
  let revokeObjectURLMock: ReturnType<typeof vi.fn>
  let anchorClickMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    apiFetchMock.mockReset()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
    originalCreateObjectURL = URL.createObjectURL
    originalRevokeObjectURL = URL.revokeObjectURL
    originalAnchorClick = HTMLAnchorElement.prototype.click
    createObjectURLMock = vi.fn(() => 'blob:data-factory-cleansed-export')
    revokeObjectURLMock = vi.fn()
    anchorClickMock = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock })
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: anchorClickMock })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: originalAnchorClick })
    app = null
    container = null
  })

  it('loads systems, object schemas, and previews a template payload', async () => {
    const previewBodies: Array<Record<string, unknown>> = []
    const pipelineBodies: Array<Record<string, unknown>> = []
    const runBodies: Array<{ url: string; body: Record<string, unknown> }> = []
    const externalSystemBodies: Array<Record<string, unknown>> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['bidirectional'], supports: ['read', 'upsert'], advanced: false },
          { kind: 'erp:k3-wise-sqlserver', label: 'K3 WISE SQL Server Channel', roles: ['source', 'target'], supports: ['read'], advanced: true },
          { kind: 'metasheet:staging', label: 'MetaSheet staging multitable', roles: ['source'], supports: ['read'], advanced: false },
          { kind: 'metasheet:multitable', label: 'MetaSheet multitable', roles: ['target'], supports: ['testConnection', 'listObjects', 'getSchema', 'upsert'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          { id: 'plm_1', tenantId: 'default', workspaceId: null, name: 'PLM Source', kind: 'http', role: 'source', status: 'active' },
          { id: 'k3_1', tenantId: 'default', workspaceId: null, name: 'K3 Target', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
          { id: 'crm_1', tenantId: 'default', workspaceId: null, name: 'CRM Bidirectional', kind: 'http', role: 'bidirectional', status: 'active' },
          {
            id: 'k3_sql',
            tenantId: 'default',
            workspaceId: null,
            name: 'K3 SQL Read Channel',
            kind: 'erp:k3-wise-sqlserver',
            role: 'source',
            status: 'error',
            lastError: 'K3 WISE SQL Server channel requires an injected queryExecutor',
          },
        ])
      }
      if (url === '/api/integration/external-systems' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
        externalSystemBodies.push(body)
        return jsonResponse({
          id: body.id,
          tenantId: body.tenantId,
          workspaceId: body.workspaceId ?? null,
          projectId: body.projectId,
          name: body.name,
          kind: body.kind,
          role: body.role,
          status: body.status,
          config: body.config,
          capabilities: body.capabilities,
        })
      }
      if (url === '/api/integration/staging/descriptors') {
        return jsonResponse([
          { id: 'standard_materials', name: 'Standard Materials', fields: ['code', 'name'] },
          { id: 'bom_cleanse', name: 'BOM Cleanse', fields: ['parentCode', 'childCode', 'quantity'] },
          { id: 'integration_exceptions', name: 'Integration Exceptions', fields: ['errorCode', 'errorMessage'] },
        ])
      }
      if (url === '/api/integration/staging/install') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        expect(body).toMatchObject({
          tenantId: 'default',
          workspaceId: null,
          projectId: 'project_1',
          baseId: null,
        })
        return jsonResponse({
          sheetIds: {
            standard_materials: 'sheet_materials',
            bom_cleanse: 'sheet_bom',
          },
          viewIds: {
            standard_materials: 'view_materials',
            bom_cleanse: 'view_bom',
          },
          openLinks: {
            standard_materials: '/multitable/sheet_materials/view_materials',
            bom_cleanse: '/multitable/sheet_bom/view_bom',
          },
          targets: [
            {
              id: 'standard_materials',
              name: '物料清洗',
              sheetId: 'sheet_materials',
              viewId: 'view_materials',
              openLink: '/multitable/sheet_materials/view_materials',
            },
            {
              id: 'bom_cleanse',
              name: 'BOM 清洗',
              sheetId: 'sheet_bom',
              viewId: 'view_bom',
              openLink: '/multitable/sheet_bom/view_bom',
            },
          ],
          warnings: [],
        })
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
      if (url === '/api/integration/external-systems/metasheet_staging_project_1/objects?tenantId=default') {
        return jsonResponse([
          {
            name: 'standard_materials',
            label: '物料清洗',
            operations: ['read'],
            source: 'metasheet:staging',
            schema: [
              { name: 'code', label: 'code', type: 'string' },
              { name: 'name', label: 'name', type: 'string' },
              { name: 'uom', label: 'uom', type: 'string' },
              { name: 'quantity', label: 'quantity', type: 'number' },
            ],
          },
        ])
      }
      if (url === '/api/integration/external-systems/metasheet_staging_project_1/schema?tenantId=default&object=standard_materials') {
        return jsonResponse({
          object: 'standard_materials',
          raw: {
            sheetId: 'sheet_materials',
            viewId: 'view_materials',
            openLink: '/multitable/sheet_materials/view_materials',
          },
          fields: [
            { name: 'code', label: 'code', type: 'string' },
            { name: 'name', label: 'name', type: 'string' },
            { name: 'uom', label: 'uom', type: 'string' },
            { name: 'quantity', label: 'quantity', type: 'number' },
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
          preview: url.endsWith('/dry-run')
            ? {
                records: [
                  {
                    source: {
                      code: ' mat-001 ',
                      name: 'Bolt',
                      password: 'raw-source-secret',
                    },
                    transformed: {
                      FNumber: 'MAT-001',
                      FName: 'Bolt',
                      FQty: 2,
                    },
                    targetPayload: {
                      Data: {
                        FNumber: 'MAT-001',
                        FName: 'Bolt',
                      },
                    },
                    targetRequest: {
                      method: 'POST',
                      path: '/K3API/Material/Save',
                      query: {
                        access_token: 'raw-query-secret',
                      },
                    },
                  },
                ],
              }
            : null,
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
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('数据工厂')
    expect(container.textContent).toContain('连接新系统')
    expect(container.textContent).toContain('使用 K3 WISE 预设')
    expect(container.textContent).toContain('已加载 4 个连接 · 4 个适配器 · 3 个 staging 表')
    expect(container.textContent).toContain('连接系统')
    expect(container.textContent).toContain('选择数据集')
    expect(container.textContent).toContain('多维表清洗')
    expect(container.textContent).toContain('Dry-run / 推送')
    expect(container.textContent).toContain('数据集与多维表清洗')
    expect(container.textContent).toContain('发布 API 数据服务暂不开放')
    expect(container.textContent).toContain('物料清洗')
    expect(container.textContent).toContain('BOM 清洗')
    expect(container.textContent).toContain('回写区')
    expect(container.textContent).toContain('HTTP API')
    expect(container.textContent).toContain('MetaSheet multitable')
    expect(container.textContent).not.toContain('K3 WISE SQL Server Channel')
    expect(container.textContent).toContain('已隐藏 1 个高级连接')
    expect((container.querySelector('[data-testid="staging-sheet"]') as HTMLSelectElement).value).toBe('standard_materials')
    expect(Array.from((container.querySelector('[data-testid="source-system"]') as HTMLSelectElement).options).map((option) => option.textContent))
      .not.toContain('K3 SQL Read Channel · erp:k3-wise-sqlserver')

    ;(container.querySelector('[data-testid="toggle-inventory-overview"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container.textContent).toContain('已配置连接')
    expect(container.textContent).toContain('可用适配器')
    expect(container.textContent).toContain('SQL 连接已配置，但当前部署未注入 SQL 执行器')

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
    expect(container.textContent).toContain('暂不能作为可读 source 执行 dry-run')

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
    expect(container.textContent).toContain('数据源连接测试通过')
    expect(container.textContent).toContain('已连接')

    ;(container.querySelector('[data-testid="test-target-system"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(container.textContent).toContain('目标连接测试失败：ERP endpoint unavailable')
    expect(container.textContent).toContain('异常：ERP endpoint unavailable')

    const projectId = container.querySelector('[data-testid="staging-project-id"]') as HTMLInputElement
    projectId.value = 'project_1'
    projectId.dispatchEvent(new Event('input'))
    ;(container.querySelector('[data-testid="install-staging"]') as HTMLButtonElement).click()
    await flushUi(20)
    expect(container.textContent).toContain('清洗表已创建，并已自动设置 staging 多维表为 Dry-run 来源')
    expect((container.querySelector('[data-testid="open-staging-standard_materials"]') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/multitable/sheet_materials/view_materials')

    const stagingSourceButton = container.querySelector('[data-testid="use-staging-source-standard_materials"]') as HTMLButtonElement
    expect(stagingSourceButton.disabled).toBe(false)
    expect(externalSystemBodies).toHaveLength(1)
    expect(externalSystemBodies[0]).toMatchObject({
      id: 'metasheet_staging_project_1',
      tenantId: 'default',
      workspaceId: null,
      projectId: 'project_1',
      name: 'MetaSheet staging 多维表',
      kind: 'metasheet:staging',
      role: 'source',
      status: 'active',
      capabilities: {
        read: true,
        stagingSource: true,
        dryRunFriendly: true,
      },
    })
    expect(externalSystemBodies[0].config).toMatchObject({
      projectId: 'project_1',
      objects: {
        standard_materials: {
          sheetId: 'sheet_materials',
          viewId: 'view_materials',
          openLink: '/multitable/sheet_materials/view_materials',
          fields: ['code', 'name'],
        },
      },
    })
    expect((container.querySelector('[data-testid="source-system"]') as HTMLSelectElement).value).toBe('metasheet_staging_project_1')
    expect((container.querySelector('[data-testid="source-object"]') as HTMLSelectElement).value).toBe('standard_materials')
    expect(container.textContent).toContain('清洗表已创建，并已自动设置 staging 多维表为 Dry-run 来源')

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
      sourceSystemId: 'metasheet_staging_project_1',
      sourceObject: 'standard_materials',
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
    expect(container.textContent).toContain('已满足 dry-run 前置条件')

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
    expect(container.textContent).toContain('可导出 1 条 dry-run 清洗记录')

    ;(container.querySelector('[data-testid="export-cleansed-result"]') as HTMLButtonElement).click()
    await flushUi()
    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    expect(anchorClickMock).toHaveBeenCalledTimes(1)
    const exportedBlob = createObjectURLMock.mock.calls[0]?.[0] as Blob
    const exportedCsv = await readBlobText(exportedBlob)
    expect(exportedCsv).toContain('cleaned.FNumber')
    expect(exportedCsv).toContain('payload.Data.FNumber')
    expect(exportedCsv).toContain('MAT-001')
    expect(exportedCsv).not.toContain('raw-source-secret')
    expect(exportedCsv).not.toContain('raw-query-secret')
    expect(exportedCsv).toContain('[redacted]')
    expect(container.textContent).toContain('已导出 1 条清洗结果')
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:data-factory-cleansed-export')

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

    ;(container.querySelector('[data-testid="use-multitable-target-standard_materials"]') as HTMLButtonElement).click()
    await flushUi(10)
    expect(externalSystemBodies).toHaveLength(2)
    expect(externalSystemBodies[1]).toMatchObject({
      id: 'metasheet_target_project_1',
      tenantId: 'default',
      workspaceId: null,
      projectId: 'project_1',
      name: 'MetaSheet 目标多维表',
      kind: 'metasheet:multitable',
      role: 'target',
      status: 'active',
      capabilities: {
        write: true,
        multitableTarget: true,
        append: true,
        upsert: true,
      },
    })
    expect(externalSystemBodies[1].config).toMatchObject({
      projectId: 'project_1',
      objects: {
        standard_materials: {
          sheetId: 'sheet_materials',
          viewId: 'view_materials',
          openLink: '/multitable/sheet_materials/view_materials',
          fields: ['code', 'name'],
          keyFields: ['code'],
          mode: 'upsert',
        },
      },
    })
    expect((container.querySelector('[data-testid="target-system"]') as HTMLSelectElement).value).toBe('metasheet_target_project_1')
    expect((container.querySelector('[data-testid="target-object"]') as HTMLSelectElement).value).toBe('standard_materials')
    expect(container.textContent).toContain('已将 物料清洗 设为写回目标')
  })

  it('shows actionable source-empty and dry-run readiness guidance when no readable source exists', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'erp:k3-wise-webapi', label: 'K3 WISE WebAPI', roles: ['target'], supports: ['upsert'], advanced: false },
          { kind: 'erp:k3-wise-sqlserver', label: 'K3 WISE SQL Server Channel', roles: ['source'], supports: ['read'], advanced: true },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          { id: 'k3_target', tenantId: 'default', workspaceId: null, name: 'K3 Target', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
        ])
      }
      if (url === '/api/integration/staging/descriptors') {
        return jsonResponse([])
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('还没有可读取的数据源')
    expect(container.textContent).toContain('连接 PLM、HTTP API 或启用 SQL 只读通道')
    expect(container.textContent).toContain('还缺')
    expect(container.textContent).toContain('选择可读取的数据源')
    expect(container.textContent).toContain('Payload 预览通过不等于 pipeline dry-run')
    expect((container.querySelector('[data-testid="run-dry-run"]') as HTMLButtonElement).disabled).toBe(true)

    ;(container.querySelector('[data-testid="show-sql-setup"]') as HTMLButtonElement).click()
    await flushUi()
    expect((container.querySelector('[data-testid="show-advanced-connectors"]') as HTMLInputElement).checked).toBe(true)
    expect(container.textContent).toContain('SQL source 需要部署 allowlist queryExecutor 后才能读取')
  })

  it('does not mark error-state source or target systems as dry-run ready', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['source', 'target'], supports: ['read', 'upsert'], advanced: false },
          { kind: 'erp:k3-wise-webapi', label: 'K3 WISE WebAPI', roles: ['target'], supports: ['upsert'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          {
            id: 'plm_error',
            tenantId: 'default',
            workspaceId: null,
            name: 'PLM Source Error',
            kind: 'http',
            role: 'source',
            status: 'error',
            lastError: 'network timeout',
          },
          {
            id: 'k3_error',
            tenantId: 'default',
            workspaceId: null,
            name: 'K3 Target Error',
            kind: 'erp:k3-wise-webapi',
            role: 'target',
            status: 'error',
            lastError: 'ERP endpoint unavailable',
          },
        ])
      }
      if (url === '/api/integration/staging/descriptors') {
        return jsonResponse([])
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('异常：network timeout')
    expect(container.textContent).toContain('异常：ERP endpoint unavailable')
    expect(container.textContent).toContain('还缺')
    expect(container.textContent).not.toContain('已满足 dry-run 前置条件')
    expect((container.querySelector('[data-testid="run-dry-run"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('marks SQL Server source option as disabled when queryExecutor is missing', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'erp:k3-wise-sqlserver', label: 'K3 WISE SQL Server Channel', roles: ['source'], supports: ['read'], advanced: true },
          { kind: 'erp:k3-wise-webapi', label: 'K3 WISE WebAPI', roles: ['target'], supports: ['upsert'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          {
            id: 'k3_sql',
            tenantId: 'default',
            workspaceId: null,
            name: 'K3 SQL Read Channel',
            kind: 'erp:k3-wise-sqlserver',
            role: 'source',
            status: 'error',
            lastError: 'K3 WISE SQL Server channel requires an injected queryExecutor',
          },
          { id: 'k3_target', tenantId: 'default', workspaceId: null, name: 'K3 Target', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
        ])
      }
      if (url === '/api/integration/staging/descriptors') {
        return jsonResponse([])
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.mount(container)
    await flushUi()

    ;(container.querySelector('[data-testid="show-advanced-connectors"]') as HTMLInputElement).click()
    await flushUi()

    const sqlOption = container.querySelector('[data-testid="source-system-option-k3_sql"]') as HTMLOptionElement | null
    expect(sqlOption).not.toBeNull()
    expect(sqlOption!.disabled).toBe(true)
    expect(sqlOption!.getAttribute('data-disabled')).toBe('true')
    expect((container.querySelector('[data-testid="source-system"]') as HTMLSelectElement).value).toBe('')
    expect(container.querySelector('[data-testid="source-empty-state"]')?.textContent).toContain('还没有可读取的数据源')
    expect(container.querySelector('[data-testid="show-staging-setup"]')).not.toBeNull()

    expect(container.textContent).toContain('高级 SQL 通道未启用 / 需要部署侧注入 queryExecutor')
  })

  it('surfaces staging-creation CTA in source-empty and staging-empty when no readable source exists', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'metasheet:staging', label: 'MetaSheet staging multitable', roles: ['source'], supports: ['read'], advanced: false },
          { kind: 'erp:k3-wise-webapi', label: 'K3 WISE WebAPI', roles: ['target'], supports: ['upsert'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          { id: 'k3_target', tenantId: 'default', workspaceId: null, name: 'K3 Target', kind: 'erp:k3-wise-webapi', role: 'target', status: 'active' },
        ])
      }
      if (url === '/api/integration/staging/descriptors') {
        return jsonResponse([])
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default

    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.mount(container)
    await flushUi()

    const stagingCtaInSourceEmpty = container.querySelector('[data-testid="show-staging-setup"]') as HTMLButtonElement | null
    expect(stagingCtaInSourceEmpty).not.toBeNull()
    expect(stagingCtaInSourceEmpty!.textContent).toContain('创建 staging 多维表作为来源')

    const stagingEmpty = container.querySelector('[data-testid="staging-empty"]') as HTMLElement | null
    expect(stagingEmpty).not.toBeNull()
    expect(stagingEmpty!.textContent).toContain('填写下方 Project ID 后点击「创建清洗表」')
    const stagingFocusButton = stagingEmpty!.querySelector('[data-testid="staging-empty-focus-install"]') as HTMLButtonElement | null
    expect(stagingFocusButton).not.toBeNull()

    stagingCtaInSourceEmpty!.click()
    await flushUi()
    expect(container.textContent).toContain('创建 staging 多维表后即可在 staging 卡片上')
    expect((container.querySelector('[data-testid="inventory-overview"]'))).not.toBeNull()
  })
})
