import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

const createAdapter = () => {
  const configService = { get: vi.fn().mockResolvedValue(undefined) }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const adapter = new PLMAdapter(configService as any, logger as any)
  ;(adapter as any).apiMode = 'yuantus'
  ;(adapter as any).mockMode = false
  ;(adapter as any).yuantusItemType = 'Part'
  return adapter
}

describe('PLMAdapter runtime status', () => {
  it('advertises release readiness in yuantus mode', () => {
    const adapter = createAdapter()

    expect(adapter.getRuntimeStatus()).toMatchObject({
      implementation: 'real',
      healthSupported: true,
    })
    expect(adapter.getRuntimeStatus().supportedOperations).toContain('release_readiness')
    expect(adapter.getRuntimeStatus().supportedOperations).toContain('approval_history')
    expect(adapter.getRuntimeStatus().supportedOperations).toContain('metadata')
  })

  it('hides yuantus-only capabilities in legacy mode', () => {
    const adapter = createAdapter()
    ;(adapter as any).apiMode = 'legacy'

    expect(adapter.getRuntimeStatus().supportedOperations).toEqual(
      expect.arrayContaining(['products', 'bom', 'documents', 'approvals'])
    )
    expect(adapter.getRuntimeStatus().supportedOperations).not.toContain('release_readiness')
    expect(adapter.getRuntimeStatus().supportedOperations).not.toContain('approval_history')
    expect(adapter.getRuntimeStatus().supportedOperations).not.toContain('where_used')
    expect(adapter.getRuntimeStatus().supportedOperations).not.toContain('cad_properties')
    expect(adapter.getRuntimeStatus().supportedOperations).not.toContain('metadata')
  })
})

describe('PLMAdapter Yuantus product detail mapping', () => {
  it('merges search hit timestamps when AML detail lacks them', async () => {
    const adapter = createAdapter()
    const selectMock = vi.fn().mockResolvedValue({
      data: [{
        id: 'item-123',
        type: 'Part',
        state: 'Released',
        properties: { name: 'Test Part', item_number: 'PN-001' },
      }],
    })
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        total: 1,
        hits: [{
          id: 'item-123',
          item_type_id: 'Part',
          name: 'Test Part',
          item_number: 'PN-001',
          created_at: '2025-01-01T00:00:00.000Z',
          updated_at: '2025-01-02T00:00:00.000Z',
          properties: { item_number: 'PN-001' },
        }],
      }],
    })

    ;(adapter as any).select = selectMock
    ;(adapter as any).query = queryMock

    const product = await adapter.getProductById('item-123', { itemType: 'Part' })

    expect(queryMock).toHaveBeenCalledWith('/api/v1/search/', [
      expect.objectContaining({ q: 'item-123', item_type: 'Part' }),
    ])
    expect(product?.created_at).toBe('2025-01-01T00:00:00.000Z')
    expect(product?.updated_at).toBe('2025-01-02T00:00:00.000Z')
    expect(product?.code).toBe('PN-001')
    expect(product?.itemType).toBe('Part')
  })

  it('skips search when AML detail already contains timestamps', async () => {
    const adapter = createAdapter()
    const selectMock = vi.fn().mockResolvedValue({
      data: [{
        id: 'item-456',
        type: 'Part',
        state: 'Draft',
        created_on: '2025-02-01T00:00:00.000Z',
        modified_on: '2025-02-02T00:00:00.000Z',
        properties: { name: 'Draft Part', item_number: 'PN-002' },
      }],
    })
    const queryMock = vi.fn()

    ;(adapter as any).select = selectMock
    ;(adapter as any).query = queryMock

    const product = await adapter.getProductById('item-456', { itemType: 'Part' })

    expect(queryMock).not.toHaveBeenCalled()
    expect(product?.created_at).toBe('2025-02-01T00:00:00.000Z')
    expect(product?.updated_at).toBe('2025-02-02T00:00:00.000Z')
    expect(product?.code).toBe('PN-002')
  })

  it('falls back to search when AML lookup misses and matches item number', async () => {
    const adapter = createAdapter()
    const selectMock = vi.fn().mockResolvedValue({ data: [] })
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        total: 1,
        hits: [{
          id: 'item-999',
          item_type_id: 'Part',
          name: 'Number Part',
          item_number: 'PN-999',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
          properties: { item_number: 'PN-999', name: 'Number Part' },
        }],
      }],
    })

    ;(adapter as any).select = selectMock
    ;(adapter as any).query = queryMock

    const product = await adapter.getProductById('PN-999', { itemType: 'Part' })

    expect(queryMock).toHaveBeenCalledWith('/api/v1/search/', [
      expect.objectContaining({ q: 'PN-999', item_type: 'Part' }),
    ])
    expect(product?.id).toBe('item-999')
    expect(product?.partNumber).toBe('PN-999')
    expect(product?.name).toBe('Number Part')
  })
})

