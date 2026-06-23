import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * Delegation (委托) config CRUD — real-DB API. Exercises the admin-managed
 * /api/approval-delegations routes (approval-templates:manage) against real Postgres:
 * create / unique-active conflict / self-delegation reject / template-scope target /
 * list / disable. Proves the routes + SQL + table CHECKs together (the unit tests use
 * a fake query).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const ADMIN = `del-admin-${TS}`
const FROM = `del-from-${TS}`
const TO = `del-to-${TS}`
const MGR = `del-mgr-${TS}`

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
async function tokWith(base: string, userId: string, roles: string, perms: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`)
  return ((await res.json()) as { token: string }).token
}
async function req(base: string, path: string, token: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
}

const WINDOW = { startAt: new Date(Date.now() - 3600_000).toISOString(), endAt: new Date(Date.now() + 3600_000).toISOString() }

describeIfDatabase('delegation (委托) config CRUD — real-DB API', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let adminTok = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    // Seed the real RBAC chain for a least-privilege manager: rbacGuard walks
    // user_permissions / namespace admission, not just the token claims, so the
    // manage-only positive needs an actual grant (mirrors the W6 seam test seedUsers).
    const seedPool = poolManager.get()
    await seedPool.query(`INSERT INTO permissions (code, name, description) VALUES ('approval-templates:manage', 'Approval Templates Manage', 'delegation API test') ON CONFLICT (code) DO NOTHING`)
    await seedPool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [MGR, `${MGR}@example.test`],
    )
    await seedPool.query(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approval-templates:manage') ON CONFLICT DO NOTHING`, [MGR])
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    adminTok = await tok(base, ADMIN)
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
      await pool.query(`DELETE FROM approval_delegations WHERE delegator_user_id LIKE $1`, [`%-${TS}`])
      await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [MGR])
      await pool.query(`DELETE FROM users WHERE id = $1`, [MGR])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('enforces approval-templates:manage on the routes (403 without it; manage-only is allowed)', async () => {
    // a non-admin user WITHOUT approval-templates:manage → 403 on read AND write
    const reader = await tokWith(base, `del-reader-${TS}`, 'user', 'approvals:read')
    expect((await req(base, '/api/approval-delegations', reader)).status).toBe(403)
    expect(
      (await req(base, '/api/approval-delegations', reader, { method: 'POST', body: { delegatorUserId: `x-${TS}`, delegateeUserId: `y-${TS}`, scope: 'all', ...WINDOW } })).status,
    ).toBe(403)
    // a non-admin user holding ONLY approval-templates:manage (not *:*) → allowed
    const manager = await tokWith(base, MGR, 'user', 'approval-templates:manage')
    expect((await req(base, '/api/approval-delegations', manager)).status).toBe(200)
  })

  it('creates → lists → conflicts → rejects self/template → disables', async () => {
    // create
    const created = await req(base, '/api/approval-delegations', adminTok, {
      method: 'POST',
      body: { delegatorUserId: FROM, delegateeUserId: TO, scope: 'all', ...WINDOW },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const id = ((await created.json()) as { data: { id: string } }).data.id

    // list shows it (admin view)
    const listed = await req(base, '/api/approval-delegations', adminTok)
    const rows = ((await listed.json()) as { data: Array<{ id: string; delegatorUserId: string; delegateeUserId: string }> }).data
    expect(rows.find((r) => r.id === id)).toMatchObject({ delegatorUserId: FROM, delegateeUserId: TO })

    // a second active row for the same (delegator, scope target) → 409 conflict
    const dup = await req(base, '/api/approval-delegations', adminTok, {
      method: 'POST',
      body: { delegatorUserId: FROM, delegateeUserId: `${TO}-x`, scope: 'all', ...WINDOW },
    })
    expect(dup.status).toBe(409)

    // self-delegation → 400
    const self = await req(base, '/api/approval-delegations', adminTok, {
      method: 'POST',
      body: { delegatorUserId: FROM, delegateeUserId: FROM, scope: 'all', ...WINDOW },
    })
    expect(self.status).toBe(400)

    // scope=template with no target → 400
    const noTarget = await req(base, '/api/approval-delegations', adminTok, {
      method: 'POST',
      body: { delegatorUserId: `${FROM}-t`, delegateeUserId: TO, scope: 'template', ...WINDOW },
    })
    expect(noTarget.status).toBe(400)

    // disable → 200, then it leaves the active list
    const disabled = await req(base, `/api/approval-delegations/${id}`, adminTok, { method: 'DELETE' })
    expect(disabled.status).toBe(200)
    const after = await req(base, '/api/approval-delegations', adminTok)
    const afterRows = ((await after.json()) as { data: Array<{ id: string }> }).data
    expect(afterRows.find((r) => r.id === id)).toBeUndefined()
  })

  it('end-to-end: create a delegation via the API → start an approval → assignment resolves to the delegatee', async () => {
    const e2eFrom = `del-e2e-from-${TS}`
    const e2eTo = `del-e2e-to-${TS}`
    // 1) create the delegation via the API
    const del = await req(base, '/api/approval-delegations', adminTok, {
      method: 'POST',
      body: { delegatorUserId: e2eFrom, delegateeUserId: e2eTo, scope: 'all', ...WINDOW },
    })
    expect(del.status, await del.clone().text()).toBe(201)

    // 2) publish a static_user[delegator] template + start an approval
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'approval_1', type: 'approval', name: 'a', config: { assigneeSources: [{ kind: 'static_user', userIds: [e2eFrom] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 'e1', source: 'start', target: 'approval_1' }, { key: 'e2', source: 'approval_1', target: 'end' }],
    }
    const key = `del-api-e2e-${TS}`
    const created = await req(base, '/api/approval-templates', adminTok, {
      method: 'POST',
      body: { key, name: key, formSchema: { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }, approvalGraph: graph },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, adminTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)

    const started = await req(base, '/api/approvals', adminTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const body = (await started.json()) as { id?: string; data?: { id: string } }
    const aid = body.id ?? body.data?.id

    // 3) the assignment is the DELEGATEE (API-created delegation flowed through bake→resolve)
    const assignees = (
      await poolManager.get().query<{ assignee_id: string }>(
        `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND assignment_type = 'user'`,
        [aid],
      )
    ).rows.map((r) => r.assignee_id)
    expect(assignees).toContain(e2eTo)
    expect(assignees).not.toContain(e2eFrom)
  })
})
