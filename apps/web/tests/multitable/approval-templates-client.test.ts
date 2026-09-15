/**
 * MultitableApiClient.listApprovalTemplates — envelope shape regression.
 *
 * `/api/approval-templates` answers `{ data: [...], total }`. `parseJson` unwraps the `data` envelope
 * for every call, so the raw body reaches listApprovalTemplates as the bare array. The automation
 * rule editor reads `res.data` — before this fix that was `undefined` on the array, the roster was
 * always `[]`, and the editor silently fell back to the free-text "审批模板 ID" input even though the
 * request succeeded (seen on the 222 host with one published template). These tests pin the wrapped
 * `{ data, total }` contract against the real route body and against a bare-array body.
 */
import { describe, expect, it, vi } from 'vitest'

import { MultitableApiClient } from '../../src/multitable/api/client'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('MultitableApiClient.listApprovalTemplates — { data, total } contract', () => {
  it('returns the roster from the real `{ data, total }` route body (parseJson unwraps the envelope)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, {
        data: [
          { id: 'tpl_1', key: 'demo', name: '备料送审示例', status: 'published' },
          { id: 'tpl_2', name: 'Leave' },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      }),
    )
    const client = new MultitableApiClient({ fetchFn })

    const res = await client.listApprovalTemplates()

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toContain('/api/approval-templates')
    expect(res.data.map((t) => t.id)).toEqual(['tpl_1', 'tpl_2'])
    expect(res.data[0]?.name).toBe('备料送审示例')
    expect(res.total).toBe(2)
  })

  it('tolerates a bare-array body and drops entries without a string id', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, [{ id: 'tpl_1' }, { name: 'no-id' }, null, 'x']))
    const client = new MultitableApiClient({ fetchFn })

    const res = await client.listApprovalTemplates()

    expect(res.data).toEqual([{ id: 'tpl_1' }])
    expect(res.total).toBe(1)
  })

  it('returns an empty roster for an empty `{ data: [] }` body', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { data: [], total: 0 }))
    const client = new MultitableApiClient({ fetchFn })

    const res = await client.listApprovalTemplates()

    expect(res).toEqual({ data: [], total: 0 })
  })

  it('still throws on a 403 so the editor can degrade to the free-text template-id input', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'approvals:read required' } }))
    const client = new MultitableApiClient({ fetchFn })

    await expect(client.listApprovalTemplates()).rejects.toMatchObject({ status: 403 })
  })
})
