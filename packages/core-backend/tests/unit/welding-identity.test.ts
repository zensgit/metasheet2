import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import jwt from 'jsonwebtoken'

const mocks = vi.hoisted(() => ({ verifyToken: vi.fn(), readTokenPayload: vi.fn(), resolveSessionTenantId: vi.fn(), query: vi.fn() }))
vi.mock('../../src/auth/AuthService', () => ({ authService: mocks }))
vi.mock('../../src/db/pg', () => ({ query: mocks.query }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat), readFile: vi.fn(actual.readFile) }
})
import { stat as keyStat, readFile as readKey } from 'node:fs/promises'
import { weldingRouter, weldingPreflight } from '../../src/routes/welding'
import { isGateException } from '../../src/auth/api-path-policy'
import { readWeldingProvider, weldingSubject, signWeldingAssertion, weldingJwks } from '../../src/integrations/welding/provider'
import { requireWeldingSession } from '../../src/integrations/welding/session'

const fixture = resolve('../../artifacts/welding-f15b/unit-runtime')
mkdirSync(fixture, { recursive: true })
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' })
writeFileSync(`${fixture}/signing.pem`, key)
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(fixture, { recursive: true, force: true }) })
const now = () => Math.floor(Date.now() / 1000)
const authority = () => ({ schema: 'yuantus.welding_generation_authority/1', owner: { tenant_id: 'yt', org_id: 'yo', auth_user_id: 71, rbac_user_id: 102 } })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const fetchMock = vi.fn()
function app(tenant: string | undefined = 'mt') {
  const app = express()
  app.use(weldingPreflight)
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true }))
  app.use((req, res, next) => {
    if (isGateException(req.path)) return next()
    if (!req.headers.authorization) return res.status(401).json({ error: 'gate' })
    req.authenticatedTenantId = tenant
    next()
  })
  app.use(weldingRouter())
  return app
}
function upstream() {
  fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
    .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
    .mockResolvedValueOnce(json(authority()))
}
beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockReset()
  vi.unstubAllEnvs()
  for (const [name, value] of Object.entries({ WELDING_READ_ENABLED: 'true', WELDING_METASHEET_TENANT_ID: 'mt', WELDING_YUANTUS_ORIGIN: 'https://welding.invalid', WELDING_YUANTUS_PROVIDER: 'ms', WELDING_YUANTUS_TENANT_ID: 'yt', WELDING_YUANTUS_ORG_ID: 'yo', WELDING_SSO_ISSUER: 'https://issuer.invalid', WELDING_SSO_CLIENT_ID: 'welding', WELDING_SSO_KID: 'key-1', WELDING_SSO_PRIVATE_KEY_FILE: `${fixture}/signing.pem`, RBAC_TOKEN_TRUST: '', RBAC_BYPASS: '' })) vi.stubEnv(name, value)
  mocks.verifyToken.mockResolvedValue({ id: 'u1', tenantId: 'mt' })
  mocks.readTokenPayload.mockReturnValue({ userId: 'u1', tenantId: 'mt', sid: 'sid1', iat: now() - 10, exp: now() + 300 })
  mocks.resolveSessionTenantId.mockResolvedValue('mt')
  mocks.query.mockResolvedValue({ rows: [{ id: 'sid1' }] })
  vi.stubGlobal('fetch', fetchMock)
})
describe('finite welding identity routes', () => {
  it.each([undefined, '', '1', 'TRUE', ' true ', 'false'])('off for nonliteral flag %s before session/key/IO', async (flag) => {
    vi.stubEnv('WELDING_READ_ENABLED', flag)
    vi.stubEnv('WELDING_SSO_PRIVATE_KEY_FILE', '/nonexistent')
    for (const path of ['/api/welding/authority', '/api/welding/jwks']) {
      const result = await request(app()).get(path)
      expect(result.status).toBe(503)
      expect(result.headers['cache-control']).toBe('no-store')
    }
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(keyStat).not.toHaveBeenCalled()
    expect(readKey).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it.each(['true', 'false'])('rejects malformed and oversized bodies before the actual global parsers, flag %s', async flag => {
    vi.stubEnv('WELDING_READ_ENABLED', flag)
    for (const path of ['/api/welding/jwks', '/api/welding/authority']) {
      for (const size of [1, 10 * 1024 * 1024 + 1]) {
        // Only headers and one byte are sent: refusal must precede body consumption,
        // otherwise the oversized declared body would hang waiting for its remainder.
        const result = await request(app()).get(path).set('Content-Type', 'application/json').set('Content-Length', String(size)).send('{')
        expect(result.status).toBe(flag === 'true' ? 400 : 503)
        expect(result.headers['cache-control']).toBe('no-store')
        expect(result.body).toEqual({ error: { code: flag === 'true' ? 'WELDING_INVALID_REQUEST' : 'WELDING_UNAVAILABLE' } })
      }
    }
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(keyStat).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('only declares the exact JWKS gate exception', async () => {
    expect(isGateException('/API/WELDING/JWKS/')).toBe(true)
    for (const path of ['/api/welding/jwks/child', '/api/welding/jwksx', '/api/welding/authority', '/api/welding/%6awks']) {
      expect(isGateException(path)).toBe(false)
      expect((await request(app()).get(path)).status).toBe(401)
    }
    for (const path of ['/api/welding/jwks', '/API/WELDING/JWKS/']) {
      const publicKey = await request(app()).get(path)
      expect(publicKey.status).toBe(200)
      expect(Object.keys(publicKey.body.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use'])
    }
    const result = await request(app()).get('/api/welding/authority')
    expect(result.headers['cache-control']).toBe('no-store')
  })
  it.each(['?actor=1', '?path=../../auth/me', '?url=https://other.invalid', '?x=1&x=2', '?tenant=mt'])('rejects all query selectors %s before exchange', async (query) => {
    const result = await request(app()).get(`/api/welding/authority${query}`).set('Authorization', 'Bearer session')
    expect(result.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('returns only a validated authority after five native session rechecks', async () => {
    upstream()
    const result = await request(app()).get('/api/welding/authority').set('Authorization', 'Bearer session')
    expect(result.status).toBe(200)
    expect(result.body).toEqual(authority())
    expect(result.headers['cache-control']).toBe('no-store')
    expect(mocks.query).toHaveBeenCalledTimes(5)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://welding.invalid/api/v1/auth/sso/challenge', 'https://welding.invalid/api/v1/auth/sso/login', 'https://welding.invalid/api/v1/plugins/welding/generation-authority'])
    expect(fetchMock.mock.calls[2][1].headers.Authorization).toBe('Bearer secret-bearer')
  })
  it('rejects header fallback even with a valid signed session in the verifier', async () => {
    const result = await request(app('')).get('/api/welding/authority').set('Authorization', 'Bearer session').set('x-tenant-id', 'mt')
    expect(result.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['/api/welding/jwks/child', '/api/welding/jwks//', '/api/welding/%6awks', '/api/welding/authority/extra', '/api/welding/authority%2F..%2Fjwks'])('unrelated path does not run welding IO %s', async path => {
    const result = await request(app()).get(path).set('Authorization', 'Bearer session')
    expect(result.status).toBe(404)
    expect(keyStat).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([[1, 1], [2, 1], [3, 2], [4, 3]])('revocation after IO checkpoint %s prevents the next hop/result', async (checkpoint, hops) => {
    upstream()
    let reads = 0
    mocks.query.mockImplementation(async () => ({ rows: ++reads > checkpoint ? [] : [{ id: 'sid1' }] }))
    const result = await request(app()).get('/api/welding/authority').set('Authorization', 'Bearer session')
    expect(result.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(hops)
    expect(JSON.stringify(result.body)).not.toContain('secret')
  })
})
describe('strict native session boundary', () => {
  const check = () => requireWeldingSession('session', 'mt', readWeldingProvider())
  it.each(['sid', 'iat', 'exp', 'tenantId'])('rejects missing signed %s', async (field) => {
    const payload = mocks.readTokenPayload('session')
    delete payload[field]
    mocks.readTokenPayload.mockReturnValue(payload)
    await expect(check()).rejects.toThrow('WELDING_SESSION_REQUIRED')
  })
  it.each([[], undefined])('rejects absent/revoked/expired native registry rows %s', async (rows) => {
    if (rows) mocks.query.mockResolvedValue({ rows }); else mocks.query.mockRejectedValue(new Error('missing table secret'))
    await expect(check()).rejects.toThrow('WELDING_SESSION_REQUIRED')
  })
  it('requires verified request tenant and active membership, never headers', async () => {
    await expect(requireWeldingSession('session', undefined, readWeldingProvider())).rejects.toThrow('WELDING_SESSION_REQUIRED')
    mocks.resolveSessionTenantId.mockResolvedValue(undefined)
    await expect(check()).rejects.toThrow('WELDING_SESSION_REQUIRED')
  })
  it.each(['RBAC_TOKEN_TRUST', 'RBAC_BYPASS'])('rejects enabled %s', async (name) => {
    const config = readWeldingProvider()
    vi.stubEnv(name, '1')
    await expect(requireWeldingSession('session', 'mt', config)).rejects.toThrow('WELDING_UNAVAILABLE')
    expect(mocks.verifyToken).not.toHaveBeenCalled()
  })
  it.each([
    { exp: 1 }, { iat: Infinity }, { iat: 1.5 }, { exp: Infinity }, { iat: 9999999999 },
    { tenantId: 'other' }, { userId: 'other' }, { sid: ' ' },
  ])('rejects invalid signed identity/time fields %s', async patch => {
    mocks.readTokenPayload.mockReturnValue({ userId: 'u1', tenantId: 'mt', sid: 'sid1', iat: now() - 10, exp: now() + 300, ...patch })
    await expect(check()).rejects.toThrow('WELDING_SESSION_REQUIRED')
    expect(mocks.query).not.toHaveBeenCalled()
  })
  it.each([null, { id: 'u1', tenantId: 'mt', must_change_password: true }, { id: 'other', tenantId: 'mt' }, { id: 'u1', tenantId: 'other' }])('requires current active user and completed password change %s', async user => {
    mocks.verifyToken.mockResolvedValue(user)
    await expect(check()).rejects.toThrow('WELDING_SESSION_REQUIRED')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('rejects changed original owner after an IO boundary', async () => {
    const config = readWeldingProvider()
    const session = await requireWeldingSession('session', 'mt', config)
    mocks.verifyToken.mockResolvedValue({ id: 'u2', tenantId: 'mt' })
    mocks.readTokenPayload.mockReturnValue({ userId: 'u2', tenantId: 'mt', sid: 'sid2', iat: session.iat, exp: session.exp })
    await expect(requireWeldingSession('session', 'mt', config, session)).rejects.toThrow('WELDING_SESSION_REQUIRED')
    expect(mocks.query).toHaveBeenCalledTimes(1)
  })
  it('keeps strict two-table predicates and original signed binding in SQL', async () => {
    await check()
    expect(mocks.query.mock.calls[0][0]).toMatch(/LEFT JOIN user_session_revocations/)
    expect(mocks.query.mock.calls[0][0]).toMatch(/s.revoked_at IS NULL/)
    expect(mocks.query.mock.calls[0][0]).toMatch(/s.expires_at > NOW\(\)/)
    expect(mocks.query.mock.calls[0][0]).toMatch(/r.revoked_after < to_timestamp/)
    expect(mocks.query.mock.calls[0][1]).toEqual(['sid1', 'u1', mocks.readTokenPayload.mock.results[0].value.iat])
  })
})
describe('dedicated RSA provider', () => {
  it('publishes only RSA public fields and signs bounded canonical subject claims', async () => {
    const config = readWeldingProvider()
    const jwks = await weldingJwks(config)
    expect(Object.keys(jwks.keys[0]).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use'])
    const token = await signWeldingAssertion(config, { userId: 'u1', tenantId: 'mt', sid: 'sid1', iat: now() - 10, exp: now() + 30 }, 'nonce')
    const publicKey = createPublicKey({ key: jwks.keys[0], format: 'jwk' })
    const claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: config.issuer, audience: config.clientId, nonce: 'nonce' }) as jwt.JwtPayload
    expect(claims.sub).toBe(weldingSubject('mt', 'u1'))
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(30)
    expect(jwt.decode(token, { complete: true })!.header.kid).toBe('key-1')
    for (const options of [{ issuer: 'wrong' }, { audience: 'wrong' }, { nonce: 'wrong' }, { algorithms: ['HS256'] }]) expect(() => jwt.verify(token, publicKey, { algorithms: ['RS256'], ...options })).toThrow()
    expect(weldingSubject('a,b', 'c')).not.toBe(weldingSubject('a', 'b,c'))
  })
  it('real RSA verification refuses unknown kid, wrong key and modified signature', async () => {
    const config = readWeldingProvider()
    const jwks = await weldingJwks(config)
    const verify = (token: string) => {
      const header = jwt.decode(token, { complete: true })!.header
      const key = jwks.keys.find(candidate => candidate.kid === header.kid)
      if (!key) throw new Error('UNKNOWN_KID')
      return jwt.verify(token, createPublicKey({ key, format: 'jwk' }), { algorithms: ['RS256'], issuer: config.issuer, audience: config.clientId, nonce: 'nonce' })
    }
    const unknown = await signWeldingAssertion({ ...config, kid: 'wrong' }, { userId: 'u1', tenantId: 'mt', exp: now() + 300 }, 'nonce')
    expect(() => verify(unknown)).toThrow('UNKNOWN_KID')
    const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const forged = jwt.sign({ sub: 'subject', nonce: 'nonce' }, wrongKey, { algorithm: 'RS256', keyid: config.kid, issuer: config.issuer, audience: config.clientId, expiresIn: 60 })
    expect(() => verify(forged)).toThrow()
    const valid = await signWeldingAssertion(config, { userId: 'u1', tenantId: 'mt', exp: now() + 300 }, 'nonce')
    expect(verify(valid)).toBeTruthy()
    const pieces = valid.split('.')
    pieces[2] = `${pieces[2][0] === 'a' ? 'b' : 'a'}${pieces[2].slice(1)}`
    expect(() => verify(pieces.join('.'))).toThrow()
  })
  it.each(['http://welding.invalid', 'https://welding.invalid/path', 'https://u:p@welding.invalid', 'https://welding.invalid?x=1'])('rejects nonfixed origin %s', (origin) => {
    vi.stubEnv('WELDING_YUANTUS_ORIGIN', origin)
    expect(readWeldingProvider).toThrow('WELDING_UNAVAILABLE')
  })
})

describe('upstream DTO and transport fail closed', () => {
  const get = () => request(app()).get('/api/welding/authority').set('Authorization', 'Bearer session')
  it.each([
    { state: '', nonce: 'nonce', expires_in: 300 },
    { state: 'state', nonce: 'nonce', expires_in: '300' },
    { state: 'state', nonce: 'nonce', expires_in: 300, access_token: 'secret' },
  ])('rejects invalid challenge before login', async body => {
    fetchMock.mockResolvedValue(json(body))
    expect((await get()).status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([
    { tenant_id: 'other' }, { user_id: '71' }, { user_id: 0 }, { token_type: 'Basic' }, { expires_in: 0 }, { access_token: 'a\r\nb' }, { secret: 'secret-bearer' },
  ])('rejects invalid login before authority %s', async patch => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71, ...patch }))
    const result = await get()
    expect(result.status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result.body)).not.toContain('secret')
  })
  it.each([
    { auth_user_id: 72 }, { rbac_user_id: '102' }, { rbac_user_id: 0 }, { rbac_user_id: 1.1 }, { tenant_id: 'other' }, { org_id: 'other' }, { extra: 'secret' },
  ])('rejects authority actor/scope/shape mismatch %s', async patch => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json({ ...authority(), owner: { ...authority().owner, ...patch } }))
    expect((await get()).status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it.each([
    { ...authority(), schema: 'other' }, { ...authority(), access_token: 'secret' },
  ])('rejects authority schema and extra root fields', async body => {
    // Replace the response for the third operation, while retaining real signing.
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/challenge') ? json({ state: 's', nonce: 'n', expires_in: 300 }) : url.endsWith('/login') ? json({ access_token: 'secret', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }) : json(body))
    expect((await get()).status).toBe(502)
  })
  it.each(['bad-json', 'huge-json', 'content-length', 'redirect', 'denied', 'throw'])('bounds and redacts %s', async mode => {
    fetchMock.mockImplementation(async (_url, options) => {
      expect(options.redirect).toBe('error')
      if (mode === 'throw') throw new Error('secret-bearer private-key upstream-stack')
      if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'https://other.invalid' } })
      if (mode === 'denied') return new Response('secret-bearer', { status: 403 })
      if (mode === 'content-length') return new Response('{}', { headers: { 'content-length': '999999' } })
      return new Response(mode === 'huge-json' ? JSON.stringify({ secret: 'x'.repeat(32769) }) : 'secret not JSON')
    })
    const result = await get()
    expect(result.status).toBe(502)
    expect(result.body).toEqual({ error: { code: 'WELDING_UPSTREAM_REJECTED' } })
    expect(result.headers['cache-control']).toBe('no-store')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('bounds a stalled body read, cancels and prevents login', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cancel = vi.fn()
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start() {}, cancel })))
    try {
      const { weldingAuthority } = await import('../../src/integrations/welding/client')
      const pending = weldingAuthority(readWeldingProvider(), 'session', 'mt')
      const rejected = expect(pending).rejects.toThrow('WELDING_UPSTREAM_REJECTED')
      await vi.advanceTimersByTimeAsync(5001)
      await rejected
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(cancel).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('bounds a stalled fetch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetchMock.mockImplementation(() => new Promise(() => {}))
    try {
      const { weldingAuthority } = await import('../../src/integrations/welding/client')
      const pending = weldingAuthority(readWeldingProvider(), 'session', 'mt')
      const rejected = expect(pending).rejects.toThrow('WELDING_UPSTREAM_REJECTED')
      await vi.advanceTimersByTimeAsync(5001)
      await rejected
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('does not share credentials across concurrent users and reversed login completion', async () => {
    mocks.verifyToken.mockImplementation(async token => ({ id: token, tenantId: 'mt' }))
    mocks.readTokenPayload.mockImplementation(token => ({ userId: token, tenantId: 'mt', sid: token, iat: now() - 10, exp: now() + 300 }))
    mocks.query.mockImplementation(async (_sql, params) => ({ rows: [{ id: params[0] }] }))
    let releaseFirst: (() => void) | undefined
    let challenge = 0
    fetchMock.mockImplementation(async (url: string, options) => {
      if (url.endsWith('/challenge')) return json({ state: `s${++challenge}`, nonce: 'nonce', expires_in: 300 })
      if (url.endsWith('/login')) {
        const body = JSON.parse(options.body)
        const claims = jwt.decode(body.id_token) as jwt.JwtPayload
        const actor = claims.sub === weldingSubject('mt', 'u1') ? 71 : 72
        if (actor === 71) await new Promise<void>(resolve => { releaseFirst = resolve })
        else { while (!releaseFirst) await new Promise(resolve => setImmediate(resolve)); releaseFirst() }
        return json({ access_token: `private-${actor}`, token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: actor })
      }
      const actor = options.headers.Authorization === 'Bearer private-71' ? 71 : 72
      return json({ ...authority(), owner: { ...authority().owner, auth_user_id: actor } })
    })
    const [first, second] = await Promise.all(['u1', 'u2'].map(token => request(app()).get('/api/welding/authority').set('Authorization', `Bearer ${token}`)))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.owner.auth_user_id).toBe(71)
    expect(second.body.owner.auth_user_id).toBe(72)
    expect(JSON.stringify([first.body, second.body])).not.toContain('private-')
  })
})
