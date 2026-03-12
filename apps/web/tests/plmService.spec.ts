import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/utils/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

import { apiGet, apiPost } from '../src/utils/api'
import { plmService } from '../src/services/PlmService'

const apiGetMock = vi.mocked(apiGet)
const apiPostMock = vi.mocked(apiPost)

describe('plmService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses federation query endpoint for product search', async () => {
    apiPostMock.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [{ id: 'P-1001' }],
        total: 1,
      },
    })

    const result = await plmService.searchProducts({
      query: 'motor',
      itemType: 'Part',
      limit: 20,
      offset: 5,
    })

    expect(result.items).toHaveLength(1)
    expect(apiPostMock).toHaveBeenCalledWith('/api/federation/plm/query', {
      operation: 'products',
      pagination: {
        limit: 20,
        offset: 5,
      },
      filters: {
        query: 'motor',
        itemType: 'Part',
      },
    })
  })

  it('loads product detail through encoded federation GET route', async () => {
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      data: {
        id: 'Part/001',
        item_number: 'PN-001',
      },
    })

    const result = await plmService.getProduct('Part/001', {
      itemType: 'Part',
      itemNumber: 'PN-001',
    })

    expect(result.id).toBe('Part/001')
    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/federation/plm/products/Part%2F001?itemType=Part&itemNumber=PN-001',
    )
  })

  it('loads bom with normalized query parameters', async () => {
    apiGetMock.mockResolvedValueOnce({
      ok: true,
      data: {
        items: [{ id: 'line-1' }],
      },
    })

    const result = await plmService.getBom('P-1001', {
      depth: 3,
      effectiveAt: '2026-03-07T10:00:00Z',
    })

    expect(result.items).toHaveLength(1)
    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/federation/plm/products/P-1001/bom?depth=3&effective_at=2026-03-07T10%3A00%3A00Z',
    )
  })

  it('omits all-status filter and defaults compare sides to item mode', async () => {
    apiPostMock
      .mockResolvedValueOnce({
        ok: true,
        data: {
          items: [],
          total: 0,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          summary: { changed: 1 },
        },
      })

    await plmService.listApprovals({
      productId: 'P-1001',
      status: 'all',
    })

    await plmService.getBomCompare({
      leftId: 'P-1001',
      rightId: 'P-1002',
      maxLevels: 2,
    })

    expect(apiPostMock).toHaveBeenNthCalledWith(1, '/api/federation/plm/query', {
      operation: 'approvals',
      productId: 'P-1001',
      pagination: {
        limit: 100,
        offset: 0,
      },
      filters: undefined,
    })

    expect(apiPostMock).toHaveBeenNthCalledWith(2, '/api/federation/plm/query', {
      operation: 'bom_compare',
      leftId: 'P-1001',
      rightId: 'P-1002',
      leftType: 'item',
      rightType: 'item',
      maxLevels: 2,
      compareMode: undefined,
      lineKey: undefined,
      includeChildFields: undefined,
      includeSubstitutes: undefined,
      includeEffectivity: undefined,
      includeRelationshipProps: undefined,
      effectiveAt: undefined,
    })
  })

  it('uses upstream error message when federation query rejects logically', async () => {
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      data: null,
      error: {
        message: 'upstream denied',
      },
    })

    await expect(
      plmService.listDocuments({
        productId: 'P-1001',
      }),
    ).rejects.toThrow('upstream denied')
  })

  it('falls back to local message when federation mutate omits error text', async () => {
    apiPostMock.mockResolvedValueOnce({
      ok: false,
      data: null,
    })

    await expect(
      plmService.approveApproval({
        approvalId: 'APP-1',
      }),
    ).rejects.toThrow('审批通过失败')
  })
})
