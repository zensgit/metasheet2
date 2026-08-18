import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { query } from '../../src/db/pg'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-2 §L2-C form-field contact extensions (`form_field_user_manager` 表单内联系人上级 /
 * `form_field_user_dept_head` 表单内联系人部门负责人) — REAL-DB end-to-end acceptance
 * (docs/development/approval-lock2-org-controls-field-routing-20260817.md §L2-C, §2.1-§2.6;
 * gates C-1/C-2/C-4/C-5/D-2/D-4/D-5 + the door-2 create-time 422 of §2.2; harness mirrors
 * approval-dept-head-chain.db.test.ts, org fixture extends it with a leader-pointer chain ABOVE
 * the chosen contact).
 *
 * Org fixture (one integration `fc-<TS>`, org 'default'):
 *   DEPT_TOP (root; dept_manager_userid_list = [HEAD2])
 *     <- DEPT_MID (manager list EMPTY — the continue-past-empty-level level)
 *          <- DEPT_BOT (CONTACT's primary dept; manager list = [HEAD1]; a DIFFERENT account
 *                       LEADER1 is flagged leader_in_dept — the C-4 pointer-distinctness arm)
 *   DEPT_L2 (LEADER1's primary dept; LEADER2 is flagged leader_in_dept — the contact's
 *            manager chain is therefore [LEADER1, LEADER2] on the LEADER pointer)
 *   DEPT_AGREE (separate; the SAME account AGREE is both leader_in_dept AND
 *               dept_manager_userid_list[0] — the C-4 "pointers coincide" positive control)
 *   DEPT_REQ (REQ's own primary dept; manager list = [REQ_HEAD], REQ_LEADER flagged leader —
 *             the C-5 anchor-is-the-field negative material: neither ever resolves)
 *
 * Proves:
 *  choke    both kinds save with a valid {fieldId, level}; out-of-range / non-integer / missing
 *           level, missing fieldId, and an unknown extra key each 400 at the authoring choke with
 *           the structural source path in the message and no person id (Lock-1 G-1 posture);
 *  pins     (C-1/C-2) a dangling fieldId, a non-user field, a non-required user field, a
 *           visibilityRule-carrying required field, and a props.selection='multi' field are each
 *           rejected by validateApprovalAssigneeSourcesAgainstFormSchema (runs at save AND
 *           publish AND restore); a fully compliant template publishes (shape-selected);
 *  door 2   (§2.2) a whitespace-only contact value passes the required+type checks (door 1
 *           cannot see it) yet resolves to NO anchor → create-time 422
 *           APPROVAL_FORM_ROUTING_FIELD_EMPTY with ZERO instance rows — proving the create-time
 *           door is live and independent of the publish pins;
 *  core     dispatch resolves the extension of the SUBMITTED contact from the FROZEN create-time
 *           read: manager kind level 1/2 → [LEADER1]/[LEADER2] (leader-pointer walk re-anchored
 *           on the contact); dept-head kind level 1 → [HEAD1] and level 2 → [HEAD2] — DEPT_MID's
 *           EMPTY manager list contributes nothing but the walk CONTINUES to DEPT_TOP (Lock-1
 *           §K4's RATIFIED continue-past-empty-level posture binding this walker; the chain is
 *           DENSE so level 2 addresses the second RESOLVED head); resolvedFrom carries
 *           kind/sourceIndex/fieldId/level (D-5);
 *  C-4      in DEPT_BOT the two pointers name DIFFERENT people (LEADER1 vs HEAD1) — the two kinds
 *           resolve DIFFERENT approvers for the SAME submitted contact; in DEPT_AGREE they name
 *           the SAME person (AGREE) — the test discriminates the pointer, not the label;
 *  C-5      the resolution derives from the CHOSEN contact, never the requester (REQ's own
 *           REQ_HEAD/REQ_LEADER never appear in any resolved set);
 *  empty    a level past the contact's chain and a contact with NO directory account are EMPTY
 *           resolution → the node's emptyAssigneePolicy (default 'error' → fail-closed 400
 *           APPROVAL_ASSIGNEE_EMPTY at create, zero rows) — never a silent nobody and never the
 *           wedge's 422/503 (three different things, §L2-C);
 *  D-4      freeze purity is TEMPORAL: a directory mutation AFTER create does not move the
 *           in-flight seat at dispatch (a live-read implementation would red here), while a NEW
 *           create after the mutation DOES pick up the change;
 *  D-2      a broken approval_routing policy governing the CONTACT's org fail-closes create 422
 *           APPROVAL_ROUTING_POLICY_MISCONFIGURED (the shipped ApprovalRoutingPolicyError
 *           surfaced through the NEW field-derived wedge) with zero rows, while a template with
 *           NO field-derived source still creates under the SAME broken policy — the wedge is
 *           source-selected;
 *  handler  the kinds are handler-admitted (Lock-2 §2.4): a handler node carrying the manager
 *           kind publishes, and dispatch reaches it with the SAME frozen resolution.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `fc-req-${TS}`
