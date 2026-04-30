<template>
  <div class="meta-form-view">
    <div v-if="loading" class="meta-form-view__loading">Loading...</div>
    <template v-else>
      <div v-if="readOnly" class="meta-form-view__readonly-banner">This form is read-only</div>
      <div v-if="successMessage" class="meta-form-view__success">{{ successMessage }}</div>
      <div v-if="errorMessage" class="meta-form-view__error">{{ errorMessage }}</div>
      <form class="meta-form-view__form" @submit.prevent="onSubmit">
        <div
          v-for="field in editableFields"
          :key="field.id"
          class="meta-form-view__field"
        >
          <div class="meta-form-view__label-row">
            <label class="meta-form-view__label" :for="`field_${field.id}`">{{ field.name }}</label>
            <button
              v-if="record?.id && canComment"
              type="button"
              class="meta-form-view__comment-anchor"
              :class="formFieldAnchorClass(field.id)"
              :aria-label="`Comments for ${field.name}`"
              @click="emit('comment-field', field)"
            >
              <MetaCommentAffordance :state="formFieldAffordance(field.id)" />
            </button>
          </div>
          <input
            v-if="field.type === 'string'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="text"
            :disabled="isFieldReadOnly(field.id)"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="textControlValue(formData[field.id])"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value"
          />
          <textarea
            v-else-if="field.type === 'longText'"
            :id="`field_${field.id}`"
            class="meta-form-view__textarea"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            rows="5"
            :disabled="isFieldReadOnly(field.id)"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="textControlValue(formData[field.id])"
            @input="formData[field.id] = ($event.target as HTMLTextAreaElement).value"
          />
          <input
            v-else-if="field.type === 'number'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="number"
            :disabled="isFieldReadOnly(field.id)"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="formData[field.id] ?? ''"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)"
          />
          <label v-else-if="field.type === 'boolean'" class="meta-form-view__check">
            <input type="checkbox" :disabled="isFieldReadOnly(field.id)" :checked="!!formData[field.id]" @change="formData[field.id] = ($event.target as HTMLInputElement).checked" />
            {{ formData[field.id] ? 'Yes' : 'No' }}
          </label>
          <input
            v-else-if="field.type === 'date'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="date"
            :disabled="isFieldReadOnly(field.id)"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="formData[field.id] ?? ''"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value"
          />
          <select
            v-else-if="field.type === 'select'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            :disabled="isFieldReadOnly(field.id)"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="formData[field.id] ?? ''"
            @change="formData[field.id] = ($event.target as HTMLSelectElement).value"
          >
            <option value="">—</option>
            <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">{{ opt.value }}</option>
          </select>
          <select
            v-else-if="field.type === 'multiSelect'"
            :id="`field_${field.id}`"
            class="meta-form-view__input meta-form-view__input--multi"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            multiple
            :disabled="isFieldReadOnly(field.id)"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="multiSelectValue(field.id)"
            @change="formData[field.id] = multiSelectEventValue($event)"
          >
            <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">{{ opt.value }}</option>
          </select>
          <button
            v-else-if="field.type === 'link'"
            type="button"
            class="meta-form-view__link-btn"
            :disabled="isFieldReadOnly(field.id)"
            @click="emit('open-link-picker', field)"
          >{{ linkButtonLabel(field.id) }}</button>
          <div v-else-if="field.type === 'attachment'" class="meta-form-view__attachment-field">
            <div v-if="!isFieldReadOnly(field.id)" class="meta-form-view__attachment-controls">
              <input
                type="file"
                :multiple="attachmentAllowsMultiple(field)"
                :accept="attachmentAccept(field)"
                :disabled="!!attachmentActivity[field.id]"
                class="meta-form-view__file-input"
                @change="onFormFileSelect(field.id, $event)"
              />
              <span class="meta-form-view__attachment-hint">{{ attachmentActionHint(field.id) }}</span>
              <button
                v-if="attachmentList(field.id).length"
                type="button"
                class="meta-form-view__attachment-clear"
                :disabled="!!attachmentActivity[field.id]"
                @click="onClearAttachments(field.id)"
              >Clear all</button>
            </div>
            <span v-if="attachmentActivity[field.id]" class="meta-form-view__uploading">
              {{ attachmentActivity[field.id] === 'removing' ? 'Removing...' : attachmentActivity[field.id] === 'clearing' ? 'Clearing...' : 'Uploading...' }}
            </span>
            <MetaAttachmentList
              :attachments="attachmentItems(field.id)"
              :removable="!isFieldReadOnly(field.id)"
              empty-label=""
              @remove="onRemoveAttachment(field.id, $event)"
            />
            <div v-if="attachmentOperationErrors[field.id]" class="meta-form-view__field-error">{{ attachmentOperationErrors[field.id] }}</div>
          </div>
          <input
            v-else-if="field.type === 'currency' || field.type === 'percent'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="number"
            step="any"
            :disabled="isFieldReadOnly(field.id)"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :value="formData[field.id] ?? ''"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)"
          />
          <div v-else-if="field.type === 'rating'" class="meta-form-view__rating">
            <button
              v-for="n in ratingMaxFor(field)"
              :key="n"
              type="button"
              class="meta-form-view__rating-star"
              :class="{ 'meta-form-view__rating-star--filled': n <= ratingValueFor(field.id) }"
              :disabled="isFieldReadOnly(field.id)"
              @click="onRatingPick(field.id, n)"
            >★</button>
          </div>
          <input
            v-else-if="field.type === 'url'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="url"
            placeholder="https://example.com"
            :disabled="isFieldReadOnly(field.id)"
            :value="formData[field.id] ?? ''"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value"
          />
          <input
            v-else-if="field.type === 'email'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="email"
            placeholder="name@example.com"
            :disabled="isFieldReadOnly(field.id)"
            :value="formData[field.id] ?? ''"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value"
          />
          <input
            v-else-if="field.type === 'phone'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="tel"
            placeholder="+86 138 0000 0000"
            :disabled="isFieldReadOnly(field.id)"
            :value="formData[field.id] ?? ''"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value"
          />
          <span v-else class="meta-form-view__readonly-val">{{ readonlyFieldDisplay(field) }}</span>
          <div v-if="field.type === 'link' && linkPreview(field.id)" class="meta-form-view__link-summary">{{ linkPreview(field.id) }}</div>
          <div v-if="fieldErrors?.[field.id] || validationErrors[field.id]" :id="`error_${field.id}`" class="meta-form-view__field-error">{{ fieldErrors?.[field.id] || validationErrors[field.id] }}</div>
        </div>
        <div v-if="!readOnly" class="meta-form-view__actions">
          <button type="submit" class="meta-form-view__submit" :disabled="submitting || hasPendingAttachmentActions">
            {{ submitting ? 'Saving...' : (record ? 'Save' : 'Create') }}
          </button>
          <button v-if="record" type="button" class="meta-form-view__reset" @click="resetForm">Reset</button>
        </div>
      </form>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type {
  LinkedRecordSummary,
  MetaAttachment,
  MetaAttachmentDeleteFn,
  MetaAttachmentUploadFn,
  MultitableCommentPresenceSummary,
  MetaFieldPermission,
  MetaField,
  MetaRecord,
  MetaRowActions,
} from '../types'
import MetaAttachmentList from './MetaAttachmentList.vue'
import MetaCommentAffordance from './MetaCommentAffordance.vue'
import {
  resolveCommentAffordanceStateClass,
  resolveFieldCommentAffordance,
} from '../utils/comment-affordance'
import {
  attachmentAcceptAttr,
  resolveAttachmentFieldProperty,
  resolveRatingFieldProperty,
  shouldReplaceAttachmentSelection,
  validateAttachmentSelection,
} from '../utils/field-config'
import { linkActionLabel } from '../utils/link-fields'
import { formatFieldDisplay } from '../utils/field-display'
import { isSystemField } from '../utils/system-fields'

