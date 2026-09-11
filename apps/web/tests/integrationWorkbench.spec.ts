import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getDefaultIntegrationScope,
  getExternalSystemSchema,
  listIntegrationDeadLetters,
  listExternalSystemObjects,
  listIntegrationAdapters,
  listIntegrationPipelineRuns,
  listIntegrationProvenanceByRow,
  listIntegrationStagingDescriptors,
  listWorkbenchExternalSystems,
  previewIntegrationTemplate,
  runIntegrationPipeline,
  deriveFieldRulesFromMappings,
  summarizeFieldProvenance,
  testExternalSystemConnection,
  upsertWorkbenchExternalSystem,
  upsertIntegrationPipeline,
  isIntegrationScopedProjectId,
  isDeadLetterReplayable,
  normalizeIntegrationProjectId,
  replayIntegrationDeadLetter,
  externalSystemScopeTestWriteNote,
  externalSystemScopeWriteBlock,
  isExternalSystemWritableInScope,
} from '../src/services/integration/workbench'

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

describe('deriveFieldRulesFromMappings (DF-T1.5 reachability wire)', () => {
  it('maps each field mapping to a from_staging scalar rule keyed by the TARGET field', () => {
    // sourceField = targetField: the DF-T1 backend transforms the staging record first, so the
    // transformed record is keyed by target field and from_staging reads the transformed value.
    const rules = deriveFieldRulesFromMappings([
      { sourceField: 'code', targetField: 'FNumber' },
      { sourceField: 'name', targetField: 'FName' },
    ] as Parameters<typeof deriveFieldRulesFromMappings>[0])
    expect(rules).toEqual([
      { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'FNumber', shape: 'scalar' },
      { targetField: 'FName', sourceType: 'from_staging', sourceField: 'FName', shape: 'scalar' },
    ])
  })

  it('preserves required semantics from the mapping validation', () => {
    const rules = deriveFieldRulesFromMappings([
      { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
      { sourceField: 'spec', targetField: 'FModel', validation: [] },
    ] as Parameters<typeof deriveFieldRulesFromMappings>[0])
    expect(rules[0]).toEqual({ targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'FNumber', shape: 'scalar', required: true })
    expect(rules[1]).not.toHaveProperty('required')
  })

  it('skips mappings missing a source or target field, and tolerates an empty list', () => {
    expect(deriveFieldRulesFromMappings([])).toEqual([])
    const rules = deriveFieldRulesFromMappings([
      { sourceField: '', targetField: 'FNumber' },
      { sourceField: 'code', targetField: '' },
      { sourceField: 'code', targetField: 'FNumber' },
    ] as Parameters<typeof deriveFieldRulesFromMappings>[0])
    expect(rules).toEqual([
      { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'FNumber', shape: 'scalar' },
    ])
  })
})

describe('summarizeFieldProvenance (DF-T1.5 preview provenance)', () => {
  it('returns null when there is no fieldProvenance (legacy preview / nothing to show)', () => {
    expect(summarizeFieldProvenance(null)).toBeNull()
    expect(summarizeFieldProvenance(undefined)).toBeNull()
    expect(summarizeFieldProvenance({})).toBeNull()
    expect(summarizeFieldProvenance({ fieldProvenance: {} })).toBeNull()
  })

  it('lists fields sorted by name with their declared source', () => {
    const summary = summarizeFieldProvenance({
      fieldProvenance: { FName: 'staging', FNumber: 'staging', FUnitGroupID: 'template', FErpClsID: 'reference_table' },
    })
    expect(summary).not.toBeNull()
    expect(summary?.entries.map((entry) => entry.field)).toEqual(['FErpClsID', 'FName', 'FNumber', 'FUnitGroupID'])
    expect(summary?.entries.find((entry) => entry.field === 'FUnitGroupID')?.source).toBe('template')
  })

  it('counts per source in canonical order (staging, template, constant, reference_table)', () => {
    const summary = summarizeFieldProvenance({
      fieldProvenance: { a: 'reference_table', b: 'staging', c: 'staging', d: 'template' },
    })
    expect(summary?.stats).toEqual([
      { source: 'staging', count: 2 },
      { source: 'template', count: 1 },
      { source: 'reference_table', count: 1 },
    ])
  })

  it('appends unknown/forward-compat sources after the canonical ones', () => {
    const summary = summarizeFieldProvenance({
      fieldProvenance: { a: 'staging', b: 'future_source' },
    })
    expect(summary?.stats).toEqual([
      { source: 'staging', count: 1 },
      { source: 'future_source', count: 1 },
    ])
  })
})

describe('integration project-scope helpers', () => {
  it.each([
    ['', false],
    ['integration-core', true],
    ['plugin-integration-core', true],
    ['tenant:integration-core', true],
    ['default:integration-core', true],
    ['myproject:integration-core', true],
    ['project_default', false],
    ['tenant:integration-core:extra', false],
    ['  tenant:integration-core  ', true],
    ['tenant:plugin-integration-core', true],
  ])('isIntegrationScopedProjectId(%j) -> %s', (input, expected) => {
    expect(isIntegrationScopedProjectId(input)).toBe(expected)
  })

  it.each([
    ['', 'tenant_1', 'tenant_1:integration-core'],
    ['', '', 'default:integration-core'],
    ['   ', 'tenant_1', 'tenant_1:integration-core'],
    ['tenant_1:integration-core', 'tenant_1', 'tenant_1:integration-core'],
    ['myproject', 'tenant_1', 'myproject:integration-core'],
    ['project_default', 'tenant_1', 'project_default:integration-core'],
    ['tenant:integration-core:extra', 'tenant_1', 'tenant:integration-core:extra:integration-core'],
    ['  myproject  ', 'tenant_1', 'myproject:integration-core'],
  ])('normalizeIntegrationProjectId(%j, %j) -> %j', (input, tenant, expected) => {
    expect(normalizeIntegrationProjectId(input, tenant)).toBe(expected)
  })

  it('normalize output is always integration-scoped', () => {
    for (const sample of ['', 'x', 'a:b', 'project_default', 'tenant:integration-core:extra']) {
      expect(isIntegrationScopedProjectId(normalizeIntegrationProjectId(sample, 'tenant_1'))).toBe(true)
    }
  })
})

describe('integration workbench service', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
  })

  it('uses single-tenant defaults when no scope is stored', () => {
    expect(getDefaultIntegrationScope()).toEqual({
      tenantId: 'default',
      workspaceId: null,
    })
  })

  it('calls backend discovery and preview endpoints with scoped URLs', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/adapters') {
        return jsonResponse([{ kind: 'http', label: 'HTTP API', roles: ['bidirectional'], supports: ['read'], advanced: false }])
      }
      if (url === '/api/integration/external-systems?tenantId=default') {
        return jsonResponse([{ id: 'sys_1', name: 'HTTP source', kind: 'http', role: 'bidirectional', status: 'active' }])
      }
      if (url === '/api/integration/external-systems') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toMatchObject({
          tenantId: 'default',
          workspaceId: null,
          projectId: 'project_1',
          id: 'metasheet_staging_project_1',
          name: 'MetaSheet staging 多维表',
          kind: 'metasheet:staging',
          role: 'source',
          status: 'active',
          config: {
            projectId: 'project_1',
            objects: {
              standard_materials: {
                sheetId: 'sheet_materials',
                fields: ['code', 'name'],
              },
            },
          },
          capabilities: {
            read: true,
            stagingSource: true,
            dryRunFriendly: true,
          },
        })
        return jsonResponse({
          id: 'metasheet_staging_project_1',
          tenantId: 'default',
          workspaceId: null,
          projectId: 'project_1',
          name: 'MetaSheet staging 多维表',
          kind: 'metasheet:staging',
          role: 'source',
          status: 'active',
          config: JSON.parse(String(init?.body)).config,
          capabilities: JSON.parse(String(init?.body)).capabilities,
        })
      }
      if (url === '/api/integration/external-systems/sys%201/objects?tenantId=default') {
        return jsonResponse([{ name: 'materials', label: 'Materials', operations: ['read'] }])
      }
      if (url === '/api/integration/external-systems/sys%201/schema?tenantId=default&object=materials') {
        return jsonResponse({ object: 'materials', fields: [{ name: 'code', label: 'Code', type: 'string' }] })
      }
      if (url === '/api/integration/staging/descriptors') {
        return jsonResponse([{ id: 'standard_materials', name: 'Standard Materials', fields: ['code', 'name'] }])
      }
      if (url === '/api/integration/external-systems/sys%201/test?tenantId=default') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({})
        return jsonResponse({
          ok: true,
          status: 200,
          system: {
            id: 'sys 1',
            name: 'HTTP source',
            kind: 'http',
            role: 'bidirectional',
            status: 'active',
            tenantId: 'default',
            workspaceId: null,
            lastTestedAt: '2026-05-12T00:00:00.000Z',
          },
        })
      }
      if (url === '/api/integration/templates/preview') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toMatchObject({
          sourceRecord: { code: 'MAT-001' },
          template: { bodyKey: 'Data' },
        })
        return jsonResponse({
          valid: true,
          payload: { Data: { FNumber: 'MAT-001' } },
          targetRecord: { FNumber: 'MAT-001' },
          errors: [],
          transformErrors: [],
          validationErrors: [],
          schemaErrors: [],
        })
      }
      if (url === '/api/integration/pipelines') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toMatchObject({
          tenantId: 'default',
          sourceSystemId: 'sys 1',
          targetSystemId: 'sys 1',
          options: {
            target: {
              autoSubmit: false,
              autoAudit: false,
            },
          },
        })
        return jsonResponse({
          id: 'pipe_1',
          tenantId: 'default',
          workspaceId: null,
          name: 'Generic pipeline',
          sourceSystemId: 'sys 1',
          sourceObject: 'materials',
          targetSystemId: 'sys 1',
          targetObject: 'material',
          mode: 'manual',
          idempotencyKeyFields: ['code'],
          options: {},
          status: 'active',
        })
      }
      if (url === '/api/integration/pipelines/pipe%201/dry-run') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          tenantId: 'default',
          mode: 'manual',
          sampleLimit: 5,
        })
        return jsonResponse({ pipelineId: 'pipe 1', dryRun: true, metrics: { rowsRead: 1, rowsWritten: 0 } })
      }
      if (url === '/api/integration/pipelines/pipe%201/run') {
        expect(init?.method).toBe('POST')
        return jsonResponse({ pipelineId: 'pipe 1', dryRun: false, metrics: { rowsWritten: 1 } })
      }
      if (url === '/api/integration/runs?tenantId=default&pipelineId=pipe+1&limit=5') {
        return jsonResponse([{ id: 'run_1', tenantId: 'default', workspaceId: null, pipelineId: 'pipe 1', mode: 'manual', status: 'succeeded', rowsRead: 1, rowsCleaned: 1, rowsWritten: 0, rowsFailed: 0 }])
      }
      if (url === '/api/integration/dead-letters?tenantId=default&pipelineId=pipe+1&status=open&limit=5') {
        return jsonResponse([{ id: 'dl_1', tenantId: 'default', workspaceId: null, pipelineId: 'pipe 1', runId: 'run_1', errorCode: 'VALIDATION_FAILED', errorMessage: 'missing code', status: 'open' }])
      }
      throw new Error(`unexpected URL ${url}`)
    })

    await expect(listIntegrationAdapters()).resolves.toHaveLength(1)
    await expect(listWorkbenchExternalSystems({ tenantId: 'default' })).resolves.toHaveLength(1)
    await expect(upsertWorkbenchExternalSystem({
      tenantId: 'default',
      workspaceId: null,
      projectId: 'project_1',
      id: 'metasheet_staging_project_1',
      name: 'MetaSheet staging 多维表',
      kind: 'metasheet:staging',
      role: 'source',
      status: 'active',
      config: {
        projectId: 'project_1',
        objects: {
          standard_materials: {
            sheetId: 'sheet_materials',
            fields: ['code', 'name'],
          },
        },
      },
      capabilities: {
        read: true,
        stagingSource: true,
        dryRunFriendly: true,
      },
    })).resolves.toMatchObject({
      id: 'metasheet_staging_project_1',
      kind: 'metasheet:staging',
      role: 'source',
    })
    await expect(listExternalSystemObjects('sys 1', { tenantId: 'default' })).resolves.toHaveLength(1)
    await expect(getExternalSystemSchema('sys 1', { tenantId: 'default', object: 'materials' })).resolves.toMatchObject({
      object: 'materials',
      fields: [{ name: 'code', label: 'Code', type: 'string' }],
    })
    await expect(listIntegrationStagingDescriptors()).resolves.toEqual([
      { id: 'standard_materials', name: 'Standard Materials', fields: ['code', 'name'] },
    ])
    await expect(testExternalSystemConnection('sys 1', { tenantId: 'default' })).resolves.toMatchObject({
      ok: true,
      system: { id: 'sys 1', status: 'active' },
    })
    await expect(previewIntegrationTemplate({
      sourceRecord: { code: 'MAT-001' },
      fieldMappings: [{ sourceField: 'code', targetField: 'FNumber' }],
      template: { bodyKey: 'Data' },
    })).resolves.toMatchObject({
      valid: true,
      payload: { Data: { FNumber: 'MAT-001' } },
    })
    await expect(upsertIntegrationPipeline({
      tenantId: 'default',
      name: 'Generic pipeline',
      sourceSystemId: 'sys 1',
      sourceObject: 'materials',
      targetSystemId: 'sys 1',
      targetObject: 'material',
      mode: 'manual',
      idempotencyKeyFields: ['code'],
      options: { target: { autoSubmit: false, autoAudit: false } },
      status: 'active',
      fieldMappings: [{ sourceField: 'code', targetField: 'FNumber' }],
    })).resolves.toMatchObject({ id: 'pipe_1' })
    await expect(runIntegrationPipeline('pipe 1', {
      tenantId: 'default',
      mode: 'manual',
      sampleLimit: 5,
    }, true)).resolves.toMatchObject({ dryRun: true })
    await expect(runIntegrationPipeline('pipe 1', {
      tenantId: 'default',
      mode: 'manual',
    }, false)).resolves.toMatchObject({ dryRun: false })
    await expect(listIntegrationPipelineRuns({
      tenantId: 'default',
      pipelineId: 'pipe 1',
      limit: 5,
    })).resolves.toHaveLength(1)
    await expect(listIntegrationDeadLetters({
      tenantId: 'default',
      pipelineId: 'pipe 1',
      status: 'open',
      limit: 5,
    })).resolves.toHaveLength(1)
  })
})

