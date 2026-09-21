import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * The legacy decision endpoints (`POST /api/approvals/:id/approve`, `.../reject`) must SETTLE a
 * template-runtime instance the same way `POST /api/approvals/:id/actions` settles it — over real
 * HTTP and a real database.
 *
 * ### The defect this pins
 *
 * The legacy doors used to write the terminal status and the audit row themselves, with raw SQL,
 * for EVERY platform instance — including the ones the template runtime owns. For a runtime
 * instance that is not a decision at all, it is a bare status flip:
 *
 *   * the node cursor is never advanced — `current_node_key` keeps pointing at the node that was
 *     just decided, so on an `A -> B` graph a seated approver at A could mark the whole instance
 *     `approved` with **B never decided**;
 *   * the settled node's seats stay ACTIVE and the next node's seats are never created;
 *   * no completion event is built, enqueued or emitted, so none of the three completion consumers
 *     (`approval-bridge`, `approval-trigger`, `approval-projection` —
 *     `multitable/automation-routing-manifest.ts`) and none of the record form write-back ever
 *     hears that the instance ended;
 *   * no terminal / node-decision metric is recorded, so `approval_metrics` keeps describing the
 *     instance as in flight forever.
 *
 * ### How each case discriminates
 *
 * The parity cases are DIFFERENTIAL: two sibling instances of ONE published template, same
 * requester, same seated approver, decided with the same intent — one through the legacy door, one
 * through `/actions` — then compared field by field after normalising the two things that must
 * differ (generated ids and timestamps). `expect(legacy).toEqual(actions)` over a normalised
 * snapshot is the assertion; `comparedLeafFields` is asserted to be non-trivial so the comparison
 * cannot silently degrade into comparing two empty objects.
 *
 * Differential equality alone would still hold if BOTH doors regressed together, so every parity
 * case is paired with an ABSOLUTE case that names the post-state the settlement must reach
 * (`(S1)`/`(S2)`), and `(S2)` additionally closes the loop the private finding opened: an instance
 * that reached `approved` through the legacy door can no longer be revoked, because the cursor is
 * actually cleared now rather than left pointing at a live node.
 *
 * The `(F…)` cases are the forgery family from the seat/attribution slice's own probe, re-run
 * against the settlement path: they are same-family RECONSTRUCTIONS of those probes in this file's
 * fixture vocabulary, not the original fixture, and each one says which shape it stands for.
 *
 * Requires real PostgreSQL: every assertion reads `approval_instances`, `approval_assignments`,
 * `approval_records` or `approval_metrics` back.
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

function buildFormSchema() {
  return { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] }
}

/** A(p) -> B(q) -> end. */
function twoStepGraph(
  a: { assigneeType: 'user' | 'role'; assigneeIds: string[] },
  b: { assigneeType: 'user' | 'role'; assigneeIds: string[] },
) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { ...a, approvalMode: 'single' } },
      { key: 'approval_b', type: 'approval', config: { ...b, approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
      { key: 'e-b-end', source: 'approval_b', target: 'end' },
    ],
  }
}

/**
 * A(p) -> B(q) -> end with a `nodeOperationPolicy` on A. Same shape the Lock-5 §1.3 suite
 * (`approval-comment-required.db.test.ts`) publishes, so the policy is carried the way the shipped
 * publisher carries it rather than hand-inserted.
 */
function twoStepGraphWithNodePolicy(
  a: { assigneeType: 'user' | 'role'; assigneeIds: string[] },
  b: { assigneeType: 'user' | 'role'; assigneeIds: string[] },
  nodeOperationPolicy: Record<string, unknown>,
) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { ...a, approvalMode: 'single', nodeOperationPolicy } },
      { key: 'approval_b', type: 'approval', config: { ...b, approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
      { key: 'e-b-end', source: 'approval_b', target: 'end' },
    ],
  }
}

/** A(p) -> end. One node, so a single decision IS the terminal one. */
function oneStepGraph(a: { assigneeType: 'user' | 'role'; assigneeIds: string[] }) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { ...a, approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-end', source: 'approval_a', target: 'end' },
    ],
  }
}

type Snapshot = {
  instance: Record<string, unknown>
  assignments: Array<Record<string, unknown>>
  records: Array<Record<string, unknown>>
  metrics: Record<string, unknown>
}

/** Every leaf value in a snapshot — the size of the differential, asserted so it cannot go vacuous. */
function countLeaves(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, entry) => sum + countLeaves(entry), 0)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce((sum: number, entry) => sum + countLeaves(entry), 0)
  }
  return 1
}

