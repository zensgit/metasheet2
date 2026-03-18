<template>
  <div v-if="visible" class="meta-record-drawer">
    <div class="meta-record-drawer__header">
      <h3 class="meta-record-drawer__title">Record Detail</h3>
      <div class="meta-record-drawer__actions">
        <button v-if="canComment" class="meta-record-drawer__btn" title="Comments" @click="emit('toggle-comments')">&#x1F4AC;</button>
        <button v-if="canDelete" class="meta-record-drawer__btn meta-record-drawer__btn--danger" @click="emit('delete')">Delete</button>
        <button class="meta-record-drawer__close" @click="emit('close')">&times;</button>
      </div>
    </div>
    <div v-if="record" class="meta-record-drawer__body">
      <div v-for="field in fields" :key="field.id" class="meta-record-drawer__field">
        <label class="meta-record-drawer__label">{{ field.name }}</label>
        <div class="meta-record-drawer__value">
          <input
            v-if="canEdit && field.type === 'string'"
            class="meta-record-drawer__input"
            type="text"
            :value="record.data[field.id] ?? ''"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value)"
          />
          <input
            v-else-if="canEdit && field.type === 'number'"
            class="meta-record-drawer__input"
            type="number"
            :value="record.data[field.id] ?? ''"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value))"
          />
          <label v-else-if="canEdit && field.type === 'boolean'" class="meta-record-drawer__check">
            <input type="checkbox" :checked="!!record.data[field.id]" @change="emit('patch', field.id, ($event.target as HTMLInputElement).checked)" />
          </label>
          <button
            v-else-if="canEdit && field.type === 'link'"
            class="meta-record-drawer__link-btn"
            @click="emit('open-link-picker', field)"
          >Edit links</button>
          <span v-else class="meta-record-drawer__text">{{ formatValue(record.data[field.id]) }}</span>
        </div>
      </div>
    </div>
    <div v-else class="meta-record-drawer__empty">No record selected</div>
  </div>
</template>

<script setup lang="ts">
import type { MetaField, MetaRecord } from '../types'

defineProps<{
  visible: boolean
  record?: MetaRecord | null
  fields: MetaField[]
  canEdit: boolean
  canComment: boolean
  canDelete: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'delete'): void
  (e: 'patch', fieldId: string, value: unknown): void
  (e: 'toggle-comments'): void
  (e: 'open-link-picker', field: MetaField): void
}>()

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}
</script>

<style scoped>
.meta-record-drawer { width: 360px; border-left: 1px solid #e5e7eb; background: #fff; display: flex; flex-direction: column; overflow-y: auto; }
.meta-record-drawer__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-record-drawer__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-record-drawer__actions { display: flex; gap: 8px; align-items: center; }
.meta-record-drawer__btn { padding: 4px 10px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-record-drawer__btn--danger { color: #f56c6c; border-color: #f56c6c; }
.meta-record-drawer__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-record-drawer__body { padding: 12px 16px; flex: 1; }
.meta-record-drawer__field { margin-bottom: 14px; }
.meta-record-drawer__label { display: block; font-size: 12px; color: #999; margin-bottom: 4px; }
.meta-record-drawer__input { width: 100%; padding: 4px 8px; border: 1px solid #ddd; border-radius: 3px; font-size: 13px; }
.meta-record-drawer__check { cursor: pointer; }
.meta-record-drawer__link-btn { padding: 4px 10px; border: 1px solid #409eff; border-radius: 3px; background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 12px; }
.meta-record-drawer__text { font-size: 13px; color: #333; }
.meta-record-drawer__empty { padding: 32px; text-align: center; color: #999; }
</style>
