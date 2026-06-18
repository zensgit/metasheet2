<template>
  <section class="meta-cond-rule" data-testid="conditional-rule-builder">
    <h4 class="meta-cond-rule__title">{{ p('condRule.title') }}</h4>
    <p class="meta-cond-rule__desc">{{ p('condRule.desc') }}</p>
    <p v-if="!flagEnabled" class="meta-cond-rule__hint" data-testid="cond-rule-flag-hint">{{ p('condRule.disabledHint') }}</p>

    <ul v-if="rules.length" class="meta-cond-rule__list">
      <li
        v-for="(rule, idx) in rules"
        :key="rule.id"
        class="meta-cond-rule__row"
        :class="{ 'meta-cond-rule__row--unknown': !fieldName(rule.fieldId) }"
        :data-testid="`cond-rule-row-${idx}`"
      >
        <span class="meta-cond-rule__field">
          {{ fieldName(rule.fieldId) ?? rule.fieldId }}
          <em v-if="!fieldName(rule.fieldId)" class="meta-cond-rule__unknown">{{ p('condRule.unknownField') }}</em>
        </span>
        <span class="meta-cond-rule__op">{{ opLabel(rule.operator) }}</span>
        <span v-if="!takesNoValue(rule.operator)" class="meta-cond-rule__val">{{ displayValue(rule.value) }}</span>
        <span class="meta-cond-rule__deny">→ {{ p('condRule.deny') }}</span>
        <button type="button" class="meta-cond-rule__remove" :data-testid="`cond-rule-remove-${idx}`" @click="removeRule(idx)">
          {{ p('condRule.delete') }}
        </button>
      </li>
    </ul>
    <p v-else class="meta-cond-rule__empty">{{ p('condRule.empty') }}</p>

    <div class="meta-cond-rule__add">
      <select v-model="draftFieldId" class="meta-cond-rule__select" data-testid="cond-rule-field" :aria-label="p('condRule.field')">
        <option value="">{{ p('condRule.field') }}</option>
        <option v-for="f in fieldsWithRules" :key="f.id" :value="f.id">{{ f.name }}</option>
      </select>
      <select
        v-model="draftOperator"
        class="meta-cond-rule__select"
        data-testid="cond-rule-operator"
        :aria-label="p('condRule.operator')"
        :disabled="!draftFieldId"
      >
        <option v-for="op in draftOperators" :key="op" :value="op">{{ opLabel(op) }}</option>
      </select>
      <input
        v-if="draftNeedsValue"
        v-model="draftValue"
        class="meta-cond-rule__input"
        data-testid="cond-rule-value"
        :placeholder="p('condRule.value')"
        :aria-label="p('condRule.value')"
      />
      <button type="button" class="meta-cond-rule__add-btn" data-testid="cond-rule-add" :disabled="!canAdd" @click="addRule">
        {{ p('condRule.add') }}
      </button>
    </div>

    <div class="meta-cond-rule__actions">
      <button type="button" class="meta-cond-rule__save" data-testid="cond-rule-save" :disabled="saving" @click="save">
        {{ p('condRule.save') }}
      </button>
      <span v-if="savedFlash" class="meta-cond-rule__saved" data-testid="cond-rule-saved">{{ p('condRule.saved') }}</span>
      <span v-if="error" class="meta-cond-rule__error" role="alert" data-testid="cond-rule-error">{{ error }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MultitableApiClient } from '../api/client'
import type { MetaField } from '../types'
import { permissionLabel, type MetaPermissionLabelKey } from '../utils/meta-permission-labels'
import {
  coerceRuleValue,
  fieldTypeSupportsRule,
  operatorTakesNoValue,
  operatorsForFieldType,
  type ConditionalRuleDTO,
  type RuleOperator,
} from '../utils/conditional-rule-ops'

const props = withDefaults(
  defineProps<{
    sheetId: string
    client: MultitableApiClient
    fields?: MetaField[]
    flagEnabled?: boolean
  }>(),
  { fields: () => [], flagEnabled: false },
)

const { isZh } = useLocale()
function p(key: MetaPermissionLabelKey): string {
  return permissionLabel(key, isZh.value)
}

const rules = ref<ConditionalRuleDTO[]>([])
const saving = ref(false)
const savedFlash = ref(false)
const error = ref('')
let idSeq = 0

const draftFieldId = ref('')
const draftOperator = ref<RuleOperator | ''>('')
const draftValue = ref('')

