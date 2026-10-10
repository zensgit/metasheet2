import { readFileSync } from 'node:fs'
import path from 'node:path'
import { types } from 'node:util'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as authority from '../../src/integration/automation-live-authority'
import * as bootstrap from '../../src/integration/yida-initialization-bootstrap'
import { createYidaInitializationRuntime, yidaInitializationErrorCode,
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
const targetRef = '00000000-0000-4000-8000-000000000002'
const operationId = '00000000-0000-4000-8000-000000000003'
const credentialRef = '00000000-0000-4000-8000-000000000004'
const draftTargetRef = '00000000-0000-4000-8000-000000000005'
const rowKey = '00000000-0000-4000-8000-000000000006'
const draft = Object.freeze({ targetRef: draftTargetRef, operationId, status: 'unverified', identityKind: 'local-unverified',
  canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false,
  rowCount: 1, rows: Object.freeze([Object.freeze({ rowKey, index: 0 })]), reused: false })
const input = (): YidaInitializationInput => ({ commandId,
  material: { appKey: ' synthetic-app ', appSecret: ' synthetic-secret ', systemToken: ' synthetic-token ', userId: 'synthetic-user' },
  draft: { config: { target: { form: 'synthetic-form' } }, rowsText: '[{"synthetic":true}]', allocation: { mode: 'original' } },
  attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review', organizationId: 'synthetic-org', executionIdentity: 'synthetic-user' } })
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const emptyAnchor = (): Row => ({ slot: 1, command_id: commandId, owner_id: actor.actorId, tenant_id: actor.tenantId, workspace_id: null })
function loadMutant(source: string): typeof import('../../src/integration/yida-initialization-runtime') {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  new Function('require', 'exports', compiled)((specifier: string) => {
    if (specifier === 'node:util') return { types }
    if (specifier === './automation-live-authority') return authority
    if (specifier === './yida-initialization-bootstrap') return bootstrap
    throw new Error('Unexpected isolated module import')
  }, exports)
  return exports as typeof import('../../src/integration/yida-initialization-runtime')
}
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
  it('preserves immutable original material and nested plain JSON while caller mutates after invoke', async () => {
    const { f } = await active(), supplied = input(), result = f.runtime.initialize(actor, supplied)
    ;(supplied.material as Row).appKey = 'changed'
    ;((supplied.draft as Row).config as Row).target = { form: 'changed' }
    expect((await result).status).toBe('initialized')
    expect((f.initialize.mock.calls[0][1].material as Row).appKey).toBe(' synthetic-app ')
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
})
