<!--
  A single filter CONDITION row (field · operator · value · remove). Extracted verbatim from MetaToolbar's
  inline filter rows so it can be reused by the recursive nested-group editor (PR-2b-2) without duplicating
  the per-operator value-mode logic. The rendered DOM (classes / aria-labels / data-* hooks) is identical to
  the old inline markup, so the existing meta-toolbar-filter-builder specs pass unchanged. Emits the whole
  updated rule (not an index) — the parent maps it to its position (flat index today, tree path in PR-2b-2).
-->
<template>
  <div class="meta-toolbar__filter-rule">
    <select :value="rule.fieldId" :aria-label="l('toolbar.filterField')" @change="onFieldChange(($event.target as HTMLSelectElement).value)">
      <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
    </select>
    <span class="meta-toolbar__field-type">{{ getFilterFieldTypeLabel(rule.fieldId) }}</span>
    <select :value="rule.operator" :aria-label="l('toolbar.filterOperator')" @change="onOperatorChange(($event.target as HTMLSelectElement).value)">
      <option v-for="op in getOperatorsForField(rule.fieldId)" :key="op.value" :value="op.value">{{ op.label }}</option>
    </select>
    <span v-if="isNoValueOp(rule.operator)" class="meta-toolbar__filter-empty-hint">{{ l('toolbar.noValueNeeded') }}</span>
    <select
      v-else-if="isArrayOp(rule.operator) && isSelectLikeField(rule.fieldId)"
      class="meta-toolbar__filter-value"
      multiple
      :aria-label="l('toolbar.filterValue')"
      data-filter-multi-value="true"
      @change="onMultiValueChange($event)"
    >
      <option
        v-for="option in getSelectOptions(rule.fieldId)"
        :key="option.value"
        :value="option.value"
        :selected="Array.isArray(rule.value) && rule.value.includes(option.value)"
      >{{ option.label }}</option>
    </select>
    <template v-else-if="isBetweenOp(rule.operator)">
      <input
        class="meta-toolbar__filter-value"
        :type="getInputType(rule.fieldId)"
        :value="Array.isArray(rule.value) ? (rule.value[0] ?? '') : ''"
        :aria-label="l('toolbar.filterValue')"
        data-filter-between-min="true"
        @change="onBetweenChange(0, ($event.target as HTMLInputElement).value)"
      />
      <span class="meta-toolbar__filter-between-sep">–</span>
      <input
        class="meta-toolbar__filter-value"
        :type="getInputType(rule.fieldId)"
        :value="Array.isArray(rule.value) ? (rule.value[1] ?? '') : ''"
        :aria-label="l('toolbar.filterValue')"
        data-filter-between-max="true"
        @change="onBetweenChange(1, ($event.target as HTMLInputElement).value)"
      />
    </template>
    <input
      v-else-if="isNDaysOp(rule.operator)"
      class="meta-toolbar__filter-value"
      type="number"
      min="1"
      step="1"
      :value="rule.value ?? ''"
      :aria-label="l('toolbar.filterValue')"
      data-filter-ndays="true"
      @change="onNDaysChange(($event.target as HTMLInputElement).value)"
    />
    <select
      v-else-if="isSelectLikeField(rule.fieldId)"
      class="meta-toolbar__filter-value"
      :value="String(rule.value ?? '')"
      :aria-label="l('toolbar.filterValue')"
      @change="onValueChange(($event.target as HTMLSelectElement).value)"
    >
      <option value="" disabled>{{ getSelectOptions(rule.fieldId).length ? l('toolbar.chooseOption') : l('toolbar.noOptions') }}</option>
      <option v-for="option in getSelectOptions(rule.fieldId)" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
    <select
      v-else-if="getFieldType(rule.fieldId) === 'boolean'"
      class="meta-toolbar__filter-value"
      :value="String(rule.value ?? 'true')"
      :aria-label="l('toolbar.filterValue')"
      @change="onValueChange(($event.target as HTMLSelectElement).value)"
    >
      <option value="true">{{ l('toolbar.checkedTrue') }}</option>
      <option value="false">{{ l('toolbar.uncheckedFalse') }}</option>
    </select>
    <input
      v-else
      class="meta-toolbar__filter-value"
      :type="getInputType(rule.fieldId)"
      :placeholder="getValuePlaceholder(rule.fieldId)"
      :value="rule.value ?? ''"
      :aria-label="l('toolbar.filterValue')"
      @change="onValueChange(($event.target as HTMLInputElement).value)"
    />
    <button class="meta-toolbar__remove" @click="emit('remove')">&times;</button>
  </div>
</template>

<script setup lang="ts">
import type { MetaField } from '../types'
import type { FilterRule } from '../composables/useMultitableGrid'
import { FILTER_OPERATORS_BY_TYPE, effectiveFilterTypeKey } from '../composables/useMultitableGrid'
import { useLocale } from '../../composables/useLocale'
import { metaCoreLabel, fieldTypeLabel, filterValuePlaceholder, type MetaCoreLabelKey } from '../utils/meta-core-labels'

const props = defineProps<{ rule: FilterRule; fields: MetaField[] }>()
const emit = defineEmits<{ (e: 'update', rule: FilterRule): void; (e: 'remove'): void }>()

const { isZh } = useLocale()
const l = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)

