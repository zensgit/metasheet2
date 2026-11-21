import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'

// Source preparation only. Run against an already migrated, owned isolated DB.
// Both the canonical fixture and the real server's pools must select that same DB.
if (!process.env.ATTENDANCE_TEST_DATABASE_URL || !process.env.DATABASE_URL) {
  throw new Error('REQUESTER_DISPLAY_REAL_DATABASE_REQUIRED')
}
if (process.env.ATTENDANCE_TEST_DATABASE_URL !== process.env.DATABASE_URL) {
  throw new Error('REQUESTER_DISPLAY_DATABASE_BINDING_REQUIRED')
}

const f = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
type Actor = Awaited<ReturnType<typeof f.user>>
type Response = Awaited<ReturnType<typeof f.request>>
type CreationPath = 'generic' | 'outdoor' | 'dispatch' | 'swap' | 'trip'
const ns = 'requester_display_' + randomUUID().replaceAll('-', '')
const workDate = '2049-06-16'
const forged = { name: 'Forged label', requesterName: 'Forged label', requesterSnapshot: { id: 'forged', name: 'Forged label' } }
const labels = ['name', 'email', 'name_equals_id', 'missing', 'email_equals_id'] as const
type Label = typeof labels[number]

describe('attendance requester display through real authenticated HTTP, saved snapshots and unified DTO', () => {
  let admin: Actor
  let shiftA: string
  let shiftB: string
  let scheduleGroup: string
  const flows = {} as Record<CreationPath, string>

  async function setProfile(actor: Actor, name: string, email: string | null) {
    await f.pool.query('UPDATE users SET name=$2,email=$3,activation_status=\'activated\',must_change_password=false,local_password_set=true WHERE id=$1',
      [actor.userId, name, email])
    const me = await f.request('/api/auth/me', actor.token, undefined, 'GET')
    expect(me.status).toBe(200)
    const user = me.body.data.user
    // Positive control: missing labels come from the persisted profile, never a
    // trusted-token placeholder or the development auth fallback user.
    expect({ id: user.id, name: user.name, email: user.email }).toEqual({ id: actor.userId, name, email })
  }

  async function subject(label: Label = 'name', attendanceAdmin = false) {
    const actor = await f.user(attendanceAdmin)
    await f.pool.query(
      'INSERT INTO user_permissions(user_id,permission_code) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING',
      [actor.userId, ['attendance:write', 'approvals:read']],
    )
    await f.pool.query(
      "INSERT INTO user_namespace_admissions(user_id,namespace,enabled,source) VALUES($1,'approvals',true,'test_fixture') ON CONFLICT (user_id,namespace) DO UPDATE SET enabled=true",
      [actor.userId],
    )
    const name = label === 'name' ? '  Synthetic requester  ' : label === 'name_equals_id' ? actor.userId : ' \t '
    const email = label === 'missing' ? null : label === 'email_equals_id' ? actor.userId : actor.userId + '@requester-display.test'
    await setProfile(actor, name, email)
    return { ...actor, expectedName: label === 'name' || label === 'name_equals_id' ? name
      : label === 'email' ? email as string : 'Unknown user' }
  }

  async function assignment(actor: Actor, shiftId: string, date: string) {
    const response = await f.request('/api/attendance/assignments', admin.token, {
      userId: actor.userId, shiftId, startDate: date, endDate: date, isActive: true,
    })
    expect(response.status).toBe(201)
    return response.body.data.assignment.id as string
  }

  async function command(path: CreationPath, target: Actor, actor = target) {
    if (path === 'generic') return { route: '/api/attendance/requests', actor, status: 201, type: 'missed_check_in', body: {
      orgId: f.orgId, workDate, requestType: 'missed_check_in', requestedInAt: workDate + 'T09:00:00.000Z',
      approvalFlowId: flows.generic, ...forged, userId: admin.userId,
    } }
    if (path === 'outdoor') {
      // Keep the original future-punch guard live; outdoor uses current server time.
      punchClock.setOnlinePunchInstantForTests(null)
      return { route: '/api/attendance/punch', actor, status: 202, type: 'outdoor_punch', body: {
        orgId: f.orgId, eventType: 'check_in', source: 'mobile', location: { lat: 0, lng: 0 },
        ...forged, userId: admin.userId, meta: { requesterName: 'Forged label' },
      } }
    }
    if (path === 'dispatch') return { route: '/api/attendance/schedule-dispatch-requests', actor, status: 201, type: 'schedule_dispatch', body: {
      userId: target.userId, targetScheduleGroupId: scheduleGroup, targetShiftId: shiftA,
      startDate: workDate, endDate: workDate, approvalFlowId: flows.dispatch,
    } }
    if (path === 'swap') {
      const counterparty = await subject()
      const requesterAssignmentId = await assignment(target, shiftA, workDate)
      const counterpartyAssignmentId = await assignment(counterparty, shiftB, '2049-06-17')
      return { route: '/api/attendance/shift-swap-requests', actor, status: 201, type: 'shift_swap', body: {
        // getOrgId reads this raw selector; it does not read authenticatedTenantId.
        orgId: f.orgId, requesterAssignmentId, counterpartyAssignmentId, approvalFlowId: flows.swap, ...forged,
      } }
    }
    return { route: '/api/attendance/business-trip-requests', actor, status: 201, type: 'business_trip', body: {
      userId: target.userId, destinationTimezone: 'Asia/Tokyo',
      startAt: workDate + 'T00:00:00.000Z', endAt: '2049-06-18T00:00:00.000Z', approvalFlowId: flows.trip,
    } }
  }

  function requestId(response: Response): string {
    expect(response.body.ok).toBe(true)
    expect(response.body.data.request.id).toMatch(/^[0-9a-f-]{36}$/)
    return response.body.data.request.id
  }

  async function createGeneric(target: Actor, extra: Record<string, unknown> = {}) {
    const c = await command('generic', target)
    const response = await f.request(c.route, target.token, { ...c.body, ...extra })
    expect(response.status).toBe(201)
    return { response, id: requestId(response) }
  }

  async function saved(id: string) {
    const result = await f.pool.query(
      `SELECT r.id,r.org_id,r.user_id,r.approval_instance_id,r.approval_workflow_key,
              a.org_id AS approval_org_id,a.workflow_key,a.business_key,a.requester_snapshot,
              a.subject_snapshot,a.form_snapshot
         FROM attendance_requests r JOIN approval_instances a ON a.id=r.approval_instance_id
        WHERE r.id=$1`, [id],
    )
    expect(result.rows).toHaveLength(1)
    return result.rows[0]
  }

  async function assertSaved(id: string, target: Actor, name: string, type = 'missed_check_in') {
    const row = await saved(id)
    expect({ requestId: row.id, userId: row.user_id, orgId: row.org_id, approvalOrg: row.approval_org_id,
      requestWorkflow: row.approval_workflow_key, workflow: row.workflow_key, businessKey: row.business_key })
      .toEqual({ requestId: id, userId: target.userId, orgId: f.orgId, approvalOrg: f.orgId,
        requestWorkflow: 'attendance.request', workflow: 'attendance.request', businessKey: 'attendance-request:' + id })
    expect(row.requester_snapshot).toEqual({ id: target.userId, name })
    const dto = await f.request('/api/approvals/' + encodeURIComponent(row.approval_instance_id), target.token, undefined, 'GET')
    expect(dto.status).toBe(200)
    // GET returns the UnifiedApprovalDTO itself, not {data:{requesterSnapshot}}.
    expect(dto.body.requester).toEqual(row.requester_snapshot)
    expect({ id: dto.body.id, workflow: dto.body.workflowKey, businessKey: dto.body.businessKey,
      source: dto.body.sourceSystem, status: dto.body.status, subject: dto.body.subject, form: dto.body.formSnapshot })
      .toEqual({ id: row.approval_instance_id, workflow: row.workflow_key, businessKey: row.business_key,
        source: 'platform', status: 'pending', subject: row.subject_snapshot, form: row.form_snapshot })
    expect({ userId: dto.body.subject.userId, orgId: dto.body.subject.orgId, requestId: dto.body.subject.requestId,
      requestType: dto.body.subject.requestType }).toEqual({ userId: target.userId, orgId: f.orgId, requestId: id, requestType: type })
    return row
  }

  async function businessState() {
    const result: Record<string, unknown> = {}
    for (const table of [
      'attendance_requests', 'approval_instances', 'attendance_request_calculation_snapshots',
      'attendance_result_operations', 'attendance_result_event_outbox', 'attendance_events', 'attendance_records',
      'attendance_schedule_dispatch_requests', 'attendance_shift_swap_requests',
      'attendance_business_trip_requests', 'attendance_business_trip_arrangements', 'attendance_shift_assignments',
    ]) {
      result[table] = (await f.pool.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [f.orgId],
      )).rows
    }
    for (const [table, key] of [['approval_assignments', 'instance_id'], ['approval_records', 'instance_id']]) {
      result[table] = (await f.pool.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${key} IN
          (SELECT id FROM approval_instances WHERE org_id=$1) ORDER BY to_jsonb(t)::text`, [f.orgId],
      )).rows
    }
    return result
  }

  async function seedStoredSnapshot(id: string, snapshot: Record<string, unknown>) {
    const row = await saved(id)
    await f.pool.query('UPDATE approval_instances SET requester_snapshot=$2::jsonb WHERE id=$1 AND org_id=$3',
      [row.approval_instance_id, JSON.stringify(snapshot), f.orgId])
  }

  const edit = (id: string, actor: Actor, patch: Record<string, unknown> = {}) =>
    f.request('/api/attendance/requests/' + id, actor.token, { reason: 'Synthetic edit', ...forged, ...patch }, 'PUT')

  beforeAll(async () => {
    punchClock.setOnlinePunchInstantForTests('2049-06-14T00:00:00.000Z')
    admin = await f.start()
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    await setProfile(admin, 'Authenticated operator', admin.userId + '@operator.test')
    for (const [path, type] of Object.entries({
      generic: 'missed_check_in', outdoor: 'outdoor_punch', dispatch: 'schedule_dispatch', swap: 'shift_swap', trip: 'business_trip',
    })) {
      const response = await f.request('/api/attendance/approval-flows', admin.token, {
        orgId: f.orgId, name: ns + '_' + path, requestType: type, isActive: true,
        steps: [{ approverUserIds: [admin.userId] }],
      })
      expect(response.status).toBe(201)
      flows[path as CreationPath] = response.body.data.id
    }
    const shifts: string[] = []
    for (const [start, end] of [['09:00', '13:00'], ['14:00', '18:00']]) {
      const response = await f.request('/api/attendance/shifts', admin.token, {
        name: ns + '_' + start, timezone: 'UTC', workStartTime: start, workEndTime: end,
        workingDays: [0, 1, 2, 3, 4, 5, 6],
      })
      expect(response.status).toBe(201)
      shifts.push(response.body.data.id)
    }
    shiftA = shifts[0]
    shiftB = shifts[1]
    const group = await f.request('/api/attendance/schedule-groups', admin.token, {
      name: ns, code: ns, departmentRef: ns + '_department', source: 'manual', isActive: true,
    })
    expect(group.status).toBe(200)
    scheduleGroup = group.body.data.id
    await f.configure(admin.token, {
      geoFence: { lat: 31.2304, lng: 121.4737, radiusMeters: 100 },
      punchPolicy: { outdoor: { requireApproval: true, requireNote: false, requirePhoto: false, approvalFlowId: flows.outdoor } },
    })
  }, 180_000)
  beforeEach(() => punchClock.setOnlinePunchInstantForTests('2049-06-14T00:00:00.000Z'))
  afterAll(async () => { await f.stop() }, 60_000)

  // Generic and outdoor are SELF only. Dispatch SELF needs an actual DB admin;
  // swap/trip SELF use a nonadmin. Cross-user commands use the DB-backed admin.
  for (const path of ['generic', 'outdoor', 'dispatch', 'swap', 'trip'] as const) {
    for (const crossUser of path === 'dispatch' || path === 'swap' || path === 'trip' ? [false, true] : [false]) {
      it.each(labels)(path + (crossUser ? ' cross-user' : ' self') + ': saves and serves %s from the request subject', async label => {
        const target = await subject(label, path === 'dispatch' && !crossUser)
        const c = await command(path, target, crossUser ? admin : target)
        const response = await f.request(c.route, c.actor.token, c.body)
        expect(response.status, JSON.stringify(response.body)).toBe(c.status)
        const id = requestId(response)
        await assertSaved(id, target, target.expectedName, c.type)
        expect((await f.pool.query('SELECT count(*)::int AS n FROM attendance_events WHERE user_id=$1', [target.userId])).rows)
          .toEqual([{ n: 0 }])
      })
    }
  }

  it('pending edit freezes only the old display name after the local directory profile is renamed', async () => {
    const target = await subject()
    const made = await createGeneric(target)
    await assertSaved(made.id, target, target.expectedName)
    // Static flow preparation rebuilds relations/assignments; only name is frozen.
    await seedStoredSnapshot(made.id, { id: target.userId, name: target.expectedName,
      managerId: randomUUID(), deptHeadId: randomUUID(), managerChainIds: [randomUUID()] })
    await setProfile(target, 'Renamed directory profile', target.userId + '@renamed.test')
    expect((await edit(made.id, target)).status).toBe(200)
    await assertSaved(made.id, target, target.expectedName)
  })

  it('pending edit preserves an ambiguous genuine legacy name equal to the technical ID', async () => {
    const target = await subject()
    const made = await createGeneric(target)
    await seedStoredSnapshot(made.id, { id: target.userId, name: target.userId })
    await setProfile(target, 'New directory label', target.userId + '@renamed.test')
    expect((await edit(made.id, target)).status).toBe(200)
    await assertSaved(made.id, target, target.userId)
  })

  it.each([null, '', ' \t ', 17])('pending edit neutralizes present invalid stored name %j without live-name refresh', async name => {
    const target = await subject()
    const made = await createGeneric(target)
    await seedStoredSnapshot(made.id, { id: target.userId, name })
    expect((await edit(made.id, target)).status).toBe(200)
    await assertSaved(made.id, target, 'Unknown user')
  })

  it('pending edit neutralizes an absent stored name without using the current profile', async () => {
    const target = await subject()
    const made = await createGeneric(target)
    await seedStoredSnapshot(made.id, { id: target.userId })
    expect((await edit(made.id, target)).status).toBe(200)
    await assertSaved(made.id, target, 'Unknown user')
  })

  it.each(['id', 'orgId'])('pending edit neutralizes explicit contradictory stored %s without a new business rejection', async key => {
    const target = await subject()
    const made = await createGeneric(target)
    await seedStoredSnapshot(made.id, { id: target.userId, name: 'Wrongly bound display', [key]: randomUUID() })
    expect((await edit(made.id, target)).status).toBe(200)
    await assertSaved(made.id, target, 'Unknown user')
  })

  it('missing legacy snapshot id/org is not a positive contradiction', async () => {
    const target = await subject()
    const made = await createGeneric(target)
    await seedStoredSnapshot(made.id, { name: 'Legacy display without binding fields' })
    expect((await edit(made.id, target)).status).toBe(200)
    await assertSaved(made.id, target, 'Legacy display without binding fields')
  })

  it('D-10 self edit retains the authoritative request and instance org after membership moves', async () => {
    const target = await subject()
    const made = await createGeneric(target)
    await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=$1 AND org_id=$3',
      [target.userId, randomUUID(), f.orgId])
    // Deliberately no org selector: route orgId is normally null for this edit.
    expect((await edit(made.id, target)).status).toBe(200)
    await assertSaved(made.id, target, target.expectedName)
  })

  it('a DB-backed attendance approver can edit another user without an admin grant', async () => {
    const target = await subject()
    const approver = await subject()
    await f.pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES($1,'attendance:approve')", [approver.userId])
    const made = await createGeneric(target)
    expect((await edit(made.id, approver)).status).toBe(200)
    await assertSaved(made.id, target, target.expectedName)
  })

  it('refuses another ordinary user edit with 403 and no business mutation', async () => {
    const target = await subject()
    const outsider = await subject()
    const made = await createGeneric(target)
    const before = await businessState()
    const response = await edit(made.id, outsider)
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('FORBIDDEN')
    expect(await businessState()).toEqual(before)
  })

  it('a real reader cannot use the dev-token permission claims to create a request', async () => {
    const reader = await f.user(false)
    const before = await businessState()
    const response = await f.request('/api/attendance/requests', reader.token, {
      orgId: f.orgId, workDate, requestType: 'missed_check_in', requestedInAt: workDate + 'T09:00:00.000Z',
    })
    expect(response.status).toBe(403)
    expect(await businessState()).toEqual(before)
  })

  it.each(['actor', 'target_org'])('trip %s admission remains 403 with no mutation', async boundary => {
    const target = await subject()
    const actor = boundary === 'actor' ? await subject() : admin
    if (boundary === 'target_org') await f.pool.query('UPDATE user_orgs SET org_id=$2 WHERE user_id=$1', [target.userId, randomUUID()])
    const c = await command('trip', target, actor)
    const before = await businessState()
    const response = await f.request(c.route, actor.token, c.body)
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe(boundary === 'actor' ? 'ATTENDANCE_TRIP_FORBIDDEN' : 'ATTENDANCE_TRIP_MEMBER_REQUIRED')
    expect(await businessState()).toEqual(before)
  })

  it.each(['dispatch', 'trip'] as const)('%s rejects forged name fields at its existing strict input gate', async path => {
    const target = await subject()
    const c = await command(path, target, admin)
    const before = await businessState()
    const response = await f.request(c.route, admin.token, { ...c.body, ...forged })
    expect(response.status).toBe(path === 'trip' ? 422 : 400)
    expect(response.body.error.code).toBe(path === 'trip' ? 'ATTENDANCE_TRIP_INVALID_INPUT' : 'VALIDATION_ERROR')
    expect(await businessState()).toEqual(before)
  })

  it('duplicate-target edit keeps 409 and both saved requests/approvals unchanged', async () => {
    const target = await subject()
    await createGeneric(target)
    const other = await createGeneric(target, { workDate: '2049-06-17', requestedInAt: '2049-06-17T09:00:00.000Z' })
    const before = await businessState()
    const response = await edit(other.id, target, { workDate, requestedInAt: workDate + 'T09:00:00.000Z' })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('DUPLICATE_REQUEST')
    expect(await businessState()).toEqual(before)
  })

  it('unchanged create and edit retries replay saved responses after directory rename', async () => {
    const target = await subject()
    const c = await command('generic', target)
    const createBody = { ...c.body, operationId: randomUUID() }
    const first = await f.request(c.route, target.token, createBody)
    expect(first.status).toBe(201)
    const id = requestId(first)
    await assertSaved(id, target, target.expectedName)
    await setProfile(target, 'Renamed before create replay', target.userId + '@replay.test')
    const beforeCreateReplay = await businessState()
    const replay = await f.request(c.route, target.token, createBody)
    expect(replay.status).toBe(201)
    expect(replay.body).toEqual(first.body)
    expect(await businessState()).toEqual(beforeCreateReplay)
    const patch = { operationId: randomUUID(), expectedSnapshotVersion: 1, expectedSnapshotFingerprint: '0'.repeat(64) }
    const edited = await edit(id, target, patch)
    expect(edited.status).toBe(200)
    await setProfile(target, 'Renamed before edit replay', target.userId + '@edit-replay.test')
    const beforeEditReplay = await businessState()
    const editReplay = await edit(id, target, patch)
    expect(editReplay.status).toBe(200)
    expect(editReplay.body).toEqual(edited.body)
    expect(await businessState()).toEqual(beforeEditReplay)
    const operations = await f.pool.query(
      'SELECT entrypoint,state FROM attendance_result_operations WHERE org_id=$1 AND operation_id=ANY($2::uuid[]) ORDER BY entrypoint',
      [f.orgId, [createBody.operationId, patch.operationId]],
    )
    expect(operations.rows).toEqual([
      { entrypoint: 'request_create', state: 'completed' }, { entrypoint: 'request_pending_edit', state: 'completed' },
    ])
    await assertSaved(id, target, target.expectedName)
  })

  it.each(['create', 'edit'])('a real SQL failure after the approval writer rolls back %s atomically', async action => {
    const target = await subject()
    const existing = action === 'edit' ? await createGeneric(target) : null
    const functionName = ns + '_fail_' + action
    // Owned isolated-DB fault only; no product seam, mock, schema weakening or
    // swallowed driver error. INSERT/UPDATE happens after the approval upsert.
    await f.pool.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $fault$
      BEGIN
        IF NEW.user_id = '${target.userId}' THEN
          RAISE EXCEPTION 'REQUESTER_DISPLAY_FIXTURE_WRITE_FAILURE' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $fault$`)
    try {
      await f.pool.query(`CREATE TRIGGER ${functionName} BEFORE INSERT OR UPDATE ON attendance_requests
        FOR EACH ROW EXECUTE FUNCTION ${functionName}()`)
      const before = await businessState()
      const c = await command('generic', target)
      const response = existing ? await edit(existing.id, target) : await f.request(c.route, target.token, c.body)
      expect(response.status).toBe(500)
      expect(response.body).toEqual({ ok: false, error: { code: 'INTERNAL_ERROR',
        message: action === 'edit' ? 'Failed to update request' : 'Failed to create request' } })
      expect(await businessState()).toEqual(before)
    } finally {
      await f.pool.query(`DROP TRIGGER IF EXISTS ${functionName} ON attendance_requests`)
      await f.pool.query(`DROP FUNCTION ${functionName}()`)
    }
  })

  it('missing authenticated display cannot block completed replay or preservation of an existing name', async () => {
    const target = await subject()
    const c = await command('generic', target)
    const createBody = { ...c.body, operationId: randomUUID() }
    const first = await f.request(c.route, target.token, createBody)
    expect(first.status, first.body).toBe(201)
    const id = requestId(first)
    await setProfile(target, ' ', null)
    const beforeReplay = await businessState()
    const replay = await f.request(c.route, target.token, createBody)
    expect(replay.status, replay.body).toBe(201)
    expect(replay.body).toEqual(first.body)
    expect(await businessState()).toEqual(beforeReplay)
    const patch = { operationId: randomUUID(), expectedSnapshotVersion: 1, expectedSnapshotFingerprint: '0'.repeat(64) }
    const edited = await edit(id, target, patch)
    expect(edited.status, edited.body).toBe(200)
    const beforeEditReplay = await businessState()
    const editReplay = await edit(id, target, patch)
    expect(editReplay.status, editReplay.body).toBe(200)
    expect(editReplay.body).toEqual(edited.body)
    expect(await businessState()).toEqual(beforeEditReplay)
    await assertSaved(id, target, target.expectedName)
  })

  it.each(['dispatch', 'trip'] as const)('%s binds the named target even when the operator has no display profile', async path => {
    const target = await subject()
    const c = await command(path, target, admin)
    await setProfile(admin, ' ', null)
    try {
      const response = await f.request(c.route, admin.token, c.body)
      expect(response.status, response.body).toBe(c.status)
      await assertSaved(requestId(response), target, target.expectedName, c.type)
    } finally {
      await setProfile(admin, 'Authenticated operator', admin.userId + '@operator.test')
    }
  })


  it('a never-approved legacy paired-null request creates a new named snapshot through the real edit route', async () => {
    const target = await subject()
    const control = await subject()
    const made = await createGeneric(control)
    const old = await saved(made.id)
    const oldInstance = (await f.pool.query('SELECT to_jsonb(a) AS row FROM approval_instances a WHERE id=$1', [old.approval_instance_id])).rows
    const legacyId = randomUUID()
    const metadata = { approvalFlow: { id: flows.generic, name: ns + '_generic',
      steps: [{ approverUserIds: [admin.userId] }], currentStep: 0 } }
    await f.pool.query(
      "INSERT INTO attendance_requests (id,user_id,org_id,work_date,request_type,requested_in_at,reason,status,metadata) VALUES($1,$2,$3,$4,'missed_check_in',$5,'Synthetic legacy request','pending',$6::jsonb)",
      [legacyId, target.userId, f.orgId, workDate, workDate + 'T09:00:00.000Z', JSON.stringify(metadata)],
    )
    const legacy = (await f.pool.query(
      'SELECT approval_instance_id,approval_workflow_key FROM attendance_requests WHERE id=$1', [legacyId],
    )).rows
    expect(legacy).toEqual([{ approval_instance_id: null, approval_workflow_key: null }])
    expect((await f.pool.query('SELECT count(*)::int AS n FROM approval_instances WHERE request_no=$1', ['ATT-' + legacyId])).rows)
      .toEqual([{ n: 0 }])
    await expect(f.pool.query(
      "UPDATE attendance_requests SET approval_instance_id=$2,approval_workflow_key='attendance.request' WHERE id=$1",
      [legacyId, 'apv_' + randomUUID()],
    )).rejects.toMatchObject({ code: '23503' })
    expect((await f.pool.query(
      'SELECT approval_instance_id,approval_workflow_key FROM attendance_requests WHERE id=$1', [legacyId],
    )).rows).toEqual(legacy)
    await setProfile(target, 'Current directory label for never-approved legacy', target.userId + '@legacy.test')
    const response = await edit(legacyId, target)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    await assertSaved(legacyId, target, 'Current directory label for never-approved legacy')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM approval_instances WHERE request_no=$1', ['ATT-' + legacyId])).rows)
      .toEqual([{ n: 1 }])
    expect((await f.pool.query('SELECT to_jsonb(a) AS row FROM approval_instances a WHERE id=$1', [old.approval_instance_id])).rows)
      .toEqual(oldInstance)
  })


  it.each([
    { label: 'name' as const },
    { label: 'missing' as const },
  ])('REQUESTER_MULTI_CONTEXT_$label: freezes exact segments and target display', async ({ label }) => {
    const { computeAttendanceRequestPayloadFingerprintV1, normalizeAttendanceContextSnapshotV1 } =
      await import('../../src/attendance/w4c3b-request-snapshots')
    const { computeAttendanceWindowEvidenceFingerprintV1 } = await import('../../src/attendance/w4c2-frozen-attribution')
    const { snapshotAttendanceSettingsRow, restoreAttendanceSettingsRow } = await import('../utils/attendance-settings-row')
    const { punchPlugin } = await import('../utils/attendance-online-punch-db')
    const priorAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    // The server starts without the outbox-drain job; only this isolated org is
    // admitted after startup. Retain immutable history and restore the env exactly.
    expect(priorAllowlist ?? '').toBe('')
    expect(process.env.RBAC_BYPASS).toBe('false')
    expect(process.env.RBAC_TOKEN_TRUST).toBe('false')
    const settingsBefore = await snapshotAttendanceSettingsRow(f.pool)
    const target = await subject(label)
    const counterparty = await subject()
    const fullState = async () => {
      const state = await businessState()
      for (const table of [
        'attendance_shifts', 'attendance_shift_segments', 'attendance_record_calculations',
        'attendance_record_segments', 'attendance_result_operation_batches', 'attendance_calculation_rollout_state',
        'attendance_calculation_rollout_events', 'attendance_record_target_revisions',
        'attendance_group_effect_revisions', 'attendance_leave_balances', 'attendance_leave_balance_events',
      ]) {
        state[table] = (await f.pool.query(
          `SELECT to_jsonb(t) AS row FROM ${table} t WHERE org_id=$1 ORDER BY to_jsonb(t)::text`, [f.orgId],
        )).rows
      }
      return state
    }
    try {
      await f.configure(admin.token, { workDateAttribution: { postShiftTailMinutes: 120 } })
      await f.pool.query(
        `INSERT INTO attendance_calculation_rollout_state
          (org_id,state,engine_version,reason_code,actor_id,version,prior_state,scope)
         VALUES ($1,'shadow','requester-multisegment-test','TEST_FIXTURE',$2,1,NULL,'synthetic_staging')
         ON CONFLICT (org_id) DO NOTHING`, [f.orgId, admin.userId],
      )
      expect((await f.pool.query(
        'SELECT org_id,state,engine_version,reason_code,actor_id,version,prior_state,scope FROM attendance_calculation_rollout_state WHERE org_id=$1',
        [f.orgId],
      )).rows).toEqual([{ org_id: f.orgId, state: 'shadow', engine_version: 'requester-multisegment-test',
        reason_code: 'TEST_FIXTURE', actor_id: admin.userId, version: 1, prior_state: null, scope: 'synthetic_staging' }])
      process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = f.orgId
      const createdShift = await f.request('/api/attendance/shifts', admin.token, {
        orgId: f.orgId, name: ns + '_requester_multi_' + label, timezone: 'UTC',
        segments: [{ startTime: '08:00', endTime: '12:00' }, { startTime: '13:00', endTime: '17:00' }],
        lateGraceMinutes: 4, earlyGraceMinutes: 7, roundingMinutes: 1,
        workingDays: [0, 1, 2, 3, 4, 5, 6], flexPolicy: { mode: 'strict' },
      })
      expect(createdShift.status).toBe(201)
      const multiShiftId = createdShift.body.data.id as string
      const requesterAssignmentId = await assignment(target, multiShiftId, workDate)
      const counterpartyAssignmentId = await assignment(counterparty, shiftB, '2049-06-17')
      expect((await f.pool.query(
        `SELECT id,org_id,user_id,shift_id,slot_index,start_date::text,end_date::text,is_active,
                publish_status,assignment_kind,producer_type,temporary_replaces_assignment_id
           FROM attendance_shift_assignments WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[requesterAssignmentId, counterpartyAssignmentId]],
      )).rows).toEqual([
        { id: requesterAssignmentId, org_id: f.orgId, user_id: target.userId, shift_id: multiShiftId,
          slot_index: 0, start_date: workDate, end_date: workDate, is_active: true, publish_status: 'published',
          assignment_kind: 'regular', producer_type: null, temporary_replaces_assignment_id: null },
        { id: counterpartyAssignmentId, org_id: f.orgId, user_id: counterparty.userId, shift_id: shiftB,
          slot_index: 0, start_date: '2049-06-17', end_date: '2049-06-17', is_active: true, publish_status: 'published',
          assignment_kind: 'regular', producer_type: null, temporary_replaces_assignment_id: null },
      ].sort((a, b) => a.id.localeCompare(b.id)))
      expect((await f.pool.query(
        `SELECT segment_index,start_time::text,end_time::text,start_day_offset,end_day_offset
           FROM attendance_shift_segments WHERE org_id=$1 AND shift_id=$2 ORDER BY segment_index`,
        [f.orgId, multiShiftId],
      )).rows).toEqual([
        { segment_index: 0, start_time: '08:00:00', end_time: '12:00:00', start_day_offset: 0, end_day_offset: 0 },
        { segment_index: 1, start_time: '13:00:00', end_time: '17:00:00', start_day_offset: 0, end_day_offset: 0 },
      ])
      expect((await f.pool.query(
        `SELECT segment_index,start_time::text,end_time::text,start_day_offset,end_day_offset
           FROM attendance_shift_segments WHERE org_id=$1 AND shift_id=$2 ORDER BY segment_index`,
        [f.orgId, shiftB],
      )).rows).toEqual([
        { segment_index: 0, start_time: '14:00:00', end_time: '18:00:00', start_day_offset: 0, end_day_offset: 0 },
      ])
      expect((await f.pool.query(
        'SELECT severe_late_threshold_minutes,absence_late_threshold_minutes FROM attendance_rules WHERE org_id=$1 AND is_default=true',
        [f.orgId],
      )).rows).toEqual([{ severe_late_threshold_minutes: 30, absence_late_threshold_minutes: 60 }])
      expect((await f.pool.query(
        'SELECT user_id,is_active FROM user_orgs WHERE org_id=$1 AND user_id=ANY($2::text[]) ORDER BY user_id',
        [f.orgId, [admin.userId, target.userId, counterparty.userId]],
      )).rows).toEqual([admin.userId, target.userId, counterparty.userId].sort()
        .map(user_id => ({ user_id, is_active: true })))
      const before = await fullState()
      const operationId = randomUUID()
      const body = { orgId: f.orgId, operationId, requesterAssignmentId, counterpartyAssignmentId,
        approvalFlowId: flows.swap, reason: 'Synthetic requester multi-segment swap', ...forged }
      const startedAt = Date.now()
      const first = await f.request('/api/attendance/shift-swap-requests', admin.token, body)
      const finishedAt = Date.now()
      expect(first.status, String(first.body?.error?.code ?? 'REQUESTER_MULTI_CREATE_STATUS')).toBe(201)
      const id = requestId(first)
      await assertSaved(id, target, label === 'name' ? '  Synthetic requester  ' : 'Unknown user', 'shift_swap')
      const payload = { schemaVersion: 1 as const, workDate, requestedInAt: null, requestedOutAt: null,
        reason: body.reason, minutes: null, leaveTypeCode: null, outdoorPunch: null }
      const fingerprint = computeAttendanceRequestPayloadFingerprintV1(payload)
      const context = { schemaVersion: 1, selector: 'legacy', orgId: f.orgId, userId: target.userId,
        workDate, timezone: 'UTC', shiftId: multiShiftId, isWorkday: true, holidayKind: null,
        calculationGroupId: null, roundingMinutes: 1, severeLateThresholdMinutes: 30, absenceLateThresholdMinutes: 60,
        segments: [
          { index: 0, startTime: '08:00', endTime: '12:00', startDayOffset: 0, endDayOffset: 0,
            lateGraceMinutes: 4, earlyLeaveGraceMinutes: 7 },
          { index: 1, startTime: '13:00', endTime: '17:00', startDayOffset: 0, endDayOffset: 0,
            lateGraceMinutes: 4, earlyLeaveGraceMinutes: 7 },
        ] }
      expect(normalizeAttendanceContextSnapshotV1(context)).toEqual(context)
      const snapshots = (await f.pool.query(
        `SELECT org_id,request_id,version,request_type,subject_user_id,payload,payload_fingerprint,
                attribution_snapshot,context_snapshot,created_by
           FROM attendance_request_calculation_snapshots WHERE org_id=$1 AND request_id=$2 ORDER BY version`,
        [f.orgId, id],
      )).rows
      expect(snapshots).toEqual([{ org_id: f.orgId, request_id: id, version: 1, request_type: 'shift_swap',
        subject_user_id: target.userId, payload, payload_fingerprint: fingerprint, created_by: admin.userId,
        attribution_snapshot: { posture: 'resolved_v2', value: {
          schemaVersion: 2, resolverVersion: 'attendance-work-date-resolver-w2+w4c2-strict-rebuild@1',
          orgId: f.orgId, userId: target.userId, workDate, shiftId: multiShiftId,
          reasonCode: 'SINGLE_MATCHING_CANDIDATE',
          resolvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
          absoluteWindow: { startAt: workDate + 'T08:00:00.000Z', endAt: workDate + 'T17:00:00.000Z' },
          attributionWindow: { startAt: workDate + 'T08:00:00.000Z', endAt: workDate + 'T19:00:00.000Z' },
          attributionTailMinutes: 120, extendedByApprovedOvertime: false,
          windowEvidenceFingerprint: computeAttendanceWindowEvidenceFingerprintV1({
            attributionTailMinutes: 120, approvedOvertimeWindows: [],
          }), source: 'request_creation',
        } }, context_snapshot: context }])
      const resolvedAt = Date.parse(snapshots[0].attribution_snapshot.value.resolvedAt)
      expect(resolvedAt).toBeGreaterThanOrEqual(startedAt)
      expect(resolvedAt).toBeLessThanOrEqual(finishedAt)
      expect(first.body.data.requestSnapshot).toEqual({ version: 1, fingerprint })
      expect((await f.pool.query(
        `SELECT d.org_id,d.request_id,r.user_id,r.status,d.requester_user_id,d.counterparty_user_id,
                d.requester_assignment_id,d.counterparty_assignment_id,d.requester_shift_id,d.counterparty_shift_id,
                d.requester_work_date::text,d.counterparty_work_date::text,d.requester_slot_index,d.counterparty_slot_index,
                d.requester_start_date::text,d.requester_end_date::text,d.counterparty_start_date::text,d.counterparty_end_date::text,
                d.requester_publish_status,d.counterparty_publish_status,d.requester_producer_type,d.counterparty_producer_type,
                d.requester_assignment_kind,d.counterparty_assignment_kind,d.counterparty_status,d.source_key,
                d.requester_replacement_assignment_id,d.counterparty_replacement_assignment_id,d.finalized_at
           FROM attendance_shift_swap_requests d JOIN attendance_requests r ON r.id=d.request_id AND r.org_id=d.org_id
          WHERE d.org_id=$1 AND d.request_id=$2`, [f.orgId, id],
      )).rows).toEqual([{ org_id: f.orgId, request_id: id, user_id: target.userId, status: 'pending',
        requester_user_id: target.userId, counterparty_user_id: counterparty.userId,
        requester_assignment_id: requesterAssignmentId, counterparty_assignment_id: counterpartyAssignmentId,
        requester_shift_id: multiShiftId, counterparty_shift_id: shiftB,
        requester_work_date: workDate, counterparty_work_date: '2049-06-17', requester_slot_index: 0, counterparty_slot_index: 0,
        requester_start_date: workDate, requester_end_date: workDate, counterparty_start_date: '2049-06-17', counterparty_end_date: '2049-06-17',
        requester_publish_status: 'published', counterparty_publish_status: 'published', requester_producer_type: null,
        counterparty_producer_type: null, requester_assignment_kind: 'regular', counterparty_assignment_kind: 'regular',
        counterparty_status: 'pending', source_key: 'shift_swap:' + [requesterAssignmentId, counterpartyAssignmentId].sort().join(':'),
        requester_replacement_assignment_id: null, counterparty_replacement_assignment_id: null, finalized_at: null }])
      expect((await f.pool.query(
        'SELECT count(*)::int AS n FROM attendance_requests WHERE org_id=$1 AND user_id=$2', [f.orgId, target.userId],
      )).rows).toEqual([{ n: 1 }])
      expect((await f.pool.query(
        `SELECT entrypoint,state,actor_id,actor_posture,subject_scope,resolved_request_id
           FROM attendance_result_operations WHERE org_id=$1 AND operation_id=$2`, [f.orgId, operationId],
      )).rows).toEqual([{ entrypoint: 'request_create', state: 'completed', actor_id: admin.userId,
        actor_posture: 'attendance_admin', subject_scope: { kind: 'explicit_users', userIds: [target.userId] }, resolved_request_id: id }])
      expect((await f.pool.query(
        'SELECT count(*)::int AS n FROM approval_instances WHERE org_id=$1 AND request_no=$2', [f.orgId, 'ATT-' + id],
      )).rows).toEqual([{ n: 1 }])
      expect((await f.pool.query(
        `SELECT entrypoint,event_kind,payload,payload_schema_version,delivery_state,attempts,delivered_at
           FROM attendance_result_event_outbox WHERE org_id=$1 AND operation_id=$2`, [f.orgId, operationId],
      )).rows).toEqual([{ entrypoint: 'request_create', event_kind: 'attendance.requested',
        payload: { orgId: f.orgId, userId: target.userId, workDate, requestType: 'shift_swap', requestId: id },
        payload_schema_version: 1, delivery_state: 'pending', attempts: 0, delivered_at: null }])
      const after = await fullState()
      for (const table of [
        'attendance_shift_assignments', 'attendance_shifts', 'attendance_shift_segments', 'attendance_events', 'attendance_records',
        'attendance_record_calculations', 'attendance_record_segments', 'attendance_result_operation_batches',
        'attendance_record_target_revisions', 'attendance_group_effect_revisions', 'attendance_leave_balances', 'attendance_leave_balance_events',
      ]) expect(after[table]).toEqual(before[table])
      await setProfile(target, 'Renamed after multi-segment create', target.userId + '@multi-replay.test')
      const beforeReplay = await fullState()
      const replay = await f.request('/api/attendance/shift-swap-requests', admin.token, body)
      expect(replay.status).toBe(201)
      expect(replay.body).toEqual(first.body)
      expect(await fullState()).toEqual(beforeReplay)
      await assertSaved(id, target, label === 'name' ? '  Synthetic requester  ' : 'Unknown user', 'shift_swap')
    } finally {
      if (priorAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
      else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlist
      await restoreAttendanceSettingsRow(f.pool, settingsBefore)
      punchPlugin.resetAttendanceSettingsCacheForTests()
    }
  })
})
