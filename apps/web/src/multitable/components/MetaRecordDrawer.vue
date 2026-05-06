<template>
  <div v-if="visible" class="meta-record-drawer">
    <div class="meta-record-drawer__header">
      <h3 class="meta-record-drawer__title">Record Detail</h3>
      <div class="meta-record-drawer__nav" v-if="recordIds.length > 1">
        <button class="meta-record-drawer__nav-btn" :disabled="currentRecordIndex <= 0" aria-label="Previous record" @click="navigatePrev">&lsaquo;</button>
        <span class="meta-record-drawer__nav-pos">{{ currentRecordIndex + 1 }} / {{ recordIds.length }}</span>
        <button class="meta-record-drawer__nav-btn" :disabled="currentRecordIndex >= recordIds.length - 1" aria-label="Next record" @click="navigateNext">&rsaquo;</button>
      </div>
      <div class="meta-record-drawer__actions">
        <button
          v-if="record && canLoadSubscription"
          class="meta-record-drawer__btn meta-record-drawer__btn--watch"
          :class="{ 'meta-record-drawer__btn--watching': recordSubscribed }"
          type="button"
          :disabled="subscriptionLoading"
          :title="recordSubscribed ? 'Unwatch this record' : 'Watch this record'"
          @click="toggleRecordSubscription"
        >
          {{ recordSubscribed ? 'Watching' : 'Watch' }}
        </button>
        <button
          v-if="resolvedCanComment"
          class="meta-record-drawer__btn meta-record-drawer__btn--comment"
          :class="drawerCommentButtonClass"
          title="Comments"
          type="button"
          @click="emit('toggle-comments')"
        >
          <MetaCommentActionChip label="Comments" :state="drawerCommentAffordance" />
        </button>
        <button v-if="canManageAutomation" class="meta-record-drawer__btn" title="Open workflow designer" @click="emit('open-automation')">&#x2699; Workflow</button>
        <button v-if="canManageRecordPermissions" class="meta-record-drawer__btn" title="Record Permissions" @click="showRecordPermissions = true">&#x1F512; Permissions</button>
        <button v-if="resolvedCanDelete" class="meta-record-drawer__btn meta-record-drawer__btn--danger" @click="emit('delete')">Delete</button>
        <button class="meta-record-drawer__close" aria-label="Close record drawer" @click="emit('close')">&times;</button>
      </div>
    </div>
    <div v-if="record" class="meta-record-drawer__body">
      <div class="meta-record-drawer__tabs" role="tablist" aria-label="Record drawer sections">
        <button
          class="meta-record-drawer__tab"
          :class="{ 'meta-record-drawer__tab--active': activeTab === 'details' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'details'"
          @click="activeTab = 'details'"
        >Details</button>
        <button
          class="meta-record-drawer__tab"
          :class="{ 'meta-record-drawer__tab--active': activeTab === 'history' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'history'"
          @click="activeTab = 'history'"
        >History</button>
      </div>
      <div v-if="subscriptionError" class="meta-record-drawer__watch-error">{{ subscriptionError }}</div>
      <div v-if="activeTab === 'details'" class="meta-record-drawer__fields">
      <div v-for="field in visibleFields" :key="field.id" class="meta-record-drawer__field">
        <div class="meta-record-drawer__field-header">
          <label class="meta-record-drawer__label" :for="`drawer_field_${field.id}`">{{ field.name }}</label>
          <button
            v-if="resolvedCanComment"
            type="button"
            class="meta-record-drawer__comment-anchor"
            :class="recordFieldAnchorClass(field.id)"
            :data-comment-field="field.id"
            :aria-label="`Comment on ${field.name}`"
            :title="`Comment on ${field.name}`"
            @click="emit('comment-field', field)"
          >
            <MetaCommentAffordance :state="recordFieldAffordance(field.id)" />
          </button>
        </div>
        <div class="meta-record-drawer__value">
          <input
            v-if="canEditField(field.id) && field.type === 'string'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="text"
            :value="textControlValue(record.data[field.id])"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value)"
          />
          <textarea
            v-else-if="canEditField(field.id) && field.type === 'longText'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__textarea"
            :value="textControlValue(record.data[field.id])"
            rows="5"
            @change="emit('patch', field.id, ($event.target as HTMLTextAreaElement).value)"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'barcode'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="text"
            inputmode="text"
            placeholder="Scan or enter barcode"
            :value="textControlValue(record.data[field.id])"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value)"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'number'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="number"
            :value="record.data[field.id] ?? ''"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value))"
          />
          <input
            v-else-if="canEditField(field.id) && field.type === 'date'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            type="date"
            :value="record.data[field.id] ?? ''"
            @change="emit('patch', field.id, ($event.target as HTMLInputElement).value)"
          />
          <label v-else-if="canEditField(field.id) && field.type === 'boolean'" class="meta-record-drawer__check">
            <input type="checkbox" :checked="!!record.data[field.id]" @change="emit('patch', field.id, ($event.target as HTMLInputElement).checked)" />
          </label>
          <select
            v-else-if="canEditField(field.id) && field.type === 'select'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input"
            :value="record.data[field.id] ?? ''"
            @change="emit('patch', field.id, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">—</option>
            <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">{{ opt.value }}</option>
          </select>
          <select
            v-else-if="canEditField(field.id) && field.type === 'multiSelect'"
            :id="`drawer_field_${field.id}`"
            class="meta-record-drawer__input meta-record-drawer__input--multi"
            multiple
            :value="multiSelectValue(field.id)"
            @change="emit('patch', field.id, multiSelectEventValue($event))"
          >
            <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">{{ opt.value }}</option>
          </select>
          <button
            v-else-if="canEditField(field.id) && field.type === 'link'"
            class="meta-record-drawer__link-btn"
            @click="emit('open-link-picker', field)"
          >{{ linkButtonLabel(field.id) }}</button>
          <div v-else-if="field.type === 'attachment'" class="meta-record-drawer__attachments">
            <MetaAttachmentList
              :attachments="attachmentItems(field.id)"
              :removable="canEditField(field.id)"
              empty-label="—"
              @remove="onRemoveAttachment(field.id, $event)"
            />
            <div v-if="canEditField(field.id)" class="meta-record-drawer__attachment-add">
              <input
                type="file"
                :multiple="attachmentAllowsMultiple(field)"
                :accept="attachmentAccept(field)"
                class="meta-record-drawer__file-input"
                :disabled="!!attachmentActivity[field.id]"
                @change="onDrawerFileSelect(field.id, $event)"
              />
              <span class="meta-record-drawer__attachment-hint">{{ attachmentActionHint(field.id) }}</span>
              <button
                v-if="attachmentList(field.id).length"
                type="button"
                class="meta-record-drawer__attachment-clear"
                :disabled="!!attachmentActivity[field.id]"
                @click="onClearAttachments(field.id)"
              >Clear all</button>
              <span v-if="attachmentActivity[field.id]" class="meta-record-drawer__uploading">
                {{ attachmentActivity[field.id] === 'removing' ? 'Removing...' : attachmentActivity[field.id] === 'clearing' ? 'Clearing...' : 'Uploading...' }}
              </span>
            </div>
            <div v-if="attachmentErrors[field.id]" class="meta-record-drawer__error">{{ attachmentErrors[field.id] }}</div>
          </div>
          <span v-else class="meta-record-drawer__text">{{ formatValue(field, record.data[field.id]) }}</span>
          <div v-if="field.type === 'link' && linkPreview(field.id)" class="meta-record-drawer__link-summary">{{ linkPreview(field.id) }}</div>
        </div>
      </div>
      </div>
      <div v-else class="meta-record-drawer__history">
        <div v-if="historyLoading" class="meta-record-drawer__history-state">Loading history...</div>
        <div v-else-if="historyError" class="meta-record-drawer__history-state meta-record-drawer__history-state--error">{{ historyError }}</div>
        <div v-else-if="!canLoadHistory" class="meta-record-drawer__history-state">History unavailable for this record.</div>
        <div v-else-if="historyItems.length === 0" class="meta-record-drawer__history-state">No history yet.</div>
        <ol v-else class="meta-record-drawer__history-list">
          <li v-for="item in historyItems" :key="item.id" class="meta-record-drawer__history-item">
            <div class="meta-record-drawer__history-main">
              <span class="meta-record-drawer__history-action">{{ historyActionLabel(item.action) }}</span>
              <span class="meta-record-drawer__history-version">v{{ item.version }}</span>
            </div>
            <div class="meta-record-drawer__history-meta">
              <span>{{ formatHistoryTime(item.createdAt) }}</span>
              <span v-if="item.actorId">by {{ item.actorId }}</span>
              <span>{{ item.source }}</span>
            </div>
            <div v-if="item.changedFieldIds.length" class="meta-record-drawer__history-fields">
              {{ historyFieldLabels(item.changedFieldIds) }}
            </div>
          </li>
        </ol>
      </div>
    </div>
    <div v-else class="meta-record-drawer__empty">No record selected</div>
    <MetaRecordPermissionManager
      v-if="canManageRecordPermissions && record && sheetId && apiClient"
      :visible="showRecordPermissions"
      :sheet-id="sheetId"
      :record-id="record.id"
      :client="apiClient"
      @close="showRecordPermissions = false"
      @updated="emit('navigate', record!.id)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  LinkedRecordSummary,
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadFn,
  MultitableCommentPresenceSummary,
  MetaFieldPermission,
  MetaField,
  MetaRecord,
  MetaRecordRevision,
  MetaRecordSubscriptionStatus,
  MetaRowActions,
} from '../types'
import type { MultitableApiClient } from '../api/client'
import MetaAttachmentList from './MetaAttachmentList.vue'
import MetaCommentActionChip from './MetaCommentActionChip.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import MetaRecordPermissionManager from './MetaRecordPermissionManager.vue'
import {
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
  resolveRecordCommentAffordance,
} from '../utils/comment-affordance'
import { attachmentAcceptAttr, resolveAttachmentFieldProperty, shouldReplaceAttachmentSelection, validateAttachmentSelection } from '../utils/field-config'
import { linkActionLabel } from '../utils/link-fields'
import { formatFieldDisplay } from '../utils/field-display'
import { isSystemField } from '../utils/system-fields'

