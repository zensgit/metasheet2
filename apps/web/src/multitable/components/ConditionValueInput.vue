<template>
  <!--
    客户反馈 2026-09-24 #4b — the ONE value control of an automation condition row, shared by the rule-level
    condition rows and the condition_branch rows of MetaAutomationRuleEditor.vue (the branch rows used to be a
    bare text box whose values were saved as strings). What it emits is already in the saved shape of the
    field type (../utils/automation-condition-values.ts): number → number, boolean → boolean,
    date → 'YYYY-MM-DD', date-time → UTC ISO read in the business timezone (#6083), person / link → ONE id
    string for equals / not_equals (single-pick) and a string[] of ids for in / not_in (multi-pick). A legacy
    link-backed person (type link + refKind user) keeps the record picker (its values are people-sheet record
    ids) but reads 选择人员 and is multi-pick for in / not_in too. `in` / `not_in` on a text / number / date /
    date-time field keeps a comma-separated text box; the save path coerces each entry the same way.

    A draft that cannot be expressed in the field's shape (a half-typed number, an unparseable date-time) is
    emitted AS TYPED: the row then reads as incomplete and save is blocked with the row anchored, instead of
    silently keeping the previous value while the box shows something else.
  -->
  <div class="meta-condition-value" :data-condition-value-widget="kind">
    <ElInput
      v-if="kind === 'pending'"
      class="meta-condition-value__control"
      model-value=""
      disabled
      :placeholder="label('condition.selectFieldFirst')"
      data-condition-value="pending"
    />

    <ElSelect
      v-else-if="kind === 'boolean'"
      :model-value="booleanValue"
      class="meta-condition-value__control"
      :placeholder="label('condition.selectValue')"
      data-condition-value="boolean"
      @change="onBooleanChange"
    >
      <ElOption value="" data-value="" :label="label('condition.selectValue')" />
      <ElOption value="true" data-value="true" :label="label('condition.booleanTrue')" />
      <ElOption value="false" data-value="false" :label="label('condition.booleanFalse')" />
    </ElSelect>

    <ElSelect
      v-else-if="kind === 'booleanMultiSelect'"
      :model-value="booleanValues"
      class="meta-condition-value__control"
      :placeholder="label('condition.selectValue')"
      data-condition-value="boolean-multi-select"
      multiple
      @change="onBooleanValuesChange"
    >
      <ElOption value="true" data-value="true" :label="label('condition.booleanTrue')" />
      <ElOption value="false" data-value="false" :label="label('condition.booleanFalse')" />
    </ElSelect>

    <ElSelect
      v-else-if="kind === 'select'"
      :model-value="selectValue"
      class="meta-condition-value__control"
      :placeholder="label('condition.selectValue')"
      data-condition-value="select"
      @change="emitValue"
    >
      <ElOption value="" data-value="" :label="label('condition.selectValue')" />
      <ElOption v-for="option in fieldOptions" :key="option.value" :value="option.value" :data-value="option.value" :label="option.label ?? option.value" />
    </ElSelect>

    <ElSelect
      v-else-if="kind === 'multiSelect'"
      :model-value="listValues"
      class="meta-condition-value__control"
      :placeholder="label('condition.selectValue')"
      data-condition-value="multi-select"
      multiple
      @change="onListChange"
    >
      <ElOption v-for="option in fieldOptions" :key="option.value" :value="option.value" :data-value="option.value" :label="option.label ?? option.value" />
    </ElSelect>

    <ElInput
      v-else-if="kind === 'number'"
      :model-value="numberDraft"
      class="meta-condition-value__control"
      type="number"
      inputmode="decimal"
      :placeholder="placeholder"
      data-condition-value="number"
      @update:model-value="onNumberInput"
    />

    <!-- The hook lives on a wrapper: el-date-picker forwards unknown attrs to its (teleported) popper. -->
    <span v-else-if="kind === 'date'" class="meta-condition-value__control" data-condition-value="date">
      <ElConfigProvider :locale="elLocale">
        <ElDatePicker
          :model-value="dateValue"
          class="meta-condition-value__date"
          type="date"
          format="YYYY-MM-DD"
          value-format="YYYY-MM-DD"
          :placeholder="label('condition.pickDate')"
          @update:model-value="onDateChange"
        />
      </ElConfigProvider>
    </span>

    <template v-else-if="kind === 'dateTime'">
      <ElInput
        :model-value="dateTimeDraft"
        class="meta-condition-value__control"
        :class="{ 'meta-condition-value__control--invalid': dateTimeInvalid }"
        :placeholder="dateTimePlaceholder"
        :title="dateTimeZoneLabel || undefined"
        data-condition-value="date-time"
        :data-invalid="dateTimeInvalid ? 'true' : undefined"
        @update:model-value="onDateTimeInput"
        @blur="onDateTimeBlur"
      />
      <MetaDateTimePicker :model-value="modelValue" :timezone="dateTimeZone" @update:model-value="onDateTimePicked" />
      <span v-if="dateTimeZoneLabel" class="meta-condition-value__hint" data-condition-value-zone="">{{ dateTimeZoneLabel }}</span>
      <span v-if="dateTimeInvalid" class="meta-condition-value__hint meta-condition-value__hint--error" data-condition-value-invalid="">{{ dateTimeInvalidLabel }}</span>
    </template>

    <template v-else-if="kind === 'person' || kind === 'link'">
      <span
        v-for="id in idValues"
        :key="id"
        class="meta-condition-value__chip"
        :data-condition-value-id="id"
      >
        <span>{{ idDisplay(id) }}</span>
        <button type="button" class="meta-condition-value__chip-remove" :title="label('condition.removeValueTitle')" @click="removeId(id)">&times;</button>
      </span>
      <ElButton
        size="small"
        :data-condition-value="kind"
        :data-action="kind === 'person' ? 'pick-condition-person' : 'pick-condition-record'"
        @click="pickerOpen = true"
      >{{ picksPeople ? label('condition.pickPeople') : label('condition.pickRecords') }}</ElButton>
      <MetaPersonPicker
        v-if="kind === 'person'"
        :visible="pickerOpen"
        :field="pickerField"
        :sheet-id="sheetId ?? ''"
        :current-value="idValues"
        :current-summaries="currentSummaries"
        @close="pickerOpen = false"
        @confirm="onPersonConfirm"
      />
      <MetaLinkPicker
        v-else
        :visible="pickerOpen"
        :field="pickerField"
        :selection-mode="isArray ? 'multiple' : 'single'"
        :current-value="idValues"
        @close="pickerOpen = false"
        @confirm="onLinkConfirm"
      />
    </template>

    <ElInput
      v-else
      :model-value="textValue"
      class="meta-condition-value__control"
      :placeholder="placeholder"
      :data-condition-value="kind === 'textList' ? 'text-list' : 'text'"
      @update:model-value="emitValue"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElButton, ElConfigProvider, ElDatePicker, ElInput, ElOption, ElSelect } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import en from 'element-plus/es/locale/lang/en'
