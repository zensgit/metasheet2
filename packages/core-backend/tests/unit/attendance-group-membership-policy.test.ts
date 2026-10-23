import { lockAndRecheckAttendanceLegacyGroupPreconditionsV1 } from '../../src/attendance/w4c3a-legacy-plan-preconditions'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const policy = require('../../../../plugins/plugin-attendance/lib/attendance-group-membership-policy.cjs')
const source = readFileSync(resolve(__dirname, '../../../../plugins/plugin-attendance/index.cjs'), 'utf8')
const orgId = 'synthetic-membership-org'
const member = (groupId: string, userId = 'synthetic-user') => ({ groupId, userId })

function fixture(existing: { group_id: string; user_id: string }[] = []) {
  const policies = new Map<string, { allow_multiple_groups: boolean; version: number }>()
  let transactionId = 'synthetic-transaction-1'
  const trx = { query: vi.fn(async (sql: string, args: unknown[] = []) => {
    const org = String(args[0])
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (sql.includes('txid_current()')) return { rows: [{ transaction_id: transactionId }] }
    if (sql.includes('INSERT INTO attendance_management_group_policies')) {
      if (!policies.has(org)) policies.set(org, { allow_multiple_groups: false, version: 0 })
      return { rows: [{ ...policies.get(org)! }] }
    }
    if (sql.includes('UPDATE attendance_management_group_policies')) {
      const row = policies.get(org)!
      row.allow_multiple_groups = args[1] as boolean
      row.version++
      return { rows: [{ ...row }] }
    }
    if (sql.includes('FROM attendance_management_group_policies')) return { rows: policies.has(org) ? [policies.get(org)] : [] }
    if (sql.includes('FROM attendance_group_members')) return { rows: org === orgId ? existing : [] }
    throw new Error('UNEXPECTED_SYNTHETIC_SQL')
  }) }
  return { trx, policies, newTransaction: () => { transactionId = 'synthetic-transaction-2' } }
}

