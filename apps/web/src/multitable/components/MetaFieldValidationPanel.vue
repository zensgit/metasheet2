<template>
  <div class="meta-field-validation">
    <div class="meta-field-validation__header">
      <strong class="meta-field-validation__title">Validation Rules</strong>
    </div>

    <div class="meta-field-validation__body">
      <!-- Required toggle (all types) -->
      <div class="meta-field-validation__rule-row" data-rule-type="required">
        <label class="meta-field-validation__toggle">
          <input
            type="checkbox"
            :checked="hasRule('required')"
            data-rule-toggle="required"
            @change="onToggleRequired"
          />
          <span>Required</span>
        </label>
        <input
          v-if="hasRule('required')"
          class="meta-field-validation__input meta-field-validation__input--message"
          type="text"
          placeholder="Custom error message"
          :value="getRule('required')?.message ?? ''"
          data-rule-message="required"
          @input="onUpdateMessage('required', $event)"
        />
      </div>

      <!-- Text rules -->
      <template v-if="fieldType === 'text'">
        <div class="meta-field-validation__rule-row" data-rule-type="minLength">
          <label class="meta-field-validation__label">Min length</label>
          <div class="meta-field-validation__inline">
            <input
              class="meta-field-validation__input meta-field-validation__input--small"
              type="number"
              min="0"
              :value="getRuleValue('minLength') ?? ''"
              data-rule-value="minLength"
              @input="onSetNumericRule('minLength', $event)"
            />
            <button
              v-if="hasRule('minLength')"
              class="meta-field-validation__remove"
              type="button"
              data-rule-remove="minLength"
              @click="onRemoveRule('minLength')"
            >&times;</button>
          </div>
          <input
            v-if="hasRule('minLength')"
            class="meta-field-validation__input meta-field-validation__input--message"
            type="text"
            placeholder="Custom error message"
            :value="getRule('minLength')?.message ?? ''"
            data-rule-message="minLength"
            @input="onUpdateMessage('minLength', $event)"
          />
        </div>

        <div class="meta-field-validation__rule-row" data-rule-type="maxLength">
          <label class="meta-field-validation__label">Max length</label>
          <div class="meta-field-validation__inline">
            <input
              class="meta-field-validation__input meta-field-validation__input--small"
              type="number"
              min="0"
              :value="getRuleValue('maxLength') ?? ''"
              data-rule-value="maxLength"
              @input="onSetNumericRule('maxLength', $event)"
            />
            <button
              v-if="hasRule('maxLength')"
              class="meta-field-validation__remove"
              type="button"
              data-rule-remove="maxLength"
              @click="onRemoveRule('maxLength')"
            >&times;</button>
          </div>
          <input
            v-if="hasRule('maxLength')"
            class="meta-field-validation__input meta-field-validation__input--message"
            type="text"
            placeholder="Custom error message"
            :value="getRule('maxLength')?.message ?? ''"
            data-rule-message="maxLength"
            @input="onUpdateMessage('maxLength', $event)"
          />
        </div>

        <div class="meta-field-validation__rule-row" data-rule-type="pattern">
          <label class="meta-field-validation__label">Pattern</label>
          <div class="meta-field-validation__inline">
            <select
              class="meta-field-validation__select"
              :value="patternPreset"
              data-rule-pattern-preset="true"
              @change="onPatternPreset"
            >
              <option value="">Custom</option>
              <option value="email">Email</option>
              <option value="url">URL</option>
              <option value="phone">Phone</option>
            </select>
            <input
              class="meta-field-validation__input"
              type="text"
              placeholder="Regex pattern"
              :value="getRuleValue('pattern') ?? ''"
              data-rule-value="pattern"
              @input="onSetPatternRule($event)"
            />
            <button
              v-if="hasRule('pattern')"
              class="meta-field-validation__remove"
              type="button"
              data-rule-remove="pattern"
              @click="onRemoveRule('pattern')"
            >&times;</button>
          </div>
          <input
            v-if="hasRule('pattern')"
            class="meta-field-validation__input meta-field-validation__input--message"
            type="text"
            placeholder="Custom error message"
            :value="getRule('pattern')?.message ?? ''"
            data-rule-message="pattern"
            @input="onUpdateMessage('pattern', $event)"
          />
        </div>
      </template>

      <!-- Number rules -->
      <template v-if="fieldType === 'number'">
        <div class="meta-field-validation__rule-row" data-rule-type="min">
          <label class="meta-field-validation__label">Minimum</label>
          <div class="meta-field-validation__inline">
            <input
              class="meta-field-validation__input meta-field-validation__input--small"
              type="number"
              :value="getRuleValue('min') ?? ''"
              data-rule-value="min"
              @input="onSetNumericRule('min', $event)"
            />
            <button
              v-if="hasRule('min')"
              class="meta-field-validation__remove"
              type="button"
              data-rule-remove="min"
              @click="onRemoveRule('min')"
            >&times;</button>
          </div>
          <input
            v-if="hasRule('min')"
            class="meta-field-validation__input meta-field-validation__input--message"
            type="text"
            placeholder="Custom error message"
            :value="getRule('min')?.message ?? ''"
            data-rule-message="min"
            @input="onUpdateMessage('min', $event)"
          />
        </div>

        <div class="meta-field-validation__rule-row" data-rule-type="max">
          <label class="meta-field-validation__label">Maximum</label>
          <div class="meta-field-validation__inline">
            <input
              class="meta-field-validation__input meta-field-validation__input--small"
              type="number"
              :value="getRuleValue('max') ?? ''"
              data-rule-value="max"
              @input="onSetNumericRule('max', $event)"
            />
            <button
              v-if="hasRule('max')"
              class="meta-field-validation__remove"
              type="button"
              data-rule-remove="max"
              @click="onRemoveRule('max')"
            >&times;</button>
          </div>
          <input
            v-if="hasRule('max')"
            class="meta-field-validation__input meta-field-validation__input--message"
            type="text"
            placeholder="Custom error message"
            :value="getRule('max')?.message ?? ''"
            data-rule-message="max"
            @input="onUpdateMessage('max', $event)"
          />
        </div>
      </template>

      <!-- Select enum rule -->
      <template v-if="fieldType === 'select'">
        <div class="meta-field-validation__rule-row" data-rule-type="enum">
          <label class="meta-field-validation__toggle">
            <input
              type="checkbox"
              :checked="hasRule('enum')"
              data-rule-toggle="enum"
              @change="onToggleEnum"
            />
            <span>Restrict to defined options</span>
          </label>
          <div v-if="hasRule('enum')" class="meta-field-validation__enum-values" data-rule-enum-values="true">
            <span v-for="opt in enumValues" :key="opt" class="meta-field-validation__enum-chip">{{ opt }}</span>
            <span v-if="!enumValues.length" class="meta-field-validation__empty">No options defined</span>
          </div>
          <input
            v-if="hasRule('enum')"
            class="meta-field-validation__input meta-field-validation__input--message"
            type="text"
            placeholder="Custom error message"
            :value="getRule('enum')?.message ?? ''"
            data-rule-message="enum"
            @input="onUpdateMessage('enum', $event)"
          />
        </div>
      </template>

      <!-- Preview -->
      <div v-if="localRules.length" class="meta-field-validation__preview" data-validation-preview="true">
        <strong class="meta-field-validation__label">Preview</strong>
        <div v-for="rule in localRules" :key="rule.type" class="meta-field-validation__preview-item">
          <span class="meta-field-validation__preview-type">{{ ruleLabel(rule.type) }}</span>
          <span v-if="rule.value !== undefined" class="meta-field-validation__preview-value">{{ rule.value }}</span>
          <span v-if="rule.message" class="meta-field-validation__preview-msg">{{ rule.message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { FieldValidationRule, FieldValidationRuleType } from '../types'

const PATTERN_PRESETS: Record<string, string> = {
  email: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
  url: '^https?://.+',
  phone: '^\\+?[0-9\\-\\s()]{7,}$',
}

const props = defineProps<{
  fieldId: string
  fieldType: string
  rules: FieldValidationRule[]
  options?: Array<{ value: string }>
}>()

const emit = defineEmits<{
  (e: 'update:rules', rules: FieldValidationRule[]): void
}>()

const localRules = ref<FieldValidationRule[]>([...props.rules])

const enumValues = computed(() => {
  return props.options?.map((o) => o.value) ?? []
})

const patternPreset = computed(() => {
  const patternRule = getRule('pattern')
  if (!patternRule?.value) return ''
  const val = String(patternRule.value)
  for (const [key, preset] of Object.entries(PATTERN_PRESETS)) {
    if (val === preset) return key
  }
  return ''
})

function hasRule(type: FieldValidationRuleType): boolean {
  return localRules.value.some((r) => r.type === type)
}

function getRule(type: FieldValidationRuleType): FieldValidationRule | undefined {
  return localRules.value.find((r) => r.type === type)
}

function getRuleValue(type: FieldValidationRuleType): string | number | string[] | undefined {
  return getRule(type)?.value
}

function setRule(type: FieldValidationRuleType, value?: string | number | string[], message?: string) {
  const idx = localRules.value.findIndex((r) => r.type === type)
  const rule: FieldValidationRule = { type, value, message }
  if (idx >= 0) {
    localRules.value[idx] = rule
  } else {
    localRules.value.push(rule)
  }
  localRules.value = [...localRules.value]
  emit('update:rules', localRules.value)
}

function removeRule(type: FieldValidationRuleType) {
  localRules.value = localRules.value.filter((r) => r.type !== type)
  emit('update:rules', localRules.value)
}

function onRemoveRule(type: FieldValidationRuleType) {
  removeRule(type)
}

function onToggleRequired() {
  if (hasRule('required')) {
    removeRule('required')
  } else {
    setRule('required')
  }
}

function onToggleEnum() {
  if (hasRule('enum')) {
    removeRule('enum')
  } else {
    setRule('enum', enumValues.value)
  }
}

function onSetNumericRule(type: FieldValidationRuleType, event: Event) {
  const input = event.target as HTMLInputElement
  const val = input.value.trim()
  if (val === '') {
    removeRule(type)
    return
  }
  const num = Number(val)
  if (Number.isFinite(num)) {
    setRule(type, num, getRule(type)?.message)
  }
}

function onSetPatternRule(event: Event) {
  const input = event.target as HTMLInputElement
  const val = input.value.trim()
  if (!val) {
    removeRule('pattern')
    return
  }
  setRule('pattern', val, getRule('pattern')?.message)
}

function onPatternPreset(event: Event) {
  const select = event.target as HTMLSelectElement
  const key = select.value
  if (!key) return
  const preset = PATTERN_PRESETS[key]
  if (preset) {
    setRule('pattern', preset, getRule('pattern')?.message)
  }
}

function onUpdateMessage(type: FieldValidationRuleType, event: Event) {
  const input = event.target as HTMLInputElement
  const rule = getRule(type)
  if (rule) {
    setRule(type, rule.value, input.value || undefined)
  }
}

function ruleLabel(type: FieldValidationRuleType): string {
  switch (type) {
    case 'required': return 'Required'
    case 'minLength': return 'Min length'
    case 'maxLength': return 'Max length'
    case 'pattern': return 'Pattern'
    case 'min': return 'Minimum'
    case 'max': return 'Maximum'
    case 'enum': return 'Enum'
    default: return type
  }
}

watch(
  () => props.rules,
  (newRules) => {
    localRules.value = [...newRules]
  },
)
</script>

<style scoped>
.meta-field-validation {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}

.meta-field-validation__header {
  padding: 12px 14px;
  border-bottom: 1px solid #e2e8f0;
}

.meta-field-validation__title {
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}

.meta-field-validation__body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.meta-field-validation__rule-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.meta-field-validation__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
  cursor: pointer;
}

.meta-field-validation__label {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
}

.meta-field-validation__inline {
  display: flex;
  gap: 8px;
  align-items: center;
}

.meta-field-validation__input {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: #fff;
  box-sizing: border-box;
}

.meta-field-validation__input--small {
  width: 100px;
}

.meta-field-validation__input--message {
  width: 100%;
  font-size: 12px;
  color: #64748b;
}

.meta-field-validation__select {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: #fff;
}

.meta-field-validation__remove {
  border: none;
  background: none;
  font-size: 18px;
  cursor: pointer;
  color: #ef4444;
  line-height: 1;
  padding: 0 4px;
}

.meta-field-validation__enum-values {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.meta-field-validation__enum-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: #e0e7ff;
  color: #3730a3;
  font-size: 12px;
}

.meta-field-validation__empty {
  font-size: 12px;
  color: #94a3b8;
}

.meta-field-validation__preview {
  border-top: 1px solid #e2e8f0;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-field-validation__preview-item {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: #334155;
}

.meta-field-validation__preview-type {
  font-weight: 600;
  min-width: 80px;
}

.meta-field-validation__preview-value {
  color: #2563eb;
}

.meta-field-validation__preview-msg {
  color: #94a3b8;
  font-style: italic;
}
</style>
