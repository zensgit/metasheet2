import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'

/**
 * P4(2) phase 0 — zero-behavior-change parity for `resolveApprovalAdminCapability` /
 * `approvalAdminCapabilityGuard` (`services/approval-admin-capability.ts`), which replaced three
 * differently-typed literal guard expressions (`approvalTemplateAdminGuard` = `rbacGuardAny([...])`,
 * two bare `rbacGuard('approvals:admin')`) at every route census-tiered-admin-20260915.md (Q1)
 * lists, per p4-2-tiered-admin-design-draft-20260915.md §3.2/§3.4/§4 (criterion B).
 *
 * METHOD (feedback_prove_a_fix_by_running_the_old_implementation.md /
 * feedback_absolute_claim_sweep_must_be_mechanical.md lineage): the four EXPECTED bodies below are
 * not reconstructed from reading the guard code — they are the LITERAL bytes a real HTTP run
 * against the UNMODIFIED pre-resolver tree returned, captured by temporarily `git stash`-ing this
 * slice's own diff back to the base commit (062614f4407b3d9bffc82dae266071b8a6e5e5bd) and hitting
 * these same four routes with these same four seeded viewers over a one-shot Postgres, before any
 * resolver code existed. That capture script was throwaway (never committed); these constants are
 * its transcript. This is what makes the assertions below a PARITY proof rather than "the new
 * code agrees with itself": a change to `approvalAdminCapabilityGuard` cannot also rewrite these
 * literals to match.
 *
 * ONE GUARD REFERENCE PER CAPABILITY, ONE PROOF COVERS EVERY ROUTE ON IT. `approvalTemplateAdminGuard`
 * is a single `RequestHandler` value that 16 template routes AND the four admin
 * `/api/approval-delegations` routes (exception 1) all reference literally — proving parity for ONE
 * route wired to it proves it for all 20, because Express dispatches the SAME function object at
 * every one. `GET /api/approval-delegations` is the representative here (its body on an empty
 * fixture, `{ data: [] }`, is independent of which migrations have run — unlike, say, the
 * templates-directory role picker, whose body enumerates every seeded RBAC role and would drift
 * as unrelated future migrations add roles). `approvalProcessAdminGuard` backs
 * `/api/approvals/:id/jump` and `/api/approvals/admin/reassign`; reassign is the representative
 * (an empty body 400s on validation, deterministically, before touching any approval row).
 * `approvalDataAdminGuard` backs all four `approval-metrics.ts` admin routes; `/summary` is the
 * representative (its zero-aggregate body is stable on a fixture with no seeded approval
 * instances). Exception 2 (`member-groups/:action(bind|unbind)`, `ensurePlatformAdmin`) is
 * UNCHANGED code — see the resolver's own docblock for why — and is included below as a NEGATIVE
 * CONTROL: proof that this slice did not touch it either.
 *
 * FOUR VIEWERS, DISCRIMINATED BY DB ROWS NOT TOKEN CLAIMS (feedback_mutation_testing_limits.md /
 * advisor guidance on this task: a fixture where every token claims `role: admin` would pass all
 * four trivially and prove nothing). Every dev-token below is minted with `roles=none&perms=none` —
 * `RBAC_TOKEN_TRUST` is off by default, so `AuthService.verifyToken` discards those claims anyway
 * and re-hydrates `req.user.role`/`.permissions` from `user_roles`/`user_permissions` on every
 * request (`resolveRbacProfile`), which is exactly the arm this suite means to exercise:
 *   - platformAdmin — `user_roles` row `role_id = 'admin'` (rbac/service.ts `isAdmin`, arm 4).
 *   - processOnly   — `user_permissions` row `approvals:admin` (arm 5, `process`/`data` capability).
 *   - templateOnly  — `user_permissions` row `approval-templates:manage` (arm 5, `template` capability).
 *   - plainUser     — neither.
 * The CROSS-DENIALS this produces (`processOnly` 403 on the template route, `templateOnly` 403 on
 * the process/data routes) are the positive control that the fixture actually discriminates
 * capabilities rather than every seeded row passing every guard.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

type Viewer = 'platformAdmin' | 'processOnly' | 'templateOnly' | 'plainUser' | 'anonymous'

type CapturedResponse = { status: number; body: unknown }

/**
 * The frozen BEFORE transcript — see the docblock above for provenance. Keys match the `hit(...)`
 * calls below one-for-one; a route or viewer added to the fixture without a matching entry here
 * fails loudly (`expected[route][viewer]` would be `undefined`) rather than silently comparing
 * `undefined` to `undefined`.
 */
