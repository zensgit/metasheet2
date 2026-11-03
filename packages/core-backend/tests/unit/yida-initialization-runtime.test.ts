import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { types } from 'node:util'
import ts from 'typescript'
import winston from 'winston'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as authority from '../../src/integration/automation-live-authority'
import * as bootstrap from '../../src/integration/yida-initialization-bootstrap'
import * as encryptedSecrets from '../../src/security/encrypted-secrets'
import * as requestContext from '../../src/context/request-context'
import * as coreLogger from '../../src/core/logger'
import { createYidaInitializationRuntime, getYidaSealMaterialIssues, YIDA_SHORT_SEAL_MATERIAL_WARNING, yidaInitializationErrorCode,
  type YidaInitializationInput, type YidaInitializationRuntimeBinding } from '../../src/integration/yida-initialization-runtime'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

// CONTROL/QUERY CONTRACT ONLY: actual ACL code is called over a synthetic query
// model. This is not PostgreSQL/JWT/actual-producer positive authority evidence.
// The separate realdb suite exercises the actual SQL schema and producer graph.
type Row = Record<string, unknown>
type State = { anchor?: Row; result?: Row; target?: Row; material?: Row; operation?: Row; members?: Row[] }
const actor = Object.freeze({ actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null })
const secondAdmin = Object.freeze({ ...actor, actorId: 'synthetic-second-admin' })
const commandId = '00000000-0000-4000-8000-000000000001'
// Invisible test characters are built from code units at run time, so the source holds neither a raw
// invisible character nor an escape that an editor could rewrite into one.
const codeUnit = (code: number) => String.fromCharCode(code)
const targetRef = '00000000-0000-4000-8000-000000000002'
const operationId = '00000000-0000-4000-8000-000000000003'
const credentialRef = '00000000-0000-4000-8000-000000000004'
const draftTargetRef = '00000000-0000-4000-8000-000000000005'
const rowKey = '00000000-0000-4000-8000-000000000006'
const draft = Object.freeze({ targetRef: draftTargetRef, operationId, status: 'unverified', identityKind: 'local-unverified',
  canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false,
  rowCount: 1, rows: Object.freeze([Object.freeze({ rowKey, index: 0 })]), reused: false })