const props = defineProps<{
  fields: MetaField[]
  hiddenFieldIds?: string[]
  record?: MetaRecord | null
  loading: boolean
  readOnly?: boolean
  submitting?: boolean
  successMessage?: string | null
  errorMessage?: string | null
  fieldErrors?: Record<string, string> | null
  fieldPermissions?: Record<string, MetaFieldPermission> | null
  rowActions?: MetaRowActions | null
  linkSummariesByField?: Record<string, LinkedRecordSummary[]> | null
  attachmentSummariesByField?: Record<string, MetaAttachment[]> | null
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  canComment?: boolean
  commentPresence?: MultitableCommentPresenceSummary | null
}>()

const emit = defineEmits<{
  (e: 'submit', data: Record<string, unknown>): void
  (e: 'open-link-picker', field: MetaField): void
  (e: 'update:dirty', dirty: boolean): void
  (e: 'comment-field', field: MetaField): void
}>()

const formData = reactive<Record<string, unknown>>({})
const validationErrors = ref<Record<string, string>>({})
const attachmentActivity = ref<Record<string, 'uploading' | 'removing' | 'clearing'>>({})
const attachmentOperationErrors = ref<Record<string, string>>({})
const localAttachmentSummaries = ref<Record<string, Record<string, MetaAttachment>>>({})