const EXPECTED: Record<string, Record<Viewer, CapturedResponse>> = {
  'template.delegationsList': {
    anonymous: { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } } },
    platformAdmin: { status: 200, body: { data: [] } },
    processOnly: { status: 403, body: { error: 'Insufficient permissions' } },
    templateOnly: { status: 403, body: { error: 'Insufficient permissions' } },
    plainUser: { status: 403, body: { error: 'Insufficient permissions' } },
  },
  'process.reassign': {
    anonymous: { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } } },
    platformAdmin: { status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR', message: 'fromUserId is required' } } },
    processOnly: { status: 400, body: { ok: false, error: { code: 'VALIDATION_ERROR', message: 'fromUserId is required' } } },
    templateOnly: { status: 403, body: { error: 'Insufficient permissions' } },
    plainUser: { status: 403, body: { error: 'Insufficient permissions' } },
  },
  'data.metricsSummary': {
    anonymous: { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } } },
    platformAdmin: {
      status: 200,
      body: {
        ok: true,
        data: {
          total: 0, approved: 0, rejected: 0, revoked: 0, returned: 0, running: 0,
          avgDurationSeconds: null, p50DurationSeconds: null, p95DurationSeconds: null,
          slaBreachCount: 0, slaCandidateCount: 0, slaBreachRate: 0, byTemplate: [],
        },
      },
    },
    processOnly: {
      status: 200,
      body: {
        ok: true,
        data: {
          total: 0, approved: 0, rejected: 0, revoked: 0, returned: 0, running: 0,
          avgDurationSeconds: null, p50DurationSeconds: null, p95DurationSeconds: null,
          slaBreachCount: 0, slaCandidateCount: 0, slaBreachRate: 0, byTemplate: [],
        },
      },
    },
    templateOnly: { status: 403, body: { error: 'Insufficient permissions' } },
    plainUser: { status: 403, body: { error: 'Insufficient permissions' } },
  },
  // NEGATIVE CONTROL — unchanged code (`ensurePlatformAdmin`, exception 2). Included to prove this
  // slice left it alone, not to exercise the resolver.
  'memberGroups.bind': {
    anonymous: { status: 401, body: { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } } },
    platformAdmin: { status: 400, body: { ok: false, error: { code: 'APPROVAL_ORG_ID_REQUIRED', message: 'orgId is required' } } },
    processOnly: { status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } } },
    templateOnly: { status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } } },
    plainUser: { status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } } },
  },
}

const ROUTES: Array<{ key: keyof typeof EXPECTED; method: string; path: string; body?: unknown }> = [
  { key: 'template.delegationsList', method: 'GET', path: '/api/approval-delegations' },
  { key: 'process.reassign', method: 'POST', path: '/api/approvals/admin/reassign', body: {} },
  { key: 'data.metricsSummary', method: 'GET', path: '/api/approvals/metrics/summary' },
  { key: 'memberGroups.bind', method: 'POST', path: '/api/approval-templates/directory/member-groups/bind', body: {} },
]

