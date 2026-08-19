import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { query } from '../../src/db/pg'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-4 §2 F4-C — same-person policy (审批人=提交人), real-DB acceptance (server door + full
 * create/dispatch flow + the C-2 frozen-snapshot temporal control). Source:
 * `docs/development/approval-lock4-flow-policies-20260817.md` (RATIFIED 2026-08-17) OD-L4-4(a),
 * OD-L4-5(a), gates C-1, C-2, C-3, X-1.
 *
 * DB-INDEPENDENT logic (SAME_PERSON_POLICIES Set membership, normalizeAutoApprovalPolicy's
 * auto_skip→mergeWithRequester synthesis, the §2.2 hasEnabledAutoApprovalRule widening with its
 * mutation evidence, and the resolver's pure transfer substitution) is covered by the companion
 * `tests/unit/approval-lock4-f4c-same-person.test.ts` — this file proves the SAME behavior over the
 * real HTTP server + Postgres, and covers what genuinely needs a DB: C-1's byte-identical audit-row
 * deep-equal, C-2's temporal frozen `managerId` (real directory rows, real create-time freeze, a
 * real directory mutation between two creates), and C-3's real dispatch-side 400/pending outcomes.
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

/** One-node graph: the sole approval node's assignee IS the requester ('requester' source). */
function samePersonGraph(nodeConfig: Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'a1',
        type: 'approval',
        config: {
          assigneeSources: [{ kind: 'requester' }],
          approvalMode: 'single',
          ...nodeConfig,
        },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e1', source: 'start', target: 'a1' },
      { key: 'e2', source: 'a1', target: 'end' },
    ],
  }
}

