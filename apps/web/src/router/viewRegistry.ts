import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import type { PluginViewContribution } from '../composables/usePlugins'
import AttendanceView from '../views/AttendanceView.vue'
import CalendarView from '../views/CalendarView.vue'
import FormView from '../views/FormView.vue'
import GalleryView from '../views/GalleryView.vue'
import GridView from '../views/UniverGridPOC.vue'
import KanbanView from '../views/UniverKanbanPOC.vue'
import PlmProductView from '../views/PlmProductView.vue'
import PluginAdminView from '../views/PluginAdminView.vue'
import PluginMissingView from '../views/PluginMissingView.vue'

export interface AppView {
  id: string
  name: string
  path: string
  componentKey: string
  order: number
  source: 'core' | 'plugin'
  query?: Record<string, string>
  icon?: string
  location?: string
  pluginName?: string
  pluginDisplayName?: string
}

const fallbackComponentKey = 'PluginMissingView'

const componentRegistry: Record<string, Component> = {
  GridView,
  KanbanView,
  CalendarView,
  GalleryView,
  FormView,
  AttendanceView,
  PlmProductView,
  PluginAdminView,
  PluginMissingView
}

const viewIdComponentKey: Record<string, string> = {
  grid: 'GridView',
  kanban: 'KanbanView',
  calendar: 'CalendarView',
  gallery: 'GalleryView',
  form: 'FormView',
  attendance: 'AttendanceView',
  plm: 'PlmProductView',
  gantt: 'PluginMissingView',
  'admin-plugins': 'PluginAdminView'
}

const coreViews: AppView[] = [
  {
    id: 'grid',
    name: 'Grid',
    path: '/grid',
    componentKey: 'GridView',
    order: 10,
    source: 'core',
    query: { source: 'meta' }
  },
  {
    id: 'kanban',
    name: 'Kanban',
    path: '/kanban',
    componentKey: 'KanbanView',
    order: 20,
    source: 'core',
    query: { source: 'meta' }
  },
  {
    id: 'calendar',
    name: 'Calendar',
    path: '/calendar',
    componentKey: 'CalendarView',
    order: 30,
    source: 'core'
  },
  {
    id: 'gallery',
    name: 'Gallery',
    path: '/gallery',
    componentKey: 'GalleryView',
    order: 40,
    source: 'core'
  },
  {
    id: 'form',
    name: 'Form',
    path: '/form',
    componentKey: 'FormView',
    order: 50,
    source: 'core'
  },
  {
    id: 'plm',
    name: 'PLM',
    path: '/plm',
    componentKey: 'PlmProductView',
    order: 70,
    source: 'core'
  },
  {
    id: 'admin-plugins',
    name: 'Plugins',
    path: '/admin/plugins',
    componentKey: 'PluginAdminView',
    order: 1000,
    source: 'core',
    location: 'hidden'
  }
]

function normalizePath(id: string): string {
  if (!id) return '/'
  return id.startsWith('/') ? id : `/${id}`
}

function resolveComponentKey(
  requested: string | undefined,
  viewId: string,
  fallback?: string
): string {
  const resolved = requested || viewIdComponentKey[viewId]
  if (resolved && componentRegistry[resolved]) return resolved
  if (fallback && componentRegistry[fallback]) return fallback
  return fallbackComponentKey
}

function toPluginAppView(
  view: PluginViewContribution,
  fallback?: AppView
): AppView | null {
  if (!view?.id || !view?.name) return null
  const componentKey = resolveComponentKey(view.component, view.id, fallback?.componentKey)
  return {
    id: view.id,
    name: view.name || fallback?.name || view.id,
    path: fallback?.path || normalizePath(view.id),
    componentKey,
    order: view.order ?? fallback?.order ?? 999,
    source: 'plugin',
    query: fallback?.query,
    icon: view.icon,
    location: view.location,
    pluginName: view.pluginName,
    pluginDisplayName: view.pluginDisplayName
  }
}

export function resolveAppViews(
  pluginViews: PluginViewContribution[],
  disabledViewIds: string[] = []
): AppView[] {
  const disabled = new Set(disabledViewIds)
  const byId = new Map(
    coreViews
      .filter(view => !disabled.has(view.id))
      .map(view => [view.id, view])
  )

  for (const view of pluginViews) {
    const fallback = byId.get(view.id)
    const merged = toPluginAppView(view, fallback)
    if (!merged) continue
    byId.set(merged.id, merged)
  }

  return Array.from(byId.values())
    .filter(view => view.componentKey && componentRegistry[view.componentKey])
    .sort((a, b) => (a.order || 0) - (b.order || 0))
}

export function buildViewRoutes(views: AppView[]): RouteRecordRaw[] {
  const routes: RouteRecordRaw[] = []
  const seenPaths = new Set<string>()

  for (const view of views) {
    if (seenPaths.has(view.path)) continue
    const component = componentRegistry[view.componentKey] || componentRegistry[fallbackComponentKey]
    routes.push({
      path: view.path,
      name: view.id,
      component,
      meta: {
        title: view.name,
        viewId: view.id,
        pluginName: view.pluginName
      }
    })
    seenPaths.add(view.path)
  }

  return routes
}

export function buildNavViews(views: AppView[]): AppView[] {
  return views.filter(view => view.location !== 'hidden')
}
