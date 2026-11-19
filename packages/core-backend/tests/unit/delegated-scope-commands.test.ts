import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizationInputPlan, AuthorizationInputTx } from '../../src/rbac/authorization-input-lock'
import { mintAuthorizationInputBrand } from '../../src/rbac/authorization-input-brand'

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  memberships: new Map<string, string[]>(),
  roles: new Set<string>(),
  activeDelegation: undefined as boolean | undefined,
  configured: false,
  hasStored: false,
  storedInclude: null as unknown,
  templates: new Set<string>(),
  templateDepartments: [] as Array<{ directoryDepartmentId: string; includeChildren: boolean }>,
  templateGroups: [] as Array<{ id: string }>,
  events: [] as string[],
  fail: '',
  errorCode: 'XX000',
  errorMessage: 'fixed SQL failure',
  onQuery: undefined as ((sql: string) => void) | undefined,
  transform: undefined as ((tx: AuthorizationInputTx) => AuthorizationInputTx) | undefined,
}))

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  entry: vi.fn(),
}))

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ transaction: mocks.transaction }) },
}))
vi.mock('../../src/rbac/authorization-input-lock', async (original) => {
  const actual = await original<typeof import('../../src/rbac/authorization-input-lock')>()
  return {
    ...actual,
    withAuthorizationInputTransaction: (
      plan: AuthorizationInputPlan,
      work: (tx: AuthorizationInputTx) => Promise<unknown>,
    ) => {
      mocks.entry(plan)
      return actual.withAuthorizationInputTransaction(plan, (tx) => work(state.transform ? state.transform(tx) : tx))
    },
  }
})
vi.mock('../../src/db/pg', () => ({ query: mocks.query, transaction: mocks.transaction }))
vi.mock('../../src/core/logger', () => ({ Logger: class { info() {} warn() {} error() {} debug() {} } }))

import {
  applyDelegatedScopeTemplateCommand,
  writeDelegatedAdminMemberGroupsCommand,
  writeDelegatedAdminScopeCommand,
} from '../../src/admin/delegated-scope-commands'
import { AuthorizationInputBusyError, AUTHORIZATION_INPUT_STATEMENTS } from '../../src/rbac/authorization-input-lock'
import { AUTHORIZATION_INPUT_WRITERS } from '../../src/rbac/authorization-input-writers'
import { RECOVERY_AUTHORITY_BUSY_MARKER } from '../../src/multitable/recovery-authorization-stability'

const businessSql = /INSERT INTO delegated_role_admin_|DELETE FROM delegated_role_admin_/
const calls = () => mocks.query.mock.calls as Array<[string, unknown[]?]>
const business = () => state.events.filter((sql) => businessSql.test(sql))
const planOf = () => mocks.entry.mock.calls.at(-1)?.[0] as AuthorizationInputPlan
const scopeInput = (patch: Record<string, unknown> = {}) => ({
  actorId: 'actor',
  userId: 'target',
  action: 'assign' as const,
  namespace: 'crm',
  directoryDepartmentId: 'dept-1',
  includeChildrenIntent: { kind: 'omitted' as const },
  ...patch,
})

function user(id: string, role = 'user', extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    email: null,
    username: id,
    mobile: null,
    activation_status: 'activated',
    role,
    is_active: true,
    access_generation: 0,
    deleted_at: null,
    purged_at: null,
    ...extra,
  }
}