describeIfDatabase('legacy /approve + /reject settle through the same path as /actions', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const seededUserIds = new Set<string>()

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
      if (seededUserIds.size > 0) {
        const ids = [...seededUserIds]
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [ids])
        await pool().query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ids])
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [ids])
      }
    } finally {
      await server?.stop()
    }
  })

  function freshId(label: string): string {
    return `lgset-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
  }

  async function authToken(userId: string, roles = 'member'): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent('*:*')}`,
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { token: string }
    return payload.token
  }

  async function grantWrite(userId: string): Promise<void> {
    seededUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  async function publishTemplate(adminToken: string, graph: unknown, name: string): Promise<string> {
    const response = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: freshId(`tpl-${name}`),
        name: 'legacy decision settlement parity',
        description: 'fix/approval-legacy-approve-settlement-parity',
        formSchema: buildFormSchema(),
        approvalGraph: graph,
      },
    })
    expect(response.status, await response.clone().text()).toBe(201)
    const template = (await response.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const published = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      // `allowRevoke` matters for (S2): the revoke attempt there must be refused by the TERMINAL
      // guard, not by a policy that never allowed revoking in the first place.
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)
    return template.id
  }

  async function createApproval(requesterToken: string, templateId: string): Promise<{ id: string; version: number }> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const instance = (await create.json()) as { id: string }
    createdApprovalIds.add(instance.id)
    const row = await pool().query<{ version: number }>(
      'SELECT version FROM approval_instances WHERE id = $1',
      [instance.id],
    )
    return { id: instance.id, version: row.rows[0].version }
  }

  async function instanceRow(instanceId: string): Promise<{
    status: string
    version: number
    current_node_key: string | null
    current_step: number | null
    total_steps: number | null
  }> {
    const result = await pool().query(
      'SELECT status, version, current_node_key, current_step, total_steps FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    return result.rows[0] as never
  }

  async function recordCount(instanceId: string): Promise<number> {
    const result = await pool().query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM approval_records WHERE instance_id = $1',
      [instanceId],
    )
    return Number(result.rows[0].n)
  }

  type MetricsRow = { terminal_state: string | null; terminal_at: Date | null; node_breakdown: unknown }

  function decidedNodeKeys(metrics: MetricsRow): string[] {
    const breakdown = Array.isArray(metrics.node_breakdown)
      ? (metrics.node_breakdown as Array<Record<string, unknown>>)
      : []
    return breakdown.filter((entry) => entry.decidedAt != null).map((entry) => String(entry.nodeKey)).sort()
  }

  /**
   * BOTH metric writes are POST-COMMIT and NOT awaited by the service (a metrics outage must never
   * fail a committed decision — `safeMetricsCall`), so `node_breakdown[].decidedAt`
   * (`emitNodeDecisionMetric`) and `terminal_state` (`emitTerminalMetric`) can each land a beat
   * after the HTTP response, in either order. Anything that READS them must poll, or the
   * comparison is a race whose likeliest loser is whichever instance was decided last — and in a
   * differential that shows up as a spurious inequality, not as a missing write.
   *
   * Polling, never sleeping: the caller asserts on whatever this returns, so a genuinely absent
   * write still fails the case on its own assertion instead of hanging it.
   */
  async function awaitMetrics(
    instanceId: string,
    want: { decided?: boolean; terminal?: boolean },
    timeoutMs = 5000,
  ): Promise<MetricsRow> {
    const deadline = Date.now() + timeoutMs
    let last: MetricsRow = { terminal_state: null, terminal_at: null, node_breakdown: null }
    for (;;) {
      const result = await pool().query<MetricsRow>(
        'SELECT terminal_state, terminal_at, node_breakdown FROM approval_metrics WHERE instance_id = $1',
        [instanceId],
      )
      last = result.rows[0] ?? last
      const decidedOk = !want.decided || decidedNodeKeys(last).length > 0
      const terminalOk = !want.terminal || last.terminal_state !== null
      if (decidedOk && terminalOk) return last
      if (Date.now() >= deadline) return last
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Everything a settlement is allowed to be judged by, with the two things that MUST differ between
   * two sibling instances normalised away: generated ids (mapped to stable labels) and timestamps
   * (reduced to a present/absent boolean). Nothing else is dropped — an unexpected extra record, an
   * assignment left active, a metadata key that only one door writes, all survive into the compare.
   */
  async function settlementSnapshot(
    instanceId: string,
    labels: Record<string, string>,
    options: { awaitTerminal?: boolean } = {},
  ): Promise<Snapshot> {
    // `decided` is ALWAYS awaited — every case in this file decides at least one node, so the
    // decision metric is expected on every path; `terminal` only where the decision ends the
    // instance.
    // `request_no` is a per-instance allocated sequence, so it is an IDENTITY of the instance in
    // exactly the way its id is — normalised for the same reason, and read from the row rather than
    // pattern-matched so a genuinely different SHAPE of request number would still show up.
    const identity = await pool().query<{ request_no: string | null }>(
      'SELECT request_no FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    const requestNo = identity.rows[0]?.request_no ?? null
    const allLabels: Record<string, string> = {
      ...labels,
      [instanceId]: 'INSTANCE',
      ...(requestNo ? { [requestNo]: 'REQUEST_NO' } : {}),
    }
    const label = (value: unknown): unknown =>
      typeof value === 'string' && allLabels[value] !== undefined ? allLabels[value] : value

    const instance = await instanceRow(instanceId)
    const assignments = await pool().query(
      `SELECT node_key, assignment_type, assignee_id, is_active, entry_epoch, source_step
         FROM approval_assignments WHERE instance_id = $1
        ORDER BY node_key ASC, assignee_id ASC, entry_epoch ASC, id ASC`,
      [instanceId],
    )
    const records = await pool().query(
      `SELECT action, actor_id, actor_name, comment, reason, from_status, to_status,
              from_version, to_version, metadata
         FROM approval_records WHERE instance_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [instanceId],
    )
    const metrics = await awaitMetrics(instanceId, { decided: true, terminal: options.awaitTerminal === true })

    return {
      instance: {
        status: instance.status,
        current_node_key: instance.current_node_key,
        current_step: instance.current_step,
        total_steps: instance.total_steps,
        version: instance.version,
      },
      assignments: assignments.rows.map((row: Record<string, unknown>) => ({
        node_key: row.node_key,
        assignment_type: row.assignment_type,
        assignee: label(row.assignee_id),
        is_active: row.is_active,
        entry_epoch: row.entry_epoch,
        source_step: row.source_step,
      })),
      records: records.rows.map((row: Record<string, unknown>) => {
        const metadata = (row.metadata ?? {}) as Record<string, unknown>
        return {
          action: row.action,
          actor: label(row.actor_id),
          actor_name: label(row.actor_name),
          comment: row.comment,
          reason: row.reason,
          from_status: row.from_status,
          to_status: row.to_status,
          from_version: row.from_version,
          to_version: row.to_version,
          metadata_keys: Object.keys(metadata).sort(),
          metadata_values: Object.fromEntries(
            Object.keys(metadata).sort().map((key) => [key, label(metadata[key])]),
          ),
        }
      }),
      metrics: {
        terminal_state: metrics.terminal_state,
        has_terminal_at: metrics.terminal_at !== null,
        decided_node_keys: decidedNodeKeys(metrics),
      },
    }
  }

  /**
   * Two sibling instances of ONE template, decided with the same intent through the two doors.
   * Returns both normalised snapshots plus the size of the comparison.
   */
  async function differential(options: {
    graph: unknown
    name: string
    approverA: string
    approverB?: string
    legacyPath: (id: string) => string
    legacyBody: (version: number) => unknown
    actionsBody: unknown
    awaitTerminal?: boolean
  }): Promise<{ legacy: Snapshot; actions: Snapshot; leaves: number; legacyId: string }> {
    const admin = freshId('admin')
    const requester = freshId('req')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(options.approverA)

    const templateId = await publishTemplate(adminToken, options.graph, options.name)
    const viaLegacy = await createApproval(requesterToken, templateId)
    const viaActions = await createApproval(requesterToken, templateId)

    const labels: Record<string, string> = {
      [requester]: 'REQUESTER',
      [options.approverA]: 'APPROVER_A',
      ...(options.approverB ? { [options.approverB]: 'APPROVER_B' } : {}),
    }

    const legacyResponse = await jsonRequest(baseUrl, options.legacyPath(viaLegacy.id), approverAToken, {
      method: 'POST',
      body: options.legacyBody(viaLegacy.version),
    })
    expect(legacyResponse.status, await legacyResponse.clone().text()).toBe(200)

    const actionsResponse = await jsonRequest(baseUrl, `/api/approvals/${viaActions.id}/actions`, approverAToken, {
      method: 'POST',
      body: options.actionsBody,
    })
    expect(actionsResponse.status, await actionsResponse.clone().text()).toBe(200)

    const legacy = await settlementSnapshot(viaLegacy.id, labels, { awaitTerminal: options.awaitTerminal })
    const actions = await settlementSnapshot(viaActions.id, labels, { awaitTerminal: options.awaitTerminal })
    return { legacy, actions, leaves: countLeaves(actions), legacyId: viaLegacy.id }
  }

  // ── PARITY (differential) ────────────────────────────────────────────────────────────────────

  it('(P1) APPROVE parity, NON-TERMINAL — the same seated approver deciding node A of an A->B graph leaves byte-identical settlement state through either door', async () => {
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    const { legacy, actions, leaves } = await differential({
      graph: twoStepGraph(
        { assigneeType: 'user', assigneeIds: [approverA] },
        { assigneeType: 'user', assigneeIds: [approverB] },
      ),
      name: 'parity-approve-advance',
      approverA,
      approverB,
      legacyPath: (id) => `/api/approvals/${id}/approve`,
      legacyBody: (version) => ({ version, comment: 'ok' }),
      actionsBody: { action: 'approve', comment: 'ok' },
    })

    expect(legacy).toEqual(actions)
    // Guards the compare against going vacuous: a snapshot that degraded to empty objects would
    // still satisfy `toEqual`. EXACT rather than a floor, because the SIZE of the comparison is
    // itself the claim: if a later change stops writing a metadata key, or adds one, the number
    // moves and a reader is told the compared surface changed instead of silently comparing less.
    expect(leaves).toBe(52)
    // And the compared state is the settlement, not an accident of both rows being untouched.
    expect(actions.instance.current_node_key).toBe('approval_b')
  })

  it('(P2) APPROVE parity, TERMINAL — a one-node graph ends identically through either door, metrics included', async () => {
    const approverA = freshId('appr-a')
    const { legacy, actions, leaves } = await differential({
      graph: oneStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }),
      name: 'parity-approve-terminal',
      approverA,
      legacyPath: (id) => `/api/approvals/${id}/approve`,
      legacyBody: (version) => ({ version, comment: 'ok' }),
      actionsBody: { action: 'approve', comment: 'ok' },
      awaitTerminal: true,
    })

    expect(legacy).toEqual(actions)
    expect(leaves).toBe(46)
    expect(actions.instance.status).toBe('approved')
    expect(actions.metrics.terminal_state).toBe('approved')
  })

  it('(P3) REJECT parity — a rejection ends the instance identically through either door, metrics included', async () => {
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    const { legacy, actions, leaves } = await differential({
      graph: twoStepGraph(
        { assigneeType: 'user', assigneeIds: [approverA] },
        { assigneeType: 'user', assigneeIds: [approverB] },
      ),
      name: 'parity-reject',
      approverA,
      approverB,
      legacyPath: (id) => `/api/approvals/${id}/reject`,
      legacyBody: (version) => ({ version, reason: 'no' }),
      actionsBody: { action: 'reject', comment: 'no' },
      awaitTerminal: true,
    })

    expect(legacy).toEqual(actions)
    expect(leaves).toBe(38)
    expect(actions.instance.status).toBe('rejected')
    expect(actions.metrics.terminal_state).toBe('rejected')
  })

  // ── ABSOLUTE post-state (differential equality alone cannot catch a shared regression) ────────

  it('(S1) SETTLEMENT — legacy /approve on node A of an A->B graph advances the cursor, retires A\'s seat and activates B\'s, instead of flipping the status', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'settle-advance',
    )
    const created = await createApproval(requesterToken, templateId)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: created.version },
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const row = await instanceRow(created.id)
    expect(row.status).toBe('pending')
    expect(row.current_node_key).toBe('approval_b')

    const seats = await pool().query<{ node_key: string; assignee_id: string; is_active: boolean }>(
      'SELECT node_key, assignee_id, is_active FROM approval_assignments WHERE instance_id = $1 ORDER BY node_key ASC',
      [created.id],
    )
    expect(seats.rows.filter((seat) => seat.node_key === 'approval_a').every((seat) => seat.is_active === false)).toBe(true)
    const nextSeats = seats.rows.filter((seat) => seat.node_key === 'approval_b' && seat.is_active)
    expect(nextSeats).toHaveLength(1)
    expect(nextSeats[0].assignee_id).toBe(approverB)

    // The envelope keeps its published SHAPE; `status` now reports what the settlement reached.
    const body = (await response.json()) as { ok: boolean; data: { id: string; status: string; version: number; prevVersion: number } }
    expect(body.ok).toBe(true)
    expect(Object.keys(body.data).sort()).toEqual(['id', 'prevVersion', 'status', 'version'])
    expect(body.data.status).toBe('pending')
    expect(body.data.prevVersion).toBe(created.version)
    expect(body.data.version).toBe(created.version + 1)
  })

  it('(S2) SETTLEMENT — a legacy /approve that IS terminal clears the cursor, records the terminal metric, and the instance can no longer be revoked', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    const templateId = await publishTemplate(
      adminToken,
      oneStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }),
      'settle-terminal',
    )
    const created = await createApproval(requesterToken, templateId)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: created.version },
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const row = await instanceRow(created.id)
    expect(row.status).toBe('approved')
    // The cursor clause the private finding turned on: `approved` now really does mean "no live node".
    expect(row.current_node_key).toBeNull()

    const active = await pool().query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE',
      [created.id],
    )
    expect(Number(active.rows[0].n)).toBe(0)

    const metrics = await awaitMetrics(created.id, { decided: true, terminal: true })
    expect(metrics.terminal_state).toBe('approved')
    expect(decidedNodeKeys(metrics)).toEqual(['approval_a'])

    // THE INVARIANT (L6-B): the requester's revoke is refused on an instance the legacy door
    // approved. The revoke precondition reads the node cursor, so this holds only because the
    // settlement above actually cleared it — which is why this leg lives next to (S2)'s cursor
    // assertion rather than in the revoke suite.
    const revoke = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, requesterToken, {
      method: 'POST',
      body: { action: 'revoke', comment: 'take it back' },
    })
    const revokeBody = await revoke.clone().text()
    expect(revoke.status, revokeBody).toBe(409)
    expect((await instanceRow(created.id)).status).toBe('approved')
  })

  it('(S3) REFUSAL IDENTITY — a service-level refusal raised INSIDE the shared settlement path keeps its status, code and details in the legacy envelope, and writes nothing', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    // `commentRequired: 'always'` is the cheapest refusal that exists ONLY inside the settlement
    // path: the legacy route has no comment rule of its own on /approve, so before this slice the
    // same call was a 200. It is therefore a live test of the whole mapping chain — the service's
    // `ServiceError` is caught, recognised by `instanceof`, and rendered with ITS status code, ITS
    // error code and ITS `details`, in THIS route's `{ ok: false, error }` envelope. Without this
    // case the mapper ships with zero executions and every service refusal could silently be
    // flattened to `500 APPROVAL_APPROVE_FAILED` by the outer catch without a single test noticing.
    const templateId = await publishTemplate(
      adminToken,
      twoStepGraphWithNodePolicy(
        { assigneeType: 'user', assigneeIds: [approverA] },
        { assigneeType: 'user', assigneeIds: [approverB] },
        { commentRequired: 'always' },
      ),
      'refusal-identity',
    )
    const created = await createApproval(requesterToken, templateId)
    const before = await recordCount(created.id)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: created.version },
    })
    const raw = await response.clone().text()
    // Asserted by CODE, never by the bare status: a 400 from the route's own `VALIDATION_ERROR`
    // family would otherwise pass for the service's refusal and make this case vacuous.
    expect(response.status, raw).toBe(400)
    const body = JSON.parse(raw) as {
      ok?: boolean
      error: { code: string; message: string; details?: { nodeKey?: string } }
    }
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('APPROVAL_COMMENT_REQUIRED')
    expect(body.error.details?.nodeKey).toBe('approval_a')

    // FAIL-CLOSED: a refusal raised after the row lock was handed back still leaves zero rows.
    expect(await recordCount(created.id)).toBe(before)
    const row = await instanceRow(created.id)
    expect(row.status).toBe('pending')
    expect(row.current_node_key).toBe('approval_a')

    // POSITIVE CONTROL for the refusal itself: the SAME caller on the SAME instance succeeds once
    // the comment the node policy demands is supplied — so the 400 above is the policy, not a
    // blanket refusal of this door.
    const withComment = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: created.version, comment: 'looks good' },
    })
    expect(withComment.status, await withComment.clone().text()).toBe(200)
    expect((await instanceRow(created.id)).current_node_key).toBe('approval_b')
  })

  // ── FORGERY family, re-run against the settlement path ───────────────────────────────────────

  it('(F1) a seatless `approvals:act` holder naming the instance\'s OWN current node is still refused before any write', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    const outsider = freshId('outsider')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const outsiderToken = await authToken(outsider)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'forgery-1',
    )
    const created = await createApproval(requesterToken, templateId)
    const before = await recordCount(created.id)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, outsiderToken, {
      method: 'POST',
      body: { version: created.version, metadata: { nodeKey: 'approval_a', nodeEntryEpoch: 1 } },
    })
    const body = await response.clone().text()
    expect(response.status, body).toBe(403)
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'APPROVAL_ASSIGNMENT_REQUIRED' } })
    expect(await recordCount(created.id)).toBe(before)
    const row = await instanceRow(created.id)
    expect(row.status).toBe('pending')
    expect(row.current_node_key).toBe('approval_a')
  })

  it('(F2) a caller who is in NO role naming a ROLE node (which does carry role seats) is still refused before any write', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const outsider = freshId('outsider')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    // The outsider's token carries `member` only; the node's seat is the `auditor` ROLE.
    const outsiderToken = await authToken(outsider)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'role', assigneeIds: ['auditor'] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'forgery-2',
    )
    const created = await createApproval(requesterToken, templateId)
    const before = await recordCount(created.id)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, outsiderToken, {
      method: 'POST',
      body: { version: created.version, metadata: { nodeKey: 'approval_a' } },
    })
    const body = await response.clone().text()
    expect(response.status, body).toBe(403)
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'APPROVAL_ASSIGNMENT_REQUIRED' } })
    expect(await recordCount(created.id)).toBe(before)
    expect((await instanceRow(created.id)).status).toBe('pending')
  })

  it('(F3) a genuinely seated approver naming SOMEBODY ELSE\'S node is admitted (they are the current approver) but none of their metadata reaches the row', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'forgery-3',
    )
    const created = await createApproval(requesterToken, templateId)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: {
        version: created.version,
        metadata: { nodeKey: 'approval_b', nodeEntryEpoch: 99999, smuggled: 'x' },
      },
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const rows = await pool().query<{ metadata: Record<string, unknown> | null }>(
      "SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'approve'",
      [created.id],
    )
    expect(rows.rows).toHaveLength(1)
    const metadata = rows.rows[0].metadata ?? {}
    expect(metadata.nodeKey).toBe('approval_a')
    expect(metadata.nodeEntryEpoch).not.toBe(99999)
    expect(metadata.smuggled).toBeUndefined()
  })

  it('(F4) the same forgery on /reject is neutralised the same way', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'forgery-4',
    )
    const created = await createApproval(requesterToken, templateId)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/reject`, approverAToken, {
      method: 'POST',
      body: {
        version: created.version,
        reason: 'no',
        metadata: { nodeKey: 'approval_b', smuggled: 'x' },
      },
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const rows = await pool().query<{ metadata: Record<string, unknown> | null }>(
      "SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'reject'",
      [created.id],
    )
    expect(rows.rows).toHaveLength(1)
    const metadata = rows.rows[0].metadata ?? {}
    expect(metadata.nodeKey).toBe('approval_a')
    expect(metadata.smuggled).toBeUndefined()
    expect((await instanceRow(created.id)).status).toBe('rejected')
  })

  it('(F5) an approver whose own node has already been SETTLED cannot re-enter by naming the live node — and the settlement is what makes their seat stale', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'forgery-5',
    )
    const created = await createApproval(requesterToken, templateId)

    // A's OWN honest decision, through the legacy door. It is this call's settlement that retires
    // A's seat and moves the cursor — which is exactly why the second call below has nothing left.
    const honest = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: created.version },
    })
    expect(honest.status, await honest.clone().text()).toBe(200)
    const afterHonest = await instanceRow(created.id)
    expect(afterHonest.current_node_key).toBe('approval_b')
    const before = await recordCount(created.id)

    const forged = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: afterHonest.version, metadata: { nodeKey: 'approval_b' } },
    })
    const body = await forged.clone().text()
    expect(forged.status, body).toBe(403)
    expect(JSON.parse(body)).toMatchObject({ error: { code: 'APPROVAL_ASSIGNMENT_REQUIRED' } })
    expect(await recordCount(created.id)).toBe(before)
    expect((await instanceRow(created.id)).status).toBe('pending')
  })
})
