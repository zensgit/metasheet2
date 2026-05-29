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
