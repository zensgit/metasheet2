/**
 * todo-center-design-lock v2.14 §3.0/§5 — the shared "pending" query production-path gate.
 *
 * Judging criterion A0: with `RBAC_BYPASS=false` / `RBAC_TOKEN_TRUST=false` (the DEFAULT
 * integration harness runs with BOTH true, so `/dev-token`'s `roles=`/`perms=` become the actor's
 * identity directly and the production role-resolution axis — `users.role`, the admin-upgrade
 * REPLACEMENT semantics in `AuthService.resolveRbacProfile`, `user_roles`/`user_permissions` reads
 * — is never exercised there), `GET /api/approvals/pending-count` must return the fourteen
 * lock-mandated golden values in §5's A0 row for the fourteen viewer classes (①②③③′④⑤⑥⑦⑧⑨⑩⑪⑫⑬).
 *
 * This file, its `setup.ts`, and `vitest.todo-center-pending-gate.config.ts` are an independent
 * vitest project, mirroring `tests/elearning-pilot-auth/` (see that suite's own docblock for why a
 * dedicated process — not `vitest.integration.config.ts` — is required: `rbac/rbac.ts`'s
 * `trustTokenClaims` and `rbac/service.ts`'s `TTL_MS` are read from `process.env` ONCE, at module
 * import time).
 *
 * Import order is owned by `tests/todo-center-pending-gate/setup.ts` plus
 * `vitest.todo-center-pending-gate.config.ts`'s `setupFiles`. Do NOT run this file under any other
 * vitest config.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { Pool } from 'pg'

// ---------------------------------------------------------------------------------------------
// Import-time guards (design-lock §3.0). These duplicate — deliberately, belt-and-suspenders, per
// `elearning-pilot-auth-gate.ts:51-59`'s own precedent — the assertions `setup.ts` already makes
// BEFORE this file's own imports run (module evaluation order: setupFiles, then the test file).
// The NODE_ENV check is NOT one of the three the elearning precedent's own gate file re-asserts
// (only RBAC_BYPASS / RBAC_TOKEN_TRUST / PRODUCT_MODE are, there) — this lane's lock explicitly
// calls out that gap (第 8 轮 NIT) and requires this file to assert it too, not rely on setup.ts
// alone: `/dev-token` 404s under `NODE_ENV=production`, and the dev-mock-fallback probe (below)
// needs the non-production branch of `AuthService.getUserById` to be reachable.
// ---------------------------------------------------------------------------------------------
if (process.env.TODO_CENTER_PENDING_GATE_SETUP !== '1') {
  throw new Error('todo-center pending-query gate must load its dedicated setup before this file')
}
if (process.env.RBAC_BYPASS !== 'false') {
  throw new Error('todo-center pending-query gate requires RBAC_BYPASS=false at import')
}
if (process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('todo-center pending-query gate requires RBAC_TOKEN_TRUST=false at import')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('todo-center pending-query gate requires PRODUCT_MODE=plm-workbench at import to keep attendance self-service backfill off')
}
if (process.env.NODE_ENV !== 'test') {
  throw new Error('todo-center pending-query gate requires NODE_ENV=test at import (dev-token 404s under production, and the dev-mock-fallback probe needs the non-production branch)')
}
if (process.env.RBAC_CACHE_TTL_MS !== '0') {
  throw new Error('todo-center pending-query gate requires RBAC_CACHE_TTL_MS=0 at import (the 60s process-level permission cache must never serve a stale snapshot to a freshly-seeded viewer)')
}

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  throw new Error('todo-center pending-query gate requires DATABASE_URL; refusing skip-shaped green')
}

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  throw new Error('todo-center pending-query gate requires JWT_SECRET')
}

// Anti-skip-green sentinel (mirrors `approval-wp3-pending-count.api.test.ts`'s own, and the
// `approval-can-decide-current-node.db.test.ts` precedent design-lock §3.0 names): the dedicated
// real-DB CI job arms `EXPECT_DB=1`, so a broken/missing `DATABASE_URL` there REDS the run instead
// of silently skip-greening. Ordinary collection (`EXPECT_DB` unset) skips this cleanly.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

// -------------------------------------------------------------------------------------------
// Fixture plumbing (design-lock §3.0's executable S1–S9 seed order; this file currently seeds
// through S1–S4 and S6–S8 for classes ①②③③′④ only — S5 (`user_namespace_admissions`, class ⑥
// only) and S9 (`approval_reads`, classes ⑫⑬ only) are not needed by these classes and are
// deferred to a later step, along with classes ⑤⑥⑦⑧⑨⑩⑪⑫⑬).
// -------------------------------------------------------------------------------------------
const suffix = randomUUID().slice(0, 8)

/** ①②⑥⑦ share this literal node-key string (design-lock §5 A0, "跨类 node_key 关系写死") — ⑧'s
 *  handler-classified published definition (a later step) uses the SAME string as its handler
 *  node, so the `pd.id = i.published_definition_id` join-key mutation has a live population to
 *  break. Defined here, now, so a later step cannot let the two drift apart. */
