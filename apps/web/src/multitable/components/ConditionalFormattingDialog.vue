<template>
  <div v-if="visible" class="cf-dlg__overlay" @click.self="close">
    <div class="cf-dlg" role="dialog" aria-label="Conditional formatting rules">
      <div class="cf-dlg__header">
        <h4 class="cf-dlg__title">Conditional formatting</h4>
        <span class="cf-dlg__count">{{ draftRules.length }} / {{ ruleLimit }}</span>
        <button class="cf-dlg__close" aria-label="Close" @click="close">&times;</button>
      </div>
      <div class="cf-dlg__body">
        <p v-if="!draftRules.length" class="cf-dlg__empty">
          No rules yet. Add a rule to color cells or rows based on field values.
        </p>
        <div v-else class="cf-dlg__rule-list">
          <div
            v-for="(rule, index) in draftRules"
            :key="rule.id"
            class="cf-dlg__rule"
            :class="{ 'cf-dlg__rule--disabled': !rule.enabled }"
          >
            <div class="cf-dlg__rule-row">
              <span class="cf-dlg__rule-index">{{ index + 1 }}.</span>
              <select v-model="rule.fieldId" class="cf-dlg__select" @change="onFieldChanged(rule)">
                <option v-for="field in selectableFields" :key="field.id" :value="field.id">{{ field.name }}</option>
              </select>
              <select v-model="rule.operator" class="cf-dlg__select" @change="onOperatorChanged(rule)">
                <option
                  v-for="op in operatorsForField(rule.fieldId)"
                  :key="op.value"
                  :value="op.value"
                >{{ op.label }}</option>
              </select>
              <template v-if="operatorRequiresValue(rule.operator)">
                <template v-if="rule.operator === 'between'">
                  <input
                    type="number"
                    class="cf-dlg__input cf-dlg__input--mini"
                    :value="getBetweenValue(rule, 0)"
                    @input="setBetweenValue(rule, 0, ($event.target as HTMLInputElement).value)"
                    placeholder="min"
                  />
                  <span class="cf-dlg__sep">–</span>
                  <input
                    type="number"
                    class="cf-dlg__input cf-dlg__input--mini"
                    :value="getBetweenValue(rule, 1)"
                    @input="setBetweenValue(rule, 1, ($event.target as HTMLInputElement).value)"
                    placeholder="max"
                  />
                </template>
                <template v-else-if="isSelectField(rule.fieldId)">
                  <select v-model="rule.value" class="cf-dlg__select cf-dlg__select--value">
                    <option value="">(pick)</option>
                    <option
                      v-for="opt in selectOptionsFor(rule.fieldId)"
                      :key="opt.value"
                      :value="opt.value"
                    >{{ opt.value }}</option>
                  </select>
                </template>
                <template v-else-if="isNumberOperator(rule.operator)">
                  <input
                    type="number"
                    class="cf-dlg__input"
                    :value="rule.value"
                    @input="rule.value = ($event.target as HTMLInputElement).valueAsNumber"
                  />
                </template>
                <template v-else>
                  <input
                    type="text"
                    class="cf-dlg__input"
                    :value="rule.value as string ?? ''"
                    @input="rule.value = ($event.target as HTMLInputElement).value"
                  />
                </template>
              </template>
              <span v-else class="cf-dlg__no-value">—</span>
            </div>
            <div class="cf-dlg__rule-row cf-dlg__rule-row--secondary">
              <span class="cf-dlg__label">Color</span>
              <div class="cf-dlg__palette">
                <button
                  v-for="preset in PALETTE"
                  :key="preset"
                  type="button"
                  class="cf-dlg__swatch"
                  :class="{ 'cf-dlg__swatch--active': rule.style.backgroundColor === preset }"
                  :style="{ backgroundColor: preset }"
                  :aria-label="`Pick color ${preset}`"
                  @click="rule.style.backgroundColor = preset"
                />
                <input
                  type="text"
                  class="cf-dlg__hex"
                  :value="rule.style.backgroundColor ?? ''"
                  @input="updateHex(rule, 'backgroundColor', ($event.target as HTMLInputElement).value)"
                  placeholder="#RRGGBB"
                  maxlength="7"
                />
              </div>
              <label class="cf-dlg__check-inline">
                <input type="checkbox" :checked="rule.style.applyToRow === true" @change="rule.style.applyToRow = ($event.target as HTMLInputElement).checked" />
                <span>Apply to whole row</span>
              </label>
              <label class="cf-dlg__check-inline">
                <input type="checkbox" :checked="rule.enabled" @change="rule.enabled = ($event.target as HTMLInputElement).checked" />
                <span>Enabled</span>
              </label>
            </div>
            <div class="cf-dlg__rule-row cf-dlg__rule-row--actions">
              <button
                type="button"
                class="cf-dlg__btn cf-dlg__btn--ghost"
                :disabled="index === 0"
                @click="moveRule(index, -1)"
              >&#x25B2; Up</button>
              <button
                type="button"
                class="cf-dlg__btn cf-dlg__btn--ghost"
                :disabled="index === draftRules.length - 1"
                @click="moveRule(index, 1)"
              >&#x25BC; Down</button>
              <button type="button" class="cf-dlg__btn cf-dlg__btn--danger" @click="removeRule(index)">Remove</button>
            </div>
          </div>
        </div>
        <button
          type="button"
          class="cf-dlg__btn cf-dlg__btn--primary"
          :disabled="draftRules.length >= ruleLimit || !selectableFields.length"
          @click="addRule"
        >+ Add rule</button>
        <p v-if="!selectableFields.length" class="cf-dlg__hint">Add fields to the sheet to create formatting rules.</p>
      </div>
      <div class="cf-dlg__footer">
        <button type="button" class="cf-dlg__btn" @click="close">Cancel</button>
        <button type="button" class="cf-dlg__btn cf-dlg__btn--primary" :disabled="!dirty" @click="save">Save rules</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type {
  ConditionalFormattingOperator,
  ConditionalFormattingRule,
  MetaField,
} from '../types'
import { CONDITIONAL_FORMATTING_RULE_LIMIT } from '../types'
import { extractRulesFromConfig, operatorRequiresValue } from '../utils/conditional-formatting'

