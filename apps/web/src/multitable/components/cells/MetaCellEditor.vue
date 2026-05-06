<template>
  <div class="meta-cell-editor">
    <!-- date field type -->
    <input
      v-if="field.type === 'date'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="date"
      :value="textControlValue(modelValue)"
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
      :value="textControlValue(modelValue)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <!-- string: normal -->
    <div v-else-if="field.type === 'string'" class="meta-cell-editor__text-wrap">
      <input
        ref="inputRef"
        class="meta-cell-editor__input"
        type="text"
        :value="yjsActive ? yjsText : (modelValue ?? '')"
        @input="onTextInput"
        @keydown.enter="onTextConfirm"
        @keydown.escape="emit('cancel')"
      />
      <MetaYjsPresenceChip
        v-if="yjsActive && yjsCollaborators.length > 0"
        class="meta-cell-editor__presence"
        label="Editing"
        :users="yjsCollaborators"
      />
    </div>

    <!-- longText: multiline REST editor -->
    <textarea
      v-else-if="field.type === 'longText'"
      ref="inputRef"
      class="meta-cell-editor__textarea"
      rows="4"
      :value="textControlValue(modelValue)"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @keydown.meta.enter.prevent="emit('confirm')"
      @keydown.ctrl.enter.prevent="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- barcode: text-backed field; scanner/image generation is out of scope. -->
    <input
      v-else-if="field.type === 'barcode'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="text"
      inputmode="text"
      placeholder="Scan or enter barcode"
      :value="textControlValue(modelValue)"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- location: address-only editor; coordinates can still be supplied through API. -->
    <input
      v-else-if="field.type === 'location'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="text"
      placeholder="Enter address"
      :value="locationAddressValue(modelValue)"
      @input="emit('update:modelValue', locationValueFromAddress(($event.target as HTMLInputElement).value))"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- number -->
    <input
      v-else-if="field.type === 'number'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="number"
      :step="numericStep"
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

    <!-- multiSelect -->
    <select
      v-else-if="field.type === 'multiSelect'"
      ref="inputRef"
      class="meta-cell-editor__select meta-cell-editor__select--multi"
      multiple
      :value="multiSelectValue"
      @change="onMultiSelectChange"
      @keydown.meta.enter.prevent="emit('confirm')"
      @keydown.ctrl.enter.prevent="emit('confirm')"
      @keydown.escape="emit('cancel')"
    >
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

    <!-- currency / percent: numeric input with field-specific step -->
    <input
      v-else-if="field.type === 'currency' || field.type === 'percent'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="number"
      :step="numericStep"
      :value="modelValue ?? ''"
      @input="onNumberInput"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

    <!-- rating: click-to-set stars -->
    <div v-else-if="field.type === 'rating'" class="meta-cell-editor__rating">
      <button
        v-for="n in ratingMax"
        :key="n"
        type="button"
        class="meta-cell-editor__rating-star"
        :class="{ 'meta-cell-editor__rating-star--filled': n <= ratingValue }"
        @click="onRatingPick(n)"
      >★</button>
      <button
        v-if="ratingValue > 0"
        type="button"
        class="meta-cell-editor__rating-clear"
        @click="onRatingPick(0)"
      >Clear</button>
    </div>

    <!-- url / email / phone: validated text input -->
    <input
      v-else-if="field.type === 'url'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="url"
      placeholder="https://example.com"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <input
      v-else-if="field.type === 'email'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="email"
      placeholder="name@example.com"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />
    <input
      v-else-if="field.type === 'phone'"
      ref="inputRef"
      class="meta-cell-editor__input"
      type="tel"
      placeholder="+86 138 0000 0000"
      :value="modelValue ?? ''"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      @keydown.enter="emit('confirm')"
      @keydown.escape="emit('cancel')"
    />

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
    <span v-else class="meta-cell-editor__readonly">{{ readonlyDisplayValue }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, toRef } from 'vue'
import type { MetaAttachment, MetaAttachmentDeleteFn, MetaAttachmentUploadContext, MetaAttachmentUploadFn, MetaField } from '../../types'
import MetaAttachmentList from '../MetaAttachmentList.vue'
import MetaYjsPresenceChip from '../MetaYjsPresenceChip.vue'
import {
  attachmentAcceptAttr,
  resolveAttachmentFieldProperty,
  resolveCurrencyFieldProperty,
  resolveNumberFieldProperty,
  resolvePercentFieldProperty,
  resolveRatingFieldProperty,
  shouldReplaceAttachmentSelection,
  validateAttachmentSelection,
} from '../../utils/field-config'
import { linkActionLabel as formatLinkActionLabel } from '../../utils/link-fields'
import { formatFieldDisplay, locationAddressValue, locationValueFromAddress } from '../../utils/field-display'
import { useYjsCellBinding, type YjsCellBinding } from '../../composables/useYjsCellBinding'

const props = defineProps<{
  field: MetaField
  modelValue: unknown
  uploadFn?: MetaAttachmentUploadFn
  deleteAttachmentFn?: MetaAttachmentDeleteFn
  uploadContext?: MetaAttachmentUploadContext
  attachmentSummaries?: MetaAttachment[]
  /**
   * Record id of the cell being edited — required for Yjs binding. When
   * absent, the Yjs opt-in cannot engage; the editor falls back to the
   * existing REST path regardless of the build-time flag.
   */
  recordId?: string | null
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
  /**
   * Emitted *before* `confirm` when the user's edit was carried by the
   * Yjs opt-in path. Parents listening for this should suppress the
   * normal REST patch — the server-side Yjs bridge will persist the
   * change via `meta_records`. Pass-through REST is safe but redundant.
   */
  (e: 'yjs-commit'): void
}>()

