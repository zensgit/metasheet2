import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  ensureApprovalSchemaReady,
  ensureLocalUserRow,
  grantApprovalWriteForIntegrationActor,
} from '../helpers/approval-schema-bootstrap'
import {
  CANCEL_ROUND_TEMPLATE_ID,
  CANCEL_ROUND_TEMPLATE_NAME,
  CANCEL_ROUND_TEMPLATE_VISIBILITY_SCOPE,
} from '../../src/db/seeds/approval-cancel-round-published-definition'

/**
 * Seed-template visibility acceptance for the cancel-round published-definition seed migration
 * (`zzzz20260918100000_seed_approval_cancel_round_published_definition.ts`).
 *
 * WHAT THIS PINS, AND WHY IT EXISTS. `approval_templates.visibility_scope` defaults to
 * `'{"type":"all","ids":[]}'`, and `applyTemplateVisibilityFilter`'s first disjunct is
 * `COALESCE(visibility_scope->>'type','all') = 'all'` — which matches EVERY actor. A seed row left
 * on that default is a live template-center row for every user holding `approvals:read`: it is
 * listed by `GET /api/approval-templates`, fetchable at `GET /api/approval-templates/:id`, and
 * accepted by `templateVisibleAtCreateBoundary` as a template that user may launch an instance
 * from. The seed module's own prose says this definition is "不由用户在模板中心创建或编辑" — this
 * file is the executable form of that sentence, for the window BEFORE the product entry point is
 * wired. The migration now writes an audience-scoped `visibility_scope` explicitly; every
 * assertion below reads the SHARED constant (`CANCEL_ROUND_TEMPLATE_VISIBILITY_SCOPE`), so the
 * insert and the oracle cannot drift into two hand-copied literals.
 *
 * THE ORACLE SHAPE — "indistinguishable from a row that does not exist", not "looks empty".
 * An assertion that a normal user's response is empty is weak: it passes just as well when the
 * endpoint is broken, when the actor has no permission at all, or when the DB is missing. So each
 * negative below is paired against a SECOND request from the SAME user with an id/search token
 * that genuinely matches nothing, and the two responses are compared BYTE FOR BYTE (status line +
 * raw body text). That is the executable form of "this row contributes zero bytes to a normal
 * user's view of the template center" — the property the pre-seed tree trivially had.
 *
 * POSITIVE CONTROLS (without them every assertion here could pass vacuously):
 *   - a control template scoped `{type:'user', ids:[<this very user>]}` IS returned to the normal
 *     user in the same full listing that omits the seed ⇒ the filter is live, the actor is
 *     authorized, and the absence of the seed is a SCOPE decision, not a blanket hide;
 *   - a second control template scoped to a DIFFERENT user id is absent ⇒ the `user` disjunct is
 *     keyed on the actor's own id, so the seed's sentinel audience really is unreachable rather
 *     than merely untested;
 *   - the SAME endpoints, as a template manager, DO return the seed (existing semantics for
 *     admins are deliberately unchanged) ⇒ the 404/absence above is about audience, not deletion.
 *
 * SCOPE / WHAT THIS FILE DOES NOT CLAIM. It covers the two consumer functions of
 * `applyTemplateVisibilityFilter` for this row (`listTemplates`; `loadTemplateBundleWithClient`,
 * reached both by `GET /api/approval-templates/:id` and by `POST /api/approvals` via
 * `assembleCreationContext` -> `loadTemplateBundle` -> `loadTemplateBundleWithClient`,
 * `ApprovalProductService.ts:7571` -> `:12184` -> `:12192` -> `:12226` -> `:12235`), plus the
 * create path's 404 result. It does not discriminate `templateVisibleAtCreateBoundary`: that
 * second, in-transaction gate sits behind the same `loadTemplateBundle` 404 the call chain
 * above reaches first, so this file cannot tell the two apart. It says nothing about the cancel
 * round's own creation path proper, `createCancelRoundInstance`: keyed on
 * `CANCEL_ROUND_PUBLISHED_DEFINITION_ID` and deliberately
 * bypasses the template-visibility gate entirely (its own doc comment states this), so the scope
 * written by the migration neither enables nor disables it — which is exactly why this row can be
 * hidden today and made visible by the entry-point slice later without touching either path.
 *
 * RESIDUAL, stated rather than hidden: `users.id` is `TEXT`, so the sentinel audience id is
 * unmatched by convention, not by a type-level impossibility — the same residual the filter's own
 * `__approval_template_no_dept__` / `__approval_template_no_role__` sentinels already carry.
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

function pool() {
  return poolManager.get()
}

/** A NON-manager token: `approvals:read` / `approvals:act` / `approvals:write` only. Deliberately
 * NOT `roles=admin`, NOT `perms=*:*`, and NOT any of the three template-admin permissions — each
 * of those sets `isTemplateManager` in `resolveApprovalTemplateVisibilityActor` and bypasses
 * `applyTemplateVisibilityFilter` entirely, which would make every assertion in this file vacuous.
 *
 * `approvals:write` IS included on purpose. Without it `POST /api/approvals` stops at
 * `rbacGuard('approvals','write')` with a 403 and the create-boundary probe below would compare
 * two identical 403s that never reached the template lookup at all — a pair of fail-closed doors
 * covering for each other, i.e. an assertion with no discriminating power. The paired positive
 * control (this same user successfully creating an instance from a VISIBLE template) is what
 * proves the write gate is actually open on this token. */
