import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { types } from 'node:util'
import ts from 'typescript'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type {
  YidaOwnerRuntimeBinding, YidaOwnerRuntimeDependencies,
} from '../../src/integration/yida-owner-runtime'

// CONTROL PATH ONLY. The native core import is substituted below to isolate
// registration, exact switch, cancellation and drain. These green tests do
// not prove JWT, ACL, permanent-owner equality, grants or PostgreSQL authority.
type RuntimeModule = typeof import('../../src/integration/yida-owner-runtime')
type CoreDependencies = {
  context: { actorId: string; tenantId: string; workspaceId: null }
  database: YidaOwnerRuntimeDependencies['database']
  security: YidaOwnerRuntimeDependencies['security']
  primitives: unknown
}
type FakeAuthority = {
  prepareDraft(input: unknown): Promise<unknown>
  preview(input: unknown): Promise<unknown>
  approvals: { approve(input: unknown): Promise<unknown>; revoke(input: unknown): Promise<unknown> }
  observe(input: unknown): Promise<unknown>
}
type Factory = (deps: CoreDependencies) => FakeAuthority
const nativeRequire = createRequire(import.meta.url)
const sourcePath = fileURLToPath(new URL('../../src/integration/yida-owner-runtime.ts', import.meta.url))
const originalSource = readFileSync(sourcePath, 'utf8')
const actor = Object.freeze({ actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null })
const grant = Object.freeze({ grantId: 'synthetic-grant' })
const selected = Object.freeze({ operationId: 'synthetic-operation', rowKey: 'synthetic-row' })
const approved = Object.freeze({ ...selected, confirmationId: 'synthetic-confirmation' })
const submission = Object.freeze({ ...grant, submissionId: 'synthetic-submission' })
const approval = Object.freeze({ ...grant, ...selected, targetRef: 'synthetic-target', approvedAt: 1, expiresAt: 100,
  maxAttempts: 1, remainingAttempts: 0, status: 'admitted', revoked: false,
  admissionId: 'synthetic-admission', ledgerId: 'synthetic-ledger', canSend: false, externalWriteAttempted: false })
const delivered = Object.freeze({ approval,
  delivery: Object.freeze({ id: 'synthetic-ledger', status: 'acknowledged', durable: true }),
  reused: false, status: 'acknowledged', externalWriteAttempted: true, businessVerified: false, durable: true })
function deferred<T = unknown>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function ticks() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function fakeAuthority(): FakeAuthority {
  return {
    prepareDraft: vi.fn(async () => Object.freeze({ operationId: 'synthetic-operation' })),
    preview: vi.fn(async () => selected),
    approvals: { approve: vi.fn(async () => approval), revoke: vi.fn(async () => approval) },
    observe: vi.fn(async () => Object.freeze({ approval, delivery: null })),
  }
}
function loadRuntime(factory: Factory, source = originalSource, ownCoreErrors = new WeakMap<object, string>()): RuntimeModule {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new Function('require', 'exports', compiled)((specifier: string) => {
    if (specifier === 'node:util') return { types }
    if (specifier === './yida-send-approval-service') return {
      createInternalYidaSendExecutionAuthority: factory,
      yidaSendApprovalErrorCode: (error: unknown) => ownCoreErrors.get(error as object),
    }
    throw new Error('Unexpected unit import')
  }, exports)
  return exports as RuntimeModule
}
function fixture(options: {
  source?: string; enablement?: unknown; readEnablement?: () => unknown
  factory?: Factory; database?: YidaOwnerRuntimeDependencies['database']
  security?: YidaOwnerRuntimeDependencies['security']; result?: unknown
} = {}) {
  const authority = fakeAuthority()
  const coreFactory = vi.fn(options.factory ?? (() => authority))
  const module = loadRuntime(coreFactory, options.source)
  const query = vi.fn<Queryable['query']>(async () => ({ rows: [{ synthetic: true }], rowCount: 7 }))
  const database = options.database ?? { transaction: vi.fn(async work => work({ query })) }
  const security = options.security ?? { encrypt: vi.fn(async text => `enc:${text}`), decrypt: vi.fn(async () => 'synthetic-plain') }
  const fetcher = vi.fn(async () => { throw new Error('No protocol IO in control unit tests') })
  const readEnablement = vi.fn(options.readEnablement ?? (() => Object.hasOwn(options, 'enablement') ? options.enablement : 'true'))
  const runtime = module.createYidaOwnerRuntime({ database, security, fetch: fetcher, readEnablement })
  const submit = vi.fn(async () => options.result ?? delivered)
  const createPrimitives = vi.fn(() => Object.freeze({}))
  const createSendPort = vi.fn(() => Object.freeze({ submit, inspect: vi.fn() }))
  const binding = { createPrimitives, createSendPort } as unknown as YidaOwnerRuntimeBinding
  return { module, runtime, binding, coreFactory, authority, database, security, query, fetcher, readEnablement, createPrimitives, createSendPort, submit }
}
async function active(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options)
  const registration = await f.runtime.createPluginCapability().activate(f.binding)
  return { ...f, registration }
}

