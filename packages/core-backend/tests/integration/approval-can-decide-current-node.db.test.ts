import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * `canDecideCurrentNode` — the viewer-scoped decision affordance the detail DTO ships, over real
 * HTTP and a real database.
 *
 * WHAT THIS PROVES that the unit suite cannot. The field claims to be a MIRROR of the decision
 * endpoint's own authorization. A pure test can only show the predicate is self-consistent; it
 * cannot show the two doors agree. So every case below asserts the reported value AND then sends
 * the decision the field is talking about, pinning both together:
 *
 *   * a USER-seated approver at the current node reports `true` and their approve is accepted;
 *   * a ROLE seat is matched from a `user_roles` ROW and not from a token claim: the SAME viewer,
 *     the same token (which claims a different role) and the same instance flip from `false` +
 *     403 to `true` + 200 when that one row is added, with the claim-trusting fast path switched
 *     off so the database is the only place the role can come from;
 *   * a DELEGATED seat: the delegatee reports `true` and is accepted, and the seat row is shown to
 *     carry the delegatee rather than the delegator the template names;
 *   * the REQUESTER of a pending instance reports `false` and is refused. This is the case the
 *     field exists for: today's UI shows this reader 通过/驳回 because they hold `approvals:act`;
 *   * a viewer who HOLDS a seat row on this instance but not at the node it is stopped on reports
 *     `false`, and the viewer the cursor has reached reports `true` — same instance, one fact apart;
 *   * a CLOSED instance reports `false` for the very approver who just decided it;
 *   * an instance whose decisions go through the OTHER door (no published definition — no seat gate
 *     at all) reports `true` for a seatless viewer, and that viewer's approve really is accepted.
 *     Reporting `false` there would hide controls the server accepts;
 *   * the CREATE response is viewer-scoped too, not only the later read: a requester who is
 *     ROLE-seated at their own entry node reports `true` on the 201 itself, agreeing with a fresh
 *     detail read for the same viewer and with the door;
 *   * the ACTION response carries the field too, so acting never blanks it into the fallback —
 *     asserted on BOTH sides (a 评论 that leaves the actor seated reports `true`; the approve that
 *     spends the seat reports `false`), because a one-sided value assertion cannot tell a live
 *     field from a constant.
 *
 * Every refusal is asserted by ERROR CODE (`APPROVAL_ASSIGNMENT_REQUIRED`), never by the bare 403:
 * `rbacGuard` answers 403 as well, and a resource-guard refusal would otherwise pass for a
 * seat-gate refusal and make these cases vacuous.
 *
 * Requires real PostgreSQL: the role arm resolves through `AuthService` → `user_roles`, and the
 * door agreement is only meaningful against the real dispatch transaction.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  })
}

function buildFormSchema() {
  return { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] }
}

/** A(p) -> B(q) -> end. `p` may be a user id or, with `assigneeType: 'role'`, a role id. */
function twoStepGraph(
  a: { assigneeType: 'user' | 'role'; assigneeIds: string[] },
  b: { assigneeType: 'user' | 'role'; assigneeIds: string[] },
) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_a', type: 'approval', config: { ...a, approvalMode: 'single' } },
      { key: 'approval_b', type: 'approval', config: { ...b, approvalMode: 'single' } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'e-s-a', source: 'start', target: 'approval_a' },
      { key: 'e-a-b', source: 'approval_a', target: 'approval_b' },
      { key: 'e-b-end', source: 'approval_b', target: 'end' },
    ],
  }
}

