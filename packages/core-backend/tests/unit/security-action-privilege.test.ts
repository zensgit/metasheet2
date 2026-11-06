import { requiredSuiteJob } from '../../../../scripts/ops/plugin-tests-workflow-contract.mjs'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import {
  assessSecurityActionPrivilege,
  classifyPrivilege,
  collectPrivilegeCodes,
  computePrivilegeWitness,
  HIGH_PRIVILEGE_REASONS,
  PRIVILEGE_GRANT_SOURCE_TABLES,
  PRIVILEGE_WITNESS_DOMAIN,
  PrivilegeInputsUnavailableError,
  readPrivilegeInputs,
} from '../../src/auth/security-action-privilege'
import type { HighPrivilegeReason, PrivilegeInputs } from '../../src/auth/security-action-privilege'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { normalizeNamespace } from '../../src/rbac/namespace-admission'
import { isAdminLevelPermissionCode } from '../../src/rbac/role-assignment'
import { inspectUserPermissionGrants, isAdmin, listUserPermissions } from '../../src/rbac/service'
import { APPROVAL_ADMIN_CAPABILITY_PREDICATE } from '../../src/services/approval-admin-capability'
import {
  LEGACY_KEY_EXISTENCE_PREDICATE,
  legacyKeyExistencePredicateIsPinned,
  privilegeFixture,
  privilegeHarness,
  privilegeRow,
  readInputs,
  SUBJECT,
} from '../helpers/security-action-privilege-harness'
import type { PrivilegeRow } from '../helpers/security-action-privilege-harness'
import { collectImportEdges, importEdgeViolations, importSpecifiers, listSourceFiles, NON_LITERAL_SPECIFIER } from '../helpers/import-edge-allowlist'
import type { ImportEdge } from '../helpers/import-edge-allowlist'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const BACKEND = path.join(ROOT, 'packages', 'core-backend')
const SRC = path.join(BACKEND, 'src')

/**
 * The only files in `src` that may import the classifier or the policy module, as exact edges
 * relative to `src`: the classifier imports the policy types, and the action proof service imports
 * the policy module (a type import and a value import) and the classifier. Nothing else may.
 */
const POLICY_MODULE_IMPORT_ALLOWLIST: ReadonlyArray<ImportEdge> = [
  ['auth/security-action-privilege.ts', './external-login-assurance'],
  ['auth/security-action-proof.ts', './external-login-assurance'],
  ['auth/security-action-proof.ts', './external-login-assurance'],
  ['auth/security-action-proof.ts', './security-action-privilege'],
]
const MODULE_PATH = path.join(SRC, 'auth', 'security-action-privilege.ts')
const DB_SPEC = 'tests/integration/security-action-privilege.db.test.ts'
const DATA_STATEMENT_MARK = 'FROM users u'

type Reason = PrivilegeInputsUnavailableError['reason']

async function expectUnavailable(promise: Promise<unknown>, reason: Reason): Promise<PrivilegeInputsUnavailableError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PrivilegeInputsUnavailableError)
    expect(error).toMatchObject({ reason, status: 503, code: 'SECURITY_ACTION_UNAVAILABLE', message: 'Privilege inputs are unavailable' })
    return error as PrivilegeInputsUnavailableError
  }
  throw new Error(`expected ${reason}`)
}

async function classifyRow(overrides: Partial<PrivilegeRow>) {
  return classifyPrivilege(await readInputs(overrides))
}

