<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-bulk-edit-overlay" @click.self="onCancel">
      <div class="meta-bulk-edit-modal" role="dialog" :aria-label="title">
        <div class="meta-bulk-edit__header">
          <strong>{{ title }}</strong>
          <button class="meta-bulk-edit__close" aria-label="Close" @click="onCancel">&times;</button>
        </div>

        <div class="meta-bulk-edit__body">
          <p class="meta-bulk-edit__hint">{{ summary }}</p>

          <label class="meta-bulk-edit__row">
            <span class="meta-bulk-edit__label">Field</span>
            <select
              v-model="selectedFieldId"
              class="meta-bulk-edit__select"
              aria-label="Field to update"
              @change="onFieldChange"
            >
              <option value="">(choose a field)</option>
              <option v-for="field in eligibleFields" :key="field.id" :value="field.id">
                {{ field.name }}
              </option>
            </select>
          </label>
          <p v-if="!eligibleFields.length" class="meta-bulk-edit__hint meta-bulk-edit__hint--muted">
            No bulk-editable fields are available for the current selection.
          </p>

          <div v-if="mode === 'set' && selectedField" class="meta-bulk-edit__row">
            <span class="meta-bulk-edit__label">Value</span>
            <div class="meta-bulk-edit__value-wrap">
              <!--
                Intentionally NOT wiring @confirm to onApply: MetaCellEditor
                fires `confirm` on select/boolean `@change` (cells/MetaCellEditor.vue:113,124),
                which would silently submit the bulk patch the moment the
                user opens the select dropdown or toggles a checkbox. Bulk
                edit must require an explicit "Set value" click.
              -->
              <MetaCellEditor
                :field="selectedField"
                :model-value="value"
                @update:modelValue="value = $event"
                @cancel="onCancel"
              />
            </div>
          </div>
          <div v-else-if="mode === 'clear' && selectedField" class="meta-bulk-edit__row">
            <span class="meta-bulk-edit__label">Action</span>
            <span class="meta-bulk-edit__hint">
              Will clear <strong>{{ selectedField.name }}</strong> on {{ recordIds.length }} record(s).
            </span>
          </div>

          <div v-if="error" class="meta-bulk-edit__error" role="alert">{{ error }}</div>
          <div v-if="resultMessage" class="meta-bulk-edit__success" role="status">{{ resultMessage }}</div>
        </div>

        <div class="meta-bulk-edit__actions">
          <button class="meta-bulk-edit__btn" :disabled="busy" @click="onCancel">Cancel</button>
          <button
            class="meta-bulk-edit__btn meta-bulk-edit__btn--primary"
            :disabled="!canSubmit || busy"
            @click="onApply"
          >
            {{ submitLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MetaField } from '../types'
import { isFieldBulkEditable } from '../utils/field-permissions'
import MetaCellEditor from './cells/MetaCellEditor.vue'

const props = defineProps<{
  visible: boolean
  mode: 'set' | 'clear'
  fields: MetaField[]
  canEdit: boolean
  fieldPermissions?: Record<string, { readOnly?: boolean }>
  recordIds: string[]
  busy?: boolean
  error?: string | null
  resultMessage?: string | null
}>()

const emit = defineEmits<{
  (e: 'apply', payload: { mode: 'set' | 'clear'; fieldId: string; value: unknown; recordIds: string[] }): void
  (e: 'cancel'): void
}>()

const selectedFieldId = ref<string>('')
const value = ref<unknown>('')

const eligibleFields = computed(() =>
  props.fields.filter((field) =>
    isFieldBulkEditable({
      field,
      canEdit: props.canEdit,
      fieldPermission: props.fieldPermissions?.[field.id],
    }),
  ),
)

const selectedField = computed<MetaField | null>(
  () => eligibleFields.value.find((f) => f.id === selectedFieldId.value) ?? null,
)

const title = computed(() => (props.mode === 'clear' ? 'Clear field for selected records' : 'Set field for selected records'))
const summary = computed(() =>
  props.mode === 'clear'
    ? `Pick a field to clear on ${props.recordIds.length} selected record(s).`
    : `Pick a field and a value to set on ${props.recordIds.length} selected record(s).`,
)
const submitLabel = computed(() => (props.mode === 'clear' ? 'Clear' : 'Set value'))
const canSubmit = computed(() => Boolean(selectedField.value) && (props.mode === 'clear' || hasMeaningfulValue(value.value)))

watch(
  () => [props.visible, props.mode],
  ([visible]) => {
    if (visible) {
      selectedFieldId.value = ''
      value.value = ''
    }
  },
  { immediate: true },
)

function hasMeaningfulValue(input: unknown): boolean {
  if (input === null || input === undefined) return false
  if (typeof input === 'string') return input.length > 0
  if (Array.isArray(input)) return input.length > 0
  return true
}

function onFieldChange() {
  value.value = ''
}

function onApply() {
  if (!selectedField.value) return
  if (props.mode === 'set' && !hasMeaningfulValue(value.value)) return
  emit('apply', {
    mode: props.mode,
    fieldId: selectedField.value.id,
    value: props.mode === 'clear' ? null : value.value,
    recordIds: [...props.recordIds],
  })
}

function onCancel() {
  emit('cancel')
}
</script>

<style scoped>
.meta-bulk-edit-overlay { position: fixed; inset: 0; z-index: 110; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
.meta-bulk-edit-modal { background: #fff; border-radius: 6px; min-width: 420px; max-width: 540px; box-shadow: 0 10px 40px rgba(0,0,0,.18); display: flex; flex-direction: column; }
.meta-bulk-edit__header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #ebedf0; }
.meta-bulk-edit__close { background: transparent; border: none; font-size: 22px; line-height: 1; cursor: pointer; color: #909399; }
.meta-bulk-edit__close:hover { color: #303133; }
.meta-bulk-edit__body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.meta-bulk-edit__hint { color: #606266; font-size: 13px; margin: 0; }
.meta-bulk-edit__hint--muted { color: #909399; font-style: italic; }
.meta-bulk-edit__row { display: flex; flex-direction: column; gap: 4px; }
.meta-bulk-edit__label { font-size: 12px; color: #909399; }
.meta-bulk-edit__select { padding: 6px 8px; border: 1px solid #dcdfe6; border-radius: 4px; font-size: 14px; }
.meta-bulk-edit__value-wrap { border: 1px solid #dcdfe6; border-radius: 4px; padding: 4px; min-height: 36px; }
.meta-bulk-edit__error { color: #f56c6c; background: #fef0f0; padding: 8px 10px; border-radius: 4px; font-size: 13px; }
.meta-bulk-edit__success { color: #67c23a; background: #f0f9eb; padding: 8px 10px; border-radius: 4px; font-size: 13px; }
.meta-bulk-edit__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #ebedf0; }
.meta-bulk-edit__btn { background: #fff; border: 1px solid #dcdfe6; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 14px; }
.meta-bulk-edit__btn:hover:not(:disabled) { border-color: #c0c4cc; }
.meta-bulk-edit__btn:disabled { opacity: .55; cursor: not-allowed; }
.meta-bulk-edit__btn--primary { background: #409eff; color: #fff; border-color: #409eff; }
.meta-bulk-edit__btn--primary:hover:not(:disabled) { background: #66b1ff; border-color: #66b1ff; }
</style>
