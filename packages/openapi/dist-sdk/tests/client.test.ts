import { describe, expect, it, vi } from 'vitest'

import { createPlmFederationClient, createPlmWorkbenchClient } from '../client.js'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  })
}

describe('createPlmFederationClient', () => {
  it('posts products query with pagination and filters', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { items: [], total: 0, limit: 25, offset: 50 },
      }),
    )

    const client = createPlmFederationClient({
      baseUrl: 'http://localhost:8910/',
      getToken: () => 'token-1',
      fetch: fetchMock,
    })

    await client.listProducts({
      query: 'motor',
      itemType: 'part',
      limit: 25,
      offset: 50,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8910/api/federation/plm/query')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer token-1',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      operation: 'products',
      pagination: { limit: 25, offset: 50 },
      filters: { query: 'motor', itemType: 'part' },
    })
  })

  it('encodes product detail and bom GET requests', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'ITEM/A-1' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { items: [], total: 0 } }))

    const client = createPlmFederationClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-2',
      fetch: fetchMock,
    })

    await client.getProduct('ITEM/A-1', { itemType: 'part', itemNumber: 'P-100' })
    await client.getBom('ITEM/A-1', { depth: 3, effectiveAt: '2026-03-08T00:00:00Z' })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:8910/api/federation/plm/products/ITEM%2FA-1?itemType=part&itemNumber=P-100',
    )
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://localhost:8910/api/federation/plm/products/ITEM%2FA-1/bom?depth=3&effective_at=2026-03-08T00%3A00%3A00Z',
    )
  })

  it('omits the approvals status filter when set to all', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { items: [], total: 0 },
      }),
    )

    const client = createPlmFederationClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-3',
      fetch: fetchMock,
    })

    await client.listApprovals({
      productId: 'ITEM-1000',
      status: 'all',
    })

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      operation: 'approvals',
      productId: 'ITEM-1000',
    })
  })

  it('sends approval history, where-used, bom compare, and substitutes operations', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { approvalId: 'ECO-42', items: [], total: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { parents: [] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { added: [], removed: [], changed: [] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { substitutes: [] } }))

    const client = createPlmFederationClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-4',
      fetch: fetchMock,
    })

    await expect(client.getApprovalHistory('ECO-42')).resolves.toEqual({
      approvalId: 'ECO-42',
      items: [],
      total: 0,
    })
    await client.getWhereUsed({ itemId: 'COMP-200', recursive: true, maxLevels: 4 })
    await client.compareBom({
      leftId: 'ITEM-1000',
      rightId: 'ITEM-1001',
      includeChildFields: true,
      includeRelationshipProps: ['qty', 'uom'],
    })
    await client.listSubstitutes('BOM-LINE-001')

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'approval_history',
      approvalId: 'ECO-42',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      operation: 'where_used',
      itemId: 'COMP-200',
      recursive: true,
      maxLevels: 4,
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      operation: 'bom_compare',
      leftId: 'ITEM-1000',
      rightId: 'ITEM-1001',
      leftType: 'item',
      rightType: 'item',
      includeChildFields: true,
      includeRelationshipProps: ['qty', 'uom'],
    })
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      operation: 'substitutes',
      bomLineId: 'BOM-LINE-001',
    })
  })

  it('supports documents and approval mutation helpers', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { items: [], total: 0, limit: 100, offset: 0 } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'ECO-42', status: 'approved' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { id: 'ECO-42', status: 'rejected' } }))

    const client = createPlmFederationClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-5',
      fetch: fetchMock,
    })

    await client.listDocuments({ productId: 'ITEM-1000', role: 'primary' })
    await client.approveApproval({ approvalId: 'ECO-42', version: 2, comment: 'ok' })
    await client.rejectApproval({
      approvalId: 'ECO-42',
      version: 3,
      reason: 'needs revision',
      comment: 'needs revision',
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'documents',
      productId: 'ITEM-1000',
      pagination: { limit: 100, offset: 0 },
      filters: { role: 'primary' },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      operation: 'approval_approve',
      approvalId: 'ECO-42',
      version: 2,
      comment: 'ok',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      operation: 'approval_reject',
      approvalId: 'ECO-42',
      version: 3,
      reason: 'needs revision',
      comment: 'needs revision',
    })
  })

  it('preserves structured approval conflict metadata on mutation failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: false,
        error: {
          code: 'APPROVAL_VERSION_CONFLICT',
          message: 'Approval instance version mismatch',
          currentVersion: 4,
        },
      }, { status: 409 }),
    )

    const client = createPlmFederationClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-7',
      fetch: fetchMock,
    })

    await expect(
      client.approveApproval({ approvalId: 'ECO-42', version: 3 }),
    ).rejects.toMatchObject({
      message: 'Approval instance version mismatch',
      code: 'APPROVAL_VERSION_CONFLICT',
      currentVersion: 4,
    })
  })

  it('supports schema, substitute mutations, and CAD helpers', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { line_fields: [] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { ok: true } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { ok: true } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1', properties: {} } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1', state: {} } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1', review: {} } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1', entries: [] } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1', other_file_id: 'FILE-2' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1', stats: {} } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: { file_id: 'FILE-1' } }))

    const client = createPlmFederationClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-6',
      fetch: fetchMock,
    })

    await client.getBomCompareSchema()
    await client.addSubstitute({ bomLineId: 'LINE-1', substituteItemId: 'PART-2', properties: { source: 'test' } })
    await client.removeSubstitute({ bomLineId: 'LINE-1', substituteId: 'SUB-1' })
    await client.getCadProperties('FILE-1')
    await client.getCadViewState('FILE-1')
    await client.getCadReview('FILE-1')
    await client.getCadHistory('FILE-1')
    await client.getCadDiff({ fileId: 'FILE-1', otherFileId: 'FILE-2' })
    await client.getCadMeshStats('FILE-1')
    await client.updateCadProperties({ fileId: 'FILE-1', payload: { properties: { material: 'AL' } } })
    await client.updateCadViewState({ fileId: 'FILE-1', payload: { hidden_entity_ids: [1, 2] } })
    await client.updateCadReview({ fileId: 'FILE-1', payload: { state: 'approved' } })

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      operation: 'bom_compare_schema',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      operation: 'substitutes_add',
      bomLineId: 'LINE-1',
      substituteItemId: 'PART-2',
      properties: { source: 'test' },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      operation: 'substitutes_remove',
      bomLineId: 'LINE-1',
      substituteId: 'SUB-1',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body))).toEqual({
      operation: 'cad_diff',
      fileId: 'FILE-1',
      otherFileId: 'FILE-2',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[9]?.[1]?.body))).toEqual({
      operation: 'cad_properties_update',
      fileId: 'FILE-1',
      payload: { properties: { material: 'AL' } },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[10]?.[1]?.body))).toEqual({
      operation: 'cad_view_state_update',
      fileId: 'FILE-1',
      payload: { hidden_entity_ids: [1, 2] },
    })
    expect(JSON.parse(String(fetchMock.mock.calls[11]?.[1]?.body))).toEqual({
      operation: 'cad_review_update',
      fileId: 'FILE-1',
      payload: { state: 'approved' },
    })
  })
})

