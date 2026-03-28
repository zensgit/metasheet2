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
    mode: firstQueryValue(route.query.mode),
    embedded: parseQueryBoolean(route.query.embedded),
    role: parseMultitableRole(route.query.role),
  }
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
