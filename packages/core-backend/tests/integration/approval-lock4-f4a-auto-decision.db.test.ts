import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-4 §2 F4-A — node-level automatic decision (审批类型), real-DB acceptance (server door + full
 * create/dispatch flow). Source: `docs/development/approval-lock4-flow-policies-20260817.md`
 * (RATIFIED 2026-08-17) OD-L4-1(a), OD-L4-2(a), gates A-1, A-2, A-3.
 *
 * DB-INDEPENDENT logic (normalizeApprovalType Set membership, the publish-time placement choke
 * called in-process, and the executor's pure short-circuit behavior) is covered by the companion
 * `tests/unit/approval-lock4-f4a-auto-decision.test.ts` — this file proves the SAME behavior fires
 * through the real HTTP server + Postgres (the "server door"), and covers what genuinely needs a DB:
 * durable `approval_records` metadata, the `system:auto-approval` sentinel actor_id, and A-3's
 * dedupeHistoricalApprover / mergeAdjacentApprover history interactions (which read real audit rows).
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

describeIfDatabase('Lock-4 F4-A — node-level auto_approve (审批类型): server door + A-2/A-3 real-DB behavior', () => {
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

  async function tryCreateTemplate(adminToken: string, approvalGraph: object, label: string): Promise<Response> {
    const templateKey = `l4-f4a-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    return jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: { key: templateKey, name: 'Lock-4 F4-A', description: 'approval-lock4-flow-policies-20260817', formSchema: buildFormSchema(), approvalGraph },
    })
  }

  async function createTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const response = await tryCreateTemplate(adminToken, approvalGraph, label)
    expect(response.status, await response.clone().text()).toBe(201)
    const template = (await response.json()) as { id: string }
    createdTemplateIds.add(template.id)
    return template.id
  }

  async function publish(adminToken: string, templateId: string): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approval-templates/${templateId}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
  }

  async function publishGraphTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const templateId = await createTemplate(adminToken, approvalGraph, label)
    const publishResponse = await publish(adminToken, templateId)
    expect(publishResponse.status, await publishResponse.clone().text()).toBe(200)
    return templateId
  }

  async function createApproval(requesterToken: string, templateId: string): Promise<{ id: string; currentNodeKey: string | null; status: string; assignments: Array<{ assigneeId: string; nodeKey?: string | null }> }> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const inst = (await create.json()) as { id: string; currentNodeKey: string | null; status: string; assignments: Array<{ assigneeId: string; nodeKey?: string | null }> }
    createdApprovalIds.add(inst.id)
    return inst
  }

  async function act(token: string, instanceId: string, body: object): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, { method: 'POST', body })
  }

  async function grantWrite(userId: string): Promise<void> {
    grantedUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  async function recordsFor(instanceId: string): Promise<Array<{ action: string; actor_id: string; metadata: Record<string, unknown> | null }>> {
    const result = await pool().query(
      'SELECT action, actor_id, metadata FROM approval_records WHERE instance_id = $1 ORDER BY id ASC',
      [instanceId],
    )
    return result.rows as never
  }

  async function assignmentsFor(instanceId: string, nodeKey: string): Promise<Array<{ assignee_id: string }>> {
    const result = await pool().query(
      'SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND node_key = $2',
      [instanceId, nodeKey],
    )
    return result.rows as never
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // A-1 — server door (the SAME placement 400 the unit suite proves in-process, over real HTTP/DB)
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('A-1 server door: approvalType on a cc node 400s through the real HTTP/DB publish path (not merely in-process)', async () => {
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-a1`)
    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'cc1', type: 'cc', config: { targetType: 'role', targetIds: ['ops'], approvalType: 'auto_approve' } },
        { key: 'a1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'cc1' },
        { key: 'e2', source: 'cc1', target: 'a1' },
        { key: 'e3', source: 'a1', target: 'end' },
      ],
    }
    const response = await tryCreateTemplate(adminToken, graph, 'a1-cc')
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/config\.approvalType is not supported on a cc node/)
  })

  it('OD-L4-2(a) server door: approvalType:"auto_reject" 400s at publish through the real HTTP/DB path — RATIFIED "no inert third option"', async () => {
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-od2a`)
    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'a1', type: 'approval', config: { approvalType: 'auto_reject', approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'a1' },
        { key: 'e2', source: 'a1', target: 'end' },
      ],
    }
    const response = await tryCreateTemplate(adminToken, graph, 'od2a')
    expect(response.status).toBe(400)
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // A-2 — auto-pass behavior + byte-identical absent-config control, over real dispatch
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('A-2: an auto_approve node produces NO approval_assignments row and writes an "approve" record with actor_id=system:auto-approval and reason=auto-node-approve', async () => {
    const suffix = 'a2'
    const p = `l4-p-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'auto1', type: 'approval', config: { approvalType: 'auto_approve', approvalMode: 'single' } },
        { key: 'manual2', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'auto1' },
        { key: 'e2', source: 'auto1', target: 'manual2' },
        { key: 'e3', source: 'manual2', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)

    expect(inst.status).toBe('pending')
    expect(inst.currentNodeKey).toBe('manual2')
    expect(inst.assignments.map((a) => a.assigneeId)).toEqual([p])

    expect(await assignmentsFor(inst.id, 'auto1')).toEqual([])

    const records = await recordsFor(inst.id)
    const autoRow = records.find((r) => r.metadata?.reason === 'auto-node-approve')
    expect(autoRow).toBeTruthy()
    expect(autoRow!.action).toBe('approve')
    expect(autoRow!.actor_id).toBe('system:auto-approval')
    expect(autoRow!.metadata?.nodeKey).toBe('auto1')
    // X-4 values-free: no assignee/person id leaks into the auto-pass record's metadata.
    expect(JSON.stringify(autoRow!.metadata)).not.toContain(p)

    // Finish the flow to prove the instance completes normally afterward.
    const approveResponse = await act(pTok, inst.id, { action: 'approve' })
    expect(approveResponse.status, await approveResponse.clone().text()).toBe(200)
    const finalBody = (await approveResponse.json()) as { status: string }
    expect(finalBody.status).toBe('approved')
  })

  it('CONTROL (byte-identical absent config) — the IDENTICAL graph with approvalType ABSENT on auto1 holds pending AT auto1, requiring a genuine approve before manual2 is ever reached', async () => {
    const suffix = 'a2-ctl'
    const p1 = `l4-p1-${TS}-${suffix}`
    const p2 = `l4-p2-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'auto1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p1], approvalMode: 'single' } },
        { key: 'manual2', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p2], approvalMode: 'single' } },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'auto1' },
        { key: 'e2', source: 'auto1', target: 'manual2' },
        { key: 'e3', source: 'manual2', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.status).toBe('pending')
    expect(inst.currentNodeKey).toBe('auto1')
    expect(inst.assignments.map((a) => a.assigneeId)).toEqual([p1])
    const records = await recordsFor(inst.id)
    expect(records.some((r) => r.metadata?.reason === 'auto-node-approve')).toBe(false)
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // A-3 — no historical residue: dedupeHistoricalApprover is UNAFFECTED by an intervening
  // auto_approve node (it searches history filtered by actor id, so the system-sentinel event
  // is skipped rather than shielding anything), while mergeAdjacentApprover — whose search has
  // NO actor filter, only a same-node exclusion — IS suppressed by the same sentinel event
  // becoming the new "latest" entry. This asymmetry was caught empirically (real-DB CI run,
  // 2026-08-19): the original draft of the dedupeHistoricalApprover test asserted the WRONG
  // outcome ('pending') by wrongly assuming both policies share mergeAdjacentApprover's strict
  // positional-adjacency semantics. `findLatestApprovalHistory` (ApprovalProductService.ts) is
  // a single shared backward-search helper; dedupeHistoricalApprover's caller passes a predicate
  // that includes `entry.actorId === assignment.assigneeId`, so it walks PAST the sentinel event
  // to find P's earlier manual1 approval — this is pre-existing dedup behavior, not something
  // F4-A changes; F4-A only adds a new kind of history entry that this pre-existing search must
  // (and correctly does) skip when it doesn't match the actor filter.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // P2-2 fix (gate 20260819): the ratified A-3 property — "after an auto_approve node, a later
  // node assigned to any real user is NOT auto-approved by dedupeHistoricalApprover" with its
  // control "a genuine human approval at that same position DOES trigger the dedup" — was never
  // actually constructed below: the shipped pair below puts P's GENUINE approval BEFORE the auto
  // node, so dedupeHistoricalApprover's actor-filtered search always has a real P-authored entry
  // to walk back to regardless of the auto node's presence, and the "control" removes the auto
  // node and asserts the SAME outcome — zero discriminating power. This pair makes the auto-node
  // event the ONLY prior history entry (nothing else to dedupe against), which is the actual bar:
  // the F4-A sentinel row carries no `originalApprover` / actor identity for P, so it must NOT be
  // mistaken for a real P approval by the dedup search.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('A-3 (RATIFIED): dedupeHistoricalApprover does NOT auto-approve manual2 when the auto_approve node is the ONLY prior history entry (the sentinel carries no P identity to dedupe against)', async () => {
    const suffix = 'a3-ratified'
    const p = `l4-p-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'auto1', type: 'approval', config: { approvalType: 'auto_approve', approvalMode: 'single' } },
        {
          key: 'manual2',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: [p],
            approvalMode: 'single',
            autoApprovalPolicy: { dedupeHistoricalApprover: true, mergeAdjacentApprover: true },
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'auto1' },
        { key: 'e2', source: 'auto1', target: 'manual2' },
        { key: 'e3', source: 'manual2', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    // NOT auto-approved away: manual2 stays pending, seat held by P, requiring a genuine action.
    expect(inst.status).toBe('pending')
    expect(inst.currentNodeKey).toBe('manual2')
    expect(inst.assignments.map((a) => a.assigneeId)).toEqual([p])

    const finish = await act(pTok, inst.id, { action: 'approve' })
    expect(finish.status, await finish.clone().text()).toBe(200)
    expect(((await finish.json()) as { status: string }).status).toBe('approved')
  })

  it('CONTROL for RATIFIED A-3 — replacing auto1 with a node P GENUINELY approves DOES trigger dedupeHistoricalApprover at manual2 (the exemption is event-selected, not position-selected)', async () => {
    const suffix = 'a3-ratified-ctl'
    const p = `l4-p-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'manual1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
        {
          key: 'manual2',
          type: 'approval',
          config: {
            assigneeType: 'user',
            assigneeIds: [p],
            approvalMode: 'single',
            autoApprovalPolicy: { dedupeHistoricalApprover: true, mergeAdjacentApprover: true },
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'manual1' },
        { key: 'e2', source: 'manual1', target: 'manual2' },
        { key: 'e3', source: 'manual2', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.currentNodeKey).toBe('manual1')

    const afterFirst = await act(pTok, inst.id, { action: 'approve' })
    expect(afterFirst.status, await afterFirst.clone().text()).toBe(200)
    const afterFirstBody = (await afterFirst.json()) as { status: string; currentNodeKey: string | null }
    // A GENUINE P approval at the same position DOES dedupe manual2 away in the same request.
    expect(afterFirstBody.status).toBe('approved')
    expect(afterFirstBody.currentNodeKey).toBeNull()
  })

  it('REGRESSION PIN (asymmetry, not A-3 acceptance): dedupeHistoricalApprover\'s actor-filtered search skips an intervening auto_approve sentinel and finds P\'s EARLIER genuine approval', async () => {
    const suffix = 'a3-dedupe'
    const p = `l4-p-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'manual1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
        { key: 'auto2', type: 'approval', config: { approvalType: 'auto_approve', approvalMode: 'single' } },
        {
          key: 'manual3',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single', autoApprovalPolicy: { dedupeHistoricalApprover: true } },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'manual1' },
        { key: 'e2', source: 'manual1', target: 'auto2' },
        { key: 'e3', source: 'auto2', target: 'manual3' },
        { key: 'e4', source: 'manual3', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.currentNodeKey).toBe('manual1')

    const afterFirst = await act(pTok, inst.id, { action: 'approve' })
    expect(afterFirst.status, await afterFirst.clone().text()).toBe(200)
    const afterFirstBody = (await afterFirst.json()) as { status: string; currentNodeKey: string | null }
    // Deduped: manual1's approval by P, auto2's sentinel event (skipped — actor mismatch), then
    // manual3's dedupeHistoricalApprover finds P's manual1 approval and auto-completes the instance
    // in the SAME request — no second `act` call is reachable, there is no pending seat left.
    expect(afterFirstBody.status).toBe('approved')
    expect(afterFirstBody.currentNodeKey).toBeNull()
  })

  it('REGRESSION PIN control — WITHOUT the auto_approve node in between, dedupeHistoricalApprover produces the IDENTICAL outcome (auto2\'s presence makes no observable difference to this policy; NOT an A-3 discriminator — see the RATIFIED pair above for that)', async () => {
    const suffix = 'a3-dedupe-ctl'
    const p = `l4-p-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'manual1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
        {
          key: 'manual3',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single', autoApprovalPolicy: { dedupeHistoricalApprover: true } },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'manual1' },
        { key: 'e2', source: 'manual1', target: 'manual3' },
        { key: 'e3', source: 'manual3', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.currentNodeKey).toBe('manual1')

    const afterFirst = await act(pTok, inst.id, { action: 'approve' })
    expect(afterFirst.status, await afterFirst.clone().text()).toBe(200)
    const afterFirstBody = (await afterFirst.json()) as { status: string }
    expect(afterFirstBody.status).toBe('approved')
  })

  it('DISCLOSED SIDE EFFECT (pinned, not merely narrated) — an auto_approve node between two same-person nodes SUPPRESSES mergeAdjacentApprover at the following node (it becomes the LATEST history entry, under the system sentinel)', async () => {
    const suffix = 'a3-adjacent'
    const p = `l4-p-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'manual1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
        { key: 'auto2', type: 'approval', config: { approvalType: 'auto_approve', approvalMode: 'single' } },
        {
          key: 'manual3',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single', autoApprovalPolicy: { mergeAdjacentApprover: true } },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'manual1' },
        { key: 'e2', source: 'manual1', target: 'auto2' },
        { key: 'e3', source: 'auto2', target: 'manual3' },
        { key: 'e4', source: 'manual3', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    const afterFirst = await act(pTok, inst.id, { action: 'approve' })
    expect(afterFirst.status, await afterFirst.clone().text()).toBe(200)
    const afterFirstBody = (await afterFirst.json()) as { status: string; currentNodeKey: string | null }
    // SUPPRESSED: still pending at manual3 — mergeAdjacentApprover's "latest entry" is auto2's
    // system:auto-approval row, not P's manual1 approval, so no merge fires.
    expect(afterFirstBody.status).toBe('pending')
    expect(afterFirstBody.currentNodeKey).toBe('manual3')
    const finalApprove = await act(pTok, inst.id, { action: 'approve' })
    expect(finalApprove.status).toBe(200)
  })

  it('POSITIVE CONTROL for the side effect — WITHOUT the auto_approve node, mergeAdjacentApprover DOES merge manual3 into manual1\'s approval (the shipped precedent, unaffected by F4-A)', async () => {
    const suffix = 'a3-adjacent-ctl'
    const p = `l4-p-${TS}-${suffix}`
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const pTok = await authToken(baseUrl, p)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'manual1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single' } },
        {
          key: 'manual3',
          type: 'approval',
          config: { assigneeType: 'user', assigneeIds: [p], approvalMode: 'single', autoApprovalPolicy: { mergeAdjacentApprover: true } },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'manual1' },
        { key: 'e2', source: 'manual1', target: 'manual3' },
        { key: 'e3', source: 'manual3', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    const afterFirst = await act(pTok, inst.id, { action: 'approve' })
    expect(afterFirst.status, await afterFirst.clone().text()).toBe(200)
    expect(((await afterFirst.json()) as { status: string }).status).toBe('approved')
  })
})