describe('createPlmWorkbenchClient', () => {
  it('supports team view list and mutation helpers', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: [{ id: 'view-1', kind: 'documents', name: 'Docs' }],
        metadata: {
          total: 3,
          activeTotal: 2,
          archivedTotal: 1,
          tenantId: 'tenant-a',
          kind: 'documents',
          defaultViewId: 'view-1',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 'view-1', kind: 'documents', name: 'Docs updated' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 'view-2', kind: 'documents', name: 'Docs copy' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          action: 'archive',
          processedIds: ['view-1'],
          skippedIds: ['view-2'],
          items: [{ id: 'view-1', kind: 'documents', name: 'Docs archived' }],
        },
        metadata: {
          requestedTotal: 2,
          processedTotal: 1,
          skippedTotal: 1,
          processedKinds: ['documents'],
        },
      }))

    const client = createPlmWorkbenchClient({
      baseUrl: 'http://localhost:8910/',
      getToken: () => 'token-workbench',
      fetch: fetchMock,
    })

    await expect(client.listTeamViews('documents')).resolves.toEqual({
      items: [{ id: 'view-1', kind: 'documents', name: 'Docs' }],
      metadata: {
        total: 3,
        activeTotal: 2,
        archivedTotal: 1,
        tenantId: 'tenant-a',
        kind: 'documents',
        defaultViewId: 'view-1',
      },
    })
    await expect(client.renameTeamView('view-1', 'Docs updated')).resolves.toEqual({
      id: 'view-1',
      kind: 'documents',
      name: 'Docs updated',
    })
    await expect(client.duplicateTeamView('view-1')).resolves.toEqual({
      id: 'view-2',
      kind: 'documents',
      name: 'Docs copy',
    })
    await expect(client.batchTeamViews('archive', ['view-1', 'view-2'])).resolves.toEqual({
      action: 'archive',
      processedIds: ['view-1'],
      skippedIds: ['view-2'],
      items: [{ id: 'view-1', kind: 'documents', name: 'Docs archived' }],
      metadata: {
        requestedTotal: 2,
        processedTotal: 1,
        skippedTotal: 1,
        processedKinds: ['documents'],
      },
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:8910/api/plm-workbench/views/team?kind=documents',
    )
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('PATCH')
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      name: 'Docs updated',
    })
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({})
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      action: 'archive',
      ids: ['view-1', 'view-2'],
    })
  })

  it('supports team preset save/default/delete helpers and preserves structured errors', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 'preset-1', kind: 'bom', name: 'BOM preset' },
      }, { status: 201 }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 'preset-1', kind: 'bom', name: 'BOM preset', isDefault: true },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { id: 'preset-1', message: 'deleted' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: false,
        error: {
          code: 'PLM_TEAM_PRESET_ARCHIVED',
          message: 'Archived presets cannot be transferred',
        },
      }, { status: 409 }))

    const client = createPlmWorkbenchClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-preset',
      fetch: fetchMock,
    })

    await expect(client.saveTeamFilterPreset({
      kind: 'bom',
      name: 'BOM preset',
      state: { field: 'path', value: 'root/a', group: '机械' },
    })).resolves.toEqual({
      id: 'preset-1',
      kind: 'bom',
      name: 'BOM preset',
    })
    await expect(client.setTeamFilterPresetDefault('preset-1')).resolves.toEqual({
      id: 'preset-1',
      kind: 'bom',
      name: 'BOM preset',
      isDefault: true,
    })
    await expect(client.deleteTeamFilterPreset('preset-1')).resolves.toEqual({
      id: 'preset-1',
      message: 'deleted',
    })
    await expect(client.transferTeamFilterPreset('preset-1', 'user-2')).rejects.toMatchObject({
      message: 'Archived presets cannot be transferred',
      code: 'PLM_TEAM_PRESET_ARCHIVED',
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:8910/api/plm-workbench/filter-presets/team')
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      kind: 'bom',
      name: 'BOM preset',
      state: { field: 'path', value: 'root/a', group: '机械' },
    })
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe('DELETE')
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      ownerUserId: 'user-2',
    })
  })

  it('supports team preset list metadata helpers', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: [{ id: 'preset-1', kind: 'bom', name: 'BOM preset' }],
        metadata: {
          total: 4,
          activeTotal: 3,
          archivedTotal: 1,
          tenantId: 'tenant-a',
          kind: 'bom',
          defaultPresetId: 'preset-1',
        },
      }))

    const client = createPlmWorkbenchClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-preset',
      fetch: fetchMock,
    })

    await expect(client.listTeamFilterPresets('bom')).resolves.toEqual({
      items: [{ id: 'preset-1', kind: 'bom', name: 'BOM preset' }],
      metadata: {
        total: 4,
        activeTotal: 3,
        archivedTotal: 1,
        tenantId: 'tenant-a',
        kind: 'bom',
        defaultPresetId: 'preset-1',
      },
    })
  })

  it('supports collaborative audit list and summary helpers', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          items: [
            {
              id: 'log-1',
              action: 'archive',
            },
          ],
          page: 2,
          pageSize: 20,
          total: 35,
        },
        metadata: {
          resourceTypes: ['plm-team-view-batch', 'plm-team-preset-default'],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          windowMinutes: 180,
          actions: [{ action: 'archive', total: 4 }],
          resourceTypes: [{ resourceType: 'plm-team-view-batch', total: 6 }],
        },
      }))

    const client = createPlmWorkbenchClient({
      baseUrl: 'http://localhost:8910',
      getToken: () => 'token-audit',
      fetch: fetchMock,
    })

    await expect(client.listCollaborativeAuditLogs({
      page: 2,
      pageSize: 20,
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      kind: 'documents',
    })).resolves.toEqual({
      items: [{ id: 'log-1', action: 'archive' }],
      page: 2,
      pageSize: 20,
      total: 35,
      metadata: {
        resourceTypes: ['plm-team-view-batch', 'plm-team-preset-default'],
      },
    })

    await expect(client.getCollaborativeAuditSummary({
      windowMinutes: 180,
      limit: 6,
    })).resolves.toEqual({
      windowMinutes: 180,
      actions: [{ action: 'archive', total: 4 }],
      resourceTypes: [{ resourceType: 'plm-team-view-batch', total: 6 }],
    })

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:8910/api/plm-workbench/audit-logs?page=2&pageSize=20&action=archive&resourceType=plm-team-view-batch&kind=documents',
    )
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://localhost:8910/api/plm-workbench/audit-logs/summary?windowMinutes=180&limit=6',
    )
  })
})