import { useLocale } from '../../composables/useLocale'
import type { ConditionOperator, LinkedRecordSummary, MetaField, MetaFieldType, PersonSummary } from '../types'
import {
  automationConditionValuePlaceholder,
  automationLabel,
  type AutomationLabelKey,
} from '../utils/meta-automation-labels'
import { metaCoreLabel } from '../utils/meta-core-labels'
import { dateTimeZoneHint, formatDateTimeInZone, parseDateTimeInput } from '../utils/business-timezone'
import {
  conditionDateTimeZone,
  conditionValueWidget,
  isArrayConditionOperator,
  isLegacyPersonLinkConditionField,
  parseBooleanConditionValue,
  parseConditionArrayValue,
  parseDateConditionValue,
  parseDateTimeConditionValue,
  parseIdListConditionValue,
  parseNumberConditionValue,
  parseSingleIdConditionValue,
  type ConditionFieldLike,
} from '../utils/automation-condition-values'
import MetaDateTimePicker from './cells/MetaDateTimePicker.vue'
import MetaPersonPicker from './MetaPersonPicker.vue'
import MetaLinkPicker from './MetaLinkPicker.vue'

type ConditionValueKind =
  | 'pending'
  | 'text'
  | 'textList'
  | 'number'
  | 'date'
  | 'dateTime'
  | 'boolean'
  | 'booleanMultiSelect'
  | 'select'
  | 'multiSelect'
  | 'person'
  | 'link'

const props = defineProps<{
  modelValue: unknown
  operator: ConditionOperator
  /** The row's field, or null/undefined when none is chosen (or the field no longer exists). */
  field?: ConditionFieldLike | null
  /** True while the row has no field chosen: the control is disabled and asks for a field first. */
  pending?: boolean
  /** Sheet of the rule — the person picker's directory is per sheet + field. */
  sheetId?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: unknown): void
}>()

const { isZh } = useLocale()
const elLocale = computed(() => (isZh.value ? zhCn : en))

function label(key: AutomationLabelKey): string {
  return automationLabel(key, isZh.value)
}

const isArray = computed(() => isArrayConditionOperator(props.operator))
const widget = computed(() => conditionValueWidget(props.field, props.operator))

