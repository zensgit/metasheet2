<template>
  <div class="meta-gallery">
    <div v-if="fields.length" class="meta-gallery__toolbar">
      <label class="meta-gallery__toolbar-field">
        <span>Title</span>
        <select class="meta-gallery__toolbar-select" :value="galleryDraft.titleFieldId ?? ''" @change="onTitleFieldChange">
          <option value="">Auto</option>
          <option v-for="field in titleFieldCandidates" :key="field.id" :value="field.id">{{ field.name }}</option>
        </select>
      </label>
      <label class="meta-gallery__toolbar-field">
        <span>Cover</span>
        <select class="meta-gallery__toolbar-select" :value="galleryDraft.coverFieldId ?? ''" @change="onCoverFieldChange">
          <option value="">None</option>
          <option v-for="field in attachmentFields" :key="field.id" :value="field.id">{{ field.name }}</option>
        </select>
      </label>
      <label class="meta-gallery__toolbar-field">
        <span>Columns</span>
        <select class="meta-gallery__toolbar-select" :value="galleryDraft.columns" @change="onColumnsChange">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
          <option :value="4">4</option>
        </select>
      </label>
      <label class="meta-gallery__toolbar-field">
        <span>Card size</span>
        <select class="meta-gallery__toolbar-select" :value="galleryDraft.cardSize" @change="onCardSizeChange">
          <option value="small">Small</option>
          <option value="medium">Medium</option>
          <option value="large">Large</option>
        </select>
      </label>
      <details class="meta-gallery__field-picker">
        <summary>Card fields ({{ displayFields.length }})</summary>
        <div class="meta-gallery__field-picker-list">
          <label v-for="field in configurableFields" :key="field.id" class="meta-gallery__field-picker-item">
            <input
              type="checkbox"
              :checked="galleryDraft.fieldIds.includes(field.id)"
              @change="toggleFieldSelection(field.id)"
            />
            <span>{{ field.name }}</span>
          </label>
        </div>
      </details>
      <button v-if="canCreate" class="meta-gallery__create-btn" @click="emit('create-record', {})">+ Add record</button>
    </div>
    <div class="meta-gallery__grid" :style="gridStyle">
      <div
        v-for="(row, idx) in rows"
        :key="row.id"
        class="meta-gallery__card"
        :class="`meta-gallery__card--${galleryDraft.cardSize}`"
        role="article"
        tabindex="0"
        :aria-label="cardTitle(row)"
        @click="emit('select-record', row.id)"
        @keydown="onCardKeydown($event, idx)"
        >
        <div v-if="coverAttachment(row)" class="meta-gallery__cover">
          <img
            v-if="coverAttachment(row)?.thumbnailUrl || coverAttachment(row)?.url"
            class="meta-gallery__cover-image"
            :src="coverAttachment(row)?.thumbnailUrl || coverAttachment(row)?.url"
            :alt="cardTitle(row)"
          />
          <div v-else class="meta-gallery__cover-fallback">{{ coverAttachment(row)?.filename }}</div>
        </div>
        <div class="meta-gallery__card-header">
          <div class="meta-gallery__card-title">{{ cardTitle(row) }}</div>
          <button
            v-if="canComment"
            class="meta-gallery__comment-btn"
            :class="rowCommentButtonClass(row.id)"
            type="button"
            :aria-label="`Open comments for ${cardTitle(row)}`"
            @click.stop="emit('open-comments', row.id)"
            @keydown="onRowCommentKeydown($event, row.id)"
          >
            <MetaCommentActionChip label="Comments" :state="rowCommentAffordance(row.id)" />
          </button>
        </div>
        <div class="meta-gallery__card-body">
          <div v-for="field in displayFields" :key="field.id" class="meta-gallery__field">
            <div class="meta-gallery__field-copy">
              <span class="meta-gallery__field-label">{{ field.name }}</span>
              <div v-if="field.type === 'attachment'" class="meta-gallery__field-value meta-gallery__field-value--attachment">
                <MetaAttachmentList
                  :attachments="attachmentItems(row, field)"
                  variant="compact"
                  empty-label="No attachments"
                />
              </div>
              <span v-else class="meta-gallery__field-value">{{ formatValue(row, field) }}</span>
            </div>
            <button
              v-if="canComment"
              type="button"
              class="meta-gallery__field-comment-btn"
              :class="fieldCommentButtonClass(row.id, field.id)"
              :aria-label="`Open comments for ${field.name} on ${cardTitle(row)}`"
              @click.stop="emit('open-field-comments', { recordId: row.id, fieldId: field.id })"
              @keydown="onFieldCommentKeydown($event, row.id, field.id)"
            >
              <MetaCommentAffordance :state="fieldCommentAffordance(row.id, field.id)" />
            </button>
          </div>
        </div>
      </div>
      <div v-if="!rows.length && !loading" class="meta-gallery__empty">
        <div class="meta-gallery__empty-icon">&#x1F5BC;</div>
        <div class="meta-gallery__empty-title">No records to display</div>
        <div class="meta-gallery__empty-hint">Add records to see them as cards here</div>
        <button v-if="canCreate" class="meta-gallery__empty-action" @click="emit('create-record', {})">Create first record</button>
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
import { computed, reactive, ref, watch } from 'vue'
import type { LinkedRecordSummary, MetaAttachment, MetaField, MetaGalleryViewConfig, MetaRecord, MultitableCommentPresenceSummary } from '../types'
import { resolveGalleryViewConfig } from '../utils/view-config'
import { formatFieldDisplay } from '../utils/field-display'
import MetaAttachmentList from './MetaAttachmentList.vue'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import {
  handleCommentAffordanceKeydown,
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'

const props = defineProps<{
  rows: MetaRecord[]
  fields: MetaField[]
  loading: boolean
  canCreate?: boolean
  canComment?: boolean
  currentPage: number
  totalPages: number
  viewConfig?: Record<string, unknown> | null
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  commentPresence?: Record<string, MultitableCommentPresenceSummary | undefined>
}>()

const emit = defineEmits<{
  (e: 'select-record', recordId: string): void
  (e: 'open-comments', recordId: string): void
  (e: 'open-field-comments', payload: { recordId: string; fieldId: string }): void
  (e: 'go-to-page', page: number): void
  (e: 'create-record', data: Record<string, unknown>): void
  (e: 'update-view-config', input: { config: Record<string, unknown> }): void
}>()

const galleryConfig = computed<Required<MetaGalleryViewConfig>>(() =>
  resolveGalleryViewConfig(props.fields, props.viewConfig),
)
const pendingConfigKey = ref<string | null>(null)

const galleryDraft = reactive<Required<MetaGalleryViewConfig>>({
  titleFieldId: null,
  coverFieldId: null,
  fieldIds: [],
  columns: 3,
  cardSize: 'medium',
})

function normalizeGalleryConfig(config?: Partial<Required<MetaGalleryViewConfig>>) {
  return {
    titleFieldId: config?.titleFieldId ?? null,
    coverFieldId: config?.coverFieldId ?? null,
    fieldIds: [...(config?.fieldIds ?? [])],
    columns: config?.columns ?? 3,
    cardSize: (config?.cardSize ?? 'medium') as 'small' | 'medium' | 'large',
  }
}

watch(
  galleryConfig,
  (config) => {
    const normalized = normalizeGalleryConfig(config)
    const configKey = JSON.stringify(normalized)
    if (pendingConfigKey.value && pendingConfigKey.value !== configKey) return
    galleryDraft.titleFieldId = normalized.titleFieldId
    galleryDraft.coverFieldId = normalized.coverFieldId
    galleryDraft.fieldIds = normalized.fieldIds
    galleryDraft.columns = normalized.columns
    galleryDraft.cardSize = normalized.cardSize
    if (pendingConfigKey.value === configKey) pendingConfigKey.value = null
  },
  { immediate: true },
)

const titleFieldCandidates = computed(() =>
  props.fields.filter((field) => ['string', 'formula', 'lookup'].includes(field.type)),
)

const attachmentFields = computed(() =>
  props.fields.filter((field) => field.type === 'attachment'),
)

const titleField = computed(() => {
  const configuredId = galleryDraft.titleFieldId
  return props.fields.find((field) => field.id === configuredId) ?? props.fields.find((f) => f.type === 'string') ?? props.fields[0] ?? null
})

const displayFields = computed(() => {
  const configured = galleryDraft.fieldIds
    .map((fieldId) => props.fields.find((field) => field.id === fieldId) ?? null)
    .filter((field): field is MetaField => !!field)
    .filter((field) => field.id !== titleField.value?.id && field.id !== coverField.value?.id)
  if (configured.length > 0) return configured
  return props.fields.filter((f) => f.id !== titleField.value?.id && f.id !== coverField.value?.id).slice(0, 4)
})

const configurableFields = computed(() =>
  props.fields.filter((field) => field.id !== titleField.value?.id && field.id !== coverField.value?.id),
)

const coverField = computed(() => {
  const configuredId = galleryDraft.coverFieldId
  return configuredId ? props.fields.find((field) => field.id === configuredId) ?? null : null
})

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${galleryDraft.columns}, minmax(0, 1fr))`,
}))

function cardTitle(row: MetaRecord): string {
  if (!titleField.value) return row.id
  const display = formatValue(row, titleField.value)
  return display === '—' ? row.id : display
}

function coverAttachment(row: MetaRecord): MetaAttachment | null {
  if (!coverField.value) return null
  return props.attachmentSummaries?.[row.id]?.[coverField.value.id]?.[0] ?? null
}

function formatValue(row: MetaRecord, field: MetaField): string {
  return formatFieldDisplay({
    field,
    value: row.data[field.id],
    linkSummaries: props.linkSummaries?.[row.id]?.[field.id],
    attachmentSummaries: props.attachmentSummaries?.[row.id]?.[field.id],
  })
}

function attachmentIds(row: MetaRecord, field: MetaField): string[] {
  const rawValue = row.data[field.id]
  if (Array.isArray(rawValue)) return rawValue.map(String)
  if (rawValue) return [String(rawValue)]
  return []
}

function attachmentItems(row: MetaRecord, field: MetaField): MetaAttachment[] {
  const summaryById = new Map((props.attachmentSummaries?.[row.id]?.[field.id] ?? []).map((attachment) => [attachment.id, attachment]))
  return attachmentIds(row, field).map((id) => summaryById.get(id) ?? ({
    id,
    filename: id,
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: '',
  }))
}

function rowCommentAffordance(recordId: string) {
  return resolveRecordCommentAffordance(props.commentPresence?.[recordId])
}

function fieldCommentAffordance(recordId: string, fieldId: string) {
  return resolveFieldCommentAffordance(props.commentPresence?.[recordId], fieldId)
}

function rowCommentButtonClass(recordId: string): string {
  return resolveCommentAffordanceStateClass('meta-gallery__comment-btn', rowCommentAffordance(recordId))
}

function fieldCommentButtonClass(recordId: string, fieldId: string): string {
  return resolveCommentAffordanceStateClass('meta-gallery__field-comment-btn', fieldCommentAffordance(recordId, fieldId))
}

function onRowCommentKeydown(event: KeyboardEvent, recordId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-comments', recordId))
}

function onFieldCommentKeydown(event: KeyboardEvent, recordId: string, fieldId: string) {
  handleCommentAffordanceKeydown(event, () => emit('open-field-comments', { recordId, fieldId }))
}

function emitConfigUpdate(next: Partial<Required<MetaGalleryViewConfig>>) {
  const normalized = normalizeGalleryConfig({
    titleFieldId: galleryDraft.titleFieldId,
    coverFieldId: galleryDraft.coverFieldId,
    fieldIds: galleryDraft.fieldIds,
    columns: galleryDraft.columns,
    cardSize: galleryDraft.cardSize,
    ...next,
  })
  galleryDraft.titleFieldId = normalized.titleFieldId
  galleryDraft.coverFieldId = normalized.coverFieldId
  galleryDraft.fieldIds = normalized.fieldIds
  galleryDraft.columns = normalized.columns
  galleryDraft.cardSize = normalized.cardSize
  pendingConfigKey.value = JSON.stringify(normalized)
  emit('update-view-config', {
    config: normalized,
  })
}

function onTitleFieldChange(event: Event) {
  const nextTitleFieldId = ((event.target as HTMLSelectElement).value || null)
  emitConfigUpdate({ titleFieldId: nextTitleFieldId })
}

function onCoverFieldChange(event: Event) {
  const nextCoverFieldId = ((event.target as HTMLSelectElement).value || null)
  emitConfigUpdate({ coverFieldId: nextCoverFieldId })
}

function onColumnsChange(event: Event) {
  emitConfigUpdate({ columns: Number((event.target as HTMLSelectElement).value) || galleryDraft.columns })
}

function onCardSizeChange(event: Event) {
  const nextCardSize = (event.target as HTMLSelectElement).value as Required<MetaGalleryViewConfig>['cardSize']
  emitConfigUpdate({ cardSize: nextCardSize })
}

function toggleFieldSelection(fieldId: string) {
  const nextFieldIds = galleryDraft.fieldIds.includes(fieldId)
    ? galleryDraft.fieldIds.filter((id) => id !== fieldId)
    : [...galleryDraft.fieldIds, fieldId]
  emitConfigUpdate({ fieldIds: nextFieldIds })
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
.meta-gallery__toolbar { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 16px; border-bottom: 1px solid #eef2f7; background: #fbfdff; }
.meta-gallery__toolbar-field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: #64748b; }
.meta-gallery__toolbar-select { min-width: 104px; padding: 5px 8px; border: 1px solid #d8e1ee; border-radius: 6px; background: #fff; font-size: 12px; color: #334155; }
.meta-gallery__field-picker { margin-left: auto; align-self: end; }
.meta-gallery__create-btn { align-self: end; padding: 6px 12px; border: 1px solid #c7ddff; border-radius: 6px; background: #ecf5ff; color: #2563eb; font-size: 12px; cursor: pointer; }
.meta-gallery__create-btn:hover { background: #dbeafe; }
.meta-gallery__field-picker summary { list-style: none; cursor: pointer; font-size: 12px; color: #409eff; user-select: none; }
.meta-gallery__field-picker summary::-webkit-details-marker { display: none; }
.meta-gallery__field-picker-list { display: flex; flex-wrap: wrap; gap: 8px 12px; margin-top: 8px; padding: 10px 12px; border: 1px solid #d8e1ee; border-radius: 8px; background: #fff; box-shadow: 0 8px 20px rgba(15,23,42,.08); max-width: 360px; }
.meta-gallery__field-picker-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #475569; }
.meta-gallery__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; padding: 16px; overflow-y: auto; flex: 1; }
.meta-gallery__card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; cursor: pointer; transition: box-shadow 0.15s, border-color 0.15s; }
.meta-gallery__card--small { padding: 12px 14px; }
.meta-gallery__card--large { padding: 18px 20px; }
.meta-gallery__card:hover { border-color: #409eff; box-shadow: 0 2px 8px rgba(64,158,255,.15); }
.meta-gallery__card:focus-visible { outline: 2px solid #409eff; outline-offset: 1px; }
.meta-gallery__cover { margin: -14px -16px 12px; border-bottom: 1px solid #eef2f7; background: #f8fafc; min-height: 132px; display: flex; align-items: center; justify-content: center; overflow: hidden; border-radius: 8px 8px 0 0; }
.meta-gallery__card--small .meta-gallery__cover { min-height: 108px; margin: -12px -14px 10px; }
.meta-gallery__card--large .meta-gallery__cover { min-height: 176px; margin: -18px -20px 14px; }
.meta-gallery__cover-image { width: 100%; height: 100%; object-fit: cover; display: block; }
.meta-gallery__cover-fallback { padding: 24px; font-size: 12px; color: #64748b; text-align: center; }
.meta-gallery__card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.meta-gallery__card-title { font-size: 14px; font-weight: 600; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-gallery__comment-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 2px 8px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; flex-shrink: 0; }
.meta-gallery__comment-btn:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-gallery__comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-gallery__comment-btn--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-gallery__card-body { display: flex; flex-direction: column; gap: 4px; }
.meta-gallery__field { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; font-size: 12px; }
.meta-gallery__field-copy { flex: 1; min-width: 0; display: flex; gap: 8px; }
.meta-gallery__field-label { color: #999; min-width: 60px; flex-shrink: 0; }
.meta-gallery__field-value { color: #555; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-gallery__field-value--attachment { flex: 1; min-width: 0; white-space: normal; }
.meta-gallery__field-comment-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 24px; padding: 0 6px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; flex-shrink: 0; }
.meta-gallery__field-comment-btn:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-gallery__field-comment-btn--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-gallery__field-comment-btn--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-gallery__empty { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px; color: #999; }
.meta-gallery__empty-icon { font-size: 36px; opacity: 0.5; margin-bottom: 8px; }
.meta-gallery__empty-title { font-size: 15px; font-weight: 600; color: #666; margin-bottom: 4px; }
.meta-gallery__empty-hint { font-size: 13px; color: #aaa; }
.meta-gallery__empty-action { margin-top: 12px; padding: 8px 14px; border: 1px solid #c7ddff; border-radius: 6px; background: #ecf5ff; color: #2563eb; font-size: 12px; cursor: pointer; }
.meta-gallery__empty-action:hover { background: #dbeafe; }
.meta-gallery__pagination { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 8px; border-top: 1px solid #e5e7eb; }
.meta-gallery__page-btn { padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-gallery__page-btn:hover:not(:disabled) { background: #f5f5f5; }
.meta-gallery__page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.meta-gallery__page-info { font-size: 12px; color: #666; }
.meta-gallery__loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.7); font-size: 14px; color: #666; z-index: 10; }
</style>
