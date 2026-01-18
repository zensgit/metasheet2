<template>
  <div class="spreadsheets">
    <header class="spreadsheets__header">
      <div>
        <h2 class="spreadsheets__title">Spreadsheets</h2>
        <p class="spreadsheets__subtitle">Create and manage spreadsheet workspaces.</p>
      </div>
      <div class="spreadsheets__actions">
        <button class="spreadsheets__btn" :disabled="loading" @click="fetchSpreadsheets">Refresh</button>
      </div>
    </header>

    <section class="spreadsheets__card">
      <h3>Create Spreadsheet</h3>
      <div class="spreadsheets__form">
        <label class="spreadsheets__field">
          <span>Name</span>
          <input v-model="name" type="text" placeholder="Quarterly Review" />
        </label>
        <label class="spreadsheets__field">
          <span>First Sheet</span>
          <input v-model="firstSheet" type="text" placeholder="Sheet1" />
        </label>
        <button class="spreadsheets__btn spreadsheets__btn--primary" :disabled="creating" @click="createSpreadsheet">
          {{ creating ? 'Creating...' : 'Create' }}
        </button>
        <span v-if="statusMessage" class="spreadsheets__status" :class="{ 'spreadsheets__status--error': statusKind === 'error' }">
          {{ statusMessage }}
        </span>
      </div>
    </section>

    <section class="spreadsheets__card">
      <div class="spreadsheets__list-header">
        <h3>Available Spreadsheets</h3>
        <span v-if="spreadsheets.length" class="spreadsheets__count">{{ spreadsheets.length }} items</span>
      </div>

      <div v-if="loading" class="spreadsheets__empty">Loading spreadsheets...</div>
      <div v-else-if="errorMessage" class="spreadsheets__empty spreadsheets__empty--error">{{ errorMessage }}</div>
      <div v-else-if="!spreadsheets.length" class="spreadsheets__empty">No spreadsheets yet.</div>
      <div v-else class="spreadsheets__list">
        <div v-for="sheet in spreadsheets" :key="sheet.id" class="spreadsheets__item">
          <div>
            <h4>{{ sheet.name }}</h4>
            <p class="spreadsheets__meta">ID: {{ sheet.id }}</p>
            <p v-if="sheet.created_at" class="spreadsheets__meta">Created: {{ formatDate(sheet.created_at) }}</p>
          </div>
          <button class="spreadsheets__btn" @click="openSpreadsheet(sheet.id)">Open</button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiFetch } from '../utils/api'

interface SpreadsheetItem {
  id: string
  name: string
  owner_id?: string | null
  created_at?: string
}

const router = useRouter()
const spreadsheets = ref<SpreadsheetItem[]>([])
const loading = ref(false)
const creating = ref(false)
const errorMessage = ref('')
const statusMessage = ref('')
const statusKind = ref<'success' | 'error'>('success')
const name = ref('')
const firstSheet = ref('Sheet1')

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

async function fetchSpreadsheets() {
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await apiFetch('/api/spreadsheets')
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || 'Failed to load spreadsheets')
    }
    spreadsheets.value = payload.data?.items ?? []
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'Failed to load spreadsheets'
  } finally {
    loading.value = false
  }
}

async function createSpreadsheet() {
  if (!name.value.trim()) {
    statusKind.value = 'error'
    statusMessage.value = 'Name is required.'
    return
  }
  creating.value = true
  statusMessage.value = ''
  try {
    const response = await apiFetch('/api/spreadsheets', {
      method: 'POST',
      body: JSON.stringify({
        name: name.value.trim(),
        initial_sheets: firstSheet.value.trim() ? [{ name: firstSheet.value.trim() }] : undefined
      })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || 'Failed to create spreadsheet')
    }
    const created = payload.data?.spreadsheet
    statusKind.value = 'success'
    statusMessage.value = 'Spreadsheet created.'
    name.value = ''
    await fetchSpreadsheets()
    if (created?.id) {
      router.push(`/spreadsheets/${created.id}`)
    }
  } catch (error) {
    statusKind.value = 'error'
    statusMessage.value = error instanceof Error ? error.message : 'Failed to create spreadsheet'
  } finally {
    creating.value = false
  }
}

function openSpreadsheet(id: string) {
  router.push(`/spreadsheets/${id}`)
}

onMounted(fetchSpreadsheets)
</script>

<style scoped>
.spreadsheets {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.spreadsheets__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.spreadsheets__title {
  font-size: 24px;
  font-weight: 600;
}

.spreadsheets__subtitle {
  color: #666;
}

.spreadsheets__actions {
  display: flex;
  gap: 10px;
}

.spreadsheets__card {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.spreadsheets__form {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-end;
  margin-top: 12px;
}

.spreadsheets__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 200px;
}

.spreadsheets__field input {
  padding: 8px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
}

.spreadsheets__btn {
  padding: 8px 14px;
  border: 1px solid #d0d0d0;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.spreadsheets__btn:hover {
  background: #f0f0f0;
}

.spreadsheets__btn--primary {
  background: #1976d2;
  color: #fff;
  border-color: #1976d2;
}

.spreadsheets__btn--primary:hover {
  background: #1565c0;
}

.spreadsheets__status {
  font-size: 13px;
  color: #2e7d32;
}

.spreadsheets__status--error {
  color: #c62828;
}

.spreadsheets__list-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.spreadsheets__list {
  display: grid;
  gap: 12px;
  margin-top: 14px;
}

.spreadsheets__item {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 12px 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.spreadsheets__meta {
  color: #777;
  font-size: 12px;
}

.spreadsheets__empty {
  color: #777;
  padding: 12px 0;
}

.spreadsheets__empty--error {
  color: #c62828;
}

.spreadsheets__count {
  font-size: 12px;
  color: #666;
}

@media (max-width: 768px) {
  .spreadsheets__header {
    flex-direction: column;
    align-items: flex-start;
  }

  .spreadsheets__form {
    flex-direction: column;
    align-items: stretch;
  }

  .spreadsheets__item {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
