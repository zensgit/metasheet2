import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const grant = `yuw_${'a'.repeat(32)}_${'b'.repeat(43)}`
const shared = 'shared-account-token'
const authority = { origin: 'https://synthetic.invalid', tenantId: 'yt-b', orgId: 'org-1' }
const persisted = {
  type: 'plm',
  connection: { url: 'https://synthetic.invalid', headers: { 'x-tenant-id': 'yt-b', 'x-org-id': 'org-1' } },
  options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
}

function adapter() {
  return new PLMAdapter({ get: async () => undefined } as never, logger as never, {
    id: 'source-1',
    name: 'source-1',
    type: 'plm',
    connection: {
      // Cached adapter path stays non-root. Personal transport must ignore it.
      url: 'https://synthetic.invalid/prefix',
      headers: {
        'x-tenant-id': 'yt-b',
        'x-org-id': 'org-1',
        Authorization: `Bearer ${shared}`,
        'X-Api-Key': 'shared-key',
      },
    },
    options: { apiMode: 'yuantus', tenantId: 'yt-b', orgId: 'org-1' },
    credentials: { token: shared, username: 'service', password: 'service-secret' },
  } as never)
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('personal BOM write transport', () => {
  it('uses the existing grants page hash and a direct personal bearer', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const fetch = vi.fn().mockResolvedValue(new Response('{"schema":"yuantus.plm-bom-write-binding.v1"}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const client = adapter()
    expect(client.personalBomWriteManagementUrl(persisted)).toBe(
      'https://synthetic.invalid/personal-approval-grants#bom-write',
    )
    await client.personalBomWriteRequest('verify', grant, 'conn-1', authority)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://synthetic.invalid/api/v1/plm-bom-write-grant/verify')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({
      Authorization: `Bearer ${grant}`,
      'Content-Type': 'application/json',
      'x-tenant-id': 'yt-b',
      'x-org-id': 'org-1',
    })
    expect(JSON.stringify(init)).not.toContain(shared)
    expect(JSON.stringify(init)).not.toContain('shared-key')
    expect(JSON.parse(init.body)).toEqual({ connection_id: 'conn-1' })
  })

  it('sends line and eco-intent on the admitted paths only', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const fetch = vi.fn().mockImplementation(async (url: URL) => {
      const path = String(url)
      if (path.endsWith('/grant')) return new Response(null, { status: 204 })
      if (path.endsWith('/eco-intent')) {
        return new Response(
          JSON.stringify({
            eco_id: 'eco-1',
            state: 'open',
            attached: false,
            source_version_id: 'v1',
            target_version_id: null,
          }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ ok: true, bom_line_id: 'line-1' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    const client = adapter()
    const key = 'a'.repeat(64)
    await client.personalBomWriteRequest(
      'line',
      grant,
      'conn-1',
      authority,
      { quantity: 2, token: grant, nested: { password: 'no' } },
      { partId: 'part-1', bomLineId: 'line-1', idempotencyKey: key, ifMatch: '"etag-1"' },
    )
    await client.personalBomWriteRequest('eco-intent', grant, 'conn-1', authority, undefined, {
      partId: 'part-1',
      idempotencyKey: key,
    })
    await client.personalBomWriteRequest('revoke', grant, 'conn-1', authority)
    const paths = fetch.mock.calls.map(([url]) => String(url))
    expect(paths).toEqual([
      'https://synthetic.invalid/api/v1/bom/multitable/part-1/lines/line-1',
      'https://synthetic.invalid/api/v1/bom/multitable/part-1/eco-intent',
      'https://synthetic.invalid/api/v1/plm-bom-write-grant/grant',
    ])
    expect(fetch.mock.calls[0][1].method).toBe('PATCH')
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ quantity: 2 })
    expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(key)
    expect(fetch.mock.calls[0][1].headers['If-Match']).toBe('"etag-1"')
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${grant}`)
    expect(fetch.mock.calls[1][1].method).toBe('POST')
    expect(fetch.mock.calls[1][1].body).toBeUndefined()
    expect(fetch.mock.calls[2][1].method).toBe('DELETE')
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(shared)
  })

  it('preserves a structured native conflict once and drops secret fields', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: 'lifecycle_locked',
            message: 'Item is locked',
            state: 'Released',
            eco_required: true,
            token: grant,
          },
        }),
        { status: 409 },
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const error = await adapter().personalBomWriteRequest('verify', grant, 'conn-1', authority).then(
      () => {
        throw new Error('expected conflict')
      },
      (caught: unknown) => caught as { status: number; code: string; detail: Record<string, unknown> },
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('PLM_BOM_WRITE_CONFLICT')
    expect(error.detail).toEqual({
      code: 'lifecycle_locked',
      message: 'Item is locked',
      state: 'Released',
      eco_required: true,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('posts a UTF-8 connection id and still revokes when the flag is off', async () => {
    const fetch = vi.fn().mockImplementation(async (url: URL) => {
      if (String(url).endsWith('/grant')) return new Response(null, { status: 204 })
      return new Response('{"schema":"yuantus.plm-bom-write-binding.v1"}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const client = adapter()
    await client.personalBomWriteRequest('verify', grant, '连接-甲', authority)
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ connection_id: '连接-甲' })
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${grant}`)
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'false')
    await expect(
      client.personalBomWriteRequest('line', grant, '连接-甲', authority, { quantity: 1 }, {
        partId: 'part-1',
        bomLineId: 'line-1',
        idempotencyKey: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'PLM_BOM_WRITE_DISABLED' })
    await expect(client.personalBomWriteRequest('verify', grant, '连接-甲', authority)).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_DISABLED',
    })
    const yua = `yua_${'a'.repeat(32)}_${'b'.repeat(43)}`
    await expect(client.personalBomWriteRequest('revoke', yua, '连接-甲', authority)).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_FORBIDDEN',
    })
    await client.personalBomWriteRequest('revoke', grant, '连接-甲', authority)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][1].method).toBe('DELETE')
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${grant}`)
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(shared)
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('shared-key')
  })

  it('sends the native UTF-8 line patch on encoded opaque segments', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const partId = '部件-甲'
    const bomLineId = '行-甲'
    const connectionId = '连接-甲'
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, bom_line_id: bomLineId }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await adapter().personalBomWriteRequest(
      'line',
      grant,
      connectionId,
      authority,
      { quantity: 2 },
      { partId, bomLineId, idempotencyKey: 'a'.repeat(64) },
    )
    expect(result).toEqual({ ok: true, bom_line_id: bomLineId })
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe(
      `https://synthetic.invalid/api/v1/bom/multitable/${encodeURIComponent(partId)}/lines/${encodeURIComponent(bomLineId)}`,
    )
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ quantity: 2 })
    expect(init.headers.Authorization).toBe(`Bearer ${grant}`)
    expect(JSON.stringify(init)).not.toContain(shared)
  })

  it('sends a 140-character native item id without the header length cap', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const partId = 'p'.repeat(140)
    const bomLineId = 'l'.repeat(140)
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, bom_line_id: bomLineId }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetch)
    const result = await adapter().personalBomWriteRequest(
      'line',
      grant,
      'conn-1',
      authority,
      { quantity: 2 },
      { partId, bomLineId, idempotencyKey: 'a'.repeat(64) },
    )
    expect(result).toEqual({ ok: true, bom_line_id: bomLineId })
    const [url, init] = fetch.mock.calls[0]
    expect(String(url)).toBe(`https://synthetic.invalid/api/v1/bom/multitable/${partId}/lines/${bomLineId}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ quantity: 2 })
  })

  it('does not fetch for yua, flag off, or the approval flag alone', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'false')
    const yua = `yua_${'a'.repeat(32)}_${'b'.repeat(43)}`
    await expect(adapter().personalBomWriteRequest('verify', yua, 'conn-1', authority)).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_DISABLED',
    })
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    await expect(adapter().personalBomWriteRequest('verify', yua, 'conn-1', authority)).rejects.toMatchObject({
      code: 'PLM_BOM_WRITE_FORBIDDEN',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(adapter().personalBomWriteManagementUrl(persisted)).not.toContain('/personal-bom-write')
  })

  it.each(['https://synthetic.invalid', 'https://synthetic.invalid/'])(
    'admits persisted root %s on the management helper',
    (url) => {
      vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      const config = { ...persisted, connection: { ...persisted.connection, url } }
      expect(adapter().personalBomWriteManagementUrl(config)).toBe(
        'https://synthetic.invalid/personal-approval-grants#bom-write',
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    'https://synthetic.invalid/prefix',
    'https://synthetic.invalid/prefix/',
    'https://synthetic.invalid/%2F',
  ])('rejects persisted pathname %s before any personal fetch', (url) => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const config = { ...persisted, connection: { ...persisted.connection, url } }
    expect(() => adapter().personalBomWriteManagementUrl(config)).toThrow(
      expect.objectContaining({ status: 403, code: 'PLM_BOM_WRITE_FORBIDDEN' }),
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('personal BOM response byte limit', () => {
  function utf8Bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  function paddedVerifyJson(byteLength: number): string {
    const prefix = '{"ok":true,"pad":"'
    const suffix = '"}'
    return prefix + 'x'.repeat(byteLength - prefix.length - suffix.length) + suffix
  }

  function paddedConflictJson(byteLength: number): string {
    const prefix = '{"detail":{"code":"lifecycle_locked","message":"'
    const suffix = '","state":"Released","eco_required":true}}'
    return prefix + 'm'.repeat(byteLength - prefix.length - suffix.length) + suffix
  }

  function replacementVerifyBytes(invalidCount: number): Uint8Array {
    const prefix = utf8Bytes('{"ok":true,"pad":"')
    const suffix = utf8Bytes('"}')
    const bytes = new Uint8Array(prefix.length + invalidCount + suffix.length)
    bytes.set(prefix, 0)
    bytes.fill(0xff, prefix.length, prefix.length + invalidCount)
    bytes.set(suffix, prefix.length + invalidCount)
    return bytes
  }

  function openFiniteByteStream(parts: Uint8Array[]): {
    stream: ReadableStream<Uint8Array>
    pulls: () => number
    cancels: () => number
  } {
    let next = 0
    let pullCount = 0
    let cancelCount = 0
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pullCount += 1
          if (next >= parts.length) {
            controller.close()
            return
          }
          const part = parts[next]
          next += 1
          controller.enqueue(part)
        },
        cancel() {
          cancelCount += 1
        },
      },
      { highWaterMark: 0 },
    )
    return { stream, pulls: () => pullCount, cancels: () => cancelCount }
  }

  function lineRequest(client: ReturnType<typeof adapter>) {
    return client.personalBomWriteRequest('line', grant, 'conn-1', authority, { quantity: 1 }, {
      partId: 'part-1',
      bomLineId: 'line-1',
      idempotencyKey: 'a'.repeat(64),
    })
  }

  async function bomFailure(call: Promise<unknown>): Promise<{
    status: number
    code: string
    detail: unknown
    received: boolean
    message: string
    raw: unknown
  }> {
    try {
      await call
    } catch (caught) {
      const error = caught as {
        status: number
        code: string
        detail?: unknown
        received: boolean
        message: string
      }
      return {
        status: error.status,
        code: error.code,
        detail: error.detail,
        received: error.received,
        message: error.message,
        raw: caught,
      }
    }
    throw new Error('expected personal BOM failure')
  }

  async function lineRelay(error: unknown) {
    const wire = await import('../../src/services/plm-personal-bom-write-http')
    return wire.relayPersonalBomWriteFailure(error, 'line')
  }

  it('admits exact 8192 JSON with a BOM and reassembles split BOM and multibyte bytes', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const json = paddedVerifyJson(8192)
    expect(Buffer.byteLength(json)).toBe(8192)
    const plain = openFiniteByteStream([utf8Bytes(json)])
    const withBom = openFiniteByteStream([Uint8Array.of(0xef, 0xbb, 0xbf), utf8Bytes(json)])
    expect(3 + Buffer.byteLength(json)).toBe(8195)
    const text = '{"ok":true,"ch":"甲"}'
    const encoded = utf8Bytes(text)
    const at = encoded.indexOf(0xe7)
    expect(encoded[at]).toBe(0xe7)
    expect(encoded[at + 1]).toBe(0x94)
    expect(encoded[at + 2]).toBe(0xb2)
    expect(encoded.byteLength - (at + 2)).toBeGreaterThan(0)
    const split = openFiniteByteStream([
      Uint8Array.of(0xef),
      Uint8Array.of(0xbb, 0xbf),
      encoded.subarray(0, at + 1),
      Uint8Array.of(encoded[at + 1]),
      encoded.subarray(at + 2),
    ])
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(plain.stream, { status: 200 }))
      .mockResolvedValueOnce(new Response(withBom.stream, { status: 200 }))
      .mockResolvedValueOnce(new Response(split.stream, { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const client = adapter()
    await expect(client.personalBomWriteRequest('verify', grant, 'conn-1', authority)).resolves.toEqual(
      JSON.parse(json),
    )
    await expect(client.personalBomWriteRequest('verify', grant, 'conn-1', authority)).resolves.toEqual(
      JSON.parse(json),
    )
    await expect(client.personalBomWriteRequest('verify', grant, 'conn-1', authority)).resolves.toEqual(
      JSON.parse(text),
    )
    expect(plain.pulls()).toBe(2)
    expect(plain.cancels()).toBe(0)
    expect(withBom.pulls()).toBe(3)
    expect(withBom.cancels()).toBe(0)
    expect(split.pulls()).toBe(6)
    expect(split.cancels()).toBe(0)
    expect(plain.stream.locked).toBe(false)
    expect(withBom.stream.locked).toBe(false)
    expect(split.stream.locked).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('cancels confirmed overflow before the unread tail and keeps each non-OK status', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const prefixText =
      '{"detail":{"code":"lifecycle_locked","message":"Item is locked","state":"Released","eco_required":true},"ok":true,"bom_line_id":"line-1"}'
    const parsedPrefix = JSON.parse(prefixText) as { detail: { code: string }; ok: boolean }
    expect(parsedPrefix.detail.code).toBe('lifecycle_locked')
    expect(parsedPrefix.ok).toBe(true)
    expect(Buffer.byteLength(prefixText)).toBeLessThanOrEqual(8195)
    const prefix = utf8Bytes(prefixText)
    const tail = utf8Bytes(`UNREAD_TAIL_${grant}`)
    const statuses = [401, 403, 409, 412, 422, 500] as const
    const codes: Record<(typeof statuses)[number], string> = {
      401: 'PLM_BOM_WRITE_UNAUTHORIZED',
      403: 'PLM_BOM_WRITE_FORBIDDEN',
      409: 'PLM_BOM_WRITE_CONFLICT',
      412: 'PLM_BOM_WRITE_PRECONDITION',
      422: 'PLM_BOM_WRITE_INVALID',
      500: 'PLM_BOM_WRITE_UNAVAILABLE',
    }
    const client = adapter()
    for (const status of statuses) {
      const opened = openFiniteByteStream([prefix, new Uint8Array(8196), tail])
      const init: ResponseInit = { status }
      if (status === 401) init.headers = { 'Content-Length': '1' }
      const fetch = vi.fn().mockResolvedValue(new Response(opened.stream, init))
      vi.stubGlobal('fetch', fetch)
      const error = await bomFailure(lineRequest(client))
      expect(error.status).toBe(status)
      expect(error.code).toBe(codes[status])
      expect(error.received).toBe(true)
      expect(error.detail).toBeUndefined()
      expect(error.message).toBe(codes[status])
      expect(error.message).not.toContain('UNREAD_TAIL')
      expect(error.message).not.toContain(grant)
      expect(opened.pulls()).toBe(2)
      expect(opened.cancels()).toBe(1)
      expect(opened.stream.locked).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(fetch.mock.calls)).not.toContain(shared)
      if (status === 401 || status === 403) {
        expect(await lineRelay(error.raw)).toEqual({
          status,
          reason: 'provider-rejected',
          outcome: 'refused',
          code: 'PLM_BOM_WRITEBACK_FAILED',
          attemptOutcome: 'refused',
          operationMayHaveApplied: true,
          retryPolicy: 'same-operation',
        })
      }
      if (status === 409) {
        expect(await lineRelay(error.raw)).toEqual({
          status: 503,
          reason: 'unknown',
          outcome: 'unknown',
          code: 'PLM_BOM_WRITEBACK_FAILED',
        })
      }
    }
    const okPrefix = '{"ok":true,"bom_line_id":"line-1"}'
    expect(JSON.parse(okPrefix)).toEqual({ ok: true, bom_line_id: 'line-1' })
    const okStream = openFiniteByteStream([utf8Bytes(okPrefix), new Uint8Array(8196), tail])
    const okFetch = vi.fn().mockResolvedValue(new Response(okStream.stream, { status: 200 }))
    vi.stubGlobal('fetch', okFetch)
    const okError = await bomFailure(client.personalBomWriteRequest('verify', grant, 'conn-1', authority))
    expect(okError.status).toBe(503)
    expect(okError.code).toBe('PLM_BOM_WRITE_UNAVAILABLE')
    expect(okError.received).toBe(true)
    expect(okError.detail).toBeUndefined()
    expect(okError.message).toBe('PLM_BOM_WRITE_UNAVAILABLE')
    expect(okStream.pulls()).toBe(2)
    expect(okStream.cancels()).toBe(1)
    expect(okStream.stream.locked).toBe(false)
    expect(okFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps decoded oversize and replacement expansion on the original 8192 guards', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const json8193 = paddedVerifyJson(8193)
    const json8195 = paddedVerifyJson(8195)
    const conflict = paddedConflictJson(8193)
    expect(Buffer.byteLength(json8193)).toBe(8193)
    expect(Buffer.byteLength(json8195)).toBe(8195)
    expect(Buffer.byteLength(conflict)).toBe(8193)
    expect(JSON.parse(conflict).detail.code).toBe('lifecycle_locked')
    const expanded = replacementVerifyBytes(2725)
    const expandedText = new TextDecoder().decode(expanded)
    expect(expanded.byteLength).toBe(2745)
    expect(Buffer.byteLength(expandedText)).toBe(8195)
    expect(JSON.parse(expandedText).ok).toBe(true)
    const client = adapter()
    for (const body of [utf8Bytes(json8193), utf8Bytes(json8195), expanded]) {
      const opened = openFiniteByteStream([body])
      const fetch = vi.fn().mockResolvedValue(new Response(opened.stream, { status: 200 }))
      vi.stubGlobal('fetch', fetch)
      const error = await bomFailure(client.personalBomWriteRequest('verify', grant, 'conn-1', authority))
      expect(error.status).toBe(503)
      expect(error.code).toBe('PLM_BOM_WRITE_UNAVAILABLE')
      expect(error.received).toBe(true)
      expect(error.detail).toBeUndefined()
      expect(opened.cancels()).toBe(0)
      expect(opened.pulls()).toBe(2)
      expect(opened.stream.locked).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(1)
    }
    const conflictStream = openFiniteByteStream([utf8Bytes(conflict)])
    const conflictFetch = vi.fn().mockResolvedValue(new Response(conflictStream.stream, { status: 409 }))
    vi.stubGlobal('fetch', conflictFetch)
    const conflictError = await bomFailure(lineRequest(client))
    expect(conflictError.status).toBe(409)
    expect(conflictError.code).toBe('PLM_BOM_WRITE_CONFLICT')
    expect(conflictError.received).toBe(true)
    expect(conflictError.detail).toBeUndefined()
    expect(conflictStream.cancels()).toBe(0)
    expect(conflictStream.pulls()).toBe(2)
    expect(conflictStream.stream.locked).toBe(false)
    const small = utf8Bytes('{"schema":"yuantus.plm-bom-write-binding.v1"}')
    const hugeHeader = openFiniteByteStream([small])
    const hugeFetch = vi.fn().mockResolvedValue(
      new Response(hugeHeader.stream, {
        status: 200,
        headers: { 'Content-Length': '999999999' },
      }),
    )
    vi.stubGlobal('fetch', hugeFetch)
    await expect(client.personalBomWriteRequest('verify', grant, 'conn-1', authority)).resolves.toEqual({
      schema: 'yuantus.plm-bom-write-binding.v1',
    })
    expect(hugeHeader.cancels()).toBe(0)
    expect(hugeHeader.pulls()).toBe(2)
    expect(hugeHeader.stream.locked).toBe(false)
    expect(hugeFetch).toHaveBeenCalledTimes(1)
  })

  it('reads a null body as complete empty text', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'false')
    const client = adapter()
    await expect(client.personalBomWriteRequest('revoke', grant, 'conn-1', authority)).resolves.toBeNull()
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const emptyVerify = await bomFailure(client.personalBomWriteRequest('verify', grant, 'conn-1', authority))
    expect(emptyVerify.status).toBe(503)
    expect(emptyVerify.code).toBe('PLM_BOM_WRITE_UNAVAILABLE')
    expect(emptyVerify.received).toBe(true)
    expect(emptyVerify.detail).toBeUndefined()
    const unauthorized = await bomFailure(client.personalBomWriteRequest('verify', grant, 'conn-1', authority))
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.code).toBe('PLM_BOM_WRITE_UNAUTHORIZED')
    expect(unauthorized.received).toBe(true)
    expect(unauthorized.detail).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls[0][1].method).toBe('DELETE')
    expect(JSON.stringify(fetch.mock.calls)).not.toContain(shared)
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('shared-key')
  })

  it('maps read or cancel failure to unavailable uncertainty and keeps the 8000ms request', async () => {
    vi.stubEnv('PLM_PERSONAL_BOM_WRITE_ENABLED', 'true')
    const prefix = utf8Bytes(
      `{"detail":{"code":"lifecycle_locked","message":"${grant}","state":"Released","eco_required":true}}`,
    )
    let readPulls = 0
    let readCancels = 0
    const readStream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          readPulls += 1
          if (readPulls === 1) {
            controller.enqueue(prefix)
            return
          }
          if (readPulls === 2) throw new Error('read-failed')
          controller.close()
        },
        cancel() {
          readCancels += 1
        },
      },
      { highWaterMark: 0 },
    )
    const readFetch = vi.fn().mockResolvedValue(new Response(readStream, { status: 409 }))
    vi.stubGlobal('fetch', readFetch)
    const client = adapter()
    const readError = await bomFailure(lineRequest(client))
    expect(readError.status).toBe(503)
    expect(readError.code).toBe('PLM_BOM_WRITE_UNAVAILABLE')
    expect(readError.received).toBe(false)
    expect(readError.detail).toBeUndefined()
    expect(readError.message).toBe('PLM_BOM_WRITE_UNAVAILABLE')
    expect(readError.message).not.toContain(grant)
    expect(readError.message).not.toContain('read-failed')
    expect(readError.message).not.toContain('lifecycle_locked')
    expect(JSON.stringify(readError.raw)).not.toContain(grant)
    expect(JSON.stringify(readError.raw)).not.toContain('lifecycle_locked')
    expect(readPulls).toBe(2)
    expect(readCancels).toBe(0)
    expect(readStream.locked).toBe(false)
    expect(readFetch).toHaveBeenCalledTimes(1)
    expect(await lineRelay(readError.raw)).toEqual({
      status: 503,
      reason: 'unknown',
      outcome: 'unknown',
      code: 'PLM_BOM_WRITEBACK_FAILED',
    })

    const chunk = new Uint8Array(8196)
    chunk.set(utf8Bytes(grant))
    let cancelPulls = 0
    let cancelCount = 0
    const cancelStream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          cancelPulls += 1
          if (cancelPulls === 1) {
            controller.enqueue(chunk)
            return
          }
          controller.close()
        },
        async cancel() {
          cancelCount += 1
          throw new Error(`cancel-failed-${grant}`)
        },
      },
      { highWaterMark: 0 },
    )
    const cancelFetch = vi.fn().mockResolvedValue(new Response(cancelStream, { status: 401 }))
    vi.stubGlobal('fetch', cancelFetch)
    const cancelError = await bomFailure(lineRequest(client))
    expect(cancelError.status).toBe(503)
    expect(cancelError.code).toBe('PLM_BOM_WRITE_UNAVAILABLE')
    expect(cancelError.received).toBe(false)
    expect(cancelError.detail).toBeUndefined()
    expect(cancelError.message).toBe('PLM_BOM_WRITE_UNAVAILABLE')
    expect(cancelError.message).not.toContain(grant)
    expect(cancelError.message).not.toContain('cancel-failed')
    expect(JSON.stringify(cancelError.raw)).not.toContain(grant)
    expect(cancelPulls).toBe(1)
    expect(cancelCount).toBe(1)
    expect(cancelStream.locked).toBe(false)
    expect(cancelFetch).toHaveBeenCalledTimes(1)
    expect(await lineRelay(cancelError.raw)).toEqual({
      status: 503,
      reason: 'unknown',
      outcome: 'unknown',
      code: 'PLM_BOM_WRITEBACK_FAILED',
    })

    const signal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    try {
      const payload = utf8Bytes('{"schema":"yuantus.plm-bom-write-binding.v1"}')
      const fetch = vi.fn().mockResolvedValue(new Response(payload, { status: 200 }))
      vi.stubGlobal('fetch', fetch)
      await expect(client.personalBomWriteRequest('verify', grant, 'conn-1', authority)).resolves.toEqual({
        schema: 'yuantus.plm-bom-write-binding.v1',
      })
      expect(timeout).toHaveBeenCalledTimes(1)
      expect(timeout).toHaveBeenCalledWith(8000)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0][1].redirect).toBe('error')
      expect(fetch.mock.calls[0][1].signal).toBe(signal)
      expect(JSON.stringify(fetch.mock.calls)).not.toContain(shared)
    } finally {
      timeout.mockRestore()
    }
  })
})
