import { afterEach, describe, it, expect, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const grant = `yua_${'a'.repeat(32)}_${'b'.repeat(43)}`
function adapter(url = 'https://synthetic.invalid/prefix') {
  const conf: Record<string, unknown> = {
    'plm.url': url,
    'plm.apiMode': 'yuantus',
    'plm.tenantId': 'tenant',
    'plm.orgId': 'org',
    'plm.apiToken': 'must-not-send-service-token',
  }
  return new PLMAdapter({ get: async (k: string) => conf[k] } as never, logger as never)
}
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('fixed-provider personal-only PLM transport', () => {
  it('actual Node loader preserves the typed receipt-404 recovery branch', () => {
    const require = createRequire(import.meta.url)
    const stdout = execFileSync(process.execPath, ['--import', require.resolve('tsx'), 'tests/fixtures/plm-personal-approval-error-family.mts'], {
      cwd: process.cwd(), env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.json' }, encoding: 'utf8', timeout: 15000,
    })
    const result = JSON.parse(stdout.trim())
    expect(result.result).toEqual({ ok: true, value: 'admissionRequired' })
    expect(result.calls).toBe(1)
  })
  it('initializes configuration without service login/probe then uses only personal bearer and fixed scope', async () => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    const fetch = vi.fn().mockResolvedValue(new Response('{"safe":true}'))
    vi.stubGlobal('fetch', fetch)
    const a = adapter()
    await a.initializePersonalApproval()
    expect(fetch).not.toHaveBeenCalled()
    expect(a.personalApprovalManagementUrl()).toBe(
      'https://synthetic.invalid/personal-approval-grants',
    )
    await a.personalApprovalRequest('verify', grant, 'fixed')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(String(url)).toBe('https://synthetic.invalid/api/v1/plm-approval-card/verify')
    expect(opts.headers).toEqual({
      Authorization: `Bearer ${grant}`,
      'Content-Type': 'application/json',
      'x-tenant-id': 'tenant',
      'x-org-id': 'org',
    })
    expect(opts.redirect).toBe('error')
    expect(JSON.parse(opts.body)).toEqual({ connection_id: 'fixed' })
  })
  it.each([
    'http://synthetic.invalid',
    'https://name:password@synthetic.invalid',
    'https://synthetic.invalid?auth=x',
    'https://synthetic.invalid#fragment',
  ])('refuses unsafe fixed provider %s', async (url) => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    await expect(adapter(url).initializePersonalApproval()).rejects.toThrow()
  })
  it('allows literal loopback http only in test runtime', async () => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    vi.stubEnv('NODE_ENV', 'production')
    await expect(adapter('http://127.0.0.1:9000').initializePersonalApproval()).rejects.toThrow()
    vi.stubEnv('NODE_ENV', 'test')
    await expect(
      adapter('http://127.0.0.1:9000').initializePersonalApproval(),
    ).resolves.toBeUndefined()
  })
  it('never retries a 401 with service credentials and exposes no provider body', async () => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('sensitive provider detail', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const a = adapter()
    await a.initializePersonalApproval()
    await expect(
      a.personalApprovalRequest('receipt', grant, 'fixed', undefined, 'command'),
    ).rejects.toMatchObject({ status: 401, message: 'PLM_CARD_UNAUTHORIZED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('gate off and wrong connection refuse without request', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'false')
    await expect(adapter().initializePersonalApproval()).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('bounded personal approval response reader', () => {
  const decodedLimit = 2_000_000
  const rawLimit = decodedLimit + 3

  function jsonExact(decodedBytes: number) {
    const prefix = Buffer.from('{"v":"')
    const suffix = Buffer.from('"}')
    const euro = Buffer.from([0xe2, 0x82, 0xac])
    const fillerLen = decodedBytes - prefix.length - euro.length - suffix.length
    const bytes = Buffer.concat([
      prefix,
      Buffer.alloc(1, 0x78),
      euro,
      Buffer.alloc(fillerLen - 1, 0x78),
      suffix,
    ])
    return { bytes, boundary: prefix.length + 2 }
  }

  function streamResponse(parts: Uint8Array[], contentLength?: string, tailIndex = -1) {
    let index = 0
    let pulls = 0
    let tailPulled = false
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (index >= parts.length) {
          controller.close()
          return
        }
        if (index === tailIndex) tailPulled = true
        controller.enqueue(parts[index])
        index += 1
      },
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    const response = new Response(stream, contentLength === undefined ? undefined : {
      headers: { 'content-length': contentLength },
    })
    return {
      response,
      pulls: () => pulls,
      tailPulled: () => tailPulled,
      cancelled: () => cancelled,
    }
  }

  async function callWith(response: Response) {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    const fetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    const a = adapter()
    await a.initializePersonalApproval()
    return { fetch, a }
  }

  it('accepts exact 2000000 decoded JSON with and without one initial BOM', async () => {
    const made = jsonExact(decodedLimit)
    expect(made.bytes.length).toBe(decodedLimit)
    expect([...made.bytes.subarray(made.boundary - 1, made.boundary + 2)]).toEqual([0xe2, 0x82, 0xac])
    const decoded = new TextDecoder().decode(made.bytes)
    expect(Buffer.byteLength(decoded)).toBe(decodedLimit)
    const expected = JSON.parse(decoded)
    expect(expected.v.includes('\u20ac')).toBe(true)
    const noBom = streamResponse([
      made.bytes.subarray(0, made.boundary),
      made.bytes.subarray(made.boundary),
    ])
    const noBomCall = await callWith(noBom.response)
    await expect(noBomCall.a.personalApprovalRequest('verify', grant, 'fixed')).resolves.toEqual(expected)
    expect(noBomCall.fetch).toHaveBeenCalledTimes(1)
    expect(noBom.cancelled()).toBe(false)
    expect(noBom.response.body?.locked).toBe(false)

    const bom = Uint8Array.from([0xef, 0xbb, 0xbf])
    const withBom = streamResponse([
      bom.subarray(0, 2),
      Buffer.concat([bom.subarray(2, 3), made.bytes.subarray(0, made.boundary)]),
      made.bytes.subarray(made.boundary),
    ])
    expect(bom.length + made.bytes.length).toBe(rawLimit)
    const withBomCall = await callWith(withBom.response)
    await expect(withBomCall.a.personalApprovalRequest('verify', grant, 'fixed')).resolves.toEqual(expected)
    expect(withBomCall.fetch).toHaveBeenCalledTimes(1)
    expect(withBom.cancelled()).toBe(false)
    expect(withBom.response.body?.locked).toBe(false)
  })

  it('cancels a raw stream over 2000003 before a controlled tail is pulled', async () => {
    // A full response.text() read would pull the tail. That old path is not executed.
    const head = new Uint8Array(decodedLimit)
    const cross = new Uint8Array(4)
    const tail = Uint8Array.from([1, 2, 3, 4])
    expect(head.length + cross.length).toBe(2_000_004)
    for (const contentLength of [undefined, '1']) {
      const body = streamResponse([head, cross, tail], contentLength, 2)
      if (contentLength === undefined) expect(body.response.headers.get('content-length')).toBeNull()
      else expect(body.response.headers.get('content-length')).toBe(contentLength)
      const call = await callWith(body.response)
      await expect(call.a.personalApprovalRequest('verify', grant, 'fixed')).rejects.toMatchObject({
        status: 503,
        message: 'PLM_PROVIDER_UNAVAILABLE',
      })
      expect(call.fetch).toHaveBeenCalledTimes(1)
      expect(body.cancelled()).toBe(true)
      expect(body.tailPulled()).toBe(false)
      expect(body.pulls()).toBe(2)
      expect(body.response.body?.locked).toBe(false)
    }
  })

  it('keeps the decoded 2000000 cap for allowed raw JSON and UTF-8 replacement expansion', async () => {
    const over = jsonExact(decodedLimit + 1)
    expect(over.bytes.length).toBe(decodedLimit + 1)
    expect(over.bytes.length).toBeLessThanOrEqual(rawLimit)
    expect(Buffer.byteLength(new TextDecoder().decode(over.bytes))).toBe(decodedLimit + 1)
    const overCall = await callWith(streamResponse([over.bytes]).response)
    await expect(overCall.a.personalApprovalRequest('verify', grant, 'fixed')).rejects.toMatchObject({
      status: 503,
      message: 'PLM_PROVIDER_UNAVAILABLE',
    })
    expect(overCall.fetch).toHaveBeenCalledTimes(1)

    const prefix = Buffer.from('{"v":"')
    const suffix = Buffer.from('"}')
    const raw = Buffer.concat([prefix, Buffer.alloc(1_999_990, 0x78), Buffer.from([0xff]), suffix])
    const decoded = new TextDecoder().decode(raw)
    expect(raw.length).toBe(1_999_999)
    expect(raw.length).toBeLessThanOrEqual(rawLimit)
    expect(Buffer.byteLength(decoded)).toBe(decodedLimit + 1)
    expect(JSON.parse(decoded).v.endsWith('\uFFFD')).toBe(true)
    const expanded = await callWith(streamResponse([raw]).response)
    await expect(expanded.a.personalApprovalRequest('verify', grant, 'fixed')).rejects.toMatchObject({
      status: 503,
      message: 'PLM_PROVIDER_UNAVAILABLE',
    })
    expect(expanded.fetch).toHaveBeenCalledTimes(1)
  })

  it('accepts a small split UTF-8 body when Content-Length is far above the raw cap', async () => {
    const parts = [
      Uint8Array.from([0x7b, 0x22, 0x73, 0x22, 0x3a, 0x22, 0xc3]),
      Uint8Array.from([0xa9, 0x22, 0x7d]),
    ]
    const body = streamResponse(parts, '2000004')
    expect(body.response.headers.get('content-length')).toBe('2000004')
    expect(JSON.parse(new TextDecoder().decode(Buffer.concat(parts)))).toEqual({ s: 'é' })
    const call = await callWith(body.response)
    await expect(call.a.personalApprovalRequest('verify', grant, 'fixed')).resolves.toEqual({ s: 'é' })
    expect(call.fetch).toHaveBeenCalledTimes(1)
    expect(body.cancelled()).toBe(false)
    expect(body.response.body?.locked).toBe(false)
  })

  it('maps a stream read failure to fixed 503, releases the lock, and does not retry', async () => {
    let pulls = 0
    const stream = new ReadableStream({
      pull() {
        pulls += 1
        throw new Error('sensitive provider stream detail')
      },
    }, { highWaterMark: 0 })
    const response = new Response(stream)
    const call = await callWith(response)
    const error = await call.a.personalApprovalRequest('verify', grant, 'fixed').then(
      () => { throw new Error('expected rejection') },
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ status: 503, message: 'PLM_PROVIDER_UNAVAILABLE' })
    expect(JSON.stringify(error)).not.toContain('sensitive provider stream detail')
    expect(call.fetch).toHaveBeenCalledTimes(1)
    expect(pulls).toBe(1)
    expect(response.body?.locked).toBe(false)
  })

  it('passes one finite AbortSignal.timeout of 8000 and restores the spy', async () => {
    vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', 'true')
    vi.stubEnv('PLM_APPROVAL_CARD_CONNECTION_ID', 'fixed')
    const signal = new AbortController().signal
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
    try {
      const fetch = vi.fn().mockResolvedValue(new Response('{"ok":1}'))
      vi.stubGlobal('fetch', fetch)
      const a = adapter()
      const before = timeout.mock.calls.length
      await a.initializePersonalApproval()
      const afterInit = timeout.mock.calls.length
      await expect(a.personalApprovalRequest('verify', grant, 'fixed')).resolves.toEqual({ ok: 1 })
      expect(timeout.mock.calls.length).toBe(afterInit + 1)
      expect(timeout.mock.calls[afterInit]).toEqual([8000])
      expect(before).toBe(0)
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch.mock.calls[0][1].signal).toBe(signal)
      expect(fetch.mock.calls[0][1].redirect).toBe('error')
    } finally {
      timeout.mockRestore()
    }
  })

  it('releases the lock when cancel of one 2000004-byte chunk rejects', async () => {
    let cancels = 0
    let emitted = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted) {
          controller.close()
          return
        }
        emitted = true
        controller.enqueue(new Uint8Array(2_000_004))
      },
      async cancel() {
        cancels += 1
        throw new Error('sensitive cancel marker')
      },
    }, { highWaterMark: 0 })
    const response = new Response(stream)
    const call = await callWith(response)
    const error = await call.a.personalApprovalRequest('verify', grant, 'fixed').then(
      () => { throw new Error('expected rejection') },
      (caught: unknown) => caught,
    )
    expect(error).toMatchObject({ status: 503, message: 'PLM_PROVIDER_UNAVAILABLE' })
    expect(JSON.stringify(error)).not.toContain('sensitive cancel marker')
    expect(cancels).toBe(1)
    expect(call.fetch).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })
})
