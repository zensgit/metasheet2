<template>
  <section class="after-sales-view">
    <header class="after-sales-view__hero">
      <div>
        <p class="after-sales-view__eyebrow">Platform App Skeleton</p>
        <h1>After Sales</h1>
        <p class="after-sales-view__lead">
          This page is the low-conflict shell for the future after-sales bounded context.
        </p>
      </div>
      <div class="after-sales-view__status">
        <span v-if="loading">Loading manifest...</span>
        <span v-else-if="error">{{ error }}</span>
        <span v-else>Manifest connected</span>
      </div>
    </header>

    <section class="after-sales-view__grid">
      <article class="after-sales-view__card">
        <h2>Scope</h2>
        <p>Service tickets, installed assets, warranty policies, dispatch, escalation, and closure feedback.</p>
      </article>

      <article class="after-sales-view__card">
        <h2>Platform dependencies</h2>
        <ul v-if="manifest?.platformDependencies?.length" class="after-sales-view__list">
          <li v-for="item in manifest.platformDependencies" :key="item">{{ item }}</li>
        </ul>
        <p v-else>No manifest data loaded.</p>
      </article>

      <article class="after-sales-view__card">
        <h2>Objects</h2>
        <ul v-if="manifest?.objects?.length" class="after-sales-view__list">
          <li v-for="item in manifest.objects" :key="item.id">{{ item.name }} ({{ item.backing }})</li>
        </ul>
        <p v-else>No objects declared yet.</p>
      </article>

      <article class="after-sales-view__card">
        <h2>Workflows</h2>
        <ul v-if="manifest?.workflows?.length" class="after-sales-view__list">
          <li v-for="item in manifest.workflows" :key="item.id">{{ item.name }}</li>
        </ul>
        <p v-else>No workflows declared yet.</p>
      </article>
    </section>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiFetch } from '../utils/api'

interface AfterSalesManifest {
  id: string
  displayName: string
  platformDependencies: string[]
  objects: Array<{ id: string; name: string; backing: string }>
  workflows: Array<{ id: string; name: string }>
}

const loading = ref(true)
const error = ref('')
const manifest = ref<AfterSalesManifest | null>(null)

onMounted(async () => {
  try {
    const response = await apiFetch('/api/after-sales/app-manifest')
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    const payload = await response.json()
    manifest.value = payload?.data || null
  } catch (err: any) {
    error.value = err?.message || 'Failed to load after-sales manifest'
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.after-sales-view {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.after-sales-view__hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding: 28px;
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(14, 116, 144, 0.1), rgba(245, 158, 11, 0.12)),
    #ffffff;
  border: 1px solid rgba(14, 116, 144, 0.14);
}

.after-sales-view__eyebrow {
  margin: 0 0 8px;
  font-size: 12px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #0f766e;
}

.after-sales-view__hero h1 {
  margin: 0;
  font-size: 32px;
  line-height: 1.05;
  color: #0f172a;
}

.after-sales-view__lead {
  margin: 12px 0 0;
  max-width: 640px;
  color: #334155;
}

.after-sales-view__status {
  min-width: 180px;
  padding: 10px 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(15, 23, 42, 0.08);
  color: #0f172a;
  font-size: 13px;
  text-align: center;
}

.after-sales-view__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.after-sales-view__card {
  padding: 20px;
  border-radius: 16px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
}

.after-sales-view__card h2 {
  margin: 0 0 12px;
  font-size: 16px;
  color: #0f172a;
}

.after-sales-view__card p {
  margin: 0;
  color: #475569;
  line-height: 1.6;
}

.after-sales-view__list {
  margin: 0;
  padding-left: 18px;
  color: #334155;
}

.after-sales-view__list li + li {
  margin-top: 8px;
}
</style>
