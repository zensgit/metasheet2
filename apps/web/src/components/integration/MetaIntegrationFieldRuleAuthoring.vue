<template>
  <div class="integration-field-rule-authoring" data-testid="field-rule-authoring">
    <p class="integration-field-rule-authoring__hint">
      逐字段选择 替换(replace,来自清洗表列)或 保留(preserve,沿用模板)。参照字段可在 保留(preserve) 与 从映射表解析(from_reference_table,需选 domain)间切换,但不可降级为 scalar;gated 字段不可编辑。仅产出 fieldRules 草案,不写入 K3,也不调用 preview。
    </p>

    <ol class="integration-field-rule-authoring__list" data-testid="field-rule-list">
      <li
        v-for="(rule, index) in rules"
        :key="rule.targetField"
        class="integration-field-rule-authoring__row"
        :data-testid="`field-rule-${rule.targetField}`"
      >
        <code class="integration-field-rule-authoring__field">{{ rule.targetField }}</code>
        <span class="integration-field-rule-authoring__shape" :data-shape="rule.shape">{{ rule.shape }}</span>

        <template v-if="editability(rule).reason === 'gated'">
          <span
            class="integration-field-rule-authoring__mode integration-field-rule-authoring__mode--locked"
            :data-testid="`field-rule-mode-${rule.targetField}`"
          >gated（锁定,不可授权）</span>
          <span
            class="integration-field-rule-authoring__hint integration-field-rule-authoring__hint--strong"
            :data-testid="`field-rule-locked-${rule.targetField}`"
          >gated 字段不可编辑(不可授权)</span>
        </template>

        <template v-else-if="editability(rule).isReference">
          <!-- DF-T3b-2d: a reference may flip preserve ↔ from_reference_table (+domain); NEVER scalar. -->
          <select
            class="integration-field-rule-authoring__mode"
            :data-testid="`field-rule-mode-${rule.targetField}`"
            :value="rule.sourceType === 'from_reference_table' ? 'mapping' : 'preserve'"
            @change="onReferenceModeChange(index, ($event.target as HTMLSelectElement).value)"
          >
            <option value="preserve">保留(template)</option>
            <option value="mapping">从映射表解析(reference table)</option>
          </select>
          <template v-if="rule.sourceType === 'from_reference_table'">
            <select
              class="integration-field-rule-authoring__domain"
              :data-testid="`field-rule-domain-${rule.targetField}`"
              :value="rule.domain || ''"
              @change="onReferenceDomainChange(index, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">— 选择 domain —</option>
              <option v-for="domain in referenceDomains" :key="domain" :value="domain">{{ domain }}</option>
            </select>
            <span
              v-if="!rule.domain"
              class="integration-field-rule-authoring__hint integration-field-rule-authoring__hint--strong"
              :data-testid="`field-rule-domain-required-${rule.targetField}`"
            >需选择 domain(否则该参照字段保持未解析)</span>
            <!-- DF-T3b dual-binding: the sourceCode COLUMN the resolver reads (the second binding). -->
            <input
              class="integration-field-rule-authoring__source"
              :data-testid="`field-rule-source-code-${rule.targetField}`"
              :value="rule.sourceField || ''"
              placeholder="sourceCode 列名(清洗表列)"
              @input="onReferenceSourceFieldChange(index, ($event.target as HTMLInputElement).value)"
            />
            <span
              v-if="!rule.sourceField"
              class="integration-field-rule-authoring__hint integration-field-rule-authoring__hint--strong"
              :data-testid="`field-rule-source-code-required-${rule.targetField}`"
            >需填写 sourceCode 列(否则解析读到的列不对)</span>
          </template>
        </template>

        <template v-else>
          <select
            class="integration-field-rule-authoring__mode"
            :data-testid="`field-rule-mode-${rule.targetField}`"
            :value="rule.sourceType === 'from_staging' ? 'replace' : 'preserve'"
            @change="onModeChange(index, ($event.target as HTMLSelectElement).value)"
          >
            <option value="replace">替换(staging)</option>
            <option value="preserve">保留(template)</option>
          </select>
          <input
            v-if="rule.sourceType === 'from_staging'"
            class="integration-field-rule-authoring__source"
            :data-testid="`field-rule-source-${rule.targetField}`"
            :value="rule.sourceField || ''"
            placeholder="清洗表列名"
            @input="onSourceFieldChange(index, ($event.target as HTMLInputElement).value)"
          />
        </template>
      </li>
    </ol>

    <div
      v-if="gatedFields.length > 0"
      class="integration-field-rule-authoring__gated"
      data-testid="field-rule-gated"
    >
      <h4>锁定字段(gated,不可授权)</h4>
      <ul>
        <li v-for="field in gatedFields" :key="field" :data-testid="`field-rule-gated-${field}`">
          <code>{{ field }}</code> · 锁定
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
// DF-T2b: per-field replace/preserve authoring UI. Edits a DF-T2a draft fieldRules set and emits
// the result. It holds NO payloadTemplate / customer values (the rules carry field names + shape
// only); it makes NO backend call (no preview wire — that is DF-T2c) and never writes to K3.
import { computed } from 'vue'
import {
  DF_T3_REFERENCE_DOMAINS,
  fieldRuleEditability,
  setFieldRuleReplace,
  setFieldRulePreserve,
  setFieldRuleFromReferenceTable,
  setFieldRuleReferencePreserve,
  setFieldRuleReferenceSourceField,
  type IntegrationFieldRule,
} from '../../services/integration/workbench'

