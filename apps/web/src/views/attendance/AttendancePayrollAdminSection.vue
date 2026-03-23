<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Payroll Templates', '计薪模板') }}</h4>
      <button class="attendance__btn" :disabled="payrollTemplateLoading" @click="loadPayrollTemplates">
        {{ payrollTemplateLoading ? tr('Loading...', '加载中...') : tr('Reload templates', '重载模板') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-payroll-template-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input
          id="attendance-payroll-template-name"
          v-model="payrollTemplateForm.name"
          name="payrollTemplateName"
          type="text"
          required
          :placeholder="tr('Required payroll template name', '必填计薪模板名称')"
        />
      </label>
      <label class="attendance__field" for="attendance-payroll-template-timezone">
        <span>{{ tr('Timezone', '时区') }}</span>
        <select
          id="attendance-payroll-template-timezone"
          v-model="payrollTemplateForm.timezone"
          name="payrollTemplateTimezone"
        >
          <optgroup
            v-for="group in payrollTemplateTimezoneOptionGroups"
            :key="group.id"
            :label="tr(group.labelEn, group.labelZh)"
          >
            <option v-for="timezone in group.options" :key="timezone.value" :value="timezone.value">
              {{ timezone.label }}
            </option>
          </optgroup>
        </select>
        <small class="attendance__field-hint">
          {{ tr('Current', '当前') }}: {{ payrollTemplateTimezoneStatusLabel || '--' }}
        </small>
      </label>
      <label class="attendance__field" for="attendance-payroll-template-start">
        <span>{{ tr('Start day', '起始日') }}</span>
        <input
          id="attendance-payroll-template-start"
          v-model.number="payrollTemplateForm.startDay"
          name="payrollTemplateStartDay"
          type="number"
          min="1"
          max="31"
        />
      </label>
      <label class="attendance__field" for="attendance-payroll-template-end">
        <span>{{ tr('End day', '结束日') }}</span>
        <input
          id="attendance-payroll-template-end"
          v-model.number="payrollTemplateForm.endDay"
          name="payrollTemplateEndDay"
          type="number"
          min="1"
          max="31"
        />
      </label>
      <label class="attendance__field" for="attendance-payroll-template-offset">
        <span>{{ tr('End month offset', '结束月偏移') }}</span>
        <select
          id="attendance-payroll-template-offset"
          v-model.number="payrollTemplateForm.endMonthOffset"
          name="payrollTemplateOffset"
        >
          <option :value="0">{{ tr('Same month', '当月') }}</option>
          <option :value="1">{{ tr('Next month', '次月') }}</option>
        </select>
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-payroll-template-auto">
        <span>{{ tr('Auto generate', '自动生成') }}</span>
        <input
          id="attendance-payroll-template-auto"
          v-model="payrollTemplateForm.autoGenerate"
          name="payrollTemplateAuto"
          type="checkbox"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-payroll-template-default">
        <span>{{ tr('Default', '默认') }}</span>
        <input
          id="attendance-payroll-template-default"
          v-model="payrollTemplateForm.isDefault"
          name="payrollTemplateDefault"
          type="checkbox"
        />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-payroll-template-config">
        <span>{{ tr('Config (JSON)', '配置（JSON）') }}</span>
        <textarea
          id="attendance-payroll-template-config"
          v-model="payrollTemplateForm.config"
          name="payrollTemplateConfig"
          rows="3"
          placeholder="{}"
        />
        <small class="attendance__field-hint">
          {{ tr('Use JSON for payroll-specific settings such as summary formulas, allowance flags, or export metadata.', '可用 JSON 配置计薪专属设置，例如汇总公式、补贴开关或导出元数据。') }}
        </small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="payrollTemplateSaving" @click="savePayrollTemplate">
        {{ payrollTemplateSaving ? tr('Saving...', '保存中...') : payrollTemplateEditingId ? tr('Update template', '更新模板') : tr('Create template', '创建模板') }}
      </button>
      <button
        v-if="payrollTemplateEditingId"
        class="attendance__btn"
        :disabled="payrollTemplateSaving"
        @click="resetPayrollTemplateForm"
      >
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="payrollTemplates.length === 0" class="attendance__empty">{{ tr('No payroll templates yet.', '暂无计薪模板。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Timezone', '时区') }}</th>
            <th>{{ tr('Start', '开始') }}</th>
            <th>{{ tr('End', '结束') }}</th>
            <th>{{ tr('Offset', '偏移') }}</th>
            <th>{{ tr('Default', '默认') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in payrollTemplates" :key="item.id">
            <td>{{ item.name }}</td>
            <td>{{ formatTimezoneOptionLabel(item.timezone) }}</td>
            <td>{{ item.startDay }}</td>
            <td>{{ item.endDay }}</td>
            <td>{{ item.endMonthOffset }}</td>
            <td>{{ item.isDefault ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editPayrollTemplate(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deletePayrollTemplate(item.id)">
                {{ tr('Delete', '删除') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Payroll Cycles', '计薪周期') }}</h4>
      <button class="attendance__btn" :disabled="payrollCycleLoading" @click="loadPayrollCycles">
        {{ payrollCycleLoading ? tr('Loading...', '加载中...') : tr('Reload cycles', '重载周期') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-payroll-cycle-template">
        <span>{{ tr('Template', '模板') }}</span>
        <select
          id="attendance-payroll-cycle-template"
          v-model="payrollCycleForm.templateId"
          name="payrollCycleTemplate"
          :disabled="payrollTemplates.length === 0"
        >
          <option value="">{{ tr('Manual', '手工') }}</option>
          <option v-for="item in payrollTemplates" :key="item.id" :value="item.id">
            {{ formatPayrollTemplateSelectLabel(item) }}
          </option>
        </select>
        <small class="attendance__field-hint">
          {{ payrollCycleTemplateTimezoneHint }}
        </small>
      </label>
      <label class="attendance__field" for="attendance-payroll-cycle-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input
          id="attendance-payroll-cycle-name"
          v-model="payrollCycleForm.name"
          name="payrollCycleName"
          type="text"
          :placeholder="tr('Optional', '可选')"
        />
      </label>
      <label class="attendance__field" for="attendance-payroll-cycle-anchor">
        <span>{{ tr('Anchor date', '锚点日期') }}</span>
        <input
          id="attendance-payroll-cycle-anchor"
          v-model="payrollCycleForm.anchorDate"
          name="payrollCycleAnchor"
          type="date"
        />
      </label>
      <label class="attendance__field" for="attendance-payroll-cycle-start">
        <span>{{ tr('Start date', '开始日期') }}</span>
        <input
          id="attendance-payroll-cycle-start"
          v-model="payrollCycleForm.startDate"
          name="payrollCycleStartDate"
          type="date"
        />
      </label>
      <label class="attendance__field" for="attendance-payroll-cycle-end">
        <span>{{ tr('End date', '结束日期') }}</span>
        <input
          id="attendance-payroll-cycle-end"
          v-model="payrollCycleForm.endDate"
          name="payrollCycleEndDate"
          type="date"
        />
      </label>
      <label class="attendance__field" for="attendance-payroll-cycle-status">
        <span>{{ tr('Status', '状态') }}</span>
        <select
          id="attendance-payroll-cycle-status"
          v-model="payrollCycleForm.status"
          name="payrollCycleStatus"
        >
          <option value="open">{{ tr('Open', '开启') }}</option>
          <option value="closed">{{ tr('Closed', '关闭') }}</option>
          <option value="archived">{{ tr('Archived', '归档') }}</option>
        </select>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="payrollCycleSaving" @click="savePayrollCycle">
        {{ payrollCycleSaving ? tr('Saving...', '保存中...') : payrollCycleEditingId ? tr('Update cycle', '更新周期') : tr('Create cycle', '创建周期') }}
      </button>
      <button class="attendance__btn" :disabled="payrollCycleSaving" @click="loadPayrollCycleSummary">
        {{ tr('Load summary', '加载汇总') }}
      </button>
      <button class="attendance__btn" :disabled="payrollCycleSaving" @click="exportPayrollCycleSummary">
        {{ tr('Export CSV', '导出 CSV') }}
      </button>
      <button
        v-if="payrollCycleEditingId"
        class="attendance__btn"
        :disabled="payrollCycleSaving"
        @click="resetPayrollCycleForm"
      >
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>

    <details class="attendance__details">
      <summary class="attendance__details-summary">{{ tr('Batch generate cycles', '批量生成周期') }}</summary>
      <div class="attendance__admin-grid attendance__admin-grid--compact">
        <label class="attendance__field" for="attendance-payroll-cycle-gen-template">
          <span>{{ tr('Template', '模板') }}</span>
          <select
            id="attendance-payroll-cycle-gen-template"
            v-model="payrollCycleGenerateForm.templateId"
            name="payrollCycleGenTemplate"
            :disabled="payrollTemplates.length === 0"
          >
            <option value="">{{ payrollCycleGenerateDefaultOptionLabel }}</option>
            <option v-for="item in payrollTemplates" :key="item.id" :value="item.id">
              {{ formatPayrollTemplateSelectLabel(item) }}
            </option>
          </select>
          <small class="attendance__field-hint">
            {{ payrollCycleGenerateTimezoneHint }}
          </small>
        </label>
        <label class="attendance__field" for="attendance-payroll-cycle-gen-anchor">
          <span>{{ tr('Anchor date', '锚点日期') }}</span>
          <input
            id="attendance-payroll-cycle-gen-anchor"
            v-model="payrollCycleGenerateForm.anchorDate"
            name="payrollCycleGenAnchor"
            type="date"
          />
        </label>
        <label class="attendance__field" for="attendance-payroll-cycle-gen-count">
          <span>{{ tr('Count', '数量') }}</span>
          <input
            id="attendance-payroll-cycle-gen-count"
            v-model.number="payrollCycleGenerateForm.count"
            name="payrollCycleGenCount"
            type="number"
            min="1"
            max="36"
          />
        </label>
        <label class="attendance__field" for="attendance-payroll-cycle-gen-status">
          <span>{{ tr('Status', '状态') }}</span>
          <select
            id="attendance-payroll-cycle-gen-status"
            v-model="payrollCycleGenerateForm.status"
            name="payrollCycleGenStatus"
          >
            <option value="open">{{ tr('Open', '开启') }}</option>
            <option value="closed">{{ tr('Closed', '关闭') }}</option>
            <option value="archived">{{ tr('Archived', '归档') }}</option>
          </select>
        </label>
        <label class="attendance__field" for="attendance-payroll-cycle-gen-prefix">
          <span>{{ tr('Name prefix', '名称前缀') }}</span>
          <input
            id="attendance-payroll-cycle-gen-prefix"
            v-model="payrollCycleGenerateForm.namePrefix"
            name="payrollCycleGenPrefix"
            type="text"
            :placeholder="tr('Optional', '可选')"
          />
        </label>
        <label class="attendance__field attendance__field--full" for="attendance-payroll-cycle-gen-metadata">
          <span>{{ tr('Metadata (JSON)', '元数据（JSON）') }}</span>
          <textarea
            id="attendance-payroll-cycle-gen-metadata"
            v-model="payrollCycleGenerateForm.metadata"
            name="payrollCycleGenMetadata"
            rows="2"
            placeholder="{}"
          />
        </label>
      </div>
      <div class="attendance__admin-actions">
        <button
          class="attendance__btn attendance__btn--primary"
          :disabled="payrollCycleGenerating"
          @click="generatePayrollCycles"
        >
          {{ payrollCycleGenerating ? tr('Generating...', '生成中...') : tr('Generate cycles', '生成周期') }}
        </button>
        <button class="attendance__btn" :disabled="payrollCycleGenerating" @click="resetPayrollCycleGenerateForm">
          {{ tr('Reset', '重置') }}
        </button>
        <span v-if="payrollCycleGenerateResult" class="attendance__empty">
          {{ tr('Created', '已创建') }} {{ payrollCycleGenerateResult.created }}，{{ tr('skipped', '跳过') }} {{ payrollCycleGenerateResult.skipped }}。
        </span>
      </div>
    </details>

    <div v-if="payrollCycleSummary" class="attendance__summary">
      <div class="attendance__summary-item">
        <span>{{ tr('Cycle total minutes', '周期总分钟数') }}</span>
        <strong>{{ payrollCycleSummary.total_minutes }}</strong>
      </div>
      <div class="attendance__summary-item">
        <span>{{ tr('Leave minutes', '请假分钟数') }}</span>
        <strong>{{ payrollCycleSummary.leave_minutes ?? 0 }}</strong>
      </div>
      <div class="attendance__summary-item">
        <span>{{ tr('Overtime minutes', '加班分钟数') }}</span>
        <strong>{{ payrollCycleSummary.overtime_minutes ?? 0 }}</strong>
      </div>
      <div class="attendance__summary-item">
        <span>{{ tr('Late minutes', '迟到分钟数') }}</span>
        <strong>{{ payrollCycleSummary.total_late_minutes ?? 0 }}</strong>
      </div>
      <div class="attendance__summary-item">
        <span>{{ tr('Early leave minutes', '早退分钟数') }}</span>
        <strong>{{ payrollCycleSummary.total_early_leave_minutes ?? 0 }}</strong>
      </div>
    </div>
    <div v-if="payrollCycles.length === 0" class="attendance__empty">{{ tr('No payroll cycles yet.', '暂无计薪周期。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Template', '模板') }}</th>
            <th>{{ tr('Start', '开始') }}</th>
            <th>{{ tr('End', '结束') }}</th>
            <th>{{ tr('Status', '状态') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in payrollCycles" :key="item.id">
            <td>{{ item.name || '--' }}</td>
            <td>{{ payrollTemplateName(item.templateId) }}</td>
            <td>{{ item.startDate }}</td>
            <td>{{ item.endDate }}</td>
            <td>{{ formatStatus(item.status) }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editPayrollCycle(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deletePayrollCycle(item.id)">
                {{ tr('Delete', '删除') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, type Ref } from 'vue'
import type {
  AttendancePayrollCycle,
  AttendancePayrollSummary,
  AttendancePayrollTemplate,
} from './useAttendanceAdminPayroll'
import {
  buildTimezoneOptionGroups,
  formatTimezoneOptionLabel,
  formatTimezoneStatusLabel,
} from './attendanceTimezones'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface PayrollTemplateFormState {
  name: string
  timezone: string
  startDay: number
  endDay: number
  endMonthOffset: number
  autoGenerate: boolean
  isDefault: boolean
  config: string
}

interface PayrollCycleFormState {
  templateId: string
  name: string
  anchorDate: string
  startDate: string
  endDate: string
  status: string
}

interface PayrollCycleGenerateFormState {
  templateId: string
  anchorDate: string
  count: number
  status: string
  namePrefix: string
  metadata: string
}

interface PayrollBindings {
  payrollTemplateLoading: Ref<boolean>
  payrollTemplateSaving: Ref<boolean>
  payrollCycleLoading: Ref<boolean>
  payrollCycleSaving: Ref<boolean>
  payrollCycleGenerating: Ref<boolean>
  payrollCycleGenerateResult: Ref<{ created: number; skipped: number } | null>
  payrollTemplates: Ref<AttendancePayrollTemplate[]>
  payrollCycles: Ref<AttendancePayrollCycle[]>
  payrollTemplateEditingId: Ref<string | null>
  payrollCycleEditingId: Ref<string | null>
  payrollCycleSummary: Ref<AttendancePayrollSummary | null>
  payrollTemplateForm: PayrollTemplateFormState
  payrollCycleForm: PayrollCycleFormState
  payrollCycleGenerateForm: PayrollCycleGenerateFormState
  payrollTemplateName: (templateId?: string | null) => string
  resetPayrollTemplateForm: () => MaybePromise<void>
  editPayrollTemplate: (item: AttendancePayrollTemplate) => MaybePromise<void>
  loadPayrollTemplates: () => MaybePromise<void>
  savePayrollTemplate: () => MaybePromise<void>
  deletePayrollTemplate: (id: string) => MaybePromise<void>
  resetPayrollCycleForm: () => MaybePromise<void>
  resetPayrollCycleGenerateForm: () => MaybePromise<void>
  editPayrollCycle: (item: AttendancePayrollCycle) => MaybePromise<void>
  loadPayrollCycles: () => MaybePromise<void>
  generatePayrollCycles: () => MaybePromise<void>
  savePayrollCycle: () => MaybePromise<void>
  deletePayrollCycle: (id: string) => MaybePromise<void>
  loadPayrollCycleSummary: () => MaybePromise<void>
  exportPayrollCycleSummary: () => MaybePromise<void>
}

const props = defineProps<{
  tr: Translate
  payroll: PayrollBindings
  formatStatus: (value: string) => string
}>()

const tr = props.tr
const formatStatus = props.formatStatus
const payrollTemplateLoading = props.payroll.payrollTemplateLoading
const payrollTemplateSaving = props.payroll.payrollTemplateSaving
const payrollCycleLoading = props.payroll.payrollCycleLoading
const payrollCycleSaving = props.payroll.payrollCycleSaving
const payrollCycleGenerating = props.payroll.payrollCycleGenerating
const payrollCycleGenerateResult = props.payroll.payrollCycleGenerateResult
const payrollTemplates = props.payroll.payrollTemplates
const payrollCycles = props.payroll.payrollCycles
const payrollTemplateEditingId = props.payroll.payrollTemplateEditingId
const payrollCycleEditingId = props.payroll.payrollCycleEditingId
const payrollCycleSummary = props.payroll.payrollCycleSummary
const payrollTemplateForm = props.payroll.payrollTemplateForm
const payrollCycleForm = props.payroll.payrollCycleForm
const payrollCycleGenerateForm = props.payroll.payrollCycleGenerateForm
const payrollTemplateTimezoneOptionGroups = computed(() => buildTimezoneOptionGroups(payrollTemplateForm.timezone))
const payrollTemplateTimezoneStatusLabel = computed(() => formatTimezoneStatusLabel(payrollTemplateForm.timezone))
const payrollTemplateName = props.payroll.payrollTemplateName
const resetPayrollTemplateForm = () => props.payroll.resetPayrollTemplateForm()
const editPayrollTemplate = (item: AttendancePayrollTemplate) => props.payroll.editPayrollTemplate(item)
const loadPayrollTemplates = () => props.payroll.loadPayrollTemplates()
const savePayrollTemplate = () => props.payroll.savePayrollTemplate()
const deletePayrollTemplate = (id: string) => props.payroll.deletePayrollTemplate(id)
const resetPayrollCycleForm = () => props.payroll.resetPayrollCycleForm()
const resetPayrollCycleGenerateForm = () => props.payroll.resetPayrollCycleGenerateForm()
const editPayrollCycle = (item: AttendancePayrollCycle) => props.payroll.editPayrollCycle(item)
const loadPayrollCycles = () => props.payroll.loadPayrollCycles()
const generatePayrollCycles = () => props.payroll.generatePayrollCycles()
const savePayrollCycle = () => props.payroll.savePayrollCycle()
const deletePayrollCycle = (id: string) => props.payroll.deletePayrollCycle(id)
const loadPayrollCycleSummary = () => props.payroll.loadPayrollCycleSummary()
const exportPayrollCycleSummary = () => props.payroll.exportPayrollCycleSummary()

function resolvePayrollTemplateTimezoneContext(templateId: string, emptyMode: 'manual' | 'default'): string {
  const normalizedTemplateId = templateId.trim()
  if (!normalizedTemplateId) {
    if (emptyMode === 'manual') {
      return tr('Manual', '手工')
    }
    const defaultTemplate = payrollTemplates.value.find(item => item.isDefault)
    if (!defaultTemplate) {
      return tr('Default template not found', '未找到默认模板')
    }
    return `${defaultTemplate.name} (${formatTimezoneStatusLabel(defaultTemplate.timezone)})`
  }

  const template = payrollTemplates.value.find(item => item.id === normalizedTemplateId)
  if (!template) return normalizedTemplateId
  return `${template.name} (${formatTimezoneStatusLabel(template.timezone)})`
}

function formatPayrollTemplateSelectLabel(template: AttendancePayrollTemplate): string {
  return `${template.name} (${formatTimezoneStatusLabel(template.timezone)})`
}

const payrollCycleGenerateDefaultOptionLabel = computed(() => {
  const defaultTemplate = payrollTemplates.value.find(item => item.isDefault)
  if (!defaultTemplate) {
    return tr('Default template', '默认模板')
  }
  return tr(
    `Default template (${defaultTemplate.name} · ${formatTimezoneStatusLabel(defaultTemplate.timezone)})`,
    `默认模板（${defaultTemplate.name} · ${formatTimezoneStatusLabel(defaultTemplate.timezone)}）`,
  )
})

const payrollCycleTemplateTimezoneHint = computed(() => (
  `${tr('Cycle template timezone', '周期模板时区')}: ${resolvePayrollTemplateTimezoneContext(payrollCycleForm.templateId, 'manual')}`
))

const payrollCycleGenerateTimezoneHint = computed(() => (
  `${tr('Generate timezone context', '生成时区上下文')}: ${resolvePayrollTemplateTimezoneContext(payrollCycleGenerateForm.templateId, 'default')}`
))
</script>

<style scoped>
.attendance__admin-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.attendance__admin-section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.attendance__admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.attendance__admin-grid--compact {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.attendance__admin-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__field--full {
  grid-column: 1 / -1;
}

.attendance__field--checkbox {
  justify-content: flex-end;
}

.attendance__btn {
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid #d0d0d0;
  background: #fff;
  cursor: pointer;
}

.attendance__btn--primary {
  background: #1f6feb;
  border-color: #1f6feb;
  color: #fff;
}

.attendance__btn--danger {
  color: #c62828;
}

.attendance__btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.attendance__table-wrapper {
  width: 100%;
  overflow-x: auto;
}

.attendance__table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
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

.attendance__details {
  border: 1px solid #e4e7eb;
  border-radius: 8px;
  padding: 12px;
  background: #fafbfc;
}

.attendance__details-summary {
  cursor: pointer;
  font-weight: 600;
  margin-bottom: 12px;
}

.attendance__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.attendance__summary-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border-radius: 8px;
  background: #f5f6f8;
}

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}
</style>
