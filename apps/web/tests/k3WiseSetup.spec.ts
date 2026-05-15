import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  applyExternalSystemToForm,
  applyK3WiseGateJsonToForm,
  buildK3WiseDocumentPayloadPreview,
  buildK3WiseDeployGateChecklist,
  buildK3WiseGateDraft,
  buildK3WisePocCommandSet,
  buildK3WisePocEnvironmentTemplate,
  buildK3WisePostdeploySignoffBundle,
  buildK3WiseSqlConnectionFingerprint,
  buildK3WiseSqlSystemConnectionFingerprint,
  buildK3WiseWebApiConnectionFingerprint,
  buildK3WiseWebApiSystemConnectionFingerprint,
  buildK3WisePipelineObservationQuery,
  buildK3WisePipelinePayloads,
  buildK3WisePipelineRunPayload,
  buildK3WiseSetupPayloads,
  buildK3WiseStagingInstallPayload,
  createDefaultK3WiseSetupForm,
  formatIntegrationStagingDescriptorFieldSummary,
  getIntegrationStagingFieldCount,
  getK3WisePipelineId,
  listK3WiseDocumentTemplates,
  splitList,
  stringifyK3WiseGateDraft,
  summarizeK3WiseDeployGateChecklist,
  validateK3WiseGateDraftForm,
  validateK3WisePipelineObservationForm,
  validateK3WisePipelineTemplateForm,
  validateK3WisePipelineRunForm,
  validateK3WiseSetupForm,
  validateK3WiseStagingInstallForm,
  type IntegrationExternalSystem,
} from '../src/services/integration/k3WiseSetup'