const props = withDefaults(
  defineProps<{
    modelValue: IntegrationFieldRule[]
    gatedFields?: string[]
  }>(),
  { gatedFields: () => [] },
)

const emit = defineEmits<{ (e: 'update:modelValue', rules: IntegrationFieldRule[]): void }>()

const rules = computed(() => props.modelValue)
const gatedFields = computed(() => props.gatedFields ?? [])
const referenceDomains = DF_T3_REFERENCE_DOMAINS

function editability(rule: IntegrationFieldRule) {
  return fieldRuleEditability(rule, gatedFields.value)
}

function emitUpdated(index: number, next: IntegrationFieldRule): void {
  emit('update:modelValue', props.modelValue.map((rule, i) => (i === index ? next : rule)))
}

// SCALAR mode (replace/preserve). Guards against gated AND reference fields — a reference must never be
// downgraded to a scalar replace (its mode is handled by onReferenceModeChange).
function onModeChange(index: number, mode: string): void {
  const rule = props.modelValue[index]
  const e = editability(rule)
  if (!e.editable || e.isReference) return
  if (mode === 'replace') emitUpdated(index, setFieldRuleReplace(rule, rule.sourceField || ''))
  else emitUpdated(index, setFieldRulePreserve(rule))
}

function onSourceFieldChange(index: number, sourceField: string): void {
  const rule = props.modelValue[index]
  const e = editability(rule)
  if (!e.editable || e.isReference) return
  emitUpdated(index, setFieldRuleReplace(rule, sourceField))
}

// DF-T3b-2d: REFERENCE mode (preserve ↔ from_reference_table). Keeps shape/completeness; never scalar.
// Switching to 'mapping' yields the half-state (no domain yet) → the operator must pick a domain.
function onReferenceModeChange(index: number, mode: string): void {
  const rule = props.modelValue[index]
  const e = editability(rule)
  if (!e.editable || !e.isReference) return
  if (mode === 'mapping') emitUpdated(index, setFieldRuleFromReferenceTable(rule, rule.domain || ''))
  else emitUpdated(index, setFieldRuleReferencePreserve(rule))
}

function onReferenceDomainChange(index: number, domain: string): void {
  const rule = props.modelValue[index]
  const e = editability(rule)
  if (!e.editable || !e.isReference) return
  emitUpdated(index, setFieldRuleFromReferenceTable(rule, domain))
}

// DF-T3b dual-binding: the sourceCode column (rule.sourceField) for a from_reference_table reference.
function onReferenceSourceFieldChange(index: number, sourceField: string): void {
  const rule = props.modelValue[index]
  const e = editability(rule)
  if (!e.editable || !e.isReference || rule.sourceType !== 'from_reference_table') return
  emitUpdated(index, setFieldRuleReferenceSourceField(rule, sourceField))
}
</script>
