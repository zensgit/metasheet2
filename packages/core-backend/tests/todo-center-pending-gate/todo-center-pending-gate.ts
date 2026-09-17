/**
 * todo-center-design-lock v2.14 §3.0/§5 — the shared "pending" query production-path gate.
 *
 * Judging criterion A0: with `RBAC_BYPASS=false` / `RBAC_TOKEN_TRUST=false` (the DEFAULT
 * integration harness runs with BOTH true, so `/dev-token`'s `roles=`/`perms=` become the actor's
 * identity directly and the production role-resolution axis — `users.role`, the admin-upgrade
 * REPLACEMENT semantics in `AuthService.resolveRbacProfile`, `user_roles`/`user_permissions` reads
 * — is never exercised there), `GET /api/approvals/pending-count` must return the fourteen
 * lock-mandated golden values in §5's A0 row for the fourteen viewer classes (①②③③′④⑤⑥⑦⑧⑨⑩⑪⑫⑬). This
 * step adds class ⑨; ⑩⑪⑫⑬ remain deferred (see the fixture-plumbing docblock below).
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
// through S1–S8 for classes ①②③③′④⑤⑥⑦⑧⑨ — S9 (`approval_reads`, classes ⑫⑬ only) is not needed by
// these classes and is deferred to a later step, along with classes ⑩⑪⑫⑬).
// -------------------------------------------------------------------------------------------
const suffix = randomUUID().slice(0, 8)

/** ①②⑥⑦ share this literal node-key string (design-lock §5 A0, "跨类 node_key 关系写死") — ⑧'s
 *  handler-classified published definition (below) uses the SAME string as its handler node, so the
 *  `pd.id = i.published_definition_id` join-key mutation has a live population to break: dropping
 *  that join key lets ⑧'s handler definition match ①②⑥⑦'s instances by `node_key` alone, wrongly
 *  excluding all four, not just flipping ⑧ itself. */
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

// Class ⑤'s `user_roles.role_id` value. Unlike `'admin'` (load-bearing literal `isRbacAdmin`
// reads) this string is arbitrary — `role_id` carries no FK (design-lock §3.0) — but it is
// suffixed anyway, consistent with every other fixture value in this file, so no two runs (or two
// classes within one run) can ever collide on it.
const ROLE_NAME_CLASS_5 = `reviewer-c5-${suffix}`

// Class ⑥'s `user_roles.role_id` value is NOT arbitrary like ⑤'s: `attendance_approver` is a
// migration-seeded role (`zzzz20260208100000_create_roles_table.ts`) whose `role_permissions` row
// (`attendance:approve`) is what makes `namespace-admission.ts`'s `fetchUserNamespaceRoleContext`
// resolve `'attendance'` into `controlledNamespaces` in the first place — a fixture-invented role id
// would leave that set empty and `filterPermissionCodesByNamespaceAdmission` would strip
// `attendance:approve` right back out regardless of the admission row below. Confirmed present in
// this suite's own DB (not inferred from migration source): `role_permissions` holds
// `('attendance_approver','attendance:approve')` and `permissions` holds `'attendance:approve'`.
const ROLE_ID_CLASS_6_ATTENDANCE_APPROVER = 'attendance_approver'
const NAMESPACE_ADMISSION_CLASS_6 = 'attendance'

