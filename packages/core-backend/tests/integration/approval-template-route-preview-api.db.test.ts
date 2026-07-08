/**
 * RP-3 — POST /api/approval-templates/:id/route-preview (route-preview lock, RATIFIED; B3-06
 * 模板作者 authoring 试运行).
 *
 * The admin dry-run surface. Proves over real HTTP + real Postgres:
 * - canManageTemplates guard (403 for a caller without it) — the sampleRequesterId org-probe
 *   surface is unreachable to ordinary users (owner order ③);
 * - DRAFT preview: an UN-published template is previewable (the substrate compiles the authoring
 *   graph via the same buildRuntimeGraph publish uses, and skips the published gate);
 * - sampleRequesterId DRIVES the resolved route (a `requester`-kind node resolves to the sample
 *   requester → different sample id ⇒ different assignee), and falls back to the admin actor when
 *   omitted;
 * - zero writes (scoped to this test's template).
 *
 * The preview===create consistency golden + delegation/fault goldens live in the RP-1 substrate
 * suite; this file owns the B3-06 wire surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const ADMIN = `u_rp3_admin_${TS}`
const SAMPLE_A = `u_rp3_a_${TS}`
const SAMPLE_A_NAME = `样例发起人甲-${TS}`
const SAMPLE_B = `u_rp3_b_${TS}`
const SAMPLE_B_NAME = `样例发起人乙-${TS}`

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
  truncated: boolean
}

describeIfDatabase('RP-3 — POST /api/approval-templates/:id/route-preview (real-DB HTTP)', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let adminTok = ''
  let draftTemplateId = ''
  let deptRoutingDraftId = ''

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    for (const [uid, name] of [[SAMPLE_A, SAMPLE_A_NAME], [SAMPLE_B, SAMPLE_B_NAME], [ADMIN, ADMIN]] as const) {
      await pool.query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $3, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE`,
        [uid, `${uid}@rp3.test`, name],
      )
    }

    // A DRAFT template — created but NEVER published. Its single approval node assigns to the
    // `requester`, so the resolved assignee == whichever requester the preview runs as.
    const approvals = new ApprovalProductService()
    const template = await approvals.createTemplate({
      key: `rp3-${TS}`,
      name: 'RP3 Authoring Preview Template',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          { key: 'approval_1', type: 'approval', name: '发起人自审', config: { mode: 'any', assigneeSources: [{ kind: 'requester' }] } },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'end' },
        ],
      },
    } as never, { userId: ADMIN, userName: ADMIN } as never)
    draftTemplateId = (template as { id: string }).id
    // NOTE: deliberately NOT published — the whole point of B3-06 is previewing un-published edits.

    // A draft that ROUTES on requester.department — for pinning the wedge-guard contract when a
    // sample requester lacks the department the graph needs.
    const deptTemplate = await approvals.createTemplate({
      key: `rp3dept-${TS}`,
      name: 'RP3 Dept-Routing Draft',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          { key: 'cond_1', type: 'condition', name: 'route', config: { branches: [{ edgeKey: 'eng', rules: [], formula: { expression: 'requester.department == "工程部"' } }], defaultEdgeKey: 'other' } },
          { key: 'approval_eng', type: 'approval', name: '工程审批', config: { mode: 'any', assigneeSources: [{ kind: 'requester' }] } },
          { key: 'approval_other', type: 'approval', name: '其他审批', config: { mode: 'any', assigneeSources: [{ kind: 'requester' }] } },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e0', source: 'start', target: 'cond_1' },
          { key: 'eng', source: 'cond_1', target: 'approval_eng' },
          { key: 'other', source: 'cond_1', target: 'approval_other' },
          { key: 'ee', source: 'approval_eng', target: 'end' },
          { key: 'eo', source: 'approval_other', target: 'end' },
        ],
      },
    } as never, { userId: ADMIN, userName: ADMIN } as never)
    deptRoutingDraftId = (deptTemplate as { id: string }).id

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    adminTok = await tokWith(base, ADMIN, 'admin', '*:*')
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      for (const tid of [draftTemplateId, deptRoutingDraftId]) {
        if (!tid) continue
        const iids = (await pool.query(`SELECT id FROM approval_instances WHERE template_id = $1`, [tid])).rows.map((r) => r.id as string)
        if (iids.length > 0) {
          await pool.query(`DELETE FROM approval_records WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1)`, [iids])
          await pool.query(`DELETE FROM approval_instances WHERE id = ANY($1)`, [iids])
        }
        await pool.query(`DELETE FROM approval_published_definitions WHERE template_id = $1`, [tid])
        await pool.query(`DELETE FROM approval_templates WHERE id = $1`, [tid])
      }
      await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ADMIN, SAMPLE_A, SAMPLE_B]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  const PATH = () => `/api/approval-templates/${draftTemplateId}/route-preview`

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('401 without a token', async () => {
    expect((await post(base, PATH(), null, { sampleFormData: { summary: 's' } })).status).toBe(401)
  })

  it('403 without canManageTemplates (owner order ③ — sampleRequesterId probe surface is admin-only)', async () => {
    const reader = await tokWith(base, `u_rp3_reader_${TS}`, 'user', 'approvals:read')
    const res = await post(base, PATH(), reader, { sampleFormData: { summary: 's' }, sampleRequesterId: SAMPLE_A })
    expect(res.status).toBe(403)
  })

  it('400 when sampleFormData is missing/malformed', async () => {
    expect((await post(base, PATH(), adminTok, { sampleRequesterId: SAMPLE_A })).status).toBe(400)
    expect((await post(base, PATH(), adminTok, { sampleFormData: ['nope'] })).status).toBe(400)
  })

  it('404 for an unknown templateId', async () => {
    const res = await post(base, `/api/approval-templates/00000000-0000-4000-8000-000000000000/route-preview`, adminTok, { sampleFormData: { summary: 's' } })
    expect(res.status).toBe(404)
  })

  it('previews a DRAFT (never-published) template and resolves the route as the SAMPLE requester', async () => {
    const resA = await post(base, PATH(), adminTok, { sampleFormData: { summary: 'draft run' }, sampleRequesterId: SAMPLE_A })
    expect(resA.status, await resA.clone().text()).toBe(200)
    const bodyA = (await resA.json()) as PreviewBody
    // Draft compiled + walked; the requester-kind node resolved to sample A (with name enrichment).
    expect(bodyA.route.map((n) => n.nodeKey)).toEqual(['approval_1'])
    expect(bodyA.route[0]!.assignees).toEqual([{ id: SAMPLE_A, name: SAMPLE_A_NAME, assignmentType: 'user' }])

    // A DIFFERENT sample requester ⇒ a different resolved assignee — proves sampleRequesterId drives
    // the routing identity (the org-probe capability), not the admin caller.
    const resB = await post(base, PATH(), adminTok, { sampleFormData: { summary: 'draft run' }, sampleRequesterId: SAMPLE_B })
    const bodyB = (await resB.json()) as PreviewBody
    expect(bodyB.route[0]!.assignees).toEqual([{ id: SAMPLE_B, name: SAMPLE_B_NAME, assignmentType: 'user' }])
  })

  it('falls back to the admin actor as requester when sampleRequesterId is omitted', async () => {
    const res = await post(base, PATH(), adminTok, { sampleFormData: { summary: 'no sample' } })
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as PreviewBody
    expect(body.route[0]!.assignees.map((a) => a.id)).toEqual([ADMIN])
  })

  it('PINNED CONTRACT: a requester-attribute wedge fails closed (422), same as create — NOT a fake default route', async () => {
    // The template routes on requester.department; the sample requester has no department. The
    // shared substrate's wedge guard fails closed (422) exactly as the real create would — preview
    // must NOT gracefully show the default branch, because create would REJECT this requester, not
    // route them to default. Fidelity (preview===create) over convenience. The FE surfaces this as
    // "此样例发起人缺少部门，真实提交会被拒", not a misleading resolved path.
    const res = await post(base, `/api/approval-templates/${deptRoutingDraftId}/route-preview`, adminTok, {
      sampleFormData: { summary: 'dept route' },
      sampleRequesterId: SAMPLE_A,
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe('APPROVAL_REQUESTER_DEPARTMENT_REQUIRED')
  })

  it('§3 output-contract conformance + ZERO writes (scoped to this template)', async () => {
    const pool = poolManager.get()
    const countRows = async () => {
      const [i, a] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS c FROM approval_instances WHERE template_id = $1', [draftTemplateId]),
        pool.query('SELECT COUNT(*)::int AS c FROM approval_assignments WHERE instance_id IN (SELECT id FROM approval_instances WHERE template_id = $1)', [draftTemplateId]),
      ])
      return { instances: i.rows[0].c as number, assignments: a.rows[0].c as number }
    }
    const before = await countRows()
    const res = await post(base, PATH(), adminTok, { sampleFormData: { summary: 'zero write' }, sampleRequesterId: SAMPLE_A })
    expect(res.status).toBe(200)
    const body = (await res.json()) as PreviewBody
    expect(Object.keys(body).sort()).toEqual(['route', 'truncated'])
    expect(await countRows()).toEqual(before)
  })
})