const APPROVER = `fc-appr-${TS}`
const U_CONTACT = `fc-contact-${TS}`
const U_CONTACT_AGREE = `fc-contactagree-${TS}`
const U_CONTACT_NOACC = `fc-contactnoacc-${TS}` // local user with NO directory account (empty arm)
const U_LEADER1 = `fc-leader1-${TS}`
const U_LEADER2 = `fc-leader2-${TS}`
const U_HEAD1 = `fc-head1-${TS}`
const U_HEAD1B = `fc-head1b-${TS}` // post-mutation replacement head (D-4 temporal arm)
const U_HEAD2 = `fc-head2-${TS}`
const U_AGREE = `fc-agree-${TS}`
const U_REQ_HEAD = `fc-reqhead-${TS}`

const EXT_TOP = `ftop-${TS}`
const EXT_MID = `fmid-${TS}`
const EXT_BOT = `fbot-${TS}`
const EXT_L2 = `fl2-${TS}`
const EXT_AGREE_DEPT = `fagree-${TS}`
const EXT_REQ_DEPT = `freqd-${TS}`
const EXT_CONTACT = `econtact-${TS}`
const EXT_CONTACT_AGREE = `econtactagree-${TS}`
const EXT_LEADER1 = `eleader1-${TS}`
const EXT_LEADER2 = `eleader2-${TS}`
const EXT_HEAD1 = `ehead1-${TS}`
const EXT_HEAD1B = `ehead1b-${TS}`
const EXT_HEAD2 = `ehead2-${TS}`
const EXT_AGREE_USER = `eagree-${TS}`
const EXT_REQ = `ereq-${TS}`
const EXT_REQ_HEAD = `ereqhead-${TS}`
const EXT_REQ_LEADER = `ereqleader-${TS}`

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

// Publish pins (Lock-2 §L2-C): the referenced field is TOP-LEVEL, `user`, required, and carries
// no visibilityRule — the compliant schema every positive-control template uses.
const FORM_SCHEMA = {
  fields: [
    { id: 'reason', type: 'text', label: 'r', required: true },
    { id: 'contact', type: 'user', label: '联系人', required: true },
  ],
}

type ExtensionKind = 'form_field_user_manager' | 'form_field_user_dept_head'

// gate (static APPROVER) -> ext (the contact extension under test) -> end.
function extGraph(kind: ExtensionKind, level: number, emptyAssigneePolicy: 'error' | 'auto-approve' = 'error') {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'gate', type: 'approval', name: 'gate', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'ext', type: 'approval', name: 'ext', config: { assigneeSources: [{ kind, fieldId: 'contact', level }], approvalMode: 'all', emptyAssigneePolicy } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2g', source: 'start', target: 'gate' },
      { key: 'g2x', source: 'gate', target: 'ext' },
      { key: 'x2e', source: 'ext', target: 'end' },
    ],
  }
}

// single-node graph: the extension node is FIRST, so an empty resolution surfaces at create.
function firstNodeGraph(kind: ExtensionKind, level: number) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'ext', type: 'approval', name: 'ext', config: { assigneeSources: [{ kind, fieldId: 'contact', level }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2x', source: 'start', target: 'ext' },
      { key: 'x2e', source: 'ext', target: 'end' },
    ],
  }
}

