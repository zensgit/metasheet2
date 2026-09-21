import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * The legacy decision endpoints (`POST /api/approvals/:id/approve`, `POST /api/approvals/:id/reject`)
 * — seat / round / status admission, and SERVER-DERIVED node attribution — over real HTTP and a
 * real database.
 *
 * ### The two defects this pins
 *
 * Before this change, both endpoints authorized on `authenticate` + `approvals:act` + an optimistic
 * `version` + `status === 'pending'`, and then wrote `req.body.metadata` into
 * `approval_records.metadata` VERBATIM. Two consequences, each covered here:
 *
 *   1. ADMISSION — anyone holding `approvals:act` could drive a template-runtime instance to a
 *      terminal status without holding a seat at the node it is stopped on. `/actions` refuses that
 *      same caller 403 `APPROVAL_ASSIGNMENT_REQUIRED`; the legacy doors did not.
 *   2. ATTRIBUTION — `approval_records.metadata->>'nodeKey'` is read back as the node a decision
 *      was made AT (e.g. by `loadPriorNodeApproverDeciders`'s prior-node decider map). A key the
 *      CALLER supplied is not attribution: a reader cannot tell a row a seated approver wrote at
 *      their own node from a row written while naming somebody else's node.
 *
 * ### What each case is for
 *
 * Every refusal is asserted by ERROR CODE, never by the bare status — `rbacGuard` answers 403 too,
 * so a resource-guard refusal would otherwise pass for a seat-gate refusal and make the case
 * vacuous. Every refusal ALSO asserts a ZERO-ROW delta on `approval_records` plus an unchanged
 * `status`/`version`: "refused before the write" is the claim, and "the instance still looks
 * pending" can hold for other reasons (a rolled-back write leaves the same row counts only if the
 * rollback worked). Counting the rows is what discriminates.
 *
 *   * (1)/(2) NEGATIVE — a seatless `approvals:act` holder is refused on `/approve` and on
 *     `/reject`, zero rows written.
 *   * (3) POSITIVE CONTROL — the seated approver's honest call still succeeds, writes exactly one
 *     row, and that row carries the SERVER's `nodeKey` plus a `nodeEntryEpoch`. Without this, the
 *     gate could be passing case (1) by refusing everybody.
 *   * (4) DISCRIMINATOR — the SAME seated approver sends a metadata blob naming a DIFFERENT node
 *     (and a different round): the call still succeeds, the caller's own unrelated keys survive
 *     byte-for-byte, and the stored `nodeKey`/`nodeEntryEpoch` are the SERVER's values. This is the
 *     leg that proves the strip is load-bearing rather than incidental; removing the strip turns it
 *     red while leaving (1)-(3) green.
 *   * (5) ROLE SEAT — the SAME viewer with the SAME token flips from refused to accepted on the one
 *     fact of a `user_roles` ROW, with the claim-trusting fast path switched off so the database is
 *     the only place the role can come from. Two sibling instances of one template rather than one
 *     instance, because a legacy decision is terminal. The gate must cover role seats: one that
 *     only understood user seats would lock out every ROLE-seated approver the server accepts.
 *   * (6) ROUND — an approver whose node has already been settled (their seat deactivated, the
 *     cursor moved on) is refused, even though they are genuinely one of this instance's approvers
 *     and hold a real, honest seat ROW on it. This is the round clause: "held a seat here once" is
 *     not "holds the seat now".
 *   * (7) STATUS — a terminal instance keeps its pre-existing 400 `APPROVAL_STATUS_INVALID`; the
 *     new gate does not pre-empt it and does not change that refusal's identity.
 *   * (8) NOT SEAT-GATED — a legacy platform row with no published definition still accepts a
 *     seatless caller, exactly as it does today. `/actions` does not seat-gate those rows either
 *     (it dispatches them to `ApprovalBridgeService`, which has no assignment gate at all), so
 *     narrowing them here would make this door stricter than the other one. Its client-supplied
 *     `nodeKey` IS still dropped — a key no server-side seat can vouch for is never stored.
 *   * (9) `/actions` PARITY — the other door's verdict for the very same seatless caller and the
 *     very same instance is the same 403 with the same code, and the seated caller's `/actions`
 *     row carries the same server-derived `nodeKey`. The two doors now answer alike.
 *   * (10) `/reject` ATTRIBUTION — the (4) discriminator again, on the OTHER legacy endpoint.
 *     It exists because the attribution wiring is a PAIR of sibling call sites, one per endpoint,
 *     and cases (3)(4)(5)(8) all run through `/approve` only: without this case a mutation of the
 *     `/reject` site alone leaves the whole file green, and a both-sites mutation proves neither
 *     site individually. `/reject`'s seatless refusal is already covered by (2); this is its
 *     attribution half.
 *
 * Requires real PostgreSQL: the gate runs inside the route's own transaction, the role arm resolves
 * through `AuthService` → `user_roles`, and the attribution assertions read `approval_records`.
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

