<template>
  <div v-if="visible" class="meta-link-picker__overlay" @click.self="emit('close')">
    <div class="meta-link-picker">
      <div class="meta-link-picker__header">
        <h4 class="meta-link-picker__title">Link Records — {{ field?.name ?? '' }}</h4>
        <button class="meta-link-picker__close" @click="emit('close')">&times;</button>
      </div>
      <div class="meta-link-picker__search">
        <input v-model="search" class="meta-link-picker__input" placeholder="Search records..." @input="onSearch" />
      </div>
      <div v-if="selectedSummaries.length" class="meta-link-picker__selected">
        <div class="meta-link-picker__selected-header">
          <span class="meta-link-picker__selected-label">Selected</span>
          <button class="meta-link-picker__clear" @click="clearSelection">Clear</button>
        </div>
        <div class="meta-link-picker__chips">
          <span v-for="item in selectedSummaries" :key="item.id" class="meta-link-picker__chip">{{ item.display || item.id }}</span>
        </div>
      </div>
      <div class="meta-link-picker__body">
        <div v-if="loading" class="meta-link-picker__loading">Loading...</div>
        <label
          v-for="rec in records"
          :key="rec.id"
          class="meta-link-picker__item"
        >
          <input type="checkbox" :checked="selected.has(rec.id)" @change="toggleSelect(rec.id)" />
          <span>{{ rec.display || rec.id }}</span>
        </label>
        <div v-if="!loading && !records.length" class="meta-link-picker__empty">No records found</div>
      </div>
      <div class="meta-link-picker__footer">
        <span class="meta-link-picker__count">{{ selected.size }} selected</span>
        <div class="meta-link-picker__actions">
          <button class="meta-link-picker__cancel" @click="emit('close')">Cancel</button>
        <button class="meta-link-picker__confirm" @click="onConfirm">Confirm</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, reactive, computed } from 'vue'
import type { MetaField, LinkedRecordSummary } from '../types'
import { multitableClient } from '../api/client'

const props = defineProps<{
  visible: boolean
  field?: MetaField | null
  currentValue?: unknown
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', payload: { recordIds: string[]; summaries: LinkedRecordSummary[] }): void
}>()

const search = ref('')
const records = ref<LinkedRecordSummary[]>([])
const loading = ref(false)
const selected = reactive(new Set<string>())
const summaryById = reactive<Record<string, LinkedRecordSummary>>({})

watch(() => props.visible, async (v) => {
  if (!v) {
    if (debounceTimer) clearTimeout(debounceTimer)
    return
  }
  if (!props.field) return
  // Init selected from current value
  selected.clear()
  Object.keys(summaryById).forEach((id) => delete summaryById[id])
  const cv = props.currentValue
  const ids = Array.isArray(cv) ? cv.map(String) : cv ? [String(cv)] : []
  ids.forEach((id) => selected.add(id))
  search.value = ''
  await loadRecords()
})

async function loadRecords() {
  if (!props.field) return
  loading.value = true
  try {
    const data = await multitableClient.listLinkOptions(props.field.id, { search: search.value || undefined, limit: 50 })
    records.value = data.records ?? []
    for (const record of data.selected ?? []) summaryById[record.id] = record
    for (const record of data.records ?? []) summaryById[record.id] = record
  } catch {
    records.value = []
  } finally {
    loading.value = false
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
function onSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => loadRecords(), 300)
}

function toggleSelect(id: string) {
  if (selected.has(id)) selected.delete(id)
  else {
    selected.add(id)
    const record = records.value.find((item) => item.id === id)
    if (record) summaryById[id] = record
  }
}

const selectedSummaries = computed(() =>
  Array.from(selected).map((id) => summaryById[id] ?? { id, display: id }),
)

function clearSelection() {
  selected.clear()
}

function onConfirm() {
  const recordIds = Array.from(selected)
  emit('confirm', {
    recordIds,
    summaries: recordIds.map((id) => summaryById[id]).filter((item): item is LinkedRecordSummary => !!item),
  })
}
</script>

<style scoped>
.meta-link-picker__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 100; display: flex; align-items: center; justify-content: center; }
.meta-link-picker { width: 480px; max-height: 70vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); display: flex; flex-direction: column; }
.meta-link-picker__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-link-picker__title { font-size: 14px; font-weight: 600; margin: 0; }
.meta-link-picker__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-link-picker__search { padding: 8px 16px; }
.meta-link-picker__input { width: 100%; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-link-picker__selected { padding: 0 16px 8px; border-bottom: 1px solid #f0f0f0; }
.meta-link-picker__selected-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.meta-link-picker__selected-label { font-size: 12px; font-weight: 600; color: #606266; }
.meta-link-picker__clear { border: none; background: none; color: #909399; font-size: 12px; cursor: pointer; }
.meta-link-picker__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-link-picker__chip { padding: 2px 8px; border-radius: 999px; background: #ecf5ff; color: #409eff; font-size: 12px; }
.meta-link-picker__body { flex: 1; overflow-y: auto; padding: 0 16px; max-height: 300px; }
.meta-link-picker__item { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; cursor: pointer; }
.meta-link-picker__loading, .meta-link-picker__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-link-picker__footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid #eee; }
.meta-link-picker__count { font-size: 12px; color: #666; }
.meta-link-picker__actions { display: flex; gap: 8px; }
.meta-link-picker__cancel { padding: 6px 12px; background: #fff; color: #606266; border: 1px solid #dcdfe6; border-radius: 4px; cursor: pointer; font-size: 13px; }
.meta-link-picker__confirm { padding: 6px 18px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
.meta-link-picker__confirm:hover { background: #66b1ff; }
</style>
