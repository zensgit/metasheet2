<template>
  <section class="plugin-view-host">
    <div v-if="loading" class="plugin-view-host__state">Loading plugin view...</div>
    <div v-else-if="error" class="plugin-view-host__state">{{ error }}</div>
    <div v-else-if="!activePlugin" class="plugin-view-host__state">
      Plugin not found or inactive.
    </div>
    <div v-else-if="!activeView" class="plugin-view-host__state">
      View not found for this plugin.
    </div>
    <div v-else-if="!activeComponent" class="plugin-view-host__state">
      View component not registered.
    </div>
    <component v-else :is="activeComponent" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { usePlugins } from '../composables/usePlugins'
import { viewRegistry } from '../plugins/viewRegistry'

const route = useRoute()
const { plugins, views, loading, error, fetchPlugins } = usePlugins()

const pluginName = computed(() => String(route.params.plugin || ''))
const viewId = computed(() => String(route.params.viewId || ''))

const activePlugin = computed(() => {
  return plugins.value.find(plugin => plugin.name === pluginName.value && plugin.status === 'active')
})

const activeView = computed(() => {
  if (!activePlugin.value) return null
  return views.value.find(view => view.plugin === activePlugin.value?.name && view.id === viewId.value) || null
})

const activeComponent = computed(() => {
  const componentName = activeView.value?.component
  if (!componentName) return null
  return viewRegistry[componentName] || null
})

onMounted(async () => {
  await fetchPlugins()
})
</script>

<style scoped>
.plugin-view-host {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.plugin-view-host__state {
  padding: 24px;
  background: #fff;
  border-radius: 12px;
  border: 1px solid #eee;
  color: #666;
  font-size: 14px;
}
</style>