const props = withDefaults(defineProps<{
  visible: boolean
  record?: MetaRecord | null
  fields: MetaField[]
  canEdit: boolean
  canComment: boolean
  canDelete: boolean
  canManageAutomation?: boolean
  fieldPermissions?: Record<string, MetaFieldPermission> | null
  rowActions?: MetaRowActions | null
  commentPresence?: MultitableCommentPresenceSummary | null
  linkSummariesByField?: Record<string, LinkedRecordSummary[]>
  attachmentSummariesByField?: Record<string, MetaAttachment[]>
  recordIds?: string[]
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  canManageRecordPermissions?: boolean
  sheetId?: string
  apiClient?: MultitableApiClient
}>(), {
  recordIds: () => [],
})

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'delete'): void
  (e: 'patch', fieldId: string, value: unknown): void
  (e: 'toggle-comments'): void
  (e: 'comment-field', field: MetaField): void
  (e: 'open-automation'): void
  (e: 'open-link-picker', field: MetaField): void
  (e: 'navigate', recordId: string): void
}>()

const showRecordPermissions = ref(false)
const activeTab = ref<'details' | 'history'>('details')
const historyItems = ref<MetaRecordRevision[]>([])
const historyLoading = ref(false)
const historyError = ref('')
let historyRequestId = 0
const recordSubscribed = ref(false)
const subscriptionLoading = ref(false)
const subscriptionError = ref('')
let subscriptionRequestId = 0

