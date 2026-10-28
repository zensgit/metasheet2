import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

type JsonRecord = Record<string, unknown>

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function authToken(baseUrl: string, userId: string, perms = '*:*', roles = 'admin'): Promise<string> {
  if (perms.split(',').some((permission) => ['*:*', 'approvals:*', 'approvals:write'].includes(permission.trim()))) {
    await grantApprovalWriteForIntegrationActor(userId)
  }
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  expect(response.status).toBe(200)
  const payload = await response.json() as { token: string }
  return payload.token
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function buildFormSchema() {
  return {
    fields: [{ id: 'reason', type: 'text', label: '事由', required: true }],
  }
}

function buildUserGraph(assigneeId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_a',
        type: 'approval',
        config: { assigneeType: 'user', assigneeIds: [assigneeId], approvalMode: 'single' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-a', source: 'start', target: 'approval_a' },
      { key: 'edge-a-end', source: 'approval_a', target: 'end' },
    ],
  }
}

function buildRoleGraph(roleId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'approval_role',
        type: 'approval',
        config: { assigneeType: 'role', assigneeIds: [roleId], approvalMode: 'single' },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-role', source: 'start', target: 'approval_role' },
      { key: 'edge-role-end', source: 'approval_role', target: 'end' },
    ],
  }
}