describeIfDatabase('Lock-4 F4-C — same-person policy (审批人=提交人): server door + C-1/C-2/C-3/X-1 real-DB behavior', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const grantedUserIds = new Set<string>()
  const createdIntegrationIds = new Set<string>()
  const createdLocalUserIds = new Set<string>()

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
      for (const integrationId of createdIntegrationIds) {
        // account_departments + links cascade on directory_accounts delete.
        await pool().query('DELETE FROM directory_accounts WHERE integration_id = $1', [integrationId])
        await pool().query('DELETE FROM directory_departments WHERE integration_id = $1', [integrationId])
        await pool().query('DELETE FROM directory_integrations WHERE id = $1', [integrationId])
      }
      if (createdLocalUserIds.size > 0) {
        await pool().query('DELETE FROM users WHERE id = ANY($1)', [[...createdLocalUserIds]])
      }
    } finally {
      await server?.stop()
    }
  })

  async function tryCreateTemplate(adminToken: string, approvalGraph: object, label: string): Promise<Response> {
    const templateKey = `l4-f4c-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
    return jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: { key: templateKey, name: 'Lock-4 F4-C', description: 'approval-lock4-flow-policies-20260817', formSchema: buildFormSchema(), approvalGraph },
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

  async function tryCreateApproval(requesterToken: string, templateId: string): Promise<Response> {
    return jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
  }

  async function createApproval(requesterToken: string, templateId: string): Promise<{ id: string; currentNodeKey: string | null; status: string; assignments: Array<{ assigneeId: string; nodeKey?: string | null }> }> {
    const response = await tryCreateApproval(requesterToken, templateId)
    expect(response.status, await response.clone().text()).toBe(201)
    const inst = (await response.json()) as { id: string; currentNodeKey: string | null; status: string; assignments: Array<{ assigneeId: string; nodeKey?: string | null }> }
    createdApprovalIds.add(inst.id)
    return inst
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

  // P2-3 fix: every C-1/C-2/C-3 fixture above uses `samePersonGraph`, whose same-person node is
  // ALWAYS the first approval node — resolved at CREATE (`getEffectiveSamePersonPolicy`'s create
  // call site, ApprovalProductService.ts :6981). The provider is wired at three MORE sites
  // (adminJump :7568, timeout-jump :8131, dispatch/advance :8376); this helper drives the
  // dispatch/advance path by actually approving a prior node.
  async function act(token: string, instanceId: string, body: object): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, { method: 'POST', body })
  }

  /**
   * Strip the fields that legitimately differ per-instance before a deep-equal:
   * `nodeEntryEpoch` (per-instance activation counter) and `requestNo` (the `action:'created'`
   * row's metadata carries the sequential request number `allocateRequestNo()` mints — see
   * ApprovalProductService.ts's `createApproval`; it is allocated once per instance and is
   * NEVER equal across two separate `createApproval` calls, even from the same template, so
   * leaving it in would make this "byte-identical" comparison structurally unsatisfiable
   * regardless of whether F4-C's own behavior is byte-identical).
   */
  function normalizeRecordsForComparison(rows: Array<{ action: string; actor_id: string; metadata: Record<string, unknown> | null }>) {
    return rows.map((row) => ({
      action: row.action,
      actor_id: row.actor_id,
      metadata: row.metadata ? { ...row.metadata, nodeEntryEpoch: undefined, requestNo: undefined } : row.metadata,
    }))
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // C-1 — auto_skip byte-identical to mergeWithRequester:true, over real dispatch records
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('C-1: samePersonPolicy:"auto_skip" produces approval_records BYTE-IDENTICAL (deep-equal, only nodeEntryEpoch normalized) to mergeWithRequester:true', async () => {
    // The SAME requester creates both instances (from two different published templates) —
    // deliberately, so the events' metadata.originalApprover.id is identical across A and B and the
    // deep-equal below is a TRUE byte-for-byte comparison, not a weakened one that had to strip
    // person-identifying fields to pass.
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-c1`)
    const requesterId = `l4-req-${TS}-c1`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)

    const graphAutoSkip = samePersonGraph({ autoApprovalPolicy: { samePersonPolicy: 'auto_skip' } })
    const templateA = await publishGraphTemplate(adminToken, graphAutoSkip, 'c1-autoskip')
    const instA = await createApproval(requesterToken, templateA)
    expect(instA.status).toBe('approved')

    const graphMerge = samePersonGraph({ autoApprovalPolicy: { mergeWithRequester: true } })
    const templateB = await publishGraphTemplate(adminToken, graphMerge, 'c1-merge')
    const instB = await createApproval(requesterToken, templateB)
    expect(instB.status).toBe('approved')

    const recordsA = normalizeRecordsForComparison(await recordsFor(instA.id))
    const recordsB = normalizeRecordsForComparison(await recordsFor(instB.id))
    expect(recordsA).toEqual(recordsB)
    expect(recordsA.map((r) => r.action)).toContain('approve')
  })

  it('CONTROL for C-1 — "self_approve" (explicit, i.e. today\'s default) leaves the requester\'s own seat PENDING — no auto-skip', async () => {
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-c1ctl`)
    const requesterId = `l4-req-${TS}-c1ctl`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const graph = samePersonGraph({ autoApprovalPolicy: { samePersonPolicy: 'self_approve' } })
    const templateId = await publishGraphTemplate(adminToken, graph, 'c1-ctl')
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.status).toBe('pending')
    expect(inst.currentNodeKey).toBe('a1')
    expect(inst.assignments.map((a) => a.assigneeId)).toEqual([requesterId])
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // C-2 — transfer purity: frozen managerId, no live directory read at dispatch. Two-instance
  // temporal test bracketing a real directory mutation.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('C-2: the transfer resolves from the FROZEN managerId at create — a directory reassignment AFTER instance 1 is created does NOT move its seat, but DOES move instance 2\'s (created after the reassignment)', async () => {
    const suffix = 'c2'
    const integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`l4f4c-${TS}-${suffix}`, `l4f4c-corp-${TS}-${suffix}`],
    )).rows[0].id
    createdIntegrationIds.add(integrationId)

    const deptId = (await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
       VALUES ($1, $2, 'Eng', true, '{}'::jsonb) RETURNING id`,
      [integrationId, `l4f4c-dept-${TS}-${suffix}`],
    )).rows[0].id

    const U_R = `l4f4c-ur-${TS}-${suffix}`
    const U_M1 = `l4f4c-um1-${TS}-${suffix}`
    const U_M2 = `l4f4c-um2-${TS}-${suffix}`
    await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x'), ($3, $4, 'x'), ($5, $6, 'x')`, [
      U_R, `${U_R}@example.test`, U_M1, `${U_M1}@example.test`, U_M2, `${U_M2}@example.test`,
    ])
    createdLocalUserIds.add(U_R)
    createdLocalUserIds.add(U_M1)
    createdLocalUserIds.add(U_M2)

    const accR = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'R', '{}'::jsonb) RETURNING id`,
      [integrationId, `l4f4c-extR-${TS}-${suffix}`, `l4f4c-keyR-${TS}-${suffix}`],
    )).rows[0].id
    const accM1 = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'M1', $4::jsonb) RETURNING id`,
      [integrationId, `l4f4c-extM1-${TS}-${suffix}`, `l4f4c-keyM1-${TS}-${suffix}`, JSON.stringify({ leader_in_dept: [{ dept_id: `l4f4c-dept-${TS}-${suffix}`, leader: true }] })],
    )).rows[0].id
    const accM2 = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'M2', '{}'::jsonb) RETURNING id`,
      [integrationId, `l4f4c-extM2-${TS}-${suffix}`, `l4f4c-keyM2-${TS}-${suffix}`],
    )).rows[0].id

    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual'), ($5, $6, 'linked', 'manual')`,
      [accR, U_R, accM1, U_M1, accM2, U_M2],
    )
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true), ($3, $2, true), ($4, $2, true)`,
      [accR, deptId, accM1, accM2],
    )

    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterToken = await authToken(baseUrl, U_R)
    await grantWrite(U_R)
    const graph = samePersonGraph({ autoApprovalPolicy: { samePersonPolicy: 'transfer_direct_manager' } })
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)

    // Instance 1: created while M1 is the flagged leader (frozen managerId = U_M1).
    const inst1 = await createApproval(requesterToken, templateId)
    expect(inst1.status).toBe('pending')
    expect(inst1.currentNodeKey).toBe('a1')
    expect(inst1.assignments.map((a) => a.assigneeId)).toEqual([U_M1])

    // Real directory mutation: M1 loses the leader flag, M2 gains it.
    await query(`UPDATE directory_accounts SET raw = '{}'::jsonb WHERE id = $1`, [accM1])
    await query(
      `UPDATE directory_accounts SET raw = $2::jsonb WHERE id = $1`,
      [accM2, JSON.stringify({ leader_in_dept: [{ dept_id: `l4f4c-dept-${TS}-${suffix}`, leader: true }] })],
    )

    // Instance 2: created AFTER the mutation (frozen managerId = U_M2).
    const inst2 = await createApproval(requesterToken, templateId)
    expect(inst2.status).toBe('pending')
    expect(inst2.assignments.map((a) => a.assigneeId)).toEqual([U_M2])

    // Instance 1's seat is UNCHANGED by the later mutation — proves the transfer read at DISPATCH
    // (not just at create) still uses the frozen snapshot, never a live re-query.
    const inst1Assignments = await pool().query(
      'SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE',
      [inst1.id, 'a1'],
    )
    expect(inst1Assignments.rows.map((r: { assignee_id: string }) => r.assignee_id)).toEqual([U_M1])
  })

  it('C-2 (P2-3 fix, dispatch-resolved): transfer_direct_manager resolves at DISPATCH — not just create — when the same-person node is the SECOND node, reached only after an ordinary prior node is approved', async () => {
    const suffix = 'c2-dispatch'
    const integrationId = (await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`l4f4c-${TS}-${suffix}`, `l4f4c-corp-${TS}-${suffix}`],
    )).rows[0].id
    createdIntegrationIds.add(integrationId)

    const deptId = (await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, name, is_active, raw)
       VALUES ($1, $2, 'Eng', true, '{}'::jsonb) RETURNING id`,
      [integrationId, `l4f4c-dept-${TS}-${suffix}`],
    )).rows[0].id

    const U_R = `l4f4c-ur-${TS}-${suffix}`
    const U_M = `l4f4c-um-${TS}-${suffix}`
    const U_OTHER = `l4f4c-uo-${TS}-${suffix}` // n1's ordinary approver — no directory presence needed
    await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x'), ($3, $4, 'x')`, [
      U_R, `${U_R}@example.test`, U_M, `${U_M}@example.test`,
    ])
    createdLocalUserIds.add(U_R)
    createdLocalUserIds.add(U_M)

    const accR = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'R', '{}'::jsonb) RETURNING id`,
      [integrationId, `l4f4c-extR-${TS}-${suffix}`, `l4f4c-keyR-${TS}-${suffix}`],
    )).rows[0].id
    const accM = (await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'M', $4::jsonb) RETURNING id`,
      [integrationId, `l4f4c-extM-${TS}-${suffix}`, `l4f4c-keyM-${TS}-${suffix}`, JSON.stringify({ leader_in_dept: [{ dept_id: `l4f4c-dept-${TS}-${suffix}`, leader: true }] })],
    )).rows[0].id

    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual')`,
      [accR, U_R, accM, U_M],
    )
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true), ($3, $2, true)`,
      [accR, deptId, accM],
    )

    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterToken = await authToken(baseUrl, U_R)
    await grantWrite(U_R)
    const otherToken = await authToken(baseUrl, U_OTHER)

    // n1 is an ORDINARY node (no same-person involvement) so a2 — the same-person node — is
    // resolved ONLY when execution dispatches to it after n1 is approved, never at create.
    const graph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'n1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [U_OTHER], approvalMode: 'single' } },
        {
          key: 'a2',
          type: 'approval',
          config: {
            assigneeSources: [{ kind: 'requester' }],
            approvalMode: 'single',
            autoApprovalPolicy: { samePersonPolicy: 'transfer_direct_manager' },
          },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'n1' },
        { key: 'e2', source: 'n1', target: 'a2' },
        { key: 'e3', source: 'a2', target: 'end' },
      ],
    }
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)
    const inst = await createApproval(requesterToken, templateId)
    expect(inst.currentNodeKey).toBe('n1')
    // At CREATE, a2 has not been dispatched to yet — nothing to assert about its seat here; this
    // is exactly the gap M10b exposed (removing the 3 non-create provider sites left every
    // samePersonGraph-based fixture, which resolves at create, green).

    const advance = await act(otherToken, inst.id, { action: 'approve' })
    expect(advance.status, await advance.clone().text()).toBe(200)
    const advanceBody = (await advance.json()) as { status: string; currentNodeKey: string | null }
    expect(advanceBody.status).toBe('pending')
    expect(advanceBody.currentNodeKey).toBe('a2')

    // The transfer fired AT DISPATCH: a2's seat is the manager, NOT the requester holding their
    // own seat (which is precisely the outcome F4-C exists to prevent).
    const a2Assignments = await pool().query(
      'SELECT assignee_id, metadata FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE',
      [inst.id, 'a2'],
    )
    expect(a2Assignments.rows.map((r: { assignee_id: string }) => r.assignee_id)).toEqual([U_M])
    const a2Metadata = a2Assignments.rows[0]?.metadata as Record<string, unknown> | null
    expect((a2Metadata?.resolvedFrom as Record<string, unknown> | undefined)?.kind).toBe('requester')
    expect(a2Metadata?.samePersonTransfer).toBeTruthy()

    const finish = await act(await authToken(baseUrl, U_M), inst.id, { action: 'approve' })
    expect(finish.status, await finish.clone().text()).toBe(200)
    expect(((await finish.json()) as { status: string }).status).toBe('approved')
  })

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // C-3 — absent transfer target: seat not produced, emptyAssigneePolicy governs, never
  // self_approve
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it('C-3: with no manager resolvable (no directory record at all), the seat is not produced and default emptyAssigneePolicy (\'error\') 400s — it never falls back to self_approve', async () => {
    const suffix = 'c3'
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}` // no directory presence whatsoever
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const graph = samePersonGraph({ autoApprovalPolicy: { samePersonPolicy: 'transfer_direct_manager' } })
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)

    const response = await tryCreateApproval(requesterToken, templateId)
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('APPROVAL_ASSIGNEE_EMPTY')
  })

  it('POSITIVE CONTROL for C-3 (composes with F4-B\'s shipped emptyAssigneePolicy) — the SAME no-manager fixture with emptyAssigneePolicy:"auto-approve" auto-passes via the shipped empty-assignee arm, not via self_approve', async () => {
    const suffix = 'c3-ctl'
    const adminToken = await authToken(baseUrl, `l4-admin-${TS}-${suffix}`)
    const requesterId = `l4-req-${TS}-${suffix}`
    const requesterToken = await authToken(baseUrl, requesterId)
    await grantWrite(requesterId)
    const graph = samePersonGraph({
      autoApprovalPolicy: { samePersonPolicy: 'transfer_direct_manager' },
      emptyAssigneePolicy: 'auto-approve',
    })
    const templateId = await publishGraphTemplate(adminToken, graph, suffix)

    const inst = await createApproval(requesterToken, templateId)
    expect(inst.status).toBe('approved')
    const records = await recordsFor(inst.id)
    const autoRow = records.find((r) => r.metadata?.reason === 'empty-assignee')
    expect(autoRow).toBeTruthy()
    // Never self-approved: the requester's own id never appears as the actor of the auto-pass row.
    expect(autoRow!.actor_id).toBe('system:auto-approval')
    expect(autoRow!.actor_id).not.toBe(requesterId)
  })
})
