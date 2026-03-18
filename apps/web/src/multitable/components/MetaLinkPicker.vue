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
        <button class="meta-link-picker__confirm" @click="onConfirm">Confirm</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, reactive } from 'vue'
import type { MetaField, LinkedRecordSummary } from '../types'
import { multitableClient } from '../api/client'

const props = defineProps<{
  visible: boolean
  field?: MetaField | null
  currentValue?: unknown
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', recordIds: string[]): void
}>()

const search = ref('')
const records = ref<LinkedRecordSummary[]>([])
const loading = ref(false)
const selected = reactive(new Set<string>())

watch(() => props.visible, async (v) => {
  if (!v || !props.field) return
  // Init selected from current value
  selected.clear()
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
  } catch {
    records.value = []
  } finally {
    loading.value = false
  }
}

function onSearch() { loadRecords() }

function toggleSelect(id: string) {
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
}

function onConfirm() { emit('confirm', Array.from(selected)) }
</script>

<style scoped>
.meta-link-picker__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 100; display: flex; align-items: center; justify-content: center; }
.meta-link-picker { width: 480px; max-height: 70vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); display: flex; flex-direction: column; }
.meta-link-picker__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-link-picker__title { font-size: 14px; font-weight: 600; margin: 0; }
.meta-link-picker__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-link-picker__search { padding: 8px 16px; }
.meta-link-picker__input { width: 100%; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-link-picker__body { flex: 1; overflow-y: auto; padding: 0 16px; max-height: 300px; }
.meta-link-picker__item { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; cursor: pointer; }
.meta-link-picker__loading, .meta-link-picker__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-link-picker__footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid #eee; }
.meta-link-picker__count { font-size: 12px; color: #666; }
.meta-link-picker__confirm { padding: 6px 18px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
.meta-link-picker__confirm:hover { background: #66b1ff; }
</style>
