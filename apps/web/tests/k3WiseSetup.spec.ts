import { describe, expect, it } from 'vitest'
import {
  applyExternalSystemToForm,
  buildK3WiseSetupPayloads,
  createDefaultK3WiseSetupForm,
  splitList,
  validateK3WiseSetupForm,
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
})
