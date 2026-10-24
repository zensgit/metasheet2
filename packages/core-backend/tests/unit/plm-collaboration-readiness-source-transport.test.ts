import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import {
  READINESS_COLLABORATION_COVERAGE_STATUS,
  READINESS_COLLABORATION_FEATURE_KEY,
  READINESS_COLLABORATION_PROJECTION_CONTRACT,
} from '../../src/multitable/plm-collaboration-readiness-wire'
import {
  readSharedTransportAudit,
  resetSharedTransportAudit,
  setManagedBindingReaderForTests,
} from '../../src/services/plm-managed-companion'

const SECRET = 'w23-readiness-body-secret'
const SNAPSHOT = '2026-10-24T01:02:03.000000Z'
const GENERATED = '2026-10-24T01:02:04.000000Z'
const nativeFetch = globalThis.fetch.bind(globalThis)
const servers: Server[] = []

function useRealFetch() {
  vi.stubGlobal('fetch', (resource: RequestInfo | URL, init?: RequestInit) => nativeFetch(resource, init))
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  setManagedBindingReaderForTests(null)
  resetSharedTransportAudit()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function adapter(): PLMAdapter {
  const created = new PLMAdapter(
    { get: async () => undefined } as never,
    { info() {}, warn() {}, error() {}, debug() {} } as never,
    {
      id: 'source-a',
      name: 'Adapter A',
      type: 'plm',
      connection: {
        url: 'http://127.0.0.1:9/adapter-a',
        headers: {
          'x-tenant-id': 'tenant-a',
          'x-org-id': 'org-a',
          Authorization: 'Bearer adapter-a-token',
        },
      },
      options: { apiMode: 'yuantus', tenantId: 'tenant-a', orgId: 'org-a' },
      credentials: { token: 'adapter-a-token', username: 'adapter-a-user', password: 'adapter-a-password' },
    },
  )
  const client = { request: vi.fn(), get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }
  const poisoned = created as unknown as {
    client: typeof client
    authToken: string
    yuantusCredentials: { username: string; password: string; tenantId: string; orgId: string }
  }
  poisoned.client = client
  poisoned.authToken = 'adapter-a-cached-token'
  poisoned.yuantusCredentials = {
    username: 'adapter-a-user', password: 'adapter-a-password', tenantId: 'tenant-a', orgId: 'org-a',
  }
  return created
}

function input(overrides: Record<string, unknown> = {}) {
  return { itemId: 'item-root', rulesetId: 'ruleset-1', currentVersionId: null, ...overrides }
}

function sourceConfig(url: string, overrides: Record<string, unknown> = {}): DataSourceConfig {
  return {
    id: 'source-b',
    name: 'Source B',
    type: 'plm',
    connection: {
      url,
      headers: {
        'x-tenant-id': 'tenant-w23',
        'x-org-id': 'org-w23',
        Authorization: 'Bearer wrong-header-token',
        'X-API-Key': 'adapter-a-key',
      },
    },
    options: { apiMode: 'yuantus', tenantId: 'tenant-w23', orgId: 'org-w23' },
    credentials: { token: 'token-b' },
    ...overrides,
  } as DataSourceConfig
}

function dto(version: string | null, itemId = 'item-root', rulesetId = 'ruleset-1') {
  return {
    projection_contract: READINESS_COLLABORATION_PROJECTION_CONTRACT,
    feature_key: READINESS_COLLABORATION_FEATURE_KEY,
    entitled: true,
    source: { tenant_id: 'tenant-w23', org_id: 'org-w23', item_id: itemId, current_version_id: version },
    snapshot_at: SNAPSHOT,
    readiness: {
      item_id: itemId,
      ruleset_id: rulesetId,
      generated_at: GENERATED,
      coverage_status: READINESS_COLLABORATION_COVERAGE_STATUS,
      summary: { resources: 1, ok_resources: 1, error_count: 0, warning_count: 0 },
      resources: [{
        kind: 'mbom_release',
        name: null,
        state: null,
        resource_type: 'mbom',
        resource_id: 'mbom-1',
        errors: [],
        warnings: [],
      }],
    },
  }
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string }> {
  const server = createServer(handler)
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ url: `http://127.0.0.1:${port}` })
    })
  })
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function blockFetch() {
  const fetchSpy = vi.fn(async () => {
    throw new Error('egress')
  })
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

it.each([undefined, '', 'false', 'true', 'arbitrary'] as const)(
  'refuses managed source B before egress when the flag is %s',
  async (flag) => {
    if (flag === undefined) delete process.env.PLM_MANAGED_COMPANION_ENABLED
    else vi.stubEnv('PLM_MANAGED_COMPANION_ENABLED', flag)
    const seen: string[] = []
    setManagedBindingReaderForTests(async (id) => {
      seen.push(id)
      return { kind: 'bound', row: { binding_status: 'active' } as never }
    })
    const fetchSpy = blockFetch()
    await expect(adapter().getReadinessCollaborationSource(input(), sourceConfig('http://127.0.0.1:9'))).rejects.toMatchObject({
      status: 403, code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED',
    })
    expect(seen).toEqual(['source-b'])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readSharedTransportAudit().calls).toBe(0)
  },
)

