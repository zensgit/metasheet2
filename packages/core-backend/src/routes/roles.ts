import type { Request, Response} from 'express';
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { hasLegacyAdminClaim } from '../rbac/platform-admin'
import { auditLog } from '../audit/audit'
import { pool, transaction } from '../db/pg'
import { invalidateUserPerms, isAdmin, userHasPermission } from '../rbac/service'
import { sendIfRecoveryConflict } from '../db/recovery-conflict'
import { parsePagination } from '../util/response'
import { Logger } from '../core/logger'

const logger = new Logger('RolesRoute')

// 简易内存存储占位
const roles = new Map<string, { id: string; name: string; permissions: string[] }>()

/** The transaction/pool client shape both writers here run their statements through. */
type SqlClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }

/**
 * Upper bound on how many offending codes a 4xx body echoes back.
 *
 * Echoing them at all is deliberate and is NOT a values leak: every code in this list
 * came from THIS request's own body, so the caller is only being shown what it just
 * sent — the same choice `POST /api/permissions/grant` already makes
 * (routes/permissions.ts: "Permission code '<x>' does not exist"). Without it an admin
 * who mistyped one checkbox out of fifty has no way to find it. The cap keeps a hostile
 * body from turning the error into an unbounded reflection, and `unknownCount` always
 * reports the true total. Nothing unvalidated ever reaches the audit log: the refusal
 * audit entry below records COUNTS only, never the codes.
 */
const REJECTED_CODE_ECHO_LIMIT = 20

/**
 * The seeded platform-administrator role (migrations/054_create_users_table.sql seeds it
 * with `*:*`). Membership in it is what `rbac/service.isAdmin` tests, so its permission
 * set is the platform's root of trust: emptying it de-administrates everyone, and
 * deleting it removes the only row `isAdmin` looks for. Both are therefore reserved for a
 * platform administrator, independently of which individual codes move.
 */
const PLATFORM_ADMIN_ROLE_ID = 'admin'

/** A caller-fault refusal raised from inside the write transaction, so it rolls back. */
class RolePermissionRequestError extends Error {
  constructor(
    readonly status: number,
    readonly httpCode: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RolePermissionRequestError'
  }
}

function sendRolePermissionRequestError(res: Response, error: RolePermissionRequestError): Response {
  return res.status(error.status).json({
    ok: false,
    error: { code: error.httpCode, message: error.message, details: error.details },
  })
}

/** Keep log tokens to a conservative charset — a role id is caller-controlled text. */
function logToken(value: unknown): string {
  const normalized = String(value ?? '').replace(/[^A-Za-z0-9_.:*-]/g, '_').slice(0, 64)
  return normalized || 'UNKNOWN'
}

/**
 * Every REFUSAL on this RBAC write path leaves a trace. Before this, a caller could probe
 * the gate all afternoon — wildcard, then `admin:*`, then a list of guessed codes — and
 * the audit trail would hold only the grants that SUCCEEDED, because `auditLog` was
 * reached solely after a successful commit and the file instantiated no logger at all.
 *
 * Values-free by construction: the entry records the refusal code and the COUNT of
 * offending codes, never the codes themselves (the 4xx BODY echoes them back to the
 * caller that sent them — see REJECTED_CODE_ECHO_LIMIT — but the durable record does not).
 * `action` is suffixed `_denied` so a refusal can never be mistaken for a write when
 * reading the trail, and so tests can assert "no WRITE-shaped entry" rather than
 * "no entry".
 */
async function recordRoleWriteRefusal(params: {
  action: 'create' | 'update' | 'delete'
  actorId?: string
  roleId: string
  error: RolePermissionRequestError
}): Promise<void> {
  const { action, actorId, roleId, error } = params
  const offendingCount = Number(
    error.details?.unknownCount ?? error.details?.escalatingCount ?? 0,
  ) || 0
  logger.warn(
    `role write refused (action=${action} role=${logToken(roleId)}`
    + ` refusal=${logToken(error.httpCode)} status=${error.status}`
    + ` actor=${logToken(actorId)} offending_codes=${offendingCount})`,
  )
  await auditLog({
    actorId,
    actorType: 'user',
    action: `${action}_denied`,
    resourceType: 'role',
    resourceId: roleId,
    meta: { refusalCode: error.httpCode, status: error.status, offendingCount },
  })
}

/**
 * The unclassified-error backstop. This router has NO async error wrapper (it is mounted
 * bare in src/index.ts and uses no asyncHandler), so a rethrow here escapes as an
 * unhandled rejection with NO response at all — the caller sees a hung request until its
 * own timeout, not an error. That is the failure mode the catalog probe below exists to
 * avoid for one specific cause; leaving every OTHER cause (a concurrent role delete
 * tripping `role_permissions_role_id_fkey`, a dropped connection, a deadlock) to hang was
 * the same bug with a different trigger.
 *
 * Values-free: the body is a fixed code/message and the log line carries the SQLSTATE
 * only — never the driver message, which routinely echoes row values.
 */
