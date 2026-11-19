import type { Request, Response } from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'
import type { AuthorizationInputTx, AuthorizationInputPlan } from '../../src/rbac/authorization-input-lock'

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  membership: true,
  catalogue: true,
  rowCount: 1, codes: new Set<string>(),
  fail: '' as string,
  commitFailure: false,
  commitGate: undefined as Promise<void> | undefined,
  beforeQuery: undefined as (() => void) | undefined,
  events: [] as string[],
  actorId: 'actor',
  precheck: true,
}))
const mocks = vi.hoisted(() => ({
  query: vi.fn(), transaction: vi.fn(), audit: vi.fn(), invalidate: vi.fn(), readback: vi.fn(), isAdmin: vi.fn(),
}))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ transaction: mocks.transaction }) },
}))
vi.mock('../../src/db/pg', () => ({ pool: { query: vi.fn() }, transaction: vi.fn() }))
vi.mock('../../src/middleware/auth', () => ({
  authenticate: (req: Request, _res: Response, next: () => void) => { req.user = { id: state.actorId } as never; next() },
}))
vi.mock('../../src/rbac/service', () => ({
  isAdmin: mocks.isAdmin,
  invalidateUserPerms: mocks.invalidate,
  listUserPermissions: mocks.readback,
  inspectUserPermissionGrants: vi.fn(),
  userHasPermission: vi.fn(),
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: mocks.audit }))

import { writeLegacyAuthorizationException } from '../../src/admin/authorization-exception-compat'
import { assertPermissionExceptionRoot } from '../../src/admin/direct-permission-authority'
import { permissionsRouter } from '../../src/routes/permissions'
const makeRouter = permissionsRouter

const input = { actorId: 'actor', userId: 'target', permission: 'crm:read' }
const paths = ['/api/permissions/grant', '/api/permissions/revoke', '/api/admin/permission-templates/apply']
const generic = ['Failed to grant permission', 'Failed to revoke permission', 'Failed to apply permission template']

async function route(index: number, userId: unknown = 'target', extra: Record<string, unknown> = {}) {
  const router = makeRouter()
  const layer = router.stack.find(entry => entry.route?.path === paths[index])
  const req = { body: { userId, permission: 'crm:read', templateId: 'attendance-employee', ...extra }, headers: {} } as unknown as Request
  const res = {
    statusCode: 200, body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  for (const handler of layer!.route.stack) await handler.handle(req, res, () => {})
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  state.rows = new Map(['actor', 'target'].map(id => [id, {
    id, role: 'user', is_active: true, activation_status: 'activated', deleted_at: null, purged_at: null,
  }]))
  state.membership = true
  state.catalogue = true
  state.rowCount = 1
  state.codes = new Set()
  state.fail = ''
  state.commitFailure = false
  state.commitGate = undefined
  state.beforeQuery = undefined
  state.events = []
  state.actorId = 'actor'
  state.precheck = true
  mocks.isAdmin.mockImplementation(async () => state.precheck)
  mocks.invalidate.mockImplementation(() => { state.events.push('invalidate') })
  mocks.audit.mockImplementation(async () => { state.events.push('audit') })
  mocks.readback.mockImplementation(async () => { state.events.push('readback'); return ['crm:read'] })
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    state.beforeQuery?.()
    state.beforeQuery = undefined
    state.events.push(sql)
    if (state.fail && sql.includes(state.fail)) throw Object.assign(new Error('fixed failure'), { code: 'XX000' })
    if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '2s', statement_timeout: '3s' }] }
    if (/FROM users/.test(sql)) return { rows: state.rows.has(String(params?.[0])) ? [state.rows.get(String(params?.[0]))] : [] }
    if (/FROM user_roles/.test(sql)) return { rows: state.membership ? [{ role_id: 'admin' }] : [] }
    if (sql.startsWith('SELECT permission_code FROM user_permissions')) return { rows: [...state.codes].sort().map(permission_code => ({ permission_code })) }
    if (/FROM permissions/.test(sql)) return { rows: state.catalogue ? (params?.[0] as string[]).map(code => ({ code })) : [] }
    if (/^(INSERT INTO|DELETE FROM) user_permissions/.test(sql)) {
      const code = String(params?.[1])
      if (sql.startsWith('INSERT')) state.codes.add(code); else state.codes.delete(code)
      return { rows: [{ user_id: params?.[0], permission_code: code }], rowCount: state.rowCount }
    }
    if (sql.includes('access_generation')) return { rows: [{ access_generation: 1 }] }
    return { rows: [], rowCount: state.rowCount }
  })
  mocks.transaction.mockImplementation(async (work) => {
    state.events.push('BEGIN')
    try {
      const result = await work({ query: mocks.query })
      if (state.commitGate) await state.commitGate
      state.events.push('COMMIT')
      if (state.commitFailure) throw new Error('commit result unknown')
      return result
    } catch (error) {
      state.events.push('ROLLBACK_ATTEMPT')
      throw error
    }
  })
})