async function normalUserToken(baseUrl: string, userId: string): Promise<string> {
  await ensureLocalUserRow(userId)
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=user&perms=${encodeURIComponent('approvals:read,approvals:act,approvals:write')}`,
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

/** A template-manager token (`roles=admin`, `perms=*:*`) — the "既有语义" side of every pairing. */
async function managerToken(baseUrl: string, userId: string): Promise<string> {
  await ensureLocalUserRow(userId)
  const response = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=admin&perms=${encodeURIComponent('*:*')}`,
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { token: string }).token
}

type RawResponse = { status: number; body: string }

async function rawGet(baseUrl: string, path: string, token: string): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return { status: response.status, body: await response.text() }
}

async function rawPost(baseUrl: string, path: string, token: string, body: unknown): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.text() }
}

/** Walks EVERY page of the template list for one actor — an absence claim taken from page 1 only
 * would be defeated by ordering (`ORDER BY updated_at DESC, id DESC`), not by the filter.
 *
 * DEPENDS ON SERIAL FILE EXECUTION for its PRESENCE half only. Offset pagination over a mutable
 * ordering can drop a row across a page boundary if another writer touches `approval_templates`
 * mid-sweep; `vitest.integration.config.ts` pins `fileParallelism: false` + `maxConcurrency: 1`, so
 * no sibling suite runs concurrently with this one today. If that ever changes, the
 * `toContain(visibleControlId)` control below must become a single `?search=`-scoped request; the
 * ABSENCE halves are unaffected (a dropped row cannot manufacture a false pass) and the seed's
 * absence is independently pinned byte-for-byte by the `?search=` and detail-404 tests. The 50-page
 * cap throws rather than returning a short answer, so a table larger than the cap is a loud failure,
 * not a silently weakened assertion. */
async function listAllTemplateIds(baseUrl: string, token: string): Promise<{ ids: string[]; bodies: string[] }> {
  const ids: string[] = []
  const bodies: string[] = []
  const pageSize = 200
  for (let page = 1; page <= 50; page += 1) {
    const response = await rawGet(baseUrl, `/api/approval-templates?page=${page}&pageSize=${pageSize}`, token)
    expect(response.status).toBe(200)
    bodies.push(response.body)
    const parsed = JSON.parse(response.body) as { data: Array<{ id: string }>; total: number }
    ids.push(...parsed.data.map((row) => row.id))
    if (parsed.data.length < pageSize) return { ids, bodies }
  }
  throw new Error('template listing did not terminate within 50 pages')
}

