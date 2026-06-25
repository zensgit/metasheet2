import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// Gate B — server-side amount total-check end-to-end (design-lock #3161). Proves what the Gate A unit
// tests can't: the mapping ROUND-TRIPS through form_schema (create → publish → createApproval) and the
// check FIRES fail-closed at submit, plus the fail-closed AUTHORING validation at template-save.

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const ADMIN = `amt-admin-${TS}`
const REQUESTER = `amt-req-${TS}`

async function canListen(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}
async function token(baseUrl: string, userId: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`)
  return ((await r.json()) as { token: string }).token
}
async function api(baseUrl: string, path: string, tok: string, body?: unknown, method = 'POST'): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const FORM_SCHEMA_WITH_CHECK = {
  fields: [
    { id: 'amount', type: 'number', label: '总额', required: true },
    {
      id: 'items', type: 'detail', label: '明细',
      columns: [
        { id: 'name', type: 'text', label: '名称' },
        { id: 'amount', type: 'number', label: '金额' },
      ],
    },
  ],
  amountConsistencyCheck: { totalFieldId: 'amount', detailFieldId: 'items', amountColumnId: 'amount' },
}
const GRAPH = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'a1', type: 'approval', name: '审批', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'a1' },
    { key: 'e2', source: 'a1', target: 'end' },
  ],
}

describeIfDatabase('approval amount total-check (Gate B, real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let adminTok = ''
  let reqTok = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    baseUrl = `http://127.0.0.1:${server.getAddress()!.port}`
    adminTok = await token(baseUrl, ADMIN)
    reqTok = await token(baseUrl, REQUESTER)
  })
  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const ids = (await pool.query('SELECT id FROM approval_templates WHERE key LIKE $1', [`amt-${TS}-%`])).rows.map((r) => r.id as string)
      if (ids.length) {
        await pool.query('DELETE FROM approval_instances WHERE template_id = ANY($1::uuid[])', [ids]).catch(() => {})
        await pool.query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [ids])
        await pool.query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [ids])
      }
    } catch { /* best-effort */ }
    if (server) await server.stop()
  })

  async function publishTemplate(formSchema: unknown): Promise<string> {
    const created = await api(baseUrl, '/api/approval-templates', adminTok, {
      key: `amt-${TS}-${Math.floor(performance.now())}`, name: 'Amount check', formSchema, approvalGraph: GRAPH,
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const id = ((await created.json()) as { id: string }).id
    expect((await api(baseUrl, `/api/approval-templates/${id}/publish`, adminTok, { policy: { allowRevoke: true } })).status).toBe(200)
    return id
  }

  it('rejects a MISMATCHED total at submit (the under-stated bypass) and accepts a MATCHING one', async () => {
    const templateId = await publishTemplate(FORM_SCHEMA_WITH_CHECK)
    // under-stated total (100 < 100+200) → fail-closed, no approval created
    const bad = await api(baseUrl, '/api/approvals', reqTok, { templateId, formData: { amount: 100, items: [{ amount: 100 }, { amount: 200 }] } })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toContain('不一致')
    // matching total → created
    const ok = await api(baseUrl, '/api/approvals', reqTok, { templateId, formData: { amount: 300, items: [{ amount: 100 }, { amount: 200 }] } })
    expect(ok.status, await ok.clone().text()).toBe(201)
  })

  it('rejects a malformed amountConsistencyCheck at TEMPLATE-SAVE (fail-closed authoring)', async () => {
    // totalFieldId points at the detail field (not a number) → rejected at create, before publish
    const bad = await api(baseUrl, '/api/approval-templates', adminTok, {
      key: `amt-${TS}-bad`, name: 'Bad mapping', approvalGraph: GRAPH,
      formSchema: { ...FORM_SCHEMA_WITH_CHECK, amountConsistencyCheck: { totalFieldId: 'items', detailFieldId: 'items', amountColumnId: 'amount' } },
    })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toMatch(/totalFieldId must reference a number field/)
  })

  it('a template WITHOUT the mapping is unaffected (no check path)', async () => {
    const templateId = await publishTemplate({ fields: FORM_SCHEMA_WITH_CHECK.fields }) // no amountConsistencyCheck
    const ok = await api(baseUrl, '/api/approvals', reqTok, { templateId, formData: { amount: 100, items: [{ amount: 999 }] } })
    expect(ok.status, await ok.clone().text()).toBe(201) // inconsistent total accepted — no mapping, no check
  })
})