async function reasonsOf(overrides: Partial<PrivilegeRow>): Promise<readonly HighPrivilegeReason[]> {
  return (await classifyRow(overrides)).reasons
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('privilege inputs read', () => {
  it('issues the isolation probe, two transaction probes and one data statement over every grant source', async () => {
    const { executor, calls } = privilegeHarness()
    await readPrivilegeInputs(executor, SUBJECT)
    expect(calls.map(({ sql }) => sql).slice(0, 3)).toEqual([
      "SELECT current_setting('transaction_isolation') AS isolation",
      'SELECT pg_current_xact_id()::text AS xid',
      'SELECT pg_current_xact_id()::text AS xid',
    ])
    expect(calls).toHaveLength(4)
    const { sql, params } = calls[3]
    expect(params).toEqual([SUBJECT])
    for (const table of PRIVILEGE_GRANT_SOURCE_TABLES) expect(sql).toMatch(new RegExp(`\\b(?:FROM|JOIN)\\s+${table}\\b`))
    expect(sql).not.toMatch(/FOR (?:UPDATE|SHARE|KEY SHARE|NO KEY UPDATE)/)
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|COMMIT|SET)\b/)
    // Every source subquery binds its own subject column to the single parameter.
    expect(count(sql, 'WHERE ur.user_id = $1::text')).toBe(2)
    expect(count(sql, 'WHERE up.user_id = $1::text')).toBe(1)
    expect(count(sql, 'WHERE una.user_id = $1::text')).toBe(1)
    expect(count(sql, 'WHERE s.admin_user_id = $1::text')).toBe(1)
    expect(count(sql, 'WHERE g.admin_user_id = $1::text')).toBe(1)
    expect(count(sql, 'WHERE u.id = $1::text')).toBe(1)
    expect(count(sql, '(SELECT jsonb_agg(')).toBe(6)
    expect(count(sql, '$1')).toBe(7)
  })

  it('reads only the two delegated role administration scope tables as scope sources', async () => {
    const { executor, calls } = privilegeHarness()
    await readPrivilegeInputs(executor, SUBJECT)
    expect(calls[3].sql).not.toMatch(/elearning_admin_scopes|attendance_scheduler_scopes|elearning_object_acl/)
    expect(PRIVILEGE_GRANT_SOURCE_TABLES).toHaveLength(7)
    expect(HIGH_PRIVILEGE_REASONS).toEqual([
      'platform_admin_flag', 'platform_admin_role_column', 'platform_admin_role', 'delegated_admin_role',
      'delegated_admin_scope', 'admin_level_code', 'sensitive_authority_code',
    ])
  })

  it.each(['repeatable read', 'serializable', '', 'READ COMMITTED'])('requires read committed before the data statement: isolation %j', async (isolation) => {
    const { executor, calls } = privilegeHarness(privilegeFixture({ isolation }))
    await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'transaction_required')
    expect(calls).toHaveLength(1)
  })

  it('requires exactly one isolation row', async () => {
    const base = privilegeHarness()
    const executor: Queryable = {
      async query(sql, params) {
        if (sql.includes('current_setting')) return { rows: [], rowCount: 0 }
        return base.executor.query(sql, params)
      },
    }
    await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'transaction_required')
    expect(base.calls).toHaveLength(0)
  })

  it.each([['100', '101'], ['', ''], []])('requires one ongoing transaction: xids %j', async (...xids) => {
    const { executor, calls } = privilegeHarness(privilegeFixture({ xids }))
    await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'transaction_required')
    expect(calls.some(({ sql }) => sql.includes(DATA_STATEMENT_MARK))).toBe(false)
  })

  it.each([
    ['current_setting', '42P01'],
    ['current_setting', '25P02'],
    ['pg_current_xact_id', '42P01'],
    ['pg_current_xact_id', '25P02'],
  ])('maps a failing probe to transaction_required: %s with %s', async (failAt, failCode) => {
    const { executor, calls } = privilegeHarness(privilegeFixture(), { failAt, failCode })
    await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'transaction_required')
    expect(calls.some(({ sql }) => sql.includes(DATA_STATEMENT_MARK))).toBe(false)
  })

  it.each([null, undefined, {}, { query: false }])('requires a usable executor: case %#', async (executor) => {
    await expectUnavailable(readPrivilegeInputs(executor as Queryable, SUBJECT), 'transaction_required')
  })

  it.each(['42P01', '42703', '57014', '55P03', '40001', '25P02', null])('refuses with read_failed when the data statement fails with %j and never discloses the cause', async (failCode) => {
    const { executor } = privilegeHarness(privilegeFixture({ rows: [privilegeRow({ is_admin: true })] }), { failAt: DATA_STATEMENT_MARK, failCode })
    const error = await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'read_failed')
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain('synthetic_private_sql_detail')
    expect(JSON.stringify(error)).not.toContain('42P01')
    expect(error.message).toBe('Privilege inputs are unavailable')
  })

  describe('with optional schema degradation enabled', () => {
    const previous = process.env.RBAC_OPTIONAL
    afterEach(() => {
      if (previous === undefined) delete process.env.RBAC_OPTIONAL
      else process.env.RBAC_OPTIONAL = previous
    })

    it('still refuses with read_failed when a source table is missing', async () => {
      process.env.RBAC_OPTIONAL = '1'
      const { executor } = privilegeHarness(privilegeFixture(), { failAt: DATA_STATEMENT_MARK, failCode: '42P01' })
      await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'read_failed')
    })
  })

  it('refuses with subject_missing when no row exists', async () => {
    const { executor } = privilegeHarness(privilegeFixture({ rows: [] }))
    await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'subject_missing')
  })

  it.each([
    ['two rows', [privilegeRow(), privilegeRow()]],
    ['another subject', [privilegeRow({ id: 'another_subject' })]],
    ['a non-object row', [null as unknown as PrivilegeRow]],
  ])('refuses with input_malformed on %s', async (_label, rows) => {
    const { executor } = privilegeHarness(privilegeFixture({ rows }))
    await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'input_malformed')
  })

  it.each([
    ['is_admin null', { is_admin: null }],
    ['is_admin string', { is_admin: 'true' }],
    ['is_admin number', { is_admin: 1 }],
    ['role null', { role: null }],
    ['role number', { role: 1 }],
    ['role_ids not an array', { role_ids: 'admin' }],
    ['role_ids with a non-string', { role_ids: ['admin', 1] }],
    ['direct_codes with null', { direct_codes: [null] }],
    ['direct_codes not an array', { direct_codes: { 0: 'x' } }],
    ['pair with one element', { role_permission_pairs: [['r']] }],
    ['pair with three elements', { role_permission_pairs: [['r', 'c', 'x']] }],
    ['pair with a non-string', { role_permission_pairs: [['r', 1]] }],
    ['pairs not an array', { role_permission_pairs: 'r:c' }],
    ['admission enabled not boolean', { admissions: [['attendance', 'true']] }],
    ['admission namespace not string', { admissions: [[1, true]] }],
    ['department scope with a non-string', { department_scopes: [['attendance', 1]] }],
    ['department scope with one element', { department_scopes: [['attendance']] }],
    ['member group scope with a non-string', { member_group_scopes: [[null, 'g']] }],
    ['legacy value is a JSON object', { legacy_permissions: { 'users:write': true } }],
    ['legacy value is a JSON string', { legacy_permissions: 'admin:all' }],
    ['legacy value is a JSON number', { legacy_permissions: 7 }],
    ['legacy value is a JSON boolean', { legacy_permissions: true }],
    ['legacy value is null', { legacy_permissions: null }],
    ['legacy value with undefined', { legacy_permissions: [undefined] }],
    ['legacy value with a non-finite number', { legacy_permissions: [Infinity] }],
    ['legacy value with a bigint', { legacy_permissions: [1n] }],
    ['legacy value with a class instance', { legacy_permissions: [new Date(0)] }],
    ['legacy value nested beyond the depth limit', { legacy_permissions: Array.from({ length: 70 }).reduce<unknown>((inner) => [inner], 'x') }],
  ] satisfies Array<[string, Partial<PrivilegeRow>]>)('refuses with input_malformed on a row whose %s', async (_label, overrides) => {
    await expectUnavailable(readInputs(overrides), 'input_malformed')
  })

  it.each(['', ' x', 'x\n', 'x\u0000', 42, null, undefined, 'x'.repeat(256), {}])('refuses a non-canonical subject id without querying: case %#', async (userId) => {
    const { executor, calls } = privilegeHarness()
    await expectUnavailable(readPrivilegeInputs(executor, userId as string), 'input_malformed')
    expect(calls).toEqual([])
  })

  it('normalizes legacy elements as the authorization aggregator does', async () => {
    expect(collectPrivilegeCodes(await readInputs({ legacy_permissions: ['b:read', ' a:read '] }))).toEqual(['a:read', 'b:read'])
    expect(collectPrivilegeCodes(await readInputs({ legacy_permissions: [['*:*']] }))).toEqual(['*:*'])
    const elements = [7, { a: 1 }, null, true, ['x', 'y'], ' spaced ']
    expect(collectPrivilegeCodes(await readInputs({ legacy_permissions: elements })))
      .toEqual([...new Set(elements.map((e) => normalizeNamespace(e)).filter(Boolean))].sort())
    expect(collectPrivilegeCodes(await readInputs({ legacy_permissions: [] }))).toEqual([])
    expect(await classifyRow({ legacy_permissions: [] })).toEqual({ privilegeClass: 'standard', reasons: [] })
    expect(await classifyRow({ legacy_permissions: ['admin:all'] })).toEqual({ privilegeClass: 'high', reasons: ['admin_level_code'] })
  })

  const nonArrayLegacyValues: Array<[string, unknown]> = [
    ['a JSON object whose keys are permission codes', { 'attendance:admin': true }],
    ['a JSON object', { 'users:write': true }],
    ['a JSON string', 'admin:all'],
    ['a JSON number', 7],
    ['a JSON boolean', true],
    ['a JSON null', null],
  ]

  it.each(nonArrayLegacyValues)('never assesses a class when the legacy value is %s', async (_label, legacy) => {
    const { executor, calls } = privilegeHarness(privilegeFixture({ rows: [privilegeRow({ legacy_permissions: legacy })] }))
    await expectUnavailable(assessSecurityActionPrivilege(executor, SUBJECT), 'input_malformed')
    expect(calls.filter(({ sql }) => sql.includes(DATA_STATEMENT_MARK))).toHaveLength(1)
  })

  describe('legacy array rule, each enforcement point on its own', () => {
    // The row read never collects codes, so this case holds or fails on the row-shape check alone.
    it.each(nonArrayLegacyValues)('the row read refuses a legacy value that is %s', async (_label, legacy) => {
      const { executor, calls } = privilegeHarness(privilegeFixture({ rows: [privilegeRow({ legacy_permissions: legacy })] }))
      await expectUnavailable(readPrivilegeInputs(executor, SUBJECT), 'input_malformed')
      expect(calls.filter(({ sql }) => sql.includes(DATA_STATEMENT_MARK))).toHaveLength(1)
    })

    // The inputs are a literal, never produced by the read path, so this case holds or fails on the
    // check at code collection alone.
    const assembled = (legacyPermissions: unknown): PrivilegeInputs => ({
      userId: SUBJECT, isAdmin: false, role: 'user', roleIds: [], directCodes: ['tasks:write'], rolePermissions: [],
      legacyPermissions, admissions: [], delegatedDepartmentScopes: [], delegatedMemberGroupScopes: [],
    }) as unknown as PrivilegeInputs

    it.each(nonArrayLegacyValues)('code collection refuses inputs assembled outside the read path whose legacy value is %s', (_label, legacy) => {
      const forged = assembled(legacy)
      expect(() => collectPrivilegeCodes(forged)).toThrow(PrivilegeInputsUnavailableError)
      expect(() => collectPrivilegeCodes(forged)).toThrow(expect.objectContaining({ reason: 'input_malformed' }))
      expect(() => classifyPrivilege(forged)).toThrow(PrivilegeInputsUnavailableError)
      expect(() => classifyPrivilege(forged)).toThrow(expect.objectContaining({ reason: 'input_malformed' }))
      expect(collectPrivilegeCodes(assembled([]))).toEqual(['tasks:write'])
      expect(collectPrivilegeCodes(assembled(['users:write']))).toEqual(['tasks:write', 'users:write'])
    })

    it('runs the stored-object case against a predicate text that is still present in the module it is taken from', () => {
      expect(LEGACY_KEY_EXISTENCE_PREDICATE).toContain("?| ARRAY[ 'attendance:admin'")
      expect(legacyKeyExistencePredicateIsPinned()).toBe(true)
    })
  })

  it.each([
    ['an element whose toString is not callable', [{ toString: 1 }]],
    ['an element without a prototype', [Object.create(null)]],
  ])('maps a legacy element that cannot be normalized to input_malformed: %s', async (_label, legacy) => {
    const inputs = await readInputs({ legacy_permissions: legacy })
    expect(() => classifyPrivilege(inputs)).toThrow(PrivilegeInputsUnavailableError)
    expect(() => classifyPrivilege(inputs)).toThrow(expect.objectContaining({ reason: 'input_malformed' }))
    expect(() => collectPrivilegeCodes(inputs)).toThrow(PrivilegeInputsUnavailableError)
    expect(() => collectPrivilegeCodes(inputs)).toThrow(expect.objectContaining({ reason: 'input_malformed' }))
    const { executor } = privilegeHarness(privilegeFixture({ rows: [privilegeRow({ legacy_permissions: legacy })] }))
    await expectUnavailable(assessSecurityActionPrivilege(executor, SUBJECT), 'input_malformed')
  })

  it('returns frozen inputs whose collections are sorted by code unit regardless of row order', async () => {
    const inputs = await readInputs({
      role_ids: ['b', 'B', 'a'],
      direct_codes: ['z:read', 'A:read', 'a:read'],
      role_permission_pairs: [['r2', 'x:read'], ['r1', 'y:read'], ['r1', 'x:read']],
      admissions: [['b', true], ['a', false], ['a', true]],
      department_scopes: [['x', 'd2'], ['x', 'd1']],
      member_group_scopes: [['y', 'g2'], ['x', 'g9']],
    })
    expect(Object.isFrozen(inputs)).toBe(true)
    expect(Object.isFrozen(inputs.roleIds)).toBe(true)
    expect(Object.isFrozen(inputs.rolePermissions[0])).toBe(true)
    expect(inputs.roleIds).toEqual(['B', 'a', 'b'])
    expect(inputs.directCodes).toEqual(['A:read', 'a:read', 'z:read'])
    expect(inputs.rolePermissions).toEqual([['r1', 'x:read'], ['r1', 'y:read'], ['r2', 'x:read']])
    expect(inputs.admissions).toEqual([['a', false], ['a', true], ['b', true]])
    expect(inputs.delegatedDepartmentScopes).toEqual([['x', 'd1'], ['x', 'd2']])
    expect(inputs.delegatedMemberGroupScopes).toEqual([['x', 'g9'], ['y', 'g2']])
    expect(inputs.userId).toBe(SUBJECT)
  })

  it('assesses class, reasons and witness from one data statement', async () => {
    const row = privilegeRow({ role_ids: ['attendance_admin'], direct_codes: ['tasks:write'], admissions: [['attendance', true]] })
    const { executor, calls } = privilegeHarness(privilegeFixture({ rows: [row] }))
    const assessment = await assessSecurityActionPrivilege(executor, SUBJECT)
    expect(calls.filter(({ sql }) => sql.includes(DATA_STATEMENT_MARK))).toHaveLength(1)
    expect(calls).toHaveLength(4)
    const inputs = await readInputs(row)
    expect(assessment).toEqual({ ...classifyPrivilege(inputs), witness: computePrivilegeWitness(inputs) })
    expect(Object.isFrozen(assessment)).toBe(true)
  })
})