const attachmentActivity = ref<Record<string, 'uploading' | 'removing' | 'clearing'>>({})
const attachmentErrors = ref<Record<string, string>>({})
const localAttachmentSummaries = ref<Record<string, Record<string, MetaAttachment>>>({})

watch(() => props.record, () => {
  attachmentActivity.value = {}
  attachmentErrors.value = {}
  localAttachmentSummaries.value = {}
  historyItems.value = []
  historyError.value = ''
  recordSubscribed.value = false
  subscriptionError.value = ''
})

watch(
  [() => props.visible, () => props.record?.id, () => props.sheetId, () => props.apiClient],
  () => {
    if (props.visible) void loadRecordSubscription()
  },
  { immediate: true },
)

watch(
  [() => activeTab.value, () => props.visible, () => props.record?.id, () => props.sheetId, () => props.apiClient],
  () => {
    if (activeTab.value === 'history') void loadRecordHistory()
  },
  { immediate: false },
)

const currentRecordIndex = computed(() => {
  if (!props.record || !props.recordIds.length) return -1
  return props.recordIds.indexOf(props.record.id)
})

const visibleFields = computed(() => props.fields.filter((field) => props.fieldPermissions?.[field.id]?.visible !== false))
const fieldLabelById = computed(() => new Map(props.fields.map((field) => [field.id, field.name])))
const canLoadHistory = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)
const canLoadSubscription = computed(() => !!props.apiClient && !!props.sheetId && !!props.record?.id)
const resolvedCanComment = computed(() => props.rowActions?.canComment ?? props.canComment)
const resolvedCanDelete = computed(() => props.rowActions?.canDelete ?? props.canDelete)
const drawerCommentAffordance = computed(() => resolveRecordCommentAffordance(props.commentPresence))
const drawerCommentButtonClass = computed(() =>
  resolveCommentAffordanceStateClass('meta-record-drawer__btn--comment', drawerCommentAffordance.value),
)