it.each([
  ['disabled', { kind: 'bound', row: { binding_status: 'disabled' } }, 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED'],
  ['stale', { kind: 'bound', row: { link_status: 'stale' } }, 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED'],
  ['schema-missing', { kind: 'schema-missing' }, 'PLM_MANAGED_SCHEMA_MISSING'],
  ['unavailable', { kind: 'unavailable' }, 'PLM_MANAGED_BINDING_UNAVAILABLE'],
] as const)('refuses %s for source B with flag false and true', async (_label, classified, code) => {
  for (const flag of ['false', 'true']) {
    vi.stubEnv('PLM_MANAGED_COMPANION_ENABLED', flag)
    const seen: string[] = []
    setManagedBindingReaderForTests(async (id) => {
      seen.push(id)
      return classified as never
    })
    const fetchSpy = blockFetch()
    await expect(adapter().getReadinessCollaborationSource(input(), sourceConfig('http://127.0.0.1:9'))).rejects.toMatchObject({
      status: 403, code,
    })
    expect(seen).toEqual(['source-b'])
    expect(fetchSpy).not.toHaveBeenCalled()
  }
})

it('reads unbound source B when adapter A is managed', async () => {
  useRealFetch()
  const seen: string[] = []
  const recorded: Array<Record<string, unknown>> = []
  let evilHits = 0
  const origin = await listen(async (req, res) => {
    recorded.push({
      method: req.method,
      url: req.url,
      body: await read(req),
      authorization: req.headers.authorization,
      tenant: req.headers['x-tenant-id'],
      org: req.headers['x-org-id'],
      apiKey: req.headers['x-api-key'],
    })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(dto(null)))
  })
  const evil = await listen((_req, res) => {
    evilHits += 1
    res.end('evil')
  })
  const sourceB = sourceConfig(origin.url)
  setManagedBindingReaderForTests(async (id) => {
    seen.push(id)
    sourceB.connection.url = evil.url
    sourceB.id = 'source-a'
    sourceB.credentials = { token: 'mutated-token' }
    return id === 'source-a'
      ? { kind: 'bound', row: {} as never }
      : { kind: 'unbound' }
  })
  const delays: number[] = []
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    delays.push(ms)
    return timeout(ms)
  })
  const created = adapter()
  const result = await created.getReadinessCollaborationSource(input(), sourceB)
  expect(result.readiness.ruleset_id).toBe('ruleset-1')
  expect(result.readiness.coverage_status).toBe('bounded_not_proven_complete')
  expect(result.readiness.resources[0]?.resource_id).toBe('mbom-1')
  expect(result.source).toEqual({
    tenant_id: 'tenant-w23', org_id: 'org-w23', item_id: 'item-root', current_version_id: null,
  })
  expect(recorded).toEqual([{
    method: 'POST',
    url: '/api/v1/plm/collaboration-sources/items/item-root/release-readiness',
    body: '{"ruleset_id":"ruleset-1","current_version_id":null}',
    authorization: 'Bearer token-b',
    tenant: 'tenant-w23',
    org: 'org-w23',
    apiKey: undefined,
  }])
  expect(seen).toEqual(['source-b', 'source-b', 'source-b'])
  expect(evilHits).toBe(0)
  expect(delays).toEqual([8000])
  expect(readSharedTransportAudit().calls).toBe(0)
  expect((created as unknown as { client: { post: ReturnType<typeof vi.fn> } }).client.post).not.toHaveBeenCalled()
})