const editableFields = computed(() => {
  const hidden = new Set(props.hiddenFieldIds ?? [])
  return props.fields.filter((field) => !hidden.has(field.id) && props.fieldPermissions?.[field.id]?.visible !== false)
})

function isFieldReadOnly(fieldId: string): boolean {
  const field = props.fields.find((item) => item.id === fieldId) ?? null
  return !!props.readOnly || props.fieldPermissions?.[fieldId]?.readOnly === true || props.rowActions?.canEdit === false || isSystemField(field)
}

const hasUnsavedChanges = computed(() => {
  if (!props.record) return Object.keys(formData).some((k) => !isEmptyFormValue(formData[k]))
  return Object.keys(formData).some((k) => !isSameFormValue(formData[k], props.record!.data[k]))
})

const hasPendingAttachmentActions = computed(() => Object.keys(attachmentActivity.value).length > 0)
const formDirty = computed(() => hasUnsavedChanges.value || hasPendingAttachmentActions.value)

function formFieldAffordance(fieldId: string) {
  return resolveFieldCommentAffordance(props.commentPresence, fieldId)
}

function formFieldAnchorClass(fieldId: string): string {
  return resolveCommentAffordanceStateClass('meta-form-view__comment-anchor', formFieldAffordance(fieldId))
}

function textControlValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function multiSelectValue(fieldId: string): string[] {
  const value = formData[fieldId]
  return Array.isArray(value) ? value.map(String) : []
}

function multiSelectEventValue(event: Event): string[] {
  const select = event.target as HTMLSelectElement
  return Array.from(select.selectedOptions).map((option) => option.value)
}

function syncFromRecord(record: MetaRecord | null | undefined) {
  Object.keys(formData).forEach((k) => delete formData[k])
  if (record) Object.assign(formData, { ...record.data })
}

watch(() => props.record, (record, previousRecord) => {
  syncFromRecord(record)
  validationErrors.value = {}
  attachmentOperationErrors.value = {}
  if (record?.id !== previousRecord?.id) {
    localAttachmentSummaries.value = {}
    attachmentActivity.value = {}
  }
}, { immediate: true })

watch(
  formDirty,
  (dirty) => {
    emit('update:dirty', dirty)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  emit('update:dirty', false)
})

function validate(): boolean {
  const errs: Record<string, string> = {}
  for (const f of editableFields.value) {
    const v = formData[f.id]
    if (f.required && isEmptyFormValue(v)) {
      errs[f.id] = `${f.name} is required`
    }
  }
  validationErrors.value = errs
  return Object.keys(errs).length === 0
}

function onSubmit() {
  if (!validate()) return
  emit('submit', buildSubmitPayload())
}

function resetForm() {
  if (hasUnsavedChanges.value && !confirm('Discard unsaved changes?')) return
  syncFromRecord(props.record)
  validationErrors.value = {}
}

function linkButtonLabel(fieldId: string): string {
  const count = linkSummaryCount(fieldId)
  const field = props.fields.find((item) => item.id === fieldId) ?? null
  return linkActionLabel(field, count)
}

function ratingMaxFor(field: MetaField): number {
  return resolveRatingFieldProperty(field.property).max
}

function ratingValueFor(fieldId: string): number {
  const v = formData[fieldId]
  const num = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.round(num))
}

function onRatingPick(fieldId: string, value: number) {
  formData[fieldId] = value === ratingValueFor(fieldId) ? null : value
}

function linkPreview(fieldId: string): string {
  const summaries = props.linkSummariesByField?.[fieldId] ?? []
  if (summaries.length) return summaries.map((item) => item.display || item.id).join(', ')
  const raw = formData[fieldId] ?? props.record?.data[fieldId]
  const ids = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []
  return ids.join(', ')
}

function linkSummaryCount(fieldId: string): number {
  const summaries = props.linkSummariesByField?.[fieldId] ?? []
  if (summaries.length) return summaries.length
  const raw = formData[fieldId] ?? props.record?.data[fieldId]
  return Array.isArray(raw) ? raw.length : raw ? 1 : 0
}

function readonlyFieldDisplay(field: MetaField): string {
  return formatFieldDisplay({
    field,
    value: formData[field.id] ?? props.record?.data[field.id],
    linkSummaries: props.linkSummariesByField?.[field.id],
    attachmentSummaries: props.attachmentSummariesByField?.[field.id],
  })
}