const input = (): YidaInitializationInput => ({ commandId,
  material: { appKey: 'synthetic app', appSecret: 'synthetic secret', systemToken: 'synthetic token', userId: 'synthetic-user' },
  draft: { config: { target: { form: 'synthetic-form' } }, rowsText: '[{"synthetic":true}]', allocation: { mode: 'original' } },
  attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review', organizationId: 'synthetic-org', executionIdentity: 'synthetic-user' } })
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const emptyAnchor = (): Row => ({ slot: 1, command_id: commandId, owner_id: actor.actorId, tenant_id: actor.tenantId, workspace_id: null })
function loadTestModule<T>(source: string, resolve: (name: string) => unknown): T {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const exports = {}
  new Function('require', 'exports', compiled)(resolve, exports)
  return exports as T
}
function loadMutant(source: string, logger = coreLogger): typeof import('../../src/integration/yida-initialization-runtime') {
  return loadTestModule(source, (specifier: string) => {
    if (specifier === 'node:util') return { types }
    if (specifier === './automation-live-authority') return authority
    if (specifier === './yida-initialization-bootstrap') return bootstrap
    if (specifier === '../security/encrypted-secrets') return encryptedSecrets
    if (specifier === '../context/request-context') return requestContext
    if (specifier === '../core/logger') return logger
    throw new Error('Unexpected isolated module import')
  })
}
// L4 refuses unless ENCRYPTION_KEY / ENCRYPTION_SALT pass the production checks in EVERY NODE_ENV, and
// tests/setup.ts configures neither: each case starts from explicit synthetic, non-default material and
// gets the process environment back afterwards.
const syntheticEncryption = Object.freeze({ ENCRYPTION_KEY: 'synthetic-unit-encryption-key-0123456789abcdef',
  ENCRYPTION_SALT: 'synthetic-unit-encryption-salt-0123456789abcdef' })
function setEnv(key: string, value: string | undefined) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
let savedEnv: Array<[string, string | undefined]> = []
beforeEach(() => {
  savedEnv = ['NODE_ENV', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT'].map(key => [key, process.env[key]])
  for (const [key, value] of Object.entries(syntheticEncryption)) setEnv(key, value)
})
afterEach(() => { for (const [key, value] of savedEnv) setEnv(key, value) })
function fixture(options: { missing?: boolean; badXids?: boolean; badIsolation?: boolean;
  beforeQuery?: (sql: string) => Promise<void>; beforeCommit?: () => Promise<void>; lostCommit?: boolean;
  createRuntime?: typeof createYidaInitializationRuntime } = {}) {
  let state: State = { anchor: options.missing ? undefined : emptyAnchor() }, working = state, xid = 0
  let allowed = true, memberships = true, transactions = 0, commits = 0
  const sql: string[] = []
  const query: Queryable['query'] = vi.fn(async (text: string, params?: unknown[]) => {
    sql.push(text)
    await options.beforeQuery?.(text)
    let rows: Row[] = []
    if (text.includes('transaction_isolation')) rows = [{ isolation: options.badIsolation ? 'serializable' : 'read committed' }]
    else if (text.includes('pg_current_xact_id')) rows = [{ xid: options.badXids ? String(++xid) : 'synthetic-stable-xid' }]
    else if (text.includes('pg_advisory_xact_lock')) rows = [{}]
    else if (/FROM user_roles\b/u.test(text)) rows = allowed ? [{ role_id: 'admin' }] : []
    else if (/FROM role_permissions\b|FROM user_permissions\b/u.test(text)) rows = []
    else if (/FROM users\b/u.test(text)) rows = [{ id: params?.[0], role: allowed ? 'admin' : 'user', is_active: true, activation_status: 'activated', permissions: [] }]
    else if (/FROM user_orgs\b/u.test(text)) rows = memberships ? [{ user_id: params?.[0], org_id: params?.[1], is_active: true }] : []
    else if (/FROM user_namespace_admissions\b/u.test(text)) rows = []
    else if (text.startsWith('INSERT INTO integration_yida_initialization_anchor')) {
      working.anchor = { slot: 1, command_id: params?.[0], owner_id: params?.[1], tenant_id: params?.[2], workspace_id: null }
      rows = [working.anchor]
    } else if (text.startsWith('INSERT INTO integration_yida_initializations')) {
      working.result = { slot: 1, command_id: params?.[0], owner_id: params?.[1], tenant_id: params?.[2], workspace_id: null,
        target_ref: params?.[3], operation_id: params?.[4], credential_ref: params?.[5], credential_generation: 1 }
      rows = [working.result]
    } else if (text.includes('FROM integration_yida_initialization_anchor')) rows = working.anchor ? [working.anchor] : []
    else if (text.includes('FROM integration_yida_initializations')) rows = working.result ? [working.result] : []
    else if (text.includes('FROM integration_yida_approved_target')) rows = working.target ? [working.target] : []
    else if (text.includes('FROM integration_yida_credential_materials')) rows = working.material ? [working.material] : []
    else if (text.includes('FROM integration_yida_draft_operations')) {
      // Preserve the real 091 contract: scope comes from JOIN draft_targets,
      // not fictional owner/tenant columns on draft_operations.
      expect(text).toContain('JOIN integration_yida_draft_targets')
      rows = working.operation ? [working.operation] : []
    } else if (text.includes('FROM integration_yida_draft_rows')) rows = working.members ?? []
    else throw new Error('Unexpected synthetic query')
    return { rows, rowCount: rows.length }
  })
  const database: bootstrap.YidaInitializationDatabase = { async transaction<T>(work: (trx: Queryable) => Promise<T>) {
    transactions++; working = structuredClone(state)
    try {
      const result = await work({ query })
      await options.beforeCommit?.()
      state = working; commits++
      if (options.lostCommit) throw new Error('private commit acknowledgement')
      return result
    } finally { working = state }
  } }
  const initialize = vi.fn(async (_trx: Queryable, supplied: YidaInitializationInput) => {
    expect(Object.isFrozen(supplied)).toBe(true)
    expect(Object.getPrototypeOf((supplied.draft as Row).config)).toBe(Object.prototype)
    working.target = { slot: 1, target_ref: targetRef, tenant_id: actor.tenantId, workspace_id: null, owner_id: actor.actorId,
      operation_id: operationId, draft_target_ref: draftTargetRef, credential_ref: credentialRef, credential_generation: 1,
      evidence_version: 1, status: 'manually_confirmed' }
    working.material = { tenant_id: actor.tenantId, workspace_id: null, owner_id: actor.actorId, generation: 1, status: 'current' }
    working.operation = { tenant_id: actor.tenantId, workspace_id: null, owner_id: actor.actorId, target_ref: draftTargetRef,
      row_count: 1, target_status: 'unverified', operation_status: 'unverified' }
    working.members = [{ row_key: rowKey, ordinal: 0 }]
    return { draft, credentialRef, credentialGeneration: 1, targetRef }
  })
  const inspect = vi.fn(async () => ({ ...draft, reused: true }))
  const createProducer = vi.fn(() => ({ initializeInTransaction: initialize, inspectDraftInTransaction: inspect }))
  const security = { encrypt: vi.fn(async (value: string) => `enc:${value}`), decrypt: vi.fn(async () => 'synthetic') }
  const runtime = (options.createRuntime ?? createYidaInitializationRuntime)({ database, security })
  const binding: YidaInitializationRuntimeBinding = { createInitializationProducer: createProducer }
  return { runtime, database, binding, initialize, inspect, createProducer, security, sql, query,
    get state() { return state }, set allowed(value: boolean) { allowed = value }, set memberships(value: boolean) { memberships = value },
    get transactions() { return transactions }, get commits() { return commits } }
}
async function active(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options), registration = await f.runtime.createPluginCapability().activate(f.binding)
  return { f, registration }
}
const rejected = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code: `YIDA_INITIALIZATION_${code}` })

