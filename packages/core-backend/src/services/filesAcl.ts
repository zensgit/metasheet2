/**
 * F1 files-acl-tombstone design-lock (2026-07-10): resource-level ACL for the four `files.ts`
 * HTTP endpoints (list / info / download / delete).
 *
 * Defect closed: those endpoints previously only ran `authenticate` (valid JWT, any user) — any
 * logged-in caller could enumerate `GET /api/files`, then read or delete any other user's uploaded
 * file by id, including attendance outdoor-punch photo evidence (S2 #4016 / H2 #4044 made `files`
 * rows carry real evidentiary weight, so this is no longer an acceptable platform-wide gap — owner
 * explicitly authorized this ACL cut).
 *
 * `filesAclAllowsAccess` is kept a pure function (no I/O) so the actual access decision — the
 * security-load-bearing part — is unit-testable with plain objects, independent of HTTP/DB
 * plumbing. The admin-claim check mirrors the existing `hasLegacyAdminClaim` used by
 * `routes/admin-users.ts` and `routes/events.ts` (same three checks: `role`, `roles[]`, `perms[]`)
 * — kept as a local, non-exported copy here, matching the existing convention that neither of
 * those two route files exports its own copy either (each route family keeps its own).
 */
import type { Request } from 'express'
import { isAdmin as isRbacAdmin } from '../rbac/service'

/**
 * Sentinel written as `owner_id` when no identity claim (`id` / `userId` / `sub`) was present on
 * the request at upload time (pre-dates the S2 userId-resolution-family fix referenced in the
 * 2026-07-08 tracker entry). Such rows are attributable to no one — see
 * `filesAclAllowsAccess` below for why this is checked explicitly rather than relying on a plain
 * `ownerId === callerId` comparison.
 */
export const FILES_ANONYMOUS_OWNER_ID = 'anonymous'

/**
 * Resolves the caller's id exactly the way `files.ts` always has (`req.user?.id ?? ... ?? 'anonymous'`),
 * just centralized so upload/list/info/download/delete all agree on one derivation. Always returns a
 * string (numeric JWT `id` claims are stringified — functionally identical to the pre-existing
 * behavior, since the value only ever round-trips through a TEXT column).
 */
export function getFilesRequestUserId(req: Request): string {
  const raw = (req.user?.id ?? req.user?.userId ?? req.user?.sub) as string | number | undefined
  if (raw === undefined || raw === null || raw === '') return FILES_ANONYMOUS_OWNER_ID
  return typeof raw === 'string' ? raw : String(raw)
}

/** Byte-identical to `admin-users.ts`'s `hasLegacyAdminClaim` / `events.ts`'s inline equivalent. */
function hasFilesLegacyAdminClaim(req: Request): boolean {
  const raw = req.user as Record<string, unknown> | undefined
  if (!raw) return false
  if (raw.role === 'admin') return true
  if (Array.isArray(raw.roles) && raw.roles.includes('admin')) return true
  if (Array.isArray(raw.perms) && (raw.perms.includes('*:*') || raw.perms.includes('admin:all'))) return true
  return false
}

/**
 * Admin determination for the files ACL: legacy JWT claim (role/roles/perms) OR the RBAC
 * `user_roles` row — same two-source combo `admin-users.ts#ensurePlatformAdmin` and `events.ts`'s
 * router-level gate both use.
 */
export async function isFilesRequestAdmin(req: Request): Promise<boolean> {
  if (hasFilesLegacyAdminClaim(req)) return true
  const userId = getFilesRequestUserId(req)
  if (!userId || userId === FILES_ANONYMOUS_OWNER_ID) return false
  return isRbacAdmin(userId)
}

export interface FilesAclRow {
  ownerId: string | null
}

export interface FilesAclDecisionInput {
  admin: boolean
  callerId: string
  /** The active (`deleted_at IS NULL`) `files` row for this id, or `null` if none exists —
   * covers both "never had a row" (legacy/pre-S2 object) and "already tombstoned" uniformly. */
  row: FilesAclRow | null
}

/**
 * The single access decision reused by list/info/download/delete.
 *
 * - admin → always allowed.
 * - no active row (never existed, predates the S2 writer, or already tombstoned) → **not** allowed
 *   for non-admins. There are no known non-admin, non-attendance consumers of these HTTP endpoints
 *   in this codebase (verified: no frontend or plugin caller references them outside this file's own
 *   upload/delete usage inside the attendance test suite) — the fail-closed reading costs nothing in
 *   practice and is what the owner's authorization asked for. Recorded here, not silently assumed.
 * - row exists but `ownerId` is the `'anonymous'` sentinel → **never** treated as "the caller owns
 *   it", even if the caller's own derived id also happens to be `'anonymous'` (the fallback used
 *   when a request carries no identity claim at all) — that sentinel represents "nobody
 *   attributable", not a real identity two different anonymous uploads could coincidentally share.
 * - otherwise → caller must be the row's owner.
 */
export function filesAclAllowsAccess(input: FilesAclDecisionInput): boolean {
  if (input.admin) return true
  if (!input.row) return false
  if (input.row.ownerId === null) return false
  if (input.row.ownerId === FILES_ANONYMOUS_OWNER_ID) return false
  return input.row.ownerId === input.callerId
}
