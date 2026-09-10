<template>
  <div v-if="showsAnyControl" class="integration-workbench__transform-args">
    <template v-if="fn === 'toDate'">
      <select v-model="args.dateFormat" :data-testid="`${testidPrefix}-date-format`">
        <option v-for="option in dateFormatOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <small class="integration-workbench__field-help" :data-testid="`${testidPrefix}-date-format-help`">
        引擎只区分「仅日期」和「ISO 日期时间」两种输出，不接受 YYYY-MM-DD 这类自定义格式串。
      </small>
    </template>

    <template v-else-if="fn === 'defaultValue'">
      <input
        v-model="args.defaultValueText"
        :data-testid="`${testidPrefix}-default-value`"
        placeholder="缺值时写入的值，例如 UNKNOWN"
      />
      <small class="integration-workbench__field-help" :data-testid="`${testidPrefix}-default-value-help`">
        空字符串、纯空格都算缺值；这里填的值按字符串写入，需要数字请在后面再接一步 toNumber。
      </small>
    </template>

    <template v-else-if="fn === 'concat'">
      <select
        v-if="hasFieldOptions"
        v-model="args.concatFields"
        multiple
        size="4"
        :data-testid="`${testidPrefix}-concat-fields`"
      >
        <option v-for="option in fieldOptions" :key="option.value" :value="option.value">
          {{ fieldOptionText(option) }}
        </option>
      </select>
      <input
        v-else
        :value="args.concatFields.join(', ')"
        :data-testid="`${testidPrefix}-concat-fields`"
        placeholder="拼接字段，逗号分隔，例如 spec,color"
        @input="onConcatFieldsText(($event.target as HTMLInputElement).value)"
      />
      <input
        v-model="args.concatSeparator"
        :data-testid="`${testidPrefix}-concat-separator`"
        placeholder="分隔符，例如 -（留空表示直接相连）"
      />
      <small class="integration-workbench__field-help" :data-testid="`${testidPrefix}-concat-help`">
        当前来源字段的值排在最前，其后按所选顺序拼接；空值会被跳过，不会留下多余分隔符。
      </small>
    </template>
  </div>
</template>

<script setup lang="ts">
// G27 — the per-step argument controls for the cleaning-rules editor, shared by step 1 (whose
// state lives on `EditableMapping.transformArgs`) and by every chained step (whose state lives on
// `MappingTransformStep.args`). Extracted so the two call sites cannot drift apart: one markup,
// one set of testids (`${testidPrefix}-...`).
//
// It mutates the `args` object it is handed, exactly like IntegrationMappingRulesSection.vue
// mutates the `mappings` array items it is handed — the parent view owns the same object, so the
// nested `v-model` writes land in the view's `ref` with no extra plumbing. `dictMap`'s textarea
// stays in the parent because its testid (`dict-map-${index}`) predates this component and is
// asserted by IntegrationWorkbenchView.spec.ts.
import { computed } from 'vue'
import { DATE_FORMAT_OPTIONS, parseCommaSeparatedList } from './integrationMappingTransform'
import type { MappingTransformArgs, SourceFieldOption, TransformFn } from './integrationWorkbenchSectionTypes'

const props = defineProps<{
  fn: TransformFn
  args: MappingTransformArgs
  testidPrefix: string
  hasFieldOptions: boolean
  fieldOptions: SourceFieldOption[]
  fieldOptionText: (option: SourceFieldOption) => string
}>()

const dateFormatOptions = DATE_FORMAT_OPTIONS

// trim/upper/lower/toNumber/dictMap take no editor-authored argument, so the block collapses
// entirely for them (and for the empty "no transform"选项).
const showsAnyControl = computed(() => props.fn === 'toDate' || props.fn === 'defaultValue' || props.fn === 'concat')

function onConcatFieldsText(text: string): void {
  props.args.concatFields = parseCommaSeparatedList(text)
}
</script>

<style scoped>
.integration-workbench__transform-args {
  display: grid;
  gap: 6px;
  margin-top: 6px;
}

/* Same control styling as the rest of the mapping editor — these rules are scoped to this
   component, so they duplicate (never relocate) the parent's. */
.integration-workbench__transform-args input,
.integration-workbench__transform-args select {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench__transform-args select[multiple] {
  padding: 4px;
}

.integration-workbench__field-help {
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
}
</style>
