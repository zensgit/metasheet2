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
 * EVERY declared permission. A route that declares `permissionsAnyOf` additionally
 * needs at least one of those.
 */

/** The `permissions` array declared on a route's meta, or `[]` if none/!array. */
export function routeMetaPermissions(meta: unknown): string[] {
  const permissions = (meta as { permissions?: unknown } | null | undefined)?.permissions
  return Array.isArray(permissions) ? (permissions as string[]) : []
}

/** The `permissionsAnyOf` array declared on a route's meta, or `[]` if none/!array. */
export function routeMetaPermissionsAnyOf(meta: unknown): string[] {
  const permissions = (meta as { permissionsAnyOf?: unknown } | null | undefined)?.permissionsAnyOf
  return Array.isArray(permissions) ? (permissions as string[]) : []
}

/**
 * Whether a route is permitted given a permission probe. Mirrors the guard:
 * `permitted = required.length === 0 || required.every(hasPermission)`, so
 * `!isRoutePermitted(...)` === the original `length > 0 && !every(...)` redirect
 * condition. `permissionsAnyOf`, when declared, must also have one code held.
 */
export function isRoutePermitted(
  meta: unknown,
  hasPermission: (permission: string) => boolean,
): boolean {
  const required = routeMetaPermissions(meta)
  if (required.length > 0 && !required.every((permission) => hasPermission(permission))) return false
  const anyOf = routeMetaPermissionsAnyOf(meta)
  return anyOf.length === 0 || anyOf.some((permission) => hasPermission(permission))
}