describeIfDatabase('legacy /approve + /reject: seat, round, status, and server-derived node attribution', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const createdTemplateIds = new Set<string>()
  const createdApprovalIds = new Set<string>()
  const seededUserIds = new Set<string>()

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
    return `lgseat-${TS}-${label}-${Math.floor(Math.random() * 1e6)}`
  }

  /**
   * A token whose CLAIMS deliberately do not name the role under test. Combined with
   * `withoutTokenClaimTrust`, this is what makes the ROLE case a genuine test of the DB row: the
   * only place the role id can come from is `user_roles`.
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
   * make the role case vacuous. (Borrowed verbatim from
   * `approval-can-decide-current-node.db.test.ts`, which gates the SAME predicate on the other door.)
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
   * Direct `user_permissions` grants, needed because a viewer resolved from the DATABASE (role case,
   * claim trust off) does not get `approvals:act` from the `*:*` claim on its token. Without this
   * the RESOURCE guard refuses first and the seat-gate 403 the case is about is never reached —
   * two different refusals behind one status code.
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
        name: 'legacy decision seat + node attribution',
        description: 'fix/approval-legacy-approve-seat-and-node-attribution',
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

  async function rawRow(instanceId: string): Promise<{
    status: string
    version: number
    current_node_key: string | null
  }> {
    const result = await pool().query(
      `SELECT status, version, current_node_key FROM approval_instances WHERE id = $1`,
      [instanceId],
    )
    return result.rows[0] as never
  }

  async function createApproval(
    requesterToken: string,
    templateId: string,
  ): Promise<{ id: string; version: number }> {
    const create = await jsonRequest(baseUrl, '/api/approvals', requesterToken, {
      method: 'POST',
      body: { templateId, formData: { reason: 'r' } },
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const instance = (await create.json()) as { id: string }
    createdApprovalIds.add(instance.id)
    const row = await rawRow(instance.id)
    return { id: instance.id, version: row.version }
  }

  async function recordCount(instanceId: string): Promise<number> {
    const result = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_records WHERE instance_id = $1`,
      [instanceId],
    )
    return Number(result.rows[0].n)
  }

  async function recordsFor(instanceId: string, action: string): Promise<Array<{
    actor_id: string
    metadata: Record<string, unknown> | null
  }>> {
    const result = await pool().query<{ actor_id: string; metadata: Record<string, unknown> | null }>(
      `SELECT actor_id, metadata FROM approval_records
        WHERE instance_id = $1 AND action = $2 ORDER BY occurred_at ASC, id ASC`,
      [instanceId, action],
    )
    return result.rows
  }

  /**
   * The SEAT-GATE refusal specifically, PLUS the zero-row / unchanged-instance evidence that makes
   * "refused BEFORE the write" a checked claim rather than a description.
   */
  async function expectRefusedBeforeWrite(
    response: Response,
    instanceId: string,
    before: { count: number; status: string; version: number },
    expected: { status: number; code: string },
  ): Promise<void> {
    const body = await response.clone().text()
    expect(response.status, body).toBe(expected.status)
    expect(JSON.parse(body)).toMatchObject({ error: { code: expected.code } })
    expect(await recordCount(instanceId)).toBe(before.count)
    const after = await rawRow(instanceId)
    expect(after.status).toBe(before.status)
    expect(after.version).toBe(before.version)
  }

  async function snapshot(instanceId: string): Promise<{ count: number; status: string; version: number }> {
    const row = await rawRow(instanceId)
    return { count: await recordCount(instanceId), status: row.status, version: row.version }
  }

  it('(1) NEGATIVE — a seatless `approvals:act` holder is refused 403 APPROVAL_ASSIGNMENT_REQUIRED on legacy /approve, with zero rows written', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    const outsider = freshId('outsider')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const outsiderToken = await authToken(outsider)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'neg-approve',
    )
    const created = await createApproval(requesterToken, templateId)
    const before = await snapshot(created.id)
    expect(before.status).toBe('pending')

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, outsiderToken, {
      method: 'POST',
      body: { version: created.version, metadata: { nodeKey: 'approval_a' } },
    })
    await expectRefusedBeforeWrite(response, created.id, before, {
      status: 403,
      code: 'APPROVAL_ASSIGNMENT_REQUIRED',
    })
  })

  it('(2) NEGATIVE — the same seatless caller is refused the same way on legacy /reject', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    const outsider = freshId('outsider')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const outsiderToken = await authToken(outsider)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'neg-reject',
    )
    const created = await createApproval(requesterToken, templateId)
    const before = await snapshot(created.id)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/reject`, outsiderToken, {
      method: 'POST',
      body: { version: created.version, reason: 'no', metadata: { nodeKey: 'approval_a' } },
    })
    await expectRefusedBeforeWrite(response, created.id, before, {
      status: 403,
      code: 'APPROVAL_ASSIGNMENT_REQUIRED',
    })
  })

  it('(3) POSITIVE CONTROL — the seated approver still succeeds, writes exactly one row carrying the server nodeKey + nodeEntryEpoch, and the instance ADVANCES to the next node instead of ending', async () => {
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
      'pos-honest',
    )
    const created = await createApproval(requesterToken, templateId)
    const before = await snapshot(created.id)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: created.version },
    })
    expect(response.status, await response.clone().text()).toBe(200)

    expect(await recordCount(created.id)).toBe(before.count + 1)
    const rows = await recordsFor(created.id, 'approve')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(approverA)
    // The cursor is on `approval_a`; the seat that admitted this actor is the one at `approval_a`.
    expect(rows[0].metadata?.nodeKey).toBe('approval_a')
    // The ROUND half. Its exact integer is an internal activation sequence, so the assertion is
    // that it is a real epoch (an integer), not a pinned literal.
    expect(Number.isInteger(rows[0].metadata?.nodeEntryEpoch)).toBe(true)
    // SETTLEMENT (H-5): this decision is node A of an A -> B graph, so it is NOT terminal. Before
    // the settlement-parity slice this route wrote `status = 'approved'` here with B never decided
    // and the cursor still on A — a bare status flip, not a decision. The instance must now be
    // `pending` at `approval_b`, which is exactly what the `/actions` door does with the same call.
    const settled = await rawRow(created.id)
    expect(settled.status).toBe('pending')
    expect(settled.current_node_key).toBe('approval_b')
  })

  it('(4) DISCRIMINATOR — a seated approver naming a DIFFERENT node/round has the server values stored instead, and none of their metadata is echoed into the audit row', async () => {
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
      'forged-key',
    )
    const created = await createApproval(requesterToken, templateId)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: {
        version: created.version,
        metadata: {
          // The forgery: a node this actor never decided, and a round that is not this one.
          nodeKey: 'approval_b',
          nodeEntryEpoch: 99999,
          // A caller's own unrelated payload. H-5: the shared settlement path builds the audit
          // row's metadata entirely server-side and never forwards the request blob, so these keys
          // are absent from the stored row — the strip is no longer key-scoped, it is total. That
          // is a NARROWING of this route's published behaviour, recorded in the design MD's
          // contract-change table.
          clientNote: 'keep-me',
          nested: { a: 1 },
        },
      },
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const rows = await recordsFor(created.id, 'approve')
    expect(rows).toHaveLength(1)
    const metadata = rows[0].metadata ?? {}
    expect(metadata.nodeKey).toBe('approval_a')
    expect(metadata.nodeEntryEpoch).not.toBe(99999)
    expect(Number.isInteger(metadata.nodeEntryEpoch)).toBe(true)
    expect(metadata.clientNote).toBeUndefined()
    expect(metadata.nested).toBeUndefined()
    // Positive control for the two assertions above: they must fail because the CALLER's keys are
    // gone, not because the row itself is empty. The server's own keys are present.
    expect(metadata.nextNodeKey).toBe('approval_b')
  })

  it('(5) ROLE SEAT — the SAME viewer with the SAME token flips from refused to accepted on the one fact of a `user_roles` ROW, so the gate is shown to cover role seats and to read them from the database', async () => {
    const admin = freshId('admin')
    // The viewer under test is also the REQUESTER, purely so the instance stays readable to them
    // throughout. Being the requester grants no seat; their standing at `approval_a` comes ONLY
    // from the ROLE seat. (Same fixture shape as `approval-can-decide-current-node.db.test.ts`'s
    // role arm, which pins the same predicate on the other door.)
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
    // TWO sibling instances of one template, because a legacy decision is TERMINAL: the refused
    // call and the accepted call cannot be made against the same row. Everything else — viewer,
    // token, template, node, seat shape — is identical, so the only fact that differs between them
    // is whether the `user_roles` row existed at the moment of the call.
    const refusedOn = await createApproval(roleViewerToken, templateId)
    const acceptedOn = await createApproval(roleViewerToken, templateId)

    // Fixture check: the seat at the node under test really is ROLE-typed, so this is not a
    // user-seat test in disguise.
    const seatRows = await pool().query(
      `SELECT assignment_type, assignee_id FROM approval_assignments WHERE instance_id = $1 AND node_key = 'approval_a'`,
      [refusedOn.id],
    )
    expect(seatRows.rows).toEqual([{ assignment_type: 'role', assignee_id: 'admin' }])

    await withoutTokenClaimTrust(async () => {
      // No `user_roles` row yet. The token's own claims are the only place the role could come
      // from, and they are not consulted on this path — so the role seat matches nothing.
      const noRow = await pool().query(`SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [roleViewer])
      expect(noRow.rows).toHaveLength(0)

      const before = await snapshot(refusedOn.id)
      const refused = await jsonRequest(baseUrl, `/api/approvals/${refusedOn.id}/approve`, roleViewerToken, {
        method: 'POST',
        body: { version: refusedOn.version },
      })
      await expectRefusedBeforeWrite(refused, refusedOn.id, before, {
        status: 403,
        code: 'APPROVAL_ASSIGNMENT_REQUIRED',
      })

      // ONE fact changes: the row.
      await pool().query(
        `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
        [roleViewer],
      )

      const accepted = await jsonRequest(baseUrl, `/api/approvals/${acceptedOn.id}/approve`, roleViewerToken, {
        method: 'POST',
        body: { version: acceptedOn.version },
      })
      expect(accepted.status, await accepted.clone().text()).toBe(200)
      const rows = await recordsFor(acceptedOn.id, 'approve')
      expect(rows).toHaveLength(1)
      expect(rows[0].actor_id).toBe(roleViewer)
      expect(rows[0].metadata?.nodeKey).toBe('approval_a')
    })
  })

  it('(6) ROUND — an approver whose own node has already been settled is refused, even though they hold a real seat row on this instance', async () => {
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
      'round',
    )
    const created = await createApproval(requesterToken, templateId)

    // A settles their node honestly through the seat-gated door; the cursor moves to B's node and
    // A's seat is deactivated.
    const advanced = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, approverAToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'ok' },
    })
    expect(advanced.status, await advanced.clone().text()).toBe(200)
    const moved = await rawRow(created.id)
    expect(moved.status).toBe('pending')
    expect(moved.current_node_key).toBe('approval_b')

    // A's seat ROW is still there on the instance (deactivated) — so a gate keyed on "is this actor
    // one of this instance's approvers" would let this through. PREMISE CHECK, not the assertion.
    const seatRows = await pool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM approval_assignments
        WHERE instance_id = $1 AND assignee_id = $2`,
      [created.id, approverA],
    )
    expect(Number(seatRows.rows[0].n)).toBeGreaterThan(0)

    const before = await snapshot(created.id)
    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, approverAToken, {
      method: 'POST',
      body: { version: before.version, metadata: { nodeKey: 'approval_a' } },
    })
    await expectRefusedBeforeWrite(response, created.id, before, {
      status: 403,
      code: 'APPROVAL_ASSIGNMENT_REQUIRED',
    })
  })

  it('(7) STATUS — a terminal instance keeps its pre-existing 400 APPROVAL_STATUS_INVALID; the seat gate does not pre-empt or rename that refusal', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    const outsider = freshId('outsider')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)
    const outsiderToken = await authToken(outsider)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'status',
    )
    const created = await createApproval(requesterToken, templateId)
    const revoked = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, requesterToken, {
      method: 'POST',
      body: { action: 'revoke' },
    })
    expect(revoked.status, await revoked.clone().text()).toBe(200)
    expect((await rawRow(created.id)).status).toBe('revoked')

    const before = await snapshot(created.id)
    // Asserted for BOTH a seatless caller and the (now seatless, because terminal) approver: the
    // status refusal wins in each case, so the new gate never converts a 400 into a 403.
    for (const token of [outsiderToken, approverAToken]) {
      const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, token, {
        method: 'POST',
        body: { version: before.version },
      })
      await expectRefusedBeforeWrite(response, created.id, before, {
        status: 400,
        code: 'APPROVAL_STATUS_INVALID',
      })
    }
  })

  it('(8) NOT SEAT-GATED — a legacy platform row with no published definition still accepts a seatless caller (status quo), and its client-supplied nodeKey is dropped', async () => {
    const outsider = freshId('outsider')
    const outsiderToken = await authToken(outsider)
    // A legacy platform row. There is no shipped route that creates one — that is what "legacy"
    // means here — so the fixture inserts the row directly, the same way
    // `packages/core-backend/scripts/test-approvals-contract.mjs` does for the very same endpoints.
    const legacyId = freshId('legacy-row')
    createdApprovalIds.add(legacyId)
    await pool().query(
      `INSERT INTO approval_instances (id, status, version) VALUES ($1, 'pending', 0)`,
      [legacyId],
    )

    const before = await snapshot(legacyId)
    const response = await jsonRequest(baseUrl, `/api/approvals/${legacyId}/approve`, outsiderToken, {
      method: 'POST',
      body: { version: before.version, metadata: { nodeKey: 'approval_whatever', keep: 'yes' } },
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect((await rawRow(legacyId)).status).toBe('approved')

    const rows = await recordsFor(legacyId, 'approve')
    expect(rows).toHaveLength(1)
    const metadata = rows[0].metadata ?? {}
    // No server-side seat can vouch for any node name on this row, so NO node name is stored —
    // not the caller's, and not a guess derived from `current_node_key` either.
    expect(metadata.nodeKey).toBeUndefined()
    expect(metadata.nodeEntryEpoch).toBeUndefined()
    expect(metadata.keep).toBe('yes')
  })

  it('(9) /actions PARITY — the other door answers the same seatless caller with the same code, and its seated row carries the same server-derived nodeKey', async () => {
    const admin = freshId('admin')
    const requester = freshId('req')
    const approverA = freshId('appr-a')
    const approverB = freshId('appr-b')
    const outsider = freshId('outsider')
    await grantWrite(requester)
    const adminToken = await authToken(admin, 'admin')
    const requesterToken = await authToken(requester)
    const approverAToken = await authToken(approverA)
    const outsiderToken = await authToken(outsider)

    const templateId = await publishTemplate(
      adminToken,
      twoStepGraph({ assigneeType: 'user', assigneeIds: [approverA] }, { assigneeType: 'user', assigneeIds: [approverB] }),
      'actions-parity',
    )
    const created = await createApproval(requesterToken, templateId)
    const before = await snapshot(created.id)

    const refusedByActions = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, outsiderToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'ok' },
    })
    await expectRefusedBeforeWrite(refusedByActions, created.id, before, {
      status: 403,
      code: 'APPROVAL_ASSIGNMENT_REQUIRED',
    })

    const refusedByLegacy = await jsonRequest(baseUrl, `/api/approvals/${created.id}/approve`, outsiderToken, {
      method: 'POST',
      body: { version: before.version },
    })
    await expectRefusedBeforeWrite(refusedByLegacy, created.id, before, {
      status: 403,
      code: 'APPROVAL_ASSIGNMENT_REQUIRED',
    })

    const accepted = await jsonRequest(baseUrl, `/api/approvals/${created.id}/actions`, approverAToken, {
      method: 'POST',
      body: { action: 'approve', comment: 'ok' },
    })
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const rows = await recordsFor(created.id, 'approve')
    expect(rows).toHaveLength(1)
    expect(rows[0].metadata?.nodeKey).toBe('approval_a')
  })

  it('(10) /reject ATTRIBUTION — the (4) discriminator on the OTHER endpoint: `/reject`\'s own attribution site is separately load-bearing', async () => {
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
      'forged-key-reject',
    )
    const created = await createApproval(requesterToken, templateId)

    const response = await jsonRequest(baseUrl, `/api/approvals/${created.id}/reject`, approverAToken, {
      method: 'POST',
      body: {
        version: created.version,
        reason: 'no',
        metadata: {
          nodeKey: 'approval_b',
          nodeEntryEpoch: 99999,
          clientNote: 'keep-me',
          nested: { a: 1 },
        },
      },
    })
    expect(response.status, await response.clone().text()).toBe(200)

    const rows = await recordsFor(created.id, 'reject')
    expect(rows).toHaveLength(1)
    const metadata = rows[0].metadata ?? {}
    expect(metadata.nodeKey).toBe('approval_a')
    // H-5: `/actions`'s reject arm stamps `nodeKey` and nothing else — a reject is terminal, so
    // there is no later round for a `nodeEntryEpoch` to disambiguate. Routing this door through
    // the same settlement path means its row now has the SAME shape: the forged round key is gone
    // and no server round key replaces it. Recorded in the design MD's contract-change table.
    expect(metadata.nodeEntryEpoch).toBeUndefined()
    expect(metadata.clientNote).toBeUndefined()
    expect(metadata.nested).toBeUndefined()
    expect((await rawRow(created.id)).status).toBe('rejected')
  })
})
