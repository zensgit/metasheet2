import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App as VueApp, type Component } from 'vue'

const apiFetchMock = vi.fn()
const apiGetMock = vi.fn()

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiGet: (...args: unknown[]) => apiGetMock(...args),
}))

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rawJsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
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
  let originalConfirm: typeof window.confirm | undefined
  let createObjectURLMock: ReturnType<typeof vi.fn>
  let revokeObjectURLMock: ReturnType<typeof vi.fn>
  let anchorClickMock: ReturnType<typeof vi.fn>
  let confirmMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    apiFetchMock.mockReset()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
    originalCreateObjectURL = URL.createObjectURL
    originalRevokeObjectURL = URL.revokeObjectURL
    originalAnchorClick = HTMLAnchorElement.prototype.click
    originalConfirm = window.confirm
    createObjectURLMock = vi.fn(() => 'blob:data-factory-cleansed-export')
    revokeObjectURLMock = vi.fn()
    anchorClickMock = vi.fn()
    confirmMock = vi.fn(() => true)
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock })
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: anchorClickMock })
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirmMock })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, value: originalAnchorClick })
    Object.defineProperty(window, 'confirm', { configurable: true, value: originalConfirm })
    app = null
    container = null
  })

  it('loads systems, object schemas, and previews a template payload', async () => {
    const previewBodies: Array<Record<string, unknown>> = []
    const pipelineBodies: Array<Record<string, unknown>> = []
    const runBodies: Array<{ url: string; body: Record<string, unknown> }> = []
    const externalSystemBodies: Array<Record<string, unknown>> = []
    let dryRunPreviewMode: 'record' | 'empty' = 'record'
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
            lastError: 'SQLSERVER_EXECUTOR_MISSING: inject queryExecutor when creating K3WiseSqlServerChannel',
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
        const baseResult = {
          valid: true,
          payload: { Data: { FNumber: 'MAT-001', FName: 'Bolt', FBaseUnitID: 'Pcs' } },
          targetRecord: { FNumber: 'MAT-001', FName: 'Bolt', FBaseUnitID: 'Pcs' },
          errors: [],
          transformErrors: [],
          validationErrors: [],
          schemaErrors: [],
        }
        // Faithful to the backend: targetPayloadPreview is returned ONLY when the request carried a
        // payloadTemplate (the DF-T1 no-write preview path); the legacy preview omits it.
        if (body.payloadTemplate) {
          return jsonResponse({
            ...baseResult,
            targetPayloadPreview: {
              eligibleForSaveOnly: true,
              unresolvedPlaceholders: [],
              unresolvedReferenceComponents: [],
              missingRequiredFields: [],
              fieldProvenance: { FNumber: 'staging', FName: 'staging', FUnitGroupID: 'template', FErpClsID: 'reference_table' },
              compositionSource: 'k3-save-body-composer',
              redactionSelfCheck: { applied: true, clean: true },
            },
          })
        }
        return jsonResponse(baseResult)
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
            ? dryRunPreviewMode === 'empty'
              ? { rowsRead: 0, rowsCleaned: 0, rowsWritten: 0 }
              : { rowsRead: 1, rowsCleaned: 1, rowsWritten: 0 }
            : { rowsRead: 1, rowsCleaned: 1, rowsWritten: 1 },
          preview: url.endsWith('/dry-run')
            ? dryRunPreviewMode === 'empty'
              ? { records: [], errors: [] }
              : {
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
    expect(container.textContent).toContain('新增或管理连接')
    expect(container.textContent).toContain('使用 K3 WISE 预设')
    expect(container.textContent).toContain('已配置连接 4 个（可编辑 / 复制 / 停用 / 删除） · 4 个适配器 · 3 个 staging 表')
    expect(container.textContent).toContain('连接系统')
    expect(container.textContent).toContain('选择数据集')
    expect(container.textContent).toContain('多维表清洗')
    expect(container.textContent).toContain('Dry-run / 推送')
    expect(container.querySelector('[data-testid="data-factory-quick-flow"]')?.textContent)
      .toContain('选来源系统 -> 2. 选来源数据集')
    expect(container.textContent).toContain('选择系统与数据集')
    expect(container.textContent).toContain('1. 来源对象选择')
    expect(container.textContent).toContain('2. 目标模板选择')
    expect(container.textContent).toContain('数据集与多维表清洗')
    expect(container.textContent).toContain('一行就是一条清洗内容')
    expect(container.textContent).toContain('新增自定义清洗项')
    expect(container.textContent).toContain('运行与推送')
    expect(container.querySelector('[data-testid="run-push-explainer"]')?.textContent).toContain('Dry-run 只读取来源数据')
    expect(container.querySelector('[data-testid="run-push-explainer"]')?.textContent).toContain('默认不 Submit、不 Audit')
    expect(container.querySelector('[data-testid="run-push-explainer"]')?.textContent).toContain('dead letter')
    expect(container.textContent).toContain('保存清洗流程')
    expect(container.textContent).not.toContain('Pipeline 执行')
    expect(container.textContent).toContain('发布 API 数据服务暂不开放')
    expect(container.textContent).toContain('物料清洗')
    expect(container.textContent).toContain('BOM 清洗')
    expect(container.textContent).toContain('回写区')
    expect(container.textContent).toContain('HTTP API')
    expect(container.textContent).toContain('MetaSheet multitable')
    expect(container.textContent).not.toContain('K3 WISE SQL Server Channel')
    expect(container.textContent).toContain('已隐藏 1 个高级连接')
    expect((container.querySelector('[data-testid="staging-sheet"]') as HTMLSelectElement).value).toBe('standard_materials')
    expect((container.querySelector('[data-testid="save-pipeline"]') as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-testid="save-readiness-summary"]')?.textContent).toContain('选择来源数据集')
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
    // #2223: a stale `error` connection names the recovery action, so an operator retests it rather than
    // assuming the dry-run itself is broken.
    expect(container.textContent).toContain('点击"测试连接"重新激活')
    expect(container.textContent).toContain('不要手写 /grid 或 /spreadsheets/standard_materials')
    const refreshStagingLinkButton = container.querySelector('[data-testid="refresh-staging-link-standard_materials"]') as HTMLButtonElement
    expect(refreshStagingLinkButton.disabled).toBe(false)
    expect(refreshStagingLinkButton.textContent).toContain('生成打开链接')

    const projectId = container.querySelector('[data-testid="staging-project-id"]') as HTMLInputElement
    projectId.value = 'project_1'
    projectId.dispatchEvent(new Event('input'))
    ;(container.querySelector('[data-testid="install-staging"]') as HTMLButtonElement).click()
    await flushUi(20)
    expect(container.textContent).toContain('清洗表已创建，并已自动设置 staging 多维表为 Dry-run 来源')
    expect((container.querySelector('[data-testid="open-staging-standard_materials"]') as HTMLAnchorElement).getAttribute('href'))
      .toBe('/multitable/sheet_materials/view_materials')
    expect(container.textContent).toContain('使用此 /multitable 链接进入真正的多维表工具栏')

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

    ;(container.querySelector('[data-testid="use-staging-source-bom_cleanse"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect((container.querySelector('[data-testid="source-object"]') as HTMLSelectElement).value).toBe('bom_cleanse')
    const mismatchNotice = container.querySelector('[data-testid="source-target-mismatch-notice"]') as HTMLElement | null
    expect(mismatchNotice).not.toBeNull()
    expect(mismatchNotice!.textContent).toContain('目标模板')
    expect(mismatchNotice!.textContent).toContain('物料清洗')
    expect(mismatchNotice!.textContent).toContain('BOM 清洗')
    expect((container.querySelector('[data-testid="save-pipeline"]') as HTMLButtonElement).disabled).toBe(true)
    expect(container.querySelector('[data-testid="save-readiness-summary"]')?.textContent).toContain('确认来源与目标匹配')

    ;(container.querySelector('[data-testid="use-recommended-staging-source"]') as HTMLButtonElement).click()
    await flushUi(12)
    expect((container.querySelector('[data-testid="source-object"]') as HTMLSelectElement).value).toBe('standard_materials')
    expect(container.querySelector('[data-testid="source-target-mismatch-notice"]')).toBeNull()
    expect(container.textContent).toContain('已按目标模板切换到 物料清洗')

    expect((container.querySelector('[data-testid="source-field-0"]') as HTMLInputElement).value).toBe('code')
    expect((container.querySelector('[data-testid="target-field-0"]') as HTMLInputElement).value).toBe('FNumber')
    expect((container.querySelector('[data-testid="transform-fn-0"]') as HTMLSelectElement).value).toBe('trim')
    expect((container.querySelector('[data-testid="transform-fn-3"]') as HTMLSelectElement).value).toBe('toNumber')
    expect(container.querySelector('[data-testid="mapping-rule-list"]')?.textContent).toContain('code -> FNumber')
    expect(container.querySelector('[data-testid="mapping-summary-0"]')?.textContent).toContain('trim')
    expect(container.textContent).toContain('Material code')
    expect((container.querySelector('[data-testid="save-pipeline"]') as HTMLButtonElement).disabled).toBe(false)
    expect(container.querySelector('[data-testid="save-readiness-summary"]')?.textContent).toContain('已满足保存条件')
    expect(container.querySelector('[data-testid="pipeline-name-hint"]')?.textContent).toContain('留空自动生成')
    expect(container.querySelector('[data-testid="pipeline-mode-help"]')?.textContent).toContain('manual 手工触发')
    expect(container.querySelector('[data-testid="idempotency-fields-help"]')?.textContent).toContain('避免重复写入')
    expect(container.querySelector('[data-testid="pipeline-id-help"]')?.textContent).toContain('保存成功后自动回填')

    ;(container.querySelector('[data-testid="use-generated-pipeline-name"]') as HTMLButtonElement).click()
    await flushUi()
    const generatedName = (container.querySelector('[data-testid="pipeline-name"]') as HTMLInputElement).value
    expect(generatedName).toContain('MetaSheet staging 多维表:standard_materials')
    expect(generatedName).toContain('K3 Target:material')

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

    // DF-T1.5 reachability — Test 1 (legacy request unchanged): payloadTemplate was empty, so the
    // request stayed legacy and the provenance panel is ABSENT. The faithful mock returns
    // targetPayloadPreview only when the request carries payloadTemplate, so the panel cannot
    // render vacuously (this is the exact gap #1968's test had).
    expect(container.querySelector('[data-testid="preview-provenance"]')).toBeNull()

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
    // Test 1 (cont.): the legacy POST carried neither payloadTemplate nor fieldRules.
    expect(previewBodies[0]).not.toHaveProperty('payloadTemplate')
    expect(previewBodies[0]).not.toHaveProperty('fieldRules')

    // DF-T1.5 reachability — Test 2 (DF-T1 request is wired): fill the payloadTemplate JSON and
    // re-run preview → the POST carries payloadTemplate + fieldRules, the backend returns
    // targetPayloadPreview, and the provenance panel renders names + stats (never payload values).
    const payloadTemplateInput = container.querySelector('[data-testid="payload-template"]') as HTMLTextAreaElement
    payloadTemplateInput.value = JSON.stringify({ FNumber: '<code>', FName: '<name>', FUnitGroupID: { FNumber: '<n>', FName: '<u>' } })
    payloadTemplateInput.dispatchEvent(new Event('input'))
    await flushUi()
    ;(container.querySelector('[data-testid="preview-payload"]') as HTMLButtonElement).click()
    await flushUi()

    expect(previewBodies).toHaveLength(2)
    expect(previewBodies[1]).toHaveProperty('payloadTemplate')
    expect(previewBodies[1]).toHaveProperty('fieldRules')
    const wiredFieldRules = (previewBodies[1] as Record<string, unknown>).fieldRules as Array<Record<string, unknown>>
    expect(Array.isArray(wiredFieldRules)).toBe(true)
    expect(wiredFieldRules.length).toBeGreaterThan(0)
    expect(wiredFieldRules[0]).toMatchObject({ sourceType: 'from_staging', shape: 'scalar' })
    const wiredPanel = container.querySelector('[data-testid="preview-provenance"]') as HTMLElement | null
    expect(wiredPanel).not.toBeNull()
    const wiredText = wiredPanel?.textContent || ''
    expect(wiredText).toContain('FNumber')
    expect(wiredText).toContain('FUnitGroupID')
    expect(container.querySelector('[data-testid="preview-provenance-stats"]')?.textContent || '').toContain('暂存源: 2')
    // Secret hygiene: the provenance panel shows NO payload values.
    expect(wiredText).not.toContain('MAT-001')
    expect(wiredText).not.toContain('Bolt')
    expect(wiredText).not.toContain('Pcs')

    // (DF-T3b dual-binding picker has its own focused test below — it needs authored from_reference_table
    // rules, which this DF-T1 derive path does not produce.)

    // DF-T1.5 reachability — Test 3 (invalid payloadTemplate JSON blocks the request): no new POST
    // is made and an error is surfaced.
    payloadTemplateInput.value = '{ not valid json'
    payloadTemplateInput.dispatchEvent(new Event('input'))
    await flushUi()
    ;(container.querySelector('[data-testid="preview-payload"]') as HTMLButtonElement).click()
    await flushUi()
    expect(previewBodies).toHaveLength(2)
    expect(container.textContent).toContain('预览失败')

    // reset to legacy for the remainder of the test (pipeline save below is preview-independent)
    payloadTemplateInput.value = ''
    payloadTemplateInput.dispatchEvent(new Event('input'))
    await flushUi()

    ;(container.querySelector('[data-testid="save-pipeline"]') as HTMLButtonElement).click()
    await flushUi()

    expect(pipelineBodies).toHaveLength(1)
    expect(pipelineBodies[0]).toMatchObject({
      tenantId: 'default',
      name: generatedName,
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

    dryRunPreviewMode = 'empty'
    ;(container.querySelector('[data-testid="run-dry-run"]') as HTMLButtonElement).click()
    await flushUi(16)
    expect(runBodies[2]).toMatchObject({
      url: '/api/integration/pipelines/pipe_1/dry-run',
    })
    expect(container.textContent).toContain('Dry-run 成功，但本次没有可处理记录')
    expect(container.querySelector('[data-testid="dry-run-empty-preview-notice"]')?.textContent).toContain('来源数据集为空或过滤条件过严')
    expect(container.querySelector('[data-testid="cleansed-export-summary"]')?.textContent).toContain('没有可导出记录')

    ;(container.querySelector('[data-testid="use-multitable-target-standard_materials"]') as HTMLButtonElement).click()
    await flushUi(10)
    const multitableTargetBody = externalSystemBodies.find((body) => body.kind === 'metasheet:multitable')
    expect(multitableTargetBody).toMatchObject({
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
    expect(multitableTargetBody?.config).toMatchObject({
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
    expect(container.querySelector('[data-testid="save-readiness-summary"]')?.textContent).toContain('选择数据源系统')
    expect(container.textContent).toContain('Payload 预览通过不等于 pipeline dry-run')
    expect((container.querySelector('[data-testid="save-pipeline"]') as HTMLButtonElement).disabled).toBe(true)
    expect((container.querySelector('[data-testid="run-dry-run"]') as HTMLButtonElement).disabled).toBe(true)

    ;(container.querySelector('[data-testid="show-sql-setup"]') as HTMLButtonElement).click()
    await flushUi()
    expect((container.querySelector('[data-testid="show-advanced-connectors"]') as HTMLInputElement).checked).toBe(true)
    expect(container.textContent).toContain('SQL source 需要部署 allowlist queryExecutor 后才能读取')
  })

  it('explains source/target connector split and supports safe connection draft management', async () => {
    const upsertBodies: Array<Record<string, unknown>> = []
    const deleteUrls: string[] = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['source', 'target', 'bidirectional'], supports: ['read', 'upsert'], advanced: false },
          { kind: 'erp:k3-wise-webapi', label: 'K3 WISE WebAPI', roles: ['target'], supports: ['upsert'], advanced: false },
          { kind: 'erp:k3-wise-sqlserver', label: 'K3 WISE SQL Server Channel', roles: ['source'], supports: ['read'], advanced: true },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          {
            id: 'plm_source',
            tenantId: 'default',
            workspaceId: null,
            name: 'PLM Source',
            kind: 'http',
            role: 'source',
            status: 'active',
            config: { baseUrl: 'https://plm.example.test/api' },
            capabilities: { read: true },
          },
          {
            id: 'k3_target',
            tenantId: 'default',
            workspaceId: null,
            name: 'K3 Target',
            kind: 'erp:k3-wise-webapi',
            role: 'target',
            status: 'active',
            config: {
              baseUrl: 'http://k3.example.test/K3API/',
              objects: { material: { endpointPath: '/Material/Save' } },
            },
            capabilities: { write: true },
          },
          {
            id: 'k3_archived_target',
            tenantId: 'default',
            workspaceId: null,
            name: 'K3 Archived Target',
            kind: 'erp:k3-wise-webapi',
            role: 'target',
            status: 'inactive',
            config: { baseUrl: 'http://k3-archive.example.test/K3API/' },
            capabilities: { write: true },
          },
        ])
      }
      if (url === '/api/integration/external-systems' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
        upsertBodies.push(body)
        return jsonResponse({
          id: body.id || 'k3_target_copy',
          tenantId: body.tenantId,
          workspaceId: body.workspaceId ?? null,
          name: body.name,
          kind: body.kind,
          role: body.role,
          status: body.status,
          config: body.config,
          capabilities: body.capabilities,
        })
      }
      if (url === '/api/integration/external-systems/k3_target?tenantId=default' && init?.method === 'DELETE') {
        deleteUrls.push(url)
        return jsonResponse({
          deleted: true,
          system: {
            id: 'k3_target',
            tenantId: 'default',
            workspaceId: null,
            name: 'K3 Target',
            kind: 'erp:k3-wise-webapi',
            role: 'target',
            status: 'active',
          },
        })
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
    // eslint-disable-next-line vue/one-component-per-file
    app.component('RouterLink', {
      props: {
        to: {
          type: [String, Object],
          required: false,
          default: '',
        },
      },
      setup(_props, { slots }) {
        return () => h('a', slots.default?.())
      },
    })
    app.mount(container)
    await flushUi()

    const sourceOptions = Array.from((container.querySelector('[data-testid="source-system"]') as HTMLSelectElement).options).map((option) => option.textContent)
    const targetOptions = Array.from((container.querySelector('[data-testid="target-system"]') as HTMLSelectElement).options).map((option) => option.textContent)
    expect(sourceOptions).toContain('PLM Source · http')
    expect(sourceOptions).not.toContain('K3 Target · erp:k3-wise-webapi')
    expect(targetOptions).toContain('K3 Target · erp:k3-wise-webapi')
    expect(container.querySelector('[data-testid="source-selector-explanation"]')?.textContent).toContain('当前 K3 WISE WebAPI 仅作为目标写入连接')
    expect(container.querySelector('[data-testid="k3-webapi-read-gate-notice"]')?.textContent).toContain('来源侧请使用 staging 多维表、SQL 只读通道或其他可读连接')
    expect(container.querySelector('[data-testid="target-selector-explanation"]')?.textContent).toContain('Save-only')

    ;(container.querySelector('[data-testid="toggle-inventory-overview"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container.textContent).toContain('在这里编辑、复制、停用 / 启用或删除连接')
    const deleteButton = container.querySelector('[data-testid="delete-connection-k3_target"]') as HTMLButtonElement
    expect(deleteButton.disabled).toBe(false)
    expect(deleteButton.textContent).toContain('删除')

    ;(container.querySelector('[data-testid="copy-connection-k3_target"]') as HTMLButtonElement).click()
    await flushUi()
    expect((container.querySelector('[data-testid="connection-draft-name"]') as HTMLInputElement).value).toBe('K3 Target copy')
    expect((container.querySelector('[data-testid="connection-draft-status"]') as HTMLSelectElement).value).toBe('inactive')
    expect(container.querySelector('[data-testid="connection-duplicate-warning"]')?.textContent).toContain('已有同类型同角色连接')

    ;(container.querySelector('[data-testid="save-connection-draft"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(upsertBodies[0]).toMatchObject({
      tenantId: 'default',
      workspaceId: null,
      name: 'K3 Target copy',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'inactive',
      config: {
        baseUrl: 'http://k3.example.test/K3API/',
      },
      capabilities: {
        write: true,
      },
    })
    expect(container.textContent).toContain('连接已保存：K3 Target copy')

    ;(container.querySelector('[data-testid="edit-connection-k3_target"]') as HTMLButtonElement).click()
    await flushUi()
    const draftName = container.querySelector('[data-testid="connection-draft-name"]') as HTMLInputElement
    draftName.value = 'K3 Target Edited'
    draftName.dispatchEvent(new Event('input', { bubbles: true }))
    ;(container.querySelector('[data-testid="save-connection-draft"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(upsertBodies[1]).toMatchObject({
      id: 'k3_target',
      name: 'K3 Target Edited',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
    })

    ;(container.querySelector('[data-testid="deactivate-connection-plm_source"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(upsertBodies[2]).toMatchObject({
      id: 'plm_source',
      name: 'PLM Source',
      kind: 'http',
      role: 'source',
      status: 'inactive',
    })
    expect(container.textContent).toContain('连接已停用：PLM Source')

    ;(container.querySelector('[data-testid="activate-connection-k3_archived_target"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(upsertBodies[3]).toMatchObject({
      id: 'k3_archived_target',
      name: 'K3 Archived Target',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
    })
    expect(container.textContent).toContain('连接已启用：K3 Archived Target')

    ;(container.querySelector('[data-testid="delete-connection-k3_target"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('删除连接'))
    expect(deleteUrls).toEqual(['/api/integration/external-systems/k3_target?tenantId=default'])
    expect(container.textContent).toContain('连接已删除：K3 Target Edited')
    expect(container.textContent).not.toContain('K3 Target · erp:k3-wise-webapi')
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

  it('#2232: enables the run buttons for a pasted existing pipeline ID even when the build checklist is incomplete', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['source', 'target'], supports: ['read', 'upsert'], advanced: false },
          { kind: 'erp:k3-wise-webapi', label: 'K3 WISE WebAPI', roles: ['target'], supports: ['upsert'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          { id: 'plm_1', tenantId: 'default', workspaceId: null, name: 'PLM Source', kind: 'http', role: 'source', status: 'active' },
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

    // Mirror the #2205 re-run flow: a source is selected (mid-build, NOT a blank form), but the rest of the
    // build checklist (target system/object, mapping rules, idempotency fields) is intentionally left unset.
    const sourceSystemSelect = container.querySelector('[data-testid="source-system"]') as HTMLSelectElement
    sourceSystemSelect.value = 'plm_1'
    sourceSystemSelect.dispatchEvent(new Event('change'))
    await flushUi()

    const runDryRunButton = container.querySelector('[data-testid="run-dry-run"]') as HTMLButtonElement
    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement

    // The BUILD checklist is genuinely incomplete (this is what makes the test discriminate against the old
    // full-checklist gate), yet without a pipeline ID the run buttons stay disabled.
    expect(container.querySelector('[data-testid="dry-run-readiness-summary"]')?.textContent).toContain('还缺')
    const unreadyBefore = Array.from(container.querySelectorAll('[data-testid="pipeline-readiness"] li[data-ready="false"]'))
    expect(unreadyBefore.length).toBeGreaterThan(0)
    expect(runDryRunButton.disabled).toBe(true)

    // Paste an existing pipeline ID (server already holds its target/mapping/idempotency) → run-dry-run enables
    // even though the build checklist is still incomplete.
    pipelineIdInput.value = '485b1a40-0000-0000-0000-000000002205'
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    expect(container.querySelector('[data-testid="dry-run-readiness-summary"]')?.textContent).toContain('还缺')
    expect(runDryRunButton.disabled).toBe(false)

    // The danger save-only run button gates additionally on the explicit allow-toggle, but the pipeline-ID gate
    // is likewise decoupled from the build checklist: ticking allow enables it.
    const runSaveOnlyButton = container.querySelector('[data-testid="run-save-only"]') as HTMLButtonElement
    expect(runSaveOnlyButton.disabled).toBe(true)
    ;(container.querySelector('[data-testid="allow-save-only-run"]') as HTMLInputElement).click()
    await flushUi()
    expect(runSaveOnlyButton.disabled).toBe(false)

    // Clearing the pipeline ID re-disables both run buttons (empty ID → no run target).
    pipelineIdInput.value = '   '
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect(runDryRunButton.disabled).toBe(true)
    expect(runSaveOnlyButton.disabled).toBe(true)
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

    expect(container.textContent).toContain('高级 SQL 通道未启用 / SQLSERVER_EXECUTOR_MISSING / 需要部署侧注入 queryExecutor')
    expect(container.textContent).toContain('SQLSERVER_EXECUTOR_MISSING')
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
    expect(stagingEmpty!.textContent).toContain('点击「创建清洗表」即可生成 staging 多维表')
    const stagingFocusButton = stagingEmpty!.querySelector('[data-testid="staging-empty-focus-install"]') as HTMLButtonElement | null
    expect(stagingFocusButton).not.toBeNull()

    stagingCtaInSourceEmpty!.click()
    await flushUi()
    expect(container.textContent).toContain('创建 staging 多维表后即可在 staging 卡片上')
    expect((container.querySelector('[data-testid="inventory-overview"]'))).not.toBeNull()
  })

  it('warns and one-click normalizes a non-integration-scoped staging project ID', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'metasheet:staging', label: 'MetaSheet staging multitable', roles: ['source'], supports: ['read'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([])
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

    const projectIdInput = container.querySelector('[data-testid="staging-project-id"]') as HTMLInputElement
    const scopeStatus = container.querySelector('[data-testid="staging-project-id-scope-status"]') as HTMLElement
    expect(container.querySelector('[data-testid="staging-project-id-scope-warning"]')).toBeNull()
    expect(scopeStatus.textContent).toContain('default:integration-core')

    projectIdInput.value = 'project_default'
    projectIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    projectIdInput.dispatchEvent(new Event('change', { bubbles: true }))
    projectIdInput.dispatchEvent(new Event('blur', { bubbles: true }))
    await flushUi()

    const warning = container.querySelector('[data-testid="staging-project-id-scope-warning"]') as HTMLElement | null
    expect(warning).not.toBeNull()
    expect(warning!.textContent).toContain('不是 integration 作用域')
    expect(scopeStatus.textContent).toContain('当前为非 integration 作用域：project_default')

    ;(container.querySelector('[data-testid="normalize-staging-project-id"]') as HTMLButtonElement).click()
    await flushUi()

    expect(projectIdInput.value).toBe('project_default:integration-core')
    expect(container.querySelector('[data-testid="staging-project-id-scope-warning"]')).toBeNull()
    expect(scopeStatus.textContent).toContain('project_default:integration-core')
    expect(container.textContent).toContain('Project ID 已规范化为 project_default:integration-core')

    projectIdInput.value = ''
    projectIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    projectIdInput.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    expect(container.querySelector('[data-testid="staging-project-id-scope-warning"]')).toBeNull()
    expect(scopeStatus.textContent).toContain('default:integration-core')
  })

  it('renders run monitoring with row-level results and confirm-gated dead-letter replay', async () => {
    const replayBodies: Array<Record<string, unknown>> = []
    let deadLetterFetches = 0
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      // onMounted bootstrap (refreshBootstrap)
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      // monitoring reads
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe_mon&limit=5') {
        return jsonResponse([
          {
            id: 'run_mon_1',
            tenantId: 'default',
            workspaceId: null,
            pipelineId: 'pipe_mon',
            mode: 'manual',
            triggeredBy: 'api',
            status: 'partial',
            rowsRead: 3,
            rowsCleaned: 3,
            rowsWritten: 2,
            rowsFailed: 1,
            durationMs: 1200,
            startedAt: '2026-05-26T01:00:00.000Z',
            finishedAt: '2026-05-26T01:00:01.200Z',
            errorSummary: '1 row failed validation',
            details: {
              watermarkAdvanced: false,
              targetWriteSummaries: [
                { code: 'MAT-001', result: 'ok', targetId: 'K3-9001' },
                { code: 'MAT-002', result: 'ok', targetId: 'K3-9002' },
              ],
            },
          },
        ])
      }
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe_mon&status=open&limit=5') {
        deadLetterFetches += 1
        // After replay, the letter leaves the open list.
        if (deadLetterFetches >= 2) return jsonResponse([])
        return jsonResponse([
          {
            id: 'dl_mon_1',
            tenantId: 'default',
            workspaceId: null,
            pipelineId: 'pipe_mon',
            runId: 'run_mon_1',
            idempotencyKey: 'MAT-003',
            errorCode: 'VALIDATION_FAILED',
            errorMessage: 'missing name',
            retryCount: 0,
            status: 'open',
          },
        ])
      }
      if (url === '/api/integration/dead-letters/dl_mon_1/replay') {
        expect(init?.method).toBe('POST')
        replayBodies.push(JSON.parse(String(init?.body)))
        return jsonResponse({
          deadLetter: { id: 'dl_mon_1', status: 'replayed' },
          replay: { run: { id: 'run_mon_2' }, metrics: { rowsWritten: 1, rowsFailed: 0 } },
        })
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

    // Stage-5 term (renamed from 运行观察).
    expect(container.textContent).toContain('运行监控')

    // Point monitoring at an existing pipeline, then refresh.
    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    pipelineIdInput.value = 'pipe_mon'
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()

    // Run row surfaces status + emphasized write/fail counts.
    const runRow = container.querySelector('[data-testid="pipeline-run-run_mon_1"]') as HTMLElement
    expect(runRow).not.toBeNull()
    expect(runRow.textContent).toContain('partial')
    expect(runRow.textContent).toContain('write 2')
    expect(runRow.textContent).toContain('fail 1')

    // Row-level results are collapsed by default, then expandable.
    expect(container.querySelector('[data-testid="run-row-summaries-run_mon_1"]')).toBeNull()
    ;(container.querySelector('[data-testid="toggle-run-summaries-run_mon_1"]') as HTMLButtonElement).click()
    await flushUi()
    const summaries = container.querySelector('[data-testid="run-row-summaries-run_mon_1"]') as HTMLElement
    expect(summaries).not.toBeNull()
    expect(summaries.textContent).toContain('K3-9001')
    expect(summaries.textContent).toContain('MAT-002')

    // Open dead-letter shows as retryable.
    expect(container.querySelector('[data-testid="dead-letter-dl_mon_1"]')).not.toBeNull()
    expect((container.querySelector('[data-testid="dead-letter-retryable-dl_mon_1"]') as HTMLElement).textContent).toContain('可重放')

    // Replay requires a two-step confirm: prepare click does NOT POST.
    const prepareBtn = container.querySelector('[data-testid="replay-dead-letter-dl_mon_1"]') as HTMLButtonElement
    expect(prepareBtn).not.toBeNull()
    expect(container.querySelector('[data-testid="confirm-replay-dead-letter-dl_mon_1"]')).toBeNull()
    prepareBtn.click()
    await flushUi()
    expect(replayBodies).toHaveLength(0)

    // Confirm click POSTs to the existing replay route with the scoped body.
    const confirmBtn = container.querySelector('[data-testid="confirm-replay-dead-letter-dl_mon_1"]') as HTMLButtonElement
    expect(confirmBtn).not.toBeNull()
    confirmBtn.click()
    // Replay → success status → finally awaits refreshPipelineObservation (two
    // parallel fetches + re-render); drain the full async chain.
    await flushUi(15)
    expect(replayBodies).toEqual([{ tenantId: 'default', workspaceId: null, mode: 'manual' }])

    // Observation reloaded after replay; the replayed letter left the open list.
    expect(deadLetterFetches).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('[data-testid="dead-letter-dl_mon_1"]')).toBeNull()
    expect(container.textContent).toContain('Replay 成功')
  })

  it('expands a dead-letter into a read-only cross-run provenance timeline (fires by-rowId GET with rowId+pipelineId)', async () => {
    const provenanceCalls: Array<{ url: string; method?: string }> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe_prov&limit=5') return jsonResponse([])
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe_prov&status=open&limit=5') {
        return jsonResponse([
          {
            id: 'dl_prov_1',
            tenantId: 'default',
            workspaceId: null,
            pipelineId: 'pipe_prov',
            runId: 'run_prov_2',
            idempotencyKey: 'MAT-777',
            errorCode: 'VALIDATION_FAILED',
            errorMessage: 'missing name',
            status: 'open',
          },
        ])
      }
      if (url.startsWith('/api/integration/provenance')) {
        provenanceCalls.push({ url, method: init?.method })
        // Cross-run: the same rowId failed across two runs (still open → no success arc yet).
        return jsonResponse([
          {
            runId: 'run_prov_1',
            pipelineId: 'pipe_prov',
            rowId: 'MAT-777',
            eventType: 'target_write_failed',
            at: '2026-05-27T02:00:00.000Z',
            attrs: { errorCode: 'VALIDATION_FAILED', step: 'write' },
            eventIndex: 0,
            runStatus: 'partial',
            runMode: 'manual',
            runCreatedAt: '2026-05-27T02:00:00.000Z',
          },
          {
            runId: 'run_prov_2',
            pipelineId: 'pipe_prov',
            rowId: 'MAT-777',
            eventType: 'target_write_failed',
            at: '2026-05-28T03:00:00.000Z',
            attrs: { errorCode: 'VALIDATION_FAILED', step: 'write' },
            eventIndex: 0,
            runStatus: 'partial',
            runMode: 'manual',
            runCreatedAt: '2026-05-28T03:00:00.000Z',
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

    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    pipelineIdInput.value = 'pipe_prov'
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()

    // Dead-letter present; timeline NOT fetched until the row is expanded.
    expect(container.querySelector('[data-testid="dead-letter-dl_prov_1"]')).not.toBeNull()
    expect(provenanceCalls).toHaveLength(0)
    expect(container.querySelector('[data-testid="dead-letter-provenance-dl_prov_1"]')).toBeNull()

    // KEYSTONE (real wire): expanding the row FIRES the by-rowId provenance GET,
    // and the query carries rowId + pipelineId — not a pre-mocked render.
    ;(container.querySelector('[data-testid="toggle-dead-letter-provenance-dl_prov_1"]') as HTMLButtonElement).click()
    await flushUi()
    expect(provenanceCalls).toHaveLength(1)
    expect(provenanceCalls[0].url).toContain('/api/integration/provenance')
    expect(provenanceCalls[0].url).toContain('rowId=MAT-777')
    expect(provenanceCalls[0].url).toContain('pipelineId=pipe_prov')
    // Read-only: the fetch is a GET, never a POST/write.
    expect(provenanceCalls[0].method ?? 'GET').toBe('GET')

    // Cross-run timeline rendered: both runs + the event type are visible.
    const timeline = container.querySelector('[data-testid="dead-letter-provenance-timeline-dl_prov_1"]') as HTMLElement
    expect(timeline).not.toBeNull()
    expect(timeline.textContent).toContain('target_write_failed')
    expect(timeline.textContent).toContain('run_prov_1')
    expect(timeline.textContent).toContain('run_prov_2')

    // Read-only: the timeline introduces no replay/confirm affordance.
    expect(container.querySelector('[data-testid="confirm-replay-dead-letter-dl_prov_1"]')).toBeNull()

    // Collapse hides the timeline; re-expanding reuses the cached fetch (no refetch).
    ;(container.querySelector('[data-testid="toggle-dead-letter-provenance-dl_prov_1"]') as HTMLButtonElement).click()
    await flushUi()
    expect(container.querySelector('[data-testid="dead-letter-provenance-timeline-dl_prov_1"]')).toBeNull()
    ;(container.querySelector('[data-testid="toggle-dead-letter-provenance-dl_prov_1"]') as HTMLButtonElement).click()
    await flushUi()
    expect(provenanceCalls).toHaveLength(1)
  })

  it('disables the provenance lookup for a dead-letter without an idempotency key (no rowId)', async () => {
    const provenanceCalls: string[] = []
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe_nokey&limit=5') return jsonResponse([])
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe_nokey&status=open&limit=5') {
        return jsonResponse([
          {
            id: 'dl_nokey_1',
            tenantId: 'default',
            workspaceId: null,
            pipelineId: 'pipe_nokey',
            runId: 'run_nokey_1',
            idempotencyKey: null,
            errorCode: 'WRITE_FAILED',
            errorMessage: 'no key',
            status: 'open',
          },
        ])
      }
      if (url.startsWith('/api/integration/provenance')) {
        provenanceCalls.push(url)
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

    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    pipelineIdInput.value = 'pipe_nokey'
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()

    // No rowId → the toggle is disabled, an explicit hint shows, and clicking fires no GET.
    const toggle = container.querySelector('[data-testid="toggle-dead-letter-provenance-dl_nokey_1"]') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(toggle.disabled).toBe(true)
    expect(container.querySelector('[data-testid="dead-letter-provenance-unavailable-dl_nokey_1"]')).not.toBeNull()
    toggle.click()
    await flushUi()
    expect(provenanceCalls).toHaveLength(0)
    expect(container.querySelector('[data-testid="dead-letter-provenance-dl_nokey_1"]')).toBeNull()
  })

  it('treats a successful replay carrying a markReplayed warning as success (no false retry prompt)', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe_warn&limit=5') return jsonResponse([])
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe_warn&status=open&limit=5') {
        return jsonResponse([
          { id: 'dl_warn_1', tenantId: 'default', workspaceId: null, pipelineId: 'pipe_warn', runId: 'run_x', errorCode: 'TARGET_5XX', errorMessage: 'gateway timeout', status: 'open' },
        ])
      }
      if (url === '/api/integration/dead-letters/dl_warn_1/replay') {
        expect(init?.method).toBe('POST')
        // ERP write SUCCEEDED (rowsFailed 0), but markReplayed bookkeeping failed:
        // backend returns success + warning with the letter still 'open'
        // (pipeline-runner.cjs:732-756).
        return jsonResponse({
          deadLetter: { id: 'dl_warn_1', status: 'open' },
          replay: { run: { id: 'run_y' }, metrics: { rowsWritten: 1, rowsFailed: 0 } },
          warning: { code: 'MARK_REPLAYED_FAILED', message: 'bookkeeping failed' },
        })
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

    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    pipelineIdInput.value = 'pipe_warn'
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()
    ;(container.querySelector('[data-testid="replay-dead-letter-dl_warn_1"]') as HTMLButtonElement).click()
    await flushUi()
    ;(container.querySelector('[data-testid="confirm-replay-dead-letter-dl_warn_1"]') as HTMLButtonElement).click()
    await flushUi(15)

    // A successful write must read as success even though the letter stayed
    // 'open' and a warning came back — and must NOT show the retry prompt
    // (which would invite a duplicate ERP write). The warning is surfaced.
    expect(container.textContent).toContain('Replay 成功')
    expect(container.textContent).toContain('bookkeeping failed')
    expect(container.textContent).not.toContain('未完全成功')
  })

  it('does not offer replay for a non-open (replayed/discarded) dead-letter', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe_np&limit=5') return jsonResponse([])
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe_np&status=open&limit=5') {
        // A letter already 'replayed' must NOT be replayable again (a second
        // live ERP write); the only-open guard must hide the replay button.
        return jsonResponse([
          { id: 'dl_np_1', tenantId: 'default', workspaceId: null, pipelineId: 'pipe_np', runId: 'run_z', errorCode: 'VALIDATION_FAILED', errorMessage: 'missing code', status: 'replayed' },
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

    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    pipelineIdInput.value = 'pipe_np'
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()

    expect(container.querySelector('[data-testid="dead-letter-dl_np_1"]')).not.toBeNull()
    expect((container.querySelector('[data-testid="dead-letter-retryable-dl_np_1"]') as HTMLElement).textContent).toContain('不可重放')
    expect(container.querySelector('[data-testid="replay-dead-letter-dl_np_1"]')).toBeNull()
  })

  it('surfaces a 403 permission error on replay without removing the dead-letter', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe_perm&limit=5') return jsonResponse([])
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe_perm&status=open&limit=5') {
        return jsonResponse([
          { id: 'dl_perm_1', tenantId: 'default', workspaceId: null, pipelineId: 'pipe_perm', runId: 'run_p', errorCode: 'VALIDATION_FAILED', errorMessage: 'missing code', status: 'open' },
        ])
      }
      if (url === '/api/integration/dead-letters/dl_perm_1/replay') {
        expect(init?.method).toBe('POST')
        // Backend route enforces requireAccess(req, 'write').
        return new Response(
          JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'write permission required' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        )
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

    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    pipelineIdInput.value = 'pipe_perm'
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()
    ;(container.querySelector('[data-testid="replay-dead-letter-dl_perm_1"]') as HTMLButtonElement).click()
    await flushUi()
    ;(container.querySelector('[data-testid="confirm-replay-dead-letter-dl_perm_1"]') as HTMLButtonElement).click()
    await flushUi(15)

    // Permission failure is surfaced and the dead-letter stays put (the panel
    // reflects server truth on refresh — there is no optimistic removal).
    expect(container.textContent).toContain('write permission required')
    expect(container.querySelector('[data-testid="dead-letter-dl_perm_1"]')).not.toBeNull()
  })

  it('locks the confirm button while a replay is in flight (no double-submit window)', async () => {
    let resolveReplay!: (v: Response) => void
    let replayCalls = 0
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe_if&limit=5') return jsonResponse([])
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe_if&status=open&limit=5') {
        return jsonResponse([
          { id: 'dl_if_1', tenantId: 'default', workspaceId: null, pipelineId: 'pipe_if', runId: 'run_if', errorCode: 'VALIDATION_FAILED', errorMessage: 'missing code', status: 'open' },
        ])
      }
      if (url === '/api/integration/dead-letters/dl_if_1/replay') {
        replayCalls += 1
        // Hold the request open so the in-flight UI state is observable.
        return new Promise<Response>((resolve) => { resolveReplay = resolve })
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

    const pipelineIdInput = container.querySelector('[data-testid="pipeline-id"]') as HTMLInputElement
    pipelineIdInput.value = 'pipe_if'
    pipelineIdInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="refresh-observation"]') as HTMLButtonElement).click()
    await flushUi()
    ;(container.querySelector('[data-testid="replay-dead-letter-dl_if_1"]') as HTMLButtonElement).click()
    await flushUi()
    const confirmBtn = container.querySelector('[data-testid="confirm-replay-dead-letter-dl_if_1"]') as HTMLButtonElement
    expect(confirmBtn).not.toBeNull()
    confirmBtn.click()
    await flushUi()

    // Request held open: the confirm button is disabled and shows the busy label,
    // so a second click cannot fire another POST.
    expect(confirmBtn.disabled).toBe(true)
    expect(confirmBtn.textContent).toContain('Replay 中…')
    expect(replayCalls).toBe(1)

    // Resolve and let the flow complete.
    resolveReplay(new Response(
      JSON.stringify({ ok: true, data: { deadLetter: { id: 'dl_if_1', status: 'replayed' }, replay: { run: { id: 'run_if2' }, metrics: { rowsFailed: 0 } } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    await flushUi(15)
    expect(replayCalls).toBe(1)
    expect(container.textContent).toContain('Replay 成功')
  })

  it('DF-T2c: derives a draft via the read-only route, and authoring edits reach the real preview request body', async () => {
    const deriveBodies: Array<Record<string, unknown>> = []
    const previewBodies: Array<Record<string, unknown>> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      // a metasheet:staging system so the DF-T3b dual-binding picker has a system to bind
      if (url.startsWith('/api/integration/external-systems')) return jsonResponse([
        { id: 'ms_staging_1', name: 'MetaSheet staging', kind: 'metasheet:staging', status: 'active' },
      ])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/templates/derive') {
        deriveBodies.push(JSON.parse(String(init?.body)))
        // the read-only route returns the DF-T2a draft (scalar→replace, reference→preserve, gated excluded)
        // route returns values-free { fieldRules, gatedFields, evidence } — NO raw payloadTemplate
        return jsonResponse({
          fieldRules: [
            { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'FNumber', shape: 'scalar' },
            { targetField: 'FUnitID', sourceType: 'preserve_template', shape: 'object-passthrough', completeness: 'require-fnumber-fname' },
          ],
          gatedFields: ['FBaseUnitID'],
          evidence: {
            fields: [
              { field: 'FNumber', sourceType: 'from_staging', shape: 'scalar', isReference: false, hasValue: true },
              { field: 'FUnitID', sourceType: 'preserve_template', shape: 'object-passthrough', completeness: 'require-fnumber-fname', isReference: true, hasValue: true },
            ],
            gatedFields: ['FBaseUnitID'],
          },
        })
      }
      if (url === '/api/integration/templates/preview') {
        previewBodies.push(JSON.parse(String(init?.body)))
        return jsonResponse({ targetPayloadPreview: { fieldProvenance: {}, eligibleForSaveOnly: true } })
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

    // raw operator-local sample + a payloadTemplate to derive from
    const sample = container.querySelector('[data-testid="sample-record"]') as HTMLTextAreaElement
    sample.value = JSON.stringify({ materialCode: 'MAT-1' })
    sample.dispatchEvent(new Event('input'))
    const tpl = container.querySelector('[data-testid="payload-template"]') as HTMLTextAreaElement
    tpl.value = JSON.stringify({ FNumber: 'MAT-1', FName: 'Widget', FUnitID: { FNumber: '01', FName: 'PCS' } })
    tpl.dispatchEvent(new Event('input'))
    await flushUi()

    // KEYSTONE 1 — derive FIRES the read-only route with the payloadTemplate (not a fixture)
    ;(container.querySelector('[data-testid="derive-template-draft"]') as HTMLButtonElement).click()
    await flushUi()
    expect(deriveBodies).toHaveLength(1)
    expect(deriveBodies[0]).toHaveProperty('payloadTemplate')
    expect((deriveBodies[0].payloadTemplate as Record<string, unknown>).FUnitID).toBeDefined()
    // the authoring UI is driven by the REAL derived draft
    expect(container.querySelector('[data-testid="field-rule-FNumber"]')).not.toBeNull()
    // DF-T3b-2d: a reference is now reference-EDITABLE (preserve↔from_reference_table), not locked — it
    // renders an editable mode <select>, and there is still no scalar source input (never downgradable).
    const refMode = container.querySelector('[data-testid="field-rule-mode-FUnitID"]') as HTMLSelectElement
    expect(refMode?.tagName).toBe('SELECT')
    expect(container.querySelector('[data-testid="field-rule-locked-FUnitID"]')).toBeNull()
    expect(container.querySelector('[data-testid="field-rule-source-FUnitID"]')).toBeNull()

    // author: set FNumber's cleansed staging column
    const source = container.querySelector('[data-testid="field-rule-source-FNumber"]') as HTMLInputElement
    expect(source).not.toBeNull()
    source.value = 'materialCode'
    source.dispatchEvent(new Event('input'))
    await flushUi()

    // KEYSTONE 2 — the PREVIEW request body carries payloadTemplate + the AUTHORED fieldRules
    // (the edit flowed through to the wire; this is a request-body assertion, not a render check).
    ;(container.querySelector('[data-testid="preview-payload"]') as HTMLButtonElement).click()
    await flushUi()
    expect(previewBodies).toHaveLength(1)
    expect(previewBodies[0]).toHaveProperty('payloadTemplate')
    const rules = previewBodies[0].fieldRules as Array<Record<string, unknown>>
    expect(rules.find((r) => r.targetField === 'FNumber')).toMatchObject({ sourceType: 'from_staging', sourceField: 'materialCode', shape: 'scalar' })
    expect(rules.find((r) => r.targetField === 'FUnitID')).toMatchObject({ sourceType: 'preserve_template' })

    // KEYSTONE 3 (DF-T3b DUAL-BINDING) — author FUnitID as from_reference_table, bind BOTH halves via the
    // structured picker, and assert the preview POST carries both: the sheet binding (referenceMappingSources)
    // AND the sourceCode-column binding (rule.sourceField on the from_reference_table rule).
    const refModeK3 = container.querySelector('[data-testid="field-rule-mode-FUnitID"]') as HTMLSelectElement
    refModeK3.value = 'mapping'
    refModeK3.dispatchEvent(new Event('change'))
    await flushUi()
    const domainSel = container.querySelector('[data-testid="field-rule-domain-FUnitID"]') as HTMLSelectElement
    domainSel.value = 'unit'
    domainSel.dispatchEvent(new Event('change'))
    await flushUi()
    const srcCol = container.querySelector('[data-testid="field-rule-source-code-FUnitID"]') as HTMLInputElement
    expect(srcCol).not.toBeNull() // the sourceCode-column input (binding #2)
    srcCol.value = 'unitSourceCode'
    srcCol.dispatchEvent(new Event('input'))
    await flushUi()

    // the picker now lists the 'unit' domain (derived from the authored from_reference_table rule) — bind it
    const sysSel = container.querySelector('[data-testid="ref-mapping-system-unit"]') as HTMLSelectElement
    expect(sysSel?.tagName).toBe('SELECT') // staging-system dropdown (by NAME → id; no typed systemId)
    sysSel.value = 'ms_staging_1'
    sysSel.dispatchEvent(new Event('change'))
    await flushUi()
    const objInput = container.querySelector('[data-testid="ref-mapping-object-unit"]') as HTMLInputElement
    objInput.value = 'unit_dict'
    objInput.dispatchEvent(new Event('input'))
    await flushUi()

    ;(container.querySelector('[data-testid="preview-payload"]') as HTMLButtonElement).click()
    await flushUi()
    const lastBody = previewBodies.at(-1)!
    // binding #1 — the sheet binding
    expect(lastBody.referenceMappingSources).toEqual([{ domain: 'unit', systemId: 'ms_staging_1', object: 'unit_dict' }])
    // binding #2 — the sourceCode column on the from_reference_table rule (NOT just the sheet)
    const rules2 = lastBody.fieldRules as Array<Record<string, unknown>>
    expect(rules2.find((r) => r.targetField === 'FUnitID')).toMatchObject({ sourceType: 'from_reference_table', domain: 'unit', sourceField: 'unitSourceCode' })

    // orphan-drop — revert FUnitID to preserve → 'unit' is no longer an authored from_reference_table
    // domain → the (now stale) sheet binding is dropped from the next preview POST (the send loop iterates
    // the CURRENT domains, not the bindings map).
    const refModeRevert = container.querySelector('[data-testid="field-rule-mode-FUnitID"]') as HTMLSelectElement
    refModeRevert.value = 'preserve'
    refModeRevert.dispatchEvent(new Event('change'))
    await flushUi()
    ;(container.querySelector('[data-testid="preview-payload"]') as HTMLButtonElement).click()
    await flushUi()
    expect(previewBodies.at(-1)!).not.toHaveProperty('referenceMappingSources')
  })

  it('C2b: data-source:sql-readonly connection uses the structured picker and references a data source by id (no credentials)', async () => {
    const upsertBodies: Array<Record<string, unknown>> = []
    apiGetMock.mockReset()
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/data-sources') {
        return { ok: true, data: { items: [
          { id: 'pg-1', name: 'Warehouse PG', type: 'postgres', connected: true },
          { id: 'mssql-2', name: 'ERP MSSQL', type: 'sqlserver', connected: true },
        ] } }
      }
      throw new Error(`unexpected apiGet ${url}`)
    })
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['source', 'target', 'bidirectional'], supports: ['read', 'upsert'], advanced: false },
          { kind: 'data-source:sql-readonly', label: 'Read-only SQL data source', roles: ['source'], supports: ['testConnection', 'listObjects', 'getSchema', 'read'], advanced: true, guardrails: { write: { supported: false } } },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/external-systems' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
        upsertBodies.push(body)
        return jsonResponse({ id: 'ds_bridge_1', ...body })
      }
      if (url.startsWith('/api/integration/external-systems/ds_bridge_1/objects')) {
        return jsonResponse([{ name: 'public.items', label: 'public.items', operations: ['read'], source: 'data-source:sql-readonly' }])
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    // eslint-disable-next-line vue/one-component-per-file
    app.component('RouterLink', {
      props: { to: { type: [String, Object], required: false, default: '' } },
      setup(_props, { slots }) { return () => h('a', slots.default?.()) },
    })
    app.mount(container)
    await flushUi()

    // Picker is hidden until the operator picks the bridge kind, and the data-source list is NOT fetched yet (lazy).
    expect(container.querySelector('[data-testid="data-source-bridge-picker"]')).toBeNull()
    expect(apiGetMock.mock.calls.some(([url]) => url === '/api/data-sources')).toBe(false)

    // data-source:sql-readonly is an advanced connector — reveal it via the advanced toggle first.
    const advancedToggle = container.querySelector('[data-testid="show-advanced-connectors"]') as HTMLInputElement
    advancedToggle.checked = true
    advancedToggle.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    const kindSelect = container.querySelector('[data-testid="connection-draft-kind"]') as HTMLSelectElement
    kindSelect.value = 'data-source:sql-readonly'
    kindSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    // Picker appears + lists the data sources; the raw-JSON config is hidden for this kind.
    expect(container.querySelector('[data-testid="data-source-bridge-picker"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="connection-draft-config"]')).toBeNull()
    const dsSelect = container.querySelector('[data-testid="data-source-bridge-id"]') as HTMLSelectElement
    const dsOptions = Array.from(dsSelect.options).map((option) => option.textContent?.trim())
    expect(dsOptions).toContain('Warehouse PG · postgres')
    expect(dsOptions).toContain('ERP MSSQL · sqlserver')
    expect(container.querySelector('[data-testid="data-source-bridge-hint"]')?.textContent).toContain('凭据由 /data-sources 管理')

    const nameInput = container.querySelector('[data-testid="connection-draft-name"]') as HTMLInputElement
    nameInput.value = 'Warehouse bridge'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    dsSelect.value = 'pg-1'
    dsSelect.dispatchEvent(new Event('change', { bubbles: true }))
    const objInput = container.querySelector('[data-testid="data-source-bridge-object"]') as HTMLInputElement
    objInput.value = 'public.items'
    objInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(container.querySelector('[data-testid="save-connection-draft"]') as HTMLButtonElement).click()
    await flushUi(8)

    // The saved connection references the data source by id (+ object) and carries NO credentials.
    expect(upsertBodies).toHaveLength(1)
    const saved = upsertBodies[0]
    expect(saved.kind).toBe('data-source:sql-readonly')
    expect(saved.role).toBe('source')
    expect(saved.config).toEqual({ dataSourceId: 'pg-1', object: 'public.items' })
    expect(saved).not.toHaveProperty('credentials')
    expect(JSON.stringify(saved.config)).not.toMatch(/password|token|secret|credential/i)
    expect(container.textContent).toContain('连接已保存：Warehouse bridge')

    // Reachability: the saved bridge source is selectable as a Data Factory source, and loading its
    // objects routes through the (now principal-threaded) objects endpoint — not fail-closed.
    const sourceSystemSelect = container.querySelector('[data-testid="source-system"]') as HTMLSelectElement
    expect(Array.from(sourceSystemSelect.options).some((option) => option.value === 'ds_bridge_1')).toBe(true)
    sourceSystemSelect.value = 'ds_bridge_1'
    sourceSystemSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    ;(container.querySelector('[data-testid="load-source-objects"]') as HTMLButtonElement).click()
    await flushUi(8)
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/integration/external-systems/ds_bridge_1/objects'))).toBe(true)
    const objectSelect = container.querySelector('[data-testid="source-object"]') as HTMLSelectElement
    expect(Array.from(objectSelect.options).map((option) => option.value)).toContain('public.items')
  })

  it('C2b: the save gate requires an object (no half-config without a table/view)', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['source', 'target', 'bidirectional'], supports: ['read', 'upsert'], advanced: false },
          { kind: 'data-source:sql-readonly', label: 'Read-only SQL data source', roles: ['source'], supports: ['testConnection', 'listObjects', 'getSchema', 'read'], advanced: true, guardrails: { write: { supported: false } } },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      throw new Error(`unexpected URL ${url}`)
    })
    apiGetMock.mockReset()
    apiGetMock.mockImplementation(async (url: string) => {
      if (url === '/api/data-sources') return { ok: true, data: { items: [{ id: 'pg-1', name: 'Warehouse PG', type: 'postgres', connected: true }] } }
      throw new Error(`unexpected apiGet ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    // eslint-disable-next-line vue/one-component-per-file
    app.component('RouterLink', { props: { to: { type: [String, Object], required: false, default: '' } }, setup(_props, { slots }) { return () => h('a', slots.default?.()) } })
    app.mount(container)
    await flushUi()

    ;(container.querySelector('[data-testid="show-advanced-connectors"]') as HTMLInputElement).checked = true
    container.querySelector('[data-testid="show-advanced-connectors"]')!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    const kindSelect = container.querySelector('[data-testid="connection-draft-kind"]') as HTMLSelectElement
    kindSelect.value = 'data-source:sql-readonly'
    kindSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()
    const nameInput = container.querySelector('[data-testid="connection-draft-name"]') as HTMLInputElement
    nameInput.value = 'Half config'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    const dsSelect = container.querySelector('[data-testid="data-source-bridge-id"]') as HTMLSelectElement
    dsSelect.value = 'pg-1'
    dsSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi()

    // dataSourceId picked but object empty → save must stay disabled.
    expect((container.querySelector('[data-testid="save-connection-draft"]') as HTMLButtonElement).disabled).toBe(true)

    const objInput = container.querySelector('[data-testid="data-source-bridge-object"]') as HTMLInputElement
    objInput.value = 'public.items'
    objInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()
    expect((container.querySelector('[data-testid="save-connection-draft"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('C3: shows an enabled approval automation entry for an entitled Yuantus PLM data-source bridge and marks stubbed actions', async () => {
    const capabilityCalls: string[] = []
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['source'], supports: ['read'], advanced: false },
          { kind: 'data-source:sql-readonly', label: 'Read-only PLM data source', roles: ['source'], supports: ['read'], advanced: true },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          { id: 'http_1', tenantId: 'default', workspaceId: null, name: 'HTTP Source', kind: 'http', role: 'source', status: 'active' },
          {
            id: 'plm_bridge',
            tenantId: 'default',
            workspaceId: null,
            name: 'Yuantus PLM bridge',
            kind: 'data-source:sql-readonly',
            role: 'source',
            status: 'active',
            config: { dataSourceId: 'plm-ds', object: 'eco' },
          },
        ])
      }
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/plm-workbench/data-sources/plm-ds/capabilities') {
        capabilityCalls.push(url)
        return rawJsonResponse({
          data_source_id: 'plm-ds',
          available: true,
          manifest: {
            schema_version: 'v1',
            provider: 'yuantus-plm',
            advisory: true,
            features: {
              approval_automation: {
                supported: true,
                api_version: 'v1',
                entitled: true,
                scenarios: ['eco'],
                actions: ['notify'],
                action_status: 'stubbed',
              },
              bom_multitable: { supported: false, api_version: null, entitled: false },
            },
          },
        })
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) { return () => h('a', slots.default?.()) },
    })
    app.mount(container)
    await flushUi(8)

    expect(container.querySelector('[data-testid="plm-approval-capability-entry"]')).toBeNull()

    ;(container.querySelector('[data-testid="show-advanced-connectors"]') as HTMLInputElement).click()
    await flushUi()
    const sourceSystemSelect = container.querySelector('[data-testid="source-system"]') as HTMLSelectElement
    sourceSystemSelect.value = 'plm_bridge'
    sourceSystemSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(8)

    const entry = container.querySelector('[data-testid="plm-approval-capability-entry"]') as HTMLElement | null
    expect(entry).not.toBeNull()
    expect(entry!.dataset.state).toBe('enabled')
    expect(entry!.dataset.actionStatus).toBe('stubbed')
    expect(entry!.textContent).toContain('ECO 审批自动化')
    expect(entry!.textContent).toContain('notify 当前仍是占位动作')
    expect(entry!.textContent).toContain('approval_automation · API v1')
    expect(capabilityCalls).toEqual(['/api/plm-workbench/data-sources/plm-ds/capabilities'])
  })

  it('P3-C: shows an enabled BOM-review entry (with the read-only panel) for an entitled bom_multitable, fetching no BOM until asked', async () => {
    const calls: string[] = []
    apiFetchMock.mockImplementation(async (url: string) => {
      calls.push(url)
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'data-source:sql-readonly', label: 'Read-only PLM data source', roles: ['source'], supports: ['read'], advanced: true },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          {
            id: 'plm_bridge', tenantId: 'default', workspaceId: null, name: 'Yuantus PLM bridge',
            kind: 'data-source:sql-readonly', role: 'source', status: 'active',
            config: { dataSourceId: 'plm-ds', object: 'eco' },
          },
        ])
      }
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/plm-workbench/data-sources/plm-ds/capabilities') {
        return rawJsonResponse({
          data_source_id: 'plm-ds',
          available: true,
          manifest: {
            schema_version: 'v1', provider: 'yuantus-plm', advisory: true,
            features: {
              bom_multitable: { supported: true, api_version: 'v1', entitled: true, scenarios: ['bom_review'] },
            },
          },
        })
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', { props: ['to'], setup(_props, { slots }) { return () => h('a', slots.default?.()) } })
    app.mount(container)
    await flushUi(8)

    ;(container.querySelector('[data-testid="show-advanced-connectors"]') as HTMLInputElement).click()
    await flushUi()
    const sourceSystemSelect = container.querySelector('[data-testid="source-system"]') as HTMLSelectElement
    sourceSystemSelect.value = 'plm_bridge'
    sourceSystemSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(8)

    const entry = container.querySelector('[data-testid="plm-bom-multitable-capability-entry"]') as HTMLElement | null
    expect(entry).not.toBeNull()
    expect(entry!.dataset.state).toBe('enabled')
    expect(entry!.textContent).toContain('BOM 多维表 Review')
    expect(entry!.textContent).toContain('bom_multitable · API v1')
    // the read-only panel is mounted, but it must NOT have fetched any BOM context yet
    expect(container.querySelector('[data-testid="plm-bom-review-panel"]')).not.toBeNull()
    expect(calls.some((u) => u.includes('/bom-multitable/'))).toBe(false)
  })

  it('C3: shows only the upgrade affordance for supported but not entitled approval automation', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'data-source:sql-readonly', label: 'Read-only PLM data source', roles: ['source'], supports: ['read'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          {
            id: 'plm_bridge',
            tenantId: 'default',
            workspaceId: null,
            name: 'Yuantus PLM bridge',
            kind: 'data-source:sql-readonly',
            role: 'source',
            status: 'active',
            config: { dataSourceId: 'plm-ds', object: 'eco' },
          },
        ])
      }
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/plm-workbench/data-sources/plm-ds/capabilities') {
        return rawJsonResponse({
          data_source_id: 'plm-ds',
          available: true,
          manifest: {
            schema_version: 'v1',
            provider: 'yuantus-plm',
            advisory: true,
            features: {
              approval_automation: {
                supported: true,
                api_version: 'v1',
                entitled: false,
                scenarios: ['eco'],
                actions: ['notify'],
                action_status: 'stubbed',
              },
            },
          },
        })
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) { return () => h('a', slots.default?.()) },
    })
    app.mount(container)
    await flushUi(8)

    const entry = container.querySelector('[data-testid="plm-approval-capability-entry"]') as HTMLElement | null
    expect(entry).not.toBeNull()
    expect(entry!.dataset.state).toBe('upgrade')
    expect(entry!.textContent).toContain('升级审批自动化')
    expect(entry!.textContent).toContain('尚未开通 approval_automation')
    expect(entry!.textContent).not.toContain('ECO 审批自动化')
  })

  it('C3: hides approval automation entry for unsupported or unavailable PLM capability manifests', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'data-source:sql-readonly', label: 'Read-only PLM data source', roles: ['source'], supports: ['read'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([
          {
            id: 'plm_bridge',
            tenantId: 'default',
            workspaceId: null,
            name: 'Yuantus PLM bridge',
            kind: 'data-source:sql-readonly',
            role: 'source',
            status: 'active',
            config: { dataSourceId: 'plm-ds', object: 'eco' },
          },
          {
            id: 'plm_unavailable',
            tenantId: 'default',
            workspaceId: null,
            name: 'Unavailable PLM bridge',
            kind: 'data-source:sql-readonly',
            role: 'source',
            status: 'active',
            config: { dataSourceId: 'plm-ds-unavailable', object: 'eco' },
          },
        ])
      }
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/plm-workbench/data-sources/plm-ds/capabilities') {
        return rawJsonResponse({
          data_source_id: 'plm-ds',
          available: true,
          manifest: {
            schema_version: 'v1',
            provider: 'yuantus-plm',
            advisory: true,
            features: {
              approval_automation: { supported: false, api_version: null, entitled: false },
            },
          },
        })
      }
      if (url === '/api/plm-workbench/data-sources/plm-ds-unavailable/capabilities') {
        return rawJsonResponse({ data_source_id: 'plm-ds-unavailable', available: false, reason: 'unavailable' })
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const View = (await import('../src/views/IntegrationWorkbenchView.vue')).default
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View as Component)
    app.component('router-link', {
      props: ['to'],
      setup(_props, { slots }) { return () => h('a', slots.default?.()) },
    })
    app.mount(container)
    await flushUi(8)

    expect(container.querySelector('[data-testid="plm-approval-capability-entry"]')).toBeNull()

    const sourceSystemSelect = container.querySelector('[data-testid="source-system"]') as HTMLSelectElement
    sourceSystemSelect.value = 'plm_unavailable'
    sourceSystemSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(8)
    expect(container.querySelector('[data-testid="plm-approval-capability-entry"]')).toBeNull()
  })

  it('C5-2: runs a configured table action via dry-run token without client-supplied plan or sheet scope', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:write']))
    const dryRunBodies: Array<{ url: string; body: Record<string, unknown> }> = []
    const applyBodies: Array<{ url: string; body: Record<string, unknown> }> = []
    const publicAction = {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      kind: 'parameterized_table_action',
      label: 'PLM project BOM -> stock preparation',
      configured: true,
      parameters: [{
        id: 'projectNo',
        label: 'Project number',
        type: 'string',
        required: true,
        trim: true,
        binding: { type: 'equality_filter', field: 'FileCode' },
      }],
      permissions: { dryRun: 'read', apply: 'write' },
      evidence: { valuesFreeIssueEvidence: true },
    }
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([
          { kind: 'http', label: 'HTTP API', roles: ['source'], supports: ['read'], advanced: false },
        ])
      }
      if (url === '/api/integration/external-systems?tenantId=default') return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/table-actions?tenantId=default') return jsonResponse([publicAction])
      if (url === '/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run?tenantId=default') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        dryRunBodies.push({ url, body })
        return jsonResponse({
          action: publicAction,
          status: 'manual_confirm_required',
          dryRunToken: 'dry-token-secret',
          revision: 'rev-1',
          canApply: true,
          counts: { add: 1, update: 2, skip: 3, inactive: 1, manual_confirm: 1 },
          evidence: {
            actionId: publicAction.actionId,
            projectNoPresent: true,
            dryRunRevision: 'rev-1',
            expansion: { status: 'expanded', rows: 4, errorTypes: [] },
            plan: { counts: { add: 1, update: 2, skip: 3, inactive: 1, manual_confirm: 1 }, errorTypes: [] },
          },
        })
      }
      if (url === '/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/apply?tenantId=default') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        applyBodies.push({ url, body })
        return jsonResponse({
          action: publicAction,
          status: 'partial',
          permission: 'write',
          dryRunRevision: 'rev-1',
          apply: { status: 'partial', created: 1, patched: 2, skipped: 3, manualConfirmHeld: 1 },
          evidence: {
            actionId: publicAction.actionId,
            projectNoPresent: true,
            dryRunRevision: 'rev-1',
            apply: { status: 'partial', errorCodes: [] },
          },
        })
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
    await flushUi(12)

    expect(container.querySelector('[data-testid="table-action-panel"]')?.textContent).toContain('PLM project BOM -> stock preparation')
    expect(container.querySelector('[data-testid="table-action-boundary"]')?.textContent).toContain('不提供 raw SQL')
    expect((container.querySelector('[data-testid="table-action-dry-run"]') as HTMLButtonElement).disabled).toBe(true)

    const projectInput = container.querySelector('[data-testid="table-action-project-no"]') as HTMLInputElement
    projectInput.value = 'P-001'
    projectInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(container.querySelector('[data-testid="table-action-dry-run"]') as HTMLButtonElement).click()
    await flushUi(10)
    expect(dryRunBodies).toHaveLength(1)
    expect(dryRunBodies[0].body).toEqual({
      parameters: { projectNo: 'P-001' },
    })
    expect(dryRunBodies[0].body).not.toHaveProperty('sheetId')
    expect(dryRunBodies[0].body).not.toHaveProperty('source')
    expect(dryRunBodies[0].body).not.toHaveProperty('target')
    expect(dryRunBodies[0].body).not.toHaveProperty('plan')
    expect(dryRunBodies[0].body).not.toHaveProperty('payload')
    expect(container.querySelector('[data-testid="table-action-review"]')?.textContent).toContain('manual 1')
    expect(container.querySelector('[data-testid="table-action-token-state"]')?.textContent).toContain('token 已签发')
    expect(container.querySelector('[data-testid="table-action-panel"]')?.textContent).not.toContain('dry-token-secret')
    expect((container.querySelector('[data-testid="table-action-apply"]') as HTMLButtonElement).disabled).toBe(true)

    ;(container.querySelector('[data-testid="table-action-accept-manual-hold"]') as HTMLInputElement).click()
    await flushUi()
    expect((container.querySelector('[data-testid="table-action-apply"]') as HTMLButtonElement).disabled).toBe(false)
    ;(container.querySelector('[data-testid="table-action-apply"]') as HTMLButtonElement).click()
    await flushUi(10)

    expect(applyBodies).toHaveLength(1)
    expect(applyBodies[0].body).toEqual({
      parameters: { projectNo: 'P-001' },
      confirm: {
        dryRunToken: 'dry-token-secret',
        acceptManualConfirmHold: true,
      },
    })
    expect(applyBodies[0].body).not.toHaveProperty('sheetId')
    expect(applyBodies[0].body).not.toHaveProperty('source')
    expect(applyBodies[0].body).not.toHaveProperty('target')
    expect(applyBodies[0].body).not.toHaveProperty('plan')
    expect(applyBodies[0].body).not.toHaveProperty('payload')
    expect(container.querySelector('[data-testid="table-action-apply-result"]')?.textContent).toContain('apply partial')
    expect(container.querySelector('[data-testid="table-action-evidence"]')?.textContent).not.toContain('P-001')
    expect(container.querySelector('[data-testid="table-action-evidence"]')?.textContent).not.toContain('dry-token-secret')
  })

  it('C5-2: keeps apply disabled for read-only users after a successful dry-run', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:read']))
    const applyBodies: Array<Record<string, unknown>> = []
    const publicAction = {
      actionId: 'plm.stock-preparation.pull-bom.v1',
      kind: 'parameterized_table_action',
      label: 'PLM project BOM -> stock preparation',
      configured: true,
      parameters: [{ id: 'projectNo', label: 'Project number', type: 'string', required: true }],
      permissions: { dryRun: 'read', apply: 'write' },
      evidence: { valuesFreeIssueEvidence: true },
    }
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url === '/api/integration/external-systems?tenantId=default') return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/table-actions?tenantId=default') return jsonResponse([publicAction])
      if (url === '/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run?tenantId=default') {
        return jsonResponse({
          action: publicAction,
          status: 'ready',
          dryRunToken: 'read-only-dry-token',
          revision: 'rev-read-only',
          canApply: true,
          counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 },
          evidence: { actionId: publicAction.actionId, projectNoPresent: true, dryRunRevision: 'rev-read-only' },
        })
      }
      if (url === '/api/integration/table-actions/plm.stock-preparation.pull-bom.v1/apply?tenantId=default') {
        applyBodies.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>)
        return jsonResponse({ status: 'succeeded' })
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
    await flushUi(12)

    const projectInput = container.querySelector('[data-testid="table-action-project-no"]') as HTMLInputElement
    projectInput.value = 'P-READ'
    projectInput.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    ;(container.querySelector('[data-testid="table-action-dry-run"]') as HTMLButtonElement).click()
    await flushUi(10)

    expect(container.querySelector('[data-testid="table-action-review"]')?.textContent).toContain('add 1')
    expect(container.querySelector('[data-testid="table-action-token-state"]')?.textContent).toContain('token 已签发')
    const applyButton = container.querySelector('[data-testid="table-action-apply"]') as HTMLButtonElement
    expect(applyButton.disabled).toBe(true)
    applyButton.click()
    await flushUi()
    expect(applyBodies).toHaveLength(0)
  })

  it('C6: lets admins sync stock-preparation options and predefined action bindings without client scope or payload fields', async () => {
    localStorage.setItem('user_permissions', JSON.stringify(['integration:admin']))
    const syncBodies: Array<Record<string, unknown>> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') return jsonResponse([])
      if (url === '/api/integration/external-systems?tenantId=default') return jsonResponse([])
      if (url === '/api/integration/staging/descriptors') return jsonResponse([])
      if (url === '/api/integration/table-actions?tenantId=default') return jsonResponse([])
      if (url === '/api/integration/stock-preparation/options/sync') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
        syncBodies.push(body)
        return jsonResponse({
          ok: true,
          target: { objectId: 'plm_stock_preparation_main', fieldCount: 2 },
          evidence: {
            objectId: 'plm_stock_preparation_main',
            fields: [
              { field: 'materialType', optionSource: { type: 'config_info', key: 'material_type' }, optionCount: 1, actionBindingCount: 1 },
            ],
            skipped: [],
          },
        })
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
    await flushUi(12)

    expect(container.querySelector('[data-testid="stock-option-sync-panel"]')?.textContent).toContain('备料选项同步')
    expect(container.querySelector('[data-testid="stock-option-sync-boundary"]')?.textContent).toContain('不接受 SQL/JS/URL/function body')
    const textarea = container.querySelector('[data-testid="stock-option-sync-json"]') as HTMLTextAreaElement
    textarea.value = JSON.stringify({
      optionSets: {
        material_type: [{
          value: 'plate',
          label: 'Plate',
          actionBindings: [{ actionId: 'plm.stock-preparation.pull-bom.v1' }],
        }],
      },
    })
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const syncButton = container.querySelector('[data-testid="stock-option-sync-run"]') as HTMLButtonElement
    expect(syncButton.disabled).toBe(false)
    syncButton.click()
    await flushUi(10)

    expect(syncBodies).toHaveLength(1)
    expect(syncBodies[0]).toEqual({
      tenantId: 'default',
      workspaceId: null,
      optionSets: {
        material_type: [{
          value: 'plate',
          label: 'Plate',
          actionBindings: [{ actionId: 'plm.stock-preparation.pull-bom.v1' }],
        }],
      },
    })
    expect(syncBodies[0]).not.toHaveProperty('sheetId')
    expect(syncBodies[0]).not.toHaveProperty('source')
    expect(syncBodies[0]).not.toHaveProperty('target')
    expect(syncBodies[0]).not.toHaveProperty('plan')
    expect(syncBodies[0]).not.toHaveProperty('payload')
    const evidence = container.querySelector('[data-testid="stock-option-sync-evidence"]')?.textContent || ''
    expect(evidence).toContain('material_type')
    expect(evidence).not.toContain('plate')
    expect(evidence).not.toContain('Plate')
  })
})
