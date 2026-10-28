// Actual Express router for POST /initialization/connection-test and the GET/POST /initialization
// display bit, with fake host ports. Dispatch over an EventEmitter request (no listener), plus one
// loopback request through the actual correlation middleware and the actual Logger (values-free).
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { inspect } from 'node:util'
import express, { type Request, type Response } from 'express'
import winston from 'winston'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIntegrationYidaOwnerRouter, yidaOwnerNoStoreMiddleware, yidaOwnerJsonOnlyMiddleware,
  type YidaConnectionTestHttpPort, type YidaInitializationHttpPort, type YidaOwnerHttpPort } from '../../src/routes/integration-yida-owner'
import { YidaConnectionTestError } from '../../src/integration/yida-connection-test-runtime'
import { YidaInitializationError } from '../../src/integration/yida-initialization-runtime'
import { YIDA_OWNER_HTTP_PREFIX as PREFIX } from '../../src/integration/yida-owner-http-observation'
import { correlationIdMiddleware } from '../../src/middleware/correlation'
import { Logger } from '../../src/core/logger'

const commandId = '11111111-1111-4111-8111-111111111111'
const otherCommand = '22222222-2222-4222-8222-222222222222'
const actor = { actorId: 'synthetic-http-owner', tenantId: 'synthetic-http-tenant', workspaceId: null }
const body = () => ({ commandId, mode: 'candidate', material: { appKey: ' synthetic-probe key ', appSecret: ' synthetic-probe secret ' } })
const view = (outcome = 'ok') => ({ commandId, mode: 'candidate', outcome, tokenIssued: outcome === 'ok',
  tokenRetained: false, externalWriteAttempted: false, canSend: false })
const ready = () => ({ commandId, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false })
function probePort(result: unknown = view(), enabled: unknown = false) {
  const calls: Array<{ actor: unknown; input: unknown; signal: AbortSignal }> = []
  const reads: unknown[] = []
  const value: YidaConnectionTestHttpPort = {
    async test(owner, input, options) {
      calls.push({ actor: owner, input, signal: options.signal })
      if (result instanceof Error) throw result
      return result
    },
    connectionTestEnabled() { reads.push(enabled); if (enabled instanceof Error) throw enabled; return enabled as boolean },
  }
  return { value, calls, reads }
}
const initPort: YidaInitializationHttpPort = { async status() { return ready() }, async initialize() { return ready() } }
async function dispatch(method: string, url: string, payload: unknown, port?: YidaConnectionTestHttpPort,
  options: { headers?: Record<string, string>; query?: Record<string, unknown>; authenticated?: boolean; init?: YidaInitializationHttpPort } = {}) {
  const req = Object.assign(new EventEmitter(), { method, url, originalUrl: PREFIX + url, headers: options.headers ?? {},
    query: options.query ?? {}, body: payload, user: options.authenticated === false ? undefined : { id: actor.actorId },
    authenticatedTenantId: actor.tenantId, aborted: false })
  let status = 0
  const owner = { sendEnabled: () => false } as unknown as YidaOwnerHttpPort
  const router = createIntegrationYidaOwnerRouter(owner, options.init ?? initPort, port)
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, setHeader() {},
    status(value: number) { status = value; return this }, json(_body: unknown) {} })
  const result = await new Promise<unknown>((resolve, reject) => {
    res.json = (sent: unknown) => { res.writableEnded = true; resolve(sent) }
    yidaOwnerNoStoreMiddleware(req as unknown as Request, res as unknown as Response, () => {
      router(req as unknown as Request, res as unknown as Response, reject)
    })
  })
  await Promise.resolve()
  return { status, result }
}
const probe = (payload: unknown, port?: YidaConnectionTestHttpPort, options?: Parameters<typeof dispatch>[4]) =>
  dispatch('POST', '/initialization/connection-test', payload, port, options)
const refusal = (code: string, status: number) => ({ status, result: { ok: false, error: { code } } })

