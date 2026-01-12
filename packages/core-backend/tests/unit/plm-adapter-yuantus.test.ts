import { describe, it, expect, vi } from 'vitest'
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
})

describe('PLMAdapter Yuantus documents mapping', () => {
  it('maps document metadata and resolves URLs', async () => {
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

    ;(adapter as any).query = queryMock

    const result = await adapter.getProductDocuments('item-1')

    expect(queryMock).toHaveBeenCalledWith('/api/v1/file/item/item-1', [expect.any(Object)])
    expect(queryMock).toHaveBeenCalledWith('/api/v1/file/file-1')
    expect(result.data).toHaveLength(1)

    const doc = result.data[0]
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
  })
})

describe('PLMAdapter Yuantus approvals mapping', () => {
  it('maps ECO approvals and filters by status', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [
        { id: 'eco-1', name: 'ECO One', state: 'done', created_by_id: 7, created_at: '2026-01-01T00:00:00.000Z', product_id: 'prod-1' },
        { id: 'eco-2', name: 'ECO Two', state: 'rejected', created_by_id: '8', created_at: '2026-01-02T00:00:00.000Z' },
        { id: 'eco-3', name: 'ECO Three', state: 'in_review', created_by_id: '9', created_at: '2026-01-03T00:00:00.000Z' },
      ],
    })

    ;(adapter as any).query = queryMock

    const approved = await adapter.getApprovals({ status: 'approved' })
    expect(approved.data).toHaveLength(1)
    expect(approved.data[0].status).toBe('approved')
    expect(approved.data[0].requester_id).toBe('7')

    const all = await adapter.getApprovals()
    expect(all.data).toHaveLength(3)
    expect(all.data.map((entry) => entry.status)).toEqual(['approved', 'rejected', 'pending'])
  })
})

describe('PLMAdapter Yuantus error handling', () => {
  it('returns error when search payload includes detail', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{ detail: 'invalid query' }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getProducts({ search: 'bad-query' })

    expect(result.data).toHaveLength(0)
    expect(result.error?.message).toContain('invalid query')
  })

  it('returns error when document payload includes detail', async () => {
    const adapter = createAdapter()
    const queryMock = vi.fn().mockResolvedValue({
      data: [{ detail: 'document lookup failed' }],
    })

    ;(adapter as any).query = queryMock

    const result = await adapter.getProductDocuments('item-404')

    expect(result.data).toHaveLength(0)
    expect(result.error?.message).toContain('document lookup failed')
  })
})