// **Deliberate, flagged divergence from the lock's literal wording — surfaced for the Opus gate,
// not silently absorbed.** §5 A0 ⑥ writes the seat as `('source_queue','attendance:approve')`,
// the REAL production permission code. Seeding it verbatim collides with an UNRELATED class this
// same file also seeds: class ③′'s viewer holds a genuine `user_roles('admin')` row (load-bearing
// for a DIFFERENT reason — the role-upgrade-replaces-not-unions bug §5 A0 ③′ pins), and
// `filterPermissionCodesByNamespaceAdmission`'s admin fast path (`namespace-admission.ts:369`,
// `if (roleContext.isAdmin) return normalizedCodes`) hands ANY `user_roles('admin')` holder every
// one of admin's `role_permissions` codes UNFILTERED — confirmed in this suite's own DB
// (`SELECT permission_code FROM role_permissions WHERE role_id='admin' AND permission_code LIKE
// 'attendance%'` → includes `attendance:approve`). So with the literal code, class ③′'s viewer
// would ALSO match this class's `source_queue` seat via the query's PERMISSIONS arm (`$3`) —
// discovered empirically: seeding it verbatim turned ③′'s golden `0` into `1` while leaving every
// other already-passing class green, isolating the interaction to exactly this pair. That is not a
// fixture ordering bug to paper over with test isolation (which would make every class's golden
// value depend on which OTHER classes happen to be seeded, the opposite of what §3.0's "seed all
// fourteen once" order is for) — it is the admin bypass genuinely, correctly extending to ANY
// permission-keyed `source_queue` item, including this one.
//
// Fix: keep the MECHANISM verbatim (⑥'s `attendance:approve` visibility comes from
// `attendance_approver` role + `user_namespace_admissions`, never `user_permissions` directly —
// the exact thing §3.0's "v2.6 写「不用 user_roles」是错的" correction pins) but use a
// fixture-owned, per-run-suffixed code in the SAME `attendance` namespace as the `source_queue`
// seat's `assignee_id`, added as a SECOND `role_permissions` row on the same
// `attendance_approver` role (alongside its existing real mapping, not replacing it) — so
// `derivePermissionNamespace` still resolves `'attendance'`, `controlledNamespaces`/the admission
// gate are still exercised identically for ⑥'s own (non-admin) viewer, but no OTHER role's
// `role_permissions` (in particular `admin`'s) happens to already list this exact string. What
// this does NOT decide: whether real admins SHOULD count real attendance-sourced source_queue
// items in production today — that is a live product-behavior question, not a fixture concern,
// and is left for the platform-authorization line (§7-6 territory), not adjudicated here.
const SOURCE_QUEUE_PERMISSION_CODE_CLASS_6 = `attendance:approve-c6-${suffix}`

// FORWARD NOTE for whichever step adds class ⑪ (its own instance, `('user', id)` PLUS
// `('role','employee')` on itself): design-lock §5 A0 writes ⑪'s role seat as the bare literal
// `'employee'`. Every OTHER `users.role='employee'` class already seeded here (①④⑤⑥, and later
// ⑦⑨⑩⑫⑬) resolves `resolveApprovalActorRoles(req)` to `['employee']` too — seeding ⑪'s role-type
// seat as literal `'employee'` would therefore match ALL of their `('role', $2)` arms, inflating ①
// 1→2, ④ 0→1, ⑥ 1→2, exactly the ②/③′ cross-contamination class this file's own `ROLE_NAME_CLASS_2`
// comment (above) already worked around. ⑪ MUST use its own suffixed role string for BOTH its
// `users.role` column and its `('role', <string>)` seat's `assignee_id` (mirroring `ROLE_NAME_CLASS_2`
// / `ROLE_NAME_CLASS_3B`), never the bare `'employee'` literal, even though the lock text writes it
// unsuffixed — `git grep -n "'employee'"` under `src/` turns up no RBAC-load-bearing read of that
// exact string (unlike `role_id='admin'`), so suffixing it changes nothing the query under test
// reads.

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

