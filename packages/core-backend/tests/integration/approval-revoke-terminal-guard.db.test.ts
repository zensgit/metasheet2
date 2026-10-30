import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { invalidateUserPerms } from '../../src/rbac/service'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Revoke terminal-status guard — real-DB acceptance.
 *
 * `dispatchAction`'s `revoke` branch previously gated "already handled" purely on
 * `!currentNodeKey` (an active-node check), not on `instance.status`. The executor path always
 * clears `current_node_key` when it moves an instance to a terminal status, so on THAT path the
 * node-key check happened to also reject a terminal instance. Not every write path that can move
 * an instance to a terminal status clears `current_node_key` the same way — the legacy
 * `/api/approvals/:id/approve` and `/api/approvals/:id/reject` endpoints update `status` only and
 * leave `current_node_key` as it was. Before this change, an instance that reached a terminal
 * status via one of those endpoints kept a non-null `current_node_key` and so passed the node-key
 * check, making it eligible for revoke despite already being terminal.
 *
 * This suite adds an explicit `instance.status ∈ APPROVAL_TERMINAL_STATUSES` guard ahead of the
 * node-key check (same 409 `INVALID_STATUS_TRANSITION` shape), and exercises three approval
 * pre-states against revoke:
 *   (a) terminal via the legacy `/approve` endpoint (current_node_key left non-null)
 *   (b) terminal via the executor `/actions {action:'approve'}` endpoint (current_node_key cleared;
 *       answered by the status guard — the older node-key 409 is unreachable once status is terminal)
 *   (c) POSITIVE CONTROL — still `pending` (revoke must still succeed)
 * plus an observational case:
 *   (d) terminal via the legacy `/reject` endpoint — recorded as-is, not asserted as a design
 *       decision; `'rejected'` is one of the `APPROVAL_TERMINAL_STATUSES` members so the new guard
 *       covers it identically to (a), which the test documents rather than special-cases.
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

async function authToken(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { token: string }
  return payload.token
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

function buildFormSchema() {
  return { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] }
}

/** `start -> approval_a -> end`: a single approval node, one assignee, single approvalMode. */
function oneNodeGraph(approverId: string) {
  return {
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
  }
}

