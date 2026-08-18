import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { query } from '../../src/db/pg'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-1 §K4 `continuous_dept_heads` (连续多级部门负责人) — REAL-DB end-to-end acceptance
 * (docs/development/approval-lock1-enterprise-assignees-20260817.md §K4; gates G-1/G-2/G-3/
 * G-13/G-18; harness mirrors approval-requester-choice.db.test.ts, org fixture mirrors
 * approval-manager-chain.db.test.ts extended with a THREE-level department PARENT tree).
 *
 * Org fixture (one integration, `dh-<TS>`):
 *   DEPT_TOP (root; manager list = [HEAD3])
 *     <- DEPT_MID (manager list EMPTY — the continue-past-empty-level level)
 *          <- DEPT_BOT (REQ's primary dept; manager list = [HEAD1]; ALSO flags a DIFFERENT
 *                       account LEADER_BOT leader_in_dept, for the G-13 pointer-distinctness arm)
 *   DEPT_AGREE (separate, one level; the SAME account AGREE is both dept_manager_userid_list[0]
 *               AND leader_in_dept-flagged — the G-13 "pointers coincide" arm)
 *
 * Proves:
 *  G-1      levels validated byte-identically to continuous_managers: out-of-range / non-integer /
 *           missing 400s; a valid shape saves in the same fixture (positive control);
 *  G-2      a contract-unimplemented kind is rejected at authoring, never persisted;
 *  G-3/core the real department-parent-tree walk executes real SQL end-to-end: DEPT_MID's EMPTY
 *           manager list contributes NOTHING but the walk CONTINUES to DEPT_TOP (ratified Lock-1
 *           §K4 continue-past-empty-level posture) — dispatch resolves EXACTLY [HEAD1, HEAD3],
 *           each with metadata.resolvedFrom.kind='continuous_dept_heads';
 *  G-13     in DEPT_BOT, leader_in_dept (LEADER_BOT) and dept_manager_userid_list (HEAD1) name
 *           DIFFERENT people: continuous_managers and continuous_dept_heads resolve DIFFERENT
 *           people for the SAME requester (arm 1 — discriminates the pointer, not the label); in
 *           DEPT_AGREE they name the SAME person (AGREE): both kinds resolve the SAME person for a
 *           second requester (arm 2 — the test is not vacuously always-different);
 *  freeze   a directory mutation (DEPT_BOT's manager list swapped) AFTER create does not change an
 *  purity   in-flight assignment (frozen snapshot) but DOES change a NEWLY created approval — the
 *           freeze is temporal, not a dead/cached read (mirrors K2's G-19 temporal positive control);
 *  G-18     the levels-validation 400 body carries the node key/source index, never a person id.
 *
 * G-20 (org-read fail-closed extension to continuous_dept_heads) lives in the existing parametrized
 * fixture `approval-routing-policy-failclose.api.test.ts` (KINDS now includes
 * 'continuous_dept_heads') — not duplicated here.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `dh-req-${TS}`
const REQ_AGREE = `dh-reqagree-${TS}`
const APPROVER = `dh-appr-${TS}`
const U_HEAD1 = `dh-head1-${TS}`
const U_HEAD1B = `dh-head1b-${TS}` // post-mutation replacement head (freeze-purity temporal arm)
const U_HEAD3 = `dh-head3-${TS}`
const U_LEADER_BOT = `dh-leaderbot-${TS}` // leader_in_dept of DEPT_BOT, DIFFERENT from HEAD1 (G-13 arm 1)
const U_AGREE = `dh-agree-${TS}` // both leader_in_dept AND dept_manager_userid_list of DEPT_AGREE (G-13 arm 2)

// Deterministic external ids, hoisted to module scope so both `beforeAll` (fixture insert) and
// individual `it()` blocks (the freeze-purity mutation) can reference the SAME values.
const EXT_TOP = `dtop-${TS}`
const EXT_MID = `dmid-${TS}`
const EXT_BOT = `dbot-${TS}`
const EXT_HEAD1 = `ehead1-${TS}`
const EXT_HEAD1B = `ehead1b-${TS}`
const EXT_HEAD3 = `ehead3-${TS}`
const EXT_LEADER_BOT = `eleaderbot-${TS}`
const EXT_REQ = `ereq-${TS}`
const EXT_AGREE_DEPT = `dagree-${TS}`
const EXT_AGREE_USER = `eagree-${TS}`
const EXT_REQ_AGREE = `ereqagree-${TS}`

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

// gate (static APPROVER) -> heads (continuous_dept_heads) -> end.
function headsGraph(levels: number, emptyAssigneePolicy: 'error' | 'auto-approve' = 'error') {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'gate', type: 'approval', name: 'gate', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'heads', type: 'approval', name: 'heads', config: { assigneeSources: [{ kind: 'continuous_dept_heads', levels }], approvalMode: 'all', emptyAssigneePolicy } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2g', source: 'start', target: 'gate' },
      { key: 'g2h', source: 'gate', target: 'heads' },
      { key: 'h2e', source: 'heads', target: 'end' },
    ],
  }
}