it('posts the exact nullable body for an encoded item and does not retarget after login', async () => {
  const seen: string[] = []
  const recorded: Array<Record<string, unknown>> = []
  const origin = await listen(async (req, res) => {
    const body = await read(req)
    recorded.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/v1/auth/login') {
      res.end(JSON.stringify({ access_token: 'login-token-b' }))
      return
    }
    res.end(JSON.stringify(dto('ver-root', 'item/root', 'ruleset/1')))
  })
  const evil = await listen(() => {
    throw new Error('retargeted request reached the other server')
  })
  const sourceB = sourceConfig(origin.url, {
    credentials: { token: '', username: 'native-user', password: 'native-password' },
  })
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const response = await nativeFetch(resource, init)
    sourceB.connection.url = `${evil.url}/retarget`
    sourceB.id = 'source-a'
    sourceB.credentials = { token: 'mutated-token', username: 'mutated-user', password: 'mutated-password' }
    return response
  })
  setManagedBindingReaderForTests(async (id) => {
    seen.push(id)
    sourceB.connection.url = `${evil.url}/during-admission`
    return id === 'source-b' ? { kind: 'unbound' } : { kind: 'bound', row: {} as never }
  })
  const result = await adapter().getReadinessCollaborationSource(input({
    itemId: 'item/root', rulesetId: 'ruleset/1', currentVersionId: 'ver-root',
  }), sourceB)
  expect(result.source.current_version_id).toBe('ver-root')
  expect(result.readiness.item_id).toBe('item/root')
  expect(result.readiness.ruleset_id).toBe('ruleset/1')
  expect(recorded.map((call) => call.url)).toEqual([
    '/api/v1/auth/login',
    '/api/v1/plm/collaboration-sources/items/item%2Froot/release-readiness',
  ])
  expect(recorded[0]?.body).toBe('{"username":"native-user","password":"native-password","tenant_id":"tenant-w23","org_id":"org-w23"}')
  expect(recorded[1]?.body).toBe('{"ruleset_id":"ruleset/1","current_version_id":"ver-root"}')
  expect(recorded[1]?.authorization).toBe('Bearer login-token-b')
  expect(JSON.stringify(recorded)).not.toContain('adapter-a')
  expect(JSON.stringify(recorded)).not.toContain('mutated-password')
  expect(seen).toEqual(['source-b', 'source-b', 'source-b', 'source-b', 'source-b'])
})

it.each([
  ['missing id', { id: '' }],
  ['blank id', { id: ' source-b' }],
  ['missing credentials', { credentials: undefined }],
  ['ambiguous tenant', { connection: { url: 'http://127.0.0.1:9', headers: { 'x-tenant-id': 'tenant-w23', 'X-Tenant-Id': 'tenant-other', 'x-org-id': 'org-w23' } } }],
  ['conflicting option', { options: { apiMode: 'yuantus', tenantId: 'tenant-other', orgId: 'org-w23' } }],
  ['userinfo', { connection: { url: 'https://user:pass@127.0.0.1/native' } }],
  ['query', { connection: { url: 'http://127.0.0.1:9/native?token=adapter-a-token' } }],
  ['hash', { connection: { url: 'http://127.0.0.1:9/native#adapter-a-password' } }],
  ['external http', { connection: { url: 'http://example.com/native' } }],
  ['base mismatch', { connection: { url: 'http://127.0.0.1:9/a', baseURL: 'http://127.0.0.1:9/b', headers: { 'x-tenant-id': 'tenant-w23', 'x-org-id': 'org-w23' } } }],
  ['extra input', null],
] as const)('rejects %s with no egress and no adapter A credential', async (label, overrides) => {
  const seen: string[] = []
  setManagedBindingReaderForTests(async (id) => {
    seen.push(id)
    return { kind: 'unbound' }
  })
  const fetchSpy = blockFetch()
  const config = sourceConfig('http://127.0.0.1:9', overrides === null ? {} : overrides as Record<string, unknown>)
  const request = label === 'extra input' ? { ...input(), ecoId: 'eco-1' } : input()
  await expect(adapter().getReadinessCollaborationSource(request, config)).rejects.toThrow()
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(seen).not.toContain('source-a')
  const error = await adapter().getReadinessCollaborationSource(request, config).then(() => null, (caught) => caught as Error)
  expect(String(error.message)).not.toContain('adapter-a-password')
  expect(String(error.message)).not.toContain('adapter-a-token')
  if (label === 'extra input') expect(error).toMatchObject({ status: 422, code: 'READINESS_SOURCE_INPUT_INVALID' })
  if (label === 'ambiguous tenant' || label === 'conflicting option') {
    expect(error).toMatchObject({ status: 403, code: 'READINESS_SOURCE_SCOPE_AMBIGUOUS' })
  }
})

