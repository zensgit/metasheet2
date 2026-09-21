import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { eventBus } from '../../src/integration/events/event-bus'
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
 *   * no completion event is built or emitted, so none of the three completion consumers
 *     (`approval-bridge`, `approval-trigger`, `approval-projection` —
 *     `multitable/automation-routing-manifest.ts`) and none of the record form write-back ever
 *     hears that the instance ended. (S6) observes the EMIT itself, in-process, on the bus the
 *     three consumers subscribe to. It does NOT observe the three consumers reacting — that still
 *     needs each one's own upstream fixture and is not claimed here;
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
 * ### The ONE field the two doors are allowed to disagree on
 *
 * `approval_records.reason` is the legacy `/reject` door's OWN column and `/actions` has never had
 * anything to write into it (its request carries no `reason`). This door collects the text under a
 * mandatory 400 (`APPROVAL_REJECTION_REASON_REQUIRED`), so "settle like `/actions`" must not mean
 * "collect it and drop it". The differential in (P3) therefore carries ONE named carve-out — the
 * `reason` column of the reject row — and that carve-out is not a blind spot: (S4) pins both halves
 * of that column ABSOLUTELY with a comment text and a reason text that differ from each other, so
 * the "both doors regressed to NULL together" failure the differential cannot see is exactly what
 * (S4) fails on. Nothing else is excluded from the compare.
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
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

/**
 * (S8)'s two pinned origin values.
 *
 * `AUDIT_ORIGIN_USER_AGENT` is sent by (S8) itself, so the assertion is exact and
 * environment-independent: it can only appear in the row if THIS request's header reached
 * `insertApprovalRecord`'s `actor` argument.
 *
 * `AUDIT_ORIGIN_IP` is tied to ONE property of this suite's own setup: `beforeAll` binds the
 * server to `host: '127.0.0.1'` explicitly, so the accepted socket is IPv4 and Express's `req.ip`
 * (trust-proxy off ⇒ `req.socket.remoteAddress`) is the dotted-quad loopback rather than the
 * `::ffff:`-mapped form a `::` dual-stack bind would produce. If that bind ever changes, this pin
 * is the thing that legitimately moves — and it should move deliberately, not be relaxed to a
 * substring match that a NULL could also satisfy.
 */
const AUDIT_ORIGIN_USER_AGENT = 'h5-settlement-parity-audit-origin/1.0'
const AUDIT_ORIGIN_IP = '127.0.0.1'

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

/**
 * THE ONE CARVE-OUT, named rather than hidden: `approval_records.reason` on a `reject` row.
 *
 * * PREDICATE — exactly the rows with `action === 'reject'`, and exactly the key `reason`. Every
 *   other row keeps its `reason` in the compare (a non-reject row that suddenly grew one is still
 *   an inequality), and every other key of the reject row stays too.
 * * WHY — the legacy `/reject` door publishes this column and enforces its presence with a 400
 *   (`APPROVAL_REJECTION_REASON_REQUIRED`); `/actions` has no `reason` in its request at all, so
 *   the two doors CANNOT agree here, and a differential that demanded they agree would only be
 *   satisfiable by dropping the column from the legacy door — which is the defect, not the fix.
 * * THE INVARIANT THIS MUST NOT HIDE — "both doors regressed to NULL together". (S4) asserts the
 *   legacy row's `comment` and `reason` by exact, DIFFERENT text, and (P3) asserts both sides of
 *   this column explicitly at the point the carve-out is applied. Remove the fix and both go red.
 */