function canEditField(fieldId: string): boolean {
  const field = props.fields.find((item) => item.id === fieldId) ?? null
  return props.canEdit
    && props.rowActions?.canEdit !== false
    && props.fieldPermissions?.[fieldId]?.readOnly !== true
    && !isSystemField(field)
}

function recordFieldAffordance(fieldId: string) {
  return resolveFieldCommentAffordance(props.commentPresence, fieldId)
}

function recordFieldAnchorClass(fieldId: string): string {
  return resolveCommentAffordanceStateClass('meta-record-drawer__comment-anchor', recordFieldAffordance(fieldId))
}

function navigatePrev() {
  const idx = currentRecordIndex.value
  if (idx > 0) emit('navigate', props.recordIds[idx - 1])
}

function navigateNext() {
  const idx = currentRecordIndex.value
  if (idx >= 0 && idx < props.recordIds.length - 1) emit('navigate', props.recordIds[idx + 1])
}

async function loadRecordHistory() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId) {
    historyItems.value = []
    historyLoading.value = false
    historyError.value = ''
    return
  }
  const requestId = ++historyRequestId
  historyLoading.value = true
  historyError.value = ''
  try {
    const items = await apiClient.listRecordHistory(sheetId, recordId, { limit: 50 })
    if (requestId !== historyRequestId) return
    historyItems.value = items
  } catch (error: any) {
    if (requestId !== historyRequestId) return
    historyItems.value = []
    historyError.value = error?.message ?? 'Failed to load history'
  } finally {
    if (requestId === historyRequestId) historyLoading.value = false
  }
}

function applySubscriptionStatus(status: MetaRecordSubscriptionStatus) {
  recordSubscribed.value = status.subscribed
}

async function loadRecordSubscription() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId) {
    recordSubscribed.value = false
    subscriptionLoading.value = false
    subscriptionError.value = ''
    return
  }
  const requestId = ++subscriptionRequestId
  subscriptionLoading.value = true
  subscriptionError.value = ''
  try {
    const status = await apiClient.getRecordSubscriptionStatus(sheetId, recordId)
    if (requestId !== subscriptionRequestId) return
    applySubscriptionStatus(status)
  } catch (error: any) {
    if (requestId !== subscriptionRequestId) return
    recordSubscribed.value = false
    subscriptionError.value = error?.message ?? 'Failed to load watch status'
  } finally {
    if (requestId === subscriptionRequestId) subscriptionLoading.value = false
  }
}

async function toggleRecordSubscription() {
  const apiClient = props.apiClient
  const sheetId = props.sheetId
  const recordId = props.record?.id
  if (!apiClient || !sheetId || !recordId || subscriptionLoading.value) return
  const requestId = ++subscriptionRequestId
  subscriptionLoading.value = true
  subscriptionError.value = ''
  try {
    const status = recordSubscribed.value
      ? await apiClient.unsubscribeRecord(sheetId, recordId)
      : await apiClient.subscribeRecord(sheetId, recordId)
    if (requestId !== subscriptionRequestId) return
    applySubscriptionStatus(status)
  } catch (error: any) {
    if (requestId !== subscriptionRequestId) return
    subscriptionError.value = error?.message ?? 'Failed to update watch status'
  } finally {
    if (requestId === subscriptionRequestId) subscriptionLoading.value = false
  }
}

