import { beforeEach, describe, expect, it, vi } from 'vitest'
import { plmRequestClient } from '../src/services/plm/plmFederationClient'

describe('plmFederationClient requestWithRetry', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    localStorage.clear()
    localStorage.setItem('auth_token', 'test-token')
  })

  it('retries approval actions with the latest etag after a 409 response', async () => {
    fetchMock
      .mockResolvedValueOnce({
        status: 409,
        headers: new Headers(),
        json: async () => ({ error: { message: 'conflict' } }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ etag: 'etag-2' }),
        json: async () => ({ ok: true }),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: new Headers({ etag: 'etag-3' }),
        json: async () => ({ ok: true, retried: true }),
      })

    const response = await plmRequestClient.requestWithRetry(
      'POST',
      '/api/plm/approvals/approval-1/approve',
      { decision: 'approve' },
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/plm/approvals/approval-1')
    const retryHeaders = new Headers((fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.headers)
    expect(retryHeaders.get('if-match')).toBe('etag-2')
    expect(response.status).toBe(200)
    expect(response.etag).toBe('etag-3')
    expect(response.json).toEqual({ ok: true, retried: true })
  })

  it('forwards explicit if-match headers and exposes response etags', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ etag: 'etag-1' }),
      json: async () => ({ ok: true }),
    })

    const response = await plmRequestClient.request(
      'POST',
      '/api/federation/plm/mutate',
      { operation: 'approveApproval' },
      'etag-0',
    )

    const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-token')
    expect(headers.get('if-match')).toBe('etag-0')
    expect(response).toEqual({
      status: 200,
      etag: 'etag-1',
      json: { ok: true },
    })
  })
})