function sendRoleWriteFailure(
  res: Response,
  error: unknown,
  action: 'create' | 'update' | 'delete',
  roleId: string,
): Response {
  const sqlstate = typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code)
    : ''
  if (sqlstate === '23503') {
    // A foreign key vanished under the write: the role (or a permission code) was
    // deleted concurrently. Retryable from the caller's point of view — reload and redo.
    //
    // SCHEMA CAVEAT, so this mapping is not read as a guarantee: the role_id side of that
    // foreign key — `role_permissions.role_id REFERENCES roles(id) ON DELETE CASCADE`, and
    // the matching one on `user_roles` — exists only in the SQL migration set
    // (migrations/033_create_rbac_core.sql:17 and :36). The Kysely set,
    // src/db/migrations/20250924190000_create_rbac_tables.ts, creates role_permissions and
    // user_roles with the permission_code foreign key ONLY (:105-115) and no role_id one at
    // all — it does not even create `roles`. On a database built that way a concurrent role
    // delete raises nothing here and leaves orphan rows instead; that is also why the DELETE
    // handler snapshots its members with an explicit read rather than relying on the cascade
    // having fired (a snapshot that is correct under BOTH shapes).
    logger.warn(`role write lost a foreign key (action=${action} role=${logToken(roleId)} sqlstate=23503)`)
    return res.status(409).json({
      ok: false,
      error: {
        code: 'ROLE_WRITE_CONFLICT',
        message: 'The role or one of its permission codes changed while this write was running; reload and retry',
        details: { retryable: true },
      },
    })
  }
  logger.error(
    `role write failed (action=${action} role=${logToken(roleId)} sqlstate=${logToken(sqlstate || 'UNKNOWN')})`,
  )
  return res.status(500).json({
    ok: false,
    error: { code: 'ROLE_WRITE_FAILED', message: 'Role write failed' },
  })
}

/**
 * ABSENT vs EMPTY, the whole point of this handler's contract:
 *   - key missing (or explicitly `undefined`) - null - permissions are NOT touched, so a
 *     name-only rename cannot silently strip a role;
 *   - an array (including the empty one) - the FULL desired set, replace semantics;
 *   - anything else (a string, a number, null) - 400, never a guess.
 */
function readDesiredPermissionSet(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null
  if (!Object.prototype.hasOwnProperty.call(body, 'permissions')) return null
  const raw = (body as { permissions?: unknown }).permissions
  if (raw === undefined) return null
  if (!Array.isArray(raw)) {
    throw new RolePermissionRequestError(
      400,
      'PERMISSIONS_INVALID',
      'permissions must be an array of permission codes (omit the key to leave permissions unchanged)',
    )
  }
  return normalizePermissionCodes(raw, { strict: true })
}

/** Trim, drop duplicates, sort. `strict` turns a malformed entry into a 400 instead of a skip. */
function normalizePermissionCodes(raw: unknown[], options: { strict: boolean }): string[] {
  const codes: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
      if (!options.strict) continue
      throw new RolePermissionRequestError(
        400,
        'PERMISSIONS_INVALID',
        'permissions must contain only non-empty permission code strings',
      )
    }
    const code = entry.trim()
    if (!codes.includes(code)) codes.push(code)
  }
  return codes.sort()
}

/**
 * OPTIMISTIC CONCURRENCY token. The role editor submits the WHOLE checkbox grid it loaded
 * earlier, so without a token a stale tab silently resurrects a revocation: admin A loads
 * {a,b}, admin B revokes b, admin A saves the stale grid and b is granted again — the
 * fail-OPEN direction, and nobody is told. When the client echoes the `updatedAt` it
 * loaded, a mid-air collision becomes a 409 and the grid is reloaded instead of replayed.
 *
 * Optional on purpose: a client that does not send it keeps the previous last-writer-wins
 * behaviour rather than being locked out (this is a compatibility floor, not a widening —
 * nothing about WHO may write changes). The row lock taken inside the transaction serializes
 * two concurrent PUTs regardless, so the interleaving half of the race is closed for
 * everyone; the token closes the stale-read half for clients that carry it.
 */
function readExpectedUpdatedAt(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const raw = (body as { expectedUpdatedAt?: unknown }).expectedUpdatedAt
  if (raw === undefined || raw === null || raw === '') return null
  const parsed = raw instanceof Date ? raw.getTime() : Date.parse(String(raw))
  if (!Number.isFinite(parsed)) {
    throw new RolePermissionRequestError(
      400,
      'EXPECTED_UPDATED_AT_INVALID',
      'expectedUpdatedAt must be an ISO 8601 timestamp (omit it to skip the concurrency check)',
    )
  }
  return parsed
}

