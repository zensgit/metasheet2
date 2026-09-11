<template>
  <section id="int-sec-object-template" class="integration-workbench__panel">
    <el-card shadow="never">
      <template #header>
        <div class="integration-workbench__panel-head">
          <div>
            <h2>选择系统与数据集</h2>
        <p>来源对象决定从哪里取数，目标模板决定写到哪里。先选系统，再加载可选数据集或模板。</p>
      </div>
    </div>
      </template>

    <div class="integration-workbench__grid integration-workbench__grid--systems">
      <div class="integration-workbench__system-column">
        <h2>1. 来源对象选择</h2>
        <label>
          <span>数据源系统</span>
          <select v-model="sourceSystemId" data-testid="source-system" @change="handleSourceSystemChange">
            <option value="">请选择数据源系统</option>
            <option
              v-for="system in sourceSystems"
              :key="system.id"
              :value="system.id"
              :disabled="isSourceOptionDisabled(system)"
              :data-disabled="isSourceOptionDisabled(system) ? 'true' : 'false'"
              :data-testid="`source-system-option-${system.id}`"
            >
              {{ system.name }} · {{ system.kind }}
            </option>
          </select>
        </label>
        <div class="integration-workbench__hint" data-testid="source-selector-explanation">
          {{ sourceSelectorExplanation }}
        </div>
        <div
          v-if="selectedPlmApprovalCapabilityEntry"
          class="integration-workbench__capability-entry"
          :data-state="selectedPlmApprovalCapabilityEntry.state"
          :data-action-status="selectedPlmApprovalCapabilityEntry.actionStatus || 'none'"
          data-testid="plm-approval-capability-entry"
        >
          <div>
            <span class="integration-workbench__badge" :data-status="selectedPlmApprovalCapabilityEntry.state">
              {{ selectedPlmApprovalCapabilityEntry.badge }}
            </span>
            <strong>{{ selectedPlmApprovalCapabilityEntry.title }}</strong>
          </div>
          <p>{{ selectedPlmApprovalCapabilityEntry.detail }}</p>
          <small v-if="selectedPlmApprovalCapabilityEntry.apiVersion">
            {{ PLM_APPROVAL_AUTOMATION_FEATURE_KEY }} · API {{ selectedPlmApprovalCapabilityEntry.apiVersion }}
          </small>
        </div>
        <div
          v-if="selectedPlmBomMultitableCapabilityEntry"
          class="integration-workbench__capability-entry"
          :data-state="selectedPlmBomMultitableCapabilityEntry.state"
          data-testid="plm-bom-multitable-capability-entry"
        >
          <div>
            <span class="integration-workbench__badge" :data-status="selectedPlmBomMultitableCapabilityEntry.state">
              {{ selectedPlmBomMultitableCapabilityEntry.badge }}
            </span>
            <strong>{{ selectedPlmBomMultitableCapabilityEntry.title }}</strong>
          </div>
          <p>{{ selectedPlmBomMultitableCapabilityEntry.detail }}</p>
          <small v-if="selectedPlmBomMultitableCapabilityEntry.apiVersion">
            {{ PLM_BOM_MULTITABLE_FEATURE_KEY }} · API {{ selectedPlmBomMultitableCapabilityEntry.apiVersion }}
          </small>
          <PlmBomReviewPanel
            v-if="selectedPlmBomMultitableCapabilityEntry.state === 'enabled' && selectedSourcePlmDataSourceId"
            :data-source-id="selectedSourcePlmDataSourceId"
            :eco-intent-enabled="selectedPlmBomEcoIntentEnabled"
          />
        </div>
        <div v-if="!hasRunnableSourceSystem" class="integration-workbench__empty integration-workbench__empty--actionable" data-testid="source-empty-state">
          <strong>还没有可读取的数据源。</strong>
          <p>连接 PLM、HTTP API 或启用 SQL 只读通道后，可将数据导入 staging 多维表再清洗。</p>
          <div class="integration-workbench__actions">
            <router-link class="integration-workbench__button" to="/integrations/k3-wise">使用 K3 WISE 预设</router-link>
            <button type="button" class="integration-workbench__button" data-testid="show-staging-setup" @click="showStagingSetup">创建 staging 多维表作为来源</button>
            <button type="button" class="integration-workbench__button" @click="showSqlSetup">启用 SQL 只读通道</button>
          </div>
        </div>
        <div v-if="sourceRuntimeBlocker" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="source-runtime-blocker">
          {{ sourceRuntimeBlocker }}
        </div>
        <div v-if="k3WebApiReadGateNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="k3-webapi-read-gate-notice">
          {{ k3WebApiReadGateNotice }}
        </div>
        <div v-if="sqlChannelDisabledHint" class="integration-workbench__hint" data-testid="sql-channel-disabled-hint">
          {{ sqlChannelDisabledHint }}
        </div>
        <div class="integration-workbench__connection-row">
          <span class="integration-workbench__badge" :data-status="sourceConnectionStatus">{{ sourceConnectionLabel }}</span>
          <button type="button" class="integration-workbench__button" data-testid="test-source-system" @click="testSystem('source')">
            测试来源连接
          </button>
          <button type="button" class="integration-workbench__button" data-testid="load-source-objects" @click="loadObjects('source')">
            加载来源对象
          </button>
        </div>
        <label>
          <span>来源数据集（从哪里取数）</span>
          <select v-model="sourceObjectName" data-testid="source-object" @change="handleSourceObjectChange">
            <option value="">请选择来源数据集</option>
            <option v-for="object in sourceObjects" :key="object.name" :value="object.name">
              {{ object.label || object.name }}
            </option>
          </select>
        </label>
        <div v-if="sourceSchema.fields.length" class="integration-workbench__schema-filter">
          <input
            v-model="sourceFieldQuery"
            type="search"
            data-testid="source-field-filter"
            :placeholder="`搜索来源字段（共 ${sourceSchema.fields.length} 个）`"
            aria-label="搜索来源字段"
          />
          <span class="integration-workbench__schema-count" data-testid="source-field-count">
            {{ sourceFields.length }} / {{ sourceSchema.fields.length }}
          </span>
        </div>
        <ul class="integration-workbench__schema-list">
          <li
            v-for="field in sourceFields"
            :key="field.name"
            class="integration-workbench__schema-row"
            :data-testid="`source-field-${field.name}`"
            :title="copiedField === field.name ? '已复制字段名' : '点击复制字段名'"
            @click="copyFieldName(field.name)"
          >
            <span class="integration-workbench__schema-label">{{ field.label || field.name }}</span>
            <code>{{ field.name }}</code>
            <em v-if="field.type" class="integration-workbench__schema-type">{{ field.type }}</em>
            <small
              v-if="copiedField === field.name"
              class="integration-workbench__schema-copied"
              data-testid="source-field-copied"
            >已复制</small>
          </li>
          <li v-if="!sourceFields.length" class="integration-workbench__schema-empty" data-testid="source-field-empty">
            没有匹配「{{ sourceFieldQuery }}」的字段
          </li>
        </ul>
      </div>

      <div class="integration-workbench__system-column">
        <h2>2. 目标模板选择</h2>
        <label>
          <span>目标系统</span>
          <select v-model="targetSystemId" data-testid="target-system">
            <option value="">请选择目标系统</option>
            <option v-for="system in targetSystems" :key="system.id" :value="system.id">
              {{ system.name }} · {{ system.kind }}
            </option>
          </select>
        </label>
        <div class="integration-workbench__hint" data-testid="target-selector-explanation">
          {{ targetSelectorExplanation }}
        </div>
        <div class="integration-workbench__connection-row">
          <span class="integration-workbench__badge" :data-status="targetConnectionStatus">{{ targetConnectionLabel }}</span>
          <button type="button" class="integration-workbench__button" data-testid="test-target-system" @click="testSystem('target')">
            测试目标连接
          </button>
          <button type="button" class="integration-workbench__button" data-testid="load-target-objects" @click="loadObjects('target')">
            加载目标模板
          </button>
        </div>
        <label>
          <span>目标数据集 / 模板（写到哪里）</span>
          <select v-model="targetObjectName" data-testid="target-object" @change="loadSchema('target')">
            <option value="">请选择目标数据集</option>
            <option v-for="object in targetObjects" :key="object.name" :value="object.name">
              {{ object.label || object.name }}
            </option>
          </select>
        </label>
        <div v-if="targetSchema.fields.length" class="integration-workbench__schema-filter">
          <input
            v-model="targetFieldQuery"
            type="search"
            data-testid="target-field-filter"
            :placeholder="`搜索目标字段（共 ${targetSchema.fields.length} 个）`"
            aria-label="搜索目标字段"
          />
          <span class="integration-workbench__schema-count" data-testid="target-field-count">
            {{ targetFields.length }} / {{ targetSchema.fields.length }}
          </span>
        </div>
        <ul class="integration-workbench__schema-list">
          <li
            v-for="field in targetFields"
            :key="field.name"
            class="integration-workbench__schema-row"
            :data-testid="`target-field-${field.name}`"
            :title="copiedField === field.name ? '已复制字段名' : '点击复制字段名'"
            @click="copyFieldName(field.name)"
          >
            <span class="integration-workbench__schema-label">{{ field.label || field.name }}</span>
            <code>{{ field.name }}</code>
            <em v-if="field.type" class="integration-workbench__schema-type">{{ field.type }}</em>
            <strong v-if="field.required">必填</strong>
            <small
              v-if="copiedField === field.name"
              class="integration-workbench__schema-copied"
              data-testid="target-field-copied"
            >已复制</small>
          </li>
          <li v-if="!targetFields.length" class="integration-workbench__schema-empty" data-testid="target-field-empty">
            没有匹配「{{ targetFieldQuery }}」的字段
          </li>
        </ul>
      </div>
    </div>
    <div v-if="sameSystemNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="same-system-notice">
      {{ sameSystemNotice }}
    </div>
    <div v-if="protocolSplitNotice" class="integration-workbench__hint" data-testid="protocol-split-notice">
      {{ protocolSplitNotice }}
    </div>
    <div v-if="stagingTargetMismatchNotice" class="integration-workbench__hint integration-workbench__hint--strong" data-testid="source-target-mismatch-notice">
      <span>{{ stagingTargetMismatchNotice }}</span>
      <button
        v-if="recommendedStagingSourceObject"
        type="button"
        class="integration-workbench__button"
        data-testid="use-recommended-staging-source"
        @click="useRecommendedStagingSource"
      >
        切换到 {{ stagingDatasetCopy[recommendedStagingSourceObject]?.name || recommendedStagingSourceObject }}
      </button>
    </div>
    </el-card>
  </section>
