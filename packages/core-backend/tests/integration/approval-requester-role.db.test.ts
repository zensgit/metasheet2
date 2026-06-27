import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * `requester.role` membership — REAL-DB end-to-end round-trip (mirrors approval-requester-title.db.test.ts).
 *
 * Proves:
 *  (a) createApproval FREEZES the requester's role-id set into requester_snapshot.directoryRoles (JSONB) —
 *      resolved by a FRESH `user_roles` SELECT, NOT the login-time token claim `roles`;
 *  (b) the condition node, reached at DISPATCH (after an approval) where requester_snapshot is reloaded FROM
 *      the row, routes on that frozen role set via `requester.role in [...]` membership.
 *
 * The token discriminator is deliberate: the dev-token mints `roles=admin`, but the membership literal set is
 * ["finance_approver"] (NO admin). Routing to the finance branch can therefore ONLY come from the seeded
 * user_roles row (finance_approver) — a (broken) implementation that routed on the token claim `admin` would
 * intersect nothing and take the default edge instead, so this test fails-closed against that regression.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `rrole-req-${TS}`
const APPROVER = `rrole-appr-${TS}`
const FIN = `rrole-fin-${TS}`
const OTHER = `rrole-oth-${TS}`
const ROLE = `finance_approver-${TS}` // seeded into user_roles; MUST match the membership literal below

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}
async function tok(base: string, userId: string): Promise<string> {
  // roles=admin on the token: directoryRoles MUST come from user_roles, not this claim (see discriminator).
  const res = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
  return ((await res.json()) as { token: string }).token
}
async function req(base: string, path: string, token: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

const GRAPH = {
  nodes: [
    { key: 'start', type: 'start', name: 's', config: {} },
    { key: 'approval_1', type: 'approval', name: 'gate', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    // condition is DOWNSTREAM of an approval node, so it is evaluated at dispatch (after approve), where
    // requester_snapshot is reloaded from the row — the path that proves the round-trip. Literal set has NO
    // admin, so only the seeded user_roles row can route to the finance branch.
    { key: 'condition_1', type: 'condition', name: 'route', config: { branches: [{ edgeKey: 'fin', rules: [], formula: { expression: `requester.role in ["${ROLE}"]` } }], defaultEdgeKey: 'other' } },
    { key: 'approval_fin', type: 'approval', name: 'fin', config: { assigneeSources: [{ kind: 'static_user', userIds: [FIN] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'approval_other', type: 'approval', name: 'oth', config: { assigneeSources: [{ kind: 'static_user', userIds: [OTHER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: 'e', config: {} },
  ],
  edges: [
    { key: 's2a1', source: 'start', target: 'approval_1' },
    { key: 'a12c', source: 'approval_1', target: 'condition_1' },
    { key: 'fin', source: 'condition_1', target: 'approval_fin' },
    { key: 'other', source: 'condition_1', target: 'approval_other' },
    { key: 'fin2e', source: 'approval_fin', target: 'end' },
    { key: 'oth2e', source: 'approval_other', target: 'end' },
  ],
}

describeIfDatabase('requester.role — real-DB create->reload->dispatch round-trip', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let apprTok = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    // RBAC table guard (defensive — present via migrations in the CI lane; matches the real schema).
    await pool.query(`CREATE TABLE IF NOT EXISTS user_roles (user_id varchar(255) NOT NULL, role_id varchar(255) NOT NULL, created_at timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL)`)
    // Seed: the requester user + a single user_roles row. NO directory account needed — requester.role reads
    // straight off user_roles, independent of the directory snapshot.
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`, [REQ, `${REQ}@x.test`])
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [REQ, ROLE])
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    apprTok = await tok(base, APPROVER)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`rrole-${TS}-%`])).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        const iids = (await pool.query(`SELECT id FROM approval_instances WHERE template_id = ANY($1::uuid[])`, [tids])).rows.map((r) => r.id as string)
        if (iids.length > 0) {
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1::uuid[])`, [tids])
      }
      await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [REQ])
      await pool.query(`DELETE FROM users WHERE id = $1`, [REQ])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('freezes directoryRoles FROM user_roles (not the token claim) and routes the membership condition at dispatch', async () => {
    const key = `rrole-${TS}-1`
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }, approvalGraph: GRAPH },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)

    // requester REQ starts → createApproval freezes the user_roles set into requester_snapshot.
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const startBody = (await started.json()) as { id?: string; data?: { id: string } }
    const iid = startBody.id ?? startBody.data!.id

    const pool = poolManager.get()
    // (a) JSONB round-trip: role set frozen at create FROM user_roles. The token claim `roles` is admin, so
    //     directoryRoles===[ROLE] (finance) — NOT [admin] — proves the source is user_roles, not the token.
    const snap = (await pool.query<{ requester_snapshot: { directoryRoles?: string[]; roles?: string[] } | null; current_node_key: string | null }>(
      `SELECT requester_snapshot, current_node_key FROM approval_instances WHERE id = $1`,
      [iid],
    )).rows[0]
    expect(snap.requester_snapshot?.directoryRoles).toEqual([ROLE])
    expect(snap.requester_snapshot?.roles).toContain('admin') // token claim — present but NOT what routes
    expect(snap.requester_snapshot?.directoryRoles).not.toContain('admin')
    expect(snap.current_node_key).toBe('approval_1')

    // dispatch: APPROVER approves approval_1 → dispatchAction reloads requester_snapshot FROM the row and
    // re-threads requesterContext.roles; the condition then routes on the reloaded frozen role set.
    const approved = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
    expect(approved.status, await approved.clone().text()).toBeLessThan(300)

    // (b) routed to the finance branch via membership on the reloaded frozen role set (not formData, not token).
    const after = (await pool.query<{ current_node_key: string | null }>(
      `SELECT current_node_key FROM approval_instances WHERE id = $1`,
      [iid],
    )).rows[0]
    expect(after.current_node_key).toBe('approval_fin')
    const assignees = (await pool.query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND assignment_type = 'user' AND is_active = TRUE`,
      [iid],
    )).rows.map((r) => r.assignee_id)
    expect(assignees).toContain(FIN)
    expect(assignees).not.toContain(OTHER)
  })
})