describe('YiDa connection-test HTTP contract — fake host port, no IO', () => {
  it('200 closed view, trusted actor, exact pasted bytes and a live abort signal', async () => {
    const f = probePort()
    expect(await probe(body(), f.value)).toEqual({ status: 200, result: { ok: true, data: view() } })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].actor).toEqual(actor)
    expect(f.calls[0].input).toEqual(body())
    expect(f.calls[0].signal.aborted).toBe(false)
    for (const outcome of ['upstream_rejected', 'unreachable', 'timeout']) {
      expect(await probe(body(), probePort(view(outcome)).value)).toEqual({ status: 200, result: { ok: true, data: view(outcome) } })
    }
  })
  it.each([
    ['missing mode', { commandId, material: body().material }],
    ['stored mode (PR B, not shipped)', { ...body(), mode: 'stored' }],
    ['extra body key', { ...body(), ownerId: actor.actorId }],
    ['extra material key', { ...body(), material: { ...body().material, systemToken: 'synthetic' } }],
    ['whitespace secret', { ...body(), material: { appKey: 'synthetic', appSecret: '   ' } }],
    ['oversized secret', { ...body(), material: { appKey: 'synthetic', appSecret: 'x'.repeat(4097) } }],
    ['non-string key', { ...body(), material: { appKey: 1, appSecret: 'synthetic' } }],
    ['non-uuid command', { ...body(), commandId: 'synthetic-command' }],
    ['no body', undefined],
  ])('400 before the port: %s', async (_name, payload) => {
    const f = probePort()
    expect(await probe(payload, f.value)).toEqual(refusal('YIDA_OWNER_HTTP_INPUT', 400))
    expect(f.calls).toHaveLength(0)
  })
  it('scope headers, query keys and a missing principal are refused before the port; no port is 503', async () => {
    const f = probePort()
    expect((await probe(body(), f.value, { headers: { 'x-tenant-id': actor.tenantId } })).status).toBe(400)
    expect((await probe(body(), f.value, { query: { commandId } })).status).toBe(400)
    expect((await probe(body(), f.value, { authenticated: false })).status).toBe(401)
    expect(f.calls).toHaveLength(0)
    expect(await probe(body())).toEqual(refusal('YIDA_OWNER_HTTP_UNAVAILABLE', 503))
  })
  it.each([
    ['DISABLED', 403], ['DENIED', 403], ['CONFLICT', 409], ['CANCELLED', 409], ['THROTTLED', 429],
    ['INACTIVE', 503], ['UNAVAILABLE', 503], ['INPUT', 400],
  ] as const)('runtime %s maps to its closed status', async (code, status) => {
    expect(await probe(body(), probePort(new YidaConnectionTestError(code)).value)).toEqual(refusal(`YIDA_CONNECTION_TEST_${code}`, status))
  })
  it('a foreign error, or a DTO that is not the closed view, is 503 and never echoed', async () => {
    const foreign = Object.assign(new Error('PRIVATE_ERROR_CANARY'), { code: 'YIDA_CONNECTION_TEST_DENIED', cause: 'PRIVATE_CAUSE_CANARY' })
    expect(await probe(body(), probePort(foreign).value)).toEqual(refusal('YIDA_OWNER_HTTP_UNAVAILABLE', 503))
    for (const bad of [{ ...view(), token: 'PRIVATE_TOKEN_CANARY' }, { ...view(), tokenRetained: true }, { ...view(), externalWriteAttempted: true },
      { ...view(), canSend: true }, { ...view(), outcome: 'synthetic' }, { ...view(), tokenIssued: false },
      { ...view('unreachable'), tokenIssued: true }, { ...view(), commandId: otherCommand }, { ...view(), mode: 'stored' }]) {
      const result = await probe(body(), probePort(bad).value)
      expect(result).toEqual(refusal('YIDA_OWNER_HTTP_UNAVAILABLE', 503))
      expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN_CANARY')
    }
  })
  it('GET/POST /initialization carry connectionTestEnabled: exact boolean true only, read only after the authorized status', async () => {
    for (const [value, expected] of [[true, true], [false, false], ['true', false], [1, false], [new Error('PRIVATE_SWITCH_CANARY'), false]] as const) {
      expect(await dispatch('GET', '/initialization', undefined, probePort(view(), value).value))
        .toEqual({ status: 200, result: { ok: true, data: { ...ready(), sendEnabled: false, connectionTestEnabled: expected } } })
    }
    expect(await dispatch('GET', '/initialization', undefined, undefined))
      .toEqual({ status: 200, result: { ok: true, data: { ...ready(), sendEnabled: false, connectionTestEnabled: false } } })
    const f = probePort(view(), true)
    const denied: YidaInitializationHttpPort = { ...initPort, async status() { throw new YidaInitializationError('DENIED') } }
    expect(await dispatch('GET', '/initialization', undefined, f.value, { init: denied })).toEqual(refusal('YIDA_INITIALIZATION_DENIED', 403))
    expect(f.reads).toEqual([])
  })
})

