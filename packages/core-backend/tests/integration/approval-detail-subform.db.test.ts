import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

/**
 * Detail / sub-form (明细/子表单) C-2 runtime — real-DB submit→freeze→read round-trip.
 *
 * The unit tests cover validateApprovalFormData / pruneHiddenFormData against hand-built
 * schemas. This proves the REAL WIRE the unit tests hand-feed: a detail template's `columns`
 * survive the JSONB round-trip on the template version, and createApproval validates the
 * submitted rows, prunes hidden/unknown cells per row, and freezes the result into
 * form_snapshot. (wire-vs-fixture guard: `columns` is a new field-by-field-serialized member.)
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `det-req-${TS}`

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

describeIfDatabase('detail / sub-form (明细) submit→freeze→read — real-DB round-trip (C-2)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let tid = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)

    const graph = {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'approval_1', type: 'approval', name: 'a', config: { assigneeSources: [{ kind: 'static_user', userIds: [REQ] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [{ key: 'e1', source: 'start', target: 'approval_1' }, { key: 'e2', source: 'approval_1', target: 'end' }],
    }
    const key = `det-tpl-${TS}`
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: {
        key,
        name: key,
        formSchema: {
          fields: [{
            id: 'items', type: 'detail', label: '明细', required: true, minRows: 1, maxRows: 5,
            columns: [
              { id: 'product', type: 'text', label: '品名', required: true },
              { id: 'qty', type: 'number', label: '数量', required: true },
              { id: 'memo', type: 'text', label: '备注', visibilityRule: { fieldId: 'product', operator: 'eq', value: 'special' } },
            ],
          }],
        },
        approvalGraph: graph,
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    tid = ((await created.json()) as { id: string }).id
    expect((await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })).status).toBe(200)
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
        await pool.query(`DELETE FROM approval_template_versions WHERE template_id = ANY($1)`, [tids])
        await pool.query(`DELETE FROM approval_templates WHERE id = ANY($1)`, [tids])
      }
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('persists detail columns on the template version (JSONB round-trip)', async () => {
    const pool = poolManager.get()
    const row = (await pool.query<{ form_schema: { fields: Array<{ id: string; columns?: Array<{ id: string }>; minRows?: number; maxRows?: number }> } }>(
      `SELECT v.form_schema FROM approval_template_versions v JOIN approval_templates t ON t.latest_version_id = v.id WHERE t.id = $1`,
      [tid],
    )).rows[0]
    const detail = row.form_schema.fields.find((field) => field.id === 'items')
    expect(detail?.columns?.map((column) => column.id)).toEqual(['product', 'qty', 'memo'])
    expect(detail?.minRows).toBe(1)
    expect(detail?.maxRows).toBe(5)
  })

  it('validates rows + freezes the detail into form_snapshot, pruning a hidden cell and an unknown sub-key', async () => {
    const started = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: {
        templateId: tid,
        formData: { items: [
          { product: 'A', qty: 2, memo: 'should-drop', junk: 'x' }, // memo hidden (product != special); junk unknown
          { product: 'special', qty: 1, memo: 'keep' },             // memo visible
        ] },
      },
    })
    expect(started.status, await started.clone().text()).toBeLessThan(300)
    const body = (await started.json()) as { id?: string; data?: { id: string } }
    const aid = body.id ?? body.data?.id

    const pool = poolManager.get()
    const snapshot = (await pool.query<{ form_snapshot: { items: Array<Record<string, unknown>> } }>(
      `SELECT form_snapshot FROM approval_instances WHERE id = $1`,
      [aid],
    )).rows[0].form_snapshot
    expect(snapshot.items).toEqual([
      { product: 'A', qty: 2 },
      { product: 'special', qty: 1, memo: 'keep' },
    ])
  })

  it('rejects an invalid detail submission (missing required cell) with a row-addressed 400', async () => {
    const bad = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { items: [{ product: 'A' }] } }, // missing required qty
    })
    expect(bad.status).toBe(400)
    expect(await bad.text()).toMatch(/items\[0\]\.qty is required/)
  })
})
