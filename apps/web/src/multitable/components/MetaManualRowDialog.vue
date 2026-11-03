<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-manual-row-overlay" @click.self="onCancel">
      <div class="meta-manual-row-modal" role="dialog" aria-modal="true" :aria-label="l('dialog.title')" data-testid="manual-row-dialog">
        <div class="meta-manual-row__header">
          <strong>{{ l('dialog.title') }}</strong>
          <MtIconButton class="meta-manual-row__close" :aria-label="l('dialog.cancel')" data-action="manual-row-dialog-close" @click="onCancel">&times;</MtIconButton>
        </div>

        <div class="meta-manual-row__body">
          <!-- 项目号 is stamped by the server from the project registration (ADR §3.2); the dialog only says so. -->
          <div class="meta-manual-row__row" data-testid="manual-row-dialog-project-no">
            <span class="meta-manual-row__label">{{ l('dialog.projectNo') }}</span>
            <span class="meta-manual-row__readonly">{{ l('dialog.projectNoAuto') }}</span>
          </div>

          <p v-if="hasRequiredField" class="meta-manual-row__hint">{{ l('dialog.requiredHint') }}</p>
          <p v-if="!plan.fields.length" class="meta-manual-row__hint meta-manual-row__hint--muted">{{ l('dialog.noFields') }}</p>

          <label
            v-for="entry in plan.fields"
            :key="entry.field.id"
            class="meta-manual-row__row"
            :data-manual-row-field="entry.field.id"
          >
            <span class="meta-manual-row__label">
              {{ entry.field.name }}<span v-if="entry.required" class="meta-manual-row__required" aria-hidden="true"> *</span>
            </span>
            <textarea
              v-if="entry.field.type === 'longText'"
              v-model="draft[entry.field.id]"
              class="meta-manual-row__input"
              rows="2"
              :aria-required="entry.required"
              :disabled="submitting"
            />
            <input
              v-else-if="isNumberType(entry.field.type)"
              v-model="draft[entry.field.id]"
              class="meta-manual-row__input"
              type="number"
              :aria-required="entry.required"
              :disabled="submitting"
            />
            <input
              v-else-if="entry.field.type === 'date'"
              v-model="draft[entry.field.id]"
              class="meta-manual-row__input"
              type="date"
              :aria-required="entry.required"
              :disabled="submitting"
            />
            <input
              v-else-if="entry.field.type === 'boolean'"
              v-model="checks[entry.field.id]"
              class="meta-manual-row__checkbox"
              type="checkbox"
              :disabled="submitting"
            />
            <select
              v-else-if="entry.field.type === 'select'"
              v-model="draft[entry.field.id]"
              class="meta-manual-row__input"
              :aria-required="entry.required"
              :disabled="submitting"
            >
              <option value=""></option>
              <option v-for="option in selectOptions(entry.field)" :key="option" :value="option">{{ option }}</option>
            </select>
            <input
              v-else
              v-model="draft[entry.field.id]"
              class="meta-manual-row__input"
              type="text"
              :aria-required="entry.required"
              :disabled="submitting"
            />
            <span
              v-if="fieldMessage(entry.field.id)"
              class="meta-manual-row__field-error"
              role="alert"
              :data-manual-row-field-error="entry.field.id"
            >{{ fieldMessage(entry.field.id) }}</span>
          </label>

          <div v-if="plan.blockedRequiredCount > 0" class="meta-manual-row__error" role="alert" data-testid="manual-row-dialog-blocked">
            {{ l('dialog.blockedRequired') }}
          </div>
          <div v-if="error" class="meta-manual-row__error" role="alert" data-testid="manual-row-dialog-error">{{ error }}</div>
        </div>

        <div class="meta-manual-row__actions">
          <MtButton data-action="manual-row-dialog-cancel" :disabled="submitting" @click="onCancel">{{ l('dialog.cancel') }}</MtButton>
          <MtButton
            variant="primary"
            data-action="manual-row-dialog-submit"
            :disabled="submitting || plan.blockedRequiredCount > 0 || !plan.fields.length"
            @click="onSubmit"
          >
            {{ submitting ? l('dialog.submitting') : l('dialog.submit') }}
          </MtButton>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
