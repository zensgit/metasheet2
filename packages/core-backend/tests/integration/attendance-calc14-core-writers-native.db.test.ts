import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createOnlinePunchDbFixture } from '../utils/attendance-online-punch-db'
import { seedAttendanceW7ContextSourcePostureV1 } from '../utils/w7-context-source-posture-fixture'

// Main runs this NEW whole file in a fresh process after the current native batch.
// No fallback URL, auth/SQL mocks, fake clock, invented trigger or schema changes.
const ownedUrl = process.env.ATTENDANCE_TEST_DATABASE_URL
if (!ownedUrl || process.env.DATABASE_URL !== ownedUrl) {
  throw new Error('CALC14_CORE_WRITERS_MATCHED_OWNED_DATABASE_REQUIRED')
}
const host = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
const prior = {
  w4: process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED,
  w7: process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED,
}
const run = 'calc14native_' + randomUUID().replace(/-/g, '')
const groupId = randomUUID()
const otherGroupId = randomUUID()
const shiftId = randomUUID()
const groupName = 'CALC14 native core writer group'
const shiftName = 'CALC14 native core writer shift'
const adminRoute = '/api/admin/users'
const w1Route = '/api/attendance-admin/calculation-group-memberships/transition'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const day = (offset: number) => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
    .toISOString().slice(0, 10)
}
const dates = { assignment: day(2), admin: day(3), effectiveOn: day(4), w1: day(5), next: day(6) }
let admin: Awaited<ReturnType<typeof host.start>>
let createdUserId: string
let assignmentId: string
let transitioned: Record<string, unknown>
const transitionCorrelation = randomUUID()
const reason = 'CALC14 native ordinary transition'

function adminInput(tag: string, businessEffectiveDate?: string) {
  return {
    username: run + '_' + tag, name: 'CALC14 native ' + tag,
    password: 'T3st-Only-9a!Calc14', role: 'user', isActive: true,
    orgId: host.orgId, attendanceGroupId: groupId,
    defaultShiftId: shiftId, defaultShiftStartDate: dates.assignment,
    ...(businessEffectiveDate === undefined ? {} : { businessEffectiveDate }),
  }
}
function transitionInput(correlationId: string, extra: Record<string, unknown> = {}) {
  return {
    orgId: host.orgId, userId: createdUserId, targetGroupId: groupId,
    effectiveOn: dates.effectiveOn, reason, correlationId, ...extra,
  }
}
async function sources() {
  return (await host.pool.query(
    `SELECT id::text, source_kind, source_id, business_effective_date::text,
       event_kind, actor_id, correlation_id, payload
     FROM attendance_calc14_source_versions WHERE org_id=$1 ORDER BY id`,
    [host.orgId],
  )).rows
}
async function state() {
  const counts = (await host.pool.query(
    `SELECT
      (SELECT count(*)::int FROM users WHERE username LIKE $2) AS users,
      (SELECT count(*)::int FROM user_orgs WHERE org_id=$1) AS user_orgs,
      (SELECT count(*)::int FROM attendance_group_members WHERE org_id=$1) AS group_members,
      (SELECT count(*)::int FROM attendance_shift_assignments WHERE org_id=$1) AS assignments,
      (SELECT count(*)::int FROM attendance_calculation_group_memberships WHERE org_id=$1) AS memberships,
      (SELECT count(*)::int FROM attendance_calculation_group_membership_operations WHERE org_id=$1) AS operations,
      (SELECT count(*)::int FROM attendance_calc14_source_versions WHERE org_id=$1) AS versions`,
    [host.orgId, run + '%'],
  )).rows
  expect(counts).toHaveLength(1)
  return { counts: counts[0], sources: await sources() }
}
async function candidateUsers(tag: string) {
  return (await host.pool.query('SELECT id::text FROM users WHERE username=$1', [run + '_' + tag])).rows
}
async function membershipRows() {
  return (await host.pool.query(
    `SELECT id::text, org_id, user_id::text, group_id::text, effective_from::text, effective_to::text,
       assigned_by, assigned_reason, assigned_correlation_id,
       closed_by, closed_reason, closed_correlation_id, created_at, updated_at, xmin::text AS transaction_id
     FROM attendance_calculation_group_memberships
     WHERE org_id=$1 AND user_id=$2 ORDER BY effective_from,id`,
    [host.orgId, createdUserId],
  )).rows
}
async function currentPublication() {
  return (await host.pool.query(
    "SELECT attendance_calc14_source_payload($1,'user_publication',$2) AS payload",
    [host.orgId, createdUserId],
  )).rows[0].payload
}
function errorBody(code: string) { return { ok: false, error: { code, message: code } } }

