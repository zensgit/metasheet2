import type { Request } from 'express'

/**
 * The request-side platform-admin claim predicate shared by routes/admin-users.ts and
 * routes/roles.ts.
 *
 * Extracted VERBATIM from routes/admin-users.ts (where it had lived as a local function
 * behind `ensurePlatformAdmin`) the moment a second write path — routes/roles.ts — needed
 * the same question answered. The alternative was a second, independently drifting admin
 * predicate, which is an auth bug waiting to happen: routes/roles.ts would have refused a
 * principal that `GET /api/admin/roles` (the read side of the very same admin screen)
 * serves as an administrator. admin-users.ts now imports this and keeps no private copy,
 * so those two cannot diverge.
 *
 * SCOPE, stated honestly: two further private copies remain elsewhere and are deliberately
 * NOT touched by this change — routes/attendance-admin.ts (byte-identical body) and
 * routes/admin-directory.ts (which additionally accepts a `permissions` array containing
 * `*:*`, i.e. a WIDER admit set). Folding either of them in here is a separate change on
 * someone else's surface, and adopting the wider variant would widen who may write roles.
 *
 * This is the CLAIM leg only — it never touches the database. Callers combine it with the
 * DB legs (`isAdmin(userId)` / `userHasPermission(userId, '*:*')`) exactly as
 * `ensurePlatformAdmin` does; it widens nobody, because every route that consults it sits
 * behind its own authentication + rbacGuard first.
 */
export function hasLegacyAdminClaim(req: Request): boolean {
  const raw = req.user as Record<string, unknown> | undefined
  if (!raw) return false
  if (raw.role === 'admin') return true
  if (Array.isArray(raw.roles) && raw.roles.includes('admin')) return true
  if (Array.isArray(raw.perms) && (raw.perms.includes('*:*') || raw.perms.includes('admin:all'))) return true
  return false
}
