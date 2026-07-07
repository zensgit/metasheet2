<template>
  <div class="integration-workbench__grid">
    <label>
      <span>清洗流程名称</span>
      <input v-model="pipelineName" data-testid="pipeline-name" :placeholder="generatedPipelineName" />
      <small class="integration-workbench__field-help" data-testid="pipeline-name-hint">留空自动生成：{{ generatedPipelineName }}；也可以手动改成业务名称。</small>
      <button type="button" class="integration-workbench__inline-action" data-testid="use-generated-pipeline-name" @click="useGeneratedPipelineName">
        使用自动名称
      </button>
    </label>
    <label>
      <span>清洗流程模式</span>
      <select v-model="pipelineMode" data-testid="pipeline-mode">
        <option value="manual">manual</option>
        <option value="incremental">incremental</option>
        <option value="full">full</option>
      </select>
      <small class="integration-workbench__field-help" data-testid="pipeline-mode-help">manual 手工触发；incremental 用水位增量；full 重新扫描来源数据集。</small>
    </label>
    <div v-if="showWatermarkConfig" class="integration-workbench__watermark-config" data-testid="watermark-config">
      <div class="integration-workbench__grid integration-workbench__grid--compact">
        <label>
          <span>水位类型</span>
          <select v-model="watermarkType" data-testid="watermark-type">
            <option value="updated_at">updated_at</option>
            <option value="monotonic_id">monotonic_id</option>
          </select>
        </label>
        <label>
          <span>水位字段</span>
          <select v-if="hasSourceFieldOptions" v-model="watermarkField" data-testid="watermark-field">
            <option value="">请选择水位字段</option>
            <option
              v-for="option in sourceFieldOptionsForValue(watermarkField)"
              :key="`${option.stale ? 'stale' : 'schema'}:${option.value}`"
              :value="option.value"
            >
              {{ sourceFieldOptionText(option) }}
            </option>
          </select>
          <input v-else v-model="watermarkField" data-testid="watermark-field" placeholder="updated_at" />
        </label>
        <label v-if="watermarkType === 'updated_at'">
          <span>并列判别字段</span>
          <select v-if="hasSourceFieldOptions" v-model="watermarkTiebreaker" data-testid="watermark-tiebreaker">
            <option value="">请选择 tiebreaker</option>
            <option
              v-for="option in sourceFieldOptionsForValue(watermarkTiebreaker)"
              :key="`${option.stale ? 'stale' : 'schema'}:${option.value}`"
              :value="option.value"
            >
              {{ sourceFieldOptionText(option) }}
            </option>
          </select>
          <input v-else v-model="watermarkTiebreaker" data-testid="watermark-tiebreaker" placeholder="id" />
        </label>
      </div>
      <p class="integration-workbench__hint" data-testid="watermark-config-help">
        保存只写入增量读取配置；不读取数据库、不推进水位、不写外部系统。updated_at 对 SQL 只读源必须配置不同的 tiebreaker。
      </p>
      <p v-if="watermarkConfigError" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="watermark-config-error">
        {{ watermarkConfigError }}
      </p>
    </div>
    <label>
      <span>幂等字段</span>
      <input v-model="idempotencyFieldsText" data-testid="idempotency-fields" placeholder="code 或 sourceId,revision" />
      <small class="integration-workbench__field-help" data-testid="idempotency-fields-help">用于识别同一业务记录，避免重复写入；物料通常用 code，BOM 可用 parentCode,childCode,sequence。</small>
    </label>
    <label>
      <span>清洗 staging 表</span>
      <select v-model="stagingSheetId" data-testid="staging-sheet">
        <option value="">不绑定 staging 表</option>
        <option v-for="descriptor in stagingDescriptors" :key="descriptor.id" :value="descriptor.id">
          {{ descriptor.name }} · {{ descriptor.id }}
        </option>
      </select>
    </label>
    <label>
      <span>已保存流程 ID</span>
      <input v-model="savedPipelineId" data-testid="pipeline-id" placeholder="保存后自动回填，也可粘贴已有 ID" />
      <small class="integration-workbench__field-help" data-testid="pipeline-id-help">这是后端 pipeline ID。新建时留空，保存成功后自动回填；排障或复跑时可粘贴已有 ID。</small>
    </label>
    <label>
      <span>运行模式</span>
      <select v-model="pipelineRunMode" data-testid="pipeline-run-mode">
        <option value="manual">manual</option>
        <option value="incremental">incremental</option>
        <option value="full">full</option>
      </select>
    </label>
    <label>
      <span>Dry-run 样本数</span>
      <input v-model="pipelineSampleLimit" data-testid="sample-limit" inputmode="numeric" />
    </label>
  </div>

  <div class="integration-workbench__run-explainer" data-testid="run-push-explainer">
    <strong>运行时会发生什么</strong>
    <ul>
      <li>Dry-run 只读取来源数据并生成目标 payload preview，不写 K3 或其他外部系统。</li>
      <li>Save-only 只调用目标系统保存接口；默认不 Submit、不 Audit，也不覆盖来源多维表。</li>
      <li>成功后展示写入数、外部 ID 或单据号；失败会写入 dead letter，可从异常区打开排查。</li>
      <li>导出清洗结果只使用已脱敏 preview，可用于人工复核或交接。</li>
    </ul>
  </div>

  <label class="integration-workbench__inline-check">
    <input v-model="allowSaveOnlyRun" type="checkbox" data-testid="allow-save-only-run" />
    <span>允许本次 Save-only 推送。保持 Submit / Audit 关闭。</span>
  </label>

  <div class="integration-workbench__readiness" data-testid="pipeline-readiness">
    <div>
      <strong>保存清洗流程前置条件</strong>
      <p data-testid="save-readiness-summary">{{ savePipelineBlockedSummary }}</p>
      <strong>运行前置条件</strong>
      <p data-testid="dry-run-readiness-summary">{{ dryRunBlockedSummary }}</p>
    </div>
    <ul>
      <li v-for="item in dryRunReadinessItems" :key="item.id" :data-ready="item.ready ? 'true' : 'false'">
        <span>{{ item.ready ? '已完成' : '待处理' }}</span>
        <strong>{{ item.label }}</strong>
        <small>{{ item.detail }}</small>
      </li>
    </ul>
  </div>

  <div class="integration-workbench__actions">
    <button type="button" class="integration-workbench__button" data-testid="run-dry-run" :disabled="runningPipeline !== '' || !canRunPipeline" @click="executePipeline(true)">
      {{ runningPipeline === 'dry-run' ? 'Dry-run 中' : 'Dry-run' }}
    </button>
    <button type="button" class="integration-workbench__button integration-workbench__button--danger" data-testid="run-save-only" :disabled="runningPipeline !== '' || !allowSaveOnlyRun || !canRunPipeline" @click="executePipeline(false)">
      {{ runningPipeline === 'run' ? '推送中' : 'Save-only 推送' }}
    </button>
  </div>
  <div v-if="dryRunEmptyPreviewNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="dry-run-empty-preview-notice">
    {{ dryRunEmptyPreviewNotice }}
  </div>