// single-node graph (no gate) directly resolving one kind at levels=1, for the G-13 comparison.
function singleLevelGraph(kind: 'continuous_managers' | 'continuous_dept_heads') {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'lvl1', type: 'approval', name: 'l', config: { assigneeSources: [{ kind, levels: 1 }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2l', source: 'start', target: 'lvl1' },
      { key: 'l2e', source: 'lvl1', target: 'end' },
    ],
  }
}

type ErrorBody = { code?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } }
function errorCode(body: ErrorBody): string | undefined {
  return body.code ?? body.error?.code
}

describeIfDatabase('Lock-1 §K4 continuous_dept_heads — real-DB create/freeze/dispatch acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let reqAgreeTok = ''
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
  async function instanceCount(tid: string): Promise<number> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM approval_instances WHERE template_id = $1`, [tid])
    return (rows.rows[0] as { n: number }).n
  }
  async function activeAssignees(iid: string, nodeKey: string): Promise<Array<{ assignee_id: string; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(
      `SELECT assignee_id, metadata FROM approval_assignments WHERE instance_id = $1 AND node_key = $2 AND is_active = TRUE ORDER BY assignee_id`,
      [iid, nodeKey],
    )
    return rows.rows as Array<{ assignee_id: string; metadata: Record<string, unknown> | null }>
  }
  async function createAsReq(tid: string, requesterTok = reqTok): Promise<{ status: number; iid?: string; text: string }> {
    const started = await req(base, '/api/approvals', requesterTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    const text = await started.clone().text()
    if (started.status >= 300) return { status: started.status, text }
    return { status: started.status, iid: ((await started.json()) as { id: string }).id, text }
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()

    for (const u of [REQ, REQ_AGREE, APPROVER, U_HEAD1, U_HEAD1B, U_HEAD3, U_LEADER_BOT, U_AGREE]) {
      await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`, [u, `${u}@example.test`])
    }

    const integ = await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`dh-${TS}`, `dh-corp-${TS}`],
    )
    integrationId = integ.rows[0].id

    // ── DEPT_TOP <- DEPT_MID(empty) <- DEPT_BOT(REQ's primary) ──────────────────────────────
    const extTop = EXT_TOP
    const extMid = EXT_MID
    const extBot = EXT_BOT
    const extHead1 = EXT_HEAD1
    const extHead3 = EXT_HEAD3
    const extLeaderBot = EXT_LEADER_BOT
    const extReq = EXT_REQ

    await query(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, NULL, 'Top', true, $3::jsonb)`,
      [integrationId, extTop, JSON.stringify({ dept_manager_userid_list: [extHead3] })],
    )
    // DEPT_MID: EMPTY manager list — the continue-past-empty-level proof point.
    await query(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, $3, 'Mid', true, $4::jsonb)`,
      [integrationId, extMid, extTop, JSON.stringify({ dept_manager_userid_list: [] })],
    )
    const deptBot = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, $3, 'Bot', true, $4::jsonb) RETURNING id`,
      [integrationId, extBot, extMid, JSON.stringify({ dept_manager_userid_list: [extHead1] })],
    )
    deptBotId = deptBot.rows[0].id

    const accReq = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Req', '{}'::jsonb) RETURNING id`,
      [integrationId, extReq, `k-req-${TS}`],
    )
    const accHead1 = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Head1', '{}'::jsonb) RETURNING id`,
      [integrationId, extHead1, `k-head1-${TS}`],
    )
    const accHead3 = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Head3', '{}'::jsonb) RETURNING id`,
      [integrationId, extHead3, `k-head3-${TS}`],
    )
    // LEADER_BOT: member of DEPT_BOT, flagged leader_in_dept for it — DIFFERENT person from HEAD1
    // (G-13 arm 1: the two pointers must disagree here).
    const accLeaderBot = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'LeaderBot', $4::jsonb) RETURNING id`,
      [integrationId, extLeaderBot, `k-leaderbot-${TS}`, JSON.stringify({ leader_in_dept: [{ dept_id: extBot, leader: true }] })],
    )

    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual'), ($5, $6, 'linked', 'manual'), ($7, $8, 'linked', 'manual')`,
      [accReq.rows[0].id, REQ, accHead1.rows[0].id, U_HEAD1, accHead3.rows[0].id, U_HEAD3, accLeaderBot.rows[0].id, U_LEADER_BOT],
    )
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true), ($3, $2, false)`,
      [accReq.rows[0].id, deptBotId, accLeaderBot.rows[0].id],
    )

    // ── DEPT_AGREE: the SAME account is both leader_in_dept AND dept_manager_userid_list[0]
    //    (G-13 arm 2 — the two pointers COINCIDE here) ────────────────────────────────────────
    const extAgreeDept = EXT_AGREE_DEPT
    const extAgreeUser = EXT_AGREE_USER
    const extReqAgree = EXT_REQ_AGREE
    const deptAgree = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, NULL, 'Agree', true, $3::jsonb) RETURNING id`,
      [integrationId, extAgreeDept, JSON.stringify({ dept_manager_userid_list: [extAgreeUser] })],
    )
    const accReqAgree = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'ReqAgree', '{}'::jsonb) RETURNING id`,
      [integrationId, extReqAgree, `k-reqagree-${TS}`],
    )
    const accAgree = await query<{ id: string }>(
      `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
       VALUES ($1, $2, $3, 'Agree', $4::jsonb) RETURNING id`,
      [integrationId, extAgreeUser, `k-agree-${TS}`, JSON.stringify({ leader_in_dept: [{ dept_id: extAgreeDept, leader: true }] })],
    )
    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual')`,
      [accReqAgree.rows[0].id, REQ_AGREE, accAgree.rows[0].id, U_AGREE],
    )
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true), ($3, $2, false)`,
      [accReqAgree.rows[0].id, deptAgree.rows[0].id, accAgree.rows[0].id],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    reqAgreeTok = await tok(base, REQ_AGREE)
    apprTok = await tok(base, APPROVER)
    head1Tok = await tok(base, U_HEAD1)
    head1bTok = await tok(base, U_HEAD1B)
    head3Tok = await tok(base, U_HEAD3)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`dh-${TS}-%`])).rows.map((r) => r.id as string)
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
      await query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, REQ_AGREE, APPROVER, U_HEAD1, U_HEAD1B, U_HEAD3, U_LEADER_BOT, U_AGREE]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── G-1 — authoring choke: levels validated byte-identically to continuous_managers ─────────
  it('G-1: continuous_dept_heads saves with a valid levels; out-of-range / non-integer / missing each 400 (G-18: node key present, no person id)', async () => {
    // Positive control FIRST: a valid shape saves.
    const okTid = await createTemplate(`dh-${TS}-g1-ok`, headsGraph(3))
    expect(okTid).toBeTruthy()

    const badLevels: unknown[] = [0, -1, 1.5, 11, 'two', null, undefined]
    for (const levels of badLevels) {
      const graph = headsGraph(3) as { nodes: Array<{ config: { assigneeSources?: unknown[] } }> }
      const source: Record<string, unknown> = { kind: 'continuous_dept_heads' }
      if (levels !== undefined) source.levels = levels
      graph.nodes[2].config.assigneeSources = [source]
      const res = await req(base, '/api/approval-templates', reqTok, {
        method: 'POST',
        body: { key: `dh-${TS}-g1-bad`, name: 'bad', formSchema: FORM_SCHEMA, approvalGraph: graph },
      })
      expect(res.status, JSON.stringify(levels)).toBe(400)
      const raw = await res.clone().text()
      // G-18: values-free — the message carries the structural source-index location
      // (`assigneeSources[0].levels`, a template-authored path — permitted by §2.6) and never a
      // person id (trivially true here since none was ever supplied for a shape-rejection).
      expect(raw).toContain('assigneeSources[0].levels')
    }
  })

  // ── G-2 — not-yet-implemented is not inert ───────────────────────────────────────────────────
  // NOTE: `dept_head_at_level` (K5-b) is no longer this test's "unimplemented" example — Lock-1
  // §K5-b landed in a LATER slice (docs/development/approval-lock1-enterprise-assignees-20260817.md
  // §K5-b; real-DB acceptance for it lives in its own approval-dept-head-at-level.db.test.ts,
  // sibling job approval-realdb-k5b). `user_group` (Lock-1 §K1) is still genuinely unimplemented at
  // this baseline — it is not even a member of ApprovalAssigneeSourceKind yet — so it is the
  // fixture now.
  it('G-2: a contract-unimplemented kind (user_group / K1, not landed at this baseline) is rejected at authoring, never persisted', async () => {
    const graph = headsGraph(3) as { nodes: Array<{ config: { assigneeSources?: unknown[] } }> }
    graph.nodes[2].config.assigneeSources = [{ kind: 'user_group', groupIds: ['g1'] }]
    const key = `dh-${TS}-g2-unimplemented`
    const res = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: graph },
    })
    expect(res.status).toBe(400)
    const rows = await query(`SELECT id FROM approval_templates WHERE key = $1`, [key])
    expect(rows.rows).toHaveLength(0)
    // Positive control: continuous_dept_heads (this slice's implemented kind) persists — G-1 above.
  })

  // ── Core: real 3-level department-parent-tree walk, continue-past-empty over REAL SQL ────────
  it('core: dispatch resolves EXACTLY [HEAD1, HEAD3] — DEPT_MID (empty list) contributes nothing but the walk CONTINUES to DEPT_TOP (ratified continue-past-empty-level posture)', async () => {
    const tid = await createPublished(`dh-${TS}-core`, headsGraph(3))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
    expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)

    const assignees = await activeAssignees(iid, 'heads')
    expect(assignees.map((a) => a.assignee_id).sort()).toEqual([U_HEAD1, U_HEAD3].sort())
    for (const a of assignees) {
      const resolvedFrom = (a.metadata as { resolvedFrom?: { kind?: string } } | null)?.resolvedFrom
      expect(resolvedFrom?.kind).toBe('continuous_dept_heads')
    }

    // Finish the instance so it does not linger PENDING for the afterAll cleanup ordering.
    await req(base, `/api/approvals/${iid}/actions`, head1Tok, { method: 'POST', body: { action: 'approve' } })
    await req(base, `/api/approvals/${iid}/actions`, head3Tok, { method: 'POST', body: { action: 'approve' } })
  })

  // ── G-13 — chain distinctness: the pointer, not the label ────────────────────────────────────
  it('G-13 arm 1 (DISAGREE): in DEPT_BOT, leader_in_dept (LEADER_BOT) and dept_manager_userid_list (HEAD1) name DIFFERENT people — continuous_managers and continuous_dept_heads resolve DIFFERENT people for the SAME requester', async () => {
    const cmTid = await createPublished(`dh-${TS}-g13-disagree-cm`, singleLevelGraph('continuous_managers'))
    const cmRes = await createAsReq(cmTid)
    expect(cmRes.status, cmRes.text).toBe(201)
    const cmAssignees = await activeAssignees(cmRes.iid!, 'lvl1')

    const dhTid = await createPublished(`dh-${TS}-g13-disagree-dh`, singleLevelGraph('continuous_dept_heads'))
    const dhRes = await createAsReq(dhTid)
    expect(dhRes.status, dhRes.text).toBe(201)
    const dhAssignees = await activeAssignees(dhRes.iid!, 'lvl1')

    expect(cmAssignees.map((a) => a.assignee_id)).toEqual([U_LEADER_BOT])
    expect(dhAssignees.map((a) => a.assignee_id)).toEqual([U_HEAD1])
    expect(cmAssignees.map((a) => a.assignee_id)).not.toEqual(dhAssignees.map((a) => a.assignee_id))
  })

  it('G-13 arm 2 (AGREE, positive control): in DEPT_AGREE, both pointers name the SAME person — continuous_managers and continuous_dept_heads resolve the SAME person (the test discriminates the pointer, not a blanket always-different assumption)', async () => {
    const cmTid = await createPublished(`dh-${TS}-g13-agree-cm`, singleLevelGraph('continuous_managers'))
    const cmRes = await createAsReq(cmTid, reqAgreeTok)
    expect(cmRes.status, cmRes.text).toBe(201)
    const cmAssignees = await activeAssignees(cmRes.iid!, 'lvl1')

    const dhTid = await createPublished(`dh-${TS}-g13-agree-dh`, singleLevelGraph('continuous_dept_heads'))
    const dhRes = await createAsReq(dhTid, reqAgreeTok)
    expect(dhRes.status, dhRes.text).toBe(201)
    const dhAssignees = await activeAssignees(dhRes.iid!, 'lvl1')

    expect(cmAssignees.map((a) => a.assignee_id)).toEqual([U_AGREE])
    expect(dhAssignees.map((a) => a.assignee_id)).toEqual([U_AGREE])
  })

  // ── Freeze purity: dispatch does not re-read the directory; the read IS per-create (temporal) ─
  it('freeze purity: a directory mutation AFTER create does not change the in-flight (frozen) assignee, but DOES change a NEWLY created approval — temporal, not a dead read', async () => {
    const tid = await createPublished(`dh-${TS}-freeze`, headsGraph(3))
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
      const inFlight = await activeAssignees(iid, 'heads')
      expect(inFlight.map((a) => a.assignee_id).sort()).toEqual([U_HEAD1, U_HEAD3].sort())
      expect(inFlight.map((a) => a.assignee_id)).not.toContain(U_HEAD1B)

      // Positive control (temporal, not dead-cache): a NEW create AFTER the mutation DOES pick up
      // HEAD1B — the scope read re-executes per create rather than being cached at module load.
      const newTid = await createPublished(`dh-${TS}-freeze-new`, headsGraph(3))
      const newStarted = await createAsReq(newTid)
      expect(newStarted.status, newStarted.text).toBe(201)
      const newGateApprove = await req(base, `/api/approvals/${newStarted.iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(newGateApprove.status, await newGateApprove.clone().text()).toBeLessThan(300)
      const newAssignees = await activeAssignees(newStarted.iid!, 'heads')
      expect(newAssignees.map((a) => a.assignee_id).sort()).toEqual([U_HEAD1B, U_HEAD3].sort())

      // Clean up both in-flight instances so they do not linger PENDING.
      await req(base, `/api/approvals/${iid}/actions`, head1Tok, { method: 'POST', body: { action: 'approve' } })
      await req(base, `/api/approvals/${iid}/actions`, head3Tok, { method: 'POST', body: { action: 'approve' } })
      await req(base, `/api/approvals/${newStarted.iid}/actions`, head1bTok, { method: 'POST', body: { action: 'approve' } })
      await req(base, `/api/approvals/${newStarted.iid}/actions`, head3Tok, { method: 'POST', body: { action: 'approve' } })
    } finally {
      // Restore DEPT_BOT's manager list for any later test in this file relying on HEAD1.
      await query(
        `UPDATE directory_departments SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{dept_manager_userid_list}', $2::jsonb) WHERE id = $1`,
        [deptBotId, JSON.stringify([EXT_HEAD1])],
      )
    }
  })
})