function buildSubmitPayload(): Record<string, unknown> {
  const systemFieldIds = new Set(props.fields.filter((field) => isSystemField(field)).map((field) => field.id))
  return Object.fromEntries(
    Object.entries(formData).filter(([fieldId]) => !systemFieldIds.has(fieldId)),
  )
}

function attachmentList(fieldId: string): string[] {
  const raw = formData[fieldId] ?? props.record?.data[fieldId]
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

function attachmentActionHint(fieldId: string): string {
  const field = props.fields.find((item) => item.id === fieldId)
  if (!field || field.type !== 'attachment') return 'Add files'
  const allowsMultiple = attachmentAllowsMultiple(field)
  if (allowsMultiple) return 'Add files'
  return attachmentList(fieldId).length ? 'Upload a new file to replace the current one' : 'Upload a file'
}

async function onFormFileSelect(fieldId: string, e: Event) {
  const input = e.target as HTMLInputElement
  const files = input.files
  if (!files?.length) return
  clearAttachmentOperationError(fieldId)
  const field = props.fields.find((item) => item.id === fieldId)
  if (field) {
    const validationError = validateAttachmentSelection(field, files, attachmentList(fieldId).length)
    if (validationError) {
      setAttachmentOperationError(fieldId, validationError)
      input.value = ''
      return
    }
  }
  if (!props.uploadFn) {
    const existing = attachmentList(fieldId)
    const replaceExisting = field ? shouldReplaceAttachmentSelection(field, files, existing.length) : false
    const uploadedNames = Array.from(files).map((file) => file.name)
    formData[fieldId] = replaceExisting ? uploadedNames : [...existing, ...uploadedNames]
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
    formData[fieldId] = replaceExisting ? newIds : [...existing, ...newIds]
  } catch (error: any) {
    setAttachmentOperationError(fieldId, error?.message ?? 'Failed to upload attachment')
  } finally {
    setAttachmentActivity(fieldId)
    input.value = ''
  }
}

async function onRemoveAttachment(fieldId: string, attachmentId: string) {
  clearAttachmentOperationError(fieldId)
  if (props.deleteAttachmentFn) {
    setAttachmentActivity(fieldId, 'removing')
    try {
      await props.deleteAttachmentFn(attachmentId, {
        recordId: props.record?.id,
        fieldId,
      })
    } catch (error: any) {
      setAttachmentOperationError(fieldId, error?.message ?? 'Failed to remove attachment')
      setAttachmentActivity(fieldId)
      return
    }
    setAttachmentActivity(fieldId)
  }
  formData[fieldId] = attachmentList(fieldId).filter((id) => id !== attachmentId)
  forgetLocalAttachment(fieldId, attachmentId)
}

async function onClearAttachments(fieldId: string) {
  const existingIds = attachmentList(fieldId)
  if (!existingIds.length) return
  clearAttachmentOperationError(fieldId)
  if (props.deleteAttachmentFn) {
    setAttachmentActivity(fieldId, 'clearing')
    try {
      for (const attachmentId of existingIds) {
        await props.deleteAttachmentFn(attachmentId, {
          recordId: props.record?.id,
          fieldId,
        })
        forgetLocalAttachment(fieldId, attachmentId)
      }
    } catch (error: any) {
      setAttachmentOperationError(fieldId, error?.message ?? 'Failed to clear attachments')
      setAttachmentActivity(fieldId)
      return
    }
    setAttachmentActivity(fieldId)
  }
  formData[fieldId] = []
}

function attachmentAccept(field: MetaField): string | undefined {
  return attachmentAcceptAttr(field)
}

function attachmentAllowsMultiple(field: MetaField): boolean {
  return resolveAttachmentFieldProperty(field.property).maxFiles !== 1
}

function setAttachmentActivity(fieldId: string, activity?: 'uploading' | 'removing' | 'clearing') {
  const next = { ...attachmentActivity.value }
  if (activity) next[fieldId] = activity
  else delete next[fieldId]
  attachmentActivity.value = next
}

function setAttachmentOperationError(fieldId: string, message: string) {
  attachmentOperationErrors.value = {
    ...attachmentOperationErrors.value,
    [fieldId]: message,
  }
}

function clearAttachmentOperationError(fieldId: string) {
  if (!attachmentOperationErrors.value[fieldId]) return
  const next = { ...attachmentOperationErrors.value }
  delete next[fieldId]
  attachmentOperationErrors.value = next
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

function isEmptyFormValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

function isSameFormValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftValues = Array.isArray(left) ? left.map(String) : left == null ? [] : [String(left)]
    const rightValues = Array.isArray(right) ? right.map(String) : right == null ? [] : [String(right)]
    if (leftValues.length !== rightValues.length) return false
    return leftValues.every((value, index) => value === rightValues[index])
  }
  return left === right
}
</script>