describe('organization management-group membership policy', () => {
  it('defaults false/0, persists by org, increments only transitions and rejects every stale version', async () => {
    const { trx } = fixture()
    expect(await policy.readPolicy(trx, orgId)).toEqual({ orgId, allowMultipleGroups: false, version: 0 })
    expect(await policy.setPolicy(trx, orgId, { allowMultipleGroups: false, expectedVersion: 0 }))
      .toEqual({ orgId, allowMultipleGroups: false, version: 0 })
    expect(await policy.setPolicy(trx, orgId, { allowMultipleGroups: true, expectedVersion: 0 }))
      .toEqual({ orgId, allowMultipleGroups: true, version: 1 })
    expect(await policy.setPolicy(trx, orgId, { allowMultipleGroups: true, expectedVersion: 1 }))
      .toEqual({ orgId, allowMultipleGroups: true, version: 1 })
    await expect(policy.setPolicy(trx, orgId, { allowMultipleGroups: true, expectedVersion: 0 }))
      .rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_GROUP_MEMBERSHIP_POLICY_VERSION_CONFLICT' })
    expect(await policy.setPolicy(trx, orgId, { allowMultipleGroups: false, expectedVersion: 1 }))
      .toEqual({ orgId, allowMultipleGroups: false, version: 2 })
    expect(await policy.readPolicy(trx, 'synthetic-other-org'))
      .toEqual({ orgId: 'synthetic-other-org', allowMultipleGroups: false, version: 0 })
  })

  it.each([null, {}, [], { allowMultipleGroups: true }, { allowMultipleGroups: 'true', expectedVersion: 0 },
    { allowMultipleGroups: 1, expectedVersion: 0 }, { allowMultipleGroups: false, expectedVersion: -1 },
    { allowMultipleGroups: false, expectedVersion: 0.5 }, { allowMultipleGroups: false, expectedVersion: '0' },
    { allowMultipleGroups: false, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { allowMultipleGroups: false, expectedVersion: 0, orgId: 'injected' }])('rejects strict-input negative %#', body => {
    expect(() => policy.parsePolicyInput(body)).toThrow('ATTENDANCE_GROUP_MEMBERSHIP_POLICY_INVALID_INPUT')
  })

  it('rejects a new second group, including two groups in one batch, before member DML', async () => {
    const f = fixture([{ group_id: 'group-a', user_id: 'synthetic-user' }])
    await expect(policy.assertCanAddMembers(f.trx, orgId, [member('group-b')]))
      .rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' })
    const empty = fixture()
    await expect(policy.assertCanAddMembers(empty.trx, orgId, [member('group-a'), member('group-b')]))
      .rejects.toThrow('ATTENDANCE_MULTIPLE_GROUPS_DISABLED')
    expect(f.trx.query.mock.calls.some(([sql]) => /INSERT INTO attendance_group_members\s*\(/.test(sql))).toBe(false)
  })

  it('preserves legacy multiple memberships and same-group idempotency; true admits a new group', async () => {
    const f = fixture([{ group_id: 'group-a', user_id: 'synthetic-user' }, { group_id: 'group-b', user_id: 'synthetic-user' }])
    await policy.assertCanAddMembers(f.trx, orgId, [member('group-a'), member('group-b'), member('group-a')])
    await expect(policy.assertCanAddMembers(f.trx, orgId, [member('group-c')])).rejects.toThrow('ATTENDANCE_MULTIPLE_GROUPS_DISABLED')
    await policy.setPolicy(f.trx, orgId, { allowMultipleGroups: true, expectedVersion: 0 })
    await policy.assertCanAddMembers(f.trx, orgId, [member('group-c')])
    expect(f.trx.query.mock.calls.some(([sql]) => /DELETE|attendance_calculation_group_memberships/.test(sql))).toBe(false)
  })

  it('orders per-org/user locks and takes a row write fence before reading membership', async () => {
    const f = fixture()
    await policy.assertCanAddMembers(f.trx, orgId, [member('group-a', 'z'), member('group-a', 'a')])
    const calls = f.trx.query.mock.calls
    expect(calls[0][1]).toEqual([JSON.stringify(['attendance-timezone-policy-v1', orgId])])
    const keys = calls.filter(([sql]) => sql.includes('pg_advisory_xact_lock')).slice(1).map(([, args]) => JSON.parse(String(args[0])))
    expect(keys).toEqual([
      ['attendance-management-group-member-v1', orgId, 'a'],
      ['attendance-management-group-member-v1', orgId, 'z'],
    ])
    expect(calls.findIndex(([sql]) => sql.includes('ON CONFLICT (org_id) DO UPDATE')))
      .toBeLessThan(calls.findIndex(([sql]) => sql.includes('FROM attendance_group_members WHERE')))
  })

  it('requires exact transaction/org/assignment capability in the immutable effect phase, without rereading policy', async () => {
    const f = fixture()
    const members = [member('group-a')]
    await expect(policy.requireAdmission(f.trx, orgId, members)).rejects.toThrow('ATTENDANCE_GROUP_MEMBERSHIP_PRECONDITION_REQUIRED')
    await policy.prepareAdmission(f.trx, orgId, members)
    f.trx.query.mockClear()
    await policy.requireAdmission(f.trx, orgId, members)
    expect(f.trx.query.mock.calls.map(([sql]) => sql)).toEqual(['SELECT txid_current()::text AS transaction_id'])
    await expect(policy.requireAdmission(f.trx, 'other-org', members)).rejects.toThrow('ATTENDANCE_GROUP_MEMBERSHIP_PRECONDITION_REQUIRED')
    await expect(policy.requireAdmission(f.trx, orgId, [member('group-b')])).rejects.toThrow('ATTENDANCE_GROUP_MEMBERSHIP_PRECONDITION_REQUIRED')
    f.newTransaction()
    await expect(policy.requireAdmission(f.trx, orgId, members)).rejects.toThrow('ATTENDANCE_GROUP_MEMBERSHIP_PRECONDITION_REQUIRED')
  })

  it('canonicalizes group UUID capability keys while preserving user text casing', async () => {
    const groupId = 'aaaaaaaa-0000-4000-8000-000000000001'
    const f = fixture([{ group_id: groupId, user_id: 'synthetic-user' }])
    await policy.prepareAdmission(f.trx, orgId, [member(groupId.toUpperCase())])
    await policy.requireAdmission(f.trx, orgId, [member(groupId)])
    await expect(policy.requireAdmission(f.trx, orgId, [member(groupId, 'SYNTHETIC-USER')]))
      .rejects.toThrow('ATTENDANCE_GROUP_MEMBERSHIP_PRECONDITION_REQUIRED')
  })

  it('rejects frozen second-group admission in the real precondition boundary before immutable effects', async () => {
    const f = fixture([{ group_id: 'group-a', user_id: 'synthetic-user' }])
    const plan = {
      manifest: { orgId, groupRevision: 1, groupStateFingerprint: 'synthetic-fingerprint' },
      groupEffects: [{ kind: 'ensure_member', groupRef: 'group-b', userId: 'synthetic-user', membershipExistedAtPrepare: false }],
    }
    expect(await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(f.trx as never, plan as never)).toBe(false)
    expect(f.trx.query.mock.calls.some(([sql]) => /INSERT INTO attendance_(groups|group_members)\s*\(/.test(sql))).toBe(false)
    await expect(policy.requireAdmission(f.trx, orgId, [member('group-b')]))
      .rejects.toThrow('ATTENDANCE_GROUP_MEMBERSHIP_PRECONDITION_REQUIRED')
  })

  it('executes the actual plugin import batch helper and rejects before any chunk INSERT', async () => {
    const f = fixture([{ group_id: 'group-a', user_id: 'synthetic-user' }])
    const chunk = source.slice(source.indexOf('async function assertAttendanceManagementGroupAdmission('),
      source.indexOf('async function loadRuleSetConfigById('))
    const helper = vm.runInNewContext(chunk + '; insertAttendanceGroupMembers', {
      assertManagementGroupAdmission: policy.assertCanAddMembers,
      AttendanceGroupMembershipPolicyError: policy.AttendanceGroupMembershipPolicyError,
      HttpError: class extends Error { constructor(public status: number, public code: string) { super(code) } },
      assertActiveOrgMemberUserIds: async () => ['synthetic-user'],
    })
    await expect(helper(f.trx, orgId, [member('group-b')], {})).rejects.toMatchObject({ status: 409, code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' })
    expect(f.trx.query.mock.calls.some(([sql]) => /INSERT INTO attendance_group_members\s*\(/.test(sql))).toBe(false)
  })
})

describe('actual management-group member HTTP writer', () => {
  it('refuses a new second group before DML and event emission', async () => {
    const f = fixture([{ group_id: 'group-a', user_id: 'synthetic-user' }])
    let handler: (req: unknown, res: unknown, next: unknown, actor: unknown) => Promise<void>
    class HttpError extends Error {
      constructor(public status: number, public code: string) { super(code) }
    }
    const emitEvent = vi.fn()
    const marker = "    context.api.http.addRoute(\n      'POST',\n      '/api/attendance/groups/:id/members',"
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThan(0)
    const end = source.indexOf('    context.api.http.addRoute(', start + marker.length)
    const shape = { optional: () => null }
    vm.runInNewContext(source.slice(start, end), {
      context: { api: { http: { addRoute: (_method: string, _path: string, route: typeof handler) => { handler = route } } } },
      withAttendanceGroupMemberAccess: (_action: string, route: unknown) => route,
      z: { object: () => ({ safeParse: (data: unknown) => ({ success: true, data }) }), string: () => shape, array: () => shape },
      normalizeGroupMembersPayload: (data: unknown) => data,
      normalizeUuidString: (id: string) => id,
      db: { transaction: (work: (trx: unknown) => Promise<unknown>) => work(f.trx) },
      withAttendanceTimezoneSourceChange: (_trx: unknown, _input: unknown, work: () => Promise<unknown>) => work(),
      assertActiveOrgMemberUserIds: (_trx: unknown, _org: string, ids: string[]) => ids,
      assertAttendanceManagementGroupAdmission: async (...args: unknown[]) => {
        try { await policy.assertCanAddMembers(...args) } catch (error) {
          if (error instanceof policy.AttendanceGroupMembershipPolicyError) {
            const known = error as Error & { status: number; code: string }
            throw new HttpError(known.status, known.code)
          }
          throw error
        }
      },
      emitEvent, HttpError,
      attendanceHttpErrorBody: (error: HttpError) => ({ ok: false, error: { code: error.code } }),
      isDatabaseSchemaError: () => false,
      logger: { error: vi.fn() },
    })
    const result = { status: 200, body: undefined as unknown }
    const res = { status: (status: number) => { result.status = status; return res }, json: (body: unknown) => { result.body = body } }
    await handler!({ params: { id: 'group-b' }, body: { userIds: ['synthetic-user'] } }, res, undefined, { orgId, userId: 'synthetic-admin', scope: 'org' })
    expect(result).toEqual({ status: 409, body: { ok: false, error: { code: 'ATTENDANCE_MULTIPLE_GROUPS_DISABLED' } } })
    expect(emitEvent).not.toHaveBeenCalled()
    expect(f.trx.query.mock.calls.some(([sql]) => /INSERT INTO attendance_group_members\s*\(/.test(sql))).toBe(false)
  })
})

describe('policy API boundary', () => {
  function api() {
    const f = fixture()
    const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
    const actorSource = source.slice(source.indexOf('function resolveAttendanceGroupRouteActorContext('),
      source.indexOf('function getAuthenticatedTokenSubjectUserId('))
    const resolveActor = vm.runInNewContext(actorSource + '; resolveAttendanceGroupRouteActorContext', {
      getAuthenticatedUserId: (req: { user?: { id: string } }) => req.user?.id,
      getAuthenticatedOrgId: (req: { user?: { orgId: string } }) => req.user?.orgId,
    })
    const authorizeManage = vi.fn(async ({ actorId }: { actorId: string }) => actorId === 'synthetic-admin')
    policy.registerGroupMembershipPolicyRoutes({
      addRoute: (method: string, path: string, handler: (req: unknown, res: unknown) => Promise<void>) => routes.set(method + ' ' + path, handler),
      withPermission: (permission: string, handler: unknown) => { expect(permission).toBe('attendance:admin'); return handler },
      resolveActor, db: { transaction: (work: (trx: unknown) => Promise<unknown>) => work(f.trx) }, authorizeManage,
    })
    async function invoke(method: string, overrides: Record<string, unknown> = {}) {
      const result = { status: 200, body: undefined as unknown }
      const res = { status: (status: number) => { result.status = status; return res }, json: (body: unknown) => { result.body = body } }
      await routes.get(method + ' /api/attendance/group-membership-policy')!({
        user: { id: 'synthetic-admin', orgId }, headers: {}, query: { orgId }, ...overrides,
      }, res)
      return result
    }
    return { ...f, invoke, authorizeManage }
  }
  it('returns exact GET and POST acknowledgments', async () => {
    const f = api()
    expect(await f.invoke('GET')).toEqual({ status: 200, body: { ok: true, data: { orgId, allowMultipleGroups: false, version: 0 } } })
    expect(await f.invoke('POST', { body: { allowMultipleGroups: true, expectedVersion: 0 } }))
      .toEqual({ status: 200, body: { ok: true, data: { orgId, allowMultipleGroups: true, version: 1 } } })
    expect(await f.invoke('POST', { body: { allowMultipleGroups: false, expectedVersion: 0 } }))
      .toEqual({ status: 409, body: { ok: false, error: { code: 'ATTENDANCE_GROUP_MEMBERSHIP_POLICY_VERSION_CONFLICT' } } })
  })
  it('rejects malformed POST without SQL and returns storage errors without raw values', async () => {
    const f = api()
    expect(await f.invoke('POST', { body: { allowMultipleGroups: 'true', expectedVersion: 0 } }))
      .toEqual({ status: 400, body: { ok: false, error: { code: 'ATTENDANCE_GROUP_MEMBERSHIP_POLICY_INVALID_INPUT' } } })
    expect(f.trx.query).not.toHaveBeenCalled()
    f.trx.query.mockRejectedValue(new Error('synthetic-private-driver-detail'))
    expect(await f.invoke('GET')).toEqual({ status: 503, body: { ok: false, error: { code: 'ATTENDANCE_GROUP_MEMBERSHIP_POLICY_UNAVAILABLE' } } })
  })

  it.each(['GET', 'POST'])('rejects unauthenticated, missing-org, wrong-org, non-admin and inactive actors on %s', async method => {
    const f = api()
    const body = { allowMultipleGroups: true, expectedVersion: 0 }
    expect((await f.invoke(method, { user: undefined, body })).status).toBe(401)
    expect((await f.invoke(method, { user: { id: 'synthetic-admin' }, body })).status).toBe(403)
    expect((await f.invoke(method, { query: { orgId: 'other-org' }, body })).status).toBe(404)
    expect((await f.invoke(method, { headers: { 'x-org-id': 'other-org' }, body })).status).toBe(404)
    expect((await f.invoke(method, { user: { id: 'employee', orgId }, body })).status).toBe(403)
    f.authorizeManage.mockResolvedValue(false)
    expect((await f.invoke(method, { body })).status).toBe(403)
    expect(f.policies.size).toBe(0)
  })
})

describe('production writer coverage', () => {
  it('takes the shared org prefix before reservation/business locks in both legacy import hosts', () => {
    const nullHost = source.slice(source.indexOf('async function runAttendanceLegacyNullVersionCommitAtomically('),
      source.indexOf('const ATTENDANCE_IMPORT_STARTUP_RECOVERY_PAGE_SIZE'))
    const reservation = nullHost.indexOf('await acquireAttendanceSyncImportReservationLocks(')
    expect(reservation).toBeGreaterThan(0)
    expect(reservation).toBeLessThan(nullHost.indexOf('const lockedJobs ='))
    const reservationHost = source.slice(source.indexOf('async function acquireAttendanceSyncImportReservationLocks('),
      source.indexOf('async function runAttendanceLegacyNullVersionCommitAtomically('))
    const boundedOrgPrefix = reservationHost.indexOf('[attendanceManagementGroupOrgLockKey(orgId)]')
    expect(boundedOrgPrefix).toBeGreaterThan(reservationHost.indexOf('const deadline ='))
    expect(boundedOrgPrefix).toBeLessThan(reservationHost.indexOf('[normalizedWitness.rolloutKey]'))
    expect(reservationHost).toContain('await lockAttendanceManagementGroupOrg(client, orgId)')
    const directStart = source.indexOf('await runCommitTransaction(async (trx) => {')
    const directHost = source.slice(directStart, source.indexOf('if (prepareOnly && groupSync?.autoCreate)', directStart))
    const directPrefix = directHost.indexOf('if (!prepareOnly) await lockAttendanceManagementGroupOrg(trx, orgId)')
    expect(directPrefix).toBeGreaterThan(0)
    expect(directPrefix).toBeLessThan(directHost.indexOf('await acquireImportIdempotencyLock('))
    expect(directPrefix).toBeLessThan(directHost.indexOf('await ensureAttendanceGroups('))
    const backend = (name: string) => readFileSync(resolve(__dirname, '../../src/attendance/' + name), 'utf8')
    const sync = backend('w4c3a-sync-import-host.ts')
    const asyncHost = backend('w4c3a-legacy-plan-processor.ts')
    const syncPrefix = sync.indexOf('await acquireAttendanceImportTimezonePrefixV1(trx, input.orgId)')
    const asyncPrefix = asyncHost.indexOf('await acquireAttendanceImportTimezonePrefixV1(trx, orgId)')
    expect(syncPrefix).toBeGreaterThan(0)
    expect(asyncPrefix).toBeGreaterThan(0)
    expect(syncPrefix).toBeLessThan(sync.indexOf("await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')"))
    expect(asyncPrefix).toBeLessThan(asyncHost.indexOf("await acquireAttendanceCalculationRolloutLock(trx, orgKey, 'shared')"))
  })

  it('keeps all four member insert sites behind policy admission and frozen policy reads outside effects', () => {
    const backend = (name: string) => readFileSync(resolve(__dirname, '../../src/' + name), 'utf8')
    expect(source).toMatch(/await assertAttendanceManagementGroupAdmission\(db, orgId, members\)/)
    expect(source).toMatch(/await assertAttendanceManagementGroupAdmission\(trx, orgId,[\s\S]*?acceptedUserIds\.map/)
    expect(backend('routes/admin-users.ts')).toMatch(/await assertAttendanceManagementGroupAdmission\(client, attendanceOrgId,[\s\S]*?INSERT INTO attendance_group_members/)
    expect(readFileSync(resolve(__dirname, '../../../../.github/workflows/plugin-tests.yml'), 'utf8'))
      .toContain('tests/integration/attendance-group-membership-policy.db.test.ts')
    expect(readFileSync(resolve(__dirname, '../../vitest.config.ts'), 'utf8'))
      .toContain("'tests/integration/attendance-group-membership-policy.db.test.ts'")
    const preconditions = backend('attendance/w4c3a-legacy-plan-preconditions.ts')
    expect(preconditions.indexOf('await prepareAttendanceManagementGroupAdmission')).toBeLessThan(preconditions.indexOf('// 1-3: lock frozen-existing groups'))
    const effects = backend('attendance/w4c3a-legacy-plan-group-effects.ts')
    expect(effects).toContain('await requireAttendanceManagementGroupAdmission')
    expect(effects).not.toMatch(/readPolicy|setPolicy|assertCanAddMembers/)
  })
})