// Lock-2 §2.4 handler admission: gate (static approval) -> handler carrying the extension -> end.
function handlerGraph(kind: ExtensionKind, level: number) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'gate', type: 'approval', name: 'gate', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'do', type: 'handler', name: 'do', config: { assigneeSources: [{ kind, fieldId: 'contact', level }] } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2g', source: 'start', target: 'gate' },
      { key: 'g2d', source: 'gate', target: 'do' },
      { key: 'd2e', source: 'do', target: 'end' },
    ],
  }
}

// Anti-skip-green sentinel (K2/K3 posture): the workflow lane sets EXPECT_DB=1 — there, a
// missing/broken DATABASE_URL must go RED (this test runs and fails) instead of the whole suite
// silently reporting skipped. Ordinary no-DB collection (EXPECT_DB unset) skips it cleanly.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('Lock-2 §L2-C form-field contact extensions — real-DB create-freeze/dispatch acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let apprTok = ''
  let integrationId = ''
  let brokenIntegrationId = ''
  let deptBotId = ''

  async function createTemplate(key: string, graph: unknown, formSchema: unknown = FORM_SCHEMA): Promise<string> {
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema, approvalGraph: graph },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    return ((await created.json()) as { id: string }).id
  }
  async function createPublished(key: string, graph: unknown, formSchema: unknown = FORM_SCHEMA): Promise<string> {
    const tid = await createTemplate(key, graph, formSchema)
    const published = await req(base, `/api/approval-templates/${tid}/publish`, reqTok, { method: 'POST', body: { policy: { allowRevoke: true } } })
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
  async function createAsReq(tid: string, contactValue: unknown = U_CONTACT): Promise<{ status: number; iid?: string; text: string }> {
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r', contact: contactValue } } })
    const text = await started.clone().text()
    if (started.status >= 300) return { status: started.status, text }
    return { status: started.status, iid: ((await started.json()) as { id: string }).id, text }
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()

    for (const u of [REQ, APPROVER, U_CONTACT, U_CONTACT_AGREE, U_CONTACT_NOACC, U_LEADER1, U_LEADER2, U_HEAD1, U_HEAD1B, U_HEAD2, U_AGREE, U_REQ_HEAD]) {
      await query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x') ON CONFLICT (id) DO NOTHING`, [u, `${u}@example.test`])
    }

    const integ = await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id) VALUES ($1, $2) RETURNING id`,
      [`fc-${TS}`, `fc-corp-${TS}`],
    )
    integrationId = integ.rows[0].id

    // ── departments ──────────────────────────────────────────────────────────────────────────
    await query(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, NULL, 'Top', true, $3::jsonb)`,
      [integrationId, EXT_TOP, JSON.stringify({ dept_manager_userid_list: [EXT_HEAD2] })],
    )
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
    const deptL2 = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, NULL, 'L2', true, '{}'::jsonb) RETURNING id`,
      [integrationId, EXT_L2],
    )
    const deptAgree = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, NULL, 'Agree', true, $3::jsonb) RETURNING id`,
      [integrationId, EXT_AGREE_DEPT, JSON.stringify({ dept_manager_userid_list: [EXT_AGREE_USER] })],
    )
    const deptReq = await query<{ id: string }>(
      `INSERT INTO directory_departments (integration_id, external_department_id, external_parent_department_id, name, is_active, raw)
       VALUES ($1, $2, NULL, 'ReqDept', true, $3::jsonb) RETURNING id`,
      [integrationId, EXT_REQ_DEPT, JSON.stringify({ dept_manager_userid_list: [EXT_REQ_HEAD] })],
    )

    // ── accounts ─────────────────────────────────────────────────────────────────────────────
    const insertAccount = async (external: string, name: string, raw: Record<string, unknown> = {}): Promise<string> => {
      const row = await query<{ id: string }>(
        `INSERT INTO directory_accounts (integration_id, external_user_id, external_key, name, raw)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
        [integrationId, external, `k-${external}`, name, JSON.stringify(raw)],
      )
      return row.rows[0].id
    }
    const accContact = await insertAccount(EXT_CONTACT, 'Contact')
    const accContactAgree = await insertAccount(EXT_CONTACT_AGREE, 'ContactAgree')
    // LEADER1: member of DEPT_BOT flagged leader_in_dept for it (the contact's level-1 manager on
    // the LEADER pointer), with their OWN primary department DEPT_L2 — whose leader is LEADER2.
    const accLeader1 = await insertAccount(EXT_LEADER1, 'Leader1', { leader_in_dept: [{ dept_id: EXT_BOT, leader: true }] })
    const accLeader2 = await insertAccount(EXT_LEADER2, 'Leader2', { leader_in_dept: [{ dept_id: EXT_L2, leader: true }] })
    const accHead1 = await insertAccount(EXT_HEAD1, 'Head1')
    const accHead2 = await insertAccount(EXT_HEAD2, 'Head2')
    const accAgree = await insertAccount(EXT_AGREE_USER, 'Agree', { leader_in_dept: [{ dept_id: EXT_AGREE_DEPT, leader: true }] })
    // Requester material (C-5): REQ has their OWN dept/head/leader — none of which may resolve.
    const accReq = await insertAccount(EXT_REQ, 'Req')
    const accReqHead = await insertAccount(EXT_REQ_HEAD, 'ReqHead')
    const accReqLeader = await insertAccount(EXT_REQ_LEADER, 'ReqLeader', { leader_in_dept: [{ dept_id: EXT_REQ_DEPT, leader: true }] })

    await query(
      `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy)
       VALUES ($1, $2, 'linked', 'manual'), ($3, $4, 'linked', 'manual'), ($5, $6, 'linked', 'manual'),
              ($7, $8, 'linked', 'manual'), ($9, $10, 'linked', 'manual'), ($11, $12, 'linked', 'manual'),
              ($13, $14, 'linked', 'manual'), ($15, $16, 'linked', 'manual'), ($17, $18, 'linked', 'manual')`,
      [
        accContact, U_CONTACT,
        accContactAgree, U_CONTACT_AGREE,
        accLeader1, U_LEADER1,
        accLeader2, U_LEADER2,
        accHead1, U_HEAD1,
        accHead2, U_HEAD2,
        accAgree, U_AGREE,
        accReq, REQ,
        accReqHead, U_REQ_HEAD,
      ],
    )
    // memberships: CONTACT primary in BOT (LEADER1 non-primary member there, so the leader hop
    // finds them); LEADER1 primary in DEPT_L2 (LEADER2 non-primary member there); CONTACT_AGREE
    // primary in DEPT_AGREE (AGREE non-primary member); REQ primary in DEPT_REQ (REQ_LEADER
    // non-primary member).
    await query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary)
       VALUES ($1, $2, true), ($3, $2, false),
              ($4, $5, true), ($6, $5, false),
              ($7, $8, true), ($9, $8, false),
              ($10, $11, true), ($12, $11, false)`,
      [
        accContact, deptBotId, accLeader1,
        accLeader1, deptL2.rows[0].id, accLeader2,
        accContactAgree, deptAgree.rows[0].id, accAgree,
        accReq, deptReq.rows[0].id, accReqLeader,
      ],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    apprTok = await tok(base, APPROVER)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`fc-${TS}-%`])).rows.map((r) => r.id as string)
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
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
      if (brokenIntegrationId) {
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [brokenIntegrationId])
      }
      if (integrationId) {
        await query(`DELETE FROM directory_accounts WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_departments WHERE integration_id = $1`, [integrationId])
        await query(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      }
      await query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, APPROVER, U_CONTACT, U_CONTACT_AGREE, U_CONTACT_NOACC, U_LEADER1, U_LEADER2, U_HEAD1, U_HEAD1B, U_HEAD2, U_AGREE, U_REQ_HEAD]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── authoring choke (Lock-1 G-1 posture for NEW kinds) ──────────────────────────────────────
  it('choke: both kinds save with a valid {fieldId, level}; bad level / missing fieldId / unknown extra key each 400 with the structural source path and no person id', async () => {
    // Positive control FIRST: a valid shape of EACH kind saves.
    expect(await createTemplate(`fc-${TS}-choke-ok-m`, extGraph('form_field_user_manager', 2))).toBeTruthy()
    expect(await createTemplate(`fc-${TS}-choke-ok-d`, extGraph('form_field_user_dept_head', 1))).toBeTruthy()

    const badLevels: unknown[] = [0, -1, 1.5, 11, 'two', null, undefined]
    for (const kind of ['form_field_user_manager', 'form_field_user_dept_head'] as const) {
      for (const level of badLevels) {
        const graph = extGraph(kind, 1) as { nodes: Array<{ config: { assigneeSources?: unknown[] } }> }
        const source: Record<string, unknown> = { kind, fieldId: 'contact' }
        if (level !== undefined) source.level = level
        graph.nodes[2].config.assigneeSources = [source]
        const res = await req(base, '/api/approval-templates', reqTok, {
          method: 'POST',
          body: { key: `fc-${TS}-choke-bad`, name: 'bad', formSchema: FORM_SCHEMA, approvalGraph: graph },
        })
        expect(res.status, `${kind} level=${JSON.stringify(level)}`).toBe(400)
        const raw = await res.clone().text()
        // Values-free: the structural source-index path (template-authored, permitted by §2.6);
        // never a person id (trivially — none was supplied for a shape rejection).
        expect(raw).toContain('assigneeSources[0].level')
      }

      // missing fieldId
      const noField = extGraph(kind, 1) as { nodes: Array<{ config: { assigneeSources?: unknown[] } }> }
      noField.nodes[2].config.assigneeSources = [{ kind, level: 1 }]
      const noFieldRes = await req(base, '/api/approval-templates', reqTok, {
        method: 'POST',
        body: { key: `fc-${TS}-choke-nf`, name: 'nf', formSchema: FORM_SCHEMA, approvalGraph: noField },
      })
      expect(noFieldRes.status).toBe(400)
      expect(await noFieldRes.clone().text()).toContain('assigneeSources[0].fieldId')

      // unknown extra key — REJECTED, never silently dropped (G-1 posture for new kinds).
      const extraKey = extGraph(kind, 1) as { nodes: Array<{ config: { assigneeSources?: unknown[] } }> }
      extraKey.nodes[2].config.assigneeSources = [{ kind, fieldId: 'contact', level: 1, futureFlag: true }]
      const extraRes = await req(base, '/api/approval-templates', reqTok, {
        method: 'POST',
        body: { key: `fc-${TS}-choke-xk`, name: 'xk', formSchema: FORM_SCHEMA, approvalGraph: extraKey },
      })
      expect(extraRes.status).toBe(400)
      expect(await extraRes.clone().text()).toContain('unknown keys')
    }
  })

  // ── publish pins (C-1/C-2; the validator runs at save AND publish AND restore) ──────────────
  it('pins: dangling field, non-user field, non-required field, visibilityRule field, and selection:multi each reject; the compliant shape publishes (shape-selected, not blanket)', async () => {
    const negativeSchemas: Array<[string, unknown]> = [
      // (1) dangling fieldId — the referenced field does not exist.
      ['dangling', { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }] }],
      // (2) wrong type — `contact` exists but is not a user field.
      ['nonuser', { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }, { id: 'contact', type: 'text', label: 'c', required: true }] }],
      // (3) not required.
      ['optional', { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }, { id: 'contact', type: 'user', label: 'c' }] }],
      // (4) required but visibility-ruled — pin (3) alone closes nothing (§L2-C): the hidden-field
      //     skip at validateApprovalFormData + pruneHiddenFormData would let the value vanish.
      ['visrule', { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }, { id: 'contact', type: 'user', label: 'c', required: true, visibilityRule: { fieldId: 'reason', operator: 'eq', value: 'show' } }] }],
      // (6) selection: 'multi' — rejected until OD-L2-7's array support lands in the same slice.
      ['multi', { fields: [{ id: 'reason', type: 'text', label: 'r', required: true }, { id: 'contact', type: 'user', label: 'c', required: true, props: { selection: 'multi' } }] }],
    ]
    for (const kind of ['form_field_user_manager', 'form_field_user_dept_head'] as const) {
      for (const [name, schema] of negativeSchemas) {
        const res = await req(base, '/api/approval-templates', reqTok, {
          method: 'POST',
          body: { key: `fc-${TS}-pin-${name}`, name, formSchema: schema, approvalGraph: extGraph(kind, 1) },
        })
        expect(res.status, `${kind} pin=${name}`).toBe(400)
        const raw = await res.clone().text()
        expect(raw).toContain(kind)
        // Values-free: the node key is present; no person id can be (none supplied).
        expect(raw).toContain('ext')
      }
      // Positive control: the SAME kind with the compliant schema publishes.
      await createPublished(`fc-${TS}-pin-ok-${kind}`, extGraph(kind, 1))
    }
  })

  // ── door 2 (§2.2) — the independent create-time 422, live through the REAL API ──────────────
  it('door 2: a whitespace-only contact value passes the required+type checks (door 1 cannot see it) but yields NO anchor → 422 APPROVAL_FORM_ROUTING_FIELD_EMPTY, zero instance rows, values-free body', async () => {
    const tid = await createPublished(`fc-${TS}-door2`, extGraph('form_field_user_manager', 1))
    const res = await createAsReq(tid, '   ')
    expect(res.status, res.text).toBe(422)
    expect(res.text).toContain('APPROVAL_FORM_ROUTING_FIELD_EMPTY')
    // Values-free: the template-authored node key + field id are permitted; no person/form value.
    expect(res.text).toContain('contact')
    expect(res.text).not.toContain(U_CONTACT)
    expect(await instanceCount(tid)).toBe(0)
    // Positive control: the SAME template with a real contact creates (the door is value-selected).
    const ok = await createAsReq(tid)
    expect(ok.status, ok.text).toBe(201)
  })

  // ── core: create-time freeze + dispatch, both pointers, both levels ─────────────────────────
  it('core (manager kind): dispatch assigns the SUBMITTED contact\'s leader-pointer manager at the configured level — level 1 → LEADER1, level 2 → LEADER2 — with resolvedFrom kind/fieldId/level (D-5), never the requester\'s own manager (C-5)', async () => {
    for (const [level, expected] of [[1, U_LEADER1], [2, U_LEADER2]] as const) {
      const tid = await createPublished(`fc-${TS}-core-m${level}`, extGraph('form_field_user_manager', level))
      const started = await createAsReq(tid)
      expect(started.status, started.text).toBe(201)
      const iid = started.iid!
      const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)
      const assignees = await activeAssignees(iid, 'ext')
      expect(assignees.map((a) => a.assignee_id)).toEqual([expected])
      const resolvedFrom = (assignees[0].metadata as { resolvedFrom?: Record<string, unknown> } | null)?.resolvedFrom
      expect(resolvedFrom).toEqual({ kind: 'form_field_user_manager', sourceIndex: 0, fieldId: 'contact', level })
      // C-5: the requester's own org material never resolves — the anchor is the FIELD.
      expect(assignees.map((a) => a.assignee_id)).not.toContain(U_REQ_HEAD)
    }
  })

  it('core (dept-head kind): level 1 → HEAD1; level 2 → HEAD2 THROUGH the empty-list DEPT_MID (the ratified continue-past-empty-level posture binds the re-anchored parent-tree walker; the chain is DENSE)', async () => {
    for (const [level, expected] of [[1, U_HEAD1], [2, U_HEAD2]] as const) {
      const tid = await createPublished(`fc-${TS}-core-d${level}`, extGraph('form_field_user_dept_head', level))
      const started = await createAsReq(tid)
      expect(started.status, started.text).toBe(201)
      const iid = started.iid!
      const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)
      const assignees = await activeAssignees(iid, 'ext')
      expect(assignees.map((a) => a.assignee_id)).toEqual([expected])
      const resolvedFrom = (assignees[0].metadata as { resolvedFrom?: Record<string, unknown> } | null)?.resolvedFrom
      expect(resolvedFrom).toEqual({ kind: 'form_field_user_dept_head', sourceIndex: 0, fieldId: 'contact', level })
    }
  })

  // ── C-4 pointer distinctness ────────────────────────────────────────────────────────────────
  it('C-4 arm 1 (DISAGREE): for the SAME submitted contact, the leader pointer (LEADER1) and the manager list (HEAD1) name DIFFERENT people — the two kinds resolve DIFFERENT approvers', async () => {
    const mTid = await createPublished(`fc-${TS}-c4-m`, firstNodeGraph('form_field_user_manager', 1))
    const mRes = await createAsReq(mTid)
    expect(mRes.status, mRes.text).toBe(201)
    const mAssignees = await activeAssignees(mRes.iid!, 'ext')

    const dTid = await createPublished(`fc-${TS}-c4-d`, firstNodeGraph('form_field_user_dept_head', 1))
    const dRes = await createAsReq(dTid)
    expect(dRes.status, dRes.text).toBe(201)
    const dAssignees = await activeAssignees(dRes.iid!, 'ext')

    expect(mAssignees.map((a) => a.assignee_id)).toEqual([U_LEADER1])
    expect(dAssignees.map((a) => a.assignee_id)).toEqual([U_HEAD1])
    expect(mAssignees.map((a) => a.assignee_id)).not.toEqual(dAssignees.map((a) => a.assignee_id))
  })

  it('C-4 arm 2 (AGREE, positive control): where the two pointers COINCIDE, both kinds resolve the SAME person — the test discriminates the pointer, not the label', async () => {
    const mTid = await createPublished(`fc-${TS}-c4a-m`, firstNodeGraph('form_field_user_manager', 1))
    const mRes = await createAsReq(mTid, U_CONTACT_AGREE)
    expect(mRes.status, mRes.text).toBe(201)
    expect((await activeAssignees(mRes.iid!, 'ext')).map((a) => a.assignee_id)).toEqual([U_AGREE])

    const dTid = await createPublished(`fc-${TS}-c4a-d`, firstNodeGraph('form_field_user_dept_head', 1))
    const dRes = await createAsReq(dTid, U_CONTACT_AGREE)
    expect(dRes.status, dRes.text).toBe(201)
    expect((await activeAssignees(dRes.iid!, 'ext')).map((a) => a.assignee_id)).toEqual([U_AGREE])
  })

  // ── empty resolution: fail-closed per policy, never a silent nobody, never the wedge ────────
  it('empty: a level past the contact\'s chain, and a contact with NO directory account, are EMPTY resolution → default policy \'error\' fail-closes create 400 APPROVAL_ASSIGNEE_EMPTY with zero rows (not the wedge\'s 422/503 — data absence is not a read failure)', async () => {
    // Manager chain has 2 entries; level 5 is contract-valid but past the end.
    const tid = await createPublished(`fc-${TS}-empty-lvl`, firstNodeGraph('form_field_user_manager', 5))
    const res = await createAsReq(tid)
    expect(res.status, res.text).toBe(400)
    expect(res.text).toContain('APPROVAL_ASSIGNEE_EMPTY')
    expect(await instanceCount(tid)).toBe(0)

    // A real local user with NO directory account: the anchor read succeeds and finds nothing.
    const tid2 = await createPublished(`fc-${TS}-empty-noacc`, firstNodeGraph('form_field_user_manager', 1))
    const res2 = await createAsReq(tid2, U_CONTACT_NOACC)
    expect(res2.status, res2.text).toBe(400)
    expect(res2.text).toContain('APPROVAL_ASSIGNEE_EMPTY')
    expect(await instanceCount(tid2)).toBe(0)
    // Neither is the wedge shape: no routing-policy/org-unresolved code on a data-absence path.
    expect(res.text).not.toContain('APPROVAL_ROUTING_POLICY_MISCONFIGURED')
    expect(res2.text).not.toContain('APPROVAL_FORM_ROUTING_ORG_UNRESOLVED')
  })

  // ── D-4 freeze purity: temporal, not a dead read; no live read at dispatch ──────────────────
  it('D-4 freeze purity: a directory mutation AFTER create does not move the in-flight seat at dispatch (a live-read implementation reds here), while a NEW create after the mutation DOES pick it up — the freeze is temporal', async () => {
    const tid = await createPublished(`fc-${TS}-freeze`, extGraph('form_field_user_dept_head', 1))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!

    // Mutate DEPT_BOT's manager list AFTER create: HEAD1 -> HEAD1B (a fresh linked account).
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

      // Dispatch the ALREADY-CREATED instance: the frozen snapshot must still resolve HEAD1 —
      // no live directory read at dispatch (Lock-2 §2.1 resolver purity).
      const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)
      const inFlight = await activeAssignees(iid, 'ext')
      expect(inFlight.map((a) => a.assignee_id)).toEqual([U_HEAD1])
      expect(inFlight.map((a) => a.assignee_id)).not.toContain(U_HEAD1B)

      // Temporal positive control: a NEW create AFTER the mutation resolves HEAD1B — the
      // create-time read re-executes per create rather than being cached or dead.
      const newTid = await createPublished(`fc-${TS}-freeze-new`, firstNodeGraph('form_field_user_dept_head', 1))
      const newStarted = await createAsReq(newTid)
      expect(newStarted.status, newStarted.text).toBe(201)
      expect((await activeAssignees(newStarted.iid!, 'ext')).map((a) => a.assignee_id)).toEqual([U_HEAD1B])
    } finally {
      await query(
        `UPDATE directory_departments SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{dept_manager_userid_list}', $2::jsonb) WHERE id = $1`,
        [deptBotId, JSON.stringify([EXT_HEAD1])],
      )
    }
  })

  // ── D-2: the NEW field-derived wedge is fail-closed and source-selected ─────────────────────
  it('D-2 wedge: a BROKEN approval_routing policy governing the contact\'s org fail-closes create 422 APPROVAL_ROUTING_POLICY_MISCONFIGURED with zero rows; a template with NO field-derived source still creates under the SAME broken policy (source-selected)', async () => {
    const extTid = await createPublished(`fc-${TS}-wedge-ext`, extGraph('form_field_user_manager', 1))
    const staticTid = await createPublished(`fc-${TS}-wedge-static`, {
      nodes: [
        { key: 'start', type: 'start', name: 's', config: {} },
        { key: 'a1', type: 'approval', name: 'a1', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'e', config: {} },
      ],
      edges: [
        { key: 's2a', source: 'start', target: 'a1' },
        { key: 'a2e', source: 'a1', target: 'end' },
      ],
    })
    // Broken policy: canonical_integration_id points at a real but NON-'active' integration in
    // the same org (the FK requires a real row) → the shipped policy probe raises
    // ApprovalRoutingPolicyError ("points at a 'disabled' integration") for every account linked
    // in org 'default'.
    const disabledInteg = await query<{ id: string }>(
      `INSERT INTO directory_integrations (name, corp_id, status) VALUES ($1, $2, 'disabled') RETURNING id`,
      [`fc-broken-${TS}`, `fc-broken-corp-${TS}`],
    )
    brokenIntegrationId = disabledInteg.rows[0].id
    await query(
      `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
       VALUES ('default', 'approval_routing', $1)`,
      [brokenIntegrationId],
    )
    try {
      const res = await createAsReq(extTid)
      expect(res.status, res.text).toBe(422)
      expect(res.text).toContain('APPROVAL_ROUTING_POLICY_MISCONFIGURED')
      expect(res.text).not.toContain(U_CONTACT)
      expect(await instanceCount(extTid)).toBe(0)

      // Source-selected: NO field-derived source ⇒ the new wedge never arms, create succeeds
      // (the requester org read fails too, but runtimeGraphUsesOrgAssigneeSource is false for a
      // static-only graph, so the shipped wedge stays quiet as well).
      const staticRes = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: staticTid, formData: { reason: 'r', contact: U_CONTACT } } })
      expect(staticRes.status, await staticRes.clone().text()).toBe(201)
    } finally {
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = 'default'`)
    }
  })

  // ── Lock-2 §2.4 handler admission ───────────────────────────────────────────────────────────
  it('handler: a handler node carrying form_field_user_manager publishes (the 7→9 roster growth) and dispatch reaches it with the SAME frozen resolution', async () => {
    const tid = await createPublished(`fc-${TS}-handler`, handlerGraph('form_field_user_manager', 1))
    const started = await createAsReq(tid)
    expect(started.status, started.text).toBe(201)
    const iid = started.iid!
    const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
    expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)
    const assignees = await activeAssignees(iid, 'do')
    expect(assignees.map((a) => a.assignee_id)).toEqual([U_LEADER1])
    const resolvedFrom = (assignees[0].metadata as { resolvedFrom?: Record<string, unknown> } | null)?.resolvedFrom
    expect(resolvedFrom).toEqual({ kind: 'form_field_user_manager', sourceIndex: 0, fieldId: 'contact', level: 1 })
  })
})
