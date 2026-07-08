<template>
  <div class="approval-steps" data-testid="attendance-approval-steps-editor">
    <div v-if="steps.length === 0" class="approval-steps__empty">
      {{ tr('No approval steps yet — add the first level.', '暂无审批步骤——请添加第一级。') }}
    </div>

    <ol class="approval-steps__list">
      <li v-for="(step, index) in steps" :key="index" class="approval-steps__item" data-testid="attendance-approval-step">
        <div class="approval-steps__head">
          <span class="approval-steps__level">{{ tr('Level', '第') }} {{ index + 1 }} {{ tr('', '级') }}</span>
          <div class="approval-steps__reorder">
            <button type="button" class="attendance__btn" :disabled="index === 0" @click="onMove(index, -1)" :aria-label="tr('Move up', '上移')">↑</button>
            <button type="button" class="attendance__btn" :disabled="index === steps.length - 1" @click="onMove(index, 1)" :aria-label="tr('Move down', '下移')">↓</button>
            <button type="button" class="attendance__btn attendance__btn--danger" @click="onRemove(index)" :aria-label="tr('Remove step', '删除步骤')">✕</button>
          </div>
        </div>

        <label class="attendance__field">
          <span>{{ tr('Step name', '步骤名称') }}</span>
          <input
            type="text"
            :value="step.name"
            :placeholder="tr('e.g. Direct manager', '如：直属主管')"
            @input="onName(index, ($event.target as HTMLInputElement).value)"
          />
        </label>

        <div class="approval-steps__approvers">
          <div class="approval-steps__col">
            <AttendanceUserPickerField
              :model-value="''"
              :label="tr('Add approver (user)', '添加审批人（用户）')"
              :tr="tr"
              :input-id="`approval-step-user-${index}`"
              @update:model-value="(uid: string) => onAddUser(index, uid)"
            />
            <div class="approval-steps__chips" data-testid="attendance-approval-step-users">
              <span v-for="uid in step.approverUserIds" :key="uid" class="approval-steps__chip">
                {{ uid }}
                <button type="button" @click="onRemoveUser(index, uid)" :aria-label="tr('Remove', '移除')">✕</button>
              </span>
              <span v-if="!(step.approverUserIds && step.approverUserIds.length)" class="approval-steps__chip-empty">{{ tr('none', '无') }}</span>
            </div>
          </div>

          <div class="approval-steps__col">
            <label class="attendance__field">
              <span>{{ tr('Add approver roles (IDs)', '添加审批角色（ID）') }}</span>
              <input
                type="text"
                :value="roleDraft[index] || ''"
                :placeholder="tr('e.g. manager, hr — Enter to add', '如：manager, hr —— 回车添加')"
                @input="roleDraft[index] = ($event.target as HTMLInputElement).value"
                @keydown.enter.prevent="onAddRoles(index)"
              />
            </label>
            <div class="approval-steps__chips" data-testid="attendance-approval-step-roles">
              <span v-for="rid in step.approverRoleIds" :key="rid" class="approval-steps__chip">
                {{ rid }}
                <button type="button" @click="onRemoveRole(index, rid)" :aria-label="tr('Remove', '移除')">✕</button>
              </span>
              <span v-if="!(step.approverRoleIds && step.approverRoleIds.length)" class="approval-steps__chip-empty">{{ tr('none', '无') }}</span>
            </div>
          </div>
        </div>

        <p v-if="stepHasNoApprover(step)" class="approval-steps__warn" data-testid="attendance-approval-step-warning">
          {{ tr('This step has no approver — it may auto-pass or fall back to admin.', '本步骤未配置审批人——可能自动通过或兜底到管理员。') }}
        </p>
      </li>
    </ol>

    <button type="button" class="attendance__btn" data-testid="attendance-approval-add-step" @click="onAdd">
      + {{ tr('Add step', '添加步骤') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import AttendanceUserPickerField from './AttendanceUserPickerField.vue'
import {
  addApproverRoles,
  addApproverUser,
  addStep,
  moveStep,
  removeApproverRole,
  removeApproverUser,
  removeStep,
  setStepField,
  stepHasNoApprover,
  type AttendanceApprovalStep,
} from './attendanceApprovalSteps'

type Translate = (en: string, zh: string) => string

const props = defineProps<{
  modelValue: AttendanceApprovalStep[]
  tr: Translate
}>()

const emit = defineEmits<{
  'update:modelValue': [value: AttendanceApprovalStep[]]
}>()

const steps = computed<AttendanceApprovalStep[]>(() => props.modelValue ?? [])
const roleDraft = reactive<Record<number, string>>({})

function commit(next: AttendanceApprovalStep[]): void {
  emit('update:modelValue', next)
}

function onAdd(): void { commit(addStep(props.modelValue)) }
function onRemove(index: number): void { commit(removeStep(props.modelValue, index)) }
function onMove(index: number, delta: number): void { commit(moveStep(props.modelValue, index, delta)) }
function onName(index: number, value: string): void { commit(setStepField(props.modelValue, index, { name: value })) }
function onAddUser(index: number, uid: string): void { if (uid) commit(addApproverUser(props.modelValue, index, uid)) }
function onRemoveUser(index: number, uid: string): void { commit(removeApproverUser(props.modelValue, index, uid)) }
function onAddRoles(index: number): void {
  const draft = roleDraft[index] || ''
  if (!draft.trim()) return
  commit(addApproverRoles(props.modelValue, index, draft))
  roleDraft[index] = ''
}
function onRemoveRole(index: number, rid: string): void { commit(removeApproverRole(props.modelValue, index, rid)) }
</script>

<style scoped>
.approval-steps__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.approval-steps__item {
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  padding: var(--ms-space-3);
  background: var(--ms-bg-card);
}

.approval-steps__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--ms-space-2);
}

.approval-steps__level {
  font-weight: 600;
  color: var(--ms-text-1);
}

.approval-steps__reorder {
  display: flex;
  gap: var(--ms-space-1);
}

.approval-steps__approvers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--ms-space-3);
}

.approval-steps__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-1);
  margin-top: var(--ms-space-1);
}

.approval-steps__chip {
  display: inline-flex;
  align-items: center;
  gap: var(--ms-space-1);
  padding: 0 var(--ms-space-2);
  border-radius: 999px;
  background: var(--ms-bg-page);
  border: 1px solid var(--ms-border-light);
  font-size: 12px;
  line-height: 20px;
}

.approval-steps__chip button {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--ms-text-3);
}

.approval-steps__chip-empty {
  color: var(--ms-text-3);
  font-size: 12px;
}

.approval-steps__warn {
  margin: var(--ms-space-2) 0 0;
  color: var(--ms-color-warning);
  font-size: 12px;
}

.approval-steps__empty {
  color: var(--ms-text-3);
  margin-bottom: var(--ms-space-2);
}
</style>