function withoutRejectReasonColumn(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    records: snapshot.records.map((row) => {
      if (row.action !== 'reject') return row
      const { reason: _carvedOut, ...rest } = row
      return rest
    }),
  }
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
    // `ip_address` / `user_agent` / `target_user_id` are in the projection because they are
    // WRITTEN by the settlement (the fourth `actor` argument of `insertApprovalRecord`) and the
    // legacy doors write them too — a door that stopped forwarding the request's origin would be a
    // silent audit regression that a snapshot without these three columns cannot see. Both sibling
    // requests in a differential come from the same client, so they are compared raw rather than
    // normalised: a genuine divergence between the two doors shows up as an inequality.
    const records = await pool().query(
      `SELECT action, actor_id, actor_name, comment, reason, from_status, to_status,
              from_version, to_version, metadata, ip_address, user_agent, target_user_id
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
          ip_address: row.ip_address,
          user_agent: row.user_agent,
          target_user_id: label(row.target_user_id),
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
    expect(leaves).toBe(58)
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
    expect(leaves).toBe(52)
    expect(actions.instance.status).toBe('approved')
    expect(actions.metrics.terminal_state).toBe('approved')
  })

  it('(P3) REJECT parity — a rejection ends the instance identically through either door, metrics included, apart from the legacy door\'s own `reason` column', async () => {
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

    // THE CARVE-OUT, applied here and nowhere else (see `withoutRejectReasonColumn`) — and
    // immediately paid for by the two absolute assertions below, which say what each door actually
    // put in the column instead of leaving it unexamined.
    expect(withoutRejectReasonColumn(legacy)).toEqual(withoutRejectReasonColumn(actions))
    const legacyReject = legacy.records.find((row) => row.action === 'reject')
    const actionsReject = actions.records.find((row) => row.action === 'reject')
    expect(legacyReject).toBeDefined()
    expect(actionsReject).toBeDefined()
    // The legacy door KEEPS its column; `/actions` has no field that could fill it.
    expect(legacyReject?.reason).toBe('no')
    expect(actionsReject?.reason).toBeNull()
    expect(leaves).toBe(44)
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

  it('(S4) REASON COLUMN — legacy /reject still writes `approval_records.reason`, and it is the REASON text, not a copy of the comment', async () => {
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
      'reject-reason-column',
    )
    const created = await createApproval(requesterToken, templateId)

    // THE DISCRIMINATOR: two DIFFERENT texts. `comment` and `reason` are separate optional
    // properties of this endpoint's published body (`packages/openapi/src/paths/approvals.yml`),
    // and only when they differ can a row tell "the reason was stored" from "the comment was
    // stored twice" from "the reason was stored into the comment column and the reason column
    // left NULL". A single text makes all three indistinguishable.
    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/reject`, approverAToken, {
      method: 'POST',
      body: { version: created.version, comment: 'C-TEXT', reason: 'R-TEXT' },
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const rows = await pool().query<{ comment: string | null; reason: string | null }>(
      "SELECT comment, reason FROM approval_records WHERE instance_id = $1 AND action = 'reject'",
      [created.id],
    )
    expect(rows.rows).toHaveLength(1)
    // ABSOLUTE, by exact text — not a differential. A differential against `/actions` could not
    // state this claim at all: `/actions` has no `reason` field, so "both doors write NULL" would
    // satisfy it. This is the case that fails if the column is ever dropped again.
    expect(rows.rows[0].comment).toBe('C-TEXT')
    expect(rows.rows[0].reason).toBe('R-TEXT')

    // Vacuity guard only: the rejection really happened, so the row above is a decision row and
    // not some other audit row that happens to be the only one on the instance.
    //
    // DELIBERATELY NOT ASSERTED HERE: the settled post-state (cursor cleared, seats retired,
    // terminal metric) — (P3), (S1) and (S2) own that. This case is written so it also PASSES on
    // the PRE-slice implementation, where the legacy door wrote both columns with its own inline
    // DML: that is what makes it a positive control for the column rather than a second copy of
    // the settlement assertions. A case that failed on both implementations could not tell "the
    // column is preserved" from "the door changed in some other way".
    expect((await instanceRow(created.id)).status).toBe('rejected')
  })

  it('(S5) CONNECTION HANDBACK — a settled legacy decision releases its pooled client exactly once, asserted rather than left to the runner to notice', async () => {
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
      'handback',
    )
    const created = await createApproval(requesterToken, templateId)

    // The settlement branch releases the route's client EARLY (it must: the shared path re-locks
    // the same row on a second connection) and sets a flag so the `catch`/`finally` below it do not
    // release it a second time. node-postgres THROWS on a second release — after the response has
    // already been written, so the client still sees its 200 and every other assertion in this
    // file stays green. Without this case the guard is detected only by the runner's unhandled-
    // error accounting, which is an exit code, not a described invariant.
    const captured: string[] = []
    const onUnhandledRejection = (reason: unknown) => {
      captured.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason))
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
        method: 'POST',
        body: { version: created.version },
      })
      expect(response.status, await response.clone().text()).toBe(200)
      // The rejection is raised after the response is flushed, so it needs a turn of the loop to
      // reach the handler. Two macrotask ticks, never a bare assertion on the same tick.
      await new Promise((resolve) => setTimeout(resolve, 20))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(captured).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }

    // POSITIVE CONTROL that the settlement really ran on this instance — an empty `captured` on a
    // call that never reached the settlement branch would be vacuous.
    expect((await instanceRow(created.id)).current_node_key).toBe('approval_b')
  })

  it('(S6) COMPLETION EVENT — a terminal legacy /approve EMITS the completion event on the bus the three completion consumers subscribe to', async () => {
    // PRECONDITION, asserted rather than assumed: `emitApprovalCompletionEvent` returns early when
    // durable delivery is ON (the in-transaction outbox is the delivery path then, and emitting as
    // well would double-deliver). This case pins the flag-OFF behaviour, which is the shipped
    // default; if the flag were on in this lane the assertion below would be measuring nothing, so
    // the flag is checked first.
    expect(String(process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED ?? '').trim().toLowerCase()).not.toBe('true')

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
      'completion-event',
    )
    const created = await createApproval(requesterToken, templateId)

    const received: Array<Record<string, unknown>> = []
    const subscriptionId = eventBus.subscribe('approval.approved', (event: unknown) => {
      received.push((event ?? {}) as Record<string, unknown>)
    })
    try {
      const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
        method: 'POST',
        body: { version: created.version },
      })
      expect(response.status, await response.clone().text()).toBe(200)
    } finally {
      eventBus.unsubscribe(subscriptionId)
    }

    // The emit is SYNCHRONOUS and pre-response (COMMIT -> metrics -> emit -> DTO -> respond), so
    // there is nothing to poll for: if the settlement did not emit, this array is empty now.
    const mine = received.filter((event) => {
      const approval = event.approval as { instanceId?: string } | undefined
      return approval?.instanceId === created.id
    })
    expect(mine).toHaveLength(1)
    expect(mine[0].eventType).toBe('approval.approved')
    const transition = mine[0].transition as { action?: string; toStatus?: string }
    expect(transition.action).toBe('approve')
    expect(transition.toStatus).toBe('approved')
    // SCOPE, stated so this is not read as more than it is: the EMIT is observed. The three
    // completion consumers (`approval-bridge`, `approval-trigger`, `approval-projection`) and the
    // record form write-back are NOT observed here — each needs its own upstream fixture.
  })

  it('(S7) CONCURRENT DOUBLE DECISION — two simultaneous legacy /approve calls carrying the SAME version settle the node exactly once, and the loser gets the one published 409', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    // A -> B, so the FIRST decision leaves the instance `pending` at B rather than terminal: the
    // loser therefore meets the VERSION clause rather than the status clause, whichever of the two
    // version checks it happens to meet (this route's own pre-check, or the settlement's
    // `expectedVersion` re-check inside the settlement transaction). A one-node graph would have
    // made this case pass for the wrong reason (`APPROVAL_STATUS_INVALID`).
    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'concurrent-double-decision',
    )
    const created = await createApproval(requesterToken, templateId)

    const body = { version: created.version, comment: 'ok' }
    const [first, second] = await Promise.all([
      jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, { method: 'POST', body }),
      jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, { method: 'POST', body }),
    ])
    const outcomes = await Promise.all([first, second].map(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    })))

    // THE OUTCOME, which is what a race acceptance is allowed to assert: exactly one winner.
    // WHICH request wins is the order PostgreSQL grants the row lock and is deliberately NOT
    // asserted.
    expect(outcomes.filter((outcome) => outcome.status === 200)).toHaveLength(1)
    const refused = outcomes.filter((outcome) => outcome.status !== 200)
    expect(refused).toHaveLength(1)
    expect(refused[0].status).toBe(409)
    // ONE 409 SHAPE. Both version checks on this route now answer in the envelope this endpoint
    // has always published for a version conflict, so this assertion holds without knowing which
    // of the two fired — and fails if the settlement's refusal is rendered in the generic
    // `error.details` envelope instead.
    const error = refused[0].body.error as Record<string, unknown>
    expect(error.code).toBe('APPROVAL_VERSION_CONFLICT')
    expect(typeof error.currentVersion).toBe('number')
    expect(error.details).toBeUndefined()

    // NO DOUBLE SETTLEMENT and NO CORRUPTED CURSOR: one version bump, one approve row, the cursor
    // on the next node and A's seat retired exactly once.
    const row = await instanceRow(created.id)
    expect(row.status).toBe('pending')
    expect(row.current_node_key).toBe('approval_b')
    expect(row.version).toBe(created.version + 1)
    const approveRows = await pool().query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM approval_records WHERE instance_id = $1 AND action = 'approve'",
      [created.id],
    )
    expect(Number(approveRows.rows[0].n)).toBe(1)
    const activeSeats = await pool().query<{ node_key: string }>(
      'SELECT node_key FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE',
      [created.id],
    )
    expect(activeSeats.rows.map((seat) => seat.node_key)).toEqual(['approval_b'])
  })

  /**
   * (S8) H-5 P3-A — THE ORIGIN COLUMNS, ABSOLUTELY.
   *
   * `ip_address` / `user_agent` / `target_user_id` are in the differential's projection (see
   * `settlementSnapshot`), and the differential is the WRONG instrument for them. Since the legacy
   * doors settle through the shared path, both of them and `/actions` now file their audit row
   * through ONE writer (`ApprovalProductService.insertApprovalRecord`), so a regression in that
   * writer —
   * an `actor` argument made optional, a placeholder order edited, a refactor that drops the
   * fourth argument at one call site and then at all of them — is necessarily SYMMETRIC. Both
   * doors lose the column together, and `expect(legacy).toEqual(actions)` is still satisfied. That
   * is the failure mode this file's own docblock names, and (P1)(P2)(P3) cannot see it.
   *
   * So each column is asserted here by exact value, on BOTH doors, and each carries a DIFFERENT
   * claim — stated per column rather than lumped together as "the origin is covered":
   *
   *   * `user_agent` — the caller's own header, pinned to a literal this case sends. Catches
   *     "stopped forwarding" AND "forwarded something else"; environment-independent.
   *   * `ip_address` — the caller's address, pinned to the loopback this suite's own bind produces
   *     (see `AUDIT_ORIGIN_IP`). Catches "stopped forwarding".
   *   * `target_user_id` — asserted NULL, and the asymmetry is deliberate: a decision row has no
   *     target by construction, so this leg catches a writer that STARTS populating the column
   *     (an actor id leaking into the audit row's target, which a differential cannot see either
   *     because both doors would leak the same id). It does NOT catch "stopped forwarding" —
   *     there is nothing to stop forwarding. This column has a leg in ONE direction only.
   *
   * NOT a second copy of the settlement assertions: the post-state (cursor, seats, metrics) is
   * owned by (P1)(P2)(S1)(S2) and is deliberately not re-asserted here.
   */
  it('(S8) AUDIT ORIGIN — both doors persist the caller\'s IP and user-agent, and neither invents a target, asserted by exact value because a regression in the shared writer hits both doors at once', async () => {
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
      'audit-origin-columns',
    )
    const viaLegacy = await createApproval(requesterToken, templateId)
    const viaActions = await createApproval(requesterToken, templateId)

    // THE SAME user-agent on both requests: the claim is about each door's own row, not about a
    // divergence between them, and a differential is explicitly not what is being run here.
    const legacyResponse = await jsonRequest(baseUrl, `/api/approvals/${viaLegacy.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: viaLegacy.version, comment: 'ok' },
      headers: { 'User-Agent': AUDIT_ORIGIN_USER_AGENT },
    })
    expect(legacyResponse.status, await legacyResponse.clone().text()).toBe(200)
    const actionsResponse = await jsonRequest(baseUrl, `/api/approvals/${viaActions.id}/actions`, approverAToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'ok' },
      headers: { 'User-Agent': AUDIT_ORIGIN_USER_AGENT },
    })
    expect(actionsResponse.status, await actionsResponse.clone().text()).toBe(200)

    for (const door of [
      { name: 'legacy /approve', instanceId: viaLegacy.id },
      { name: '/actions', instanceId: viaActions.id },
    ]) {
      const rows = await pool().query<{ ip_address: string | null; user_agent: string | null; target_user_id: string | null }>(
        `SELECT ip_address, user_agent, target_user_id FROM approval_records
          WHERE instance_id = $1 AND action = 'approve'`,
        [door.instanceId],
      )
      // Vacuity guard: the decision row exists, so the three assertions below are read off a row
      // that was actually written rather than passing on an empty result.
      expect(rows.rows, door.name).toHaveLength(1)
      expect(rows.rows[0].user_agent, door.name).toBe(AUDIT_ORIGIN_USER_AGENT)
      expect(rows.rows[0].ip_address, door.name).toBe(AUDIT_ORIGIN_IP)
      expect(rows.rows[0].target_user_id, door.name).toBeNull()
    }
  })

  /**
   * (S9) H-5 P3-B — THE SAME RACE, WITH THE SEAT GATE TAKEN OUT OF THE WAY.
   *
   * (S7) above runs two concurrent decisions from ONE approver against an A(x)->B(y) graph, so the
   * loser — whatever else is true — is not seated at B. Neutralise the `expectedVersion`
   * precondition and (S7) still refuses that loser, at the SEAT gate, 403: the case is
   * deterministically red under such a mutation but red on the wrong assertion, and it can never
   * observe the harm the precondition exists to prevent.
   *
   * This case removes that cover by seating the SAME approver at BOTH nodes — A(x)->B(x), which is
   * the shape the original defect report named (one actor holding a seat at the current node AND
   * at the next one; a real reviewer who appears twice in a chain). Now the loser IS admitted by
   * every gate except the version one:
   *
   *   * seat — they hold an active seat at whichever node is current, before and after the winner
   *     advances the cursor;
   *   * status — the instance is still `pending` (A->B, so the first decision advances rather than
   *     ends);
   *   * round — the seat at B is a fresh, active assignment row.
   *
   * So the ONLY thing standing between the loser and a second settlement is the optimistic-lock
   * precondition, in whichever of its two places fires (this route's own pre-check when the
   * winner's COMMIT got there first, the settlement transaction's `expectedVersion` re-check when
   * it did not). WHAT IS ASSERTED is the outcome, which is what a race acceptance may assert: one
   * winner, one 409, ONE approve row, and a cursor that advanced exactly once. Remove the
   * precondition and this caller decides node B holding a version that never pointed at B.
   */
  it('(S9) CONCURRENT DOUBLE DECISION, ONE APPROVER SEATED AT BOTH NODES — the loser is refused rather than deciding the NEXT node with a version that never pointed at it', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    // THE FIXTURE SHAPE, and the whole point of this case: `approverA` at BOTH nodes.
    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverA] }),
      'concurrent-double-decision-same-actor',
    )
    const created = await createApproval(requesterToken, templateId)

    const body = { version: created.version, comment: 'ok' }
    const [first, second] = await Promise.all([
      jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, { method: 'POST', body }),
      jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, { method: 'POST', body }),
    ])
    const outcomes = await Promise.all([first, second].map(async (response) => ({
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    })))

    expect(outcomes.filter((outcome) => outcome.status === 200)).toHaveLength(1)
    const refused = outcomes.filter((outcome) => outcome.status !== 200)
    expect(refused).toHaveLength(1)
    // 409, NOT 403: with this fixture the seat gate cannot be what refuses — that is the
    // difference between this case and (S7), stated as an assertion rather than as a comment.
    expect(refused[0].status).toBe(409)
    const error = refused[0].body.error as Record<string, unknown>
    expect(error.code).toBe('APPROVAL_VERSION_CONFLICT')
    expect(typeof error.currentVersion).toBe('number')
    expect(error.details).toBeUndefined()

    // EXACTLY ONE SETTLEMENT: one version bump, one approve row, the cursor one node along.
    // Without the precondition the loser settles node B as well, and these read
    // `status='approved'` / `version = N+2` / two approve rows.
    const row = await instanceRow(created.id)
    expect(row.status).toBe('pending')
    expect(row.current_node_key).toBe('approval_b')
    expect(row.version).toBe(created.version + 1)
    const approveRows = await pool().query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM approval_records WHERE instance_id = $1 AND action = 'approve'",
      [created.id],
    )
    expect(Number(approveRows.rows[0].n)).toBe(1)
    const activeSeats = await pool().query<{ node_key: string; assignee_id: string }>(
      'SELECT node_key, assignee_id FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE',
      [created.id],
    )
    expect(activeSeats.rows.map((seat) => seat.node_key)).toEqual(['approval_b'])
    // FIXTURE-SHAPE GUARD, asserted rather than assumed from the graph literal above: the node the
    // refused caller would have gone on to decide is one THEY are seated at. If a future change to
    // the publisher stopped materialising B's seat for the same user, this case would quietly
    // degrade back into (S7) — seat-gated loser, harm unobservable — and this line is what says so.
    expect(activeSeats.rows.map((seat) => seat.assignee_id)).toEqual([approverA])
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
    // `not.toBe(99999)` alone cannot tell "the server wrote its own round" from "nobody wrote a
    // round at all" — a missing key satisfies it. The shape assertion next to it is what makes the
    // pair discriminating, and `nextNodeKey` is the positive control that the row is not simply
    // empty. (Same three assertions the sibling seat/attribution suite carries for this shape.)
    expect(metadata.nodeEntryEpoch).not.toBe(99999)
    expect(Number.isInteger(metadata.nodeEntryEpoch)).toBe(true)
    expect(metadata.nextNodeKey).toBe('approval_b')
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