<style scoped>
.meta-form-view { padding: 16px 24px; overflow-y: auto; flex: 1; }
.meta-form-view__loading { text-align: center; padding: 32px; color: #999; }
.meta-form-view__readonly-banner { padding: 8px 12px; background: #fdf6ec; color: #e6a23c; border-radius: 4px; font-size: 12px; margin-bottom: 12px; }
.meta-form-view__success { padding: 8px 12px; background: #f0f9eb; color: #67c23a; border-radius: 4px; font-size: 12px; margin-bottom: 12px; }
.meta-form-view__error { padding: 8px 12px; background: #fef0f0; color: #f56c6c; border-radius: 4px; font-size: 12px; margin-bottom: 12px; }
.meta-form-view__form { max-width: 560px; }
.meta-form-view__field { margin-bottom: 16px; }
.meta-form-view__label-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.meta-form-view__label { display: block; font-size: 13px; font-weight: 500; color: #333; }
.meta-form-view__comment-anchor { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 24px; padding: 0 6px; border: 1px solid #d8e1ee; border-radius: 999px; background: #fff; cursor: pointer; color: #64748b; }
.meta-form-view__comment-anchor:hover { border-color: #93c5fd; background: #eff6ff; color: #2563eb; }
.meta-form-view__comment-anchor--active { border-color: #f59e0b; background: #fff7ed; color: #b45309; }
.meta-form-view__comment-anchor--idle { border-color: #d8e1ee; background: #fff; color: #64748b; }
.meta-form-view__input { width: 100%; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-form-view__input--multi { min-height: 110px; }
.meta-form-view__textarea {
  width: 100%; min-height: 120px; padding: 8px 10px; border: 1px solid #ddd; border-radius: 4px;
  font-size: 13px; line-height: 1.5; resize: vertical; white-space: pre-wrap;
}
.meta-form-view__input--error { border-color: #f56c6c; background: #fff7f7; }
.meta-form-view__input:disabled { background: #f5f7fa; color: #999; cursor: not-allowed; }
.meta-form-view__textarea:disabled { background: #f5f7fa; color: #999; cursor: not-allowed; }
.meta-form-view__check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.meta-form-view__link-btn { padding: 6px 12px; border: 1px solid #409eff; border-radius: 4px; background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 13px; }
.meta-form-view__link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-form-view__link-summary { margin-top: 6px; font-size: 12px; color: #606266; }
.meta-form-view__attachment-field { display: flex; flex-direction: column; gap: 6px; }
.meta-form-view__attachment-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.meta-form-view__file-input { font-size: 12px; }
.meta-form-view__attachment-hint { font-size: 12px; color: #606266; }
.meta-form-view__attachment-clear { border: none; background: none; color: #e67e22; cursor: pointer; font-size: 12px; }
.meta-form-view__attachment-clear:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-form-view__uploading { font-size: 12px; color: #409eff; }
.meta-form-view__readonly-val { color: #999; font-size: 13px; }
.meta-form-view__field-error { margin-top: 6px; color: #f56c6c; font-size: 12px; }
.meta-form-view__actions { display: flex; gap: 8px; margin-top: 16px; }
.meta-form-view__submit { padding: 8px 24px; background: #409eff; color: #fff; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; }
.meta-form-view__submit:hover:not(:disabled) { background: #66b1ff; }
.meta-form-view__submit:disabled { opacity: 0.6; cursor: not-allowed; }
.meta-form-view__reset { padding: 8px 16px; border: 1px solid #ddd; border-radius: 4px; background: #fff; font-size: 13px; cursor: pointer; color: #666; }
.meta-form-view__reset:hover { background: #f5f7fa; }
.meta-form-view__rating { display: inline-flex; gap: 2px; align-items: center; }
.meta-form-view__rating-star {
  border: none; background: none; padding: 0 1px; cursor: pointer;
  font-size: 22px; color: #d6d6d6; line-height: 1;
}
.meta-form-view__rating-star--filled { color: #f5a623; }
.meta-form-view__rating-star:disabled { cursor: not-allowed; }
.meta-form-view__rating-star:hover:not(:disabled) { color: #f5a623; }
</style>
