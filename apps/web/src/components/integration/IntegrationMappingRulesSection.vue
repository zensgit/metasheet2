<template>
  <section id="int-sec-cleaning-rules" class="integration-workbench__panel">
    <el-card shadow="never">
      <template #header>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>清洗映射规则</h2>
        <p>一行就是一条清洗内容：从来源字段取值，经过白名单转换后写入目标字段。默认映射可直接用，也允许新增自定义清洗项。</p>
      </div>
      <button type="button" class="integration-workbench__button" data-testid="add-mapping" @click="addMapping">
        新增自定义清洗项
      </button>
    </div>
      </template>


    <div class="integration-workbench__mapping-list" data-testid="mapping-rule-list">
      <details v-for="(mapping, index) in mappings" :key="mapping.id" class="integration-workbench__mapping-card" open>
        <summary :data-testid="`mapping-summary-${index}`">
          <span>{{ mappingSummary(mapping, index) }}</span>
          <small>{{ mappingDetail(mapping) }}</small>
        </summary>
        <div class="integration-workbench__mapping-editor">
          <label>
            <span>源字段</span>
            <select
              v-if="hasSourceFieldOptions"
              v-model="mapping.sourceField"
              :data-testid="`source-field-${index}`"
            >
              <option value="">请选择来源字段</option>
              <option
                v-for="option in sourceFieldOptionsForMapping(mapping)"
                :key="`${option.stale ? 'stale' : 'schema'}:${option.value}`"
                :value="option.value"
              >
                {{ sourceFieldOptionText(option) }}
              </option>
            </select>
            <input v-else v-model="mapping.sourceField" :data-testid="`source-field-${index}`" placeholder="例如 code" />
            <small v-if="hasSourceFieldOptions" class="integration-workbench__field-help" :data-testid="`source-field-picker-help-${index}`">
              字段来自来源 schema；这里只保存字段名，不显示行值。
            </small>
          </label>
          <label>
            <span>目标字段</span>
            <input v-model="mapping.targetField" :data-testid="`target-field-${index}`" placeholder="例如 FNumber" />
          </label>
          <label>
            <span>转换</span>
            <select v-model="mapping.transformFn" :data-testid="`transform-fn-${index}`">
              <option v-for="option in transformOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <small class="integration-workbench__field-help">只允许 trim、upper、lower、toNumber、dictMap；不允许用户脚本或 raw SQL。</small>
            <textarea
              v-if="mapping.transformFn === 'dictMap'"
              v-model="mapping.dictMapText"
              :data-testid="`dict-map-${index}`"
              placeholder="EA=Pcs&#10;KG=Kg"
            ></textarea>
          </label>
          <div>
            <label class="integration-workbench__mapping-check">
              <input v-model="mapping.required" type="checkbox" :data-testid="`required-${index}`" />
              <span>必填；缺值会进入 dead letter，不中断整批。</span>
            </label>
            <div class="integration-workbench__mapping-rules">
              <input v-model="mapping.minValueText" :data-testid="`validation-min-${index}`" placeholder="最小值 min" />
              <input v-model="mapping.maxValueText" :data-testid="`validation-max-${index}`" placeholder="最大值 max" />
            </div>
          </div>
          <button type="button" class="integration-workbench__icon-button" @click="removeMapping(index)">删除</button>
        </div>
      </details>
    </div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// IU-2b (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage B): extracted verbatim from IntegrationWorkbenchView.vue's `int-sec-cleaning-rules`
// section (pure template/markup move — no state or service-call logic lives here).
//
// `mappings` keeps its original nested-`v-model` editing pattern (`v-model="mapping.sourceField"`
// etc. on items pulled from the prop array via `v-for`): the parent passes down the *same*
// `EditableMapping[]` array reference it already owns (a `ref<EditableMapping[]>` in the view),
// so mutating a nested field here mutates the identical object the parent's `ref` points at —
// no different from the pre-extraction behavior where the same array was rendered inline. This
// file is not part of `apps/web`'s lint file list (see `package.json`'s `lint` script), so the
// nested-prop-mutation pattern carries no lint-gate risk either.
import type { EditableMapping, SourceFieldOption, TransformFn } from './integrationWorkbenchSectionTypes'

defineProps<{
  mappings: EditableMapping[]
  hasSourceFieldOptions: boolean
  sourceFieldOptionsForMapping: (mapping: EditableMapping) => SourceFieldOption[]
  sourceFieldOptionText: (option: SourceFieldOption) => string
  transformOptions: Array<{ value: TransformFn, label: string }>
  mappingSummary: (mapping: EditableMapping, index: number) => string
  mappingDetail: (mapping: EditableMapping) => string
  addMapping: () => void
  removeMapping: (index: number) => void
}>()
</script>

<style scoped>
/* Verbatim copies of the rules in IntegrationWorkbenchView.vue's <style scoped> block that
   target markup now rendered by this component — see IntegrationMonitoringSection.vue's style
   block comment for why duplication (not relocation) is the correct approach here. */
.integration-workbench label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input,
.integration-workbench select,
.integration-workbench textarea {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench textarea {
  min-height: 260px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}

.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench__panel p {
  margin: 8px 0 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__button,
.integration-workbench__icon-button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
}

.integration-workbench__button {
  padding: 8px 12px;
}

.integration-workbench__icon-button {
  padding: 6px 8px;
}

.integration-workbench__button:hover,
.integration-workbench__icon-button:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled,
.integration-workbench__icon-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__panel {
  margin-bottom: 16px;
  padding: 16px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__mapping-list {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__mapping-card {
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.integration-workbench__mapping-card summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  padding: 10px 12px;
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
}

.integration-workbench__mapping-card summary small {
  color: var(--ms-text-2);
  font-weight: 600;
}

.integration-workbench__mapping-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(180px, 0.8fr) minmax(180px, 0.8fr) auto;
  gap: 10px;
  padding: 0 12px 12px;
  align-items: start;
}

.integration-workbench__mapping-editor textarea {
  min-height: 68px;
  margin-top: 6px;
}

.integration-workbench__mapping-check {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 6px;
}

.integration-workbench__mapping-rules {
  display: grid;
  grid-template-columns: repeat(2, minmax(72px, 1fr));
  gap: 6px;
  margin-top: 6px;
}

.integration-workbench__field-help {
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
}

@media (max-width: 900px) {
  .integration-workbench__panel-head,
  .integration-workbench__mapping-editor {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