describe('K3 WISE setup helpers', () => {
  it('defaults tenant scope to default for single-tenant on-prem setup', () => {
    const form = createDefaultK3WiseSetupForm()

    expect(form.tenantId).toBe('default')
    expect(form.workspaceId).toBe('')
  })

  it('builds WebAPI and SQL Server external-system payloads from the setup form', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      webApiName: 'K3 WISE WebAPI',
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      webApiAuthMode: 'login',
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
        authMode: 'login',
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

  it('builds K3 API authority-code token payloads from the setup form', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      webApiName: 'K3 WISE WebAPI',
      version: 'K3 WISE 15.x test',
      baseUrl: 'http://k3.local/K3API/',
      authorityCode: 'auth-code-from-k3-admin',
    })

    expect(validateK3WiseSetupForm(form)).toEqual([])
    const payloads = buildK3WiseSetupPayloads(form)

    expect(payloads.webApi).toMatchObject({
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      credentials: {
        authorityCode: 'auth-code-from-k3-admin',
      },
      config: {
        authMode: 'authority-code',
        tokenPath: '/K3API/Token/Create',
        tokenQueryParam: 'Token',
      },
    })
    expect(payloads.webApi).not.toMatchObject({
      credentials: {
        username: expect.any(String),
      },
    })
  })

  it('defaults blank advanced tenant scope to default in payload builders', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: '',
      projectId: 'project_1',
      webApiName: 'K3 WISE WebAPI',
      version: 'K3 WISE 15.x test',
      baseUrl: 'http://k3.local',
      authorityCode: 'auth-code-from-k3-admin',
      sourceSystemId: 'plm_1',
      webApiSystemId: 'k3_1',
      materialPipelineId: 'pipe_material',
      bomPipelineId: 'pipe_bom',
    })

    expect(validateK3WiseSetupForm(form)).toEqual([])
    expect(buildK3WiseSetupPayloads(form).webApi).toMatchObject({ tenantId: 'default' })
    expect(buildK3WiseStagingInstallPayload(form)).toMatchObject({ tenantId: 'default' })
    expect(buildK3WisePipelinePayloads(form).material).toMatchObject({ tenantId: 'default' })
    expect(buildK3WisePipelineRunPayload(form, 'material')).toMatchObject({ tenantId: 'default' })
    expect(buildK3WisePipelineObservationQuery(form, 'bom')).toMatchObject({ tenantId: 'default' })
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

  it('persists disabling an existing SQL Server channel without clearing stored config', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      webApiSystemId: 'webapi_1',
      webApiHasCredentials: true,
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      acctId: '',
      username: '',
      password: '',
      sqlEnabled: false,
      sqlSystemId: 'sql_1',
      sqlName: 'K3 WISE SQL Server',
      sqlHasCredentials: true,
    })

    expect(validateK3WiseSetupForm(form)).toEqual([])
    const payloads = buildK3WiseSetupPayloads(form)

    expect(payloads.sqlServer).toEqual({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      id: 'sql_1',
      name: 'K3 WISE SQL Server',
      kind: 'erp:k3-wise-sqlserver',
      role: 'bidirectional',
      status: 'inactive',
    })
  })

  it('does not create a SQL Server system when disabled and no prior system exists', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      webApiSystemId: 'webapi_1',
      webApiHasCredentials: true,
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      acctId: '',
      username: '',
      password: '',
      sqlEnabled: false,
      sqlSystemId: '',
    })

    expect(validateK3WiseSetupForm(form)).toEqual([])
    expect(buildK3WiseSetupPayloads(form).sqlServer).toBeNull()
  })

  it('loads public external-system config without exposing credentials', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      authorityCode: 'draft-authority-code',
      acctId: 'draft-acct',
      username: 'draft-user',
      password: 'draft-password',
    })
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
    expect(next.healthPath).toBe('')
    expect(next.authorityCode).toBe('')
    expect(next.acctId).toBe('')
    expect(next.username).toBe('')
    expect(next.password).toBe('')
  })

  it('tracks unsaved WebAPI connection drafts without reacting to pipeline-only edits', () => {
    const form = createDefaultK3WiseSetupForm()
    const system: IntegrationExternalSystem = {
      id: 'sys_1',
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      name: 'K3 loaded',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
      hasCredentials: true,
      config: {
        version: 'K3 WISE 15.x',
        environment: 'uat',
        authMode: 'authority-code',
        baseUrl: 'https://k3.example.test/',
        tokenPath: '/token',
        loginPath: '/login',
        healthPath: '/health',
        lcid: 2052,
        timeoutMs: 30000,
      },
      capabilities: {},
    }
    const loaded = applyExternalSystemToForm(form, system)
    const savedFingerprint = buildK3WiseWebApiSystemConnectionFingerprint(system)

    expect(buildK3WiseWebApiConnectionFingerprint(loaded)).toBe(savedFingerprint)

    loaded.projectId = 'project_1'
    loaded.materialPipelineId = 'pipe_material'
    loaded.pipelineCursor = 'cursor_1'
    loaded.allowLivePipelineRun = true
    expect(buildK3WiseWebApiConnectionFingerprint(loaded)).toBe(savedFingerprint)

    loaded.baseUrl = 'https://k3-new.example.test/'
    expect(buildK3WiseWebApiConnectionFingerprint(loaded)).not.toBe(savedFingerprint)

    loaded.baseUrl = 'https://k3.example.test/'
    loaded.username = 'replacement-user'
    expect(buildK3WiseWebApiConnectionFingerprint(loaded)).not.toBe(savedFingerprint)

    loaded.username = ''
    loaded.authorityCode = 'replacement-authority-code'
    expect(buildK3WiseWebApiConnectionFingerprint(loaded)).not.toBe(savedFingerprint)
  })

  it('tracks unsaved SQL Server connection drafts without reacting to pipeline-only edits', () => {
    const form = createDefaultK3WiseSetupForm()
    form.sqlUsername = 'draft-user'
    form.sqlPassword = 'draft-password'
    const system: IntegrationExternalSystem = {
      id: 'sql_1',
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      name: 'K3 SQL loaded',
      kind: 'erp:k3-wise-sqlserver',
      role: 'bidirectional',
      status: 'active',
      hasCredentials: true,
      config: {
        mode: 'readonly',
        server: '10.0.0.10',
        database: 'AIS_TEST',
        allowedTables: ['dbo.t_ICItem', 'dbo.t_ICBOM'],
        middleTables: ['dbo.integration_material_stage'],
        storedProcedures: ['dbo.usp_integration_material'],
      },
      capabilities: {},
    }
    const loaded = applyExternalSystemToForm(form, system)
    const savedFingerprint = buildK3WiseSqlSystemConnectionFingerprint(system)

    expect(loaded.sqlUsername).toBe('')
    expect(loaded.sqlPassword).toBe('')
    expect(buildK3WiseSqlConnectionFingerprint(loaded)).toBe(savedFingerprint)

    loaded.projectId = 'project_1'
    loaded.bomPipelineId = 'pipe_bom'
    loaded.pipelineCursor = 'cursor_1'
    expect(buildK3WiseSqlConnectionFingerprint(loaded)).toBe(savedFingerprint)

    loaded.sqlServer = '10.0.0.11'
    expect(buildK3WiseSqlConnectionFingerprint(loaded)).not.toBe(savedFingerprint)

    loaded.sqlServer = '10.0.0.10'
    loaded.sqlPassword = 'replacement-password'
    expect(buildK3WiseSqlConnectionFingerprint(loaded)).not.toBe(savedFingerprint)
  })

  it('keeps K3 setup connection test controls behind saved-draft fingerprints', async () => {
    const source = await readFile('src/views/IntegrationK3WiseSetupView.vue', 'utf8')

    expect(source).toContain(':disabled="webApiTestDisabled"')
    expect(source).toContain(':disabled="sqlTestDisabled"')
    expect(source).toContain('hasUnsavedWebApiConnectionDraft')
    expect(source).toContain('hasUnsavedSqlConnectionDraft')
    expect(source).toContain('if (!system) return Boolean(form.webApiSystemId)')
    expect(source).toContain('if (!system) return Boolean(form.sqlSystemId)')
    expect(source).toContain('if (!form.webApiSystemId || hasUnsavedWebApiConnectionDraft.value) return')
    expect(source).toContain('if (!form.sqlSystemId || hasUnsavedSqlConnectionDraft.value) return')
  })

  it('normalizes saved K3 WISE auto-submit flags from boolean, string, numeric, and Chinese variants', () => {
    const cases: Array<{ autoSubmit: unknown; autoAudit: unknown }> = [
      { autoSubmit: true, autoAudit: false },
      { autoSubmit: 1, autoAudit: 0 },
      { autoSubmit: 'true', autoAudit: 'false' },
      { autoSubmit: 'YES', autoAudit: 'NO' },
      { autoSubmit: ' on ', autoAudit: ' off ' },
      { autoSubmit: '是', autoAudit: '否' },
      { autoSubmit: '启用', autoAudit: '禁用' },
      { autoSubmit: '开启', autoAudit: '关闭' },
    ]

    for (const item of cases) {
      const form = createDefaultK3WiseSetupForm()
      Object.assign(form, {
        autoSubmit: false,
        autoAudit: true,
      })
      const system: IntegrationExternalSystem = {
        id: 'sys_1',
        tenantId: 'tenant_1',
        workspaceId: null,
        name: 'K3 loaded',
        kind: 'erp:k3-wise-webapi',
        role: 'target',
        status: 'active',
        config: item,
        capabilities: {},
      }

      const next = applyExternalSystemToForm(form, system)

      expect(next.autoSubmit).toBe(true)
      expect(next.autoAudit).toBe(false)
    }
  })

  it('clears K3 WISE auto-submit flags when saved config contains unknown values', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      autoSubmit: true,
      autoAudit: false,
    })
    const system: IntegrationExternalSystem = {
      id: 'sys_1',
      tenantId: 'tenant_1',
      workspaceId: null,
      name: 'K3 loaded',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      status: 'active',
      config: {
        autoSubmit: 'maybe',
        autoAudit: {},
      },
      capabilities: {},
    }

    const next = applyExternalSystemToForm(form, system)

    expect(next.autoSubmit).toBe(false)
    expect(next.autoAudit).toBe(false)
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
      webApiAuthMode: 'login',
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
      webApiAuthMode: 'login',
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
    expect(routeBlock).toContain("titleZh: 'K3 WISE 预设'")
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
        k3Template: {
          id: 'k3wise.material.v1',
          version: '2026.05.v1',
          documentType: 'material',
        },
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
        k3Template: {
          id: 'k3wise.bom.v1',
          version: '2026.05.v1',
          documentType: 'bom',
        },
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

  it('renders K3 document template payload previews without internal or secret fields', () => {
    const templates = listK3WiseDocumentTemplates()
    expect(templates.map((template) => template.targetObject)).toEqual(['material', 'bom'])

    const materialPreview = buildK3WiseDocumentPayloadPreview('material')
    const bomPreview = buildK3WiseDocumentPayloadPreview('bom')

    expect(materialPreview).toEqual({
      Data: {
        FNumber: 'MAT-001',
        FName: 'Bolt',
        FModel: 'M6 x 20',
        FBaseUnitID: 'Pcs',
      },
    })
    expect(bomPreview).toEqual({
      Data: {
        FParentItemNumber: 'FG-001',
        FChildItemNumber: 'MAT-001',
        FQty: 2,
        FUnitID: 'PCS',
        FEntryID: 1,
      },
    })
    expect(JSON.stringify(materialPreview)).not.toMatch(/authorityCode|Token|password|sourceId|revision|_integration/i)
  })

  it('builds a redacted authority-code customer GATE draft and command set', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      operator: 'customer-k3-admin',
      version: 'K3 WISE 15.x test',
      environment: 'uat',
      baseUrl: 'https://k3.example.test/',
      authorityCode: 'real-authority-code',
      plmKind: 'plm:yuantus-wrapper',
      plmReadMethod: 'api',
      plmBaseUrl: 'https://plm.example.test/',
      plmDefaultProductId: 'PRODUCT-TEST-001',
      plmUsername: 'plm-user',
      plmPassword: 'real-plm-password',
      rollbackOwner: 'customer-k3-admin',
      sqlEnabled: true,
      sqlMode: 'middle-table',
      sqlServer: '10.0.0.10',
      sqlDatabase: 'AIS_TEST',
      sqlMiddleTables: 'dbo.integration_material_stage',
    })

    expect(validateK3WiseGateDraftForm(form)).toEqual([])
    const draft = buildK3WiseGateDraft(form)

    expect(draft).toMatchObject({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      operator: 'customer-k3-admin',
      k3Wise: {
        version: 'K3 WISE 15.x test',
        apiUrl: 'https://k3.example.test/',
        environment: 'uat',
        authMode: 'authority-code',
        tokenPath: '/K3API/Token/Create',
        credentials: {
          authorityCode: '<fill-outside-git>',
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
        mode: 'middle-table',
        server: '10.0.0.10',
        database: 'AIS_TEST',
        middleTables: ['dbo.integration_material_stage'],
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
    expect(JSON.stringify(draft)).not.toContain('real-authority-code')
    expect(JSON.stringify(draft)).not.toContain('real-plm-password')
    expect(stringifyK3WiseGateDraft(form)).toContain('"fieldMappings"')

    const commands = buildK3WisePocCommandSet()
    expect(commands.postdeploySmoke).toContain('integration-k3wise-postdeploy-smoke.mjs')
    expect(commands.postdeploySmoke).toContain('--require-auth')
    expect(commands.postdeploySummary).toContain('integration-k3wise-postdeploy-summary.mjs')
    expect(commands.preflight).toContain('integration-k3wise-live-poc-preflight.mjs')
    expect(commands.offlineMock).toBe('pnpm run verify:integration-k3wise:poc')
    expect(commands.evidence).toContain('integration-k3wise-live-poc-evidence.mjs')
  })

  it('builds redacted postdeploy environment and signoff command bundles', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
    })

    const env = buildK3WisePocEnvironmentTemplate(form)
    expect(env).toContain('METASHEET_BASE_URL')
    expect(env).toContain('METASHEET_AUTH_TOKEN_FILE')
    expect(env).toContain('METASHEET_TENANT_ID="tenant_1"')
    expect(env).not.toMatch(/eyJ|Bearer|password/i)

    const bundle = buildK3WisePostdeploySignoffBundle(form)
    expect(bundle).toContain('set -euo pipefail')
    expect(bundle).toContain('integration-k3wise-postdeploy-smoke.mjs')
    expect(bundle).toContain('integration-k3wise-postdeploy-summary.mjs')
    expect(bundle).not.toMatch(/eyJ|Bearer|password/i)
  })

  it('blocks unsafe live PoC GATE drafts before preflight JSON is copied', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      operator: 'customer-k3-admin',
      version: 'K3 WISE prod',
      environment: 'production',
      baseUrl: 'https://k3.example.test/',
      autoSubmit: true,
      sqlEnabled: true,
      sqlMode: 'middle-table',
      sqlMiddleTables: 'dbo.t_ICItem',
      rollbackOwner: 'customer-k3-admin',
      plmKind: 'plm:yuantus-wrapper',
      plmDefaultProductId: '',
      bomProductId: '',
    })

    const messages = validateK3WiseGateDraftForm(form).map((issue) => issue.message)
    expect(messages).toContain('Live PoC GATE must target a non-production K3 WISE environment')
    expect(messages).toContain('Live PoC GATE must stay Save-only: autoSubmit and autoAudit must be false')
    expect(messages).toContain('BOM PoC requires BOM product ID or PLM default product ID')
    expect(messages).toContain('Live PoC may not write K3 WISE core business tables')
    expect(() => buildK3WiseGateDraft(form)).toThrow('Live PoC GATE must target a non-production K3 WISE environment')
  })

  it('imports customer GATE JSON public fields without credential secrets', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      authorityCode: 'old-authority-code',
      password: 'old-k3-secret',
      plmPassword: 'old-plm-secret',
      sqlPassword: 'old-sql-secret',
    })

    const result = applyK3WiseGateJsonToForm(form, JSON.stringify({
      tenantId: 'tenant_customer',
      workspaceId: 'workspace_customer',
      projectId: 'project_customer',
      operator: 'customer-k3-admin',
      k3Wise: {
        version: 'K3 WISE 15.x',
        apiUrl: 'https://k3.customer.test/',
        environment: 'staging',
        authMode: 'authority-code',
        tokenPath: '/K3API/Token/Create',
        credentials: {
          authorityCode: 'customer-authority-code',
          username: 'ignored-for-authority-code',
        },
        autoSubmit: 'false',
        autoAudit: 'false',
      },
      plm: {
        kind: 'plm:third-party',
        readMethod: 'database',
        baseUrl: 'https://plm.example.test/',
        config: {
          defaultProductId: 'PRODUCT-001',
        },
        credentials: {
          username: 'plm-user',
          password: 'plm-secret',
          token: 'plm-token',
        },
      },
      sqlServer: {
        enabled: true,
        mode: 'middle-table',
        server: '10.0.0.10',
        database: 'AIS_TEST',
        username: 'sql-user',
        password: 'sql-secret',
        allowedTables: ['dbo.t_ICItem', 'dbo.t_ICBOM'],
        middleTables: 'dbo.integration_material_stage',
      },
      rollback: {
        owner: 'rollback-owner',
        strategy: 'delete-test-records',
      },
      bom: {
        enabled: true,
        productId: 'PRODUCT-BOM-001',
      },
    }))

    expect(result.form).toMatchObject({
      tenantId: 'tenant_customer',
      workspaceId: 'workspace_customer',
      projectId: 'project_customer',
      operator: 'customer-k3-admin',
      version: 'K3 WISE 15.x',
      baseUrl: 'https://k3.customer.test/',
      webApiAuthMode: 'authority-code',
      tokenPath: '/K3API/Token/Create',
      environment: 'staging',
      authorityCode: '',
      password: '',
      plmKind: 'plm:third-party',
      plmReadMethod: 'database',
      plmBaseUrl: 'https://plm.example.test/',
      plmDefaultProductId: 'PRODUCT-001',
      plmUsername: 'plm-user',
      plmPassword: '',
      sqlEnabled: true,
      sqlMode: 'middle-table',
      sqlServer: '10.0.0.10',
      sqlDatabase: 'AIS_TEST',
      sqlUsername: 'sql-user',
      sqlPassword: '',
      sqlAllowedTables: 'dbo.t_ICItem\ndbo.t_ICBOM',
      sqlMiddleTables: 'dbo.integration_material_stage',
      rollbackOwner: 'rollback-owner',
      rollbackStrategy: 'delete-test-records',
      bomEnabled: true,
      bomProductId: 'PRODUCT-BOM-001',
    })
    expect(result.warnings).toContain('k3Wise.credentials.authorityCode ignored; enter it in the credential form if needed')
    expect(result.warnings).toContain('plm.credentials.password ignored; enter it in the credential form if needed')
    expect(result.warnings).toContain('plm.credentials.token ignored; enter it in the credential form if needed')
    expect(result.warnings).toContain('sqlServer.password ignored; enter it in the credential form if needed')
    expect(result.warnings).not.toContain('k3Wise.tokenPath ignored; enter it in the credential form if needed')
  })

  it('rejects invalid customer GATE JSON before applying it to the form', () => {
    const form = createDefaultK3WiseSetupForm()

    expect(() => applyK3WiseGateJsonToForm(form, '')).toThrow('GATE JSON is required')
    expect(() => applyK3WiseGateJsonToForm(form, '{broken')).toThrow('GATE JSON must be valid JSON')
    expect(() => applyK3WiseGateJsonToForm(form, '[]')).toThrow('GATE JSON must be an object')
  })

  it('exposes customer GATE copy, download, import, and postdeploy controls in the setup page', async () => {
    const source = await readFile('src/views/IntegrationK3WiseSetupView.vue', 'utf8')

    expect(source).toContain('data-testid="k3-wise-gate-copy-button"')
    expect(source).toContain('data-testid="k3-wise-gate-download-button"')
    expect(source).toContain('data-testid="k3-wise-gate-import-textarea"')
    expect(source).toContain('data-testid="k3-wise-gate-import-button"')
    expect(source).toContain('data-testid="k3-wise-postdeploy-bundle"')
    expect(source).toContain('copyGateDraft')
    expect(source).toContain('downloadGateDraft')
    expect(source).toContain('importGateJson')
    expect(source).toContain('buildK3WisePostdeploySignoffBundle')
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

  it('allows staging install without an operator-entered project scope', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      projectId: '',
    })

    expect(validateK3WiseStagingInstallForm(form)).toEqual([])
    expect(buildK3WiseStagingInstallPayload(form)).toEqual({
      tenantId: 'tenant_1',
      workspaceId: null,
    })
  })

  it('builds pipeline dry-run and run payloads with only public run fields', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      materialPipelineId: 'pipe_material',
      bomPipelineId: 'pipe_bom',
      pipelineRunMode: 'incremental',
      pipelineSampleLimit: '3',
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
      sampleLimit: 3,
      cursor: 'wm_123',
    })
  })

  it('requires pipeline id and positive sample limit before pipeline execution', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: '',
      materialPipelineId: '',
      pipelineSampleLimit: '0',
    })

    const messages = validateK3WisePipelineRunForm(form, 'material').map((issue) => issue.message)
    expect(messages).toContain('Material pipeline ID is required before dry-run or run')
    expect(messages).toContain('Sample limit must be a positive integer')
    expect(() => buildK3WisePipelineRunPayload(form, 'material')).toThrow('Material pipeline ID is required before dry-run or run')
  })

  it('caps K3 WISE live PoC pipeline sample limit at three rows', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      materialPipelineId: 'pipe_material',
      pipelineSampleLimit: '4',
    })

    const messages = validateK3WisePipelineRunForm(form, 'material').map((issue) => issue.message)
    expect(messages).toContain('Live PoC sample limit must be between 1 and 3 rows')
    expect(() => buildK3WisePipelineRunPayload(form, 'material')).toThrow('Live PoC sample limit must be between 1 and 3 rows')
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

  it('requires pipeline id before loading run history', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: '',
      bomPipelineId: '',
    })

    const messages = validateK3WisePipelineObservationForm(form, 'bom').map((issue) => issue.message)
    expect(messages).toContain('BOM pipeline ID is required before loading run history')
    expect(() => buildK3WisePipelineObservationQuery(form, 'bom')).toThrow('BOM pipeline ID is required before loading run history')
  })

  it('summarizes deploy readiness fields that can be filled after deployment', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      authorityCode: 'auth-code-from-k3-admin',
    })

    const checklist = buildK3WiseDeployGateChecklist(form)
    const summary = summarizeK3WiseDeployGateChecklist(checklist)
    const byId = Object.fromEntries(checklist.map((item) => [item.id, item]))

    expect(byId.webapi?.status).toBe('ready')
    expect(byId['webapi-credentials']?.status).toBe('ready')
    expect(byId['sql-channel']?.status).toBe('warning')
    expect(byId['plm-source']?.status).toBe('external')
    expect(byId.staging?.status).toBe('missing')
    expect(summary).toMatchObject({
      external: 1,
      canSaveConfiguration: true,
      canCreatePipelines: false,
      canRunDryRun: false,
      canRunLive: false,
    })
  })

  it('marks internal dry-run ready only after source, target, staging, and pipeline ids exist', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      projectId: 'project_1',
      webApiSystemId: 'k3_1',
      webApiHasCredentials: true,
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      sourceSystemId: 'plm_1',
      materialPipelineId: 'pipe_material',
      bomPipelineId: 'pipe_bom',
    })

    const checklist = buildK3WiseDeployGateChecklist(form)
    const summary = summarizeK3WiseDeployGateChecklist(checklist)
    const byId = Object.fromEntries(checklist.map((item) => [item.id, item]))

    expect(byId['pipeline-template']?.status).toBe('ready')
    expect(byId['pipeline-dry-run']?.status).toBe('ready')
    expect(byId['pipeline-live-run']?.status).toBe('ready')
    expect(summary.canSaveConfiguration).toBe(true)
    expect(summary.canCreatePipelines).toBe(true)
    expect(summary.canRunDryRun).toBe(true)
    expect(summary.canRunLive).toBe(false)
  })

  it('requires an explicit live-run opt-in before deploy checklist allows real pipeline execution', () => {
    const form = createDefaultK3WiseSetupForm()
    Object.assign(form, {
      tenantId: 'tenant_1',
      projectId: 'project_1',
      webApiSystemId: 'k3_1',
      webApiHasCredentials: true,
      version: 'K3 WISE 15.x test',
      baseUrl: 'https://k3.example.test/K3API/',
      sourceSystemId: 'plm_1',
      materialPipelineId: 'pipe_material',
      bomPipelineId: 'pipe_bom',
      allowLivePipelineRun: true,
    })

    const checklist = buildK3WiseDeployGateChecklist(form)
    const summary = summarizeK3WiseDeployGateChecklist(checklist)
    const liveRun = checklist.find((item) => item.id === 'pipeline-live-run')

    expect(liveRun).toMatchObject({
      status: 'warning',
      field: 'allowLivePipelineRun',
    })
    expect(summary.canRunLive).toBe(true)
  })
})
