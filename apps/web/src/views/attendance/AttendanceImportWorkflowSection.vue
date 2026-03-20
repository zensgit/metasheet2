<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Import (DingTalk / Manual)', '导入（钉钉 / 手工）') }}</h4>
      <div class="attendance__admin-actions">
        <button class="attendance__btn" :disabled="importLoading" @click="loadImportTemplate">
          {{ importLoading ? tr('Loading...', '加载中...') : tr('Load template', '加载模板') }}
        </button>
        <button class="attendance__btn" :disabled="importLoading" @click="downloadImportTemplateCsv">
          {{ tr('Download CSV template', '下载 CSV 模板') }}
        </button>
      </div>
    </div>
    <div v-if="importTemplateGuide" class="attendance__template-guide">
      <div class="attendance__template-guide-header">
        <strong>{{ tr('Template guide', '模板说明') }}</strong>
        <span>
          {{ tr('Source', '来源') }}: <code>{{ importTemplateGuide.source }}</code>
          · {{ tr('Mode', '模式') }}: <code>{{ importTemplateGuide.mode }}</code>
        </span>
      </div>
      <div class="attendance__template-guide-grid">
        <div class="attendance__template-guide-card">
          <div class="attendance__template-guide-title">{{ tr('Suggested CSV header', '建议 CSV 表头') }}</div>
          <code class="attendance__template-code">{{ importTemplateGuide.sampleHeader || tr('(no header guidance yet)', '（暂无表头指导）') }}</code>
          <small class="attendance__field-hint">
            {{ tr('Use this header order when you export or hand-edit CSV rows.', '导出或手工编辑 CSV 行时，请按这个表头顺序。') }}
          </small>
        </div>
        <div class="attendance__template-guide-card">
          <div class="attendance__template-guide-title">{{ tr('Required fields', '必填字段') }}</div>
          <div v-if="importTemplateGuide.requiredFields.length" class="attendance__template-chip-list">
            <span v-for="field in importTemplateGuide.requiredFields" :key="field" class="attendance__template-chip">
              {{ field }}
            </span>
          </div>
          <small v-else class="attendance__field-hint">
            {{ tr('No required fields were declared in the template response.', '模板响应中未声明必填字段。') }}
          </small>
        </div>
        <div class="attendance__template-guide-card">
          <div class="attendance__template-guide-title">{{ tr('Template columns', '模板列') }}</div>
          <div v-if="importTemplateGuide.columns.length" class="attendance__template-chip-list">
            <span v-for="column in importTemplateGuide.columns" :key="column" class="attendance__template-chip">
              {{ column }}
            </span>
          </div>
          <small v-else class="attendance__field-hint">
            {{ tr('The template response did not declare explicit source columns.', '模板响应未声明明确的源列。') }}
          </small>
        </div>
        <div class="attendance__template-guide-card attendance__template-guide-card--full">
          <div class="attendance__template-guide-title">{{ tr('Field meanings', '字段说明') }}</div>
          <table class="attendance__template-table">
            <thead>
              <tr>
                <th>{{ tr('Field', '字段') }}</th>
                <th>{{ tr('Meaning', '含义') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in importTemplateGuide.fieldGuides" :key="item.field">
                <td><code>{{ item.field }}</code></td>
                <td>
                  {{ tr(item.meaningEn, item.meaningZh) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="selectedImportProfileGuide" class="attendance__template-guide-card attendance__template-guide-card--full">
          <div class="attendance__template-guide-title">
            {{ tr('Selected mapping profile', '已选映射配置') }}: {{ selectedImportProfileGuide.name }}
          </div>
          <small v-if="selectedImportProfileGuide.description" class="attendance__field-hint">
            {{ selectedImportProfileGuide.description }}
          </small>
          <small v-if="selectedImportProfileGuide.requiredFields.length" class="attendance__field-hint">
            {{ tr('Profile required fields', '配置必填字段') }}: {{ selectedImportProfileGuide.requiredFields.join(', ') }}
          </small>
          <div v-if="selectedImportProfileGuide.userMapKeyField || selectedImportProfileGuide.userMapSourceFields?.length" class="attendance__field-hint">
            <span v-if="selectedImportProfileGuide.userMapKeyField">
              {{ tr('User map key field', '用户映射键字段') }}: <code>{{ selectedImportProfileGuide.userMapKeyField }}</code>
            </span>
            <span v-if="selectedImportProfileGuide.userMapSourceFields?.length">
              {{ selectedImportProfileGuide.userMapKeyField ? ' · ' : '' }}
              {{ tr('User map source fields', '用户映射源字段') }}: <code>{{ selectedImportProfileGuide.userMapSourceFields.join(', ') }}</code>
            </span>
          </div>
          <table v-if="selectedImportProfileGuide.mappingEntries.length" class="attendance__template-table">
            <thead>
              <tr>
                <th>{{ tr('Target field', '目标字段') }}</th>
                <th>{{ tr('Meaning', '含义') }}</th>
                <th>{{ tr('Source field', '源字段') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in selectedImportProfileGuide.mappingEntries" :key="item.targetField">
                <td><code>{{ item.targetField }}</code></td>
                <td>{{ tr(item.meaningEn, item.meaningZh) }}</td>
                <td><code>{{ item.sourceField }}</code></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-import-rule-set">
        <span>{{ tr('Rule set', '规则集') }}</span>
        <select
          id="attendance-import-rule-set"
          name="importRuleSetId"
          v-model="importForm.ruleSetId"
          :disabled="ruleSets.length === 0"
        >
          <option value="">{{ tr('(Optional) Use default rule', '（可选）使用默认规则') }}</option>
          <option v-for="item in ruleSets" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-import-mode">
        <span>{{ tr('Import mode', '导入模式') }}</span>
        <select id="attendance-import-mode" v-model="importMode">
          <option value="override">{{ tr('override', '覆盖') }}</option>
          <option value="merge">{{ tr('merge', '合并') }}</option>
        </select>
        <small class="attendance__field-hint">
          <code>{{ tr('override', '覆盖') }}</code>: {{ tr('overwrite same user/date.', '覆盖同用户同日期记录。') }}
          <code>{{ tr('merge', '合并') }}</code>: {{ tr('keep existing fields when present.', '存在字段时保留已有值。') }}
        </small>
      </label>
      <label class="attendance__field" for="attendance-import-profile">
        <span>{{ tr('Mapping profile', '映射配置') }}</span>
        <select
          id="attendance-import-profile"
          v-model="importProfileId"
          :disabled="importMappingProfiles.length === 0"
        >
          <option value="">{{ tr('(Optional) Select profile', '（可选）选择配置') }}</option>
          <option v-for="profile in importMappingProfiles" :key="profile.id" :value="profile.id">
            {{ profile.name }}
          </option>
        </select>
        <small v-if="selectedImportProfile?.description" class="attendance__field-hint">
          {{ selectedImportProfile.description }}
        </small>
        <small v-if="selectedImportProfile?.requiredFields?.length" class="attendance__field-hint">
          {{ tr('Required fields', '必填字段') }}: {{ selectedImportProfile.requiredFields.join(', ') }}
        </small>
      </label>
      <label class="attendance__field" for="attendance-import-csv">
        <span>{{ tr('CSV file (optional)', 'CSV 文件（可选）') }}</span>
        <input
          id="attendance-import-csv"
          type="file"
          accept=".csv,text/csv"
          @change="handleImportCsvChange"
        />
        <small v-if="importCsvFileName" class="attendance__field-hint">
          {{ tr('Selected', '已选择') }}: {{ importCsvFileName }}
        </small>
      </label>
      <label class="attendance__field" for="attendance-import-csv-header">
        <span>{{ tr('CSV header row', 'CSV 表头行') }}</span>
        <input
          id="attendance-import-csv-header"
          v-model="importCsvHeaderRow"
          type="number"
          min="0"
          :placeholder="tr('Auto-detect', '自动识别')"
        />
      </label>
      <label class="attendance__field" for="attendance-import-csv-delimiter">
        <span>{{ tr('CSV delimiter', 'CSV 分隔符') }}</span>
        <input
          id="attendance-import-csv-delimiter"
          v-model="importCsvDelimiter"
          type="text"
          maxlength="2"
          placeholder=","
        />
      </label>
      <label class="attendance__field" for="attendance-import-user-map">
        <span>{{ tr('User map JSON (optional)', '用户映射 JSON（可选）') }}</span>
        <input
          id="attendance-import-user-map"
          type="file"
          accept=".json,application/json"
          @change="handleImportUserMapChange"
        />
        <small v-if="importUserMapFileName" class="attendance__field-hint">
          {{ tr('Selected', '已选择') }}: {{ importUserMapFileName }} · {{ importUserMapCount }} {{ tr('entries', '条') }}
        </small>
        <small v-if="importUserMapError" class="attendance__field-hint attendance__field-hint--error">
          {{ importUserMapError }}
        </small>
      </label>
      <label class="attendance__field" for="attendance-import-user-map-key">
        <span>{{ tr('User map key field', '用户映射键字段') }}</span>
        <input
          id="attendance-import-user-map-key"
          v-model="importUserMapKeyField"
          type="text"
          placeholder="工号"
        />
        <small v-if="selectedImportProfile?.userMapKeyField" class="attendance__field-hint">
          {{ tr('Default', '默认') }}: {{ selectedImportProfile.userMapKeyField }}
        </small>
      </label>
      <label class="attendance__field" for="attendance-import-user-map-source">
        <span>{{ tr('User map source fields', '用户映射源字段') }}</span>
        <input
          id="attendance-import-user-map-source"
          v-model="importUserMapSourceFields"
          type="text"
          placeholder="empNo,工号,姓名"
        />
        <small v-if="selectedImportProfile?.userMapSourceFields?.length" class="attendance__field-hint">
          {{ tr('Default', '默认') }}: {{ selectedImportProfile.userMapSourceFields.join(', ') }}
        </small>
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-import-group-create">
        <span>{{ tr('Auto-create groups', '自动创建分组') }}</span>
        <input id="attendance-import-group-create" v-model="importGroupAutoCreate" type="checkbox" />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-import-group-assign">
        <span>{{ tr('Auto-assign group members', '自动分配分组成员') }}</span>
        <input id="attendance-import-group-assign" v-model="importGroupAutoAssign" type="checkbox" />
      </label>
      <label class="attendance__field" for="attendance-import-group-rule-set">
        <span>{{ tr('Group rule set', '分组规则集') }}</span>
        <select
          id="attendance-import-group-rule-set"
          v-model="importGroupRuleSetId"
          :disabled="ruleSets.length === 0"
        >
          <option value="">{{ tr('(Optional) Use import rule set', '（可选）使用导入规则集') }}</option>
          <option v-for="item in ruleSets" :key="item.id" :value="item.id">
            {{ item.name }}
          </option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-import-group-timezone">
        <span>{{ tr('Group timezone (optional)', '分组时区（可选）') }}</span>
        <input
          id="attendance-import-group-timezone"
          v-model="importGroupTimezone"
          type="text"
          placeholder="Asia/Shanghai"
        />
      </label>
      <label class="attendance__field" for="attendance-import-user">
        <span>{{ tr('User ID', '用户 ID') }}</span>
        <input
          id="attendance-import-user"
          name="importUserId"
          v-model="importForm.userId"
          type="text"
          :placeholder="tr('Required if not in payload', '若 payload 无该字段则必填')"
        />
      </label>
      <label class="attendance__field" for="attendance-import-timezone">
        <span>{{ tr('Timezone', '时区') }}</span>
        <input
          id="attendance-import-timezone"
          name="importTimezone"
          v-model="importForm.timezone"
          type="text"
        />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-import-payload">
        <span>{{ tr('Payload (JSON)', '负载（JSON）') }}</span>
        <textarea
          id="attendance-import-payload"
          name="importPayload"
          v-model="importForm.payload"
          rows="6"
          placeholder='{"source":"dingtalk","userId":"...","columns":[],"data":{}}'
        />
        <small class="attendance__field-hint">
          {{ tr('Default import mode is', '默认导入模式为') }} <strong>{{ tr('override', '覆盖') }}</strong>
          {{ tr('(same user/date will be overwritten). Use', '（同用户同日期将被覆盖）。如需保留已存在字段，请在 payload 使用') }}
          <code>mode: \"merge\"</code>.
        </small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn" :disabled="importLoading" @click="applyImportCsvFile">
        {{ tr('Load CSV', '加载 CSV') }}
      </button>
      <button class="attendance__btn" :disabled="importLoading" @click="applyImportProfile">
        {{ tr('Apply profile', '应用配置') }}
      </button>
      <button class="attendance__btn" :disabled="importLoading" @click="previewImport">
        {{ importLoading ? tr('Working...', '处理中...') : tr('Preview', '预览') }}
      </button>
      <button class="attendance__btn attendance__btn--primary" :disabled="importLoading" @click="runImport">
        {{ importLoading ? tr('Importing...', '导入中...') : tr('Import', '导入') }}
      </button>
    </div>
    <small class="attendance__field-hint">
      {{ importScalabilityHint }}
    </small>
    <div
      v-if="importPreviewTask"
      class="attendance__status"
      :class="{ 'attendance__status--error': importPreviewTask.status === 'failed' }"
    >
      <div class="attendance__requests-header">
        <span>{{ importPreviewTask.mode === 'chunked' ? tr('Chunked preview task', '分块预览任务') : tr('Preview task', '预览任务') }}</span>
        <button class="attendance__btn" type="button" @click="clearImportPreviewTask">
          {{ tr('Clear', '清空') }}
        </button>
      </div>
      <div>
        {{ tr('Status', '状态') }}: <strong>{{ formatStatus(importPreviewTask.status) }}</strong>
        <template v-if="importPreviewTask.mode === 'chunked'">
          · {{ tr('Chunks', '分块') }} {{ importPreviewTask.completedChunks }} / {{ importPreviewTask.totalChunks }}
        </template>
      </div>
      <div v-if="importPreviewTask.totalRows">
        {{ tr('Progress', '进度') }}: {{ importPreviewTask.processedRows }} / {{ importPreviewTask.totalRows }}
      </div>
      <div v-if="importPreviewTask.message">{{ importPreviewTask.message }}</div>
    </div>
    <div
      v-if="importAsyncJob"
      class="attendance__status"
      :class="{ 'attendance__status--error': importAsyncJob.status === 'failed' }"
    >
      <div class="attendance__requests-header">
        <span>{{ importAsyncJob.kind === 'preview' ? tr('Async preview job', '异步预览任务') : tr('Async import job', '异步导入任务') }}</span>
        <div class="attendance__table-actions">
          <button
            class="attendance__btn"
            type="button"
            :disabled="importAsyncPolling"
            @click="refreshImportAsyncJob()"
          >
            {{ tr('Reload job', '重载任务') }}
          </button>
          <button
            v-if="importAsyncJob.status === 'queued' || importAsyncJob.status === 'running'"
            class="attendance__btn"
            type="button"
            :disabled="importAsyncPolling"
            @click="resumeImportAsyncJobPolling"
          >
            {{ importAsyncPolling ? tr('Polling...', '轮询中...') : tr('Resume polling', '恢复轮询') }}
          </button>
          <button class="attendance__btn" type="button" @click="clearImportAsyncJob">
            {{ tr('Clear', '清空') }}
          </button>
        </div>
      </div>
      <div>
        {{ tr('Status', '状态') }}: <strong>{{ formatStatus(importAsyncJob.status) }}</strong>
        <span v-if="importAsyncPolling"> · {{ tr('polling...', '轮询中...') }}</span>
      </div>
      <div v-if="importAsyncJob.total">
        {{ tr('Progress', '进度') }}: {{ importAsyncJob.progress }} / {{ importAsyncJob.total }}
        <span v-if="typeof importAsyncJob.progressPercent === 'number'">
          ({{ importAsyncJob.progressPercent }}%)
        </span>
      </div>
      <div v-if="importAsyncJobTelemetryText">{{ importAsyncJobTelemetryText }}</div>
      <div v-if="importAsyncJob.kind !== 'preview' && importAsyncJob.batchId">{{ tr('Batch', '批次') }}: {{ importAsyncJob.batchId }}</div>
      <div v-if="importAsyncJob.kind === 'preview' && importAsyncJob.preview?.rowCount">
        {{ tr('Preview rows', '预览行数') }}: {{ importAsyncJob.preview?.total ?? 0 }} / {{ importAsyncJob.preview?.rowCount }}
      </div>
      <div v-if="importAsyncJob.error">{{ tr('Error', '错误') }}: {{ importAsyncJob.error }}</div>
    </div>
    <div v-if="importStatusVisible" class="attendance__status attendance__status--error">
      <div>
        {{ statusMessage }}
      </div>
      <div v-if="statusCode">{{ tr('Code', '代码') }}: {{ statusCode }}</div>
      <div v-if="statusHint">{{ statusHint }}</div>
      <button
        v-if="statusActionLabel"
        class="attendance__btn attendance__btn--inline"
        type="button"
        :disabled="statusActionBusy"
        @click="runStatusAction"
      >
        {{ statusActionBusy ? tr('Working...', '处理中...') : statusActionLabel }}
      </button>
    </div>
    <div v-if="importCsvWarnings.length" class="attendance__status attendance__status--error">
      {{ tr('CSV warnings', 'CSV 警告') }}: {{ importCsvWarnings.join('; ') }}
    </div>
    <div v-if="importPreview.length === 0" class="attendance__empty">{{ tr('No preview data.', '暂无预览数据。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Work date', '工作日期') }}</th>
            <th>{{ tr('User ID', '用户 ID') }}</th>
            <th>{{ tr('Work minutes', '工作分钟') }}</th>
            <th>{{ tr('Late', '迟到') }}</th>
            <th>{{ tr('Early leave', '早退') }}</th>
            <th>{{ tr('Status', '状态') }}</th>
            <th>{{ tr('Warnings', '警告') }}</th>
            <th>{{ tr('Policies', '规则') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in importPreview" :key="`${item.userId}-${item.workDate}`">
            <td>{{ item.workDate }}</td>
            <td>{{ item.userId }}</td>
            <td>{{ item.workMinutes }}</td>
            <td>{{ item.lateMinutes }}</td>
            <td>{{ item.earlyLeaveMinutes }}</td>
            <td>{{ formatStatus(item.status) }}</td>
            <td>{{ formatList(item.warnings) }}</td>
            <td>{{ formatPolicyList(item) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type ComputedRef, type Ref } from 'vue'
import type {
  AttendanceImportFormState,
  AttendanceImportJob,
  AttendanceImportMappingProfile,
  AttendanceImportMode,
  AttendanceImportPreviewItem,
  AttendanceImportPreviewTask,
  AttendanceImportProfileGuide,
  AttendanceImportTemplateGuide,
} from './useAttendanceAdminImportWorkflow'
import type { AttendanceRuleSet } from './useAttendanceAdminRulesAndGroups'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface ImportWorkflowBindings {
  importForm: AttendanceImportFormState
  importLoading: Ref<boolean>
  importMode: Ref<AttendanceImportMode>
  importProfileId: Ref<string>
  importMappingProfiles: Ref<AttendanceImportMappingProfile[]>
  selectedImportProfile: ComputedRef<AttendanceImportMappingProfile | null>
  importTemplateGuide: ComputedRef<AttendanceImportTemplateGuide | null>
  selectedImportProfileGuide: ComputedRef<AttendanceImportProfileGuide | null>
  importCsvFileName: Ref<string>
  importCsvHeaderRow: Ref<string>
  importCsvDelimiter: Ref<string>
  importUserMapFileName: Ref<string>
  importUserMapCount: ComputedRef<number>
  importUserMapError: Ref<string>
  importUserMapKeyField: Ref<string>
  importUserMapSourceFields: Ref<string>
  importGroupAutoCreate: Ref<boolean>
  importGroupAutoAssign: Ref<boolean>
  importGroupRuleSetId: Ref<string>
  importGroupTimezone: Ref<string>
  importScalabilityHint: ComputedRef<string>
  importPreviewTask: Ref<AttendanceImportPreviewTask | null>
  importAsyncJob: Ref<AttendanceImportJob | null>
  importAsyncPolling: Ref<boolean>
  importAsyncJobTelemetryText: ComputedRef<string>
  importCsvWarnings: Ref<string[]>
  importPreview: Ref<AttendanceImportPreviewItem[]>
  loadImportTemplate: () => MaybePromise<void>
  downloadImportTemplateCsv: () => MaybePromise<void>
  applyImportCsvFile: () => MaybePromise<void>
  applyImportProfile: () => void
  previewImport: () => MaybePromise<void>
  runImport: () => MaybePromise<void>
  clearImportPreviewTask: () => void
  refreshImportAsyncJob: (options?: { silent?: boolean }) => MaybePromise<void>
  resumeImportAsyncJobPolling: () => MaybePromise<void>
  clearImportAsyncJob: () => void
  handleImportCsvChange: (event: Event) => void
  handleImportUserMapChange: (event: Event) => MaybePromise<void>
}

const props = defineProps<{
  tr: Translate
  ruleSets: AttendanceRuleSet[]
  workflow: ImportWorkflowBindings
  importStatusVisible: boolean
  statusMessage: string
  statusCode: string
  statusHint: string
  statusActionLabel: string
  statusActionBusy: boolean
  runStatusAction: () => MaybePromise<void>
  formatStatus: (value: string) => string
  formatList: (items?: Array<string> | null) => string
  formatPolicyList: (item: AttendanceImportPreviewItem) => string
}>()

const tr = props.tr
const ruleSets = computed(() => props.ruleSets)
const importForm = props.workflow.importForm
const importLoading = props.workflow.importLoading
const importMode = props.workflow.importMode
const importProfileId = props.workflow.importProfileId
const importMappingProfiles = props.workflow.importMappingProfiles
const selectedImportProfile = props.workflow.selectedImportProfile
const importTemplateGuide = props.workflow.importTemplateGuide
const selectedImportProfileGuide = props.workflow.selectedImportProfileGuide
const importCsvFileName = props.workflow.importCsvFileName
const importCsvHeaderRow = props.workflow.importCsvHeaderRow
const importCsvDelimiter = props.workflow.importCsvDelimiter
const importUserMapFileName = props.workflow.importUserMapFileName
const importUserMapCount = props.workflow.importUserMapCount
const importUserMapError = props.workflow.importUserMapError
const importUserMapKeyField = props.workflow.importUserMapKeyField
const importUserMapSourceFields = props.workflow.importUserMapSourceFields
const importGroupAutoCreate = props.workflow.importGroupAutoCreate
const importGroupAutoAssign = props.workflow.importGroupAutoAssign
const importGroupRuleSetId = props.workflow.importGroupRuleSetId
const importGroupTimezone = props.workflow.importGroupTimezone
const importScalabilityHint = props.workflow.importScalabilityHint
const importPreviewTask = props.workflow.importPreviewTask
const importAsyncJob = props.workflow.importAsyncJob
const importAsyncPolling = props.workflow.importAsyncPolling
const importAsyncJobTelemetryText = props.workflow.importAsyncJobTelemetryText
const importCsvWarnings = props.workflow.importCsvWarnings
const importPreview = props.workflow.importPreview

const loadImportTemplate = () => props.workflow.loadImportTemplate()
const downloadImportTemplateCsv = () => props.workflow.downloadImportTemplateCsv()
const applyImportCsvFile = () => props.workflow.applyImportCsvFile()
const applyImportProfile = () => props.workflow.applyImportProfile()
const previewImport = () => props.workflow.previewImport()
const runImport = () => props.workflow.runImport()
const clearImportPreviewTask = () => props.workflow.clearImportPreviewTask()
const refreshImportAsyncJob = () => props.workflow.refreshImportAsyncJob()
const resumeImportAsyncJobPolling = () => props.workflow.resumeImportAsyncJobPolling()
const clearImportAsyncJob = () => props.workflow.clearImportAsyncJob()
const handleImportCsvChange = (event: Event) => props.workflow.handleImportCsvChange(event)
const handleImportUserMapChange = (event: Event) => props.workflow.handleImportUserMapChange(event)
const runStatusAction = () => props.runStatusAction()
const formatStatus = props.formatStatus
const formatList = props.formatList
const formatPolicyList = props.formatPolicyList
</script>

<style scoped>
.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #555;
}

.attendance__field input,
.attendance__field select,
.attendance__field textarea {
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  min-width: 180px;
}

.attendance__field--full {
  flex: 1;
}

.attendance__field--checkbox {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.attendance__field--checkbox input {
  width: auto;
  min-width: auto;
}

.attendance__field-hint {
  color: #777;
  font-size: 11px;
}

.attendance__field-hint--error {
  color: #c0392b;
}

.attendance__template-guide {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid #dfe6ef;
  border-radius: 10px;
  background: linear-gradient(180deg, #f8fbff 0%, #fff 100%);
}

.attendance__template-guide-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #4b5563;
}

.attendance__template-guide-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.attendance__template-guide-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__template-guide-card--full {
  grid-column: 1 / -1;
}

.attendance__template-guide-title {
  font-size: 12px;
  font-weight: 600;
  color: #1f2937;
}

.attendance__template-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.attendance__template-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  background: #e8eef9;
  color: #17324f;
  font-size: 11px;
  line-height: 1.4;
}

.attendance__template-code {
  padding: 8px 10px;
  border: 1px solid #d0d7e2;
  border-radius: 8px;
  background: #fff;
  color: #111827;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}

.attendance__template-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.attendance__template-table th,
.attendance__template-table td {
  padding: 8px;
  border-top: 1px solid #e5e7eb;
  text-align: left;
  vertical-align: top;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn--primary {
  background: #1976d2;
  border-color: #1976d2;
  color: #fff;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__btn--inline {
  padding: 5px 10px;
  font-size: 12px;
}

.attendance__status {
  font-size: 12px;
  color: #2e7d32;
}

.attendance__status--error {
  color: #c62828;
}

.attendance__requests-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
}

.attendance__table-wrapper {
  width: 100%;
  overflow-x: auto;
}

.attendance__table th,
.attendance__table td {
  border-bottom: 1px solid #e0e0e0;
  padding: 8px;
  text-align: left;
  font-size: 13px;
}

.attendance__table-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}

.attendance__admin-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.attendance__admin-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.attendance__admin-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

@media (max-width: 768px) {
  .attendance__btn {
    width: 100%;
  }
}
</style>
