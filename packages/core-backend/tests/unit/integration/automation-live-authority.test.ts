import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import {
  assertAutomationIntegrationActor,
  AutomationActorAuthorityError,
} from '../../../src/integration/automation-live-authority'
import type { AutomationIntegrationActor } from '../../../src/integration/automation-live-authority'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

type Row = Record<string, unknown>
type Fixture = {
  isolation: string
  xids: string[]
  roles: Row[]
  rolePermissions: Row[]
  directPermissions: Row[]
  users: Row[]
  memberships: Row[]
  admissions: Row[]
}

const actor = { actorId: 'synthetic_actor', tenantId: 'synthetic_tenant', workspaceId: null } as const

it('registers the whole real-PG proof in an EXPECT_DB lane and excludes it from the no-DB runner', () => {
  const root = path.resolve(__dirname, '..', '..', '..', '..', '..')
  const spec = 'tests/integration/automation-live-authority-realdb.test.ts'
  const workflow = yaml.load(readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8')) as {
    jobs: { test: { steps: Array<{ id?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: unknown }> } }
  }
  const step = workflow.jobs.test.steps.find(entry => entry.id === 'external-system-delete-bind-lock-protocol-real-db')
  expect(step?.env?.EXPECT_DB).toBe('1')
  expect(step?.env?.DATABASE_URL).toBeTruthy()
  expect(step?.if).toBe("matrix.node-version == '20.x'")
  expect(step?.['continue-on-error']).toBeUndefined()
  const command = (step?.run ?? '').replace(/\\\r?\n/g, ' ')
  expect(command).toMatch(/vitest --config vitest\.integration\.config\.ts run /)
  expect(command.split(/\s+/).filter(token => token === spec)).toHaveLength(1)
  expect(command).not.toMatch(/(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
  const config = ts.createSourceFile('vitest.config.ts', readFileSync(path.join(root, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  let excluded = false
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
      excluded ||= node.initializer.elements.some(entry => ts.isStringLiteral(entry) && entry.text === spec)
    }
    ts.forEachChild(node, visit)
  }
  visit(config)
  expect(excluded).toBe(true)
})

function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    isolation: 'read committed',
    xids: ['100', '100'],
    roles: [{ role_id: 'integration_admin' }],
    rolePermissions: [{ role_id: 'integration_admin', permission_code: 'integration:admin' }],
    directPermissions: [],
    users: [{ id: actor.actorId, role: 'user', is_active: true, activation_status: 'activated', permissions: [] }],
    memberships: [{ user_id: actor.actorId, org_id: actor.tenantId, is_active: true }],
    admissions: [{ namespace: 'integration', enabled: true }],
    ...overrides,
  }
}

const tables = ['user_roles', 'role_permissions', 'user_permissions', 'users', 'user_orgs', 'user_namespace_admissions'] as const
const keys = ['roles', 'rolePermissions', 'directPermissions', 'users', 'memberships', 'admissions'] as const

function harness(data = fixture(), failAt?: string) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let probes = 0
  const trx: Queryable = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (failAt && sql.includes(failAt)) {
        throw Object.assign(new Error('synthetic_private_sql_detail'), { code: '42P01' })
      }
      if (sql.includes('current_setting')) return { rows: [{ isolation: data.isolation }], rowCount: 1 }
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: data.xids[probes++] }], rowCount: 1 }
      const index = tables.findIndex((table) => new RegExp(`FROM ${table}\\s`).test(sql))
      if (index < 0) throw new Error('Unexpected query')
      const rows = data[keys[index]]
      // Snapshot each SELECT result, as a driver would; the fixture is not an authority cache.
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length }
    },
  }
  return { trx, calls }
}

async function expectDenied(data: Fixture) {
  await expect(assertAutomationIntegrationActor(harness(data).trx, actor))
    .rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
}

