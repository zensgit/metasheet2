import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalLocation = window.location
const origin = 'https://gateway-test.example'
const now = new Date('2026-11-11T12:34:56.000Z')
const requestId = 'req-synthetic-12345678'
const fetchMock = vi.fn()
const replace = vi.fn()

function jsonResponse(body: unknown = { healthy: true }, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

async function modules() {
  const api = await import('../src/utils/api')
  const gateway = await import('../src/utils/gatewayDiagnostics')
  const errors = await import('../src/utils/networkErrors')
  const { MultitableApiClient } = await import('../src/multitable/api/client')
  return { ...api, ...gateway, ...errors, MultitableApiClient }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(now)
  fetchMock.mockReset()
  replace.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  vi.stubEnv('VITE_API_URL', '')
  vi.stubEnv('VITE_API_BASE', '')
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin, pathname: '/multitable', search: '', hash: '', replace },
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

describe('gateway diagnosis at API JSON consumers', () => {
  it.each(['en', 'zh-CN'])('diagnoses HTML errors with safe ID and time in %s without exposing request data', async (locale) => {
    localStorage.setItem('metasheet_locale', locale)
    localStorage.setItem('auth_token', 'synthetic-private-token')
    const { apiPost, GATEWAY_INTERFERENCE } = await modules()
    fetchMock.mockResolvedValue(new Response('<html>PRIVATE-RESPONSE</html>', {
      status: 500, headers: { 'Content-Type': 'text/html', 'X-Request-ID': requestId },
    }))
    const error = await apiPost('/api/write?token=PRIVATE-URL', { secret: 'PRIVATE-BODY' }).catch((failure) => failure)
    expect(error).toMatchObject({
      name: 'GatewayInterferenceError', code: GATEWAY_INTERFERENCE, status: 500,
      requestId, requestIdSource: 'response', timestamp: now.toISOString(),
    })
    expect(error.message).toContain(locale === 'zh-CN'
      ? '请求可能被网络安全设备拦截，请联系网络管理员'
      : 'The request may have been blocked by a network security device. Please contact your network administrator.')
    expect(error.message).toContain(error.localTime)
    expect(error.message).toContain(now.toISOString())
    expect(error.message).toContain(requestId)
    expect(JSON.stringify(error) + error.message).not.toMatch(/PRIVATE|synthetic-private-token|gateway-test|\/api\//)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([400, 401, 403, 404, 500, 503])('diagnoses a non-JSON %s only after consumption and never logs out on gateway HTML', async (status) => {
    const { apiFetch, readGatewayJson } = await modules()
    localStorage.setItem('auth_token', 'synthetic-token')
    const response = new Response('blocked', { status, headers: { 'Content-Type': 'text/html' } })
    const clone = vi.spyOn(response, 'clone')
    fetchMock.mockResolvedValue(response)
    const received = await apiFetch('/api/private', { expectJson: true })
    expect(received).toBe(response)
    expect(received.bodyUsed).toBe(false)
    expect(clone).not.toHaveBeenCalled()
    await expect(readGatewayJson(received)).rejects.toMatchObject({ code: 'GATEWAY_INTERFERENCE', status })
    expect(replace).not.toHaveBeenCalled()
    expect(localStorage.getItem('auth_token')).toBe('synthetic-token')
  })

  it.each([200, 500])('detects literal NUL at status %s but accepts escaped JSON NUL data', async (status) => {
    const { MultitableApiClient } = await modules()
    fetchMock.mockResolvedValueOnce(new Response('{"ok":false}\u0000', {
      status, headers: { 'Content-Type': 'application/json' },
    }))
    const client = new MultitableApiClient()
    await expect(client.deleteRecord('record-synthetic')).rejects.toMatchObject({ code: 'GATEWAY_INTERFERENCE', status })
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { deleted: 'value\u0000inside' } }))
    await expect(client.deleteRecord('record-synthetic')).resolves.toEqual({ deleted: 'value\u0000inside' })
  })

  it.each(['application/json', 'application/problem+json', 'text/html'])('preserves typed application errors even with a misleading %s header', async (contentType) => {
    const { MultitableApiClient } = await modules()
    const client = new MultitableApiClient()
    for (const [status, code] of [[401, 'UNAUTHENTICATED'], [500, 'BUSINESS_FAILURE'], [503, 'RECOVERY_ARCHIVE_SCOPE_UNAVAILABLE']] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        ok: false, error: { code, message: 'Synthetic application message', fieldErrors: { title: 'Required' }, serverVersion: 7 },
      }, status, { 'Content-Type': contentType, 'Retry-After': '3' }))
      await expect(client.deleteRecord('record-synthetic')).rejects.toMatchObject({
        name: 'MultitableApiError', status, code, fieldErrors: { title: 'Required' }, serverVersion: 7, retryAfterMs: 3000,
      })
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('preserves password-change redirects for typed JSON refusals without cloning', async () => {
    const { apiGet } = await modules()
    const response = jsonResponse({ error: { code: 'PASSWORD_CHANGE_REQUIRED' } }, 403)
    const clone = vi.spyOn(response, 'clone')
    fetchMock.mockResolvedValue(response)
    await expect(apiGet('/api/private')).rejects.toThrow('API error: 403')
    expect(replace).toHaveBeenCalledWith('/force-password-change')
    expect(clone).not.toHaveBeenCalled()
  })

  it('diagnoses failed malformed JSON regardless of MIME while excluding non-API and successful HTML', async () => {
    const { apiGet, apiFetch, readGatewayJson } = await modules()
    fetchMock.mockResolvedValueOnce(new Response('blocked\u0000', { status: 500 }))
    await expect(apiGet('/assets/file')).rejects.toThrow('API error: 500')
    fetchMock.mockResolvedValueOnce(new Response('<html>broken</html>', { status: 500, headers: { 'Content-Type': 'application/json' } }))
    await expect(apiGet('/api/test')).rejects.toMatchObject({ code: 'GATEWAY_INTERFERENCE', status: 500 })
    fetchMock.mockResolvedValueOnce(new Response('<html>page</html>', { status: 200 }))
    const response = await apiFetch('/api/test', { expectJson: true })
    await expect(readGatewayJson(response)).resolves.toMatchObject({ validJson: false })
  })

  it('does not invoke the JSON/auth callback for a successfully received non-JSON body', async () => {
    const { gatewayRequest, rememberGatewayResponse, readGatewayJson } = await modules()
    const response = new Response('<html>not JSON</html>', { headers: { 'Content-Type': 'application/json' } })
    const onJson = vi.fn()
    rememberGatewayResponse(response, gatewayRequest('/api/test'), onJson)
    await expect(readGatewayJson(response)).resolves.toMatchObject({ validJson: false })
    expect(onJson).not.toHaveBeenCalled()
  })

  it.each(['json', 'export'])('keeps authentication for JSON-MIME HTML 401 on the %s consumer', async (consumer) => {
    const { MultitableApiClient } = await modules()
    localStorage.setItem('auth_token', 'synthetic-token')
    fetchMock.mockResolvedValue(new Response('<html>blocked</html>', {
      status: 401, headers: { 'Content-Type': 'application/json' },
    }))
    const client = new MultitableApiClient()
    const result = consumer === 'export'
      ? client.exportSheet({ sheetId: 'sheet-synthetic', format: 'xlsx' })
      : client.deleteRecord('record-synthetic')
    await expect(result).rejects.toMatchObject({ code: 'GATEWAY_INTERFERENCE', status: 401 })
    expect(localStorage.getItem('auth_token')).toBe('synthetic-token')
    expect(replace).not.toHaveBeenCalled()
  })

  it.each(['json', 'export'])('treats JSON null as valid JSON and retains ordinary 401 auth behavior on %s', async (consumer) => {
    const { MultitableApiClient } = await modules()
    localStorage.setItem('auth_token', 'synthetic-token')
    fetchMock.mockResolvedValue(jsonResponse(null, 401))
    const client = new MultitableApiClient()
    const result = consumer === 'export'
      ? client.exportSheet({ sheetId: 'sheet-synthetic', format: 'xlsx' })
      : client.deleteRecord('record-synthetic')
    await expect(result).rejects.toMatchObject({ name: 'MultitableApiError', status: 401, code: undefined })
    expect(localStorage.getItem('auth_token')).toBeNull()
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('does not consume or clone an unbounded stream or binary export to diagnose it', async () => {
    const { apiFetch, apiPost, MultitableApiClient } = await modules()
    const streamResponse = new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } })
    const streamClone = vi.spyOn(streamResponse, 'clone')
    const streamText = vi.spyOn(streamResponse, 'text')
    fetchMock.mockResolvedValueOnce(streamResponse)
    expect(await apiFetch('/api/events')).toBe(streamResponse)
    expect(streamResponse.bodyUsed).toBe(false)
    expect(streamClone).not.toHaveBeenCalled()
    expect(streamText).not.toHaveBeenCalled()
    void streamResponse.body?.cancel()
    const binary = new Response('binary\u0000payload', {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1000000000' },
    })
    const clone = vi.spyOn(binary, 'clone')
    const text = vi.spyOn(binary, 'text')
    fetchMock.mockResolvedValueOnce(binary)
    const result = await new MultitableApiClient().exportSheet({ sheetId: 'sheet-synthetic', format: 'xlsx' })
    expect(result.blob.size).toBeGreaterThan(0)
    expect(clone).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(apiPost('/api/write', {})).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' })
  })

  it.each([
    [401, 'text/html', '<html>blocked</html>'],
    [403, 'text/html', '<html>blocked</html>'],
    [500, 'text/html', '<html>blocked</html>'],
    [401, 'application/json', '{"error":"blocked"}\u0000'],
    [500, 'application/json', '{"error":"blocked"}\u0000'],
  ])('diagnoses export failure %s (%s) without logging out or marking the origin healthy', async (status, contentType, body) => {
    const { apiPost, MultitableApiClient } = await modules()
    localStorage.setItem('auth_token', 'synthetic-token')
    const response = new Response(body, { status, headers: { 'Content-Type': contentType, 'X-Request-ID': requestId } })
    const clone = vi.spyOn(response, 'clone')
    const blob = vi.spyOn(response, 'blob')
    fetchMock.mockResolvedValueOnce(response)
    await expect(new MultitableApiClient().exportSheet({ sheetId: 'sheet-synthetic', format: 'xlsx' })).rejects.toMatchObject({
      code: 'GATEWAY_INTERFERENCE', status, requestId,
    })
    expect(clone).not.toHaveBeenCalled()
    expect(blob).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(localStorage.getItem('auth_token')).toBe('synthetic-token')
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(apiPost('/api/write', {})).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' })
  })

  it.each([
    [401, 'UNAUTHENTICATED', '/login?redirect=%2Fmultitable'],
    [403, 'PASSWORD_CHANGE_REQUIRED', '/force-password-change'],
    [500, 'BUSINESS_FAILURE', null],
  ])('preserves export JSON typed error %s, its message and its auth behavior', async (status, code, redirect) => {
    const { MultitableApiClient } = await modules()
    localStorage.setItem('auth_token', 'synthetic-token')
    const response = jsonResponse({ error: { code, message: 'Synthetic export refusal' } }, status)
    const clone = vi.spyOn(response, 'clone')
    fetchMock.mockResolvedValueOnce(response)
    await expect(new MultitableApiClient().exportSheet({ sheetId: 'sheet-synthetic', format: 'xlsx' })).rejects.toMatchObject({
      name: 'MultitableApiError', status, code, message: 'Synthetic export refusal',
    })
    expect(clone).not.toHaveBeenCalled()
    if (redirect) expect(replace).toHaveBeenCalledWith(redirect)
    else expect(replace).not.toHaveBeenCalled()
    expect(localStorage.getItem('auth_token')).toBe(status === 401 ? null : 'synthetic-token')
  })
})

