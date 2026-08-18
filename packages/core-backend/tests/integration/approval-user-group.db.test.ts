import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * Lock-1 §K1 `user_group` (用户组) — REAL-DB end-to-end acceptance
 * (docs/development/approval-lock1-enterprise-assignees-20260817.md §K1, gates G-1/G-4(deferred)/
 * G-5/G-6/G-7/G-17/G-18; harness mirrors approval-requester-choice.db.test.ts).
 *
 * Proves:
 *  G-1      the authoring choke accepts user_group ONLY in its exact shape (non-empty groupIds,
 *           no unknown extra keys) — a valid shape saves in the same fixture (positive control);
 *  G-5      OD-L1-2(a) curated per-org binding table (`approval_usable_member_groups`, empty by
 *           default): a group with NO binding row (dangling) fails publish 400
 *           (APPROVAL_ASSIGNEE_GROUP_NOT_BOUND), values-free; a group bound to the publishing org
 *           publishes (the gate is membership-selected);
 *  G-6      multi-corp negative: a group bound ONLY to 'org-b' fails publish under the DEFAULT org
 *           (dangling-from-default's perspective) and publishes under orgId='org-b' — both
 *           directions asserted, with NO directory fixture at all (org is a plain request param —
 *           OD-L1-2(a) does not require identity→org resolution plumbing);
 *  G-7      OD-L1-1(a) EAGER_EXPANSION binding semantics: a group membership change AFTER create
 *           does NOT alter an in-flight instance (frozen `groupMemberIds` snapshot) — the
 *           DISCRIMINATING freeze-purity test — while a NEW create AFTER the SAME mutation DOES
 *           pick it up (temporal, not a dead/cached read);
 *  G-17     identical (sorted) group sets on parallel branches are publish-blocked; different sets
 *           are not (the fingerprint mirror is order-independent and kind-selected);
 *  G-18     every rejection here is values-free: node key / source index / group id (a
 *           template-authored identifier, §2.6-permitted) — never a person id or group membership;
 *  +        empty group under `emptyAssigneePolicy:'auto-approve'` yields an AUDITED
 *           `system:auto-approval` record (never a silent nobody); under the default 'error' it
 *           fails closed APPROVAL_ASSIGNEE_EMPTY;
 *  +        the curated bind/unbind path is the ONLY way to add/remove a binding row (direct writes
 *           are not exercised by any route — this proves the ROUTE'S effect, not just the SQL);
 *  +        the picker endpoint is org-scoped: org A cannot list org B's bound groups (values-free
 *           negative — no group NAME/id crosses the boundary either).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const REQ = `ug-req-${TS}`
const APPROVER = `ug-appr-${TS}`
const M1 = `ug-m1-${TS}`
const M2 = `ug-m2-${TS}`
const M3 = `ug-m3-${TS}`
const OTHER = `ug-other-${TS}`
const ORG_B = `ug-org-b-${TS}`

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

// Linear: static gate first, then a single user_group node referencing `groupId` — used by the
// shape/happy-path/freeze-purity/publish-binding tests.
function ugGraph(groupIds: string[], emptyAssigneePolicy: 'error' | 'auto-approve' = 'error') {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'approval_1', type: 'approval', name: 'gate', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
      { key: 'approval_ug', type: 'approval', name: 'group', config: { assigneeSources: [{ kind: 'user_group', groupIds }], approvalMode: 'all', emptyAssigneePolicy } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2a1', source: 'start', target: 'approval_1' },
      { key: 'a12ug', source: 'approval_1', target: 'approval_ug' },
      { key: 'ug2e', source: 'approval_ug', target: 'end' },
    ],
  }
}

// The user_group node is FIRST (no gate) — a create-time cascade resolves it immediately, so an
// empty-policy test observes the outcome synchronously from createApproval's own response/rows.
function ugFirstGraph(groupIds: string[], emptyAssigneePolicy: 'error' | 'auto-approve') {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'approval_ug', type: 'approval', name: 'group', config: { assigneeSources: [{ kind: 'user_group', groupIds }], approvalMode: 'all', emptyAssigneePolicy } },
      { key: 'end', type: 'end', name: 'e', config: {} },
    ],
    edges: [
      { key: 's2ug', source: 'start', target: 'approval_ug' },
      { key: 'ug2e', source: 'approval_ug', target: 'end' },
    ],
  }
}