</template>

<script setup lang="ts">
// IU-2d (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage D — `int-sec-run-push` decomposition): pipeline config + run trigger, the first of five
// focused sub-panels the prior monolithic `int-sec-run-push` section bundled. Pure template/
// markup move — no state or service-call logic lives here; the parent view keeps every
// ref/computed/function and continues to own the `<section id="int-sec-run-push">` + `<el-card>`
// shell (header/save-pipeline button included) so DOM order and card nesting stay byte-identical
// to before this slice — this component renders *inside* that shell, not around it.
import type { IntegrationPipelineMode, IntegrationStagingDescriptor } from '../../services/integration/workbench'
import type { ReadinessItem, SourceFieldOption, WatermarkType } from './integrationWorkbenchSectionTypes'

defineProps<{
  generatedPipelineName: string
  showWatermarkConfig: boolean
  hasSourceFieldOptions: boolean
  sourceFieldOptionsForValue: (value: string) => SourceFieldOption[]
  sourceFieldOptionText: (option: SourceFieldOption) => string
  watermarkConfigError: string
  stagingDescriptors: IntegrationStagingDescriptor[]
  savePipelineBlockedSummary: string
  dryRunBlockedSummary: string
  dryRunReadinessItems: ReadinessItem[]
  runningPipeline: 'dry-run' | 'run' | ''
  canRunPipeline: boolean
  dryRunEmptyPreviewNotice: string
  useGeneratedPipelineName: () => void
  executePipeline: (dryRun: boolean) => Promise<void>
}>()