const kind = computed<ConditionValueKind>(() => {
  if (props.pending) return 'pending'
  const current = widget.value
  // A list of numbers / days / instants / free text is typed comma-separated; the save path coerces each entry.
  if (isArray.value && (current === 'text' || current === 'number' || current === 'date' || current === 'dateTime')) {
    return 'textList'
  }
  return current
})

const placeholder = computed(() => automationConditionValuePlaceholder(widget.value, isArray.value, isZh.value))

function emitValue(value: unknown) {
  emit('update:modelValue', value)
}

// ---- text / text list ----
const textValue = computed(() => {
  const value = props.modelValue
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join(', ')
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
})

// ---- select / multi-select ----
const fieldOptions = computed(() => props.field?.options ?? [])
const selectValue = computed(() => (typeof props.modelValue === 'string' ? props.modelValue : ''))
const listValues = computed(() => parseConditionArrayValue(props.modelValue).map(String))
function onListChange(values: string[]) {
  emitValue([...values])
}

// ---- boolean (是 / 否 ⇄ true / false) ----
const booleanValue = computed(() => {
  const parsed = parseBooleanConditionValue(props.modelValue)
  return parsed === null ? '' : String(parsed)
})
const booleanValues = computed(() => parseConditionArrayValue(props.modelValue)
  .map(parseBooleanConditionValue)
  .filter((entry): entry is boolean => entry !== null)
  .map(String))
function onBooleanChange(value: string) {
  const parsed = parseBooleanConditionValue(value)
  emitValue(parsed === null ? '' : parsed)
}
function onBooleanValuesChange(values: string[]) {
  emitValue(values.map(parseBooleanConditionValue).filter((entry): entry is boolean => entry !== null))
}

// ---- number ----
// The box keeps its own text: re-deriving it from the emitted number on every keystroke would eat a trailing
// `.` / `-` while typing. It only follows `modelValue` when the two stop meaning the same number.
function numberText(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return typeof value === 'string' ? value : ''
}
const numberDraft = ref(numberText(props.modelValue))
watch(() => props.modelValue, (value) => {
  if (value === numberDraft.value) return // our own echo of an empty / unparseable draft
  const draftNumber = parseNumberConditionValue(numberDraft.value)
  if (draftNumber !== null && draftNumber === parseNumberConditionValue(value)) return
  numberDraft.value = numberText(value)
})
function onNumberInput(text: string) {
  numberDraft.value = text
  const trimmed = text.trim()
  if (!trimmed) {
    emitValue('')
    return
  }
  const parsed = parseNumberConditionValue(trimmed)
  emitValue(parsed === null ? text : parsed)
}

// The field's zone (field property → business timezone, #6083): date-time values are typed / shown in it,
// and a date value that names its own zone (`…T16:00:00.000Z`) is shown as its day in it.
const dateTimeZone = computed(() => conditionDateTimeZone(props.field))

// ---- date (floating calendar day, 'YYYY-MM-DD') ----
const dateValue = computed(() => parseDateConditionValue(props.modelValue, dateTimeZone.value) ?? '')
function onDateChange(value: unknown) {
  emitValue(typeof value === 'string' ? value : '')
}

