/**
 * Slice 3 — MultitableApiClient.restoreRecordVersion contract (request + error-code mapping).
 * Verifies the frontend's wire contract with POST .../restore: the exact body it sends and that
 * each documented backend error code surfaces on the thrown error's `.code` (so callers branch on
 * the contract, not on message strings).
 */
import { describe, expect, it, vi } from 'vitest'
import { MultitableApiClient } from '../src/multitable/api/client'

type ApiErr = Error & { status?: number; code?: string }

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  })
}

const OK_WIRE = {
  ok: true,
  data: { recordId: 'rec_1', newVersion: 4, noop: false, restoredFieldIds: ['fld_a'], skippedFieldIds: [] },
}

describe('MultitableApiClient.restoreRecordVersion (Slice 3)', () => {
  it('POSTs { targetVersion, expectedVersion } to the restore path and unwraps the data envelope', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(OK_WIRE))
    const client = new MultitableApiClient({ fetchFn })

    const result = await client.restoreRecordVersion('sheet_1', 'rec_1', 2, 3)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/multitable/sheets/sheet_1/records/rec_1/restore')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ targetVersion: 2, expectedVersion: 3 })
    expect(result).toEqual(OK_WIRE.data)
  })

  it('encodes path segments', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(OK_WIRE))
    const client = new MultitableApiClient({ fetchFn })
    await client.restoreRecordVersion('sheet/1', 'rec 1', 1, 1)
    const [url] = fetchFn.mock.calls[0] as [string]
    expect(url).toBe('/api/multitable/sheets/sheet%2F1/records/rec%201/restore')
  })

  it.each([
    [409, 'VERSION_CONFLICT'],
    [410, 'VERSION_EXPIRED'],
    [422, 'RESTORE_UNSUPPORTED'],
    [422, 'SNAPSHOT_UNAVAILABLE'],
    [422, 'SCHEMA_DRIFT'],
    [403, 'RESTORE_FORBIDDEN'],
  ])('surfaces backend %i error code %s on the thrown error', async (status, code) => {
    const fetchFn = vi.fn(async () => jsonResponse({ ok: false, error: { code, message: `${code} msg` } }, { status }))
    const client = new MultitableApiClient({ fetchFn })
    await expect(client.restoreRecordVersion('sheet_1', 'rec_1', 2, 3)).rejects.toMatchObject({ code, status })
  })
})
