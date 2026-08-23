/**
 * The role-assignment boundary and the access-preset grant table.
 *
 * Two halves, both structural rather than example-based:
 *
 *  A. THE PRESET TABLE. Every access preset states the capability it grants through its
 *     `roleId` and permission codes. One rule over the whole exported table replaces
 *     per-preset review, so a preset added next year is covered without anyone remembering
 *     this file exists. A second leg pins the namespaces each preset's grants derive, which
 *     is what provisioning must admit for those grants to resolve to anything.
 *
 *  B. THE ASSIGNMENT BOUNDARY. `src/rbac/role-assignment.ts` is the only module that writes
 *     `user_roles`, and every caller must name the authority it acts under. Leg B1 is what
 *     makes that a fact rather than a convention: it sweeps both SQL syntaxes over the whole
 *     backend `src` tree and the plugin tree and requires the writer file-set to be exactly
 *     the boundary module.
 *
 * EVERY "THIS IS NOW REFUSED" LEG CARRIES A POSITIVE CONTROL. An assertion that something
 * does not happen is worthless if it would also pass against a broken implementation, so
 * each refusal leg is paired with a check that the same predicate ACCEPTS the corresponding
 * legitimate value, and each sweep regex is fired against a real file mutated IN MEMORY (the
 * technique `attendance-w6-group-effective-policy-dml-sweep.test.ts` established — never a
 * frozen fixture, and never a write into the real tree, which would race sibling suites
 * under `pool: 'forks'`).
 *
 * LANE: `tests/unit/*.test.ts` is collected by `pnpm --filter @metasheet/core-backend test`
 * (vitest default discovery; this file is not in `vitest.config.ts`'s exclude list), which is
 * the unpinned "Run core-backend tests" step of `plugin-tests.yml` job `test`. Its 20.x leg
 * publishes the check `test (20.x)`, which IS in main's required-status-check list. No
 * workflow edit is required, and none is made.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// attendance-admin.ts pulls a real module graph at import time; the registry and the route
// handlers are what this file needs, not the database.
const pgMocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), poolQuery: vi.fn() }))
vi.mock('../../src/db/pg', () => ({
  query: pgMocks.query,
  transaction: pgMocks.transaction,
  pool: { query: pgMocks.poolQuery },
}))
vi.mock('../../src/services/AttendanceScheduler', () => ({
  getSharedAttendanceScheduler: vi.fn(() => null),
}))
vi.mock('../../src/services/AttendanceNotificationRedelivery', () => ({
  redeliverFailedAttendanceNotification: vi.fn(),
}))
const rbacServiceMocks = vi.hoisted(() => ({
  isAdmin: vi.fn(async () => false),
  listUserPermissions: vi.fn(async () => [] as string[]),
  invalidateUserPerms: vi.fn(),
  userHasPermission: vi.fn(async () => false),
}))
vi.mock('../../src/rbac/service', () => rbacServiceMocks)

import type { Request, Response, Router } from 'express'
import { listAccessPresets } from '../../src/auth/access-presets'
import {
  deriveDelegatedAdminNamespace,
  deriveGrantNamespaces,
  grantNamespaceAdmissions,
  isNamespaceAdmissionControlledResource,
} from '../../src/rbac/namespace-admission'
import {
  assertRoleAssignable,
  assignUserRoles,
  isRoleAssignable,
  RoleAssignmentError,
  RoleAssignmentForbiddenError,
  sendIfRoleAssignmentRefused,
  unassignUserRoles,
  type RoleAssignmentScope,
} from '../../src/rbac/role-assignment'
import { ATTENDANCE_ROLE_TEMPLATES, attendanceAdminRouter } from '../../src/routes/attendance-admin'
import { adminUsersRouter, ATTENDANCE_ROLE_IDS } from '../../src/routes/admin-users'

const REPO_ROOT = path.resolve(__dirname, '../../../../')
const PLATFORM_ADMIN_ROLE_ID = 'admin'

/* ────────────────────────────── A. the preset table ────────────────────────────── */

/**
 * The rule, extracted so the SAME predicate can be fired at the real table and at a decoy.
 * A rule only applied to data that satisfies it proves nothing about the rule.
 */
function presetGrantsPlatformAdminColumn(preset: { role: string; roleId?: string }): boolean {
  return preset.role === 'admin' && preset.roleId !== PLATFORM_ADMIN_ROLE_ID
}