/**
 * The COMPANION baseline, and the reason `expectedUpdatedAt` alone is not enough: other
 * writers grant codes by writing `role_permissions` DIRECTLY, without touching
 * `roles.updated_at`, so the concurrency token cannot move even though the set did.
 *
 * The in-repo example is `ensureAttendanceRoleTemplates`
 * (routes/attendance-admin.ts:439-466, called on three admin request paths): it INSERTs
 * role_permissions rows for FIXED role ids — `attendance_employee`, `attendance_approver`,
 * `attendance_importer`, `attendance_admin` — and never writes the `roles` row at all.
 * Those ids are real `roles` rows (seeded by
 * src/db/migrations/zzzz20260208100000_create_roles_table.ts:71-79), so `GET /api/roles`
 * lists them and THIS editor edits them. A grid loaded before one of those calls therefore
 * carries a still-valid timestamp, and its DELETE would revoke codes the admin never
 * unchecked and never saw. Comparing the set the client LOADED against the set actually
 * stored catches any writer, in-process or not.
 *
 * NOT the plugin provisioner, which an earlier revision of this comment cited and which
 * does not fit on either half: services/PluginRbacProvisioningService.applyRoleMatrix DOES
 * move the token (`ON CONFLICT (id) DO UPDATE SET name, updated_at = now()`, :111-118), and
 * it confines itself to `${pluginId}:${appId}:${roleSlug}` ids (:78) that this editor never
 * edits. The FEATURE is unchanged — only the example was wrong.
 *
 * Optional, like the timestamp: absent means the previous last-writer-wins behaviour.
 */
function readExpectedPermissionSet(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null
  const raw = (body as { expectedPermissions?: unknown }).expectedPermissions
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) {
    throw new RolePermissionRequestError(
      400,
      'EXPECTED_PERMISSIONS_INVALID',
      'expectedPermissions must be an array of permission codes (omit the key to skip the concurrency check)',
    )
  }
  return normalizePermissionCodes(raw, { strict: false })
}

function sameCodeSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((code, index) => code === right[index])
}

function toEpochMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Codes whose blast radius is wider than one resource action. The all-permissions
 * wildcard is a real row in the permissions catalog and `GET /api/permissions` returns
 * the catalog unfiltered, so the role editor already renders it as a checkbox.
 * rbacGuard expands both the global wildcard and a per-resource one (rbac/rbac.ts
 * hasPermissionCode), so all of those shapes count as elevation.
 */
function isElevatedPermissionCode(code: string): boolean {
  const normalized = code.trim().toLowerCase()
  if (!normalized) return false
  if (normalized === '*' || normalized === '*:*') return true
  if (normalized.endsWith(':*')) return true
  const resource = normalized.split(':')[0]
  return resource === '*' || resource === 'admin'
}

/**
 * The platform-admin test this route gates elevated grants on. It is deliberately the
 * SAME population `ensurePlatformAdmin` admits for `GET /api/admin/roles` — the read side
 * of this very editor (routes/admin-users.ts) — plus the wildcard holder:
 *
 *   - `hasLegacyAdminClaim(req)`: the shared request-claim predicate (rbac/platform-admin.ts,
 *     imported by admin-users.ts too so the two cannot drift). Without this leg an
 *     administrator whose status comes from the legacy claim — `users.role='admin'`, a
 *     token `roles` claim, or the no-DB fallback user — is refused by the write side
 *     while the read side serves them the editor: the exact "the owner cannot grant a
 *     permission through any UI, it has to be done with SQL" symptom this route exists to
 *     remove;
 *   - `isAdmin(actorId)`: LIVE SQL on user_roles, never the 60s permission memo;
 *   - `userHasPermission(actorId, '*:*')`: also live; holding the all-permissions
 *     wildcard is what makes someone an owner here and does not imply membership in the
 *     seeded `admin` role.
 *
 * Still strictly narrower than `roles:write`, which is all this route demanded before.
 */
async function actorIsPlatformAdmin(req: Request, actorId?: string): Promise<boolean> {
  if (hasLegacyAdminClaim(req)) return true
  if (!actorId) return false
  if (await isAdmin(actorId)) return true
  return await userHasPermission(actorId, '*:*')
}