function retoken(source: AuthorizationInputTx, patch: Partial<AuthorizationInputTx> = {}): AuthorizationInputTx {
  const token = { ...source, query: source.query, ...patch }
  mintAuthorizationInputBrand(token, [token])
  return token as AuthorizationInputTx
}

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  state.users = new Map([
    ['actor', user('actor', 'admin')],
    ['target', user('target', 'user')],
  ])
  state.memberships = new Map([
    ['actor', ['admin']],
    ['target', ['crm_admin']],
  ])
  state.roles = new Set(['admin', 'crm_admin', 'attendance_admin'])
  state.activeDelegation = undefined
  state.configured = false
  state.hasStored = false
  state.storedInclude = null
  state.templates = new Set(['template-1'])
  state.templateDepartments = []
  state.templateGroups = []
  state.events = []
  state.fail = ''
  state.errorCode = 'XX000'
  state.errorMessage = 'fixed SQL failure'
  state.onQuery = undefined
  state.transform = undefined
  mocks.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    state.events.push(text)
    state.onQuery?.(sql)
    if (state.fail === 'user-lock' && /FROM users/.test(sql) && /FOR UPDATE/.test(sql)) {
      throw Object.assign(new Error(state.errorMessage), { code: state.errorCode })
    }
    if (state.fail === 'admin-share' && sql.includes("role_id = 'admin' FOR SHARE")) {
      throw Object.assign(new Error(state.errorMessage), { code: state.errorCode })
    }
    if (sql.includes('current_setting')) return { rows: [{ lock_timeout: '2s', statement_timeout: '3s' }] }
    if (sql.includes('set_config')) return { rows: [] }
    if (sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared) {
      const id = String(params?.[0])
      return { rows: state.roles.has(id) ? [{ id }] : [] }
    }
    if (/FROM users/.test(sql) && /FOR UPDATE/.test(sql)) {
      const row = state.users.get(String(params?.[0]))
      return { rows: row ? [row] : [] }
    }
    if (sql.includes("role_id = 'admin' FOR SHARE")) {
      const held = (state.memberships.get(String(params?.[0])) ?? []).includes('admin')
      return { rows: held ? [{ role_id: 'admin' }] : [] }
    }
    if (sql.includes('FROM user_roles') && sql.includes('ORDER BY role_id ASC')) {
      const ids = [...(state.memberships.get(String(params?.[0])) ?? [])]
      return { rows: ids.map((role_id) => ({ role_id })) }
    }
    if (sql.startsWith('SELECT enabled FROM delegated_role_admin_activation')) {
      return { rows: state.activeDelegation === undefined ? [] : [{ enabled: state.activeDelegation }] }
    }
    if (sql.includes('AS configured')) return { rows: [{ configured: state.configured }] }
    if (sql.includes('INSERT INTO delegated_role_admin_activation')) {
      return { rows: [{ enabled: params?.[2], revision: params?.[3] }] }
    }
    if (sql.includes('SELECT include_children') && sql.includes('delegated_role_admin_scopes')) {
      return state.hasStored ? { rows: [{ include_children: state.storedInclude }] } : { rows: [] }
    }
    if (sql.includes('FROM delegated_role_scope_templates') && sql.includes('FOR UPDATE')) {
      const id = String(params?.[0])
      return { rows: state.templates.has(id) ? [{ id }] : [] }
    }
    if (sql.includes('FROM delegated_role_scope_template_departments')) {
      return {
        rows: state.templateDepartments.map((row) => ({
          directory_department_id: row.directoryDepartmentId,
          include_children: row.includeChildren,
        })),
      }
    }
    if (sql.includes('FROM delegated_role_scope_template_member_groups')) {
      return { rows: state.templateGroups.map((row) => ({ group_id: row.id })) }
    }
    return { rows: [], rowCount: 0 }
  })
  mocks.transaction.mockImplementation(async (work) => {
    const saved = structuredClone({
      users: state.users,
      memberships: state.memberships,
      roles: state.roles,
      hasStored: state.hasStored,
      storedInclude: state.storedInclude,
      templates: state.templates,
      templateDepartments: state.templateDepartments,
      templateGroups: state.templateGroups,
    })
    state.events.push('BEGIN')
    try {
      const result = await work({ query: mocks.query })
      state.events.push('COMMIT_CONFIRMED')
      return result
    } catch (error) {
      state.events.push('ROLLBACK_ATTEMPT')
      Object.assign(state, saved)
      throw error
    }
  })
})

