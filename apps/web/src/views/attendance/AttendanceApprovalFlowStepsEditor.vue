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

        <label class="attendance__field" :for="`approval-step-kind-${index}`">
          <span>{{ tr('Approver source', '审批人来源') }}</span>
          <select
            :id="`approval-step-kind-${index}`"
            class="approval-steps__kind"
            data-testid="attendance-approval-step-kind"
            :value="kindSelectValue(step)"
            @change="onKindChange(index, ($event.target as HTMLSelectElement).value)"
          >
            <option value="static">{{ tr('Static approvers', '指定审批人') }}</option>
            <option value="direct_manager">{{ tr('Direct manager', '直属上级') }}</option>
            <option value="dept_head">{{ tr('Department head', '部门主管') }}</option>
            <option value="manager_at_level" :disabled="!hostMaxKnown">
              {{ tr('Manager at level', '指定层级上级') }}{{ hostMaxKnown ? '' : tr(' (waiting for host max…)', '（等待主机上限…）') }}
            </option>
            <option
              v-if="isUnsupportedDynamicStep(step)"
              :value="`unsupported:${String(step.kind)}`"
              disabled
            >
              {{ tr('Unsupported source', '不支持的来源') }}: {{ formatUnsupportedKind(step) }}
            </option>
          </select>
        </label>

        <p
          v-if="isUnsupportedDynamicStep(step)"
          class="approval-steps__warn"
          data-testid="attendance-approval-step-unsupported"
        >
          {{ tr(
            'This step uses an unsupported or malformed approver source and will be preserved as-is until you change it. It is not silently rewritten.',
            '本步骤使用了不支持或畸形的审批人来源，在您主动更改前将原样保留，不会被静默改写。',
          ) }}
        </p>

        <!-- Static approver pickers — only for true kind-less static steps -->
        <div v-if="isEditableStaticStep(step)" class="approval-steps__approvers">
          <div class="approval-steps__col">
            <AttendanceUserPickerField
              :model-value="''"
              :label="tr('Add approver (user)', '添加审批人（用户）')"
              :tr="tr"
              :input-id="`approval-step-user-${index}`"
              endpoint="/api/attendance-admin/users/search"
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

        <!-- manager_at_level: show persisted level even when max is unknown (read-only until host max arrives) -->
        <label
          v-if="kindSelectValue(step) === 'manager_at_level'"
          class="attendance__field"
          :for="`approval-step-level-${index}`"
        >
          <span>{{ tr('Manager level (1 = direct manager)', '上级层级（1 = 直属上级）') }}</span>
          <input
            :id="`approval-step-level-${index}`"
            type="number"
            min="1"
            :max="levelInputMax"
            step="any"
            data-testid="attendance-approval-step-level"
            :disabled="!hostMaxKnown"
            :value="step.level === undefined || step.level === null ? '' : step.level"
            @input="onLevel(index, ($event.target as HTMLInputElement).value)"
          />
          <span v-if="hostMaxKnown" class="approval-steps__hint">
            {{ tr('Allowed range', '允许范围') }}: 1 … {{ hostMax }}
          </span>
          <span v-else class="approval-steps__hint" data-testid="attendance-approval-step-level-waiting">
            {{ tr('Level editing waits for the host max from directory readiness.', '层级编辑需等待主机返回的目录就绪上限。') }}
          </span>
        </label>

        <p v-if="isEditableStaticStep(step) && stepHasNoApprover(step)" class="approval-steps__warn" data-testid="attendance-approval-step-warning">
          {{ tr('This step has no approver — it may auto-pass or fall back to admin.', '本步骤未配置审批人——可能自动通过或兜底到管理员。') }}
        </p>
      </li>
    </ol>

    <!-- Directory warning lives only on the parent (AttendanceView) via collectAuthoringWarnings
         so the same OD-S7-6 message is not shown twice (review P3). -->

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
  getApprovalStepKind,
  getStepKindSelection,
  isEditableStaticStep,
  isUnsupportedDynamicStep,
  moveStep,
  removeApproverRole,
  removeApproverUser,
  removeStep,
  setManagerLevel,
  setStepField,
  setStepKind,
  stepHasNoApprover,
  type AttendanceApprovalStep,
  type AttendanceStepKindSelection,
} from './attendanceApprovalSteps'

type Translate = (en: string, zh: string) => string

const props = defineProps<{
  modelValue: AttendanceApprovalStep[]
  tr: Translate
  /**
   * Host-authoritative chain cap from the readiness seam.
   * null/undefined = unknown — manager_at_level creation/editing is disabled;
   * existing persisted manager_at_level content remains visible and unchanged.
   */
  maxManagerChainLevels?: number | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: AttendanceApprovalStep[]]
}>()

const steps = computed<AttendanceApprovalStep[]>(() => props.modelValue ?? [])
const roleDraft = reactive<Record<number, string>>({})

const hostMax = computed((): number | null => {
  const max = props.maxManagerChainLevels
  return typeof max === 'number' && Number.isInteger(max) && max >= 1 ? max : null
})
const hostMaxKnown = computed(() => hostMax.value !== null)
/** HTML max attr: number | undefined only (null is not valid for Numberish). */
const levelInputMax = computed((): number | undefined => hostMax.value ?? undefined)

function kindSelectValue(step: AttendanceApprovalStep): string {
  const selection = getStepKindSelection(step)
  if (selection) return selection
  if (isUnsupportedDynamicStep(step)) return `unsupported:${String(step.kind)}`
  return 'static'
}

function formatUnsupportedKind(step: AttendanceApprovalStep): string {
  const kind = getApprovalStepKind(step)
  if (kind) return kind
  if (typeof step.kind === 'string') return step.kind.length === 0 ? '(blank)' : step.kind
  return String(step.kind)
}

function commit(next: AttendanceApprovalStep[]): void {
  emit('update:modelValue', next)
}

// roleDraft is keyed by step index; any structural change (move/remove) would
// otherwise leave an un-entered draft attributed to a different step (review
// P3). Clear pending drafts on structural edits so a later Enter can't add a
// role to the wrong step.
function clearRoleDrafts(): void {
  for (const key of Object.keys(roleDraft)) delete roleDraft[Number(key)]
}
function onAdd(): void { commit(addStep(props.modelValue)) }
function onRemove(index: number): void { clearRoleDrafts(); commit(removeStep(props.modelValue, index)) }
function onMove(index: number, delta: number): void { clearRoleDrafts(); commit(moveStep(props.modelValue, index, delta)) }
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

function onKindChange(index: number, raw: string): void {
  if (raw.startsWith('unsupported:')) return
  const allowed: AttendanceStepKindSelection[] = ['static', 'direct_manager', 'dept_head', 'manager_at_level']
  if (!(allowed as string[]).includes(raw)) return
  // continuous_managers is never offered (OD-S7-2).
  // manager_at_level is no-op while host max is unknown (setStepKind fail-closed).
  commit(setStepKind(props.modelValue, index, raw as AttendanceStepKindSelection, {
    maxManagerChainLevels: hostMax.value,
  }))
}

function onLevel(index: number, raw: string): void {
  // Fail-closed: store the exact number the user typed (including fractional / 0 /
  // out-of-range). No Math.trunc, no clamp. Empty input does not invent a default.
  if (raw.trim() === '') return
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return
  commit(setManagerLevel(props.modelValue, index, parsed, hostMax.value))
}
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

.approval-steps__kind {
  width: 100%;
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

.approval-steps__hint {
  display: block;
  margin-top: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 12px;
}

.approval-steps__empty {
  color: var(--ms-text-3);
  margin-bottom: var(--ms-space-2);
}
</style>
