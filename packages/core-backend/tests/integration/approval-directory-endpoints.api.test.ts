import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// Real-DB spec: only runs when a Postgres DATABASE_URL is provided (the DB-backed CI
// step in plugin-tests.yml + local runs). The no-DB default `test (18.x)` job both
// excludes this file (vitest.config.ts) and would skip it here.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

/**
 * Lane A (P1-static-picker) backend landing blocker: the two read-only directory
 * endpoints used by the authoring assignee picker.
 *   GET /api/approval-templates/directory/users?q=&limit=
 *   GET /api/approval-templates/directory/roles
 *
 * Coverage: rejection (403 for a non-manager), functional success + minimal-exposure
 * shape + ?q filter + limit (via an authorized caller), and a source-level assertion
 * that the routes are gated by the least-privilege `approval-templates:manage` and NOT
 * `ensurePlatformAdmin`. (The positive caller is an admin token because a non-admin
 * "manager" additionally needs role-derived namespace admission — the platform's real
 * RBAC layer — which is out of scope here; the least-privilege wiring is pinned by the
 * source assertion + the 403 negative.)
 */

const PREFIX = `dirpick-${Date.now()}`
const ADMIN = `${PREFIX}-admin`
const NON = `${PREFIX}-non`
const ALICE = `${PREFIX}-alice`
const BOB = `${PREFIX}-bob`
const CAROL = `${PREFIX}-carol`
const ROLE = `${PREFIX}-role` // UNCURATED (approval_usable defaults false)
const ROLE_CURATED = `${PREFIX}-role-curated` // RA-1b: approval_usable=true
// Lock-1 §K1 fix-round P2-1 — a REAL non-admin `approval-templates:manage` holder (the exact
// principal the P1 finding says must NOT be able to self-curate), seeded via the real RBAC chain
// (role + role_permissions + user_namespace_admissions), mirroring
// approval-delegation-api.db.test.ts:63-75 — NOT the `roles=admin` dev-token shortcut, which would
// make this caller indistinguishable from a platform admin.
const MGR = `${PREFIX}-mgr`
const MGR_ROLE = `${PREFIX}-mgr-role`

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function devToken(baseUrl: string, userId: string, roles: string, perms: string): Promise<string> {
  const res = await fetch(
    `${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}&roles=${encodeURIComponent(roles)}&perms=${encodeURIComponent(perms)}`,
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { token: string }).token
}

function get(baseUrl: string, p: string, token: string): Promise<Response> {
  return fetch(`${baseUrl}${p}`, { headers: { Authorization: `Bearer ${token}` } })
}