function historyActionLabel(action: MetaRecordRevision['action']): string {
  if (action === 'create') return 'Created'
  if (action === 'delete') return 'Deleted'
  return 'Updated'
}

function historyFieldLabels(fieldIds: string[]): string {
  return fieldIds
    .map((fieldId) => fieldLabelById.value.get(fieldId) ?? fieldId)
    .join(', ')
}

function formatHistoryTime(value: string): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Date(timestamp).toLocaleString()
}

function formatValue(field: MetaField, v: unknown): string {
  return formatFieldDisplay({
    field,
    value: v,
    linkSummaries: props.linkSummariesByField?.[field.id],
    attachmentSummaries: props.attachmentSummariesByField?.[field.id],
  })
}

function textControlValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function multiSelectValue(fieldId: string): string[] {
  const value = props.record?.data[fieldId]
  return Array.isArray(value) ? value.map(String) : []
}

function multiSelectEventValue(event: Event): string[] {
  const select = event.target as HTMLSelectElement
  return Array.from(select.selectedOptions).map((option) => option.value)
}

function linkButtonLabel(fieldId: string): string {
  const count = linkSummaryCount(fieldId)
  const field = props.fields.find((item) => item.id === fieldId) ?? null
  return linkActionLabel(field, count)
}

function linkPreview(fieldId: string): string {
  const summaries = props.linkSummariesByField?.[fieldId] ?? []
  if (summaries.length) return summaries.map((item) => item.display || item.id).join(', ')
  const raw = props.record?.data[fieldId]
  const ids = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
  return ids.join(', ')
}

function attachmentList(fieldId: string): string[] {
  const raw = props.record?.data[fieldId]
  if (Array.isArray(raw)) return raw.map(String)
  if (raw) return [String(raw)]
  return []
}

function attachmentItems(fieldId: string): MetaAttachment[] {
  const summaryMap = new Map((props.attachmentSummariesByField?.[fieldId] ?? []).map((attachment) => [attachment.id, attachment]))
  for (const attachment of Object.values(localAttachmentSummaries.value[fieldId] ?? {})) {
    summaryMap.set(attachment.id, attachment)
  }
  return attachmentList(fieldId).map((id) => summaryMap.get(id) ?? ({
    id,
    filename: id,
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: '',
  }))
}

function linkSummaryCount(fieldId: string): number {
  const summaries = props.linkSummariesByField?.[fieldId] ?? []
  if (summaries.length) return summaries.length
  const raw = props.record?.data[fieldId]
  return Array.isArray(raw) ? raw.length : raw ? 1 : 0
}

function attachmentActionHint(fieldId: string): string {
  const field = props.fields.find((item) => item.id === fieldId)
  if (!field || field.type !== 'attachment') return 'Add files'
  return attachmentAllowsMultiple(field)
    ? 'Add files'
    : attachmentList(fieldId).length
      ? 'Upload a new file to replace the current one'
      : 'Upload a file'
}

async function onDrawerFileSelect(fieldId: string, e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files?.length) return
  clearAttachmentError(fieldId)
  const field = props.fields.find((item) => item.id === fieldId)
  if (field) {
    const validationError = validateAttachmentSelection(field, files, attachmentList(fieldId).length)
    if (validationError) {
      setAttachmentError(fieldId, validationError)
      input.value = ''
      return
    }
  }
  if (!props.uploadFn) {
    const existing = attachmentList(fieldId)
    const replaceExisting = field ? shouldReplaceAttachmentSelection(field, files, existing.length) : false
    const uploadedNames = Array.from(files).map((file) => file.name)
    emit('patch', fieldId, replaceExisting ? uploadedNames : [...existing, ...uploadedNames])
    input.value = ''
    return
  }
  setAttachmentActivity(fieldId, 'uploading')
  try {
    const existing = attachmentList(fieldId)
    const replaceExisting = field ? shouldReplaceAttachmentSelection(field, files, existing.length) : false
    const newIds: string[] = []
    for (const file of Array.from(files)) {
      const attachment = await props.uploadFn(file, {
        recordId: props.record?.id,
        fieldId,
      })
      rememberLocalAttachment(fieldId, attachment)
      newIds.push(attachment.id)
    }
    emit('patch', fieldId, replaceExisting ? newIds : [...existing, ...newIds])
  } catch (error: any) {
    setAttachmentError(fieldId, error?.message ?? 'Failed to upload attachment')
  } finally {
    setAttachmentActivity(fieldId)
    input.value = ''
  }
}