describe('initialization host control and exact persistence query contracts', () => {
  it('registers and derives ready while send is OFF, without crypto, producer or writes', async () => {
    const { f } = await active()
    expect(f.transactions).toBe(0)
    expect(await f.runtime.status(actor)).toEqual({ commandId, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false })
    expect(f.sql.findIndex(sql => sql.includes('FROM users'))).toBeLessThan(f.sql.findIndex(sql => sql.includes('pg_advisory_xact_lock')))
    expect(f.sql.some(sql => /INSERT|UPDATE|DELETE/u.test(sql))).toBe(false)
    expect(f.createProducer).not.toHaveBeenCalled()
    expect(f.security.encrypt).not.toHaveBeenCalled()
    expect(f.security.decrypt).not.toHaveBeenCalled()
  })
  it('rejects another qualified admin and different tenant before producer or state reads', async () => {
    const { f } = await active()
    await rejected(f.runtime.status(secondAdmin), 'DENIED')
    await rejected(f.runtime.status({ ...actor, tenantId: 'synthetic-other-tenant' }), 'DENIED')
    expect(f.createProducer).not.toHaveBeenCalled()
    expect(f.sql.some(sql => sql.includes('FROM integration_yida_initializations'))).toBe(false)
    expect(f.commits).toBe(0)
  })
  it('kills only the anchor equality guard with a qualified second-admin empty-slot status control', async () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/integration/yida-initialization-runtime.ts'), 'utf8')
    const guard = "if (anchor.owner_id !== actor.actorId || anchor.tenant_id !== actor.tenantId) fail('DENIED')"
    expect(source.split(guard)).toHaveLength(2)
    const { f } = await active({ createRuntime: loadMutant(source.replace(guard, '// mutation: anchor equality removed')).createYidaInitializationRuntime })
    // This MUST become unauthorized ready. No producer/FK/error can mask removal.
    expect((await f.runtime.status(secondAdmin)).status).toBe('ready')
    expect(f.createProducer).not.toHaveBeenCalled()
  })
  it.each(['acl', 'membership', 'missing', 'isolation', 'transaction'])('rejects failed prerequisite %s without initialization', async mode => {
    const { f } = await active({ missing: mode === 'missing', badIsolation: mode === 'isolation', badXids: mode === 'transaction' })
    if (mode === 'acl') f.allowed = false
    if (mode === 'membership') f.memberships = false
    await rejected(f.runtime.initialize(actor, input()), ['acl', 'membership'].includes(mode) ? 'DENIED' : 'UNAVAILABLE')
    expect(f.initialize).not.toHaveBeenCalled()
    expect(f.commits).toBe(0)
  })
  it('rechecks actual live authority each operation, not cached initial admission', async () => {
    const { f } = await active()
    await f.runtime.status(actor)
    f.allowed = false
    await rejected(f.runtime.initialize(actor, input()), 'DENIED')
    expect(f.initialize).not.toHaveBeenCalled()
  })
  it('rejects missing POST input, extra identity, accessors and absent allocation before any DB', async () => {
    const { f } = await active(), original = input()
    const getter = vi.fn(() => commandId)
    await rejected(f.runtime.initialize(actor, undefined as unknown as YidaInitializationInput), 'INPUT')
    await rejected(f.runtime.initialize(actor, { ...original, ownerId: actor.actorId } as YidaInitializationInput), 'INPUT')
    await rejected(f.runtime.initialize(actor, { ...original, draft: { config: {}, rowsText: '[]' } }), 'INPUT')
    await rejected(f.runtime.initialize(actor, { ...original, attestation: { ...(original.attestation as Row), executionIdentity: 'other-user' } }), 'INPUT')
    await rejected(f.runtime.initialize(actor, Object.defineProperty({ ...original }, 'commandId', { get: getter })), 'INPUT')
    expect(getter).not.toHaveBeenCalled(); expect(f.transactions).toBe(0)
  })
  // L4 seals the material for good: a pasted trailing line break must be refused, never trimmed or sealed.
  it.each([
    ['appKey', 'a trailing CR/LF', 'synthetic app\r\n'], ['appSecret', 'a leading space', ' synthetic secret'],
    ['systemToken', 'a trailing LF', 'synthetic token\n'], ['systemToken', 'a leading NBSP', '\u00a0synthetic token'],
    ['systemToken', 'a trailing ideographic space', 'synthetic token\u3000'], ['appSecret', 'an inner TAB', 'synthetic\tsecret'],
    ['appKey', 'an inner C1 control', 'synthetic\u0085app'], ['systemToken', 'an inner NUL', 'synthetic\u0000token'],
  ] as const)('refuses %s with %s as INPUT before any transaction, producer, crypto or write', async (key, _label, value) => {
    const { f } = await active(), original = input()
    await rejected(f.runtime.initialize(actor, { ...original, material: { ...(original.material as Row), [key]: value } }), 'INPUT')
    expect(f.transactions).toBe(0); expect(f.createProducer).not.toHaveBeenCalled(); expect(f.initialize).not.toHaveBeenCalled()
    expect(f.security.encrypt).not.toHaveBeenCalled(); expect(f.sql).toEqual([])
  })
  // Cf (zero-width, bidi, BOM) and lone surrogates (Cs) survive trim(); L4 would seal them for good (J-F1).
  it.each([
    ['systemToken', 'a trailing zero-width space', `synthetic token${codeUnit(0x200b)}`],
    ['appKey', 'an inner zero-width space', `synthetic${codeUnit(0x200b)}app`],
    ['appSecret', 'a leading bidi embedding', `${codeUnit(0x202a)}synthetic secret`],
    ['systemToken', 'an inner pop directional isolate', `synthetic${codeUnit(0x2069)}token`],
    ['systemToken', 'an inner BOM', `synthetic${codeUnit(0xfeff)}token`],
    ['appSecret', 'a lone surrogate', `synthetic${codeUnit(0xd800)}secret`],
  ] as const)('refuses %s with %s as INPUT before any transaction, producer, crypto or write (format character or lone surrogate)', async (key, _label, value) => {
    const { f } = await active(), original = input()
    await rejected(f.runtime.initialize(actor, { ...original, material: { ...(original.material as Row), [key]: value } }), 'INPUT')
    expect(f.transactions).toBe(0); expect(f.createProducer).not.toHaveBeenCalled(); expect(f.initialize).not.toHaveBeenCalled()
    expect(f.security.encrypt).not.toHaveBeenCalled(); expect(f.sql).toEqual([])
  })
  it('refuses a userId with a zero-width space as INPUT even when executionIdentity equals it', async () => {
    const { f } = await active(), original = input(), userId = `synthetic-user${codeUnit(0x200b)}`
    await rejected(f.runtime.initialize(actor, { ...original, material: { ...(original.material as Row), userId },
      attestation: { ...(original.attestation as Row), executionIdentity: userId } }), 'INPUT')
    expect(f.transactions).toBe(0); expect(f.createProducer).not.toHaveBeenCalled(); expect(f.initialize).not.toHaveBeenCalled()
    expect(f.security.encrypt).not.toHaveBeenCalled(); expect(f.sql).toEqual([])
  })
  it('preserves immutable original material and nested plain JSON while caller mutates after invoke', async () => {
    const { f } = await active(), supplied = input(), result = f.runtime.initialize(actor, supplied)
    ;(supplied.material as Row).appKey = 'changed'
    ;((supplied.draft as Row).config as Row).target = { form: 'changed' }
    expect((await result).status).toBe('initialized')
    expect((f.initialize.mock.calls[0][1].material as Row).appKey).toBe('synthetic app')
    expect(((f.initialize.mock.calls[0][1].draft as Row).config as Row).target).toEqual({ form: 'synthetic-form' })
    expect(f.commits).toBe(1)
    expect(Object.keys(f.initialize.mock.calls[0][0])).toEqual(['query'])
  })
  it('pins command, reads actual written state, inserts result once and inspects reused true after commit', async () => {
    const { f } = await active()
    await rejected(f.runtime.initialize(actor, { ...input(), commandId: '00000000-0000-4000-8000-000000000099' }), 'CONFLICT')
    const initialized = await f.runtime.initialize(actor, input())
    expect(initialized).toMatchObject({ commandId, status: 'initialized', draft, canSend: false, tokenIssued: false, externalWriteAttempted: false })
    await rejected(f.runtime.initialize(actor, input()), 'CONFLICT')
    expect(f.initialize).toHaveBeenCalledTimes(1)
    expect(await f.runtime.status(actor)).toMatchObject({ status: 'initialized', draft: { ...draft, reused: true } })
    expect(f.sql.filter(sql => sql.startsWith('INSERT INTO integration_yida_initializations'))).toHaveLength(1)
    expect(f.sql.some(sql => /(?:INSERT|UPDATE|DELETE).*integration_yida_initialization_anchor/u.test(sql))).toBe(false)
  })
  it.each(['legacy', 'missing-target', 'wrong-scope', 'wrong-row', 'wrong-count', 'bad-command'])('rejects unconfirmed/corrupt state %s', async mode => {
    const { f } = await active()
    if (mode === 'bad-command') f.state.anchor!.command_id = 'not-a-uuid'
    else {
      await f.runtime.initialize(actor, input())
      if (mode === 'legacy') delete f.state.result
      if (mode === 'missing-target') delete f.state.target
      if (mode === 'wrong-scope') f.state.operation!.owner_id = secondAdmin.actorId
      if (mode === 'wrong-row') f.state.members![0].row_key = '00000000-0000-4000-8000-000000000077'
      if (mode === 'wrong-count') f.state.operation!.row_count = 2
    }
    await rejected(f.runtime.status(actor), 'UNAVAILABLE')
  })
  it('cannot accept a fabricated receipt without actual target/material/operation/members', async () => {
    const { f } = await active()
    f.initialize.mockImplementationOnce(async () => ({ draft, credentialRef, credentialGeneration: 1, targetRef }))
    await rejected(f.runtime.initialize(actor, input()), 'UNAVAILABLE')
    expect(f.state.result).toBeUndefined(); expect(f.commits).toBe(0)
  })
  it('does not assume rollback or retry after COMMIT acknowledgement loss', async () => {
    const { f } = await active({ lostCommit: true })
    await rejected(f.runtime.initialize(actor, input()), 'UNAVAILABLE')
    expect(f.state.result?.command_id).toBe(commandId)
    expect(f.initialize).toHaveBeenCalledTimes(1); expect(f.commits).toBe(1)
    expect(yidaInitializationErrorCode({ code: 'YIDA_INITIALIZATION_INPUT' })).toBeUndefined()
    expect(yidaInitializationErrorCode(new bootstrap.YidaInitializationError('INPUT'))).toBe('YIDA_INITIALIZATION_INPUT')
    const foreign = new Proxy({}, { get() { throw new Error('must not inspect foreign rejection') } })
    expect(yidaInitializationErrorCode(foreign)).toBeUndefined()
  })
  it('post-COMMIT cancellation rejects uncertain control, with persisted state left for explicit status', async () => {
    const caller = new AbortController()
    const { f } = await active({ beforeCommit: async () => { caller.abort() } })
    await rejected(f.runtime.initialize(actor, input(), { signal: caller.signal }), 'CANCELLED')
    expect(f.state.result?.command_id).toBe(commandId); expect(f.commits).toBe(1)
    expect(f.initialize).toHaveBeenCalledTimes(1)
  })
  it('stop synchronously aborts then drains the actual pending COMMIT result before settling', async () => {
    const entered = deferred(), release = deferred()
    const { f } = await active({ beforeCommit: async () => { entered.resolve(); await release.promise } })
    const pending = f.runtime.initialize(actor, input())
    await entered.promise
    let drained = false
    const drain = f.runtime.stop().then(() => { drained = true })
    await Promise.resolve(); expect(drained).toBe(false)
    await rejected(f.runtime.status(actor), 'INACTIVE')
    release.resolve(); await rejected(pending, 'CANCELLED'); await drain
    expect(drained).toBe(true); expect(f.state.result?.command_id).toBe(commandId)
  })
  it('drains actual producer promise rather than cancelling its physical crypto work', async () => {
    const { f, registration } = await active(), entered = deferred(), release = deferred()
    f.initialize.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error('private crypto failure') })
    const pending = f.runtime.initialize(actor, input())
    await entered.promise
    let stopped = false
    const drain = registration.stop().then(() => { stopped = true })
    await Promise.resolve(); expect(stopped).toBe(false)
    release.resolve(); await rejected(pending, 'CANCELLED'); await drain
    expect(stopped).toBe(true); expect(f.commits).toBe(0)
    await rejected(f.runtime.status(actor), 'INACTIVE')
  })
})

