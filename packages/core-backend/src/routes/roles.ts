import type { Request, Response} from 'express';
import { Router } from 'express'
import { rbacGuard } from '../rbac/rbac'
import { auditLog } from '../audit/audit'
import { pool, transaction } from '../db/pg'
import { invalidateUserPerms, isAdmin, userHasPermission } from '../rbac/service'
import { sendIfRecoveryConflict } from '../db/recovery-conflict'
import { parsePagination } from '../util/response'

// 简易内存存储占位
const roles = new Map<string, { id: string; name: string; permissions: string[] }>()

/**
 * Upper bound on how many offending codes a 4xx body echoes back.
 *
 * Echoing them at all is deliberate and is NOT a values leak: every code in this list
 * came from THIS request's own body, so the caller is only being shown what it just
 * sent — the same choice `POST /api/permissions/grant` already makes
 * (routes/permissions.ts: "Permission code '<x>' does not exist"). Without it an admin
 * who mistyped one checkbox out of fifty has no way to find it. The cap keeps a hostile
 * body from turning the error into an unbounded reflection, and `unknownCount` always
 * reports the true total. Nothing unvalidated ever reaches the audit log: the 4xx paths
 * return before `auditLog` runs.
 */
const REJECTED_CODE_ECHO_LIMIT = 20

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
  const codes: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) {
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
 * Codes whose blast radius is wider than one resource action. The all-permissions
 * wildcard is a real row in the permissions catalog and `GET /api/permissions` returns
 * the catalog unfiltered, so the role editor already renders it as a checkbox; the moment
 * this route starts WRITING the set, checking that box would mint an everything-role.
 * rbacGuard expands both the global wildcard and a per-resource one (rbac/rbac.ts
 * hasPermissionCode), so all of those shapes count as elevation. ADDING one therefore
 * additionally requires platform admin — this NARROWS the write; it does not change who
 * may call the route (the rbacGuard above is untouched).
 */
function isElevatedPermissionCode(code: string): boolean {
  const normalized = code.trim().toLowerCase()
  if (!normalized) return false
  if (normalized === '*' || normalized === '*:*') return true
  if (normalized.endsWith(':*')) return true
  const resource = normalized.split(':')[0]
  return resource === '*' || resource === 'admin'
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

  r.post('/api/roles', rbacGuard('roles', 'write'), async (req: Request, res: Response) => {
    const id = req.body?.id || `role_${Date.now()}`
    const name = req.body?.name || 'unnamed'
    const perms: string[] = Array.isArray(req.body?.permissions) ? req.body.permissions : []
    if (pool) {
      try {
        await pool.query('INSERT INTO roles(id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [id, name])
        for (const p of perms) {
          await pool.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, p])
        }
      } catch (error) {
        // O2-S2: role_permissions is a recovery-authority table — a marker 40001 under a
        // held recovery lease is a retryable 409. Every other error rethrows unchanged
        // (the handler had no catch before, so the rejection path is byte-identical).
        if (sendIfRecoveryConflict(res, error)) return
        throw error
      }
      await auditLog({ actorId: req.user?.id?.toString(), actorType: 'user', action: 'create', resourceType: 'role', resourceId: id, meta: { name, permissions: perms } })
      const { rows } = await pool.query('SELECT id, name, created_at, updated_at FROM roles WHERE id=$1', [id])
      return res.json({ ok: true, data: rows[0] })
    }
    roles.set(id, { id, name, permissions: perms })
    await auditLog({ actorId: req.user?.id?.toString(), actorType: 'user', action: 'create', resourceType: 'role', resourceId: id, meta: { name, permissions: perms } })
    return res.json({ ok: true, data: roles.get(id) })
  })

  /**
   * PUT persists the permission set. Before this handler did so it read only `name`,
   * never referenced `req.body.permissions`, never touched `role_permissions`, and still
   * answered `{ ok: true }` — so the role editor reported a successful grant while
   * nothing was written, and the only working remedy was raw SQL.
   *
   * Semantics vs POST: POST's write is ADDITIVE (`INSERT … ON CONFLICT DO NOTHING`, no
   * DELETE), which on its own path — creating a role that has no prior set — is
   * indistinguishable from replace. PUT edits a role that already HAS a set and is driven
   * by a checkbox grid, so unchecking must revoke; PUT therefore adds the DELETE that
   * replace requires, and DIVERGES from POST's additive-on-an-existing-id behaviour by
   * design. Everything else follows POST: the same INSERT statement and conflict clause,
   * and the same `permissions` key in the audit meta.
   */
  r.put('/api/roles/:id', rbacGuard('roles', 'write'), async (req: Request, res: Response) => {
    const id = req.params.id
    const actorId = req.user?.id?.toString()
    let desired: string[] | null
    try {
      desired = readDesiredPermissionSet(req.body)
    } catch (error) {
      if (error instanceof RolePermissionRequestError) return sendRolePermissionRequestError(res, error)
      throw error
    }
    if (pool) {
      const { rows } = await pool.query('SELECT id, name FROM roles WHERE id=$1', [id])
      if (!rows.length) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Role not found' } })
      const before = rows[0]
      const name = req.body?.name ?? before.name

      // An actor-side fact, so it is resolved outside the write transaction, and only
      // when the desired set actually carries an elevated code. Both legs are LIVE SQL,
      // never the 60s permission memo, so the gate cannot be opened by a stale cache.
      // The second leg exists so the gate cannot FALSELY deny a real owner: holding the
      // all-permissions wildcard is what makes someone an owner here, and it is not
      // necessarily accompanied by membership in the seeded `admin` role. It is still
      // strictly narrower than `roles:write`, which is all this route demanded before.
      const actorMayElevate = desired?.some(isElevatedPermissionCode)
        ? Boolean(actorId) && (
            await isAdmin(actorId as string) || await userHasPermission(actorId as string, '*:*')
          )
        : false

      let beforeCodes: string[] = []
      let added: string[] = []
      let removed: string[] = []
      try {
        // ONE transaction over the rename AND the permission replacement: a rejected or
        // failed permission write must not leave a renamed role behind, and the catalog
        // probe reads the SAME snapshot as the write, so the 4xx path is a rollback
        // rather than a best-effort abort.
        await transaction(async (client) => {
          if (!desired) {
            await client.query('UPDATE roles SET name=$1, updated_at=now() WHERE id=$2', [name, id])
            return
          }
          const current = await client.query('SELECT permission_code FROM role_permissions WHERE role_id=$1', [id])
          beforeCodes = (current.rows as Array<{ permission_code: string }>)
            .map((row) => row.permission_code)
            .sort()

          const known = await client.query('SELECT code FROM permissions WHERE code = ANY($1::text[])', [desired])
          const knownCodes = new Set((known.rows as Array<{ code: string }>).map((row) => row.code))
          const unknown = desired.filter((code) => !knownCodes.has(code))
          if (unknown.length) {
            // Explicit refusal instead of letting role_permissions_permission_code_fkey
            // (SQLSTATE 23503) fire: this router has no async error wrapper, so an
            // unclassified rejection escapes as an unhandled rejection with no response
            // at all — the caller would see a hung request, not a 4xx.
            throw new RolePermissionRequestError(
              400,
              'UNKNOWN_PERMISSION_CODE',
              `${unknown.length} permission code(s) are not in the permissions catalog`,
              { unknownCount: unknown.length, unknown: unknown.slice(0, REJECTED_CODE_ECHO_LIMIT) },
            )
          }

          const beforeSet = new Set(beforeCodes)
          added = desired.filter((code) => !beforeSet.has(code))
          removed = beforeCodes.filter((code) => !desired.includes(code))

          const escalating = added.filter(isElevatedPermissionCode)
          if (escalating.length && !actorMayElevate) {
            throw new RolePermissionRequestError(
              403,
              'PERMISSION_ESCALATION_FORBIDDEN',
              'Only a platform administrator may add wildcard or admin permission codes to a role',
              { escalatingCount: escalating.length, escalating: escalating.slice(0, REJECTED_CODE_ECHO_LIMIT) },
            )
          }

          await client.query('UPDATE roles SET name=$1, updated_at=now() WHERE id=$2', [name, id])
          // An empty desired set makes the NOT-IN predicate true for every row, i.e. it
          // clears the role — which is exactly what a fully unchecked grid means.
          await client.query('DELETE FROM role_permissions WHERE role_id=$1 AND permission_code <> ALL($2::text[])', [id, desired])
          for (const p of desired) {
            await client.query('INSERT INTO role_permissions(role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, p])
          }
        })
      } catch (error) {
        if (error instanceof RolePermissionRequestError) return sendRolePermissionRequestError(res, error)
        // O2-S2: marker 40001 → retryable 409; all else rethrows unchanged.
        if (sendIfRecoveryConflict(res, error)) return
        throw error
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
      let membersInvalidated = 0
      if (added.length || removed.length) {
        const members = await pool.query('SELECT user_id FROM user_roles WHERE role_id=$1', [id])
        for (const row of members.rows as Array<{ user_id: string }>) {
          const memberId = String(row.user_id ?? '')
          if (!memberId) continue
          invalidateUserPerms(memberId)
          membersInvalidated += 1
        }
      }

      await auditLog({
        actorId: req.user?.id?.toString(),
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
      })
      return res.json({ ok: true, data: desired ? { id, name, permissions: desired } : { id, name } })
    }
    const before = roles.get(id)
    if (!before) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Role not found' } })
    const name = req.body?.name ?? before.name
    // The same absent-vs-present contract as the DB branch. Catalog validation and the
    // elevation gate are DB-backed and have no counterpart here: this branch only runs
    // with no pool at all, where there is no permissions catalog to check against.
    const next = { ...before, name, ...(desired ? { permissions: desired } : {}) }
    roles.set(id, next)
    await auditLog({ actorId: req.user?.id?.toString(), actorType: 'user', action: 'update', resourceType: 'role', resourceId: id, meta: { before, after: next } })
    return res.json({ ok: true, data: next })
  })

  r.delete('/api/roles/:id', rbacGuard('roles', 'write'), async (req: Request, res: Response) => {
    const id = req.params.id
    if (pool) {
      const { rows } = await pool.query('SELECT id, name FROM roles WHERE id=$1', [id])
      const before = rows[0] || null
      try {
        // The FK cascade from roles → role_permissions deletes recovery-authority rows,
        // so this DELETE can also surface the marker 40001.
        await pool.query('DELETE FROM roles WHERE id=$1', [id])
      } catch (error) {
        // O2-S2: marker 40001 → retryable 409; all else rethrows unchanged.
        if (sendIfRecoveryConflict(res, error)) return
        throw error
      }
      await auditLog({ actorId: req.user?.id?.toString(), actorType: 'user', action: 'delete', resourceType: 'role', resourceId: id, meta: { before } })
      return res.json({ ok: true, data: { id } })
    }
    const before = roles.get(id)
    roles.delete(id)
    await auditLog({ actorId: req.user?.id?.toString(), actorType: 'user', action: 'delete', resourceType: 'role', resourceId: id, meta: { before } })
    return res.json({ ok: true, data: { id } })
  })

  return r
}