async function onRemoveAttachment(fieldId: string, attachmentId: string) {
  clearAttachmentError(fieldId)
  if (props.deleteAttachmentFn) {
    setAttachmentActivity(fieldId, 'removing')
    try {
      await props.deleteAttachmentFn(attachmentId, {
        recordId: props.record?.id,
        fieldId,
      })
    } catch (error: any) {
      setAttachmentError(fieldId, error?.message ?? 'Failed to remove attachment')
      setAttachmentActivity(fieldId)
      return
    }
    setAttachmentActivity(fieldId)
  }
  const existing = attachmentList(fieldId)
  emit('patch', fieldId, existing.filter((id) => id !== attachmentId))
  forgetLocalAttachment(fieldId, attachmentId)
}

async function onClearAttachments(fieldId: string) {
  const existing = attachmentList(fieldId)
  if (!existing.length) return
  clearAttachmentError(fieldId)
  if (props.deleteAttachmentFn) {
    setAttachmentActivity(fieldId, 'clearing')
    try {
      for (const attachmentId of existing) {
        await props.deleteAttachmentFn(attachmentId, {
          recordId: props.record?.id,
          fieldId,
        })
        forgetLocalAttachment(fieldId, attachmentId)
      }
    } catch (error: any) {
      setAttachmentError(fieldId, error?.message ?? 'Failed to clear attachments')
      setAttachmentActivity(fieldId)
      return
    }
    setAttachmentActivity(fieldId)
  }
  emit('patch', fieldId, [])
}

function setAttachmentActivity(fieldId: string, activity?: 'uploading' | 'removing' | 'clearing') {
  const next = { ...attachmentActivity.value }
  if (activity) next[fieldId] = activity
  else delete next[fieldId]
  attachmentActivity.value = next
}

function setAttachmentError(fieldId: string, message: string) {
  attachmentErrors.value = {
    ...attachmentErrors.value,
    [fieldId]: message,
  }
}

function clearAttachmentError(fieldId: string) {
  if (!attachmentErrors.value[fieldId]) return
  const next = { ...attachmentErrors.value }
  delete next[fieldId]
  attachmentErrors.value = next
}

function rememberLocalAttachment(fieldId: string, attachment: MetaAttachment) {
  localAttachmentSummaries.value = {
    ...localAttachmentSummaries.value,
    [fieldId]: {
      ...(localAttachmentSummaries.value[fieldId] ?? {}),
      [attachment.id]: attachment,
    },
  }
}

function forgetLocalAttachment(fieldId: string, attachmentId: string) {
  const current = localAttachmentSummaries.value[fieldId]
  if (!current?.[attachmentId]) return
  const nextFieldMap = { ...current }
  delete nextFieldMap[attachmentId]
  localAttachmentSummaries.value = {
    ...localAttachmentSummaries.value,
    [fieldId]: nextFieldMap,
  }
}

function attachmentAccept(field: MetaField): string | undefined {
  return attachmentAcceptAttr(field)
}

function attachmentAllowsMultiple(field: MetaField): boolean {
  return resolveAttachmentFieldProperty(field.property).maxFiles !== 1
}
</script>