/**
 * The ONE authority gate over role permission writes, applied by BOTH writers.
 *
 * It lives in a helper precisely because a gate on a single verb is not a boundary: PUT
 * refusing `*:*` while POST accepts the same body with `{id: '<existing role>'}` — same
 * router, same rbacGuard, ON CONFLICT DO NOTHING on the role row and an additive grant on
 * the role_permissions row — would be a 403 its own sibling dissolves in one request.
 *
 * SYMMETRIC in both directions. Removing an elevated code is not "less dangerous" than
 * adding one: emptying the seeded `admin` role de-administrates the platform and reads as
 * `ok: true`, and quietly dropping `stock-prep:*` revokes a whole team — with the cache
 * fan-out below making it effective immediately. `added` and `removed` are therefore both
 * examined, and any write that touches the platform-admin role's set at all is reserved
 * for a platform administrator regardless of which codes move.
 *
 * LOCK SHAPE worth recording: on the elevated / platform-admin-role path only, this helper
 * calls `actorIsPlatformAdmin`, i.e. `isAdmin` and `userHasPermission` (rbac/service), which
 * run their own statements through the module pool — a SECOND pool checkout taken while the
 * caller is still holding the `SELECT … FOR UPDATE` row lock inside `transaction()`. Both
 * callers reach it from inside their transaction. It is rare (an ordinary edit short-circuits
 * at the `!elevating.length && !touchesPlatformAdminRole` return, and a legacy-claim admin
 * short-circuits before any query) and short, but it is the lock-held-across-an-independent-
 * checkout shape: with the pool saturated by concurrent elevated edits, the lock holder waits
 * on a client that the waiters are holding. Recorded, not restructured — whether the check is
 * needed at all is only known after `added`/`removed` are computed from the LOCKED snapshot,
 * so hoisting it out of the transaction means running it unconditionally on every write.
 */
async function assertRoleGrantAuthority(params: {
  req: Request
  actorId?: string
  roleId: string
  added: readonly string[]
  removed: readonly string[]
}): Promise<void> {
  const { req, actorId, roleId, added, removed } = params
  const elevating = [...added, ...removed].filter(isElevatedPermissionCode)
  const touchesPlatformAdminRole = roleId === PLATFORM_ADMIN_ROLE_ID
    && (added.length > 0 || removed.length > 0)
  if (!elevating.length && !touchesPlatformAdminRole) return
  if (await actorIsPlatformAdmin(req, actorId)) return
  if (!elevating.length) {
    throw new RolePermissionRequestError(
      403,
      'PROTECTED_ROLE_FORBIDDEN',
      'Only a platform administrator may change the permissions of the platform administrator role',
      { roleId },
    )
  }
  throw new RolePermissionRequestError(
    403,
    'PERMISSION_ESCALATION_FORBIDDEN',
    'Only a platform administrator may add or remove wildcard or admin permission codes on a role',
    { escalatingCount: elevating.length, escalating: elevating.slice(0, REJECTED_CODE_ECHO_LIMIT) },
  )
}

/**
 * Explicit refusal instead of letting `role_permissions_permission_code_fkey`
 * (SQLSTATE 23503) fire. Only the codes being ADDED need probing: every code already on
 * the role is in the catalog by that same foreign key.
 */
async function assertCodesInCatalog(client: SqlClient, codes: readonly string[]): Promise<void> {
  if (!codes.length) return
  const known = await client.query('SELECT code FROM permissions WHERE code = ANY($1::text[])', [codes])
  const knownCodes = new Set((known.rows as Array<{ code: string }>).map((row) => row.code))
  const unknown = codes.filter((code) => !knownCodes.has(code))
  if (!unknown.length) return
  throw new RolePermissionRequestError(
    400,
    'UNKNOWN_PERMISSION_CODE',
    `${unknown.length} permission code(s) are not in the permissions catalog`,
    { unknownCount: unknown.length, unknown: unknown.slice(0, REJECTED_CODE_ECHO_LIMIT) },
  )
}

/**
 * The role's current members. Split out of `invalidateRoleMembers` because DELETE must take
 * this snapshot BEFORE the role row goes: `user_roles.role_id REFERENCES roles(id) ON DELETE
 * CASCADE` (migrations/033_create_rbac_core.sql:36), so after the DELETE the lookup returns
 * nobody and the fan-out would silently invalidate no one.
 */
async function readRoleMemberIds(roleId: string): Promise<string[]> {
  if (!pool) return []
  const members = await pool.query('SELECT user_id FROM user_roles WHERE role_id=$1', [roleId])
  const memberIds: string[] = []
  for (const row of members.rows as Array<{ user_id: string }>) {
    const memberId = String(row.user_id ?? '')
    if (memberId) memberIds.push(memberId)
  }
  return memberIds
}

/** Drop the per-user permission memo for a snapshot of members. Returns how many were dropped. */
function invalidateMembers(memberIds: readonly string[]): number {
  for (const memberId of memberIds) invalidateUserPerms(memberId)
  return memberIds.length
}