</template>

<script setup lang="ts">
// IU-2c (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-2,
// stage C): extracted verbatim from IntegrationWorkbenchView.vue's `int-sec-object-template`
// section (pure template/markup move — no state or service-call logic lives here). The parent
// view owns every ref/computed/service-call; this component only renders them and forwards user
// actions back up via the exact same function references it is handed as props.
//
// `sourceSystemId`/`sourceObjectName`/`targetSystemId`/`targetObjectName` are the four native
// `v-model`-bound selects in this section, so each uses `defineModel` (same pattern as IU-2b's
// `stagingBaseId`) — the parent binds `v-model:source-system-id="sourceSystemId"` etc. instead
// of a plain prop + manual change handler.
//
// `PLM_APPROVAL_AUTOMATION_FEATURE_KEY` / `PLM_BOM_MULTITABLE_FEATURE_KEY` are plain literal
// string constants used only for display; duplicated locally (same rationale as the shared
// type file's duplicated shapes) rather than passed as props or touching the parent's script.
import { computed, ref } from 'vue'

import type {
  IntegrationObjectSchema,
  IntegrationObjectSchemaField,
  IntegrationSystemObject,
  WorkbenchExternalSystem,
} from '../../services/integration/workbench'
import type { PlmApprovalCapabilityEntry, PlmBomCapabilityEntry, WorkbenchSide } from './integrationWorkbenchSectionTypes'
import PlmBomReviewPanel from '../plm/PlmBomReviewPanel.vue'

