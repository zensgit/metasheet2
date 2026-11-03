/**
 * Residual sweep (NIT-2, gate finding `/tmp/lock9-gate-20260822.md` §NIT-2) — the ONE
 * actor-roles resolver, shared by `routes/approvals.ts`, `routes/todo.ts`,
 * `approval-attachment-runtime.ts` and the cancel-round entry port.
 *
 * Prior to this extraction, the SAME body (a `req.user.role` singular claim unioned with the
 * `req.user.roles` array claim, deduplicated) was defined twice — once in `routes/approvals.ts`
 * (`resolveApprovalActorRoles`, 18 call sites) and once in `approval-attachment-runtime.ts`
 * (`resolveActorRolesFromRequest`, 1 call site, whose own docblock recorded the duplication as
 * deliberate "to avoid a new cross-module export"). The two bodies had already drifted lexically
 * (`(role)` vs `(r)` as the filter-callback parameter name) though never behaviourally — the
 * residual-sweep judgement is that a text-parity test would itself be a source-text assertion
 * (`feedback_source_text_assertions_are_not_behaviour`: the normaliser can be deleted along with
 * the drift it polices), so this extraction removes the SECOND definition instead, making drift
 * impossible by construction rather than merely detected.
 *
 * ### Role set = request claims ∪ `users.role` ∪ `user_roles.role_id`
 *
 * Role-typed approval seats store a ROLE ID (`ApprovalAssigneeResolver` pushes `('role', roleId)`).
 * In production the request carries only one role (`req.user.role`, built by
 * `AuthService.resolveRbacProfile` from the `users.role` column and replaced by `'admin'` when a
 * `user_roles` admin row exists) and no `roles` array, so a user granted a role ONLY through a
 * `user_roles` row never matched that role's seats: the pending tab, the badge / todo count, the
 * todo center and the decision gate all missed them.
 *
 * `resolveApprovalActorRoles` now unions the request claims with the actor's role ids read from the
 * database: the `users.role` column and every `user_roles.role_id` row. ROLE IDS ONLY — the `roles`
 * table is not joined and role NAMES never enter the set, so a seat whose assignee string happens
 * to equal some role's display name does not match a holder of that role.
 *
 * ONE SOURCE for gate and surfaces: every approval-domain consumer that decides "can this actor act
 * / does this count as theirs" (the decision door, the pending tab filter, `/pending-count`, the
 * todo center's approval source, `canDecideCurrentNode`, batch actions, the attachment seat check,
 * the count pushes) reads THIS function, so no surface can be wider than the gate.
 *
 * FAIL CLOSED by surfacing the error: the database read THROWS on failure; nothing here swallows it
 * into a narrower set. Each surface's own error path then reports it (route 500, the todo source's
 * `unavailable`), and no decision is ever taken on a partial role set. This follows the todo-center
 * rule that the shared pending query's resolver must not turn a read failure into an empty set.
 *
 * Memoized per request: several consumers of one request (e.g. an action plus its count push) share
 * one read.
 *
 * Leaf on purpose: a `services/` module must not import from `routes/`, and `routes/approvals.ts`
 * already imports from `services/` (e.g. `ApprovalProductService`), so placing the shared helper
 * here keeps the existing edge direction and introduces no import cycle.
 */
import type { Request } from 'express'
import { query as defaultQuery } from '../db/pg'

/** Minimal query surface — a pool wrapper or a checked-out client both satisfy it. */
export interface ApprovalRoleQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>
}

const defaultQueryable: ApprovalRoleQueryable = {
  query: (sql, params) => defaultQuery(sql, params),
}

/** Deduplicated role CLAIMS on the request — the `req.user.role` singular claim (if present) unioned
 *  with the `req.user.roles` array claim (string entries only, non-empty). No database read. */