<style scoped>
.meta-record-drawer { width: 360px; border-left: 1px solid #e5e7eb; background: #fff; display: flex; flex-direction: column; overflow-y: auto; }
.meta-record-drawer__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-record-drawer__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-record-drawer__actions { display: flex; gap: 8px; align-items: center; }
.meta-record-drawer__btn { padding: 4px 10px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-record-drawer__btn--comment { border-radius: 999px; padding: 3px 8px; }
.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-record-drawer__btn--comment.meta-record-drawer__btn--comment--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-record-drawer__btn--danger { color: #f56c6c; border-color: #f56c6c; }
.meta-record-drawer__btn--watch { border-color: #bfdbfe; color: #1d4ed8; background: #eff6ff; }
.meta-record-drawer__btn--watching { border-color: #0f766e; color: #0f766e; background: #ecfdf5; }
.meta-record-drawer__btn:disabled { opacity: 0.55; cursor: not-allowed; }
.meta-record-drawer__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-record-drawer__nav { display: flex; align-items: center; gap: 4px; margin-right: auto; margin-left: 8px; }
.meta-record-drawer__nav-btn { width: 24px; height: 24px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
.meta-record-drawer__nav-btn:hover:not(:disabled) { background: #f5f5f5; }
.meta-record-drawer__nav-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.meta-record-drawer__nav-pos { font-size: 11px; color: #999; min-width: 36px; text-align: center; }
.meta-record-drawer__body { padding: 12px 16px; flex: 1; }
.meta-record-drawer__tabs { display: inline-flex; gap: 4px; padding: 3px; margin-bottom: 14px; border: 1px solid #e5e7eb; border-radius: 999px; background: #f8fafc; }
.meta-record-drawer__tab { min-width: 76px; padding: 5px 12px; border: none; border-radius: 999px; background: transparent; color: #64748b; cursor: pointer; font-size: 12px; font-weight: 600; }
.meta-record-drawer__tab--active { background: #111827; color: #fff; box-shadow: 0 2px 8px rgba(15, 23, 42, 0.16); }
.meta-record-drawer__watch-error { margin: -4px 0 12px; color: #b91c1c; font-size: 12px; }
.meta-record-drawer__field { margin-bottom: 14px; }
.meta-record-drawer__field-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.meta-record-drawer__label { display: block; font-size: 12px; color: #999; }
.meta-record-drawer__comment-anchor { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 24px; padding: 0 6px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; }
.meta-record-drawer__comment-anchor:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-record-drawer__comment-anchor--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-record-drawer__comment-anchor--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-record-drawer__input { width: 100%; padding: 4px 8px; border: 1px solid #ddd; border-radius: 3px; font-size: 13px; }
.meta-record-drawer__input--multi { min-height: 96px; }
.meta-record-drawer__textarea {
  width: 100%; min-height: 104px; padding: 6px 8px; border: 1px solid #ddd; border-radius: 3px;
  font-size: 13px; line-height: 1.45; resize: vertical; white-space: pre-wrap;
}
.meta-record-drawer__check { cursor: pointer; }
.meta-record-drawer__link-btn { padding: 4px 10px; border: 1px solid #409eff; border-radius: 3px; background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 12px; }
.meta-record-drawer__link-summary { margin-top: 6px; font-size: 12px; color: #606266; }
.meta-record-drawer__attachments { display: flex; flex-direction: column; gap: 6px; }
.meta-record-drawer__attachment-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.meta-record-drawer__file-input { font-size: 12px; }
.meta-record-drawer__attachment-hint { font-size: 12px; color: #606266; }
.meta-record-drawer__attachment-clear { border: none; background: none; color: #e67e22; cursor: pointer; font-size: 12px; }
.meta-record-drawer__attachment-clear:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-record-drawer__uploading { font-size: 12px; color: #409eff; }
.meta-record-drawer__error { color: #f56c6c; font-size: 12px; }
.meta-record-drawer__text { font-size: 13px; color: #333; white-space: pre-wrap; word-break: break-word; }
.meta-record-drawer__empty { padding: 32px; text-align: center; color: #999; }
.meta-record-drawer__history-state { padding: 18px 12px; border: 1px dashed #d8e1ee; border-radius: 8px; color: #64748b; font-size: 13px; text-align: center; }
.meta-record-drawer__history-state--error { border-color: #fecaca; color: #b91c1c; background: #fef2f2; }
.meta-record-drawer__history-list { display: flex; flex-direction: column; gap: 10px; padding: 0; margin: 0; list-style: none; }
.meta-record-drawer__history-item { padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; }
.meta-record-drawer__history-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
.meta-record-drawer__history-action { font-size: 13px; font-weight: 700; color: #111827; }
.meta-record-drawer__history-version { font-size: 11px; font-weight: 700; color: #2563eb; background: #eff6ff; border-radius: 999px; padding: 2px 7px; }
.meta-record-drawer__history-meta { display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: #64748b; }
.meta-record-drawer__history-fields { margin-top: 8px; font-size: 12px; color: #374151; word-break: break-word; }
</style>
