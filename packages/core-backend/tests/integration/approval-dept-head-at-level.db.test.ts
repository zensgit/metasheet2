import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { query } from '../../src/db/pg'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-1 §K5-b `dept_head_at_level` (指定层级部门负责人) — REAL-DB end-to-end acceptance
 * (docs/development/approval-lock1-enterprise-assignees-20260817.md §K5-b; gates G-1/G-2/G-3/
 * G-18/G-19/G-20; harness mirrors approval-dept-head-chain.db.test.ts (K4) — this kind is
 * strictly downstream of K4, reading the SAME `deptHeadChainIds` snapshot field, so the org
 * fixture below is deliberately shaped IDENTICALLY to K4's, to prove the SAME chain positioned by
 * a SINGLE `level` resolves the SAME entry `continuous_dept_heads` would slice to).
 *
 * Org fixture (one integration, `dhal-<TS>`):
 *   DEPT_TOP (root; manager list = [HEAD3])
 *     <- DEPT_MID (manager list EMPTY — the continue-past-empty-level level; load-bearing for the
 *                  positional-not-hop-count proof below)
 *          <- DEPT_BOT (REQ's primary dept; manager list = [HEAD1])
 *
 * deptHeadChainIds for REQ = [HEAD1, HEAD3] (DEPT_MID's empty list contributes nothing but does
 * NOT terminate the walk or shift a "hole" into the array — the array is DENSE).
 *
 * Proves:
 *  G-1      level validated byte-identically to manager_at_level: out-of-range / non-integer /
 *           missing 400s; a valid shape saves in the same fixture (positive control);
 *  G-2      a contract-unimplemented kind is rejected at authoring, never persisted;
 *  core     dept_head_at_level level=2 resolves EXACTLY HEAD3 — the SAME entry
 *           continuous_dept_heads levels=2 slices to at position [1] — proving the read is
 *           POSITIONAL over the dense chain (level 2 = the second RESOLVED head, walking through
 *           DEPT_MID's empty level), never "the head 2 parent-hops up" (which would be DEPT_MID's
 *           own — nonexistent — head);
 *  level=1  resolves EXACTLY HEAD1 (the requester's own department head, byte-identical to the
 *           shipped single-level `dept_head`);
 *  out-of-  level=5 (valid in contract, [1, MAX_MANAGER_CHAIN_LEVELS]) against a chain of length 2
 *  range    resolves EMPTY and falls to the node's `emptyAssigneePolicy` — a NORMAL
 *           APPROVAL_ASSIGNEE_EMPTY 400 under 'error' (Lock-1 §K5: never a dispatch CRASH, never
 *           silently coerced to a shallower level);
 *  freeze   a directory mutation (DEPT_BOT's manager list swapped) AFTER create does not change an
 *  purity   in-flight assignment (frozen snapshot) but DOES change a NEWLY created approval — the
 *           freeze is temporal, not a dead/cached read;
 *  G-18     the level-validation 400 body carries the node key/source index, never a person id.
 *
 * G-20 (org-read fail-closed extension to dept_head_at_level) lives in the existing parametrized
 * fixture `approval-routing-policy-failclose.api.test.ts` (KINDS now includes
 * 'dept_head_at_level') — not duplicated here, same posture as K4.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `dhal-req-${TS}`
const APPROVER = `dhal-appr-${TS}`
const U_HEAD1 = `dhal-head1-${TS}`
const U_HEAD1B = `dhal-head1b-${TS}` // post-mutation replacement head (freeze-purity temporal arm)
const U_HEAD3 = `dhal-head3-${TS}`

const EXT_TOP = `dhaltop-${TS}`
const EXT_MID = `dhalmid-${TS}`
const EXT_BOT = `dhalbot-${TS}`
const EXT_HEAD1 = `dhalehead1-${TS}`
const EXT_HEAD1B = `dhalehead1b-${TS}`
const EXT_HEAD3 = `dhalehead3-${TS}`
const EXT_REQ = `dhalereq-${TS}`

async function canListen(): Promise<boolean> {
  return await new Promise((r) => {
    const s = net.createServer()
    s.once('error', () => r(false))
    s.listen(0, '127.0.0.1', () => s.close(() => r(true)))
  })
}
async function tok(base: string, userId: string): Promise<string> {
  await grantApprovalWriteForIntegrationActor(userId)
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

const FORM_SCHEMA = { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }

// gate (static APPROVER) -> head (dept_head_at_level) -> end.
function headGraph(level: number, emptyAssigneePolicy: 'error' | 'auto-approve' = 'error') {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'gate', type: 'approval', name: 'gate', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'head', type: 'approval', name: 'head', config: { assigneeSources: [{ kind: 'dept_head_at_level', level }], approvalMode: 'single', emptyAssigneePolicy } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2g', source: 'start', target: 'gate' },
      { key: 'g2h', source: 'gate', target: 'head' },
      { key: 'h2e', source: 'head', target: 'end' },
    ],
  }
}

type ErrorBody = { code?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } }
function errorCode(body: ErrorBody): string | undefined {
  return body.code ?? body.error?.code
}