// ---- date-time (business-timezone wall clock ⇄ UTC ISO; the #6083 helpers, not the browser's zone) ----
const dateTimeZoneLabel = computed(() => dateTimeZoneHint(dateTimeZone.value, isZh.value))
const dateTimePlaceholder = computed(() => metaCoreLabel('cell.dateTimePlaceholder', isZh.value))
const dateTimeInvalidLabel = computed(() => metaCoreLabel('cell.dateTimeInvalid', isZh.value))
function dateTimeText(value: unknown): string {
  if (parseDateTimeConditionValue(value, dateTimeZone.value) !== null) {
    return formatDateTimeInZone(value, dateTimeZone.value) ?? ''
  }
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : ''
}
/** Whether the box text and the stored value denote the same thing (so the box must not be re-derived). */
function draftMatchesValue(text: string, value: unknown): boolean {
  const parsed = parseDateTimeInput(text, dateTimeZone.value)
  if (!parsed.ok) return text === value // our own echo of an unparseable draft
  const typed = parsed.value === null ? null : Date.parse(parsed.value)
  const iso = parseDateTimeConditionValue(value, dateTimeZone.value)
  const stored = iso === null ? null : Date.parse(iso)
  return typed === stored
}
function dateTimeDraftUnparseable(text: string): boolean {
  return !parseDateTimeInput(text, dateTimeZone.value).ok
}
const dateTimeDraft = ref(dateTimeText(props.modelValue))
// A LOADED value that names no instant (e.g. a bare date typed into the old branch text box) is flagged at
// once: the row blocks save, so the box must say why without needing a focus / blur first.
const dateTimeTouched = ref(dateTimeDraftUnparseable(dateTimeDraft.value))
watch([() => props.modelValue, dateTimeZone], ([value]) => {
  if (draftMatchesValue(dateTimeDraft.value, value)) return
  dateTimeDraft.value = dateTimeText(value)
  dateTimeTouched.value = dateTimeDraftUnparseable(dateTimeDraft.value)
})
const dateTimeInvalid = computed(() => dateTimeTouched.value && dateTimeDraftUnparseable(dateTimeDraft.value))
function onDateTimeInput(text: string) {
  dateTimeDraft.value = text
  const parsed = parseDateTimeInput(text, dateTimeZone.value)
  if (parsed.ok) dateTimeTouched.value = false
  emitValue(parsed.ok ? (parsed.value ?? '') : text)
}
function onDateTimeBlur() {
  dateTimeTouched.value = true
  const parsed = parseDateTimeInput(dateTimeDraft.value, dateTimeZone.value)
  if (parsed.ok) dateTimeDraft.value = dateTimeText(parsed.value)
}
function onDateTimePicked(value: string) {
  dateTimeDraft.value = dateTimeText(value)
  dateTimeTouched.value = false
  emitValue(value)
}

// ---- person / link (ids picked with the existing person picker / record picker) ----
// `equals` / `not_equals` compare against ONE id (saved as a string, the shape the backend validates for a
// single-value person / link condition); `in` / `not_in` against a list (saved as string[]).
const pickerOpen = ref(false)
/** A native person, or a legacy link-backed person (record picker, but it picks people). */
const picksPeople = computed(() => kind.value === 'person' || isLegacyPersonLinkConditionField(props.field))
const summaries = ref<Record<string, string>>({})
const idValues = computed<string[]>(() => {
  if (isArray.value) return parseIdListConditionValue(props.modelValue) ?? []
  const id = parseSingleIdConditionValue(props.modelValue)
  return id === null ? [] : [id]
})
function emitIds(ids: readonly string[]) {
  emitValue(isArray.value ? [...ids] : (ids[0] ?? ''))
}
const currentSummaries = computed<PersonSummary[]>(() => idValues.value
  .filter((id) => summaries.value[id])
  .map((id) => ({ id, display: summaries.value[id] })))
// The picker's cap follows the OPERATOR, not the field: `in` / `not_in` pick a list, `equals` / `not_equals`
// pick exactly one — whatever the field's own single / multiple setting is. The person picker reads it from
// `limitSingleRecord`; the record picker also forces single-select for a legacy person (`refKind: 'user'`,
// kept here so its title reads 选择人员), so it gets the cap explicitly as `selectionMode` as well.
const pickerField = computed<MetaField | null>(() => {
  const field = props.field
  if (!field) return null
  const property: Record<string, unknown> = { ...(field.property ?? {}) }
  property.limitSingleRecord = !isArray.value
  return { id: field.id, name: field.name ?? '', type: field.type as MetaFieldType, property }
})
function idDisplay(id: string): string {
  return summaries.value[id] || id
}
function rememberSummaries(items: Array<PersonSummary | LinkedRecordSummary>) {
  const next = { ...summaries.value }
  for (const item of items) {
    if (item?.id && item.display) next[item.id] = item.display
  }
  summaries.value = next
}
function removeId(id: string) {
  emitIds(idValues.value.filter((entry) => entry !== id))
}
function onPersonConfirm(payload: { userIds: string[]; summaries: PersonSummary[] }) {
  rememberSummaries(payload.summaries)
  pickerOpen.value = false
  emitIds(payload.userIds)
}
function onLinkConfirm(payload: { recordIds: string[]; summaries: LinkedRecordSummary[] }) {
  rememberSummaries(payload.summaries)
  pickerOpen.value = false
  emitIds(payload.recordIds)
}
</script>

<style scoped>
.meta-condition-value {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-width: 80px;
}

.meta-condition-value__control {
  flex: 1;
  min-width: 80px;
}

.meta-condition-value__date {
  width: 100%;
}

.meta-condition-value__control--invalid :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}

.meta-condition-value__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
  font-size: 12px;
}

.meta-condition-value__chip-remove {
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}

.meta-condition-value__hint {
  font-size: 12px;
  color: var(--ms-text-3);
}

.meta-condition-value__hint--error {
  color: var(--el-color-danger-dark-2);
}
</style>
