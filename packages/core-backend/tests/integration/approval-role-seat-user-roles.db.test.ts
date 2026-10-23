import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Role-typed approval seats match roles granted through `user_roles` rows — over real HTTP and a
 * real database, on every surface that reads the shared approval role set.
 *
 * A 「指定角色」 node writes ONE `('role', <role id>)` seat. The role set every approval surface
 * matches against is `resolveApprovalActorRoles` = request claims ∪ `users.role` ∪
 * `user_roles.role_id` (ids only). This suite pins, per viewer:
 *
 *   (a) a non-admin who holds role R ONLY through a `user_roles` row (their `users.role` is
 *       something else) sees the instance in the pending tab (`GET /api/approvals?tab=pending`),
 *   (b) is counted in `/api/approvals/pending-count` and `/api/todo/count`, and gets the todo item
 *       marked `actionable`, with the detail's `canDecideCurrentNode` true,
 *   (c) can approve AND reject through the decision door,
 *   (d) a viewer who does NOT hold R sees none of it and is refused by the seat gate,
 *   (e) the `users.role`-column path still works,
 *   (f) ids only: a seat whose assignee string equals R's display NAME does not match a holder of R
 *       on any can-act surface (the detail may still be readable through the readability
 *       predicate's own name arm — it then reports `canDecideCurrentNode: false`).
 *
 * The claim-trusting fast path is switched OFF for every viewer request (`withoutTokenClaimTrust`),
 * so each viewer is resolved from the database exactly as in production, and their token claims
 * name no role under test. Every seat-gate refusal is asserted by error code, never bare 403.
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

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

/** start -> approval_a(role seat) -> approval_b(user seat) -> end. */
function roleSeatGraph(roleSeatAssignee: string, nextUserId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { assigneeType: 'role', assigneeIds: [roleSeatAssignee], approvalMode: 'single' } },
      { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [nextUserId], approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
      { key: 'e-b-end', source: 'approval_b', target: 'end' },
    ],
  }
}