describe('integration dead-letter replay service', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    if (typeof localStorage?.clear === 'function') localStorage.clear()
  })

  it.each([
    ['open', true],
    ['replayed', false],
    ['discarded', false],
    ['unknown', false],
  ])('isDeadLetterReplayable(status=%s) -> %s', (status, expected) => {
    expect(isDeadLetterReplayable({ status })).toBe(expected)
  })

  it('replays a dead letter via the existing :id/replay route and returns the envelope data', async () => {
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/integration/dead-letters/dl%201/replay') {
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          tenantId: 'default',
          workspaceId: null,
          mode: 'manual',
        })
        return jsonResponse({
          deadLetter: { id: 'dl 1', status: 'replayed' },
          replay: { run: { id: 'run_9' }, metrics: { rowsWritten: 1, rowsFailed: 0 } },
        })
      }
      throw new Error(`unexpected URL ${url}`)
    })

    await expect(replayIntegrationDeadLetter('dl 1', {
      tenantId: 'default',
      workspaceId: null,
      mode: 'manual',
    })).resolves.toMatchObject({
      deadLetter: { id: 'dl 1', status: 'replayed' },
      replay: { metrics: { rowsFailed: 0 } },
    })
  })

  it('surfaces a backend replay error (e.g. 501 REPLAY_NOT_IMPLEMENTED)', async () => {
    apiFetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ ok: false, error: { code: 'REPLAY_NOT_IMPLEMENTED', message: 'Dead-letter replay is not implemented' } }),
      { status: 501, headers: { 'Content-Type': 'application/json' } },
    ))
    await expect(replayIntegrationDeadLetter('dl 1', { tenantId: 'default' }))
      .rejects.toThrow('Dead-letter replay is not implemented')
  })

  it('surfaces a 403 when the caller lacks write permission on the replay route', async () => {
    // Replay is a write — the backend route enforces requireAccess(req, 'write').
    // A forbidden caller must see the error, not a silent success.
    apiFetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'write permission required' } }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    ))
    await expect(replayIntegrationDeadLetter('dl 1', { tenantId: 'default' }))
      .rejects.toThrow('write permission required')
  })
})

