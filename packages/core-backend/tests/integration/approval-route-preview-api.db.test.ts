/**
 * RP-2 — POST /api/approvals/preview (route-preview lock, RATIFIED; B3-05 发起页预览).
 *
 * Route-level proof over real HTTP + real Postgres: the preview endpoint carries the SAME
 * guard chain as POST /api/approvals (authenticate + rbacGuard approvals:write), interprets
 * the body only through the read-only substrate (previewApprovalRoute), display-enriches
 * assignee names with an honest id fallback, and writes NOTHING. The service-level
 * preview===create golden lives in approval-route-preview-substrate.db.test.ts; this file
 * owns the wire surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQUESTER = `u_rp2_req_${TS}`
const APPROVER_NAMED = `u_rp2_named_${TS}`
const APPROVER_BLANK = `u_rp2_blank_${TS}`
const NAMED_DISPLAY = `预览审批人甲-${TS}`

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}
async function tokWith(base: string, userId: string, roles: string, perms: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`)
  return ((await res.json()) as { token: string }).token
}
async function post(base: string, path: string, token: string | null, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

interface PreviewBody {
  route: Array<{ nodeKey: string; nodeLabel: string; assignees: Array<{ id: string; name: string; assignmentType: string }>; resolveError?: string }>
  totalSteps: number
  truncated: boolean
}

describeIfDatabase('RP-2 — POST /api/approvals/preview (real-DB HTTP)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let requesterTok = ''
  let templateId = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    // APPROVER_NAMED gets a real display name (enrichment must surface it); APPROVER_BLANK a
    // whitespace-only name (enrichment must fall back to the honest id, never render blank).
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE`,
      [APPROVER_NAMED, `${APPROVER_NAMED}@rp2.test`, NAMED_DISPLAY],
    )
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, '  ', 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE`,
      [APPROVER_BLANK, `${APPROVER_BLANK}@rp2.test`],
    )
    await pool.query(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [REQUESTER, `${REQUESTER}@rp2.test`],
    )

    const approvals = new ApprovalProductService()
    const template = await approvals.createTemplate({
      key: `rp2-${TS}`,
      name: 'RP2 Preview API Template',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          { key: 'approval_1', type: 'approval', name: '一级审批', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER_NAMED] }] } },
          { key: 'approval_2', type: 'approval', name: '二级审批', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER_BLANK] }] } },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'approval_2' },
          { key: 'e3', source: 'approval_2', target: 'end' },
        ],
      },
    } as never, { userId: REQUESTER, userName: REQUESTER } as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    requesterTok = await tokWith(base, REQUESTER, 'user', 'approvals:write')
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const iids = (await pool.query(`SELECT id FROM approval_instances WHERE template_id = $1`, [templateId])).rows.map((r) => r.id as string)
      if (iids.length > 0) {
        await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
        await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
        await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
      }
      await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = $1`, [templateId])
      await pool.query(`DELETE FROM approval_templates WHERE id = $1`, [templateId])
      await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[REQUESTER, APPROVER_NAMED, APPROVER_BLANK]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('401 without a token (authenticate rung intact)', async () => {
    const res = await post(base, '/api/approvals/preview', null, { templateId, formData: { summary: 's' } })
    expect(res.status).toBe(401)
  })

  it('403 without approvals:write (rbacGuard rung intact — read-only caller cannot probe routes)', async () => {
    const readerTok = await tokWith(base, `u_rp2_reader_${TS}`, 'user', 'approvals:read')
    const res = await post(base, '/api/approvals/preview', readerTok, { templateId, formData: { summary: 's' } })
    expect(res.status).toBe(403)
  })

  it('400 when templateId or formData is missing/malformed', async () => {
    expect((await post(base, '/api/approvals/preview', requesterTok, { formData: { summary: 's' } })).status).toBe(400)
    expect((await post(base, '/api/approvals/preview', requesterTok, { templateId })).status).toBe(400)
    expect((await post(base, '/api/approvals/preview', requesterTok, { templateId, formData: ['not-an-object'] })).status).toBe(400)
  })

  it('404 for an unknown templateId (ServiceError passthrough, no 500)', async () => {
    // Well-formed uuid that matches nothing (approval_templates.id is uuid — a non-uuid string
    // dies at the cast with 500 on the create route too; that口径 is pre-existing, not RP-2's).
    const res = await post(base, '/api/approvals/preview', requesterTok, { templateId: '00000000-0000-4000-8000-000000000000', formData: { summary: 's' } })
    expect(res.status).toBe(404)
  })

  it('200 happy path: resolved route with display-name enrichment + honest id fallback, and ZERO writes', async () => {
    const pool = poolManager.get()
    const countRows = async () => {
      const [i, a, r] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS c FROM approval_instances'),
        pool.query('SELECT COUNT(*)::int AS c FROM approval_assignments'),
        pool.query('SELECT COUNT(*)::int AS c FROM approval_records'),
      ])
      return { instances: i.rows[0].c as number, assignments: a.rows[0].c as number, records: r.rows[0].c as number }
    }
    const before = await countRows()

    const res = await post(base, '/api/approvals/preview', requesterTok, { templateId, formData: { summary: 'wire run' } })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as PreviewBody

    expect(body.truncated).toBe(false)
    expect(body.route.map((n) => n.nodeKey)).toEqual(['approval_1', 'approval_2'])
    expect(body.route[0]!.nodeLabel).toBe('一级审批')
    // Display-name enrichment: node 1's approver has a real users.name → surfaced verbatim.
    expect(body.route[0]!.assignees).toEqual([{ id: APPROVER_NAMED, name: NAMED_DISPLAY, assignmentType: 'user' }])
    // Honest fallback: node 2's approver has a whitespace-only name → id, never a blank chip.
    expect(body.route[1]!.assignees).toEqual([{ id: APPROVER_BLANK, name: APPROVER_BLANK, assignmentType: 'user' }])

    expect(await countRows()).toEqual(before)
  })
})