// Parallel fork whose BOTH branches are user_group nodes (G-17).
function parallelGroupGraph(branchGroupIds: (branch: 'a' | 'b') => string[]) {
  return {
    nodes: [
      { key: 'start', type: 'start', name: 's', config: {} },
      { key: 'fork', type: 'parallel', name: 'fork', config: { branches: ['e-fork-a', 'e-fork-b'], joinMode: 'all', joinNodeKey: 'join' } },
      { key: 'branch_a', type: 'approval', name: 'A', config: { assigneeSources: [{ kind: 'user_group', groupIds: branchGroupIds('a') }], approvalMode: 'all', emptyAssigneePolicy: 'error' } },
      { key: 'branch_b', type: 'approval', name: 'B', config: { assigneeSources: [{ kind: 'user_group', groupIds: branchGroupIds('b') }], approvalMode: 'all', emptyAssigneePolicy: 'error' } },
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

// ── Anti-skip-green sentinel (K2/K3 posture, PR #4952 gate P2-2) ────────────────────────────
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

describeIfDatabase('Lock-1 §K1 user_group — real-DB create/freeze/dispatch/publish-binding acceptance', () => {
  let server: MetaSheetServer | undefined
  let base = ''
  let reqTok = ''
  let apprTok = ''
  let groupIdMain = ''
  let groupIdOrgB = ''
  let groupIdUnbound = ''
  let groupIdEmpty = ''

  async function createTemplate(key: string, graph: unknown): Promise<{ status: number; id?: string; body: unknown }> {
    const created = await req(base, '/api/approval-templates', reqTok, {
      method: 'POST',
      body: { key, name: key, formSchema: FORM_SCHEMA, approvalGraph: graph },
    })
    const body = await created.clone().json().catch(() => ({}))
    return { status: created.status, id: (body as { id?: string }).id, body }
  }
  async function publishTemplate(tid: string, orgId?: string): Promise<Response> {
    return req(base, `/api/approval-templates/${tid}/publish`, reqTok, {
      method: 'POST',
      body: { policy: { allowRevoke: true }, ...(orgId !== undefined ? { orgId } : {}) },
    })
  }
  async function createPublished(key: string, graph: unknown, orgId?: string): Promise<string> {
    const created = await createTemplate(key, graph)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const published = await publishTemplate(created.id!, orgId)
    expect(published.status, await published.clone().text()).toBe(200)
    return created.id!
  }
  async function instanceCount(tid: string): Promise<number> {
    const pool = poolManager.get()
    const rows = await pool.query(`SELECT COUNT(*)::int AS n FROM approval_instances WHERE template_id = $1`, [tid])
    return (rows.rows[0] as { n: number }).n
  }
  async function activeAssignees(iid: string, nodeKey?: string): Promise<Array<{ assignee_id: string; node_key: string | null; metadata: Record<string, unknown> | null }>> {
    const pool = poolManager.get()
    const rows = await pool.query(
      `SELECT assignee_id, node_key, metadata FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ${nodeKey ? 'AND node_key = $2' : ''} ORDER BY assignee_id`,
      nodeKey ? [iid, nodeKey] : [iid],
    )
    return rows.rows as Array<{ assignee_id: string; node_key: string | null; metadata: Record<string, unknown> | null }>
  }
  async function createGroup(name: string): Promise<string> {
    const pool = poolManager.get()
    const row = await pool.query<{ id: string }>(
      `INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id`,
      [name],
    )
    return row.rows[0].id
  }
  async function bindGroup(orgId: string, groupId: string, token = reqTok): Promise<Response> {
    return req(base, '/api/approval-templates/directory/member-groups/bind', token, {
      method: 'POST',
      body: { orgId, groupId },
    })
  }
  async function unbindGroup(orgId: string, groupId: string, token = reqTok): Promise<Response> {
    return req(base, '/api/approval-templates/directory/member-groups/unbind', token, {
      method: 'POST',
      body: { orgId, groupId },
    })
  }
  async function listBoundGroups(orgId: string, token = reqTok): Promise<{ status: number; groups: Array<{ id: string; name: string; memberCount: number }> }> {
    const res = await req(base, `/api/approval-templates/directory/member-groups?orgId=${encodeURIComponent(orgId)}`, token)
    const body = (await res.json().catch(() => ({ groups: [] }))) as { groups?: Array<{ id: string; name: string; memberCount: number }> }
    return { status: res.status, groups: body.groups ?? [] }
  }

  beforeAll(async () => {
    expect(await canListen()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()
    // Defensive guards (present via migrations in a full CI lane; matches the real schema) —
    // same posture as K2's user_roles/roles guards.
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_member_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        description text,
        created_by text,
        updated_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_member_groups_name ON platform_member_groups(name)`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_member_group_members (
        group_id uuid NOT NULL REFERENCES platform_member_groups(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (group_id, user_id)
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS approval_usable_member_groups (
        org_id text NOT NULL,
        group_id uuid NOT NULL REFERENCES platform_member_groups(id) ON DELETE CASCADE,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, group_id)
      )
    `)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true`)
    for (const userId of [REQ, APPROVER, M1, M2, M3, OTHER]) {
      await pool.query(`INSERT INTO users (id, email, password_hash, is_active) VALUES ($1, $2, 'x', TRUE) ON CONFLICT (id) DO NOTHING`, [userId, `${userId}@x.test`])
    }

    groupIdMain = await createGroup(`ug-grp-main-${TS}`)
    groupIdOrgB = await createGroup(`ug-grp-orgb-${TS}`)
    groupIdUnbound = await createGroup(`ug-grp-unbound-${TS}`)
    groupIdEmpty = await createGroup(`ug-grp-empty-${TS}`)
    await pool.query(`INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2), ($1, $3)`, [groupIdMain, M1, M2])
    await pool.query(`INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)`, [groupIdOrgB, M1])

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    base = `http://127.0.0.1:${server.getAddress()!.port}`
    reqTok = await tok(base, REQ)
    apprTok = await tok(base, APPROVER)

    // Curated bindings via the ROUTE (not direct SQL) — proves the route itself, not just the
    // schema. groupIdMain -> DEFAULT_ORG_ID ('default', the publish/picker fallback); groupIdOrgB
    // -> ORG_B only. groupIdUnbound and groupIdEmpty are deliberately left unbound until their
    // own tests bind them explicitly (dangling-by-default).
    const boundMain = await bindGroup('default', groupIdMain)
    expect(boundMain.status, await boundMain.clone().text()).toBe(200)
    const boundOrgB = await bindGroup(ORG_B, groupIdOrgB)
    expect(boundOrgB.status, await boundOrgB.clone().text()).toBe(200)
  })

  afterAll(async () => {
    try {
      const pool = poolManager.get()
      const tids = (await pool.query(`SELECT id FROM approval_templates WHERE key LIKE $1`, [`ug-${TS}-%`])).rows.map((r) => r.id as string)
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
      await pool.query(`DELETE FROM approval_usable_member_groups WHERE group_id = ANY($1::uuid[])`, [[groupIdMain, groupIdOrgB, groupIdUnbound, groupIdEmpty]])
      await pool.query(`DELETE FROM platform_member_group_members WHERE group_id = ANY($1::uuid[])`, [[groupIdMain, groupIdOrgB, groupIdUnbound, groupIdEmpty]])
      await pool.query(`DELETE FROM platform_member_groups WHERE id = ANY($1::uuid[])`, [[groupIdMain, groupIdOrgB, groupIdUnbound, groupIdEmpty]])
      await pool.query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[REQ, APPROVER, M1, M2, M3, OTHER]])
    } catch {
      /* best effort */
    }
    if (server) await server.stop()
  })

  // ── Migration-shape assertion (fix-round P2-3) ──────────────────────────────────────────────
  // The `beforeAll` guard above is DEFENSIVE (matches the K2/K4/K5-b/K3 precedent's own defensive
  // roles/user_roles CREATE TABLE guards) and intentionally OMITS the `created_by` FK + the
  // `group_id` index — so if the REAL migration (zzzz20260818120000) never ran, this suite would
  // otherwise stay fully green against a materially weaker table. This test makes that
  // observable: it asserts the shape ONLY the migration produces, so a dropped/reverted migration
  // reds here even though every other test in this file still passes against the defensive
  // fallback table.
  it('the real migration ran: approval_usable_member_groups carries the created_by→users FK and the group_id index (not just the defensive fallback shape)', async () => {
    const pool = poolManager.get()
    const fk = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname = 'approval_usable_member_groups_created_by_fkey'
         AND conrelid = 'approval_usable_member_groups'::regclass
         AND confrelid = 'users'::regclass`,
    )
    expect(fk.rows.length, 'created_by -> users(id) FK missing — only the defensive fallback DDL ran, the migration did not').toBe(1)
    const idx = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'approval_usable_member_groups'
         AND indexname = 'idx_approval_usable_member_groups_group_id'`,
    )
    expect(idx.rows.length, 'idx_approval_usable_member_groups_group_id missing — only the defensive fallback DDL ran, the migration did not').toBe(1)
  })

  // ── G-1 — authoring choke: exact shape only ─────────────────────────────────────────────────
  it('G-1: user_group saves in its exact shape; empty groupIds / non-array / unknown extra key each 400', async () => {
    // Positive control FIRST: the exact shape saves (the rejection below is shape-selected).
    const ok = await createTemplate(`ug-${TS}-g1-ok`, ugGraph([groupIdMain]))
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)

    const badShapes: Array<Record<string, unknown>> = [
      { kind: 'user_group', groupIds: [] },
      { kind: 'user_group', groupIds: 'not-an-array' },
      { kind: 'user_group', groupIds: [groupIdMain], futureFlag: true },
      { kind: 'user_group' },
    ]
    for (const source of badShapes) {
      const graph = JSON.parse(JSON.stringify(ugGraph([groupIdMain]))) as ReturnType<typeof ugGraph>
      ;(graph.nodes[2].config as { assigneeSources: unknown[] }).assigneeSources = [source]
      const res = await req(base, '/api/approval-templates', reqTok, {
        method: 'POST',
        body: { key: `ug-${TS}-g1-bad`, name: 'bad', formSchema: FORM_SCHEMA, approvalGraph: graph },
      })
      expect(res.status, JSON.stringify(source)).toBe(400)
    }
  })

  // ── Curated bind/unbind path (the ONLY sanctioned mutation) ─────────────────────────────────
  it('curated CRUD: bind requires a REAL group (404 for a nonexistent id); unbind removes the row so a later publish 400s', async () => {
    const badBind = await bindGroup('default', '00000000-0000-0000-0000-000000000000')
    expect(badBind.status).toBe(404)

    // A fresh group bound then unbound: publish succeeds while bound, fails once unbound — the
    // STATE actually changed via the route (not a stale cache / direct-SQL side channel).
    const scratchGroup = await createGroup(`ug-grp-scratch-${TS}`)
    const bound = await bindGroup('default', scratchGroup)
    expect(bound.status, await bound.clone().text()).toBe(200)
    const listedBound = await listBoundGroups('default')
    expect(listedBound.groups.map((g) => g.id)).toContain(scratchGroup)

    const publishedWhileBound = await createTemplate(`ug-${TS}-crud-bound`, ugGraph([scratchGroup]))
    expect(publishedWhileBound.status).toBe(201)
    const okPublish = await publishTemplate(publishedWhileBound.id!)
    expect(okPublish.status, await okPublish.clone().text()).toBe(200)

    const unbound = await unbindGroup('default', scratchGroup)
    expect(unbound.status, await unbound.clone().text()).toBe(200)
    const listedAfterUnbind = await listBoundGroups('default')
    expect(listedAfterUnbind.groups.map((g) => g.id)).not.toContain(scratchGroup)

    const publishedWhileUnbound = await createTemplate(`ug-${TS}-crud-unbound`, ugGraph([scratchGroup]))
    expect(publishedWhileUnbound.status).toBe(201)
    const blockedPublish = await publishTemplate(publishedWhileUnbound.id!)
    expect(blockedPublish.status, await blockedPublish.clone().text()).toBe(400)
    expect(errorCode((await blockedPublish.json()) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_GROUP_NOT_BOUND')

    const pool = poolManager.get()
    await pool.query(`DELETE FROM approval_usable_member_groups WHERE group_id = $1`, [scratchGroup])
    await pool.query(`DELETE FROM platform_member_groups WHERE id = $1`, [scratchGroup])
  })

  // ── Picker query-partitioning: values-free re: MEMBER identities only ───────────────────────
  // FIX-ROUND RETITLE (gate finding P2-b/i): the PRIOR title here asserted an AUTHORIZATION
  // property ("org A cannot list org B's bindings") that the test body never tested — both calls
  // below use the SAME `reqTok` (a single non-platform-admin template author), so this is a
  // query-PARTITION test, not a cross-caller isolation test. Per §K1 the picker is authorized "the
  // same [way as] the shipped user/role lookups" — i.e. NOT re-engineered into a per-namespace
  // authorization boundary (Lock-1 names no such boundary, and this codebase has no org-identity
  // resolution to build one on). A caller holding the picker's shipped permission MAY list any
  // named namespace's bindings — id + name + memberCount — by choosing its `orgId`; that is the
  // ratified shape, not a leak. What stays genuinely values-free is MEMBER identity: the picker
  // never returns who is in a group, only how many.
  it('picker: results partition by the requested orgId — a single caller sees ONLY the named namespace\'s bindings per call; member identities never appear (values-free)', async () => {
    // Same caller (reqTok) issues BOTH calls — this discriminates the query param, not the caller.
    const defaultList = await listBoundGroups('default')
    expect(defaultList.groups.map((g) => g.id)).toContain(groupIdMain)
    expect(defaultList.groups.map((g) => g.id)).not.toContain(groupIdOrgB)

    const orgBList = await listBoundGroups(ORG_B)
    expect(orgBList.groups.map((g) => g.id)).toContain(groupIdOrgB)
    expect(orgBList.groups.map((g) => g.id)).not.toContain(groupIdMain)

    // Values-free re: MEMBER identity only: memberCount is a count, never the member id list —
    // this is the property the picker's shape actually guarantees (approval-directory.ts's
    // `DirectoryMemberGroupOption` carries id + name + memberCount, nothing else).
    const mainEntry = defaultList.groups.find((g) => g.id === groupIdMain)
    expect(mainEntry?.memberCount).toBe(2)
    expect(JSON.stringify(defaultList.groups)).not.toContain(M1)
    expect(JSON.stringify(defaultList.groups)).not.toContain(M2)
  })

  // ── G-5 — publish binding gate: dangling / bound ────────────────────────────────────────────
  it('G-5: publishing a template referencing an UNBOUND group fails closed 400 (values-free); binding it THEN publishes (membership-selected)', async () => {
    const created = await createTemplate(`ug-${TS}-g5-unbound`, ugGraph([groupIdUnbound]))
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const blocked = await publishTemplate(created.id!)
    expect(blocked.status, await blocked.clone().text()).toBe(400)
    const raw = await blocked.clone().text()
    const body = (await blocked.json()) as ErrorBody
    expect(errorCode(body)).toBe('APPROVAL_ASSIGNEE_GROUP_NOT_BOUND')
    // G-18 values-free: the node key / source index / group id (template-authored) are present;
    // no person id or group-membership row is ever in scope for this dangling-reference case.
    expect(body.error?.details?.nodeKey).toBe('approval_ug')
    expect(body.error?.details?.groupId).toBe(groupIdUnbound)
    expect(raw).toContain('approval_ug')

    // Positive control: bind it THEN publish — the SAME template now succeeds (membership-selected,
    // not a blanket rejection of every unbound-at-creation-time template).
    const nowBound = await bindGroup('default', groupIdUnbound)
    expect(nowBound.status, await nowBound.clone().text()).toBe(200)
    const nowPublished = await publishTemplate(created.id!)
    expect(nowPublished.status, await nowPublished.clone().text()).toBe(200)
  })

  // ── G-6 — multi-corp negative: org is a plain request param, no directory fixture needed ──────
  it('G-6: a group bound ONLY to org-b fails publish under the (omitted → DEFAULT) org and publishes under orgId=org-b — both directions asserted', async () => {
    const created = await createTemplate(`ug-${TS}-g6`, ugGraph([groupIdOrgB]))
    expect(created.status, JSON.stringify(created.body)).toBe(201)

    // Direction 1: orgId OMITTED entirely → normalizes to DEFAULT_ORG_ID → groupIdOrgB has no
    // binding there → 400. This is the "default path fails closed" proof — if a blank/absent
    // orgId ever collapsed to "match any org" this would wrongly pass.
    const blockedDefault = await publishTemplate(created.id!)
    expect(blockedDefault.status, await blockedDefault.clone().text()).toBe(400)
    expect(errorCode((await blockedDefault.json()) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_GROUP_NOT_BOUND')

    // Direction 2: explicit orgId=org-b → groupIdOrgB IS bound there → publishes.
    const publishedOrgB = await publishTemplate(created.id!, ORG_B)
    expect(publishedOrgB.status, await publishedOrgB.clone().text()).toBe(200)
  })

  // ── Happy path + G-7 freeze purity (the DISCRIMINATING test) ────────────────────────────────
  // Ordering is load-bearing: the membership mutation happens BEFORE the group node's ONLY
  // resolution (the gate approve that dispatches into `approval_ug`) — so if the resolver ever
  // read `platform_member_group_members` live at that moment (instead of the frozen
  // `requester_snapshot.groupMemberIds` captured at CREATE, before the mutation), the result
  // would reflect the MUTATED state. A check that re-reads already-written assignment rows
  // AFTER a post-resolution mutation would be a dead read (feedback_empty_read_is_not_absence) —
  // this test forces the mutation to land BEFORE resolution instead.
  it('happy path: bound group members are frozen at create, dispatched with resolvedFrom.groupId; G-7 freeze purity: a membership change made BEFORE the group node resolves still reflects the CREATE-TIME snapshot, not the live state at resolution time', async () => {
    const tid = await createPublished(`ug-${TS}-freeze`, ugGraph([groupIdMain]))
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
    expect(started.status, await started.clone().text()).toBe(201)
    const iid = ((await started.json()) as { id: string }).id

    // Frozen snapshot check: groupMemberIds landed in requester_snapshot at CREATE, before the
    // group node is even dispatched.
    const pool = poolManager.get()
    const snap = (await pool.query<{ requester_snapshot: { groupMemberIds?: Record<string, string[]> } }>(
      `SELECT requester_snapshot FROM approval_instances WHERE id = $1`,
      [iid],
    )).rows[0]
    expect(snap.requester_snapshot.groupMemberIds?.[groupIdMain]?.slice().sort()).toEqual([M1, M2].sort())

    // G-7 mutation: M2 leaves, M3 joins — AFTER create, but BEFORE the group node's first (and
    // only) resolution below.
    await pool.query(`DELETE FROM platform_member_group_members WHERE group_id = $1 AND user_id = $2`, [groupIdMain, M2])
    await pool.query(`INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)`, [groupIdMain, M3])
    try {
      // Advance past the gate: this is the FIRST time `approval_ug` resolves. If the resolver
      // read live, this would assign M1+M3 (the CURRENT membership); it must assign M1+M2 (the
      // snapshot frozen at create, BEFORE this mutation).
      const gateApprove = await req(base, `/api/approvals/${iid}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(gateApprove.status, await gateApprove.clone().text()).toBeLessThan(300)
      const happy = await activeAssignees(iid, 'approval_ug')
      expect(happy.map((a) => a.assignee_id).sort()).toEqual([M1, M2].sort())
      expect(happy.map((a) => a.assignee_id)).not.toContain(M3)
      for (const row of happy) {
        const resolvedFrom = (row.metadata as { resolvedFrom?: { kind?: string; groupId?: string } } | null)?.resolvedFrom
        expect(resolvedFrom?.kind).toBe('user_group')
        expect(resolvedFrom?.groupId).toBe(groupIdMain)
      }

      // Temporal positive control: a NEW create AFTER the SAME mutation DOES pick up M1+M3 — the
      // read re-executes per create rather than being cached/frozen anywhere globally.
      const startedNew = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: tid, formData: { reason: 'r' } } })
      expect(startedNew.status, await startedNew.clone().text()).toBe(201)
      const iidNew = ((await startedNew.json()) as { id: string }).id
      const gateApproveNew = await req(base, `/api/approvals/${iidNew}/actions`, apprTok, { method: 'POST', body: { action: 'approve' } })
      expect(gateApproveNew.status, await gateApproveNew.clone().text()).toBeLessThan(300)
      const freshMembers = await activeAssignees(iidNew, 'approval_ug')
      expect(freshMembers.map((a) => a.assignee_id).sort()).toEqual([M1, M3].sort())

      // Clean up both in-flight instances so they do not linger PENDING.
      await req(base, `/api/approvals/${iid}/actions`, await tok(base, M1), { method: 'POST', body: { action: 'approve' } })
      await req(base, `/api/approvals/${iidNew}/actions`, await tok(base, M1), { method: 'POST', body: { action: 'approve' } })
      await req(base, `/api/approvals/${iidNew}/actions`, await tok(base, M3), { method: 'POST', body: { action: 'approve' } })
    } finally {
      // Restore membership for any later test relying on M1+M2.
      await pool.query(`DELETE FROM platform_member_group_members WHERE group_id = $1 AND user_id = $2`, [groupIdMain, M3])
      await pool.query(`INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [groupIdMain, M2])
    }
  })

  // ── Empty group: never a silent NOBODY under auto-approve; fail-closed under 'error' ────────
  it('empty group + emptyAssigneePolicy fail-closed: default (error) rejects at create; auto-approve completes with an AUDITED system:auto-approval record, never a silent nobody', async () => {
    // Bind the (still zero-member) group FIRST — publish's org-binding gate is independent of
    // membership, so it must be bound before either template below can publish at all.
    const boundEmpty = await bindGroup('default', groupIdEmpty)
    expect(boundEmpty.status, await boundEmpty.clone().text()).toBe(200)

    // 'error' default: the group is bound but has ZERO members — create-time cascade on this
    // first-node graph fails closed, zero rows.
    const errTid = await createPublished(`ug-${TS}-empty-error`, ugFirstGraph([groupIdEmpty], 'error'))
    const failed = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: errTid, formData: { reason: 'r' } } })
    expect(failed.status, await failed.clone().text()).toBe(400)
    expect(errorCode((await failed.json()) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_EMPTY')
    expect(await instanceCount(errTid)).toBe(0)

    // 'auto-approve': the SAME empty group completes via an AUDITED system actor, not silently.
    const autoTid = await createPublished(`ug-${TS}-empty-auto`, ugFirstGraph([groupIdEmpty], 'auto-approve'))
    const started = await req(base, '/api/approvals', reqTok, { method: 'POST', body: { templateId: autoTid, formData: { reason: 'r' } } })
    expect(started.status, await started.clone().text()).toBe(201)
    const iid = ((await started.json()) as { id: string }).id
    const pool = poolManager.get()
    const records = await pool.query<{ actor_id: string; action: string }>(
      `SELECT actor_id, action FROM approval_records WHERE instance_id = $1 AND action = 'approve'`,
      [iid],
    )
    expect(records.rows.some((r) => r.actor_id === 'system:auto-approval')).toBe(true)
    // Never a silent nobody: the single-node graph (nothing after `approval_ug` but `end`)
    // reaches a REAL terminal status via the audited auto-approval — not stuck pending on a
    // node with zero resolvable assignees and no trace of why.
    const inst = await pool.query<{ status: string }>(`SELECT status FROM approval_instances WHERE id = $1`, [iid])
    expect(inst.rows[0].status).toBe('approved')
  })

  // ── G-17 — fingerprint lockstep: sorted-order collision, kind-selected ──────────────────────
  it('G-17: identical (sorted) group sets on parallel branches are publish-blocked; different sets are not', async () => {
    const blocked = await createTemplate(`ug-${TS}-g17-dup`, parallelGroupGraph(() => [groupIdMain]))
    expect(blocked.status).toBe(201)
    const blockedPublish = await publishTemplate(blocked.id!)
    expect(blockedPublish.status, await blockedPublish.clone().text()).toBe(400)
    expect(errorCode((await blockedPublish.json()) as ErrorBody)).toBe('APPROVAL_ASSIGNEE_PARALLEL_DYNAMIC_CONFLICT')

    // Positive control: DIFFERENT group sets publish fine. A second group (groupIdOrgB) is
    // bound to 'default' too, ONLY for this fixture, so a single orgId publishes both branches —
    // the assertion under test is fingerprint distinctness, not the org-binding gate again.
    const alsoBind = await bindGroup('default', groupIdOrgB)
    expect(alsoBind.status, await alsoBind.clone().text()).toBe(200)
    try {
      const ok = await createTemplate(`ug-${TS}-g17-ok`, parallelGroupGraph((branch) => (branch === 'a' ? [groupIdMain] : [groupIdOrgB])))
      expect(ok.status).toBe(201)
      const okPublish = await publishTemplate(ok.id!)
      expect(okPublish.status, await okPublish.clone().text()).toBe(200)
    } finally {
      await unbindGroup('default', groupIdOrgB)
    }
  })
})
