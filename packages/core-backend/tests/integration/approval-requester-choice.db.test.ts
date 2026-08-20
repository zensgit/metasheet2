import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-1 §K2 `requester_choice` (提交人自选) — REAL-DB end-to-end acceptance
 * (docs/development/approval-lock1-enterprise-assignees-20260817.md §K2, gates G-1/G-2/G-8/G-9/
 * G-17/G-18; harness mirrors approval-requester-role.db.test.ts).
 *
 * Proves:
 *  G-1/G-2  the authoring choke accepts requester_choice ONLY in its exact shape and rejects a
 *           contract-unimplemented kind outright (never persisted, never inert);
 *  G-8      out-of-scope / cardinality / missing choices are values-free 422 at create with ZERO
 *           rows persisted; an in-scope choice creates and the assignment carries
 *           metadata.resolvedFrom.kind='requester_choice' — including the CURATION-INDEPENDENCE
 *           discriminator: the role scope validates against PLAIN user_roles membership, so a
 *           choice scoped to a role with approval_usable=FALSE still validates (a broken
 *           implementation importing resolveApprovalRequesterRoleIds would 422 here);
 *  G-9      a role change AFTER create does not alter the frozen choice — dispatch resolves the
 *           chosen user, a return re-entry re-resolves the SAME list — while `transfer` (the
 *           sanctioned mutation) DOES change the seat;
 *  G-17     the null fingerprint is deliberate: requester_choice on both parallel branches
 *           publishes (arm 1, with a `requester`×`requester` publish-400 positive control) and the
 *           same-person collision is caught by the RUNTIME 409 (arm 2, with a
 *           different-person create succeeding as the positive control);
 *  G-18     the 422 bodies carry the node key (template-authored) and NEVER the chosen person id.
 *  G-20     IDENTIFIABILITY (2026-08-21, Codex #4 P2-1 backend derivation): active + in-scope is
 *           not sufficient — a chosen approver whose directory row has a blank/absent display
 *           name is rejected fail-closed (APPROVAL_REQUESTER_CHOICE_UNIDENTIFIED, values-free),
 *           mirroring the FE picker's own choiceConfirmedNames/isChoiceOptionUnidentifiable gate
 *           server-side. Every OTHER fixture user below is now seeded WITH a `name` specifically
 *           so this new baseline check does not turn every pre-existing success-path assertion in
 *           this file into a 422 — only the dedicated UNNAMED fixture is deliberately nameless.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `rchoice-req-${TS}`
const APPROVER = `rchoice-appr-${TS}`
const CHOSEN = `rchoice-chosen-${TS}` // holds ROLE (approval_usable=FALSE — the curation trap)
const NON_HOLDER = `rchoice-nonholder-${TS}` // active user with NO user_roles row
const M1 = `rchoice-m1-${TS}`
const M2 = `rchoice-m2-${TS}`
const OTHER = `rchoice-other-${TS}` // active; outside every members list; transfer target
const INACTIVE = `rchoice-inactive-${TS}` // users.is_active = FALSE
const UNNAMED = `rchoice-unnamed-${TS}` // ACTIVE, in scope, but users.name IS NULL (G-20)
const ROLE = `rchoice-role-${TS}` // seeded with approval_usable = FALSE, deliberately

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

// Linear: static gate first, then a SINGLE-mode ROLE-scoped requester_choice node — used by the
// role-scope validation, freeze/immutability (G-9) and transfer tests.
const ROLE_SCOPE_GRAPH = {
  nodes: [
    { key: 'start', type: 'start', name: 's', config: {} },
    { key: 'approval_1', type: 'approval', name: 'gate', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'approval_rc', type: 'approval', name: 'chosen', config: { assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'role', roleIds: [ROLE] } }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: 'e', config: {} },
  ],
  edges: [
    { key: 's2a1', source: 'start', target: 'approval_1' },
    { key: 'a12rc', source: 'approval_1', target: 'approval_rc' },
    { key: 'rc2e', source: 'approval_rc', target: 'end' },
  ],
}

