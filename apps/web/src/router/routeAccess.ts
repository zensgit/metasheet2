/**
 * Pure route permission gate, extracted from the router `beforeEach` guard
 * (`main.ts`) so the "non-manager is redirected away from manage-gated routes"
 * invariant can be unit-tested against the REAL `appRoutes` meta. Previously the
 * check lived only inline in the guard with no test, so a drift between a FE
 * route's `meta.permissions` and the backend `rbacGuard` string (e.g. the
 * approval-template authoring routes) would pass CI silently.
 *
 * Behaviour matches the original inline check byte-for-byte: a route with no
 * declared `permissions` is always permitted; otherwise the user must hold
 * EVERY declared permission.
 */

/** The `permissions` array declared on a route's meta, or `[]` if none/!array. */
export function routeMetaPermissions(meta: unknown): string[] {
  const permissions = (meta as { permissions?: unknown } | null | undefined)?.permissions
  return Array.isArray(permissions) ? (permissions as string[]) : []
}

/**
 * Whether a route is permitted given a permission probe. Mirrors the guard:
 * `permitted = required.length === 0 || required.every(hasPermission)`, so
 * `!isRoutePermitted(...)` === the original `length > 0 && !every(...)` redirect
 * condition.
 */
export function isRoutePermitted(
  meta: unknown,
  hasPermission: (permission: string) => boolean,
): boolean {
  const required = routeMetaPermissions(meta)
  return required.length === 0 || required.every((permission) => hasPermission(permission))
}
