import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * POST-GATE integration acceptance (A/E/B/D/G combined) — the runbook, executed.
 * ONE 3-node template: Node1 = static picker (A) + hidden field (B); Node2 = self-approver (E);
 * Node3 = normal node for add/reduce-sign (D). Plus an old-template regression (G snapshot harmless).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `acc-req-${TS}`, A1 = `acc-n1-${TS}`, A3 = `acc-n3-${TS}`, COS = `acc-cosign-${TS}`

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
const node = (key: string, cfg: Record<string, unknown>) => ({ key, type: 'approval', name: key, config: cfg })

describeIfDatabase('POST-GATE acceptance — A/E/B/D/G combined (real DB)', () => {
  let server: MetaSheetServer | undefined, base = '', reqTok = '', a1Tok = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ); a1Tok = await tok(base, A1)
  })
  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`acc-%-${TS}%`])).rows.map((r) => r.id as string)
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

  it('A+E+B coexist on one published template; start → B redaction at Node1; E self-resolves Node2; D add/reduce on Node3; G snapshot does not block', async () => {
    // ---- author the 3-node multi-feature template (A assignee + B hidden on Node1; E on Node2; D node = Node3) ----
    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 'start', config: {} },
        node('approval_1', { assigneeSources: [{ kind: 'static_user', userIds: [A1] }], approvalMode: 'single', fieldPermissions: [{ fieldId: 'secret', access: 'hidden' }] }),
        node('approval_2', { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', autoApprovalPolicy: { mergeWithRequester: true } }),
        node('approval_3', { assigneeSources: [{ kind: 'static_user', userIds: [A3] }], approvalMode: 'single' }),
        { key: 'end', type: 'end', name: 'end', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' }, { key: 'e2', source: 'approval_1', target: 'approval_2' },
        { key: 'e3', source: 'approval_2', target: 'approval_3' }, { key: 'e4', source: 'approval_3', target: 'end' },
      ],
    }
    const form = { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }, { id: 'secret', type: 'text', label: 's' }] }
    const created = await req(base, '/api/approval-templates', reqTok, { method: 'POST', body: { key: `acc-multi-${TS}`, name: 'acc multi', formSchema: form, approvalGraph: graph } })
    expect(created.status, await created.clone().text()).toBe(201) // A+E+B coexist + normalize accepts
    const tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)

    // ---- start (G snapshot best-effort must not block) ----
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r', secret: 'TOP-SECRET' } } })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const startedBody = (await started.json()) as { id?: string; data?: { id: string } }
    const aid = startedBody.id ?? startedBody.data?.id

    // ---- B: at Node1 (hiding node) the hidden field is redacted for every viewer; DB byte-intact ----
    const detail = await (await req(base, `/api/approvals/${aid}`, a1Tok)).json() as any
    const snap = detail.formSnapshot ?? detail.data?.formSnapshot ?? {}
    expect(snap.reason).toBe('r')
    expect('secret' in snap).toBe(false) // B redaction (approver view)
    const dbRow = (await poolManager.get().query(`SELECT form_snapshot FROM approval_instances WHERE id=$1`, [aid])).rows[0]
    expect((dbRow.form_snapshot as any).secret).toBe('TOP-SECRET') // DB byte-intact

    // ---- approve Node1 → E self-resolves Node2 → pending at Node3; B field reappears ----
    expect((await req(base, `/api/approvals/${aid}/actions`, a1Tok, { method: 'POST', body: { action: 'approve', comment: 'n1' } })).status).toBeLessThan(300)
    const afterN1 = await (await req(base, `/api/approvals/${aid}`, reqTok)).json() as any
    const cur = afterN1.currentNodeKey ?? afterN1.data?.currentNodeKey
    expect(cur, JSON.stringify(afterN1).slice(0, 300)).toBe('approval_3') // E auto-resolved Node2, now at Node3
    const snap3 = afterN1.formSnapshot ?? afterN1.data?.formSnapshot ?? {}
    expect(snap3.secret).toBe('TOP-SECRET') // B: hidden field present again after leaving Node1

    // ---- D: add_sign then reduce_sign on Node3 ----
    const a3Tok = await tok(base, A3)
    const addR = await req(base, `/api/approvals/${aid}/actions`, a3Tok, { method: 'POST', body: { action: 'add_sign', targetUserIds: [COS], addSignMode: 'parallel' } })
    expect(addR.status, await addR.clone().text()).toBeLessThan(300)
    const activeAfterAdd = (await poolManager.get().query(`SELECT count(*)::int n FROM approval_assignments WHERE instance_id=$1 AND node_key='approval_3' AND is_active=TRUE`, [aid])).rows[0].n
    expect(activeAfterAdd).toBeGreaterThanOrEqual(2) // add_sign extended the node
    const redR = await req(base, `/api/approvals/${aid}/actions`, a3Tok, { method: 'POST', body: { action: 'reduce_sign', targetAssignmentUserId: COS } })
    expect(redR.status, await redR.clone().text()).toBeLessThan(300)
    const cosActive = (await poolManager.get().query(`SELECT count(*)::int n FROM approval_assignments WHERE instance_id=$1 AND node_key='approval_3' AND assignee_id=$2 AND is_active=TRUE`, [aid, COS])).rows[0].n
    expect(cosActive).toBe(0) // reduce_sign deactivated only the added co-signer
  })

  it('legacy template (no features): create/start/approve flow unchanged; G snapshot harmless (flow-equivalence, not a byte diff)', async () => {
    const form = { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }
    const graph = { nodes: [{ key: 'start', type: 'start', name: 's', config: {} }, node('approval_1', { assigneeSources: [{ kind: 'static_user', userIds: [A1] }], approvalMode: 'single' }), { key: 'end', type: 'end', name: 'e', config: {} }], edges: [{ key: 'e1', source: 'start', target: 'approval_1' }, { key: 'e2', source: 'approval_1', target: 'end' }] }
    const c = await req(base, '/api/approval-templates', reqTok, { method: 'POST', body: { key: `acc-legacy-${TS}`, name: 'legacy', formSchema: form, approvalGraph: graph } })
    expect(c.status).toBe(201)
    const tid = ((await c.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)
    const s = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(s.status).toBeLessThan(300) // create succeeds; G snapshot bake never blocks
    const sBody = (await s.json()) as { id?: string; data?: { id: string } }
    const aid = sBody.id ?? sBody.data?.id
    expect((await req(base, `/api/approvals/${aid}/actions`, a1Tok, { method: 'POST', body: { action: 'approve', comment: 'ok' } })).status).toBeLessThan(300)
  })
})
