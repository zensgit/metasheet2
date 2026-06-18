import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * direct_manager assignee source — real-DB create/start.
 *
 * SCOPE: this exercises the create/start WIRING (normalizer accepts `direct_manager`;
 * the resolver runs in the real createApproval→dispatch path) and the locked
 * "unresolvable manager → emptyAssigneePolicy" decision on BOTH branches. The requester
 * has NO directory manager, so `requesterSnapshot.managerId` is absent and the node
 * resolves empty. The RESOLVED-manager assignment (managerId present) is covered by the
 * resolver unit test (resolution logic + metadata) and the ApprovalDirectoryOrg plumbing
 * tests (directory → managerId snapshot bake); it is intentionally NOT re-seeded here as a
 * 5-table directory fixture.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `dm-req-${TS}`

async function canListen(): Promise<boolean> {
  return await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(0, '127.0.0.1', () => s.close(() => r(true))) })
}
async function tok(base: string, userId: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
  return ((await res.json()) as { token: string }).token
}
async function req(base: string, path: string, token: string, opts: { method?: string; body?: unknown } = {}): Promise<Response> {
  return fetch(`${base}${path}`, { method: opts.method || 'GET', headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) })
}
function graph(emptyAssigneePolicy: 'auto-approve' | 'error') {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'approval_1', type: 'approval', name: '直属上级', config: { assigneeSources: [{ kind: 'direct_manager' }], approvalMode: 'single', emptyAssigneePolicy } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [{ key: 'e1', source: 'start', target: 'approval_1' }, { key: 'e2', source: 'approval_1', target: 'end' }],
  }
}

describeIfDatabase('direct_manager assignee source — real-DB create/start', () => {
  let server: MetaSheetServer | undefined, base = '', reqTok = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
  })
  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`dm-%-${TS}%`])).rows.map((r) => r.id as string)
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
    } catch { /* best effort */ }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  async function publish(key: string, emptyAssigneePolicy: 'auto-approve' | 'error'): Promise<string> {
    const created = await req(base, '/api/approval-templates', reqTok, { method: 'POST', body: { key, name: key, formSchema: { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }, approvalGraph: graph(emptyAssigneePolicy) } })
    expect(created.status, await created.clone().text()).toBe(201) // normalizer accepts direct_manager
    const tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)
    return tid
  }

  it('auto-approve branch: a requester with no manager auto-resolves the direct_manager node (does not block)', async () => {
    const tid = await publish(`dm-auto-${TS}`, 'auto-approve')
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const body = (await started.json()) as { id?: string; status?: string; data?: { id: string; status?: string } }
    const aid = body.id ?? body.data?.id
    const status = (await (await req(base, `/api/approvals/${aid}`, reqTok)).json() as any)
    const s = status.status ?? status.data?.status
    // empty direct_manager + auto-approve cascades past approval_1 → terminal approved/completed
    expect(['approved', 'completed', 'auto_approved']).toContain(String(s))
  })

  it('error branch: a requester with no manager makes the direct_manager node fail-create (empty assignee)', async () => {
    const tid = await publish(`dm-err-${TS}`, 'error')
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(started.status).toBeGreaterThanOrEqual(400) // empty assignee under 'error' policy rejects at start
  })
})