describeIfDatabase('approval role seats match roles granted via user_roles (ids only), on every can-act surface', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const seededUserIds = new Set<string>()
  const seededRoleIds = new Set<string>()

  const pool = () => poolManager.get()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    try {
      const approvalIds = [...createdApprovalIds]
      const templateIds = [...createdTemplateIds]
      if (approvalIds.length > 0) {
        await pool().query('DELETE FROM approval_reads WHERE instance_id = ANY($1::text[])', [approvalIds])
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
      if (seededUserIds.size > 0) {
        const ids = [...seededUserIds]
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [ids])
        await pool().query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ids])
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [ids])
      }
      if (seededRoleIds.size > 0) {
        await pool().query('DELETE FROM roles WHERE id = ANY($1::text[])', [[...seededRoleIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  function freshId(label: string): string {
    return `f1rs-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
  }

  /**
   * A fresh non-admin role R per case (counts are per viewer across ALL pending instances, so a role
   * shared between cases would leak one case's still-pending seats into another's counts), with a
   * display NAME that differs from its id (case (f)).
   */
  async function seedRole(label: string): Promise<{ id: string; name: string }> {
    const id = freshId(`role-${label}`)
    const name = `F1 Role Name ${label} ${TS}`
    seededRoleIds.add(id)
    await pool().query(
      `INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [id, name],
    )
    return { id, name }
  }

  /** Token claims name only `member` — never the role under test. */
  async function authToken(userId: string, roles = 'member'): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent('*:*')}`,
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { token: string }
    return payload.token
  }

  /** Resolve the viewer from the DATABASE (users + user_roles + user_permissions), as production does. */
  async function withoutTokenClaimTrust<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.RBAC_TOKEN_TRUST
    process.env.RBAC_TOKEN_TRUST = 'false'
    try {
      return await fn()
    } finally {
      if (previous === undefined) delete process.env.RBAC_TOKEN_TRUST
      else process.env.RBAC_TOKEN_TRUST = previous
    }
  }

  async function seedUser(userId: string, options: { role: string; roleIds?: string[] }): Promise<void> {
    seededUserIds.add(userId)
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
       VALUES ($1, $1 || '@example.test', $1, 'x', $2, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE, is_admin = FALSE`,
      [userId, options.role],
    )
    for (const roleId of options.roleIds ?? []) {
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, roleId],
      )
    }
  }

  /** Direct grants: viewers are DB-resolved, so the `*:*` token claim is not what `rbacGuard` reads. */
  async function grantPermissions(userId: string, codes: string[]): Promise<void> {
    seededUserIds.add(userId)
    const hasNameColumn = (
      await pool().query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'permissions' AND column_name = 'name'
         ) AS present`,
      )
    ).rows[0]?.present === true
    for (const code of codes) {
      if (hasNameColumn) {
        await pool().query(
          `INSERT INTO permissions (code, name, description) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`,
          [code, code, code],
        )
      } else {
        await pool().query(
          `INSERT INTO permissions (code, description) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
          [code, code],
        )
      }
      await pool().query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, code],
      )
    }
  }

  async function seedViewer(label: string, options: { role: string; roleIds?: string[] }): Promise<{ id: string; token: string }> {
    const id = freshId(label)
    await seedUser(id, options)
    await grantPermissions(id, ['approvals:read', 'approvals:act'])
    return { id, token: await authToken(id) }
  }

  async function publishTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const response = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: freshId(`tpl-${label}`),
        name: 'role seat via user_roles',
        description: 'role seats match user_roles ids',
        formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
        approvalGraph,
      },
    })
    expect(response.status, await response.clone().text()).toBe(201)
    const template = (await response.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const published = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)
    return template.id
  }

  async function createApproval(requesterToken: string, templateId: string): Promise<string> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const instance = (await create.json()) as { id: string }
    createdApprovalIds.add(instance.id)
    return instance.id
  }

  async function pendingTabIds(token: string): Promise<string[]> {
    const response = await jsonRequest(baseUrl, '/api/approvals?tab=pending&sourceSystem=all', token)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    return body.data.map((row) => row.id)
  }

  async function legacyPendingIds(token: string): Promise<string[]> {
    const response = await jsonRequest(baseUrl, '/api/approvals/pending', token)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as { data: Array<{ id: string }> }
    return body.data.map((row) => row.id)
  }

  async function pendingCount(token: string): Promise<number> {
    const response = await jsonRequest(baseUrl, '/api/approvals/pending-count?sourceSystem=all', token)
    expect(response.status, await response.clone().text()).toBe(200)
    return ((await response.json()) as { count: number }).count
  }

  async function todoCount(token: string): Promise<number> {
    const response = await jsonRequest(baseUrl, '/api/todo/count', token)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = (await response.json()) as { count: number; sources: Record<string, unknown> }
    expect(body.sources.approval).toBe('ok')
    return body.count
  }

  async function todoItems(token: string): Promise<Array<{ id: string; actionable?: boolean }>> {
    const response = await jsonRequest(baseUrl, '/api/todo/items', token)
    expect(response.status, await response.clone().text()).toBe(200)
    return ((await response.json()) as { items: Array<{ id: string; actionable?: boolean }> }).items
  }

  async function detail(token: string, instanceId: string): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}`, token)
  }

  async function act(token: string, instanceId: string, action: 'approve' | 'reject'): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, {
      method: 'POST',
      body: { action, comment: 'ok' },
    })
  }

  async function expectSeatGateRefusal(response: Response): Promise<void> {
    expect(response.status, await response.clone().text()).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'APPROVAL_ASSIGNMENT_REQUIRED' } })
  }

  async function instanceStatus(instanceId: string): Promise<{ status: string; current_node_key: string | null }> {
    const result = await pool().query<{ status: string; current_node_key: string | null }>(
      'SELECT status, current_node_key FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    return result.rows[0]
  }

  /** One requester (claim-trusted, write-granted) and one admin template author per case. */
  async function fixture(label: string, roleSeatAssignee: string): Promise<{ instanceA: string; instanceB: string }> {
    const admin = freshId(`admin-${label}`)
    const requester = freshId(`req-${label}`)
    const next = freshId(`next-${label}`)
    await grantApprovalWriteForIntegrationActor(requester)
    seededUserIds.add(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const templateId = await publishTemplate(adminToken, roleSeatGraph(roleSeatAssignee, next), label)
    const instanceA = await createApproval(requesterToken, templateId)
    const instanceB = await createApproval(requesterToken, templateId)
    for (const instanceId of [instanceA, instanceB]) {
      const seats = await pool().query(
        `SELECT assignment_type, assignee_id FROM approval_assignments
          WHERE instance_id = $1 AND node_key = 'approval_a' AND is_active = TRUE`,
        [instanceId],
      )
      // Fixture check: the seat under test is ROLE-typed and names exactly the assignee string.
      expect(seats.rows).toEqual([{ assignment_type: 'role', assignee_id: roleSeatAssignee }])
    }
    return { instanceA, instanceB }
  }

  /** R held ONLY through a `user_roles` row (`users.role` is something else). */
  async function userRolesOnlyHolder(label: string) {
    const role = await seedRole(label)
    const { instanceA, instanceB } = await fixture(label, role.id)
    const holder = await seedViewer(`${label}-holder`, { role: 'user', roleIds: [role.id] })
    return { instanceA, instanceB, holder }
  }

  it('(a) a non-admin holding R ONLY via user_roles sees the role-seated instances in the pending tab', async () => {
    const { instanceA, instanceB, holder } = await userRolesOnlyHolder('row-a')
    await withoutTokenClaimTrust(async () => {
      // Pre-existing discriminator: the legacy feed already resolves roles from the DB.
      expect(await legacyPendingIds(holder.token)).toEqual(expect.arrayContaining([instanceA, instanceB]))
      expect(await pendingTabIds(holder.token)).toEqual(expect.arrayContaining([instanceA, instanceB]))
    })
  })

  it('(b) ... is counted in pending-count and the todo count, and the todo items and detail offer the decision', async () => {
    const { instanceA, instanceB, holder } = await userRolesOnlyHolder('row-b')
    await withoutTokenClaimTrust(async () => {
      expect(await pendingCount(holder.token)).toBe(2)
      expect(await todoCount(holder.token)).toBe(2)
      const ours = (await todoItems(holder.token)).filter((item) => item.id === instanceA || item.id === instanceB)
      expect(ours).toHaveLength(2)
      for (const item of ours) expect(item.actionable).toBe(true)
      const read = await detail(holder.token, instanceA)
      expect(read.status, await read.clone().text()).toBe(200)
      expect(((await read.json()) as { canDecideCurrentNode?: boolean }).canDecideCurrentNode).toBe(true)
    })
  })

  it('(c) ... can approve and reject through the decision door', async () => {
    const { instanceA, instanceB, holder } = await userRolesOnlyHolder('row-c')
    await withoutTokenClaimTrust(async () => {
      const approved = await act(holder.token, instanceA, 'approve')
      expect(approved.status, await approved.clone().text()).toBe(200)
      expect(await instanceStatus(instanceA)).toEqual({ status: 'pending', current_node_key: 'approval_b' })
      const rejected = await act(holder.token, instanceB, 'reject')
      expect(rejected.status, await rejected.clone().text()).toBe(200)
      expect((await instanceStatus(instanceB)).status).toBe('rejected')
      // Both decided: nothing pending for this holder any more.
      expect(await pendingCount(holder.token)).toBe(0)
      expect(await todoCount(holder.token)).toBe(0)
    })
  })

  it('(d) a viewer who does NOT hold R sees none of it and is refused by the seat gate', async () => {
    const role = await seedRole('out')
    const { instanceA } = await fixture('out', role.id)
    const outsider = await seedViewer('outsider', { role: 'user', roleIds: [`${role.id}-other`] })

    await withoutTokenClaimTrust(async () => {
      expect(await pendingTabIds(outsider.token)).not.toContain(instanceA)
      expect(await legacyPendingIds(outsider.token)).not.toContain(instanceA)
      expect(await pendingCount(outsider.token)).toBe(0)
      expect(await todoCount(outsider.token)).toBe(0)
      expect((await todoItems(outsider.token)).map((item) => item.id)).not.toContain(instanceA)
      const refused = await act(outsider.token, instanceA, 'approve')
      await expectSeatGateRefusal(refused)
      expect(await instanceStatus(instanceA)).toEqual({ status: 'pending', current_node_key: 'approval_a' })
    })
  })

  it('(e) the users.role-column path still works: users.role = R, no user_roles row', async () => {
    const role = await seedRole('col')
    const { instanceA, instanceB } = await fixture('col', role.id)
    const columnHolder = await seedViewer('col-holder', { role: role.id })
    const rows = await pool().query('SELECT 1 FROM user_roles WHERE user_id = $1', [columnHolder.id])
    expect(rows.rows).toHaveLength(0)

    await withoutTokenClaimTrust(async () => {
      expect(await pendingTabIds(columnHolder.token)).toEqual(expect.arrayContaining([instanceA, instanceB]))
      expect(await pendingCount(columnHolder.token)).toBe(2)
      expect(await todoCount(columnHolder.token)).toBe(2)
      const approved = await act(columnHolder.token, instanceA, 'approve')
      expect(approved.status, await approved.clone().text()).toBe(200)
      expect(await instanceStatus(instanceA)).toEqual({ status: 'pending', current_node_key: 'approval_b' })
    })
  })

  it('(f) ids only: a seat naming R\'s display NAME does not match a holder of R (user_roles row) on any can-act surface', async () => {
    const role = await seedRole('name')
    const { instanceA } = await fixture('name', role.name)
    const holder = await seedViewer('name-holder', { role: 'user', roleIds: [role.id] })

    await withoutTokenClaimTrust(async () => {
      expect(await pendingTabIds(holder.token)).not.toContain(instanceA)
      expect(await pendingCount(holder.token)).toBe(0)
      expect(await todoCount(holder.token)).toBe(0)
      expect((await todoItems(holder.token)).map((item) => item.id)).not.toContain(instanceA)
      // The readability predicate (a different, ratified predicate) also matches role NAMES, so the
      // detail may be readable; when it is, it must not offer the decision.
      const read = await detail(holder.token, instanceA)
      if (read.status === 200) {
        expect(((await read.json()) as { canDecideCurrentNode?: boolean }).canDecideCurrentNode).toBe(false)
      } else {
        expect(read.status).toBe(404)
      }
      const refused = await act(holder.token, instanceA, 'approve')
      await expectSeatGateRefusal(refused)
      expect(await instanceStatus(instanceA)).toEqual({ status: 'pending', current_node_key: 'approval_a' })
    })
  })
})
