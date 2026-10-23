import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'
import { ICollabService } from '../../src/di/identifiers'
import { buildAuthenticatedUserRoom } from '../../src/services/CollabService'

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

/** start -> approval_a(user seat) -> approval_b(user seat) -> end. */
function userSeatGraph(firstUserId: string, secondUserId: string) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [firstUserId], approvalMode: 'single' } },
      { key: 'approval_b', type: 'approval', config: { assigneeType: 'user', assigneeIds: [secondUserId], approvalMode: 'single' } },
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

  async function seedViewer(
    label: string,
    options: { role: string; roleIds?: string[]; permissions?: string[] },
  ): Promise<{ id: string; token: string }> {
    const id = freshId(label)
    await seedUser(id, options)
    await grantPermissions(id, options.permissions ?? ['approvals:read', 'approvals:act'])
    return { id, token: await authToken(id) }
  }

  type Push = { room: string; event: string; payload: { count?: number } | undefined }
  /** Records every realtime push the server's collab service makes, passing each one through. */
  function recordPushes(): { pushes: Push[]; stop: () => void } {
    const injector = (server as unknown as { injector: { get: (id: unknown) => any } }).injector
    const collab = injector.get(ICollabService)
    const original = collab.broadcastTo
    const pushes: Push[] = []
    collab.broadcastTo = (room: string, event: string, payload: unknown) => {
      pushes.push({ room, event, payload: payload as Push['payload'] })
      return original.call(collab, room, event, payload)
    }
    return { pushes, stop: () => { collab.broadcastTo = original } }
  }

  async function publishTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const response = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: freshId(`tpl-${label}`),
        name: `role seat via user_roles ${label} ${TS}`,
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
  async function fixture(label: string, roleSeatAssignee: string): Promise<{ templateId: string; instanceA: string; instanceB: string }> {
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
    return { templateId, instanceA, instanceB }
  }

  /** R held ONLY through a `user_roles` row (`users.role` is something else). */
  async function userRolesOnlyHolder(label: string) {
    const role = await seedRole(label)
    const { templateId, instanceA, instanceB } = await fixture(label, role.id)
    const holder = await seedViewer(`${label}-holder`, { role: 'user', roleIds: [role.id] })
    return { role, templateId, instanceA, instanceB, holder }
  }

  async function rawVersion(instanceId: string): Promise<number> {
    const result = await pool().query<{ version: number }>('SELECT version FROM approval_instances WHERE id = $1', [instanceId])
    return result.rows[0].version
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

  it('(g) the legacy /approve and /reject doors accept the user_roles-only holder and refuse a viewer outside R', async () => {
    const { instanceA, instanceB, holder } = await userRolesOnlyHolder('row-g')
    const outsider = await seedViewer('row-g-outsider', { role: 'user' })
    await withoutTokenClaimTrust(async () => {
      const refused = await jsonRequest(baseUrl, `/api/approvals/${instanceA}/approve`, outsider.token, {
        method: 'POST',
        body: { version: await rawVersion(instanceA), metadata: { nodeKey: 'approval_a' } },
      })
      await expectSeatGateRefusal(refused)
      expect(await instanceStatus(instanceA)).toEqual({ status: 'pending', current_node_key: 'approval_a' })

      const approved = await jsonRequest(baseUrl, `/api/approvals/${instanceA}/approve`, holder.token, {
        method: 'POST',
        body: { version: await rawVersion(instanceA), metadata: { nodeKey: 'approval_a' } },
      })
      expect(approved.status, await approved.clone().text()).toBe(200)
      expect(await instanceStatus(instanceA)).toEqual({ status: 'pending', current_node_key: 'approval_b' })

      const rejected = await jsonRequest(baseUrl, `/api/approvals/${instanceB}/reject`, holder.token, {
        method: 'POST',
        body: { version: await rawVersion(instanceB), reason: 'no', metadata: { nodeKey: 'approval_a' } },
      })
      expect(rejected.status, await rejected.clone().text()).toBe(200)
      expect((await instanceStatus(instanceB)).status).toBe('rejected')
    })
  })

  it('(h) side effect: a role-scoped (按角色可见) template becomes visible to a user_roles-only holder of that role', async () => {
    const { role, templateId, holder } = await userRolesOnlyHolder('row-h')
    const outsider = await seedViewer('row-h-outsider', { role: 'user' })
    await pool().query(
      `UPDATE approval_templates SET visibility_scope = $2::jsonb WHERE id = $1`,
      [templateId, JSON.stringify({ type: 'role', ids: [role.id] })],
    )
    await withoutTokenClaimTrust(async () => {
      const seen = await jsonRequest(baseUrl, `/api/approval-templates/${templateId}`, holder.token)
      expect(seen.status, await seen.clone().text()).toBe(200)
      const hidden = await jsonRequest(baseUrl, `/api/approval-templates/${templateId}`, outsider.token)
      expect(hidden.status, await hidden.clone().text()).toBe(404)
    })
  })

  it('(k) a user_roles holder of R WITHOUT approvals:act is refused (a seat match alone is not enough)', async () => {
    const role = await seedRole('row-k')
    const { instanceA } = await fixture('row-k', role.id)
    const readOnly = await seedViewer('row-k-readonly', { role: 'user', roleIds: [role.id], permissions: ['approvals:read'] })
    await withoutTokenClaimTrust(async () => {
      // The seat matches (the item is theirs to see) ...
      expect(await pendingTabIds(readOnly.token)).toContain(instanceA)
      // ... but the door is guarded by approvals:act first.
      const refused = await act(readOnly.token, instanceA, 'approve')
      expect(refused.status, await refused.clone().text()).toBe(403)
      const legacy = await jsonRequest(baseUrl, `/api/approvals/${instanceA}/approve`, readOnly.token, {
        method: 'POST',
        body: { version: await rawVersion(instanceA), metadata: { nodeKey: 'approval_a' } },
      })
      expect(legacy.status, await legacy.clone().text()).toBe(403)
      expect(await instanceStatus(instanceA)).toEqual({ status: 'pending', current_node_key: 'approval_a' })
    })
  })

  it('(i) admin semantics do not drift: with token-claim trust ON, claims without admin plus a DB-only admin user_roles row — list, detail, preview and create all treat the actor as a NON-manager', async () => {
    // Token-claim trust stays ON here (the integration default): the request claims are `member`
    // and the template permissions only; the admin row exists ONLY in user_roles.
    expect(process.env.RBAC_TOKEN_TRUST).toBe('true')
    const label = 'admin-drift'
    const admin = freshId(`admin-${label}`)
    const someoneElse = freshId(`other-${label}`)
    const actorId = freshId(`actor-${label}`)
    await seedUser(actorId, { role: 'user', roleIds: ['admin'] })
    await grantApprovalWriteForIntegrationActor(actorId)
    const adminToken = await authToken(admin, 'admin')
    const templateId = await publishTemplate(adminToken, userSeatGraph(someoneElse, someoneElse), label)
    // Positive control: a template visible to all, so a refusal below is the visibility filter and
    // not an inability to create at all.
    const openTemplateId = await publishTemplate(adminToken, userSeatGraph(someoneElse, someoneElse), `${label}-open`)
    // Visible ONLY to someoneElse: a non-manager actor must not see or use it.
    await pool().query(
      `UPDATE approval_templates SET visibility_scope = $2::jsonb WHERE id = $1`,
      [templateId, JSON.stringify({ type: 'user', ids: [someoneElse] })],
    )
    const tokenResponse = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(actorId)}&roles=member&perms=${encodeURIComponent('approvals:read,approvals:write')}`,
    )
    expect(tokenResponse.status).toBe(200)
    const actorToken = ((await tokenResponse.json()) as { token: string }).token

    const list = await jsonRequest(baseUrl, `/api/approval-templates?search=${encodeURIComponent(`role seat via user_roles ${label} ${TS}`)}`, actorToken)
    expect(list.status, await list.clone().text()).toBe(200)
    expect(((await list.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id)).not.toContain(templateId)

    const read = await jsonRequest(baseUrl, `/api/approval-templates/${templateId}`, actorToken)
    expect(read.status, await read.clone().text()).toBe(404)

    const preview = await jsonRequest(baseUrl, '/api/approvals/preview', actorToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(preview.status, await preview.clone().text()).toBe(404)

    const control = await jsonRequest(baseUrl, '/api/approvals', actorToken, {
      method: 'POST',
      body: { templateId: openTemplateId, formData: { reason: 'r' } },
    })
    expect(control.status, await control.clone().text()).toBe(201)
    createdApprovalIds.add(((await control.json()) as { id: string }).id)

    const create = await jsonRequest(baseUrl, '/api/approvals', actorToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    const createText = await create.clone().text()
    if (create.status === 201) createdApprovalIds.add(((await create.json()) as { id: string }).id)
    expect(create.status, createText).toBe(404)
  })

  it('(j) the live count push to OTHER affected users carries their stored role ids: a handler holding R via user_roles is pushed the same todo count their own GET answers', async () => {
    const role = await seedRole('push-j')
    // P: an unrelated pending item seated ONLY on role R.
    const { instanceA: roleItem } = await fixture('push-j', role.id)
    const handler = await seedViewer('push-j-handler', { role: 'user', roleIds: [role.id] })
    const first = await seedViewer('push-j-first', { role: 'user' })
    // Q: first (user seat) -> handler (user seat). When `first` approves, the push goes to `handler`
    // as an affected user — handed over with a user id only.
    const admin = freshId('admin-push-j')
    const requester = freshId('req-push-j')
    await grantApprovalWriteForIntegrationActor(requester)
    seededUserIds.add(requester)
    const templateId = await publishTemplate(await authToken(admin, 'admin'), userSeatGraph(first.id, handler.id), 'push-j-users')
    const userItem = await createApproval(await authToken(requester), templateId)

    const recorder = recordPushes()
    try {
      await withoutTokenClaimTrust(async () => {
        expect(await pendingTabIds(handler.token)).toContain(roleItem)
        recorder.pushes.length = 0
        const approved = await act(first.token, userItem, 'approve')
        expect(approved.status, await approved.clone().text()).toBe(200)
        const handlerCount = await todoCount(handler.token)
        // Both the role-seated item and the now-active user seat are the handler's.
        expect(handlerCount).toBe(2)
        const handlerPushes = recorder.pushes.filter(
          (push) => push.room === buildAuthenticatedUserRoom(handler.id) && push.event === 'todo:counts-updated',
        )
        expect(handlerPushes).toHaveLength(1)
        expect(handlerPushes[0].payload?.count).toBe(handlerCount)
      })
    } finally {
      recorder.stop()
    }
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
      // detail IS readable to this holder — and it must not offer the decision.
      const read = await detail(holder.token, instanceA)
      expect(read.status, await read.clone().text()).toBe(200)
      expect(((await read.json()) as { canDecideCurrentNode?: boolean }).canDecideCurrentNode).toBe(false)
      const refused = await act(holder.token, instanceA, 'approve')
      await expectSeatGateRefusal(refused)
      expect(await instanceStatus(instanceA)).toEqual({ status: 'pending', current_node_key: 'approval_a' })
    })
  })
})