describe('delegated scope commands through the real default root', () => {
  it.each(['department', 'member group', 'template'] as const)('rolls back the %s write when active delegation would have no configured scope', async (kind) => {
    state.activeDelegation = true
    const run = () => {
      if (kind === 'department') return writeDelegatedAdminScopeCommand(scopeInput({ action: 'unassign' }))
      if (kind === 'member group') return writeDelegatedAdminMemberGroupsCommand({
        actorId: 'actor', userId: 'target', action: 'unassign', namespace: 'crm', groupId: 'group-1',
      })
      state.templateGroups = [{ id: 'group-1' }]
      return applyDelegatedScopeTemplateCommand({
        actorId: 'actor', userId: 'target', namespace: 'crm', templateId: 'template-1', mode: 'replace',
      })
    }
    await expect(run()).rejects.toMatchObject({ code: 'ROLE_DELEGATION_ACTIVATION_SCOPE_REQUIRED' })
    const activation = state.events.findIndex(sql => sql.startsWith('SELECT enabled FROM delegated_role_admin_activation'))
    const removal = state.events.findIndex(sql => sql.startsWith('DELETE FROM delegated_role_admin_'))
    const check = state.events.findIndex(sql => sql.includes('AS configured'))
    expect(activation).toBeGreaterThan(state.events.indexOf('BEGIN'))
    expect(removal).toBeGreaterThan(activation)
    expect(check).toBeGreaterThan(removal)
    expect(state.events.at(-1)).toBe('ROLLBACK_ATTEMPT')
  })

  it('initializes the activation revision before assigning the first department', async () => {
    vi.stubEnv('DELEGATED_SCOPE_ACTIVATION_ENABLED', 'true')
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).resolves.toMatchObject({ refused: false })
    const initialized = calls().findIndex(([sql]) => sql.includes('INSERT INTO delegated_role_admin_activation'))
    const assigned = calls().findIndex(([sql]) => sql.includes('INSERT INTO delegated_role_admin_scopes'))
    expect(initialized).toBeGreaterThanOrEqual(0)
    expect(assigned).toBeGreaterThan(initialized)
    expect(calls()[initialized]?.[1]).toEqual(['target', 'crm', false, expect.any(String)])
  })

  it('freezes the shared plan for a raw admin and writes the omitted include-children default', async () => {
    const result = await writeDelegatedAdminScopeCommand(scopeInput())
    expect(result).toEqual({ refused: false, adminNamespaces: ['crm'], persisted: true })
    const plan = planOf()
    expect(plan).toEqual({
      intent: 'SET_DELEGATED_SCOPE',
      roleIds: ['crm_admin'],
      userIds: ['actor', 'target'],
      admissionUserIds: ['actor', 'target'],
      witness: { userIds: ['actor', 'target'], admissionUserIds: ['actor', 'target'] },
    })
    for (const value of [plan, plan.roleIds, plan.userIds, plan.admissionUserIds, plan.witness, plan.witness?.userIds, plan.witness?.admissionUserIds]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    expect(Object.keys(plan).sort()).toEqual(['admissionUserIds', 'intent', 'roleIds', 'userIds', 'witness'])
    const share = calls().filter(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)
    expect(share.map(([, params]) => params)).toEqual([['crm_admin']])
    expect(calls().some(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))).toBe(false)
    expect(calls().some(([sql]) => sql.includes('user-recycle:platform-admin'))).toBe(false)
    expect(calls().find(([sql]) => sql.includes('INSERT INTO delegated_role_admin_scopes'))?.[1]).toEqual([
      'target', 'crm', 'dept-1', true, 'actor',
    ])
    expect(mocks.entry).toHaveBeenCalledTimes(1)
    expect(calls().filter(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.namespaceAdmission).map(([, params]) => params)).toEqual([
      ['namespace-admission:actor'],
      ['namespace-admission:target'],
    ])
  })

  it('snapshots top-level and nested inputs before the first await and leaves the caller mutable', async () => {
    const intent = { kind: 'explicit' as const, value: true }
    const input = scopeInput({ includeChildrenIntent: intent })
    state.onQuery = (sql) => {
      if (!sql.includes('ORDER BY role_id ASC')) return
      input.actorId = 'other'
      input.namespace = 'other'
      intent.value = false
      input.includeChildrenIntent = { kind: 'omitted' }
      state.onQuery = undefined
    }
    expect(await writeDelegatedAdminScopeCommand(input)).toMatchObject({ refused: false, persisted: true })
    expect(calls().find(([sql]) => sql.includes('INSERT INTO delegated_role_admin_scopes'))?.[1]).toEqual([
      'target', 'crm', 'dept-1', true, 'actor',
    ])
    input.actorId = 'after'
    expect(input.actorId).toBe('after')
    expect(intent.value).toBe(false)
  })

  it('deduplicates actor and target into one subject', async () => {
    state.memberships.set('actor', ['admin', 'crm_admin'])
    expect(await writeDelegatedAdminScopeCommand(scopeInput({ userId: 'actor' }))).toMatchObject({ refused: false, persisted: true })
    expect(planOf().userIds).toEqual(['actor'])
    expect(calls().filter(([sql]) => /FROM users/.test(sql) && /FOR UPDATE/.test(sql))).toHaveLength(1)
  })

  it('share-locks the admin child for a membership actor and restores the saved timeouts', async () => {
    state.users.set('actor', user('actor', 'user'))
    const result = await writeDelegatedAdminScopeCommand(scopeInput())
    expect(result).toMatchObject({ refused: false, persisted: true })
    const share = calls().findIndex(([sql]) => sql.includes("role_id = 'admin' FOR SHARE"))
    expect(share).toBeGreaterThan(0)
    expect(calls()[share - 1][1]).toEqual(['5000', '10000'])
    expect(calls()[share + 1][1]).toEqual(['2s', '3s'])
    expect(calls()[share][1]).toEqual(['actor'])
  })

  it('does not treat the target admin membership as the actor edge', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.memberships.set('actor', [])
    state.memberships.set('target', ['crm_admin', 'admin'])
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({ name: 'PlatformActorAuthorityLost', code: 'FORBIDDEN' })
    expect(business()).toEqual([])
  })

  it('skips timeout restore when the admin child share throws', async () => {
    state.users.set('actor', user('actor', 'user'))
    state.fail = 'admin-share'
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({ code: 'XX000' })
    expect(calls().filter(([, params]) => params?.[0] === '2s' && params?.[1] === '3s')).toHaveLength(1)
    expect(business()).toEqual([])
    expect(mocks.entry).toHaveBeenCalledTimes(1)
  })

  it('reports a missing target before actor authority and before a corrupt witness', async () => {
    state.users.delete('target')
    state.users.delete('actor')
    state.transform = (tx) => retoken(tx, {
      witnessed: { userIds: new Set<string>(), admissionUserIds: new Set<string>() },
    })
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({
      name: 'AccessGraphUserUnavailableError',
      code: 'NOT_FOUND',
    })
    expect(business()).toEqual([])
  })

  it('reports recycle before an inactive actor', async () => {
    state.users.set('target', user('target', 'user', { deleted_at: '2026-01-01' }))
    state.users.set('actor', user('actor', 'admin', { is_active: false }))
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({ code: 'USER_IN_RECYCLE_BIN' })
    expect(business()).toEqual([])
  })

  it.each([
    ['inactive', { is_active: false }],
    ['pending', { activation_status: 'pending' }],
  ])('still writes an %s target', async (_label, extra) => {
    state.users.set('target', user('target', 'user', extra))
    expect(await writeDelegatedAdminScopeCommand(scopeInput())).toMatchObject({ refused: false, persisted: true })
  })

  it('refuses a missing, inactive, pending, or purged actor with no DML', async () => {
    for (const extra of [
      null,
      { is_active: false },
      { activation_status: 'pending' },
      { purged_at: '2026-01-01' },
    ]) {
      state.events = []
      state.users.set('actor', extra === null ? user('missing', 'admin') : user('actor', 'admin', extra))
      if (extra === null) state.users.delete('actor')
      await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({ code: 'FORBIDDEN' })
      expect(business()).toEqual([])
    }
  })

  it('refuses assign when the fresh read loses namespace A and still writes when B is added', async () => {
    let reads = 0
    state.onQuery = (sql) => {
      if (!sql.includes('ORDER BY role_id ASC')) return
      reads += 1
      if (reads === 2) state.memberships.set('target', [])
    }
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).resolves.toMatchObject({ refused: 'namespace' })
    expect(planOf().roleIds).toEqual(['crm_admin'])
    expect(business()).toEqual([])

    reads = 0
    state.events = []
    mocks.query.mockClear()
    state.memberships.set('target', ['crm_admin'])
    state.onQuery = (sql) => {
      if (!sql.includes('ORDER BY role_id ASC')) return
      reads += 1
      if (reads === 2) state.memberships.set('target', ['crm_admin', 'sales_admin'])
    }
    expect(await writeDelegatedAdminScopeCommand(scopeInput())).toMatchObject({
      refused: false,
      adminNamespaces: ['crm', 'sales'],
    })
    expect(planOf().roleIds).toEqual(['crm_admin'])
    expect(calls().filter(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared).map(([, params]) => params)).toEqual([['crm_admin']])
  })

  it('unassign does not refuse a namespace that the fresh read no longer holds', async () => {
    let reads = 0
    state.onQuery = (sql) => {
      if (!sql.includes('ORDER BY role_id ASC')) return
      reads += 1
      if (reads === 2) state.memberships.set('target', [])
    }
    expect(await writeDelegatedAdminScopeCommand(scopeInput({ action: 'unassign' }))).toEqual({
      refused: false,
      adminNamespaces: [],
      persisted: null,
    })
    expect(calls().some(([sql]) => sql.includes('DELETE FROM delegated_role_admin_scopes'))).toBe(true)
  })

  it('keeps a padded deriving id out of the parent plan and still authorizes its namespace', async () => {
    state.memberships.set('target', [' attendance_admin '])
    const result = await writeDelegatedAdminScopeCommand(scopeInput({ namespace: 'attendance' }))
    expect(result).toMatchObject({ refused: false, adminNamespaces: ['attendance'], persisted: true })
    expect(planOf().roleIds).toEqual([])
    expect(calls().some(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared)).toBe(false)
  })

  it('locks only already-canonical deriving ids and accepts a dangling missing parent', async () => {
    state.memberships.set('target', [' attendance_admin ', 'crm_admin', 'missing_admin', 'admin', ''])
    state.roles.delete('missing_admin')
    expect(await writeDelegatedAdminScopeCommand(scopeInput())).toMatchObject({ refused: false, persisted: true })
    expect(planOf().roleIds).toEqual(['crm_admin', 'missing_admin'])
    expect(calls().filter(([sql]) => sql === AUTHORIZATION_INPUT_STATEMENTS.roleRowShared).map(([, params]) => params)).toEqual([
      ['crm_admin'],
      ['missing_admin'],
    ])
  })

  it('preserves a stored exact bit while the rollout is off and writes an explicit false only for byte true', async () => {
    state.hasStored = true
    state.storedInclude = false
    expect(await writeDelegatedAdminScopeCommand(scopeInput())).toMatchObject({ persisted: false })
    expect(calls().find(([sql]) => sql.includes('INSERT INTO delegated_role_admin_scopes'))?.[1]?.[3]).toBe(false)

    await expect(writeDelegatedAdminScopeCommand(scopeInput({
      includeChildrenIntent: { kind: 'explicit', value: false },
    }))).resolves.toMatchObject({ refused: 'exact' })
    expect(business().filter((sql) => sql.includes('INSERT INTO delegated_role_admin_scopes'))).toHaveLength(1)

    vi.stubEnv('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED', 'true')
    expect(await writeDelegatedAdminScopeCommand(scopeInput({
      includeChildrenIntent: { kind: 'explicit', value: false },
    }))).toMatchObject({ refused: false, persisted: false })
  })

  it('assigns and unassigns a member group without rechecking the group row', async () => {
    expect(await writeDelegatedAdminMemberGroupsCommand({
      actorId: 'actor', userId: 'target', action: 'assign', namespace: 'crm', groupId: 'group-1',
    })).toEqual({ refused: false, adminNamespaces: ['crm'] })
    expect(calls().find(([sql]) => sql.includes('INSERT INTO delegated_role_admin_member_groups'))?.[1]).toEqual([
      'target', 'crm', 'group-1', 'actor',
    ])
    expect(calls().some(([sql]) => sql.includes('FROM platform_member_groups'))).toBe(false)
    state.events = []
    expect(await writeDelegatedAdminMemberGroupsCommand({
      actorId: 'actor', userId: 'target', action: 'unassign', namespace: 'crm', groupId: 'group-1',
    })).toMatchObject({ refused: false })
    expect(calls().some(([sql]) => sql.includes('DELETE FROM delegated_role_admin_member_groups'))).toBe(true)
  })

  it('refuses a group assign when the fresh read loses the namespace and does not insert', async () => {
    let reads = 0
    state.onQuery = (sql) => {
      if (!sql.includes('ORDER BY role_id ASC')) return
      reads += 1
      if (reads === 2) state.memberships.set('target', [])
    }
    await expect(writeDelegatedAdminMemberGroupsCommand({
      actorId: 'actor', userId: 'target', action: 'assign', namespace: 'crm', groupId: 'group-1',
    })).resolves.toEqual({ refused: true, adminNamespaces: [] })
    expect(calls().some(([sql]) => sql.includes('INSERT INTO delegated_role_admin_member_groups'))).toBe(false)
    expect(calls().some(([sql]) => sql.includes('FROM platform_member_groups'))).toBe(false)
  })

  it('refuses a template apply when the fresh read loses the namespace before the template lock', async () => {
    let reads = 0
    state.onQuery = (sql) => {
      if (!sql.includes('ORDER BY role_id ASC')) return
      reads += 1
      if (reads === 2) state.memberships.set('target', [])
    }
    await expect(applyDelegatedScopeTemplateCommand({
      actorId: 'actor', userId: 'target', namespace: 'crm', templateId: 'template-1', mode: 'replace',
    })).resolves.toEqual({ refused: 'namespace', adminNamespaces: [] })
    const sqls = calls().map(([sql]) => sql)
    expect(sqls.filter((sql) => sql.includes('ORDER BY role_id ASC'))).toHaveLength(2)
    expect(sqls.some((sql) => sql.includes('FROM delegated_role_scope_templates') && sql.includes('FOR UPDATE'))).toBe(false)
    expect(sqls.some((sql) => sql.includes('delegated_role_scope_template_departments'))).toBe(false)
    expect(sqls.some((sql) => sql.includes('delegated_role_scope_template_member_groups'))).toBe(false)
    expect(sqls.some((sql) => sql.includes('DELETE FROM delegated_role_admin_'))).toBe(false)
  })

  it('replace deletes both tables before insert and merge does not delete', async () => {
    state.templateDepartments = [{ directoryDepartmentId: 'dept-1', includeChildren: true }]
    state.templateGroups = [{ id: 'group-1' }]
    const replaced = await applyDelegatedScopeTemplateCommand({
      actorId: 'actor', userId: 'target', namespace: 'crm', templateId: 'template-1', mode: 'replace',
    })
    expect(replaced).toMatchObject({
      refused: false,
      departments: [{ directoryDepartmentId: 'dept-1', includeChildren: true }],
      memberGroups: [{ id: 'group-1' }],
    })
    const sqls = calls().map(([sql]) => sql)
    const departmentDelete = sqls.findIndex((sql) => sql.includes('DELETE FROM delegated_role_admin_scopes'))
    const groupDelete = sqls.findIndex((sql) => sql.includes('DELETE FROM delegated_role_admin_member_groups'))
    const departmentInsert = sqls.findIndex((sql) => sql.includes('INSERT INTO delegated_role_admin_scopes'))
    expect(departmentDelete).toBeGreaterThanOrEqual(0)
    expect(groupDelete).toBeGreaterThan(departmentDelete)
    expect(departmentInsert).toBeGreaterThan(groupDelete)

    state.events = []
    mocks.query.mockClear()
    await applyDelegatedScopeTemplateCommand({
      actorId: 'actor', userId: 'target', namespace: 'crm', templateId: 'template-1', mode: 'merge',
    })
    expect(calls().some(([sql]) => sql.includes('DELETE FROM delegated_role_admin_'))).toBe(false)
  })

  it('refuses a missing, empty, or exact template before either delete', async () => {
    state.templates.delete('template-1')
    await expect(applyDelegatedScopeTemplateCommand({
      actorId: 'actor', userId: 'target', namespace: 'crm', templateId: 'template-1', mode: 'replace',
    })).resolves.toMatchObject({ refused: 'missing-template' })
    expect(calls().some(([sql]) => sql.includes('delegated_role_scope_template_departments'))).toBe(false)
    expect(business()).toEqual([])

    state.templates.add('template-1')
    state.events = []
    await expect(applyDelegatedScopeTemplateCommand({
      actorId: 'actor', userId: 'target', namespace: 'crm', templateId: 'template-1', mode: 'merge',
    })).resolves.toMatchObject({ refused: 'empty' })
    expect(business()).toEqual([])

    state.templateDepartments = [{ directoryDepartmentId: 'dept-1', includeChildren: false }]
    state.events = []
    await expect(applyDelegatedScopeTemplateCommand({
      actorId: 'actor', userId: 'target', namespace: 'crm', templateId: 'template-1', mode: 'replace',
    })).resolves.toMatchObject({ refused: 'exact' })
    expect(business()).toEqual([])
  })

  it('rejects an unbranded, closed, cloned, or witness-corrupt token before DML when the domain is valid', async () => {
    const first = await writeDelegatedAdminScopeCommand(scopeInput())
    expect(first).toMatchObject({ refused: false })
    const foreign = planOf()
    state.transform = (tx) => ({ ...tx, query: tx.query }) as AuthorizationInputTx
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({ reason: 'unbranded' })
    state.transform = (tx) => {
      const token = { ...tx, query: tx.query }
      mintAuthorizationInputBrand(token, [token]).close()
      return token as AuthorizationInputTx
    }
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({ reason: 'closed' })
    state.transform = (tx) => retoken(tx, { plan: foreign })
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({ reason: 'delegated_scope_context' })
    state.transform = (tx) => retoken(tx, {
      witnessed: { userIds: new Set(['target']), admissionUserIds: new Set(['actor', 'target']) },
    })
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toMatchObject({ reason: 'delegated_scope_context' })
    expect(business().filter((sql) => sql.includes('INSERT INTO delegated_role_admin_scopes'))).toHaveLength(1)
  })

  it('maps acquisition 55P03 and 40P01 to one busy attempt and leaves marker 40001 and XX000 unmapped', async () => {
    state.fail = 'user-lock'
    state.errorCode = '55P03'
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.toBeInstanceOf(AuthorizationInputBusyError)
    expect(mocks.entry).toHaveBeenCalledTimes(1)
    expect(mocks.transaction).toHaveBeenCalledTimes(1)
    expect(business()).toEqual([])

    state.errorCode = '40P01'
    state.errorMessage = 'deadlock detected'
    await expect(writeDelegatedAdminMemberGroupsCommand({
      actorId: 'actor', userId: 'target', action: 'assign', namespace: 'crm', groupId: 'group-1',
    })).rejects.toMatchObject({ code: 'AUTHORIZATION_INPUT_BUSY', busyReason: 'deadlock' })

    state.errorCode = '40001'
    state.errorMessage = RECOVERY_AUTHORITY_BUSY_MARKER
    try {
      await applyDelegatedScopeTemplateCommand({
        actorId: 'actor', userId: 'target', namespace: 'crm', templateId: 'template-1', mode: 'merge',
      })
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).not.toBeInstanceOf(AuthorizationInputBusyError)
      expect(error).toMatchObject({ code: '40001' })
    }

    state.errorCode = 'XX000'
    state.errorMessage = 'fixed SQL failure'
    await expect(writeDelegatedAdminScopeCommand(scopeInput())).rejects.not.toBeInstanceOf(AuthorizationInputBusyError)
    expect(business()).toEqual([])
  })
})

