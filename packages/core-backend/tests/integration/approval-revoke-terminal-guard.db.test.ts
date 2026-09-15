import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
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

  it('(a) legacy /approve: instance is terminal with a non-null current_node_key on this base, so this test also re-confirms the pre-existing-fixture premise the guard is closing', async () => {
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

    // PREMISE CHECK (not the fix under test): legacy /approve's UPDATE sets status only, so
    // current_node_key is still whatever it was before approval — confirming the node-key check
    // alone would not have rejected this instance.
    const afterApprove = await rawRow(created.id)
    expect(afterApprove.status).toBe('approved')
    expect(afterApprove.current_node_key).toBe('approval_a')

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

  it('(d) OBSERVATIONAL, not a design assertion: legacy /reject leaves current_node_key non-null the same way /approve does, and the new guard (status-based) covers it — recorded as-is', async () => {
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
    // /reject itself is out of scope for this change): the row is 'rejected' and current_node_key
    // is left as it was, same shape as legacy /approve.
    const afterReject = await rawRow(created.id)
    expect(afterReject.status).toBe('rejected')
    expect(afterReject.current_node_key).toBe('approval_a')

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
})