describe('access presets — a scoped preset declares its capability through roleId and permissions', () => {
  it('no preset sets the platform-wide role column unless it is the platform-admin preset', () => {
    const presets = listAccessPresets()
    // Domain floor: an empty table would make the loop below vacuously green.
    expect(presets.length).toBeGreaterThan(0)

    const offenders = presets.filter(presetGrantsPlatformAdminColumn).map((preset) => preset.id)
    expect(offenders).toEqual([])
  })

  it('POSITIVE CONTROL — the same rule flags a preset that does set it', () => {
    // Built from a real row so the decoy is the shape the rule must catch, not a strawman.
    const real = listAccessPresets().find((preset) => preset.roleId === 'attendance_admin')
    expect(real).toBeDefined()
    expect(presetGrantsPlatformAdminColumn({ ...real!, role: 'admin' })).toBe(true)
    expect(presetGrantsPlatformAdminColumn({ role: 'admin', roleId: PLATFORM_ADMIN_ROLE_ID })).toBe(false)
  })

  it('every scoped preset declares the capability it grants through roleId + permissions', () => {
    // The counterpart to the rule above: the platform-wide column is not what carries the grant,
    // so each attendance preset must carry a role id and a non-empty permission set of its own.
    const scoped = listAccessPresets().filter((preset) => preset.productMode === 'attendance')
    expect(scoped.length).toBeGreaterThan(0)
    for (const preset of scoped) {
      expect(preset.roleId, `${preset.id} must declare a roleId`).toBeTruthy()
      expect(preset.permissions.length, `${preset.id} must declare permissions`).toBeGreaterThan(0)
    }
  })
})

describe('access presets — the namespaces each grant derives', () => {
  it('derives exactly the admission-controlled namespaces implied by roleId + permission codes', () => {
    const presets = listAccessPresets()
    expect(presets.length).toBeGreaterThan(0)

    const derived = Object.fromEntries(
      presets.map((preset) => [
        preset.id,
        deriveGrantNamespaces({ roleId: preset.roleId, permissionCodes: preset.permissions }),
      ]),
    )

    // Pinned whole-table expectation. Presets whose permissions touch only
    // non-admission-controlled resources derive nothing and must write no admission row —
    // that is the leg proving the derivation cannot over-grant.
    expect(derived).toEqual({
      'platform-editor': [],
      'platform-viewer': [],
      'attendance-employee': ['attendance'],
      'attendance-approver': ['attendance'],
      'attendance-admin': ['attendance'],
      'attendance-importer': ['attendance'],
      'plm-collaborator': [],
    })

    // Floor: at least one preset must derive something, or "no over-granting" is trivially true.
    expect(Object.values(derived).some((namespaces) => namespaces.length > 0)).toBe(true)
  })

  it('POSITIVE CONTROL — the derivation is driven by the grant, not by the preset id', () => {
    expect(deriveGrantNamespaces({ roleId: 'attendance_admin', permissionCodes: [] })).toEqual(['attendance'])
    expect(deriveGrantNamespaces({ roleId: '', permissionCodes: ['attendance:read'] })).toEqual(['attendance'])
    // multitable is a non-admission-controlled resource, so it derives nothing.
    expect(deriveGrantNamespaces({ roleId: '', permissionCodes: ['multitable:read'] })).toEqual([])
    expect(deriveGrantNamespaces({ roleId: '', permissionCodes: [] })).toEqual([])
  })

  it('the admission writer enables exactly the derived namespaces (executed, not read)', async () => {
    const statements: Array<{ sql: string; params: unknown[] }> = []
    const executor = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push({ sql, params: params ?? [] })
        return { rows: [] }
      },
    }

    const written = await grantNamespaceAdmissions(executor, {
      userId: 'user-1',
      namespaces: deriveGrantNamespaces({ roleId: 'attendance_admin', permissionCodes: ['attendance:admin'] }),
      actorId: 'admin-1',
      source: 'admin_create',
    })

    expect(written).toEqual(['attendance'])
    expect(statements).toHaveLength(1)
    expect(statements[0].sql).toMatch(/INSERT INTO user_namespace_admissions/)
    expect(statements[0].sql).toMatch(/enabled = TRUE/)
    expect(statements[0].params[0]).toBe('user-1')
    expect(statements[0].params[1]).toEqual(['attendance'])

    // NEGATIVE CONTROL — an empty derivation writes nothing at all.
    statements.length = 0
    expect(await grantNamespaceAdmissions(executor, { userId: 'user-1', namespaces: [] })).toEqual([])
    expect(statements).toHaveLength(0)
  })
})

/* ─────────────────────── B. the assignment boundary predicate ─────────────────────── */

