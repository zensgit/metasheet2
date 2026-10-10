<!-- Admin-only 员工常用图标 picker. Employees never see this control. -->
<template>
  <div class="attendance-ew-admin-icons" data-attendance-employee-quick-icons>
    <h4 class="attendance-ew-admin-icons__title">{{ tr('Employee common icons', '员工常用图标') }}</h4>
    <p class="attendance-ew-admin-icons__hint">
      {{ tr('Filled tiles shown on the employee overview. Invalid keys fall back to defaults.', '显示在员工总览上的面性图标。无效键回退到默认。') }}
    </p>
    <div
      v-for="row in rows"
      :key="row.key"
      class="attendance-ew-admin-icons__row"
      :data-attendance-quick-icon-action="row.key"
    >
      <span class="attendance-ew-admin-icons__label">{{ row.label }}</span>
      <span class="attendance-ew-admin-icons__preview" :class="`attendance-ew-admin-icons__preview--${row.key}`">
        <AttendanceEmployeeCommonIcon :name="modelValue[row.key]" />
      </span>
      <div class="attendance-ew-admin-icons__choices">
        <button
          v-for="iconId in iconIds"
          :key="iconId"
          type="button"
          class="attendance-ew-admin-icons__choice"
          :class="{ 'attendance-ew-admin-icons__choice--active': modelValue[row.key] === iconId }"
          :data-attendance-quick-icon-option="iconId"
          :aria-label="iconId"
          @click="select(row.key, iconId)"
        >
          <AttendanceEmployeeCommonIcon :name="iconId" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AttendanceEmployeeCommonIcon from './AttendanceEmployeeCommonIcon.vue'
import {
  COMMON_ICON_IDS,
  type CommonIconId,
  type EmployeeQuickActionIcons,
  type EmployeeQuickActionKey,
} from './attendanceEmployeeWorkspaceCommonIcons'

type TranslateFn = (en: string, zh: string) => string

const props = defineProps<{
  modelValue: EmployeeQuickActionIcons
  tr: TranslateFn
}>()

const emit = defineEmits<{
  'update:modelValue': [value: EmployeeQuickActionIcons]
}>()

const iconIds = COMMON_ICON_IDS

const rows: Array<{ key: EmployeeQuickActionKey; label: string }> = [
  { key: 'makeup', label: props.tr('Makeup punch', '补卡') },
  { key: 'leave', label: props.tr('Leave', '请假') },
  { key: 'overtime', label: props.tr('Overtime', '加班') },
  { key: 'swap', label: props.tr('Shift swap', '换班') },
]

function select(key: EmployeeQuickActionKey, iconId: CommonIconId): void {
  emit('update:modelValue', { ...props.modelValue, [key]: iconId })
}
</script>

<style scoped>
.attendance-ew-admin-icons {
  display: flex;
  flex-direction: column;
  gap: 12px;
  grid-column: 1 / -1;
}

.attendance-ew-admin-icons__title {
  margin: 0;
  font-size: 14px;
}

.attendance-ew-admin-icons__hint {
  margin: 0;
  font-size: 12px;
  color: var(--ms-text-3);
}

.attendance-ew-admin-icons__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.attendance-ew-admin-icons__label {
  min-width: 72px;
  font-size: 13px;
}

.attendance-ew-admin-icons__preview {
  width: 40px;
  height: 40px;
  border-radius: var(--ms-radius-lg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--el-color-primary-light-9);
  color: var(--ms-color-primary);
}

.attendance-ew-admin-icons__preview--makeup { background: var(--el-color-primary-light-9); color: var(--ms-color-primary); }
.attendance-ew-admin-icons__preview--leave { background: var(--el-color-success-light-9); color: var(--ms-color-success); }
.attendance-ew-admin-icons__preview--overtime { background: var(--el-color-warning-light-9); color: var(--ms-color-warning); }
.attendance-ew-admin-icons__preview--swap { background: var(--el-color-info-light-9); color: var(--ms-color-info); }

.attendance-ew-admin-icons__preview :deep(svg),
.attendance-ew-admin-icons__choice :deep(svg) {
  width: 18px;
  height: 18px;
}

.attendance-ew-admin-icons__choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.attendance-ew-admin-icons__choice {
  width: 32px;
  height: 32px;
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}

.attendance-ew-admin-icons__choice--active {
  box-shadow: 0 0 0 2px var(--ms-color-primary);
  color: var(--ms-color-primary);
}
</style>