// 人工补充行 B3 (ADR adr-stock-prep-manual-rows-20261030 §8 B3.3): 「新增人工补充行」. The fields come from the
// workbench's plan (utils/manual-rows.ts resolveManualRowDialogPlan: the block's dialog / required ids ∩ the actor's
// field permissions); only 名称 and 总用量 are required on the template. 项目号 is never typed — the server stamps it,
// together with the row's own key and 有效 (ADR §3.2). This component only collects values; the workbench sends them to
// POST /sheets/:sheetId/manual-rows and owns the error / success handling.
import { computed, reactive, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { MtButton, MtIconButton } from '../ui'
import type { MetaField } from '../types'
import { manualRowLabel, manualRowRequiredMessage, type ManualRowLabelKey } from '../utils/manual-row-labels'
import { isBlankManualRowValue, type ManualRowDialogPlan } from '../utils/manual-rows'

const props = withDefaults(defineProps<{
  visible: boolean
  plan: ManualRowDialogPlan
  submitting?: boolean
  error?: string | null
  /** The server's per-field messages (422 fieldErrors), keyed by field id. */
  fieldErrors?: Record<string, string> | null
}>(), {
  submitting: false,
  error: null,
  fieldErrors: null,
})

const emit = defineEmits<{
  (e: 'submit', data: Record<string, unknown>): void
  (e: 'cancel'): void
}>()

const { isZh } = useLocale()
const l = (key: ManualRowLabelKey) => manualRowLabel(key, isZh.value)

const NUMBER_TYPES = new Set(['number', 'currency', 'percent', 'rating'])
const isNumberType = (type: string) => NUMBER_TYPES.has(type)

const draft = reactive<Record<string, string | number>>({})
const checks = reactive<Record<string, boolean>>({})
const localErrors = reactive<Record<string, string>>({})
const hasRequiredField = computed(() => props.plan.fields.some((entry) => entry.required))

function resetDraft(): void {
  for (const key of Object.keys(draft)) delete draft[key]
  for (const key of Object.keys(checks)) delete checks[key]
  for (const key of Object.keys(localErrors)) delete localErrors[key]
  for (const entry of props.plan.fields) {
    if (entry.field.type === 'boolean') checks[entry.field.id] = false
    else draft[entry.field.id] = ''
  }
}

watch(() => props.visible, (visible) => { if (visible) resetDraft() }, { immediate: true })

function selectOptions(field: MetaField): string[] {
  const own = Array.isArray(field.options) ? field.options : []
  const fromProperty = Array.isArray((field.property as { options?: unknown } | undefined)?.options)
    ? ((field.property as { options: unknown[] }).options)
    : []
  const values: string[] = []
  for (const option of [...own, ...fromProperty]) {
    const value = typeof option === 'string' ? option : (option as { value?: unknown } | null)?.value
    if (typeof value === 'string' && value !== '' && !values.includes(value)) values.push(value)
  }
  return values
}

function fieldMessage(fieldId: string): string | null {
  return localErrors[fieldId] ?? props.fieldErrors?.[fieldId] ?? null
}

/** The value a control holds, as the create sends it (null = not filled: the key is left out). */
function submittedValue(field: MetaField, raw: unknown): unknown {
  if (field.type === 'boolean') return raw === true ? true : null
  if (isNumberType(field.type)) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    if (typeof raw !== 'string' || raw.trim() === '') return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  if (typeof raw !== 'string') return null
  return isBlankManualRowValue(raw) ? null : raw
}

function onSubmit(): void {
  if (props.submitting || props.plan.blockedRequiredCount > 0) return
  for (const key of Object.keys(localErrors)) delete localErrors[key]
  const data: Record<string, unknown> = {}
  for (const entry of props.plan.fields) {
    const value = submittedValue(entry.field, entry.field.type === 'boolean' ? checks[entry.field.id] : draft[entry.field.id])
    if (value === null) {
      if (entry.required) localErrors[entry.field.id] = manualRowRequiredMessage(entry.field.name, isZh.value)
      continue
    }
    data[entry.field.id] = value
  }
  if (Object.keys(localErrors).length > 0) return
  emit('submit', data)
}

function onCancel(): void {
  if (props.submitting) return
  emit('cancel')
}
</script>

<style scoped>
.meta-manual-row-overlay { position: fixed; inset: 0; z-index: 110; background: rgba(0, 0, 0, .3); display: flex; align-items: center; justify-content: center; }
.meta-manual-row-modal { background: #fff; border-radius: 6px; width: min(480px, calc(100vw - 32px)); max-height: calc(100vh - 48px); box-shadow: 0 10px 40px rgba(0, 0, 0, .18); display: flex; flex-direction: column; }
.meta-manual-row__header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #ebedf0; }
.meta-manual-row__body { padding: 16px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.meta-manual-row__row { display: flex; flex-direction: column; gap: 4px; }
.meta-manual-row__label { font-size: 12px; color: #606266; }
.meta-manual-row__required { color: #f56c6c; }
.meta-manual-row__readonly { font-size: 13px; color: #909399; padding: 6px 0; }
.meta-manual-row__input { padding: 6px 8px; border: 1px solid #dcdfe6; border-radius: 4px; font-size: 14px; font-family: inherit; }
.meta-manual-row__checkbox { align-self: flex-start; }
.meta-manual-row__hint { color: #606266; font-size: 12px; margin: 0; }
.meta-manual-row__hint--muted { color: #909399; font-style: italic; }
.meta-manual-row__field-error { color: #f56c6c; font-size: 12px; }
.meta-manual-row__error { color: #f56c6c; background: #fef0f0; padding: 8px 10px; border-radius: 4px; font-size: 13px; }
.meta-manual-row__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--ms-border-light, #ebedf0); }
</style>