describe('Automation LIVE actor authority (unit query fixtures, not PostgreSQL lock proof)', () => {
  it('accepts an active tenant member with current admitted integration admin permission', async () => {
    await expect(assertAutomationIntegrationActor(harness().trx, actor)).resolves.toBeUndefined()
  })

  it.each([
    ['normalized admin role', { roles: [{ role_id: 'admin' }], rolePermissions: [], admissions: [] }],
    ['legacy exact admin role', { roles: [], rolePermissions: [], admissions: [], users: [
      { ...fixture().users[0], role: 'admin' },
    ] }],
    ['direct exact role:admin permission', { roles: [], rolePermissions: [], admissions: [], directPermissions: [
      { permission_code: 'role:admin' },
    ] }],
    ['role exact role:admin permission', { roles: [{ role_id: 'operator' }], admissions: [], rolePermissions: [
      { role_id: 'operator', permission_code: 'role:admin' },
    ] }],
    ['legacy exact role:admin permission', { roles: [], rolePermissions: [], admissions: [], users: [
      { ...fixture().users[0], permissions: ['role:admin'] },
    ] }],
  ] satisfies Array<[string, Partial<Fixture>]> )('accepts %s without an integration namespace admission', async (_label, overrides) => {
    await expect(assertAutomationIntegrationActor(harness(fixture(overrides)).trx, actor)).resolves.toBeUndefined()
  })

  it.each([
    ['direct', { directPermissions: [{ permission_code: 'integration:admin' }] }],
    ['legacy', { users: [{ ...fixture().users[0], permissions: ['integration:admin'] }] }],
  ] satisfies Array<[string, Partial<Fixture>]> )('accepts %s integration permission when a delegated namespace role is admitted', async (_label, overrides) => {
    await expect(assertAutomationIntegrationActor(harness(fixture({ rolePermissions: [], ...overrides })).trx, actor))
      .resolves.toBeUndefined()
  })

  it('derives integration namespace from a role permission even without an admin-suffixed role', async () => {
    await expect(assertAutomationIntegrationActor(harness(fixture({
      roles: [{ role_id: 'reader' }],
      rolePermissions: [{ role_id: 'reader', permission_code: 'integration:read' }],
      directPermissions: [{ permission_code: 'integration:admin' }],
    })).trx, actor)).resolves.toBeUndefined()
  })

  it('uses normalized permission strings like the current namespace filter', async () => {
    await expect(assertAutomationIntegrationActor(harness(fixture({
      rolePermissions: [{ role_id: 'integration_admin', permission_code: ' integration:admin ' }],
    })).trx, actor)).resolves.toBeUndefined()
  })

  it.each([
    ['no user', []],
    ['inactive', [{ ...fixture().users[0], is_active: false }]],
    ['missing active flag', [{ ...fixture().users[0], is_active: undefined }]],
    ['truthy but nonboolean active flag', [{ ...fixture().users[0], is_active: 'true' }]],
    ['disabled', [{ ...fixture().users[0], role: 'disabled' }]],
    ['pending activation', [{ ...fixture().users[0], activation_status: 'pending_activation' }]],
    ['null activation', [{ ...fixture().users[0], activation_status: null }]],
    ['unknown activation', [{ ...fixture().users[0], activation_status: 'unexpected' }]],
    ['mismatched user', [{ ...fixture().users[0], id: 'another_actor' }]],
  ] satisfies Array<[string, Row[]]> )('rejects %s despite an integration admin grant', async (_label, users) => {
    await expectDenied(fixture({ users }))
  })

  it('uses effective normalized admin role for the shared activation gate', async () => {
    await expect(assertAutomationIntegrationActor(harness(fixture({
      roles: [{ role_id: 'admin' }], users: [{ ...fixture().users[0], role: 'disabled' }],
    })).trx, actor)).resolves.toBeUndefined()
  })

  it.each([
    ['missing membership', []],
    ['inactive membership', [{ ...fixture().memberships[0], is_active: false }]],
    ['nonboolean membership', [{ ...fixture().memberships[0], is_active: 1 }]],
    ['other tenant', [{ ...fixture().memberships[0], org_id: 'another_tenant' }]],
    ['other user', [{ ...fixture().memberships[0], user_id: 'another_actor' }]],
    ['duplicate membership', [...fixture().memberships, ...fixture().memberships]],
  ] satisfies Array<[string, Row[]]> )('rejects %s even for normalized platform admin', async (_label, memberships) => {
    await expectDenied(fixture({ roles: [{ role_id: 'admin' }], memberships }))
  })

  it.each([
    ['wildcard', ['*:*']], ['integration wildcard', ['integration:*']], ['role wildcard', ['role:*']],
    ['wrong case', ['Integration:admin']], ['read permission', ['integration:read']],
  ])('does not promote %s to exact admin authority', async (_label, permissions) => {
    await expectDenied(fixture({ rolePermissions: [], users: [{ ...fixture().users[0], permissions }] }))
  })

  it.each([
    ['direct permission with no role', { roles: [], rolePermissions: [], directPermissions: [{ permission_code: 'integration:admin' }] }],
    ['legacy permission with no role', { roles: [], rolePermissions: [], users: [{ ...fixture().users[0], permissions: ['integration:admin'] }] }],
    ['display name and is_admin', { roles: [{ role_id: 'operator', name: 'admin' }], rolePermissions: [], users: [{ ...fixture().users[0], is_admin: true }] }],
    ['ordinary integration role name only', { roles: [{ role_id: 'integration_reader' }], rolePermissions: [], directPermissions: [{ permission_code: 'integration:admin' }] }],
    ['missing admission', { admissions: [] }],
    ['revoked admission', { admissions: [{ namespace: 'integration', enabled: false }] }],
    ['wrong admission namespace', { admissions: [{ namespace: 'workflow', enabled: true }] }],
    ['truthy but nonboolean admission', { admissions: [{ namespace: 'integration', enabled: 'true' }] }],
  ] satisfies Array<[string, Partial<Fixture>]> )('rejects %s', async (_label, overrides) => {
    await expectDenied(fixture(overrides))
  })

  it.each([
    null, undefined, {}, [], { ...actor, actorId: '' }, { ...actor, actorId: ' actor' },
    { ...actor, tenantId: 'tenant ' }, { ...actor, actorId: 'actor\u0000' },
    { ...actor, actorId: 42 }, { ...actor, tenantId: 'x'.repeat(256) },
    { actorId: actor.actorId, tenantId: actor.tenantId }, { ...actor, workspaceId: undefined },
    { ...actor, workspaceId: 'workspace' },
  ])('rejects noncanonical host scope without querying: case %#', async (input) => {
    const { trx, calls } = harness()
    await expect(assertAutomationIntegrationActor(trx, input as AutomationIntegrationActor))
      .rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_INPUT_INVALID' })
    expect(calls).toEqual([])
  })

  it.each([null, undefined, {}, { query: false }])('rejects unusable transaction handles: case %#', async (trx) => {
    await expect(assertAutomationIntegrationActor(trx as Queryable, actor))
      .rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED' })
  })

  it.each(['repeatable read', 'serializable', 'read uncommitted', 'READ COMMITTED'])('rejects isolation %s before authority queries', async (isolation) => {
    const { trx, calls } = harness(fixture({ isolation }))
    await expect(assertAutomationIntegrationActor(trx, actor))
      .rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED' })
    expect(calls).toHaveLength(1)
  })

  it.each([['100', '101'], ['', ''], []])('rejects autocommit or invalid xid probe: case %#', async (...xids) => {
    const { trx, calls } = harness(fixture({ xids }))
    await expect(assertAutomationIntegrationActor(trx, actor))
      .rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED' })
    expect(calls.some(({ sql }) => sql.includes('FROM user_roles'))).toBe(false)
  })

  it.each(['current_setting', 'pg_current_xact_id'])('sanitizes transaction failure at %s', async (failAt) => {
    const { trx } = harness(fixture(), failAt)
    await expect(assertAutomationIntegrationActor(trx, actor)).rejects.toMatchObject({
      code: 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED',
      message: 'Automation actor authority requires a read-committed transaction',
    })
  })

  it.each(tables)('rejects unavailable %s even for platform admin without disclosing query error', async (table) => {
    const { trx } = harness(fixture({ roles: [{ role_id: 'admin' }] }), `FROM ${table}`)
    try {
      await assertAutomationIntegrationActor(trx, actor)
      expect.fail('unavailable authority must reject')
    } catch (error) {
      expect(error).toBeInstanceOf(AutomationActorAuthorityError)
      expect(error).toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE', message: 'Automation actor authority is unavailable' })
      expect(error).not.toHaveProperty('cause')
      expect(JSON.stringify(error)).not.toContain('synthetic_private_sql_detail')
    }
  })

  it('locks phased positive authority once and derives only from captured role ids, with no unlocked reread', async () => {
    const { trx, calls } = harness(fixture({
      roles: [{ role_id: 'z_operator' }, { role_id: 'integration_admin' }, { role_id: 'a_operator' }],
    }))
    await assertAutomationIntegrationActor(trx, actor)
    expect(calls).toHaveLength(9)
    expect(calls.slice(0, 3).map(({ sql }) => sql)).toEqual([
      "SELECT current_setting('transaction_isolation') AS isolation",
      'SELECT pg_current_xact_id()::text AS xid',
      'SELECT pg_current_xact_id()::text AS xid',
    ])
    for (const [index, table] of tables.entries()) {
      expect(calls[index + 3].sql).toContain(`FROM ${table}`)
      expect(calls[index + 3].sql).toContain('FOR SHARE')
    }
    expect(calls[4].params).toEqual([['a_operator', 'integration_admin', 'z_operator']])
    expect(calls[4].sql).not.toContain('JOIN')
    expect(calls[7].params).toEqual([actor.actorId, actor.tenantId])
    expect(calls[8].params).toEqual([actor.actorId, 'integration'])
    expect(calls.every(({ sql }) => !/\b(UPDATE|INSERT|DELETE|COMMIT|SET)\b/.test(sql))).toBe(true)
  })

  it('does not adopt a role inserted after the captured user_roles lock result', async () => {
    const data = fixture({ roles: [], rolePermissions: [], directPermissions: [{ permission_code: 'integration:admin' }] })
    const base = harness(data)
    const trx: Queryable = {
      async query(sql, params) {
        const result = await base.trx.query(sql, params)
        if (/FROM user_roles\s/.test(sql)) data.roles.push({ role_id: 'integration_admin' })
        return result
      },
    }
    await expect(assertAutomationIntegrationActor(trx, actor))
      .rejects.toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
    expect(base.calls[4].params).toEqual([[]])
    expect(base.calls.filter(({ sql }) => /FROM user_roles\s/.test(sql))).toHaveLength(1)
  })
})