describe('rbac/role-assignment — scope is required and the bounded arm is derived', () => {
  const attendanceScope: RoleAssignmentScope = { kind: 'namespaces', namespaces: ['attendance'] }

  it('admits every role id in the exported registries under its own namespace', () => {
    const templateRoleIds = Object.values(ATTENDANCE_ROLE_TEMPLATES).map((template) => template.roleId)
    expect(templateRoleIds.length).toBeGreaterThan(0)
    for (const roleId of templateRoleIds) {
      expect(() => assertRoleAssignable(roleId, attendanceScope), roleId).not.toThrow()
    }

    const presetRoleIds = listAccessPresets()
      .filter((preset) => preset.productMode === 'attendance' && preset.roleId)
      .map((preset) => String(preset.roleId))
    expect(presetRoleIds.length).toBeGreaterThan(0)
    for (const roleId of presetRoleIds) {
      expect(() => assertRoleAssignable(roleId, attendanceScope), roleId).not.toThrow()
    }
  })

  it('refuses the platform-admin role id under every namespace the registries derive', () => {
    // The namespace set is derived from the shipped registries, not listed here, so a
    // namespace introduced later is covered without editing this test.
    const namespaces = Array.from(
      new Set([
        ...listAccessPresets().filter((preset) => preset.roleId).map((preset) => preset.productMode),
        ...Object.values(ATTENDANCE_ROLE_TEMPLATES).map((template) => template.roleId.split('_')[0]),
      ]),
    )
    // Floor: without this an empty registry makes the refusal loop vacuously green.
    expect(namespaces.length).toBeGreaterThan(0)

    for (const namespace of namespaces) {
      expect(
        () => assertRoleAssignable(PLATFORM_ADMIN_ROLE_ID, { kind: 'namespaces', namespaces: [namespace] }),
        namespace,
      ).toThrow(RoleAssignmentForbiddenError)
    }
  })

  it('POSITIVE CONTROL — the same namespaces admit their own role ids, so the loop above is not refusing everything', () => {
    expect(isRoleAssignable('attendance_admin', attendanceScope)).toBe(true)
    expect(isRoleAssignable('attendance', attendanceScope)).toBe(true)
    expect(isRoleAssignable(PLATFORM_ADMIN_ROLE_ID, attendanceScope)).toBe(false)
  })

  it('a namespace that is not admission-controlled scopes nothing', () => {
    // `admin` is classified as a non-namespaced resource, so declaring it as a namespace
    // does not widen the bounded arm to the platform-admin role id. The refusal follows from
    // the shared resource classification, not from a denylist this test would have to track.
    expect(isRoleAssignable(PLATFORM_ADMIN_ROLE_ID, { kind: 'namespaces', namespaces: ['admin'] })).toBe(false)
    expect(isRoleAssignable('multitable_admin', { kind: 'namespaces', namespaces: ['multitable'] })).toBe(false)
    // POSITIVE CONTROL for the same arm: an admission-controlled namespace still works.
    expect(isRoleAssignable('attendance_admin', { kind: 'namespaces', namespaces: ['attendance'] })).toBe(true)
  })

  it('the directory governance seam is bounded by its CONFIG VALIDATOR, not by its scope argument', () => {
    // Recorded so nobody reads that seam's scope argument as the constraint. It passes
    // `{kind:'fixed', roleIds: <the ids it is assigning>}`, which admits by construction —
    // deliberately, because the real bound for that seam runs earlier, when a platform admin
    // writes the integration configuration. The scope STATES the authority; it does not
    // narrow it, and it is a no-op refusal-wise.
    const configuredRoleIds = ['attendance_employee', 'some_business_role']
    for (const roleId of configuredRoleIds) {
      expect(isRoleAssignable(roleId, { kind: 'fixed', roleIds: configuredRoleIds })).toBe(true)
    }
    // And the reason it is admissive rather than safe: if a configuration ever named the
    // platform-admin role id, this scope would admit it too.
    expect(isRoleAssignable(PLATFORM_ADMIN_ROLE_ID, { kind: 'fixed', roleIds: ['admin'] })).toBe(true)

    // The predicate that actually bounds that seam is the config validator's, applied at
    // configuration write time. Exercised here on the values it accepts and rejects, so the
    // location of the bound is pinned even though the validator itself is module-private.
    expect(deriveDelegatedAdminNamespace('admin')).toBeNull()          // refused by its explicit id check
    expect(deriveDelegatedAdminNamespace('attendance_admin')).toBe('attendance') // refused: delegated-admin role
    expect(deriveDelegatedAdminNamespace('attendance_employee')).toBeNull()      // admitted there
    expect(deriveDelegatedAdminNamespace('some_business_role')).toBeNull()       // admitted there
  })

  it('the fixed arm admits only its own set; the platform arm is unbounded and says so', () => {
    const fixed: RoleAssignmentScope = { kind: 'fixed', roleIds: ['attendance_employee'] }
    expect(isRoleAssignable('attendance_employee', fixed)).toBe(true)
    expect(isRoleAssignable('attendance_admin', fixed)).toBe(false)
    expect(isRoleAssignable(PLATFORM_ADMIN_ROLE_ID, fixed)).toBe(false)
    expect(isRoleAssignable(PLATFORM_ADMIN_ROLE_ID, { kind: 'platform-admin' })).toBe(true)
  })

  it('an empty or blank role id is refused under every scope', () => {
    for (const scope of [
      { kind: 'platform-admin' } as const,
      { kind: 'namespaces', namespaces: ['attendance'] } as const,
      { kind: 'fixed', roleIds: ['attendance_employee'] } as const,
    ]) {
      expect(isRoleAssignable('', scope)).toBe(false)
      expect(isRoleAssignable('   ', scope)).toBe(false)
    }
  })

  it('the writers refuse before issuing any statement (executed)', async () => {
    const statements: string[] = []
    const executor = {
      query: async (sql: string) => {
        statements.push(sql)
        return { rows: [] }
      },
    }
    const scope: RoleAssignmentScope = { kind: 'namespaces', namespaces: ['attendance'] }

    await expect(
      assignUserRoles({ userIds: ['u1'], roleId: PLATFORM_ADMIN_ROLE_ID, scope, executor }),
    ).rejects.toBeInstanceOf(RoleAssignmentForbiddenError)
    await expect(
      unassignUserRoles({ userIds: ['u1'], roleId: PLATFORM_ADMIN_ROLE_ID, scope, executor }),
    ).rejects.toBeInstanceOf(RoleAssignmentForbiddenError)
    expect(statements).toEqual([])

    // POSITIVE CONTROL — an in-scope role id does reach the executor, so "no statements"
    // above is a refusal and not a broken harness.
    await assignUserRoles({ userIds: ['u1'], roleId: 'attendance_employee', scope, executor })
    await unassignUserRoles({ userIds: ['u1'], roleId: 'attendance_employee', scope, executor })
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/INSERT INTO user_roles/)
    expect(statements[1]).toMatch(/DELETE FROM user_roles/)
  })
})

