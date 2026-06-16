import type { LocationQueryValue, RouteRecordRaw } from 'vue-router'
import { AppRouteNames, ROUTE_PATHS } from './types'
import type { MultitableRole } from '../multitable/composables/useMultitableCapabilities'

function firstQueryValue(value: LocationQueryValue | LocationQueryValue[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
  return undefined
}

function parseQueryBoolean(value: LocationQueryValue | LocationQueryValue[] | undefined): boolean | undefined {
  const raw = firstQueryValue(value)?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return undefined
}

function parseMultitableRole(value: LocationQueryValue | LocationQueryValue[] | undefined): MultitableRole | undefined {
  const raw = firstQueryValue(value)
  if (raw === 'owner' || raw === 'editor' || raw === 'commenter' || raw === 'viewer') {
    return raw
  }
  return undefined
}

type MultitableRouteSource = {
  params: Record<string, unknown>
  query: Record<string, LocationQueryValue | LocationQueryValue[] | undefined>
}

export function resolveMultitableRouteProps(route: MultitableRouteSource) {
  return {
    baseId: firstQueryValue(route.query.baseId),
    sheetId: typeof route.params.sheetId === 'string' ? route.params.sheetId : undefined,
    viewId: typeof route.params.viewId === 'string' ? route.params.viewId : undefined,
    recordId: firstQueryValue(route.query.recordId),
    commentId: firstQueryValue(route.query.commentId),
    fieldId: firstQueryValue(route.query.fieldId),
    openComments: parseQueryBoolean(route.query.openComments),
    mode: firstQueryValue(route.query.mode),
    embedded: parseQueryBoolean(route.query.embedded),
    role: parseMultitableRole(route.query.role),
  }
}

export function resolvePublicMultitableFormRouteProps(route: MultitableRouteSource) {
  return {
    sheetId: typeof route.params.sheetId === 'string' ? route.params.sheetId : undefined,
    viewId: typeof route.params.viewId === 'string' ? route.params.viewId : undefined,
    publicToken: firstQueryValue(route.query.publicToken),
    // A4: surface the raw query so the public form can read `?prefill_<fieldId>=`
    // params. The component applies the author `prefillableFieldIds` allowlist
    // (carried in the loaded form-context) + read-only/system filtering — the
    // router only forwards; it deliberately does NOT decide what is prefillable
    // (the allowlist arrives with the context, not the route).
    prefillQuery: collectPrefillQuery(route.query),
  }
}

// Forward only `prefill_*` query params as a flat string map (first value per
// key). Non-prefill query params (publicToken, etc.) are excluded so the prop
// stays a focused, serializable seed source.
function collectPrefillQuery(
  query: Record<string, LocationQueryValue | LocationQueryValue[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('prefill_')) continue
    const first = firstQueryValue(value)
    if (typeof first === 'string') out[key] = first
  }
  return out
}

export function buildMultitableRoute(component: NonNullable<RouteRecordRaw['component']>): RouteRecordRaw {
  return {
    path: ROUTE_PATHS.MULTITABLE,
    name: AppRouteNames.MULTITABLE,
    component,
    props: resolveMultitableRouteProps,
    meta: { title: 'Multitable', requiresAuth: true },
  }
}

export function buildPublicMultitableFormRoute(component: NonNullable<RouteRecordRaw['component']>): RouteRecordRaw {
  return {
    path: ROUTE_PATHS.MULTITABLE_PUBLIC_FORM,
    name: AppRouteNames.MULTITABLE_PUBLIC_FORM,
    component,
    props: resolvePublicMultitableFormRouteProps,
    meta: { title: 'Public Multitable Form', hideNavbar: true, requiresAuth: false, skipShellBootstrap: true },
  }
}