it('rejects loopback http outside test with no egress', async () => {
  setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
  vi.stubEnv('NODE_ENV', 'production')
  const fetchSpy = blockFetch()
  await expect(adapter().getReadinessCollaborationSource(input(), sourceConfig('http://127.0.0.1:9'))).rejects.toMatchObject({
    code: 'READINESS_SOURCE_URL_REJECTED',
  })
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('rejects a malformed token and a non-string token without a login fallback', async () => {
  const fetchSpy = blockFetch()
  setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
  await expect(adapter().getReadinessCollaborationSource(input(), sourceConfig('http://127.0.0.1:9', {
    credentials: { token: 'bad\ntoken', username: 'native-user', password: 'native-password' },
  }))).rejects.toMatchObject({ code: 'READINESS_SOURCE_TOKEN_REJECTED' })
  await expect(adapter().getReadinessCollaborationSource(input(), sourceConfig('http://127.0.0.1:9', {
    credentials: { token: 15, username: 'native-user', password: 'native-password' },
  }))).rejects.toMatchObject({ code: 'READINESS_SOURCE_TOKEN_REJECTED' })
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('does not follow a redirect, time out into a sanitized error, or send a second identity after a rejected token', async () => {
  useRealFetch()
  let evilHits = 0
  const evil = await listen((_req, res) => {
    evilHits += 1
    res.end(SECRET)
  })
  const redirected: string[] = []
  const redirectOrigin = await listen((req, res) => {
    redirected.push(req.url || '')
    res.statusCode = 302
    res.setHeader('Location', `${evil.url}/stolen-${SECRET}`)
    res.end('redirect')
  })
  setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
  const redirectError = await adapter().getReadinessCollaborationSource(input(), sourceConfig(redirectOrigin.url)).then(
    () => null,
    (error) => error as Error,
  )
  expect(redirectError).toMatchObject({ code: 'READINESS_SOURCE_UNAVAILABLE', message: 'READINESS_SOURCE_UNAVAILABLE' })
  expect(JSON.stringify(redirectError)).not.toContain(SECRET)
  expect(evilHits).toBe(0)
  expect(redirected).toEqual(['/api/v1/plm/collaboration-sources/items/item-root/release-readiness'])

  const delays: number[] = []
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    delays.push(ms)
    return timeout(20)
  })
  const hung = await listen(() => {
    // Leave the response open until the captured signal aborts it.
  })
  const timeoutError = await adapter().getReadinessCollaborationSource(input(), sourceConfig(hung.url)).then(
    () => null,
    (error) => error as Error,
  )
  expect(timeoutError).toMatchObject({ code: 'READINESS_SOURCE_UNAVAILABLE', message: 'READINESS_SOURCE_UNAVAILABLE' })
  expect(delays).toEqual([8000])
  expect(JSON.stringify(timeoutError)).not.toContain(SECRET)
  expect(JSON.stringify(timeoutError)).not.toContain('token-b')

  for (const status of [401, 403]) {
    const denied: string[] = []
    const denyOrigin = await listen(async (req, res) => {
      denied.push(req.url || '')
      await read(req)
      res.statusCode = status
      res.end(SECRET)
    })
    const deniedError = await adapter().getReadinessCollaborationSource(input(), sourceConfig(denyOrigin.url, {
      credentials: { token: 'token-b', username: 'native-user', password: 'native-password' },
    })).then(() => null, (error) => error as Error)
    expect(deniedError).toMatchObject({ status: 401, code: 'READINESS_SOURCE_TOKEN_REJECTED', message: 'READINESS_SOURCE_TOKEN_REJECTED' })
    expect(denied).toEqual(['/api/v1/plm/collaboration-sources/items/item-root/release-readiness'])
    expect(JSON.stringify(deniedError)).not.toContain(SECRET)
    expect(JSON.stringify(deniedError)).not.toContain('native-password')
  }
})

it.each([
  ['malformed', (body: ReturnType<typeof dto>) => ({ ...body, properties: { publish: SECRET } }), 502, 'READINESS_SOURCE_REJECTED'],
  ['foreign tenant', (body: ReturnType<typeof dto>) => ({ ...body, source: { ...body.source, tenant_id: 'tenant-other' } }), 409, 'READINESS_SOURCE_ANCHOR_MISMATCH'],
  ['foreign version', (body: ReturnType<typeof dto>) => ({
    ...body,
    source: { ...body.source, current_version_id: 'ver-other' },
  }), 409, 'READINESS_SOURCE_ANCHOR_MISMATCH'],
  ['foreign ruleset', (body: ReturnType<typeof dto>) => ({
    ...body,
    readiness: { ...body.readiness, ruleset_id: 'ruleset-other' },
  }), 409, 'READINESS_SOURCE_ANCHOR_MISMATCH'],
  ['global ready', (body: ReturnType<typeof dto>) => ({
    ...body,
    readiness: { ...body.readiness, coverage_status: 'all_ready', resources: [{
      ...body.readiness.resources[0],
      name: SECRET,
    }] },
  }), 502, 'READINESS_SOURCE_REJECTED'],
] as const)('denies a %s body without returning a snapshot', async (_label, mutate, status, code) => {
  useRealFetch()
  const origin = await listen(async (req, res) => {
    await read(req)
    res.setHeader('content-type', 'application/json')
    const body = mutate(dto('ver-root'))
    if (body.readiness.resources[0]) body.readiness.resources[0].name = SECRET
    res.end(JSON.stringify(body))
  })
  setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
  const error = await adapter().getReadinessCollaborationSource(input({ currentVersionId: 'ver-root' }), sourceConfig(origin.url)).then(
    () => null,
    (caught) => caught as Error,
  )
  expect(error).toMatchObject({ status, code, message: code })
  expect(JSON.stringify(error)).not.toContain(SECRET)
})

it('refuses an unlicensed body and a transient 503 without returning a snapshot', async () => {
  useRealFetch()
  const unlicensed = await listen(async (req, res) => {
    await read(req)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      projection_contract: READINESS_COLLABORATION_PROJECTION_CONTRACT,
      feature_key: READINESS_COLLABORATION_FEATURE_KEY,
      entitled: false,
      source: null,
      snapshot_at: null,
      readiness: null,
      description: SECRET,
    }))
  })
  setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
  const unlicensedError = await adapter().getReadinessCollaborationSource(input(), sourceConfig(unlicensed.url)).then(
    () => null,
    (caught) => caught as Error,
  )
  expect(unlicensedError).toMatchObject({ status: 403, code: 'READINESS_SOURCE_UNLICENSED', message: 'READINESS_SOURCE_UNLICENSED' })
  expect(JSON.stringify(unlicensedError)).not.toContain(SECRET)

  const unavailable = await listen(async (req, res) => {
    await read(req)
    res.statusCode = 503
    res.end(JSON.stringify({ ...dto(null), description: SECRET }))
  })
  const unavailableError = await adapter().getReadinessCollaborationSource(input(), sourceConfig(unavailable.url)).then(
    () => null,
    (caught) => caught as Error,
  )
  expect(unavailableError).toMatchObject({ status: 502, code: 'READINESS_SOURCE_UNAVAILABLE', message: 'READINESS_SOURCE_UNAVAILABLE' })
  expect(JSON.stringify(unavailableError)).not.toContain(SECRET)
  expect(JSON.stringify(unavailableError)).not.toContain('mbom-1')
})