const SHARED_SEAT_NODE_KEY = `todo-center-pending-gate-seat-${suffix}`

// Distinct role-name strings for classes ② and ③′ (rather than a shared literal like `'manager'`)
// — both classes hold a `('role', <this string>)` seat, and BOTH classes' `users.role` column is
// ALSO this string (so `resolveApprovalActorRoles` matches its own seat), so had the two classes
// shared one literal, ②'s resolved role would ALSO match ③′'s role-type seat (and vice versa),
// inflating ②'s count to 2 — a fixture cross-contamination bug caught by running this file, not a
// bug in the query under test. Suffixed so distinct test runs (and distinct classes within one
// run) can never collide.
const ROLE_NAME_CLASS_2 = `manager-c2-${suffix}`
const ROLE_NAME_CLASS_3B = `manager-c3b-${suffix}`

function pool(): Pool {
  return poolManager.get()
}

interface ViewerFixture {
  id: string
  email: string
  username: string
  name: string
  role: string
}

function viewer(tag: string, role: string): ViewerFixture {
  const id = `todo-center-pending-gate-${tag}-${suffix}`
  return {
    id,
    email: `${id}@todo-center-pending-gate.test`,
    username: id,
    name: `Todo Center Gate ${tag} ${suffix}`,
    role,
  }
}

// S1 — `permissions('approvals:read')`. `approvals:read` has ZERO registration points repo-wide
// (`git grep -c "'approvals:read'" packages/core-backend/src/db/migrations | awk -F: '$2>0' | wc -l`
// → 0) while `user_permissions.permission_code` carries an FK to `permissions(code)` — inserting a
// `user_permissions` row for it without this INSERT first dies 23503 in `beforeAll`.
async function seedApprovalsReadPermission(): Promise<void> {
  await pool().query(
    `INSERT INTO permissions (code, name, description)
     VALUES ('approvals:read', 'Approvals Read', 'todo-center-pending-gate fixture permission')
     ON CONFLICT (code) DO NOTHING`,
  )
}

// S2 — one `users` row per viewer. Every field the dev-mock fallback's fixed identity
// (`dev@metasheet.com` / `dev-user` / `Development User`) does NOT share, so the per-class
// `/api/auth/me` assertion below can tell "seeded correctly" apart from "silently fell through to
// the mock" (design-lock §3.0's dev-mock-fallback note).
async function seedUser(v: ViewerFixture): Promise<void> {
  await pool().query(
    `INSERT INTO users (id, email, username, name, password_hash, role, is_active, activation_status, local_password_set)
     VALUES ($1, $2, $3, $4, 'x', $5, TRUE, 'activated', TRUE)`,
    [v.id, v.email, v.username, v.name, v.role],
  )
}

