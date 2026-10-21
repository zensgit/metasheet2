import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

import { searchApprovalDirectoryDepartments } from '../src/approvals/api'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

describe('searchApprovalDirectoryDepartments', () => {
  beforeEach(() => apiFetchMock.mockReset())
  afterEach(() => vi.clearAllMocks())

  it('maps the minimal department directory shape and requester default', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({
      departments: [{
        id: 'dept-a',
        name: '产品部',
        fullPath: '总部 / 产品部',
        parentId: 'dept-root',
        hasChildren: true,
        integrationId: 'must-not-pass-through',
      }],
      requesterDepartmentId: 'dept-a',
    }))

    await expect(searchApprovalDirectoryDepartments('  产品  ', 8)).resolves.toEqual({
      departments: [{
        id: 'dept-a',
        name: '产品部',
        fullPath: '总部 / 产品部',
        parentId: 'dept-root',
        hasChildren: true,
      }],
      requesterDepartmentId: 'dept-a',
    })
    expect(apiFetchMock.mock.calls[0]?.[0])
      .toBe('/api/approvals/directory/departments?q=%E4%BA%A7%E5%93%81&limit=8')
  })

  it('drops malformed entries and an invalid requester default without throwing', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({
      departments: [
        { id: 'dept-a', name: '', fullPath: '总部 / 产品部', hasChildren: false },
        { id: 'dept-b', name: '研发部', fullPath: '', hasChildren: false },
        { id: 'dept-c', name: '财务部', fullPath: '总部 / 财务部', hasChildren: 'no' },
      ],
      requesterDepartmentId: 7,
    }))
    await expect(searchApprovalDirectoryDepartments('')).resolves.toEqual({ departments: [] })
    expect(apiFetchMock.mock.calls[0]?.[0]).toBe('/api/approvals/directory/departments?limit=20')
  })

  it('degrades non-OK, invalid JSON, and network failures to an empty result', async () => {
    apiFetchMock.mockResolvedValueOnce(jsonResponse({}, 403))
    await expect(searchApprovalDirectoryDepartments('x')).resolves.toEqual({ departments: [] })

    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new Error('invalid json') },
    } as unknown as Response)
    await expect(searchApprovalDirectoryDepartments('x')).resolves.toEqual({ departments: [] })

    apiFetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(searchApprovalDirectoryDepartments('x')).resolves.toEqual({ departments: [] })
  })

  it('uses explicit tree mode for root and child browsing without an org selector', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ departments: [] }))
    await searchApprovalDirectoryDepartments('', 50, null)
    expect(apiFetchMock.mock.calls[0]?.[0])
      .toBe('/api/approvals/directory/departments?limit=50&mode=tree')

    await searchApprovalDirectoryDepartments('', 50, 'dept-parent')
    expect(apiFetchMock.mock.calls[1]?.[0])
      .toBe('/api/approvals/directory/departments?limit=50&mode=tree&parentId=dept-parent')
  })
})