describeIfDatabase('canDecideCurrentNode — the detail DTO mirrors the decision door, per viewer', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const seededUserIds = new Set<string>()
  const seededDelegationIds = new Set<string>()

  const pool = () => poolManager.get()

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    try {
      const approvalIds = [...createdApprovalIds]
      const templateIds = [...createdTemplateIds]
      if (approvalIds.length > 0) {
        await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [approvalIds])
        await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [approvalIds])
      }
      if (templateIds.length > 0) {
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [templateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [templateIds])
      }
      if (seededDelegationIds.size > 0) {
        await pool().query('DELETE FROM approval_delegations WHERE id = ANY($1::text[])', [[...seededDelegationIds]])
      }
      if (seededUserIds.size > 0) {
        const ids = [...seededUserIds]
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [ids])
        await pool().query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ids])
        await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [ids])
      }
    } finally {
      await server?.stop()
    }
  })

  function freshId(label: string): string {
    return `cdcn-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
  }

  /**
   * A token whose CLAIMS deliberately do not name the role under test. Combined with
   * `withoutTokenClaimTrust` below, this is what makes the role cases a genuine test of the DB row:
   * the only place `'admin'` can come from is `user_roles`.
   */
  async function authToken(userId: string, roles = 'member'): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent('*:*')}`,
    )
    expect(response.status).toBe(200)
    const payload = (await response.json()) as { token: string }
    return payload.token
  }

  /**
   * Runs `fn` with `AuthService`'s dev-only claim-trusting fast path OFF, so `verifyToken` resolves
   * the actor from the DATABASE (`users` + `user_roles` via `resolveRbacProfile`) exactly as a
   * production request does. `tests/setup.integration.ts` turns that path ON globally for every
   * integration file; leaving it on would let a token claim stand in for the `user_roles` row and
   * make the role cases below vacuous.
   */
  async function withoutTokenClaimTrust<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.RBAC_TOKEN_TRUST
    process.env.RBAC_TOKEN_TRUST = 'false'
    try {
      return await fn()
    } finally {
      if (previous === undefined) delete process.env.RBAC_TOKEN_TRUST
      else process.env.RBAC_TOKEN_TRUST = previous
    }
  }

  async function seedUser(userId: string, options: { role?: string; roleIds?: string[] } = {}): Promise<void> {
    seededUserIds.add(userId)
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
       VALUES ($1, $1 || '@example.test', $1, 'x', $2, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, is_active = TRUE, is_admin = FALSE`,
      [userId, options.role ?? 'user'],
    )
    for (const roleId of options.roleIds ?? []) {
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, roleId],
      )
    }
  }

  async function grantWrite(userId: string): Promise<void> {
    seededUserIds.add(userId)
    await grantApprovalWriteForIntegrationActor(userId)
  }

  /**
   * Direct `user_permissions` grants, needed because these viewers are resolved from the DATABASE
   * (the claim-trusting fast path is off for the role cases), so the `*:*` claim on their token is
   * not what `rbacGuard` reads. Without this a viewer would be refused 403 by the RESOURCE guard
   * and the seat-gate 403 the test is actually about would never be reached — two different
   * refusals behind the same status code.
   */
  async function grantPermissions(userId: string, codes: string[]): Promise<void> {
    seededUserIds.add(userId)
    const hasNameColumn = (
      await pool().query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'permissions' AND column_name = 'name'
         ) AS present`,
      )
    ).rows[0]?.present === true
    for (const code of codes) {
      if (hasNameColumn) {
        await pool().query(
          `INSERT INTO permissions (code, name, description) VALUES ($1, $2, $3)
           ON CONFLICT (code) DO NOTHING`,
          [code, code, code],
        )
      } else {
        await pool().query(
          `INSERT INTO permissions (code, description) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
          [code, code],
        )
      }
      await pool().query(
        `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, code],
      )
    }
  }

  async function publishTemplate(adminToken: string, approvalGraph: object, label: string): Promise<string> {
    const response = await jsonRequest(baseUrl, '/api/approval-templates', adminToken, {
      method: 'POST',
      body: {
        key: freshId(`tpl-${label}`),
        name: 'canDecideCurrentNode acceptance',
        description: 'viewer-scoped decision affordance',
        formSchema: buildFormSchema(),
        approvalGraph,
      },
    })
    expect(response.status, await response.clone().text()).toBe(201)
    const template = (await response.json()) as { id: string }
    createdTemplateIds.add(template.id)
    const published = await jsonRequest(baseUrl, `/api/approval-templates/${template.id}/publish`, adminToken, {
      method: 'POST',
      body: { policy: { allowRevoke: true } },
    })
    expect(published.status, await published.clone().text()).toBe(200)
    return template.id
  }

  async function createApproval(requesterToken: string, templateId: string): Promise<string> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const instance = (await create.json()) as { id: string }
    createdApprovalIds.add(instance.id)
    return instance.id
  }

  /** The reported value for one viewer. `undefined` would mean the server stopped shipping it. */
  async function reportedValue(token: string, instanceId: string): Promise<boolean | undefined> {
    const detail = await jsonRequest(baseUrl, `/api/approvals/${instanceId}`, token)
    expect(detail.status, await detail.clone().text()).toBe(200)
    const dto = (await detail.json()) as { canDecideCurrentNode?: boolean }
    return dto.canDecideCurrentNode
  }

  async function approve(token: string, instanceId: string): Promise<Response> {
    return jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, token, {
      method: 'POST',
      body: { action: 'approve', comment: 'ok' },
    })
  }

  /**
   * The SEAT-GATE refusal specifically. `rbacGuard` also answers 403, so asserting the status alone
   * cannot tell "the door refused this viewer's seat" from "this viewer never reached the door".
   */
  async function expectSeatGateRefusal(response: Response): Promise<void> {
    expect(response.status, await response.clone().text()).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'APPROVAL_ASSIGNMENT_REQUIRED' } })
  }

  it('a USER-seated approver at the current node reports true, and their approve is accepted', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'user-seat',
    )
    const instanceId = await createApproval(requesterToken, templateId)

    expect(await reportedValue(approverAToken, instanceId)).toBe(true)
    const accepted = await approve(approverAToken, instanceId)
    expect(accepted.status, await accepted.clone().text()).toBe(200)
  })

  it('the REQUESTER of a pending instance reports false, and their approve is refused 403', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'requester',
    )
    const instanceId = await createApproval(requesterToken, templateId)

    // The requester can READ their own instance (they are a participant), which is exactly why the
    // old UI showed them the decision bar — `canAct` is a global grant, not a seat check.
    expect(await reportedValue(requesterToken, instanceId)).toBe(false)
    await expectSeatGateRefusal(await approve(requesterToken, instanceId))
  })

  it('a seat that is not at the node the instance is stopped on reports false; the same viewer reports true once the cursor reaches them', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)
    const approverBToken = await authToken(approverB)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'later-node',
    )
    const instanceId = await createApproval(requesterToken, templateId)

    // The downstream approver holds no assignment ROW yet — the executor writes one when the node
    // activates — so the instance is not even readable to them. That refusal is the read-admission
    // predicate's, not this field's; asserted here so the sequencing below is not mistaken for it.
    const beforeActivation = await jsonRequest(baseUrl, `/api/approvals/${instanceId}`, approverBToken)
    expect(beforeActivation.status).toBe(404)
    await expectSeatGateRefusal(await approve(approverBToken, instanceId))

    const advanced = await approve(approverAToken, instanceId)
    expect(advanced.status, await advanced.clone().text()).toBe(200)

    // Same viewer, same instance — only the node the instance is stopped on has changed.
    expect(await reportedValue(approverBToken, instanceId)).toBe(true)

    // And the approver who just acted still HOLDS a seat row on this instance (so they can still
    // read it) — it is simply no longer the node the instance is stopped on. This is the
    // "seat, but not here" case, isolated from the requester case above.
    const staleSeat = await pool().query(
      `SELECT node_key, is_active FROM approval_assignments WHERE instance_id = $1 AND assignee_id = $2`,
      [instanceId, approverA],
    )
    expect(staleSeat.rows.length).toBeGreaterThan(0)
    expect(await reportedValue(approverAToken, instanceId)).toBe(false)
    await expectSeatGateRefusal(await approve(approverAToken, instanceId))
  })

  it('a CLOSED instance reports false for the approver who decided it', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    const templateId = await publishTemplate(
      adminToken,
      {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'approval_a', type: 'approval', config: { assigneeType: 'user', assigneeIds: [approverA], approvalMode: 'single' } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_a' },
          { key: 'e-a-end', source: 'approval_a', target: 'end' },
        ],
      },
      'closed',
    )
    const instanceId = await createApproval(requesterToken, templateId)

    expect(await reportedValue(approverAToken, instanceId)).toBe(true)
    const accepted = await approve(approverAToken, instanceId)
    expect(accepted.status, await accepted.clone().text()).toBe(200)

    // The seat rows are deactivated when the instance closes, so the door's seat gate — which runs
    // ahead of its status check — is what refuses the second attempt. Asserted by CODE, not by the
    // bare 403, so this cannot pass because some earlier guard refused instead.
    expect(await reportedValue(approverAToken, instanceId)).toBe(false)
    await expectSeatGateRefusal(await approve(approverAToken, instanceId))
  })

  it('a ROLE seat is matched from a user_roles ROW, not a token claim: the same viewer flips false -> true when the row is added', async () => {
    const admin = freshId('admin')
    // The viewer under test is also the REQUESTER, purely so the instance is readable to them
    // throughout (a downstream approver holds no assignment row until their node activates, and
    // would simply 404). Being the requester grants no seat: it is the case this whole slice is
    // about. Their standing at the node under test comes only from the ROLE seat.
    const roleViewer = freshId('role-viewer')
    const approverB = freshId('appr-b')
    await grantWrite(roleViewer)
    await seedUser(roleViewer, { role: 'user' })
    await grantPermissions(roleViewer, ['approvals:read', 'approvals:act'])

    const adminToken = await authToken(admin, 'admin')
    // The token claims 'member'. Nothing in it ever says 'admin'.
    const roleViewerToken = await authToken(roleViewer, 'member')

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'role', assigneeIds: ['admin'] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'role-seat',
    )
    const instanceId = await createApproval(roleViewerToken, templateId)

    // Fixture check: the seat at the node under test really is ROLE-typed, so this is not a
    // user-seat test in disguise.
    const seatRows = await pool().query(
      `SELECT assignment_type, assignee_id FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_a'`,
      [instanceId],
    )
    expect(seatRows.rows).toEqual([{ assignment_type: 'role', assignee_id: 'admin' }])

    await withoutTokenClaimTrust(async () => {
      // No `user_roles` row yet. The token's own claims are the only place a role could come from,
      // and they are not consulted on this path — so the role seat matches nothing.
      const before = await pool().query(`SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [roleViewer])
      expect(before.rows).toHaveLength(0)
      expect(await reportedValue(roleViewerToken, instanceId)).toBe(false)
      await expectSeatGateRefusal(await approve(roleViewerToken, instanceId))

      // ONE fact changes: the row. Same viewer, same token, same instance, same node.
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
        [roleViewer],
      )

      expect(await reportedValue(roleViewerToken, instanceId)).toBe(true)
      const accepted = await approve(roleViewerToken, instanceId)
      expect(accepted.status, await accepted.clone().text()).toBe(200)
    })
  })

  it('the CREATE response is viewer-scoped too: a requester ROLE-seated at their own entry node reports true on the 201', async () => {
    // The 201 body is a viewer-scoped read like every other. It was computed from the actor's id
    // ALONE, without their roles, so this exact requester — role-seated at the node their own
    // instance stops on — was told `false` on create while a fresh GET said `true` and the door
    // accepted them. THREE legs, deliberately: the create response, a fresh detail read for the
    // SAME viewer, and what the door actually does. That is what tells "this call site is broken"
    // apart from "the field is broken" — dropping the roles from the create call flips only the
    // first of the three, while a constant-`true` field would flip none of them.
    //
    // Stated so it is not over-read: all three legs assert `true`, so this case is ONE-SIDED and is
    // green under a constant-`true` field (measured). Its discrimination comes entirely from that
    // three-leg asymmetry under the roles-drop mutation, not from two-sidedness — unlike the action
    // case below, where two-sidedness is the whole point.
    const admin = freshId('admin')
    const roleViewer = freshId('create-role-viewer')
    const approverB = freshId('appr-b')
    await grantWrite(roleViewer)
    // The `user_roles` row is in place BEFORE the create (unlike the flip case above, which adds it
    // mid-test), so `resolveRbacProfile` already promotes this viewer's role on the create request
    // itself. Their token still claims `member` and never claims `admin`.
    //
    // That promotion is also why the third leg below (approve -> 200) needs checking rather than
    // assuming: an RBAC admin could in principle be waved past the seat gate, which would make the
    // door leg vacuous. Measured, by re-pointing this same fixture's seat at a role the viewer does
    // NOT hold (`'reviewer'`) while leaving them an RBAC admin: create `false`, detail `false`,
    // approve refused `APPROVAL_ASSIGNMENT_REQUIRED`. So admin-ness does not open this door, and the
    // 200 below is earned by the ROLE SEAT.
    await seedUser(roleViewer, { role: 'user', roleIds: ['admin'] })
    await grantPermissions(roleViewer, ['approvals:read', 'approvals:act'])

    const adminToken = await authToken(admin, 'admin')
    const roleViewerToken = await authToken(roleViewer, 'member')

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'role', assigneeIds: ['admin'] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'create-role-seat',
    )

    await withoutTokenClaimTrust(async () => {
      const create = await jsonRequest(baseUrl, '/api/approvals', roleViewerToken, {
        method: 'POST',
        body: { templateId, formData: { reason: 'r' } },
      })
      expect(create.status, await create.clone().text()).toBe(201)
      const created = (await create.json()) as { id: string; canDecideCurrentNode?: boolean }
      createdApprovalIds.add(created.id)

      // Fixture check: the node the instance stops on really carries a ROLE seat, so the roles are
      // the only thing that can decide this — a user-seat fixture would report `true` either way.
      const seatRows = await pool().query(
        `SELECT assignment_type, assignee_id FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_a'`,
        [created.id],
      )
      expect(seatRows.rows).toEqual([{ assignment_type: 'role', assignee_id: 'admin' }])

      expect(typeof created.canDecideCurrentNode).toBe('boolean')
      expect(created.canDecideCurrentNode).toBe(true)
      expect(await reportedValue(roleViewerToken, created.id)).toBe(true)
      const accepted = await approve(roleViewerToken, created.id)
      expect(accepted.status, await accepted.clone().text()).toBe(200)
    })
  })

  it('a DELEGATED seat: the delegatee reports true and is accepted, the delegator named by the template is not seated at all', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const delegator = freshId('delegator')
    const delegatee = freshId('delegatee')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const delegateeToken = await authToken(delegatee)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [delegator] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'delegation',
    )

    const delegationId = randomUUID()
    seededDelegationIds.add(delegationId)
    await pool().query(
      `INSERT INTO approval_delegations
         (id, delegator_user_id, delegatee_user_id, scope, scope_template_id, start_at, end_at, active)
       VALUES ($1, $2, $3, 'all', NULL, now() - interval '1 hour', now() + interval '1 day', TRUE)`,
      [delegationId, delegator, delegatee],
    )

    const instanceId = await createApproval(requesterToken, templateId)

    // Delegation is applied at CREATE time, so the seat row itself names the delegatee — this is
    // why the mirror needs no delegation-specific branch, and the assertion that pins it.
    const seatRows = await pool().query(
      `SELECT assignee_id FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_a'`,
      [instanceId],
    )
    expect(seatRows.rows).toEqual([{ assignee_id: delegatee }])

    expect(await reportedValue(delegateeToken, instanceId)).toBe(true)
    const accepted = await approve(delegateeToken, instanceId)
    expect(accepted.status, await accepted.clone().text()).toBe(200)
  })

  it('an instance whose door has NO seat gate reports true for a seatless viewer, and that viewer really is accepted', async () => {
    // A platform row with no published definition is dispatched by ApprovalBridgeService, which
    // checks `approvals:act` and a pending status and nothing else. Reporting `false` here would
    // hide controls the server accepts — the divergence pointed the other way.
    const requester = freshId('legacy-req')
    await grantWrite(requester)
    const requesterToken = await authToken(requester)
    const instanceId = `legacy-${TS}-${Math.floor(Math.random() * 1e6)}`
    createdApprovalIds.add(instanceId)
    await pool().query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, created_at, updated_at)
       VALUES ($1, 'pending', 0, 'platform', $2, $3, 'legacy door', $4::jsonb,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 'ok', now(), now())`,
      [instanceId, `cdcn-wf-${TS}`, `cdcn:${instanceId}`, JSON.stringify({ id: requester, name: requester })],
    )

    const seats = await pool().query('SELECT 1 FROM approval_assignments WHERE instance_id = $1', [instanceId])
    expect(seats.rows).toHaveLength(0)

    expect(await reportedValue(requesterToken, instanceId)).toBe(true)
    const accepted = await approve(requesterToken, instanceId)
    expect(accepted.status, await accepted.clone().text()).toBe(200)

    // Once closed, the same viewer reports false — the status arm applies on both doors.
    expect(await reportedValue(requesterToken, instanceId)).toBe(false)
  })

  it('the ACTION response carries the field too, with the value the door would give: true while the actor still holds the seat, false once they have spent it', async () => {
    // The web store publishes an action response into the same slot the detail read fills. If only
    // the detail read carried the field, an approve would blank it and the client would fall back
    // to showing the bar again.
    //
    // The VALUE assertions are two-sided on purpose, and that is what carries the discrimination: a
    // lone `false` after the approve stayed green under a constant-`false` field — measured, and
    // exactly the failure this case exists to catch — so the same actor is also read at a moment the
    // door would accept them. The `typeof === 'boolean'` line states the wire contract explicitly
    // (a boolean, never a truthy/falsy stand-in); it is SUBSUMED by the value assertions, which
    // already fail on an absent or non-boolean field, and is not claimed to red anywhere they do
    // not.
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'action-response',
    )
    const instanceId = await createApproval(requesterToken, templateId)

    // 评论 goes through the SAME seat gate but leaves the instance at the same node with the actor
    // still seated (no status change, no version change, no assignment deactivation) — so the
    // response the client publishes into the detail slot must still say `true`.
    const commented = await jsonRequest(baseUrl, `/api/approvals/${instanceId}/actions`, approverAToken, {
      method: 'POST',
      body: { action: 'comment', comment: 'looking at it' },
    })
    expect(commented.status, await commented.clone().text()).toBe(200)
    const commentDto = (await commented.json()) as { canDecideCurrentNode?: boolean }
    expect(typeof commentDto.canDecideCurrentNode).toBe('boolean')
    expect(commentDto.canDecideCurrentNode).toBe(true)

    // …and `false` once the approve has moved the cursor off their node.
    const accepted = await approve(approverAToken, instanceId)
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const dto = (await accepted.json()) as { canDecideCurrentNode?: boolean }
    expect(typeof dto.canDecideCurrentNode).toBe('boolean')
    expect(dto.canDecideCurrentNode).toBe(false)
  })
})
