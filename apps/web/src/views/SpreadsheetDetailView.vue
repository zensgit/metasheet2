<template>
  <div class="spreadsheet-detail">
    <header class="spreadsheet-detail__header">
      <div>
        <h2 class="spreadsheet-detail__title">{{ spreadsheet?.name || 'Spreadsheet' }}</h2>
        <p class="spreadsheet-detail__subtitle">{{ spreadsheet?.id }}</p>
      </div>
      <div class="spreadsheet-detail__actions">
        <button class="spreadsheet-detail__btn" :disabled="loading" @click="fetchSpreadsheet">Refresh</button>
        <button class="spreadsheet-detail__btn" @click="goBack">Back</button>
      </div>
    </header>

    <section class="spreadsheet-detail__card">
      <h3>Sheets</h3>
      <div v-if="!spreadsheet?.sheets?.length" class="spreadsheet-detail__empty">No sheets available.</div>
      <div v-else class="spreadsheet-detail__sheet-list">
        <div
          v-for="sheet in spreadsheet.sheets"
          :key="sheet.id"
          class="spreadsheet-detail__sheet"
          :class="{ 'spreadsheet-detail__sheet--active': sheet.id === selectedSheetId }"
          @click="selectSheet(sheet.id)"
        >
          <div>{{ sheet.name }}</div>
          <small>{{ sheet.id }}</small>
        </div>
      </div>
    </section>

    <section class="spreadsheet-detail__card">
      <h3>Update Cell</h3>
      <div class="spreadsheet-detail__form">
        <label class="spreadsheet-detail__field">
          <span>Row</span>
          <input v-model.number="cellRow" type="number" min="0" />
        </label>
        <label class="spreadsheet-detail__field">
          <span>Column</span>
          <input v-model.number="cellCol" type="number" min="0" />
        </label>
        <label class="spreadsheet-detail__field">
          <span>Value</span>
          <input v-model="cellValue" type="text" placeholder="42" />
        </label>
        <label class="spreadsheet-detail__field">
          <span>Formula</span>
          <input v-model="cellFormula" type="text" placeholder="=A1+B1" />
        </label>
        <label class="spreadsheet-detail__field">
          <span>Data Type</span>
          <select v-model="cellType">
            <option value="">auto</option>
            <option value="text">text</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
            <option value="date">date</option>
          </select>
        </label>
        <button class="spreadsheet-detail__btn spreadsheet-detail__btn--primary" :disabled="updating" @click="updateCell">
          {{ updating ? 'Updating...' : 'Update' }}
        </button>
      </div>
      <p v-if="statusMessage" class="spreadsheet-detail__status" :class="{ 'spreadsheet-detail__status--error': statusKind === 'error' }">
        {{ statusMessage }}
      </p>
    </section>

    <section class="spreadsheet-detail__card">
      <h3>Latest Cells Response</h3>
      <pre class="spreadsheet-detail__code">{{ lastResponse || 'No updates yet.' }}</pre>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiFetch } from '../utils/api'

interface SheetItem {
  id: string
  name: string
}

interface SpreadsheetDetail {
  id: string
  name: string
  sheets: SheetItem[]
}

const route = useRoute()
const router = useRouter()

const spreadsheet = ref<SpreadsheetDetail | null>(null)
const loading = ref(false)
const updating = ref(false)
const selectedSheetId = ref<string>('')
const cellRow = ref<number>(0)
const cellCol = ref<number>(0)
const cellValue = ref<string>('')
const cellFormula = ref<string>('')
const cellType = ref<string>('')
const statusMessage = ref('')
const statusKind = ref<'success' | 'error'>('success')
const lastResponse = ref('')

const spreadsheetId = computed(() => route.params.id as string)

function selectSheet(id: string) {
  selectedSheetId.value = id
}

function goBack() {
  router.push('/spreadsheets')
}

async function fetchSpreadsheet() {
  if (!spreadsheetId.value) return
  loading.value = true
  try {
    const response = await apiFetch(`/api/spreadsheets/${spreadsheetId.value}`)
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || 'Failed to load spreadsheet')
    }
    spreadsheet.value = payload.data
    if (!selectedSheetId.value && spreadsheet.value?.sheets?.length) {
      selectedSheetId.value = spreadsheet.value.sheets[0].id
    }
  } catch (error) {
    statusKind.value = 'error'
    statusMessage.value = error instanceof Error ? error.message : 'Failed to load spreadsheet'
  } finally {
    loading.value = false
  }
}

async function updateCell() {
  if (!selectedSheetId.value) {
    statusKind.value = 'error'
    statusMessage.value = 'Select a sheet first.'
    return
  }
  updating.value = true
  statusMessage.value = ''
  try {
    const response = await apiFetch(`/api/spreadsheets/${spreadsheetId.value}/sheets/${selectedSheetId.value}/cells`, {
      method: 'PUT',
      body: JSON.stringify({
        cells: [{
          row: cellRow.value,
          col: cellCol.value,
          value: cellValue.value || null,
          formula: cellFormula.value || undefined,
          dataType: cellType.value || undefined
        }]
      })
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.error?.message || 'Failed to update cell')
    }
    statusKind.value = 'success'
    statusMessage.value = 'Cell updated.'
    lastResponse.value = JSON.stringify(payload.data, null, 2)
  } catch (error) {
    statusKind.value = 'error'
    statusMessage.value = error instanceof Error ? error.message : 'Failed to update cell'
  } finally {
    updating.value = false
  }
}

onMounted(fetchSpreadsheet)
</script>

<style scoped>
.spreadsheet-detail {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.spreadsheet-detail__header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}

.spreadsheet-detail__title {
  font-size: 24px;
  font-weight: 600;
}

.spreadsheet-detail__subtitle {
  color: #666;
  font-size: 13px;
}

.spreadsheet-detail__actions {
  display: flex;
  gap: 10px;
}

.spreadsheet-detail__card {
  background: #fff;
  border-radius: 10px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.spreadsheet-detail__sheet-list {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.spreadsheet-detail__sheet {
  border: 1px solid #e0e0e0;
  border-radius: 8px;
  padding: 10px 12px;
  cursor: pointer;
}

.spreadsheet-detail__sheet--active {
  border-color: #1976d2;
  background: #e3f2fd;
}

.spreadsheet-detail__form {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: flex-end;
  margin-top: 12px;
}

.spreadsheet-detail__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 160px;
}

.spreadsheet-detail__field input,
.spreadsheet-detail__field select {
  padding: 8px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
}

.spreadsheet-detail__btn {
  padding: 8px 14px;
  border: 1px solid #d0d0d0;
  background: #fff;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.spreadsheet-detail__btn:hover {
  background: #f0f0f0;
}

.spreadsheet-detail__btn--primary {
  background: #1976d2;
  color: #fff;
  border-color: #1976d2;
}

.spreadsheet-detail__btn--primary:hover {
  background: #1565c0;
}

.spreadsheet-detail__status {
  margin-top: 10px;
  font-size: 13px;
  color: #2e7d32;
}

.spreadsheet-detail__status--error {
  color: #c62828;
}

.spreadsheet-detail__empty {
  color: #777;
  margin-top: 12px;
}

.spreadsheet-detail__code {
  background: #f7f7f7;
  padding: 12px;
  border-radius: 8px;
  font-size: 12px;
  max-height: 240px;
  overflow: auto;
}

@media (max-width: 768px) {
  .spreadsheet-detail__header {
    flex-direction: column;
    align-items: flex-start;
  }

  .spreadsheet-detail__form {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