const props = defineProps<{
  visible: boolean
  fields: MetaField[]
  /** Current view config; rules are read from `config.conditionalFormattingRules`. */
  viewConfig?: Record<string, unknown>
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'save', rules: ConditionalFormattingRule[]): void
  (e: 'update:dirty', dirty: boolean): void
}>()

const ruleLimit = CONDITIONAL_FORMATTING_RULE_LIMIT

const PALETTE = [
  '#fce4e4',
  '#fff4d6',
  '#e0f3d8',
  '#d6ebff',
  '#e2dafc',
  '#fde2f3',
  '#f5f5f5',
  '#1f2937',
] as const

const draftRules = ref<ConditionalFormattingRule[]>([])
const baseline = ref('[]')

function snapshot(rules: ConditionalFormattingRule[]): string {
  return JSON.stringify(rules)
}

function hydrate() {
  const initial = extractRulesFromConfig(props.viewConfig).map((rule, index) => ({
    ...rule,
    order: index,
    style: { ...rule.style },
  }))
  draftRules.value = reactive(initial) as ConditionalFormattingRule[]
  baseline.value = snapshot(draftRules.value)
}

watch(() => props.visible, (visible) => {
  if (visible) hydrate()
}, { immediate: true })

watch(() => props.viewConfig, () => {
  if (props.visible) hydrate()
})

const dirty = computed(() => props.visible && snapshot(draftRules.value) !== baseline.value)

watch(dirty, (value) => emit('update:dirty', value), { immediate: true })

const fieldsById = computed(() => {
  const map = new Map<string, MetaField>()
  for (const field of props.fields) map.set(field.id, field)
  return map
})

const selectableFields = computed(() => props.fields)

function isSelectField(fieldId: string): boolean {
  return fieldsById.value.get(fieldId)?.type === 'select'
}

function isDateField(fieldId: string): boolean {
  return fieldsById.value.get(fieldId)?.type === 'date'
}