// MULTI-mode MEMBERS-scoped requester_choice as the first (and only) approval node.
const MEMBERS_SCOPE_GRAPH = {
  nodes: [
    { key: 'start', type: 'start', name: 's', config: {} },
    { key: 'approval_rc', type: 'approval', name: 'chosen', config: { assigneeSources: [{ kind: 'requester_choice', mode: 'multi', scope: { type: 'members', userIds: [M1, M2] } }], approvalMode: 'all', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: 'e', config: {} },
  ],
  edges: [
    { key: 's2rc', source: 'start', target: 'approval_rc' },
    { key: 'rc2e', source: 'approval_rc', target: 'end' },
  ],
}

// SINGLE-mode COMPANY-scoped requester_choice (any ACTIVE local user).
const COMPANY_SCOPE_GRAPH = {
  nodes: [
    { key: 'start', type: 'start', name: 's', config: {} },
    { key: 'approval_rc', type: 'approval', name: 'chosen', config: { assigneeSources: [{ kind: 'requester_choice', mode: 'single', scope: { type: 'company' } }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
    { key: 'end', type: 'end', name: 'e', config: {} },
  ],
  edges: [
    { key: 's2rc', source: 'start', target: 'approval_rc' },
    { key: 'rc2e', source: 'approval_rc', target: 'end' },
  ],
}

// Parallel fork whose BOTH branches are company-scoped requester_choice nodes (G-17).
function parallelChoiceGraph(branchSource: (branch: 'a' | 'b') => Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'fork', type: 'parallel', name: 'fork', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
      { key: 'branch_a', type: 'approval', name: 'A', config: { assigneeSources: [branchSource('a')], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'branch_b', type: 'approval', name: 'B', config: { assigneeSources: [branchSource('b')], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'join', type: 'approval', name: 'join', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 'e-start-fork', source: 'start', target: 'fork' },
      { key: 'e-fork-a', source: 'fork', target: 'branch_a' },
      { key: 'e-fork-b', source: 'fork', target: 'branch_b' },
      { key: 'e-a-join', source: 'branch_a', target: 'join' },
      { key: 'e-b-join', source: 'branch_b', target: 'join' },
      { key: 'e-join-end', source: 'join', target: 'end' },
    ],
  }
}

type ErrorBody = { code?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } }
function errorCode(body: ErrorBody): string | undefined {
  return body.code ?? body.error?.code
}

// ── Anti-skip-green sentinel (PR #4952 gate P2-2) ────────────────────────────────────────────
// TOP-LEVEL, deliberately OUTSIDE describeIfDatabase: a sentinel inside the gated describe is
// structurally inert — it skips exactly when it should fire. The dedicated
// .github/workflows/approval-realdb-acceptance.yml lane sets EXPECT_DB=1: there, a
// missing/broken DATABASE_URL REDS the run instead of reporting the whole suite as silently
// skipped-green. Ordinary no-DB collection (EXPECT_DB unset) skips this test cleanly.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('Lock-1 §K2 requester_choice — real-DB create/freeze/dispatch acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let apprTok = ''
  let chosenTok = ''

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
  async function activeAssignees(iid: string): Promise<Array<{ assignee_id: string; node_key: string | null; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(
      `SELECT assignee_id, node_key, metadata FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ORDER BY assignee_id`,
      [iid],
    )
    return rows.rows as Array<{ assignee_id: string; node_key: string | null; metadata: Record<string, unknown> | null }>
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    // RBAC table guards (defensive — present via migrations in a full CI lane; matches the real schema).
    await pool.query(`CREATE TABLE IF NOT EXISTS user_roles (user_id varchar(255) NOT NULL, role_id varchar(255) NOT NULL, created_at timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL)`)
    await pool.query(`CREATE TABLE IF NOT EXISTS roles (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL)`)
    await pool.query(`ALTER TABLE roles ADD COLUMN IF NOT EXISTS approval_usable boolean NOT NULL DEFAULT false`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`)
    // CURATION-INDEPENDENCE TRAP (§K2 verbatim): the choice-scope role is approval_usable=FALSE.
    // K2's role scope is PLAIN membership; only the requester.role ROUTING predicate is curated.
    await pool.query(`INSERT INTO roles (id, name, approval_usable) VALUES ($1, $2, false) ON CONFLICT (id) DO UPDATE SET approval_usable = false`, [ROLE, ROLE])
    // G-20: every OTHER fixture user is seeded WITH a real `name` -- the new identifiability
    // baseline (validateAndFreezeRequesterChoices) would otherwise 422 every pre-existing
    // success-path assertion below, since `users.name` has no default and every one of these
    // rows was previously created nameless.
    for (const userId of [REQ, APPROVER, CHOSEN, NON_HOLDER, M1, M2, OTHER]) {
      await pool.query(`INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1, $2, $3, 'x', TRUE) ON CONFLICT (id) DO NOTHING`, [userId, `${userId}@x.test`, userId])
    }
    await pool.query(`INSERT INTO users (id, email, name, password_hash, is_active) VALUES ($1, $2, $3, 'x', FALSE) ON CONFLICT (id) DO NOTHING`, [INACTIVE, `${INACTIVE}@x.test`, INACTIVE])
    // G-20: ACTIVE, in scope for `company`, but deliberately left NAMELESS (name IS NULL) --
    // the dedicated fixture for the identifiability baseline itself.
    await pool.query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE) ON CONFLICT (id) DO NOTHING`, [UNNAMED, `${UNNAMED}@x.test`])
    await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [CHOSEN, ROLE])
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    apprTok = await tok(base, APPROVER)
    chosenTok = await tok(base, CHOSEN)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`rchoice-${TS}-%`])).rows.map((r) => r.id as string)
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
      await pool.query(`DELETE FROM user_roles WHERE user_id = ANY($1::varchar[])`, [[CHOSEN]])
      await pool.query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, APPROVER, CHOSEN, NON_HOLDER, M1, M2, OTHER, INACTIVE, UNNAMED]])
      await pool.query(`DELETE FROM roles WHERE id = ANY($1::text[])`, [[ROLE]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  // ── G-1 / G-2 — authoring choke: exact shape only; unimplemented kinds fail closed ─────────
  it('G-1: requester_choice saves in its exact shape; bad mode / unknown scope type / extra scope key each 400', async () => {
    // Positive control FIRST: the exact shape saves (the rejection below is shape-selected).
    await createTemplate(`rchoice-${TS}-g1-ok`, ROLE_SCOPE_GRAPH)

    const badShapes: Array<Record<string, unknown>> = [
      { kind: 'requester_choice', mode: 'both', scope: { type: 'company' } },
      { kind: 'requester_choice', mode: 'single', scope: { type: 'dept' } },
      { kind: 'requester_choice', mode: 'single', scope: { type: 'company', extra: true } },
      { kind: 'requester_choice', mode: 'single', scope: { type: 'members', userIds: [] } },
      { kind: 'requester_choice', mode: 'single', scope: { type: 'role' } },
      { kind: 'requester_choice', mode: 'single', scope: { type: 'company' }, futureFlag: 1 },
    ]
    for (const source of badShapes) {
      const graph = JSON.parse(JSON.stringify(COMPANY_SCOPE_GRAPH)) as typeof COMPANY_SCOPE_GRAPH
      ;(graph.nodes[1].config as { assigneeSources: unknown[] }).assigneeSources = [source]
      const res = await req(base, '/api/approval-templates', reqTok, {
        method: 'POST',
        body: { key: `rchoice-${TS}-g1-bad`, name: 'bad', formSchema: FORM_SCHEMA, approvalGraph: graph },
      })
      expect(res.status, JSON.stringify(source)).toBe(400)
    }
  })

  it('G-2: a contract-unimplemented kind is rejected at authoring and never persisted', async () => {
    // Lock-1 §K1 landed `user_group` (this file's PREVIOUS fixture here) — swapped to a kind
    // that is genuinely undeclared anywhere in the union, so this arm keeps testing the SAME
    // default-arm rejection mechanism (`normalizeApprovalAssigneeSources`'s `default:` choke)
    // rather than silently starting to exercise the (now-implemented) K1 create path instead.
    const graph = JSON.parse(JSON.stringify(COMPANY_SCOPE_GRAPH)) as typeof COMPANY_SCOPE_GRAPH
    ;(graph.nodes[1].config as { assigneeSources: unknown[] }).assigneeSources = [{ kind: 'not_a_real_kind', groupIds: ['g1'] }]
    const key = `rchoice-${TS}-g2-notreal`
    const res = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: graph },
    })
    expect(res.status).toBe(400)
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT id FROM approval_templates WHERE key = $1`, [key])
    expect(rows.rows).toHaveLength(0)
    // Positive control: the implemented kind persisted in the same fixture family (G-1 above).
  })

  // ── G-8 — create-path scope validation: values-free 422, zero rows ─────────────────────────
  it('G-8: a published requester_choice node with NO entry in the payload is a create-time 422 (REQUIRED), zero rows', async () => {
    const tid = await createPublished(`rchoice-${TS}-g8-required`, MEMBERS_SCOPE_GRAPH)
    const res = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(res.status, await res.clone().text()).toBe(422)
    const body = (await res.json()) as ErrorBody
    expect(errorCode(body)).toBe('APPROVAL_REQUESTER_CHOICE_REQUIRED')
    expect(body.error?.details?.nodeKey).toBe('approval_rc')
    expect(await instanceCount(tid)).toBe(0)

    // Positive control in the SAME fixture: an in-scope choice creates successfully, the frozen
    // map lands in the snapshot, and the assignment is attributed to requester_choice.
    const ok = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [M1] } },
    })
    expect(ok.status, await ok.clone().text()).toBe(201)
    const iid = ((await ok.json()) as { id: string }).id
    const pool = poolManager.get()
    const snap = (await pool.query<{ requester_snapshot: { requesterChoices?: Record<string, string[]> } }>(
      `SELECT requester_snapshot FROM approval_instances WHERE id = $1`,
      [iid],
    )).rows[0]
    expect(snap.requester_snapshot.requesterChoices).toEqual({ approval_rc: [M1] })
    const assignments = await activeAssignees(iid)
    expect(assignments.map((a) => a.assignee_id)).toEqual([M1])
    const resolvedFrom = (assignments[0].metadata as { resolvedFrom?: { kind?: string } } | null)?.resolvedFrom
    expect(resolvedFrom?.kind).toBe('requester_choice')
  })

  it('G-8/G-18: an out-of-list members choice is a VALUES-FREE 422 (node key present, chosen id absent), zero rows', async () => {
    const tid = await createPublished(`rchoice-${TS}-g8-members`, MEMBERS_SCOPE_GRAPH)
    const res = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [OTHER] } },
    })
    expect(res.status).toBe(422)
    const raw = await res.clone().text()
    const body = (await res.json()) as ErrorBody
    expect(errorCode(body)).toBe('APPROVAL_REQUESTER_CHOICE_OUT_OF_SCOPE')
    // G-18 both arms: values-free (no chosen person id anywhere in the body) AND the SAME path
    // carries the node key + scope type — the check is not passing on an empty payload.
    expect(raw).not.toContain(OTHER)
    expect(body.error?.details?.nodeKey).toBe('approval_rc')
    expect(body.error?.details?.scopeType).toBe('members')
    expect(await instanceCount(tid)).toBe(0)
  })

  it('G-8: single-mode cardinality — two chosen ids 422 (CARDINALITY) with zero rows; multi-mode accepts two', async () => {
    const singleTid = await createPublished(`rchoice-${TS}-g8-card-single`, COMPANY_SCOPE_GRAPH)
    const res = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: singleTid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [M1, M2] } },
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as ErrorBody
    expect(errorCode(body)).toBe('APPROVAL_REQUESTER_CHOICE_CARDINALITY')
    expect(body.error?.details?.mode).toBe('single')
    expect(await instanceCount(singleTid)).toBe(0)

    // Positive control: the SAME two ids are accepted by a MULTI-mode node — the rejection is
    // mode-selected, not blanket.
    const multiTid = await createPublished(`rchoice-${TS}-g8-card-multi`, MEMBERS_SCOPE_GRAPH)
    const ok = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: multiTid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [M1, M2] } },
    })
    expect(ok.status, await ok.clone().text()).toBe(201)
    const iid = ((await ok.json()) as { id: string }).id
    expect((await activeAssignees(iid)).map((a) => a.assignee_id).sort()).toEqual([M1, M2].sort())
  })

  it('G-8: an entry for a node with NO requester_choice source is 422 (UNKNOWN_NODE), zero rows', async () => {
    const tid = await createPublished(`rchoice-${TS}-g8-unknownnode`, MEMBERS_SCOPE_GRAPH)
    const res = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [M1], start: [M2] } },
    })
    expect(res.status).toBe(422)
    expect(errorCode((await res.json()) as ErrorBody)).toBe('APPROVAL_REQUESTER_CHOICE_UNKNOWN_NODE')
    expect(await instanceCount(tid)).toBe(0)
  })

  it('G-8: company scope accepts any ACTIVE user and rejects an INACTIVE one (OUT_OF_SCOPE, zero rows)', async () => {
    const tid = await createPublished(`rchoice-${TS}-g8-company`, COMPANY_SCOPE_GRAPH)
    const bad = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [INACTIVE] } },
    })
    expect(bad.status).toBe(422)
    expect(errorCode((await bad.json()) as ErrorBody)).toBe('APPROVAL_REQUESTER_CHOICE_OUT_OF_SCOPE')
    expect(await instanceCount(tid)).toBe(0)

    // Positive: an arbitrary ACTIVE user (no role, no members list) is in scope for `company`.
    const ok = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [NON_HOLDER] } },
    })
    expect(ok.status, await ok.clone().text()).toBe(201)
  })

  // G-20 (2026-08-21, Codex #4 P2-1 backend derivation): active + in-scope is not enough -- a
  // chosen approver with a blank/absent directory display name (UNNAMED: is_active=TRUE, no
  // members/role restriction to fail on) is rejected fail-closed, values-free, zero rows. The
  // positive control (a NAMED active user, same scope, same template) proves the 422 is about
  // identifiability specifically, not an unrelated regression in the company-scope path itself.
  it('G-20 identifiability: company scope rejects a chosen approver with a blank/absent display name (APPROVAL_REQUESTER_CHOICE_UNIDENTIFIED, zero rows), and accepts a named one', async () => {
    const tid = await createPublished(`rchoice-${TS}-g20-unidentified`, COMPANY_SCOPE_GRAPH)
    const bad = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [UNNAMED] } },
    })
    expect(bad.status, await bad.clone().text()).toBe(422)
    const raw = await bad.clone().text()
    expect(errorCode((await bad.json()) as ErrorBody)).toBe('APPROVAL_REQUESTER_CHOICE_UNIDENTIFIED')
    expect(raw, 'values-free: the chosen (unidentifiable) id itself must never be echoed').not.toContain(UNNAMED)
    expect(await instanceCount(tid)).toBe(0)

    // Positive control: a NAMED active user, same scope, same template, succeeds.
    const ok = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [NON_HOLDER] } },
    })
    expect(ok.status, await ok.clone().text()).toBe(201)
  })

  it('G-8 role scope: PLAIN user_roles membership — validates against an approval_usable=FALSE role (curation-independence) and rejects a non-holder', async () => {
    const tid = await createPublished(`rchoice-${TS}-g8-role`, ROLE_SCOPE_GRAPH)
    // THE §K2 DISCRIMINATOR: ROLE is seeded approval_usable=FALSE. A (wrong) implementation
    // reusing resolveApprovalRequesterRoleIds would resolve zero holders and 422 here.
    const ok = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [CHOSEN] } },
    })
    expect(ok.status, await ok.clone().text()).toBe(201)

    // Non-holder of the configured role: OUT_OF_SCOPE, values-free, zero NEW rows.
    const before = await instanceCount(tid)
    const bad = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [NON_HOLDER] } },
    })
    expect(bad.status).toBe(422)
    const raw = await bad.clone().text()
    expect(errorCode((await bad.json()) as ErrorBody)).toBe('APPROVAL_REQUESTER_CHOICE_OUT_OF_SCOPE')
    expect(raw).not.toContain(NON_HOLDER)
    expect(await instanceCount(tid)).toBe(before)
  })

  // ── G-9 — freeze-at-create: role change never re-routes; return re-resolves the SAME list;
  //          transfer is the ONE sanctioned in-flight mutation ────────────────────────────────
  it('G-9: role removed AFTER create → dispatch still assigns the frozen choice; return re-entry re-resolves the SAME list; transfer DOES move the seat', async () => {
    const tid = await createPublished(`rchoice-${TS}-g9`, ROLE_SCOPE_GRAPH)
    const started = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [CHOSEN] } },
    })
    expect(started.status, await started.clone().text()).toBe(201)
    const iid = ((await started.json()) as { id: string }).id

    // Directory/role change AFTER create: CHOSEN loses the scoped role entirely.
    const pool = poolManager.get()
    await pool.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`, [CHOSEN, ROLE])
    try {
      // Dispatch to the requester_choice node — resolves from the FROZEN map, not live user_roles.
      const approved = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(approved.status, await approved.clone().text()).toBeLessThan(300)
      let active = await activeAssignees(iid)
      expect(active.map((a) => a.assignee_id)).toEqual([CHOSEN])
      expect(active[0].node_key).toBe('approval_rc')

      // Return to the gate node, then re-approve: the RE-ENTERED node re-resolves the SAME
      // frozen list (immutability across return — no re-read, no re-choice, no re-validation).
      const returned = await req(base, `/api/approvals/${iid}/actions`, chosenTok, {
        method: 'POST',
        body: { action: 'return', targetNodeKey: 'approval_1' },
      })
      expect(returned.status, await returned.clone().text()).toBeLessThan(300)
      const reApproved = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(reApproved.status, await reApproved.clone().text()).toBeLessThan(300)
      active = await activeAssignees(iid)
      expect(active.map((a) => a.assignee_id)).toEqual([CHOSEN])
      expect(active[0].node_key).toBe('approval_rc')

      // G-19 temporal positive control (PR #4952 gate P3-5): the SAME role removal DOES reject a
      // NEW create — the freeze is temporal (the scope read re-executes per create), never a
      // dead/startup-cached read. Discriminates against a holders set cached across creates,
      // which would pass both the in-flight assertions above and the static non-holder negative.
      const beforeTemporal = await instanceCount(tid)
      const temporalCreate = await req(base, '/api/approvals', reqTok, {
        method: 'POST',
        body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [CHOSEN] } },
      })
      expect(temporalCreate.status, await temporalCreate.clone().text()).toBe(422)
      expect(errorCode((await temporalCreate.json()) as ErrorBody)).toBe('APPROVAL_REQUESTER_CHOICE_OUT_OF_SCOPE')
      expect(await instanceCount(tid)).toBe(beforeTemporal)

      // Positive control (the sanctioned mutation): transfer moves the seat to OTHER.
      const transferred = await req(base, `/api/approvals/${iid}/actions`, chosenTok, {
        method: 'POST',
        body: { action: 'transfer', targetUserId: OTHER },
      })
      expect(transferred.status, await transferred.clone().text()).toBeLessThan(300)
      active = await activeAssignees(iid)
      expect(active.map((a) => a.assignee_id)).toEqual([OTHER])
      expect(active.map((a) => a.assignee_id)).not.toContain(CHOSEN)
    } finally {
      // Restore for any later test relying on CHOSEN's membership.
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [CHOSEN, ROLE])
    }
  })

  // ── G-17 — null fingerprint deliberate: publish passes, runtime 409 owns the collision ──────
  it('G-17 arm 1: requester_choice on BOTH parallel branches publishes; identical `requester` sources are publish-blocked (positive control)', async () => {
    const rcTid = await createTemplate(
      `rchoice-${TS}-g17-publish`,
      parallelChoiceGraph(() => ({ kind: 'requester_choice', mode: 'single', scope: { type: 'company' } })),
    )
    const published = await publishTemplate(rcTid)
    expect(published.status, await published.clone().text()).toBe(200)

    // Positive control: the SAME topology with a provably-identical dynamic source on both
    // branches is publish-blocked with the SAME code the runtime guard raises.
    const dupTid = await createTemplate(
      `rchoice-${TS}-g17-dup`,
      parallelChoiceGraph(() => ({ kind: 'requester' })),
    )
    const blocked = await publishTemplate(dupTid)
    expect(blocked.status, await blocked.clone().text()).toBe(400)
    expect(errorCode((await blocked.json()) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT')
  })

  it('G-17 arm 2: choosing the SAME person for both branches hits the runtime 409 (zero rows); different persons create fine', async () => {
    const tid = await createPublished(
      `rchoice-${TS}-g17-runtime`,
      parallelChoiceGraph(() => ({ kind: 'requester_choice', mode: 'single', scope: { type: 'company' } })),
    )
    const conflicted = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { branch_a: [M1], branch_b: [M1] } },
    })
    expect(conflicted.status, await conflicted.clone().text()).toBe(409)
    expect(errorCode((await conflicted.json()) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT')
    expect(await instanceCount(tid)).toBe(0)

    // Positive control: DIFFERENT chosen persons fan out into two active branch assignments.
    const ok = await req(base, '/api/approvals', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { branch_a: [M1], branch_b: [M2] } },
    })
    expect(ok.status, await ok.clone().text()).toBe(201)
    const iid = ((await ok.json()) as { id: string }).id
    const active = await activeAssignees(iid)
    expect(active.map((a) => a.assignee_id).sort()).toEqual([M1, M2].sort())
  })

  // ── Route preview honesty (B3-05 substrate; §K2 optional-presence) ─────────────────────────
  it('route preview: choices are OPTIONAL pre-choice (honest truncation, NOT a 422) and resolve the chosen user post-choice', async () => {
    const tid = await createPublished(`rchoice-${TS}-preview`, MEMBERS_SCOPE_GRAPH)
    // Pre-choice: the preview must NOT 422 (choices are optional on the read-only walk). With
    // emptyAssigneePolicy 'error' on the first node, the walk's honest floor is an EMPTY
    // TRUNCATED route (walkPreviewRoute catches the empty-resolution throw) — never a
    // fabricated approver and never a create-style rejection.
    const bare = await req(base, '/api/approvals/preview', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' } },
    })
    expect(bare.status, await bare.clone().text()).toBe(200)
    const bareBody = (await bare.json()) as { route: Array<{ nodeKey: string }>; truncated?: boolean }
    expect(bareBody.route).toEqual([])
    expect(bareBody.truncated).toBe(true)

    const chosen = await req(base, '/api/approvals/preview', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [M1] } },
    })
    expect(chosen.status, await chosen.clone().text()).toBe(200)
    const chosenBody = (await chosen.json()) as { route: Array<{ nodeKey: string; resolveError?: string; assignees: Array<{ id: string }> }> }
    const chosenNode = chosenBody.route.find((n) => n.nodeKey === 'approval_rc')
    expect(chosenNode?.resolveError).toBeUndefined()
    expect(chosenNode?.assignees.map((a) => a.id)).toEqual([M1])
    // Preview is validated on the SAME substrate: an out-of-scope preview choice 422s too.
    const invalid = await req(base, '/api/approvals/preview', reqTok, {
      method: 'POST',
      body: { templateId: tid, formData: { reason: 'r' }, requesterChoices: { approval_rc: [OTHER] } },
    })
    expect(invalid.status).toBe(422)
  })
})