function post(baseUrl: string, p: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describeIfDatabase('approval directory endpoints (P1-static-picker backend, real DB)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''
  let adminToken = ''
  let nonMgrToken = ''
  let mgrToken = ''
  let roleSeeded = false
  let mgrSeeded = false
  let memberGroupId = ''

  beforeAll(async () => {
    expect(await canListenOnEphemeralPort()).toBe(true)
    await ensureApprovalSchemaReady()
    const pool = poolManager.get()

    const seedUser = async (id: string, name: string) => {
      await pool.query(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $3, 'x', 'member', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, name = EXCLUDED.name`,
        [id, `${id}@ex.test`, name],
      )
    }
    await seedUser(ALICE, 'ZmarkerQ Alice')
    await seedUser(BOB, 'ZmarkerQ Bob')
    await seedUser(CAROL, 'Zzz Other Person')
    // Lock-1 §K1 fix-round P2-1 — a REAL `users` row for ADMIN: bindApprovalUsableMemberGroup
    // writes `created_by`, which the REAL migration's FK (approval_usable_member_groups
    // .created_by -> users.id) enforces. Every OTHER test in this file only needs a dev-token JWT
    // identity (no users row), so this was never needed until the bind/unbind tests below.
    await seedUser(ADMIN, 'Dirpick Admin')
    try {
      // RA-1b: defensively ensure the curated column exists (whether or not the migration ran in this lane),
      // then seed an UNCURATED role (ROLE, default approval_usable=false) and a CURATED role (approval_usable=true).
      await pool.query(`ALTER TABLE roles ADD COLUMN IF NOT EXISTS approval_usable boolean NOT NULL DEFAULT false`)
      await pool.query(`INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [ROLE, 'Dirpick Role'])
      await pool.query(
        `INSERT INTO roles (id, name, approval_usable) VALUES ($1, $2, true)
         ON CONFLICT (id) DO UPDATE SET approval_usable = true`,
        [ROLE_CURATED, 'Dirpick Curated Role'],
      )
      roleSeeded = true
    } catch {
      roleSeeded = false
    }

    // Lock-1 §K1 fix-round P2-1 — the REAL non-admin approval-templates:manage caller (role +
    // role_permissions + user_namespace_admissions), mirroring approval-delegation-api.db.test.ts
    // exactly. This is the P1 finding's exact constrained principal: gated IN on the picker GET
    // (unchanged, approvalTemplateAdminGuard) and gated OUT on bind/unbind (post-fix,
    // ensurePlatformAdmin) — proving the P1 loop is closed by a caller who is NOT merely
    // unauthenticated/permission-less.
    try {
      await seedUser(MGR, 'Dirpick Manager')
      await pool.query(`INSERT INTO permissions (code, name, description) VALUES ('approval-templates:manage', 'Approval Templates Manage', 'directory-endpoints test') ON CONFLICT (code) DO NOTHING`)
      await pool.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [MGR, MGR_ROLE])
      await pool.query(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'approval-templates:manage') ON CONFLICT DO NOTHING`, [MGR_ROLE])
      await pool.query(
        `INSERT INTO user_namespace_admissions (user_id, namespace, enabled)
         VALUES ($1, 'approval-templates', TRUE)
         ON CONFLICT (user_id, namespace) DO UPDATE SET enabled = TRUE`,
        [MGR],
      )
      mgrSeeded = true
    } catch {
      mgrSeeded = false
    }

    // A real platform_member_groups row for the bind/unbind guard tests below (existence is
    // verified BEFORE the guard-relevant branch runs, so a nonexistent group would 404 before ever
    // reaching the authorization question — this fixture keeps the guard tests guard-selected).
    const groupRow = await pool.query<{ id: string }>(
      `INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id`,
      [`${PREFIX}-group`],
    )
    memberGroupId = groupRow.rows[0].id

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address!.port}`

    adminToken = await devToken(baseUrl, ADMIN, 'admin', '*:*')
    // roles=member keeps this NON-admin; empty perms → lacks approval-templates:manage.
    nonMgrToken = await devToken(baseUrl, NON, 'member', '')
    // roles=user (NOT admin); perms carries the claim, DB seeding above is what actually resolves
    // it (rbacGuardAny checks BOTH the resolved permission AND namespace admission).
    mgrToken = await devToken(baseUrl, MGR, 'user', 'approval-templates:manage')
  })

  afterAll(async () => {
    const pool = poolManager.get()
    try {
      await pool.query(`DELETE FROM approval_usable_member_groups WHERE group_id = $1`, [memberGroupId])
      await pool.query(`DELETE FROM platform_member_groups WHERE id = $1`, [memberGroupId])
      if (mgrSeeded) {
        await pool.query(`DELETE FROM user_namespace_admissions WHERE user_id = $1`, [MGR])
        await pool.query(`DELETE FROM user_roles WHERE user_id = $1`, [MGR])
        await pool.query(`DELETE FROM role_permissions WHERE role_id = $1`, [MGR_ROLE])
      }
      await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[ADMIN, NON, ALICE, BOB, CAROL, MGR]])
      if (roleSeeded) await pool.query(`DELETE FROM roles WHERE id = ANY($1::text[])`, [[ROLE, ROLE_CURATED]])
    } catch {
      // ignore cleanup failures
    }
    if (server) await server.stop()
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('rejects a non-manager on /directory/users (403)', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/users', nonMgrToken)
    expect(res.status).toBe(403)
  })

  it('rejects a non-manager on /directory/roles (403)', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/roles', nonMgrToken)
    expect(res.status).toBe(403)
  })

  it('returns the minimal {id,name,email} shape on /directory/users for an authorized caller', async () => {
    const res = await get(baseUrl, `/api/approval-templates/directory/users?q=ZmarkerQ`, adminToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<Record<string, unknown>> }
    expect(Array.isArray(body.users)).toBe(true)
    const alice = body.users.find((u) => u.id === ALICE)
    expect(alice).toBeTruthy()
    // least-privilege exposure: ONLY id/name/email — NOT mobile/department/role/is_admin/etc.
    expect(Object.keys(alice as Record<string, unknown>).sort()).toEqual(['email', 'id', 'name'])
    expect((alice as { email: string }).email).toBe(`${ALICE}@ex.test`)
  })

  it('filters by ?q name marker (matches alice/bob, excludes the other)', async () => {
    const res = await get(baseUrl, `/api/approval-templates/directory/users?q=ZmarkerQ`, adminToken)
    const body = (await res.json()) as { users: Array<{ id: string }> }
    const ids = body.users.map((u) => u.id)
    expect(ids).toContain(ALICE)
    expect(ids).toContain(BOB)
    expect(ids).not.toContain(CAROL)
  })

  it('applies limit (limit=1 over 2 matches → 1), clamps 0 without erroring, and caps at 50', async () => {
    const one = await get(baseUrl, `/api/approval-templates/directory/users?q=ZmarkerQ&limit=1`, adminToken)
    expect(one.status).toBe(200)
    expect(((await one.json()) as { users: unknown[] }).users.length).toBe(1)
    const zero = await get(baseUrl, `/api/approval-templates/directory/users?q=ZmarkerQ&limit=0`, adminToken)
    expect(zero.status).toBe(200)
    expect(((await zero.json()) as { users: unknown[] }).users.length).toBeGreaterThanOrEqual(1)
    const over = await get(baseUrl, `/api/approval-templates/directory/users?limit=999`, adminToken)
    expect(((await over.json()) as { users: unknown[] }).users.length).toBeLessThanOrEqual(50)
  })

  it('returns the minimal {id,name} shape on /directory/roles', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/roles', adminToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { roles: Array<Record<string, unknown>> }
    expect(Array.isArray(body.roles)).toBe(true)
    if (roleSeeded) {
      const seeded = body.roles.find((r) => r.id === ROLE)
      expect(seeded).toBeTruthy()
      expect(Object.keys(seeded as Record<string, unknown>).sort()).toEqual(['id', 'name'])
    } else if (body.roles.length > 0) {
      expect(Object.keys(body.roles[0]).sort()).toEqual(['id', 'name'])
    }
  })

  it('RA-1b: /directory/formula-roles returns ONLY approval_usable roles (curated vocabulary)', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/formula-roles', adminToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { roles: Array<{ id: string; name: string }> }
    expect(Array.isArray(body.roles)).toBe(true)
    if (roleSeeded) {
      const ids = body.roles.map((r) => r.id)
      expect(ids).toContain(ROLE_CURATED) // approval_usable=true → curated
      expect(ids).not.toContain(ROLE) // approval_usable=false → excluded (secure-by-default)
    }
  })

  it('RA-1b: /directory/roles is UNCHANGED — the shared author/static_role picker still returns ALL roles', async () => {
    // The curated lock scopes ONLY formula requester.role; static_role approver selection (which shares this
    // endpoint) must still see uncurated roles, otherwise the owner boundary would over-reach.
    const res = await get(baseUrl, '/api/approval-templates/directory/roles', adminToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { roles: Array<{ id: string }> }
    if (roleSeeded) {
      const ids = body.roles.map((r) => r.id)
      expect(ids).toContain(ROLE) // uncurated role STILL visible to the shared picker
      expect(ids).toContain(ROLE_CURATED)
    }
  })

  it('rejects a non-manager on /directory/formula-roles (403)', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/formula-roles', nonMgrToken)
    expect(res.status).toBe(403)
  })

  // ── Lock-1 §K1 fix-round P2-1 — the picker GET stays at the shared template-admin guard ──────
  it('rejects a non-manager on GET /directory/member-groups (403)', async () => {
    const res = await get(baseUrl, '/api/approval-templates/directory/member-groups?orgId=default', nonMgrToken)
    expect(res.status).toBe(403)
  })

  it('a non-admin approval-templates:manage caller CAN list bound groups (200) — the picker is authoring convenience, not the curation boundary', async () => {
    if (!mgrSeeded) return
    const res = await get(baseUrl, '/api/approval-templates/directory/member-groups?orgId=default', mgrToken)
    expect(res.status, await res.clone().text()).toBe(200)
    const body = (await res.json()) as { groups: unknown[] }
    expect(Array.isArray(body.groups)).toBe(true)
  })

  // ── Lock-1 §K1 fix-round P1/P2-1 — bind/unbind is `ensurePlatformAdmin`-gated: STRICTER than
  // the picker above and every other route on this seam. The mutation that proves this guard is
  // load-bearing (stripping it back to `approvalTemplateAdminGuard` reds these two negatives) was
  // run manually via cp+sha256 backup/restore per the PR's verification discipline — see the PR
  // body for the mutation log.
  it('rejects a non-admin approval-templates:manage caller on POST bind (403) — the P1 loop is closed: self-curation is no longer possible', async () => {
    if (!mgrSeeded) return
    const res = await post(baseUrl, '/api/approval-templates/directory/member-groups/bind', mgrToken, {
      orgId: 'default',
      groupId: memberGroupId,
    })
    expect(res.status, await res.clone().text()).toBe(403)
    // Positive control in the SAME fixture: the identical request succeeds for a platform admin —
    // the rejection above is guard-selected (principal), not a blanket route failure.
    const admin = await post(baseUrl, '/api/approval-templates/directory/member-groups/bind', adminToken, {
      orgId: 'default',
      groupId: memberGroupId,
    })
    expect(admin.status, await admin.clone().text()).toBe(200)
  })

  it('rejects a non-admin approval-templates:manage caller on POST unbind (403); a platform admin CAN unbind (200)', async () => {
    if (!mgrSeeded) return
    // Ensure a binding exists first (idempotent bind as platform admin), so the unbind negative
    // below is exercised against a REAL row, not short-circuited by a no-op.
    const seedBind = await post(baseUrl, '/api/approval-templates/directory/member-groups/bind', adminToken, {
      orgId: 'default',
      groupId: memberGroupId,
    })
    expect(seedBind.status, await seedBind.clone().text()).toBe(200)

    const res = await post(baseUrl, '/api/approval-templates/directory/member-groups/unbind', mgrToken, {
      orgId: 'default',
      groupId: memberGroupId,
    })
    expect(res.status, await res.clone().text()).toBe(403)

    const admin = await post(baseUrl, '/api/approval-templates/directory/member-groups/unbind', adminToken, {
      orgId: 'default',
      groupId: memberGroupId,
    })
    expect(admin.status, await admin.clone().text()).toBe(200)
  })

  it('routes are gated by the least-privilege template-admin guard, NOT ensurePlatformAdmin — EXCEPT the curated bind/unbind path, which is the reverse (Lock-1 §K1 fix-round P1)', () => {
    const src = readFileSync(path.resolve(__dirname, '../../src/routes/approvals.ts'), 'utf8')
    const lines = src.split('\n')
    const usersLine = lines.find((l) => l.includes("'/api/approval-templates/directory/users'"))
    const rolesLine = lines.find((l) => l.includes("'/api/approval-templates/directory/roles'"))
    const formulaRolesLine = lines.find((l) => l.includes("'/api/approval-templates/directory/formula-roles'"))
    const memberGroupsGetLine = lines.find((l) => l.includes("r.get('/api/approval-templates/directory/member-groups'"))
    const bindUnbindLine = lines.find((l) => l.includes("'/api/approval-templates/directory/member-groups/:action(bind|unbind)'"))
    expect(usersLine).toBeTruthy()
    expect(rolesLine).toBeTruthy()
    expect(formulaRolesLine).toBeTruthy()
    expect(memberGroupsGetLine).toBeTruthy()
    expect(bindUnbindLine).toBeTruthy()
    expect(src).toContain("rbacGuardAny(['approval-templates:manage', 'approvals:admin-templates'])")
    expect(usersLine).toContain('approvalTemplateAdminGuard')
    expect(rolesLine).toContain('approvalTemplateAdminGuard')
    expect(formulaRolesLine).toContain('approvalTemplateAdminGuard')
    expect(memberGroupsGetLine).toContain('approvalTemplateAdminGuard')
    expect(usersLine).not.toContain('ensurePlatformAdmin')
    expect(rolesLine).not.toContain('ensurePlatformAdmin')
    expect(formulaRolesLine).not.toContain('ensurePlatformAdmin')
    expect(memberGroupsGetLine).not.toContain('ensurePlatformAdmin')
    // The bind/unbind route line itself carries NEITHER guard (the check moved inside the
    // handler); assert the handler body — the next 4 lines — calls `ensurePlatformAdmin` and does
    // NOT reuse `approvalTemplateAdminGuard` as a middleware.
    expect(bindUnbindLine).not.toContain('approvalTemplateAdminGuard')
    const bindUnbindIndex = lines.indexOf(bindUnbindLine as string)
    const handlerBody = lines.slice(bindUnbindIndex, bindUnbindIndex + 5).join('\n')
    expect(handlerBody).toContain('ensurePlatformAdmin(req, res)')
  })
})
