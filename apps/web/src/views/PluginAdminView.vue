<template>
  <div class="plugin-admin">
    <header class="plugin-admin__header">
      <div>
        <h2>Plugin Management</h2>
        <p>Toggle module availability. Changes affect navigation immediately.</p>
      </div>
      <button class="plugin-admin__btn" :disabled="loading" @click="loadPlugins">
        {{ loading ? 'Loading...' : 'Refresh' }}
      </button>
    </header>

    <div v-if="error" class="plugin-admin__error">{{ error }}</div>

    <table class="plugin-admin__table" v-if="plugins.length">
      <thead>
        <tr>
          <th>Name</th>
          <th>Status</th>
          <th>Enabled</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="plugin in plugins" :key="plugin.name">
          <td>
            <div class="plugin-admin__name">
              <strong>{{ plugin.displayName || plugin.name }}</strong>
              <span class="plugin-admin__muted">{{ plugin.name }}</span>
            </div>
          </td>
          <td>
            <span class="plugin-admin__status" :class="`plugin-admin__status--${plugin.status}`">
              {{ plugin.status }}
            </span>
          </td>
          <td>
            <label class="plugin-admin__switch">
              <input
                type="checkbox"
                :checked="plugin.enabled"
                :disabled="saving === plugin.name"
                @change="toggleEnabled(plugin, $event)"
              />
              <span class="plugin-admin__slider"></span>
            </label>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-else-if="!loading" class="plugin-admin__empty">No plugins found.</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'

interface PluginRow {
  name: string
  displayName?: string
  status: 'active' | 'inactive' | 'failed'
  enabled: boolean
}

const plugins = ref<PluginRow[]>([])
const loading = ref(false)
const saving = ref<string | null>(null)
const error = ref('')

async function loadPlugins() {
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch('/api/plugins')
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const data = await res.json()
    plugins.value = (Array.isArray(data) ? data : []).map((item: any) => ({
      name: item.name,
      displayName: item.displayName,
      status: item.status,
      enabled: item.enabled !== false
    }))
  } catch (err: any) {
    error.value = err?.message || 'Failed to load plugins'
  } finally {
    loading.value = false
  }
}

async function toggleEnabled(plugin: PluginRow, event: Event) {
  const target = event.target as HTMLInputElement
  const nextEnabled = target.checked
  saving.value = plugin.name
  error.value = ''
  try {
    const res = await apiFetch('/api/admin/plugins/config', {
      method: 'PUT',
      body: JSON.stringify({ plugin: plugin.name, enabled: nextEnabled })
    })
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}`)
    }
    plugin.enabled = nextEnabled
    plugin.status = nextEnabled ? plugin.status : 'inactive'
  } catch (err: any) {
    error.value = err?.message || 'Failed to update plugin'
    target.checked = plugin.enabled
  } finally {
    saving.value = null
  }
}

onMounted(() => {
  loadPlugins()
})
</script>

<style scoped>
.plugin-admin {
  max-width: 960px;
  margin: 32px auto;
  padding: 0 24px 48px;
}

.plugin-admin__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
}

.plugin-admin__header h2 {
  font-size: 22px;
  margin-bottom: 4px;
}

.plugin-admin__header p {
  color: #6b7280;
}

.plugin-admin__btn {
  border: 1px solid #d1d5db;
  background: #fff;
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
}

.plugin-admin__btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.plugin-admin__error {
  background: #fee2e2;
  color: #b91c1c;
  padding: 10px 12px;
  border-radius: 8px;
  margin-bottom: 16px;
}

.plugin-admin__table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  overflow: hidden;
}

.plugin-admin__table th,
.plugin-admin__table td {
  padding: 12px 16px;
  text-align: left;
  border-bottom: 1px solid #f3f4f6;
}

.plugin-admin__table th {
  background: #f9fafb;
  font-weight: 600;
  color: #374151;
}

.plugin-admin__name {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.plugin-admin__muted {
  color: #9ca3af;
  font-size: 12px;
}

.plugin-admin__status {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.plugin-admin__status--active {
  background: #dcfce7;
  color: #166534;
}

.plugin-admin__status--inactive {
  background: #e5e7eb;
  color: #374151;
}

.plugin-admin__status--failed {
  background: #fee2e2;
  color: #b91c1c;
}

.plugin-admin__switch {
  position: relative;
  display: inline-block;
  width: 46px;
  height: 26px;
}

.plugin-admin__switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.plugin-admin__slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: #d1d5db;
  border-radius: 999px;
  transition: background 0.2s ease;
}

.plugin-admin__slider::before {
  content: '';
  position: absolute;
  height: 20px;
  width: 20px;
  left: 3px;
  top: 3px;
  background: #fff;
  border-radius: 999px;
  transition: transform 0.2s ease;
}

.plugin-admin__switch input:checked + .plugin-admin__slider {
  background: #2563eb;
}

.plugin-admin__switch input:checked + .plugin-admin__slider::before {
  transform: translateX(20px);
}

.plugin-admin__empty {
  color: #6b7280;
  padding: 16px;
}
</style>