describe('delegated scope writer literals stay on the private functions', () => {
  const source = readFileSync(new URL('../../src/admin/delegated-scope-commands.ts', import.meta.url), 'utf8')
  const sliceFunction = (signature: string) => {
    const start = source.indexOf(signature)
    expect(start, signature).toBeGreaterThanOrEqual(0)
    const rest = source.slice(start + signature.length)
    const next = rest.search(/\n(?:export )?async function |\nfunction /)
    return source.slice(start, start + signature.length + (next < 0 ? rest.length : next))
  }
  const count = (text: string, needle: string) => text.split(needle).length - 1

  it('keeps INSERT and DELETE literals out of the public commands', () => {
    for (const name of [
      'export async function writeDelegatedAdminScopeCommand',
      'export async function writeDelegatedAdminMemberGroupsCommand',
      'export async function applyDelegatedScopeTemplateCommand',
    ]) {
      const body = sliceFunction(name)
      expect(count(body, 'INSERT INTO'), name).toBe(0)
      expect(count(body, 'DELETE FROM'), name).toBe(0)
    }
  })

  it('keeps the eight business literals on the three private writers', () => {
    const scope = sliceFunction('async function writeDelegatedAdminScopeOnTx')
    const groups = sliceFunction('async function writeDelegatedAdminMemberGroupsOnTx')
    const apply = sliceFunction('async function applyDelegatedScopeTemplateOnTx')
    expect(count(scope, 'INSERT INTO delegated_role_admin_scopes')).toBe(1)
    expect(count(scope, 'DELETE FROM delegated_role_admin_scopes')).toBe(1)
    expect(count(groups, 'INSERT INTO delegated_role_admin_member_groups')).toBe(1)
    expect(count(groups, 'DELETE FROM delegated_role_admin_member_groups')).toBe(1)
    expect(count(apply, 'DELETE FROM delegated_role_admin_scopes')).toBe(1)
    expect(count(apply, 'DELETE FROM delegated_role_admin_member_groups')).toBe(1)
    expect(count(apply, 'INSERT INTO delegated_role_admin_scopes')).toBe(1)
    expect(count(apply, 'INSERT INTO delegated_role_admin_member_groups')).toBe(1)
  })

  it('marks only the reviewed W-12, W-13, and W-14 command symbols converted', () => {
    const writers = AUTHORIZATION_INPUT_WRITERS.filter((writer) => ['W-12', 'W-13', 'W-14'].includes(writer.id))
    expect(writers.map((writer) => [writer.id, writer.status, writer.symbol])).toEqual([
      ['W-12', 'converted', 'writeDelegatedAdminScopeOnTx'],
      ['W-13', 'converted', 'writeDelegatedAdminMemberGroupsOnTx'],
      ['W-14', 'converted', 'applyDelegatedScopeTemplateOnTx'],
    ])
  })
})
