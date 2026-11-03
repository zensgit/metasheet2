<script setup lang="ts">
import AttendanceAudienceChipField from './AttendanceAudienceChipField.vue'

type Translate = (en: string, zh: string) => string

interface OverrideAudienceForm {
  attendanceGroups?: string
  roles?: string
  roleTags?: string
  userIds?: string
  userNames?: string
  excludeUserIds?: string
  excludeUserNames?: string
  dayIndexStart?: number | null
  dayIndexEnd?: number | null
  dayIndexList?: string
}

withDefaults(defineProps<{
  override: OverrideAudienceForm
  groupOptions?: string[]
  roleOptions?: string[]
  tr: Translate
  searchUserNames?: (query: string) => Promise<string[]>
  markCalendarPolicy?: boolean
}>(), {
  groupOptions: () => [],
  roleOptions: () => [],
  searchUserNames: undefined,
  markCalendarPolicy: false,
})
</script>

<template>
  <div class="attendance__override-filters" data-attendance-override-audience>
    <label class="attendance__override-field">
      <span>{{ tr('Attendance groups', '考勤组') }}</span>
      <AttendanceAudienceChipField
        v-model="override.attendanceGroups"
        :options="groupOptions"
        :tr="tr"
        :placeholder="tr('Choose or type a group', '选择或输入考勤组')"
        :input-attrs="markCalendarPolicy ? { 'data-calendar-policy-override-attendance-groups': 'true' } : {}"
      />
    </label>
    <label class="attendance__override-field">
      <span>{{ tr('Roles', '角色') }}</span>
      <AttendanceAudienceChipField
        v-model="override.roles"
        :options="roleOptions"
        :tr="tr"
        :placeholder="tr('Choose or type a role', '选择或输入角色')"
      />
    </label>
    <label class="attendance__override-field">
      <span>{{ tr('Role tags', '角色标签') }}</span>
      <AttendanceAudienceChipField
        v-model="override.roleTags"
        :options="roleOptions"
        :tr="tr"
        :placeholder="tr('Choose or type a tag', '选择或输入标签')"
      />
      <small class="attendance__field-hint">
        {{ tr('No separate tag catalog yet. Role names work as tags, or type one.', '还没有独立标签目录。可从角色名里选，也可以直接输入。') }}
      </small>
    </label>
    <label class="attendance__override-field">
      <span>{{ tr('User names', '用户名') }}</span>
      <AttendanceAudienceChipField
        v-model="override.userNames"
        :tr="tr"
        :search="searchUserNames"
        :placeholder="tr('Search a name', '搜索姓名')"
      />
    </label>
    <label class="attendance__override-field">
      <span>{{ tr('Exclude user names', '排除用户名') }}</span>
      <AttendanceAudienceChipField
        v-model="override.excludeUserNames"
        :tr="tr"
        :search="searchUserNames"
        :placeholder="tr('Search a name to exclude', '搜索要排除的姓名')"
      />
    </label>
    <details class="attendance__override-advanced" data-attendance-override-advanced>
      <summary>{{ tr('Advanced', '高级') }}</summary>
      <div class="attendance__override-advanced-grid">
        <label class="attendance__override-field">
          <span>{{ tr('User IDs', '用户ID') }}</span>
          <input v-model="override.userIds" type="text" :placeholder="tr('UUIDs, comma separated', 'UUID，逗号分隔')" />
        </label>
        <label class="attendance__override-field">
          <span>{{ tr('Exclude user IDs', '排除用户ID') }}</span>
          <input v-model="override.excludeUserIds" type="text" :placeholder="tr('UUIDs, comma separated', 'UUID，逗号分隔')" />
        </label>
        <label class="attendance__override-field">
          <span>{{ tr('Day index start', '节假日序号起始') }}</span>
          <input
            v-model.number="override.dayIndexStart"
            type="number"
            min="1"
            v-bind="markCalendarPolicy ? { 'data-calendar-policy-override-day-index-start': 'true' } : {}"
          />
        </label>
        <label class="attendance__override-field">
          <span>{{ tr('Day index end', '节假日序号结束') }}</span>
          <input
            v-model.number="override.dayIndexEnd"
            type="number"
            min="1"
            v-bind="markCalendarPolicy ? { 'data-calendar-policy-override-day-index-end': 'true' } : {}"
          />
        </label>
        <label class="attendance__override-field">
          <span>{{ tr('Day index list', '节假日序号列表') }}</span>
          <input v-model="override.dayIndexList" type="text" placeholder="1,2,3" />
        </label>
      </div>
    </details>
  </div>
</template>

<style scoped>
.attendance__override-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px 16px;
}

.attendance__override-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: fit-content;
  max-width: 16rem;
  font-size: 12px;
}

.attendance__override-field > span {
  color: var(--ms-text-2, #475467);
  font-size: 12px;
  font-weight: 600;
}

.attendance__field-hint {
  max-width: 16rem;
  color: var(--ms-text-3, #667085);
  font-size: 11px;
  line-height: 1.4;
}

.attendance__override-advanced {
  flex: 1 0 100%;
  width: fit-content;
  max-width: 100%;
}

.attendance__override-advanced summary {
  width: fit-content;
  color: var(--ms-text-3, #667085);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.attendance__override-advanced-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  margin-top: 8px;
}

.attendance__override-advanced-grid input {
  width: 11rem;
  max-width: 100%;
  min-height: 32px;
  padding: 4px 8px;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: var(--ms-radius-md, 8px);
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-1, #1f2329);
  font-size: 13px;
}

.attendance__override-advanced-grid input[type='number'] {
  width: 5.5rem;
}
</style>
