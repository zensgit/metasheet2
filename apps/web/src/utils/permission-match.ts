/**
 * Pure permission-code matcher — the browser half of the ONE algebra App Center visibility runs.
 *
 * This is NOT a second policy: `useAuth().hasPermission` (`composables/useAuth.ts`) delegates its
 * code-matching tail to `matchesPermission` here, so the browser has exactly one implementation, and
 * `packages/core-backend/src/auth/permission-match.ts` is the same algebra on the server.
 * Both are pinned to ONE truth table — `packages/core-backend/tests/fixtures/permission-match-truth-table.json`,
 * read from disk by `tests/permission-match-parity.spec.ts` here and by
 * `tests/unit/permission-match.test.ts` in core-backend — so a change to either side that is not a
 * change to the other turns a test red.
 *
 * The admin bypass is deliberately NOT here: `useAuth#hasPermission` short-circuits on its
 * `isAdmin`/`roles` snapshot before this runs, and the server's router does the same before calling
 * its copy. That is what lets one truth table describe both sides.
 */

/** Trim + drop non-strings, matching `useAuth.ts#parseStringArray` exactly. */
export function normalizePermissionCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * Does `userCodes` satisfy the single required code `required`?
 * A blank requirement is satisfied by anyone — preserving `useAuth#hasPermission`'s
 * `if (!normalized) return true`.
 */
export function matchesPermission(userCodes: readonly string[], required: string): boolean {
  const normalized = String(required || '').trim()
  if (!normalized) return true

  const permissions = normalizePermissionCodes(userCodes as unknown)
  if (permissions.includes(normalized) || permissions.includes('*:*')) return true

  const [resource, action] = normalized.split(':')
  if (!resource || !action) return false
  if (permissions.includes(`${resource}:*`)) return true
  if (permissions.includes(`${resource}:admin`) && action !== 'admin') return true
  if (action === 'read' && permissions.includes(`${resource}:write`)) return true
  return false
}

/**
 * ANY-OF, not all-of: a manifest's `permissions` array names the codes an app USES, so one hit makes
 * it visible. An empty list is public; a list declared with nothing usable in it fails CLOSED.
 */
export function matchesAnyPermission(userCodes: readonly string[], required: readonly string[]): boolean {
  const declaredCount = Array.isArray(required) ? required.length : 0
  const codes = normalizePermissionCodes(required as unknown)
  if (codes.length === 0) return declaredCount === 0
  return codes.some((code) => matchesPermission(userCodes, code))
}