describe('PLMAdapter Yuantus documents mapping', () => {
  it('merges file attachments with AML related documents and resolves URLs', async () => {
    const adapter = createAdapter()
    ;(adapter as any).config.connection.url = 'http://plm.local'

    const queryMock = vi.fn(async (path: string) => {
      if (path.startsWith('/api/v1/file/item/')) {
        return {
          data: [{
            file_id: 'file-1',
            filename: 'entry-name.dwg',
            file_role: 'primary',
            document_type: 'drawing',
            document_version: 'A',
            file_size: 512,
            preview_url: '/files/preview/file-1',
            download_url: 'http://cdn.local/download/file-1',
          }],
        }
      }
      if (path === '/api/v1/file/file-1') {
        return {
          data: [{
            filename: 'meta-name.dwg',
            document_type: 'drawing',
            document_version: 'B',
            file_size: 2048,
            mime_type: 'application/dwg',
            created_at: '2026-01-01T00:00:00.000Z',
          }],
        }
      }
      return { data: [] }
    })
    const selectMock = vi.fn(async (path: string) => {
      if (path === '/api/v1/aml/query') {
        return {
          data: [{
            id: 'item-1',
            name: 'Root Part',
            state: 'Released',
            config_id: 'cfg-root',
            'Document Part': [{
              id: 'doc-2',
              name: 'Spec Document',
              state: 'Draft',
              item_number: 'DOC-002',
              config_id: 'cfg-doc-2',
              current_version_id: 'ver-2',
              properties: {
                document_type: 'specification',
                engineering_state: 'draft',
              },
            }],
          }],
        }
      }
      return { data: [] }
    })

    ;(adapter as any).query = queryMock
    ;(adapter as any).select = selectMock

    const result = await adapter.getProductDocuments('item-1')

    expect(queryMock).toHaveBeenCalledWith('/api/v1/file/item/item-1', [expect.any(Object)])
    expect(selectMock).toHaveBeenCalledWith('/api/v1/aml/query', expect.objectContaining({
      method: 'POST',
      data: expect.objectContaining({
        type: 'Part',
        where: { id: 'item-1' },
        expand: ['Document Part'],
      }),
    }))
    expect(queryMock).toHaveBeenCalledWith('/api/v1/file/file-1')
    expect(result.data).toHaveLength(2)

    const [doc, relatedDoc] = result.data
    expect(doc.id).toBe('file-1')
    expect(doc.name).toBe('meta-name.dwg')
    expect(doc.document_type).toBe('drawing')
    expect(doc.engineering_revision).toBe('B')
    expect(doc.file_size).toBe(2048)
    expect(doc.mime_type).toBe('application/dwg')
    expect(doc.preview_url).toBe('http://plm.local/files/preview/file-1')
    expect(doc.download_url).toBe('http://cdn.local/download/file-1')
    expect(doc.is_production_doc).toBe(true)
    expect(doc.metadata?.file_role).toBe('primary')

    expect(relatedDoc.id).toBe('doc-2')
    expect(relatedDoc.name).toBe('Spec Document')
    expect(relatedDoc.document_type).toBe('specification')
    expect(relatedDoc.engineering_state).toBe('Draft')
    expect(relatedDoc.item_number).toBe('DOC-002')
    expect(relatedDoc.config_id).toBe('cfg-doc-2')
    expect(relatedDoc.current_version_id).toBe('ver-2')
    expect(relatedDoc.metadata?.config_id).toBe('cfg-doc-2')
  })

  it('deduplicates merged documents by id and file id', async () => {
    const adapter = createAdapter()

    const queryMock = vi.fn(async (path: string) => {
      if (path.startsWith('/api/v1/file/item/')) {
        return {
          data: [{
            file_id: 'shared-1',
            filename: 'shared.dwg',
            file_role: 'primary',
            document_type: 'drawing',
          }],
        }
      }
      return { data: [] }
    })
    const selectMock = vi.fn(async (path: string) => {
      if (path === '/api/v1/aml/query') {
        return {
          data: [{
            id: 'item-1',
            'Document Part': [{
              id: 'shared-1',
              name: 'Shared Document',
              state: 'Released',
              item_number: 'DOC-SHARED',
            }],
          }],
        }
      }
      return { data: [] }
    })

    ;(adapter as any).query = queryMock
    ;(adapter as any).select = selectMock

    const result = await adapter.getProductDocuments('item-1')

    expect(result.data).toHaveLength(1)
    expect(result.data[0].id).toBe('shared-1')
  })
})

describe('PLMAdapter Yuantus metadata mapping', () => {
  it('loads AML item metadata through the dedicated metadata route', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        id: 'Part',
        label: 'Part',
        is_relationship: false,
        properties: [
          {
            name: 'item_number',
            label: '料号',
            type: 'string',
            required: true,
            length: 64,
            default: null,
          },
        ],
      }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getItemMetadata('Part')

    expect(queryMock).toHaveBeenCalledWith('/api/v1/aml/metadata/Part')
    expect(result.error).toBeUndefined()
    expect(result.metadata?.totalCount).toBe(1)
    expect(result.data).toEqual([{
      id: 'Part',
      label: 'Part',
      is_relationship: false,
      properties: [{
        name: 'item_number',
        label: '料号',
        type: 'string',
        required: true,
        length: 64,
        default: null,
      }],
    }])
  })
})

describe('PLMAdapter Yuantus approvals mapping', () => {
  it('maps ECO approvals, forwards collection filters, and filters by status', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [
        { id: 'eco-1', name: 'ECO One', state: 'done', version: 12, created_by_id: 7, created_at: '2026-01-01T00:00:00.000Z', product_id: 'prod-1' },
        { id: 'eco-2', name: 'ECO Two', state: 'rejected', version: '   ', created_by_id: '8', created_at: '2026-01-02T00:00:00.000Z' },
        { id: 'eco-3', name: 'ECO Three', state: 'in_review', version: '3', created_by_id: '9', created_at: '2026-01-03T00:00:00.000Z' },
      ],
    })
    const getProductByIdSpy = vi.spyOn(adapter, 'getProductById').mockResolvedValue({
      id: 'prod-1',
      name: 'Mapped Product',
      code: 'P-0001',
      partNumber: 'P-0001',
      version: 'A',
      status: 'Released',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    })

    ;(adapter as any).query = queryMock

    const approved = await adapter.getApprovals({
      status: 'approved',
      productId: 'prod-1',
      requesterId: '7',
      limit: 25,
      offset: 25,
    })

    expect(queryMock).toHaveBeenNthCalledWith(1, '/api/v1/eco', [
      {
        product_id: 'prod-1',
        created_by_id: '7',
        limit: 25,
        offset: 25,
      },
    ])
    expect(getProductByIdSpy).toHaveBeenCalledWith('prod-1')
    expect(approved.data).toHaveLength(1)
    expect(approved.data[0].status).toBe('approved')
    expect(approved.data[0].requester_id).toBe('7')
    expect(approved.data[0].version).toBe(12)
    expect(approved.data[0].product_number).toBe('P-0001')

    const all = await adapter.getApprovals()
    expect(queryMock).toHaveBeenNthCalledWith(2, '/api/v1/eco', [{}])
    expect(all.data).toHaveLength(3)
    expect(all.data.map((entry) => entry.status)).toEqual(['approved', 'rejected', 'pending'])
    expect(all.data.map((entry) => entry.version)).toEqual([12, undefined, 3])
  })

  it('loads one ECO approval request by id from the ECO detail endpoint', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'eco-2',
          name: 'Approve ECO',
          eco_type: 'bom',
          state: 'progress',
          version: 7,
          created_by_id: 8,
          created_by_name: 'Requester Eight',
          created_at: '2026-04-11T00:00:00.000Z',
          product_id: 'prod-1',
        },
      ],
    })

    const getProductByIdSpy = vi.spyOn(adapter, 'getProductById').mockResolvedValue({
      id: 'prod-1',
      name: 'Mounting Bracket',
      code: 'P-0001',
      partNumber: 'P-0001',
      version: 'A',
      status: 'Released',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getApprovalById('eco-2')

    expect(queryMock).toHaveBeenCalledWith('/api/v1/eco/eco-2')
    expect(getProductByIdSpy).toHaveBeenCalledWith('prod-1')
    expect(result.data).toEqual([
      expect.objectContaining({
        id: 'eco-2',
        request_type: 'bom',
        title: 'Approve ECO',
        requester_id: '8',
        requester_name: 'Requester Eight',
        status: 'pending',
        version: 7,
        product_id: 'prod-1',
        product_number: 'P-0001',
        product_name: 'Mounting Bracket',
      }),
    ])
  })
})