describeIfDatabase('P4(2) phase 0 — approval admin capability resolver, zero-behavior-change parity', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()

  const suffix = randomUUID().slice(0, 8)
  const platformAdminId = `a0-platform-admin-${suffix}`
  const processOnlyId = `a0-process-only-${suffix}`
  const templateOnlyId = `a0-template-only-${suffix}`
  const plainUserId = `a0-plain-user-${suffix}`
  const seededUserIds = [platformAdminId, processOnlyId, templateOnlyId, plainUserId]

  const viewerIds: Record<Exclude<Viewer, 'anonymous'>, string> = {
    platformAdmin: platformAdminId,
    processOnly: processOnlyId,
    templateOnly: templateOnlyId,
    plainUser: plainUserId,
  }
  const tokens: Partial<Record<Exclude<Viewer, 'anonymous'>, string>> = {}

  async function seedUser(userId: string): Promise<void> {
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
       VALUES ($1, $1 || '@example.test', $1, 'x', 'user', TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET role = 'user', is_active = TRUE, is_admin = FALSE`,
      [userId],
    )
  }

  async function devToken(userId: string): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=none&perms=none`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async function hit(method: string, path: string, viewer: Viewer, body?: unknown): Promise<CapturedResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (viewer !== 'anonymous') headers.authorization = `Bearer ${tokens[viewer]}`
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await response.text()
    let parsedBody: unknown
    try { parsedBody = JSON.parse(text) } catch { parsedBody = text }
    return { status: response.status, body: parsedBody }
  }

  beforeAll(async () => {
    for (const id of seededUserIds) await seedUser(id)
    // `user_permissions.permission_code` FK's into `permissions` — `approval-templates:manage` has
    // no seeding migration of its own (grep: zero hits) even though it gates real routes today, so
    // the fixture registers it itself. `approvals:admin` is already seeded
    // (zzzz20260702110000_add_approval_reassign_and_admin_scopes.ts); ON CONFLICT either way.
    await pool().query(
      `INSERT INTO permissions (code, name)
       VALUES ('approvals:admin', 'Approvals Admin'), ('approval-templates:manage', 'Approval Templates Manage')
       ON CONFLICT (code) DO NOTHING`,
    )
    await pool().query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`,
      [platformAdminId],
    )
    await pool().query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:admin') ON CONFLICT DO NOTHING`,
      [processOnlyId],
    )
    await pool().query(
      `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approval-templates:manage') ON CONFLICT DO NOTHING`,
      [templateOnlyId],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address && typeof address === 'object' ? address.port : undefined).toBeTruthy()
    baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`

    for (const key of Object.keys(viewerIds) as Array<Exclude<Viewer, 'anonymous'>>) {
      tokens[key] = await devToken(viewerIds[key])
    }
  })

  afterAll(async () => {
    try {
      await pool().query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [seededUserIds])
      await pool().query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [seededUserIds])
      await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [seededUserIds])
    } finally {
      await server?.stop()
    }
  })

  it('(0) the fixture discriminates: process-only is refused the template route, template-only is refused the process/data routes', async () => {
    // The positive control this whole file turns on — see the docblock. If this fails, the fixture
    // itself is broken (e.g. every seeded row resolving to platform-admin) and every parity
    // assertion below would be passing for the wrong reason.
    const templateFromProcessOnly = await hit('GET', '/api/approval-delegations', 'processOnly')
    expect(templateFromProcessOnly.status).toBe(403)
    const processFromTemplateOnly = await hit('POST', '/api/approvals/admin/reassign', 'templateOnly', {})
    expect(processFromTemplateOnly.status).toBe(403)
    const dataFromTemplateOnly = await hit('GET', '/api/approvals/metrics/summary', 'templateOnly')
    expect(dataFromTemplateOnly.status).toBe(403)
  })

  const viewers: Viewer[] = ['anonymous', 'platformAdmin', 'processOnly', 'templateOnly', 'plainUser']

  for (const route of ROUTES) {
    for (const viewer of viewers) {
      it(`(parity) ${route.method} ${route.path} — ${viewer} — byte-for-byte equal to the pre-resolver capture`, async () => {
        const actual = await hit(route.method, route.path, viewer, route.body)
        const expected = EXPECTED[route.key][viewer]
        expect(actual.status).toBe(expected.status)
        expect(actual.body).toEqual(expected.body)
      })
    }
  }
})
