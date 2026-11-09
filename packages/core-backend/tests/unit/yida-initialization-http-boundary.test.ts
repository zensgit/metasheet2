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
import { YidaInitializationError } from '../../src/integration/yida-initialization-runtime'
import { draftInput, syntheticMaterial } from '../utils/stock-preparation-yida-owner-http-fixture'

const commandId = '11111111-1111-4111-8111-111111111111'
// Invisible test characters are built from code units at run time, so the source holds neither a raw
// invisible character nor an escape that an editor could rewrite into one.
const codeUnit = (code: number) => String.fromCharCode(code)
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
  options: { query?: Record<string, unknown>; headers?: Record<string, string>; authenticated?: boolean; url?: string; owner?: YidaOwnerHttpPort } = {}) {
  const req = Object.assign(new EventEmitter(), { method, url: options.url ?? '/initialization',
    originalUrl: '/api/integration/yida-owner-send/initialization', headers: options.headers ?? {}, query: options.query ?? {},
    body, user: options.authenticated === false ? undefined : { id: actor.actorId }, authenticatedTenantId: actor.tenantId, aborted: false })
  const headers: Record<string, unknown> = {}
  let status = 0
  const router = createIntegrationYidaOwnerRouter(options.owner ?? {} as YidaOwnerHttpPort, value)
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
  const names = ['record', 'literalId', 'credential', 'id', 'initializationInput']
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
    expect(await dispatch('GET', undefined, f.value)).toEqual({ status: 200, result: { ok: true, data: { ...ready(), sendEnabled: false } } })
    expect(await dispatch('POST', request, f.value)).toEqual({ status: 201, result: { ok: true, data: { ...initialized(), sendEnabled: false } } })
    expect(f.calls).toHaveLength(2); expect(f.calls[1].actor).toEqual(actor)
    expect(f.calls[1].input).toEqual(request); expect(f.calls[1].signal.aborted).toBe(false)
    expect(JSON.stringify(initialized())).not.toContain(request.material.appSecret)
  })
  it('sendEnabled is the owner runtime boolean, read only after an authorized status, and a throwing read is false', async () => {
    const f = port(), reads: unknown[] = []
    const owner = (value: unknown) => ({ sendEnabled() { reads.push(value); if (value instanceof Error) throw value; return value } }) as unknown as YidaOwnerHttpPort
    for (const [value, expected] of [[true, true], [false, false], ['true', false], [1, false], [new Error('PRIVATE_SWITCH_CANARY'), false]] as const) {
      expect(await dispatch('GET', undefined, f.value, { owner: owner(value) }))
        .toEqual({ status: 200, result: { ok: true, data: { ...ready(), sendEnabled: expected } } })
    }
    expect(await dispatch('POST', input(), f.value, { owner: owner(true) }))
      .toEqual({ status: 201, result: { ok: true, data: { ...initialized(), sendEnabled: true } } })
    reads.length = 0
    const denied: YidaInitializationHttpPort = { ...f.value, async status() { throw new YidaInitializationError('DENIED') } }
    expect(await dispatch('GET', undefined, denied, { owner: owner(true) }))
      .toEqual({ status: 403, result: { ok: false, error: { code: 'YIDA_INITIALIZATION_DENIED' } } })
    expect(reads).toEqual([])
  })
  it('ENCRYPTION_NOT_READY from the host is its own closed 503 code; a forged code string is not', async () => {
    const f = port()
    const refused: YidaInitializationHttpPort = { ...f.value, async initialize() { throw new YidaInitializationError('ENCRYPTION_NOT_READY') } }
    expect(await dispatch('POST', input(), refused))
      .toEqual({ status: 503, result: { ok: false, error: { code: 'YIDA_INITIALIZATION_ENCRYPTION_NOT_READY' } } })
    const forged: YidaInitializationHttpPort = { ...f.value, async initialize() {
      throw Object.assign(new Error('YIDA_INITIALIZATION_ENCRYPTION_NOT_READY'), { code: 'YIDA_INITIALIZATION_ENCRYPTION_NOT_READY' }) } }
    expect(await dispatch('POST', input(), forged)).toEqual({ status: 503, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_UNAVAILABLE' } } })
    // GET status is not gated on the material.
    expect(await dispatch('GET', undefined, refused)).toEqual({ status: 200, result: { ok: true, data: { ...ready(), sendEnabled: false } } })
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
  // L4 seals the material for good: a pasted line break or padding is refused, never trimmed or echoed.
  it.each([
    ['appKey', 'a trailing CR/LF', 'synthetic-http-app-key\r\n'], ['appSecret', 'a leading space', ' synthetic-http-app-secret'],
    ['systemToken', 'a trailing LF', 'synthetic-http-system-token\n'], ['systemToken', 'a leading NBSP', '\u00a0synthetic-http-system-token'],
    ['systemToken', 'a trailing ideographic space', 'synthetic-http-system-token\u3000'], ['systemToken', 'an inner TAB', 'synthetic-http\tsystem-token'],
    ['appSecret', 'an inner C1 control', 'synthetic-http\u0085app-secret'],
  ] as const)('a pasted %s with %s is 400 before host invocation', async (key, _label, value) => {
    const f = port(), request = input()
    expect(await dispatch('POST', { ...request, material: { ...request.material, [key]: value } }, f.value))
      .toEqual({ status: 400, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_INPUT' } } })
    expect(f.calls).toHaveLength(0)
  })
  // Cf (zero-width, bidi, BOM) and lone surrogates (Cs) survive trim(); L4 would seal them for good (J-F1).
  it.each([
    ['systemToken', 'a trailing zero-width space', `synthetic-http-system-token${codeUnit(0x200b)}`],
    ['appSecret', 'an inner zero-width space', `synthetic-http${codeUnit(0x200b)}app-secret`],
    ['appKey', 'a leading bidi embedding', `${codeUnit(0x202a)}synthetic-http-app-key`],
    ['systemToken', 'an inner right-to-left mark', `synthetic-http${codeUnit(0x200f)}system-token`],
    ['appSecret', 'an inner BOM', `synthetic-http${codeUnit(0xfeff)}app-secret`],
    ['systemToken', 'a lone surrogate', `synthetic-http${codeUnit(0xd800)}system-token`],
  ] as const)('a pasted %s with %s is 400 before host invocation (format character or lone surrogate)', async (key, _label, value) => {
    const f = port(), request = input()
    expect(await dispatch('POST', { ...request, material: { ...request.material, [key]: value } }, f.value))
      .toEqual({ status: 400, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_INPUT' } } })
    expect(f.calls).toHaveLength(0)
  })
  it('a userId with a zero-width space is 400 before host invocation even when executionIdentity equals it', async () => {
    const f = port(), request = input(), userId = `${request.material.userId}${codeUnit(0x200b)}`
    expect(await dispatch('POST', { ...request, material: { ...request.material, userId },
      attestation: { ...request.attestation, executionIdentity: userId } }, f.value))
      .toEqual({ status: 400, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_INPUT' } } })
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

// YD (owner 2026-11-07, R-88: an open question gets a configurable default). The route's closed bodies for the new options.
describe('YD configurable defaults at the HTTP boundary — no IO fake host port', () => {
  it('Q4 / D2: the initialization body takes the optional quantityRounding (the plugin owns its values) and never a config-level materialCodeForm', async () => {
    const f = port(), request = input()
    const split = { mode: 'equal_decimal_exact', projects: ['SYN-P1', 'SYN-P2'], projectField: 'projectNo', quantityField: 'quantity' }
    expect((await dispatch('POST', { ...request, draft: { ...request.draft, allocation: { ...split, quantityRounding: 'legacy-1dp' } } }, f.value)).status).toBe(201)
    expect(f.calls).toHaveLength(1)
    expect((f.calls[0].input as { draft: { allocation: unknown } }).draft.allocation).toEqual({ ...split, quantityRounding: 'legacy-1dp' })
    // Still closed: quantityRounding never rides on original, and no other key is admitted next to it. D2 (reworked after
    // verify-YD-r1 F1): the material-code form is a preset-part option of a v3 generated entry, sealed by the generated-
    // layout signature; the v2 initialization has no generated entry, so its body never takes a form (400, no port call).
    for (const draft of [
      { ...request.draft, allocation: { mode: 'original', quantityRounding: 'exact' } },
      { ...request.draft, allocation: { ...split, quantityRounding: 'exact', rounding: 'x' } },
      { ...request.draft, config: { ...request.draft.config, materialCodeForm: 'uuid-32' } },
      { ...request.draft, config: { ...request.draft.config, materialCodeForm: 'uuid-36' } },
    ]) expect((await dispatch('POST', { ...request, draft }, f.value)).status).toBe(400)
    expect(f.calls).toHaveLength(1)
  })

  // D17 b: INTEGRATION_YIDA_SHEET_SOURCE_ENABLED (the owner runtime's exact boolean). The harness wires no sheet-source
  // dependencies, so a body the route ADMITS onto the sheet path answers 503 there; a refused body is 400 first.
  const sheetBody = { config: draftInput().config, allocation: { mode: 'original' },
    source: { kind: 'sheet', sheetId: 'synthetic-sheet', projectNo: 'SYN-P1' } }
  const ownerPort = (multi: unknown, sheet: unknown) => {
    const calls: unknown[] = []
    const value = {
      sendEnabled: () => true, multiTargetEnabled: () => multi, sheetSourceEnabled: () => sheet,
      async prepareDraft(_owner: unknown, request: unknown) { calls.push(request); return initialized().draft },
      async proveDraftOwner() { return { proven: true } },
    } as unknown as YidaOwnerHttpPort
    return { value, calls }
  }
  const drafts = (body: unknown, owner: YidaOwnerHttpPort) => dispatch('POST', body, port().value, { url: '/drafts', owner })

  it('D17 b: with multi-target OFF the sheet source is admitted only while the switch bit is exactly true, never with a targetRef', async () => {
    for (const sheet of [false, undefined, 'true', 1]) {
      const f = ownerPort(false, sheet)
      expect((await drafts(sheetBody, f.value)).status, String(sheet)).toBe(400)
      // The original pasted body is unchanged while OFF.
      expect((await drafts({ ...draftInput() }, f.value)).status, String(sheet)).toBe(201)
      expect(f.calls).toEqual([{ ...draftInput() }])
    }
    const on = ownerPort(false, true)
    expect(await drafts(sheetBody, on.value)).toEqual({ status: 503, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_UNAVAILABLE' } } })
    expect((await drafts({ ...sheetBody, targetRef }, on.value)).status).toBe(400)
    expect((await drafts({ ...draftInput(), source: sheetBody.source }, on.value)).status).toBe(400)
    // Pasted rows on the switch-ON body: forwarded without a targetRef or a binding.
    expect((await drafts({ ...draftInput() }, on.value)).status).toBe(201)
    expect(on.calls).toEqual([{ ...draftInput() }])
    // A throwing bit is OFF.
    const throwing = { ...ownerPort(false, true).value, sheetSourceEnabled: () => { throw new Error('PRIVATE_SWITCH_CANARY') } } as unknown as YidaOwnerHttpPort
    expect((await drafts(sheetBody, throwing)).status).toBe(400)
    // Multi-target ON is unchanged by the bit: a targetRef is admitted onto the sheet path.
    for (const sheet of [false, true]) {
      expect((await drafts({ ...sheetBody, targetRef }, ownerPort(true, sheet).value)).status).toBe(503)
    }
  })
})