export function resolveApprovalActorRoleClaims(req: Request): string[] {
  const role = typeof req.user?.role === 'string' && req.user.role.trim().length > 0
    ? [req.user.role.trim()]
    : []
  const roles = Array.isArray(req.user?.roles)
    ? req.user!.roles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : []
  return Array.from(new Set([...role, ...roles]))
}

/**
 * The actor's role ids as stored: the `users.role` column ∪ every `user_roles.role_id` row (trimmed,
 * blanks dropped, deduplicated, ids only). THROWS on a read failure — callers must not convert that
 * into an empty or narrower set.
 */
export async function loadApprovalUserRoleIds(
  userId: string,
  db: ApprovalRoleQueryable = defaultQueryable,
): Promise<string[]> {
  const id = typeof userId === 'string' ? userId.trim() : ''
  if (!id) return []
  const roles = new Set<string>()
  const userResult = await db.query('SELECT role FROM users WHERE id = $1', [id])
  const column = (userResult.rows[0] as { role?: unknown } | undefined)?.role
  if (typeof column === 'string' && column.trim()) roles.add(column.trim())
  const roleRows = await db.query('SELECT role_id FROM user_roles WHERE user_id = $1', [id])
  for (const row of roleRows.rows as Array<{ role_id?: unknown }>) {
    if (typeof row.role_id === 'string' && row.role_id.trim()) roles.add(row.role_id.trim())
  }
  return [...roles]
}

function resolveRequestActorId(req: Request): string | null {
  const candidate = req.user?.id ?? req.user?.userId ?? (req.user as { sub?: unknown } | undefined)?.sub
  if (typeof candidate !== 'string') return null
  const normalized = candidate.trim()
  return normalized.length > 0 ? normalized : null
}

const perRequestRoles = new WeakMap<Request, Promise<string[]>>()

/**
 * The approval actor's role set: request claims ∪ `users.role` ∪ `user_roles.role_id` (see the
 * module docblock). Rejects when the database read fails.
 */
export function resolveApprovalActorRoles(req: Request): Promise<string[]> {
  const cached = perRequestRoles.get(req)
  if (cached) return cached
  const claims = resolveApprovalActorRoleClaims(req)
  const actorId = resolveRequestActorId(req)
  const pending = actorId
    ? loadApprovalUserRoleIds(actorId).then((stored) => Array.from(new Set([...claims, ...stored])))
    : Promise.resolve(claims)
  perRequestRoles.set(req, pending)
  return pending
}

/**
 * The role set a count PUSH computes a recipient's badge with, for a recipient who is not the
 * requesting actor (no request claims are available for them). Without trusted token claims a
 * user's own `resolveApprovalActorRoles` is exactly `users.role` ∪ `user_roles.role_id` (the
 * `'admin'` upgrade on the request comes from a `user_roles` row that set already contains), so the
 * pushed number matches that user's own `GET /api/todo/count` / `/pending-count`. THROWS on a read
 * failure: the caller must skip that recipient's push rather than push a narrower number.
 */
export function resolveApprovalPushRecipientRoles(
  userId: string,
  db: ApprovalRoleQueryable = defaultQueryable,
): Promise<string[]> {
  return loadApprovalUserRoleIds(userId, db)
}

/**
 * The ONE template-manager ("admin") determination for approval template visibility. It reads the
 * request's role CLAIMS only (`resolveApprovalActorRoleClaims`, which already carries the
 * `req.user.role` value) plus the permission codes — never the widened stored role set, so adding
 * `user_roles` ids to role-seat matching cannot change who is treated as a template manager on any
 * entry (list, detail, categories, create, preview, route-preview, attachment upload).
 */
export function isApprovalTemplateManager(
  adminRoleClaims: readonly string[],
  permissions: readonly string[],
): boolean {
  return adminRoleClaims.includes('admin')
    || permissions.includes('*:*')
    || permissions.includes('approvals:*')
    || permissions.includes('approvals:admin-templates')
    || permissions.includes('approval-templates:manage')
}