describe('PLMAdapter Yuantus BOM analysis and approval actions', () => {
  it('maps approval history from ECO approvals endpoint', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'approval-1',
          eco_id: 'eco-1',
          stage_id: 'stage-1',
          approval_type: 'mandatory',
          required_role: 'engineer',
          user_id: 7,
          status: 'pending',
          comment: null,
          approved_at: null,
          created_at: '2026-01-04T00:00:00.000Z',
        },
      ],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getApprovalHistory('eco-1')

    expect(queryMock).toHaveBeenCalledWith('/api/v1/eco/eco-1/approvals')
    expect(result.data).toEqual([
      {
        id: 'approval-1',
        eco_id: 'eco-1',
        stage_id: 'stage-1',
        approval_type: 'mandatory',
        required_role: 'engineer',
        user_id: 7,
        status: 'pending',
        comment: null,
        approved_at: null,
        created_at: '2026-01-04T00:00:00.000Z',
      },
    ])
  })

  it('posts approve and reject actions to ECO endpoints with optimistic-lock version payloads', async () => {
    const adapter = createAdapter()
    const selectMock = vi.fn()
      .mockResolvedValueOnce({
        data: [{
          id: 'eco-approve-1',
          status: 'approved',
          comment: 'Ship it',
          approved_at: '2026-04-11T00:00:00.000Z',
          created_at: '2026-04-11T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        data: [{
          id: 'eco-reject-1',
          status: 'rejected',
          comment: 'Missing test evidence',
          approved_at: '2026-04-11T00:00:00.000Z',
          created_at: '2026-04-11T00:00:00.000Z',
        }],
      })

    ;(adapter as any).select = selectMock

    const approved = await adapter.approveApproval('eco-approve-1', 7, 'Ship it')
    const rejected = await adapter.rejectApproval('eco-reject-1', 8, 'Missing test evidence')

    expect(selectMock).toHaveBeenNthCalledWith(1, '/api/v1/eco/eco-approve-1/approve', {
      method: 'POST',
      data: { version: 7, comment: 'Ship it' },
    })
    expect(selectMock).toHaveBeenNthCalledWith(2, '/api/v1/eco/eco-reject-1/reject', {
      method: 'POST',
      data: { version: 8, comment: 'Missing test evidence' },
    })
    expect(approved.data[0]).toMatchObject({
      id: 'eco-approve-1',
      status: 'approved',
      approved_at: '2026-04-11T00:00:00.000Z',
      created_at: '2026-04-11T00:00:00.000Z',
    })
    expect(rejected.data[0]).toMatchObject({
      id: 'eco-reject-1',
      status: 'rejected',
      approved_at: '2026-04-11T00:00:00.000Z',
      created_at: '2026-04-11T00:00:00.000Z',
    })
  })

  it('queries where-used with recursive and max-level parameters', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        item_id: 'item-child-1',
        count: 1,
        parents: [{
          relationship: { id: 'rel-1', quantity: 4 },
          parent: { id: 'item-parent-1', properties: { item_number: 'ASM-001' } },
          level: 1,
        }],
      }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getWhereUsed('item-child-1', {
      recursive: true,
      maxLevels: 4,
    })

    expect(queryMock).toHaveBeenCalledWith('/api/v1/bom/item-child-1/where-used', [
      { recursive: true, max_levels: 4 },
    ])
    expect(result.data[0]).toMatchObject({
      item_id: 'item-child-1',
      count: 1,
      parents: [expect.objectContaining({ level: 1 })],
    })
  })

  it('loads BOM compare schema from the dedicated schema endpoint', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        line_fields: [
          {
            field: 'quantity',
            severity: 'major',
            normalized: 'float',
            description: 'BOM quantity on the relationship line.',
          },
        ],
        compare_modes: [
          {
            mode: 'summarized',
            line_key: 'child_config',
            include_relationship_props: ['quantity', 'uom'],
            aggregate_quantities: true,
            aliases: ['summary'],
            description: 'Aggregate quantities for identical children.',
          },
        ],
        line_key_options: ['child_config', 'child_id'],
        defaults: {
          max_levels: 10,
          line_key: 'child_config',
        },
      }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getBomCompareSchema()

    expect(queryMock).toHaveBeenCalledWith('/api/v1/bom/compare/schema')
    expect(result.data[0]).toMatchObject({
      line_fields: [expect.objectContaining({ field: 'quantity', severity: 'major' })],
      compare_modes: [expect.objectContaining({ mode: 'summarized' })],
      line_key_options: ['child_config', 'child_id'],
      defaults: expect.objectContaining({ max_levels: 10 }),
    })
  })

  it('lists BOM substitutes from the dedicated BOM substitutes endpoint', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        bom_line_id: 'bom-line-1',
        count: 1,
        substitutes: [{
          id: 'sub-rel-1',
          relationship: {
            id: 'sub-rel-1',
            source_id: 'bom-line-1',
            related_id: 'part-sub-1',
            properties: { rank: 1, note: 'Preferred alternate' },
          },
          part: {
            id: 'part-sub-1',
            item_number: 'P-0003',
            name: 'Nut M6',
          },
          substitute_part: {
            id: 'part-sub-1',
            item_number: 'P-0003',
            name: 'Nut M6',
          },
          rank: 1,
          substitute_number: 'P-0003',
          substitute_name: 'Nut M6',
        }],
      }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getBomSubstitutes('bom-line-1')

    expect(queryMock).toHaveBeenCalledWith('/api/v1/bom/bom-line-1/substitutes')
    expect(result.data[0]).toMatchObject({
      bom_line_id: 'bom-line-1',
      count: 1,
      substitutes: [expect.objectContaining({ id: 'sub-rel-1', rank: 1 })],
    })
  })

  it('posts add/remove substitute mutations to the BOM substitutes endpoints', async () => {
    const adapter = createAdapter()
    const insertMock = vi.fn().mockResolvedValue({
      data: [{
        ok: true,
        substitute_id: 'sub-rel-new',
        bom_line_id: 'bom-line-1',
        substitute_item_id: 'part-sub-2',
      }],
    })
    const deleteMock = vi.fn().mockResolvedValue({
      data: [{
        ok: true,
        substitute_id: 'sub-rel-remove',
      }],
    })

    ;(adapter as any).insert = insertMock
    ;(adapter as any).delete = deleteMock

    const added = await adapter.addBomSubstitute('bom-line-1', 'part-sub-2', {
      rank: 2,
      note: 'Field alternate',
    })
    const removed = await adapter.removeBomSubstitute('bom-line-1', 'sub-rel-remove')

    expect(insertMock).toHaveBeenCalledWith('/api/v1/bom/bom-line-1/substitutes', {
      substitute_item_id: 'part-sub-2',
      properties: {
        rank: 2,
        note: 'Field alternate',
      },
    })
    expect(deleteMock).toHaveBeenCalledWith('/api/v1/bom/bom-line-1/substitutes/sub-rel-remove', {})
    expect(added.data[0]).toMatchObject({
      ok: true,
      substitute_id: 'sub-rel-new',
      bom_line_id: 'bom-line-1',
      substitute_item_id: 'part-sub-2',
    })
    expect(removed.data[0]).toEqual({
      ok: true,
      substitute_id: 'sub-rel-remove',
    })
  })
})