const readonlyDisplayValue = computed(() =>
  formatFieldDisplay({
    field: props.field,
    value: props.modelValue,
    attachmentSummaries: props.attachmentSummaries,
  }),
)

function textControlValue(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

// --- Yjs opt-in binding (text cells only; inert when flag off) ---
// See useYjsCellBinding for flag gating + timeout + fallback. The editor
// always renders; `yjsActive` flips true only when a live Y.Doc is
// attached, at which point the `<input>` is driven by Y.Text instead of
// `modelValue`. On any failure (flag off, timeout, server error, mid-edit
// disconnect) `yjsActive` stays/returns to false and the input falls
// back to the REST path untouched.
const recordIdRef = toRef(props, 'recordId') as unknown as import('vue').Ref<string | null | undefined>
const fieldIdRef = computed<string | null>(() => {
  if (props.field?.type !== 'string') return null
  if (isDateLike.value) return null
  if (!props.recordId) return null
  return props.field.id
})
const inertYjsBinding: YjsCellBinding = {
  active: ref(false),
  text: ref(''),
  setText: () => { /* inactive: non-text editors keep using REST */ },
  collaborators: ref([]),
  release: () => { /* nothing to release */ },
}
const yjsEligibleAtSetup = props.field?.type === 'string' && !isDateLike.value && !!props.recordId
const yjsBinding = yjsEligibleAtSetup
  ? useYjsCellBinding({
      recordId: computed<string | null>(() => recordIdRef.value ?? null),
      fieldId: fieldIdRef,
      onFallback: (reason) => {
        if (reason === 'disabled') return // expected, no noise
        // Soft warning only — the REST path remains fully usable.
        // eslint-disable-next-line no-console
        console.warn(`[multitable] Yjs cell binding fell back to REST (${reason})`)
      },
    })
  : inertYjsBinding
const yjsActive = computed(() => yjsBinding.active.value)
const yjsText = computed(() => yjsBinding.text.value)
const yjsCollaborators = computed(() => yjsBinding.collaborators.value)

function onTextInput(event: Event) {
  const next = (event.target as HTMLInputElement).value
  if (yjsActive.value) {
    // Drive Y.Text; mirror via update:modelValue so parent state
    // (undo buffers, derived cell previews) stays in sync.
    yjsBinding.setText(next)
  }
  emit('update:modelValue', next)
}

function onTextConfirm() {
  if (yjsActive.value) emit('yjs-commit')
  emit('confirm')
}

const inputRef = ref<HTMLElement | null>(null)
const multiSelectValue = computed(() => {
  const raw = props.modelValue
  if (!Array.isArray(raw)) return []
  return raw.map(String)
})

function onMultiSelectChange(event: Event) {
  const select = event.target as HTMLSelectElement
  emit('update:modelValue', Array.from(select.selectedOptions).map((option) => option.value))
}

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

const numericStep = computed(() => {
  if (props.field.type === 'number') {
    const { decimals } = resolveNumberFieldProperty(props.field.property)
    return decimals && decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : 'any'
  }
  if (props.field.type === 'currency') {
    const { decimals } = resolveCurrencyFieldProperty(props.field.property)
    return decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : '1'
  }
  if (props.field.type === 'percent') {
    const { decimals } = resolvePercentFieldProperty(props.field.property)
    return decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : '1'
  }
  return 'any'
})

const ratingMax = computed(() => {
  if (props.field.type !== 'rating') return 5
  return resolveRatingFieldProperty(props.field.property).max
})

const ratingValue = computed(() => {
  const v = props.modelValue
  const num = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(ratingMax.value, Math.round(num)))
})

function onRatingPick(value: number) {
  emit('update:modelValue', value === 0 ? null : value)
  emit('confirm')
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
.meta-cell-editor__text-wrap {
  display: flex; align-items: center; gap: 6px; width: 100%;
}
.meta-cell-editor__input {
  width: 100%; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px;
  font-size: 13px; outline: none;
}
.meta-cell-editor__textarea {
  width: 100%; min-height: 88px; padding: 6px 8px; border: 1px solid #409eff; border-radius: 4px;
  font-size: 13px; line-height: 1.45; outline: none; resize: vertical; white-space: pre-wrap;
}
.meta-cell-editor__presence {
  flex-shrink: 0;
}
.meta-cell-editor__select {
  width: 100%; padding: 2px 4px; border: 1px solid #409eff; border-radius: 3px;
  font-size: 13px; outline: none;
}
.meta-cell-editor__select--multi { min-height: 96px; padding: 4px 6px; }
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
.meta-cell-editor__rating { display: flex; align-items: center; gap: 2px; }
.meta-cell-editor__rating-star {
  border: none; background: none; padding: 0 1px; cursor: pointer;
  font-size: 18px; color: #d6d6d6; line-height: 1;
}
.meta-cell-editor__rating-star--filled { color: #f5a623; }
.meta-cell-editor__rating-star:hover { color: #f5a623; }
.meta-cell-editor__rating-clear {
  margin-left: 6px; padding: 1px 6px; border: 1px solid #ddd; border-radius: 3px;
  background: #fff; cursor: pointer; font-size: 11px; color: #666;
}
</style>