const pipelineName = defineModel<string>('pipelineName', { default: '' })
const pipelineMode = defineModel<IntegrationPipelineMode>('pipelineMode', { default: 'manual' })
const watermarkType = defineModel<WatermarkType>('watermarkType', { default: 'updated_at' })
const watermarkField = defineModel<string>('watermarkField', { default: '' })
const watermarkTiebreaker = defineModel<string>('watermarkTiebreaker', { default: '' })
const idempotencyFieldsText = defineModel<string>('idempotencyFieldsText', { default: '' })
const stagingSheetId = defineModel<string>('stagingSheetId', { default: '' })
const savedPipelineId = defineModel<string>('savedPipelineId', { default: '' })
const pipelineRunMode = defineModel<IntegrationPipelineMode>('pipelineRunMode', { default: 'manual' })
const pipelineSampleLimit = defineModel<string>('pipelineSampleLimit', { default: '' })
const allowSaveOnlyRun = defineModel<boolean>('allowSaveOnlyRun', { default: false })
</script>

<style scoped>
/* Verbatim copies (selectively trimmed to the tags/classes this component actually renders — same
   approach as every other IU-2b/IU-2c/IU-2d child) of the rules in IntegrationWorkbenchView.vue's
   <style scoped> block that target this markup. */
.integration-workbench label {
  display: grid;
  gap: 6px;
  color: var(--ms-text-1);
  font-size: 13px;
  font-weight: 700;
}

.integration-workbench input,
.integration-workbench select {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.integration-workbench__field-help {
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.45;
}

.integration-workbench__inline-action {
  width: max-content;
  border: 0;
  background: transparent;
  color: var(--ms-color-primary);
  cursor: pointer;
  font: inherit;
  font-weight: 700;
  padding: 0;
  text-align: left;
}

.integration-workbench__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.integration-workbench__grid--compact {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.integration-workbench__watermark-config {
  grid-column: 1 / -1;
  padding: 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.integration-workbench__hint {
  margin-top: 10px;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.integration-workbench__hint--strong {
  padding: 10px 12px;
  border-radius: 6px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.integration-workbench__run-explainer {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.integration-workbench__run-explainer strong {
  color: var(--ms-text-1);
}

.integration-workbench__run-explainer ul {
  display: grid;
  gap: 6px;
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__inline-check {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}

.integration-workbench__inline-check input {
  width: auto;
}

.integration-workbench__readiness {
  display: grid;
  grid-template-columns: minmax(220px, 0.4fr) minmax(0, 1fr);
}

.integration-workbench__readiness ul {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.integration-workbench__readiness li {
  display: grid;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--ms-bg-card);
}

.integration-workbench__readiness li[data-ready="true"] {
  border-color: var(--el-color-success-light-7);
  background: var(--el-color-success-light-9);
}

.integration-workbench__readiness li > span {
  color: var(--el-color-warning-dark-2);
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench__readiness li[data-ready="true"] > span {
  color: var(--el-color-success-dark-2);
}

.integration-workbench__readiness small {
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.4;
}

.integration-workbench__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__button {
  border: 1px solid var(--ms-border);
  border-radius: 6px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-weight: 700;
  text-decoration: none;
  padding: 8px 12px;
}

.integration-workbench__button:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.integration-workbench__button--danger {
  border-color: var(--el-color-danger-light-3);
  color: var(--el-color-danger);
}

@media (max-width: 900px) {
  .integration-workbench__readiness,
  .integration-workbench__readiness ul,
  .integration-workbench__grid {
    grid-template-columns: 1fr;
  }

  .integration-workbench__readiness {
    display: grid;
  }
}
</style>