describe('PLMAdapter Yuantus CAD routes', () => {
  it('queries CAD properties, view state, review, history, diff, and mesh stats from dedicated Yuantus endpoints', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn(async (path: string, params?: Array<Record<string, unknown>>) => {
      if (path === '/api/v1/cad/files/file-props/properties') {
        return {
          data: [{
            file_id: 'file-props',
            properties: { material: 'AL-6061', finish: 'anodized' },
            updated_at: '2026-04-11T00:00:00.000Z',
            source: 'imported',
            cad_document_schema_version: 3,
          }],
        }
      }
      if (path === '/api/v1/cad/files/file-view/view-state') {
        return {
          data: [{
            file_id: 'file-view',
            hidden_entity_ids: [12, 19],
            notes: [{ entity_id: 12, note: 'check hole position', color: '#FFB020' }],
            updated_at: '2026-04-11T00:00:00.000Z',
            source: 'client',
            cad_document_schema_version: 3,
          }],
        }
      }
      if (path === '/api/v1/cad/files/file-review/review') {
        return {
          data: [{
            file_id: 'file-review',
            state: 'pending',
            note: 'Awaiting review',
            reviewed_at: '2026-04-11T00:00:00.000Z',
            reviewed_by_id: 1,
          }],
        }
      }
      if (path === '/api/v1/cad/files/file-history/history') {
        return {
          data: [{
            file_id: 'file-history',
            entries: [
              { id: 'chg-1', action: 'cad_properties_update', payload: { properties: { material: 'AL-6061' } }, created_at: '2026-04-10T00:00:00.000Z', user_id: 1 },
              { id: 'chg-2', action: 'cad_review_update', payload: { state: 'approved' }, created_at: '2026-04-11T00:00:00.000Z', user_id: 1 },
            ],
          }],
        }
      }
      if (path === '/api/v1/cad/files/file-left/diff') {
        expect(params).toEqual([{ other_file_id: 'file-right' }])
        return {
          data: [{
            file_id: 'file-left',
            other_file_id: 'file-right',
            properties: {
              added: { finish: 'anodized' },
              removed: { coating: 'none' },
              changed: { weight_kg: { from: 1.1, to: 1.2 } },
            },
            cad_document_schema_version: { from: 1, to: 2 },
          }],
        }
      }
      if (path === '/api/v1/cad/files/file-mesh/mesh-stats') {
        return {
          data: [{
            file_id: 'file-mesh',
            stats: {
              available: true,
              raw_keys: ['bounds', 'entities', 'triangle_count'],
              entity_count: 2,
              triangle_count: 102400,
              bounds: { min: [0, 0, 0], max: [10, 20, 5] },
            },
          }],
        }
      }
      return { data: [] }
    })

    ;(adapter as any).query = queryMock

    const properties = await adapter.getCadProperties('file-props')
    const viewState = await adapter.getCadViewState('file-view')
    const review = await adapter.getCadReview('file-review')
    const history = await adapter.getCadHistory('file-history')
    const diff = await adapter.getCadDiff('file-left', 'file-right')
    const meshStats = await adapter.getCadMeshStats('file-mesh')

    expect(properties.data[0]).toMatchObject({
      file_id: 'file-props',
      properties: { material: 'AL-6061', finish: 'anodized' },
      source: 'imported',
      cad_document_schema_version: 3,
    })
    expect(viewState.data[0]).toMatchObject({
      file_id: 'file-view',
      hidden_entity_ids: [12, 19],
      notes: [{ entity_id: 12, note: 'check hole position', color: '#FFB020' }],
    })
    expect(review.data[0]).toMatchObject({
      file_id: 'file-review',
      state: 'pending',
      reviewed_by_id: 1,
    })
    expect(history.data[0].entries).toHaveLength(2)
    expect(diff.data[0]).toMatchObject({
      file_id: 'file-left',
      other_file_id: 'file-right',
      cad_document_schema_version: { from: 1, to: 2 },
    })
    expect(meshStats.data[0].stats).toMatchObject({
      available: true,
      entity_count: 2,
      triangle_count: 102400,
    })
  })

  it('patches CAD properties and view state, and posts CAD review updates to dedicated Yuantus endpoints', async () => {
    const adapter = createAdapter()
    const selectMock = vi.fn(async (path: string, options: Record<string, unknown>) => {
      if (path === '/api/v1/cad/files/file-props-write/properties') {
        expect(options).toEqual({
          method: 'PATCH',
          data: {
            properties: { material: 'AL-7075', finish: 'hard-anodized' },
            source: 'manual',
          },
        })
        return {
          data: [{
            file_id: 'file-props-write',
            properties: { material: 'AL-7075', finish: 'hard-anodized' },
            updated_at: '2026-04-11T01:00:00.000Z',
            source: 'manual',
            cad_document_schema_version: 4,
          }],
        }
      }
      if (path === '/api/v1/cad/files/file-view-write/view-state') {
        expect(options).toEqual({
          method: 'PATCH',
          data: {
            hidden_entity_ids: [12, 19],
            notes: [{ entity_id: 19, note: 'hide fastener', color: '#4C9AFF' }],
            source: 'client',
            refresh_preview: false,
          },
        })
        return {
          data: [{
            file_id: 'file-view-write',
            hidden_entity_ids: [12, 19],
            notes: [{ entity_id: 19, note: 'hide fastener', color: '#4C9AFF' }],
            updated_at: '2026-04-11T01:00:00.000Z',
            source: 'client',
            cad_document_schema_version: 3,
          }],
        }
      }
      return { data: [] }
    })
    const insertMock = vi.fn(async (path: string, payload: Record<string, unknown>) => {
      if (path === '/api/v1/cad/files/file-review-write/review') {
        expect(payload).toEqual({
          state: 'approved',
          note: 'Looks good',
        })
        return {
          data: [{
            file_id: 'file-review-write',
            state: 'approved',
            note: 'Looks good',
            reviewed_at: '2026-04-11T01:00:00.000Z',
            reviewed_by_id: 1,
          }],
        }
      }
      return { data: [] }
    })

    ;(adapter as any).select = selectMock
    ;(adapter as any).insert = insertMock

    const updatedProperties = await adapter.updateCadProperties('file-props-write', {
      properties: { material: 'AL-7075', finish: 'hard-anodized' },
      source: 'manual',
    })
    const updatedViewState = await adapter.updateCadViewState('file-view-write', {
      hidden_entity_ids: [12, 19],
      notes: [{ entity_id: 19, note: 'hide fastener', color: '#4C9AFF' }],
      source: 'client',
      refresh_preview: false,
    })
    const updatedReview = await adapter.updateCadReview('file-review-write', {
      state: 'approved',
      note: 'Looks good',
    })

    expect(updatedProperties.data[0]).toMatchObject({
      file_id: 'file-props-write',
      properties: { material: 'AL-7075', finish: 'hard-anodized' },
      source: 'manual',
      cad_document_schema_version: 4,
    })
    expect(updatedViewState.data[0]).toMatchObject({
      file_id: 'file-view-write',
      hidden_entity_ids: [12, 19],
      source: 'client',
      cad_document_schema_version: 3,
    })
    expect(updatedReview.data[0]).toMatchObject({
      file_id: 'file-review-write',
      state: 'approved',
      note: 'Looks good',
      reviewed_by_id: 1,
    })
  })
})