describeIfDatabase('approval revoke: terminal-status guard ahead of the node-key check', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const grantedUserIds = new Set<string>()
  const requesterAccessUserIds = new Set<string>()

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
      if (grantedUserIds.size > 0) {
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[...grantedUserIds]])
      }
      // New owned identities only, after all owned approval/template rows above are gone.
      if (requesterAccessUserIds.size > 0) {
        const userIds = [...requesterAccessUserIds]
        await pool().query('DELETE FROM user_sessions WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [userIds])
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [userIds])
        for (const userId of userIds) invalidateUserPerms(userId)
      }
    } finally {
      await server?.stop()
    }
  })

  async function grantWrite(userId: string): Promise<void> {
    grantedUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  async function publishOneNodeTemplate(adminToken: string, approverId: string, label: string): Promise<string> {
    const templateKey = `l1-revoke-guard-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    const create = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: templateKey,
        name: 'L1 revoke terminal guard',
        description: 'fix/approval-revoke-terminal-guard',
        formSchema: buildFormSchema(),
        approvalGraph: oneNodeGraph(approverId),
      },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const template = (await create.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const publishResponse = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return template.id
  }

  async function rawRow(instanceId: string): Promise<{
    status: string
    version: number
    current_node_key: string | null
  }> {
    const result = await pool().query(
      `SELECT status, version, current_node_key FROM approval_instances WHERE id = $1`,
      [instanceId],
    )
    return result.rows[0] as never
  }

  // `UnifiedApprovalDTO` (the create response) carries no `version` field, so the caller reads
  // it back with `rawRow` rather than trusting an assumed shape on the JSON response.
  async function createApproval(
    requesterToken: string,
    templateId: string,
  ): Promise<{ id: string; version: number; currentNodeKey: string | null }> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string; currentNodeKey: string | null }
    createdApprovalIds.add(inst.id)
    const row = await rawRow(inst.id)
    return { id: inst.id, currentNodeKey: inst.currentNodeKey, version: row.version }
  }

  async function revoke(requesterToken: string, instanceId: string): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, requesterToken, {
      method: 'POST',
      body: { action: 'revoke' },
    })
  }

  it('(a) legacy /approve: the instance is terminal and revoke is refused 409 by the STATUS guard — the non-null-cursor premise this case used to re-confirm is retired by the settlement-parity slice', async () => {
    const suffix = `a-${TS}`
    const requesterId = `l1-req-${suffix}`
    const approverId = `l1-apr-${suffix}`
    const adminId = `l1-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'a')
    const created = await createApproval(requesterToken, templateId)
    expect(created.currentNodeKey).toBe('approval_a')

    const legacyApprove = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverToken, {
      method: 'POST',
      body: { version: created.version },
    })
    expect(legacyApprove.status, await legacyApprove.clone().text()).toBe(200)

    // PREMISE, RESTATED (`fix/approval-legacy-approve-settlement-parity`): legacy `/approve` no
    // longer writes the terminal status itself. A seat-gated (template-runtime) instance is settled
    // by `ApprovalProductService.dispatchAction` — the same method `/actions` calls — so this row
    // now reaches the SAME terminal shape as case (b): `approved` with the cursor CLEARED.
    //
    // WHAT THAT COSTS THIS FILE, said plainly rather than quietly dropped: this case used to be the
    // one place where a terminal instance still carried a live `current_node_key`, which is what
    // made "the node-key check alone would not have rejected this instance" a DEMONSTRATED claim
    // rather than a stated one. No shipped route produces that shape any more, so the status
    // guard's independence from the pre-existing node-key check is no longer discriminated here —
    // the guard is unchanged and still correct, but on this fixture it is now defence in depth.
    // Restoring the discriminator would mean constructing the state directly rather than through
    // the HTTP surface, which is a change to this file's fixture doctrine and is NOT made here.
    const afterApprove = await rawRow(created.id)
    expect(afterApprove.status).toBe('approved')
    expect(afterApprove.current_node_key).toBeNull()

    const revokeResponse = await revoke(requesterToken, created.id)
    const revokeBody = await revokeResponse.clone().text()
    expect(revokeResponse.status, revokeBody).toBe(409)
    const parsed = JSON.parse(revokeBody) as { error: { code: string } }
    expect(parsed.error.code).toBe('INVALID_STATUS_TRANSITION')

    const finalRow = await rawRow(created.id)
    expect(finalRow.status).toBe('approved')
    expect(finalRow.version).toBe(afterApprove.version)
  })

  it('(b) executor /actions{approve}: instance is terminal (status approved, current_node_key cleared) — revoke is 409 via the new status guard; the pre-existing node-key check is not reached for terminal statuses', async () => {
    const suffix = `b-${TS}`
    const requesterId = `l1-req-${suffix}`
    const approverId = `l1-apr-${suffix}`
    const adminId = `l1-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'b')
    const created = await createApproval(requesterToken, templateId)
    expect(created.currentNodeKey).toBe('approval_a')

    const executorApprove = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, approverToken, {
      method: 'POST',
      body: { action: 'approve' },
    })
    expect(executorApprove.status, await executorApprove.clone().text()).toBe(200)

    const afterApprove = await rawRow(created.id)
    expect(afterApprove.status).toBe('approved')
    expect(afterApprove.current_node_key).toBeNull()

    const revokeResponse = await revoke(requesterToken, created.id)
    const revokeBody = await revokeResponse.clone().text()
    expect(revokeResponse.status, revokeBody).toBe(409)
    const parsed = JSON.parse(revokeBody) as { error: { code: string } }
    expect(parsed.error.code).toBe('INVALID_STATUS_TRANSITION')

    const finalRow = await rawRow(created.id)
    expect(finalRow.status).toBe('approved')
  })

  it('(c) POSITIVE CONTROL: a pending instance still revokes successfully — the new guard does not catch normal revoke', async () => {
    const suffix = `c-${TS}`
    const requesterId = `l1-req-${suffix}`
    const approverId = `l1-apr-${suffix}`
    const adminId = `l1-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)

    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'c')
    const created = await createApproval(requesterToken, templateId)
    expect(created.currentNodeKey).toBe('approval_a')

    const beforeRow = await rawRow(created.id)
    expect(beforeRow.status).toBe('pending')

    const revokeResponse = await revoke(requesterToken, created.id)
    expect(revokeResponse.status, await revokeResponse.clone().text()).toBe(200)

    const finalRow = await rawRow(created.id)
    expect(finalRow.status).toBe('revoked')
    expect(finalRow.current_node_key).toBeNull()
  })

  it('(d) OBSERVATIONAL, not a design assertion: legacy /reject reaches the same terminal shape as /approve does, and the new guard (status-based) covers it — recorded as-is', async () => {
    const suffix = `d-${TS}`
    const requesterId = `l1-req-${suffix}`
    const approverId = `l1-apr-${suffix}`
    const adminId = `l1-admin-${suffix}`
    await grantWrite(requesterId)
    const adminToken = await authToken(baseUrl, adminId)
    const requesterToken = await authToken(baseUrl, requesterId)
    const approverToken = await authToken(baseUrl, approverId)

    const templateId = await publishOneNodeTemplate(adminToken, approverId, 'd')
    const created = await createApproval(requesterToken, templateId)
    expect(created.currentNodeKey).toBe('approval_a')

    const legacyReject = await jsonRequest(baseUrl, `/api/approvals/${created.id}/reject`, approverToken, {
      method: 'POST',
      body: { version: created.version, reason: 'no' },
    })
    expect(legacyReject.status, await legacyReject.clone().text()).toBe(200)

    // OBSERVATION (structural symmetry with (a), not asserted as intended behavior of /reject —
    // /reject itself is out of scope for THIS file's change): the row is 'rejected' and, since
    // `fix/approval-legacy-approve-settlement-parity`, the cursor is cleared — the same shape
    // legacy /approve now reaches, and the same shape `/actions{reject}` has always reached.
    const afterReject = await rawRow(created.id)
    expect(afterReject.status).toBe('rejected')
    expect(afterReject.current_node_key).toBeNull()

    // 'rejected' is a member of APPROVAL_TERMINAL_STATUSES, so the new status-based guard (added
    // for revoke, not specific to any one terminal status) refuses this the same way it refuses
    // (a)'s 'approved' case.
    const revokeResponse = await revoke(requesterToken, created.id)
    const revokeBody = await revokeResponse.clone().text()
    expect(revokeResponse.status, revokeBody).toBe(409)
    const parsed = JSON.parse(revokeBody) as { error: { code: string } }
    expect(parsed.error.code).toBe('INVALID_STATUS_TRANSITION')

    const finalRow = await rawRow(created.id)
    expect(finalRow.status).toBe('rejected')
  })

  describe('REQUESTER_REVOKE_ACCESS', () => {
    const namespace = `requester-revoke-${TS}-${randomUUID()}`
    const orgId = `${namespace}-org`
    const otherOrgId = `${namespace}-other-org`
    const requesterId = `${namespace}-requester`
    const approverId = `${namespace}-approver`
    const otherWriterId = `${namespace}-other-writer`
    const readerId = `${namespace}-reader`
    const adminId = `${namespace}-admin`
    const tokens = new Map<string, string>()
    let templateId = ''

    // The integration setup trusts claims. Override only during awaited requests and restore
    // even on assertion failure; the four existing admin-token cases remain unchanged.
    async function withDatabaseAuthentication<T>(fn: () => Promise<T>): Promise<T> {
      const previous = process.env.RBAC_TOKEN_TRUST
      process.env.RBAC_TOKEN_TRUST = 'false'
      try {
        return await fn()
      } finally {
        if (previous === undefined) delete process.env.RBAC_TOKEN_TRUST
        else process.env.RBAC_TOKEN_TRUST = previous
      }
    }

    function tokenFor(userId: string): string {
      const token = tokens.get(userId)
      expect(token).toBeTruthy()
      return token!
    }

    async function assertWriterIdentity(userId: string): Promise<void> {
      const response = await jsonRequest(baseUrl, '/api/auth/me', tokenFor(userId))
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        data: { user: { id: string; name: string; role: string; permissions: string[] } }
      }
      expect(body.data.user.id).toBe(userId)
      expect(body.data.user.name).toBe(userId)
      expect(body.data.user.role).toBe('user')
      expect(body.data.user.permissions.filter((code) => code.startsWith('approvals:')).sort())
        .toEqual(['approvals:read', 'approvals:write'])
      expect(body.data.user.permissions.some((code) => code.includes('*') || code.startsWith('admin:'))).toBe(false)
    }

    beforeAll(async () => withDatabaseAuthentication(async () => {
      // Require the migrated catalogue; never create/delete shared permission definitions.
      const catalogue = await pool().query(
        "SELECT code FROM permissions WHERE code IN ('approvals:read', 'approvals:write') ORDER BY code",
      )
      expect(catalogue.rows).toEqual([{ code: 'approvals:read' }, { code: 'approvals:write' }])
      for (const userId of [requesterId, approverId, otherWriterId, readerId, adminId]) {
        requesterAccessUserIds.add(userId)
        await pool().query(
          `INSERT INTO users
             (id, email, username, name, password_hash, role, permissions, is_active, is_admin,
              activation_status, local_password_set, must_change_password)
           VALUES ($1, $2, $1, $1, 'x', $3, '[]'::jsonb, TRUE, $4, 'activated', TRUE, FALSE)`,
          [userId, `${userId}@example.test`, userId === adminId ? 'admin' : 'user', userId === adminId],
        )
        await pool().query(
          'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)',
          [userId, orgId],
        )
        if (userId !== adminId) {
          await pool().query(
            `INSERT INTO user_permissions (user_id, permission_code)
             VALUES ($1, 'approvals:read'), ($1, 'approvals:write')`,
            [userId],
          )
        }
        const memberships = await pool().query(
          'SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active = TRUE ORDER BY org_id',
          [userId],
        )
        expect(memberships.rows).toEqual([{ org_id: orgId }])
        const roles = await pool().query('SELECT role_id FROM user_roles WHERE user_id = $1', [userId])
        expect(roles.rows).toEqual([])
        const grants = await pool().query(
          'SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code',
          [userId],
        )
        expect(grants.rows).toEqual(userId === adminId ? [] : [
          { permission_code: 'approvals:read' },
          { permission_code: 'approvals:write' },
        ])
        // No admin role or permission claims, including for the template author:
        // its admin authority comes from its own users row through real authentication.
        const response = await fetch(
          `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=user&perms=`,
        )
        expect(response.status).toBe(200)
        const payload = (await response.json()) as {
          token: string; payload: { roles: string[]; perms: string[]; sid: string }
        }
        expect(payload.payload.roles).toEqual(['user'])
        expect(payload.payload.perms).toEqual([])
        tokens.set(userId, payload.token)
        const sessions = await pool().query(
          'SELECT id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL',
          [userId],
        )
        expect(sessions.rows).toEqual([{ id: payload.payload.sid }])
        if (userId !== adminId) await assertWriterIdentity(userId)
      }
      templateId = await publishOneNodeTemplate(tokenFor(adminId), approverId, namespace)
    }))

    async function snapshot(instanceId: string) {
      const instance = await pool().query('SELECT * FROM approval_instances WHERE id = $1', [instanceId])
      const assignments = await pool().query(
        'SELECT * FROM approval_assignments WHERE instance_id = $1 ORDER BY id', [instanceId],
      )
      const records = await pool().query(
        'SELECT * FROM approval_records WHERE instance_id = $1 ORDER BY id', [instanceId],
      )
      return { instance: instance.rows, assignments: assignments.rows, records: records.rows }
    }

    async function freshPending(userId = requesterId) {
      const created = await createApproval(tokenFor(userId), templateId)
      const row = await pool().query(
        `SELECT status, current_node_key, org_id, requester_snapshot->>'id' AS requester_id
         FROM approval_instances WHERE id = $1`, [created.id],
      )
      expect(row.rows).toEqual([{
        status: 'pending', current_node_key: 'approval_a', org_id: orgId, requester_id: userId,
      }])
      const active = await pool().query(
        'SELECT assignee_id, node_key FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE',
        [created.id],
      )
      expect(active.rows).toEqual([{ assignee_id: approverId, node_key: 'approval_a' }])
      const handled = await pool().query(
        `SELECT action FROM approval_records WHERE instance_id = $1
         AND action IN ('approve', 'reject', 'transfer', 'handle')`, [created.id],
      )
      expect(handled.rows).toEqual([])
      return created
    }

    it('RW_SELF: read/write-only requester revokes own pending unhandled instance with real requester audit', async () => withDatabaseAuthentication(async () => {
      await assertWriterIdentity(requesterId)
      const created = await freshPending()
      const response = await revoke(tokenFor(requesterId), created.id)
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await rawRow(created.id)).toEqual({
        status: 'revoked', current_node_key: null, version: created.version + 1,
      })
      const active = await pool().query(
        'SELECT id FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE', [created.id],
      )
      expect(active.rows).toEqual([])
      const audit = await pool().query(
        `SELECT action, actor_id, from_status, to_status, from_version, to_version,
                metadata->>'nodeKey' AS node_key
         FROM approval_records WHERE instance_id = $1 AND action = 'revoke'`, [created.id],
      )
      expect(audit.rows).toEqual([{
        action: 'revoke', actor_id: requesterId, from_status: 'pending', to_status: 'revoked',
        from_version: created.version, to_version: created.version + 1, node_key: 'approval_a',
      }])
    }))

    it('RW_OTHER_ACTIONS: all eight non-revoke actions remain act-gated with unchanged business snapshots', async () => withDatabaseAuthentication(async () => {
      // A real active approver seat prevents assignment refusal from hiding a widened RBAC door.
      // Eight action arms, ONE test call.
      await assertWriterIdentity(approverId)
      const created = await freshPending()
      const actions = [
        { action: 'approve' },
        { action: 'reject', comment: 'synthetic' },
        { action: 'transfer', targetUserId: otherWriterId },
        { action: 'return', targetNodeKey: 'start' },
        { action: 'add_sign', targetUserIds: [otherWriterId], addSignMode: 'parallel' },
        { action: 'reduce_sign', targetAssignmentUserId: otherWriterId },
        { action: 'comment', comment: 'synthetic' },
        { action: 'handle', fieldWrites: {} },
      ]
      for (const body of actions) {
        const before = await snapshot(created.id)
        const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, tokenFor(approverId), {
          method: 'POST', body,
        })
        expect(response.status, body.action).toBe(403)
        expect(await response.json(), body.action).toEqual({ error: 'Insufficient permissions' })
        expect(await snapshot(created.id), body.action).toEqual(before)
      }
    }))

    it('RW_NOT_REQUESTER: same-org non-requester writer is refused by the requester guard without mutation', async () => withDatabaseAuthentication(async () => {
      await assertWriterIdentity(otherWriterId)
      const created = await freshPending()
      const before = await snapshot(created.id)
      const response = await revoke(tokenFor(otherWriterId), created.id)
      expect(response.status).toBe(403)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_REVOKE_FORBIDDEN')
      expect(await snapshot(created.id)).toEqual(before)
    }))

    it('RW_ORG_LOST: requester retaining write but only another active org cannot revoke, including forged org selectors', async () => withDatabaseAuthentication(async () => {
      const created = await freshPending()
      const before = await snapshot(created.id)
      try {
        await pool().query(
          'UPDATE user_orgs SET is_active = FALSE WHERE user_id = $1 AND org_id = $2', [requesterId, orgId],
        )
        await pool().query(
          'INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [requesterId, otherOrgId],
        )
        const memberships = await pool().query(
          'SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active = TRUE', [requesterId],
        )
        expect(memberships.rows).toEqual([{ org_id: otherOrgId }])
        await assertWriterIdentity(requesterId)
        // No selector, then body/header/both for the lost instance org AND the active
        // foreign org, plus one internal-marker spoof: EIGHT arms, ONE test call. A selected foreign org is not the instance org.
        const selectors: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [
          { body: {}, headers: {} },
          { body: { orgId }, headers: {} },
          { body: {}, headers: { 'x-org-id': orgId } },
          { body: { orgId }, headers: { 'x-org-id': orgId } },
          { body: { orgId: otherOrgId }, headers: {} },
          { body: {}, headers: { 'x-org-id': otherOrgId } },
          { body: { orgId: otherOrgId }, headers: { 'x-org-id': otherOrgId } },
          { body: { requesterRevokeRoute: false, actor: { requesterRevokeRoute: false } }, headers: {} },
        ]
        for (const selector of selectors) {
          const response = await fetch(`${baseUrl}/api/approvals/${created.id}/actions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${tokenFor(requesterId)}`, 'Content-Type': 'application/json',
              ...selector.headers,
            },
            body: JSON.stringify({ action: 'revoke', ...selector.body }),
          })
          expect(response.status, await response.clone().text()).toBe(403)
          expect(await snapshot(created.id)).toEqual(before)
        }
      } finally {
        await pool().query('DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2', [requesterId, otherOrgId])
        await pool().query(
          'UPDATE user_orgs SET is_active = TRUE WHERE user_id = $1 AND org_id = $2', [requesterId, orgId],
        )
      }
    }))

    it('ADMIN_NOT_REQUESTER: DB admin template author cannot revoke another requester instance', async () => withDatabaseAuthentication(async () => {
      const created = await freshPending()
      const before = await snapshot(created.id)
      const response = await revoke(tokenFor(adminId), created.id)
      expect(response.status).toBe(403)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('APPROVAL_REVOKE_FORBIDDEN')
      expect(await snapshot(created.id)).toEqual(before)
    }))

    it('ACT_ONLY_SELF: non-admin requester retains the existing act path after its write grant is removed', async () => withDatabaseAuthentication(async () => {
      const created = await freshPending()
      try {
        await pool().query("DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:write'", [requesterId])
        await pool().query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:act')", [requesterId])
        invalidateUserPerms(requesterId)
        const me = await jsonRequest(baseUrl, '/api/auth/me', tokenFor(requesterId))
        expect(me.status).toBe(200)
        const body = (await me.json()) as { data: { user: { role: string; permissions: string[] } } }
        expect(body.data.user.role).toBe('user')
        expect(body.data.user.permissions.filter((code) => code.startsWith('approvals:')).sort())
          .toEqual(['approvals:act', 'approvals:read'])
        const response = await revoke(tokenFor(requesterId), created.id)
        expect(response.status, await response.clone().text()).toBe(200)
        expect(await rawRow(created.id)).toEqual({
          status: 'revoked', current_node_key: null, version: created.version + 1,
        })
      } finally {
        await pool().query("DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:act'", [requesterId])
        await pool().query("INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING", [requesterId])
        invalidateUserPerms(requesterId)
      }
    }))

    it('NONLITERAL_REVOKE: arrays, objects, case and whitespace cannot use the requester exception', async () => withDatabaseAuthentication(async () => {
      await assertWriterIdentity(requesterId)
      const created = await freshPending()
      const before = await snapshot(created.id)
      for (const action of [['revoke'], { action: 'revoke' }, ' revoke', 'revoke ', 'REVOKE', null]) {
        const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, tokenFor(requesterId), {
          method: 'POST', body: { action },
        })
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ error: 'Insufficient permissions' })
        expect(await snapshot(created.id)).toEqual(before)
      }
    }))

    async function withOnlyForeignMembership(userId: string, operation: () => Promise<void>): Promise<void> {
      try {
        await pool().query('UPDATE user_orgs SET is_active = FALSE WHERE user_id = $1 AND org_id = $2', [userId, orgId])
        await pool().query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)', [userId, otherOrgId])
        const memberships = await pool().query('SELECT org_id FROM user_orgs WHERE user_id = $1 AND is_active = TRUE', [userId])
        expect(memberships.rows).toEqual([{ org_id: otherOrgId }])
        await operation()
      } finally {
        await pool().query('DELETE FROM user_orgs WHERE user_id = $1 AND org_id = $2', [userId, otherOrgId])
        await pool().query('UPDATE user_orgs SET is_active = TRUE WHERE user_id = $1 AND org_id = $2', [userId, orgId])
      }
    }

    it('EARLY_AUTH_NONREQUESTER: foreign writer cannot obtain node details through a fieldWrites rider or forged actor', async () => withDatabaseAuthentication(async () => {
      const created = await freshPending()
      const before = await snapshot(created.id)
      await withOnlyForeignMembership(otherWriterId, async () => {
        await assertWriterIdentity(otherWriterId)
        const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, tokenFor(otherWriterId), {
          method: 'POST',
          body: { action: 'revoke', fieldWrites: {}, actor: { userId: requesterId, roles: ['admin'] }, userId: requesterId },
        })
        expect(response.status, await response.clone().text()).toBe(403)
        const body = (await response.json()) as { error: { code: string; details?: unknown } }
        expect(body.error.code).toBe('APPROVAL_REVOKE_FORBIDDEN')
        expect(body.error).not.toHaveProperty('details')
        expect(await snapshot(created.id)).toEqual(before)
      })
    }))

    it('EARLY_AUTH_LOST_ORG: requester without instance-org membership cannot obtain node details through a fieldWrites rider', async () => withDatabaseAuthentication(async () => {
      const created = await freshPending()
      const before = await snapshot(created.id)
      await withOnlyForeignMembership(requesterId, async () => {
        await assertWriterIdentity(requesterId)
        const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, tokenFor(requesterId), {
          method: 'POST', body: { action: 'revoke', fieldWrites: {}, requesterRevokeRoute: false },
        })
        expect(response.status, await response.clone().text()).toBe(403)
        const body = (await response.json()) as { error: { code: string; details?: unknown } }
        expect(body.error.code).toBe('APPROVAL_REVOKE_FORBIDDEN')
        expect(body.error).not.toHaveProperty('details')
        expect(await snapshot(created.id)).toEqual(before)
      })
    }))

    it('EARLY_AUTH_OWNER_RIDER: authorized requester still receives the original misplaced-fieldWrites refusal without mutation', async () => withDatabaseAuthentication(async () => {
      const created = await freshPending()
      const before = await snapshot(created.id)
      const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, tokenFor(requesterId), {
        method: 'POST', body: { action: 'revoke', fieldWrites: {} },
      })
      expect(response.status).toBe(400)
      const body = (await response.json()) as { error: { code: string; details: { nodeKey: string } } }
      expect(body.error.code).toBe('APPROVAL_FIELD_WRITE_ACTION_NOT_ALLOWED')
      expect(body.error.details).toEqual({ nodeKey: 'approval_a' })
      expect(await snapshot(created.id)).toEqual(before)
    }))

    it('READ_ONLY_SELF: readable own pending instance is not revoke write authority', async () => withDatabaseAuthentication(async () => {
      const created = await freshPending(readerId)
      await pool().query(
        "DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:write'", [readerId],
      )
      invalidateUserPerms(readerId)
      const me = await jsonRequest(baseUrl, '/api/auth/me', tokenFor(readerId))
      expect(me.status).toBe(200)
      const body = (await me.json()) as { data: { user: { role: string; permissions: string[] } } }
      expect(body.data.user.role).toBe('user')
      expect(body.data.user.permissions.filter((code) => code.startsWith('approvals:'))).toEqual(['approvals:read'])
      const readable = await jsonRequest(baseUrl, `/api/approvals/${created.id}`, tokenFor(readerId))
      expect(readable.status).toBe(200)
      const before = await snapshot(created.id)
      const response = await revoke(tokenFor(readerId), created.id)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'Insufficient permissions' })
      expect(await snapshot(created.id)).toEqual(before)
    }))
  })
})
