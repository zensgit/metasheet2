/**
 * MultitableApiClient.exportSheet — the rewired "all rows" export path.
 *
 * The export picker's "all rows" scope no longer serializes the client-loaded grid page (the verified
 * 50-row data-loss bug); it calls this method, which hits the mask-preserving backend route with the
 * picker's chosen fieldIds + the active viewId. The server applies field_permissions + view-hidden +
 * §2a.3 taint masking AFTER the selection (selection narrows, never widens) — these tests assert the
 * REQUEST is shaped correctly (the mask itself is enforced + tested server-side, in the real-DB suite).
 */
import { describe, expect, it, vi } from 'vitest'

import { MultitableApiClient } from '../../src/multitable/api/client'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

describe('MultitableApiClient.exportSheet — all-rows mask-route request shaping', () => {
  it('requests the export route with viewId + comma-joined fieldIds + format, and returns blob + filename', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('col\r\nval', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="My_Sheet.csv"',
        },
      }),
    )
    const client = new MultitableApiClient({ fetchFn })

    const { blob, filename } = await client.exportSheet({
      sheetId: 'sheet_1',
      viewId: 'view_1',
      fieldIds: ['fld_a', 'fld_b'],
      format: 'csv',
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const url = fetchFn.mock.calls[0][0] as string
    expect(url).toContain('/api/multitable/sheets/sheet_1/export-xlsx')
    // fieldIds are sent as the comma-joined form the route parses; viewId + format passthrough.
    expect(url).toContain('viewId=view_1')
    expect(url).toContain(`fieldIds=${encodeURIComponent('fld_a,fld_b')}`)
    expect(url).toContain('format=csv')
    expect(filename).toBe('My_Sheet.csv')
    // The response body is returned as a Blob (the caller hands it to the download helper). Assert it is a
    // non-empty Blob rather than reading .text() (jsdom's Blob has no usable .text()); end-to-end content is
    // covered by the real-DB suite.
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)
  })

  it('omits fieldIds entirely when the selection is empty (route then exports all permitted columns)', async () => {
    const fetchFn = vi.fn(async () => new Response('x', { status: 200, headers: { 'Content-Type': 'text/csv' } }))
    const client = new MultitableApiClient({ fetchFn })

    await client.exportSheet({ sheetId: 'sheet_1', fieldIds: [], format: 'xlsx' })

    const url = fetchFn.mock.calls[0][0] as string
    // No empty fieldIds= (an empty selection server-side is a 400; "all columns" is the absence of the param).
    expect(url).not.toContain('fieldIds=')
    expect(url).toContain('format=xlsx')
    // No viewId when not provided.
    expect(url).not.toContain('viewId=')
  })

  it('throws a MultitableApiError carrying the server message + code on a non-2xx (so the caller can toast it)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(400, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'fieldIds selection resolved to no exportable columns (unknown or not permitted)' } }),
    )
    const client = new MultitableApiClient({ fetchFn })

    await expect(
      client.exportSheet({ sheetId: 'sheet_1', fieldIds: ['nope'], format: 'xlsx' }),
    ).rejects.toMatchObject({
      name: 'MultitableApiError',
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'fieldIds selection resolved to no exportable columns (unknown or not permitted)',
    })
  })

  it('falls back to a generic filename when Content-Disposition is absent', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('bin', { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }),
    )
    const client = new MultitableApiClient({ fetchFn })

    const { filename } = await client.exportSheet({ sheetId: 'sheet_1', format: 'xlsx' })
    expect(filename).toBe('export')
  })
})
