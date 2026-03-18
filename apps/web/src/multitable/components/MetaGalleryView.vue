<template>
  <div class="meta-gallery">
    <div class="meta-gallery__grid">
      <div
        v-for="(row, idx) in rows"
        :key="row.id"
        class="meta-gallery__card"
        role="article"
        tabindex="0"
        :aria-label="cardTitle(row)"
        @click="emit('select-record', row.id)"
        @keydown="onCardKeydown($event, idx)"
      >
        <div class="meta-gallery__card-title">{{ cardTitle(row) }}</div>
        <div class="meta-gallery__card-body">
          <div v-for="field in displayFields" :key="field.id" class="meta-gallery__field">
            <span class="meta-gallery__field-label">{{ field.name }}</span>
            <span class="meta-gallery__field-value">{{ formatValue(row.data[field.id], field) }}</span>
          </div>
        </div>
      </div>
      <div v-if="!rows.length && !loading" class="meta-gallery__empty">
        <div class="meta-gallery__empty-icon">&#x1F5BC;</div>
        <div class="meta-gallery__empty-title">No records to display</div>
        <div class="meta-gallery__empty-hint">Add records to see them as cards here</div>
      </div>
    </div>
    <div v-if="totalPages > 1" class="meta-gallery__pagination">
      <button class="meta-gallery__page-btn" :disabled="currentPage <= 1" @click="emit('go-to-page', currentPage - 1)">&lsaquo; Prev</button>
      <span class="meta-gallery__page-info">{{ currentPage }} / {{ totalPages }}</span>
      <button class="meta-gallery__page-btn" :disabled="currentPage >= totalPages" @click="emit('go-to-page', currentPage + 1)">Next &rsaquo;</button>
    </div>
    <div v-if="loading" class="meta-gallery__loading">Loading...</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MetaField, MetaRecord } from '../types'

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  currentPage: number
  totalPages: number
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'go-to-page', page: number): void
}>()

const titleField = computed(() =>
  props.fields.find((f) => f.type === 'string') ?? props.fields[0] ?? null,
)

const displayFields = computed(() =>
  props.fields.filter((f) => f.id !== titleField.value?.id).slice(0, 4),
)

function cardTitle(row: MetaRecord): string {
  if (!titleField.value) return row.id
  return String(row.data[titleField.value.id] ?? '') || row.id
}

function formatValue(val: unknown, field: MetaField): string {
  if (val === null || val === undefined) return '—'
  if (field.type === 'boolean') return val ? '✓' : '✗'
  if (Array.isArray(val)) return val.length ? `${val.length} linked` : '—'
  return String(val)
}

const focusedCardIndex = ref(-1)

function onCardKeydown(e: KeyboardEvent, idx: number) {
  if (e.key === 'Enter') {
    e.preventDefault()
    emit('select-record', props.rows[idx].id)
    return
  }
  const cols = getColumnsCount()
  let next = idx
  if (e.key === 'ArrowRight') next = idx + 1
  else if (e.key === 'ArrowLeft') next = idx - 1
  else if (e.key === 'ArrowDown') next = idx + cols
  else if (e.key === 'ArrowUp') next = idx - cols
  else return

  e.preventDefault()
  if (next >= 0 && next < props.rows.length) {
    focusedCardIndex.value = next
    const cards = document.querySelectorAll('.meta-gallery__card[tabindex="0"]')
    ;(cards[next] as HTMLElement)?.focus()
  }
}

function getColumnsCount(): number {
  const grid = document.querySelector('.meta-gallery__grid')
  if (!grid) return 1
  const style = getComputedStyle(grid)
  const cols = style.gridTemplateColumns.split(' ').length
  return cols || 1
}
</script>

<style scoped>
.meta-gallery { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.meta-gallery__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; padding: 16px; overflow-y: auto; flex: 1; }
.meta-gallery__card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; cursor: pointer; transition: box-shadow 0.15s, border-color 0.15s; }
.meta-gallery__card:hover { border-color: #409eff; box-shadow: 0 2px 8px rgba(64,158,255,.15); }
.meta-gallery__card:focus-visible { outline: 2px solid #409eff; outline-offset: 1px; }
.meta-gallery__card-title { font-size: 14px; font-weight: 600; color: #333; margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-gallery__card-body { display: flex; flex-direction: column; gap: 4px; }
.meta-gallery__field { display: flex; gap: 8px; font-size: 12px; }
.meta-gallery__field-label { color: #999; min-width: 60px; flex-shrink: 0; }
.meta-gallery__field-value { color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-gallery__empty { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px; color: #999; }
.meta-gallery__empty-icon { font-size: 36px; opacity: 0.5; margin-bottom: 8px; }
.meta-gallery__empty-title { font-size: 15px; font-weight: 600; color: #666; margin-bottom: 4px; }
.meta-gallery__empty-hint { font-size: 13px; color: #aaa; }
.meta-gallery__pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 8px; border-top: 1px solid #e5e7eb; }
.meta-gallery__page-btn { padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-gallery__page-btn:hover:not(:disabled) { background: #f5f5f5; }
.meta-gallery__page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.meta-gallery__page-info { font-size: 12px; color: #666; }
.meta-gallery__loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.7); font-size: 14px; color: #666; z-index: 10; }
</style>
