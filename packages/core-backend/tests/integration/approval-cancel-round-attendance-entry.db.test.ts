import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import net from 'net'
import * as path from 'path'
import { randomUUID } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { type ApprovalActionRequest } from '../../src/types/approval-product'
import {
  getAttendanceCancellationExecutionPort,
  registerAttendanceCancellationExecutionProvider,
  unregisterAttendanceCancellationExecutionProvider,
  type AttendanceCancellationExecutionPort,
} from '../../src/core/attendance-cancellation-execution-port'
import type {
  AttendanceRequestOperationExternalTransactionInputV1,
  AttendanceRequestOperationExternalTransactionResultV1,
} from '../../src/attendance/w4c3b-request-operation-boundary'
import { CANCEL_ROUND_TEMPLATE_ID } from '../../src/db/seeds/approval-cancel-round-published-definition'
import { CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE } from '../../src/approvals/approval-cancel-round-entry-port'
import {
  insertDingTalkApprovalCardDelivery,
  markDingTalkApprovalCardDeliverySendFailed,
  markDingTalkApprovalCardDeliverySent,
} from '../../src/integrations/dingtalk/approval-card-deliveries'
import { ApprovalGraphExecutor } from '../../src/services/ApprovalGraphExecutor'
import { ICollabService } from '../../src/di/identifiers'
import { buildAuthenticatedUserRoom } from '../../src/services/CollabService'
import { invalidateUserPerms } from '../../src/rbac/service'
import { applyTodoMirrorTaskCreated } from '../../src/services/dingtalk-todo-mirror-service'
import { DingTalkTodoMirrorWorker, type TodoMirrorWorkerQuery } from '../../src/services/dingtalk-todo-mirror-worker'
import { buildApprovalTaskCreatedEvent } from '../../src/services/ApprovalTaskCreatedEvent'