const networkSpies: ReturnType<typeof vi.spyOn>[] = []
beforeAll(() => {
  for (const [module, methods] of [
    ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
    ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ] as const) {
    const api = nativeRequire(module)
    for (const method of methods) networkSpies.push(vi.spyOn(api, method).mockImplementation(() => { throw new Error('Native network forbidden') }))
  }
  networkSpies.push(vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('Native fetch forbidden') }))
})
afterEach(() => { for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled() })
afterAll(() => { for (const spy of networkSpies) spy.mockRestore() })

describe('Yida owner runtime control paths (NOT positive authority proof)', () => {
  it('registers while OFF without DB/material/network and copies the factory closures before any await', async () => {
    const f = fixture({ enablement: 'false' })
    const capability = f.runtime.createPluginCapability()
    const pending = capability.activate(f.binding)
    f.binding = { createPrimitives: () => { throw new Error('Replacement') }, createSendPort: () => { throw new Error('Replacement') } }
    await pending
    expect(f.createPrimitives).not.toHaveBeenCalled()
    expect(f.createSendPort).not.toHaveBeenCalled()
    expect(f.database.transaction).not.toHaveBeenCalled()
    expect(f.security.encrypt).not.toHaveBeenCalled()
    expect(f.security.decrypt).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
    await f.runtime.observe(actor, grant)
    await f.runtime.revoke(actor, grant)
    expect(f.coreFactory).toHaveBeenCalledTimes(2)
    const captured = f.coreFactory.mock.calls[0][0]
    expect(captured.context).toEqual(actor)
    expect(Object.isFrozen(captured.context)).toBe(true)
    expect(Object.keys(captured.security).sort()).toEqual(['decrypt', 'encrypt'])
    expect(Object.keys(f.createPrimitives.mock.calls[0][0]).sort()).toEqual(['actorId', 'tenantId', 'workspaceId'])
    expect(f.readEnablement).not.toHaveBeenCalled()
    await expect(f.runtime.prepareDraft(actor, { config: {}, rowsText: '[]' })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
    await expect(f.runtime.preview(actor, selected)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
    await expect(f.runtime.approve(actor, approved)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
    await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
    await f.runtime.stop()
  })

  it.each([undefined, null, false, true, 1, 'TRUE', 'true ', new String('true')])('rejects nonliteral enablement %s', async value => {
    const f = await active({ enablement: value })
    await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
    expect(f.createPrimitives).not.toHaveBeenCalled()
    expect(f.createSendPort).not.toHaveBeenCalled()
    await f.runtime.stop()
  })

  it('observes rejected native switch promises without admitting or leaking unhandled rejection', async () => {
    const errors: unknown[] = [], listener = (error: unknown) => errors.push(error)
    process.on('unhandledRejection', listener)
    try {
      const f = await active({ readEnablement: () => Promise.reject(new Error('synthetic-private-switch')) })
      await expect(f.runtime.preview(actor, selected)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(errors).toEqual([])
      await f.runtime.stop()
    } finally { process.off('unhandledRejection', listener) }
  })

  it('makes capabilities one use and rejects stale capabilities and malformed bindings without touching getters/proxies', async () => {
    const f = fixture()
    const stale = f.runtime.createPluginCapability(), fresh = f.runtime.createPluginCapability()
    await expect(stale.activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' })
    await fresh.activate(f.binding)
    await expect(fresh.activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' })
    await f.runtime.deactivate()
    const get = vi.fn(() => { throw new Error('Getter touched') })
    const invalid = Object.defineProperty({ createSendPort: f.binding.createSendPort }, 'createPrimitives', { enumerable: true, get })
    await expect(f.runtime.createPluginCapability().activate(invalid as YidaOwnerRuntimeBinding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    expect(get).not.toHaveBeenCalled()
    const traps = vi.fn(() => { throw new Error('Proxy touched') })
    const proxy = new Proxy({}, { get: traps, getPrototypeOf: traps, ownKeys: traps })
    await expect(f.runtime.createPluginCapability().activate(proxy as YidaOwnerRuntimeBinding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    expect(traps).not.toHaveBeenCalled()
    await f.runtime.stop()
  })

  it('captures mutable binding functions and passes EXACT trusted contexts/options to actual factory slots', async () => {
    const f = fixture()
    const original = f.binding as { createPrimitives: YidaOwnerRuntimeBinding['createPrimitives']; createSendPort: YidaOwnerRuntimeBinding['createSendPort'] }
    await f.runtime.createPluginCapability().activate(original)
    original.createPrimitives = () => { throw new Error('mutated primitives') }
    original.createSendPort = () => { throw new Error('mutated sender') }
    await f.runtime.submit(actor, submission)
    expect(f.createPrimitives).toHaveBeenCalledTimes(1)
    expect(f.createSendPort).toHaveBeenCalledTimes(1)
    const options = f.createSendPort.mock.calls[0][0]
    expect(Object.keys(options).sort()).toEqual(['authority', 'context', 'fetch', 'readEnablement', 'timeoutMs'])
    expect(options.context).toEqual(actor)
    expect(options.authority).toBe(f.authority)
    expect(options.timeoutMs).toBe(10000)
    expect(Object.isFrozen(options)).toBe(true)
    await f.runtime.stop()
  })

  it('rejects caller identity additions, inherited fields, getters, proxies and closed execution/options extras', async () => {
    const f = await active()
    const getter = vi.fn(() => actor.actorId)
    const withGetter = Object.defineProperty({ tenantId: actor.tenantId, workspaceId: null }, 'actorId', { enumerable: true, get: getter })
    const invalid = [ { ...actor, ownerId: actor.actorId }, { ...actor, permission: true }, { ...actor, workspaceId: 'workspace' },
      Object.create(actor), withGetter, new Proxy(actor, {}) ]
    for (const scope of invalid) await expect(f.runtime.observe(scope, grant)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    expect(getter).not.toHaveBeenCalled()
    for (const extra of ['context', 'config', 'payload', 'permission', 'credential', 'fetch', 'readEnablement']) {
      await expect(f.runtime.submit(actor, { ...submission, [extra]: 'synthetic' })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
      await expect(f.runtime.submit(actor, submission, { [extra]: 'synthetic' })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    }
    for (const signal of [{}, Object.create(AbortSignal.prototype), new Proxy(new AbortController().signal, {})]) {
      await expect(f.runtime.submit(actor, submission, { signal })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
    }
    expect(f.coreFactory).not.toHaveBeenCalled()
    await f.runtime.stop()
  })

  it('closes admission and aborts the actual pending native signal synchronously; stop waits for the original promise', async () => {
    const f = await active(), pending = deferred(), settled = vi.fn()
    let originalSignal!: AbortSignal
    f.submit.mockImplementation((_input, options) => { originalSignal = options.signal; return pending.promise })
    const run = f.runtime.submit(actor, submission)
    await ticks()
    expect(Object.getPrototypeOf(originalSignal)).toBe(AbortSignal.prototype)
    expect(originalSignal.aborted).toBe(false)
    const stopping = f.runtime.stop()
    expect(originalSignal.aborted).toBe(true)
    expect(f.runtime.stop()).toBe(stopping)
    stopping.then(settled)
    await ticks()
    expect(settled).not.toHaveBeenCalled()
    await expect(f.runtime.observe(actor, grant)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' })
    expect(() => f.runtime.createPluginCapability()).toThrow('YIDA_OWNER_RUNTIME_INACTIVE')
    pending.resolve(delivered)
    await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' })
    await stopping
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('keeps caller cancellation pending until the plugin returns and prevents preaborted callers from admission', async () => {
    const f = await active(), pending = deferred(), caller = new AbortController()
    let signal!: AbortSignal
    f.submit.mockImplementation((_input, options) => { signal = options.signal; return pending.promise })
    const run = f.runtime.submit(actor, submission, { signal: caller.signal }), settled = vi.fn()
    run.then(settled, settled)
    await ticks()
    caller.abort()
    expect(signal.aborted).toBe(true)
    await ticks()
    expect(settled).not.toHaveBeenCalled()
    pending.resolve(delivered)
    await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' })
    const before = f.coreFactory.mock.calls.length
    await expect(f.runtime.submit(actor, submission, { signal: caller.signal })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' })
    expect(f.coreFactory).toHaveBeenCalledTimes(before)
    await f.runtime.stop()
  })

  it('uses the native aborted getter even if a signal acquires a shadow getter', async () => {
    const f = await active(), gate = deferred(), getter = vi.fn(() => false)
    f.submit.mockImplementation((_input, options) => {
      Object.defineProperty(options.signal, 'aborted', { get: getter })
      return gate.promise
    })
    const run = f.runtime.submit(actor, submission)
    await ticks()
    const stopping = f.runtime.stop()
    gate.resolve(delivered)
    await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' })
    await stopping
    expect(getter).not.toHaveBeenCalled()
  })

  it('deactivation drains before new registration and old stop handles cannot close a new generation', async () => {
    const f = await active(), pending = deferred()
    f.submit.mockImplementation(() => pending.promise)
    const run = f.runtime.submit(actor, submission)
    await ticks()
    const unused = f.runtime.createPluginCapability()
    const retiring = f.runtime.deactivate()
    expect(f.registration.stop()).toBe(retiring)
    await expect(unused.activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' })
    await expect(f.runtime.createPluginCapability().activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' })
    pending.resolve(delivered)
    await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' })
    await retiring
    const newRegistration = await f.runtime.createPluginCapability().activate(f.binding)
    await f.registration.stop()
    await expect(f.runtime.observe(actor, grant)).resolves.toEqual({ approval, delivery: null })
    await newRegistration.stop()
    await f.runtime.stop()
  })

  it('bounds all outstanding original runs at 32 and drains all pending work', async () => {
    const waits = Array.from({ length: 32 }, () => deferred()), authority = fakeAuthority()
    let ordinal = 0
    authority.observe = () => waits[ordinal++].promise
    const f = await active({ factory: () => authority })
    const runs = waits.map(() => f.runtime.observe(actor, grant))
    await expect(f.runtime.observe(actor, grant)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' })
    await ticks()
    expect(ordinal).toBe(32)
    const stopped = vi.fn(), stopping = f.runtime.stop()
    stopping.then(stopped)
    for (const wait of waits.slice(0, 31)) wait.resolve({ approval, delivery: null })
    await ticks()
    expect(stopped).not.toHaveBeenCalled()
    waits[31].resolve({ approval, delivery: null })
    for (const run of runs) await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' })
    await stopping
  })

  it('preserves raw rows/rowCount and rejects late query/security/COMMIT receipts without inventing rollback', async () => {
    const queryPending = deferred<{ rows: Record<string, unknown>[]; rowCount: number | null }>(), returned = { rows: [{ synthetic: true }], rowCount: 7 }
    const factory: Factory = deps => ({ ...fakeAuthority(), preview: () => deps.database.transaction(trx => trx.query('synthetic query')) })
    const f = await active({ factory })
    await expect(f.runtime.preview(actor, selected)).resolves.toEqual(returned)
    f.query.mockImplementation(() => queryPending.promise)
    const run = f.runtime.preview(actor, selected)
    await ticks()
    const stopping = f.runtime.stop(), done = vi.fn()
    stopping.then(done)
    await ticks()
    expect(done).not.toHaveBeenCalled()
    queryPending.resolve(returned)
    await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' })
    await stopping
    expect(f.query.mock.calls.map(call => call[0])).toEqual(['synthetic query', 'synthetic query'])

    const commit = deferred(), g = await active({ factory,
      database: { transaction: async work => { await work({ query: async () => returned }); await commit.promise; throw new Error('synthetic COMMIT response lost') } } })
    const committed = g.runtime.preview(actor, selected)
    await ticks()
    commit.resolve(null)
    await expect(committed).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' })
    expect(g.createSendPort).not.toHaveBeenCalled()
    await g.runtime.stop()
  })

  it('retains original host dependencies after a plugin waiter finishes early, and drains them before retirement', async () => {
    const gate = deferred<string>(), authority = fakeAuthority(), consumed = vi.fn()
    const f = await active({ factory: deps => {
      authority.preview = async () => {
        // Model the real token-client cancellation: its waiter can finish
        // while loadCredential/exchange remains genuinely outstanding.
        deps.security.decrypt('enc:synthetic').then(consumed, () => {})
        return selected
      }
      return authority
    }, security: { encrypt: async text => text, decrypt: () => gate.promise } })
    const run = f.runtime.preview(actor, selected), runDone = vi.fn()
    run.then(runDone, runDone)
    await ticks()
    expect(runDone).not.toHaveBeenCalled()
    const retiring = f.runtime.deactivate(), retired = vi.fn()
    retiring.then(retired)
    await ticks()
    expect(retired).not.toHaveBeenCalled()
    await expect(f.runtime.createPluginCapability().activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' })
    gate.resolve('synthetic-private')
    await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' })
    await retiring
    expect(consumed).not.toHaveBeenCalled()
    expect(runDone).toHaveBeenCalledTimes(1)
    await f.runtime.stop()
  })

  it('rechecks exact enablement after slow host queries, security and fetch, before exposing outputs', async () => {
    for (const kind of ['query', 'security', 'fetch']) {
      const gate = deferred(), read = vi.fn(() => 'true')
      const authority = fakeAuthority()
      const f = await active({ readEnablement: read, factory: deps => {
        authority.preview = () => kind === 'query'
          ? deps.database.transaction(trx => trx.query('synthetic query')) : deps.security.decrypt('enc:synthetic')
        return authority
      }, database: { transaction: work => work({ query: async () => { await gate.promise; return { rows: [], rowCount: 0 } } }) },
      security: { encrypt: async text => text, decrypt: async () => { await gate.promise; return 'synthetic-plain' } } })
      if (kind === 'fetch') {
        f.fetcher.mockImplementation(async () => { await gate.promise; return new Response('synthetic') })
        f.createSendPort.mockImplementation(options => ({ submit: async () => { await options.fetch('https://synthetic.invalid'); return delivered }, inspect: vi.fn() }))
      }
      const run = kind === 'fetch' ? f.runtime.submit(actor, submission) : f.runtime.preview(actor, selected)
      await ticks()
      read.mockReturnValue('false')
      gate.resolve(null)
      await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' })
      await f.runtime.stop()
    }
  })

  it('closes foreign proxy rejections without inspecting their properties, preserving only own core brands', async () => {
    const touched = vi.fn(() => { throw new Error('Foreign proxy trap') }), foreign = new Proxy({}, { get: touched, getPrototypeOf: touched, ownKeys: touched })
    const f = await active()
    f.authority.observe = async () => { throw foreign }
    const error = await f.runtime.observe(actor, grant).catch(reason => reason)
    expect(error.message).toBe('YIDA_OWNER_RUNTIME_UNAVAILABLE')
    expect(f.module.yidaOwnerRuntimeErrorCode(error)).toBe('YIDA_OWNER_RUNTIME_UNAVAILABLE')
    expect(f.module.yidaOwnerRuntimeErrorCode(foreign)).toBeUndefined()
    expect(touched).not.toHaveBeenCalled()
    await f.runtime.stop()
    const branded = new Error('fixed safe core error'), own = new WeakMap<object, string>([[branded, 'YIDA_SEND_APPROVAL_CONFLICT']])
    const authority = fakeAuthority()
    authority.observe = async () => { throw branded }
    const module = loadRuntime(() => authority, originalSource, own)
    const g = fixture()
    const runtime = module.createYidaOwnerRuntime({ database: g.database, security: g.security, fetch: g.fetcher })
    await runtime.createPluginCapability().activate(g.binding)
    await expect(runtime.observe(actor, grant)).rejects.toBe(branded)
    await runtime.stop()
  })

  it('projects a closed submit view and rejects execution authority/material additions', async () => {
    for (const key of ['permit', 'handle', 'credential', 'material', 'token', 'config']) {
      const f = await active({ result: { ...delivered, [key]: 'synthetic-private' } })
      await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
      await f.runtime.stop()
    }
    const f = await active()
    const output = await f.runtime.submit(actor, submission)
    expect(output).toEqual(delivered)
    expect(Object.isFrozen(output)).toBe(true)
    await f.runtime.stop()
  })
})

describe('in-memory guard mutation probes (no repository writes)', () => {
  it('kills each removed control guard with its behavioral assertion', async () => {
    type Probe = { name: string; from: string; to: string; test(source: string): Promise<void> }
    const deniedActor = async (source: string, supplied: unknown) => {
      const f = await active({ source })
      try { await expect(f.runtime.observe(supplied, grant)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' }) }
      finally { await f.runtime.stop() }
    }
    const probes: Probe[] = [
      { name: 'record/proxy', from: "types.isProxy(value) || Array.isArray(value)", to: 'Array.isArray(value)', test: source => deniedActor(source, new Proxy(actor, {})) },
      { name: 'record/prototype', from: "if (proto !== Object.prototype && proto !== null) fail('INPUT')", to: '', test: source => deniedActor(source, Object.assign(Object.create({ synthetic: true }), actor)) },
      { name: 'record/closed-keys', from: "typeof key !== 'string' || !keys.includes(key)", to: "typeof key !== 'string'", test: source => deniedActor(source, { ...actor, ownerId: actor.actorId }) },
      { name: 'record/required-keys', from: "|| required.some(key => !Object.hasOwn(descriptors, key))", to: '', test: async source => {
        const f = await active({ source })
        try { await expect(f.runtime.prepareDraft(actor, { rowsText: '[]' })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'record/data-descriptors', from: "if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')", to: '', test: source => deniedActor(source, Object.defineProperty({ ...actor }, 'actorId', { value: actor.actorId, enumerable: false })) },
      { name: 'identity/null-workspace', from: "if (input.workspaceId !== null) fail('INPUT')", to: '', test: source => deniedActor(source, { ...actor, workspaceId: 'synthetic-workspace' }) },
      { name: 'identity/canonical-id', from: "|| value.trim() !== value", to: '', test: source => deniedActor(source, { ...actor, actorId: ' synthetic-owner' }) },
      { name: 'draft/bounded-text', from: "|| Buffer.byteLength(parsed.rowsText, 'utf8') > 16 * 1024 * 1024", to: '', test: async source => {
        const f = await active({ source })
        try { await expect(f.runtime.prepareDraft(actor, { config: {}, rowsText: 'x'.repeat(16 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'switch/exact-literal', from: "if (value !== 'true')", to: 'if (!value)', test: async source => {
        const f = await active({ source, enablement: true })
        try { await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'switch/default-OFF', from: "dependencies.readEnablement ?? (() => 'false')", to: "dependencies.readEnablement ?? (() => 'true')", test: async source => {
        const f = fixture({ source })
        const runtime = f.module.createYidaOwnerRuntime({ database: f.database, security: f.security, fetch: f.fetcher })
        await runtime.createPluginCapability().activate(f.binding)
        try { await expect(runtime.preview(actor, selected)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' }) }
        finally { await runtime.stop() }
      } },
      { name: 'dependencies/bounded-timeout', from: '|| !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000', to: '', test: async source => {
        const f = fixture({ source })
        expect(() => f.module.createYidaOwnerRuntime({ database: f.database, security: f.security, fetch: f.fetcher, timeoutMs: 1 })).toThrow('YIDA_OWNER_RUNTIME_INPUT')
        await f.runtime.stop()
      } },
      { name: 'capability/generation', from: '|| generation !== capabilityGeneration', to: '', test: async source => {
        const f = fixture({ source }), stale = f.runtime.createPluginCapability()
        f.runtime.createPluginCapability()
        try { await expect(stale.activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'capability/one-use', from: 'terminal || used || generation', to: 'terminal || generation', test: async source => {
        const f = fixture({ source }), capability = f.runtime.createPluginCapability()
        await expect(capability.activate({ unexpected: true })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' })
        try { await expect(capability.activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'capability/singleton', from: 'generation !== capabilityGeneration || active', to: 'generation !== capabilityGeneration', test: async source => {
        const f = await active({ source })
        try { await expect(f.runtime.createPluginCapability().activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'capability/proxy-functions', from: "typeof closed[key] !== 'function' || types.isProxy(closed[key])", to: "typeof closed[key] !== 'function'", test: async source => {
        const f = fixture({ source }), binding = { ...f.binding, createPrimitives: new Proxy(f.binding.createPrimitives, {}) }
        try { await expect(f.runtime.createPluginCapability().activate(binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'capability/captured-closure', from: "closed.createPrimitives as YidaOwnerRuntimeBinding['createPrimitives']", to: 'context => binding.createPrimitives(context)', test: async source => {
        const f = await active({ source })
        const binding = f.binding as { createPrimitives: YidaOwnerRuntimeBinding['createPrimitives'] }
        binding.createPrimitives = () => { throw new Error('mutated binding') }
        try { await expect(f.runtime.observe(actor, grant)).resolves.toEqual({ approval, delivery: null }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'capability/retirement-generation', from: 'if (active === state && !state.closed) ++capabilityGeneration', to: '', test: async source => {
        const f = await active({ source }), stale = f.runtime.createPluginCapability()
        await f.registration.stop()
        try { await expect(stale.activate(f.binding)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'shutdown/terminal-capability', from: "if (terminal) fail('INACTIVE')", to: '', test: async source => {
        const f = fixture({ source })
        await f.runtime.stop()
        expect(() => f.runtime.createPluginCapability()).toThrow('YIDA_OWNER_RUNTIME_INACTIVE')
      } },
      { name: 'admission/bound32', from: "if (state.runs.size >= MAX_RUNS) fail('UNAVAILABLE')", to: '', test: async source => {
        const gate = deferred(), f = await active({ source, factory: () => ({ ...fakeAuthority(), observe: () => gate.promise }) })
        const runs = Array.from({ length: 32 }, () => f.runtime.observe(actor, grant))
        const extra = f.runtime.observe(actor, grant)
        // Resolve before assertion: a removed bound must fail promptly rather
        // than leave this mutation probe waiting forever.
        gate.resolve({ approval, delivery: null })
        try { await expect(extra).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' }) }
        finally { await Promise.allSettled(runs); await f.runtime.stop() }
      } },
      { name: 'admission/active-registration', from: "if (terminal || !state || state.closed) fail('INACTIVE')", to: '', test: async source => {
        const f = fixture({ source })
        try { await expect(f.runtime.observe(actor, grant)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INACTIVE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'signal/native-brand', from: "try { abortedGetter.call(signal) } catch { fail('INPUT') }", to: '', test: async source => {
        const f = await active({ source })
        try { await expect(f.runtime.submit(actor, submission, { signal: Object.create(AbortSignal.prototype) })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'signal/native-prototype', from: '|| Object.getPrototypeOf(signal) !== AbortSignal.prototype', to: '', test: async source => {
        const f = await active({ source }), controller = new AbortController()
        Object.setPrototypeOf(controller.signal, Object.create(AbortSignal.prototype))
        try { await expect(f.runtime.submit(actor, submission, { signal: controller.signal })).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'signal/preabort-admission', from: "if (caller && abortedGetter.call(caller)) fail('CANCELLED')", to: '', test: async source => {
        const f = await active({ source }), caller = new AbortController()
        caller.abort()
        const run = f.runtime.submit(actor, submission, { signal: caller.signal })
        try { expect(f.readEnablement).not.toHaveBeenCalled(); await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' }) }
        finally { await run.catch(() => {}); await f.runtime.stop() }
      } },
      { name: 'lifetime/abort-before-await', from: 'for (const run of state.runs) run.controller.abort()', to: '', test: async source => {
        const f = await active({ source }), gate = deferred()
        let signal!: AbortSignal
        f.submit.mockImplementation((_input, options) => { signal = options.signal; return gate.promise })
        const run = f.runtime.submit(actor, submission)
        await ticks()
        const stopping = f.runtime.stop()
        try { expect(signal.aborted).toBe(true) }
        finally { gate.resolve(delivered); await run.catch(() => {}); await stopping }
      } },
      { name: 'lifetime/reject-late-output', from: "if (abortedGetter.call(controller.signal)) fail('CANCELLED')", to: '', test: async source => {
        const gate = deferred<string>(), caught = vi.fn()
        const f = await active({ source, factory: deps => ({ ...fakeAuthority(), preview: async () => {
          try { await deps.security.decrypt('enc:synthetic') }
          catch (error) { caught(f.module.yidaOwnerRuntimeErrorCode(error)) }
          return selected
        } }), security: { encrypt: async text => text, decrypt: () => gate.promise } })
        const run = f.runtime.preview(actor, selected)
        await ticks()
        const stopping = f.runtime.stop()
        gate.resolve('synthetic-private')
        await run.catch(() => {})
        try { expect(caught).toHaveBeenCalledWith('YIDA_OWNER_RUNTIME_CANCELLED') }
        finally { await stopping }
      } },
      { name: 'drain/original-pending', from: 'Promise.allSettled([...state.runs].map(run => run.pending))', to: 'Promise.resolve([])', test: async source => {
        const f = await active({ source }), gate = deferred()
        f.submit.mockImplementation(() => gate.promise)
        const run = f.runtime.submit(actor, submission)
        await ticks()
        const stopping = f.runtime.stop(), done = vi.fn()
        stopping.then(done)
        await ticks()
        try { expect(done).not.toHaveBeenCalled() }
        finally { gate.resolve(delivered); await run.catch(() => {}); await stopping }
      } },
      { name: 'drain/reuse-original', from: 'if (state.draining) return state.draining', to: '', test: async source => {
        const f = await active({ source })
        const first = f.registration.stop(), second = f.registration.stop()
        try { expect(second).toBe(first) }
        finally { await Promise.allSettled([first, second]); await f.runtime.stop() }
      } },
      { name: 'drain/original-host-dependencies', from: 'while (run.dependencies.size > 0) await Promise.allSettled([...run.dependencies])', to: '', test: async source => {
        const gate = deferred<string>(), f = await active({ source, factory: deps => ({ ...fakeAuthority(), preview: async () => {
          deps.security.decrypt('enc:synthetic').catch(() => {})
          return selected
        } }), security: { encrypt: async text => text, decrypt: () => gate.promise } })
        const run = f.runtime.preview(actor, selected), done = vi.fn()
        run.then(done, done)
        await ticks()
        await ticks()
        try { expect(done).not.toHaveBeenCalled() }
        finally { gate.resolve('synthetic-private'); await run.catch(() => {}); await f.runtime.stop() }
      } },
      { name: 'drain/reject-retired-output', from: "if (terminal || state.closed || state !== active || (caller && abortedGetter.call(caller))) fail('CANCELLED')", to: '', test: async source => {
        const gate = deferred<string>(), f = await active({ source, factory: deps => ({ ...fakeAuthority(), preview: async () => {
          deps.security.decrypt('enc:synthetic').catch(() => {})
          return selected
        } }), security: { encrypt: async text => text, decrypt: () => gate.promise } })
        const run = f.runtime.preview(actor, selected)
        await ticks()
        await ticks()
        const stopping = f.runtime.deactivate()
        gate.resolve('synthetic-private')
        try { await expect(run).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_CANCELLED' }) }
        finally { await stopping; await f.runtime.stop() }
      } },
      { name: 'query/reject-late-receipt', from: 'return checked(() => raw.query(sql, params))', to: 'return raw.query(sql, params)', test: async source => {
        const gate = deferred<{ rows: Record<string, unknown>[]; rowCount: number | null }>(), consumed = vi.fn()
        const f = await active({ source, factory: deps => ({ ...fakeAuthority(), preview: () => deps.database.transaction(async trx => {
          const returned = await trx.query('synthetic query')
          consumed(returned)
          return selected
        }) }), database: { transaction: work => work({ query: () => gate.promise }) } })
        const run = f.runtime.preview(actor, selected)
        await ticks()
        const stopping = f.runtime.stop()
        gate.resolve({ rows: [{ synthetic: true }], rowCount: 7 })
        await run.catch(() => {})
        try { expect(consumed).not.toHaveBeenCalled() }
        finally { await stopping }
      } },
      { name: 'security/reject-late-receipt', from: 'decrypt(value: string) { return checked(() => decrypt(value)) }', to: 'decrypt(value: string) { return decrypt(value) }', test: async source => {
        const gate = deferred<string>(), consumed = vi.fn()
        const f = await active({ source, factory: deps => ({ ...fakeAuthority(), preview: async () => {
          consumed(await deps.security.decrypt('enc:synthetic'))
          return selected
        } }), security: { encrypt: async text => text, decrypt: () => gate.promise } })
        const run = f.runtime.preview(actor, selected)
        await ticks()
        const stopping = f.runtime.stop()
        gate.resolve('synthetic-private')
        await run.catch(() => {})
        try { expect(consumed).not.toHaveBeenCalled() }
        finally { await stopping }
      } },
      { name: 'transaction/reject-late-COMMIT', from: 'return checked(() => transaction(async raw => {', to: 'return transaction(async raw => {', test: async source => {
        const gate = deferred(), consumed = vi.fn()
        const f = await active({ source, factory: deps => ({ ...fakeAuthority(), preview: async () => {
          consumed(await deps.database.transaction(async () => selected))
          return selected
        } }), database: { transaction: async work => {
          const output = await work({ query: async () => ({ rows: [], rowCount: 0 }) })
          await gate.promise
          return output
        } } })
        const run = f.runtime.preview(actor, selected)
        await ticks()
        const stopping = f.runtime.stop()
        gate.resolve(null)
        await run.catch(() => {})
        try { expect(consumed).not.toHaveBeenCalled() }
        finally { await stopping }
      } },
      { name: 'port/closed-return', from: "['submit', 'inspect'], ['submit'])", to: "['submit', 'inspect', 'material'], ['submit'])", test: async source => {
        const f = await active({ source })
        f.createSendPort.mockImplementation(() => ({ submit: f.submit, inspect: vi.fn(), material: 'synthetic-private' }))
        try { await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'port/proxy-submit', from: "typeof port.submit !== 'function' || types.isProxy(port.submit)", to: "typeof port.submit !== 'function'", test: async source => {
        const f = await active({ source })
        f.createSendPort.mockImplementation(() => ({ submit: new Proxy(f.submit, {}), inspect: vi.fn() }))
        try { await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'output/closed-projection', from: "return submitView(response, parsed.grantId)", to: 'return response', test: async source => {
        const f = await active({ source, result: { ...delivered, permit: 'synthetic-private' } })
        try { await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_INPUT' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'output/safe-metadata', from: 'raw.canSend !== false', to: 'false', test: async source => {
        const f = await active({ source, result: { ...delivered, approval: Object.freeze({ ...approval, canSend: true }) } })
        try { await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'output/no-business-proof', from: 'raw.businessVerified !== false', to: 'false', test: async source => {
        const f = await active({ source, result: { ...delivered, businessVerified: true } })
        try { await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'output/bounded-clock', from: "if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 1) fail('UNAVAILABLE')", to: '', test: async source => {
        const f = await active({ source, result: { ...delivered, approval: Object.freeze({ ...approval, approvedAt: 0 }) } })
        try { await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'output/durable-delivery-status', from: "if (!DELIVERY_STATES.has(row.status as string) || row.durable !== true) fail('UNAVAILABLE')", to: '', test: async source => {
        const f = await active({ source, result: { ...delivered, delivery: { ...delivered.delivery, status: 'synthetic-unknown-state' } } })
        try { await expect(f.runtime.submit(actor, submission)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_UNAVAILABLE' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'errors/own-runtime-brand', from: 'if (own) fail(own)', to: '', test: async source => {
        const f = await active({ source, enablement: 'false' })
        try { await expect(f.runtime.preview(actor, selected)).rejects.toMatchObject({ code: 'YIDA_OWNER_RUNTIME_DISABLED' }) }
        finally { await f.runtime.stop() }
      } },
      { name: 'errors/only-own-core-brand', from: "if (yidaSendApprovalErrorCode(error) !== undefined) throw error", to: '', test: async source => {
        const branded = new Error('fixed safe core error'), own = new WeakMap<object, string>([[branded, 'YIDA_SEND_APPROVAL_CONFLICT']])
        const authority = fakeAuthority(), f = fixture()
        authority.observe = async () => { throw branded }
        const runtime = loadRuntime(() => authority, source, own).createYidaOwnerRuntime({ database: f.database, security: f.security, fetch: f.fetcher })
        await runtime.createPluginCapability().activate(f.binding)
        try { await expect(runtime.observe(actor, grant)).rejects.toBe(branded) }
        finally { await runtime.stop() }
      } },
    ]
    const killed: string[] = []
    for (const probe of probes) {
      expect(originalSource.includes(probe.from), probe.name).toBe(true)
      await probe.test(originalSource)
      let mutation = originalSource.replace(probe.from, probe.to)
      if (probe.name === 'transaction/reject-late-COMMIT') mutation = mutation.replace('          }))\n        },', '          })\n        },')
      const syntax = ts.transpileModule(mutation, { reportDiagnostics: true,
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).diagnostics
      expect(syntax?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error), `${probe.name} mutation must parse`).toEqual([])
      let red = false
      try { await probe.test(mutation) } catch { red = true }
      expect(red, `Removing ${probe.name} must make its behavioral test red`).toBe(true)
      killed.push(probe.name)
    }
    console.log(`YIDA_OWNER_RUNTIME_MUTATIONS killed=${killed.length}/${probes.length} ${killed.join(', ')}`)
  })
})
