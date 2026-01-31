import { ref } from 'vue'
import { getApiBase } from '../utils/api'

export interface ContributedView {
  id: string
  name: string
  component?: string
  icon?: string
  location?: string
  order?: number
}

export interface PluginInfo {
  name: string
  version?: string
  displayName?: string
  status: 'active' | 'inactive' | 'failed'
  error?: string
  errorCode?: string
  lastAttempt?: string
  contributes?: {
    views?: ContributedView[]
    menus?: Record<string, Array<{ command: string; group?: string; order?: number }>>
  }
}

export interface PluginViewEntry extends ContributedView {
  plugin: string
}

export interface PluginNavItem {
  id: string
  label: string
  path: string
  order?: number
}

export function usePlugins() {
  const plugins = ref<PluginInfo[]>([])
  const views = ref<PluginViewEntry[]>([])
  const navItems = ref<PluginNavItem[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchPlugins () {
    loading.value = true
    error.value = null
    const base = getApiBase()
    try {
      const res = await fetch(`${base}/api/plugins`)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const payload = await res.json()
      const data: PluginInfo[] = Array.isArray(payload) ? payload : (payload?.list || [])
      plugins.value = data
      // Aggregate views from active plugins only
      const active = data.filter(p => p.status === 'active')
      const agg: PluginViewEntry[] = []
      for (const p of active) {
        const pv = p.contributes?.views || []
        for (const v of pv) {
          if (v && v.id && v.name) agg.push({ ...v, plugin: p.name })
        }
      }
      views.value = agg
        .slice()
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))

      navItems.value = views.value
        .filter(v => v.location === 'main-nav')
        .map(v => ({
          id: `${v.plugin}:${v.id}`,
          label: v.name,
          path: `/p/${v.plugin}/${v.id}`,
          order: v.order,
        }))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label))
    } catch (e: any) {
      error.value = e?.message || 'Failed to load plugins'
    } finally {
      loading.value = false
    }
  }

  return { plugins, views, navItems, loading, error, fetchPlugins }
}
