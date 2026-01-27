<template>
  <section class="plugin-admin">
    <header class="plugin-admin__header">
      <div>
        <h1 class="plugin-admin__title">Plugin Manager</h1>
        <p class="plugin-admin__subtitle">Manage runtime status and configuration for installed plugins.</p>
      </div>
      <button class="btn btn--primary" :disabled="loading" @click="refresh">
        {{ loading ? 'Refreshing...' : 'Refresh' }}
      </button>
    </header>

    <div v-if="error" class="plugin-admin__error">{{ error }}</div>
    <div v-else-if="loading" class="plugin-admin__loading">Loading plugins...</div>

    <div v-else class="plugin-admin__grid">
      <article v-for="plugin in plugins" :key="plugin.name" class="plugin-card">
        <div class="plugin-card__header">
          <div>
            <h2 class="plugin-card__title">{{ plugin.displayName || plugin.name }}</h2>
            <p class="plugin-card__id">{{ plugin.name }}</p>
          </div>
          <span class="status-chip" :class="statusClass(plugin.status)">
            {{ plugin.status }}
          </span>
        </div>

        <p v-if="plugin.description" class="plugin-card__desc">{{ plugin.description }}</p>

        <div class="plugin-card__meta">
          <span>Version: {{ plugin.version || 'unknown' }}</span>
          <span>Registry: {{ plugin.registryStatus || 'n/a' }}</span>
          <span v-if="plugin.lastActivated">Last activated: {{ plugin.lastActivated }}</span>
        </div>

        <div v-if="plugin.error" class="plugin-card__error">Error: {{ plugin.error }}</div>
        <div v-if="actionErrors[plugin.name]" class="plugin-card__error">
          {{ actionErrors[plugin.name] }}
        </div>

        <div class="plugin-card__actions">
          <button
            class="btn btn--secondary"
            :disabled="actionLoading[plugin.name]"
            @click="togglePlugin(plugin)"
          >
            {{ plugin.status === 'active' ? 'Disable' : 'Enable' }}
          </button>
          <button
            class="btn btn--ghost"
            :disabled="actionLoading[plugin.name]"
            @click="reloadPlugin(plugin)"
          >
            Reload
          </button>
        </div>

        <div class="plugin-card__config">
          <div class="plugin-card__config-header">
            <span>Config</span>
            <button
              class="btn btn--ghost"
              :disabled="configLoading[plugin.name]"
              @click="loadConfig(plugin)"
            >
              {{ configLoading[plugin.name] ? 'Loading...' : 'Load' }}
            </button>
          </div>

          <div v-if="configState[plugin.name]" class="plugin-card__config-body">
            <textarea
              v-model="configDraft[plugin.name]"
              class="plugin-card__textarea"
              rows="6"
              spellcheck="false"
            />
            <div class="plugin-card__config-actions">
              <button
                class="btn btn--primary"
                :disabled="configSaving[plugin.name]"
                @click="saveConfig(plugin)"
              >
                {{ configSaving[plugin.name] ? 'Saving...' : 'Save config' }}
              </button>
              <span v-if="configHints[plugin.name]" class="plugin-card__config-note">
                {{ configHints[plugin.name] }}
              </span>
            </div>
            <div v-if="configErrors[plugin.name]" class="plugin-card__error">
              {{ configErrors[plugin.name] }}
            </div>
            <details v-if="configState[plugin.name]?.schema" class="plugin-card__schema">
              <summary>Schema</summary>
              <pre>{{ formatJson(configState[plugin.name]?.schema) }}</pre>
            </details>
          </div>
          <div v-else class="plugin-card__config-empty">No config loaded.</div>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { apiFetch } from '../utils/api'

type PluginStatus = 'active' | 'inactive' | 'failed'

interface PluginEntry {
  name: string
  displayName?: string
  description?: string
  version?: string
  author?: string
  status: PluginStatus
  error?: string | null
  lastAttempt?: string | null
  registryStatus?: string | null
  lastActivated?: string | null
}

interface PluginConfigEntry {
  config?: Record<string, unknown>
  schema?: Record<string, unknown> | null
  version?: string | null
  last_modified?: string | null
  modified_by?: string | null
}

