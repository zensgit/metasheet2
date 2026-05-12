import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getDefaultIntegrationScope,
  getExternalSystemSchema,
  listIntegrationDeadLetters,
  listExternalSystemObjects,
  listIntegrationAdapters,
  listIntegrationPipelineRuns,
  listIntegrationStagingDescriptors,
  listWorkbenchExternalSystems,
  previewIntegrationTemplate,
  runIntegrationPipeline,
  testExternalSystemConnection,
  upsertIntegrationPipeline,
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