describeIfDatabase('Approval T2-1+2 scoped admins + bulk handover — real DB', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const createdUserIds = new Set<string>()

  const pool = () => poolManager.get()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    try {
      const approvalIds = [...createdApprovalIds]
      const templateIds = [...createdTemplateIds]
      if (approvalIds.length > 0) {
        await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      if (createdUserIds.size > 0) {
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [[...createdUserIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  async function ensureUsers(...ids: string[]): Promise<void> {
    for (const id of ids) {
      createdUserIds.add(id)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active)
         VALUES ($1, $2, $3, 'test', 'user', '[]'::jsonb, TRUE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, updated_at = now()`,
        [id, `${id}@example.test`, id],
      )
    }
  }

  async function publishTemplate(token: string, graph: object, name: string): Promise<string> {
    const create = await jsonRequest(baseUrl, '/api/approval-templates', token, {
      method: 'POST',
      body: {
        key: `bulk-reassign-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name,
        description: 'T2-1+2 bulk reassign integration',
        formSchema: buildFormSchema(),
        approvalGraph: graph,
      },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const template = await create.json() as { id: string }
    createdTemplateIds.add(template.id)
    const publish = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, token, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publish.status, await publish.clone().text()).toBe(200)
    return template.id
  }

  async function startApproval(token: string, templateId: string): Promise<{ id: string; version: number }> {
    const create = await jsonRequest(baseUrl, '/api/approvals', token, {
      method: 'POST',
      body: { templateId, formData: { reason: 'handover' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const approval = await create.json() as { id: string }
    createdApprovalIds.add(approval.id)
    const version = await pool().query<{ version: number }>(
      `SELECT version FROM approval_instances WHERE id = $1`,
      [approval.id],
    )
    expect(version.rows).toHaveLength(1)
    return { id: approval.id, version: version.rows[0].version }
  }

  it('gives approvals:admin-templates a real template-management surface but not process handover', async () => {
    const templateAdmin = await authToken(baseUrl, 'template-admin-only', 'approvals:admin-templates', 'user')
    const create = await jsonRequest(baseUrl, '/api/approval-templates', templateAdmin, {
      method: 'POST',
      body: {
        key: `template-admin-surface-${Date.now()}`,
        name: 'Template admin surface',
        formSchema: buildFormSchema(),
        approvalGraph: buildUserGraph('surface-approver'),
      },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const template = await create.json() as { id: string }
    createdTemplateIds.add(template.id)

    const denied = await jsonRequest(baseUrl, '/api/approvals/admin/reassign', templateAdmin, {
      method: 'POST',
      body: { fromUserId: 'from-user', toUserId: 'to-user', reason: 'not process admin' },
    })
    expect(denied.status).toBe(403)
  })

  it('reassigns active user assignments, bumps version, audits reassign, and reruns as a no-op', async () => {
    await ensureUsers('handover-from', 'handover-to')
    const admin = await authToken(baseUrl, 'handover-admin', 'approvals:admin', 'user')
    const author = await authToken(baseUrl, 'handover-author')
    const requester = await authToken(baseUrl, 'handover-requester')
    const templateId = await publishTemplate(author, buildUserGraph('handover-from'), 'handover-success')
    const approval = await startApproval(requester, templateId)

    const emptyExplicit = await jsonRequest(baseUrl, '/api/approvals/admin/reassign', admin, {
      method: 'POST',
      body: {
        fromUserId: 'handover-from',
        toUserId: 'handover-to',
        instanceIds: [],
        reason: 'empty explicit list must not enumerate everything',
      },
    })
    expect(emptyExplicit.status, await emptyExplicit.clone().text()).toBe(200)
    const emptyExplicitBody = await emptyExplicit.json() as { data: { succeeded: string[]; skipped: unknown[] } }
    expect(emptyExplicitBody.data.succeeded).toEqual([])
    expect(emptyExplicitBody.data.skipped).toEqual([])
    const untouched = await pool().query<{ assignee_id: string; is_active: boolean }>(
      `SELECT assignee_id, is_active
         FROM approval_assignments
        WHERE instance_id = $1
        ORDER BY created_at ASC`,
      [approval.id],
    )
    expect(untouched.rows).toContainEqual({ assignee_id: 'handover-from', is_active: true })

    const first = await jsonRequest(baseUrl, '/api/approvals/admin/reassign', admin, {
      method: 'POST',
      body: {
        fromUserId: 'handover-from',
        toUserId: 'handover-to',
        instanceIds: [approval.id],
        reason: 'employee left',
      },
    })
    expect(first.status, await first.clone().text()).toBe(200)
    const firstBody = await first.json() as { data: { succeeded: string[]; skipped: unknown[] } }
    expect(firstBody.data.succeeded, JSON.stringify(firstBody)).toEqual([approval.id])
    expect(firstBody.data.skipped).toEqual([])

    const state = await pool().query<{
      version: number
      assignee_id: string
      is_active: boolean
      metadata: JsonRecord | null
    }>(
      `SELECT i.version, a.assignee_id, a.is_active, a.metadata
         FROM approval_instances i
         JOIN approval_assignments a ON a.instance_id = i.id
        WHERE i.id = $1
        ORDER BY a.created_at ASC`,
      [approval.id],
    )
    expect(state.rows.some((row) => row.assignee_id === 'handover-from' && row.is_active === false)).toBe(true)
    const target = state.rows.find((row) => row.assignee_id === 'handover-to' && row.is_active === true)
    expect(target?.metadata?.adminReassign).toBe(true)
    expect(target?.metadata?.reassignedFrom).toBe('handover-from')
    expect(state.rows[0].version).toBe(approval.version + 1)

    const audit = await pool().query<{ action: string; actor_id: string; target_user_id: string | null; metadata: JsonRecord }>(
      `SELECT action, actor_id, target_user_id, metadata
         FROM approval_records
        WHERE instance_id = $1 AND action = 'reassign'`,
      [approval.id],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0].actor_id).toBe('handover-admin')
    expect(audit.rows[0].target_user_id).toBe('handover-to')
    expect(audit.rows[0].metadata.fromUserId).toBe('handover-from')

    const rerun = await jsonRequest(baseUrl, '/api/approvals/admin/reassign', admin, {
      method: 'POST',
      body: {
        fromUserId: 'handover-from',
        toUserId: 'handover-to',
        instanceIds: [approval.id],
        reason: 'employee left',
      },
    })
    expect(rerun.status, await rerun.clone().text()).toBe(200)
    const rerunBody = await rerun.json() as { data: { succeeded: string[]; skipped: Array<{ id: string; reason: string }> } }
    expect(rerunBody.data.succeeded).toEqual([])
    expect(rerunBody.data.skipped).toEqual([{ id: approval.id, reason: 'not-assigned' }])
  })

  it('fails closed for invalid target, requester target, and role-typed source assignments', async () => {
    await ensureUsers('guard-from', 'guard-target', 'role-target')
    const admin = await authToken(baseUrl, 'guard-admin', 'approvals:admin', 'user')
    const author = await authToken(baseUrl, 'guard-author')
    const requesterAsTarget = await authToken(baseUrl, 'guard-target')

    const invalid = await jsonRequest(baseUrl, '/api/approvals/admin/reassign', admin, {
      method: 'POST',
      body: { fromUserId: 'guard-from', toUserId: 'missing-target-user', reason: 'invalid target' },
    })
    expect(invalid.status).toBe(400)

    const userTemplate = await publishTemplate(author, buildUserGraph('guard-from'), 'requester-target')
    const requesterTargetApproval = await startApproval(requesterAsTarget, userTemplate)
    const requesterGuard = await jsonRequest(baseUrl, '/api/approvals/admin/reassign', admin, {
      method: 'POST',
      body: {
        fromUserId: 'guard-from',
        toUserId: 'guard-target',
        instanceIds: [requesterTargetApproval.id],
        reason: 'segregation guard',
      },
    })
    expect(requesterGuard.status, await requesterGuard.clone().text()).toBe(200)
    const requesterGuardBody = await requesterGuard.json() as { data: { skipped: Array<{ id: string; reason: string }> } }
    expect(requesterGuardBody.data.skipped).toEqual([{ id: requesterTargetApproval.id, reason: 'target-is-requester' }])

    const roleTemplate = await publishTemplate(author, buildRoleGraph('role-reviewer'), 'role-not-user')
    const roleApproval = await startApproval(await authToken(baseUrl, 'role-requester'), roleTemplate)
    const roleGuard = await jsonRequest(baseUrl, '/api/approvals/admin/reassign', admin, {
      method: 'POST',
      body: {
        fromUserId: 'role-reviewer',
        toUserId: 'role-target',
        instanceIds: [roleApproval.id],
        reason: 'role should not handover',
      },
    })
    expect(roleGuard.status, await roleGuard.clone().text()).toBe(200)
    const roleGuardBody = await roleGuard.json() as { data: { skipped: Array<{ id: string; reason: string }> } }
    expect(roleGuardBody.data.skipped).toEqual([{ id: roleApproval.id, reason: 'not-assigned' }])
  })

  // 按人查单（管理员）: GET /api/approvals/admin/by-user and GET /api/approvals/admin/directory/users,
  // against real PostgreSQL. Rows are seeded directly so each one exercises exactly ONE way a user
  // can be tied to an instance; every kind is asserted as a whole set over this test's own rows.
  it('looks up one (deactivated) user\'s pending / decided / involved approvals, admin-only', async () => {
    const suffix = randomUUID().slice(0, 8)
    const dbAdminId = `byuser-db-admin-${suffix}`
    const tokenAdminId = `byuser-token-admin-${suffix}`
    const departedId = `byuser-departed-${suffix}`
    const otherId = `byuser-other-${suffix}`
    const departedName = `ByUserDeparted ${suffix}`

    const seedUser = async (id: string, name: string, options: { isActive: boolean; isAdmin: boolean }) => {
      createdUserIds.add(id)
      await pool().query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $1 || '@example.test', $2, 'test', 'user', '[]'::jsonb, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name, is_active = EXCLUDED.is_active, is_admin = EXCLUDED.is_admin, updated_at = now()`,
        [id, name, options.isActive, options.isAdmin],
      )
    }
    await seedUser(dbAdminId, dbAdminId, { isActive: true, isAdmin: true })
    await seedUser(tokenAdminId, tokenAdminId, { isActive: true, isAdmin: false })
    // The person being looked up has left: the account is deactivated.
    await seedUser(departedId, departedName, { isActive: false, isAdmin: false })
    await seedUser(otherId, otherId, { isActive: true, isAdmin: false })

    const seedInstance = async (key: string, status: string, requesterId: string, sourceSystem = 'platform') => {
      const id = `byuser_${suffix}_${key}`
      createdApprovalIds.add(id)
      await pool().query(
        `INSERT INTO approval_instances
           (id, status, version, source_system, workflow_key, business_key, title,
            requester_snapshot, subject_snapshot, policy_snapshot, metadata,
            current_step, total_steps, sync_status, created_at, updated_at)
         VALUES ($1, $2, 0, $3, $4, $5, $6, $7::jsonb,
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 'ok', now(), now())`,
        [id, status, sourceSystem, `byuser-wf-${suffix}`, `byuser:${id}`, `ByUser ${key}`,
          JSON.stringify({ id: requesterId, name: requesterId })],
      )
      return id
    }
    const seedSeat = async (instanceId: string, assigneeId: string, isActive: boolean, assignmentType = 'user') => {
      await pool().query(
        `INSERT INTO approval_assignments
           (id, instance_id, assignment_type, assignee_id, source_step, is_active, metadata, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 0, $5, '{}'::jsonb, now(), now())`,
        [randomUUID(), instanceId, assignmentType, assigneeId, isActive],
      )
    }
    const seedRecord = async (instanceId: string, action: string, actorId: string, metadata: JsonRecord = {}) => {
      await pool().query(
        `INSERT INTO approval_records (instance_id, action, actor_id, to_status, metadata, occurred_at)
         VALUES ($1, $2, $3, 'pending', $4::jsonb, now())`,
        [instanceId, action, actorId, JSON.stringify(metadata)],
      )
    }

    // Each row ties the departed user to the instance in exactly one way.
    const pendingSeat = await seedInstance('pending_seat', 'pending', otherId)
    await seedSeat(pendingSeat, departedId, true)
    const approvedByThem = await seedInstance('approved_by_them', 'approved', otherId)
    await seedSeat(approvedByThem, departedId, false)
    await seedRecord(approvedByThem, 'approve', departedId)
    const returnedByThem = await seedInstance('returned_by_them', 'pending', otherId)
    await seedRecord(returnedByThem, 'return', departedId)
    const transferredAway = await seedInstance('transferred_away', 'pending', otherId)
    await seedSeat(transferredAway, departedId, false)
    await seedRecord(transferredAway, 'transfer', departedId)
    const commentOnly = await seedInstance('comment_only', 'pending', otherId)
    await seedRecord(commentOnly, 'comment', departedId)
    const ccOnly = await seedInstance('cc_only', 'pending', otherId)
    await seedRecord(ccOnly, 'cc', otherId, { targetType: 'user', targetId: departedId })
    const requestedByThem = await seedInstance('requested_by_them', 'approved', departedId)
    // Negative controls: none of these involves the departed user as a participant.
    const unrelated = await seedInstance('unrelated', 'pending', otherId)
    await seedSeat(unrelated, otherId, true)
    // A role-typed seat whose assignee_id happens to equal the user id (inactive, so `pending` —
    // which mirrors the batch-transfer queue read and does not look at the seat type — cannot
    // admit it either). Only the `assignment_type = 'user'` conjunct keeps it out of `involved`.
    const roleSeatOnly = await seedInstance('role_seat_only', 'pending', otherId)
    await seedSeat(roleSeatOnly, departedId, false, 'role')
    const reassignActorOnly = await seedInstance('reassign_actor_only', 'pending', otherId)
    await seedRecord(reassignActorOnly, 'reassign', departedId)
    const externalMirror = await seedInstance('external_mirror', 'pending', departedId, 'plm')

    const ownRows = new Set([
      pendingSeat, approvedByThem, returnedByThem, transferredAway, commentOnly, ccOnly, requestedByThem,
      unrelated, roleSeatOnly, reassignActorOnly, externalMirror,
    ])
    const lookup = async (token: string, query: string) => jsonRequest(baseUrl, `/api/approvals/admin/by-user?${query}`, token)
    const lookupIds = async (token: string, kind: string): Promise<string[]> => {
      const response = await lookup(token, `userId=${encodeURIComponent(departedId)}&kind=${kind}&pageSize=100`)
      expect(response.status, await response.clone().text()).toBe(200)
      const body = await response.json() as { ok: boolean; data: { kind: string; items: Array<{ id: string }>; total: number } }
      expect(body.ok).toBe(true)
      expect(body.data.kind).toBe(kind)
      return body.data.items.map((item) => item.id).filter((id) => ownRows.has(id)).sort()
    }

    const dbAdminToken = await authToken(baseUrl, dbAdminId, 'approvals:admin', 'user')
    // 当前待审批: the active seat only — the same seat read 批量转交 loads. The inactive seats were
    // handed on.
    expect(await lookupIds(dbAdminToken, 'pending')).toEqual([pendingSeat])
    // 已审批: decision actions only — approve and return count, transfer and comment do not.
    expect(await lookupIds(dbAdminToken, 'decided')).toEqual([approvedByThem, returnedByThem].sort())
    // 参与过: requester, any user seat, participant actions, user CC. Not an administrator's
    // reassign row, not a role seat, not an external mirror.
    expect(await lookupIds(dbAdminToken, 'involved')).toEqual([
      pendingSeat, approvedByThem, returnedByThem, transferredAway, commentOnly, ccOnly, requestedByThem,
    ].sort())

    // Paging: one row per page, the total covers the whole kind.
    const firstPage = await lookup(dbAdminToken, `userId=${encodeURIComponent(departedId)}&kind=decided&page=1&pageSize=1`)
    expect(firstPage.status).toBe(200)
    const firstBody = await firstPage.json() as { data: { items: Array<{ id: string }>; total: number; page: number; pageSize: number } }
    expect(firstBody.data.items).toHaveLength(1)
    expect(firstBody.data.total).toBe(2)
    expect(firstBody.data.page).toBe(1)
    expect(firstBody.data.pageSize).toBe(1)
    const secondPage = await lookup(dbAdminToken, `userId=${encodeURIComponent(departedId)}&kind=decided&page=2&pageSize=1`)
    const secondBody = await secondPage.json() as { data: { items: Array<{ id: string }> } }
    expect(secondBody.data.items).toHaveLength(1)
    expect(secondBody.data.items[0].id).not.toBe(firstBody.data.items[0].id)

    // Enum-strict and bounded.
    const badKind = await lookup(dbAdminToken, `userId=${encodeURIComponent(departedId)}&kind=all`)
    expect(badKind.status).toBe(400)
    expect(((await badKind.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_BY_USER_KIND_INVALID')
    const overPage = await lookup(dbAdminToken, `userId=${encodeURIComponent(departedId)}&kind=involved&pageSize=101`)
    expect(overPage.status).toBe(400)

    // Access stays consistent with the existing approval read permission: this caller gets no rows.
    const tokenAdminToken = await authToken(baseUrl, tokenAdminId, 'approvals:admin', 'admin')
    expect(await lookupIds(tokenAdminToken, 'involved')).toEqual([])

    // Same permission as 批量转交: without approvals:admin the route is refused.
    const reader = await authToken(baseUrl, `byuser-reader-${suffix}`, 'approvals:read', 'user')
    expect((await lookup(reader, `userId=${encodeURIComponent(departedId)}&kind=involved`)).status).toBe(403)
    const templateAdmin = await authToken(baseUrl, `byuser-template-admin-${suffix}`, 'approvals:admin-templates', 'user')
    expect((await lookup(templateAdmin, `userId=${encodeURIComponent(departedId)}&kind=involved`)).status).toBe(403)

    // The administrator directory finds the deactivated account and marks it; the participant
    // directory still does not return it.
    const adminDirectory = await jsonRequest(
      baseUrl,
      `/api/approvals/admin/directory/users?q=${encodeURIComponent(departedName)}`,
      dbAdminToken,
    )
    expect(adminDirectory.status).toBe(200)
    const adminUsers = ((await adminDirectory.json()) as { users: Array<Record<string, unknown>> }).users
    expect(adminUsers).toEqual([
      { id: departedId, name: departedName, email: `${departedId}@example.test`, isActive: false },
    ])
    const participantDirectory = await jsonRequest(
      baseUrl,
      `/api/approvals/directory/users?q=${encodeURIComponent(departedName)}`,
      reader,
    )
    expect(participantDirectory.status).toBe(200)
    expect(((await participantDirectory.json()) as { users: unknown[] }).users).toEqual([])
    expect((await jsonRequest(baseUrl, `/api/approvals/admin/directory/users?q=${encodeURIComponent(departedName)}`, reader)).status)
      .toBe(403)
  })
})
