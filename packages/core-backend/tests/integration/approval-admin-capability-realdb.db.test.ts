import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { randomUUID } from 'node:crypto'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'
import { ApprovalBridgeService } from '../../src/services/ApprovalBridgeService'
import {
  APPROVAL_ADMIN_CAPABILITY_PREDICATE,
  isApprovalAdministrator,
} from '../../src/services/approval-admin-capability'

/**
 * P1b round 3, item 6 — the approval-administrator capability's SQL, executed against real
 * PostgreSQL.
 *
 * WHY THIS FILE EXISTS. `GET /api/approvals/admin/capability` and its
 * `isApprovalAdministrator` predicate shipped with unit coverage only: a fake pool answered rows
 * the test itself had written, so every arm of
 * `is_active = TRUE AND (is_admin = TRUE OR role = 'admin')` was asserted against a stub that never
 * parsed the SQL. The predicate's whole purpose is to answer the SAME question the approval list
 * scope's admin arm answers, and that agreement had only ever been established as TEXT agreement
 * (a source-extracting tripwire) plus a hand-read of both statements. Neither can catch a statement
 * that parses but selects the wrong thing — a column that does not exist under that name, a
 * three-valued-logic surprise on a NULL column, a predicate that admits a row the list scope's arm
 * would not. That gap closes only by running it.
 *
 * WHAT IS ASSERTED, and the shape of the fixture. Five identities, alike in every respect except the
 * two `users` columns the predicate reads, so no test here can pass on an incidental difference:
 *
 *   dbAdminByFlag      is_admin = TRUE,  role = 'viewer', is_active = TRUE   → true
 *   dbAdminByRole      is_admin = FALSE, role = 'admin',  is_active = TRUE   → true
 *   tokenOnlyAdmin     is_admin = FALSE, role = 'viewer', is_active = TRUE   → false
 *   inactiveDbAdmin    is_admin = TRUE,  role = 'admin',  is_active = FALSE  → false
 *   (absent)           no `users` row at all                                 → false
 *
 * `tokenOnlyAdmin` is the identity this whole capability exists for: it is handed a token that
 * CLAIMS `roles=admin` and `perms=*:*` — everything the web client's own admin gate and the
 * reassign endpoint's `rbacGuard` look at — and the answer is still `false`, because the answer
 * comes from the `users` table. `inactiveDbAdmin` is the arm only real SQL can settle: a
 * deactivated row satisfies BOTH halves of the OR, so anything but a genuine `is_active = TRUE`
 * conjunct admits it.
 *
 * A FIXTURE THIS SUITE SET OUT TO SEED AND COULD NOT, recorded because it changes what the
 * predicate has to defend against. A sixth identity was to carry NULL in `role` / `is_admin`, since
 * `is_admin = TRUE` over a NULL yields NULL rather than FALSE and a differently-assembled predicate
 * (a `NOT (...)`, a misplaced `COALESCE`) would flip on it. Real PostgreSQL refused the insert:
 * all three predicate columns are NOT NULL, with defaults. The three-valued case is therefore not
 * reachable, and the guarantee lives in the SCHEMA rather than in the predicate — which is exactly
 * why test (5b) asserts the NOT NULL constraints instead of the row. A migration that relaxed one
 * would silently reintroduce the case, and that test is what would notice. The no-DB unit suite
 * could not have found this: its fake pool returns whatever rows the test declares, constraints and
 * all being absent.
 *
 * AND THE AGREEMENT ITSELF, executed rather than read. Test (7) puts the capability's answer and
 * the list scope's projection side by side on ONE seeded row that belongs to somebody else: the
 * identity the capability calls an administrator is served that row by `listApprovals`, and the
 * identity it refuses is not. That is the actual claim the page rests on — "gating on this boolean
 * gates on the same truth the list binds" — and it is the one thing a text tripwire cannot prove.
 *
 * NOT ASSERTED HERE, so a green run is not over-read:
 *   - The ORG PIN. `listApprovals` conjoins a second, per-row org condition when
 *     `APPROVAL_S1_ORG_PIN_ENABLED` is on (default OFF); the capability has no counterpart and
 *     deliberately does not get one (see `approval-admin-capability.ts`). This suite runs on the
 *     shipped default and asserts the status quo, exactly as the sibling list-scope suite does. The
 *     residual is disclosed in that service's docblock, not silently covered by a test that would
 *     have to assert away a behaviour this slice has no authority to change.
 *   - PostgreSQL version. This runs on postgres:16 in CI. The predicate is boolean-column equality
 *     plus one short ASCII string comparison, so it carries no collation or locale sensitivity, but
 *     that is a statement about the predicate — not a claim that this suite has been run on every
 *     version the product deploys to.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Anti-skip-green sentinel: the evidence lane sets EXPECT_DB=1, so a missing/broken DATABASE_URL
// there REDS the run instead of reporting the whole file as silently skipped-green.
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

type CapabilityResponse = { ok?: boolean; data?: { isApprovalAdmin?: unknown } }

describeIfDatabase('approval administrator capability — real PostgreSQL', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  const pool = () => poolManager.get()

  const suffix = randomUUID().slice(0, 8)
  const orgId = `cap-org-${suffix}`

  const dbAdminByFlagId = `cap-admin-flag-${suffix}`
  const dbAdminByRoleId = `cap-admin-role-${suffix}`
  const tokenOnlyAdminId = `cap-token-admin-${suffix}`
  const inactiveDbAdminId = `cap-inactive-admin-${suffix}`
  /** Deliberately never inserted into `users` — the "no row" arm. */
  const absentUserId = `cap-absent-${suffix}`
  const otherRequesterId = `cap-other-requester-${suffix}`
  const otherSeatId = `cap-other-seat-${suffix}`

  const seededUserIds = [
    dbAdminByFlagId,
    dbAdminByRoleId,
    tokenOnlyAdminId,
    inactiveDbAdminId,
    otherRequesterId,
    otherSeatId,
  ]

  /** One pending platform row belonging to somebody else entirely: neither requester, seat, past
   *  actor nor CC target is any of the identities under test, so the ONLY scope arm that can admit
   *  it is the DB-backed administrator arm. That is what makes test (7) discriminating. */
  const foreignInstanceId = `cap_foreign_${suffix}`
  const seededInstanceIds = [foreignInstanceId]

  /** All three columns are stated explicitly on every call: they are the entire fixture, and a
   *  defaulted one would make a test pass for a reason its name does not mention. */
  async function seedUser(
    userId: string,
    options: { role: string; isAdmin: boolean; isActive: boolean },
  ): Promise<void> {
    await pool().query(
      `INSERT INTO users (id, email, name, password_hash, role, is_active, is_admin)
       VALUES ($1, $1 || '@example.test', $1, 'x', $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
         SET role = EXCLUDED.role, is_active = EXCLUDED.is_active, is_admin = EXCLUDED.is_admin`,
      [userId, options.role, options.isActive, options.isAdmin],
    )
  }

  async function authToken(userId: string, roles: string, perms: string): Promise<string> {
    const response = await fetch(
      `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { token: string }).token
  }

  async function capabilityOverHttp(token: string): Promise<{ status: number; body: CapabilityResponse }> {
    const response = await fetch(`${baseUrl}/api/approvals/admin/capability`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return { status: response.status, body: (await response.json()) as CapabilityResponse }
  }

  /** The list scope in isolation: no `tab`, so nothing but the scope condition can exclude a row. */
  async function scopeOwnIds(actorId: string, actorRoles: string[], actorPermissions: string[]): Promise<string[]> {
    const result = await new ApprovalBridgeService().listApprovals({
      limit: 500,
      actorId,
      actorRoles,
      actorPermissions,
    })
    return result.data.map((row) => row.id).filter((id) => seededInstanceIds.includes(id)).sort()
  }

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()

    await seedUser(dbAdminByFlagId, { role: 'viewer', isAdmin: true, isActive: true })
    await seedUser(dbAdminByRoleId, { role: 'admin', isAdmin: false, isActive: true })
    await seedUser(tokenOnlyAdminId, { role: 'viewer', isAdmin: false, isActive: true })
    // BOTH halves of the OR satisfied, and inactive. Only the `is_active` conjunct can refuse it.
    await seedUser(inactiveDbAdminId, { role: 'admin', isAdmin: true, isActive: false })
    await seedUser(otherRequesterId, { role: 'viewer', isAdmin: false, isActive: true })
    await seedUser(otherSeatId, { role: 'viewer', isAdmin: false, isActive: true })

    for (const userId of seededUserIds) {
      await pool().query(
        `INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, TRUE)
         ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`,
        [userId, orgId],
      )
    }

    await pool().query(
      `INSERT INTO approval_instances
         (id, status, version, source_system, workflow_key, business_key, title,
          requester_snapshot, subject_snapshot, policy_snapshot, metadata,
          current_step, total_steps, sync_status, org_id, created_at, updated_at)
       VALUES ($1, 'pending', 0, 'platform', $2, $3, $4, $5::jsonb,
               '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 0, 'ok', $6, now(), now())`,
      [
        foreignInstanceId,
        `cap-wf-${suffix}`,
        `cap:${foreignInstanceId}`,
        `CAP ${foreignInstanceId}`,
        JSON.stringify({ id: otherRequesterId, name: otherRequesterId }),
        orgId,
      ],
    )
    await pool().query(
      `INSERT INTO approval_assignments
         (id, instance_id, assignment_type, assignee_id, source_step, is_active, metadata, created_at, updated_at)
       VALUES ($1, $2, 'user', $3, 0, TRUE, '{}'::jsonb, now(), now())`,
      [randomUUID(), foreignInstanceId, otherSeatId],
    )

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address && typeof address === 'object' ? address.port : undefined).toBeTruthy()
    baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`
  })

  afterAll(async () => {
    try {
      await pool().query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [seededInstanceIds])
      await pool().query('DELETE FROM user_orgs WHERE user_id = ANY($1::text[])', [seededUserIds])
      await pool().query('DELETE FROM users WHERE id = ANY($1::text[])', [seededUserIds])
    } finally {
      await server?.stop()
    }
  })

  // ───────────────────────────────────────────────────────────────────────────
  // The predicate, executed.
  // ───────────────────────────────────────────────────────────────────────────

  it('(0) the fixture is real: every identity under test is in `users` with the columns this suite says it has', async () => {
    // A negative control on the whole file. Without it, a seed that silently failed would make every
    // `false` assertion below pass for the wrong reason ("no row" instead of "the wrong columns").
    const result = await pool().query(
      `SELECT id, role, is_admin, is_active FROM users WHERE id = ANY($1::text[]) ORDER BY id`,
      [[dbAdminByFlagId, dbAdminByRoleId, tokenOnlyAdminId, inactiveDbAdminId]],
    )
    const byId = new Map(
      (result.rows as Array<{ id: string; role: string; is_admin: boolean; is_active: boolean }>)
        .map((row) => [row.id, row]),
    )
    expect(byId.size).toBe(4)
    expect(byId.get(dbAdminByFlagId)).toMatchObject({ is_admin: true, role: 'viewer', is_active: true })
    expect(byId.get(dbAdminByRoleId)).toMatchObject({ is_admin: false, role: 'admin', is_active: true })
    expect(byId.get(tokenOnlyAdminId)).toMatchObject({ is_admin: false, role: 'viewer', is_active: true })
    expect(byId.get(inactiveDbAdminId)).toMatchObject({ is_admin: true, role: 'admin', is_active: false })
    // And the row this suite's list assertions turn on exists, pending and platform.
    const instance = await pool().query(
      `SELECT status, source_system FROM approval_instances WHERE id = $1`,
      [foreignInstanceId],
    )
    expect(instance.rows[0]).toMatchObject({ status: 'pending', source_system: 'platform' })
  })

  it('(1) a DB administrator by the `is_admin` column is an approval administrator', async () => {
    await expect(isApprovalAdministrator(pool(), dbAdminByFlagId)).resolves.toBe(true)
  })

  it('(2) a DB administrator by `role = \'admin\'` is an approval administrator', async () => {
    await expect(isApprovalAdministrator(pool(), dbAdminByRoleId)).resolves.toBe(true)
  })

  it('(3) an identity whose ADMIN-NESS lives only in its token is NOT an approval administrator', async () => {
    await expect(isApprovalAdministrator(pool(), tokenOnlyAdminId)).resolves.toBe(false)
  })

  it('(4) a DEACTIVATED row satisfying both halves of the OR is refused', async () => {
    await expect(isApprovalAdministrator(pool(), inactiveDbAdminId)).resolves.toBe(false)
  })

  it('(5) an identity with no `users` row at all is refused, and so is a blank id', async () => {
    await expect(isApprovalAdministrator(pool(), absentUserId)).resolves.toBe(false)
    // The guard ahead of the query — never reaches SQL, so it is asserted here rather than assumed
    // to be equivalent to "no row".
    await expect(isApprovalAdministrator(pool(), '   ')).resolves.toBe(false)
    await expect(isApprovalAdministrator(pool(), '')).resolves.toBe(false)
  })

  it('(5b) the three predicate columns are NOT NULL, which is what keeps this predicate two-valued', async () => {
    // `is_admin = TRUE` over a NULL is NULL, not FALSE. The predicate does not defend against that
    // case, and it does not have to — the SCHEMA forecloses it. That is a real dependency, so it is
    // pinned here: a migration relaxing any of these three would silently widen what this predicate
    // has to handle, and would red exactly this test rather than being discovered by an admin who
    // stopped being one. Seeding the row instead is not an option — PostgreSQL refuses the insert.
    const result = await pool().query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'users'
          AND column_name = ANY($1::text[])
        ORDER BY column_name`,
      [['is_active', 'is_admin', 'role']],
    )
    expect((result.rows as Array<{ column_name: string; is_nullable: string }>)
      .map((row) => `${row.column_name}:${row.is_nullable}`))
      .toEqual(['is_active:NO', 'is_admin:NO', 'role:NO'])
  })

  it('(6) the exported predicate text is the statement that actually ran (no second, drifted copy)', async () => {
    // Executing the exported constant directly proves the string this repo's tripwire compares
    // against the list scope is itself valid SQL over the real `users` table — a text tripwire
    // cannot tell a correct predicate from a well-formed but unrunnable one.
    const result = await pool().query(
      `SELECT id FROM users WHERE id = ANY($1::text[]) AND ${APPROVAL_ADMIN_CAPABILITY_PREDICATE} ORDER BY id`,
      [[dbAdminByFlagId, dbAdminByRoleId, tokenOnlyAdminId, inactiveDbAdminId]],
    )
    expect((result.rows as Array<{ id: string }>).map((row) => row.id).sort())
      .toEqual([dbAdminByFlagId, dbAdminByRoleId].sort())
  })

  // ───────────────────────────────────────────────────────────────────────────
  // The agreement the page rests on, executed rather than read.
  // ───────────────────────────────────────────────────────────────────────────

  it('(7) the identity the capability calls an administrator is the one the LIST SCOPE serves another approver’s row to', async () => {
    // Same claims for both, so nothing here can turn on the token: `*:*` and an `admin` role claim.
    const claims = { roles: ['admin'], permissions: ['*:*'] }

    await expect(isApprovalAdministrator(pool(), dbAdminByFlagId)).resolves.toBe(true)
    expect(await scopeOwnIds(dbAdminByFlagId, claims.roles, claims.permissions)).toEqual([foreignInstanceId])

    await expect(isApprovalAdministrator(pool(), tokenOnlyAdminId)).resolves.toBe(false)
    expect(await scopeOwnIds(tokenOnlyAdminId, claims.roles, claims.permissions)).toEqual([])

    // The deactivated row is the sharper half of the same claim: it is refused by BOTH surfaces, so
    // this pair cannot pass on a scope that merely ignores `is_active`.
    await expect(isApprovalAdministrator(pool(), inactiveDbAdminId)).resolves.toBe(false)
    expect(await scopeOwnIds(inactiveDbAdminId, claims.roles, claims.permissions)).toEqual([])
  })

  // ───────────────────────────────────────────────────────────────────────────
  // The HTTP surface — where `resolveApprovalActorId` and the envelope live.
  // ───────────────────────────────────────────────────────────────────────────

  it('(8) the route answers `true` / `false` as DATA, off the `users` row and not off the caller’s claims', async () => {
    // Every token below claims the admin role and `*:*`. The answers differ anyway.
    const granted = await capabilityOverHttp(await authToken(dbAdminByFlagId, 'admin', '*:*'))
    expect(granted.status).toBe(200)
    expect(granted.body.data?.isApprovalAdmin).toBe(true)

    const grantedByRole = await capabilityOverHttp(await authToken(dbAdminByRoleId, 'admin', '*:*'))
    expect(grantedByRole.status).toBe(200)
    expect(grantedByRole.body.data?.isApprovalAdmin).toBe(true)

    const denied = await capabilityOverHttp(await authToken(tokenOnlyAdminId, 'admin', '*:*'))
    expect(denied.status).toBe(200)
    expect(denied.body.data?.isApprovalAdmin).toBe(false)
    // `false` is DATA in a 200, never a 403 — the client has to be able to tell "no" from "the read
    // did not happen", which is the whole reason this route carries no `rbacGuard`.
    expect(denied.body.ok).toBe(true)
    expect(typeof denied.body.data?.isApprovalAdmin).toBe('boolean')

    const inactive = await capabilityOverHttp(await authToken(inactiveDbAdminId, 'admin', '*:*'))
    expect(inactive.status).toBe(200)
    expect(inactive.body.data?.isApprovalAdmin).toBe(false)
  })

  it('(9) an unauthenticated caller is refused rather than answered `false`', async () => {
    const response = await fetch(`${baseUrl}/api/approvals/admin/capability`)
    // The exact code is `authenticate`'s to choose; what matters here is that the route never hands
    // an anonymous caller a BOOLEAN, which a client would render as a statement about their rights.
    expect(response.status).toBeGreaterThanOrEqual(400)
    const body = (await response.json().catch(() => ({}))) as CapabilityResponse
    expect(body.data?.isApprovalAdmin).toBeUndefined()
  })
})
