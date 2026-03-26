export type PlmDeferredRouteQueryPatch = Record<string, string | number | boolean | undefined>

export function mergePlmDeferredRouteQueryPatch(
  current: PlmDeferredRouteQueryPatch | null,
  patch: PlmDeferredRouteQueryPatch,
): PlmDeferredRouteQueryPatch | null {
  const entries = Object.entries(patch)
  if (!entries.length) {
    return current
  }

  const next: PlmDeferredRouteQueryPatch = {
    ...(current || {}),
  }
  for (const [key, value] of entries) {
    next[key] = value
  }
  return next
}

export function resolvePlmDeferredRouteQueryPatch(
  current: PlmDeferredRouteQueryPatch | null,
  hasPendingHydration: boolean,
) {
  if (!current || !Object.keys(current).length) {
    return {
      pendingPatch: null,
      flushPatch: null,
    }
  }

  if (hasPendingHydration) {
    return {
      pendingPatch: current,
      flushPatch: null,
    }
  }

  return {
    pendingPatch: null,
    flushPatch: current,
  }
}