describeIfDatabase('cancel-round seed template is invisible to ordinary template-center users', () => {
  let server: MetaSheetServer
  let baseUrl = ''

  const normalUserId = `c1r8-user-${TS}`
  const otherUserId = `c1r8-other-${TS}`
  const managerUserId = `c1r8-mgr-${TS}`
  const hiddenControlId = randomUUID()
  const approverId = `c1r8-apr-${TS}`
  /** Created + published through the real authoring API, then scoped to `normalUserId`. Serves as
   * BOTH the listing positive control and the create-boundary positive control. */
  let visibleControlId = ''
  const createdTemplateIds: string[] = [hiddenControlId]
  const createdApprovalIds: string[] = []
  const grantedUserIds: string[] = []

  let normalToken = ''
  let mgrToken = ''

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    const port = address && typeof address === 'object' ? address.port : undefined
    expect(port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${port}`

    normalToken = await normalUserToken(baseUrl, normalUserId)
    mgrToken = await managerToken(baseUrl, managerUserId)
    await ensureLocalUserRow(otherUserId)
    await ensureLocalUserRow(approverId)
    grantedUserIds.push(normalUserId)
    await grantApprovalWriteForIntegrationActor(normalUserId)

    // Control 1 — a REAL published template (created and published through the authoring API, so
    // it has a version and an active published definition and is genuinely launchable), then
    // narrowed to exactly this actor with the SAME shipped `user` scope semantics the seed now
    // uses. The scope is set by direct UPDATE rather than through the authoring API so the
    // control's value is a literal in this file, not the output of the normalizer.
    const createControl = await fetch(`${baseUrl}/api/approval-templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgrToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: `c1r8_visible_control_${TS}`,
        name: `c1r8 visible control ${TS}`,
        description: 'approval-cancel-round-seed-template-visibility.db.test.ts',
        formSchema: { fields: [{ id: 'reason', type: 'text', label: '事由', required: true }] },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'approval_a',
              type: 'approval',
              config: { assigneeType: 'user', assigneeIds: [approverId], approvalMode: 'single' },
            },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'e-s-a', source: 'start', target: 'approval_a' },
            { key: 'e-a-end', source: 'approval_a', target: 'end' },
          ],
        },
      }),
    })
    expect(createControl.status, await createControl.clone().text()).toBe(201)
    visibleControlId = ((await createControl.json()) as { id: string }).id
    createdTemplateIds.push(visibleControlId)

    const publishControl = await fetch(`${baseUrl}/api/approval-templates/${visibleControlId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mgrToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy: { allowRevoke: true } }),
    })
    expect(publishControl.status, await publishControl.clone().text()).toBe(200)

    await pool().query(
      `UPDATE approval_templates SET visibility_scope = $2::jsonb WHERE id = $1`,
      [visibleControlId, JSON.stringify({ type: 'user', ids: [normalUserId] })],
    )

    // Control 2 — the same scope semantics aimed at somebody ELSE, so the `user` disjunct is shown
    // to be keyed on the actor's own id rather than merely "non-`all` means hidden".
    await pool().query(
      `INSERT INTO approval_templates (id, key, name, status, visibility_scope)
       VALUES ($1, $2, $3, 'published', $4::jsonb)`,
      [
        hiddenControlId,
        `c1r8_hidden_control_${TS}`,
        `c1r8 hidden control ${TS}`,
        JSON.stringify({ type: 'user', ids: [otherUserId] }),
      ],
    )
  })

  afterAll(async () => {
    try {
      if (createdApprovalIds.length > 0) {
        await pool().query('DELETE FROM approval_records WHERE instance_id = ANY($1::text[])', [createdApprovalIds])
        await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [createdApprovalIds])
        await pool().query('DELETE FROM approval_metrics WHERE instance_id = ANY($1::text[])', [createdApprovalIds])
        await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdApprovalIds])
      }
      if (createdTemplateIds.length > 0) {
        await pool().query('DELETE FROM approval_published_definitions WHERE template_id = ANY($1::uuid[])', [createdTemplateIds])
        await pool().query('UPDATE approval_templates SET active_version_id = NULL, latest_version_id = NULL WHERE id = ANY($1::uuid[])', [createdTemplateIds])
        await pool().query('DELETE FROM approval_template_versions WHERE template_id = ANY($1::uuid[])', [createdTemplateIds])
        await pool().query('DELETE FROM approval_templates WHERE id = ANY($1::uuid[])', [createdTemplateIds])
      }
      if (grantedUserIds.length > 0) {
        await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [grantedUserIds])
      }
      await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [
        [normalUserId, otherUserId, managerUserId, approverId],
      ])
    } finally {
      await server?.stop()
    }
  })

  it('the seed row exists and carries exactly the migration-pinned audience scope', async () => {
    const result = await pool().query<{ visibility_scope: unknown; status: string; name: string }>(
      `SELECT visibility_scope, status, name FROM approval_templates WHERE id = $1`,
      [CANCEL_ROUND_TEMPLATE_ID],
    )
    // Not a skip: a lane that runs this file against a database where the seed migration never ran
    // would otherwise "pass" every absence assertion below for the wrong reason.
    expect(result.rows.length).toBe(1)
    expect(result.rows[0]!.name).toBe(CANCEL_ROUND_TEMPLATE_NAME)
    expect(result.rows[0]!.status).toBe('published')
    expect(result.rows[0]!.visibility_scope).toEqual(CANCEL_ROUND_TEMPLATE_VISIBILITY_SCOPE)
  })

  it('a normal user\'s full template listing omits the seed while returning a control scoped to them', async () => {
    const { ids, bodies } = await listAllTemplateIds(baseUrl, normalToken)

    // Negative: the seed is not on ANY page, by id or by name.
    expect(ids).not.toContain(CANCEL_ROUND_TEMPLATE_ID)
    for (const body of bodies) {
      expect(body).not.toContain(CANCEL_ROUND_TEMPLATE_ID)
      expect(body).not.toContain(CANCEL_ROUND_TEMPLATE_NAME)
    }

    // Positive control 1 — the filter is live and this actor is authorized.
    expect(ids).toContain(visibleControlId)
    // Positive control 2 — the `user` disjunct is keyed on the actor's own id.
    expect(ids).not.toContain(hiddenControlId)
  })

  it('a template manager\'s listing DOES contain the seed (existing admin semantics unchanged)', async () => {
    const { ids } = await listAllTemplateIds(baseUrl, mgrToken)
    expect(ids).toContain(CANCEL_ROUND_TEMPLATE_ID)
    // A manager bypasses the filter entirely, so both controls are visible to them too — this is
    // what makes the normal user's split above attributable to scope rather than to the rows.
    expect(ids).toContain(visibleControlId)
    expect(ids).toContain(hiddenControlId)
  })

  it('searching the seed\'s own name as a normal user is byte-identical to searching a token that matches nothing', async () => {
    const neverMatches = `c1r8-no-such-template-${TS}`
    const seedSearch = await rawGet(
      baseUrl,
      `/api/approval-templates?search=${encodeURIComponent(CANCEL_ROUND_TEMPLATE_NAME)}`,
      normalToken,
    )
    const controlSearch = await rawGet(
      baseUrl,
      `/api/approval-templates?search=${encodeURIComponent(neverMatches)}`,
      normalToken,
    )
    expect(seedSearch.status).toBe(200)
    expect(seedSearch.status).toBe(controlSearch.status)
    expect(seedSearch.body).toBe(controlSearch.body)

    // Discriminating control on the comparison itself: the SAME search, as a manager, is NOT
    // byte-identical to the empty one — so the equality above is a real property of the filtered
    // view, not an artifact of `?search=` being ignored.
    const managerSeedSearch = await rawGet(
      baseUrl,
      `/api/approval-templates?search=${encodeURIComponent(CANCEL_ROUND_TEMPLATE_NAME)}`,
      mgrToken,
    )
    expect(managerSeedSearch.status).toBe(200)
    expect(managerSeedSearch.body).not.toBe(controlSearch.body)
    expect(managerSeedSearch.body).toContain(CANCEL_ROUND_TEMPLATE_ID)
  })

  it('GET /api/approval-templates/<seed id> as a normal user is byte-identical to a never-existing id', async () => {
    const neverExisting = randomUUID()
    const seedDetail = await rawGet(baseUrl, `/api/approval-templates/${CANCEL_ROUND_TEMPLATE_ID}`, normalToken)
    const absentDetail = await rawGet(baseUrl, `/api/approval-templates/${neverExisting}`, normalToken)

    expect(seedDetail.status).toBe(404)
    expect(seedDetail.status).toBe(absentDetail.status)
    expect(seedDetail.body).toBe(absentDetail.body)
    expect(seedDetail.body).toContain('APPROVAL_TEMPLATE_NOT_FOUND')

    // Positive control: the same id IS resolvable for a template manager, so the 404 above is an
    // audience decision and not a missing/deleted row.
    const managerDetail = await rawGet(baseUrl, `/api/approval-templates/${CANCEL_ROUND_TEMPLATE_ID}`, mgrToken)
    expect(managerDetail.status).toBe(200)
    expect(managerDetail.body).toContain(CANCEL_ROUND_TEMPLATE_ID)
  })

  it('a normal user cannot launch an instance from the seed: identical to launching from a never-existing template', async () => {
    // POSITIVE CONTROL FIRST — the same token, the same endpoint, a template that IS in this
    // user's audience: 201. Without this line the two rejections below could both be the
    // `rbacGuard('approvals','write')` 403 (or any other earlier door) and the byte-equality would
    // prove nothing about template visibility.
    const allowedCreate = await rawPost(baseUrl, '/api/approvals', normalToken, {
      templateId: visibleControlId,
      formData: { reason: 'c1r8 positive control' },
    })
    expect(allowedCreate.status, allowedCreate.body).toBe(201)
    createdApprovalIds.push((JSON.parse(allowedCreate.body) as { id: string }).id)

    const neverExisting = randomUUID()
    const seedCreate = await rawPost(baseUrl, '/api/approvals', normalToken, {
      templateId: CANCEL_ROUND_TEMPLATE_ID,
      formData: { reason: 'c1r8 seed probe' },
    })
    const absentCreate = await rawPost(baseUrl, '/api/approvals', normalToken, {
      templateId: neverExisting,
      formData: { reason: 'c1r8 seed probe' },
    })

    expect(seedCreate.status, seedCreate.body).toBe(404)
    expect(seedCreate.status).toBe(absentCreate.status)
    expect(seedCreate.body).toBe(absentCreate.body)
    expect(seedCreate.body).toContain('APPROVAL_TEMPLATE_NOT_FOUND')

    // No instance was created against the seed's published definition — the rejection lands before
    // any insert, so the seed is not merely hidden from the list while still being launchable.
    const created = await pool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM approval_instances
        WHERE requester_snapshot->>'id' = $1
          AND template_id = $2`,
      [normalUserId, CANCEL_ROUND_TEMPLATE_ID],
    )
    expect(created.rows[0]!.count).toBe('0')
  })
})
