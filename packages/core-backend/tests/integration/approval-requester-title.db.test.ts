import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * `requester.title` — REAL-DB end-to-end round-trip (mirrors approval-requester-department.db.test.ts).
 *
 * Proves:
 *  (a) createApproval FREEZES the directory-resolved job TITLE into requester_snapshot (JSONB) — sourced
 *      from directory_accounts.title, not actor.*;
 *  (b) the condition node, reached at DISPATCH (after an approval) where requester_snapshot is reloaded
 *      FROM the row, routes on that frozen value.
 *
 * Routing at dispatch (not create) is deliberate: the create-time requesterContext is built in-memory, so
 * a create-only assertion would false-green; only the dispatch reload proves the JSONB round-trip +
 * re-thread (the team's documented wire-vs-fixture trap).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `rtitle-req-${TS}`
const APPROVER = `rtitle-appr-${TS}`
const MGR = `rtitle-mgr-${TS}`
const OTHER = `rtitle-oth-${TS}`
const TITLE = '经理' // MUST match the formula literal in GRAPH below

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}
async function tok(base: string, userId: string): Promise<string> {
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
    // condition is DOWNSTREAM of an approval node, so it is evaluated at dispatch (after approve),
    // where requester_snapshot is reloaded from the row — the path that proves the round-trip.
    { key: 'condition_1', type: 'condition', name: 'route', config: { branches: [{ edgeKey: 'mgr', rules: [], formula: { expression: `requester.title == '${TITLE}'` } }], defaultEdgeKey: 'other' } },
    { key: 'approval_mgr', type: 'approval', name: 'mgr', config: { assigneeSources: [{ kind: 'static_user', userIds: [MGR] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'approval_other', type: 'approval', name: 'oth', config: { assigneeSources: [{ kind: 'static_user', userIds: [OTHER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: 'e', config: {} },
  ],
  edges: [
    { key: 's2a1', source: 'start', target: 'approval_1' },
    { key: 'a12c', source: 'approval_1', target: 'condition_1' },
    { key: 'mgr', source: 'condition_1', target: 'approval_mgr' },
    { key: 'other', source: 'condition_1', target: 'approval_other' },
    { key: 'mgr2e', source: 'approval_mgr', target: 'end' },
    { key: 'oth2e', source: 'approval_other', target: 'end' },
  ],
}

describeIfDatabase('requester.title — real-DB create->reload->dispatch round-trip', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let apprTok = ''
  let integrationId = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    // directory seed: REQ -> account with title='经理' -> linked local user. No department row needed —
    // requester.title reads directly off directory_accounts.title.
    integrationId = (await pool.query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`rtitle-${TS}`, `rtitle-corp-${TS}`],
    )).rows[0].id
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [REQ, `${REQ}@x.test`])
    const accR = (await pool.query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, title, raw)
       VALUES ($1, $2, $3, 'R', $4, '{}'::jsonb) RETURNING id`,
      [integrationId, `extR-${TS}`, `keyR-${TS}`, TITLE],
    )).rows[0].id
    await pool.query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [accR, REQ],
    )
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    apprTok = await tok(base, APPROVER)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`rtitle-${TS}-%`])).rows.map((r) => r.id as string)
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
      if (integrationId) {
        await pool.query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
        await pool.query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
        await pool.query(`DELETE FROM users WHERE id = $1`, [REQ])
      }
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('freezes directoryTitle into requester_snapshot and routes the condition on the reloaded value at dispatch', async () => {
    const key = `rtitle-${TS}-1`
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }, approvalGraph: GRAPH },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)

    // requester REQ starts → createApproval freezes directory title into requester_snapshot.
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const startBody = (await started.json()) as { id?: string; data?: { id: string } }
    const iid = startBody.id ?? startBody.data!.id

    const pool = poolManager.get()
    // (a) JSONB round-trip: directory-resolved title frozen at create, survives the column.
    const snap = (await pool.query<{ requester_snapshot: { directoryTitle?: string } | null; current_node_key: string | null }>(
      `SELECT requester_snapshot, current_node_key FROM approval_instances WHERE id = $1`,
      [iid],
    )).rows[0]
    expect(snap.requester_snapshot?.directoryTitle).toBe(TITLE)
    expect(snap.current_node_key).toBe('approval_1')

    // dispatch: APPROVER approves approval_1 → dispatchAction reloads requester_snapshot FROM the row
    // and re-threads requesterContext; the condition then routes on the reloaded frozen value.
    const approved = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
    expect(approved.status, await approved.clone().text()).toBeLessThan(300)

    // (b) routed to the manager branch using the reloaded frozen title (not formData, not actor.title).
    const after = (await pool.query<{ current_node_key: string | null }>(
      `SELECT current_node_key FROM approval_instances WHERE id = $1`,
      [iid],
    )).rows[0]
    expect(after.current_node_key).toBe('approval_mgr')
    const assignees = (await pool.query<{ assignee_id: string }>(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND assignment_type = 'user' AND is_active = TRUE`,
      [iid],
    )).rows.map((r) => r.assignee_id)
    expect(assignees).toContain(MGR)
    expect(assignees).not.toContain(OTHER)
  })
})