describe('L4 refuses before any writer unless the encryption material passes the production checks, in every NODE_ENV', () => {
  const guard = "if (getEncryptionMaterialIssues(process.env).length > 0) fail('ENCRYPTION_NOT_READY')"
  const nodeEnvs = ['(unset)', 'development', 'test', 'Production', 'production'] as const
  const materials: Readonly<Record<string, Readonly<Record<'ENCRYPTION_KEY' | 'ENCRYPTION_SALT', string | undefined>>>> = {
    'both unset': { ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: undefined },
    'built-in defaults': { ENCRYPTION_KEY: encryptedSecrets.DEFAULT_ENCRYPTION_KEY, ENCRYPTION_SALT: encryptedSecrets.DEFAULT_ENCRYPTION_SALT },
    'whitespace-only key': { ENCRYPTION_KEY: ' \t ', ENCRYPTION_SALT: syntheticEncryption.ENCRYPTION_SALT },
    'empty key': { ENCRYPTION_KEY: '', ENCRYPTION_SALT: syntheticEncryption.ENCRYPTION_SALT },
    'default key only': { ENCRYPTION_KEY: encryptedSecrets.DEFAULT_ENCRYPTION_KEY, ENCRYPTION_SALT: syntheticEncryption.ENCRYPTION_SALT },
    'salt unset': { ENCRYPTION_KEY: syntheticEncryption.ENCRYPTION_KEY, ENCRYPTION_SALT: undefined },
    'default salt only': { ENCRYPTION_KEY: syntheticEncryption.ENCRYPTION_KEY, ENCRYPTION_SALT: encryptedSecrets.DEFAULT_ENCRYPTION_SALT },
  }
  function useEnvironment(nodeEnv: typeof nodeEnvs[number], material: Readonly<Record<string, string | undefined>>) {
    setEnv('NODE_ENV', nodeEnv === '(unset)' ? undefined : nodeEnv)
    for (const [key, value] of Object.entries(material)) setEnv(key, value)
  }
  it.each(nodeEnvs.flatMap(nodeEnv => Object.keys(materials).map(name => [nodeEnv, name] as const)))(
    'NODE_ENV %s, %s: ENCRYPTION_NOT_READY with no producer (so no crypto), write or fetch; the slot stays ready', async (nodeEnv, name) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      try {
        const { f } = await active()
        useEnvironment(nodeEnv, materials[name])
        await rejected(f.runtime.initialize(actor, input()), 'ENCRYPTION_NOT_READY')
        // At this layer every seal goes through the producer the binding creates (the runtime itself never calls
        // dependencies.security), so "no producer was created" is the no-crypto guarantee. The real host security
        // service is exercised by the real-DB suites.
        expect(f.createProducer).not.toHaveBeenCalled(); expect(f.initialize).not.toHaveBeenCalled()
        expect(f.sql.some(sql => /INSERT|UPDATE|DELETE/u.test(sql))).toBe(false)
        expect(f.commits).toBe(0); expect(f.state.result).toBeUndefined(); expect(f.state.target).toBeUndefined()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(await f.runtime.status(actor)).toEqual({ commandId, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false })
      } finally { fetchSpy.mockRestore() }
    })
  it.each(nodeEnvs)('NODE_ENV %s with valid synthetic material still initializes exactly once', async nodeEnv => {
    const { f } = await active()
    useEnvironment(nodeEnv, syntheticEncryption)
    expect((await f.runtime.initialize(actor, input())).status).toBe('initialized')
    expect(f.initialize).toHaveBeenCalledTimes(1); expect(f.commits).toBe(1)
  })
  // One material per refusal rule: the production checks (this describe) and each L4 seal-material rule
  // (getYidaSealMaterialIssues). Whichever check refuses, it runs behind the live ACL, anchor owner, command and slot
  // checks, so only the authorized anchor owner with an empty slot learns that the material is not ready.
  const ownerOnly: Readonly<Record<string, readonly [typeof materials[string], 'production checks' | 'seal material']>> = {
    'both unset': [materials['both unset'], 'production checks'],
    'a doc placeholder key': [{ ENCRYPTION_KEY: '<openssl rand -hex 32>', ENCRYPTION_SALT: syntheticEncryption.ENCRYPTION_SALT }, 'seal material'],
    'the documented sample values': [{ ENCRYPTION_KEY: 'your-32-byte-key-here', ENCRYPTION_SALT: 'your-salt-here' }, 'seal material'],
    'the built-in defaults swapped': [{ ENCRYPTION_KEY: encryptedSecrets.DEFAULT_ENCRYPTION_SALT, ENCRYPTION_SALT: encryptedSecrets.DEFAULT_ENCRYPTION_KEY }, 'seal material'],
    'KEY equal to SALT': [{ ENCRYPTION_KEY: syntheticEncryption.ENCRYPTION_KEY, ENCRYPTION_SALT: syntheticEncryption.ENCRYPTION_KEY }, 'seal material'],
  }
  it.each(Object.keys(ownerOnly))('%s: the readiness bit is the anchor owner\'s only: DENIED, a revoked ACL, a wrong command and an initialized slot keep their own codes', async name => {
    const [material, check] = ownerOnly[name]
    const { f } = await active()
    await f.runtime.initialize(actor, input())
    const fresh = await active()
    useEnvironment('development', material)
    expect(encryptedSecrets.getEncryptionMaterialIssues(process.env).length > 0).toBe(check === 'production checks')
    expect(getYidaSealMaterialIssues(process.env).length > 0).toBe(check === 'seal material')
    await rejected(fresh.f.runtime.initialize(secondAdmin, input()), 'DENIED')
    await rejected(fresh.f.runtime.initialize({ ...actor, tenantId: 'synthetic-other-tenant' }, input()), 'DENIED')
    await rejected(fresh.f.runtime.initialize(actor, { ...input(), commandId: '00000000-0000-4000-8000-000000000099' }), 'CONFLICT')
    await rejected(f.runtime.initialize(actor, input()), 'CONFLICT')
    fresh.f.allowed = false
    await rejected(fresh.f.runtime.initialize(actor, input()), 'DENIED')
    fresh.f.allowed = true
    // Positive control: the same material does refuse the anchor owner with an empty slot.
    await rejected(fresh.f.runtime.initialize(actor, input()), 'ENCRYPTION_NOT_READY')
    expect(fresh.f.createProducer).not.toHaveBeenCalled(); expect(fresh.f.commits).toBe(0); expect(f.initialize).toHaveBeenCalledTimes(1)
    // GET is untouched: status needs no encryption material and still decodes the sealed slot.
    expect((await f.runtime.status(actor)).status).toBe('initialized')
  })
  it('removing only the readiness guard lets the same request seal under the public defaults (negative assertion red)', async () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/integration/yida-initialization-runtime.ts'), 'utf8')
    expect(source.split(guard)).toHaveLength(2)
    const { f } = await active({ createRuntime: loadMutant(source.replace(guard, '// mutation: readiness guard removed')).createYidaInitializationRuntime })
    useEnvironment('development', materials['both unset'])
    expect((await f.runtime.initialize(actor, input())).status).toBe('initialized')
    expect(f.initialize).toHaveBeenCalledTimes(1); expect(f.commits).toBe(1)
    expect(f.state.result?.command_id).toBe(commandId)
  })
})

