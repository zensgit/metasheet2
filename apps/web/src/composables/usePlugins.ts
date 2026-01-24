import { ref } from 'vue'
import { getApiBase } from '../utils/api'

export interface PluginViewContribution {
  id: string
  name: string
  component?: string
  type?: string
  icon?: string
  order?: number
  location?: string
  settings?: Record<string, unknown>
  pluginName?: string
  pluginDisplayName?: string
}

export interface PluginInfo {
  name: string
  version?: string
  displayName?: string
  status: 'active' | 'inactive' | 'failed'
  enabled?: boolean
  error?: string
  errorCode?: string
  lastAttempt?: string
  contributes?: {
    views?: PluginViewContribution[]
  }
}

const plugins = ref<PluginInfo[]>([])
const views = ref<PluginViewContribution[]>([])
const disabledViewIds = ref<string[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref<string | null>(null)

export function usePlugins() {
  async function fetchPlugins(options: { force?: boolean } = {}) {
    if (loading.value) return
    if (loaded.value && !options.force) return
    loading.value = true
    error.value = null
    const base = getApiBase()
    try {
      const res = await fetch(`${base}/api/plugins`)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const payload = await res.json()
      const data: PluginInfo[] = Array.isArray(payload) ? payload : (payload?.list || [])
      plugins.value = data

      const active = data.filter(p => p.status === 'active' && p.enabled !== false)
      const agg: PluginViewContribution[] = []
      for (const p of active) {
        const pv = p.contributes?.views || []
        for (const v of pv) {
          if (v && v.id && v.name) {
            agg.push({
              ...v,
              pluginName: p.name,
              pluginDisplayName: p.displayName
            })
          }
        }
      }
      views.value = agg

      const disabledViews = new Set<string>()
      for (const p of data) {
        if (p.enabled !== false) continue
        const pv = p.contributes?.views || []
        for (const v of pv) {
          if (v?.id) disabledViews.add(v.id)
        }
      }
      disabledViewIds.value = Array.from(disabledViews)
    } catch (e: any) {
      error.value = e?.message || 'Failed to load plugins'
      plugins.value = []
      views.value = []
      disabledViewIds.value = []
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  return { plugins, views, disabledViewIds, loading, loaded, error, fetchPlugins }
}
