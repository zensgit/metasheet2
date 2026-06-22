import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * Delegation (委托) bake→resolve seam — real-DB create/start.
 *
 * Proves the seam THIS feature introduces (P2c): createApproval() READS
 * approval_delegations, FREEZES the active delegator->delegatee map into
 * requester_snapshot, and INSERTS the SUBSTITUTED assignment. A static_user node points
 * at the delegator; an active 'all'-scope delegation routes it to the delegatee. The
 * substitution/dedup LOGIC itself is covered by the resolver unit tests — this proves
 * the real DB wire (read → freeze → insert) that the unit tests hand-feed.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `del-req-${TS}`
const DELEGATOR = `del-from-${TS}`
const DELEGATEE = `del-to-${TS}`

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

describeIfDatabase('delegation (委托) bake→resolve seam — real-DB create/start', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    // Active 'all'-scope delegation DELEGATOR -> DELEGATEE covering the create instant.
    await pool.query(
      `INSERT INTO approval_delegations (id, delegator_user_id, delegatee_user_id, scope, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', TRUE)`,
      [`deld-${TS}`, DELEGATOR, DELEGATEE],
    )
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`%-${TS}`])).rows.map((r) => r.id as string)
      if (tids.length > 0) {
        const iids = (await pool.query(`SELECT id FROM approval_instances WHERE template_id = ANY($1)`, [tids])).rows.map((r) => r.id as string)
        if (iids.length > 0) {
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1)`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1)`, [tids])
      }
      await pool.query(`DELETE FROM approval_delegations WHERE id = $1`, [`deld-${TS}`])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('reads approval_delegations → freezes into requester_snapshot → inserts the delegatee assignment', async () => {
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'a',
          config: { assigneeSources: [{ kind: 'static_user', userIds: [DELEGATOR] }], approvalMode: 'single', emptyAssigneePolicy: 'error' },
        },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 'e1', source: 'start', target: 'approval_1' }, { key: 'e2', source: 'approval_1', target: 'end' }],
    }
    const key = `del-seam-${TS}`
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }, approvalGraph: graph },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)

    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(started.status, await started.clone().text()).toBeLessThan(300) // node resolves to the DELEGATEE (a valid assignee), not empty
    const body = (await started.json()) as { id?: string; data?: { id: string } }
    const aid = body.id ?? body.data?.id

    const pool = poolManager.get()
    // (1) read → freeze: the active delegation is baked into the instance snapshot.
    const snap = (
      await pool.query<{ requester_snapshot: { delegations?: Record<string, string> } | null }>(
        `SELECT requester_snapshot FROM approval_instances WHERE id = $1`,
        [aid],
      )
    ).rows[0]?.requester_snapshot
    expect(snap?.delegations).toEqual({ [DELEGATOR]: DELEGATEE })

    // (2) freeze → insert substituted: the pending assignee is the DELEGATEE, and the
    // DELEGATOR was never inserted as an assignment.
    const assignees = (
      await pool.query<{ assignee_id: string }>(
        `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND assignment_type = 'user'`,
        [aid],
      )
    ).rows.map((r) => r.assignee_id)
    expect(assignees).toContain(DELEGATEE)
    expect(assignees).not.toContain(DELEGATOR)
  })
})
