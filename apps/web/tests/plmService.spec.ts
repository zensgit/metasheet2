import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

import { apiFetch } from '../src/utils/api'
import { plmService } from '../src/services/PlmService'

const apiFetchMock = vi.mocked(apiFetch)

describe('plmService', () => {
  function mockJsonResponse(status: number, json: unknown, headers?: Record<string, string>) {
    return {
      status,
      headers: new Headers(headers),
      json: async () => json,
    }
  }

  function getRequestBody(callIndex: number): unknown {
    const options = apiFetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined
    const body = options?.body
    return typeof body === 'string' ? JSON.parse(body) : body
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses federation query endpoint for product search', async () => {
    apiFetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: true,
      data: {
        items: [{ id: 'P-1001' }],
        total: 1,
      },
    }))

    const result = await plmService.searchProducts({
      query: 'motor',
      itemType: 'Part',
      limit: 20,
      offset: 5,
    })

    expect(result.items).toHaveLength(1)
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/federation/plm/query')
    expect(getRequestBody(0)).toEqual({
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
    apiFetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: true,
      data: {
        id: 'Part/001',
        item_number: 'PN-001',
      },
    }))

    const result = await plmService.getProduct('Part/001', {
      itemType: 'Part',
      itemNumber: 'PN-001',
    })

    expect(result.id).toBe('Part/001')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/federation/plm/products/Part%2F001?itemType=Part&itemNumber=PN-001',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('loads bom with normalized query parameters', async () => {
    apiFetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: true,
      data: {
        items: [{ id: 'line-1' }],
      },
    }))

    const result = await plmService.getBom('P-1001', {
      depth: 3,
      effectiveAt: '2026-03-07T10:00:00Z',
    })

    expect(result.items).toHaveLength(1)
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/federation/plm/products/P-1001/bom?depth=3&effective_at=2026-03-07T10%3A00%3A00Z',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('loads product metadata through encoded federation GET route', async () => {
    apiFetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: true,
      data: {
        id: 'Part',
        properties: [],
      },
    }))

    const result = await plmService.getMetadata('Part/Assembly')

    expect(result.id).toBe('Part')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/federation/plm/metadata/Part%2FAssembly',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('omits all-status filter and defaults compare sides to item mode', async () => {
    apiFetchMock
      .mockResolvedValueOnce(mockJsonResponse(200, {
        ok: true,
        data: {
          items: [],
          total: 0,
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse(200, {
        ok: true,
        data: {
          summary: { changed: 1 },
        },
      }))

    await plmService.listApprovals({
      productId: 'P-1001',
      status: 'all',
    })

    await plmService.getBomCompare({
      leftId: 'P-1001',
      rightId: 'P-1002',
      maxLevels: 2,
    })

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/federation/plm/query')
    expect(getRequestBody(0)).toEqual({
      operation: 'approvals',
      productId: 'P-1001',
      pagination: {
        limit: 100,
        offset: 0,
      },
      filters: undefined,
    })

    expect(apiFetchMock.mock.calls[1]?.[0]).toBe('/api/federation/plm/query')
    expect(getRequestBody(1)).toEqual({
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
    apiFetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: false,
      data: null,
      error: {
        message: 'upstream denied',
      },
    }))

    await expect(
      plmService.listDocuments({
        productId: 'P-1001',
      }),
    ).rejects.toThrow('upstream denied')
  })

  it('falls back to local message when federation mutate omits error text', async () => {
    apiFetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: false,
      data: null,
    }))

    await expect(
      plmService.approveApproval({
        approvalId: 'APP-1',
        version: 0,
      }),
    ).rejects.toThrow('审批通过失败')
  })

  it('forwards approval action versions and reject reasons through the federation client', async () => {
    apiFetchMock
      .mockResolvedValueOnce(mockJsonResponse(200, {
        ok: true,
        data: {
          id: 'APP-1',
          status: 'approved',
          version: 2,
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse(200, {
        ok: true,
        data: {
          id: 'APP-2',
          status: 'rejected',
          version: 5,
        },
      }))

    await plmService.approveApproval({
      approvalId: 'APP-1',
      version: 1,
      comment: 'looks good',
    })

    await plmService.rejectApproval({
      approvalId: 'APP-2',
      version: 4,
      reason: 'needs revision',
      comment: 'needs revision',
    })

    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/federation/plm/mutate')
    expect(getRequestBody(0)).toEqual({
      operation: 'approval_approve',
      approvalId: 'APP-1',
      version: 1,
      comment: 'looks good',
    })
    expect(apiFetchMock.mock.calls[1]?.[0]).toBe('/api/federation/plm/mutate')
    expect(getRequestBody(1)).toEqual({
      operation: 'approval_reject',
      approvalId: 'APP-2',
      version: 4,
      reason: 'needs revision',
      comment: 'needs revision',
    })
  })

  it('preserves structured approval conflict metadata through the localized federation client', async () => {
    apiFetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: false,
      data: null,
      error: {
        code: 'APPROVAL_VERSION_CONFLICT',
        message: 'Approval instance version mismatch',
        currentVersion: 9,
      },
    }))

    await expect(
      plmService.approveApproval({
        approvalId: 'APP-9',
        version: 8,
      }),
    ).rejects.toMatchObject({
      message: 'Approval instance version mismatch',
      code: 'APPROVAL_VERSION_CONFLICT',
      currentVersion: 9,
    })
  })

  it('preserves approval history envelope fields from the federation client', async () => {
    apiFetchMock.mockResolvedValueOnce(mockJsonResponse(200, {
      ok: true,
      data: {
        approvalId: 'ECO-42',
        items: [{ id: 'record-1' }],
        total: 1,
      },
    }))

    const result = await plmService.getApprovalHistory('ECO-42')

    expect(result).toEqual({
      approvalId: 'ECO-42',
      items: [{ id: 'record-1' }],
      total: 1,
    })
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/federation/plm/query')
    expect(getRequestBody(0)).toEqual({
      operation: 'approval_history',
      approvalId: 'ECO-42',
    })
  })
})
