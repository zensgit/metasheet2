// B1-b: MultitableApiClient.runButton — POST .../button/run.
// The keystone is the HTTP-200-on-failure contract: a FAILED action resolves
// (does not throw); only non-2xx throws MultitableApiError.
import { describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'

type ApiErr = Error & { status?: number; code?: string }
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('MultitableApiClient.runButton (B1-b)', () => {
  it('POSTs to the encoded run path with an empty body and returns succeeded', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ ok: true, data: { status: 'succeeded', executionId: 'axe_btn_1' } }))
    const client = new MultitableApiClient({ fetchFn })
    const res = await client.runButton('s1', 'r1', 'f1')
    expect(res).toEqual({ status: 'succeeded', executionId: 'axe_btn_1' })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/multitable/sheets/s1/records/r1/fields/f1/button/run',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    )
  })

  it('RESOLVES (does not throw) when the action fails — HTTP 200 ok:false data.status=failed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      json({ ok: false, data: { status: 'failed', executionId: 'axe_btn_2', message: 'boom' } }, 200),
    )
    const client = new MultitableApiClient({ fetchFn })
    const res = await client.runButton('s1', 'r1', 'f1')
    expect(res).toEqual({ status: 'failed', executionId: 'axe_btn_2', message: 'boom' })
  })

  it('includes requestId in the body only when provided', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ ok: true, data: { status: 'succeeded', executionId: 'x' } }))
    const client = new MultitableApiClient({ fetchFn })
    await client.runButton('s1', 'r1', 'f1', 'req-9')
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ body: JSON.stringify({ requestId: 'req-9' }) }))
  })

  it('encodeURIComponents all three path segments', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ ok: true, data: { status: 'succeeded', executionId: 'x' } }))
    const client = new MultitableApiClient({ fetchFn })
    await client.runButton('s/1', 'r 1', 'f#1')
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/multitable/sheets/s%2F1/records/r%201/fields/f%231/button/run',
      expect.anything(),
    )
  })

  it('THROWS MultitableApiError on a non-2xx (permission/contract) error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json({ ok: false, error: { code: 'FORBIDDEN', message: 'nope' } }, 403))
    const client = new MultitableApiClient({ fetchFn })
    await expect(client.runButton('s1', 'r1', 'f1')).rejects.toMatchObject({ name: 'MultitableApiError', status: 403 } as ApiErr)
  })
})