function isNumberField(fieldId: string): boolean {
  return fieldsById.value.get(fieldId)?.type === 'number'
}

function isBooleanField(fieldId: string): boolean {
  return fieldsById.value.get(fieldId)?.type === 'boolean'
}

function isNumberOperator(op: ConditionalFormattingOperator): boolean {
  return op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte'
}

function operatorsForField(fieldId: string): Array<{ value: ConditionalFormattingOperator; label: string }> {
  const baseEmpty = [
    { value: 'is_empty' as const, label: 'is empty' },
    { value: 'is_not_empty' as const, label: 'is not empty' },
  ]
  if (isNumberField(fieldId)) {
    return [
      { value: 'gt', label: '>' },
      { value: 'gte', label: '>=' },
      { value: 'lt', label: '<' },
      { value: 'lte', label: '<=' },
      { value: 'eq', label: '=' },
      { value: 'neq', label: '!=' },
      { value: 'between', label: 'between' },
      ...baseEmpty,
    ]
  }
  if (isDateField(fieldId)) {
    return [
      { value: 'is_today', label: 'is today' },
      { value: 'is_overdue', label: 'is overdue' },
      { value: 'is_in_last_n_days', label: 'is in last N days' },
      { value: 'is_in_next_n_days', label: 'is in next N days' },
      ...baseEmpty,
    ]
  }
  if (isBooleanField(fieldId)) {
    return [
      { value: 'is_true', label: 'is checked' },
      { value: 'is_false', label: 'is unchecked' },
      ...baseEmpty,
    ]
  }
  if (isSelectField(fieldId)) {
    return [
      { value: 'eq', label: 'is' },
      { value: 'neq', label: 'is not' },
      { value: 'contains', label: 'contains' },
      ...baseEmpty,
    ]
  }
  return [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '!=' },
    { value: 'contains', label: 'contains' },
    { value: 'not_contains', label: 'does not contain' },
    ...baseEmpty,
  ]
}

function defaultOperatorFor(fieldId: string): ConditionalFormattingOperator {
  return operatorsForField(fieldId)[0]?.value ?? 'eq'
}

function defaultValueFor(operator: ConditionalFormattingOperator): unknown {
  if (operator === 'between') return [0, 0]
  if (operator === 'is_in_last_n_days' || operator === 'is_in_next_n_days') return 7
  if (!operatorRequiresValue(operator)) return undefined
  return ''
}

function selectOptionsFor(fieldId: string): Array<{ value: string }> {
  const field = fieldsById.value.get(fieldId)
  return field?.options ?? []
}

function onFieldChanged(rule: ConditionalFormattingRule) {
  rule.operator = defaultOperatorFor(rule.fieldId)
  rule.value = defaultValueFor(rule.operator)
}

function onOperatorChanged(rule: ConditionalFormattingRule) {
  rule.value = defaultValueFor(rule.operator)
}

