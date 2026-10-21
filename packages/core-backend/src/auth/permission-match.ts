/**
 * Pure permission-code matcher — the ONE algebra both sides of App Center visibility run.
 *
 * WHY A NEW MODULE. The server had no reusable production-grade matcher to consume the
 * `permissions` codes an `app.manifest.json` already declares:
 *  - `requireAccess` does not exist in core-backend (it lives only in plugin CJS route files);
 *  - `middleware/permission-metrics-middleware.ts#checkUserPermission` is not exported and resolves
 *    codes through a hard-coded demo role table (admin/editor/viewer), so binding App Center
 *    visibility to it would bind it to a fixture;
 *  - `AuthService#checkPermission` covers only exact + `resource:*`, so it would HIDE cards the
 *    browser's own `useAuth().hasPermission` shows (a `resource:write` holder asking for
 *    `resource:read`), and a server-hidden/client-shown split is itself a new fake entry.
 *
 * SO THE SEMANTICS ARE COPIED, NOT INVENTED: every rule below mirrors
 * `apps/web/src/composables/useAuth.ts#hasPermission` (:521-537) line for line, and
 * `apps/web/src/utils/permission-match.ts` is the same algebra on the browser side — both are
 * pinned to ONE truth table, `packages/core-backend/tests/fixtures/permission-match-truth-table.json`,
 * which both test suites read from disk so the two cannot drift silently.
 *
 * DELIBERATELY OUT OF SCOPE HERE: the admin bypass and the roles list. `useAuth().hasPermission`
 * short-circuits on its `isAdmin`/`roles` snapshot BEFORE reaching this algebra, so an admin marker
 * such as `admin:all` is NOT a wildcard in the code algebra itself. Keeping the bypass in the caller
 * is what lets the same truth table describe both sides. The router's bypass is
 * `isPlatformAppAdminRequest` in `routes/platform-apps.ts`.
 */

/** Trim + drop non-strings, matching `useAuth.ts#parseStringArray` (:304-317) exactly. */
export function normalizePermissionCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * Does `userCodes` satisfy the single required code `required`?
 *
 * An EMPTY/blank requirement is satisfied by anyone — same as `useAuth#hasPermission`'s
 * `if (!normalized) return true`. Callers that must not fail open on a blank requirement have to
 * reject it before calling.
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
 * ANY-OF, not all-of: a manifest's `permissions` array names the codes an app USES, not a
 * conjunction its users must all hold. One hit makes the app visible.
 *
 * An EMPTY `required` list means "this app declares no codes" and is treated as public to every
 * authenticated caller. All four shipped manifests declare a non-empty list, so this only governs
 * apps written later.
 *
 * A list that is declared but survives normalization as empty (`['', '  ']`) is NOT public: the app
 * asked for a gate and gave nothing usable, so this fails CLOSED rather than turning a typo into an
 * open door.
 */
export function matchesAnyPermission(userCodes: readonly string[], required: readonly string[]): boolean {
  const declaredCount = Array.isArray(required) ? required.length : 0
  const codes = normalizePermissionCodes(required as unknown)
  if (codes.length === 0) return declaredCount === 0
  return codes.some((code) => matchesPermission(userCodes, code))
}