/** Drop the per-user permission memo for exactly the role's members (read + drop, for PUT/POST). */
async function invalidateRoleMembers(roleId: string): Promise<number> {
  return invalidateMembers(await readRoleMemberIds(roleId))
}

/**
 * The POST-COMMIT tail of a writer, made individually non-fatal.
 *
 * Everything a handler does below its `transaction()` runs AFTER the data is committed: the
 * cache fan-out, the audit entry, POST's read-back of the stored row. Those awaits used to
 * sit OUTSIDE the handler's catch, and this router is mounted bare in src/index.ts — no
 * asyncHandler, Express 4 — so a rejection there became an unhandled rejection and the caller
 * got NO response at all. That is precisely the hang `sendRoleWriteFailure` above exists to
 * prevent, reintroduced two lines past the point where it stops watching.
 *
 * Swallow-and-log rather than a widened catch, and the direction matters: the row is ALREADY
 * committed when these run. Turning a failed memo drop into a 500 would report a write that
 * happened as a write that did not, and invite a retry of an applied change — on PUT that
 * retry computes an EMPTY delta and skips the fan-out entirely, so the "safe" answer is the
 * one that loses the invalidation permanently. The caller is told the truth (the write
 * landed); the operator is told the rest, at error level, and the audit entry distinguishes
 * "no members" (0) from "the fan-out did not run" (null).
 *
 * Values-free like every other log line here: the effect label, the action, the role id token
 * and the SQLSTATE — never the driver message, which routinely echoes row values.
 *
 * Bounded claim: this covers the SUCCESS tail. `recordRoleWriteRefusal` is still awaited
 * un-wrapped from inside each handler's CATCH block, where a throw escapes that same catch;
 * `auditLog` swallows its own write failures (audit/audit.ts:62-72) so that path is not
 * reachable today, but it is not guarded here either.
 */
async function settlePostCommitEffect<T>(
  context: {
    label: 'cache_fanout' | 'audit' | 'readback'
    action: 'create' | 'update' | 'delete'
    roleId: string
  },
  effect: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await effect()
  } catch (error) {
    const sqlstate = typeof (error as { code?: unknown })?.code === 'string'
      ? String((error as { code: string }).code)
      : ''
    logger.error(
      `role write post-commit effect failed (effect=${context.label} action=${context.action}`
      + ` role=${logToken(context.roleId)} sqlstate=${logToken(sqlstate || 'UNKNOWN')})`,
    )
    return fallback
  }
}

