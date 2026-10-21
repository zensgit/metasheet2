import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady, grantApprovalWriteForIntegrationActor } from '../helpers/approval-schema-bootstrap'

/**
 * GET /api/approvals/:id/history — guard alignment, real-DB acceptance.
 *
 * `/history` (routes/approval-history.ts) carries the SAME PERMISSION guard the sibling detail
 * route (`GET /api/approvals/:id`, routes/approvals.ts) has always applied: `authenticate`
 * followed by `rbacGuard('approvals', 'read')`. #5024 (`a0edbe39a4`) is what brought the two routes
 * to that permission parity, and its own body said "neither this route nor its sibling adds a
 * per-instance predicate on top of rbacGuard" — TRUE at the time, no longer true after Lock-10
 * (S1). `canReadApprovalInstance` now runs AFTER this guard on BOTH routes (OD-S1-12): a principal
 * WITHOUT `approvals:read` still gets 403 here (this guard is leg-1 and runs first — unchanged); a
 * principal WITH it who is not a participant now gets 404 `APPROVAL_NOT_FOUND` instead of 200. This
 * suite is the regression harness for BOTH legs: the guard's two 403s and its 401 are pinned
 * unchanged below (leg-1, #5024's contract); four cases that used to return 200 for a non-
 * participant are re-cast to 404 (leg-2, S1's narrowing) — see each test's own comment for why.
 *
 * NOTE, AMENDED: this suite still does NOT call `grantApprovalWriteForIntegrationActor` (the
 * `permissions` + `user_permissions` seeding helper other approval real-DB suites use) — that
 * remains true and deliberate; RBAC_TOKEN_TRUST's trusted-claims path is still what satisfies
 * `rbacGuard` here, never a DB permission row. What DID change: the "admin reader path" test below
 * now seeds a real `users` row, because Lock-10's admin arm (OD-S1-8) is DB-backed only — a JWT
 * `role: 'admin'` claim with no matching `users` row no longer bypasses anything. That is not a
 * grant-helper reintroduction; it is what makes THIS test actually exercise OD-S1-8 rather than
 * (as it did before this slice) coincidentally passing on the trusted-claims permission check
 * alone. The 403/403/401 tests remain seed-free by design.
 *
 * AMENDED AGAIN (test report 2026-10-08, T4cd): the DTO-shape tests at the end of the describe build
 * a real instance through the create/approve path, and THAT write path takes the helper's
 * `approvals:write` grant for its requester, like every other approval real-DB suite. The guard
 * tests above it are unchanged and still seed nothing.
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

/**
 * Mints a dev-token with EXPLICIT roles/perms claims. The suite runs under
 * `vitest.integration.config.ts`, whose `tests/setup.integration.ts` sets `RBAC_TOKEN_TRUST=true`
 * for the process — so these claims are trusted directly (AuthService.buildTrustedTokenUser) rather
 * than resolved from any `users`/`user_permissions` row, which is what lets this suite mint a
 * precisely-scoped non-privileged principal without seeding RBAC tables.
 */
