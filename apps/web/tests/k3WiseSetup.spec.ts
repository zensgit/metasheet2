import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  applyExternalSystemToForm,
  buildK3WiseGateDraft,
  buildK3WisePipelineObservationQuery,
  buildK3WisePipelinePayloads,
  buildK3WisePipelineRunPayload,
  buildK3WisePocCommandSet,
  buildK3WiseSetupPayloads,
  buildK3WiseStagingInstallPayload,
  createDefaultK3WiseSetupForm,
  formatIntegrationStagingDescriptorFieldSummary,
  getIntegrationStagingFieldCount,
  getK3WisePipelineId,
  splitList,
  stringifyK3WiseGateDraft,
  validateK3WiseGateDraftForm,
  validateK3WisePipelineObservationForm,
  validateK3WisePipelineTemplateForm,
  validateK3WisePipelineRunForm,
  validateK3WiseSetupForm,
  validateK3WiseStagingInstallForm,
  type IntegrationExternalSystem,
} from '../src/services/integration/k3WiseSetup'

describe('K3 WISE setup helpers', () => {
  it('builds WebAPI and SQL Server external-system payloads from the setup form', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      webApiName: 'K3 WISE WebAPI',
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      acctId: 'AIS_TEST',
      username: 'k3-user',
      password: 'secret',
      sqlEnabled: true,
      sqlServer: '10.0.0.10',
      sqlDatabase: 'AIS_TEST',
      sqlAllowedTables: 'dbo.t_ICItem\ndbo.t_ICBOM, dbo.t_ICBomChild',
      sqlMiddleTables: 'dbo.integration_material_stage',
    })

    expect(validateK3WiseSetupForm(form)).toEqual([])
    const payloads = buildK3WiseSetupPayloads(form)

    expect(payloads.webApi).toMatchObject({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      credentials: {
        username: 'k3-user',
        password: 'secret',
        acctId: 'AIS_TEST',
      },
      config: {
        baseUrl: 'https://k3.example.test/K3API/',
        autoSubmit: false,
        autoAudit: false,
      },
    })
    expect(payloads.sqlServer).toMatchObject({
      kind: 'erp:k3-wise-sqlserver',
      role: 'bidirectional',
      config: {
        allowedTables: ['dbo.t_ICItem', 'dbo.t_ICBOM', 'dbo.t_ICBomChild'],
        middleTables: ['dbo.integration_material_stage'],
      },
    })
  })

  it('preserves existing credential storage when editing without replacement fields', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      webApiSystemId: 'sys_1',
      webApiHasCredentials: true,
      webApiName: 'K3 WISE WebAPI',
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      username: '',
      password: '',
      acctId: '',
    })

    expect(validateK3WiseSetupForm(form)).toEqual([])
    const payloads = buildK3WiseSetupPayloads(form)

    expect(payloads.webApi).toMatchObject({
      id: 'sys_1',
      kind: 'erp:k3-wise-webapi',
    })
    expect(payloads.webApi).not.toHaveProperty('credentials')
  })

  it('loads public external-system config without exposing credentials', () => {
    const form = createDefaultK3WiseSetupForm()
    const system: IntegrationExternalSystem = {
      id: 'sys_1',
      tenantId: 'tenant_1',
      workspaceId: null,
      name: 'K3 loaded',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
      hasCredentials: true,
      config: {
        version: 'K3 WISE 15.x',
        environment: 'uat',
        baseUrl: 'https://k3.example.test/',
        loginPath: '/login',
        objects: {
          material: { savePath: '/material/save' },
          bom: { savePath: '/bom/save' },
        },
      },
      capabilities: {},
    }

    const next = applyExternalSystemToForm(form, system)

    expect(next.webApiSystemId).toBe('sys_1')
    expect(next.webApiHasCredentials).toBe(true)
    expect(next.baseUrl).toBe('https://k3.example.test/')
    expect(next.password).toBe('')
  })

  it('validates absolute endpoint paths and incomplete credential replacement', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      webApiSystemId: 'sys_1',
      webApiHasCredentials: true,
      webApiName: 'K3 WISE WebAPI',
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      username: 'new-user',
      password: '',
      acctId: 'AIS_TEST',
      materialSavePath: 'https://evil.example/save',
    })

    const messages = validateK3WiseSetupForm(form).map((issue) => issue.message)
    expect(messages).toContain('K3 WISE password is required when credentials are created or replaced')
    expect(messages).toContain('materialSavePath must be relative to the K3 WISE base URL')
  })

  it('rejects invalid K3 numeric transport fields instead of silently using defaults', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      webApiName: 'K3 WISE WebAPI',
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      acctId: 'AIS_TEST',
      username: 'k3-user',
      password: 'secret',
      lcid: 'zh-CN',
      timeoutMs: '0',
    })

    const messages = validateK3WiseSetupForm(form).map((issue) => issue.message)
    expect(messages).toContain('lcid must be a positive integer')
    expect(messages).toContain('timeoutMs must be a positive integer')
    expect(() => buildK3WiseSetupPayloads(form)).toThrow('lcid must be a positive integer')
  })

  it('keeps the K3 WISE setup route behind integration write permission', async () => {
    const source = await readFile('src/router/appRoutes.ts', 'utf8')
    const mainSource = await readFile('src/main.ts', 'utf8')
    const routeStart = source.indexOf("path: '/integrations/k3-wise'")
    const routeEnd = source.indexOf("path: '/workflows'", routeStart)
    const routeBlock = source.slice(routeStart, routeEnd)

    expect(routeBlock).toContain("path: '/integrations/k3-wise'")
    expect(routeBlock).toContain("titleZh: 'K3 WISE 对接'")
    expect(routeBlock).toContain("permissions: ['integration:write']")
    expect(routeBlock).not.toContain("requiredFeature: 'attendanceAdmin'")
    expect(mainSource).toContain('to.meta?.permissions')
    expect(mainSource).toContain('auth.hasPermission(permission)')
  })

  it('splits comma and newline table lists', () => {
    expect(splitList('t_ICItem, t_ICBOM\n t_ICBomChild')).toEqual(['t_ICItem', 't_ICBOM', 't_ICBomChild'])
  })

  it('builds draft material and BOM cleansing pipeline templates', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      sourceSystemId: 'plm_1',
      webApiSystemId: 'k3_1',
      materialStagingObjectId: 'standard_materials',
      bomStagingObjectId: 'bom_cleanse',
    })

    expect(validateK3WisePipelineTemplateForm(form)).toEqual([])
    const payloads = buildK3WisePipelinePayloads(form)

    expect(payloads.material).toMatchObject({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      sourceSystemId: 'plm_1',
      targetSystemId: 'k3_1',
      sourceObject: 'materials',
      targetObject: 'material',
      mode: 'incremental',
      status: 'draft',
      idempotencyKeyFields: ['sourceId', 'revision'],
      options: {
        target: {
          autoSubmit: false,
          autoAudit: false,
        },
        erpFeedback: {
          objectId: 'standard_materials',
          keyField: '_integration_idempotency_key',
        },
      },
    })
    expect(payloads.material.fieldMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceField: 'code', targetField: 'FNumber' }),
        expect.objectContaining({ sourceField: 'name', targetField: 'FName' }),
      ]),
    )
    expect(payloads.bom).toMatchObject({
      sourceObject: 'bom',
      targetObject: 'bom',
      mode: 'manual',
      options: {
        target: {
          autoSubmit: false,
          autoAudit: false,
        },
        erpFeedback: {
          objectId: 'bom_cleanse',
        },
      },
    })
    expect(payloads.bom.fieldMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceField: 'parentCode', targetField: 'FParentItemNumber' }),
        expect.objectContaining({ sourceField: 'quantity', targetField: 'FQty' }),
      ]),
    )
  })

  it('requires saved PLM source and K3 target systems before pipeline template creation', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      sourceSystemId: '',
      webApiSystemId: '',
    })

    const messages = validateK3WisePipelineTemplateForm(form).map((issue) => issue.message)
    expect(messages).toContain('PLM source system ID is required')
    expect(messages).toContain('Save or select a K3 WISE WebAPI system before creating pipelines')
    expect(() => buildK3WisePipelinePayloads(form)).toThrow('PLM source system ID is required')
  })

  it('keeps pipeline staging object validation permissive until descriptors are loaded', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      sourceSystemId: 'plm_1',
      webApiSystemId: 'k3_1',
      materialStagingObjectId: 'custom_material_stage',
      bomStagingObjectId: 'custom_bom_stage',
    })

    expect(validateK3WisePipelineTemplateForm(form)).toEqual([])
  })

  it('requires selected pipeline staging objects to match loaded descriptors', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      sourceSystemId: 'plm_1',
      webApiSystemId: 'k3_1',
      materialStagingObjectId: 'typo_materials',
      bomStagingObjectId: 'bom_cleanse',
    })

    const messages = validateK3WisePipelineTemplateForm(form, [
      { id: 'standard_materials', name: 'Standard Materials', fields: ['code'] },
      { id: 'bom_cleanse', name: 'BOM Cleanse', fields: ['parentCode'] },
    ]).map((issue) => issue.message)

    expect(messages).toContain('Material staging object must match a loaded descriptor')
    expect(messages).not.toContain('BOM staging object must match a loaded descriptor')
  })

  it('builds staging install payloads from tenant and project scope', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      baseId: 'base_1',
    })

    expect(validateK3WiseStagingInstallForm(form)).toEqual([])
    expect(buildK3WiseStagingInstallPayload(form)).toEqual({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      baseId: 'base_1',
    })
  })

  it('summarizes staging descriptor field details for the setup page preview', () => {
    const descriptor = {
      id: 'standard_materials',
      name: 'Standard Materials',
      fields: ['code', 'name', 'status'],
      fieldDetails: [
        { id: 'code', name: 'Material Code', type: 'string' },
        { id: 'name', name: 'Material Name', type: 'string' },
        { id: 'status', name: 'Status', type: 'select', options: ['draft', 'active', 'obsolete'] },
      ],
    }

    expect(getIntegrationStagingFieldCount(descriptor)).toBe(3)
    expect(formatIntegrationStagingDescriptorFieldSummary(descriptor)).toBe(
      '3 fields · select:1, string:2 · select status(3)',
    )
  })

  it('falls back to field ids when descriptor details are not available', () => {
    const descriptor = {
      id: 'legacy_descriptor',
      name: 'Legacy Descriptor',
      fields: ['code', 'name'],
    }

    expect(getIntegrationStagingFieldCount(descriptor)).toBe(2)
    expect(formatIntegrationStagingDescriptorFieldSummary(descriptor)).toBe('2 fields')
  })

  it('requires project scope before staging install', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      projectId: '',
    })

    const messages = validateK3WiseStagingInstallForm(form).map((issue) => issue.message)
    expect(messages).toContain('projectId is required before installing staging tables')
    expect(() => buildK3WiseStagingInstallPayload(form)).toThrow('projectId is required before installing staging tables')
  })

  it('builds pipeline dry-run and run payloads with only public run fields', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      materialPipelineId: 'pipe_material',
      bomPipelineId: 'pipe_bom',
      pipelineRunMode: 'incremental',
      pipelineSampleLimit: '25',
      pipelineCursor: 'wm_123',
      allowLivePipelineRun: true,
    })

    expect(validateK3WisePipelineRunForm(form, 'material')).toEqual([])
    expect(getK3WisePipelineId(form, 'material')).toBe('pipe_material')
    expect(getK3WisePipelineId(form, 'bom')).toBe('pipe_bom')
    expect(buildK3WisePipelineRunPayload(form, 'material')).toEqual({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      mode: 'incremental',
      sampleLimit: 25,
      cursor: 'wm_123',
    })
  })

  it('requires tenant, pipeline id, and positive sample limit before pipeline execution', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: '',
      materialPipelineId: '',
      pipelineSampleLimit: '0',
    })

    const messages = validateK3WisePipelineRunForm(form, 'material').map((issue) => issue.message)
    expect(messages).toContain('tenantId is required')
    expect(messages).toContain('Material pipeline ID is required before dry-run or run')
    expect(messages).toContain('Sample limit must be a positive integer')
    expect(() => buildK3WisePipelineRunPayload(form, 'material')).toThrow('tenantId is required')
  })

  it('builds a redacted customer GATE draft and preflight command set from the setup form', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      operator: 'integration-admin',
      version: 'K3 WISE 15.x test',
      environment: 'uat',
      baseUrl: 'https://k3.example.test/K3API/',
      acctId: 'AIS_TEST',
      username: 'k3-user',
      password: 'real-k3-password',
      sqlEnabled: true,
      sqlMode: 'readonly',
      sqlServer: '10.0.0.10',
      sqlDatabase: 'AIS_TEST',
      sqlAllowedTables: 'dbo.t_ICItem\ndbo.t_MeasureUnit',
      plmKind: 'plm:yuantus-wrapper',
      plmReadMethod: 'api',
      plmBaseUrl: 'https://plm.example.test/',
      plmDefaultProductId: 'PRODUCT-TEST-001',
      plmUsername: 'plm-user',
      plmPassword: 'real-plm-password',
      rollbackOwner: 'customer-k3-admin',
      rollbackStrategy: 'disable-test-records',
      bomEnabled: true,
    })

    expect(validateK3WiseGateDraftForm(form)).toEqual([])
    const draft = buildK3WiseGateDraft(form)

    expect(draft).toMatchObject({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      operator: 'integration-admin',
      k3Wise: {
        version: 'K3 WISE 15.x test',
        apiUrl: 'https://k3.example.test/K3API/',
        acctId: 'AIS_TEST',
        environment: 'uat',
        credentials: {
          username: 'k3-user',
          password: '<fill-outside-git>',
        },
        autoSubmit: false,
        autoAudit: false,
      },
      plm: {
        kind: 'plm:yuantus-wrapper',
        readMethod: 'api',
        baseUrl: 'https://plm.example.test/',
        config: {
          defaultProductId: 'PRODUCT-TEST-001',
        },
        credentials: {
          username: 'plm-user',
          password: '<fill-outside-git>',
        },
      },
      sqlServer: {
        enabled: true,
        mode: 'readonly',
        allowedTables: ['dbo.t_ICItem', 'dbo.t_MeasureUnit'],
        writeCoreTables: false,
      },
      rollback: {
        owner: 'customer-k3-admin',
        strategy: 'disable-test-records',
      },
      bom: {
        enabled: true,
        productId: 'PRODUCT-TEST-001',
      },
    })
    expect(JSON.stringify(draft)).not.toContain('real-k3-password')
    expect(JSON.stringify(draft)).not.toContain('real-plm-password')
    expect(stringifyK3WiseGateDraft(form)).toContain('"fieldMappings"')

    const commands = buildK3WisePocCommandSet('tmp/gate.json')
    expect(commands.preflight).toContain('--input tmp/gate.json')
    expect(commands.offlineMock).toBe('pnpm run verify:integration-k3wise:poc')
    expect(commands.evidence).toContain('integration-k3wise-live-poc-evidence.mjs')
  })

  it('blocks unsafe live PoC GATE drafts before preflight JSON is copied', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      operator: 'integration-admin',
      version: 'K3 WISE 15.x test',
      environment: 'production',
      baseUrl: 'https://k3.example.test/K3API/',
      acctId: 'AIS_TEST',
      autoSubmit: true,
      sqlEnabled: true,
      sqlMode: 'middle-table',
      sqlAllowedTables: 'dbo.t_ICItem',
      rollbackOwner: 'customer-k3-admin',
      bomEnabled: true,
      bomProductId: '',
      plmDefaultProductId: '',
    })

    const messages = validateK3WiseGateDraftForm(form).map((issue) => issue.message)
    expect(messages).toContain('Live PoC GATE must target a non-production K3 WISE environment')
    expect(messages).toContain('Live PoC GATE must stay Save-only: autoSubmit and autoAudit must be false')
    expect(messages).toContain('Live PoC may not write K3 WISE core business tables')
    expect(messages).toContain('BOM PoC requires BOM product ID or PLM default product ID')
    expect(() => buildK3WiseGateDraft(form)).toThrow('Live PoC GATE must target a non-production K3 WISE environment')
  })

  it('builds run and dead-letter observation queries for selected pipelines', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      materialPipelineId: 'pipe_material',
      bomPipelineId: 'pipe_bom',
    })

    expect(validateK3WisePipelineObservationForm(form, 'bom')).toEqual([])
    expect(buildK3WisePipelineObservationQuery(form, 'bom', { status: 'open', limit: 5, offset: 0 })).toEqual({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      pipelineId: 'pipe_bom',
      status: 'open',
      limit: 5,
      offset: 0,
    })
  })

  it('requires tenant and pipeline id before loading run history', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: '',
      bomPipelineId: '',
    })

    const messages = validateK3WisePipelineObservationForm(form, 'bom').map((issue) => issue.message)
    expect(messages).toContain('tenantId is required')
    expect(messages).toContain('BOM pipeline ID is required before loading run history')
    expect(() => buildK3WisePipelineObservationQuery(form, 'bom')).toThrow('tenantId is required')
  })
})