describe('integration provenance read service (DF-N2-3)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('reads a row cross-run timeline by-rowId with rowId + pipelineId + scope on the GET, and coerces to an array', async () => {
    const calls: Array<{ url: string; method?: string }> = []
    apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method })
      if (url.startsWith('/api/integration/provenance')) {
        return jsonResponse([
          {
            runId: 'run_a',
            pipelineId: 'pipe_x',
            rowId: 'MAT-9',
            eventType: 'target_write_failed',
            at: '2026-05-28T00:00:00.000Z',
            attrs: { errorCode: 'VALIDATION_FAILED' },
            eventIndex: 0,
            runStatus: 'partial',
            runMode: 'manual',
            runCreatedAt: '2026-05-28T00:00:00.000Z',
          },
        ])
      }
      throw new Error(`unexpected URL ${url}`)
    })

    const entries = await listIntegrationProvenanceByRow({
      tenantId: 'default',
      rowId: 'MAT-9',
      pipelineId: 'pipe_x',
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ runId: 'run_a', rowId: 'MAT-9', eventType: 'target_write_failed' })

    // The GET carries rowId + pipelineId (collision guard) + tenant scope; read-only.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/api/integration/provenance?')
    expect(calls[0].url).toContain('rowId=MAT-9')
    expect(calls[0].url).toContain('pipelineId=pipe_x')
    expect(calls[0].url).toContain('tenantId=default')
    expect(calls[0].method ?? 'GET').toBe('GET')
  })

  it('omits empty optional params and tolerates a non-array body', async () => {
    const calls: string[] = []
    apiFetchMock.mockImplementation(async (url: string) => {
      calls.push(url)
      // Non-array body (e.g. an unexpected envelope) must coerce to [].
      return jsonResponse({ unexpected: true })
    })
    const entries = await listIntegrationProvenanceByRow({ tenantId: 'default', rowId: 'MAT-1' })
    expect(entries).toEqual([])
    // No pipelineId/from/to/limit/offset provided → those keys are absent from the query.
    expect(calls[0]).not.toContain('pipelineId=')
    expect(calls[0]).not.toContain('from=')
    expect(calls[0]).not.toContain('limit=')
    expect(calls[0]).toContain('rowId=MAT-1')
  })
})