describe('PLMAdapter Yuantus release readiness mapping', () => {
  it('maps release readiness summary/resources and adds canonical links', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        item_id: 'item-rr-1',
        generated_at: '2026-04-11T00:00:00.000Z',
        ruleset_id: 'gate-a',
        summary: {
          ok: false,
          resources: 3,
          ok_resources: 2,
          error_count: 1,
          warning_count: 1,
          by_kind: {
            mbom: {
              resources: 1,
              ok_resources: 0,
              error_count: 1,
              warning_count: 0,
            },
          },
        },
        resources: [{
          kind: 'mbom',
          name: 'MBOM Alignment',
          state: 'warning',
          diagnostics: {
            ok: false,
            resource_type: 'mbom',
            resource_id: 'mbom-1',
            ruleset_id: 'gate-a',
            errors: [{ code: 'MBOM_MISSING', message: 'MBOM baseline missing', severity: 'error' }],
            warnings: [{ code: 'ALT_ROUTE', message: 'Alternate route incomplete', severity: 'warning' }],
          },
        }],
        esign_manifest: { pending: 1 },
      }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getReleaseReadiness('item-rr-1', {
      rulesetId: 'gate-a',
      mbomLimit: 10,
      routingLimit: 12,
      baselineLimit: 8,
    })

    expect(queryMock).toHaveBeenCalledWith('/api/v1/release-readiness/items/item-rr-1', [
      {
        ruleset_id: 'gate-a',
        mbom_limit: 10,
        routing_limit: 12,
        baseline_limit: 8,
      },
    ])
    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toMatchObject({
      item_id: 'item-rr-1',
      ruleset_id: 'gate-a',
      summary: {
        ok: false,
        error_count: 1,
        by_kind: {
          mbom: {
            resources: 1,
            error_count: 1,
          },
        },
      },
      resources: [
        expect.objectContaining({
          kind: 'mbom',
          diagnostics: expect.objectContaining({
            resource_type: 'mbom',
            resource_id: 'mbom-1',
            ruleset_id: 'gate-a',
          }),
        }),
      ],
      links: {
        summary: '/api/v1/release-readiness/items/item-rr-1?ruleset_id=gate-a',
        export: '/api/v1/release-readiness/items/item-rr-1/export?export_format=zip&ruleset_id=gate-a',
      },
      esign_manifest: { pending: 1 },
    })
  })

})

describe('PLMAdapter Yuantus documents single-side failure + sources metadata', () => {
  it('returns AML related documents when file/item endpoint errors, with sources showing degradation', async () => {
    const adapter = createAdapter()

    const queryMock = vi.fn(async (path: string) => {
      if (path.startsWith('/api/v1/file/item/')) {
        return { data: [], error: new Error('file endpoint down') }
      }
      return { data: [] }
    })
    const selectMock = vi.fn(async (path: string) => {
      if (path === '/api/v1/aml/query') {
        return {
          data: [{
            id: 'item-1',
            'Document Part': [{
              id: 'doc-aml-1',
              name: 'Surviving AML Doc',
              state: 'Released',
              item_number: 'DOC-AML-1',
            }],
          }],
        }
      }
      return { data: [] }
    })

    ;(adapter as any).query = queryMock
    ;(adapter as any).select = selectMock

    const result = await adapter.getProductDocuments('item-1')
    expect(result.data).toHaveLength(1)
    expect(result.data[0].name).toBe('Surviving AML Doc')
    expect(result.error).toBeUndefined()

    // sources metadata: attachments failed, related_documents succeeded
    const sources = (result.metadata as any)?.sources
    expect(sources).toBeDefined()
    expect(sources).toHaveLength(2)
    expect(sources[0]).toMatchObject({ name: 'attachments', ok: false })
    expect(sources[0].error).toBeDefined()
    expect(sources[1]).toMatchObject({ name: 'related_documents', ok: true, count: 1 })
  })

  it('returns file attachments when AML query endpoint errors, with sources showing degradation', async () => {
    const adapter = createAdapter()

    const queryMock = vi.fn(async (path: string) => {
      if (path.startsWith('/api/v1/file/item/')) {
        return {
          data: [{
            file_id: 'file-survive-1',
            filename: 'surviving-file.pdf',
            file_role: 'primary',
            document_type: 'drawing',
          }],
        }
      }
      if (path.startsWith('/api/v1/file/')) {
        return { data: [] }
      }
      return { data: [] }
    })
    const selectMock = vi.fn(async () => {
      return { data: [], error: new Error('aml query down') }
    })

    ;(adapter as any).query = queryMock
    ;(adapter as any).select = selectMock

    const result = await adapter.getProductDocuments('item-1')
    expect(result.data).toHaveLength(1)
    expect(result.data[0].name).toBe('surviving-file.pdf')
    expect(result.error).toBeUndefined()

    // sources metadata: attachments succeeded, related_documents failed
    const sources = (result.metadata as any)?.sources
    expect(sources).toBeDefined()
    expect(sources[0]).toMatchObject({ name: 'attachments', ok: true, count: 1 })
    expect(sources[1]).toMatchObject({ name: 'related_documents', ok: false })
    expect(sources[1].error).toBeDefined()
  })

  it('propagates error and marks both sources failed when both sides fail', async () => {
    const adapter = createAdapter()

    const fileError = new Error('file side down')
    const queryMock = vi.fn(async () => {
      return { data: [], error: fileError }
    })
    const selectMock = vi.fn(async () => {
      return { data: [], error: new Error('aml side down') }
    })

    ;(adapter as any).query = queryMock
    ;(adapter as any).select = selectMock

    const result = await adapter.getProductDocuments('item-1')
    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()

    // sources metadata: both failed
    const sources = (result.metadata as any)?.sources
    expect(sources).toBeDefined()
    expect(sources[0]).toMatchObject({ name: 'attachments', ok: false })
    expect(sources[1]).toMatchObject({ name: 'related_documents', ok: false })
  })

  it('reports both sources ok when neither fails', async () => {
    const adapter = createAdapter()

    const queryMock = vi.fn(async (path: string) => {
      if (path.startsWith('/api/v1/file/item/')) {
        return {
          data: [{
            file_id: 'f1',
            filename: 'spec.pdf',
            file_role: 'primary',
            document_type: 'drawing',
          }],
        }
      }
      return { data: [] }
    })
    const selectMock = vi.fn(async (path: string) => {
      if (path === '/api/v1/aml/query') {
        return {
          data: [{
            id: 'item-1',
            'Document Part': [{
              id: 'doc-1',
              name: 'Related Doc',
              state: 'Draft',
            }],
          }],
        }
      }
      return { data: [] }
    })

    ;(adapter as any).query = queryMock
    ;(adapter as any).select = selectMock

    const result = await adapter.getProductDocuments('item-1')
    expect(result.data).toHaveLength(2)
    expect(result.error).toBeUndefined()

    const sources = (result.metadata as any)?.sources
    expect(sources).toBeDefined()
    expect(sources[0]).toMatchObject({ name: 'attachments', ok: true, count: 1 })
    expect(sources[1]).toMatchObject({ name: 'related_documents', ok: true, count: 1 })
  })
})