const PLM_APPROVAL_AUTOMATION_FEATURE_KEY = 'approval_automation'
const PLM_BOM_MULTITABLE_FEATURE_KEY = 'bom_multitable'

const props = defineProps<{
  sourceSystems: WorkbenchExternalSystem[]
  isSourceOptionDisabled: (system: WorkbenchExternalSystem) => boolean
  handleSourceSystemChange: () => void
  sourceSelectorExplanation: string
  selectedPlmApprovalCapabilityEntry: PlmApprovalCapabilityEntry | null
  selectedPlmBomMultitableCapabilityEntry: PlmBomCapabilityEntry | null
  // ECO Phase 3: capability-advisory pre-gate for the locked-BOM ECO-revision CTA (computed by
  // the workbench view from features.bom_eco_revision; the panel never fetches capabilities).
  selectedPlmBomEcoIntentEnabled: boolean
  selectedSourcePlmDataSourceId: string
  hasRunnableSourceSystem: boolean
  showStagingSetup: () => void
  showSqlSetup: () => void
  sourceRuntimeBlocker: string
  k3WebApiReadGateNotice: string
  sqlChannelDisabledHint: string
  sourceConnectionStatus: string
  sourceConnectionLabel: string
  testSystem: (side: WorkbenchSide) => Promise<void>
  loadObjects: (side: WorkbenchSide) => Promise<void>
  handleSourceObjectChange: () => Promise<void>
  sourceObjects: IntegrationSystemObject[]
  sourceSchema: IntegrationObjectSchema
  targetSystems: WorkbenchExternalSystem[]
  targetSelectorExplanation: string
  targetConnectionStatus: string
  targetConnectionLabel: string
  loadSchema: (side: WorkbenchSide) => Promise<void>
  targetObjects: IntegrationSystemObject[]
  targetSchema: IntegrationObjectSchema
  sameSystemNotice: string
  protocolSplitNotice: string
  stagingTargetMismatchNotice: string
  recommendedStagingSourceObject: string
  stagingDatasetCopy: Record<string, { area: string; name: string; description: string }>
  useRecommendedStagingSource: () => Promise<void>
}>()