// S3 — `user_roles`. `role_id` carries no FK (design-lock §3.0: "⑤ 的 reviewer 可凭空插") so any
// literal role-id string is insertable without a matching `roles` row — except `'admin'`, which
// `rbac/service.ts`'s `isAdmin` reads literally (`role_id = 'admin'`), so THAT literal is load-
// bearing, not arbitrary.
async function seedUserRole(userId: string, roleId: string): Promise<void> {
  await pool().query(
    `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, roleId],
  )
}

// S4 — `user_permissions('approvals:read')`. `/pending-count` guards on `rbacGuard('approvals',
// 'read')`; under this lane's `RBAC_BYPASS=false`/`RBAC_TOKEN_TRUST=false`, a viewer with no grant
// gets 403 before the shared query ever runs — every 200-shaped A0 cell below asserts HTTP 200
// FIRST, precisely so a missing grant cannot silently pass as a 403-vs-403 byte-equal comparison
// (design-lock §5 A0: "403=403 也逐字节相等,空转").
async function grantApprovalsRead(userId: string): Promise<void> {
  await pool().query(
    `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`,
    [userId],
  )
}

// S6 — the three-table published-definition chain (`approval_templates` → `_versions` →
// `_published_definitions`), non-handler shape (empty `runtime_graph`, the default). Each caller
// gets its OWN template (`key` is globally unique) so `idx_approval_published_definitions_active_template`
// (`UNIQUE (template_id) WHERE is_active = TRUE`) never collides across classes.
async function seedNonHandlerPublishedDefinition(tag: string): Promise<string> {
  const templateResult = await pool().query<{ id: string }>(
    `INSERT INTO approval_templates (key, name, status) VALUES ($1, $2, 'published') RETURNING id`,
    [`todo-center-pending-gate-${tag}-${suffix}`, `Todo Center Gate ${tag} Template`],
  )
  const templateId = templateResult.rows[0].id

  const versionResult = await pool().query<{ id: string }>(
    `INSERT INTO approval_template_versions (template_id, version, status) VALUES ($1, 1, 'published') RETURNING id`,
    [templateId],
  )
  const versionId = versionResult.rows[0].id

  const definitionResult = await pool().query<{ id: string }>(
    `INSERT INTO approval_published_definitions (template_id, template_version_id, runtime_graph, is_active)
     VALUES ($1, $2, '{}'::jsonb, TRUE) RETURNING id`,
    [templateId, versionId],
  )
  return definitionResult.rows[0].id
}

interface InstanceFixture {
  id: string
  status: string
  sourceSystem: string
  publishedDefinitionId: string | null
  currentNodeKey: string | null
}

// S7 — `approval_instances`. `id` is `text NOT NULL` with no default (unlike S6's
// `gen_random_uuid()` defaults) and must NOT start with `plm:` (`approval-seat-authorization.ts:190`
// keys its door-selection off that prefix). `org_id` is nullable today but design-lock §3.0 has the
// fixture give it a non-blank value now, ahead of the existence CHECK a later migration adds.
async function seedInstance(fixture: InstanceFixture): Promise<void> {
  await pool().query(
    `INSERT INTO approval_instances (id, status, source_system, published_definition_id, current_node_key, org_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      fixture.id,
      fixture.status,
      fixture.sourceSystem,
      fixture.publishedDefinitionId,
      fixture.currentNodeKey,
      `todo-center-pending-gate-org-${suffix}`,
    ],
  )
}

// S8 — `approval_assignments`. `assignment_type` CHECK restricts to `user`/`role`/`source_queue`;
// `assignee_id` is `NOT NULL`.
async function seedAssignment(opts: {
  instanceId: string
  assignmentType: 'user' | 'role' | 'source_queue'
  assigneeId: string
  nodeKey: string
  isActive?: boolean
}): Promise<void> {
  await pool().query(
    `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, node_key, is_active)
     VALUES ($1, $2, $3, $4, $5)`,
    [opts.instanceId, opts.assignmentType, opts.assigneeId, opts.nodeKey, opts.isActive ?? true],
  )
}

async function devToken(baseUrl: string, userId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(userId)}`)
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { token: string }
  return payload.token
}

interface PendingCountResponse {
  count: number
  unreadCount: number
}

async function fetchPendingCount(
  baseUrl: string,
  token: string,
  sourceSystem?: string,
): Promise<{ status: number; body: PendingCountResponse & { error?: { code: string } } }> {
  const qs = sourceSystem !== undefined ? `?sourceSystem=${encodeURIComponent(sourceSystem)}` : ''
  const response = await fetch(`${baseUrl}/api/approvals/pending-count${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = (await response.json()) as PendingCountResponse & { error?: { code: string } }
  return { status: response.status, body }
}

interface MeResponseUser {
  email?: string
  username?: string
  name?: string
  role?: string
}

async function fetchMe(baseUrl: string, token: string): Promise<MeResponseUser> {
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(response.status).toBe(200)
  const payload = (await response.json()) as { data: { user: MeResponseUser } }
  return payload.data.user
}

describe('todo-center pending-query production-path gate (real DB, dedicated process)', () => {
  let server: MetaSheetServer | undefined
  let baseUrl = ''

  // Class ① — the base shape every other class is a variant of: `users.role='employee'`, no admin
  // `user_roles` row, holds a `('user', id)` seat on a pending platform instance whose published
  // definition does not classify the seat's node as a handler ⇒ count 1 (design-lock §5 A0 ①).
  const v1 = viewer('c1-user-seat', 'employee')
  // Class ② — `users.role='manager'`, no admin row, holds a `('role', 'manager')` seat (same
  // shared node key as ①) ⇒ count 1 (§5 A0 ②).
  const v2 = viewer('c2-role-seat', ROLE_NAME_CLASS_2)
  // Class ③ — `users.role='admin'`, no seat at all ⇒ 0 (negative control: admin does not widen the
  // shared query) (§5 A0 ③).
  const v3 = viewer('c3-admin-no-seat', 'admin')
  // Class ③′ — `users.role='manager'` PLUS an admin `user_roles` row, holding a `('role',
  // 'manager')` seat of its own ⇒ (a) = 0: `resolveRbacProfile`'s admin upgrade REPLACES `role`
  // with `'admin'` rather than unioning it, so the manager-role seat no longer matches
  // `resolveApprovalActorRoles(req)` — a pre-existing, deliberately-unfixed behavior this class
  // pins as-is (§5 A0 ③′; §3.0 "升格是替换,manager 席位丢失").
  const v3b = viewer('c3prime-admin-upgrade-drops-role-seat', ROLE_NAME_CLASS_3B)
  // Class ④ — `users.role='employee'`, no seat at all ⇒ 0 (§5 A0 ④).
  const v4 = viewer('c4-employee-no-seat', 'employee')

  const instance1: InstanceFixture = {
    id: `todo-center-pending-gate-i1-${suffix}`,
    status: 'pending',
    sourceSystem: 'platform',
    publishedDefinitionId: null, // filled in beforeAll
    currentNodeKey: SHARED_SEAT_NODE_KEY,
  }
  const instance2: InstanceFixture = {
    id: `todo-center-pending-gate-i2-${suffix}`,
    status: 'pending',
    sourceSystem: 'platform',
    publishedDefinitionId: null,
    currentNodeKey: SHARED_SEAT_NODE_KEY,
  }
  const instance3b: InstanceFixture = {
    id: `todo-center-pending-gate-i3b-${suffix}`,
    status: 'pending',
    sourceSystem: 'platform',
    publishedDefinitionId: null,
    currentNodeKey: `todo-center-pending-gate-node-3b-${suffix}`,
  }

  const seededUserIds = [v1.id, v2.id, v3.id, v3b.id, v4.id]
  const seededInstanceIds = [instance1.id, instance2.id, instance3b.id]

  beforeAll(async () => {
    await seedApprovalsReadPermission()

    for (const v of [v1, v2, v3, v3b, v4]) {
      await seedUser(v)
      // Design-lock §3.0: "每类都 seed users 行 + user_permissions('approvals:read')" — uniformly,
      // regardless of whether the class is expected to reach the query via the admin fast-path.
      await grantApprovalsRead(v.id)
    }

    // Class ③′'s admin `user_roles` row — the row `isRbacAdmin` reads (`role_id = 'admin'`
    // literally), seeded AFTER the plain S2/S4 seeding above so it reads clearly as the class's
    // distinguishing fixture, not an artifact of shared setup.
    await seedUserRole(v3b.id, 'admin')

    instance1.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c1')
    instance2.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c2')
    instance3b.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c3b')

    await seedInstance(instance1)
    await seedInstance(instance2)
    await seedInstance(instance3b)

    await seedAssignment({
      instanceId: instance1.id,
      assignmentType: 'user',
      assigneeId: v1.id,
      nodeKey: SHARED_SEAT_NODE_KEY,
    })
    await seedAssignment({
      instanceId: instance2.id,
      assignmentType: 'role',
      assigneeId: ROLE_NAME_CLASS_2,
      nodeKey: SHARED_SEAT_NODE_KEY,
    })
    await seedAssignment({
      instanceId: instance3b.id,
      assignmentType: 'role',
      assigneeId: ROLE_NAME_CLASS_3B,
      nodeKey: instance3b.currentNodeKey!,
    })
    // Class ③ and ④ intentionally seed NO assignment and NO instance of their own (design-lock
    // §3.0 S7 note: "③/④ 无席位无实例").

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    await server.start()
    const address = server.getAddress()
    expect(address?.port).toBeTruthy()
    baseUrl = `http://127.0.0.1:${address!.port}`
  })

  afterAll(async () => {
    const p = pool()
    try {
      await p.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [seededInstanceIds])
      await p.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [seededInstanceIds])
      await p.query(
        'DELETE FROM approval_published_definitions WHERE id = ANY($1::uuid[])',
        [[instance1.publishedDefinitionId, instance2.publishedDefinitionId, instance3b.publishedDefinitionId]],
      )
      await p.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [seededUserIds])
      await p.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [seededUserIds])
      await p.query('DELETE FROM users WHERE id = ANY($1::text[])', [seededUserIds])
    } catch {
      // cleanup failures shouldn't mask the test result
    }
    if (server) await server.stop()
  })

  // Design-lock §3.0's dev-mock-fallback probe: an UNSEEDED id, run through the real
  // `/api/auth/me` route, must come back with the mock's fixed identity fields. This is what makes
  // every seeded class's identity assertion below load-bearing — without this probe, a class that
  // was never actually seeded (and silently fell through to the mock) could still pass its
  // `count`/`unreadCount` assertions if the mock's `role:'admin'`+`['*:*']` also happens to satisfy
  // them (as it would for classes ③/④, both expecting 0).
  it('probe: an unseeded id hitting /api/auth/me gets the dev-mock fallback identity (proves the mock is reachable and distinguishable from a seeded row)', async () => {
    const unseededId = `todo-center-pending-gate-unseeded-${suffix}`
    const token = await devToken(baseUrl, unseededId)
    const user = await fetchMe(baseUrl, token)
    expect(user.email).toBe('dev@metasheet.com')
    expect(user.username).toBe('dev-user')
    expect(user.name).toBe('Development User')
  })

  describe('A0 — shared query golden values (?sourceSystem=all, the real badge/center request shape)', () => {
    it('class ① — user seat, pending, published, non-handler node ⇒ count 1', async () => {
      const token = await devToken(baseUrl, v1.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v1.email)
      expect(me.username).toBe(v1.username)
      expect(me.name).toBe(v1.name)

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(1)
      expect(body.unreadCount).toBe(1)
    })

    it('class ① — ?sourceSystem=plm excludes the platform-sourced instance ⇒ count 0, unreadCount 0', async () => {
      const token = await devToken(baseUrl, v1.id)
      const { status, body } = await fetchPendingCount(baseUrl, token, 'plm')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(0)
      expect(body.unreadCount).toBe(0)
    })

    it('class ① — ?sourceSystem=bogus is rejected with 400 + APPROVAL_SOURCE_SYSTEM_INVALID', async () => {
      const token = await devToken(baseUrl, v1.id)
      const { status, body } = await fetchPendingCount(baseUrl, token, 'bogus')
      expect(status).toBe(400)
      expect(body.error?.code).toBe('APPROVAL_SOURCE_SYSTEM_INVALID')
    })

    it('class ② — role seat (manager), pending, published, non-handler node ⇒ count 1', async () => {
      const token = await devToken(baseUrl, v2.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v2.email)
      expect(me.username).toBe(v2.username)
      expect(me.name).toBe(v2.name)

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(1)
      expect(body.unreadCount).toBe(1)
    })

    it('class ③ — admin, no seat ⇒ 0 (negative control: admin does not widen the shared query)', async () => {
      const token = await devToken(baseUrl, v3.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v3.email)
      expect(me.username).toBe(v3.username)
      expect(me.name).toBe(v3.name)

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(0)
      expect(body.unreadCount).toBe(0)
    })

    it('class ③′ — manager role seat, but an admin user_roles row upgrades (a)\'s role and DROPS the manager seat match ⇒ 0', async () => {
      const token = await devToken(baseUrl, v3b.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v3b.email)
      expect(me.username).toBe(v3b.username)
      expect(me.name).toBe(v3b.name)
      // The admin-upgrade REPLACES `role`, so the resolved identity must read back as 'admin', not
      // the seeded 'manager' — this is the exact mechanism §5 A0 ③′ pins.
      expect(me.role).toBe('admin')

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(0)
      expect(body.unreadCount).toBe(0)
    })

    it('class ④ — employee, no seat ⇒ 0', async () => {
      const token = await devToken(baseUrl, v4.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v4.email)
      expect(me.username).toBe(v4.username)
      expect(me.name).toBe(v4.name)

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(0)
      expect(body.unreadCount).toBe(0)
    })
  })
})