/* ─────────────────────── B3. the registries agree ─────────────────────── */

describe('attendance role registries agree with each other', () => {
  it('the router template registry and the access-preset table name the same role ids', () => {
    const fromTemplates = new Set(Object.values(ATTENDANCE_ROLE_TEMPLATES).map((template) => template.roleId))
    const fromPresets = new Set(
      listAccessPresets()
        .filter((preset) => preset.productMode === 'attendance' && preset.roleId)
        .map((preset) => String(preset.roleId)),
    )
    expect(fromTemplates.size).toBeGreaterThan(0)
    expect([...fromPresets].sort()).toEqual([...fromTemplates].sort())
  })

  it('the attendance role-id classification set agrees with both', () => {
    // The set is derived from the preset table rather than written out; this leg is what keeps
    // it derived, so the two registries cannot name different role ids.
    const fromTemplates = [...new Set(Object.values(ATTENDANCE_ROLE_TEMPLATES).map((t) => t.roleId))].sort()
    expect([...ATTENDANCE_ROLE_IDS].sort()).toEqual(fromTemplates)
  })
})

/* ──────────────────── B4. the attendance routes go through the boundary ──────────────────── */

function mockResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res as Response & { statusCode: number; body: unknown }
}

/** Invoke a route's FINAL handler directly — the router-level guard is not under test here. */
function invokeHandler(router: Router, method: 'post', routePath: string, req: Partial<Request>, res: Response) {
  const layer = (router as unknown as {
    stack: Array<{
      route?: {
        path: string
        methods: Record<string, boolean>
        stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>
      }
    }>
  }).stack.find((entry) => entry.route?.path === routePath && entry.route?.methods?.[method])
  if (!layer?.route) throw new Error(`Route ${method.toUpperCase()} ${routePath} not found`)
  const handler = layer.route.stack[layer.route.stack.length - 1].handle
  const fullReq = {
    method: method.toUpperCase(), headers: {}, query: {}, params: {}, body: {}, user: { id: 'admin-1' }, ...req,
  } as unknown as Request
  return Promise.resolve(handler(fullReq, res, (err?: unknown) => { if (err) throw err }))
}