export function rolesRouter(): Router {
  const r = Router()

  r.get('/api/roles', rbacGuard('roles', 'read'), async (req: Request, res: Response) => {
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>)
    if (pool) {
      const count = await pool.query('SELECT COUNT(*)::int AS c FROM roles')
      const total = count.rows[0]?.c || 0
      const { rows } = await pool.query('SELECT id, name, created_at, updated_at FROM roles ORDER BY id ASC LIMIT $1 OFFSET $2', [pageSize, offset])
      return res.json({ ok: true, data: { items: rows, page, pageSize, total } })
    }
    const arr = Array.from(roles.values())
    const total = arr.length
    const items = arr.slice(offset, offset + pageSize)
    return res.json({ ok: true, data: { items, page, pageSize, total } })
  })

  /**
   * POST is ADDITIVE and, on an id that already exists, is a permission GRANT on that
   * existing role (`INSERT INTO roles … ON CONFLICT (id) DO NOTHING` leaves the row alone,
   * the per-code INSERT still lands). It therefore runs the SAME authority gate and the
   * SAME catalog probe as PUT — a gate only PUT enforced would deny legitimate edits while
   * denying no attack, because the identical intent re-sent as POST would land.
   */
  r.post('/api/roles', rbacGuard('roles', 'write'), async (req: Request, res: Response) => {
    const id = String(req.body?.id || `role_${Date.now()}`)
    const name = req.body?.name || 'unnamed'
    const actorId = req.user?.id?.toString()
    const perms: string[] = Array.isArray(req.body?.permissions)
      ? normalizePermissionCodes(req.body.permissions as unknown[], { strict: false })
      : []
    if (pool) {
      let added: string[] = []
      try {
        // ONE transaction over the role row and its grants: a refused or failed grant must
        // not leave a freshly created role behind, and the gate's read of the CURRENT set
        // must see the same snapshot the write does.
        await transaction(async (client) => {
          await client.query('INSERT INTO roles(id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [id, name])
          if (!perms.length) return
          // Serializes against a concurrent PUT/POST on the same role.
          await client.query('SELECT id FROM roles WHERE id=$1 FOR UPDATE', [id])
          const current = await client.query('SELECT permission_code FROM role_permissions WHERE role_id=$1', [id])
          const currentCodes = new Set(
            (current.rows as Array<{ permission_code: string }>).map((row) => row.permission_code),
          )
          added = perms.filter((code) => !currentCodes.has(code))
          if (!added.length) return
          await assertRoleGrantAuthority({ req, actorId, roleId: id, added, removed: [] })
          await assertCodesInCatalog(client, added)
          for (const p of added) {
            await client.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, p])
          }
        })
      } catch (error) {
        if (error instanceof RolePermissionRequestError) {
          await recordRoleWriteRefusal({ action: 'create', actorId, roleId: id, error })
          return sendRolePermissionRequestError(res, error)
        }
        // O2-S2: role_permissions is a recovery-authority table — a marker 40001 under a
        // held recovery lease is a retryable 409.
        if (sendIfRecoveryConflict(res, error)) return
        return sendRoleWriteFailure(res, error, 'create', id)
      }
      // Post-commit tail — the role row and its grants are committed, so nothing below may
      // turn this into a failure, and nothing below may reject unanswered. See
      // settlePostCommitEffect.
      const membersInvalidated = added.length
        ? await settlePostCommitEffect<number | null>(
          { label: 'cache_fanout', action: 'create', roleId: id },
          () => invalidateRoleMembers(id),
          null,
        )
        : 0
      await settlePostCommitEffect<void>(
        { label: 'audit', action: 'create', roleId: id },
        () => auditLog({ actorId, actorType: 'user', action: 'create', resourceType: 'role', resourceId: id, meta: { name, permissions: perms, permissionsAdded: added, membersInvalidated } }),
        undefined,
      )
      const stored = await settlePostCommitEffect<Record<string, unknown> | null>(
        { label: 'readback', action: 'create', roleId: id },
        async () => {
          const { rows } = await pool.query('SELECT id, name, created_at, updated_at FROM roles WHERE id=$1', [id])
          return (rows[0] as Record<string, unknown> | undefined) ?? null
        },
        null,
      )
      // The read-back is a convenience, not the write. When it fails the id is the only thing
      // this handler can state as FACT: `ON CONFLICT (id) DO NOTHING` means the submitted
      // `name` is not necessarily the stored one, so echoing it back would be a guess.
      return res.json({ ok: true, data: stored ?? { id } })
    }
    roles.set(id, { id, name, permissions: perms })
    await auditLog({ actorId, actorType: 'user', action: 'create', resourceType: 'role', resourceId: id, meta: { name, permissions: perms } })
    return res.json({ ok: true, data: roles.get(id) })
  })

  /**
   * PUT persists the permission set. Before this handler did so it read only `name`,
   * never referenced `req.body.permissions`, never touched `role_permissions`, and still
   * answered `{ ok: true }` — so the role editor reported a successful grant while
   * nothing was written, and the only working remedy was raw SQL.
   *
   * Semantics vs POST: POST's write is ADDITIVE (`INSERT … ON CONFLICT DO NOTHING`, no
   * DELETE). PUT edits a role that already HAS a set and is driven by a checkbox grid, so
   * unchecking must revoke; PUT therefore adds the DELETE that replace requires, and
   * DIVERGES from POST's additive behaviour by design. The AUTHORITY rules do not diverge:
   * both run assertRoleGrantAuthority + assertCodesInCatalog.
   *
   * Statement set, and why a pure rename stays lease-proof: when the submitted set equals
   * the stored one (`added` and `removed` both empty — what the editor produces on a
   * rename, since the page always sends the whole grid) the DELETE/INSERT pair is SKIPPED
   * entirely, so the transaction degenerates to `UPDATE roles`. `roles` carries none of
   * the nine recovery-authority triggers, so such a rename cannot raise the 40001 marker;
   * a real permission change can, and answers the uniform retryable 409.
   */
  r.put('/api/roles/:id', rbacGuard('roles', 'write'), async (req: Request, res: Response) => {
    const id = req.params.id
    const actorId = req.user?.id?.toString()
    let desired: string[] | null
    let expectedUpdatedAt: number | null
    let expectedPermissions: string[] | null
    try {
      desired = readDesiredPermissionSet(req.body)
      expectedUpdatedAt = readExpectedUpdatedAt(req.body)
      expectedPermissions = readExpectedPermissionSet(req.body)
    } catch (error) {
      if (error instanceof RolePermissionRequestError) {
        await recordRoleWriteRefusal({ action: 'update', actorId, roleId: id, error })
        return sendRolePermissionRequestError(res, error)
      }
      throw error
    }
    if (pool) {
      let before: { id: string; name: string } = { id, name: '' }
      let name = ''
      let beforeCodes: string[] = []
      let added: string[] = []
      let removed: string[] = []
      try {
        // ONE transaction over the lookup, the rename AND the permission replacement: a
        // rejected or failed permission write must not leave a renamed role behind, the
        // catalog probe reads the SAME snapshot as the write, and the row lock below is
        // only a lock if the read that takes it is inside the transaction.
        await transaction(async (client) => {
          // FOR UPDATE, as the FIRST statement: two overlapping saves of the same role
          // would otherwise both read the pre-state under READ COMMITTED and interleave
          // their DELETE/INSERT pairs into the union of both desired sets.
          const locked = await client.query('SELECT id, name, updated_at FROM roles WHERE id=$1 FOR UPDATE', [id])
          const lockedRow = (locked.rows as Array<{ id: string; name: string; updated_at?: unknown }>)[0]
          if (!lockedRow) {
            throw new RolePermissionRequestError(404, 'NOT_FOUND', 'Role not found')
          }
          before = { id: lockedRow.id, name: lockedRow.name }
          name = req.body?.name ?? lockedRow.name

          const storedUpdatedAt = toEpochMillis(lockedRow.updated_at)
          // A row with no usable timestamp carries no token to compare against; the lock
          // above is then the only arbitration available (documented on readExpectedUpdatedAt).
          if (expectedUpdatedAt !== null && storedUpdatedAt !== null && expectedUpdatedAt !== storedUpdatedAt) {
            throw new RolePermissionRequestError(
              409,
              'ROLE_MODIFIED',
              'This role changed since it was loaded; reload it and re-apply the change',
              { retryable: true },
            )
          }

          if (!desired) {
            await client.query('UPDATE roles SET name=$1, updated_at=now() WHERE id=$2', [name, id])
            return
          }
          const current = await client.query('SELECT permission_code FROM role_permissions WHERE role_id=$1', [id])
          beforeCodes = (current.rows as Array<{ permission_code: string }>)
            .map((row) => row.permission_code)
            .sort()

          if (expectedPermissions && !sameCodeSet(expectedPermissions, beforeCodes)) {
            throw new RolePermissionRequestError(
              409,
              'ROLE_MODIFIED',
              'This role changed since it was loaded; reload it and re-apply the change',
              { retryable: true },
            )
          }

          const beforeSet = new Set(beforeCodes)
          added = desired.filter((code) => !beforeSet.has(code))
          removed = beforeCodes.filter((code) => !desired.includes(code))

          // Authority BEFORE the catalog probe: a refused caller learns nothing about
          // which of its guessed codes exist.
          await assertRoleGrantAuthority({ req, actorId, roleId: id, added, removed })
          await assertCodesInCatalog(client, added)

          await client.query('UPDATE roles SET name=$1, updated_at=now() WHERE id=$2', [name, id])
          if (!added.length && !removed.length) return
          // An empty desired set makes the NOT-IN predicate true for every row, i.e. it
          // clears the role — which is exactly what a fully unchecked grid means.
          await client.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_code <> ALL($2::text[])', [id, desired])
          for (const p of added) {
            await client.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, p])
          }
        })
      } catch (error) {
        if (error instanceof RolePermissionRequestError) {
          if (error.status !== 404) {
            await recordRoleWriteRefusal({ action: 'update', actorId, roleId: id, error })
          }
          return sendRolePermissionRequestError(res, error)
        }
        // O2-S2: marker 40001 → retryable 409.
        if (sendIfRecoveryConflict(res, error)) return
        return sendRoleWriteFailure(res, error, 'update', id)
      }

      // Post-commit side effect, not part of the atomic write set (the same split
      // admin-users.ts uses). `req.user.permissions` is served from the
      // listUserPermissions memo, and rbacGuard trusts that list BEFORE it asks the DB,
      // so without this fan-out a revoked code stays effective for up to
      // RBAC_CACHE_TTL_MS (default 60s) — a revoke that fails OPEN. The affected
      // population is exactly the role's members: the memo is keyed per user, and a role
      // change reaches a user only through user_roles. The memo is process-local, so in a
      // multi-instance deployment the OTHER instances still carry their own stale entries
      // until the TTL expires; this fan-out cannot reach them.
      // ...and it runs through settlePostCommitEffect, because the row is already committed:
      // a rejection here would otherwise escape this handler unanswered (no asyncHandler on
      // this router), and a 500 would report a landed write as a failed one.
      const membersInvalidated = (added.length || removed.length)
        ? await settlePostCommitEffect<number | null>(
          { label: 'cache_fanout', action: 'update', roleId: id },
          () => invalidateRoleMembers(id),
          null,
        )
        : 0

      await settlePostCommitEffect<void>(
        { label: 'audit', action: 'update', roleId: id },
        () => auditLog({
          actorId,
          actorType: 'user',
          action: 'update',
          resourceType: 'role',
          resourceId: id,
          meta: {
            before: desired ? { ...before, permissions: beforeCodes } : before,
            after: desired ? { id, name, permissions: desired } : { id, name },
            permissionsChanged: added.length > 0 || removed.length > 0,
            permissionsAdded: added,
            permissionsRemoved: removed,
            membersInvalidated,
          },
        }),
        undefined,
      )
      return res.json({ ok: true, data: desired ? { id, name, permissions: desired } : { id, name } })
    }
    const beforeMemory = roles.get(id)
    if (!beforeMemory) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Role not found' } })
    const memoryName = req.body?.name ?? beforeMemory.name
    // The same absent-vs-present contract as the DB branch. The catalog probe and the
    // authority gate are DB-backed and have no counterpart here: this branch only runs
    // with no pool at all, where there is no permissions catalog to check against — and
    // where this Map grants nothing, because rbac/service answers every authorization
    // question `false` without a pool.
    const next = { ...beforeMemory, name: memoryName, ...(desired ? { permissions: desired } : {}) }
    roles.set(id, next)
    await auditLog({ actorId, actorType: 'user', action: 'update', resourceType: 'role', resourceId: id, meta: { before: beforeMemory, after: next } })
    return res.json({ ok: true, data: next })
  })

  r.delete('/api/roles/:id', rbacGuard('roles', 'write'), async (req: Request, res: Response) => {
    const id = req.params.id
    const actorId = req.user?.id?.toString()
    if (pool) {
      let before: unknown = null
      let memberIds: string[] = []
      try {
        const { rows } = await pool.query('SELECT id, name FROM roles WHERE id=$1', [id])
        before = rows[0] ?? null
        // Deleting the seeded platform-admin role removes the only row `isAdmin` looks for,
        // i.e. it de-administrates the platform — the same blast radius as emptying its
        // permission set, which the PUT gate reserves for a platform administrator. A
        // surgical revoke and a delete must not have different admit sets, or the gate is
        // just a detour.
        if (before && id === PLATFORM_ADMIN_ROLE_ID && !await actorIsPlatformAdmin(req, actorId)) {
          throw new RolePermissionRequestError(
            403,
            'PROTECTED_ROLE_FORBIDDEN',
            'Only a platform administrator may delete the platform administrator role',
            { roleId: id },
          )
        }
        // The member snapshot, taken BEFORE the row goes and INSIDE this try. Before,
        // because `user_roles.role_id → roles(id)` is ON DELETE CASCADE
        // (migrations/033_create_rbac_core.sql:36) and the rows are gone afterwards. Inside,
        // because a read that failed out here would escape unanswered exactly like the tail
        // used to — and unlike the tail this one is PRE-commit, so its honest answer is the
        // 500 below, with nothing deleted.
        memberIds = await readRoleMemberIds(id)
        // The FK cascade from roles → role_permissions deletes recovery-authority rows,
        // so this DELETE can also surface the marker 40001.
        await pool.query('DELETE FROM roles WHERE id=$1', [id])
      } catch (error) {
        if (error instanceof RolePermissionRequestError) {
          await recordRoleWriteRefusal({ action: 'delete', actorId, roleId: id, error })
          return sendRolePermissionRequestError(res, error)
        }
        // O2-S2: marker 40001 → retryable 409.
        if (sendIfRecoveryConflict(res, error)) return
        return sendRoleWriteFailure(res, error, 'delete', id)
      }
      // The revocation this router offers with the WIDEST blast radius — every code the role
      // carried, for every member — and until now the only write path with no fan-out at all:
      // the members kept the whole revoked set for up to RBAC_CACHE_TTL_MS (rbac/service.ts:13,
      // default 60s), because rbacGuard trusts the per-user memo before it asks the DB. Same
      // process-local limit as PUT's: other instances expire on their own TTL.
      const membersInvalidated = await settlePostCommitEffect<number | null>(
        { label: 'cache_fanout', action: 'delete', roleId: id },
        async () => invalidateMembers(memberIds),
        null,
      )
      await settlePostCommitEffect<void>(
        { label: 'audit', action: 'delete', roleId: id },
        () => auditLog({ actorId, actorType: 'user', action: 'delete', resourceType: 'role', resourceId: id, meta: { before, membersInvalidated } }),
        undefined,
      )
      return res.json({ ok: true, data: { id } })
    }
    const before = roles.get(id)
    roles.delete(id)
    await auditLog({ actorId, actorType: 'user', action: 'delete', resourceType: 'role', resourceId: id, meta: { before } })
    return res.json({ ok: true, data: { id } })
  })

  return r
}