beforeAll(async () => {
  // Existing test-only exact-org posture; no new switch or external writer.
  delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  process.env.ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED = host.orgId
  admin = await host.start() // real src/index host; RBAC=false/false before dynamic import
  expect([process.env.RBAC_BYPASS, process.env.RBAC_TOKEN_TRUST]).toEqual(['false', 'false'])
  const claims = JSON.parse(Buffer.from(admin.token.split('.')[1], 'base64url').toString('utf8'))
  expect(claims.roles).toEqual(['viewer'])
  // isAdmin reads THIS actual user_roles row, rather than users.is_admin or token perms.
  const role = await host.pool.query("SELECT id FROM roles WHERE id='admin'")
  expect(role.rows).toEqual([{ id: 'admin' }])
  await host.pool.query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin') ON CONFLICT DO NOTHING", [admin.userId])
  const actor = await host.pool.query(
    `SELECT u.id::text AS user_id, ur.role_id, u.is_active AS user_active, uo.org_id, uo.is_active AS org_active
     FROM users u JOIN user_roles ur ON ur.user_id=u.id AND ur.role_id='admin'
     JOIN user_orgs uo ON uo.user_id=u.id AND uo.org_id=$2 WHERE u.id=$1`,
    [admin.userId, host.orgId],
  )
  expect(actor.rows).toEqual([{
    user_id: admin.userId, role_id: 'admin', user_active: true, org_id: host.orgId, org_active: true,
  }])
  // Virgin source setup while persisted W7 posture is OFF. No fabricated prehistory.
  await host.pool.query(
    `INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,is_overnight,
       late_grace_minutes,early_grace_minutes,rounding_minutes,working_days,flex_mode)
     VALUES($1,$2,$3,'UTC','09:00','17:00',false,5,5,5,'[0,1,2,3,4,5,6]'::jsonb,'strict')`,
    [shiftId, host.orgId, shiftName],
  )
  await host.pool.query(
    `INSERT INTO attendance_shift_segments(id,org_id,shift_id,segment_index,start_time,end_time,start_day_offset,end_day_offset)
     VALUES($1,$2,$3,0,'09:00','17:00',0,0)`,
    [randomUUID(), host.orgId, shiftId],
  )
  for (const id of [groupId, otherGroupId]) {
    await host.pool.query(
      `INSERT INTO attendance_groups(id,org_id,name,code,attendance_type,timezone)
       VALUES($1,$2,$3,$4,'fixed_shift','UTC')`,
      [id, host.orgId, id === groupId ? groupName : groupName + ' alternate', 'calc14-core-' + id],
    )
  }
  await seedAttendanceW7ContextSourcePostureV1(host.pool, host.orgId, 'group_shadow', {
    actorId: admin.userId, engineVersion: 'calc14-core-writers-native',
  })
  expect((await host.pool.query(
    'SELECT state,scope FROM attendance_calculation_context_source_state WHERE org_id=$1', [host.orgId],
  )).rows).toEqual([{ state: 'group_shadow', scope: 'synthetic_staging' }])
  expect(await sources()).toEqual([])
}, 120000)