const fieldsWithRules = computed(() => props.fields.filter((f) => fieldTypeSupportsRule(f.type)))
const draftField = computed(() => props.fields.find((f) => f.id === draftFieldId.value))
const draftOperators = computed<RuleOperator[]>(() => operatorsForFieldType(draftField.value?.type))
const draftNeedsValue = computed(() => !!draftOperator.value && !operatorTakesNoValue(draftOperator.value))
const canAdd = computed(
  () => !!draftFieldId.value && !!draftOperator.value && (!draftNeedsValue.value || draftValue.value.trim() !== ''),
)

function fieldName(fieldId: string): string | null {
  return props.fields.find((f) => f.id === fieldId)?.name ?? null
}
function opLabel(op: RuleOperator): string {
  return p(`condRule.op.${op}` as MetaPermissionLabelKey)
}
function takesNoValue(op: RuleOperator): boolean {
  return operatorTakesNoValue(op)
}
function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  return value == null ? '' : String(value)
}

// keep draftOperator valid for the chosen field
watch(draftFieldId, () => {
  const ops = draftOperators.value
  draftOperator.value = ops.length ? ops[0] : ''
  draftValue.value = ''
})

async function load(): Promise<void> {
  error.value = ''
  try {
    const res = await props.client.getConditionalRules(props.sheetId)
    rules.value = res.rules
  } catch {
    error.value = p('condRule.error.load')
  }
}

function addRule(): void {
  if (!canAdd.value || !draftOperator.value) return
  rules.value.push({
    id: `cr_${Date.now()}_${idSeq++}`,
    fieldId: draftFieldId.value,
    operator: draftOperator.value,
    value: coerceRuleValue(draftField.value?.type, draftOperator.value, draftValue.value),
    effect: 'deny_read',
  })
  draftFieldId.value = ''
  draftOperator.value = ''
  draftValue.value = ''
}

function removeRule(idx: number): void {
  rules.value.splice(idx, 1)
}

async function save(): Promise<void> {
  saving.value = true
  error.value = ''
  savedFlash.value = false
  try {
    // send the full list (incl preserved unknown-field rules) so nothing is silently dropped
    rules.value = await props.client.setConditionalRules(props.sheetId, [...rules.value])
    savedFlash.value = true
  } catch {
    error.value = p('condRule.error.save')
  } finally {
    saving.value = false
  }
}

onMounted(load)
watch(() => props.sheetId, load)
</script>

<style scoped>
.meta-cond-rule { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--meta-border, #e5e7eb); }
.meta-cond-rule__title { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.meta-cond-rule__desc { margin: 0 0 8px; font-size: 12px; color: var(--meta-text-muted, #6b7280); }
.meta-cond-rule__hint { margin: 0 0 8px; font-size: 12px; color: var(--meta-warning, #b45309); }
.meta-cond-rule__list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.meta-cond-rule__row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 4px 8px; background: var(--meta-surface-2, #f9fafb); border-radius: 6px; }
.meta-cond-rule__row--unknown { opacity: 0.7; }
.meta-cond-rule__field { font-weight: 600; }
.meta-cond-rule__unknown { font-weight: 400; font-style: italic; color: var(--meta-text-muted, #9ca3af); margin-left: 4px; }
.meta-cond-rule__op { color: var(--meta-text-muted, #6b7280); }
.meta-cond-rule__deny { color: var(--meta-danger, #dc2626); margin-left: auto; }
.meta-cond-rule__remove { border: none; background: none; color: var(--meta-danger, #dc2626); cursor: pointer; font-size: 12px; }
.meta-cond-rule__add { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.meta-cond-rule__select, .meta-cond-rule__input { font-size: 12px; padding: 4px 6px; border: 1px solid var(--meta-border, #d1d5db); border-radius: 6px; }
.meta-cond-rule__add-btn, .meta-cond-rule__save { font-size: 12px; padding: 4px 10px; border: 1px solid var(--meta-border, #d1d5db); border-radius: 6px; cursor: pointer; background: var(--meta-surface, #fff); }
.meta-cond-rule__add-btn:disabled, .meta-cond-rule__save:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-cond-rule__actions { display: flex; align-items: center; gap: 12px; }
.meta-cond-rule__saved { font-size: 12px; color: var(--meta-success, #059669); }
.meta-cond-rule__error { font-size: 12px; color: var(--meta-danger, #dc2626); }
</style>