/**
 * Approval change-request lock v5.9, product entry v2 (lock header 「RATIFY 追记 —— 产品入口增补 v2」,
 * 2026-09-28) — phase A acceptance, real DB + real HTTP, for the two attendance-side routes
 * `GET` / `POST /api/attendance/requests/:id/cancel-round` (P-1 Q1′ = (i)).
 *
 * WHAT IS REAL HERE: the server process (core + plugin-attendance, loaded from the repo's own plugin
 * directory), both authorization layers (`RBAC_BYPASS='false'` is set and asserted — the plugin's
 * `withPermission` reads `user_roles` / `user_permissions` from THIS database, core's `rbacGuard`
 * reads the token plus the same tables), the creation path, the engine's approve/reject/revoke
 * branches, and the durable read projector. The employee-lane tokens are minted by the REAL
 * `POST /api/auth/login` against bcrypt-hashed `users` rows (P-10: 「只持员工级权限、不持任何
 * `approvals:*` 的真实令牌」). The ONLY double is the C-1 attendance cancellation PROVIDER, bound
 * through the production registry (save/restore), so the three-token classification can be driven
 * deterministically — the real W4 boundary's end-to-end run is the redemption suite's, not this one's.
 *
 * FIXTURE-ONLY privilege, named so it is never mistaken for the population under test: the template
 * author and the approver use `GET /api/auth/dev-token?roles=admin` tokens to create/publish the
 * fixture template and to approve/reject on `/api/approvals/:id/actions`. Those tokens are never sent
 * to the two routes under test. Original documents are created IN-PROCESS for their requester; the
 * service's own write boundary reads `approvals:write` from the DATABASE, so the fixture grants it
 * for that one call and DELETES the grant before the requester touches any route — the P-10 case
 * then proves the absence at test time (`GET /api/approvals/:id` ⇒ 403). An employee never holds an
 * admin-claims token at all.
 *
 * RATIFIED CRITERIA THIS FILE PINS (owner option text is in the lock header, not restated here):
 *   - P-10: employee real token → launch 201 → read 200 → read result 200; the same employee token is
 *     403'd by `GET /api/approvals/:id` (so the pass is the attendance-side mount, not a stray
 *     `approvals:*` grant); an admin real token is green on the same three steps (positive control).
 *   - P-1 (a)/(b)/(c) with the P-8 registered codes; creation-path refusals pass through as
 *     (status, code, message) with NO `details`.
 *   - P-4: summary keyed by the original document; I7 on the original instance; `round: null` ⇒ 200;
 *     a viewer who fails I7 gets the byte-identical 404 of a never-existing id.
 *   - P-3 (iii): all three classification tokens, each read back twice (「刷新后仍可查」), each equal
 *     to what `GET /api/approvals/:id` projects for the same round (one projector, three surfaces).
 *   - P-2 / P-7: V1 / V3 / V4 / V5 / V6 status tokens; system closure vs approver reject told apart by
 *     `closedBySystem`; `blockCode` without the adapter's free-text detail.
 *   - P-9: the seed template through the PUBLIC create path — legs A (admin HTTP), B (employee HTTP),
 *     C (normal actor, in-process service) — never yields a cancel round.
 *
 * A2 (owner 2026-09-29, 「Attendance-side + OFF flag (Recommended)」), the last describe block:
 *   - the launch sits behind `ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED`, default OFF. This file turns it
 *     ON in `beforeAll` (and restores the previous value in `afterAll`) because every phase A case
 *     launches; the OFF case removes it and measures zero writes.
 *   - `POST …/cancel-round/actions` (approve / reject, `attendance:approve`) and
 *     `POST …/cancel-round/withdraw` (`attendance:write`, original requester only) are driven with
 *     REAL login tokens: the seat holder is the fixture approver, whose `attendance_approver` role is
 *     added inside the A2 block (before that point it holds the employee role only, which is what the
 *     plugin-403 case measures). The dev-token approver remains fixture-only, as above.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

type Raw = { status: number; text: string; json: any }

const PLUGIN_FORBIDDEN_BODY = '{"ok":false,"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}'
const CORE_RBAC_FORBIDDEN_BODY = '{"error":"Insufficient permissions"}'

describeIfDatabase('cancel-round product entry phase A — attendance-side routes (real DB + real HTTP)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const previousRbacBypass = process.env.RBAC_BYPASS
  const ENTRY_FLAG = 'ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED'
  const previousEntryFlag = process.env[ENTRY_FLAG]
  const password = `G4a-entry-${TS}-Pw!`
  let passwordHash = ''

  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdRequestIds = new Set<string>()
  const createdLeaveTypeIds = new Set<string>()
  const seededUserIds = new Set<string>()
  const devTokenUserIds = new Set<string>()
  const createdRoleIds = new Set<string>()

  const pool = () => poolManager.get()
  const service = () => new ApprovalProductService()

  // The one approver every fixture document routes to, and the fixture template author.
  const approverId = `g4a-apr-${TS}`
  const authorId = `g4a-author-${TS}`
  let approverFixtureToken = ''
  let templateId = ''

  async function http(
    method: string,
    pathName: string,
    token: string | null,
    body?: unknown,
  ): Promise<Raw> {
    const response = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    let json: any
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { status: response.status, text, json }
  }

  /** A directory user that can log in. `roles` → `user_roles`, `perms` → `user_permissions`. */
  async function seedLoginUser(
    userId: string,
    options: { roles?: string[]; perms?: string[]; admin?: boolean } = {},
  ): Promise<void> {
    seededUserIds.add(userId)
    await pool().query(
      `INSERT INTO users
         (id, email, username, name, password_hash, role, permissions, is_active, is_admin,
          activation_status, local_password_set, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $1, $1, $3, $4, '[]'::jsonb, TRUE, $5, 'activated', TRUE, FALSE, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [userId, `${userId}@example.test`, passwordHash, options.admin ? 'admin' : 'user', options.admin === true],
    )
    await pool().query(
      `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE)
       ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
      [userId],
    )
    for (const roleId of options.roles ?? []) {
      await pool().query(
        'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, roleId],
      )
    }
    for (const code of options.perms ?? []) {
      await pool().query(
        'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [userId, code],
      )
    }
  }

  /**
   * A principal holding `perms` in the attendance namespace: a fixture role of its own carrying
   * `perms`, plus an enabled attendance namespace admission (see private record).
   */
  async function seedScopedAttendanceUser(userId: string, perms: string[]): Promise<void> {
    const roleId = `g4a_scoped_${userId}`
    createdRoleIds.add(roleId)
    await pool().query('INSERT INTO roles (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [roleId])
    for (const code of perms) {
      await pool().query(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [roleId, code],
      )
    }
    await seedLoginUser(userId, { roles: [roleId] })
    await pool().query(
      `INSERT INTO user_namespace_admissions (user_id, namespace, enabled) VALUES ($1, 'attendance', TRUE)
       ON CONFLICT (user_id, namespace) DO UPDATE SET enabled = TRUE`,
      [userId],
    )
  }

  /** P-10 「真实令牌」: minted by the production login route, not by the dev-token route. */
  async function loginToken(userId: string): Promise<string> {
    const login = await http('POST', '/api/auth/login', null, {
      identifier: `${userId}@example.test`,
      password,
    })
    expect(login.status, login.text).toBe(200)
    const token = login.json?.token ?? login.json?.data?.token
    expect(typeof token).toBe('string')
    return token as string
  }

  /** FIXTURE-ONLY admin-claims token (see file header); never sent to the routes under test. */
  async function fixtureAdminToken(userId: string): Promise<string> {
    devTokenUserIds.add(userId)
    const response = await http(
      'GET',
      `/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
      null,
    )
    expect(response.status).toBe(200)
    return response.json.token as string
  }

  async function publishFixtureTemplate(authorToken: string): Promise<string> {
    const create = await http('POST', '/api/approval-templates', authorToken, {
      key: `g4a-entry-${TS}-${Math.floor(Math.random() * 1e6)}`,
      name: 'G4-A cancel-round entry fixture',
      description: 'approval-cancel-round-attendance-entry.db.test.ts',
      formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'approval_a',
            type: 'approval',
            config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'single' },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-end', source: 'approval_a', target: 'end' },
        ],
      },
    })
    expect(create.status, create.text).toBe(201)
    const id = create.json.id as string
    createdTemplateIds.add(id)
    const publish = await http('POST', `/api/approval-templates/${id}/publish`, authorToken, {
      policy: { allowRevoke: true },
    })
    expect(publish.status, publish.text).toBe(200)
    return id
  }

  /**
   * An APPROVED leave: original document created in-process for `documentRequesterId` (so its
   * `requester_snapshot.id` is that person), approved by the fixture approver over HTTP, then
   * re-keyed as an attendance document with an `attendance_requests` row owned by `leaveUserId`
   * (composite FK order: instance re-key → request insert → business key), exactly the shape the
   * redemption suite's `attachAttendanceRequest` builds.
   */
  async function seedApprovedLeave(options: {
    documentRequesterId: string
    leaveUserId?: string
    requestStatus?: string
  }): Promise<{ documentId: string; requestId: string }> {
    // Fixture-only: the create boundary's DB-read approvals:write, granted for this call and removed.
    await grantApprovalWriteForIntegrationActor(options.documentRequesterId)
    let dto: { id: string }
    try {
      dto = await service().createApproval(
        { templateId, formData: { reason: 'g4a leave' } },
        { userId: options.documentRequesterId, roles: [] },
      )
    } finally {
      await pool().query(
        `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:write'`,
        [options.documentRequesterId],
      )
    }
    createdApprovalIds.add(dto.id)
    const approve = await http('POST', `/api/approvals/${dto.id}/actions`, approverFixtureToken, { action: 'approve' })
    expect(approve.status, approve.text).toBe(200)
    const status = await pool().query<{ status: string }>('SELECT status FROM approval_instances WHERE id = $1', [dto.id])
    expect(status.rows[0]?.status).toBe('approved')

    const rekeyed = await pool().query(
      `UPDATE approval_instances SET workflow_key = 'attendance.request' WHERE id = $1`,
      [dto.id],
    )
    expect(rekeyed.rowCount).toBe(1)
    const inserted = await pool().query<{ id: string }>(
      `INSERT INTO attendance_requests
         (user_id, work_date, request_type, status, approval_instance_id, approval_workflow_key)
       VALUES ($1, CURRENT_DATE, 'leave', $3, $2, 'attendance.request')
       RETURNING id::text AS id`,
      [options.leaveUserId ?? options.documentRequesterId, dto.id, options.requestStatus ?? 'approved'],
    )
    const requestId = inserted.rows[0].id
    createdRequestIds.add(requestId)
    await pool().query(`UPDATE approval_instances SET business_key = $2 WHERE id = $1`, [
      dto.id,
      `attendance-request:${requestId}`,
    ])
    return { documentId: dto.id, requestId }
  }

  async function roundsFor(documentId: string): Promise<Array<{ id: string; outcome: string; engine_instance_id: string }>> {
    const result = await pool().query<{ id: string; outcome: string; engine_instance_id: string }>(
      'SELECT id, outcome, engine_instance_id FROM approval_rounds WHERE document_id = $1 ORDER BY started_at',
      [documentId],
    )
    for (const row of result.rows) createdApprovalIds.add(row.engine_instance_id)
    return result.rows
  }

  function bindCancellationPort(
    respond: () => Promise<AttendanceRequestOperationExternalTransactionResultV1>,
  ): { stop: () => void; calls: AttendanceRequestOperationExternalTransactionInputV1[] } {
    const calls: AttendanceRequestOperationExternalTransactionInputV1[] = []
    const port: AttendanceCancellationExecutionPort = {
      execute: async () => {
        throw new Error('the HTTP entry must not be reached from the approval side')
      },
      executeInExternalTransaction: async (input) => {
        calls.push(input)
        return respond()
      },
    }
    const previous = getAttendanceCancellationExecutionPort()
    registerAttendanceCancellationExecutionProvider(port)
    return {
      calls,
      stop: () => {
        if (previous) registerAttendanceCancellationExecutionProvider(previous)
        else unregisterAttendanceCancellationExecutionProvider()
      },
    }
  }

  const entryPath = (requestId: string) => `/api/attendance/requests/${requestId}/cancel-round`

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    process.env.RBAC_BYPASS = 'false'
    // A2: the launch is default-OFF; every phase A case launches, so the suite runs with it ON and the
    // A2 OFF case removes it explicitly.
    process.env[ENTRY_FLAG] = 'true'
    await ensureApprovalSchemaReady()
    passwordHash = await bcrypt.hash(password, 4)
    const repoRoot = path.resolve(__dirname, '../../../..')
    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [path.join(repoRoot, 'plugins', 'plugin-attendance')],
    })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`

    await seedLoginUser(approverId, { roles: ['attendance_employee'] })
    await seedLoginUser(authorId)
    approverFixtureToken = await fixtureAdminToken(approverId)
    templateId = await publishFixtureTemplate(await fixtureAdminToken(authorId))
  })

  afterAll(async () => {
    try {
      const requestIds = [...createdRequestIds]
      if (createdApprovalIds.size > 0) {
        // Every round's own engine instance, including rounds no case read back through `roundsFor`.
        const engines = await pool().query<{ engine_instance_id: string }>(
          `SELECT engine_instance_id FROM approval_rounds
            WHERE document_id = ANY($1::text[]) AND engine_instance_id IS NOT NULL`,
          [[...createdApprovalIds]],
        )
        for (const row of engines.rows) createdApprovalIds.add(row.engine_instance_id)
      }
      const approvalIds = [...createdApprovalIds]
      if (requestIds.length > 0) {
        await pool().query('DELETE FROM attendance_requests WHERE id = ANY($1::uuid[])', [requestIds])
      }
      const leaveTypeIds = [...createdLeaveTypeIds]
      if (leaveTypeIds.length > 0) {
        await pool().query('DELETE FROM attendance_leave_types WHERE id = ANY($1::uuid[])', [leaveTypeIds])
      }
      if (approvalIds.length > 0) {
        // Phase C delivery-ledger fixtures: the todo mirror ledger has no FK to the instance.
        await pool().query('DELETE FROM dingtalk_todo_mirrors WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query(
          'DELETE FROM approval_rounds WHERE document_id = ANY($1::text[]) OR engine_instance_id = ANY($1::text[])',
          [approvalIds],
        )
        await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      const templateIds = [...createdTemplateIds]
      if (templateIds.length > 0) {
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      const userIds = [...new Set([...seededUserIds, ...devTokenUserIds])]
      if (userIds.length > 0) {
        // The LEAVE ONLY case approves a real missed_check_in through the plugin, which writes the
        // punch-side rows below. Their append-only revision history row is left in place by design
        // (direct mutation is refused by its guard).
        await pool().query('DELETE FROM attendance_events WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM attendance_records WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM user_sessions WHERE user_id = ANY($1::text[])', [userIds]).catch(() => undefined)
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...seededUserIds]])
      }
      const roleIds = [...createdRoleIds]
      if (roleIds.length > 0) {
        await pool().query('DELETE FROM user_roles WHERE role_id = ANY($1::text[])', [roleIds])
        await pool().query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [roleIds])
        await pool().query('DELETE FROM roles WHERE id = ANY($1::text[])', [roleIds])
      }
    } finally {
      await server?.stop()
      if (previousRbacBypass === undefined) delete process.env.RBAC_BYPASS
      else process.env.RBAC_BYPASS = previousRbacBypass
      if (previousEntryFlag === undefined) delete process.env[ENTRY_FLAG]
      else process.env[ENTRY_FLAG] = previousEntryFlag
    }
  })

  it('harness: real authorization is ON and the routes are registered (404 on an unknown id, not an unrouted path)', async () => {
    expect(process.env.RBAC_BYPASS).toBe('false')
    const employee = `g4a-harness-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const token = await loginToken(employee)
    const unknown = await http('GET', entryPath(randomUUID()), token)
    expect(unknown.status, unknown.text).toBe(404)
    expect(unknown.json).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: 'Request not found' } })
    const malformed = await http('GET', entryPath('not-a-uuid'), token)
    expect(malformed.status).toBe(400)
    expect(malformed.json?.error?.code).toBe('VALIDATION_ERROR')
  })

  it('P-10 + P-1: an employee REAL token (attendance_employee only, no approvals:*) — read 200 (none) → launch 201 → read 200; duplicate launch 409 ALREADY_PENDING', async () => {
    const employee = `g4a-emp-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const token = await loginToken(employee)
    const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })

    // Discriminator: this token really holds NO approvals:* — the approval-side detail route refuses it.
    const approvalSide = await http('GET', `/api/approvals/${documentId}`, token)
    expect(approvalSide.status).toBe(403)
    expect(approvalSide.text).toBe(CORE_RBAC_FORBIDDEN_BODY)

    const before = await http('GET', entryPath(requestId), token)
    expect(before.status, before.text).toBe(200)
    expect(before.json).toEqual({ ok: true, data: { requestId, documentInstanceId: documentId, round: null, entryEnabled: true } })

    const launch = await http('POST', entryPath(requestId), token, { reason: '行程取消' })
    expect(launch.status, launch.text).toBe(201)
    const round = launch.json.data.round
    expect(launch.json.data.requestId).toBe(requestId)
    expect(launch.json.data.documentInstanceId).toBe(documentId)
    // The launch body keeps the summary's shape, `entryEnabled` included (owner 14:3x ②).
    expect(Object.keys(launch.json.data).sort()).toEqual(['documentInstanceId', 'entryEnabled', 'requestId', 'round'])
    expect(launch.json.data.entryEnabled).toBe(true)
    expect(round).toMatchObject({
      outcome: 'pending',
      status: 'cancellation_pending_approval',
      endedAt: null,
      closeReason: null,
      blockCode: null,
      closedBySystem: false,
      canWithdraw: true,
      withdrawBlockedReason: null,
      cancellationOutcome: null,
    })
    // P-6: no seat / assignee data of any kind on this surface; P-4: no policy snapshot.
    expect(Object.keys(round).sort()).toEqual([
      'canWithdraw', 'cancellationOutcome', 'closeReason', 'closedBySystem', 'blockCode', 'deliveries',
      'endedAt', 'engineInstanceId', 'outcome', 'roundId', 'startedAt', 'status', 'withdrawBlockedReason',
    ].sort())
    // P-5: no delivery ledger row exists for this round (no card rule, the todo mirror is off).
    expect(round.deliveries).toEqual([])
    expect(launch.text.includes('policy_snapshot')).toBe(false)

    const rows = await roundsFor(documentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: round.roundId, outcome: 'pending', engine_instance_id: round.engineInstanceId })
    const engine = await pool().query<{ workflow_key: string; requester_id: string }>(
      `SELECT workflow_key, requester_snapshot->>'id' AS requester_id FROM approval_instances WHERE id = $1`,
      [round.engineInstanceId],
    )
    expect(engine.rows[0]).toEqual({ workflow_key: 'approval.cancel-round', requester_id: employee })

    const after = await http('GET', entryPath(requestId), token)
    expect(after.status).toBe(200)
    expect(after.json.data.round).toEqual(round)

    const duplicate = await http('POST', entryPath(requestId), token, {})
    expect(duplicate.status).toBe(409)
    expect(duplicate.json).toEqual({
      ok: false,
      error: { code: 'CANCEL_ROUND_ALREADY_PENDING', message: 'This document already has a cancel round in progress' },
    })
    expect(await roundsFor(documentId)).toHaveLength(1)
  })

  describe('P-3 (iii): the three classification tokens, durable and identical to the approval-side projection', () => {
    const cases: Array<{
      label: string
      response: AttendanceRequestOperationExternalTransactionResultV1
      expected: unknown
      expectedBytes: string
    }> = [
      {
        label: 'cancelled',
        response: {
          kind: 'executed',
          response: { ok: true, data: { reversal: { reversed: 480, lots: 1, unrecoverableExpired: 0, alreadyReversed: false } } },
        } as AttendanceRequestOperationExternalTransactionResultV1,
        expected: {
          status: 'cancelled',
          reversal: { reversed: 480, lots: 1, unrecoverableExpired: 0, alreadyReversed: false },
        },
        expectedBytes: '"cancellationOutcome":{"status":"cancelled","reversal":{"reversed":480,"lots":1,"unrecoverableExpired":0,"alreadyReversed":false}}',
      },
      {
        label: 'cancelled_with_unrecoverable_expired',
        response: {
          kind: 'executed',
          response: { ok: true, data: { reversal: { reversed: 360, lots: 2, unrecoverableExpired: 120, alreadyReversed: false } } },
        } as AttendanceRequestOperationExternalTransactionResultV1,
        expected: {
          status: 'cancelled_with_unrecoverable_expired',
          reversal: { reversed: 360, lots: 2, unrecoverableExpired: 120, alreadyReversed: false },
        },
        expectedBytes: '"cancellationOutcome":{"status":"cancelled_with_unrecoverable_expired","reversal":{"reversed":360,"lots":2,"unrecoverableExpired":120,"alreadyReversed":false}}',
      },
      {
        label: 'cancelled_reversal_unreported',
        response: { kind: 'executed', response: { ok: true, data: {} } } as AttendanceRequestOperationExternalTransactionResultV1,
        expected: { status: 'cancelled_reversal_unreported', reversal: null },
        expectedBytes: '"cancellationOutcome":{"status":"cancelled_reversal_unreported","reversal":null}',
      },
    ]

    for (const testCase of cases) {
      it(`${testCase.label}: launched by the employee, redeemed by the approver, read back twice by the employee`, async () => {
        const employee = `g4a-p3-${testCase.label}-${TS}`
        await seedLoginUser(employee, { roles: ['attendance_employee'] })
        const token = await loginToken(employee)
        const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })

        const launch = await http('POST', entryPath(requestId), token, {})
        expect(launch.status, launch.text).toBe(201)
        const roundInstanceId = launch.json.data.round.engineInstanceId as string

        const stub = bindCancellationPort(async () => testCase.response)
        try {
          const approve = await http('POST', `/api/approvals/${roundInstanceId}/actions`, approverFixtureToken, { action: 'approve' })
          expect(approve.status, approve.text).toBe(200)
          expect(stub.calls).toHaveLength(1)
        } finally {
          stub.stop()
        }

        const first = await http('GET', entryPath(requestId), token)
        expect(first.status, first.text).toBe(200)
        expect(first.json.data.round).toMatchObject({
          outcome: 'applied',
          status: 'leave_cancelled',
          closedBySystem: false,
          closeReason: null,
          blockCode: null,
          canWithdraw: false,
          withdrawBlockedReason: 'INVALID_STATUS_TRANSITION',
        })
        expect(first.json.data.round.cancellationOutcome).toEqual(testCase.expected)
        expect(first.text).toContain(testCase.expectedBytes)

        // 「刷新后仍可查」: a second, independent read returns the same bytes.
        const second = await http('GET', entryPath(requestId), token)
        expect(second.status).toBe(200)
        expect(second.text).toBe(first.text)

        // One projector, three surfaces: the approval-side detail of the SAME round agrees.
        const approvalSide = await http('GET', `/api/approvals/${roundInstanceId}`, approverFixtureToken)
        expect(approvalSide.status, approvalSide.text).toBe(200)
        expect(approvalSide.json.cancellationOutcome).toEqual(first.json.data.round.cancellationOutcome)
        expect((await roundsFor(documentId))[0]?.outcome).toBe('applied')
      })
    }
  })

  it('P-2: V3 approver reject is NOT a system close; the document may be relaunched (撤销不限次)', async () => {
    const employee = `g4a-v3-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const token = await loginToken(employee)
    const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })
    const launch = await http('POST', entryPath(requestId), token, {})
    expect(launch.status, launch.text).toBe(201)
    const reject = await http('POST', `/api/approvals/${launch.json.data.round.engineInstanceId}/actions`, approverFixtureToken, {
      action: 'reject',
      comment: 'no',
    })
    expect(reject.status, reject.text).toBe(200)

    const summary = await http('GET', entryPath(requestId), token)
    expect(summary.json.data.round).toMatchObject({
      outcome: 'rejected',
      status: 'cancellation_rejected',
      closedBySystem: false,
      closeReason: null,
      cancellationOutcome: null,
      canWithdraw: false,
    })
    const relaunch = await http('POST', entryPath(requestId), token, {})
    expect(relaunch.status, relaunch.text).toBe(201)
    expect(relaunch.json.data.round.roundId).not.toBe(launch.json.data.round.roundId)
    expect((await roundsFor(documentId)).map((row) => row.outcome)).toEqual(['rejected', 'pending'])
  })

  it('P-2: V5 window-closed system close is told apart from an approver reject (closedBySystem + round_expired)', async () => {
    const employee = `g4a-v5-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const token = await loginToken(employee)
    const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })
    // §2-G2 anchor moved past the leave suite's 90-day ceiling — the anchor, not the clock.
    const aged = await pool().query(
      `UPDATE approval_records SET created_at = now() - make_interval(days => 200)
        WHERE instance_id = $1 AND to_status = 'approved'`,
      [documentId],
    )
    expect(aged.rowCount).toBe(1)
    const launch = await http('POST', entryPath(requestId), token, {})
    expect(launch.status, launch.text).toBe(201)
    const approve = await http('POST', `/api/approvals/${launch.json.data.round.engineInstanceId}/actions`, approverFixtureToken, {
      action: 'approve',
    })
    expect(approve.status, approve.text).toBe(200)

    const summary = await http('GET', entryPath(requestId), token)
    expect(summary.json.data.round).toMatchObject({
      outcome: 'expired',
      status: 'cancellation_window_closed',
      closedBySystem: true,
      closeReason: 'round_expired',
      blockCode: null,
      cancellationOutcome: null,
    })
    expect((await roundsFor(documentId))[0]?.outcome).toBe('expired')
  })

  it('P-2 / P-7: V6 business block carries the bare code, never the adapter detail', async () => {
    const employee = `g4a-v6-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const token = await loginToken(employee)
    const { requestId } = await seedApprovedLeave({ documentRequesterId: employee })
    const launch = await http('POST', entryPath(requestId), token, {})
    expect(launch.status, launch.text).toBe(201)
    const stub = bindCancellationPort(async () => ({
      kind: 'business_refused',
      code: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
      detail: 'g4a-free-text-detail-must-not-appear',
    }) as AttendanceRequestOperationExternalTransactionResultV1)
    try {
      const approve = await http('POST', `/api/approvals/${launch.json.data.round.engineInstanceId}/actions`, approverFixtureToken, {
        action: 'approve',
      })
      expect(approve.status, approve.text).toBe(200)
    } finally {
      stub.stop()
    }
    const summary = await http('GET', entryPath(requestId), token)
    expect(summary.json.data.round).toMatchObject({
      outcome: 'blocked',
      status: 'cancellation_blocked',
      closedBySystem: true,
      closeReason: 'business_blocked:ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
      blockCode: 'ATTENDANCE_CANCELLATION_REVIEW_REQUIRED',
    })
    expect(summary.text.includes('g4a-free-text-detail-must-not-appear')).toBe(false)
  })

  it('P-4 canWithdraw agrees with the ENGINE revoke gate in both directions (requester true ⇒ engine revoke succeeds; admin false ⇒ same code, before AND after the round ends); the approval-side action route still refuses the employee (witness)', async () => {
    const employee = `g4a-wd-${TS}`
    const admin = `g4a-wd-admin-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    await seedLoginUser(admin, { roles: ['admin'], admin: true })
    const employeeToken = await loginToken(employee)
    const adminToken = await loginToken(admin)
    const { requestId } = await seedApprovedLeave({ documentRequesterId: employee })
    const launch = await http('POST', entryPath(requestId), employeeToken, {})
    expect(launch.status, launch.text).toBe(201)
    const roundInstanceId = launch.json.data.round.engineInstanceId as string

    const adminView = await http('GET', entryPath(requestId), adminToken)
    expect(adminView.status, adminView.text).toBe(200)
    expect(adminView.json.data.round).toMatchObject({ canWithdraw: false, withdrawBlockedReason: 'APPROVAL_REVOKE_FORBIDDEN' })
    await expect(
      service().dispatchAction(roundInstanceId, { action: 'revoke' } as ApprovalActionRequest, { userId: admin, roles: ['admin'] }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'APPROVAL_REVOKE_FORBIDDEN' })

    expect(launch.json.data.round.canWithdraw).toBe(true)

    // WITNESS: `canWithdraw` is the ENGINE-level gate. The approval-side action route keeps its own
    // permission guard in front of the engine, and the same employee token is refused there before
    // the engine is reached — exact core body, round untouched. The employee's HTTP withdraw path is
    // the attendance-side route added by A2 (driven in the A2 block below).
    const httpRevoke = await http('POST', `/api/approvals/${roundInstanceId}/actions`, employeeToken, { action: 'revoke' })
    expect(httpRevoke.status).toBe(403)
    expect(httpRevoke.text).toBe(CORE_RBAC_FORBIDDEN_BODY)
    const stillPending = await http('GET', entryPath(requestId), employeeToken)
    expect(stillPending.json.data.round).toMatchObject({ outcome: 'pending', canWithdraw: true, withdrawBlockedReason: null })

    await service().dispatchAction(roundInstanceId, { action: 'revoke' } as ApprovalActionRequest, { userId: employee, roles: [] })
    const withdrawn = await http('GET', entryPath(requestId), employeeToken)
    expect(withdrawn.json.data.round).toMatchObject({
      outcome: 'withdrawn',
      status: 'cancellation_withdrawn',
      closedBySystem: false,
      canWithdraw: false,
      withdrawBlockedReason: 'INVALID_STATUS_TRANSITION',
    })

    // Same agreement once the round has ENDED, for a viewer who is not the requester: the engine
    // checks the requester before the terminal status, so it answers the admin APPROVAL_REVOKE_FORBIDDEN
    // (not INVALID_STATUS_TRANSITION) — and the summary must name the same code.
    const adminAfter = await http('GET', entryPath(requestId), adminToken)
    expect(adminAfter.status, adminAfter.text).toBe(200)
    expect(adminAfter.json.data.round).toMatchObject({
      outcome: 'withdrawn',
      canWithdraw: false,
      withdrawBlockedReason: 'APPROVAL_REVOKE_FORBIDDEN',
    })
    await expect(
      service().dispatchAction(roundInstanceId, { action: 'revoke' } as ApprovalActionRequest, { userId: admin, roles: ['admin'] }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'APPROVAL_REVOKE_FORBIDDEN' })
    await expect(
      service().dispatchAction(roundInstanceId, { action: 'revoke' } as ApprovalActionRequest, { userId: employee, roles: [] }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATUS_TRANSITION' })
  })

  it('P-4 / I7: an outsider, and a request with no approval instance, get the byte-identical 404 of a never-existing id (GET and POST)', async () => {
    const employee = `g4a-own-${TS}`
    const outsider = `g4a-out-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    await seedLoginUser(outsider, { roles: ['attendance_employee'] })
    const employeeToken = await loginToken(employee)
    const outsiderToken = await loginToken(outsider)
    const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })
    const neverExisting = randomUUID()

    for (const method of ['GET', 'POST'] as const) {
      const absent = await http(method, entryPath(neverExisting), outsiderToken, method === 'POST' ? {} : undefined)
      const foreign = await http(method, entryPath(requestId), outsiderToken, method === 'POST' ? {} : undefined)
      expect(absent.status).toBe(404)
      expect(foreign.status).toBe(absent.status)
      expect(foreign.text).toBe(absent.text)
    }
    expect(await roundsFor(documentId)).toHaveLength(0)

    const bare = await pool().query<{ id: string }>(
      `INSERT INTO attendance_requests (user_id, work_date, request_type, status)
       VALUES ($1, CURRENT_DATE, 'leave', 'approved') RETURNING id::text AS id`,
      [employee],
    )
    createdRequestIds.add(bare.rows[0].id)
    const ownBareGet = await http('GET', entryPath(bare.rows[0].id), employeeToken)
    const ownAbsentGet = await http('GET', entryPath(neverExisting), employeeToken)
    expect(ownBareGet.status).toBe(404)
    expect(ownBareGet.text).toBe(ownAbsentGet.text)
  })

  it('P-1 (b): a participant who may READ (the approver) sees the summary but cannot launch — 403 CANCEL_ROUND_REQUESTER_ONLY', async () => {
    const employee = `g4a-part-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const approverToken = await loginToken(approverId)
    const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })
    const read = await http('GET', entryPath(requestId), approverToken)
    expect(read.status, read.text).toBe(200)
    expect(read.json.data.round).toBeNull()
    const launch = await http('POST', entryPath(requestId), approverToken, {})
    expect(launch.status).toBe(403)
    expect(launch.json).toEqual({
      ok: false,
      error: {
        code: 'CANCEL_ROUND_REQUESTER_ONLY',
        message: 'Only the original requester may start a cancel round for this document',
      },
    })
    expect(await roundsFor(documentId)).toHaveLength(0)
  })

  it('P-1 (b) route-level witness: a document whose snapshot requester ≠ the leave owner cannot be launched by the snapshot requester', async () => {
    // DEFENCE IN DEPTH, constructed shape: the plugin's own request writers set
    // `requester_snapshot.id` = the request's `user_id` today, so the plugin does not produce this
    // shape; the fixture builds it directly to witness the route's own check. It is the one fixture
    // where that check is load-bearing: the creation path compares against `requester_snapshot.id`
    // (= the snapshot requester here) and would accept; the route compares against the leave's
    // `user_id` (= the owner) and must refuse. lock:157 「委托人不可;代理发起另案」.
    const proxy = `g4a-proxy-${TS}`
    const owner = `g4a-proxied-${TS}`
    await seedLoginUser(proxy, { roles: ['attendance_employee'] })
    await seedLoginUser(owner, { roles: ['attendance_employee'] })
    const proxyToken = await loginToken(proxy)
    const ownerToken = await loginToken(owner)
    const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: proxy, leaveUserId: owner })

    const launch = await http('POST', entryPath(requestId), proxyToken, {})
    expect(launch.status, launch.text).toBe(403)
    expect(launch.json?.error?.code).toBe('CANCEL_ROUND_REQUESTER_ONLY')
    expect(await roundsFor(documentId)).toHaveLength(0)

    // Documented consequence of I7 (no second predicate): the leave's owner is not a participant of
    // a document someone else submitted, so the summary is 404 to them.
    const ownerRead = await http('GET', entryPath(requestId), ownerToken)
    expect(ownerRead.status).toBe(404)
  })

  it('P-1 (a): a leave whose attendance request is not approved — 409 CANCEL_ROUND_DOCUMENT_NOT_APPROVED, no round', async () => {
    const employee = `g4a-na-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const token = await loginToken(employee)
    const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee, requestStatus: 'pending' })
    const launch = await http('POST', entryPath(requestId), token, {})
    expect(launch.status).toBe(409)
    expect(launch.json).toEqual({
      ok: false,
      error: {
        code: 'CANCEL_ROUND_DOCUMENT_NOT_APPROVED',
        message: 'A cancel round can only be started for an approved document',
      },
    })
    expect(await roundsFor(documentId)).toHaveLength(0)
  })

  it('LEAVE ONLY: an approved NON-leave request created and approved through the real plugin routes is outside the entry — GET and POST are the byte-identical 404 of a never-existing id, and no round is opened', async () => {
    // Same predicate as the W4 cancel adapter's `approvedLeave` (status approved AND request_type
    // leave): a round on a non-leave document could never be redeemed by W4. The refusal shape (the
    // not-found body, no new code) is provisional pending an owner/gate pick (design MD).
    const employee = `g4a-nl-${TS}`
    const attendanceAdmin = `g4a-nl-admin-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    await seedLoginUser(attendanceAdmin, { roles: ['admin'], admin: true })
    const token = await loginToken(employee)
    const create = await http('POST', '/api/attendance/requests', token, {
      workDate: new Date().toISOString().slice(0, 10),
      requestType: 'missed_check_in',
      requestedInAt: new Date().toISOString(),
    })
    expect(create.status, create.text).toBe(201)
    const requestId = create.json?.data?.request?.id as string
    expect(typeof requestId).toBe('string')
    createdRequestIds.add(requestId)
    const created = await pool().query<{ approval_instance_id: string | null }>(
      'SELECT approval_instance_id FROM attendance_requests WHERE id = $1',
      [requestId],
    )
    const documentId = created.rows[0]?.approval_instance_id
    expect(typeof documentId).toBe('string')
    createdApprovalIds.add(documentId as string)

    const approve = await http('POST', `/api/attendance/requests/${requestId}/approve`, await loginToken(attendanceAdmin), { comment: 'ok' })
    expect(approve.status, approve.text).toBe(200)
    const row = await pool().query<{ status: string; request_type: string; engine_status: string }>(
      `SELECT r.status, r.request_type, i.status AS engine_status
         FROM attendance_requests r JOIN approval_instances i ON i.id = r.approval_instance_id
        WHERE r.id = $1`,
      [requestId],
    )
    // Precondition, so the 404 below cannot pass vacuously: approved on both sides, not a leave.
    expect(row.rows[0]).toEqual({ status: 'approved', request_type: 'missed_check_in', engine_status: 'approved' })

    const neverExisting = randomUUID()
    for (const method of ['GET', 'POST'] as const) {
      const body = method === 'POST' ? {} : undefined
      const absent = await http(method, entryPath(neverExisting), token, body)
      const nonLeave = await http(method, entryPath(requestId), token, body)
      expect(absent.status).toBe(404)
      expect(nonLeave.status, nonLeave.text).toBe(404)
      expect(nonLeave.text).toBe(absent.text)
    }
    expect(await roundsFor(documentId as string)).toHaveLength(0)
  })

  it('ORG SCOPE: the requester\'s own approved leave whose request row sits in ANOTHER org is the byte-identical 404 of a never-existing id (GET and POST), and no round is opened', async () => {
    const employee = `g4a-org-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const token = await loginToken(employee)
    const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })
    const moved = await pool().query(
      `UPDATE attendance_requests SET org_id = $2 WHERE id = $1`,
      [requestId, `g4a-other-org-${TS}`],
    )
    expect(moved.rowCount).toBe(1)

    const neverExisting = randomUUID()
    for (const method of ['GET', 'POST'] as const) {
      const body = method === 'POST' ? {} : undefined
      const absent = await http(method, entryPath(neverExisting), token, body)
      const otherOrg = await http(method, entryPath(requestId), token, body)
      expect(absent.status).toBe(404)
      expect(otherOrg.status, otherOrg.text).toBe(404)
      expect(otherOrg.text).toBe(absent.text)
    }
    expect(await roundsFor(documentId)).toHaveLength(0)
  })

  it('P-8 / P-6′: creation-path refusals pass through as {code, message} only — SUITE_FORBIDDEN with its own message; the seat class (SEAT_INELIGIBLE, NO_ELIGIBLE_APPROVER) with the neutral message and no details', async () => {
    const employee = `g4a-p8-${TS}`
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const token = await loginToken(employee)

    const forbidden = await seedApprovedLeave({ documentRequesterId: employee })
    await pool().query(
      `UPDATE approval_instances SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"suite":"forbidden"}'::jsonb WHERE id = $1`,
      [forbidden.documentId],
    )
    const suite = await http('POST', entryPath(forbidden.requestId), token, {})
    expect(suite.status, suite.text).toBe(409)
    expect(suite.json.error.code).toBe('CANCEL_ROUND_SUITE_FORBIDDEN')
    expect(Object.keys(suite.json.error).sort()).toEqual(['code', 'message'])
    // Non-seat codes keep the creation path's own message.
    expect(typeof suite.json.error.message).toBe('string')
    expect(suite.json.error.message).not.toBe(CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE)

    const seat = await seedApprovedLeave({ documentRequesterId: employee })
    await pool().query('UPDATE users SET is_active = FALSE WHERE id = $1', [approverId])
    try {
      const ineligible = await http('POST', entryPath(seat.requestId), token, {})
      expect(ineligible.status, ineligible.text).toBe(409)
      expect(ineligible.json).toEqual({
        ok: false,
        error: { code: 'CANCEL_ROUND_SEAT_INELIGIBLE', message: CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE },
      })
      expect(ineligible.text.includes('details')).toBe(false)
      expect(ineligible.text.includes(approverId)).toBe(false)
    } finally {
      await pool().query('UPDATE users SET is_active = TRUE WHERE id = $1', [approverId])
    }

    // NO_ELIGIBLE_APPROVER: the document's only approval is re-labelled as automation's, so the
    // creation path finds no human seat to re-convene.
    const automated = await seedApprovedLeave({ documentRequesterId: employee })
    const relabelled = await pool().query(
      `UPDATE approval_records SET actor_id = 'system:auto-approval' WHERE instance_id = $1 AND action = 'approve'`,
      [automated.documentId],
    )
    expect(relabelled.rowCount).toBe(1)
    const noSeat = await http('POST', entryPath(automated.requestId), token, {})
    expect(noSeat.status, noSeat.text).toBe(409)
    expect(noSeat.json).toEqual({
      ok: false,
      error: { code: 'CANCEL_ROUND_NO_ELIGIBLE_APPROVER', message: CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE },
    })

    expect(await roundsFor(forbidden.documentId)).toHaveLength(0)
    expect(await roundsFor(seat.documentId)).toHaveLength(0)
    expect(await roundsFor(automated.documentId)).toHaveLength(0)
  })

  it('P-10 positive control: an ADMIN real token is green on the same three steps for their own leave, and reads (I7 admin arm) but cannot launch someone else\'s', async () => {
    const admin = `g4a-admin-${TS}`
    const employee = `g4a-adm-emp-${TS}`
    await seedLoginUser(admin, { roles: ['admin'], admin: true })
    await seedLoginUser(employee, { roles: ['attendance_employee'] })
    const adminToken = await loginToken(admin)

    const own = await seedApprovedLeave({ documentRequesterId: admin })
    expect((await http('GET', entryPath(own.requestId), adminToken)).status).toBe(200)
    const launch = await http('POST', entryPath(own.requestId), adminToken, {})
    expect(launch.status, launch.text).toBe(201)
    const read = await http('GET', entryPath(own.requestId), adminToken)
    expect(read.status).toBe(200)
    expect(read.json.data.round.roundId).toBe(launch.json.data.round.roundId)

    const other = await seedApprovedLeave({ documentRequesterId: employee })
    const otherRead = await http('GET', entryPath(other.requestId), adminToken)
    expect(otherRead.status, otherRead.text).toBe(200)
    const otherLaunch = await http('POST', entryPath(other.requestId), adminToken, {})
    expect(otherLaunch.status).toBe(403)
    expect(otherLaunch.json.error.code).toBe('CANCEL_ROUND_REQUESTER_ONLY')
  })

  it('P-10 (c): without attendance:write the launch is refused by the plugin guard (exact body); without attendance:read the read is too', async () => {
    const readOnly = `g4a-ro-${TS}`
    const noRead = `g4a-nr-${TS}`
    await seedScopedAttendanceUser(readOnly, ['attendance:read'])
    await seedScopedAttendanceUser(noRead, ['attendance:approve'])
    const readOnlyToken = await loginToken(readOnly)
    const noPermToken = await loginToken(noRead)
    const own = await seedApprovedLeave({ documentRequesterId: readOnly })

    const read = await http('GET', entryPath(own.requestId), readOnlyToken)
    expect(read.status, read.text).toBe(200)
    const launch = await http('POST', entryPath(own.requestId), readOnlyToken, {})
    expect(launch.status).toBe(403)
    expect(launch.text).toBe(PLUGIN_FORBIDDEN_BODY)
    expect(await roundsFor(own.documentId)).toHaveLength(0)

    const noPermOwn = await seedApprovedLeave({ documentRequesterId: noRead })
    const noPermRead = await http('GET', entryPath(noPermOwn.requestId), noPermToken)
    expect(noPermRead.status).toBe(403)
    expect(noPermRead.text).toBe(PLUGIN_FORBIDDEN_BODY)
  })

  describe('P-9: the seed template through the PUBLIC create path never yields a cancel round', () => {
    async function countRounds(): Promise<number> {
      const result = await pool().query<{ count: string }>('SELECT COUNT(*)::text AS count FROM approval_rounds')
      return Number(result.rows[0].count)
    }
    async function seedInstancesBy(userId: string): Promise<number> {
      const result = await pool().query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM approval_instances WHERE template_id = $1 AND requester_snapshot->>'id' = $2`,
        [CANCEL_ROUND_TEMPLATE_ID, userId],
      )
      return Number(result.rows[0].count)
    }

    it('leg A — admin HTTP (rbac bypassed by the admin claim): the exact refusal, zero instances, zero rounds', async () => {
      const admin = `g4a-p9a-${TS}`
      const token = await fixtureAdminToken(admin)
      const roundsBefore = await countRounds()
      const create = await http('POST', '/api/approvals', token, { templateId: CANCEL_ROUND_TEMPLATE_ID, formData: {} })
      if (create.status >= 200 && create.status < 300) {
        createdApprovalIds.add(create.json.id)
        const row = await pool().query<{ workflow_key: string }>('SELECT workflow_key FROM approval_instances WHERE id = $1', [create.json.id])
        expect(row.rows[0]?.workflow_key).not.toBe('approval.cancel-round')
      }
      // Measured answer: the admin claim passes rbac AND template visibility (template manager); the
      // seed graph's single `requester_choice` node then refuses before any insert.
      expect(create.status, create.text).toBe(422)
      expect(create.json?.error?.code).toBe('APPROVAL_REQUESTER_CHOICE_REQUIRED')
      expect(await seedInstancesBy(admin)).toBe(0)
      expect(await countRounds()).toBe(roundsBefore)

      // Driven one door further: WITH the requester choice supplied, the in-transaction create
      // boundary (DB-only template visibility — the admin CLAIM does not reach it) refuses the seed
      // exactly as it refuses a never-existing template. Measured, and pinned.
      const withChoice = await http('POST', '/api/approvals', token, {
        templateId: CANCEL_ROUND_TEMPLATE_ID,
        formData: {},
        requesterChoices: { cancel_approval: [approverId] },
      })
      if (withChoice.status >= 200 && withChoice.status < 300) createdApprovalIds.add(withChoice.json.id)
      expect(withChoice.status, withChoice.text).toBe(404)
      expect(withChoice.json?.error?.code).toBe('APPROVAL_TEMPLATE_NOT_FOUND')
      expect(await seedInstancesBy(admin)).toBe(0)
      expect(await countRounds()).toBe(roundsBefore)
    })

    it('leg B — employee HTTP (no approvals:*): 403 at rbacGuard(approvals, write), before any template lookup', async () => {
      const employee = `g4a-p9b-${TS}`
      await seedLoginUser(employee, { roles: ['attendance_employee'] })
      const token = await loginToken(employee)
      const roundsBefore = await countRounds()
      const create = await http('POST', '/api/approvals', token, { templateId: CANCEL_ROUND_TEMPLATE_ID, formData: {} })
      expect(create.status).toBe(403)
      expect(create.text).toBe(CORE_RBAC_FORBIDDEN_BODY)
      expect(await seedInstancesBy(employee)).toBe(0)
      expect(await countRounds()).toBe(roundsBefore)
    })

    it('leg C — normal actor, in-process service (no rbac in front): refused as a never-existing template, zero instances, zero rounds', async () => {
      const employee = `g4a-p9c-${TS}`
      await seedLoginUser(employee, { roles: ['attendance_employee'] })
      const roundsBefore = await countRounds()
      await expect(
        service().createApproval({ templateId: CANCEL_ROUND_TEMPLATE_ID, formData: {} }, { userId: employee, roles: [] }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'APPROVAL_TEMPLATE_NOT_FOUND' })
      await expect(
        service().createApproval({ templateId: randomUUID(), formData: {} }, { userId: employee, roles: [] }),
      ).rejects.toMatchObject({ statusCode: 404, code: 'APPROVAL_TEMPLATE_NOT_FOUND' })
      expect(await seedInstancesBy(employee)).toBe(0)
      expect(await countRounds()).toBe(roundsBefore)
    })
  })

  describe('A2 (owner 2026-09-29 「Attendance-side + OFF flag (Recommended)」): default-OFF launch flag, approver approve / reject, requester withdraw', () => {
    const NOT_FOUND_BODY = '{"ok":false,"error":{"code":"NOT_FOUND","message":"Request not found"}}'
    const actionsPath = (requestId: string) => `${entryPath(requestId)}/actions`
    const withdrawPath = (requestId: string) => `${entryPath(requestId)}/withdraw`
    const expectedCancelled = {
      status: 'cancelled',
      reversal: { reversed: 480, lots: 1, unrecoverableExpired: 0, alreadyReversed: false },
    }
    const cancelledResponse = {
      kind: 'executed',
      response: { ok: true, data: { reversal: { reversed: 480, lots: 1, unrecoverableExpired: 0, alreadyReversed: false } } },
    } as AttendanceRequestOperationExternalTransactionResultV1

    /** Whole-table row counts: the OFF launch must add nothing to any table the creation path writes. */
    const WRITE_SET = ['approval_instances', 'approval_rounds', 'approval_assignments', 'approval_records'] as const
    async function countWriteSet(): Promise<Record<(typeof WRITE_SET)[number], number>> {
      const counts = {} as Record<(typeof WRITE_SET)[number], number>
      for (const table of WRITE_SET) {
        const result = await pool().query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`)
        counts[table] = Number(result.rows[0].count)
      }
      return counts
    }

    /** The fixture approver (the seat on every fixture document) gains the built-in approver role. */
    async function grantAttendanceApproverRole(userId: string): Promise<void> {
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'attendance_approver') ON CONFLICT DO NOTHING`,
        [userId],
      )
    }

    /** An employee's approved leave with a PENDING round launched through the entry (flag ON). */
    async function launchedRound(label: string): Promise<{
      employee: string
      employeeToken: string
      documentId: string
      requestId: string
      roundInstanceId: string
      roundId: string
    }> {
      const employee = `g4a-a2-${label}-${TS}`
      await seedLoginUser(employee, { roles: ['attendance_employee'] })
      const employeeToken = await loginToken(employee)
      const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })
      const launch = await http('POST', entryPath(requestId), employeeToken, {})
      expect(launch.status, launch.text).toBe(201)
      return {
        employee,
        employeeToken,
        documentId,
        requestId,
        roundInstanceId: launch.json.data.round.engineInstanceId as string,
        roundId: launch.json.data.round.roundId as string,
      }
    }

    it('flag OFF (unset, and an explicit "false"): the launch answers the byte-identical 404 of a never-existing id and writes NOTHING; the summary read is unaffected; flag ON is the positive control on the same leave', async () => {
      const employee = `g4a-a2-off-${TS}`
      await seedLoginUser(employee, { roles: ['attendance_employee'] })
      const token = await loginToken(employee)
      const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })
      const before = await countWriteSet()
      try {
        for (const value of [undefined, 'false'] as const) {
          if (value === undefined) delete process.env[ENTRY_FLAG]
          else process.env[ENTRY_FLAG] = value
          const off = await http('POST', entryPath(requestId), token, { reason: 'flag off' })
          const absent = await http('POST', entryPath(randomUUID()), token, {})
          expect(off.status, off.text).toBe(404)
          expect(off.text).toBe(NOT_FOUND_BODY)
          expect(off.text).toBe(absent.text)
          // The read is not gated, and it reports the flag's GLOBAL state (owner 14:3x ②): false.
          const read = await http('GET', entryPath(requestId), token)
          expect(read.status, read.text).toBe(200)
          expect(read.json.data.round).toBeNull()
          expect(read.json.data.entryEnabled).toBe(false)
        }
        // Zero writes: no round, no engine instance, no seat, no audit row — anywhere, not just here.
        expect(await roundsFor(documentId)).toHaveLength(0)
        expect(await countWriteSet()).toEqual(before)
      } finally {
        process.env[ENTRY_FLAG] = 'true'
      }
      const on = await http('POST', entryPath(requestId), token, {})
      expect(on.status, on.text).toBe(201)
      expect(on.json.data.entryEnabled).toBe(true)
      const readOn = await http('GET', entryPath(requestId), token)
      expect(readOn.json.data.entryEnabled).toBe(true)
      expect(await roundsFor(documentId)).toHaveLength(1)
      const after = await countWriteSet()
      expect(after.approval_instances).toBe(before.approval_instances + 1)
      expect(after.approval_rounds).toBe(before.approval_rounds + 1)
    })

    it('without attendance:approve, the SEAT HOLDER is refused by the plugin guard (exact body) and the round is untouched; with the approver role added, the same person on the same round succeeds', async () => {
      const fixture = await launchedRound('noperm')
      const approverToken = await loginToken(approverId)
      const refused = await http('POST', actionsPath(fixture.requestId), approverToken, { action: 'approve' })
      expect(refused.status).toBe(403)
      expect(refused.text).toBe(PLUGIN_FORBIDDEN_BODY)
      expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['pending'])

      await grantAttendanceApproverRole(approverId)
      const stub = bindCancellationPort(async () => cancelledResponse)
      try {
        const approved = await http('POST', actionsPath(fixture.requestId), approverToken, { action: 'approve' })
        expect(approved.status, approved.text).toBe(200)
        expect(stub.calls).toHaveLength(1)
      } finally {
        stub.stop()
      }
      expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['applied'])
    })

    it('approve by the seated attendance_approver (real token): the round is redeemed through the SAME engine entry — leave cancelled, reversal carried (C-2 shape), identical on the entry summary and the approval-side projection; the approve is recorded AS the caller', async () => {
      await grantAttendanceApproverRole(approverId)
      const approverToken = await loginToken(approverId)
      const fixture = await launchedRound('approve')

      // `roles: []` premise (port docblock): every seat on a launched round is a PERSON seat.
      const seats = await pool().query<{ assignment_type: string; assignee_id: string; is_active: boolean }>(
        'SELECT assignment_type, assignee_id, is_active FROM approval_assignments WHERE instance_id = $1',
        [fixture.roundInstanceId],
      )
      expect(seats.rows.length).toBeGreaterThan(0)
      expect(seats.rows.every((row) => row.assignment_type === 'user')).toBe(true)
      expect(seats.rows.filter((row) => row.is_active).map((row) => row.assignee_id)).toEqual([approverId])

      const stub = bindCancellationPort(async () => cancelledResponse)
      let approved: Raw = { status: 0, text: '', json: undefined }
      try {
        approved = await http('POST', actionsPath(fixture.requestId), approverToken, { action: 'approve', comment: '同意撤销' })
        expect(approved.status, approved.text).toBe(200)
        expect(stub.calls).toHaveLength(1)
      } finally {
        stub.stop()
      }
      // Owner 14:3x ① 「Minimal action response」: the success body names the round and where it now
      // stands — exactly these four keys; the summary is read behind I7 on the summary route only.
      expect(approved.json).toEqual({
        ok: true,
        data: { requestId: fixture.requestId, roundId: fixture.roundId, outcome: 'applied', status: 'leave_cancelled' },
      })

      const employeeRead = await http('GET', entryPath(fixture.requestId), fixture.employeeToken)
      expect(employeeRead.status).toBe(200)
      expect(employeeRead.json.data.round).toMatchObject({
        roundId: fixture.roundId,
        outcome: 'applied',
        status: 'leave_cancelled',
        closedBySystem: false,
        closeReason: null,
        blockCode: null,
        canWithdraw: false,
      })
      expect(employeeRead.json.data.round.cancellationOutcome).toEqual(expectedCancelled)
      const approvalSide = await http('GET', `/api/approvals/${fixture.roundInstanceId}`, approverFixtureToken)
      expect(approvalSide.status, approvalSide.text).toBe(200)
      expect(approvalSide.json.cancellationOutcome).toEqual(expectedCancelled)
      expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['applied'])

      const record = await pool().query<{ actor_id: string; comment: string | null }>(
        `SELECT actor_id, comment FROM approval_records WHERE instance_id = $1 AND action = 'approve'`,
        [fixture.roundInstanceId],
      )
      expect(record.rows).toEqual([{ actor_id: approverId, comment: '同意撤销' }])
    })

    it('reject by the seated approver: the service entry\'s own comment rule is passed through (400, round untouched), then a commented reject closes the round as V3 and the ORIGINAL leave is unchanged', async () => {
      await grantAttendanceApproverRole(approverId)
      const approverToken = await loginToken(approverId)
      const fixture = await launchedRound('reject')
      const stub = bindCancellationPort(async () => {
        throw new Error('a reject must never reach the cancellation boundary')
      })
      try {
        const bare = await http('POST', actionsPath(fixture.requestId), approverToken, { action: 'reject' })
        expect(bare.status, bare.text).toBe(400)
        expect(bare.json).toEqual({ ok: false, error: { code: 'REJECT_COMMENT_REQUIRED', message: 'Rejection comment is required' } })
        expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['pending'])

        const rejected = await http('POST', actionsPath(fixture.requestId), approverToken, { action: 'reject', comment: '不同意' })
        expect(rejected.status, rejected.text).toBe(200)
        expect(rejected.json).toEqual({
          ok: true,
          data: { requestId: fixture.requestId, roundId: fixture.roundId, outcome: 'rejected', status: 'cancellation_rejected' },
        })
        const summary = await http('GET', entryPath(fixture.requestId), fixture.employeeToken)
        expect(summary.json.data.round).toMatchObject({
          roundId: fixture.roundId,
          outcome: 'rejected',
          status: 'cancellation_rejected',
          closedBySystem: false,
          closeReason: null,
          cancellationOutcome: null,
        })
        expect(stub.calls).toHaveLength(0)
      } finally {
        stub.stop()
      }
      const original = await pool().query<{ instance_status: string; request_status: string }>(
        `SELECT i.status AS instance_status, r.status AS request_status
           FROM approval_instances i JOIN attendance_requests r ON r.approval_instance_id = i.id
          WHERE i.id = $1`,
        [fixture.documentId],
      )
      expect(original.rows[0]).toEqual({ instance_status: 'approved', request_status: 'approved' })
    })

    it('an attendance:approve holder WITHOUT a seat gets the service entry\'s existing refusal (403 APPROVAL_ASSIGNMENT_REQUIRED, code + message only) and the round is untouched; with no round, and for a never-existing id, the entry\'s 404', async () => {
      // A holder of the built-in approver role who is NOT a seat on the round (and not its requester).
      const noSeat = `g4a-a2-apr-unseated-${TS}`
      await seedLoginUser(noSeat, { roles: ['attendance_approver'] })
      const noSeatToken = await loginToken(noSeat)
      const fixture = await launchedRound('noseat')
      expect(fixture.employee).not.toBe(noSeat)

      const refused = await http('POST', actionsPath(fixture.requestId), noSeatToken, { action: 'approve' })
      expect(refused.status, refused.text).toBe(403)
      expect(refused.json).toEqual({
        ok: false,
        error: { code: 'APPROVAL_ASSIGNMENT_REQUIRED', message: 'Approval assignment not found for actor' },
      })
      const rejectTry = await http('POST', actionsPath(fixture.requestId), noSeatToken, { action: 'reject', comment: 'x' })
      expect(rejectTry.status).toBe(403)
      expect(rejectTry.json?.error?.code).toBe('APPROVAL_ASSIGNMENT_REQUIRED')
      expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['pending'])
      const records = await pool().query<{ action: string; actor_id: string }>(
        'SELECT action, actor_id FROM approval_records WHERE instance_id = $1 ORDER BY occurred_at, id',
        [fixture.roundInstanceId],
      )
      expect(records.rows).toEqual([{ action: 'created', actor_id: fixture.employee }])

      // No round on the document ⇒ the entry's 404 (nothing to act on), byte-identical to a
      // never-existing id.
      const bareLeave = await seedApprovedLeave({ documentRequesterId: fixture.employee })
      const noRound = await http('POST', actionsPath(bareLeave.requestId), noSeatToken, { action: 'approve' })
      const absent = await http('POST', actionsPath(randomUUID()), noSeatToken, { action: 'approve' })
      expect(noRound.status).toBe(404)
      expect(noRound.text).toBe(NOT_FOUND_BODY)
      expect(absent.text).toBe(NOT_FOUND_BODY)
    })

    it('only approve / reject are accepted on the actions route: transfer / add_sign / reduce_sign / revoke / comment / handle / return are 400 VALIDATION_ERROR before any lookup, and the round is untouched', async () => {
      await grantAttendanceApproverRole(approverId)
      const approverToken = await loginToken(approverId)
      const fixture = await launchedRound('verbs')
      for (const action of ['transfer', 'add_sign', 'reduce_sign', 'revoke', 'comment', 'handle', 'return']) {
        const response = await http('POST', actionsPath(fixture.requestId), approverToken, {
          action,
          targetUserId: approverId,
          comment: 'x',
        })
        expect(response.status, `${action}: ${response.text}`).toBe(400)
        expect(response.json?.error?.code).toBe('VALIDATION_ERROR')
      }
      expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['pending'])
      const records = await pool().query<{ action: string }>(
        `SELECT action FROM approval_records WHERE instance_id = $1 ORDER BY occurred_at, id`,
        [fixture.roundInstanceId],
      )
      expect(records.rows.map((row) => row.action)).toEqual(['created'])
    })

    it('requester withdraw (real employee token, attendance:write): the round is withdrawn (V4) through the engine\'s revoke, and I3 then lets the SAME leave be launched again', async () => {
      const fixture = await launchedRound('withdraw')
      const withdrawn = await http('POST', withdrawPath(fixture.requestId), fixture.employeeToken, {})
      expect(withdrawn.status, withdrawn.text).toBe(200)
      expect(withdrawn.json).toEqual({
        ok: true,
        data: { requestId: fixture.requestId, roundId: fixture.roundId, outcome: 'withdrawn', status: 'cancellation_withdrawn' },
      })
      const summary = await http('GET', entryPath(fixture.requestId), fixture.employeeToken)
      expect(summary.json.data.round).toMatchObject({
        roundId: fixture.roundId,
        outcome: 'withdrawn',
        status: 'cancellation_withdrawn',
        closedBySystem: false,
        canWithdraw: false,
        withdrawBlockedReason: 'INVALID_STATUS_TRANSITION',
      })
      const engine = await pool().query<{ status: string }>('SELECT status FROM approval_instances WHERE id = $1', [fixture.roundInstanceId])
      expect(engine.rows[0]?.status).toBe('revoked')
      const revokeRecord = await pool().query<{ actor_id: string }>(
        `SELECT actor_id FROM approval_records WHERE instance_id = $1 AND action = 'revoke'`,
        [fixture.roundInstanceId],
      )
      expect(revokeRecord.rows).toEqual([{ actor_id: fixture.employee }])

      // A second withdraw on the finished round: the engine's own terminal answer, passed through.
      const again = await http('POST', withdrawPath(fixture.requestId), fixture.employeeToken, {})
      expect(again.status, again.text).toBe(409)
      expect(again.json?.error?.code).toBe('INVALID_STATUS_TRANSITION')

      const relaunch = await http('POST', entryPath(fixture.requestId), fixture.employeeToken, {})
      expect(relaunch.status, relaunch.text).toBe(201)
      expect(relaunch.json.data.round.roundId).not.toBe(fixture.roundId)
      expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['withdrawn', 'pending'])
    })

    it('withdraw by anyone but the leave\'s own user is refused: a participant who may read (the approver) gets the engine\'s revoke-refusal code at the route; an outsider gets the entry\'s 404; the round is untouched', async () => {
      const fixture = await launchedRound('wd-other')
      const approverToken = await loginToken(approverId)
      const byApprover = await http('POST', withdrawPath(fixture.requestId), approverToken, {})
      expect(byApprover.status, byApprover.text).toBe(403)
      expect(byApprover.json).toEqual({
        ok: false,
        error: { code: 'APPROVAL_REVOKE_FORBIDDEN', message: 'Only the requester can revoke this approval' },
      })
      const outsider = `g4a-a2-wd-out-${TS}`
      await seedLoginUser(outsider, { roles: ['attendance_employee'] })
      const byOutsider = await http('POST', withdrawPath(fixture.requestId), await loginToken(outsider), {})
      expect(byOutsider.status).toBe(404)
      expect(byOutsider.text).toBe(NOT_FOUND_BODY)
      expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['pending'])
    })

    it('without attendance:write, the leave\'s own user is refused at the withdraw route by the plugin guard (exact body) and the round is untouched; with attendance:write added, the same person withdraws', async () => {
      const readOnly = `g4a-a2-wd-ro-${TS}`
      await seedScopedAttendanceUser(readOnly, ['attendance:read'])
      const token = await loginToken(readOnly)
      const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: readOnly })
      // Opened in-process: this principal cannot launch (P-10 (c)); the withdraw route is what is measured.
      const round = await service().createCancelRoundInstance(documentId, { userId: readOnly })
      createdApprovalIds.add(round.id)
      const refused = await http('POST', withdrawPath(requestId), token, {})
      expect(refused.status).toBe(403)
      expect(refused.text).toBe(PLUGIN_FORBIDDEN_BODY)
      expect((await roundsFor(documentId)).map((row) => row.outcome)).toEqual(['pending'])

      await seedScopedAttendanceUser(readOnly, ['attendance:read', 'attendance:write'])
      const withdrawn = await http('POST', withdrawPath(requestId), token, {})
      expect(withdrawn.status, withdrawn.text).toBe(200)
      expect((await roundsFor(documentId)).map((row) => row.outcome)).toEqual(['withdrawn'])
    })

    it('withdraw route-level requester witness (constructed shape, defence in depth): on a round whose engine requester is the snapshot requester but whose leave belongs to someone else, the snapshot requester is refused at the ROUTE — the engine alone would accept', async () => {
      // Same constructed shape as the phase A launch witness: the plugin's own writers never produce
      // it. The round is created IN-PROCESS by the creation path, which keys on the snapshot requester
      // and accepts; the engine's revoke gate compares against that same id and would accept too, so
      // the route's leave-owner check is the only thing that refuses here.
      const proxy = `g4a-a2-proxy-${TS}`
      const owner = `g4a-a2-owner-${TS}`
      await seedLoginUser(proxy, { roles: ['attendance_employee'] })
      await seedLoginUser(owner, { roles: ['attendance_employee'] })
      const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: proxy, leaveUserId: owner })
      const round = await service().createCancelRoundInstance(documentId, { userId: proxy })
      createdApprovalIds.add(round.id)
      const withdraw = await http('POST', withdrawPath(requestId), await loginToken(proxy), {})
      expect(withdraw.status, withdraw.text).toBe(403)
      expect(withdraw.json?.error?.code).toBe('APPROVAL_REVOKE_FORBIDDEN')
      expect((await roundsFor(documentId)).map((row) => row.outcome)).toEqual(['pending'])
    })

    it('the flag gates ONLY the launch: rounds opened while it was ON can still be approved by their seat holder and withdrawn by their requester after it is switched OFF; only a new launch is refused', async () => {
      await grantAttendanceApproverRole(approverId)
      const approverToken = await loginToken(approverId)
      const toApprove = await launchedRound('scope-apr')
      const toWithdraw = await launchedRound('scope-wd')
      const stub = bindCancellationPort(async () => cancelledResponse)
      try {
        delete process.env[ENTRY_FLAG]
        const approved = await http('POST', actionsPath(toApprove.requestId), approverToken, { action: 'approve' })
        expect(approved.status, approved.text).toBe(200)
        expect(approved.json.data).toMatchObject({ roundId: toApprove.roundId, outcome: 'applied' })
        expect(stub.calls).toHaveLength(1)

        const withdrawn = await http('POST', withdrawPath(toWithdraw.requestId), toWithdraw.employeeToken, {})
        expect(withdrawn.status, withdrawn.text).toBe(200)
        expect(withdrawn.json.data).toMatchObject({ roundId: toWithdraw.roundId, outcome: 'withdrawn' })

        // With the round withdrawn, I3 would let the same leave launch again — the flag is what refuses.
        const relaunch = await http('POST', entryPath(toWithdraw.requestId), toWithdraw.employeeToken, {})
        expect(relaunch.status, relaunch.text).toBe(404)
        expect(relaunch.text).toBe(NOT_FOUND_BODY)
        const summary = await http('GET', entryPath(toWithdraw.requestId), toWithdraw.employeeToken)
        expect(summary.status).toBe(200)
        expect(summary.json.data.entryEnabled).toBe(false)
      } finally {
        process.env[ENTRY_FLAG] = 'true'
        stub.stop()
      }
      expect((await roundsFor(toApprove.documentId)).map((row) => row.outcome)).toEqual(['applied'])
      expect((await roundsFor(toWithdraw.documentId)).map((row) => row.outcome)).toEqual(['withdrawn'])
    })

    it('withdraw on the requester\'s own approved leave that has NO round: the entry\'s 404, byte-identical to a never-existing id (not a 500)', async () => {
      const employee = `g4a-a2-wd-none-${TS}`
      await seedLoginUser(employee, { roles: ['attendance_employee'] })
      const token = await loginToken(employee)
      const { documentId, requestId } = await seedApprovedLeave({ documentRequesterId: employee })
      // The requester can read the leave (the summary answers 200, no round) — so the 404 below is the
      // no-round branch, not the visibility one.
      const read = await http('GET', entryPath(requestId), token)
      expect(read.status, read.text).toBe(200)
      expect(read.json.data.round).toBeNull()
      const noRound = await http('POST', withdrawPath(requestId), token, {})
      const absent = await http('POST', withdrawPath(randomUUID()), token, {})
      expect(noRound.status, noRound.text).toBe(404)
      expect(noRound.text).toBe(NOT_FOUND_BODY)
      expect(noRound.text).toBe(absent.text)
      expect(await roundsFor(documentId)).toHaveLength(0)
    })

    it('identity comes from the authenticated token: with no Authorization header, a user-id header does not reach the actions or withdraw route (401), and the round is untouched', async () => {
      const fixture = await launchedRound('noauth')
      for (const [pathName, body] of [
        [actionsPath(fixture.requestId), { action: 'approve' }],
        [withdrawPath(fixture.requestId), {}],
      ] as const) {
        const response = await fetch(`${baseUrl}${pathName}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': pathName.endsWith('/actions') ? approverId : fixture.employee },
          body: JSON.stringify(body),
        })
        expect(response.status).toBe(401)
      }
      expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['pending'])
    })

    it('end to end with NO stand-in: a leave created and approved through the real plugin routes, launched by its employee, approved on the attendance side by the seated attendance_approver — the real W4 boundary cancels the leave', async () => {
      const employee = `g4a-a2-e2e-${TS}`
      const approver = `g4a-a2-e2e-apr-${TS}`
      const attendanceAdmin = `g4a-a2-e2e-adm-${TS}`
      await seedLoginUser(employee, { roles: ['attendance_employee'] })
      await seedLoginUser(approver, { roles: ['attendance_approver'] })
      await seedLoginUser(attendanceAdmin, { roles: ['admin'], admin: true })
      const employeeToken = await loginToken(employee)
      const approverToken = await loginToken(approver)

      const leaveType = await http('POST', '/api/attendance/leave-types', await loginToken(attendanceAdmin), {
        code: `g4a2e${TS}`.slice(0, 20),
        name: `G4A2 E2E ${TS}`,
        paid: false,
        requiresApproval: true,
      })
      expect(leaveType.status, leaveType.text).toBe(201)
      const leaveTypeId = leaveType.json?.data?.id as string
      expect(typeof leaveTypeId).toBe('string')
      createdLeaveTypeIds.add(leaveTypeId)

      const create = await http('POST', '/api/attendance/requests', employeeToken, {
        workDate: '2031-03-12',
        requestType: 'leave',
        leaveTypeId,
        minutes: 120,
      })
      expect(create.status, create.text).toBe(201)
      const requestId = create.json?.data?.request?.id as string
      createdRequestIds.add(requestId)
      const approve = await http('POST', `/api/attendance/requests/${requestId}/approve`, approverToken, { comment: 'ok' })
      expect(approve.status, approve.text).toBe(200)
      const original = await pool().query<{ status: string; request_type: string; approval_instance_id: string }>(
        'SELECT status, request_type, approval_instance_id FROM attendance_requests WHERE id = $1',
        [requestId],
      )
      expect(original.rows[0]).toMatchObject({ status: 'approved', request_type: 'leave' })
      const documentId = original.rows[0].approval_instance_id
      createdApprovalIds.add(documentId)

      const launch = await http('POST', entryPath(requestId), employeeToken, {})
      expect(launch.status, launch.text).toBe(201)
      const roundInstanceId = launch.json.data.round.engineInstanceId as string
      createdApprovalIds.add(roundInstanceId)
      const seats = await pool().query<{ assignee_id: string }>(
        'SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE',
        [roundInstanceId],
      )
      expect(seats.rows.map((row) => row.assignee_id)).toEqual([approver])

      const decided = await http('POST', actionsPath(requestId), approverToken, { action: 'approve' })
      expect(decided.status, decided.text).toBe(200)
      expect(decided.json.data).toEqual({
        requestId,
        roundId: launch.json.data.round.roundId,
        outcome: 'applied',
        status: 'leave_cancelled',
      })
      const read = await http('GET', entryPath(requestId), employeeToken)
      expect(read.json.data.round).toMatchObject({ outcome: 'applied', status: 'leave_cancelled', closedBySystem: false })
      // An unpaid leave type holds no balance lots, so the real boundary reports the C-2 shape with a
      // zero reversal; the balance-bearing shape is pinned by the stand-in approve case above.
      const outcome = read.json.data.round.cancellationOutcome
      expect(outcome).toEqual({
        status: 'cancelled',
        reversal: { reversed: 0, lots: 0, unrecoverableExpired: 0, alreadyReversed: false },
      })
      // Cross-read of the same projection on the approval side (fixture token of the seated approver).
      const approvalSide = await http('GET', `/api/approvals/${roundInstanceId}`, await fixtureAdminToken(approver))
      expect(approvalSide.status, approvalSide.text).toBe(200)
      expect(approvalSide.json.cancellationOutcome).toEqual(outcome)

      const after = await pool().query<{ status: string }>('SELECT status FROM attendance_requests WHERE id = $1', [requestId])
      expect(after.rows[0]?.status).toBe('cancelled')
      expect((await roundsFor(documentId)).map((row) => row.outcome)).toEqual(['applied'])
    })

    it('the launch records the requester\'s display name on the round\'s created audit row (not the bare id)', async () => {
      const employee = `g4a-a2-name-${TS}`
      const displayName = `G4A 显示名 ${TS}`
      await seedLoginUser(employee, { roles: ['attendance_employee'] })
      await pool().query('UPDATE users SET name = $2 WHERE id = $1', [employee, displayName])
      const token = await loginToken(employee)
      const { requestId } = await seedApprovedLeave({ documentRequesterId: employee })
      const launch = await http('POST', entryPath(requestId), token, {})
      expect(launch.status, launch.text).toBe(201)
      const created = await pool().query<{ actor_id: string; actor_name: string }>(
        `SELECT actor_id, actor_name FROM approval_records WHERE instance_id = $1 AND action = 'created'`,
        [launch.json.data.round.engineInstanceId],
      )
      expect(created.rows).toEqual([{ actor_id: employee, actor_name: displayName }])
    })

    describe('phase C (backend): P-5 values-free delivery status on the summary', () => {
      it('P-5 (iii): the summary lists THIS round\'s own deliveries with status / channel type / attempts / timestamps only — no id, recipient or error text — and a failed delivery changes nothing about the round: outcome, engine status and seats are untouched and the seat holder still approves', async () => {
        await grantAttendanceApproverRole(approverId)
        const approverToken = await loginToken(approverId)
        const fixture = await launchedRound('p5')
        const q = (text: string, values?: unknown[]) => pool().query(text, values)
        const engineRow = await pool().query<{ current_node_key: string; org_id: string | null }>(
          'SELECT current_node_key, org_id FROM approval_instances WHERE id = $1',
          [fixture.roundInstanceId],
        )
        const nodeKey = engineRow.rows[0].current_node_key
        const orgId = engineRow.rows[0].org_id ?? 'default'
        const seatRows = async () =>
          (
            await pool().query<{ id: string; assignee_id: string; is_active: boolean; node_key: string }>(
              'SELECT id::text AS id, assignee_id, is_active, node_key FROM approval_assignments WHERE instance_id = $1 ORDER BY id',
              [fixture.roundInstanceId],
            )
          ).rows
        const engineStatus = async () =>
          (await pool().query<{ status: string }>('SELECT status FROM approval_instances WHERE id = $1', [fixture.roundInstanceId]))
            .rows[0]?.status
        const seatsBefore = await seatRows()
        expect(seatsBefore.filter((row) => row.is_active).map((row) => row.assignee_id)).toEqual([approverId])

        // Values that must never reach the summary.
        const SECRET_DT_USER = `dt-recipient-${TS}`
        const SECRET_ERROR = `provider refused: token=secret-${TS}`
        const SECRET_TASK = `ext-task-${TS}`
        const SECRET_TODO_ERROR = `todo provider refused: secret-${TS}`
        const SECRET_TODO_TASK = `ext-todo-${TS}`

        // Two approval-card rows through the card ledger's own writers: one failed, one sent.
        const failedCard = await insertDingTalkApprovalCardDelivery(q, {
          instanceId: fixture.roundInstanceId,
          nodeKey,
          recipientUserId: approverId,
          recipientDingTalkUserId: SECRET_DT_USER,
          deliveryKind: 'work_notice_action_card',
        })
        expect(await markDingTalkApprovalCardDeliverySendFailed(q, failedCard.id, SECRET_ERROR)).not.toBeNull()
        const sentCard = await insertDingTalkApprovalCardDelivery(q, {
          instanceId: fixture.roundInstanceId,
          nodeKey,
          recipientUserId: approverId,
          recipientDingTalkUserId: SECRET_DT_USER,
          deliveryKind: 'interactive_card',
        })
        expect(await markDingTalkApprovalCardDeliverySent(q, sentCard.id, SECRET_TASK)).not.toBeNull()
        // Todo-mirror rows (ledger rows as its worker leaves them): failed after three attempts; and a
        // row retired before any attempt, which is not a delivery and must not be listed.
        const todoFailed = await pool().query<{ id: string }>(
          `INSERT INTO dingtalk_todo_mirrors
             (org_id, instance_id, node_key, recipient_user_id, recipient_union_id, source_key, dingtalk_task_id,
              status, attempt_count, last_attempt_at, last_error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', 3, now() + interval '2 seconds', $8,
                   now() + interval '1 second', now() + interval '2 seconds')
           RETURNING id::text AS id`,
          [orgId, fixture.roundInstanceId, nodeKey, approverId, SECRET_DT_USER, `g4c-todo-failed-${TS}`, SECRET_TODO_TASK, SECRET_TODO_ERROR],
        )
        await pool().query(
          `INSERT INTO dingtalk_todo_mirrors
             (org_id, instance_id, node_key, recipient_user_id, source_key, status, attempt_count, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'superseded', 0, now() + interval '3 seconds', now() + interval '3 seconds')`,
          [orgId, fixture.roundInstanceId, nodeKey, approverId, `g4c-todo-retired-${TS}`],
        )
        // A delivery of the ORIGINAL document (not of the round) is not this round's and is not listed.
        const originalCard = await insertDingTalkApprovalCardDelivery(q, {
          instanceId: fixture.documentId,
          nodeKey: 'approval_a',
          recipientUserId: approverId,
          recipientDingTalkUserId: SECRET_DT_USER,
          deliveryKind: 'work_notice_action_card',
        })
        expect(await markDingTalkApprovalCardDeliverySendFailed(q, originalCard.id, SECRET_ERROR)).not.toBeNull()

        const read = await http('GET', entryPath(fixture.requestId), fixture.employeeToken)
        expect(read.status, read.text).toBe(200)
        const deliveries = read.json.data.round.deliveries as Array<Record<string, unknown>>
        expect(deliveries.map((d) => ({ channelType: d.channelType, status: d.status, attempts: d.attempts }))).toEqual([
          { channelType: 'dingtalk_approval_card', status: 'failed', attempts: 1 },
          { channelType: 'dingtalk_approval_card', status: 'delivered', attempts: 1 },
          { channelType: 'dingtalk_todo', status: 'failed', attempts: 3 },
        ])
        for (const delivery of deliveries) {
          expect(Object.keys(delivery).sort()).toEqual(['attempts', 'channelType', 'createdAt', 'lastAttemptAt', 'status', 'updatedAt'])
          expect(Number.isNaN(Date.parse(String(delivery.createdAt)))).toBe(false)
          expect(Number.isNaN(Date.parse(String(delivery.updatedAt)))).toBe(false)
          expect(Number.isNaN(Date.parse(String(delivery.lastAttemptAt)))).toBe(false)
        }
        for (const secret of [
          SECRET_DT_USER, SECRET_ERROR, SECRET_TASK, SECRET_TODO_ERROR, SECRET_TODO_TASK,
          failedCard.id, sentCard.id, originalCard.id, todoFailed.rows[0].id, approverId, nodeKey,
        ]) {
          expect(read.text.includes(secret), `summary leaks ${secret}`).toBe(false)
        }
        // Same I7-gated read for another reader of the original document: the same list.
        const approverRead = await http('GET', entryPath(fixture.requestId), approverToken)
        expect(approverRead.status, approverRead.text).toBe(200)
        expect(approverRead.json.data.round.deliveries).toEqual(deliveries)

        // The invariant: delivery failures moved nothing.
        expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['pending'])
        expect(await engineStatus()).toBe('pending')
        expect(await seatRows()).toEqual(seatsBefore)
        expect(read.json.data.round).toMatchObject({ outcome: 'pending', status: 'cancellation_pending_approval', canWithdraw: true })

        const stub = bindCancellationPort(async () => cancelledResponse)
        try {
          const approved = await http('POST', actionsPath(fixture.requestId), approverToken, { action: 'approve' })
          expect(approved.status, approved.text).toBe(200)
          expect(approved.json.data).toMatchObject({ roundId: fixture.roundId, outcome: 'applied' })
        } finally {
          stub.stop()
        }
        const after = await http('GET', entryPath(fixture.requestId), fixture.employeeToken)
        expect(after.json.data.round.outcome).toBe('applied')
        expect(after.json.data.round.deliveries.map((d: Record<string, unknown>) => d.status)).toEqual(['failed', 'delivered', 'failed'])
      })

      it('P-5 invariant through the todo mirror\'s OWN service and worker: the round\'s seat is mirrored by the consumer, the worker\'s send attempt ends in a terminal non-delivery, the summary lists it as failed — and the round outcome, the engine status and the seats are untouched; the seat holder still approves', async () => {
        await grantAttendanceApproverRole(approverId)
        const approverToken = await loginToken(approverId)
        const fixture = await launchedRound('p5-mirror')
        const q = (text: string, values?: unknown[]) => pool().query(text, values)
        const seatRows = async () =>
          (
            await pool().query<{ id: string; assignee_id: string; is_active: boolean; node_key: string; entry_epoch: number | null }>(
              'SELECT id::text AS id, assignee_id, is_active, node_key, entry_epoch FROM approval_assignments WHERE instance_id = $1 ORDER BY id',
              [fixture.roundInstanceId],
            )
          ).rows
        const engineStatus = async () =>
          (await pool().query<{ status: string }>('SELECT status FROM approval_instances WHERE id = $1', [fixture.roundInstanceId]))
            .rows[0]?.status
        const seatsBefore = await seatRows()
        const activeSeats = seatsBefore.filter((row) => row.is_active)
        expect(activeSeats.map((row) => row.assignee_id)).toEqual([approverId])

        // The consumer leg: the round's own task_created, built from its active seat by the producer's
        // builder, through the mirror's service entry. The flag is handed to the call only
        // (`deps.env`), so the server's own mirror stays OFF for every other case.
        const instance = (
          await pool().query<{
            id: string
            request_no: string | null
            template_id: string | null
            template_version_id: string | null
            published_definition_id: string | null
            business_key: string | null
            workflow_key: string | null
            requester_snapshot: unknown
          }>(
            `SELECT id, request_no, template_id::text AS template_id, template_version_id::text AS template_version_id,
                    published_definition_id::text AS published_definition_id, business_key, workflow_key, requester_snapshot
               FROM approval_instances WHERE id = $1`,
            [fixture.roundInstanceId],
          )
        ).rows[0]
        const event = buildApprovalTaskCreatedEvent({
          instance,
          task: {
            nodeKey: activeSeats[0].node_key,
            entryEpoch: activeSeats[0].entry_epoch,
            assigneeUserId: approverId,
            sourceStep: 0,
          },
        })
        const applied = await applyTodoMirrorTaskCreated(q, event, { env: { DINGTALK_TODO_MIRROR_ENABLED: 'true' } })
        expect(applied).toMatchObject({ handled: true, insertedRows: 1 })

        // The worker leg: the real worker on the real ledger. Every network seam is a fake that throws,
        // so nothing can leave the process; `maxAttempts: 1` makes the first failed attempt terminal.
        const noNetwork = async (): Promise<never> => {
          throw new Error('no network in this suite')
        }
        // The worker's clock is FIXED one minute ahead. The consumer's row takes `next_attempt_at` from
        // the database's `now()` (microseconds), while the worker's due check compares it with its own
        // clock as a millisecond ISO string; with the real clock, a claim in the same millisecond as
        // the insert finds the row not yet due and claims nothing. Fixed (not moving), so the round's
        // own row can be shown below to carry exactly this worker's claim instant.
        const workerNow = new Date(Date.now() + 60_000)
        const worker = new DingTalkTodoMirrorWorker({
          query: ((text: string, values?: unknown[]) => pool().query(text, values)) as unknown as TodoMirrorWorkerQuery,
          maxAttempts: 1,
          now: () => workerNow,
          readConfig: noNetwork,
          fetchAccessToken: noNetwork,
          resolveOperatorUnionId: noNetwork,
          createTodoTask: noNetwork,
          completeTodoTask: noNetwork,
        })
        // The worker claims from the WHOLE ledger, not from this round. Before it runs, no live row
        // (the claim's statuses) may exist outside this round's instance, so the throwing fakes can
        // only ever reach this round's row and the batch counters below are this row's alone.
        const otherLive = await pool().query<{ n: number }>(
          `SELECT count(*)::int AS n FROM dingtalk_todo_mirrors
            WHERE instance_id <> $1 AND status IN ('pending', 'completing', 'sending')`,
          [fixture.roundInstanceId],
        )
        expect(otherLive.rows[0].n, 'a live todo-mirror row outside this round exists; the worker would claim it too').toBe(0)
        const run = await worker.runBatch()
        expect(run.claimed).toBe(1)
        // The approver has no DingTalk binding, so the attempt ends before any send: `failed` when the
        // org has no active DingTalk integration (retry budget exhausted), `skipped` when it has one
        // (recipient not bound). Which one depends on directory rows other suites may leave in the
        // shared database; the ledger row must be one of the two, attempted once, and never sent.
        const ledger = await pool().query<{
          status: string
          attempt_count: number
          dingtalk_task_id: string | null
          last_attempt_at: Date | null
        }>(
          'SELECT status, attempt_count, dingtalk_task_id, last_attempt_at FROM dingtalk_todo_mirrors WHERE instance_id = $1',
          [fixture.roundInstanceId],
        )
        expect(ledger.rows).toHaveLength(1)
        expect(['failed', 'skipped']).toContain(ledger.rows[0].status)
        expect(ledger.rows[0].attempt_count).toBe(1)
        expect(ledger.rows[0].dingtalk_task_id).toBeNull()
        // This worker's claim, on this round's row.
        expect(ledger.rows[0].last_attempt_at?.toISOString()).toBe(workerNow.toISOString())
        expect(run.failed + run.skipped).toBe(1)

        const read = await http('GET', entryPath(fixture.requestId), fixture.employeeToken)
        expect(read.status, read.text).toBe(200)
        expect(
          (read.json.data.round.deliveries as Array<Record<string, unknown>>).map((d) => ({
            channelType: d.channelType,
            status: d.status,
            attempts: d.attempts,
          })),
        ).toEqual([{ channelType: 'dingtalk_todo', status: 'failed', attempts: 1 }])

        // The invariant: the mirror's failure moved nothing.
        expect((await roundsFor(fixture.documentId)).map((row) => row.outcome)).toEqual(['pending'])
        expect(await engineStatus()).toBe('pending')
        expect(await seatRows()).toEqual(seatsBefore)
        expect(read.json.data.round).toMatchObject({ outcome: 'pending', status: 'cancellation_pending_approval', canWithdraw: true })

        const stub = bindCancellationPort(async () => cancelledResponse)
        try {
          const approved = await http('POST', actionsPath(fixture.requestId), approverToken, { action: 'approve' })
          expect(approved.status, approved.text).toBe(200)
          expect(approved.json.data).toMatchObject({ roundId: fixture.roundId, outcome: 'applied' })
        } finally {
          stub.stop()
        }
      })
    })

    describe('phase C (backend): P-11 — the round in the todo center, the seat-arm fence, the count refresh', () => {
      type Push = { room: string; event: string; payload: any }
      /** Records every realtime push the server's collab service makes, passing each one through. */
      function recordPushes(): { pushes: Push[]; stop: () => void } {
        const injector = (server as unknown as { injector: { get: (id: unknown) => any } }).injector
        const collab = injector.get(ICollabService)
        const original = collab.broadcastTo
        const pushes: Push[] = []
        collab.broadcastTo = (room: string, event: string, payload: unknown) => {
          pushes.push({ room, event, payload })
          return original.call(collab, room, event, payload)
        }
        return { pushes, stop: () => { collab.broadcastTo = original } }
      }
      const todoPushesFor = (pushes: Push[], userId: string) =>
        pushes.filter((push) => push.room === buildAuthenticatedUserRoom(userId) && push.event === 'todo:counts-updated')

      it('P-11 (a)(b): the round\'s seat is a todo item (source approval, workflowKey approval.cancel-round, href to the ORIGINAL leave request) and count == list; the seat holder\'s todo count is pushed after the launch, after the attendance-side approve and after the requester\'s withdraw', async () => {
        await grantAttendanceApproverRole(approverId)
        // The todo routes sit behind approvals:read (catalogued, granted to nobody by default); the
        // fixture approver gets it here, with the permission cache cleared for the grant to be read.
        await pool().query(
          `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`,
          [approverId],
        )
        invalidateUserPerms(approverId)
        const approverToken = await loginToken(approverId)
        const recorder = recordPushes()
        try {
          const fixture = await launchedRound('todo')
          const toWithdraw = await launchedRound('todo-wd')
          // Launch ⇒ a push to the new seat holder (and to the requester).
          expect(todoPushesFor(recorder.pushes, approverId).length).toBeGreaterThanOrEqual(2)
          expect(todoPushesFor(recorder.pushes, fixture.employee).length).toBeGreaterThanOrEqual(1)

          const items = await http('GET', '/api/todo/items', approverToken)
          const count = await http('GET', '/api/todo/count', approverToken)
          expect(items.status, items.text).toBe(200)
          expect(count.status, count.text).toBe(200)
          expect(items.json.sources).toEqual({ approval: 'ok' })
          expect(count.json.count).toBe(items.json.items.length)
          const item = items.json.items.find((entry: { id: string }) => entry.id === fixture.roundInstanceId)
          expect(item).toEqual({
            source: 'approval',
            id: fixture.roundInstanceId,
            title: expect.stringContaining('撤销'),
            href: `/attendance?section=attendance-overview-requests&requestId=${fixture.requestId}`,
            updatedAt: expect.any(String),
            actionable: true,
            workflowKey: 'approval.cancel-round',
          })
          expect(items.json.items.filter((entry: { id: string }) => entry.id === fixture.roundInstanceId)).toHaveLength(1)
          // The latest push to the seat holder carried the same number the count route answers.
          const lastLaunchPush = todoPushesFor(recorder.pushes, approverId).at(-1)
          expect(lastLaunchPush?.payload?.count).toBe(count.json.count)

          const before = count.json.count as number
          recorder.pushes.length = 0
          const stub = bindCancellationPort(async () => cancelledResponse)
          try {
            const approved = await http('POST', actionsPath(fixture.requestId), approverToken, { action: 'approve' })
            expect(approved.status, approved.text).toBe(200)
          } finally {
            stub.stop()
          }
          const afterApprovePush = todoPushesFor(recorder.pushes, approverId).at(-1)
          expect(afterApprovePush?.payload?.count).toBe(before - 1)
          const itemsAfter = await http('GET', '/api/todo/items', approverToken)
          expect(itemsAfter.json.items.some((entry: { id: string }) => entry.id === fixture.roundInstanceId)).toBe(false)
          expect((await http('GET', '/api/todo/count', approverToken)).json.count).toBe(before - 1)

          recorder.pushes.length = 0
          const withdrawn = await http('POST', withdrawPath(toWithdraw.requestId), toWithdraw.employeeToken, {})
          expect(withdrawn.status, withdrawn.text).toBe(200)
          // The withdraw deactivates the approver's seat: the push reaches the seat holder, not only the caller.
          const afterWithdrawPush = todoPushesFor(recorder.pushes, approverId).at(-1)
          expect(afterWithdrawPush?.payload?.count).toBe(before - 2)
          expect((await http('GET', '/api/todo/count', approverToken)).json.count).toBe(before - 2)
        } finally {
          recorder.stop()
          await pool().query(
            `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:read'`,
            [approverId],
          )
          invalidateUserPerms(approverId)
        }
      })

      it('P-11 count refresh carries the ACTOR\'s role claims, as the approval side does: a requester and an approver whose users.role is admin, each seeing an unrelated role-seated pending item, are pushed the same todo count their own GET /api/todo/count answers — after the launch, the attendance-side approve and the withdraw', async () => {
        await grantAttendanceApproverRole(approverId)
        const requester = `g4c-roles-req-${TS}`
        await seedLoginUser(requester, { roles: ['attendance_employee'] })
        // An unrelated pending item whose ONLY active seat is the role arm `admin` (the shape the
        // attendance fallback queue seats). It is in a viewer's count only when that viewer's `admin`
        // role claim reaches the count.
        const otherRequester = `g4c-roles-other-${TS}`
        await seedLoginUser(otherRequester, { roles: ['attendance_employee'] })
        await grantApprovalWriteForIntegrationActor(otherRequester)
        let other: { id: string }
        try {
          other = await service().createApproval(
            { templateId, formData: { reason: 'g4c role-seated item' } },
            { userId: otherRequester, roles: [] },
          )
        } finally {
          await pool().query(
            `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:write'`,
            [otherRequester],
          )
        }
        createdApprovalIds.add(other.id)
        const otherNode = (
          await pool().query<{ current_node_key: string }>('SELECT current_node_key FROM approval_instances WHERE id = $1', [other.id])
        ).rows[0].current_node_key
        await pool().query('UPDATE approval_assignments SET is_active = FALSE WHERE instance_id = $1', [other.id])
        await pool().query(
          `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, is_active)
           VALUES ($1, 'role', 'admin', $2, TRUE)`,
          [other.id, otherNode],
        )

        const viewers = [approverId, requester]
        const recorder = recordPushes()
        try {
          for (const userId of viewers) {
            // The count read's role input is the token's `role` claim (the `users.role` column), so
            // the column is set before logging in. The todo routes sit behind approvals:read.
            await pool().query(`UPDATE users SET role = 'admin' WHERE id = $1`, [userId])
            await pool().query(
              `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`,
              [userId],
            )
            invalidateUserPerms(userId)
          }
          const approverToken = await loginToken(approverId)
          const requesterToken = await loginToken(requester)
          const countOf = async (token: string): Promise<number> => {
            const response = await http('GET', '/api/todo/count', token)
            expect(response.status, response.text).toBe(200)
            return response.json.count as number
          }
          const lastPushedCount = (userId: string) => todoPushesFor(recorder.pushes, userId).at(-1)?.payload?.count
          // Precondition, so the legs below cannot pass vacuously: both viewers' own reads include the
          // role-seated item.
          for (const token of [approverToken, requesterToken]) {
            const items = await http('GET', '/api/todo/items', token)
            expect(items.status, items.text).toBe(200)
            expect(items.json.items.some((entry: { id: string }) => entry.id === other.id)).toBe(true)
          }

          // Leg 1 — launch: the requester acts.
          const toApprove = await seedApprovedLeave({ documentRequesterId: requester })
          recorder.pushes.length = 0
          const launch = await http('POST', entryPath(toApprove.requestId), requesterToken, {})
          expect(launch.status, launch.text).toBe(201)
          expect(todoPushesFor(recorder.pushes, requester)).toHaveLength(1)
          expect(lastPushedCount(requester)).toBe(await countOf(requesterToken))

          // Leg 2 — attendance-side approve: the approver acts on their own seat.
          recorder.pushes.length = 0
          const stub = bindCancellationPort(async () => cancelledResponse)
          try {
            const approved = await http('POST', actionsPath(toApprove.requestId), approverToken, { action: 'approve' })
            expect(approved.status, approved.text).toBe(200)
          } finally {
            stub.stop()
          }
          expect(todoPushesFor(recorder.pushes, approverId)).toHaveLength(1)
          expect(lastPushedCount(approverId)).toBe(await countOf(approverToken))

          // Leg 3 — withdraw: the requester acts on a second leave's round.
          const toWithdraw = await seedApprovedLeave({ documentRequesterId: requester })
          const relaunch = await http('POST', entryPath(toWithdraw.requestId), requesterToken, {})
          expect(relaunch.status, relaunch.text).toBe(201)
          recorder.pushes.length = 0
          const withdrawn = await http('POST', withdrawPath(toWithdraw.requestId), requesterToken, {})
          expect(withdrawn.status, withdrawn.text).toBe(200)
          expect(todoPushesFor(recorder.pushes, requester)).toHaveLength(1)
          expect(lastPushedCount(requester)).toBe(await countOf(requesterToken))
        } finally {
          recorder.stop()
          await pool().query('UPDATE approval_assignments SET is_active = FALSE WHERE instance_id = $1', [other.id])
          for (const userId of viewers) {
            await pool().query(`UPDATE users SET role = 'user' WHERE id = $1`, [userId])
            await pool().query(
              `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:read'`,
              [userId],
            )
            invalidateUserPerms(userId)
          }
        }
      })

      it('P-11 (c), lock §14.1 fence: every seat a launch writes is a person arm (user / role, never source_queue); a creation that would seat any other arm is refused with the registered code before ANY write', async () => {
        const fixture = await launchedRound('fence')
        const arms = await pool().query<{ assignment_type: string }>(
          'SELECT DISTINCT assignment_type FROM approval_assignments WHERE instance_id = $1',
          [fixture.roundInstanceId],
        )
        expect(arms.rows.length).toBeGreaterThan(0)
        expect(arms.rows.every((row) => row.assignment_type === 'user' || row.assignment_type === 'role')).toBe(true)

        // A fence witness: the seed graph cannot produce a queue seat, so the executor's answer is
        // rewritten for ONE call to carry one; the creation path must refuse before writing anything.
        const employee = `g4a-c-fence-${TS}`
        await seedLoginUser(employee, { roles: ['attendance_employee'] })
        const { documentId } = await seedApprovedLeave({ documentRequesterId: employee })
        const original = ApprovalGraphExecutor.prototype.resolveInitialState
        const spy = vi.spyOn(ApprovalGraphExecutor.prototype, 'resolveInitialState').mockImplementationOnce(function (
          this: ApprovalGraphExecutor,
          ...args: Parameters<typeof original>
        ) {
          const state = original.apply(this, args)
          return {
            ...state,
            assignments: state.assignments.map((assignment, index) =>
              index === 0 ? { ...assignment, assignmentType: 'source_queue' as unknown as 'user' } : assignment,
            ),
          }
        })
        // The request-number sequence is the creation path's first write, and it is NOT transactional:
        // a refusal placed after `nextval` (or after the first INSERT, which the rollback would hide)
        // still moves it. Its state unchanged across the refused call is what 「before ANY write」 means
        // here; zero rows alone would only show that nothing was left behind.
        const requestNoSequence = async (): Promise<string> =>
          JSON.stringify(
            (await pool().query<{ last_value: string; is_called: boolean }>(
              'SELECT last_value::text AS last_value, is_called FROM approval_request_no_seq',
            )).rows[0],
          )
        const instancesBefore = await pool().query<{ count: string }>('SELECT COUNT(*)::text AS count FROM approval_instances')
        const sequenceBefore = await requestNoSequence()
        try {
          await expect(service().createCancelRoundInstance(documentId, { userId: employee })).rejects.toMatchObject({
            statusCode: 409,
            code: 'CANCEL_ROUND_NO_ELIGIBLE_APPROVER',
          })
          expect(spy).toHaveBeenCalledTimes(1)
        } finally {
          spy.mockRestore()
        }
        expect(await requestNoSequence()).toBe(sequenceBefore)
        expect(await roundsFor(documentId)).toHaveLength(0)
        const instancesAfter = await pool().query<{ count: string }>('SELECT COUNT(*)::text AS count FROM approval_instances')
        expect(instancesAfter.rows[0].count).toBe(instancesBefore.rows[0].count)
        // Positive control on the same document: without the rewrite the same call opens the round —
        // and moves the sequence, so the probe above is live.
        const round = await service().createCancelRoundInstance(documentId, { userId: employee })
        createdApprovalIds.add(round.id)
        expect((await roundsFor(documentId)).map((row) => row.outcome)).toEqual(['pending'])
        expect(await requestNoSequence()).not.toBe(sequenceBefore)
      })
    })
  })
})

