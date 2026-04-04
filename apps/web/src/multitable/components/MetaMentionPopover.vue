<template>
  <div v-if="visible" class="meta-mention-popover" @click.self="emit('close')">
    <div class="meta-mention-popover__panel" role="dialog" aria-label="Mentions">
      <div class="meta-mention-popover__header">
        <strong>Mentions</strong>
        <button class="meta-mention-popover__close" aria-label="Close mentions" @click="emit('close')">&times;</button>
      </div>
      <div class="meta-mention-popover__list">
        <button
          v-for="item in items"
          :key="item.rowId"
          class="meta-mention-popover__item"
          :class="{ 'meta-mention-popover__item--unread': item.unreadCount > 0 }"
          @click="emit('select-record', { rowId: item.rowId, fieldId: item.mentionedFieldIds[0] ?? null, mentionedFieldIds: item.mentionedFieldIds })"
        >
          <span v-if="item.unreadCount > 0" class="meta-mention-popover__unread-dot" aria-label="Unread"></span>
          <span class="meta-mention-popover__label">{{ resolveLabel(item.rowId) }}</span>
          <span class="meta-mention-popover__count">{{ item.mentionedCount }}</span>
          <span
            v-if="item.mentionedFieldIds.length > 0"
            class="meta-mention-popover__fields"
            :title="item.mentionedFieldIds.map(resolveFieldName).join(', ')"
          >
            {{ fieldScopeLabel(item.mentionedFieldIds) }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { CommentMentionSummaryItem, MetaField, MetaRecord } from '../types'

const props = defineProps<{
  visible: boolean
  items: CommentMentionSummaryItem[]
  rows: MetaRecord[]
  fields: MetaField[]
  displayFieldId: string | null
}>()

export type MentionPopoverSelectPayload = {
  rowId: string
  fieldId: string | null
  mentionedFieldIds: string[]
}

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select-record', payload: MentionPopoverSelectPayload): void
}>()

function resolveLabel(rowId: string): string {
  if (!props.displayFieldId) return rowId
  const row = props.rows.find((record) => record.id === rowId)
  if (!row) return rowId
  const value = row.data[props.displayFieldId]
  if (value === null || value === undefined || value === '') return rowId
  return String(value)
}

function resolveFieldName(fieldId: string): string {
  const field = props.fields.find((candidate) => candidate.id === fieldId)
  return field?.name ?? fieldId
}

function fieldScopeLabel(mentionedFieldIds: string[]): string {
  if (mentionedFieldIds.length === 0) return ''
  const primary = resolveFieldName(mentionedFieldIds[0])
  if (mentionedFieldIds.length === 1) return primary
  return `${primary} +${mentionedFieldIds.length - 1} more`
}
</script>

<style scoped>
.meta-mention-popover { position: fixed; inset: 0; z-index: 1000; }
.meta-mention-popover__panel { position: absolute; top: 48px; left: 120px; width: 320px; max-height: 360px; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); display: flex; flex-direction: column; overflow: hidden; }
.meta-mention-popover__header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #f0f0f0; }
.meta-mention-popover__header strong { font-size: 14px; color: #333; }
.meta-mention-popover__close { border: none; background: none; font-size: 18px; cursor: pointer; color: #999; padding: 0 2px; line-height: 1; }
.meta-mention-popover__close:hover { color: #333; }
.meta-mention-popover__list { overflow-y: auto; flex: 1; }
.meta-mention-popover__item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 14px; border: none; background: none; cursor: pointer; text-align: left; font-size: 13px; color: #333; }
.meta-mention-popover__item:hover { background: #f5f7fa; }
.meta-mention-popover__item--unread { font-weight: 600; background: #fffbe6; }
.meta-mention-popover__item--unread:hover { background: #fff7cc; }
.meta-mention-popover__unread-dot { width: 8px; height: 8px; border-radius: 50%; background: #e6a23c; flex-shrink: 0; }
.meta-mention-popover__label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-mention-popover__count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: #e6a23c; color: #fff; font-size: 11px; font-weight: 600; }
.meta-mention-popover__fields { color: #999; font-size: 11px; white-space: nowrap; }
</style>