describe('L4 also refuses public or obviously invalid material that passes the production checks; short material only warns', () => {
  const sealGuard = "if (getYidaSealMaterialIssues(process.env).length > 0) fail('ENCRYPTION_NOT_READY')"
  const nodeEnvs = ['(unset)', 'development', 'production'] as const
  const tab = String.fromCharCode(9), long = syntheticEncryption
  const { DEFAULT_ENCRYPTION_KEY: defaultKey, DEFAULT_ENCRYPTION_SALT: defaultSalt } = encryptedSecrets
  type Material = Readonly<{ ENCRYPTION_KEY: string; ENCRYPTION_SALT: string }>
  // Every entry passes getEncryptionMaterialIssues (asserted per case), so only the L4 check can refuse it.
  const refused: Readonly<Record<string, Material>> = {
    '(a) both easy-start doc placeholders': { ENCRYPTION_KEY: '<openssl rand -hex 32>', ENCRYPTION_SALT: '<openssl rand -hex 32, generated separately>' },
    '(a) a padded angle-bracket key': { ENCRYPTION_KEY: `  <paste the generated key here>${tab}`, ENCRYPTION_SALT: long.ENCRYPTION_SALT },
    '(a) a placeholder salt only': { ENCRYPTION_KEY: long.ENCRYPTION_KEY, ENCRYPTION_SALT: '<openssl rand -hex 32, generated separately>' },
    '(a) the secret-management report samples': { ENCRYPTION_KEY: 'your-32-byte-key-here', ENCRYPTION_SALT: 'your-salt-here' },
    '(a) the report samples in another case': { ENCRYPTION_KEY: 'YOUR-32-BYTE-KEY-HERE', ENCRYPTION_SALT: 'Your-Salt-Here' },
    '(a) the dev-doc 32-hex sample pair': { ENCRYPTION_KEY: 'abcdef0123456789abcdef0123456789', ENCRYPTION_SALT: '0123456789abcdef0123456789abcdef' },
    '(a) the dev-doc 32-hex sample key in upper case': { ENCRYPTION_KEY: 'ABCDEF0123456789ABCDEF0123456789', ENCRYPTION_SALT: long.ENCRYPTION_SALT },
    '(b) both built-in defaults swapped': { ENCRYPTION_KEY: defaultSalt, ENCRYPTION_SALT: defaultKey },
    '(b) the default salt as the key': { ENCRYPTION_KEY: defaultSalt, ENCRYPTION_SALT: long.ENCRYPTION_SALT },
    '(b) the default key as the salt': { ENCRYPTION_KEY: long.ENCRYPTION_KEY, ENCRYPTION_SALT: defaultKey },
    '(c) KEY equal to SALT': { ENCRYPTION_KEY: long.ENCRYPTION_KEY, ENCRYPTION_SALT: long.ENCRYPTION_KEY },
    '(c) KEY equal to SALT after trimming': { ENCRYPTION_KEY: ` ${long.ENCRYPTION_SALT}`, ENCRYPTION_SALT: `${long.ENCRYPTION_SALT}${tab}` },
  }
  const short: Readonly<Record<string, Material>> = {
    'a 1-character key and salt': { ENCRYPTION_KEY: 'k', ENCRYPTION_SALT: 's' },
    'a 31-character key': { ENCRYPTION_KEY: 'k'.repeat(31), ENCRYPTION_SALT: long.ENCRYPTION_SALT },
    'a key of 31 Unicode code points': { ENCRYPTION_KEY: '\u{1F512}'.repeat(31), ENCRYPTION_SALT: long.ENCRYPTION_SALT },
    'a padded salt of 31 Unicode code points': { ENCRYPTION_KEY: long.ENCRYPTION_KEY, ENCRYPTION_SALT: ` ${'\u{20000}'.repeat(31)} ` },
    'a salt 31 characters after trimming': { ENCRYPTION_KEY: long.ENCRYPTION_KEY, ENCRYPTION_SALT: ` ${'s'.repeat(31)} ` },
  }
  const sealed: Readonly<Record<string, Material>> = {
    '32-character key and salt': { ENCRYPTION_KEY: 'k'.repeat(32), ENCRYPTION_SALT: 's'.repeat(32) },
    '32 Unicode code points in each value': { ENCRYPTION_KEY: '\u{1F512}'.repeat(32), ENCRYPTION_SALT: '\u{20000}'.repeat(32) },
    'the long synthetic material': long,
  }
  function useEnvironment(nodeEnv: typeof nodeEnvs[number], material: Material) {
    setEnv('NODE_ENV', nodeEnv === '(unset)' ? undefined : nodeEnv)
    for (const [key, value] of Object.entries(material)) setEnv(key, value)
  }
  // Records each warning with the request and log contexts it is written in (the owner HTTP route runs L4 inside the
  // private observation surface, which would rewrite any message there). Nothing reaches the console.
  function recordWarnings() {
    const seen: Array<{ args: unknown[]; request: unknown; log: unknown }> = []
    const spy = vi.spyOn(coreLogger.Logger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
      seen.push({ args, request: requestContext.getRequestContext(), log: coreLogger.getLogContext() })
    })
    return { seen, spy }
  }
  const insideOwnerRequest = <T>(work: () => Promise<T>) => requestContext.runWithRequestContext({ correlationId: 'synthetic-correlation',
    privateObservationSurface: 'yida-owner-http', userId: 'synthetic-request-user', tenantId: 'synthetic-request-tenant' },
  () => coreLogger.runWithLogContext({ requestId: 'synthetic-request-id' }, work))

  it('omits the active OpenTelemetry span only from the short-material warning', async () => {
    // The container hoists the telemetry plugin's dependencies. Load the same optional API explicitly
    // here so a strict pnpm layout also exercises the traced path.
    const requireTelemetry = createRequire(path.resolve(__dirname, '../../../../plugins/plugin-telemetry-otel/package.json'))
    const api = requireTelemetry('@opentelemetry/api')
    const { NodeTracerProvider } = requireTelemetry('@opentelemetry/sdk-node').node
    const provider = new NodeTracerProvider()
    const fromTest = createRequire(__filename)
    const logger = loadTestModule<typeof coreLogger>(readFileSync(path.resolve(__dirname, '../../src/core/logger.ts'), 'utf8'), name => {
      if (name === '@opentelemetry/api') return api
      if (name === '../context/request-context') return requestContext
      return fromTest(name)
    })
    const source = readFileSync(path.resolve(__dirname, '../../src/integration/yida-initialization-runtime.ts'), 'utf8')
    const { f } = await active({ createRuntime: loadMutant(source, logger).createYidaInitializationRuntime })
    useEnvironment('production', short['a 1-character key and salt'])
    const entries: Row[] = []
    const capture = vi.spyOn(winston.transports.Console.prototype, 'log').mockImplementation((info, done) => {
      entries.push({ ...info }); done()
    })
    const traceId = '1'.repeat(32), spanId = '2'.repeat(16)
    const priorLevel = process.env.LOG_LEVEL
    try {
      setEnv('LOG_LEVEL', 'warn')
      provider.register({ propagator: null })
      const traced = api.trace.setSpanContext(api.ROOT_CONTEXT, { traceId, spanId, traceFlags: 1 })
      await api.context.with(traced, async () => {
        const control = new logger.Logger('TraceControl')
        control.warn('before')
        const result = await requestContext.runWithRequestContext({ correlationId: 'synthetic-owner',
          privateObservationSurface: 'yida-owner-http' }, () => logger.runWithLogContext({ requestId: 'synthetic-request' },
          () => f.runtime.initialize(actor, input())))
        expect(result.status).toBe('initialized')
        control.warn('after')
      })
      await new Promise(resolve => setImmediate(resolve))
      const controls = entries.filter(entry => entry.context === 'TraceControl')
      expect(controls).toMatchObject([{ message: 'before', traceId, spanId }, { message: 'after', traceId, spanId }])
      const warned = entries.filter(entry => entry.message === YIDA_SHORT_SEAL_MATERIAL_WARNING)
      expect(warned).toHaveLength(1)
      expect(Object.keys(warned[0]).sort()).toEqual(['context', 'level', 'message', 'service', 'timestamp'])
    } finally {
      setEnv('LOG_LEVEL', priorLevel)
      capture.mockRestore()
      api.context.disable(); api.trace.disable()
      await provider.shutdown()
    }
  })

  it.each(nodeEnvs.flatMap(nodeEnv => Object.keys(refused).map(name => [nodeEnv, name] as const)))(
    'NODE_ENV %s, %s: ENCRYPTION_NOT_READY with no producer, write, fetch or warning; the slot stays ready', async (nodeEnv, name) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch'), warnings = recordWarnings()
      try {
        const { f } = await active()
        useEnvironment(nodeEnv, refused[name])
        expect(encryptedSecrets.getEncryptionMaterialIssues(process.env)).toEqual([])
        const failure = await insideOwnerRequest(() => f.runtime.initialize(actor, input())).then(() => undefined, (error: unknown) => error)
        expect(failure).toMatchObject({ code: 'YIDA_INITIALIZATION_ENCRYPTION_NOT_READY', message: 'YIDA_INITIALIZATION_ENCRYPTION_NOT_READY' })
        expect(f.createProducer).not.toHaveBeenCalled(); expect(f.initialize).not.toHaveBeenCalled()
        expect(f.sql.some(sql => /INSERT|UPDATE|DELETE/u.test(sql))).toBe(false)
        expect(f.commits).toBe(0); expect(f.state.result).toBeUndefined(); expect(f.state.target).toBeUndefined()
        expect(fetchSpy).not.toHaveBeenCalled(); expect(warnings.seen).toEqual([])
        expect(await f.runtime.status(actor)).toEqual({ commandId, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false })
      } finally { fetchSpy.mockRestore(); warnings.spy.mockRestore() }
    })
  it.each(nodeEnvs.flatMap(nodeEnv => Object.keys(short).map(name => [nodeEnv, name] as const)))(
    'NODE_ENV %s, %s: seals once, then logs the one fixed warning outside the owner request and log contexts', async (nodeEnv, name) => {
      const warnings = recordWarnings()
      try {
        const { f } = await active()
        useEnvironment(nodeEnv, short[name])
        expect(getYidaSealMaterialIssues(process.env)).toEqual([])
        expect((await insideOwnerRequest(() => f.runtime.initialize(actor, input()))).status).toBe('initialized')
        expect(f.initialize).toHaveBeenCalledTimes(1); expect(f.commits).toBe(1)
        // One argument, no meta; written with no request context (so no correlation, user or tenant field and no
        // private-surface rewrite) and an empty log context (no request id).
        expect(warnings.seen).toEqual([{ args: [YIDA_SHORT_SEAL_MATERIAL_WARNING], request: undefined, log: {} }])
        await f.runtime.status(actor); expect(warnings.seen).toHaveLength(1)
      } finally { warnings.spy.mockRestore() }
    })
  it.each(nodeEnvs.flatMap(nodeEnv => Object.keys(sealed).map(name => [nodeEnv, name] as const)))(
    'NODE_ENV %s, %s: seals once with no warning', async (nodeEnv, name) => {
      const warnings = recordWarnings()
      try {
        const { f } = await active()
        useEnvironment(nodeEnv, sealed[name])
        expect((await f.runtime.initialize(actor, input())).status).toBe('initialized')
        expect(f.initialize).toHaveBeenCalledTimes(1); expect(f.commits).toBe(1); expect(warnings.seen).toEqual([])
      } finally { warnings.spy.mockRestore() }
    })
  it('short material whose initialization does not succeed logs no warning', async () => {
    const warnings = recordWarnings()
    try {
      const { f } = await active({ lostCommit: true })
      useEnvironment('production', short['a 1-character key and salt'])
      await rejected(f.runtime.initialize(actor, input()), 'UNAVAILABLE')
      expect(f.initialize).toHaveBeenCalledTimes(1); expect(warnings.seen).toEqual([])
    } finally { warnings.spy.mockRestore() }
  })
  it('the warning text is a fixed constant: no value, no number but the 32-character threshold, and no re-key advice', () => {
    // The seal cannot be re-keyed (a changed ENCRYPTION_KEY / ENCRYPTION_SALT leaves the slot unreadable), so the
    // advice is to keep the exact material, never to rotate it.
    expect(YIDA_SHORT_SEAL_MATERIAL_WARNING).toBe('YiDa initialization sealed credentials under an encryption key or salt shorter than 32 characters. '
      + 'This seal cannot be re-keyed. Securely back up the effective ENCRYPTION_KEY and ENCRYPTION_SALT from the configuration '
      + 'sources used by the running service. Keep those exact values for the life of the deployment.')
    expect(YIDA_SHORT_SEAL_MATERIAL_WARNING.match(/\d+/gu)).toEqual(['32'])
    expect(/rotat/iu.test(YIDA_SHORT_SEAL_MATERIAL_WARNING)).toBe(false)
  })
  it('the helper is pure and values-free, and leaves unset, blank and default material to the shared checks', () => {
    for (const env of [{}, { ENCRYPTION_KEY: '', ENCRYPTION_SALT: ' ' }, { ENCRYPTION_KEY: defaultKey, ENCRYPTION_SALT: defaultSalt },
      { ENCRYPTION_KEY: defaultKey }, { ENCRYPTION_SALT: defaultSalt }, ...Object.values(short), ...Object.values(sealed)]) {
      expect(getYidaSealMaterialIssues(env)).toEqual([])
    }
    for (const material of Object.values(refused)) {
      const env = { ...material }, before = JSON.stringify(env), issues = getYidaSealMaterialIssues(env)
      expect(issues.length).toBeGreaterThan(0); expect(JSON.stringify(env)).toBe(before)
      for (const issue of issues) for (const value of Object.values(material)) expect(issue.includes(value.trim())).toBe(false)
    }
  })
  it('removing only the seal-material guard lets a doc placeholder seal for good (negative assertion red)', async () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/integration/yida-initialization-runtime.ts'), 'utf8')
    expect(source.split(sealGuard)).toHaveLength(2)
    const { f } = await active({ createRuntime: loadMutant(source.replace(sealGuard, '// mutation: seal-material guard removed')).createYidaInitializationRuntime })
    useEnvironment('production', refused['(a) both easy-start doc placeholders'])
    expect((await f.runtime.initialize(actor, input())).status).toBe('initialized')
    expect(f.initialize).toHaveBeenCalledTimes(1); expect(f.commits).toBe(1)
    expect(f.state.result?.command_id).toBe(commandId)
  })
})

