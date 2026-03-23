<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Leave Types', '请假类型') }}</h4>
      <button class="attendance__btn" :disabled="leaveTypeLoading" @click="loadLeaveTypes">
        {{ leaveTypeLoading ? tr('Loading...', '加载中...') : tr('Reload leave types', '重载请假类型') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-leave-code">
        <span>{{ tr('Code', '编码') }}</span>
        <input
          id="attendance-leave-code"
          v-model="leaveTypeForm.code"
          name="leaveCode"
          type="text"
          :placeholder="tr('Auto-generated from name', '名称自动生成')"
        />
      </label>
      <label class="attendance__field" for="attendance-leave-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-leave-name" v-model="leaveTypeForm.name" name="leaveName" type="text" />
      </label>
      <label class="attendance__field" for="attendance-leave-minutes">
        <span>{{ tr('Minutes / day', '每日分钟数') }}</span>
        <input
          id="attendance-leave-minutes"
          v-model.number="leaveTypeForm.defaultMinutesPerDay"
          name="leaveMinutes"
          type="number"
          min="0"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-leave-approval">
        <span>{{ tr('Requires approval', '需要审批') }}</span>
        <input
          id="attendance-leave-approval"
          v-model="leaveTypeForm.requiresApproval"
          name="leaveRequiresApproval"
          type="checkbox"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-leave-paid">
        <span>{{ tr('Paid leave', '带薪假') }}</span>
        <input
          id="attendance-leave-paid"
          v-model="leaveTypeForm.paid"
          name="leavePaid"
          type="checkbox"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-leave-attachment">
        <span>{{ tr('Requires attachment', '需要附件') }}</span>
        <input
          id="attendance-leave-attachment"
          v-model="leaveTypeForm.requiresAttachment"
          name="leaveRequiresAttachment"
          type="checkbox"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-leave-active">
        <span>{{ tr('Active', '启用') }}</span>
        <input id="attendance-leave-active" v-model="leaveTypeForm.isActive" name="leaveActive" type="checkbox" />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="leaveTypeSaving" @click="saveLeaveType">
        {{ leaveTypeSaving ? tr('Saving...', '保存中...') : leaveTypeEditingId ? tr('Update leave type', '更新请假类型') : tr('Create leave type', '创建请假类型') }}
      </button>
      <button v-if="leaveTypeEditingId" class="attendance__btn" :disabled="leaveTypeSaving" @click="resetLeaveTypeForm">
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="leaveTypes.length === 0" class="attendance__empty">{{ tr('No leave types yet.', '暂无请假类型。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Code', '编码') }}</th>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Paid', '带薪') }}</th>
            <th>{{ tr('Approval', '审批') }}</th>
            <th>{{ tr('Attachment', '附件') }}</th>
            <th>{{ tr('Minutes', '分钟') }}</th>
            <th>{{ tr('Active', '启用') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in leaveTypes" :key="item.id">
            <td>{{ item.code }}</td>
            <td>{{ item.name }}</td>
            <td>{{ item.paid ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td>{{ item.requiresApproval ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td>{{ item.requiresAttachment ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td>{{ item.defaultMinutesPerDay }}</td>
            <td>{{ item.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editLeaveType(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteLeaveType(item.id)">
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
      <h4>{{ tr('Overtime Rules', '加班规则') }}</h4>
      <button class="attendance__btn" :disabled="overtimeRuleLoading" @click="loadOvertimeRules">
        {{ overtimeRuleLoading ? tr('Loading...', '加载中...') : tr('Reload overtime rules', '重载加班规则') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-overtime-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-overtime-name" v-model="overtimeRuleForm.name" name="overtimeName" type="text" />
      </label>
      <label class="attendance__field" for="attendance-overtime-min">
        <span>{{ tr('Min minutes', '最小分钟数') }}</span>
        <input
          id="attendance-overtime-min"
          v-model.number="overtimeRuleForm.minMinutes"
          name="overtimeMinMinutes"
          type="number"
          min="0"
        />
      </label>
      <label class="attendance__field" for="attendance-overtime-rounding">
        <span>{{ tr('Rounding', '取整') }}</span>
        <input
          id="attendance-overtime-rounding"
          v-model.number="overtimeRuleForm.roundingMinutes"
          name="overtimeRounding"
          type="number"
          min="1"
        />
      </label>
      <label class="attendance__field" for="attendance-overtime-max">
        <span>{{ tr('Max / day', '每日上限') }}</span>
        <input
          id="attendance-overtime-max"
          v-model.number="overtimeRuleForm.maxMinutesPerDay"
          name="overtimeMax"
          type="number"
          min="0"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-overtime-approval">
        <span>{{ tr('Requires approval', '需要审批') }}</span>
        <input
          id="attendance-overtime-approval"
          v-model="overtimeRuleForm.requiresApproval"
          name="overtimeRequiresApproval"
          type="checkbox"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-overtime-active">
        <span>{{ tr('Active', '启用') }}</span>
        <input
          id="attendance-overtime-active"
          v-model="overtimeRuleForm.isActive"
          name="overtimeActive"
          type="checkbox"
        />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="overtimeRuleSaving" @click="saveOvertimeRule">
        {{ overtimeRuleSaving ? tr('Saving...', '保存中...') : overtimeRuleEditingId ? tr('Update rule', '更新规则') : tr('Create rule', '创建规则') }}
      </button>
      <button
        v-if="overtimeRuleEditingId"
        class="attendance__btn"
        :disabled="overtimeRuleSaving"
        @click="resetOvertimeRuleForm"
      >
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="overtimeRules.length === 0" class="attendance__empty">{{ tr('No overtime rules yet.', '暂无加班规则。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Min', '最小') }}</th>
            <th>{{ tr('Rounding', '取整') }}</th>
            <th>{{ tr('Max', '上限') }}</th>
            <th>{{ tr('Approval', '审批') }}</th>
            <th>{{ tr('Active', '启用') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rule in overtimeRules" :key="rule.id">
            <td>{{ rule.name }}</td>
            <td>{{ rule.minMinutes }}</td>
            <td>{{ rule.roundingMinutes }}</td>
            <td>{{ rule.maxMinutesPerDay }}</td>
            <td>{{ rule.requiresApproval ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td>{{ rule.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editOvertimeRule(rule)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteOvertimeRule(rule.id)">
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
      <h4>{{ tr('Approval Flows', '审批流') }}</h4>
      <button class="attendance__btn" :disabled="approvalFlowLoading" @click="loadApprovalFlows">
        {{ approvalFlowLoading ? tr('Loading...', '加载中...') : tr('Reload flows', '重载流程') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-approval-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-approval-name" v-model="approvalFlowForm.name" name="approvalName" type="text" />
      </label>
      <label class="attendance__field" for="attendance-approval-type">
        <span>{{ tr('Request type', '申请类型') }}</span>
        <select id="attendance-approval-type" v-model="approvalFlowForm.requestType" name="approvalType">
          <option value="missed_check_in">{{ tr('Missed check-in', '漏打上班卡') }}</option>
          <option value="missed_check_out">{{ tr('Missed check-out', '漏打下班卡') }}</option>
          <option value="time_correction">{{ tr('Time correction', '时间更正') }}</option>
          <option value="leave">{{ tr('Leave', '请假') }}</option>
          <option value="overtime">{{ tr('Overtime', '加班') }}</option>
        </select>
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-approval-active">
        <span>{{ tr('Active', '启用') }}</span>
        <input
          id="attendance-approval-active"
          v-model="approvalFlowForm.isActive"
          name="approvalActive"
          type="checkbox"
        />
      </label>
      <div class="attendance__field attendance__field--full">
        <div class="attendance__builder-header">
          <div class="attendance__builder-header-copy">
            <span class="attendance__builder-title">{{ tr('Visual approval builder', '可视化审批构建器') }}</span>
            <small class="attendance__field-hint">
              {{ tr('Build approval gates step by step. The JSON editor below stays synced for fallback edits.', '按步骤配置审批关卡，下方 JSON 编辑器会保持同步，作为高级兜底编辑入口。') }}
            </small>
          </div>
          <div class="attendance__builder-summary">
            <span class="attendance__builder-chip">{{ tr('Steps', '步骤') }}: {{ approvalFlowBuilderSummary.stepCount }}</span>
            <span class="attendance__builder-chip">{{ tr('Role gates', '角色关卡') }}: {{ approvalFlowBuilderSummary.roleAssignmentCount }}</span>
            <span class="attendance__builder-chip">{{ tr('Direct users', '指定用户') }}: {{ approvalFlowBuilderSummary.directUserCount }}</span>
          </div>
        </div>
        <div class="attendance__builder-templates">
          <button
            v-for="template in approvalFlowTemplates"
            :key="template.id"
            class="attendance__btn attendance__builder-template"
            type="button"
            @click="applyApprovalFlowTemplate(template.id)"
          >
            <strong>{{ template.label }}</strong>
            <small>{{ template.description }}</small>
          </button>
        </div>
        <div v-if="approvalFlowBuilderSteps.length === 0" class="attendance__empty">
          {{ tr('No approval steps yet. Start from a template or add a custom step.', '暂未配置审批步骤。可先套用模板，或手动添加自定义步骤。') }}
        </div>
        <div v-else class="attendance__builder-list">
          <div v-for="(step, index) in approvalFlowBuilderSteps" :key="step.id" class="attendance__builder-card">
            <div class="attendance__builder-card-header">
              <strong>{{ tr('Step', '步骤') }} {{ index + 1 }}</strong>
              <button class="attendance__btn" type="button" @click="removeApprovalFlowBuilderStep(index)">
                {{ tr('Remove', '移除') }}
              </button>
            </div>
            <div class="attendance__admin-grid">
              <label class="attendance__field" :for="`attendance-approval-step-name-${step.id}`">
                <span>{{ tr('Step name', '步骤名称') }}</span>
                <input
                  :id="`attendance-approval-step-name-${step.id}`"
                  v-model="step.name"
                  type="text"
                  :placeholder="tr('Manager review', '直属主管审批')"
                />
              </label>
              <label class="attendance__field" :for="`attendance-approval-step-roles-${step.id}`">
                <span>{{ tr('Approver role IDs', '审批角色 ID') }}</span>
                <input
                  :id="`attendance-approval-step-roles-${step.id}`"
                  v-model="step.approverRoleIdsText"
                  type="text"
                  :placeholder="tr('manager, hr', 'manager, hr')"
                />
              </label>
              <label class="attendance__field" :for="`attendance-approval-step-users-${step.id}`">
                <span>{{ tr('Approver user IDs', '审批用户 ID') }}</span>
                <input
                  :id="`attendance-approval-step-users-${step.id}`"
                  v-model="step.approverUserIdsText"
                  type="text"
                  :placeholder="tr('user-1, user-2', 'user-1, user-2')"
                />
              </label>
            </div>
            <small class="attendance__field-hint">
              {{ summarizeBuilderStep(step) }}
            </small>
          </div>
        </div>
        <div class="attendance__admin-actions">
          <button class="attendance__btn" type="button" @click="addApprovalFlowBuilderStep()">
            {{ tr('Add step', '添加步骤') }}
          </button>
        </div>
      </div>
      <div class="attendance__field attendance__field--full attendance__builder-handoff">
        <div class="attendance__builder-header">
          <div class="attendance__builder-header-copy">
            <span class="attendance__builder-title">{{ tr('Workflow designer handoff', '流程设计器接力') }}</span>
            <small class="attendance__field-hint">
              {{ tr('Send the current approval draft into the attendance workflow designer and auto-apply the recommended starter template. This does not replace the live attendance approval engine.', '把当前审批草稿带入考勤流程设计器，并自动套用推荐起步模板。它不会替换当前生效的考勤审批执行引擎。') }}
            </small>
          </div>
          <div class="attendance__builder-summary">
            <span class="attendance__builder-chip">{{ tr('Starter', '推荐起步模板') }}: {{ workflowStarterLabel }}</span>
            <span class="attendance__builder-chip">{{ tr('Flow name', '流程名称') }}: {{ workflowHandoffFlowName }}</span>
          </div>
        </div>
        <div class="attendance__admin-actions">
          <button
            class="attendance__btn attendance__btn--primary"
            type="button"
            :disabled="!canOpenWorkflowDesigner"
            @click="openWorkflowDesignerFromApprovalFlow"
          >
            {{ canOpenWorkflowDesigner ? tr('Open in workflow designer', '在流程设计器中打开') : tr('Workflow capability required', '需要流程能力') }}
          </button>
          <button
            v-if="linkedWorkflowId"
            class="attendance__btn"
            type="button"
            @click="openLinkedWorkflowDraft"
          >
            {{ tr('Open linked draft', '打开已关联草稿') }}
          </button>
          <button
            v-if="approvalFlowEditingId && linkedWorkflowId"
            class="attendance__btn"
            type="button"
            @click="clearLinkedWorkflowDraft"
          >
            {{ tr('Clear link', '清除关联') }}
          </button>
        </div>
        <div class="attendance__builder-link-state">
          <strong>{{ tr('Linked workflow draft', '已关联工作流草稿') }}:</strong>
          <span v-if="linkedWorkflowId">{{ linkedWorkflowId }}</span>
          <span v-else>{{ tr('No linked workflow draft', '暂无已关联工作流草稿') }}</span>
        </div>
        <small class="attendance__field-hint">
          {{ tr('The workflow designer will receive request type, flow name, step count, and step summary, then seed a starter draft with the recommended template.', '流程设计器会接收申请类型、流程名称、步骤数量和步骤摘要，并用推荐模板生成起步草稿。') }}
        </small>
        <small v-if="!approvalFlowEditingId" class="attendance__field-hint">
          {{ tr('Save the approval flow first if you want to keep a persistent workflow draft link.', '如需保留正式工作流草稿关联，请先保存当前审批流程。') }}
        </small>
      </div>
      <label class="attendance__field attendance__field--full" for="attendance-approval-steps">
        <span>{{ tr('Advanced JSON fallback', '高级 JSON 兜底') }}</span>
        <textarea
          id="attendance-approval-steps"
          v-model="approvalFlowForm.steps"
          name="approvalSteps"
          rows="8"
          placeholder='[{"name":"Manager","approverRoleIds":["manager"]}]'
        />
        <small class="attendance__field-hint">
          {{ tr('Use JSON only for bulk edits or compatibility checks. Supported step fields are name, approverUserIds, and approverRoleIds.', '建议仅在批量编辑或兼容性检查时使用 JSON。当前支持的步骤字段为 name、approverUserIds 和 approverRoleIds。') }}
        </small>
        <small v-if="approvalFlowBuilderError" class="attendance__field-hint attendance__field-hint--danger">
          {{ approvalFlowBuilderError }}
        </small>
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="approvalFlowSaving" @click="saveApprovalFlow">
        {{ approvalFlowSaving ? tr('Saving...', '保存中...') : approvalFlowEditingId ? tr('Update flow', '更新流程') : tr('Create flow', '创建流程') }}
      </button>
      <button
        v-if="approvalFlowEditingId"
        class="attendance__btn"
        :disabled="approvalFlowSaving"
        @click="resetApprovalFlowForm"
      >
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="approvalFlows.length === 0" class="attendance__empty">{{ tr('No approval flows yet.', '暂无审批流程。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Request', '申请') }}</th>
            <th>{{ tr('Steps', '步骤') }}</th>
            <th>{{ tr('Active', '启用') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="flow in approvalFlows" :key="flow.id">
            <td>{{ flow.name }}</td>
            <td>{{ formatRequestType(flow.requestType) }}</td>
            <td>
              <div>{{ flow.steps.length }}</div>
              <small class="attendance__field-hint">{{ summarizeFlowSteps(flow.steps) }}</small>
            </td>
            <td>{{ flow.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editApprovalFlow(flow)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteApprovalFlow(flow.id)">
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
import { useRouter } from 'vue-router'
import type {
  AttendanceApprovalBuilderStep,
  AttendanceApprovalFlow,
  AttendanceApprovalFlowTemplateChoice,
  AttendanceApprovalStep,
  AttendanceLeaveType,
  AttendanceOvertimeRule,
} from './useAttendanceAdminLeavePolicies'
import { useFeatureFlags } from '../../stores/featureFlags'
import {
  buildAttendanceWorkflowHandoffQuery,
  formatAttendanceWorkflowStarterLabel,
  resolveAttendanceWorkflowStarterId,
} from './attendanceWorkflowHandoff'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface LeaveTypeFormState {
  code: string
  name: string
  paid: boolean
  requiresApproval: boolean
  requiresAttachment: boolean
  defaultMinutesPerDay: number
  isActive: boolean
}

interface OvertimeRuleFormState {
  name: string
  minMinutes: number
  roundingMinutes: number
  maxMinutesPerDay: number
  requiresApproval: boolean
  isActive: boolean
}

interface ApprovalFlowFormState {
  name: string
  requestType: string
  workflowId: string
  steps: string
  isActive: boolean
}

interface LeavePoliciesBindings {
  leaveTypes: Ref<AttendanceLeaveType[]>
  leaveTypeLoading: Ref<boolean>
  leaveTypeSaving: Ref<boolean>
  leaveTypeEditingId: Ref<string | null>
  leaveTypeForm: LeaveTypeFormState
  resetLeaveTypeForm: () => MaybePromise<void>
  editLeaveType: (item: AttendanceLeaveType) => MaybePromise<void>
  loadLeaveTypes: () => MaybePromise<void>
  saveLeaveType: () => MaybePromise<void>
  deleteLeaveType: (id: string) => MaybePromise<void>
  overtimeRules: Ref<AttendanceOvertimeRule[]>
  overtimeRuleLoading: Ref<boolean>
  overtimeRuleSaving: Ref<boolean>
  overtimeRuleEditingId: Ref<string | null>
  overtimeRuleForm: OvertimeRuleFormState
  resetOvertimeRuleForm: () => MaybePromise<void>
  editOvertimeRule: (item: AttendanceOvertimeRule) => MaybePromise<void>
  loadOvertimeRules: () => MaybePromise<void>
  saveOvertimeRule: () => MaybePromise<void>
  deleteOvertimeRule: (id: string) => MaybePromise<void>
  approvalFlows: Ref<AttendanceApprovalFlow[]>
  approvalFlowLoading: Ref<boolean>
  approvalFlowSaving: Ref<boolean>
  approvalFlowEditingId: Ref<string | null>
  approvalFlowForm: ApprovalFlowFormState
  approvalFlowBuilderSteps: Ref<AttendanceApprovalBuilderStep[]>
  approvalFlowBuilderError: Ref<string>
  approvalFlowBuilderSummary: Ref<{
    stepCount: number
    roleAssignmentCount: number
    directUserCount: number
    placeholderCount: number
  }>
  approvalFlowTemplates: Ref<AttendanceApprovalFlowTemplateChoice[]>
  addApprovalFlowBuilderStep: () => MaybePromise<void>
  removeApprovalFlowBuilderStep: (index: number) => MaybePromise<void>
  applyApprovalFlowTemplate: (templateId: string) => MaybePromise<void>
  resetApprovalFlowForm: () => MaybePromise<void>
  editApprovalFlow: (item: AttendanceApprovalFlow) => MaybePromise<void>
  loadApprovalFlows: () => MaybePromise<void>
  saveApprovalFlow: () => MaybePromise<void>
  deleteApprovalFlow: (id: string) => MaybePromise<void>
  linkApprovalFlowWorkflow: (flowId: string, workflowId: string | null) => MaybePromise<unknown>
}

const props = defineProps<{
  tr: Translate
  policies: LeavePoliciesBindings
  formatRequestType: (value: string) => string
}>()

const tr = props.tr
const router = useRouter()
const { hasFeature } = useFeatureFlags()
const formatRequestType = props.formatRequestType
const leaveTypes = props.policies.leaveTypes
const leaveTypeLoading = props.policies.leaveTypeLoading
const leaveTypeSaving = props.policies.leaveTypeSaving
const leaveTypeEditingId = props.policies.leaveTypeEditingId
const leaveTypeForm = props.policies.leaveTypeForm
const resetLeaveTypeForm = () => props.policies.resetLeaveTypeForm()
const editLeaveType = (item: AttendanceLeaveType) => props.policies.editLeaveType(item)
const loadLeaveTypes = () => props.policies.loadLeaveTypes()
const saveLeaveType = () => props.policies.saveLeaveType()
const deleteLeaveType = (id: string) => props.policies.deleteLeaveType(id)
const overtimeRules = props.policies.overtimeRules
const overtimeRuleLoading = props.policies.overtimeRuleLoading
const overtimeRuleSaving = props.policies.overtimeRuleSaving
const overtimeRuleEditingId = props.policies.overtimeRuleEditingId
const overtimeRuleForm = props.policies.overtimeRuleForm
const resetOvertimeRuleForm = () => props.policies.resetOvertimeRuleForm()
const editOvertimeRule = (item: AttendanceOvertimeRule) => props.policies.editOvertimeRule(item)
const loadOvertimeRules = () => props.policies.loadOvertimeRules()
const saveOvertimeRule = () => props.policies.saveOvertimeRule()
const deleteOvertimeRule = (id: string) => props.policies.deleteOvertimeRule(id)
const approvalFlows = props.policies.approvalFlows
const approvalFlowLoading = props.policies.approvalFlowLoading
const approvalFlowSaving = props.policies.approvalFlowSaving
const approvalFlowEditingId = props.policies.approvalFlowEditingId
const approvalFlowForm = props.policies.approvalFlowForm
const approvalFlowBuilderSteps = props.policies.approvalFlowBuilderSteps
const approvalFlowBuilderError = props.policies.approvalFlowBuilderError
const approvalFlowBuilderSummary = props.policies.approvalFlowBuilderSummary
const approvalFlowTemplates = props.policies.approvalFlowTemplates
const addApprovalFlowBuilderStep = () => props.policies.addApprovalFlowBuilderStep()
const removeApprovalFlowBuilderStep = (index: number) => props.policies.removeApprovalFlowBuilderStep(index)
const applyApprovalFlowTemplate = (templateId: string) => props.policies.applyApprovalFlowTemplate(templateId)
const resetApprovalFlowForm = () => props.policies.resetApprovalFlowForm()
const editApprovalFlow = (item: AttendanceApprovalFlow) => props.policies.editApprovalFlow(item)
const loadApprovalFlows = () => props.policies.loadApprovalFlows()
const saveApprovalFlow = () => props.policies.saveApprovalFlow()
const deleteApprovalFlow = (id: string) => props.policies.deleteApprovalFlow(id)
const linkApprovalFlowWorkflow = (flowId: string, workflowId: string | null) => props.policies.linkApprovalFlowWorkflow(flowId, workflowId)
const canOpenWorkflowDesigner = computed(() => hasFeature('workflow'))
const linkedWorkflowId = computed(() => approvalFlowForm.workflowId.trim())

const workflowStarterLabel = computed(() => {
  const starterId = resolveAttendanceWorkflowStarterId(
    approvalFlowForm.requestType,
    approvalFlowBuilderSummary.value.stepCount,
  )
  return formatAttendanceWorkflowStarterLabel(starterId, tr)
})

const workflowHandoffFlowName = computed(() => {
  const name = approvalFlowForm.name.trim()
  if (name) return name
  return formatRequestType(approvalFlowForm.requestType)
})

function parseList(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function summarizeBuilderStep(step: AttendanceApprovalBuilderStep): string {
  const name = step.name.trim() || `${tr('Step', '步骤')}`
  const roleIds = parseList(step.approverRoleIdsText)
  const userIds = parseList(step.approverUserIdsText)
  const roleSummary = roleIds.length > 0 ? roleIds.join(', ') : tr('Any role', '任意角色')
  const userSummary = userIds.length > 0 ? userIds.join(', ') : tr('No direct users', '未指定用户')
  return `${name} | ${tr('Roles', '角色')}: ${roleSummary} | ${tr('Users', '用户')}: ${userSummary}`
}

function summarizeFlowSteps(steps: AttendanceApprovalStep[]): string {
  if (!Array.isArray(steps) || steps.length === 0) {
    return tr('No steps configured', '尚未配置步骤')
  }
  return steps
    .map((step, index) => {
      const name = typeof step.name === 'string' && step.name.trim()
        ? step.name.trim()
        : `${tr('Step', '步骤')} ${index + 1}`
      return name
    })
    .join(' -> ')
}

async function openWorkflowDesignerFromApprovalFlow(): Promise<void> {
  if (!canOpenWorkflowDesigner.value) return
  await router.push({
    name: 'attendance',
    query: buildAttendanceWorkflowHandoffQuery({
      requestType: approvalFlowForm.requestType,
      approvalFlowId: approvalFlowEditingId.value,
      approvalFlowName: approvalFlowForm.name,
      steps: approvalFlowBuilderSteps.value,
    }),
  })
}

async function openLinkedWorkflowDraft(): Promise<void> {
  if (!linkedWorkflowId.value) return
  await router.push({
    name: 'workflow-designer',
    params: { id: linkedWorkflowId.value },
  })
}

async function clearLinkedWorkflowDraft(): Promise<void> {
  if (!approvalFlowEditingId.value) return
  await linkApprovalFlowWorkflow(approvalFlowEditingId.value, null)
}
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

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__field-hint--danger {
  color: #c62828;
}

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}

.attendance__builder-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
}

.attendance__builder-header-copy {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.attendance__builder-title {
  font-size: 13px;
  font-weight: 600;
}

.attendance__builder-summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__builder-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 999px;
  background: #f3f6fb;
  color: #315ea8;
  font-size: 12px;
}

.attendance__builder-templates {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.attendance__builder-template {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  max-width: 260px;
  text-align: left;
}

.attendance__builder-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.attendance__builder-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid #e0e6ef;
  border-radius: 8px;
  background: #fafcff;
}

.attendance__builder-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.attendance__builder-handoff {
  border: 1px solid #d8e3f4;
  border-radius: 10px;
  padding: 12px;
  background: #f7fbff;
}

.attendance__builder-link-state {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #475569;
}
</style>