describe('session-local healthy GET signal and final transport outcomes', () => {
  it.each(['en', 'zh-CN'])('diagnoses a no-response write only after a successful same-origin GET (%s)', async (locale) => {
    localStorage.setItem('metasheet_locale', locale)
    const { apiGet, apiPost } = await modules()
    fetchMock.mockResolvedValueOnce(jsonResponse()).mockRejectedValue(new TypeError('Failed to fetch PRIVATE'))
    await apiGet('/api/health')
    const error = await apiPost('/api/write', {}).catch((failure) => failure)
    expect(error).toMatchObject({ code: 'GATEWAY_INTERFERENCE', status: 0, timestamp: now.toISOString(), requestIdSource: 'request' })
    expect(error.message).toContain(locale === 'zh-CN' ? '网络安全设备' : 'network security device')
    expect(error.message).not.toContain('PRIVATE')
    expect(error.requestId).toBe((fetchMock.mock.calls[1][1].headers as Headers).get('x-request-id'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['absent', 'expired', 'different-origin', 'offline', 'post-only', 'failed-get', 'html-get', 'previous-session'])('does not misclassify transport failures when health is %s', async (scenario) => {
    let api = await modules()
    fetchMock.mockResolvedValueOnce(scenario === 'failed-get'
      ? jsonResponse({ error: { code: 'FAILURE' } }, 500)
      : scenario === 'html-get' ? new Response('<html>not healthy</html>') : jsonResponse())
    if (scenario !== 'absent') {
      if (scenario === 'post-only') await api.apiPost('/api/health', {})
      else await api.apiGet('/api/health').catch(() => {})
    }
    if (scenario === 'expired') vi.setSystemTime(now.getTime() + api.GATEWAY_HEALTH_WINDOW_MS + 1)
    if (scenario === 'different-origin') vi.stubEnv('VITE_API_BASE', 'https://other-api.example')
    if (scenario === 'offline') vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    if (scenario === 'previous-session') {
      vi.resetModules()
      api = await modules()
    }
    fetchMock.mockReset().mockRejectedValue(new TypeError('Failed to fetch'))
    const client = new api.MultitableApiClient()
    await expect(client.createRecord({ sheetId: 'sheet-synthetic', data: {} })).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE', status: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not treat aborted requests or response-carrying exceptions as interference', async () => {
    const { apiGet, apiPost, gatewayRequest, gatewayTransportError } = await modules()
    fetchMock.mockResolvedValueOnce(jsonResponse())
    await apiGet('/api/health')
    const aborted = new DOMException('Cancelled', 'AbortError')
    fetchMock.mockRejectedValue(aborted)
    await expect(apiPost('/api/write', {})).rejects.toBe(aborted)
    const request = gatewayRequest('/api/write', { method: 'POST' })
    const responseError = Object.assign(new TypeError('Synthetic'), { status: 500 })
    expect(gatewayTransportError(responseError, request)).toBe(responseError)
    const controller = new AbortController()
    controller.abort()
    const transport = new TypeError('Failed to fetch')
    expect(gatewayTransportError(transport, request, controller.signal)).toBe(transport)
  })

  it('keeps existing GET retry counts and diagnoses only after final failure', async () => {
    const { apiGet } = await modules()
    fetchMock.mockResolvedValueOnce(jsonResponse())
    await apiGet('/api/health')
    fetchMock.mockReset().mockRejectedValue(new TypeError('Failed to fetch'))
    const settled = apiGet('/api/read').catch((error) => error)
    await vi.runAllTimersAsync()
    expect(await settled).toMatchObject({ code: 'GATEWAY_INTERFERENCE', status: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(['success', 'html', 'network', 'unconfirmed', 'json'])('finishes DELETE to POST fallback before reporting its %s result', async (outcome) => {
    const { apiGet, MultitableApiClient } = await modules()
    fetchMock.mockResolvedValueOnce(jsonResponse())
    await apiGet('/api/health')
    fetchMock.mockReset().mockRejectedValueOnce(new TypeError('Native DELETE reset'))
    if (outcome === 'network') fetchMock.mockRejectedValueOnce(new TypeError('POST reset'))
    else if (outcome === 'html') fetchMock.mockResolvedValueOnce(new Response('blocked', { status: 500 }))
    else if (outcome === 'json') fetchMock.mockResolvedValueOnce(jsonResponse({ error: { code: 'FORBIDDEN', message: 'Synthetic denial' } }, 403))
    else fetchMock.mockResolvedValueOnce(jsonResponse({ data: { deleted: 'record-synthetic' } }, 200,
      outcome === 'success' ? { 'X-Method-Overridden': 'DELETE' } : {}))
    const result = await new MultitableApiClient().deleteRecord('record-synthetic').catch((error) => error)
    if (outcome === 'success') expect(result).toEqual({ deleted: 'record-synthetic' })
    else expect(result.code).toBe(outcome === 'unconfirmed' ? 'DELETE_TRANSPORT_UNCONFIRMED'
      : outcome === 'json' ? 'FORBIDDEN' : 'GATEWAY_INTERFERENCE')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map((call) => call[1].method)).toEqual(['DELETE', 'POST'])
    expect(fetchMock.mock.calls[1][1].headers.get('X-HTTP-Method-Override')).toBe('DELETE')
    expect(fetchMock.mock.calls[1][1].headers.get('x-request-id')).toBe(fetchMock.mock.calls[0][1].headers.get('x-request-id'))
  })
})

describe('request-ID and origin boundaries', () => {
  it('selects only the immutable factory message, not forged or mutated error fields', async () => {
    const { createGatewayInterferenceError, safeGatewayDiagnosticMessage } = await modules()
    const genuine = createGatewayInterferenceError(500, requestId, true, 'request')
    const safeMessage = genuine.message
    const forged = Object.assign(new Error('PRIVATE-SERVER-VALUE'), {
      name: genuine.name, code: genuine.code, status: genuine.status,
      timestamp: genuine.timestamp, localTime: genuine.localTime, requestId: genuine.requestId,
    })
    expect(safeGatewayDiagnosticMessage(genuine)).toBe(safeMessage)
    for (const value of [forged, { ...genuine, message: 'PRIVATE-SERVER-VALUE' }, JSON.parse(JSON.stringify(genuine)), null, undefined, safeMessage]) {
      expect(safeGatewayDiagnosticMessage(value)).toBeUndefined()
    }
    Object.defineProperty(forged, 'message', { get: () => { throw new Error('must not read untrusted message') } })
    expect(safeGatewayDiagnosticMessage(forged)).toBeUndefined()
    genuine.message = 'PRIVATE-MUTATED-MESSAGE'
    genuine.requestId = 'PRIVATE-MUTATED-ID'
    expect(safeGatewayDiagnosticMessage(genuine)).toBe(safeMessage)
    expect(safeGatewayDiagnosticMessage(genuine)).not.toContain('PRIVATE')
  })

  it.each(['https://host/?token=secret', 'Bearer SECRET', 'eyJhbGci.eyJzZWNyZXQ.signature', '{"secret":"value"}', 'a'.repeat(129), 'line\nbreak'])('rejects unsafe diagnostic IDs: %s', async (unsafeId) => {
    const { safeGatewayRequestId, gatewayRequest, gatewayTransportError, apiGet } = await modules()
    expect(safeGatewayRequestId(unsafeId)).toBeUndefined()
    fetchMock.mockResolvedValueOnce(jsonResponse())
    await apiGet('/api/health')
    const headers = new Headers()
    if (!unsafeId.includes('\n')) headers.set('x-request-id', unsafeId)
    const request = gatewayRequest('/api/write?token=secret', { method: 'POST' }, headers)
    const error = gatewayTransportError(new TypeError('Failed to fetch'), request) as Error & { requestId: string }
    expect(safeGatewayRequestId(error.requestId)).toBe(error.requestId)
    expect(error.message).not.toContain(unsafeId)
    expect(error.message).not.toContain('/api/write')
  })

  it('reuses safe response IDs, discards unsafe response IDs, and honors request header omission', async () => {
    const { apiFetch, readGatewayJson, safeGatewayRequestId } = await modules()
    fetchMock.mockResolvedValue(new Response('blocked', {
      status: 500, headers: { 'Content-Type': 'text/html', 'X-Request-ID': 'Bearer secret' },
    }))
    const response = await apiFetch('/api/test', { expectJson: true, omitHeaders: ['X-Request-ID'] })
    expect(fetchMock.mock.calls[0][1].headers.has('x-request-id')).toBe(false)
    const error = await readGatewayJson(response).catch((failure) => failure)
    expect(safeGatewayRequestId(error.requestId)).toBe(error.requestId)
    expect(error.message).not.toContain('Bearer secret')
    expect(error.requestIdSource).toBe('local')
    expect(error.message).toContain('Local diagnostic ID')
  })

  it('never adds a generated header to cross-origin API or non-API requests', async () => {
    const { apiFetch } = await modules()
    vi.stubEnv('VITE_API_BASE', 'https://other-api.example')
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse()))
    await apiFetch('/api/test', { expectJson: true })
    expect(fetchMock.mock.calls[0][1].headers.has('x-request-id')).toBe(false)
    vi.stubEnv('VITE_API_BASE', '')
    await apiFetch('/assets/file', { expectJson: true })
    expect(fetchMock.mock.calls[1][1].headers.has('x-request-id')).toBe(false)
  })
})