function command(kind: 'direct.grant' | 'direct.revoke' | 'template.apply', codes: string[] = ['crm:read']) {
  const action = kind === 'template.apply' ? { kind, templateId: 'test-template', codes } : { kind, code: input.permission }
  return writeLegacyAuthorizationException({ actorId: input.actorId, userId: input.userId, action })
}

const actions = ['direct.grant', 'direct.revoke', 'template.apply'] as const
const writeEvents = () => state.events.filter(sql => /^(INSERT INTO|DELETE FROM) user_permissions/.test(sql))
const auditEvents = () => state.events.filter(sql => sql.includes('INSERT INTO authorization_operation_audit'))

describe('permission exception transactions', () => {
  it.each(actions)('%s holds sorted admissions and user rows before exact admin membership, and restores the local budget', async kind => {
    if (kind === 'direct.revoke') state.codes.add(input.permission)
    expect((await command(kind)).changed).toBe(true)
    const calls = mocks.query.mock.calls
    expect(calls.filter(([sql, params]) => sql.includes('pg_advisory_xact_lock') && typeof params?.[0] === 'string').map(([,p]) => p[0])).toEqual(['namespace-admission:actor','namespace-admission:target'])
    expect(calls.filter(([sql]) => sql.includes('FOR UPDATE') && sql.includes('FROM users')).map(([,p])=>p[0])).toEqual(['actor','target'])
    const edge = calls.findIndex(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))
    expect(edge).toBeGreaterThan(calls.findIndex(([sql]) => sql.includes('FOR UPDATE')))
    expect(calls[edge - 1][1]).toEqual(['5000','10000'])
    expect(calls[edge + 1][1]).toEqual(['2s','3s'])
    expect(state.events.indexOf(writeEvents()[0])).toBeLessThan(state.events.indexOf(auditEvents()[0]))
    expect(state.events.indexOf(auditEvents()[0])).toBeLessThan(state.events.indexOf('COMMIT'))
    expect(state.events.at(-1)).toBe('invalidate')
  })
  it.each(actions.flatMap(kind => ['absent','inactive','pending','disabled','recycled','missing edge','raw admin only'].map(fault => ({ kind, fault }))))('$kind refuses $fault before target disclosure', async ({kind, fault}) => {
    state.rows.delete('target')
    const actor = state.rows.get('actor')!
    if (fault === 'absent') state.rows.delete('actor')
    if (fault === 'inactive') actor.is_active = false
    if (fault === 'pending') actor.activation_status = 'pending_activation'
    if (fault === 'disabled') actor.role = 'disabled'
    if (fault === 'recycled') actor.deleted_at = 'now'
    if (fault === 'missing edge' || fault === 'raw admin only') state.membership = false
    if (fault === 'raw admin only') actor.role = 'admin'
    await expect(command(kind)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(writeEvents()).toEqual([])
    expect(auditEvents()).toEqual([])
  })
  it.each(actions.flatMap(kind => ['missing','recycled','inactive','pending'].map(fault => ({kind, fault}))))('$kind applies target policy for $fault after actor check', async ({kind, fault}) => {
    const target = state.rows.get('target')!
    if (fault === 'missing') state.rows.delete('target')
    if (fault === 'recycled') target.deleted_at = 'now'
    if (fault === 'inactive') target.is_active = false
    if (fault === 'pending') target.activation_status = 'pending_activation'
    if (fault === 'missing' || fault === 'recycled') {
      await expect(command(kind)).rejects.toMatchObject({ code: fault === 'missing' ? 'NOT_FOUND' : 'USER_IN_RECYCLE_BIN' })
      expect(writeEvents()).toEqual([])
    } else await expect(command(kind)).resolves.toHaveProperty('changed',kind !== 'direct.revoke')
    expect(state.events.some(sql => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(true)
  })
  it('takes one actor=target lock and keeps duplicate grant and absent revoke free of events', async () => {
    const req = { actorId: 'actor', userId: 'actor', action: { kind:'direct.grant' as const, code:'crm:read' } }
    expect((await writeLegacyAuthorizationException(req)).changed).toBe(true)
    expect(state.events.filter(sql=>sql.includes('FROM users') && sql.includes('FOR UPDATE'))).toHaveLength(1)
    expect((await writeLegacyAuthorizationException(req)).changed).toBe(false)
    expect((await writeLegacyAuthorizationException({...req,action:{kind:'direct.revoke',code:'missing'}})).changed).toBe(false)
    expect(writeEvents()).toHaveLength(1)
    expect(auditEvents()).toHaveLength(1)
    expect(mocks.invalidate).toHaveBeenCalledTimes(1)
  })
  it('copies template codes before awaiting and records each actual change in one transaction', async () => {
    const codes = ['crm:read','crm:write']
    state.beforeQuery = () => { codes.splice(0, 2, 'other') }
    expect((await command('template.apply',codes)).changed).toBe(true)
    expect([...state.codes].sort()).toEqual(['crm:read','crm:write'])
    expect(auditEvents()).toHaveLength(1)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })
  it('authorizes an empty template and reads back without writing a receipt', async () => {
    expect((await command('template.apply',[])).changed).toBe(false)
    expect(mocks.readback).toHaveBeenCalledTimes(1)
    expect(writeEvents()).toEqual([])
    expect(auditEvents()).toEqual([])
  })
  it.each(['direct.grant','template.apply'] as const)('%s validates the entire catalog before any DML', async kind => {
    state.catalogue=false
    await expect(command(kind)).rejects.toMatchObject({code:'UNKNOWN_PERMISSION'})
    expect(writeEvents()).toEqual([])
    expect(auditEvents()).toEqual([])
  })
  it.each(['FROM user_roles','INSERT INTO user_permissions','INSERT INTO authorization_operation_receipts','INSERT INTO authorization_operation_audit'])('rolls back on %s and never invalidates', async stage => {
    state.fail=stage
    await expect(command('direct.grant')).rejects.toThrow('fixed failure')
    expect(state.events).not.toContain('COMMIT')
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
  })
  it('does not replay an uncertain commit or label it a confirmed result', async () => {
    state.commitFailure=true
    await expect(command('direct.grant')).rejects.toThrow('commit result unknown')
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
})

describe('permission exception root witnesses', () => {
  it.each(actions)('%s requires the same plan, open brand, real held rows and admissions', kind => {
    const revoking = kind === 'direct.revoke'
    const ids = Object.freeze(['actor','target'])
    const intent = revoking ? 'REVOKE_DIRECT' as const : 'GRANT_DIRECT' as const
    const make = () => {
      const plan: AuthorizationInputPlan = Object.freeze({intent,userIds:ids,admissionUserIds:ids,roleIds:Object.freeze([]),witness:Object.freeze({userIds:ids,admissionUserIds:ids})})
      const tx = {world:'shared',plan,locked:new Map(ids.map(id=>[id,{}])),roleRows:new Map(),born:new Set(),witnessed:{userIds:new Set(ids),admissionUserIds:new Set(ids)}} as unknown as AuthorizationInputTx
      return {tx,context:Object.freeze({ actorId:'actor',userId:'target',plan })}
    }
    const baseline = make()
    expect(() => assertPermissionExceptionRoot(baseline.tx,baseline.context,revoking,true)).toThrow()
    const handle=mintAuthorizationInputBrand(baseline.tx,[baseline.tx])
    expect(() => assertPermissionExceptionRoot(baseline.tx,baseline.context,revoking,true)).not.toThrow()
    handle.close()
    expect(() => assertPermissionExceptionRoot(baseline.tx,baseline.context,revoking,true)).toThrow()
    for (const field of ['actor R3','target R3','actor R5','target R5','actual witness','born only','role row','world','context freeze','plan freeze','intent','identity','planned R3','planned R5','declared witness'] as const) {
      const fixture = make()
      let {tx,context} = fixture
      if (field.endsWith('R3') && field !== 'planned R3') (tx.witnessed.admissionUserIds as Set<string>).delete(field.split(' ')[0])
      if (field.endsWith('R5') && field !== 'planned R5') (tx.locked as Map<string,unknown>).delete(field.split(' ')[0])
      if (field === 'actual witness') (tx.witnessed.userIds as Set<string>).delete('actor')
      if (field === 'born only') { (tx.locked as Map<string,unknown>).delete('target'); (tx.born as Set<string>).add('target') }
      if (field === 'role row') (tx.roleRows as Map<string,string>).set('admin','held')
      if (field === 'world') tx={...tx,world:'exclusive'}
      if (field === 'context freeze') context={...context}
      if (field === 'identity') tx={...tx,plan:Object.freeze({...context.plan})}
      if (['intent','plan freeze','planned R3','planned R5','declared witness'].includes(field)) {
        const plan = { ...context.plan }
        if (field === 'intent') plan.intent = revoking ? 'GRANT_DIRECT' : 'REVOKE_DIRECT'
        if (field === 'planned R3') plan.admissionUserIds = Object.freeze(['actor'])
        if (field === 'planned R5') plan.userIds = Object.freeze(['target'])
        if (field === 'declared witness') plan.witness = Object.freeze({userIds:ids,admissionUserIds:Object.freeze(['actor'])})
        context=Object.freeze({...context,plan:field === 'plan freeze' ? plan : Object.freeze(plan)})
        tx={...tx,plan:context.plan}
      }
      mintAuthorizationInputBrand(tx,[tx])
      expect(() => assertPermissionExceptionRoot(tx,context,revoking,true),field).toThrow()
    }
  })
})

describe('compatibility HTTP results', () => {
  it.each([0,1,2])('route %i refuses malformed subjects with 400 before any transaction', async index => {
    for (const id of [42, {}, [], '  ', ' target','target ']) {
      expect(await route(index,id)).toMatchObject({statusCode:400,body:{error:'userId must be a non-empty canonical string'}})
    }
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
  it.each([0,1,2])('route %i validates required fields, reason and live administrator', async index => {
    expect((await route(index,'')).statusCode).toBe(400)
    expect((await route(index,'target',{ reason:'  ' })).statusCode).toBe(400)
    state.membership=false
    expect(await route(index)).toMatchObject({statusCode:403,body:{code:'FORBIDDEN',error:'Admin access required'}})
    expect(writeEvents()).toEqual([])
  })
  it.each([0,1,2].flatMap(index => ['55P03','57014','40P01'].map(code=>({index,code}))))('route $index returns canonical #6924 busy 409 for $code', async ({index,code}) => {
    const run=mocks.query.getMockImplementation()!
    mocks.query.mockImplementation((sql,params) => {
      if (sql.includes("role_id = 'admin' FOR SHARE")) throw Object.assign(new Error('private cause'), {code})
      return run(sql,params)
    })
    expect(await route(index)).toMatchObject({statusCode:409,body:{code:'AUTHORIZATION_INPUT_BUSY',error:'Authorization inputs are busy; retry this change.'}})
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
  it.each([0,1,2])('route %i keeps generic, optional-schema and commit errors fail closed', async index => {
    for (const error of [Object.assign(new Error('relation does not exist'),{code:'42P01'}), new Error('commit unknown')]) {
      mocks.transaction.mockRejectedValueOnce(error)
      expect(await route(index)).toMatchObject({statusCode:500,body:{error:generic[index]}})
    }
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
  it('returns unchanged revoke 404, reads template results before commit, and does not replay a read failure', async () => {
    expect(await route(1)).toMatchObject({statusCode:404,body:{error:'Permission not found for user'}})
    expect(mocks.invalidate).not.toHaveBeenCalled()
    mocks.readback.mockRejectedValueOnce(new Error('readback failure'))
    expect(await route(2)).toMatchObject({statusCode:500,body:{error:generic[2]}})
    expect(state.events.filter(e=>e==='COMMIT')).toHaveLength(1)
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
  })
})