describe('operator-only persistent anchor control contract', () => {
  it('provisions once, reuses the same stored command and rejects identity/command drift', async () => {
    const f = fixture({ missing: true })
    const first = await bootstrap.provisionYidaInitializationAnchor({ database: f.database }, { ownerId: actor.actorId, tenantId: actor.tenantId })
    const second = await bootstrap.provisionYidaInitializationAnchor({ database: f.database }, { ownerId: actor.actorId, tenantId: actor.tenantId })
    expect(first).toEqual(second); expect(Object.isFrozen(first)).toBe(true)
    expect(f.sql.filter(sql => sql.startsWith('INSERT INTO integration_yida_initialization_anchor'))).toHaveLength(1)
    await rejected(bootstrap.provisionYidaInitializationAnchor({ database: f.database }, { ownerId: secondAdmin.actorId, tenantId: actor.tenantId }), 'CONFLICT')
    await rejected(bootstrap.provisionYidaInitializationAnchor({ database: f.database }, { ownerId: actor.actorId, tenantId: actor.tenantId, commandId }), 'CONFLICT')
  })
  it('accepts an explicit canonical command but neither extra fields nor fake transaction', async () => {
    const f = fixture({ missing: true })
    expect((await bootstrap.provisionYidaInitializationAnchor({ database: f.database }, { ownerId: actor.actorId, tenantId: actor.tenantId, commandId })).commandId).toBe(commandId)
    const bad = fixture({ missing: true, badXids: true })
    await rejected(bootstrap.provisionYidaInitializationAnchor({ database: bad.database }, { ownerId: actor.actorId, tenantId: actor.tenantId }), 'UNAVAILABLE')
    expect(bad.state.anchor).toBeUndefined()
    await rejected(bootstrap.provisionYidaInitializationAnchor({ database: f.database }, { ownerId: actor.actorId, tenantId: actor.tenantId, workspaceId: null } as { ownerId: string; tenantId: string }), 'INPUT')
  })
  it('checks the live owner before the slot lock: denied or unavailable authority never anchors', async () => {
    for (const deny of ['admin', 'membership'] as const) {
      const f = fixture({ missing: true })
      if (deny === 'admin') f.allowed = false; else f.memberships = false
      await rejected(bootstrap.provisionYidaInitializationAnchor({ database: f.database }, { ownerId: actor.actorId, tenantId: actor.tenantId }), 'DENIED')
      expect(f.state.anchor).toBeUndefined()
      expect(f.sql.some(sql => sql.includes('pg_advisory_xact_lock') || sql.startsWith('INSERT'))).toBe(false)
    }
    const broken = fixture({ missing: true, beforeQuery: async sql => { if (sql.includes('FROM user_orgs')) throw new Error('private') } })
    await rejected(bootstrap.provisionYidaInitializationAnchor({ database: broken.database }, { ownerId: actor.actorId, tenantId: actor.tenantId }), 'UNAVAILABLE')
    expect(broken.state.anchor).toBeUndefined()
    const f = fixture({ missing: true })
    await bootstrap.provisionYidaInitializationAnchor({ database: f.database }, { ownerId: actor.actorId, tenantId: actor.tenantId })
    expect(f.sql.findIndex(sql => sql.includes('FROM user_orgs'))).toBeGreaterThan(-1)
    expect(f.sql.findIndex(sql => sql.includes('FROM user_orgs'))).toBeLessThan(f.sql.findIndex(sql => sql.includes('pg_advisory_xact_lock')))
  })
})
