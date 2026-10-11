// Actual Express router and its production input/projector bodies, with a fake
// host port and pre-authenticated request context. No listener, JWT or PG proof.
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { types } from 'node:util'
import type { Request, Response } from 'express'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createIntegrationYidaOwnerRouter, yidaOwnerNoStoreMiddleware,
  type YidaInitializationHttpPort, type YidaOwnerHttpPort } from '../../src/routes/integration-yida-owner'
import { draftInput, syntheticMaterial } from '../utils/stock-preparation-yida-owner-http-fixture'

const commandId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const targetRef = '33333333-3333-4333-8333-333333333333'
const rowKey = '44444444-4444-4444-8444-444444444444'
const actor = { actorId: 'synthetic-http-owner', tenantId: 'synthetic-http-tenant', workspaceId: null }
const ready = () => ({ commandId, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false })
const initialized = () => ({ ...ready(), status: 'initialized', draft: {
  targetRef, operationId, status: 'unverified', identityKind: 'local-unverified', canSend: false, canApply: false,
  tokenIssued: false, externalWriteAttempted: false, rowCount: 1, rows: [{ rowKey, index: 0 }], reused: false,
} })
const input = () => ({ commandId, material: syntheticMaterial(), draft: draftInput(), attestation: {
  kind: 'owner-reviewed-target', reviewRef: 'synthetic-http-review', organizationId: 'synthetic-http-organization',
  executionIdentity: syntheticMaterial().userId,
} })
function port(result: unknown = initialized()) {
  const calls: Array<{ input: unknown; actor: unknown; signal: AbortSignal }> = []
  const value: YidaInitializationHttpPort = {
    async status(owner, options) { calls.push({ input: null, actor: owner, signal: options.signal }); return ready() },
    async initialize(owner, request, options) { calls.push({ input: request, actor: owner, signal: options.signal }); return result },
  }
  return { value, calls }
}
async function dispatch(method: string, body: unknown, value?: YidaInitializationHttpPort,
  options: { query?: Record<string, unknown>; headers?: Record<string, string>; authenticated?: boolean; url?: string } = {}) {
  const req = Object.assign(new EventEmitter(), { method, url: options.url ?? '/initialization',
    originalUrl: '/api/integration/yida-owner-send/initialization', headers: options.headers ?? {}, query: options.query ?? {},
    body, user: options.authenticated === false ? undefined : { id: actor.actorId }, authenticatedTenantId: actor.tenantId, aborted: false })
  const headers: Record<string, unknown> = {}
  let status = 0
  const router = createIntegrationYidaOwnerRouter({} as YidaOwnerHttpPort, value)
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
    setHeader(key: string, value: unknown) { headers[key.toLowerCase()] = value },
    status(value: number) { status = value; return this },
    json(_body: unknown) {},
  })
  const result = await new Promise<unknown>((resolve, reject) => {
    res.json = (body: unknown) => { res.writableEnded = true; resolve(body) }
    yidaOwnerNoStoreMiddleware(req as unknown as Request, res as unknown as Response, () => {
      router(req as unknown as Request, res as unknown as Response, reject)
    })
  })
  // json() resolves before the async route's finally; flush that microtask.
  await Promise.resolve()
  expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0)
  expect(headers['cache-control']).toBe('no-store'); expect(headers['x-content-type-options']).toBe('nosniff')
  return { status, result }
}
function actualInputBoundary(removeIdentityGuard = false): (value: unknown) => unknown {
  const source = ts.createSourceFile('integration-yida-owner.ts', readFileSync(new URL('../../src/routes/integration-yida-owner.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
  const names = ['record', 'literalId', 'id', 'initializationInput']
  const functions = names.map(name => {
    const found = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name)
    expect(found).toHaveLength(1); return found[0].getText(source)
  })
  const anchor = '  if (attestation.executionIdentity !== material.userId) fail()'
  let code = functions.join('\n')
  expect(code.split(anchor)).toHaveLength(2)
  if (removeIdentityGuard) code = code.replace(anchor, '')
  const compiled = ts.transpileModule(code + '\nreturn initializationInput', { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText
  return new Function('types', 'Buffer', 'UUID', 'fail', compiled)(types, Buffer,
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u, () => { throw new Error('CLOSED_INPUT') })
}

describe('YiDa initialization HTTP contract — no IO fake host port', () => {
  it('GET ready and POST initialized preserve status, exact metadata and trusted actor', async () => {
    const f = port(), request = input()
    expect(await dispatch('GET', undefined, f.value)).toEqual({ status: 200, result: { ok: true, data: ready() } })
    expect(await dispatch('POST', request, f.value)).toEqual({ status: 201, result: { ok: true, data: initialized() } })
    expect(f.calls).toHaveLength(2); expect(f.calls[1].actor).toEqual(actor)
    expect(f.calls[1].input).toEqual(request); expect(f.calls[1].signal.aborted).toBe(false)
    expect(JSON.stringify(initialized())).not.toContain(request.material.appSecret)
  })
  it('raw identity mismatch and padded material userId reject before host invocation', async () => {
    const f = port(), request = input()
    for (const bad of [{ ...request, attestation: { ...request.attestation, executionIdentity: 'synthetic-other-executor' } },
      { ...request, material: { ...request.material, userId: ' ' + request.material.userId + ' ' } }]) {
      expect(await dispatch('POST', bad, f.value)).toEqual({ status: 400, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_INPUT' } } })
    }
    expect(f.calls).toHaveLength(0)
  })
  it('the actual HTTP identity guard removal makes the same original negative assertion red', () => {
    const original = actualInputBoundary(), mutant = actualInputBoundary(true), request = input()
    const bad = { ...request, attestation: { ...request.attestation, executionIdentity: 'synthetic-other-executor' } }
    expect(() => original(bad)).toThrow('CLOSED_INPUT')
    expect(mutant(bad)).toEqual(bad)
    expect(() => expect(() => mutant(bad)).toThrow('CLOSED_INPUT')).toThrow()
  })
  it('closed bodies, material limits, rows limits and missing allocation fail before host', async () => {
    const f = port(), request = input()
    for (const bad of [{ ...request, ownerId: actor.actorId }, { ...request, material: { ...request.material, token: 'synthetic-forged' } },
      { ...request, material: { ...request.material, appSecret: 'x'.repeat(4097) } },
      { ...request, draft: { config: request.draft.config, rowsText: request.draft.rowsText } },
      { ...request, draft: { ...request.draft, rowsText: 'x'.repeat(128 * 1024 + 1) } }]) {
      expect((await dispatch('POST', bad, f.value)).status).toBe(400)
    }
    expect(f.calls).toHaveLength(0)
  })
  it('GET refuses body/query/scope headers; JWT context is mandatory, missing private port is 503', async () => {
    const f = port()
    expect((await dispatch('GET', { commandId }, f.value)).status).toBe(400)
    expect((await dispatch('GET', undefined, f.value, { query: { commandId } })).status).toBe(400)
    expect((await dispatch('GET', undefined, f.value, { headers: { 'x-owner-id': actor.actorId } })).status).toBe(400)
    expect((await dispatch('GET', undefined, f.value, { authenticated: false })).status).toBe(401)
    expect(f.calls).toHaveLength(0)
    expect((await dispatch('GET', undefined)).status).toBe(503)
    expect((await dispatch('POST', input())).status).toBe(503)
  })
  it('foreign code/cause and hostile or extra DTO fields never leave the closed response', async () => {
    const hostile = { ...port().value, async initialize() { throw Object.assign(new Error('PRIVATE_ERROR_CANARY'), { code: 'YIDA_INITIALIZATION_INPUT', cause: 'PRIVATE_CAUSE_CANARY' }) } }
    expect(await dispatch('POST', input(), hostile)).toEqual({ status: 503, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_UNAVAILABLE' } } })
    for (const result of [{ ...initialized(), material: syntheticMaterial() }, { ...initialized(), tokenIssued: true },
      { ...initialized(), draft: { ...initialized().draft!, payload: 'PRIVATE_DTO_CANARY' } }]) {
      expect(await dispatch('POST', input(), port(result).value)).toEqual({ status: 503, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_UNAVAILABLE' } } })
    }
  })
})