// 列表回退 vs upsert/delete 不回退 —— 屏幕侧的那条判据。
//
// 背景:GET /api/integration/external-systems 对非 null 的 workspace hint 会回退一步,把同租户
// workspace_id IS NULL 的行也列出来;而 upsert 的 findExisting 与 delete 仍按 (tenant, workspace, id)
// 精确匹配。所以「列表里能看见」不等于「在这个作用域里改得动」,工作台的连接清单又恰好是带写按钮的清单。
//
// 口径:拦的是编辑/停用/启用/删除四个,**不是「只读」** —— 测试连接按行自身的作用域写回该行
// (服务端 persistExternalSystemTestResult,#5534),下面第二个 describe 钉着文案必须说出这件事。
describe('externalSystemScopeWriteBlock (回退来的行在当前作用域内改不动/停不掉/删不了)', () => {
  it('放行:行的作用域与当前 hint 一致(含两边都是租户级 null)', () => {
    expect(externalSystemScopeWriteBlock({ workspaceId: null }, { workspaceId: null })).toBe('')
    expect(externalSystemScopeWriteBlock({ workspaceId: null }, {})).toBe('')
    expect(externalSystemScopeWriteBlock({ workspaceId: 'ws_a' }, { workspaceId: 'ws_a' })).toBe('')
    // 空串/空白 hint 与 null 同义(与后端 normalizeWorkspaceId 同形)
    expect(externalSystemScopeWriteBlock({ workspaceId: null }, { workspaceId: '  ' })).toBe('')
    expect(isExternalSystemWritableInScope({ workspaceId: null }, { workspaceId: '' })).toBe(true)
  })

  it('拦下:带 hint 的调用方看到的租户级行 —— 四个写动作服务端会 409/404 拒掉', () => {
    const message = externalSystemScopeWriteBlock({ workspaceId: null }, { workspaceId: 'default' })
    expect(message).toContain('租户级')
    // 枚举四个动作,不准再用「只读」这种盖过测试连接的说法。
    for (const action of ['编辑', '停用', '启用', '删除']) {
      expect(message).toContain(action)
    }
    expect(message).not.toContain('只读')
    expect(isExternalSystemWritableInScope({ workspaceId: null }, { workspaceId: 'default' })).toBe(false)
  })

  it('文案必须说出测试连接仍会写这行 —— 置灰的量 ≠ 实际写不动的量', () => {
    const message = externalSystemScopeWriteBlock({ workspaceId: null }, { workspaceId: 'default' })
    expect(message).toContain('测试连接')
    expect(message).toContain('status')
  })

  it('拦下:另一个工作区的行', () => {
    expect(externalSystemScopeWriteBlock({ workspaceId: 'ws_b' }, { workspaceId: 'ws_a' }))
      .toContain('另一个工作区')
  })

  // 去掉 scopeFallback 线路字段后的回归防线:判据必须只看「这次写将要带上的 hint」。
  // 旧实现把服务端标记当第二条判据,而标记钉在拉列表那一刻:操作员按提示清空工作区输入框后
  // (工作台不会重拉列表),陈旧标记会继续拦住那条本来会成功的租户级写。
  it('hint 清空后同一行重新可写 —— 判据跟着实时 hint 走,不跟着拉列表那一刻走', () => {
    const tenantWideRow = { workspaceId: null }
    expect(externalSystemScopeWriteBlock(tenantWideRow, { workspaceId: 'default' })).not.toBe('')
    expect(externalSystemScopeWriteBlock(tenantWideRow, { workspaceId: null })).toBe('')
  })
})