describe('privilege classification', () => {
  it.each([
    ['no grant', {}],
    ['a tasks write code', { direct_codes: ['tasks:write'] }],
    ['an approvals read code', { role_permission_pairs: [['approver', 'approvals:read']] }],
    ['the attendance employee role', { role_ids: ['attendance_employee'] }],
    ['only an admission row', { admissions: [['attendance', true]] }],
    ['a users read code', { direct_codes: ['users:read'] }],
    ['a roles read code', { legacy_permissions: ['roles:read'] }],
    ['a users writer code', { direct_codes: ['users:writer'] }],
    ['an admin_view action', { direct_codes: ['tasks:admin_view'] }],
    ['a dotted admin code', { direct_codes: ['admin.read'] }],
    ['a role named _admin', { role_ids: ['_admin'] }],
    ['a role named admin_', { role_ids: ['admin_'] }],
    ['a role named administrator', { role_ids: ['administrator'] }],
    ['a role named with admin inside', { role_ids: ['x_admin_y'] }],
  ] satisfies Array<[string, Partial<PrivilegeRow>]>)('classifies a user with %s as standard', async (_label, overrides) => {
    expect(await classifyRow(overrides)).toEqual({ privilegeClass: 'standard', reasons: [] })
  })

  const codeSources = (code: string): Array<[string, Partial<PrivilegeRow>]> => [
    [`direct ${JSON.stringify(code)}`, { direct_codes: [code] }],
    [`inherited ${JSON.stringify(code)}`, { role_permission_pairs: [['operator', code]] }],
    [`legacy ${JSON.stringify(code)}`, { legacy_permissions: [code] }],
  ]

  it.each([
    ['platform_admin_flag', 'the is_admin column set', { is_admin: true }],
    ['platform_admin_role_column', 'the role column admin', { role: 'admin' }],
    ['platform_admin_role_column', 'the role column admin with surrounding whitespace and mixed case', { role: ' Admin ' }],
    ['platform_admin_role_column', 'the role column ADMIN', { role: 'ADMIN' }],
    ['platform_admin_role', 'the admin role', { role_ids: ['admin'] }],
    ['platform_admin_role', 'the admin role with surrounding whitespace', { role_ids: [' admin '] }],
    ['platform_admin_role', 'the admin role in mixed case', { role_ids: ['Admin'] }],
    ['delegated_admin_role', 'the attendance_admin role', { role_ids: ['attendance_admin'] }],
    ['delegated_admin_role', 'the stock-prep_admin role', { role_ids: ['stock-prep_admin'] }],
    ['delegated_admin_role', 'a delegated admin role in mixed case', { role_ids: ['Attendance_Admin'] }],
    ['delegated_admin_role', 'a delegated admin role with surrounding whitespace', { role_ids: [' x_admin '] }],
    ['delegated_admin_scope', 'one department scope row', { department_scopes: [['attendance', 'department-1']] }],
    ['delegated_admin_scope', 'one member group scope row', { member_group_scopes: [['attendance', 'group-1']] }],
    ...(['*:*', '*', 'admin', 'admin:all', 'Attendance:Admin', 'attendance : admin', 'x:*', 'x:y:*', '*:read', ' admin :read']
      .flatMap((code) => codeSources(code).map(([label, overrides]) => ['admin_level_code', label, overrides] as const))),
    ['admin_level_code', 'a nested legacy wildcard', { legacy_permissions: [['*:*']] }],
    ...(['users:write', 'ROLES:WRITE', ' permissions : write ']
      .flatMap((code) => codeSources(code).map(([label, overrides]) => ['sensitive_authority_code', label, overrides] as const))),
  ] as Array<[HighPrivilegeReason, string, Partial<PrivilegeRow>]>)('classifies a user as high privilege for %s when the only grant is %s', async (reason, _label, overrides) => {
    expect(await classifyRow(overrides)).toEqual({ privilegeClass: 'high', reasons: [reason] })
  })

  it('takes codes before namespace admission', async () => {
    const inherited = { role_permission_pairs: [['operator', 'attendance:admin']] } as Partial<PrivilegeRow>
    expect(await reasonsOf(inherited)).toEqual(['admin_level_code'])
    expect(await reasonsOf({ ...inherited, admissions: [['attendance', false]] })).toEqual(['admin_level_code'])
  })

  it('reports every matching reason in the fixed order', async () => {
    expect(await classifyRow({
      is_admin: true,
      role: 'admin',
      role_ids: ['admin', 'attendance_admin'],
      department_scopes: [['attendance', 'department-1']],
      direct_codes: ['*:*'],
      legacy_permissions: ['users:write'],
    })).toEqual({ privilegeClass: 'high', reasons: [...HIGH_PRIVILEGE_REASONS] })
  })

  it('classifies as high at least every shape the approval administrator predicate admits', async () => {
    expect(APPROVAL_ADMIN_CAPABILITY_PREDICATE).toContain("(is_admin = TRUE OR role = 'admin')")
    expect(await reasonsOf({ is_admin: true })).toContain('platform_admin_flag')
    expect(await reasonsOf({ role: 'admin' })).toContain('platform_admin_role_column')
  })

  it('classifies as high at least every literal the web administrator test accepts', async () => {
    const source = readFileSync(path.join(ROOT, 'apps', 'web', 'src', 'composables', 'useAuth.ts'), 'utf8')
    expect(count(source, 'const isAdmin =')).toBe(1)
    const expression = source.split('const isAdmin =')[1].split('\n\n')[0]
    const literals = [...expression.matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect([...literals].sort()).toEqual(['*:*', 'admin', 'admin:all', 'permissions:write', 'roles:write', 'users:write'])
    for (const literal of literals) {
      const classification = literal === 'admin' ? await classifyRow({ role_ids: [literal] }) : await classifyRow({ direct_codes: [literal] })
      expect(classification.privilegeClass).toBe('high')
    }
  })

  it('classifies as high every elevation shape of the role editor and every admin-level code', async () => {
    for (const code of ['*', '*:*', 'x:*', 'admin', '*:x', 'admin:x']) {
      expect((await classifyRow({ direct_codes: [code] })).privilegeClass).toBe('high')
    }
    const sample = ['*:*', 'admin:x', 'x:admin', 'x:*', 'tasks:write', 'users:read', 'Attendance:Admin', ' x : admin ', 'roles:write', '', 'a', 'a:b:c']
    for (const code of sample) {
      if (isAdminLevelPermissionCode(code)) expect((await classifyRow({ direct_codes: [code] })).privilegeClass).toBe('high')
    }
  })

  it('reads every table the authorization aggregator reads', async () => {
    const statements: string[] = []
    const runQuery = async (sql: string) => {
      statements.push(sql)
      if (sql.includes('permission_code AS code')) return { rows: [{ code: 'attendance:read' }] }
      if (sql.includes('SELECT permissions FROM users')) return { rows: [{ permissions: ['tasks:write'] }] }
      if (sql.includes('FROM user_roles ur')) return { rows: [{ role_id: 'attendance_admin', permission_code: 'attendance:read' }] }
      return { rows: [] }
    }
    await listUserPermissions(SUBJECT, runQuery)
    await inspectUserPermissionGrants(SUBJECT, runQuery)
    await isAdmin(SUBJECT, runQuery as never)
    const tables = new Set(statements.flatMap((sql) => [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((match) => match[1])))
    expect(tables.size).toBeGreaterThanOrEqual(4)
    for (const table of tables) expect(PRIVILEGE_GRANT_SOURCE_TABLES).toContain(table)
  })

  it('imports only the transaction guard, the two predicates and the policy types, and never a cache, request or environment', () => {
    const source = readFileSync(MODULE_PATH, 'utf8')
    expect(importSpecifiers(source).sort()).toEqual([
      '../multitable/automation-durable-dispatcher',
      '../multitable/pg-transaction-guard',
      '../rbac/namespace-admission',
      '../rbac/role-assignment',
      './external-login-assurance',
      'node:crypto',
    ])
    for (const forbidden of ['process.env', 'req.', 'listUserPermissions', 'getUserById', 'invalidateUserPerms', 'rbac/service', 'verifyToken']) {
      expect(source).not.toContain(forbidden)
    }
  })
})

describe('privilege witness', () => {
  const pinnedRow: Partial<PrivilegeRow> = {
    role_ids: ['b', 'B', 'a'],
    direct_codes: ['tasks:write'],
    role_permission_pairs: [['b', 'approvals:read']],
    legacy_permissions: ['spreadsheet:read'],
    admissions: [['attendance', true]],
    department_scopes: [['attendance', 'department-1']],
    member_group_scopes: [['attendance', 'group-1']],
  }

  it('is a domain-separated sha256 pinned for a fixed fixture', async () => {
    const witness = computePrivilegeWitness(await readInputs(pinnedRow))
    expect(witness).toMatch(/^[0-9a-f]{64}$/)
    expect(witness).toBe('4ecf13878fb89bb8e5cbc506d7567995256169e3c33fbc62df342c23e9ba0c2f')
  })

  it('does not depend on the order rows arrive in and is deterministic', async () => {
    const shuffled: Partial<PrivilegeRow> = {
      ...pinnedRow,
      role_ids: ['a', 'B', 'b'],
      role_permission_pairs: [['b', 'approvals:read']],
    }
    const first = computePrivilegeWitness(await readInputs(pinnedRow))
    expect(computePrivilegeWitness(await readInputs(shuffled))).toBe(first)
    expect(computePrivilegeWitness(await readInputs(pinnedRow))).toBe(first)
  })

  it.each([
    ['the is_admin flag flips', { is_admin: true }],
    ['the role column changes only in whitespace', { role: 'user ' }],
    ['a role is added', { role_ids: ['b', 'B', 'a', 'c'] }],
    ['a direct code is added', { direct_codes: ['tasks:write', 'tasks:read'] }],
    ['a code moves between two held roles', { role_permission_pairs: [['a', 'approvals:read']] }],
    ['the legacy array is reordered', { legacy_permissions: ['spreadsheet:read', 'x'] }],
    ['an admission flips', { admissions: [['attendance', false]] }],
    ['a department scope is replaced by another', { department_scopes: [['attendance', 'department-2']] }],
    ['a member group scope is replaced by another', { member_group_scopes: [['attendance', 'group-2']] }],
  ] satisfies Array<[string, Partial<PrivilegeRow>]>)('changes when %s', async (_label, change) => {
    const base = computePrivilegeWitness(await readInputs(pinnedRow))
    expect(computePrivilegeWitness(await readInputs({ ...pinnedRow, ...change }))).not.toBe(base)
  })

  it('changes when the legacy array is reordered with the same elements', async () => {
    const base = computePrivilegeWitness(await readInputs({ legacy_permissions: ['a', 'b'] }))
    expect(computePrivilegeWitness(await readInputs({ legacy_permissions: ['b', 'a'] }))).not.toBe(base)
  })

  it('orders by code unit, not by locale', async () => {
    const inputs = await readInputs({ role_ids: ['b', 'B', 'a'] })
    expect(inputs.roleIds).toEqual(['B', 'a', 'b'])
    expect([...inputs.roleIds].sort((x, y) => x.localeCompare(y))).not.toEqual(inputs.roleIds)
  })

  it('differs from the undomained hash of the same canonical encoding', async () => {
    const inputs = await readInputs(pinnedRow)
    const bare = createHash('sha256').update(JSON.stringify({
      isAdmin: inputs.isAdmin, role: inputs.role, roleIds: inputs.roleIds, directCodes: inputs.directCodes,
      rolePermissions: inputs.rolePermissions, legacyPermissions: inputs.legacyPermissions, admissions: inputs.admissions,
      delegatedDepartmentScopes: inputs.delegatedDepartmentScopes, delegatedMemberGroupScopes: inputs.delegatedMemberGroupScopes,
    })).digest('hex')
    const domained = createHash('sha256').update(PRIVILEGE_WITNESS_DOMAIN + JSON.stringify({
      admissions: inputs.admissions, delegatedDepartmentScopes: inputs.delegatedDepartmentScopes,
      delegatedMemberGroupScopes: inputs.delegatedMemberGroupScopes, directCodes: inputs.directCodes, isAdmin: inputs.isAdmin,
      legacyPermissions: inputs.legacyPermissions, role: inputs.role, roleIds: inputs.roleIds, rolePermissions: inputs.rolePermissions,
    })).digest('hex')
    const witness = computePrivilegeWitness(inputs)
    expect(witness).not.toBe(bare)
    expect(witness).toBe(domained)
    expect(PRIVILEGE_WITNESS_DOMAIN).toBe('metasheet:security-action:privilege:v1|')
  })

  it('refuses inputs whose legacy value cannot be canonically encoded', () => {
    const forged = { ...({} as PrivilegeInputs), isAdmin: false, role: 'user', roleIds: [], directCodes: [], rolePermissions: [], admissions: [], delegatedDepartmentScopes: [], delegatedMemberGroupScopes: [] }
    for (const legacy of [[Infinity], [undefined], { a: () => undefined }, [Symbol('x')], Array.from({ length: 70 }).reduce<unknown>((inner) => [inner], 'x')]) {
      expect(() => computePrivilegeWitness({ ...forged, legacyPermissions: legacy } as unknown as PrivilegeInputs))
        .toThrow(expect.objectContaining({ reason: 'input_malformed' }))
    }
  })
})

describe('wiring', () => {
  it('registers the whole real-PG suite in the approval real-DB step and excludes it from the no-DB runner', () => {
    const workflow = yaml.load(readFileSync(path.join(ROOT, '.github/workflows/plugin-tests.yml'), 'utf8')) as Parameters<typeof requiredSuiteJob>[0]
    const step = requiredSuiteJob(workflow, 'approval-db').steps.find((entry: { id?: string }) => entry.id === 'approval-real-db-integration') as
      { id?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: unknown } | undefined
    expect(step?.if).toBe("matrix.node-version == '20.x'")
    expect(step?.env?.EXPECT_DB).toBe('1')
    expect(step?.env?.DATABASE_URL).toMatch(/^postgres(?:ql)?:\/\//)
    expect(step?.['continue-on-error']).toBeUndefined()
    const command = (step?.run ?? '').replace(/\\\r?\n/g, ' ')
    expect(command).toMatch(/vitest --config vitest\.integration\.config\.ts run /)
    expect(command.split(/\s+/).filter((token) => token === DB_SPEC)).toHaveLength(1)
    expect(command).not.toMatch(/(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
    const config = ts.createSourceFile('vitest.config.ts', readFileSync(path.join(BACKEND, 'vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    let excluded = false
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
        excluded ||= node.initializer.elements.some((entry) => ts.isStringLiteral(entry) && entry.text === DB_SPEC)
      }
      ts.forEachChild(node, visit)
    }
    visit(config)
    expect(excluded).toBe(true)
    expect(existsSync(path.join(BACKEND, DB_SPEC))).toBe(true)
  })

  it('counts import and re-export statements alike as import edges', () => {
    expect(importSpecifiers("import { a } from './x'\nexport { b } from './y'\nexport * from './z'\nexport const c = 1\n")).toEqual(['./x', './y', './z'])
  })

  it('is imported, together with the policy module, by exactly the allowlisted files: the classifier and the action proof service', () => {
    const edges = collectImportEdges(SRC, /security-action-privilege|external-login-assurance/, (file) => readFileSync(file, 'utf8'))
    expect(importEdgeViolations(edges, POLICY_MODULE_IMPORT_ALLOWLIST)).toEqual([])
    for (const file of listSourceFiles(SRC)) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/require\(\s*['"`][^'"`]*(?:security-action-privilege|external-login-assurance)/)
      expect(source).not.toMatch(/import\(\s*['"`][^'"`]*(?:security-action-privilege|external-login-assurance)/)
    }
  })

  it('sees each listed load form: static, re-export, require, dynamic import and import types, with plain or template literals, in TypeScript and JavaScript', () => {
    const typescript = [
      "import { a } from './m1'",
      "import type { B } from './m2'",
      "import './m3'",
      "export * from './m4'",
      "export { c } from './m5'",
      "import legacy = require('./m6')",
      'export async function later() {',
      "  const d = await import(`./m7`)",
      "  const e = require(`./m8`)",
      "  const f = await import('./m9')",
      '  return [d, e, f]',
      '}',
      "export type G = typeof import('./m10')",
      'export const name = "./m11"',
      '',
    ].join('\n')
    expect(importSpecifiers(typescript, 'scratch.ts')).toEqual(['./m1', './m2', './m3', './m4', './m5', './m6', './m7', './m8', './m9', './m10'])
    const javascript = "'use strict'\nconst a = require('./m1')\nconst b = require(`./m2`)\nmodule.exports = () => import(`./m3`)\n"
    for (const fileName of ['scratch.js', 'scratch.cjs', 'scratch.mjs']) expect(importSpecifiers(javascript, fileName)).toEqual(['./m1', './m2', './m3'])
    const computed = "const target = './m1'\nrequire(target)\nimport(`./${target}`)\nrequire('./m' + 2)\n"
    expect(importSpecifiers(computed, 'scratch.ts')).toEqual([NON_LITERAL_SPECIFIER, NON_LITERAL_SPECIFIER, NON_LITERAL_SPECIFIER])
  })

  it('collects edges from every TypeScript and JavaScript file under the root, records a computed load in a file naming the module, and reports a non-source file naming it', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'import-edges-'))
    try {
      mkdirSync(path.join(root, 'auth'))
      const files: Record<string, string> = {
        'auth/allowed.ts': "import { a } from './watched-module'\n",
        'auth/template.ts': 'export const load = () => import(`./watched-module`)\n',
        'legacy.js': "module.exports = require(`./auth/watched-module`)\n",
        'tool.cjs': "module.exports = require('./auth/watched-module')\n",
        'tool.mjs': "export * from './auth/watched-module'\n",
        'computed.ts': "const name = 'watched-module'\nexport const load = () => require('./auth/' + name)\n",
        'notes.md': 'watched-module\n',
        'unrelated.ts': "const name = 'other'\nexport const load = () => require(name)\n",
      }
      for (const [file, text] of Object.entries(files)) writeFileSync(path.join(root, file), text)
      const edges = collectImportEdges(root, /watched-module/, (file) => readFileSync(file, 'utf8'))
      expect(importEdgeViolations(edges, [['auth/allowed.ts', './watched-module']])).toEqual([
        `unexpected: auth/template.ts -> ./watched-module`,
        `unexpected: computed.ts -> ${NON_LITERAL_SPECIFIER}`,
        'unexpected: legacy.js -> ./auth/watched-module',
        'unexpected: notes.md -> <unparsed .md>',
        'unexpected: tool.cjs -> ./auth/watched-module',
        'unexpected: tool.mjs -> ./auth/watched-module',
      ])
      expect(listSourceFiles(root).map((file) => path.relative(root, file)).sort()).toEqual(['auth/allowed.ts', 'auth/template.ts', 'computed.ts', 'legacy.js', 'tool.cjs', 'tool.mjs', 'unrelated.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports any importer the allowlist does not name, in the same directory or elsewhere, by import or by re-export, and any allowlisted edge that is missing', () => {
    const allowed = POLICY_MODULE_IMPORT_ALLOWLIST
    expect(importEdgeViolations(allowed, allowed)).toEqual([])
    expect(importEdgeViolations([...allowed].reverse(), allowed)).toEqual([])
    const sameDirectory: ImportEdge = ['auth/scratch-importer.ts', './security-action-privilege']
    expect(importEdgeViolations([...allowed, sameDirectory], allowed)).toEqual(['unexpected: auth/scratch-importer.ts -> ./security-action-privilege'])
    const elsewhere: ImportEdge = ['routes/scratch.ts', '../auth/external-login-assurance']
    expect(importEdgeViolations([...allowed, elsewhere], allowed)).toEqual(['unexpected: routes/scratch.ts -> ../auth/external-login-assurance'])
    const reExport = importSpecifiers("export * from './security-action-privilege'\nexport { a } from './external-login-assurance'\n")
      .map((specifier): ImportEdge => ['auth/scratch-reexport.ts', specifier])
    expect(importEdgeViolations([...allowed, ...reExport], allowed)).toEqual([
      'unexpected: auth/scratch-reexport.ts -> ./external-login-assurance',
      'unexpected: auth/scratch-reexport.ts -> ./security-action-privilege',
    ])
    const duplicate: ImportEdge = ['auth/security-action-proof.ts', './security-action-privilege']
    expect(importEdgeViolations([...allowed, duplicate], allowed)).toEqual(['unexpected: auth/security-action-proof.ts -> ./security-action-privilege'])
    expect(importEdgeViolations(allowed.slice(1), allowed)).toEqual(['missing: auth/security-action-privilege.ts -> ./external-login-assurance'])
    expect(importEdgeViolations([], allowed)).toHaveLength(allowed.length)
  })
})