afterAll(async () => {
  process.env.NODE_ENV = 'test' // Shared setup clears it before the fixture clock cleanup.
  try { await host.stop() } finally {
    for (const [key, value] of [
      ['ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED', prior.w4],
      ['ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED', prior.w7],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}, 60000)

describe.sequential('CALC14 actual core writers with real PG and database admin', () => {
  it('admin-create missing date rolls back users, onboarding rows and native source capture', async () => {
    const before = await state()
    expect(before.counts).toEqual({
      users: 0, user_orgs: 1, group_members: 0, assignments: 0, memberships: 0, operations: 0, versions: 0,
    })
    const response = await host.request(adminRoute, admin.token, adminInput('missing'))
    expect(response.status).toBe(422)
    expect(response.body).toEqual(errorBody('ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED'))
    expect(await candidateUsers('missing')).toEqual([])
    expect(await state()).toEqual(before)
  })

  it('admin-create future date captures membership and assignment in the actual user transaction', async () => {
    const response = await host.request(adminRoute, admin.token, adminInput('admitted', dates.admin))
    expect(response.status).toBe(200)
    const users = await host.pool.query('SELECT id::text,created_at,updated_at,xmin::text AS transaction_id FROM users WHERE username=$1', [run + '_admitted'])
    expect(users.rows).toHaveLength(1)
    createdUserId = users.rows[0].id
    expect(createdUserId).toMatch(uuid)
    const onboard = await host.pool.query(
      `SELECT gm.user_id::text,gm.group_id::text,gm.xmin::text AS member_tx,
         a.id::text AS assignment_id,a.shift_id::text,a.start_date::text,a.is_active,
         a.xmin::text AS assignment_tx,uo.xmin::text AS org_tx
       FROM attendance_group_members gm JOIN attendance_shift_assignments a
         ON a.org_id=gm.org_id AND a.user_id=gm.user_id
       JOIN user_orgs uo ON uo.org_id=gm.org_id AND uo.user_id=gm.user_id
       WHERE gm.org_id=$1 AND gm.user_id=$2`,
      [host.orgId, createdUserId],
    )
    expect(onboard.rows).toHaveLength(1)
    assignmentId = onboard.rows[0].assignment_id
    expect(assignmentId).toMatch(uuid)
    const tx = users.rows[0].transaction_id
    expect(tx).toMatch(/^\d+$/)
    expect(onboard.rows).toEqual([{
      user_id: createdUserId, group_id: groupId, member_tx: tx,
      assignment_id: assignmentId, shift_id: shiftId, start_date: dates.assignment, is_active: true,
      assignment_tx: tx, org_tx: tx,
    }])
    const { buildOnboardingPacket } = await import('../../src/auth/access-presets')
    expect(response.body).toEqual({ ok: true, data: {
      user: {
        id: createdUserId, email: null, username: run + '_admitted', name: 'CALC14 native admitted',
        mobile: null, employeeNo: null, department: null, position: null, hireDate: null,
        role: 'user', is_active: true, is_admin: false, activationStatus: 'activated', localPasswordSet: true,
        last_login_at: null, created_at: users.rows[0].created_at.toISOString(), updated_at: users.rows[0].updated_at.toISOString(),
      },
      roles: [], permissions: [], isAdmin: false, actorId: admin.userId, inviteToken: null,
      onboarding: buildOnboardingPacket({
        email: null, accountLabel: run + '_admitted', temporaryPassword: null, preset: null, inviteToken: null,
      }),
      attendanceOnboarding: {
        orgId: host.orgId, group: { id: groupId, name: groupName, memberCreated: true },
        defaultShift: { id: shiftId, name: shiftName, startDate: dates.assignment, assignmentId },
      },
    } })
    const captured = await sources()
    expect(captured.map(({ id: _id, payload: _payload, ...source }) => source)).toEqual([
      { source_kind: 'members', source_id: groupId, business_effective_date: dates.admin, event_kind: 'version', actor_id: admin.userId, correlation_id: tx },
      { source_kind: 'user_publication', source_id: createdUserId, business_effective_date: dates.admin, event_kind: 'version', actor_id: admin.userId, correlation_id: tx },
    ])
    expect(captured[0].payload).toEqual([{ user_id: createdUserId }])
    expect(captured[1].payload).toEqual(await currentPublication())
    expect(captured[1].payload.memberships).toEqual([])
    expect(captured[1].payload.rotations).toEqual([])
    expect(captured[1].payload.assignments.map((assignment: { id: string; shift_id: string; start_date: string }) => ({
      id: assignment.id, shift_id: assignment.shift_id, start_date: assignment.start_date,
    }))).toEqual([{ id: assignmentId, shift_id: shiftId, start_date: dates.assignment }])
    expect((await state()).counts).toEqual({
      users: 1, user_orgs: 2, group_members: 1, assignments: 1, memberships: 0, operations: 0, versions: 2,
    })
    expect(dates.admin).not.toBe(dates.assignment)
  })

  it('W1 missing source date rolls back membership, operation and versions through the registered native guard', async () => {
    const before = await state()
    const correlationId = randomUUID()
    const response = await host.request(w1Route, admin.token, transitionInput(correlationId))
    expect(response.status).toBe(422)
    expect(response.body).toEqual(errorBody('ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED'))
    expect(await membershipRows()).toEqual([])
    expect((await host.pool.query(
      'SELECT correlation_id FROM attendance_calculation_group_membership_operations WHERE org_id=$1 AND correlation_id=$2',
      [host.orgId, correlationId],
    )).rows).toEqual([])
    expect(await state()).toEqual(before)
  })

  it('W1 consumes a future source date distinct from effectiveOn and captures the real membership transaction', async () => {
    const before = await sources()
    const response = await host.request(w1Route, admin.token, transitionInput(transitionCorrelation, {
      businessEffectiveDate: dates.w1, actorId: randomUUID(),
    }))
    expect(response.status).toBe(200)
    const rows = await membershipRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.id).toMatch(uuid)
    const membership = {
      id: row.id, orgId: host.orgId, userId: createdUserId, groupId,
      effectiveFrom: dates.effectiveOn, effectiveTo: null,
      assignedBy: admin.userId, assignedReason: reason, assignedCorrelationId: transitionCorrelation,
      closedBy: null, closedReason: null, closedCorrelationId: null,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    }
    transitioned = { ok: true, data: { correlationId: transitionCorrelation, outcome: 'transitioned', membership } }
    expect(response.body).toEqual(transitioned)
    expect(rows).toEqual([{
      id: row.id, org_id: host.orgId, user_id: createdUserId, group_id: groupId,
      effective_from: dates.effectiveOn, effective_to: null,
      assigned_by: admin.userId, assigned_reason: reason, assigned_correlation_id: transitionCorrelation,
      closed_by: null, closed_reason: null, closed_correlation_id: null,
      created_at: row.created_at, updated_at: row.updated_at, transaction_id: row.transaction_id,
    }])
    expect((await host.pool.query(
      `SELECT org_id,correlation_id,user_id::text,target_group_id::text,effective_on::text,actor_id,reason,
         result_membership_id::text,result_snapshot,outcome,xmin::text AS transaction_id
       FROM attendance_calculation_group_membership_operations WHERE org_id=$1 AND correlation_id=$2`,
      [host.orgId, transitionCorrelation],
    )).rows).toEqual([{
      org_id: host.orgId, correlation_id: transitionCorrelation, user_id: createdUserId, target_group_id: groupId,
      effective_on: dates.effectiveOn, actor_id: admin.userId, reason, result_membership_id: row.id,
      result_snapshot: membership, outcome: 'transitioned', transaction_id: row.transaction_id,
    }])
    const after = await sources()
    expect(after.slice(0, before.length)).toEqual(before)
    const added = after.slice(before.length)
    expect(added).toHaveLength(1)
    expect(added.map(({ id: _id, payload: _payload, ...source }) => source)).toEqual([{
      source_kind: 'user_publication', source_id: createdUserId, business_effective_date: dates.w1,
      event_kind: 'version', actor_id: admin.userId, correlation_id: row.transaction_id,
    }])
    expect(added[0].payload).toEqual(await currentPublication())
    expect(added[0].payload.memberships).toEqual([{
      id: row.id, group_id: groupId, effective_from: dates.effectiveOn, effective_to: null,
    }])
    expect((await state()).counts).toEqual({
      users: 1, user_orgs: 2, group_members: 1, assignments: 1, memberships: 1, operations: 1, versions: 3,
    })
    expect(dates.w1).not.toBe(dates.effectiveOn)
  })

  it('W1 same-group no-op and exact replay need no date and append no source version', async () => {
    const before = await state()
    const rows = await membershipRows()
    const correlationId = randomUUID()
    const response = await host.request(w1Route, admin.token, transitionInput(correlationId))
    expect(response.status).toBe(200)
    const original = transitioned.data as { membership: unknown }
    expect(response.body).toEqual({ ok: true, data: {
      correlationId, outcome: 'unchanged', membership: original.membership,
    } })
    const afterNoop = await state()
    expect(afterNoop).toEqual({
      counts: { ...before.counts, operations: before.counts.operations + 1 }, sources: before.sources,
    })
    expect(await membershipRows()).toEqual(rows)
    expect((await host.pool.query(
      `SELECT correlation_id,outcome,result_snapshot FROM attendance_calculation_group_membership_operations
       WHERE org_id=$1 AND correlation_id=$2`, [host.orgId, correlationId],
    )).rows).toEqual([{ correlation_id: correlationId, outcome: 'unchanged', result_snapshot: original.membership }])
    const replay = await host.request(w1Route, admin.token, transitionInput(transitionCorrelation))
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(transitioned)
    expect(await state()).toEqual(afterNoop)
    expect(await membershipRows()).toEqual(rows)
  })

  it('native same-source date conflicts atomically roll back admin admission and a W1 close/replace', async () => {
    const before = await state()
    // Different member payload on the already retained ordinary day: real
    // deferred source capture raises23514/409 after valid onboarding DML.
    const rejectedAdmin = await host.request(adminRoute, admin.token, adminInput('conflict', dates.admin))
    expect(rejectedAdmin.status).toBe(409)
    expect(rejectedAdmin.body).toEqual(errorBody('ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT'))
    expect(await candidateUsers('conflict')).toEqual([])
    expect(await state()).toEqual(before)

    const rows = await membershipRows()
    const correlationId = randomUUID()
    // Closing the old interval and inserting another group changes the same
    // user_publication source on its retained day. No invented trigger/fault.
    const rejectedW1 = await host.request(w1Route, admin.token, transitionInput(correlationId, {
      targetGroupId: otherGroupId, effectiveOn: dates.next, businessEffectiveDate: dates.w1,
    }))
    expect(rejectedW1.status).toBe(409)
    expect(rejectedW1.body).toEqual(errorBody('ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT'))
    expect(await membershipRows()).toEqual(rows)
    expect((await host.pool.query(
      'SELECT correlation_id FROM attendance_calculation_group_membership_operations WHERE org_id=$1 AND correlation_id=$2',
      [host.orgId, correlationId],
    )).rows).toEqual([])
    expect(await state()).toEqual(before)
  })
})

// Reuses the original host/startup/RBAC posture. Run these NEW two cases with
// the C14_HTTP_POPULATED_ filter; old cases need no execution for this addition.
async function populatedForeignCoreSource() {
  const foreign = { org: randomUUID(), user: randomUUID(), group: randomUUID(), shift: randomUUID(), ruleSet: randomUUID() }
  const client = await host.pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('metasheet.calc14_org',$1,true),
      set_config('metasheet.calc14_date_required','true',true),
      set_config('metasheet.calc14_business_effective_date',$2,true),
      set_config('metasheet.calc14_actor',$3,true)`, [foreign.org, day(10), foreign.user])
    await client.query(`INSERT INTO users(id,username,name,password_hash,role,is_active,is_admin)
      VALUES($1,$1,'CALC14 foreign active synthetic user','disabled','user',true,false)`, [foreign.user])
    await client.query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)', [foreign.user, foreign.org])
    await client.query(`INSERT INTO attendance_rules(id,org_id,name,timezone,is_default,
      severe_late_threshold_minutes,absence_late_threshold_minutes,working_days)
      VALUES($1,$2,'CALC14 foreign rule','Asia/Taipei',true,30,120,'[0,1,2,3,4,5,6]'::jsonb)`, [randomUUID(), foreign.org])
    await client.query(`INSERT INTO attendance_rule_sets(id,org_id,name,version,scope,config,is_default)
      VALUES($1,$2,'CALC14 foreign rule set',1,'org','{"rule":{"lateGraceMinutes":2}}'::jsonb,false)`, [foreign.ruleSet, foreign.org])
    await client.query(`INSERT INTO attendance_shifts(id,org_id,name,timezone,work_start_time,work_end_time,
      is_overnight,late_grace_minutes,early_grace_minutes,rounding_minutes,working_days,flex_mode)
      VALUES($1,$2,'CALC14 foreign shift','Asia/Taipei','07:00','15:00',false,2,3,10,'[0,1,2,3,4,5,6]'::jsonb,'strict')`, [foreign.shift, foreign.org])
    await client.query(`INSERT INTO attendance_shift_segments(id,org_id,shift_id,segment_index,start_time,end_time,start_day_offset,end_day_offset)
      VALUES($1,$2,$3,0,'07:00','15:00',0,0)`, [randomUUID(), foreign.org, foreign.shift])
    await client.query(`INSERT INTO attendance_groups(id,org_id,name,code,attendance_type,timezone,rule_set_id)
      VALUES($1,$2,'CALC14 foreign group',$4,'fixed_shift','Asia/Taipei',$3)`, [foreign.group, foreign.org, foreign.ruleSet, foreign.group])
    await client.query(`INSERT INTO attendance_group_fixed_schedule_configs(org_id,group_id,shift_id,start_date,end_date,revision,updated_by)
      VALUES($1,$2,$3,$4,$5,1,$6)`, [foreign.org, foreign.group, foreign.shift, day(2), day(100), foreign.user])
    await client.query('INSERT INTO attendance_group_members(org_id,group_id,user_id) VALUES($1,$2,$3)', [foreign.org, foreign.group, foreign.user])
    const { createRequire } = await import('node:module')
    const { buildAttendanceGroupFixedScheduleProducerKey } = createRequire(import.meta.url)(
      '../../../../plugins/plugin-attendance/lib/attendance-group-fixed-schedule-producer-key.cjs')
    const key = buildAttendanceGroupFixedScheduleProducerKey({ groupId: foreign.group, shiftId: foreign.shift, startDate: day(2), endDate: day(100) })
    await client.query(`INSERT INTO attendance_shift_assignments(id,org_id,user_id,shift_id,start_date,end_date,is_active,
      producer_type,producer_ref_id,producer_key,producer_run_id,publish_status,slot_index)
      VALUES($1,$2,$3,$4,$5,$6,true,'attendance_group_fixed_schedule',$7,$8,$9,'published',0)`,
    [randomUUID(), foreign.org, foreign.user, foreign.shift, day(2), day(100), foreign.group, key, randomUUID()])
    await client.query(`INSERT INTO attendance_calculation_group_memberships(org_id,user_id,group_id,effective_from,
      assigned_by,assigned_reason,assigned_correlation_id) VALUES($1,$2,$3,$4,$2,'trusted-synthetic-foreign',$5)`,
    [foreign.org, foreign.user, foreign.group, day(2), randomUUID()])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  // Positive SQL evidence that the negative's foreign IDs are complete inputs,
  // not random, inactive or dangling targets. This does not assert HTTP admission.
  const { readAttendanceCalc14GroupSourcesV1, readAttendanceCalc14UserPublicationV1 } = await import('../../src/attendance/attendance-calc14-source-history')
  const readClient = await host.pool.connect()
  try {
    await readClient.query('BEGIN')
    const trx = { query: async (text: string, values?: unknown[]) => {
      const result = await readClient.query(text, values)
      return { rows: result.rows as Array<Record<string, unknown>> }
    } }
    const source = await readAttendanceCalc14GroupSourcesV1(trx, { orgId: foreign.org, groupId: foreign.group, workDate: day(20) })
    if (!source) throw new Error('CALC14_FOREIGN_COMPLETE_SOURCE_REQUIRED')
    expect({ org: source.group.org_id, shift: source.shift.id, members: source.members, publications: source.publication.length })
      .toEqual({ org: foreign.org, shift: foreign.shift, members: [{ user_id: foreign.user }], publications: 1 })
    const publication = await readAttendanceCalc14UserPublicationV1(trx, { orgId: foreign.org, userId: foreign.user, workDate: day(20) })
    if (!publication) throw new Error('CALC14_FOREIGN_PUBLICATION_REQUIRED')
    expect({ groups: publication.memberships.map(row => row.group_id), assignments: publication.assignments.map(row => row.shift_id), rotations: publication.rotations })
      .toEqual({ groups: [foreign.group], assignments: [foreign.shift], rotations: [] })
    await readClient.query('COMMIT')
  } catch (error) { await readClient.query('ROLLBACK'); throw error } finally { readClient.release() }
  expect((await host.pool.query(`SELECT u.is_active AS user_active,uo.org_id,uo.is_active AS org_active
    FROM users u JOIN user_orgs uo ON uo.user_id=u.id WHERE u.id=$1 ORDER BY uo.org_id`, [foreign.user])).rows)
    .toEqual([{ user_active: true, org_id: foreign.org, org_active: true }])
  return foreign
}
async function coreIsolationBytes(orgs: string[], identities: string[]) {
  const bytes: Record<string, string[]> = {}
  for (const table of ['user_orgs', 'attendance_groups', 'attendance_rules', 'attendance_rule_sets', 'attendance_shifts',
    'attendance_shift_segments', 'attendance_group_fixed_schedule_configs', 'attendance_group_members',
    'attendance_shift_assignments', 'attendance_rotation_assignments', 'attendance_calculation_group_memberships',
    'attendance_calculation_group_membership_operations', 'attendance_calc14_source_versions']) {
    bytes[table] = (await host.pool.query(`SELECT to_jsonb(t)::text AS bytes FROM ${table} t
      WHERE org_id=ANY($1::text[]) ORDER BY to_jsonb(t)::text`, [orgs])).rows.map(row => row.bytes)
  }
  bytes.users = (await host.pool.query(`SELECT to_jsonb(u)::text AS bytes FROM users u
    WHERE id::text=ANY($1::text[]) OR ($3::boolean AND username LIKE $2) ORDER BY id`, [identities, run + '%', orgs.includes(host.orgId)])).rows.map(row => row.bytes)
  return bytes
}

describe.sequential('CALC14 populated native writer scope negatives', () => {
  it('C14_HTTP_POPULATED_ADMIN_GROUP: current-org admin-create rejects a complete foreign group and admits own group', async () => {
    const foreign = await populatedForeignCoreSource()
    const before = await state()
    const ownBytes = await coreIsolationBytes([host.orgId], [admin.userId])
    const foreignBytes = await coreIsolationBytes([foreign.org], [foreign.user])
    const tag = 'populated_group'
    const input = adminInput(tag, day(20))
    const rejected = await host.request(adminRoute, admin.token, { ...input, attendanceGroupId: foreign.group })
    expect(rejected.status).toBe(404)
    expect(rejected.body).toEqual({ ok: false, error: { code: 'ATTENDANCE_GROUP_NOT_FOUND', message: 'Attendance group not found' } })
    expect(await candidateUsers(tag)).toEqual([])
    expect(await state()).toEqual(before)
    expect(await coreIsolationBytes([host.orgId], [admin.userId])).toEqual(ownBytes)
    expect(await coreIsolationBytes([foreign.org], [foreign.user])).toEqual(foreignBytes)

    const admitted = await host.request(adminRoute, admin.token, input)
    expect(admitted.status).toBe(200)
    const users = (await host.pool.query('SELECT * FROM users WHERE username=$1', [run + '_' + tag])).rows
    expect(users).toHaveLength(1)
    const user = users[0]
    expect(user.id).toMatch(uuid)
    const onboard = (await host.pool.query(`SELECT gm.group_id::text,a.id::text AS assignment_id,a.shift_id::text,
      a.start_date::text,uo.is_active FROM attendance_group_members gm
      JOIN attendance_shift_assignments a ON a.org_id=gm.org_id AND a.user_id=gm.user_id
      JOIN user_orgs uo ON uo.org_id=gm.org_id AND uo.user_id=gm.user_id WHERE gm.org_id=$1 AND gm.user_id=$2`, [host.orgId, user.id])).rows
    expect(onboard).toHaveLength(1)
    expect(onboard[0].assignment_id).toMatch(uuid)
    expect(onboard).toEqual([{ group_id: groupId, assignment_id: onboard[0].assignment_id, shift_id: shiftId, start_date: dates.assignment, is_active: true }])
    const { buildOnboardingPacket } = await import('../../src/auth/access-presets')
    expect(admitted.body).toEqual({ ok: true, data: {
      user: { id: user.id, email: null, username: run + '_' + tag, name: 'CALC14 native ' + tag,
        mobile: null, employeeNo: null, department: null, position: null, hireDate: null,
        role: 'user', is_active: true, is_admin: false, activationStatus: 'activated', localPasswordSet: true,
        last_login_at: null, created_at: user.created_at.toISOString(), updated_at: user.updated_at.toISOString() },
      roles: [], permissions: [], isAdmin: false, actorId: admin.userId, inviteToken: null,
      onboarding: buildOnboardingPacket({ email: null, accountLabel: run + '_' + tag, temporaryPassword: null, preset: null, inviteToken: null }),
      attendanceOnboarding: { orgId: host.orgId, group: { id: groupId, name: groupName, memberCreated: true },
        defaultShift: { id: shiftId, name: shiftName, startDate: dates.assignment, assignmentId: onboard[0].assignment_id } },
    } })
    const after = await state()
    expect(after.counts).toEqual({ ...before.counts, users: before.counts.users + 1, user_orgs: before.counts.user_orgs + 1,
      group_members: before.counts.group_members + 1, assignments: before.counts.assignments + 1, versions: before.counts.versions + 2 })
    expect(after.sources.slice(0, before.sources.length)).toEqual(before.sources)
    expect(after.sources.slice(before.sources.length).map(row => [row.source_kind, row.source_id, row.business_effective_date, row.event_kind, row.actor_id]))
      .toEqual([['members', groupId, day(20), 'version', admin.userId], ['user_publication', user.id, day(20), 'version', admin.userId]])
    expect(await coreIsolationBytes([foreign.org], [foreign.user])).toEqual(foreignBytes)
  })

  it('C14_HTTP_POPULATED_W1_USER: W1 rejects an active foreign-only user and admits an active own-org user', async () => {
    const foreign = await populatedForeignCoreSource()
    const own = await host.user(false) // existing real dev-token mint, viewer claims
    const before = await state()
    const ownBytes = await coreIsolationBytes([host.orgId], [admin.userId, own.userId])
    const foreignBytes = await coreIsolationBytes([foreign.org], [foreign.user])
    const correlationId = randomUUID()
    const input = transitionInput(correlationId, { userId: foreign.user, effectiveOn: day(21), businessEffectiveDate: day(22) })
    const rejected = await host.request(w1Route, admin.token, input)
    expect(rejected.status).toBe(422)
    expect(rejected.body).toEqual({ ok: false, error: { code: 'ACTIVE_ORG_USER_REQUIRED', message: 'Target user must be active in the requested organization' } })
    expect(await state()).toEqual(before)
    expect(await coreIsolationBytes([host.orgId], [admin.userId, own.userId])).toEqual(ownBytes)
    expect(await coreIsolationBytes([foreign.org], [foreign.user])).toEqual(foreignBytes)
    expect((await host.pool.query(`SELECT id FROM attendance_calculation_group_membership_operations
      WHERE org_id=$1 AND correlation_id=$2`, [host.orgId, correlationId])).rows).toEqual([])

    // Same endpoint/date/correlation/group/actor; only the target user changes.
    const admitted = await host.request(w1Route, admin.token, { ...input, userId: own.userId })
    expect(admitted.status).toBe(200)
    const rows = (await host.pool.query(`SELECT * FROM attendance_calculation_group_memberships
      WHERE org_id=$1 AND user_id=$2`, [host.orgId, own.userId])).rows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.id).toMatch(uuid)
    const membership = { id: row.id, orgId: host.orgId, userId: own.userId, groupId,
      effectiveFrom: day(21), effectiveTo: null, assignedBy: admin.userId, assignedReason: reason,
      assignedCorrelationId: correlationId, closedBy: null, closedReason: null, closedCorrelationId: null,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }
    expect(admitted.body).toEqual({ ok: true, data: { correlationId, outcome: 'transitioned', membership } })
    expect((await host.pool.query(`SELECT user_id,target_group_id::text,actor_id,outcome,result_membership_id::text,result_snapshot
      FROM attendance_calculation_group_membership_operations WHERE org_id=$1 AND correlation_id=$2`, [host.orgId, correlationId])).rows)
      .toEqual([{ user_id: own.userId, target_group_id: groupId, actor_id: admin.userId, outcome: 'transitioned', result_membership_id: row.id, result_snapshot: membership }])
    const after = await state()
    expect(after.counts).toEqual({ ...before.counts, memberships: before.counts.memberships + 1,
      operations: before.counts.operations + 1, versions: before.counts.versions + 1 })
    expect(after.sources.slice(0, before.sources.length)).toEqual(before.sources)
    expect(after.sources.slice(before.sources.length).map(source => [source.source_kind, source.source_id, source.business_effective_date, source.event_kind, source.actor_id]))
      .toEqual([['user_publication', own.userId, day(22), 'version', admin.userId]])
    expect(await coreIsolationBytes([foreign.org], [foreign.user])).toEqual(foreignBytes)
  })
})