function addRule() {
  const firstField = props.fields[0]
  if (!firstField) return
  const operator = defaultOperatorFor(firstField.id)
  draftRules.value.push({
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? `cfr_${crypto.randomUUID()}`
      : `cfr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    order: draftRules.value.length,
    fieldId: firstField.id,
    operator,
    value: defaultValueFor(operator),
    style: { backgroundColor: PALETTE[0] },
    enabled: true,
  } as ConditionalFormattingRule)
}

function removeRule(index: number) {
  draftRules.value.splice(index, 1)
  reorderInPlace()
}

function moveRule(index: number, direction: -1 | 1) {
  const target = index + direction
  if (target < 0 || target >= draftRules.value.length) return
  const tmp = draftRules.value[index]
  draftRules.value[index] = draftRules.value[target]
  draftRules.value[target] = tmp
  reorderInPlace()
}

function reorderInPlace() {
  draftRules.value.forEach((rule, idx) => { rule.order = idx })
}

function getBetweenValue(rule: ConditionalFormattingRule, i: 0 | 1): number | string {
  if (Array.isArray(rule.value) && rule.value.length === 2) {
    const v = rule.value[i]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' || typeof v === 'number') return v
  }
  return ''
}

function setBetweenValue(rule: ConditionalFormattingRule, i: 0 | 1, value: string) {
  const next = Array.isArray(rule.value) && rule.value.length === 2
    ? [...(rule.value as unknown[])]
    : [0, 0]
  const parsed = Number(value)
  next[i] = Number.isFinite(parsed) ? parsed : 0
  rule.value = next
}

function updateHex(rule: ConditionalFormattingRule, key: 'backgroundColor' | 'textColor', value: string) {
  rule.style[key] = value || undefined
}

function close() {
  if (dirty.value && !window.confirm('Discard unsaved formatting rules?')) return
  emit('close')
}

function save() {
  reorderInPlace()
  const cloned = draftRules.value.map((rule) => ({
    ...rule,
    style: { ...rule.style },
    value: Array.isArray(rule.value) ? [...(rule.value as unknown[])] : rule.value,
  }))
  emit('save', cloned as ConditionalFormattingRule[])
}
</script>

<style scoped>
.cf-dlg__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 110; display: flex; align-items: center; justify-content: center; }
.cf-dlg { width: 720px; max-height: 85vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.18); display: flex; flex-direction: column; }
.cf-dlg__header { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #eee; }
.cf-dlg__title { flex: 1; font-size: 15px; font-weight: 600; margin: 0; }
.cf-dlg__count { font-size: 12px; color: #666; }
.cf-dlg__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; padding: 0 4px; }
.cf-dlg__body { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
.cf-dlg__empty { font-size: 13px; color: #777; margin: 0; }
.cf-dlg__rule-list { display: flex; flex-direction: column; gap: 10px; }
.cf-dlg__rule { border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px; background: #fafafa; display: flex; flex-direction: column; gap: 6px; }
.cf-dlg__rule--disabled { opacity: 0.55; }
.cf-dlg__rule-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cf-dlg__rule-row--secondary { gap: 12px; }
.cf-dlg__rule-row--actions { justify-content: flex-end; }
.cf-dlg__rule-index { font-weight: 600; font-size: 12px; color: #666; min-width: 18px; }
.cf-dlg__select, .cf-dlg__input { padding: 4px 8px; border: 1px solid #d0d5dc; border-radius: 4px; font-size: 12px; background: #fff; }
.cf-dlg__select--value { min-width: 120px; }
.cf-dlg__input--mini { width: 80px; }
.cf-dlg__sep { color: #888; font-size: 12px; }
.cf-dlg__no-value { color: #aaa; font-size: 12px; }
.cf-dlg__label { font-size: 12px; color: #555; }
.cf-dlg__palette { display: flex; align-items: center; gap: 6px; }
.cf-dlg__swatch { width: 22px; height: 22px; border-radius: 4px; border: 1px solid #d0d5dc; cursor: pointer; padding: 0; }
.cf-dlg__swatch--active { box-shadow: 0 0 0 2px #1d4ed8; }
.cf-dlg__hex { width: 90px; padding: 3px 6px; border: 1px solid #d0d5dc; border-radius: 4px; font-size: 12px; }
.cf-dlg__check-inline { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #444; cursor: pointer; }
.cf-dlg__btn { padding: 5px 12px; border: 1px solid #d0d5dc; border-radius: 4px; background: #fff; cursor: pointer; font-size: 12px; color: #333; }
.cf-dlg__btn:hover:not(:disabled) { background: #f3f4f6; }
.cf-dlg__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.cf-dlg__btn--primary { background: #2563eb; border-color: #2563eb; color: #fff; }
.cf-dlg__btn--primary:hover:not(:disabled) { background: #1d4ed8; }
.cf-dlg__btn--danger { color: #b91c1c; border-color: #fecaca; }
.cf-dlg__btn--danger:hover:not(:disabled) { background: #fef2f2; }
.cf-dlg__btn--ghost { border-color: transparent; }
.cf-dlg__hint { font-size: 12px; color: #888; margin: 0; }
.cf-dlg__footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid #eee; }
</style>