// PLM-COLLAB Discussion Phase 3 slice-1 (READ-ONLY): getDiscussions / getDiscussionThread call
// the provider's EXISTING /api/v1/discussions routes -- no capability/SKU gate on this read
// path (see the PLMAdapter.ts type-block docstring). A missing/unreadable target comes back as
// the provider's indistinguishable 404, surfaced as `result.error`, never thrown.
describe('PLMAdapter Yuantus discussion reads', () => {
  it('lists discussion threads for a target, forwarding target/list query params to /api/v1/discussions', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        threads: [{
          id: 'thread-1',
          target_type: 'item',
          target_id: 'item-1',
          title: 'Check tolerance',
          status: 'open',
          created_by_id: 1,
          created_at: '2026-07-09T00:00:00.000Z',
          resolved_by_id: null,
          resolved_at: null,
          last_comment_at: '2026-07-09T00:05:00.000Z',
          comment_count: 2,
          anchor: null,
        }],
        next_cursor: null,
      }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getDiscussions(
      { targetType: 'item', targetId: 'item-1' },
      { includeResolved: true, includeChildren: true, limit: 20, cursor: 'cursor-abc' },
    )

    expect(queryMock).toHaveBeenCalledWith('/api/v1/discussions', [{
      target_type: 'item',
      target_id: 'item-1',
      include_resolved: true,
      include_children: true,
      limit: 20,
      cursor: 'cursor-abc',
    }])
    expect(result.data[0]).toMatchObject({
      threads: [expect.objectContaining({ id: 'thread-1', status: 'open', comment_count: 2 })],
      next_cursor: null,
    })
    expect(result.error).toBeUndefined()
  })

  it('omits optional list params when not supplied', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({ data: [{ threads: [], next_cursor: null }] })
    ;(adapter as any).query = queryMock

    await adapter.getDiscussions({ targetType: 'eco', targetId: 'eco-1' })

    expect(queryMock).toHaveBeenCalledWith('/api/v1/discussions', [{
      target_type: 'eco',
      target_id: 'eco-1',
    }])
  })

  it('fetches one discussion thread with its comments from /api/v1/discussions/{thread_id}', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{
        id: 'thread-1',
        target_type: 'item',
        target_id: 'item-1',
        title: 'Check tolerance',
        status: 'open',
        created_by_id: 1,
        created_at: '2026-07-09T00:00:00.000Z',
        resolved_by_id: null,
        resolved_at: null,
        last_comment_at: '2026-07-09T00:05:00.000Z',
        comment_count: 1,
        anchor: null,
        comments: [{
          id: 'comment-1',
          parent_comment_id: null,
          body: 'Confirm with vendor',
          body_format: 'text',
          author_user_id: 1,
          mentioned_user_ids: [],
          created_at: '2026-07-09T00:05:00.000Z',
          edited_at: null,
          deleted_at: null,
          anchor: null,
        }],
        history: [{ kind: 'lifecycle_transition', at: '2026-07-08T00:00:00.000Z' }],
      }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getDiscussionThread('thread-1', { includeHistory: true })

    expect(queryMock).toHaveBeenCalledWith('/api/v1/discussions/thread-1', [{ include_history: true }])
    expect(result.data[0]).toMatchObject({
      id: 'thread-1',
      comments: [expect.objectContaining({ id: 'comment-1', author_user_id: 1 })],
      history: [expect.objectContaining({ kind: 'lifecycle_transition' })],
    })
    expect(result.error).toBeUndefined()
  })

  it('omits include_history when not requested', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({ data: [{ id: 'thread-1', comments: [] }] })
    ;(adapter as any).query = queryMock

    await adapter.getDiscussionThread('thread-1')

    expect(queryMock).toHaveBeenCalledWith('/api/v1/discussions/thread-1', [{}])
  })

  it('surfaces the provider no-leak 404 as a QueryResult error, never a thrown exception, for a missing/unreadable target', async () => {
    const adapter = createAdapter()
    const notFoundError = Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404, data: { detail: 'discussion target not found' } },
    })
    const queryMock = vi.fn().mockResolvedValue({ data: [], error: notFoundError })
    ;(adapter as any).query = queryMock

    const result = await adapter.getDiscussions({ targetType: 'item', targetId: 'missing-item' })

    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect((result.error as any)?.response?.status).toBe(404)
  })

  it('is not gated by apiMode !== yuantus (legacy PLM has no discussion surface)', async () => {
    const adapter = createAdapter()
    ;(adapter as any).apiMode = 'legacy'

    const result = await adapter.getDiscussions({ targetType: 'item', targetId: 'item-1' })
    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()

    const detailResult = await adapter.getDiscussionThread('thread-1')
    expect(detailResult.data).toHaveLength(0)
    expect(detailResult.error).toBeDefined()
  })
})