describe('YiDa connection-test route — actual correlation middleware and Logger stay values-free', () => {
  let server: Server | undefined
  afterEach(async () => {
    vi.restoreAllMocks()
    if (server) { const owned = server; server = undefined; owned.closeAllConnections(); await new Promise<void>(resolve => owned.close(() => resolve())) }
  })
  it('only YIDA_OWNER_HTTP_<LEVEL> plus the server correlation id reach winston for the new path', async () => {
    const sentinels = { appKey: 'YidaProbeKey_SENTINEL_42', appSecret: 'YidaProbeSecret_SENTINEL_42', message: 'YidaProbeMessage_SENTINEL_42',
      meta: 'YidaProbeMeta_SENTINEL_42', error: 'YidaProbeError_SENTINEL_42', correlation: 'YidaProbeCorrelation_SENTINEL_42' }
    const entries: Array<Record<PropertyKey, unknown>> = []
    vi.spyOn(winston.transports.Console.prototype, 'log').mockImplementation(function (info: Record<PropertyKey, unknown>, callback: () => void) {
      entries.push({ ...info }); callback()
    } as never)
    const previous = process.env.LOG_LEVEL; process.env.LOG_LEVEL = 'debug'
    const logger = new Logger('SyntheticConnectionTestPort')
    if (previous === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previous
    const port: YidaConnectionTestHttpPort = {
      async test(_owner, input) {
        // A careless port logging everything it holds: none of it may survive.
        logger.debug(`probe ${sentinels.message}`, { appKey: input.material.appKey })
        logger.info(`probe ${sentinels.message}`, { appSecret: input.material.appSecret, meta: sentinels.meta })
        logger.warn(`probe ${sentinels.message}`, { appKey: input.material.appKey })
        logger.error(`probe ${sentinels.message}`, new Error(sentinels.error))
        return view()
      },
      connectionTestEnabled: () => false,
    }
    const app = express()
    app.use(correlationIdMiddleware)
    app.use(PREFIX, yidaOwnerNoStoreMiddleware, yidaOwnerJsonOnlyMiddleware, express.json({ limit: '64kb', strict: true }))
    app.use((req, _res, next) => { Object.assign(req, { user: { id: actor.actorId }, authenticatedTenantId: actor.tenantId }); next() })
    app.use(PREFIX, createIntegrationYidaOwnerRouter({ sendEnabled: () => false } as unknown as YidaOwnerHttpPort, initPort, port))
    server = createServer(app)
    await new Promise<void>(resolve => server!.listen({ port: 0, host: '127.0.0.1' }, () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('SYNTHETIC_LISTENER_REQUIRED')
    const payload = JSON.stringify({ commandId, mode: 'candidate', material: { appKey: sentinels.appKey, appSecret: sentinels.appSecret } })
    const response = await new Promise<{ status: number; header: unknown; text: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path: PREFIX + '/initialization/connection-test', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), 'x-correlation-id': sentinels.correlation } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.once('end', () => resolve({ status: res.statusCode ?? 0, header: res.headers['x-correlation-id'], text: Buffer.concat(chunks).toString('utf8') }))
      })
      req.once('error', reject); req.end(payload)
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual({ ok: true, data: view() })
    expect(typeof response.header).toBe('string'); expect(response.header).not.toBe(sentinels.correlation)
    const mine = entries.filter(entry => entry.context === 'SyntheticConnectionTestPort')
    expect(mine.map(entry => entry.message)).toEqual(['YIDA_OWNER_HTTP_DEBUG', 'YIDA_OWNER_HTTP_INFO', 'YIDA_OWNER_HTTP_WARN', 'YIDA_OWNER_HTTP_ERROR'])
    for (const entry of mine) expect(entry.correlation_id).toBe(response.header)
    const output = inspect(entries, { depth: null, colors: false, getters: false })
    for (const sentinel of Object.values(sentinels)) expect(output).not.toContain(sentinel)
  })
})
