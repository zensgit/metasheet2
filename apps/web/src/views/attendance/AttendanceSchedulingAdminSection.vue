<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Default Rule', '默认规则') }}</h4>
      <button class="attendance__btn" :disabled="ruleLoading" @click="loadRule">
        {{ ruleLoading ? tr('Loading...', '加载中...') : tr('Reload rule', '重载规则') }}
      </button>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-rule-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-rule-name" v-model="ruleForm.name" name="ruleName" type="text" />
      </label>
      <label class="attendance__field" for="attendance-rule-timezone">
        <span>{{ tr('Timezone', '时区') }}</span>
        <input id="attendance-rule-timezone" v-model="ruleForm.timezone" name="ruleTimezone" type="text" />
      </label>
      <label class="attendance__field" for="attendance-rule-start">
        <span>{{ tr('Work start', '上班时间') }}</span>
        <input id="attendance-rule-start" v-model="ruleForm.workStartTime" name="ruleWorkStartTime" type="time" />
      </label>
      <label class="attendance__field" for="attendance-rule-end">
        <span>{{ tr('Work end', '下班时间') }}</span>
        <input id="attendance-rule-end" v-model="ruleForm.workEndTime" name="ruleWorkEndTime" type="time" />
      </label>
      <label class="attendance__field" for="attendance-rule-late-grace">
        <span>{{ tr('Late grace (min)', '迟到宽限（分钟）') }}</span>
        <input id="attendance-rule-late-grace" v-model.number="ruleForm.lateGraceMinutes" name="ruleLateGraceMinutes" type="number" min="0" />
      </label>
      <label class="attendance__field" for="attendance-rule-early-grace">
        <span>{{ tr('Early grace (min)', '早退宽限（分钟）') }}</span>
        <input id="attendance-rule-early-grace" v-model.number="ruleForm.earlyGraceMinutes" name="ruleEarlyGraceMinutes" type="number" min="0" />
      </label>
      <label class="attendance__field" for="attendance-rule-rounding">
        <span>{{ tr('Rounding (min)', '取整（分钟）') }}</span>
        <input id="attendance-rule-rounding" v-model.number="ruleForm.roundingMinutes" name="ruleRoundingMinutes" type="number" min="0" />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-rule-working-days">
        <span>{{ tr('Working days (0-6)', '工作日（0-6）') }}</span>
        <input id="attendance-rule-working-days" v-model="ruleForm.workingDays" name="ruleWorkingDays" type="text" placeholder="1,2,3,4,5" />
      </label>
    </div>
    <button class="attendance__btn attendance__btn--primary" :disabled="ruleLoading" @click="saveRule">
      {{ ruleLoading ? tr('Saving...', '保存中...') : tr('Save rule', '保存规则') }}
    </button>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Rotation Rules', '轮班规则') }}</h4>
      <button class="attendance__btn" :disabled="rotationRuleLoading" @click="loadRotationRules">
        {{ rotationRuleLoading ? tr('Loading...', '加载中...') : tr('Reload rotation rules', '重载轮班规则') }}
      </button>
    </div>
    <div class="attendance__section-meta">
      {{ tr('Rotation rules', '轮班规则') }}: {{ rotationRules.length }}
      <span v-if="rotationRuleEditingId"> · {{ rotationRuleEditingLabel }}</span>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-rotation-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input id="attendance-rotation-name" v-model="rotationRuleForm.name" name="rotationName" type="text" />
      </label>
      <label class="attendance__field" for="attendance-rotation-timezone">
        <span>{{ tr('Timezone', '时区') }}</span>
        <input
          id="attendance-rotation-timezone"
          v-model="rotationRuleForm.timezone"
          name="rotationTimezone"
          type="text"
        />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-rotation-sequence">
        <span>{{ tr('Shift sequence (IDs)', '班次序列（ID）') }}</span>
        <input
          id="attendance-rotation-sequence"
          v-model="rotationRuleForm.shiftSequence"
          name="rotationSequence"
          type="text"
          :placeholder="tr('shiftId1, shiftId2', '班次ID1, 班次ID2')"
        />
        <small class="attendance__field-hint">
          {{ tr('Separate shift IDs with commas. Use the quick append buttons below to build the sequence in order, and repeat a shift if the cycle needs duplicates.', '请用英文逗号分隔班次 ID。可用下方快捷按钮按顺序拼接，如需重复班次可重复点击。') }}
        </small>
        <div v-if="shifts.length > 0" class="attendance__sequence-builder">
          <span class="attendance__field-hint">{{ tr('Quick append from existing shifts', '从已有班次快捷拼接') }}</span>
          <div class="attendance__sequence-builder-actions">
            <button
              v-for="shift in shifts"
              :key="shift.id"
              class="attendance__btn attendance__btn--inline"
              type="button"
              @click="appendShiftToRotationSequence(shift.id)"
            >
              {{ shift.name }} · {{ shift.id }}
            </button>
          </div>
        </div>
        <small v-if="rotationSequencePreviewText" class="attendance__field-hint">
          {{ tr('Current sequence', '当前序列') }}: {{ rotationSequencePreviewText }}
        </small>
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-rotation-rule-active">
        <span>{{ tr('Active', '启用') }}</span>
        <input
          id="attendance-rotation-rule-active"
          v-model="rotationRuleForm.isActive"
          name="rotationRuleActive"
          type="checkbox"
        />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="rotationRuleSaving" @click="saveRotationRule">
        {{ rotationRuleSaving ? tr('Saving...', '保存中...') : rotationRuleEditingId ? tr('Update rotation', '更新轮班') : tr('Create rotation', '创建轮班') }}
      </button>
      <button
        v-if="rotationRuleEditingId"
        class="attendance__btn"
        :disabled="rotationRuleSaving"
        @click="resetRotationRuleForm"
      >
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="rotationRules.length === 0" class="attendance__empty">{{ tr('No rotation rules yet.', '暂无轮班规则。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Timezone', '时区') }}</th>
            <th>{{ tr('Sequence', '序列') }}</th>
            <th>{{ tr('Active', '启用') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="rule in rotationRules" :key="rule.id">
            <td>{{ rule.name }}</td>
            <td>{{ rule.timezone }}</td>
            <td>{{ rule.shiftSequence.join(', ') }}</td>
            <td>{{ rule.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editRotationRule(rule)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteRotationRule(rule.id)">
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
      <h4>{{ tr('Rotation Assignments', '轮班分配') }}</h4>
      <button class="attendance__btn" :disabled="rotationAssignmentLoading" @click="loadRotationAssignments">
        {{ rotationAssignmentLoading ? tr('Loading...', '加载中...') : tr('Reload rotations', '重载轮班分配') }}
      </button>
    </div>
    <div class="attendance__section-meta">
      {{ tr('Rotation assignments', '轮班分配') }}: {{ rotationAssignments.length }}
      <span v-if="rotationAssignmentEditingId"> · {{ rotationAssignmentEditingLabel }}</span>
    </div>
    <div class="attendance__admin-grid">
      <AttendanceUserPickerField
        v-model="rotationAssignmentForm.userId"
        :tr="tr"
        :label="tr('User', '用户')"
        name="rotationUserId"
        :help-text="tr('Search by email, name, or user ID, then pick a user for this rotation.', '按邮箱、姓名或用户 ID 搜索，然后为该轮班选择用户。')"
        :search-placeholder="tr('Search users for rotation assignment', '搜索轮班分配用户')"
        :full-width="false"
        input-id="attendance-rotation-user"
      />
      <label class="attendance__field" for="attendance-rotation-rule">
        <span>{{ tr('Rotation rule', '轮班规则') }}</span>
        <select
          id="attendance-rotation-rule"
          v-model="rotationAssignmentForm.rotationRuleId"
          name="rotationRuleId"
          :disabled="rotationRules.length === 0"
        >
          <option value="" disabled>{{ tr('Select rotation', '选择轮班') }}</option>
          <option v-for="rule in rotationRules" :key="rule.id" :value="rule.id">
            {{ rule.name }}
          </option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-rotation-start">
        <span>{{ tr('Start date', '开始日期') }}</span>
        <input
          id="attendance-rotation-start"
          v-model="rotationAssignmentForm.startDate"
          name="rotationStartDate"
          type="date"
        />
      </label>
      <label class="attendance__field" for="attendance-rotation-end">
        <span>{{ tr('End date', '结束日期') }}</span>
        <input
          id="attendance-rotation-end"
          v-model="rotationAssignmentForm.endDate"
          name="rotationEndDate"
          type="date"
        />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-rotation-active">
        <span>{{ tr('Active', '启用') }}</span>
        <input
          id="attendance-rotation-active"
          v-model="rotationAssignmentForm.isActive"
          name="rotationActive"
          type="checkbox"
        />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button
        class="attendance__btn attendance__btn--primary"
        :disabled="rotationAssignmentSaving"
        @click="saveRotationAssignment"
      >
        {{ rotationAssignmentSaving ? tr('Saving...', '保存中...') : rotationAssignmentEditingId ? tr('Update assignment', '更新分配') : tr('Create assignment', '创建分配') }}
      </button>
      <button
        v-if="rotationAssignmentEditingId"
        class="attendance__btn"
        :disabled="rotationAssignmentSaving"
        @click="resetRotationAssignmentForm"
      >
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="rotationAssignments.length === 0" class="attendance__empty">{{ tr('No rotation assignments yet.', '暂无轮班分配。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('User', '用户') }}</th>
            <th>{{ tr('Rotation', '轮班') }}</th>
            <th>{{ tr('Start', '开始') }}</th>
            <th>{{ tr('End', '结束') }}</th>
            <th>{{ tr('Active', '启用') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in rotationAssignments" :key="item.assignment.id">
            <td>{{ item.assignment.userId }}</td>
            <td>{{ item.rotation.name }}</td>
            <td>{{ item.assignment.startDate }}</td>
            <td>{{ item.assignment.endDate || '--' }}</td>
            <td>{{ item.assignment.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editRotationAssignment(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteRotationAssignment(item.assignment.id)">
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
      <h4>{{ tr('Shifts', '班次') }}</h4>
      <button class="attendance__btn" :disabled="shiftLoading" @click="loadShifts">
        {{ shiftLoading ? tr('Loading...', '加载中...') : tr('Reload shifts', '重载班次') }}
      </button>
    </div>
    <div class="attendance__section-meta">
      {{ tr('Shifts', '班次') }}: {{ shifts.length }}
      <span v-if="shiftEditingId"> · {{ shiftEditingLabel }}</span>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field" for="attendance-shift-name">
        <span>{{ tr('Name', '名称') }}</span>
        <input
          id="attendance-shift-name"
          v-model="shiftForm.name"
          name="shiftName"
          type="text"
          required
          :placeholder="tr('Required shift name', '必填班次名称')"
        />
      </label>
      <label class="attendance__field" for="attendance-shift-timezone">
        <span>{{ tr('Timezone', '时区') }}</span>
        <input id="attendance-shift-timezone" v-model="shiftForm.timezone" name="shiftTimezone" type="text" />
      </label>
      <label class="attendance__field" for="attendance-shift-start">
        <span>{{ tr('Work start', '上班开始') }}</span>
        <input id="attendance-shift-start" v-model="shiftForm.workStartTime" name="shiftWorkStartTime" type="time" />
      </label>
      <label class="attendance__field" for="attendance-shift-end">
        <span>{{ tr('Work end', '下班结束') }}</span>
        <input id="attendance-shift-end" v-model="shiftForm.workEndTime" name="shiftWorkEndTime" type="time" />
      </label>
      <label class="attendance__field" for="attendance-shift-late-grace">
        <span>{{ tr('Late grace (min)', '迟到宽限（分钟）') }}</span>
        <input
          id="attendance-shift-late-grace"
          v-model.number="shiftForm.lateGraceMinutes"
          name="shiftLateGraceMinutes"
          type="number"
          min="0"
        />
      </label>
      <label class="attendance__field" for="attendance-shift-early-grace">
        <span>{{ tr('Early grace (min)', '早退宽限（分钟）') }}</span>
        <input
          id="attendance-shift-early-grace"
          v-model.number="shiftForm.earlyGraceMinutes"
          name="shiftEarlyGraceMinutes"
          type="number"
          min="0"
        />
      </label>
      <label class="attendance__field" for="attendance-shift-rounding">
        <span>{{ tr('Rounding (min)', '取整（分钟）') }}</span>
        <input
          id="attendance-shift-rounding"
          v-model.number="shiftForm.roundingMinutes"
          name="shiftRoundingMinutes"
          type="number"
          min="0"
        />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-shift-working-days">
        <span>{{ tr('Working days (0-6)', '工作日（0-6）') }}</span>
        <input
          id="attendance-shift-working-days"
          v-model="shiftForm.workingDays"
          name="shiftWorkingDays"
          type="text"
          :placeholder="tr('1,2,3,4,5', '1,2,3,4,5')"
        />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="shiftSaving" @click="saveShift">
        {{ shiftSaving ? tr('Saving...', '保存中...') : shiftEditingId ? tr('Update shift', '更新班次') : tr('Create shift', '创建班次') }}
      </button>
      <button v-if="shiftEditingId" class="attendance__btn" :disabled="shiftSaving" @click="resetShiftForm">
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="shifts.length === 0" class="attendance__empty">{{ tr('No shifts yet.', '暂无班次。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('Name', '名称') }}</th>
            <th>{{ tr('Timezone', '时区') }}</th>
            <th>{{ tr('Start', '开始') }}</th>
            <th>{{ tr('End', '结束') }}</th>
            <th>{{ tr('Working days', '工作日') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="shift in shifts" :key="shift.id">
            <td>{{ shift.name }}</td>
            <td>{{ shift.timezone }}</td>
            <td>{{ shift.workStartTime }}</td>
            <td>{{ shift.workEndTime }}</td>
            <td>{{ shift.workingDays.join(',') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editShift(shift)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteShift(shift.id)">
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
      <h4>{{ tr('Assignments', '排班分配') }}</h4>
      <button class="attendance__btn" :disabled="assignmentLoading" @click="loadAssignments">
        {{ assignmentLoading ? tr('Loading...', '加载中...') : tr('Reload assignments', '重载分配') }}
      </button>
    </div>
    <div class="attendance__section-meta">
      {{ tr('Shift assignments', '排班分配') }}: {{ assignments.length }}
      <span v-if="assignmentEditingId"> · {{ assignmentEditingLabel }}</span>
    </div>
    <div class="attendance__admin-grid">
      <AttendanceUserPickerField
        v-model="assignmentForm.userId"
        :tr="tr"
        :label="tr('User', '用户')"
        name="assignmentUserId"
        :help-text="tr('Search by email, name, or user ID, then pick a user for this shift assignment.', '按邮箱、姓名或用户 ID 搜索，然后为该班次选择用户。')"
        :search-placeholder="tr('Search users for shift assignment', '搜索班次分配用户')"
        :full-width="false"
        input-id="attendance-assignment-user-id"
      />
      <label class="attendance__field" for="attendance-assignment-shift-id">
        <span>{{ tr('Shift', '班次') }}</span>
        <select
          id="attendance-assignment-shift-id"
          v-model="assignmentForm.shiftId"
          name="assignmentShiftId"
          :disabled="shifts.length === 0"
        >
          <option value="" disabled>{{ tr('Select shift', '选择班次') }}</option>
          <option v-for="shift in shifts" :key="shift.id" :value="shift.id">
            {{ shift.name }}
          </option>
        </select>
      </label>
      <label class="attendance__field" for="attendance-assignment-start-date">
        <span>{{ tr('Start date', '开始日期') }}</span>
        <input
          id="attendance-assignment-start-date"
          v-model="assignmentForm.startDate"
          name="assignmentStartDate"
          type="date"
        />
      </label>
      <label class="attendance__field" for="attendance-assignment-end-date">
        <span>{{ tr('End date', '结束日期') }}</span>
        <input id="attendance-assignment-end-date" v-model="assignmentForm.endDate" name="assignmentEndDate" type="date" />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-assignment-active">
        <span>{{ tr('Active', '启用') }}</span>
        <input
          id="attendance-assignment-active"
          v-model="assignmentForm.isActive"
          name="assignmentActive"
          type="checkbox"
        />
      </label>
    </div>
    <div class="attendance__admin-actions">
      <button class="attendance__btn attendance__btn--primary" :disabled="assignmentSaving" @click="saveAssignment">
        {{ assignmentSaving ? tr('Saving...', '保存中...') : assignmentEditingId ? tr('Update assignment', '更新分配') : tr('Create assignment', '创建分配') }}
      </button>
      <button
        v-if="assignmentEditingId"
        class="attendance__btn"
        :disabled="assignmentSaving"
        @click="resetAssignmentForm"
      >
        {{ tr('Cancel edit', '取消编辑') }}
      </button>
    </div>
    <div v-if="assignments.length === 0" class="attendance__empty">{{ tr('No assignments yet.', '暂无排班分配。') }}</div>
    <div v-else class="attendance__table-wrapper">
      <table class="attendance__table">
        <thead>
          <tr>
            <th>{{ tr('User', '用户') }}</th>
            <th>{{ tr('Shift', '班次') }}</th>
            <th>{{ tr('Start', '开始') }}</th>
            <th>{{ tr('End', '结束') }}</th>
            <th>{{ tr('Active', '启用') }}</th>
            <th>{{ tr('Actions', '操作') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in assignments" :key="item.assignment.id">
            <td>{{ item.assignment.userId }}</td>
            <td>{{ item.shift.name }}</td>
            <td>{{ item.assignment.startDate }}</td>
            <td>{{ item.assignment.endDate || '--' }}</td>
            <td>{{ item.assignment.isActive ? tr('Yes', '是') : tr('No', '否') }}</td>
            <td class="attendance__table-actions">
              <button class="attendance__btn" @click="editAssignment(item)">{{ tr('Edit', '编辑') }}</button>
              <button class="attendance__btn attendance__btn--danger" @click="deleteAssignment(item.assignment.id)">
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
  AttendanceAssignmentItem,
  AttendanceRotationAssignmentItem,
  AttendanceRotationRule,
  AttendanceShift,
} from './useAttendanceAdminScheduling'
import AttendanceUserPickerField from './AttendanceUserPickerField.vue'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface RotationRuleFormState {
  name: string
  timezone: string
  shiftSequence: string
  isActive: boolean
}

interface RotationAssignmentFormState {
  userId: string
  rotationRuleId: string
  startDate: string
  endDate: string
  isActive: boolean
}

interface ShiftFormState {
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: string
}

interface AssignmentFormState {
  userId: string
  shiftId: string
  startDate: string
  endDate: string
  isActive: boolean
}

interface RuleFormState {
  name: string
  timezone: string
  workStartTime: string
  workEndTime: string
  lateGraceMinutes: number
  earlyGraceMinutes: number
  roundingMinutes: number
  workingDays: string
}

interface SchedulingBindings {
  loadRule: () => MaybePromise<void>
  ruleForm: RuleFormState
  ruleLoading: Ref<boolean>
  saveRule: () => MaybePromise<void>
  rotationRules: Ref<AttendanceRotationRule[]>
  rotationRuleLoading: Ref<boolean>
  rotationRuleSaving: Ref<boolean>
  rotationRuleEditingId: Ref<string | null>
  rotationRuleForm: RotationRuleFormState
  resetRotationRuleForm: () => MaybePromise<void>
  editRotationRule: (rule: AttendanceRotationRule) => MaybePromise<void>
  loadRotationRules: () => MaybePromise<void>
  saveRotationRule: () => MaybePromise<void>
  deleteRotationRule: (id: string) => MaybePromise<void>
  rotationAssignments: Ref<AttendanceRotationAssignmentItem[]>
  rotationAssignmentLoading: Ref<boolean>
  rotationAssignmentSaving: Ref<boolean>
  rotationAssignmentEditingId: Ref<string | null>
  rotationAssignmentForm: RotationAssignmentFormState
  resetRotationAssignmentForm: () => MaybePromise<void>
  editRotationAssignment: (item: AttendanceRotationAssignmentItem) => MaybePromise<void>
  loadRotationAssignments: () => MaybePromise<void>
  saveRotationAssignment: () => MaybePromise<void>
  deleteRotationAssignment: (id: string) => MaybePromise<void>
  shifts: Ref<AttendanceShift[]>
  shiftLoading: Ref<boolean>
  shiftSaving: Ref<boolean>
  shiftEditingId: Ref<string | null>
  shiftForm: ShiftFormState
  resetShiftForm: () => MaybePromise<void>
  editShift: (shift: AttendanceShift) => MaybePromise<void>
  loadShifts: () => MaybePromise<void>
  saveShift: () => MaybePromise<void>
  deleteShift: (id: string) => MaybePromise<void>
  assignments: Ref<AttendanceAssignmentItem[]>
  assignmentLoading: Ref<boolean>
  assignmentSaving: Ref<boolean>
  assignmentEditingId: Ref<string | null>
  assignmentForm: AssignmentFormState
  resetAssignmentForm: () => MaybePromise<void>
  editAssignment: (item: AttendanceAssignmentItem) => MaybePromise<void>
  loadAssignments: () => MaybePromise<void>
  saveAssignment: () => MaybePromise<void>
  deleteAssignment: (id: string) => MaybePromise<void>
}

const props = defineProps<{
  tr: Translate
  scheduling: SchedulingBindings
}>()

const tr = props.tr
const loadRule = () => props.scheduling.loadRule()
const ruleForm = props.scheduling.ruleForm
const ruleLoading = props.scheduling.ruleLoading
const saveRule = () => props.scheduling.saveRule()
const rotationRules = props.scheduling.rotationRules
const rotationRuleLoading = props.scheduling.rotationRuleLoading
const rotationRuleSaving = props.scheduling.rotationRuleSaving
const rotationRuleEditingId = props.scheduling.rotationRuleEditingId
const rotationRuleForm = props.scheduling.rotationRuleForm
const resetRotationRuleForm = () => props.scheduling.resetRotationRuleForm()
const editRotationRule = (rule: AttendanceRotationRule) => props.scheduling.editRotationRule(rule)
const loadRotationRules = () => props.scheduling.loadRotationRules()
const saveRotationRule = () => props.scheduling.saveRotationRule()
const deleteRotationRule = (id: string) => props.scheduling.deleteRotationRule(id)
const rotationAssignments = props.scheduling.rotationAssignments
const rotationAssignmentLoading = props.scheduling.rotationAssignmentLoading
const rotationAssignmentSaving = props.scheduling.rotationAssignmentSaving
const rotationAssignmentEditingId = props.scheduling.rotationAssignmentEditingId
const rotationAssignmentForm = props.scheduling.rotationAssignmentForm
const resetRotationAssignmentForm = () => props.scheduling.resetRotationAssignmentForm()
const editRotationAssignment = (item: AttendanceRotationAssignmentItem) => props.scheduling.editRotationAssignment(item)
const loadRotationAssignments = () => props.scheduling.loadRotationAssignments()
const saveRotationAssignment = () => props.scheduling.saveRotationAssignment()
const deleteRotationAssignment = (id: string) => props.scheduling.deleteRotationAssignment(id)
const shifts = props.scheduling.shifts
const shiftLoading = props.scheduling.shiftLoading
const shiftSaving = props.scheduling.shiftSaving
const shiftEditingId = props.scheduling.shiftEditingId
const shiftForm = props.scheduling.shiftForm
const resetShiftForm = () => props.scheduling.resetShiftForm()
const editShift = (shift: AttendanceShift) => props.scheduling.editShift(shift)
const loadShifts = () => props.scheduling.loadShifts()
const saveShift = () => props.scheduling.saveShift()
const deleteShift = (id: string) => props.scheduling.deleteShift(id)
const assignments = props.scheduling.assignments
const assignmentLoading = props.scheduling.assignmentLoading
const assignmentSaving = props.scheduling.assignmentSaving
const assignmentEditingId = props.scheduling.assignmentEditingId
const assignmentForm = props.scheduling.assignmentForm
const resetAssignmentForm = () => props.scheduling.resetAssignmentForm()
const editAssignment = (item: AttendanceAssignmentItem) => props.scheduling.editAssignment(item)
const loadAssignments = () => props.scheduling.loadAssignments()
const saveAssignment = () => props.scheduling.saveAssignment()
const deleteAssignment = (id: string) => props.scheduling.deleteAssignment(id)

function parseShiftSequence(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function appendShiftToRotationSequence(shiftId: string) {
  const current = parseShiftSequence(rotationRuleForm.shiftSequence)
  rotationRuleForm.shiftSequence = [...current, shiftId].join(', ')
}

const rotationSequencePreviewText = computed(() => {
  const sequence = parseShiftSequence(rotationRuleForm.shiftSequence)
  if (sequence.length === 0) return ''
  return sequence.map((shiftId) => {
    const shift = shifts.value.find(item => item.id === shiftId)
    return shift ? `${shift.name} (${shiftId})` : shiftId
  }).join(' → ')
})

const rotationRuleEditingLabel = computed(() => {
  const name = rotationRuleForm.name.trim()
  return tr(
    `Editing rotation rule: ${name || rotationRuleEditingId.value}`,
    `正在编辑轮班规则：${name || rotationRuleEditingId.value}`,
  )
})

const rotationAssignmentEditingLabel = computed(() => {
  const userId = rotationAssignmentForm.userId.trim()
  const ruleId = rotationAssignmentForm.rotationRuleId.trim()
  return tr(
    `Editing rotation assignment: ${userId || rotationAssignmentEditingId.value} → ${ruleId || tr('no rotation selected', '未选择轮班')}`,
    `正在编辑轮班分配：${userId || rotationAssignmentEditingId.value} → ${ruleId || tr('未选择轮班', '未选择轮班')}`,
  )
})

const shiftEditingLabel = computed(() => {
  const name = shiftForm.name.trim()
  return tr(
    `Editing shift: ${name || shiftEditingId.value}`,
    `正在编辑班次：${name || shiftEditingId.value}`,
  )
})

const assignmentEditingLabel = computed(() => {
  const userId = assignmentForm.userId.trim()
  const shiftId = assignmentForm.shiftId.trim()
  return tr(
    `Editing shift assignment: ${userId || assignmentEditingId.value} → ${shiftId || tr('no shift selected', '未选择班次')}`,
    `正在编辑排班分配：${userId || assignmentEditingId.value} → ${shiftId || tr('未选择班次', '未选择班次')}`,
  )
})
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

.attendance__field-hint {
  color: #666;
  font-size: 12px;
}

.attendance__section-meta {
  color: #666;
  font-size: 12px;
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

.attendance__btn--inline {
  padding: 5px 10px;
  font-size: 12px;
}

.attendance__sequence-builder {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.attendance__sequence-builder-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
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

.attendance__empty {
  color: #888;
  font-size: 13px;
  margin-top: 8px;
}
</style>