describeIfDatabase('Lock-1 §K5-b dept_head_at_level — real-DB create/freeze/dispatch acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let apprTok = ''
  let head1Tok = ''
  let head1bTok = ''
  let head3Tok = ''
  let integrationId = ''
  let deptBotId = ''

  async function createTemplate(key: string, graph: unknown): Promise<string> {
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: graph },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { id: string }).id
  }
  async function publishTemplate(tid: string): Promise<Response> {
    return req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })
  }
  async function createPublished(key: string, graph: unknown): Promise<string> {
    const tid = await createTemplate(key, graph)
    const published = await publishTemplate(tid)
    expect(published.status, await published.clone().text()).toBe(200)
    return tid
  }
  async function activeAssignees(iid: string, nodeKey: string): Promise<Array<{ assignee_id: string; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(
      `SELECT assignee_id, metadata FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE ORDER BY assignee_id`,
      [iid, nodeKey],
    )
    return rows.rows as Array<{ assignee_id: string; metadata: Record<string, unknown> | null }>
  }
  async function createAsReq(tid: string): Promise<{ status: number; iid?: string; text: string }> {
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    const text = await started.clone().text()
    if (started.status >= 300) return { status: started.status, text }
    return { status: started.status, iid: ((await started.json()) as { id: string }).id, text }
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()

    for (const u of [REQ, APPROVER, U_HEAD1, U_HEAD1B, U_HEAD3]) {
      await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`, [u, `${u}@example.test`])
    }

    const integ = await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`dhal-${TS}`, `dhal-corp-${TS}`],
    )
    integrationId = integ.rows[0].id

    // DEPT_TOP <- DEPT_MID(empty) <- DEPT_BOT (REQ's primary) — same shape as K4's fixture.
    await query(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, NULL, 'Top', true, $3::jsonb)`,
      [integrationId, EXT_TOP, JSON.stringify({ dept_manager_userid_list: [EXT_HEAD3] })],
    )
    // DEPT_MID: EMPTY manager list — the continue-past-empty-level / positional proof point.
    await query(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, $3, 'Mid', true, $4::jsonb)`,
      [integrationId, EXT_MID, EXT_TOP, JSON.stringify({ dept_manager_userid_list: [] })],
    )
    const deptBot = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, $3, 'Bot', true, $4::jsonb) RETURNING id`,
      [integrationId, EXT_BOT, EXT_MID, JSON.stringify({ dept_manager_userid_list: [EXT_HEAD1] })],
    )
    deptBotId = deptBot.rows[0].id

    const accReq = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Req', '{}'::jsonb) RETURNING id`,
      [integrationId, EXT_REQ, `k-req-${TS}`],
    )
    const accHead1 = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Head1', '{}'::jsonb) RETURNING id`,
      [integrationId, EXT_HEAD1, `k-head1-${TS}`],
    )
    const accHead3 = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Head3', '{}'::jsonb) RETURNING id`,
      [integrationId, EXT_HEAD3, `k-head3-${TS}`],
    )

    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual'), ($5, $6, 'linked', 'manual')`,
      [accReq.rows[0].id, REQ, accHead1.rows[0].id, U_HEAD1, accHead3.rows[0].id, U_HEAD3],
    )
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true)`,
      [accReq.rows[0].id, deptBotId],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    apprTok = await tok(base, APPROVER)
    head1Tok = await tok(base, U_HEAD1)
    head1bTok = await tok(base, U_HEAD1B)
    head3Tok = await tok(base, U_HEAD3)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`dhal-${TS}-%`])).rows.map((r) => r.id as string)
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
        await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
      await query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, APPROVER, U_HEAD1, U_HEAD1B, U_HEAD3]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── G-1 — authoring choke: level validated byte-identically to manager_at_level ─────────────
  it('G-1: dept_head_at_level saves with a valid level; out-of-range / non-integer / missing each 400 (G-18: node key present, no person id)', async () => {
    // Positive control FIRST: a valid shape saves.
    const okTid = await createTemplate(`dhal-${TS}-g1-ok`, headGraph(2))
    expect(okTid).toBeTruthy()

    const badLevels: unknown[] = [0, -1, 1.5, 11, 'two', null, undefined]
    for (const level of badLevels) {
      const graph = headGraph(2) as { nodes: Array<{ config: { assigneeSources?: unknown[] } }> }
      const source: Record<string, unknown> = { kind: 'dept_head_at_level' }
      if (level !== undefined) source.level = level
      graph.nodes[2].config.assigneeSources = [source]
      const res = await req(base, '/api/approval-templates', reqTok, {
        method: 'POST',
        body: { key: `dhal-${TS}-g1-bad`, name: 'bad', formSchema: FORM_SCHEMA, approvalGraph: graph },
      })
      expect(res.status, JSON.stringify(level)).toBe(400)
      const raw = await res.clone().text()
      // G-18: values-free — the message carries the structural source-index location
      // (`assigneeSources[0].level`, a template-authored path — permitted by §2.6) and never a
      // person id (trivially true here since none was ever supplied for a shape-rejection).
      expect(raw).toContain('assigneeSources[0].level')
    }
  })

  // ── G-2 — not-yet-implemented is not inert ───────────────────────────────────────────────────
  // `user_group` (Lock-1 §K1) landed since (its own approval-realdb-k1 job) — swapped to a kind
  // genuinely undeclared anywhere in the union so this arm keeps exercising the SAME default-arm
  // rejection mechanism rather than the (now-implemented) K1 create path.
  it('G-2: a contract-unimplemented kind is rejected at authoring, never persisted', async () => {
    const graph = headGraph(1) as { nodes: Array<{ config: { assigneeSources?: unknown[] } }> }
    graph.nodes[2].config.assigneeSources = [{ kind: 'not_a_real_kind', groupIds: ['g1'] }]
    const key = `dhal-${TS}-g2-unimplemented`
    const res = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: graph },
    })
    expect(res.status).toBe(400)
    const rows = await query(`SELECT id FROM approval_templates WHERE key = $1`, [key])
    expect(rows.rows).toHaveLength(0)
    // Positive control: dept_head_at_level (this slice's implemented kind) persists — G-1 above.
  })

  // ── Core: positional read over the real 3-level department-parent tree ──────────────────────
  it('core: level=1 resolves EXACTLY HEAD1 (own department head, byte-identical to the shipped single-level dept_head)', async () => {
    const tid = await createPublished(`dhal-${TS}-core-l1`, headGraph(1))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
    expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)

    const assignees = await activeAssignees(iid, 'head')
    expect(assignees.map((a) => a.assignee_id)).toEqual([U_HEAD1])
    const resolvedFrom = (assignees[0].metadata as { resolvedFrom?: { kind?: string } } | null)?.resolvedFrom
    expect(resolvedFrom?.kind).toBe('dept_head_at_level')

    await req(base, `/api/approvals/${iid}/actions`, head1Tok, { method: 'POST', body: { action: 'approve' } })
  })

  it('core: level=2 resolves EXACTLY HEAD3 — DEPT_MID (empty list) contributes nothing but the positional read walks THROUGH it (ratified continue-past-empty-level posture, proven positional not hop-count)', async () => {
    const tid = await createPublished(`dhal-${TS}-core-l2`, headGraph(2))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
    expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)

    const assignees = await activeAssignees(iid, 'head')
    expect(assignees.map((a) => a.assignee_id)).toEqual([U_HEAD3])
    const resolvedFrom = (assignees[0].metadata as { resolvedFrom?: { kind?: string } } | null)?.resolvedFrom
    expect(resolvedFrom?.kind).toBe('dept_head_at_level')

    await req(base, `/api/approvals/${iid}/actions`, head3Tok, { method: 'POST', body: { action: 'approve' } })
  })

  // ── Out-of-range: a level valid in CONTRACT but beyond THIS requester's (shorter) chain ──────
  it('out-of-range: level=5 (valid in [1, MAX_MANAGER_CHAIN_LEVELS]) against a 2-entry chain resolves EMPTY and falls to emptyAssigneePolicy — a normal APPROVAL_ASSIGNEE_EMPTY 400, NEVER a crash or silent coercion (Lock-1 §K5)', async () => {
    const tid = await createPublished(`dhal-${TS}-oor`, headGraph(5, 'error'))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
    const text = await gateApprove.clone().text()
    expect(gateApprove.status, text).toBe(400)
    expect(errorCode(JSON.parse(text) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_EMPTY')
    // G-18: values-free — the node key is present, no person id (there is none to leak — the
    // resolution genuinely found nobody).
    expect(text).toContain('head')

    const assignees = await activeAssignees(iid, 'head')
    expect(assignees).toHaveLength(0)
  })

  // ── Freeze purity: dispatch does not re-read the directory; the read IS per-create (temporal) ─
  it('freeze purity: a directory mutation AFTER create does not change the in-flight (frozen) assignee, but DOES change a NEWLY created approval — temporal, not a dead read', async () => {
    const tid = await createPublished(`dhal-${TS}-freeze`, headGraph(1))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    // Mutate DEPT_BOT's manager list AFTER create: HEAD1 -> HEAD1B.
    const accHead1b = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Head1B', '{}'::jsonb) RETURNING id`,
      [integrationId, EXT_HEAD1B, `k-head1b-${TS}`],
    )
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual')`,
      [accHead1b.rows[0].id, U_HEAD1B],
    )
    try {
      await query(
        `UPDATE directory_departments SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{dept_manager_userid_list}', $2::jsonb) WHERE id = $1`,
        [deptBotId, JSON.stringify([EXT_HEAD1B])],
      )

      // Dispatch the ALREADY-CREATED instance: the frozen snapshot must still resolve HEAD1, not
      // HEAD1B — no live directory re-read at dispatch.
      const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)
      const inFlight = await activeAssignees(iid, 'head')
      expect(inFlight.map((a) => a.assignee_id)).toEqual([U_HEAD1])

      // Positive control (temporal, not dead-cache): a NEW create AFTER the mutation DOES pick up
      // HEAD1B — the scope read re-executes per create rather than being cached at module load.
      const newTid = await createPublished(`dhal-${TS}-freeze-new`, headGraph(1))
      const newStarted = await createAsReq(newTid)
      expect(newStarted.status, newStarted.text).toBe(201)
      const newGateApprove = await req(base, `/api/approvals/${newStarted.iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(newGateApprove.status, await newGateApprove.clone().text()).toBeLessThan(300)
      const newAssignees = await activeAssignees(newStarted.iid!, 'head')
      expect(newAssignees.map((a) => a.assignee_id)).toEqual([U_HEAD1B])

      // Clean up both in-flight instances so they do not linger PENDING.
      await req(base, `/api/approvals/${iid}/actions`, head1Tok, { method: 'POST', body: { action: 'approve' } })
      await req(base, `/api/approvals/${newStarted.iid}/actions`, head1bTok, { method: 'POST', body: { action: 'approve' } })
    } finally {
      // Restore DEPT_BOT's manager list for any later test in this file relying on HEAD1.
      await query(
        `UPDATE directory_departments SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{dept_manager_userid_list}', $2::jsonb) WHERE id = $1`,
        [deptBotId, JSON.stringify([EXT_HEAD1])],
      )
    }
  })
})