const BATCH_USER_ID = '10000000-0000-4000-8000-000000000001'

const ROLE_ROUTES: Array<{ path: string; body: (roleId: string) => Record<string, unknown>; template: Record<string, unknown> }> = [
  {
    path: '/api/attendance-admin/users/:userId/roles/assign',
    body: (roleId) => ({ roleId }),
    template: { template: 'employee' },
  },
  {
    path: '/api/attendance-admin/users/:userId/roles/unassign',
    body: (roleId) => ({ roleId }),
    template: { template: 'employee' },
  },
  {
    path: '/api/attendance-admin/users/batch/roles/assign',
    body: (roleId) => ({ userIds: [BATCH_USER_ID], roleId }),
    template: { userIds: [BATCH_USER_ID], template: 'employee' },
  },
  {
    path: '/api/attendance-admin/users/batch/roles/unassign',
    body: (roleId) => ({ userIds: [BATCH_USER_ID], roleId }),
    template: { userIds: [BATCH_USER_ID], template: 'employee' },
  },
]

describe('attendance role routes are bounded by the router scope', () => {
  function installPg(seen: string[]) {
    pgMocks.query.mockReset()
    pgMocks.query.mockImplementation(async (sql: string) => {
      seen.push(sql)
      if (/FROM users/.test(sql)) {
        return {
          rows: [{
            id: BATCH_USER_ID, email: 'u@example.com', name: 'U', employeeNo: null,
            department: null, role: 'user', is_active: true, is_admin: false,
            last_login_at: null, created_at: 'now',
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
  }

  // Every one of the four routes, not just the assign pair: an unbounded unassign can strip
  // authority from an account the caller has none over, which the assign-side framing misses.
  for (const route of ROLE_ROUTES) {
    it(`${route.path} refuses an out-of-scope role id and writes nothing`, async () => {
      const seen: string[] = []
      installPg(seen)
      const res = mockResponse()
      await invokeHandler(attendanceAdminRouter(), 'post', route.path, {
        params: { userId: BATCH_USER_ID },
        body: route.body(PLATFORM_ADMIN_ROLE_ID),
      }, res)

      expect(res.statusCode).toBe(403)
      expect(res.body).toMatchObject({ ok: false, error: { code: 'ROLE_OUT_OF_SCOPE' } })
      expect(seen.filter((sql) => /(INSERT INTO|DELETE FROM)\s+user_roles/i.test(sql))).toEqual([])
    })

    it(`POSITIVE CONTROL — ${route.path} still performs the write for a template grant`, async () => {
      // Without this, the leg above would pass against a route that rejects everything —
      // including a route broken so badly it never writes at all.
      const seen: string[] = []
      installPg(seen)
      const res = mockResponse()
      await invokeHandler(attendanceAdminRouter(), 'post', route.path, {
        params: { userId: BATCH_USER_ID },
        body: route.template,
      }, res)

      expect(res.statusCode).toBe(200)
      expect(seen.filter((sql) => /(INSERT INTO|DELETE FROM)\s+user_roles/i.test(sql))).toHaveLength(1)
    })
  }

  it('the batch route refuses out-of-scope before resolving users, not only at the write', async () => {
    // Discriminates the route-level pre-check from the boundary's own assertion. The batch
    // routes short-circuit to 200 when no user resolves as eligible, so a refusal that lives
    // ONLY at the write would let an out-of-scope request return 200 on that path.
    const seen: string[] = []
    pgMocks.query.mockReset()
    pgMocks.query.mockImplementation(async (sql: string) => {
      seen.push(sql)
      return { rows: [], rowCount: 0 } // no eligible users
    })
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), 'post', '/api/attendance-admin/users/batch/roles/assign', {
      body: { userIds: [BATCH_USER_ID], roleId: PLATFORM_ADMIN_ROLE_ID },
    }, res)

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'ROLE_OUT_OF_SCOPE' } })

    // POSITIVE CONTROL — the same zero-eligible-user path returns 200 for an in-scope grant,
    // so the 403 above is the scope refusal and not the empty-batch path failing generally.
    const control = mockResponse()
    await invokeHandler(attendanceAdminRouter(), 'post', '/api/attendance-admin/users/batch/roles/assign', {
      body: { userIds: [BATCH_USER_ID], template: 'employee' },
    }, control)
    expect(control.statusCode).toBe(200)
  })

  it('a template grant that names an in-namespace role id is still accepted directly', async () => {
    // Compatibility leg: constraining the role id must not turn this router into a
    // template-only API. `attendance_importer` is a role id the namespace derivation admits
    // and an enumerated allow-list would have to remember to carry.
    const seen: string[] = []
    installPg(seen)
    const res = mockResponse()
    await invokeHandler(attendanceAdminRouter(), 'post', '/api/attendance-admin/users/:userId/roles/assign', {
      params: { userId: BATCH_USER_ID },
      body: { roleId: 'attendance_importer' },
    }, res)
    expect(res.statusCode).toBe(200)
    expect(seen.filter((sql) => /INSERT INTO\s+user_roles/i.test(sql))).toHaveLength(1)
  })
})

/* ───── B4b. the refusal mapper, and the family it covers by construction ───── */

describe('sendIfRoleAssignmentRefused', () => {
  it('answers a boundary refusal with the status and code the error carries', () => {
    const res = mockResponse()
    const handled = sendIfRoleAssignmentRefused(
      res,
      new RoleAssignmentForbiddenError('crm_operator', { kind: 'namespaces', namespaces: ['attendance'] }),
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'ROLE_OUT_OF_SCOPE' } })
    // The thrown error names the role id; the response does not.
    expect(JSON.stringify(res.body)).not.toContain('crm_operator')
  })

  it('covers a refusal added to the family later, with no entry added here', () => {
    // The claim the mapper is built on: it keys on the family's base class and reads status and
    // code off the instance, so this subclass — which this module has never heard of — is
    // answered without the mapper, or any call site, being edited. A per-class mapper would
    // return false here and the refusal would surface as whatever the call site does with an
    // unrecognised error.
    class FutureRoleAssignmentRefusal extends RoleAssignmentError {
      readonly status = 409
      readonly code = 'ROLE_ASSIGNMENT_CONFLICT'
    }
    const res = mockResponse()
    expect(sendIfRoleAssignmentRefused(res, new FutureRoleAssignmentRefusal('later'))).toBe(true)
    expect(res.statusCode).toBe(409)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'ROLE_ASSIGNMENT_CONFLICT' } })
  })

  it('NEGATIVE CONTROL — leaves every other error to its call site, writing no response', () => {
    // A mapper that swallowed unrelated errors would turn real faults into 403s.
    for (const other of [new Error('boom'), { code: 'ROLE_OUT_OF_SCOPE', status: 403 }, null, undefined, 'ROLE_OUT_OF_SCOPE']) {
      const res = mockResponse()
      expect(sendIfRoleAssignmentRefused(res, other)).toBe(false)
      expect(res.body).toBeUndefined()
      expect(res.statusCode).toBe(200)
    }
  })
})

