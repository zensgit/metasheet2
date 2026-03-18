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
          <label class="meta-form-view__label" :for="`field_${field.id}`">{{ field.name }}</label>
          <input
            v-if="field.type === 'string'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="text"
            :disabled="readOnly"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="formData[field.id] ?? ''"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value"
          />
          <input
            v-else-if="field.type === 'number'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="number"
            :disabled="readOnly"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="formData[field.id] ?? ''"
            @input="formData[field.id] = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)"
          />
          <label v-else-if="field.type === 'boolean'" class="meta-form-view__check">
            <input type="checkbox" :disabled="readOnly" :checked="!!formData[field.id]" @change="formData[field.id] = ($event.target as HTMLInputElement).checked" />
            {{ formData[field.id] ? 'Yes' : 'No' }}
          </label>
          <input
            v-else-if="field.type === 'date'"
            :id="`field_${field.id}`"
            class="meta-form-view__input"
            :class="{ 'meta-form-view__input--error': !!fieldErrors?.[field.id] || !!validationErrors[field.id] }"
            type="date"
            :disabled="readOnly"
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
            :disabled="readOnly"
            :aria-required="field.required ? 'true' : undefined"
            :aria-invalid="(!!fieldErrors?.[field.id] || !!validationErrors[field.id]) ? 'true' : undefined"
            :aria-describedby="(fieldErrors?.[field.id] || validationErrors[field.id]) ? `error_${field.id}` : undefined"
            :value="formData[field.id] ?? ''"
            @change="formData[field.id] = ($event.target as HTMLSelectElement).value"
          >
            <option value="">—</option>
            <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">{{ opt.value }}</option>
          </select>
          <button
            v-else-if="field.type === 'link'"
            type="button"
            class="meta-form-view__link-btn"
            :disabled="readOnly"
            @click="emit('open-link-picker', field)"
          >{{ linkButtonLabel(field.id) }}</button>
          <span v-else class="meta-form-view__readonly-val">{{ record?.data[field.id] ?? '—' }}</span>
          <div v-if="field.type === 'link' && linkPreview(field.id)" class="meta-form-view__link-summary">{{ linkPreview(field.id) }}</div>
          <div v-if="fieldErrors?.[field.id] || validationErrors[field.id]" :id="`error_${field.id}`" class="meta-form-view__field-error">{{ fieldErrors?.[field.id] || validationErrors[field.id] }}</div>
        </div>
        <div v-if="!readOnly" class="meta-form-view__actions">
          <button type="submit" class="meta-form-view__submit" :disabled="submitting">
            {{ submitting ? 'Saving...' : (record ? 'Save' : 'Create') }}
          </button>
          <button v-if="record" type="button" class="meta-form-view__reset" @click="resetForm">Reset</button>
        </div>
      </form>
    </template>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, watch } from 'vue'
import type { MetaField, MetaRecord, LinkedRecordSummary } from '../types'

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
  linkSummariesByField?: Record<string, LinkedRecordSummary[]> | null
}>()

const emit = defineEmits<{
  (e: 'submit', data: Record<string, unknown>): void
  (e: 'open-link-picker', field: MetaField): void
}>()

const formData = reactive<Record<string, unknown>>({})

const editableFields = computed(() => {
  const hidden = new Set(props.hiddenFieldIds ?? [])
  return props.fields.filter((f) => !hidden.has(f.id))
})

function syncFromRecord(r: MetaRecord | null | undefined) {
  Object.keys(formData).forEach((k) => delete formData[k])
  if (r) Object.assign(formData, { ...r.data })
}

watch(() => props.record, syncFromRecord, { immediate: true })

const validationErrors = ref<Record<string, string>>({})

function validate(): boolean {
  const errs: Record<string, string> = {}
  for (const f of editableFields.value) {
    const v = formData[f.id]
    if (f.required && (v === undefined || v === null || v === '')) {
      errs[f.id] = `${f.name} is required`
    }
  }
  validationErrors.value = errs
  return Object.keys(errs).length === 0
}

function onSubmit() {
  if (!validate()) return
  emit('submit', { ...formData })
}

function resetForm() {
  if (hasUnsavedChanges.value && !confirm('Discard unsaved changes?')) return
  syncFromRecord(props.record)
  validationErrors.value = {}
}

const hasUnsavedChanges = computed(() => {
  if (!props.record) return Object.keys(formData).some((k) => formData[k] !== undefined && formData[k] !== '' && formData[k] !== null)
  return Object.keys(formData).some((k) => formData[k] !== props.record!.data[k])
})

function linkButtonLabel(fieldId: string): string {
  const count = linkSummaryCount(fieldId)
  return count > 0 ? `Edit linked records (${count})` : 'Choose linked records...'
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
</script>

<style scoped>
.meta-form-view { padding: 16px 24px; overflow-y: auto; flex: 1; }
.meta-form-view__loading { text-align: center; padding: 32px; color: #999; }
.meta-form-view__readonly-banner { padding: 8px 12px; background: #fdf6ec; color: #e6a23c; border-radius: 4px; font-size: 12px; margin-bottom: 12px; }
.meta-form-view__success { padding: 8px 12px; background: #f0f9eb; color: #67c23a; border-radius: 4px; font-size: 12px; margin-bottom: 12px; }
.meta-form-view__error { padding: 8px 12px; background: #fef0f0; color: #f56c6c; border-radius: 4px; font-size: 12px; margin-bottom: 12px; }
.meta-form-view__form { max-width: 560px; }
.meta-form-view__field { margin-bottom: 16px; }
.meta-form-view__label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 4px; color: #333; }
.meta-form-view__input { width: 100%; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-form-view__input--error { border-color: #f56c6c; background: #fff7f7; }
.meta-form-view__input:disabled { background: #f5f7fa; color: #999; cursor: not-allowed; }
.meta-form-view__check { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.meta-form-view__link-btn { padding: 6px 12px; border: 1px solid #409eff; border-radius: 4px; background: #ecf5ff; color: #409eff; cursor: pointer; font-size: 13px; }
.meta-form-view__link-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-form-view__link-summary { margin-top: 6px; font-size: 12px; color: #606266; }
.meta-form-view__readonly-val { color: #999; font-size: 13px; }
.meta-form-view__field-error { margin-top: 6px; color: #f56c6c; font-size: 12px; }
.meta-form-view__actions { display: flex; gap: 8px; margin-top: 16px; }
.meta-form-view__submit { padding: 8px 24px; background: #409eff; color: #fff; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; }
.meta-form-view__submit:hover:not(:disabled) { background: #66b1ff; }
.meta-form-view__submit:disabled { opacity: 0.6; cursor: not-allowed; }
.meta-form-view__reset { padding: 8px 16px; border: 1px solid #ddd; border-radius: 4px; background: #fff; font-size: 13px; cursor: pointer; color: #666; }
.meta-form-view__reset:hover { background: #f5f7fa; }
</style>