function deferredChunkedBody(phase: 'login' | 'readiness', switchToBound: boolean) {
  let bound = false
  let calls = 0
  let held: ServerResponse | undefined
  const events: string[] = []
  const requests: string[] = []
  setManagedBindingReaderForTests(async (id) => {
    calls += 1
    events.push(`admit:${calls}:${id}:${bound}`)
    if (calls === 2) {
      setImmediate(() => {
        bound = switchToBound
        events.push(`body-release:${phase}:bound=${bound}`)
        const payload = phase === 'login'
          ? JSON.stringify({ access_token: 'login-token-b' })
          : JSON.stringify(dto(null))
        held!.write(payload)
        held!.end()
      })
    }
    return bound
      ? { kind: 'bound' as const, row: { binding_status: 'active' } as never }
      : { kind: 'unbound' as const }
  })
  return {
    events,
    requests,
    calls: () => calls,
    hold(response: ServerResponse) {
      held = response
    },
  }
}

it('accepts a delayed chunked unbound login body and refuses the readiness post when that body binds source B', async () => {
  useRealFetch()
  const loginPath = '/api/v1/auth/login'
  const readinessPath = '/api/v1/plm/collaboration-sources/items/item-root/release-readiness'
  for (const switchToBound of [false, true]) {
    const control = deferredChunkedBody('login', switchToBound)
    const origin = await listen(async (req, res) => {
      control.requests.push(String(req.url))
      control.events.push(`request:${req.url}`)
      await read(req)
      if (req.url === loginPath) {
        res.writeHead(200, { 'content-type': 'application/json' })
        control.hold(res)
        res.flushHeaders()
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(dto(null)))
    })
    const result = await adapter().getReadinessCollaborationSource(input(), sourceConfig(origin.url, {
      credentials: { username: 'native-user', password: 'native-password' },
    })).then(
      (value) => ({ kind: 'accepted' as const, id: value.readiness.item_id }),
      (error: { code?: string; message?: string }) => ({
        kind: 'refused' as const,
        code: error.code,
        message: error.message,
      }),
    )
    const releaseAt = control.events.indexOf(`body-release:login:bound=${switchToBound}`)
    expect(releaseAt).toBeGreaterThan(control.events.indexOf('admit:2:source-b:false'))
    if (!switchToBound) {
      const readinessAt = control.events.indexOf(`request:${readinessPath}`)
      expect(result).toEqual({ kind: 'accepted', id: 'item-root' })
      expect(control.requests).toEqual([loginPath, readinessPath])
      expect(control.events.slice(releaseAt + 1, readinessAt)).toContain('admit:3:source-b:false')
      expect(control.calls()).toBe(5)
    } else {
      expect(result).toMatchObject({ kind: 'refused', code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
      expect(control.requests).toEqual([loginPath])
      expect(control.events.indexOf('admit:3:source-b:true')).toBeGreaterThan(releaseAt)
      expect(control.calls()).toBe(3)
      expect(JSON.stringify(result)).not.toContain('login-token-b')
      expect(JSON.stringify(result)).not.toContain('native-password')
    }
  }
})

it('accepts a delayed chunked unbound readiness body and refuses the parsed source when that body binds source B', async () => {
  useRealFetch()
  const readinessPath = '/api/v1/plm/collaboration-sources/items/item-root/release-readiness'
  for (const switchToBound of [false, true]) {
    const control = deferredChunkedBody('readiness', switchToBound)
    const origin = await listen(async (req, res) => {
      control.requests.push(String(req.url))
      control.events.push(`request:${req.url}`)
      await read(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      control.hold(res)
      res.flushHeaders()
    })
    const result = await adapter().getReadinessCollaborationSource(input(), sourceConfig(origin.url)).then(
      (value) => ({ kind: 'accepted' as const, id: value.readiness.item_id, entitled: value.entitled }),
      (error: { code?: string; message?: string }) => ({
        kind: 'refused' as const,
        code: error.code,
        message: error.message,
      }),
    )
    const releaseAt = control.events.indexOf(`body-release:readiness:bound=${switchToBound}`)
    expect(releaseAt).toBeGreaterThan(control.events.indexOf('admit:2:source-b:false'))
    expect(control.requests).toEqual([readinessPath])
    if (!switchToBound) {
      expect(result).toEqual({ kind: 'accepted', id: 'item-root', entitled: true })
      expect(control.events.indexOf('admit:3:source-b:false')).toBeGreaterThan(releaseAt)
      expect(control.calls()).toBe(3)
    } else {
      expect(result).toMatchObject({ kind: 'refused', code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
      expect(control.events.indexOf('admit:3:source-b:true')).toBeGreaterThan(releaseAt)
      expect(control.calls()).toBe(3)
      expect(JSON.stringify(result)).not.toContain('mbom-1')
      expect(JSON.stringify(result)).not.toContain(GENERATED)
    }
  }
})
