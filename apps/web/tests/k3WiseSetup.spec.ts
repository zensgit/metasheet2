import { describe, expect, it } from 'vitest'
import {
  applyExternalSystemToForm,
  buildK3WisePipelinePayloads,
  buildK3WisePipelineRunPayload,
  buildK3WiseSetupPayloads,
  buildK3WiseStagingInstallPayload,
  createDefaultK3WiseSetupForm,
  getK3WisePipelineId,
  splitList,
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
})