const sourceSystemId = defineModel<string>('sourceSystemId', { default: '' })
const sourceObjectName = defineModel<string>('sourceObjectName', { default: '' })
const targetSystemId = defineModel<string>('targetSystemId', { default: '' })
const targetObjectName = defineModel<string>('targetObjectName', { default: '' })

// G52 (second half) — the field list used to be a bare `<ul>`. A real ERP table is 40-200 columns, and
// once SQL Server object names may be 中文 (the first half of G52) the list an operator has to eyeball
// is BOTH long and hard to skim. Three purely LOCAL affordances, none of which touch the parent's state,
// its service calls, or the wire:
//   • a filter box (matches name AND label AND type, case-insensitively, so `qty` finds `数量` when the
//     adapter supplied a label, and `nvarchar` finds every text column);
//   • the declared type rendered as a badge — it is already on `IntegrationObjectSchemaField.type` and
//     was simply not displayed;
//   • click-to-copy of the exact field NAME, because a 中文 column name is the one thing an operator
//     cannot reliably retype into a mapping expression.
// Values-free: only schema METADATA (names/labels/types) is rendered or copied — never a row value.
const sourceFieldQuery = ref('')
const targetFieldQuery = ref('')
const copiedField = ref('')

function matchesQuery(field: IntegrationObjectSchemaField, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [field.name, field.label, field.type]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .some((part) => part.toLocaleLowerCase().includes(needle))
}

function filterFields(schema: IntegrationObjectSchema, query: string): IntegrationObjectSchemaField[] {
  const fields = Array.isArray(schema?.fields) ? schema.fields : []
  return fields.filter((field) => matchesQuery(field, query))
}

const sourceFields = computed(() => filterFields(props.sourceSchema, sourceFieldQuery.value))
const targetFields = computed(() => filterFields(props.targetSchema, targetFieldQuery.value))