// --- value-mode predicates (mirror the backend operator families) ---
const UNARY = new Set(['isEmpty', 'isNotEmpty'])
const isUnaryOp = (op: string) => UNARY.has(op)
const ARRAY_OPS = new Set(['isAnyOf', 'isNoneOf'])
const isArrayOp = (op: string) => ARRAY_OPS.has(op)
const isBetweenOp = (op: string) => op === 'between'
const RELATIVE_DATE_NOVALUE_OPS = new Set(['isToday', 'isYesterday', 'isTomorrow', 'isThisWeek', 'isThisMonth', 'isOverdue'])
const RELATIVE_DATE_NDAYS_OPS = new Set(['isLastNDays', 'isNextNDays'])
const isRelativeNoValueOp = (op: string) => RELATIVE_DATE_NOVALUE_OPS.has(op)
const isNDaysOp = (op: string) => RELATIVE_DATE_NDAYS_OPS.has(op)
const isNoValueOp = (op: string) => isUnaryOp(op) || isRelativeNoValueOp(op)
const DEFAULT_RELATIVE_DAYS = 7

// --- field helpers (computed from the fields prop) ---
const getField = (id: string) => props.fields.find((f) => f.id === id)
const getFieldType = (id: string) => getField(id)?.type ?? 'string'
const isSelectLikeField = (id: string) => {
  const type = String(getFieldType(id))
  return type === 'select' || type === 'multiSelect'
}
const getOperatorsForField = (id: string) => {
  const type = String(getFieldType(id))
  if (type === 'multiSelect') return FILTER_OPERATORS_BY_TYPE.multiSelect ?? FILTER_OPERATORS_BY_TYPE.select
  return FILTER_OPERATORS_BY_TYPE[effectiveFilterTypeKey(getField(id))] ?? FILTER_OPERATORS_BY_TYPE.string
}
const getInputType = (id: string) => {
  const t = getFieldType(id)
  if (t === 'number') return 'number'
  if (t === 'date') return 'date'
  return 'text'
}
const getFilterFieldTypeLabel = (id: string) => fieldTypeLabel(String(getFieldType(id)), isZh.value)
const getValuePlaceholder = (id: string) => filterValuePlaceholder(String(getFieldType(id)), isZh.value)
function getSelectOptions(id: string): Array<{ value: string; label: string }> {
  const field = getField(id)
  const rawOptions = field?.options ?? (Array.isArray(field?.property?.options) ? field.property.options : [])
  return rawOptions
    .map((option) => {
      if (typeof option === 'string') return { value: option, label: option }
      if (option && typeof option === 'object' && 'value' in option) {
        const value = String((option as { value?: unknown }).value ?? '')
        return value ? { value, label: value } : null
      }
      return null
    })
    .filter((option): option is { value: string; label: string } => option !== null)
}
function getDefaultFilterValue(fieldId: string): unknown {
  const type = getFieldType(fieldId)
  if (String(type) === 'select' || String(type) === 'multiSelect') return getSelectOptions(fieldId)[0]?.value ?? ''
  if (type === 'boolean') return true
  return ''
}

// --- handlers (emit the whole updated rule) ---
function onFieldChange(fieldId: string) {
  const ops = getOperatorsForField(fieldId)
  emit('update', { ...props.rule, fieldId, operator: ops[0]?.value ?? 'is', value: getDefaultFilterValue(fieldId) })
}
function onOperatorChange(operator: string) {
  const r: FilterRule = { ...props.rule, operator }
  if (isNoValueOp(operator)) r.value = undefined
  else if (isArrayOp(operator) || isBetweenOp(operator)) r.value = Array.isArray(r.value) ? r.value : []
  else if (isNDaysOp(operator)) r.value = (typeof r.value === 'number' && Number.isFinite(r.value) && r.value >= 1) ? r.value : DEFAULT_RELATIVE_DAYS
  else if (r.value === undefined || Array.isArray(r.value)) r.value = getDefaultFilterValue(r.fieldId)
  emit('update', r)
}
function onMultiValueChange(event: Event) {
  const sel = event.target as HTMLSelectElement
  emit('update', { ...props.rule, value: Array.from(sel.selectedOptions).map((o) => o.value) })
}
function onBetweenChange(slot: 0 | 1, value: string) {
  const cur = Array.isArray(props.rule.value) ? [...props.rule.value] : []
  cur[slot] = value
  emit('update', { ...props.rule, value: [cur[0], cur[1]] })
}
function onNDaysChange(value: string) {
  emit('update', { ...props.rule, value: value === '' ? '' : Number(value) })
}
function onValueChange(value: string) {
  const ft = getFieldType(props.rule.fieldId)
  let nextValue: unknown = value
  if (ft === 'number' && value !== '') nextValue = Number(value)
  if (ft === 'boolean') nextValue = value === 'true'
  emit('update', { ...props.rule, value: nextValue })
}
</script>

<style scoped>
.meta-toolbar__filter-rule { display: flex; gap: 4px; margin-bottom: 4px; align-items: center; }
.meta-toolbar__filter-rule select { padding: 2px 6px; font-size: 12px; border: 1px solid #ddd; border-radius: 3px; }
.meta-toolbar__filter-value { flex: 1; min-width: 80px; padding: 2px 6px; font-size: 12px; border: 1px solid #ddd; border-radius: 3px; }
.meta-toolbar__filter-empty-hint { flex: 1; min-width: 80px; color: #999; font-size: 12px; }
.meta-toolbar__field-type { font-size: 10px; color: #aaa; margin-left: auto; }
.meta-toolbar__remove { border: none; background: none; color: #999; cursor: pointer; font-size: 16px; }
.meta-toolbar__remove:hover { color: #f56c6c; }
</style>
