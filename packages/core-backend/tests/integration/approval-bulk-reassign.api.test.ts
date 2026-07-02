import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

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
})