let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyFieldName(name: string): Promise<void> {
  // Best-effort. A non-secure browsing context has no `navigator.clipboard` at all, and the on-prem
  // deployments this workbench runs in are frequently plain HTTP. When the copy cannot happen we do
  // NOTHING — never a "已复制" badge for a copy that did not occur.
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (typeof clipboard?.writeText !== 'function') return
  try {
    await clipboard.writeText(name)
  } catch {
    return
  }
  copiedField.value = name
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    if (copiedField.value === name) copiedField.value = ''
  }, 1500)
}
</script>

<style scoped>
/* Verbatim copies of the rules in IntegrationWorkbenchView.vue's <style scoped> block that
   target markup now rendered by this component — see IntegrationMonitoringSection.vue's style
   block comment for why duplication (not relocation) is the correct approach here. */
.integration-workbench__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.integration-workbench h2 {
  margin: 0;
  font-size: 17px;
}

.integration-workbench__panel p {
  margin: 8px 0 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.integration-workbench__k3-link,
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

.integration-workbench__k3-link,
.integration-workbench__button {
  padding: 8px 12px;
}

.integration-workbench__button:hover,
.integration-workbench__k3-link:hover {
  border-color: var(--ms-color-primary);
}

.integration-workbench__button:disabled {
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

.integration-workbench__capability-entry {
  display: grid;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.integration-workbench__capability-entry > div {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.integration-workbench__capability-entry strong {
  color: var(--ms-text-1);
}

.integration-workbench__capability-entry p,
.integration-workbench__capability-entry small {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.45;
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

.integration-workbench__empty {
  padding: 12px;
  border: 1px dashed var(--ms-border);
  border-radius: 6px;
  color: var(--ms-text-2);
}

.integration-workbench__empty--actionable {
  margin-top: 10px;
}

.integration-workbench__empty strong {
  color: var(--ms-text-1);
}

.integration-workbench__empty p {
  margin: 6px 0 0;
}

.integration-workbench__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
}

.integration-workbench__connection-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.integration-workbench__badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: 700;
}

.integration-workbench__badge[data-status="active"] {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.integration-workbench__badge[data-status="error"] {
  background: var(--el-color-danger-light-9);
  color: var(--el-color-danger);
}

.integration-workbench__badge[data-status="warning"] {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.integration-workbench__badge[data-status="enabled"] {
  background: var(--el-color-success-light-9);
  color: var(--el-color-success-dark-2);
}

.integration-workbench__badge[data-status="upgrade"] {
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
}

.integration-workbench__badge[data-status="loading"] {
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
}

.integration-workbench__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
}

.integration-workbench__grid--systems {
  align-items: start;
}

.integration-workbench__system-column {
  display: grid;
  gap: 12px;
}

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

.integration-workbench__schema-list {
  min-height: 84px;
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--ms-bg-page);
  list-style: none;
}

.integration-workbench__schema-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  color: var(--ms-text-2);
}

.integration-workbench code {
  color: var(--ms-color-primary);
  font-size: 12px;
}

.integration-workbench__schema-list strong {
  color: var(--el-color-danger);
  font-size: 12px;
}

/* G52 (second half): filter + type badge + click-to-copy for the schema field list. */
.integration-workbench__schema-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
}

.integration-workbench__schema-filter input {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--ms-text-1);
  font: inherit;
  font-size: 13px;
}

.integration-workbench__schema-count {
  color: var(--ms-text-3);
  font-size: 12px;
  white-space: nowrap;
}

.integration-workbench__schema-row {
  cursor: pointer;
}

.integration-workbench__schema-row:hover {
  background: var(--el-fill-color-light);
}

.integration-workbench__schema-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.integration-workbench__schema-type {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  padding: 0 6px;
  color: var(--ms-text-3);
  font-size: 11px;
  font-style: normal;
  white-space: nowrap;
}

.integration-workbench__schema-copied {
  color: var(--el-color-success);
  font-size: 11px;
  white-space: nowrap;
}

.integration-workbench__schema-empty {
  color: var(--ms-text-3);
  cursor: default;
  font-size: 12px;
}

@media (max-width: 900px) {
  .integration-workbench__panel-head,
  .integration-workbench__grid {
    grid-template-columns: 1fr;
  }

  .integration-workbench__panel-head {
    display: grid;
  }
}
</style>
