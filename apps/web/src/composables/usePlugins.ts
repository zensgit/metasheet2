import { ref } from 'vue'
import { getApiBase } from '../utils/api'

export interface PluginInfo {
  name: string
  version?: string
  displayName?: string
  status: 'active' | 'inactive' | 'failed'
  error?: string
  errorCode?: string
  lastAttempt?: string
  contributes?: {
    views?: Array<{ id: string; name: string; component?: string }>
  }
}

export function usePlugins() {
  const plugins = ref<PluginInfo[]>([])
  const views = ref<Array<{ id: string; name: string; component?: string }>>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchPlugins () {
    loading.value = true
    error.value = null
    const base = getApiBase()
    try {
      const res = await fetch(`${base}/api/plugins`)
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const data: PluginInfo[] = await res.json()
      plugins.value = data
      // Aggregate views from active plugins only
      const active = data.filter(p => p.status === 'active')
      const agg: Array<{ id: string; name: string; component?: string }> = []
      for (const p of active) {
        const pv = p.contributes?.views || []
        for (const v of pv) {
          if (v && v.id && v.name) agg.push(v)
        }
      }
      views.value = agg
    } catch (e: any) {
      error.value = e?.message || 'Failed to load plugins'
    } finally {
      loading.value = false
    }
  }

  return { plugins, views, loading, error, fetchPlugins }
}