// 测试连接不在拦截名单里,但要如实告知写到了哪一行。
// 服务端 POST /external-systems/{id}/test 读到系统后,persistExternalSystemTestResult 故意按行自己的
// 作用域落库(#5534),所以回退来的租户级行是真的被改了 status/last_tested_at/last_error。
describe('externalSystemScopeTestWriteNote (测试连接写到了哪一行)', () => {
  it('回退来的租户级行:提示写入的是租户级那一行', () => {
    const note = externalSystemScopeTestWriteNote({ workspaceId: null }, { workspaceId: 'default' })
    expect(note).toContain('租户级')
  })

  it('自己作用域内的行、以及本来就没带 hint 的调用方:一律不加提示', () => {
    expect(externalSystemScopeTestWriteNote({ workspaceId: 'default' }, { workspaceId: 'default' })).toBe('')
    expect(externalSystemScopeTestWriteNote({ workspaceId: null }, { workspaceId: null })).toBe('')
    expect(externalSystemScopeTestWriteNote({ workspaceId: null }, {})).toBe('')
    expect(externalSystemScopeTestWriteNote({ workspaceId: 'ws_b' }, { workspaceId: 'ws_a' })).toBe('')
    expect(externalSystemScopeTestWriteNote(null, { workspaceId: 'default' })).toBe('')
  })
})
