<template>
  <div class="meta-cell-editor">
    <!-- date field type -->
    <input
      v-if="field.type === 'date'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="date"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <!-- string: date-like -->
    <input
      v-else-if="field.type === 'string' && isDateLike"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="date"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <!-- string: normal -->
    <input
      v-else-if="field.type === 'string'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="text"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- number -->
    <input
      v-else-if="field.type === 'number'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="number"
      :value="modelValue ?? ''"
      @input="onNumberInput"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- boolean -->
    <label v-else-if="field.type === 'boolean'" class="meta-cell-editor__check">
      <input
        type="checkbox"
        :checked="!!modelValue"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked); emit('confirm')"
      />
      <span>{{ modelValue ? 'Yes' : 'No' }}</span>
    </label>

    <!-- select -->
    <select
      v-else-if="field.type === 'select'"
      ref="inputRef"
      class="meta-cell-editor__select"
      :value="modelValue ?? ''"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value); emit('confirm')"
      @keydown.escape="emit('cancel')"
    >
      <option value="">—</option>
      <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">
        {{ opt.value }}
      </option>
    </select>

    <!-- link -->
    <button
      v-else-if="field.type === 'link'"
      class="meta-cell-editor__link-btn"
      @click="emit('open-link-picker')"
    >{{ linkButtonLabel }}</button>

    <!-- attachment -->
    <div v-else-if="field.type === 'attachment'" class="meta-cell-editor__attachment">
      <MetaAttachmentList
        :attachments="attachmentItems"
        removable
        empty-label="No attachments"
        @remove="onRemoveAttachment"
      />
      <div class="meta-cell-editor__attachment-actions">
        <label class="meta-cell-editor__file-trigger">
          <input
            ref="inputRef"
            type="file"
            :multiple="attachmentAllowsMultiple"
            :accept="attachmentAcceptAttrValue"
            class="meta-cell-editor__file-input"
            :disabled="!!attachmentActivity || uploading"
            @change="onFileSelect"
            @keydown.escape="emit('cancel')"
          />
          <span
            class="meta-cell-editor__file-trigger-label"
            @dragover.prevent
            @drop.prevent="onFileDrop"
          >{{ attachmentActionHint }}</span>
        </label>
        <button
          type="button"
          class="meta-cell-editor__clear-btn"
          :disabled="!attachmentIds.length || !!attachmentActivity || uploading"
          @click="clearAttachments"
        >
          Clear all
        </button>
      </div>
      <div v-if="attachmentActivity" class="meta-cell-editor__uploading">
        {{ attachmentActivity === 'removing' ? 'Removing...' : attachmentActivity === 'clearing' ? 'Clearing...' : 'Uploading...' }}
      </div>
      <div v-if="attachmentError" class="meta-cell-editor__error">{{ attachmentError }}</div>
    </div>

    <!-- readonly fallback -->
    <span v-else class="meta-cell-editor__readonly">{{ modelValue ?? '' }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import type { MetaAttachment, MetaAttachmentDeleteFn, MetaAttachmentUploadContext, MetaAttachmentUploadFn, MetaField } from '../../types'
import MetaAttachmentList from '../MetaAttachmentList.vue'
import { attachmentAcceptAttr, resolveAttachmentFieldProperty, shouldReplaceAttachmentSelection, validateAttachmentSelection } from '../../utils/field-config'
import { linkActionLabel as formatLinkActionLabel } from '../../utils/link-fields'

const props = defineProps<{
  field: MetaField
  modelValue: unknown
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  uploadContext?: MetaAttachmentUploadContext
  attachmentSummaries?: MetaAttachment[]
}>()

const DATE_RE = /^\d{4}-\d{2}-\d{2}/
const DATE_FIELD_NAMES = /date|time|deadline|due|start|end|created|updated|birthday/i
const isDateLike = computed(() => {
  if (props.field.type !== 'string') return false
  if (DATE_FIELD_NAMES.test(props.field.name)) return true
  if (typeof props.modelValue === 'string' && DATE_RE.test(props.modelValue)) return true
  return false
})

const emit = defineEmits<{
  (e: 'update:modelValue', val: unknown): void
  (e: 'confirm'): void
  (e: 'cancel'): void
  (e: 'open-link-picker'): void
}>()

const inputRef = ref<HTMLElement | null>(null)
const linkButtonLabel = computed(() => {
  if (props.field.type !== 'link') return 'Choose linked records...'
  const count = Array.isArray(props.modelValue) ? props.modelValue.length : props.modelValue ? 1 : 0
  return formatLinkActionLabel(props.field, count)
})

const uploading = ref(false)
const attachmentActivity = ref<'uploading' | 'removing' | 'clearing' | null>(null)
const attachmentError = ref('')

const attachmentIds = computed(() => {
  const v = props.modelValue
  if (Array.isArray(v)) return v.map(String)
  if (v) return [String(v)]
  return []
})
const attachmentAcceptAttrValue = computed(() => attachmentAcceptAttr(props.field))
const attachmentAllowsMultiple = computed(() => {
  if (props.field.type !== 'attachment') return true
  return resolveAttachmentFieldProperty(props.field.property).maxFiles !== 1
})
const attachmentActionHint = computed(() => {
  if (attachmentAllowsMultiple.value) return 'Drop files or click to browse'
  return attachmentIds.value.length ? 'Upload a new file to replace the current one' : 'Upload a file'
})

const attachmentItems = computed<MetaAttachment[]>(() => {
  const summaryById = new Map((props.attachmentSummaries ?? []).map((attachment) => [attachment.id, attachment]))
  return attachmentIds.value.map((id) => summaryById.get(id) ?? {
    id,
    filename: id,
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: '',
  })
})

function attachmentContext(): MetaAttachmentUploadContext {
  return {
    ...props.uploadContext,
    fieldId: props.field.id,
  }
}

async function deleteAttachment(attachmentId: string) {
  if (!props.deleteAttachmentFn) return
  await props.deleteAttachmentFn(attachmentId, attachmentContext())
}

function setAttachmentValue(nextIds: string[], confirm = true) {
  emit('update:modelValue', nextIds)
  if (confirm) emit('confirm')
}

async function uploadFiles(files: FileList) {
  attachmentError.value = ''
  const validationError = validateAttachmentSelection(props.field, files, attachmentIds.value.length)
  if (validationError) {
    attachmentError.value = validationError
    return
  }
  if (!props.uploadFn) {
    emit('update:modelValue', Array.from(files).map((f) => f.name))
    emit('confirm')
    return
  }
  attachmentActivity.value = 'uploading'
  uploading.value = true
  try {
    const existingIds = [...attachmentIds.value]
    const replaceExisting = shouldReplaceAttachmentSelection(props.field, files, existingIds.length)
    const newIds: string[] = []
    for (const file of Array.from(files)) {
      const attachment = await props.uploadFn(file, attachmentContext())
      newIds.push(attachment.id)
    }
    setAttachmentValue(replaceExisting ? newIds : [...existingIds, ...newIds])
  } catch (error: any) {
    attachmentError.value = error?.message ?? 'Failed to upload attachment'
  } finally {
    uploading.value = false
    attachmentActivity.value = null
  }
}

function onFileSelect(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (files?.length) void uploadFiles(files)
}

function onFileDrop(e: DragEvent) {
  const files = e.dataTransfer?.files
  if (files?.length) void uploadFiles(files)
}

function onNumberInput(e: Event) {
  const v = (e.target as HTMLInputElement).value
  emit('update:modelValue', v === '' ? null : Number(v))
}

async function onRemoveAttachment(attachmentId: string) {
  attachmentError.value = ''
  attachmentActivity.value = 'removing'
  try {
    if (props.deleteAttachmentFn) {
      await deleteAttachment(attachmentId)
      setAttachmentValue(attachmentIds.value.filter((id) => id !== attachmentId), false)
      return
    }
    setAttachmentValue(attachmentIds.value.filter((id) => id !== attachmentId))
  } catch (error: any) {
    attachmentError.value = error?.message ?? 'Failed to remove attachment'
  } finally {
    attachmentActivity.value = null
  }
}

async function clearAttachments() {
  if (!attachmentIds.value.length) return
  attachmentError.value = ''
  attachmentActivity.value = 'clearing'
  try {
    if (props.deleteAttachmentFn) {
      for (const attachmentId of attachmentIds.value) {
        await deleteAttachment(attachmentId)
      }
      setAttachmentValue([], false)
      return
    }
    setAttachmentValue([])
  } catch (error: any) {
    attachmentError.value = error?.message ?? 'Failed to clear attachments'
  } finally {
    attachmentActivity.value = null
  }
}

onMounted(() => {
  if (inputRef.value && 'focus' in inputRef.value) {
    ;(inputRef.value as HTMLInputElement).focus()
  }
})
</script>

<style scoped>
.meta-cell-editor { display: flex; align-items: center; }
.meta-cell-editor__input {
  width: 100%; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px;
  font-size: 13px; outline: none;
}
.meta-cell-editor__select {
  width: 100%; padding: 2px 4px; border: 1px solid #409eff; border-radius: 3px;
  font-size: 13px; outline: none;
}
.meta-cell-editor__check { display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
.meta-cell-editor__link-btn {
  padding: 2px 8px; border: 1px solid #409eff; border-radius: 3px;
  background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 12px;
}
.meta-cell-editor__attachment { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.meta-cell-editor__attachment-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.meta-cell-editor__file-trigger { position: relative; display: inline-flex; }
.meta-cell-editor__file-input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.meta-cell-editor__file-trigger-label {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 160px; padding: 8px 12px; border: 2px dashed #c0d8f0; border-radius: 6px;
  text-align: center; font-size: 11px; color: #999; cursor: pointer; background: #fafcff;
}
.meta-cell-editor__file-trigger-label:hover { border-color: #409eff; color: #409eff; }
.meta-cell-editor__clear-btn {
  padding: 6px 10px; border: 1px solid #dbe4f0; border-radius: 6px; background: #fff; cursor: pointer;
  font-size: 12px; color: #355070;
}
.meta-cell-editor__clear-btn:disabled { opacity: 0.5; cursor: default; }
.meta-cell-editor__uploading { padding: 4px 0; font-size: 11px; color: #409eff; }
.meta-cell-editor__error { font-size: 11px; color: #d14343; }
.meta-cell-editor__readonly { color: #999; font-size: 13px; }
</style>
