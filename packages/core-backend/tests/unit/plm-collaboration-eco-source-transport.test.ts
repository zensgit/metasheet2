import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import {
  readSharedTransportAudit,
  resetSharedTransportAudit,
  setManagedBindingReaderForTests,
} from '../../src/services/plm-managed-companion'

const SECRET = 'w23-body-secret'
const UPDATED = '2026-10-23T01:02:03.000000Z'
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
  return { itemId: 'item-root', ecoId: 'eco-scoped', currentVersionId: null, ...overrides }
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

function dto(version: string | null, itemId = 'item-root', ecoId = 'eco-scoped') {
  return {
    projection_contract: 'eco_collaboration_source.v1',
    feature_key: 'collaboration_source_read',
    entitled: true,
    source: { tenant_id: 'tenant-w23', org_id: 'org-w23', item_id: itemId, current_version_id: version },
    snapshot_at: '2026-10-23T02:03:04.000000Z',
    eco: {
      id: ecoId,
      name: 'Scoped ECO',
      eco_type: 'bom',
      product_id: itemId,
      source_version_id: null,
      target_version_id: null,
      stage_id: null,
      state: 'draft',
      kanban_state: 'normal',
      priority: 'high',
      updated_at: UPDATED,
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
    await expect(adapter().getEcoCollaborationSource(input(), sourceConfig('http://127.0.0.1:9'))).rejects.toMatchObject({
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
    await expect(adapter().getEcoCollaborationSource(input(), sourceConfig('http://127.0.0.1:9'))).rejects.toMatchObject({
      status: 403, code,
    })
    expect(seen).toEqual(['source-b'])
    expect(fetchSpy).not.toHaveBeenCalled()
  }
})

it('reads unbound source B when adapter A is managed', async () => {
  useRealFetch()
  const seen: string[] = []
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
  const recorded: Array<Record<string, unknown>> = []
  let evilHits = 0
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
  const result = await created.getEcoCollaborationSource(input(), sourceB)
  expect(result.eco.id).toBe('eco-scoped')
  expect(result.source).toEqual({
    tenant_id: 'tenant-w23', org_id: 'org-w23', item_id: 'item-root', current_version_id: null,
  })
  expect(result.snapshot_at).toBe('2026-10-23T02:03:04.000000Z')
  expect(recorded).toEqual([{
    method: 'POST',
    url: '/api/v1/plm/collaboration-sources/items/item-root/eco-context',
    body: '{"eco_id":"eco-scoped","current_version_id":null}',
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
    res.end(JSON.stringify(dto('ver-root', 'item/root', 'eco/scoped')))
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
  const result = await adapter().getEcoCollaborationSource(input({
    itemId: 'item/root', ecoId: 'eco/scoped', currentVersionId: 'ver-root',
  }), sourceB)
  expect(result.source.current_version_id).toBe('ver-root')
  expect(result.eco.id).toBe('eco/scoped')
  expect(recorded.map((call) => call.url)).toEqual([
    '/api/v1/auth/login',
    '/api/v1/plm/collaboration-sources/items/item%2Froot/eco-context',
  ])
  expect(recorded[0]?.body).toBe('{"username":"native-user","password":"native-password","tenant_id":"tenant-w23","org_id":"org-w23"}')
  expect(recorded[1]?.body).toBe('{"eco_id":"eco/scoped","current_version_id":"ver-root"}')
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
  ['userinfo', { connection: { url: 'https://user:pass@127.0.0.1/native' } }],
  ['query', { connection: { url: 'http://127.0.0.1:9/native?token=adapter-a-token' } }],
  ['hash', { connection: { url: 'http://127.0.0.1:9/native#adapter-a-password' } }],
  ['external http', { connection: { url: 'http://example.com/native' } }],
  ['base mismatch', { connection: { url: 'http://127.0.0.1:9/a', baseURL: 'http://127.0.0.1:9/b', headers: { 'x-tenant-id': 'tenant-w23', 'x-org-id': 'org-w23' } } }],
] as const)('rejects %s with no egress and no adapter A credential', async (_label, overrides) => {
  const seen: string[] = []
  setManagedBindingReaderForTests(async (id) => {
    seen.push(id)
    return { kind: 'unbound' }
  })
  const fetchSpy = blockFetch()
  const config = sourceConfig('http://127.0.0.1:9', overrides as Record<string, unknown>)
  await expect(adapter().getEcoCollaborationSource(input(), config)).rejects.toThrow()
  expect(fetchSpy).not.toHaveBeenCalled()
  expect(seen).not.toContain('source-a')
  const error = await adapter().getEcoCollaborationSource(input(), config).then(() => null, (caught) => caught as Error)
  expect(String(error.message)).not.toContain('adapter-a-password')
  expect(String(error.message)).not.toContain('adapter-a-token')
})

it('rejects loopback http outside test with no egress', async () => {
  setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
  vi.stubEnv('NODE_ENV', 'production')
  const fetchSpy = blockFetch()
  await expect(adapter().getEcoCollaborationSource(input(), sourceConfig('http://127.0.0.1:9'))).rejects.toMatchObject({
    code: 'ECO_SOURCE_URL_REJECTED',
  })
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('stops before the ECO post when login returns and source B is then managed', async () => {
  useRealFetch()
  const seen: string[] = []
  const recorded: string[] = []
  const origin = await listen(async (req, res) => {
    recorded.push(`${req.method} ${req.url}`)
    await read(req)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ access_token: 'login-token-b' }))
  })
  setManagedBindingReaderForTests(async (id) => {
    seen.push(id)
    return seen.length >= 2
      ? { kind: 'bound', row: { binding_status: 'disabled' } as never }
      : { kind: 'unbound' }
  })
  await expect(adapter().getEcoCollaborationSource(input(), sourceConfig(origin.url, {
    credentials: { username: 'native-user', password: 'native-password' },
  }))).rejects.toMatchObject({ code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
  expect(recorded).toEqual(['POST /api/v1/auth/login'])
  expect(seen).toEqual(['source-b', 'source-b'])
})

it('discards a valid response when source B becomes managed before acceptance', async () => {
  useRealFetch()
  const seen: string[] = []
  let posts = 0
  const origin = await listen(async (req, res) => {
    posts += 1
    await read(req)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(dto(null)))
  })
  setManagedBindingReaderForTests(async (id) => {
    seen.push(id)
    return seen.length >= 2
      ? { kind: 'bound', row: { link_status: 'stale' } as never }
      : { kind: 'unbound' }
  })
  await expect(adapter().getEcoCollaborationSource(input(), sourceConfig(origin.url))).rejects.toMatchObject({
    code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED',
  })
  expect(posts).toBe(1)
  expect(seen).toEqual(['source-b', 'source-b'])
})

it('does not follow a redirect or send a second identity after a rejected token', async () => {
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
  const redirectError = await adapter().getEcoCollaborationSource(input(), sourceConfig(redirectOrigin.url)).then(
    () => null,
    (error) => error as Error,
  )
  expect(redirectError).toMatchObject({ code: 'ECO_SOURCE_UNAVAILABLE', message: 'ECO_SOURCE_UNAVAILABLE' })
  expect(JSON.stringify(redirectError)).not.toContain(SECRET)
  expect(evilHits).toBe(0)
  expect(redirected).toEqual(['/api/v1/plm/collaboration-sources/items/item-root/eco-context'])

  const denied: string[] = []
  const denyOrigin = await listen(async (req, res) => {
    denied.push(req.url || '')
    await read(req)
    res.statusCode = 401
    res.end(SECRET)
  })
  const deniedError = await adapter().getEcoCollaborationSource(input(), sourceConfig(denyOrigin.url, {
    credentials: { token: 'token-b', username: 'native-user', password: 'native-password' },
  })).then(() => null, (error) => error as Error)
  expect(deniedError).toMatchObject({ code: 'ECO_SOURCE_TOKEN_REJECTED', message: 'ECO_SOURCE_TOKEN_REJECTED' })
  expect(denied).toEqual(['/api/v1/plm/collaboration-sources/items/item-root/eco-context'])
  expect(JSON.stringify(deniedError)).not.toContain(SECRET)
  expect(JSON.stringify(deniedError)).not.toContain('native-password')
})

it('rejects a malformed token and a non-string token without a login fallback', async () => {
  const fetchSpy = blockFetch()
  setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
  await expect(adapter().getEcoCollaborationSource(input(), sourceConfig('http://127.0.0.1:9', {
    credentials: { token: 'bad\ntoken', username: 'native-user', password: 'native-password' },
  }))).rejects.toMatchObject({ code: 'ECO_SOURCE_TOKEN_REJECTED' })
  await expect(adapter().getEcoCollaborationSource(input(), sourceConfig('http://127.0.0.1:9', {
    credentials: { token: 15, username: 'native-user', password: 'native-password' },
  }))).rejects.toMatchObject({ code: 'ECO_SOURCE_TOKEN_REJECTED' })
  expect(fetchSpy).not.toHaveBeenCalled()
})

it('refuses an unlicensed body without returning a snapshot', async () => {
  useRealFetch()
  const origin = await listen(async (req, res) => {
    await read(req)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      projection_contract: 'eco_collaboration_source.v1',
      feature_key: 'collaboration_source_read',
      entitled: false,
      source: null,
      snapshot_at: null,
      eco: null,
      description: SECRET,
    }))
  })
  setManagedBindingReaderForTests(async () => ({ kind: 'unbound' }))
  const error = await adapter().getEcoCollaborationSource(input(), sourceConfig(origin.url)).then(
    () => null,
    (caught) => caught as Error,
  )
  expect(error).toMatchObject({ code: 'ECO_SOURCE_UNLICENSED', message: 'ECO_SOURCE_UNLICENSED' })
  expect(JSON.stringify(error)).not.toContain(SECRET)
})

function deferredChunkedBody(phase: 'login' | 'eco', switchToBound: boolean) {
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

it('accepts a delayed chunked unbound login body and refuses the ECO post when that body binds source B', async () => {
  useRealFetch()
  const loginPath = '/api/v1/auth/login'
  const ecoPath = '/api/v1/plm/collaboration-sources/items/item-root/eco-context'
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
    const result = await adapter().getEcoCollaborationSource(input(), sourceConfig(origin.url, {
      credentials: { username: 'native-user', password: 'native-password' },
    })).then(
      (value) => ({ kind: 'accepted' as const, id: value.eco.id }),
      (error: { code?: string; message?: string }) => ({
        kind: 'refused' as const,
        code: error.code,
        message: error.message,
      }),
    )
    const releaseAt = control.events.indexOf(`body-release:login:bound=${switchToBound}`)
    expect(releaseAt).toBeGreaterThan(control.events.indexOf('admit:2:source-b:false'))
    if (!switchToBound) {
      const ecoAt = control.events.indexOf(`request:${ecoPath}`)
      expect(result).toEqual({ kind: 'accepted', id: 'eco-scoped' })
      expect(control.requests).toEqual([loginPath, ecoPath])
      expect(control.events.slice(releaseAt + 1, ecoAt)).toContain('admit:3:source-b:false')
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

it('accepts a delayed chunked unbound ECO body and refuses the parsed source when that body binds source B', async () => {
  useRealFetch()
  const ecoPath = '/api/v1/plm/collaboration-sources/items/item-root/eco-context'
  for (const switchToBound of [false, true]) {
    const control = deferredChunkedBody('eco', switchToBound)
    const origin = await listen(async (req, res) => {
      control.requests.push(String(req.url))
      control.events.push(`request:${req.url}`)
      await read(req)
      res.writeHead(200, { 'content-type': 'application/json' })
      control.hold(res)
      res.flushHeaders()
    })
    const result = await adapter().getEcoCollaborationSource(input(), sourceConfig(origin.url)).then(
      (value) => ({ kind: 'accepted' as const, id: value.eco.id, entitled: value.entitled }),
      (error: { code?: string; message?: string }) => ({
        kind: 'refused' as const,
        code: error.code,
        message: error.message,
      }),
    )
    const releaseAt = control.events.indexOf(`body-release:eco:bound=${switchToBound}`)
    expect(releaseAt).toBeGreaterThan(control.events.indexOf('admit:2:source-b:false'))
    expect(control.requests).toEqual([ecoPath])
    if (!switchToBound) {
      expect(result).toEqual({ kind: 'accepted', id: 'eco-scoped', entitled: true })
      expect(control.events.indexOf('admit:3:source-b:false')).toBeGreaterThan(releaseAt)
      expect(control.calls()).toBe(3)
    } else {
      expect(result).toMatchObject({ kind: 'refused', code: 'PLM_MANAGED_SHARED_TRANSPORT_REFUSED' })
      expect(control.events.indexOf('admit:3:source-b:true')).toBeGreaterThan(releaseAt)
      expect(control.calls()).toBe(3)
      expect(JSON.stringify(result)).not.toContain('Scoped ECO')
      expect(JSON.stringify(result)).not.toContain(UPDATED)
    }
  }
})