const plugins = ref<PluginEntry[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const actionLoading = reactive<Record<string, boolean>>({})
const actionErrors = reactive<Record<string, string | null>>({})

const configState = reactive<Record<string, PluginConfigEntry | null>>({})
const configDraft = reactive<Record<string, string>>({})
const configLoading = reactive<Record<string, boolean>>({})
const configSaving = reactive<Record<string, boolean>>({})
const configErrors = reactive<Record<string, string | null>>({})
const configHints = reactive<Record<string, string | null>>({})

const formatJson = (value: unknown) => JSON.stringify(value ?? {}, null, 2)

const statusClass = (status: PluginStatus) => {
  if (status === 'active') return 'status-chip--active'
  if (status === 'failed') return 'status-chip--failed'
  return 'status-chip--inactive'
}

const refresh = async () => {
  loading.value = true
  error.value = null
  try {
    const response = await apiFetch('/api/admin/plugins')
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const payload = await response.json()
    plugins.value = Array.isArray(payload?.list) ? payload.list : []
  } catch (err: any) {
    error.value = err?.message || 'Failed to load plugins'
  } finally {
    loading.value = false
  }
}

const togglePlugin = async (plugin: PluginEntry) => {
  const action = plugin.status === 'active' ? 'disable' : 'enable'
  actionLoading[plugin.name] = true
  actionErrors[plugin.name] = null
  try {
    const response = await apiFetch(`/api/admin/plugins/${plugin.name}/${action}`, { method: 'POST' })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    await refresh()
  } catch (err: any) {
    actionErrors[plugin.name] = err?.message || `Failed to ${action} plugin`
  } finally {
    actionLoading[plugin.name] = false
  }
}

const reloadPlugin = async (plugin: PluginEntry) => {
  actionLoading[plugin.name] = true
  actionErrors[plugin.name] = null
  try {
    const response = await apiFetch(`/api/admin/plugins/${plugin.name}/reload`, { method: 'POST' })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    await refresh()
  } catch (err: any) {
    actionErrors[plugin.name] = err?.message || 'Reload failed (SafetyGuard may be required)'
  } finally {
    actionLoading[plugin.name] = false
  }
}

const loadConfig = async (plugin: PluginEntry) => {
  configLoading[plugin.name] = true
  configErrors[plugin.name] = null
  configHints[plugin.name] = null
  try {
    const response = await apiFetch(`/api/admin/plugins/${plugin.name}/config`)
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const payload = await response.json()
    const entry: PluginConfigEntry = payload?.config || {}
    configState[plugin.name] = entry
    configDraft[plugin.name] = formatJson(entry.config || {})
    configHints[plugin.name] = entry.last_modified ? `Last modified: ${entry.last_modified}` : null
  } catch (err: any) {
    configErrors[plugin.name] = err?.message || 'Failed to load config'
  } finally {
    configLoading[plugin.name] = false
  }
}

const saveConfig = async (plugin: PluginEntry) => {
  configSaving[plugin.name] = true
  configErrors[plugin.name] = null
  try {
    const draft = configDraft[plugin.name] || '{}'
    const parsed = JSON.parse(draft)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Config must be a JSON object')
    }
    const response = await apiFetch(`/api/admin/plugins/${plugin.name}/config`, {
      method: 'PUT',
      body: JSON.stringify({
        config: parsed,
        schema: configState[plugin.name]?.schema ?? null,
        version: configState[plugin.name]?.version ?? '1.0.0'
      })
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const payload = await response.json()
    configHints[plugin.name] = payload?.persisted?.persisted
      ? 'Saved to database'
      : 'Saved in memory'
    configState[plugin.name] = {
      ...(configState[plugin.name] || {}),
      config: parsed
    }
  } catch (err: any) {
    configErrors[plugin.name] = err?.message || 'Failed to save config'
  } finally {
    configSaving[plugin.name] = false
  }
}

onMounted(() => {
  refresh()
})
</script>

<style scoped>
.plugin-admin {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.plugin-admin__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.plugin-admin__title {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 6px;
}

.plugin-admin__subtitle {
  color: #666;
}

.plugin-admin__error {
  background: #ffe6e6;
  border: 1px solid #ffb3b3;
  color: #b71c1c;
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 12px;
}

.plugin-admin__loading {
  color: #666;
}

.plugin-admin__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.plugin-card {
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.plugin-card__header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.plugin-card__title {
  font-size: 18px;
  font-weight: 600;
}

.plugin-card__id {
  color: #888;
  font-size: 12px;
}

.plugin-card__desc {
  color: #555;
}

.plugin-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  color: #666;
  font-size: 12px;
}

.plugin-card__actions {
  display: flex;
  gap: 8px;
}

.plugin-card__error {
  background: #fff5f5;
  border: 1px solid #ffd2d2;
  color: #b71c1c;
  padding: 8px;
  border-radius: 8px;
  font-size: 12px;
}

.plugin-card__config {
  border-top: 1px dashed #e5e5e5;
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plugin-card__config-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  color: #444;
}

.plugin-card__config-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plugin-card__config-empty {
  color: #888;
  font-size: 12px;
}

.plugin-card__textarea {
  width: 100%;
  border: 1px solid #dcdcdc;
  border-radius: 8px;
  padding: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 12px;
  color: #333;
  background: #fafafa;
}

.plugin-card__config-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-card__config-note {
  font-size: 12px;
  color: #2e7d32;
}

.plugin-card__schema pre {
  background: #f5f5f5;
  padding: 8px;
  border-radius: 8px;
  font-size: 12px;
  overflow: auto;
}

.status-chip {
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 12px;
  text-transform: capitalize;
}

.status-chip--active {
  background: #e3f2fd;
  color: #1565c0;
}

.status-chip--inactive {
  background: #f5f5f5;
  color: #666;
}

.status-chip--failed {
  background: #ffebee;
  color: #c62828;
}

.btn {
  border: none;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
}

.btn--primary {
  background: #1976d2;
  color: #fff;
}

.btn--secondary {
  background: #e3f2fd;
  color: #1565c0;
}

.btn--ghost {
  background: transparent;
  color: #1976d2;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