// PLM-COLLAB Discussion Phase 3 slice-2 (WRITE): exchangeDiscussionSession + the six write
// methods. AUTH IS DIFFERENT FROM THE READS ABOVE -- these bypass this.select/this.query (the
// HTTPAdapter request interceptor unconditionally overwrites Authorization with the adapter's
// own service token) and issue a raw fetch() instead, carrying the discussion-session bearer
// token as an EXPLICIT per-call parameter that is never cached on the adapter instance.
describe('PLMAdapter Yuantus discussion writes', () => {
  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

  const threadDetail = (overrides: Record<string, unknown> = {}) => ({
    id: 'thread-1',
    target_type: 'item',
    target_id: 'item-1',
    title: 'Check tolerance',
    status: 'open',
    created_by_id: 1,
    created_at: '2026-07-09T00:00:00.000Z',
    resolved_by_id: null,
    resolved_at: null,
    last_comment_at: '2026-07-09T00:05:00.000Z',
    comment_count: 1,
    anchor: null,
    comments: [],
    ...overrides,
  })

  beforeEach(() => {
    ;(fetch as Mock).mockClear()
  })

  it('exchanges a valid embed token for a discussion-session credential, sending NO Authorization header', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      access_token: 'session-token-abc',
      token_type: 'bearer',
      expires_in: 300,
      aud: 'discussion',
    }))

    const result = await adapter.exchangeDiscussionSession('embed-token-1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/auth/embed/discussion-session')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ embed_token: 'embed-token-1' })
    expect(init.headers).not.toHaveProperty('Authorization')

    expect(result.error).toBeUndefined()
    expect(result.data[0]).toMatchObject({ access_token: 'session-token-abc', aud: 'discussion' })
  })

  it('fails closed and uniform on a 401 exchange (dark-flag-off and an invalid token are indistinguishable)', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { detail: 'invalid or expired embed token' }))

    const result = await adapter.exchangeDiscussionSession('bad-embed-token')

    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect((result.error as any)?.response?.status).toBe(401)
  })

  it('creates a discussion thread, carrying the caller-supplied bearer token', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({ id: 'thread-new' })))

    const result = await adapter.createDiscussionThread('session-token-1', {
      target_type: 'item',
      target_id: 'item-1',
      title: 'New thread',
      body: 'first comment',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer session-token-1')
    expect(JSON.parse(init.body)).toEqual({
      target_type: 'item',
      target_id: 'item-1',
      title: 'New thread',
      body: 'first comment',
    })
    expect(result.error).toBeUndefined()
    expect(result.data[0]).toMatchObject({ id: 'thread-new', status: 'open' })
  })

  it('rejects an invalid create-thread payload (422) as a QueryResult error, never throwing', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { detail: 'unknown target_type' }))

    const result = await adapter.createDiscussionThread('session-token-1', {
      target_type: 'item',
      target_id: 'item-1',
      body: '',
    })

    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect((result.error as any)?.response?.status).toBe(422)
  })

  it('adds a comment to an existing thread', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({
      comment_count: 2,
      comments: [{
        id: 'comment-new',
        parent_comment_id: null,
        body: 'Confirmed with vendor',
        body_format: 'text',
        author_user_id: 1,
        mentioned_user_ids: [],
        created_at: '2026-07-09T00:06:00.000Z',
        edited_at: null,
        deleted_at: null,
        anchor: null,
      }],
    })))

    const result = await adapter.addDiscussionComment('session-token-1', 'thread-1', {
      body: 'Confirmed with vendor',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions/thread-1/comments')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer session-token-1')
    expect(JSON.parse(init.body)).toEqual({ body: 'Confirmed with vendor' })
    expect(result.error).toBeUndefined()
    expect(result.data[0].comments[0]).toMatchObject({ id: 'comment-new', body: 'Confirmed with vendor' })
  })

  it('surfaces a forbidden comment write (out-of-scope / no can_comment) as a QueryResult error, never throwing', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { detail: 'not permitted to comment on this discussion' }))

    const result = await adapter.addDiscussionComment('session-token-1', 'thread-1', { body: 'hi' })

    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect((result.error as any)?.response?.status).toBe(403)
  })

  it('edits a comment', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({
      comments: [{
        id: 'comment-1',
        parent_comment_id: null,
        body: 'Updated body',
        body_format: 'text',
        author_user_id: 1,
        mentioned_user_ids: [],
        created_at: '2026-07-09T00:05:00.000Z',
        edited_at: '2026-07-09T00:07:00.000Z',
        deleted_at: null,
        anchor: null,
      }],
    })))

    const result = await adapter.editDiscussionComment('session-token-1', 'thread-1', 'comment-1', {
      body: 'Updated body',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions/thread-1/comments/comment-1')
    expect(init.method).toBe('PATCH')
    expect(init.headers.Authorization).toBe('Bearer session-token-1')
    expect(JSON.parse(init.body)).toEqual({ body: 'Updated body' })
    expect(result.error).toBeUndefined()
    expect(result.data[0].comments[0]).toMatchObject({ id: 'comment-1', body: 'Updated body' })
  })

  it('deletes (soft) a comment, sending DELETE with no request body', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({
      comments: [{
        id: 'comment-1',
        parent_comment_id: null,
        body: null,
        body_format: 'text',
        author_user_id: 1,
        mentioned_user_ids: [],
        created_at: '2026-07-09T00:05:00.000Z',
        edited_at: null,
        deleted_at: '2026-07-09T00:08:00.000Z',
        anchor: null,
      }],
    })))

    const result = await adapter.deleteDiscussionComment('session-token-1', 'thread-1', 'comment-1')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions/thread-1/comments/comment-1')
    expect(init.method).toBe('DELETE')
    expect(init.headers.Authorization).toBe('Bearer session-token-1')
    expect(init.body).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(result.data[0].comments[0]).toMatchObject({ id: 'comment-1', body: null, deleted_at: expect.any(String) })
  })

  it('surfaces a missing/unreadable thread as a no-leak 404 QueryResult error on delete, never throwing', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: 'discussion target not found' }))

    const result = await adapter.deleteDiscussionComment('session-token-1', 'thread-missing', 'comment-1')

    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect((result.error as any)?.response?.status).toBe(404)
  })

  it('resolves a thread', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({
      status: 'resolved',
      resolved_by_id: 1,
      resolved_at: '2026-07-09T00:09:00.000Z',
    })))

    const result = await adapter.resolveDiscussionThread('session-token-1', 'thread-1', { comment: 'Done' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions/thread-1/resolve')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer session-token-1')
    expect(JSON.parse(init.body)).toEqual({ comment: 'Done' })
    expect(result.error).toBeUndefined()
    expect(result.data[0]).toMatchObject({ status: 'resolved' })
  })

  it('resolves a thread with no closing comment, sending an empty JSON body', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({ status: 'resolved' })))

    await adapter.resolveDiscussionThread('session-token-1', 'thread-1')

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({})
  })

  it('reopens a thread', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({ status: 'open' })))

    const result = await adapter.reopenDiscussionThread('session-token-1', 'thread-1', { comment: 'Reopening' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions/thread-1/reopen')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer session-token-1')
    expect(JSON.parse(init.body)).toEqual({ comment: 'Reopening' })
    expect(result.error).toBeUndefined()
    expect(result.data[0]).toMatchObject({ status: 'open' })
  })

  it('never caches a session token between calls -- concurrent embed sessions each carry their own bearer token', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({ id: 'thread-a' })))
    await adapter.addDiscussionComment('token-A', 'thread-a', { body: 'from A' })

    fetchMock.mockResolvedValueOnce(jsonResponse(200, threadDetail({ id: 'thread-b' })))
    await adapter.addDiscussionComment('token-B', 'thread-b', { body: 'from B' })

    expect(fetchMock.mock.calls).toHaveLength(2)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer token-A')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer token-B')
  })

  it('is not gated by apiMode !== yuantus (legacy PLM has no discussion write surface)', async () => {
    const adapter = createAdapter()
    ;(adapter as any).apiMode = 'legacy'
    const fetchMock = fetch as Mock

    const exchangeResult = await adapter.exchangeDiscussionSession('embed-token-1')
    expect(exchangeResult.error).toBeDefined()

    const writeResult = await adapter.addDiscussionComment('session-token-1', 'thread-1', { body: 'hi' })
    expect(writeResult.error).toBeDefined()

    // never reaches the network in legacy mode
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// PLM-COLLAB Discussion read-relay (metasheet2 sub-slice 2): exchangeDiscussionReadSession +
// getDiscussionsWithReadToken/getDiscussionThreadWithReadToken. SAME auth style as the WRITE
// methods above -- they bypass this.select/this.query (whose interceptor overwrites Authorization
// with the adapter's SERVICE token) and issue a raw fetch() carrying the CALLER-supplied read
// credential, never the service account. These tests exercise the REAL fetch seam (not the route
// mocks) so a typo in a path/param/header is caught.
describe('PLMAdapter Yuantus discussion read-relay methods', () => {
  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

  const threadSummary = (overrides: Record<string, unknown> = {}) => ({
    id: 'thread-1',
    target_type: 'item',
    target_id: 'P1',
    title: 'Check tolerance',
    status: 'open',
    created_by_id: 1,
    created_at: '2026-07-09T00:00:00.000Z',
    resolved_by_id: null,
    resolved_at: null,
    last_comment_at: '2026-07-09T00:05:00.000Z',
    comment_count: 1,
    anchor: null,
    ...overrides,
  })

  beforeEach(() => {
    ;(fetch as Mock).mockClear()
  })

  it('exchanges an embed token for a discussion READ credential at /discussion-read-session, sending NO Authorization header', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      access_token: 'read-token-abc',
      token_type: 'bearer',
      expires_in: 300,
      aud: 'discussion',
    }))

    const result = await adapter.exchangeDiscussionReadSession('embed-token-1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/auth/embed/discussion-read-session')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ embed_token: 'embed-token-1' })
    expect(init.headers).not.toHaveProperty('Authorization')

    expect(result.error).toBeUndefined()
    expect(result.data[0]).toMatchObject({ access_token: 'read-token-abc', aud: 'discussion' })
  })

  it('fails closed and uniform on a 401 read-session exchange (dark-flag-off and an invalid token are indistinguishable)', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { detail: 'invalid or expired embed token' }))

    const result = await adapter.exchangeDiscussionReadSession('bad-embed-token')

    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect((result.error as any)?.response?.status).toBe(401)
  })

  it('lists discussions with the read token as bearer, hitting /discussions with target_type/target_id ONLY (no include_children)', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      threads: [threadSummary()],
      next_cursor: null,
    }))

    const result = await adapter.getDiscussionsWithReadToken('read-token-1', { targetType: 'item', targetId: 'P1' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions?target_type=item&target_id=P1&include_resolved=true')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer read-token-1')
    // FIXED include_resolved=true so a resolved thread stays visible/reopenable (owner review P2);
    // still NO include_children (provider forbids it for read creds), and neither is client-injectable.
    expect(url).toContain('include_resolved=true')
    expect(url).not.toContain('include_children')
    expect(init.body).toBeUndefined()

    expect(result.error).toBeUndefined()
    expect(result.data[0]).toMatchObject({
      threads: [expect.objectContaining({ id: 'thread-1', status: 'open' })],
      next_cursor: null,
    })
  })

  it('URL-encodes the list target params', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { threads: [], next_cursor: null }))

    await adapter.getDiscussionsWithReadToken('read-token-1', { targetType: 'item', targetId: 'part id/with?chars' })

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions?target_type=item&target_id=part+id%2Fwith%3Fchars&include_resolved=true')
  })

  it('the list request carries a FIXED include_resolved=true so resolved threads stay visible (owner P2), and it is not client-injectable', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      threads: [threadSummary({ id: 'thread-open', status: 'open' }), threadSummary({ id: 'thread-resolved', status: 'resolved' })],
      next_cursor: null,
    }))

    const result = await adapter.getDiscussionsWithReadToken('read-token-1', { targetType: 'item', targetId: 'P1' })

    const [url] = fetchMock.mock.calls[0]
    // include_resolved=true is always sent; the caller has no way to pass query params to this
    // method (the relay only ever hands it { targetType, targetId } from the verified claim).
    expect(url).toContain('include_resolved=true')
    // A resolved thread from the provider is returned to the caller (visible for reopen).
    const statuses = (result.data[0] as { threads: Array<{ id: string; status: string }> }).threads.map((t) => t.status)
    expect(statuses).toContain('resolved')
    expect(statuses).toContain('open')
  })

  it('fetches one thread with the read token as bearer, hitting /discussions/{thread_id} with no query params', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ...threadSummary(), comments: [] }))

    const result = await adapter.getDiscussionThreadWithReadToken('read-token-1', 'thread-1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions/thread-1')
    expect(init.method).toBe('GET')
    expect(init.headers.Authorization).toBe('Bearer read-token-1')
    expect(init.body).toBeUndefined()

    expect(result.error).toBeUndefined()
    expect(result.data[0]).toMatchObject({ id: 'thread-1', comments: [] })
  })

  it('URL-encodes the thread id in the detail path', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ...threadSummary(), comments: [] }))

    await adapter.getDiscussionThreadWithReadToken('read-token-1', 'weird/id?x=1')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:8001/api/v1/discussions/weird%2Fid%3Fx%3D1')
  })

  it('surfaces the provider no-leak 404 as a QueryResult error, never a thrown exception (list)', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: 'discussion target not found' }))

    const result = await adapter.getDiscussionsWithReadToken('read-token-1', { targetType: 'item', targetId: 'missing' })

    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect((result.error as any)?.response?.status).toBe(404)
  })

  it('surfaces the provider no-leak 404 as a QueryResult error (detail)', async () => {
    const adapter = createAdapter()
    const fetchMock = fetch as Mock
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { detail: 'discussion target not found' }))

    const result = await adapter.getDiscussionThreadWithReadToken('read-token-1', 'missing-thread')

    expect(result.data).toHaveLength(0)
    expect(result.error).toBeDefined()
    expect((result.error as any)?.response?.status).toBe(404)
  })

  it('is not gated by apiMode !== yuantus (legacy PLM has no discussion read-relay surface)', async () => {
    const adapter = createAdapter()
    ;(adapter as any).apiMode = 'legacy'
    const fetchMock = fetch as Mock

    const exchangeResult = await adapter.exchangeDiscussionReadSession('embed-token-1')
    expect(exchangeResult.error).toBeDefined()

    const listResult = await adapter.getDiscussionsWithReadToken('read-token-1', { targetType: 'item', targetId: 'P1' })
    expect(listResult.error).toBeDefined()

    const detailResult = await adapter.getDiscussionThreadWithReadToken('read-token-1', 'thread-1')
    expect(detailResult.error).toBeDefined()

    // never reaches the network in legacy mode
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