/* ───── B5. a refusal is a permission answer at every seam, not a server fault ───── */

/**
 * The delegated role-admin seam and the boundary do not compute the same namespace set: the
 * route admits any namespace its actor's `*_admin` roles derive, while the boundary keeps only
 * the ones that are admission-controlled. The two legs below are the SAME request shape through
 * the SAME handler, differing only in whether the actor's namespace is admission-controlled —
 * so a handler that answered 403 for everything would fail the second, and one that never
 * refused would fail the first.
 *
 * Both run the shipped `namespace-admission` predicates (this file mocks only `db/pg` and
 * `rbac/service`), so the classification driving the split is the real one.
 */
describe('role-delegation seam — a boundary refusal answers 403, not 500', () => {
  const DELEGATION_ROUTE = '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)'
  const TARGET_USER_ID = '10000000-0000-4000-8000-000000000002'

  /** Serves the seam's reads by SQL shape, so neither leg depends on a call-ordering count. */
  function installDelegationPg(seen: string[], actorRoleId: string, targetRoleId: string) {
    pgMocks.query.mockReset()
    pgMocks.query.mockImplementation(async (sql: string) => {
      seen.push(sql)
      // `isUserWithinDelegatedScope` — also names the scopes table, so it is matched first.
      if (/WITH RECURSIVE/i.test(sql)) return { rows: [{ allowed: true }], rowCount: 1 }
      if (/SELECT\s+role_id\s+FROM\s+user_roles/i.test(sql)) {
        return { rows: [{ role_id: actorRoleId }], rowCount: 1 }
      }
      if (/FROM users/i.test(sql)) {
        return {
          rows: [{
            id: TARGET_USER_ID, email: 'target@example.com', name: 'Target', role: 'user',
            is_active: true, is_admin: false, last_login_at: null, created_at: 'now',
            updated_at: 'now',
          }],
          rowCount: 1,
        }
      }
      if (/FROM roles/i.test(sql)) return { rows: [{ id: targetRoleId }], rowCount: 1 }
      if (/delegated_role_admin_scopes/i.test(sql)) {
        return {
          rows: [{
            id: 'scope-1', admin_user_id: 'delegated-actor', namespace: actorRoleId.replace(/_admin$/, ''),
            directory_department_id: 'dept-1', created_by: 'admin-1', created_at: 'now', updated_at: 'now',
            integration_id: 'integration-1', integration_name: 'Dir', provider: 'local', corp_id: null,
            external_department_id: '1', department_name: 'Dept', department_full_path: 'Dept',
            department_is_active: true,
          }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
  }

  async function callSeam(actorRoleId: string, targetRoleId: string) {
    const seen: string[] = []
    installDelegationPg(seen, actorRoleId, targetRoleId)
    const res = mockResponse()
    await invokeHandler(adminUsersRouter(), 'post', DELEGATION_ROUTE, {
      params: { userId: TARGET_USER_ID, action: 'assign' },
      body: { roleId: targetRoleId },
      user: { id: 'delegated-actor' },
    }, res)
    return { res, seen }
  }

  it('refuses with 403 and a stable code, and writes nothing', async () => {
    // `workflow` is not an admission-controlled resource, so the boundary drops it while the
    // route's own pre-check accepts the role id. This is the seam's answer for that case.
    expect(isNamespaceAdmissionControlledResource('workflow')).toBe(false)

    const { res, seen } = await callSeam('workflow_admin', 'workflow_operator')

    expect(res.statusCode).toBe(403)
    expect(res.body).toMatchObject({ ok: false, error: { code: 'ROLE_OUT_OF_SCOPE' } })
    expect(seen.filter((sql) => /(INSERT INTO|DELETE FROM)\s+user_roles/i.test(sql))).toEqual([])
  })

  it('POSITIVE CONTROL — the same seam still assigns when the namespace is admission-controlled', async () => {
    // Without this leg, the 403 above would also pass against a seam that refuses everything.
    expect(isNamespaceAdmissionControlledResource('crm')).toBe(true)

    const { res, seen } = await callSeam('crm_admin', 'crm_operator')

    expect(res.statusCode).toBe(200)
    expect(seen.filter((sql) => /INSERT INTO\s+user_roles/i.test(sql))).toHaveLength(1)
  })

  it('the refusal body carries the code and no detail about the refused grant', async () => {
    // The thrown error names the role id it was constructed with; that belongs in logs, not in
    // a response body.
    const { res } = await callSeam('workflow_admin', 'workflow_operator')
    expect(JSON.stringify(res.body)).not.toContain('workflow_operator')
  })
})

/* ───────────────────── B1. the writer sweep — the leg that makes it inert ───────────────────── */

/**
 * Mechanical, visible exclusions. A sweep whose exclusions are applied by judgement is a
 * sweep that can be talked into any answer, so each is a named constant with its reason.
 */
const SWEEP_ROOTS = ['packages/core-backend/src', 'plugins'] as const
const SWEEP_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs'])
const EXCLUDED_DIRECTORIES = [
  // Schema/DDL authority, not request authority: there is no actor to scope a migration to,
  // and a remediation backfill is legitimately an INSERT here.
  'packages/core-backend/src/db/migrations',
  // Direct-DB operational tooling; it runs outside the app process, so no in-process
  // boundary can constrain it. That is a credentials question, not this boundary's.
  'packages/core-backend/scripts',
  'scripts',
  'node_modules',
  'dist',
] as const
/** The one module permitted to write the table. */
const BOUNDARY_FILE = 'packages/core-backend/src/rbac/role-assignment.ts'

const WRITER_PATTERNS: Array<{ name: string; regex: RegExp; mutate: (source: string, needle: string) => string }> = [
  {
    name: 'raw INSERT',
    regex: /\bINSERT\s+INTO\s+(public\.)?user_roles\b/i,
    mutate: (source, needle) => source.replace(needle, 'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)'),
  },
  {
    name: 'raw DELETE',
    regex: /\bDELETE\s+FROM\s+(public\.)?user_roles\b/i,
    mutate: (source, needle) => source.replace(needle, 'DELETE FROM user_roles WHERE user_id = $1'),
  },
  {
    name: 'raw UPDATE',
    regex: /\bUPDATE\s+(public\.)?user_roles\b/i,
    mutate: (source, needle) => source.replace(needle, 'UPDATE user_roles SET role_id = $2 WHERE user_id = $1'),
  },
  {
    name: 'raw MERGE',
    regex: /\bMERGE\s+INTO\s+(public\.)?user_roles\b/i,
    mutate: (source, needle) => source.replace(needle, 'MERGE INTO user_roles USING x ON (TRUE)'),
  },
  {
    name: 'query-builder',
    regex: /\.(insertInto|deleteFrom|updateTable|replaceInto)\s*\(\s*['"`]user_roles/,
    mutate: (source, needle) => source.replace(needle, "db.insertInto('user_roles')"),
  },
]

function isExcluded(relativePath: string): boolean {
  if (EXCLUDED_DIRECTORIES.some((dir) => relativePath === dir || relativePath.startsWith(`${dir}/`))) return true
  // Test material never carries request authority.
  return /(^|\/)(tests?|__tests__)\//.test(relativePath) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
}

function collectSweptFiles(): string[] {
  const files: string[] = []
  const walk = (absolute: string) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(absolute, entry.name)
      const relative = path.relative(REPO_ROOT, child).split(path.sep).join('/')
      if (isExcluded(relative)) continue
      if (entry.isDirectory()) walk(child)
      else if (SWEEP_EXTENSIONS.has(path.extname(entry.name))) files.push(relative)
    }
  }
  for (const root of SWEEP_ROOTS) walk(path.join(REPO_ROOT, root))
  return files
}

function matchingPatterns(source: string): string[] {
  return WRITER_PATTERNS.filter((pattern) => pattern.regex.test(source)).map((pattern) => pattern.name)
}

describe('user_roles has exactly one writer', () => {
  const swept = collectSweptFiles()

  it('the sweep actually reads a tree (domain floor)', () => {
    // "Found nothing" and "read nothing" are indistinguishable without this.
    expect(swept.length).toBeGreaterThan(200)
    expect(swept).toContain(BOUNDARY_FILE)
    expect(swept).toContain('packages/core-backend/src/routes/attendance-admin.ts')
    expect(swept).toContain('packages/core-backend/src/routes/admin-users.ts')
    expect(swept.some((file) => file.startsWith('plugins/'))).toBe(true)
  })

  it('every writer of the table is the boundary module and nothing else', () => {
    const writers = swept.filter((file) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8')
      return matchingPatterns(source).length > 0
    })
    expect(writers).toEqual([BOUNDARY_FILE])
  })

  it('POSITIVE CONTROL — each pattern fires on its own against a real file mutated in memory', () => {
    // One control per pattern, so a disjunct that can never match anything cannot hide behind
    // a sibling that does. The real file is read and mutated IN MEMORY: nothing is written to
    // the tree, which would race sibling suites under `pool: 'forks'`.
    const target = 'packages/core-backend/src/routes/attendance-admin.ts'
    const original = fs.readFileSync(path.join(REPO_ROOT, target), 'utf8')
    const needle = 'const ATTENDANCE_ROLE_ASSIGNMENT_SCOPE'
    expect(original).toContain(needle)
    expect(matchingPatterns(original)).toEqual([])

    for (const pattern of WRITER_PATTERNS) {
      const mutated = pattern.mutate(original, needle)
      expect(mutated, `${pattern.name} mutation must actually change the source`).not.toBe(original)
      expect(matchingPatterns(mutated), `${pattern.name} must fire`).toContain(pattern.name)
    }
  })

  it('POSITIVE CONTROL — the boundary module itself matches, so the set-equality is not empty-vs-empty', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, BOUNDARY_FILE), 'utf8')
    expect(matchingPatterns(source)).toEqual(expect.arrayContaining(['raw INSERT', 'raw DELETE']))
  })

  it('NEGATIVE CONTROL — reading the table does not trip the detector', () => {
    // Several modules legitimately SELECT from user_roles; if reads tripped the sweep it
    // would be red for the wrong reason and would be deleted rather than fixed.
    const reader = 'packages/core-backend/src/rbac/namespace-admission.ts'
    const source = fs.readFileSync(path.join(REPO_ROOT, reader), 'utf8')
    expect(source).toMatch(/FROM user_roles/)
    expect(matchingPatterns(source)).toEqual([])
  })

  it('the excluded directories are named, and the exclusion is what makes them invisible', () => {
    // States what is NOT covered instead of leaving a future reader to infer it from a glob.
    expect(EXCLUDED_DIRECTORIES).toContain('packages/core-backend/src/db/migrations')
    expect(EXCLUDED_DIRECTORIES).toContain('packages/core-backend/scripts')
    expect(isExcluded('packages/core-backend/src/db/migrations/zzzz20260208100000_create_roles_table.ts')).toBe(true)
    expect(isExcluded('packages/core-backend/scripts/seed-rbac.ts')).toBe(true)
    expect(isExcluded('packages/core-backend/src/rbac/role-assignment.ts')).toBe(false)
  })
})