// S5 — `user_namespace_admissions('attendance', enabled)`. Class ⑥ only (design-lock §3.0).
// `listUserPermissions` (`rbac/service.ts:97`) pipes its merged `user_permissions ∪ role_permissions`
// result through `filterPermissionCodesByNamespaceAdmission` (`namespace-admission.ts:356-377`),
// which — for any permission code whose namespace (`split_part(code, ':', 1)`) is admission-
// controlled — keeps the code ONLY if this table has an `enabled=true` row for that namespace.
// Without this row, ⑥'s `attendance:approve` grant (via the `attendance_approver` role) is silently
// stripped and `req.user.permissions` never carries it, so `resolveApprovalActorPermissions`'s
// `source_queue` arm (`$3`) has nothing to match — the fixture would read as ⑤-shaped (0), not ⑥'s.
async function seedNamespaceAdmission(userId: string, namespace: string): Promise<void> {
  await pool().query(
    `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source)
     VALUES ($1, $2, TRUE, 'todo-center-pending-gate-fixture')`,
    [userId, namespace],
  )
}

// Fixture-owned second `role_permissions` mapping on the real `attendance_approver` role (see the
// `SOURCE_QUEUE_PERMISSION_CODE_CLASS_6` docblock above for why this exists instead of the literal
// `attendance:approve`). `permissions` row first — `role_permissions.permission_code` carries an FK
// to it (`role_permissions_permission_code_fkey`), same ordering constraint S1 already documents for
// `approvals:read`. ADDITIVE: the role's existing two real rows (`attendance:read`/`attendance:approve`)
// are untouched; only this one new row is inserted, and only this one is removed in `afterAll`.
async function seedClass6SourceQueuePermission(): Promise<void> {
  await pool().query(
    `INSERT INTO permissions (code, name, description)
     VALUES ($1, 'Todo Center Gate Class 6 Fixture', 'todo-center-pending-gate fixture permission (class 6 source_queue seat)')
     ON CONFLICT (code) DO NOTHING`,
    [SOURCE_QUEUE_PERMISSION_CODE_CLASS_6],
  )
  await pool().query(
    `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [ROLE_ID_CLASS_6_ATTENDANCE_APPROVER, SOURCE_QUEUE_PERMISSION_CODE_CLASS_6],
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

// S6 (⑧'s variant) — same three-table chain as `seedNonHandlerPublishedDefinition` above, but
// `runtime_graph` classifies `nodeKey` as a `handler` node: `{"nodes":[{"key":<nodeKey>,
// "type":"handler"}]}`, matching production `buildRuntimeGraph`
// (`ApprovalProductService.ts:6247→:4496-4504`, `types/approval-product.ts:677-680`) so the
// `@>` containment test in `handlerNodeExclusionCondition` (`approval-pending-query.ts:74-80`)
// actually fires. Own template/version (globally-unique `key`, per `seedNonHandlerPublishedDefinition`'s
// own comment) — no need to share a template with another class's definition and juggle the
// `UNIQUE (template_id) WHERE is_active = TRUE` constraint (design-lock §3.0 S6), since a fresh
// template's first (and only) definition can stay `is_active = TRUE`.
async function seedHandlerPublishedDefinition(tag: string, nodeKey: string): Promise<string> {
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

  const runtimeGraph = JSON.stringify({ nodes: [{ key: nodeKey, type: 'handler' }] })
  const definitionResult = await pool().query<{ id: string }>(
    `INSERT INTO approval_published_definitions (template_id, template_version_id, runtime_graph, is_active)
     VALUES ($1, $2, $3::jsonb, TRUE) RETURNING id`,
    [templateId, versionId, runtimeGraph],
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
  // Class ⑤ — `users.role='employee'`, `user_roles` holds a NON-admin `reviewer` role, holding a
  // `('role', 'reviewer')` seat on its own pending platform instance ⇒ (a) = 0: (a)'s role source
  // is `users.role` (+ admin upgrade) ONLY, never `user_roles`, so a role held solely via
  // `user_roles` is invisible to the shared query under (a) — a pre-existing, deliberately-
  // unfixed, record-only behavior this class pins as-is (§5 A0 ⑤; §3.0 "记录性:(b) 会是 1,这就
  // 是 (b) 的加宽人口,也是 actionable 与门分叉的人口").
  const v5 = viewer('c5-reviewer-role-seat', 'employee')
  // Class ⑥ — `users.role='employee'`, `user_roles` holds the migration-seeded, non-admin
  // `attendance_approver` role (granting `attendance:approve` via `role_permissions`, admitted
  // through `user_namespace_admissions('attendance', enabled)`), holding a `('source_queue',
  // 'attendance:approve')` seat (same shared node key as ①) on a pending platform instance whose
  // published definition does not classify the seat's node as a handler ⇒ count 1: the query's
  // third arm (`$3`, `resolveApprovalActorPermissions`) matches `source_queue` assignments against
  // the viewer's PERMISSIONS, not roles — this is the "①计入、核心门拒绝" divergence §1.5/§7-2″
  // documents (list-side `actionable=false` is judging criterion C′, not A0; A0 only counts) (§5 A0
  // ⑥).
  const v6 = viewer('c6-source-queue-seat', 'employee')
  // Class ⑦ — same viewer/seat shape as ①, but its instance's `published_definition_id` is
  // literally NULL (never filled via `seedNonHandlerPublishedDefinition`, unlike every other class
  // here) ⇒ count 1: the handler-node exclusion is `NOT EXISTS (SELECT 1 FROM
  // approval_published_definitions pd WHERE pd.id = i.published_definition_id AND ...)`, and `pd.id
  // = NULL` never matches any row, so `NOT EXISTS` is TRUE — a NULL/dangling definition is INCLUDED,
  // not excluded (design-lock §5 A0 ⑦; mutation "EXISTS 已发布定义" would flip this to 0, red).
  // Shares `SHARED_SEAT_NODE_KEY` with ①②⑥ — this is deliberate (§5 A0 "跨类 node_key 关系写死"): a
  // later step's class ⑧ handler-classified definition targets that SAME node key, so the
  // `pd.id = i.published_definition_id` join-key mutation has ①②⑥⑦ to wrongly exclude, not just ⑧
  // itself.
  const v7 = viewer('c7-null-published-definition', 'employee')
  // Class ⑧ — same viewer/seat shape as ①, but its instance's published definition classifies the
  // seat's node (`SHARED_SEAT_NODE_KEY`) as a `handler` node ⇒ count 0: the handler-node exclusion
  // (`NOT EXISTS ... type = 'handler'`) is now FALSE for this row, so it never qualifies (design-
  // lock §5 A0 ⑧). The "flip `NOT EXISTS` to `EXISTS 已发布定义`" mutation is ONE code change with
  // TWO directions of wrongness on the SAME `NOT EXISTS` clause — ⑦'s NULL/dangling row would then
  // wrongly become excluded (1→0) while ⑧'s handler row would wrongly become included (0→1); the
  // lock requires both classes be re-checked under that one mutation, not just one of them.
  const v8 = viewer('c8-handler-node-excluded', 'employee')
  // Class ⑨ — same viewer/seat shape as ①, but its instance's `status` is `'approved'`, not
  // `'pending'` ⇒ count 0: the query's second WHERE conjunct is `i.status = 'pending'` literally —
  // any other status (closed, terminal, or otherwise) never qualifies, regardless of the seat/
  // handler-node conditions (design-lock §5 A0 ⑨; mutation "drop the status conjunct" would flip
  // this to 1, red). Shares `SHARED_SEAT_NODE_KEY` with ①②⑥⑦⑧ (consistent with every other class in
  // this file using the one shared node key where the lock does not require a distinct one).
  const v9 = viewer('c9-approved-status', 'employee')

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
  // Class ⑤'s own instance (design-lock §3.0 S7: "③′/⑤ 需要实例 … 但定义形状随意") — a distinct
  // node key from `SHARED_SEAT_NODE_KEY` (⑤ is not part of the ①②⑥⑦-vs-⑧ join-key population).
  const instance5: InstanceFixture = {
    id: `todo-center-pending-gate-i5-${suffix}`,
    status: 'pending',
    sourceSystem: 'platform',
    publishedDefinitionId: null, // filled in beforeAll
    currentNodeKey: `todo-center-pending-gate-node-5-${suffix}`,
  }
  // Class ⑥'s own instance, shared node key with ①②⑦ (design-lock §5 A0 "跨类 node_key 关系写死":
  // ①②⑥⑦ 的席位 node_key 与 ⑧ 的 handler 节点键同串).
  const instance6: InstanceFixture = {
    id: `todo-center-pending-gate-i6-${suffix}`,
    status: 'pending',
    sourceSystem: 'platform',
    publishedDefinitionId: null, // filled in beforeAll
    currentNodeKey: SHARED_SEAT_NODE_KEY,
  }
  // Class ⑦'s own instance — `publishedDefinitionId` is left `null` HERE, on purpose, and is never
  // assigned in `beforeAll` (unlike instance1/2/3b/5/6 above, whose `null` is only a placeholder
  // overwritten by `seedNonHandlerPublishedDefinition`). Shared node key with ①②⑥ (see `v7`'s
  // docblock).
  const instance7: InstanceFixture = {
    id: `todo-center-pending-gate-i7-${suffix}`,
    status: 'pending',
    sourceSystem: 'platform',
    publishedDefinitionId: null,
    currentNodeKey: SHARED_SEAT_NODE_KEY,
  }
  // Class ⑧'s own instance — published definition is the HANDLER-classified one (built in
  // `beforeAll` via `seedHandlerPublishedDefinition`), current node key = `SHARED_SEAT_NODE_KEY`,
  // shared with ①②⑥⑦ (design-lock §5 A0 "跨类 node_key 关系写死": see `v8`'s docblock and
  // `SHARED_SEAT_NODE_KEY`'s own docblock above for why this must stay the SAME string, not a
  // distinct one).
  const instance8: InstanceFixture = {
    id: `todo-center-pending-gate-i8-${suffix}`,
    status: 'pending',
    sourceSystem: 'platform',
    publishedDefinitionId: null, // filled in beforeAll (the HANDLER definition, not the non-handler helper)
    currentNodeKey: SHARED_SEAT_NODE_KEY,
  }
  // Class ⑨'s own instance — `status='approved'` (NOT `'pending'`), the only field that
  // distinguishes it from instance1's shape. Non-handler published definition, shared node key with
  // ①②⑥⑦⑧ (see `v9`'s docblock).
  const instance9: InstanceFixture = {
    id: `todo-center-pending-gate-i9-${suffix}`,
    status: 'approved',
    sourceSystem: 'platform',
    publishedDefinitionId: null, // filled in beforeAll
    currentNodeKey: SHARED_SEAT_NODE_KEY,
  }

  const seededUserIds = [v1.id, v2.id, v3.id, v3b.id, v4.id, v5.id, v6.id, v7.id, v8.id, v9.id]
  const seededInstanceIds = [instance1.id, instance2.id, instance3b.id, instance5.id, instance6.id, instance7.id, instance8.id, instance9.id]

  beforeAll(async () => {
    await seedApprovalsReadPermission()

    for (const v of [v1, v2, v3, v3b, v4, v5, v6, v7, v8, v9]) {
      await seedUser(v)
      // Design-lock §3.0: "每类都 seed users 行 + user_permissions('approvals:read')" — uniformly,
      // regardless of whether the class is expected to reach the query via the admin fast-path.
      await grantApprovalsRead(v.id)
    }

    // Class ③′'s admin `user_roles` row — the row `isRbacAdmin` reads (`role_id = 'admin'`
    // literally), seeded AFTER the plain S2/S4 seeding above so it reads clearly as the class's
    // distinguishing fixture, not an artifact of shared setup.
    await seedUserRole(v3b.id, 'admin')
    // Class ⑤'s NON-admin `user_roles` row — (a) never reads `user_roles` for role resolution, so
    // this row is exactly what the class is pinning as invisible under (a).
    await seedUserRole(v5.id, ROLE_NAME_CLASS_5)
    // Class ⑥'s NON-admin, migration-seeded `attendance_approver` row (also invisible to (a)'s
    // `users.role`-only role resolution, same as ⑤ — but ⑥ reaches the query through the
    // PERMISSIONS arm, not the role arm, so that invisibility does not zero it out the way it does
    // ⑤). Its `user_namespace_admissions` row is what keeps `attendance:approve` surviving
    // `filterPermissionCodesByNamespaceAdmission` — seeded together, right after, so both halves of
    // ⑥'s distinguishing fixture read as one unit.
    await seedUserRole(v6.id, ROLE_ID_CLASS_6_ATTENDANCE_APPROVER)
    await seedNamespaceAdmission(v6.id, NAMESPACE_ADMISSION_CLASS_6)
    await seedClass6SourceQueuePermission()

    instance1.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c1')
    instance2.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c2')
    instance3b.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c3b')
    instance5.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c5')
    instance6.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c6')
    // Class ⑧'s definition classifies `SHARED_SEAT_NODE_KEY` as a handler node — the ONLY call to
    // `seedHandlerPublishedDefinition` in this file.
    instance8.publishedDefinitionId = await seedHandlerPublishedDefinition('c8', SHARED_SEAT_NODE_KEY)
    instance9.publishedDefinitionId = await seedNonHandlerPublishedDefinition('c9')

    await seedInstance(instance1)
    await seedInstance(instance2)
    await seedInstance(instance3b)
    await seedInstance(instance5)
    await seedInstance(instance6)
    // instance7's `published_definition_id` is left NULL — no `seedNonHandlerPublishedDefinition`
    // call for it, on purpose (class ⑦'s whole point, see its docblock above).
    await seedInstance(instance7)
    await seedInstance(instance8)
    await seedInstance(instance9)

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
    await seedAssignment({
      instanceId: instance5.id,
      assignmentType: 'role',
      assigneeId: ROLE_NAME_CLASS_5,
      nodeKey: instance5.currentNodeKey!,
    })
    await seedAssignment({
      instanceId: instance6.id,
      assignmentType: 'source_queue',
      assigneeId: SOURCE_QUEUE_PERMISSION_CODE_CLASS_6,
      nodeKey: SHARED_SEAT_NODE_KEY,
    })
    await seedAssignment({
      instanceId: instance7.id,
      assignmentType: 'user',
      assigneeId: v7.id,
      nodeKey: SHARED_SEAT_NODE_KEY,
    })
    await seedAssignment({
      instanceId: instance8.id,
      assignmentType: 'user',
      assigneeId: v8.id,
      nodeKey: SHARED_SEAT_NODE_KEY,
    })
    await seedAssignment({
      instanceId: instance9.id,
      assignmentType: 'user',
      assigneeId: v9.id,
      nodeKey: SHARED_SEAT_NODE_KEY,
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
        [[
          instance1.publishedDefinitionId,
          instance2.publishedDefinitionId,
          instance3b.publishedDefinitionId,
          instance5.publishedDefinitionId,
          instance6.publishedDefinitionId,
          instance8.publishedDefinitionId,
          instance9.publishedDefinitionId,
        ]],
      )
      await p.query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [seededUserIds])
      await p.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [seededUserIds])
      // `user_namespace_admissions.user_id` cascades on `users` delete (migration
      // `zzzz20260411120000`), but deleted explicitly anyway, consistent with every other table in
      // this cleanup relying on its own `WHERE ... = ANY($1)` rather than cascade alone.
      await p.query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [seededUserIds])
      await p.query('DELETE FROM users WHERE id = ANY($1::text[])', [seededUserIds])
      // The class ⑥ fixture-owned second `role_permissions` row on the REAL `attendance_approver`
      // role (see `SOURCE_QUEUE_PERMISSION_CODE_CLASS_6` docblock) — scoped precisely to this one
      // added row, leaving the role's two pre-existing real mappings untouched. `permissions`
      // second (its FK cascades this row too, but explicit, same idiom as the rest of this block).
      await p.query('DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = $2', [
        ROLE_ID_CLASS_6_ATTENDANCE_APPROVER,
        SOURCE_QUEUE_PERMISSION_CODE_CLASS_6,
      ])
      await p.query('DELETE FROM permissions WHERE code = $1', [SOURCE_QUEUE_PERMISSION_CODE_CLASS_6])
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

    it('class ⑤ — user_roles-only reviewer role seat is invisible under (a) (role source is users.role only, not user_roles) ⇒ 0', async () => {
      const token = await devToken(baseUrl, v5.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v5.email)
      expect(me.username).toBe(v5.username)
      expect(me.name).toBe(v5.name)
      // (a) resolves role from `users.role` only — v5 was NOT given an admin `user_roles` row, so
      // no upgrade fires and `/me` reads back the seeded 'employee', not 'admin' (unlike ③′).
      expect(me.role).toBe('employee')

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(0)
      expect(body.unreadCount).toBe(0)
    })

    // NOTE (flagged divergence, see `SOURCE_QUEUE_PERMISSION_CODE_CLASS_6`'s docblock above): this
    // seat's `assignee_id` is a fixture-owned code, not the literal `attendance:approve` §5 A0 ⑥
    // writes — the literal collides with class ③′'s admin-upgraded viewer via the RBAC admin
    // bypass. The MECHANISM (attendance_approver role + namespace admission, not user_permissions)
    // is unchanged.
    it('class ⑥ — attendance source_queue seat counts under (a)+admission (permissions arm, not role arm) ⇒ 1', async () => {
      const token = await devToken(baseUrl, v6.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v6.email)
      expect(me.username).toBe(v6.username)
      expect(me.name).toBe(v6.name)
      // The `attendance_approver` user_roles row is non-admin, so — same discriminator as ⑤ — no
      // upgrade fires and `/me` reads back the seeded 'employee', proving this class's count (below)
      // is NOT coming from an accidental admin fast-path.
      expect(me.role).toBe('employee')

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(1)
      expect(body.unreadCount).toBe(1)
    })

    it('class ⑦ — user seat, pending, NULL published_definition_id (handler exclusion NOT EXISTS is inclusive) ⇒ count 1', async () => {
      const token = await devToken(baseUrl, v7.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v7.email)
      expect(me.username).toBe(v7.username)
      expect(me.name).toBe(v7.name)
      expect(me.role).toBe('employee')

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(1)
      expect(body.unreadCount).toBe(1)
    })

    it('class ⑧ — user seat, pending, but the seat\'s node is classified handler ⇒ count 0 (handler exclusion active)', async () => {
      const token = await devToken(baseUrl, v8.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v8.email)
      expect(me.username).toBe(v8.username)
      expect(me.name).toBe(v8.name)
      expect(me.role).toBe('employee')

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(0)
      expect(body.unreadCount).toBe(0)
    })

    it('class ⑨ — user seat shape identical to ①, but the instance status is \'approved\' not \'pending\' ⇒ count 0', async () => {
      const token = await devToken(baseUrl, v9.id)
      const me = await fetchMe(baseUrl, token)
      expect(me.email).toBe(v9.email)
      expect(me.username).toBe(v9.username)
      expect(me.name).toBe(v9.name)
      expect(me.role).toBe('employee')

      const { status, body } = await fetchPendingCount(baseUrl, token, 'all')
      expect(status).toBe(200)
      expect(body).toHaveProperty('count')
      expect(body.count).toBe(0)
      expect(body.unreadCount).toBe(0)
    })
  })
})