async function devToken(baseUrl: string, userId: string, roles: string, perms: string): Promise<string> {
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

async function getHistory(baseUrl: string, id: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}/api/approvals/${encodeURIComponent(id)}/history`, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describeIfDatabase('GET /api/approvals/:id/history — guard alignment with GET /api/approvals/:id', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()
  const createdInstanceIds: string[] = []
  const createdUserIds: string[] = []
  // T4cd block (end of this describe): instances built through the real create/approve path also
  // leave assignment/metric rows, a template, and a write grant behind.
  const createdTemplateIds: string[] = []
  const grantedUserIds: string[] = []

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
      if (createdInstanceIds.length > 0) {
        await pool().query(`DELETE FROM approval_records WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])`, [createdInstanceIds])
        await pool().query(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [createdInstanceIds])
      }
      if (createdTemplateIds.length > 0) {
        await pool().query(`DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])`, [createdTemplateIds])
        await pool().query(`DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])`, [createdTemplateIds])
        await pool().query(`DELETE FROM approval_templates WHERE id = ANY($1::uuid[])`, [createdTemplateIds])
      }
      if (grantedUserIds.length > 0) {
        await pool().query(`DELETE FROM user_permissions WHERE user_id = ANY($1::text[])`, [grantedUserIds])
      }
      if (createdUserIds.length > 0) {
        await pool().query(`DELETE FROM users WHERE id = ANY($1::text[])`, [createdUserIds])
      }
    } finally {
      await server?.stop()
    }
  })

  /** Seeds a minimal instance directly (no template/workflow scaffolding needed for an authz probe)
   *  with one `approval_records` row carrying a distinctive `comment` marker, so a response body can
   *  be asserted to contain — or not contain — that exact marker. */
  async function seedInstanceWithComment(requesterId: string, marker: string): Promise<string> {
    const id = `hist-guard-${TS}-${Math.random().toString(36).slice(2, 8)}`
    await pool().query(
      `INSERT INTO approval_instances (id, status, requester_snapshot) VALUES ($1, 'approved', $2::jsonb)`,
      [id, JSON.stringify({ id: requesterId })],
    )
    await pool().query(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, comment, to_status, to_version)
       VALUES ($1, 'comment', $2, 'Requester', $3, 'approved', 1)`,
      [id, requesterId, marker],
    )
    createdInstanceIds.push(id)
    return id
  }

  it('DISCRIMINATING NEGATIVE: denies a principal without approvals:read — values-free (no record/comment text, no instance id) in the body', async () => {
    // This suite's negatives depend on the trusted-claims path (see devToken's docblock) reading
    // the `perms` claim rather than skipping straight to a DB-derived fallback. Pin that precondition
    // here so a future removal of RBAC_TOKEN_TRUST from tests/setup.integration.ts fails LOUDLY
    // (this assertion) instead of turning this negative into a false 200: with the trust path gone,
    // `AuthService.getUserById` finds no `users` row for a freshly-minted id and returns the
    // NODE_ENV!=='production' dev-fallback mock user (AuthService.ts, "降级：返回mock用户" branch),
    // which is `role: 'admin', permissions: ['*:*']` — i.e. exactly the opposite of this test's intent.
    expect(process.env.RBAC_TOKEN_TRUST).toBe('true')

    const outsiderId = `hist-guard-outsider-${TS}`
    const requesterId = `hist-guard-req-a-${TS}`
    const marker = `MARKER-A-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    // Non-admin role, and perms EXPLICITLY empty (not omitted — an omitted `perms` query param
    // would fall back to the dev-token route's own default of '*:*'; an omitted `roles` would
    // default to 'admin'. Both are passed and neither grants approvals:read.)
    const token = await devToken(baseUrl, outsiderId, 'viewer', '')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(403)
    const bodyText = await response.text()
    expect(bodyText).not.toContain(marker)
    expect(bodyText).not.toContain(instanceId)
    expect(bodyText).not.toContain(requesterId)
    expect(JSON.parse(bodyText)).toEqual({ error: 'Insufficient permissions' })
  })

  it('DISCRIMINATING NEGATIVE: a populated perms claim for another resource does not satisfy approvals:read', async () => {
    // Distinct from the empty-perms negative above: an EMPTY perms claim could theoretically 403
    // because the claim is never consulted at all, not because the guard evaluated it and found it
    // insufficient. A non-empty claim for an unrelated resource can only 403 if the guard actually
    // read `perms` and matched it against 'approvals:read' — so this is the arm that isolates
    // "the guard reads and checks the claim" from "the guard denies by default".
    const outsiderId = `hist-guard-outsider2-${TS}`
    const requesterId = `hist-guard-req-a2-${TS}`
    const marker = `MARKER-A2-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    const token = await devToken(baseUrl, outsiderId, 'viewer', 'multitable:read')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(403)
    const bodyText = await response.text()
    expect(bodyText).not.toContain(marker)
    expect(JSON.parse(bodyText)).toEqual({ error: 'Insufficient permissions' })
  })

  it('S1 NARROWING (was POSITIVE CONTROL, 200): granted approvals:read but NOT a participant — the guard alone used to be enough (isolating it as the cause of the two 403s above); now canReadApprovalInstance denies with 404, exactly OD-S1-12\'s narrowing', async () => {
    const grantedId = `hist-guard-granted-${TS}`
    const requesterId = `hist-guard-req-b-${TS}`
    const marker = `MARKER-B-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    const token = await devToken(baseUrl, grantedId, 'viewer', 'approvals:read')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(404)
    const bodyText = await response.text()
    expect(bodyText).not.toContain(marker)
    expect(JSON.parse(bodyText)).toEqual({ ok: false, error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval instance not found' } })
  })

  it('S1 NARROWING (was POSITIVE CONTROL, 200): the approvals:* wildcard grant still satisfies the PERMISSION guard (hasPermissionCode\'s resource-wildcard arm, unchanged) — but a non-participant is now denied by canReadApprovalInstance at 404, not admitted at 200', async () => {
    const grantedId = `hist-guard-wildcard-${TS}`
    const requesterId = `hist-guard-req-b2-${TS}`
    const marker = `MARKER-B2-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    const token = await devToken(baseUrl, grantedId, 'viewer', 'approvals:*')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(404)
    const bodyText = await response.text()
    expect(bodyText).not.toContain(marker)
    expect(JSON.parse(bodyText)).toEqual({ ok: false, error: { code: 'APPROVAL_NOT_FOUND', message: 'Approval instance not found' } })
  })

  it('admin reader path still works — but now proves OD-S1-8 (DB-backed admin), not the trusted JWT claim: seeding a REAL users row is the fix, not a reintroduction of the grant helper this suite deliberately omits elsewhere', async () => {
    const requesterId = `hist-guard-req-c-${TS}`
    const marker = `MARKER-C-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    const adminId = `hist-guard-admin-${TS}`
    // Pre-S1: the trusted `role: 'admin'` JWT claim was already sufficient at the OLD guard
    // (rbacGuard alone). Post-S1: canReadApprovalInstance's admin arm (OD-S1-8) is DB-backed
    // only — a JWT-only admin claim with no matching `users` row does not admit (see the
    // sibling G-S1-7 NARROWING(i) test in approval-instance-readability-s1-consumers.db.test.ts
    // for the isolated before/after). Seed the row so this test proves the admin arm for real.
    createdUserIds.push(adminId)
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, is_active, is_admin) VALUES ($1, $1||'@example.test', $1, 'x', TRUE, TRUE)`,
      [adminId],
    )
    const token = await devToken(baseUrl, adminId, 'admin', '*:*')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { items: Array<{ comment: string | null }> } }
    expect(body.data.items.some((item) => item.comment === marker)).toBe(true)
  })

  it('the instance requester, holding approvals:read, still reads their own history — arm 1 (requester) fires unconditionally, no org/DB-row seeding needed (the org pin ships OFF by default — see the predicate module\'s docblock)', async () => {
    const requesterId = `hist-guard-req-d-${TS}`
    const marker = `MARKER-D-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, marker)

    const token = await devToken(baseUrl, requesterId, 'viewer', 'approvals:read')
    const response = await getHistory(baseUrl, instanceId, token)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { items: Array<{ comment: string | null }> } }
    expect(body.data.items.some((item) => item.comment === marker)).toBe(true)
  })

  it('requires authentication (no token) — unchanged by the guard alignment', async () => {
    const requesterId = `hist-guard-req-e-${TS}`
    const instanceId = await seedInstanceWithComment(requesterId, `MARKER-E-${TS}`)

    const response = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent(instanceId)}/history`)
    expect(response.status).toBe(401)
  })

  // -----------------------------------------------------------------------------------------------
  // Test report 2026-10-08, T4cd — the DTO SHAPE of the platform branch, on an instance built
  // through the real service path (create -> approve -> the engine's cc), never hand-inserted rows:
  // the row shapes asserted here are exactly what `insertApprovalRecord` writes for those events.
  //
  // Before this fix the platform branch sent only the snake_case columns, while the approval-centre
  // detail page reads the camelCase DTO (`occurredAt` / `actorName` / ...), so every platform row
  // rendered no time and 「系统」 as its actor. The camelCase copies are ADDITIVE: every snake_case
  // column is asserted unchanged beside them.
  //
  // Unlike the guard-alignment tests above (trusted-claims tokens, no permission rows seeded), these
  // CREATE an instance, so the requester gets the same `approvals:write` grant every other approval
  // real-DB suite's write path uses; the read under test is the requester's own (arm 1), exactly
  // the tester's view. They share this describe's server: its afterAll ends the shared pool, so a
  // second server in this file cannot start after it.
  // -----------------------------------------------------------------------------------------------
  async function postJson(path: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  type WireRow = Record<string, unknown> & { action: string; metadata?: Record<string, unknown> }

  /** start -> approval (one static approver) -> cc (one static user) -> end. */
  async function createApprovedInstance(suffix: string): Promise<{ instanceId: string; requesterId: string; approverId: string; rows: WireRow[] }> {
    const requesterId = `hist-dto-req-${suffix}-${TS}`
    const approverId = `hist-dto-apr-${suffix}-${TS}`
    const ccUserId = `hist-dto-cc-${suffix}-${TS}`
    grantedUserIds.push(requesterId)
    await grantApprovalWriteForIntegrationActor(requesterId)
    const requesterToken = await devToken(baseUrl, requesterId, 'admin', '*:*')
    const approverToken = await devToken(baseUrl, approverId, 'admin', '*:*')

    const created = await postJson('/api/approval-templates', requesterToken, {
      key: `hist-dto-${suffix}-${TS}`,
      name: 'T4cd history DTO shape',
      formSchema: { fields: [{ id: 'reason', type: 'text', label: 'reason', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', config: {} },
          { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'single' } },
          { key: 'cc_1', type: 'cc', config: { targetType: 'user', targetIds: [ccUserId] } },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { key: 'e-s-a', source: 'start', target: 'approval_1' },
          { key: 'e-a-c', source: 'approval_1', target: 'cc_1' },
          { key: 'e-c-e', source: 'cc_1', target: 'end' },
        ],
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const templateId = ((await created.json()) as { id: string }).id
    createdTemplateIds.push(templateId)
    const published = await postJson(`/api/approval-templates/${templateId}/publish`, requesterToken, { policy: { allowRevoke: true } })
    expect(published.status, await published.clone().text()).toBe(200)

    const instance = await postJson('/api/approvals', requesterToken, { templateId, formData: { reason: 'r' } })
    expect(instance.status, await instance.clone().text()).toBe(201)
    const instanceId = ((await instance.json()) as { id: string }).id
    createdInstanceIds.push(instanceId)

    const approved = await postJson(`/api/approvals/${instanceId}/actions`, approverToken, { action: 'approve' })
    expect(approved.status, await approved.clone().text()).toBe(200)

    const history = await getHistory(baseUrl, instanceId, await devToken(baseUrl, requesterId, 'viewer', 'approvals:read'))
    expect(history.status, await history.clone().text()).toBe(200)
    const body = (await history.json()) as { data: { items: WireRow[] } }
    return { instanceId, requesterId, approverId, rows: body.data.items }
  }

  it('every row carries actorId / actorName / occurredAt (ISO) / fromStatus / toStatus equal to its unchanged snake_case column', async () => {
    const { instanceId, requesterId, approverId, rows } = await createApprovedInstance('shape')

    // 正控: the three audit rows the service wrote, with the actors the timeline must name.
    const stored = await pool().query<{ action: string; actor_id: string }>(
      'SELECT action, actor_id FROM approval_records WHERE instance_id = $1 ORDER BY id ASC',
      [instanceId],
    )
    expect(stored.rows.map((row) => row.action).sort()).toEqual(['approve', 'cc', 'created'])

    expect(rows).toHaveLength(3)
    for (const row of rows) {
      // snake_case columns stay exactly as before.
      for (const column of ['occurred_at', 'actor_id', 'actor_name', 'from_status', 'to_status']) {
        expect(Object.prototype.hasOwnProperty.call(row, column), `${row.action}: ${column}`).toBe(true)
      }
      expect(row.actorId).toBe(row.actor_id)
      expect(row.actorName).toBe(row.actor_name)
      expect(row.fromStatus).toBe(row.from_status)
      expect(row.toStatus).toBe(row.to_status)
      expect(typeof row.occurredAt).toBe('string')
      expect(row.occurredAt).toBe(new Date(String(row.occurred_at)).toISOString())
    }

    const byAction = new Map(rows.map((row) => [row.action, row]))
    expect(byAction.get('created')?.actorId).toBe(requesterId)
    expect(byAction.get('created')?.toStatus).toBe('pending')
    expect(byAction.get('approve')?.actorId).toBe(approverId)
    // The engine writes the cc row under its own actor; naming it 「系统」 is the client's job.
    expect(byAction.get('cc')?.actorId).toBe('system')
  })

  // T4cd (node half; owner approval pending under the 2026-09-20 whitelist ruling): `nodeKey` and
  // `autoApproved` are single-key projections. Each stored row also carries keys that must stay off
  // the wire (the created row's `requestNo`; the approve row's `approvalMode` / `aggregateComplete` /
  // `nextNodeKey`; the cc row's `targetType` / `targetId`) — proven present below, so their absence
  // on the wire is about the projection, not about rows that never had them.
  it('nodeKey crosses as the stored value and is the ONLY metadata key of these rows; autoApproved crosses only as boolean true', async () => {
    const { instanceId, requesterId, rows } = await createApprovedInstance('meta')

    const stored = await pool().query<{ action: string; metadata: Record<string, unknown> | null }>(
      'SELECT action, metadata FROM approval_records WHERE instance_id = $1',
      [instanceId],
    )
    const storedByAction = new Map(stored.rows.map((row) => [row.action, row.metadata ?? {}]))
    for (const [action, metadata] of storedByAction) {
      expect(typeof metadata.nodeKey, `${action}: stored nodeKey`).toBe('string')
      expect(Object.keys(metadata).filter((key) => key !== 'nodeKey').length, `${action}: other stored keys`).toBeGreaterThan(0)
    }
    expect(storedByAction.get('created')?.nodeKey).toBe('start')

    for (const row of rows) {
      expect(row.metadata, row.action).toEqual({ nodeKey: storedByAction.get(row.action)!.nodeKey })
      expect(Object.prototype.hasOwnProperty.call(row, 'nodeKey'), `${row.action}: top-level nodeKey`).toBe(false)
    }
    const text = JSON.stringify(rows)
    for (const offWire of ['requestNo', 'approvalMode', 'aggregateComplete', 'nextNodeKey', 'targetType', 'targetId', 'nodeEntryEpoch']) {
      expect(text.includes(offWire), `${offWire} reached the wire`).toBe(false)
    }

    // autoApproved: the boolean true crosses; a string 'true' (a value the engine never writes) does not.
    await pool().query(`UPDATE approval_records SET metadata = metadata || '{"autoApproved": true}'::jsonb WHERE instance_id = $1 AND action = 'approve'`, [instanceId])
    await pool().query(`UPDATE approval_records SET metadata = metadata || '{"autoApproved": "true"}'::jsonb WHERE instance_id = $1 AND action = 'cc'`, [instanceId])
    const again = await getHistory(baseUrl, instanceId, await devToken(baseUrl, requesterId, 'viewer', 'approvals:read'))
    expect(again.status).toBe(200)
    const againRows = ((await again.json()) as { data: { items: WireRow[] } }).data.items
    const againByAction = new Map(againRows.map((row) => [row.action, row]))
    expect(againByAction.get('approve')?.metadata).toEqual({ nodeKey: storedByAction.get('approve')!.nodeKey, autoApproved: true })
    expect(againByAction.get('cc')?.metadata).toEqual({ nodeKey: storedByAction.get('cc')!.nodeKey })
    expect(againByAction.get('created')?.metadata).toEqual({ nodeKey: 'start' })
  })
})
