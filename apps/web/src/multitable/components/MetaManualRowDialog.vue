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

          <!-- ADR §12.2 「新增时选父组件」: only when /context names the pair for this actor (`parentFieldIds`). -->
          <fieldset v-if="parentFieldIds" class="meta-manual-row__parent" data-testid="manual-row-dialog-parent">
            <legend class="meta-manual-row__parent-legend">{{ l('parent.legend') }}</legend>
            <div class="meta-manual-row__parent-modes" role="radiogroup" :aria-label="l('parent.legend')">
              <label v-for="mode in parentModes" :key="mode.value" class="meta-manual-row__parent-mode">
                <input
                  v-model="parentMode"
                  type="radio"
                  :name="parentRadioName"
                  :value="mode.value"
                  :data-manual-parent-mode="mode.value"
                  :disabled="submitting"
                />
                {{ l(mode.label) }}
              </label>
            </div>
            <p v-if="parentMode === 'none'" class="meta-manual-row__hint">{{ l('parent.noneHint') }}</p>
            <MetaManualRowParentPicker
              v-else-if="parentMode === 'pick' && searchParentOptions"
              v-model="parentPicked"
              :search="searchParentOptions"
              :own-code="ownCode"
              :disabled="submitting"
              :debounce-ms="parentSearchDebounceMs"
            />
            <template v-else-if="parentMode === 'new'">
              <label class="meta-manual-row__row">
                <span class="meta-manual-row__label">{{ l('parent.code') }}<span class="meta-manual-row__required" aria-hidden="true"> *</span></span>
                <input v-model="parentNewCode" class="meta-manual-row__input" type="text" aria-required="true" data-testid="manual-parent-new-code" :disabled="submitting" />
              </label>
              <label class="meta-manual-row__row">
                <span class="meta-manual-row__label">{{ l('parent.name') }}<span class="meta-manual-row__required" aria-hidden="true"> *</span></span>
                <input v-model="parentNewName" class="meta-manual-row__input" type="text" aria-required="true" data-testid="manual-parent-new-name" :disabled="submitting" />
              </label>
              <p class="meta-manual-row__hint">{{ l('parent.newHint') }}</p>
            </template>
            <span v-if="parentError" class="meta-manual-row__field-error" role="alert" data-testid="manual-row-dialog-parent-error">{{ parentError }}</span>
          </fieldset>

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
// ADR §12.2 (slice P2): with `parentFieldIds` the dialog also offers 「父组件」 — 不挂父组件 (default; nothing is sent, as
// before), 选已有的 (a candidate saved exactly as returned) or 新建父组件 (both typed values required, trimmed). The pair is
// always sent with both keys (rule P3). A name without a code and the row as its own parent are refused here before
// anything is sent; the server re-checks both and its message is shown as is.
import { computed, reactive, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { MtButton, MtIconButton } from '../ui'
import type { MetaField, MetaManualRowParentFieldIds } from '../types'
import { manualRowLabel, manualRowRequiredMessage, type ManualRowLabelKey } from '../utils/manual-row-labels'
import {
  isBlankManualRowValue,
  manualRowParentPayload,
  manualRowParentProblem,
  type ManualRowDialogPlan,
  type ManualRowParentChoice,
  type ManualRowParentProblem,
} from '../utils/manual-rows'
import MetaManualRowParentPicker from './MetaManualRowParentPicker.vue'

const props = withDefaults(defineProps<{
  visible: boolean
  plan: ManualRowDialogPlan
  submitting?: boolean
  error?: string | null
  /** The server's per-field messages (422 fieldErrors), keyed by field id. */
  fieldErrors?: Record<string, string> | null
  /** ADR §12.6: /context's pair — absent ⇒ no 「父组件」 fieldset. */
  parentFieldIds?: MetaManualRowParentFieldIds | null
  /** The 图号 column's id, so the row's own 图号 is neither offered nor accepted as its parent. */
  ownCodeFieldId?: string | null
  /** GET …/manual-rows/parent-options for 「选已有的」. */
  searchParentOptions?: ((q: string) => Promise<unknown>) | null
  parentSearchDebounceMs?: number
}>(), {
  submitting: false,
  error: null,
  fieldErrors: null,
  parentFieldIds: null,
  ownCodeFieldId: null,
  searchParentOptions: null,
  parentSearchDebounceMs: 250,
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

type ParentMode = 'none' | 'pick' | 'new'
const parentMode = ref<ParentMode>('none')
const parentPicked = ref<{ code: string; name: string | null } | null>(null)
const parentNewCode = ref('')
const parentNewName = ref('')
const parentError = ref<string | null>(null)
const parentRadioName = `manual-row-parent-${Math.random().toString(36).slice(2)}`
const parentModes = computed<Array<{ value: ParentMode; label: ManualRowLabelKey }>>(() => [
  { value: 'none', label: 'parent.modeNone' },
  ...(props.searchParentOptions ? [{ value: 'pick' as const, label: 'parent.modePick' as const }] : []),
  { value: 'new', label: 'parent.modeNew' },
])
// The row's own 图号 as typed here (P5 compares it with the parent).
const ownCode = computed(() => (props.ownCodeFieldId ? draft[props.ownCodeFieldId] ?? null : null))

const PARENT_PROBLEM_KEYS: Readonly<Record<ManualRowParentProblem, ManualRowLabelKey>> = {
  pick_required: 'parent.problem.pickRequired',
  code_required: 'parent.problem.codeRequired',
  name_required: 'parent.problem.nameRequired',
  name_without_code: 'parent.problem.nameWithoutCode',
  self_parent: 'parent.problem.selfParent',
}

function parentChoice(): ManualRowParentChoice {
  if (parentMode.value === 'pick') return { mode: 'pick', option: parentPicked.value }
  if (parentMode.value === 'new') return { mode: 'new', code: parentNewCode.value, name: parentNewName.value }
  return { mode: 'none' }
}

watch(parentMode, () => { parentError.value = null })

function resetDraft(): void {
  for (const key of Object.keys(draft)) delete draft[key]
  for (const key of Object.keys(checks)) delete checks[key]
  for (const key of Object.keys(localErrors)) delete localErrors[key]
  parentMode.value = 'none'
  parentPicked.value = null
  parentNewCode.value = ''
  parentNewName.value = ''
  parentError.value = null
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
  parentError.value = null
  if (props.parentFieldIds) {
    const choice = parentChoice()
    const problem = manualRowParentProblem(choice, ownCode.value)
    if (problem) parentError.value = l(PARENT_PROBLEM_KEYS[problem])
    // 不挂父组件 sends nothing (exactly as before); a parent is sent as the pair, both keys.
    else if (choice.mode !== 'none') Object.assign(data, manualRowParentPayload(choice, props.parentFieldIds))
  }
  if (Object.keys(localErrors).length > 0 || parentError.value) return
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
.meta-manual-row__parent { border: 1px solid #dcdfe6; border-radius: 6px; margin: 4px 0 0; padding: 6px 12px 10px; display: flex; flex-direction: column; gap: 8px; }
.meta-manual-row__parent-legend { padding: 0 4px; font-size: 13px; font-weight: 600; color: #303133; }
.meta-manual-row__parent-modes { display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px; }
.meta-manual-row__parent-mode { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.meta-manual-row__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--ms-border-light, #ebedf0); }
</style>
