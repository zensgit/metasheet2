<template>
  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Holiday Policy', '节假日策略') }}</h4>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-first-day-enabled">
        <span>{{ tr('Holiday first-day base hours', '节假日首日基准工时') }}</span>
        <input id="attendance-holiday-first-day-enabled" v-model="settingsForm.holidayFirstDayEnabled" name="holidayFirstDayEnabled" type="checkbox" />
      </label>
      <label class="attendance__field" for="attendance-holiday-first-day-hours">
        <span>{{ tr('First-day base hours', '首日基准工时') }}</span>
        <input id="attendance-holiday-first-day-hours" v-model.number="settingsForm.holidayFirstDayBaseHours" name="holidayFirstDayBaseHours" type="number" min="0" step="0.5" />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-overtime-adds">
        <span>{{ tr('Overtime adds on holiday', '节假日计入加班') }}</span>
        <input id="attendance-holiday-overtime-adds" v-model="settingsForm.holidayOvertimeAdds" name="holidayOvertimeAdds" type="checkbox" />
      </label>
      <label class="attendance__field" for="attendance-holiday-overtime-source">
        <span>{{ tr('Overtime source', '加班来源') }}</span>
        <select id="attendance-holiday-overtime-source" v-model="settingsForm.holidayOvertimeSource" name="holidayOvertimeSource">
          <option value="approval">{{ tr('Approval', '审批') }}</option>
          <option value="clock">{{ tr('Clock', '打卡') }}</option>
          <option value="both">{{ tr('Both', '两者') }}</option>
        </select>
      </label>
      <div class="attendance__field attendance__field--full">
        <div class="attendance__admin-subsection">
          <div class="attendance__admin-subsection-header attendance__admin-subsection-header--accordion">
            <button class="attendance__accordion" type="button" :aria-expanded="holidayOverridesExpanded ? 'true' : 'false'" @click="toggleHolidayOverrides">
              <span class="attendance__accordion-copy">
                <strong>{{ tr('Holiday overrides', '节假日覆盖规则') }}</strong>
                <small>{{ holidayOverrideSummary }}</small>
              </span>
              <span class="attendance__accordion-indicator">{{ holidayOverridesExpanded ? tr('Collapse', '收起') : tr('Expand', '展开') }}</span>
            </button>
            <button class="attendance__btn" type="button" @click="addHolidayOverrideAndExpand">{{ tr('Add override', '新增覆盖') }}</button>
          </div>
          <div v-if="holidayOverridesExpanded">
            <div v-if="settingsForm.holidayOverrides.length === 0" class="attendance__empty">{{ tr('No overrides configured.', '暂无覆盖规则。') }}</div>
            <div v-else class="attendance__table-wrapper">
              <table class="attendance__table">
                <thead>
                  <tr>
                    <th class="attendance__table-col--holiday-name">{{ tr('Holiday name', '节假日名称') }}</th>
                    <th>{{ tr('Match', '匹配方式') }}</th>
                    <th>{{ tr('First-day hours', '首日工时') }}</th>
                    <th>{{ tr('Enable', '启用') }}</th>
                    <th>{{ tr('Overtime adds', '计入加班') }}</th>
                    <th>{{ tr('Overtime source', '加班来源') }}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="(override, index) in settingsForm.holidayOverrides" :key="`holiday-override-${index}`">
                    <tr>
                      <td class="attendance__table-cell--holiday-name"><input v-model="override.name" class="attendance__table-input" type="text" placeholder="春节" /></td>
                      <td>
                        <select v-model="override.match" class="attendance__table-input">
                          <option value="contains">{{ tr('Contains', '包含') }}</option>
                          <option value="equals">{{ tr('Equals', '等于') }}</option>
                          <option value="regex">{{ tr('Regex', '正则') }}</option>
                        </select>
                      </td>
                      <td><input v-model.number="override.firstDayBaseHours" class="attendance__table-input" type="number" min="0" step="0.5" /></td>
                      <td><input v-model="override.firstDayEnabled" type="checkbox" /></td>
                      <td><input v-model="override.overtimeAdds" type="checkbox" /></td>
                      <td>
                        <select v-model="override.overtimeSource" class="attendance__table-input">
                          <option value="approval">{{ tr('Approval', '审批') }}</option>
                          <option value="clock">{{ tr('Clock', '打卡') }}</option>
                          <option value="both">{{ tr('Both', '两者') }}</option>
                        </select>
                      </td>
                      <td><button class="attendance__btn attendance__btn--danger" type="button" @click="removeHolidayOverride(index)">{{ tr('Remove', '移除') }}</button></td>
                    </tr>
                    <tr class="attendance__table-row--meta">
                      <td colspan="7">
                        <div class="attendance__override-filters">
                          <label class="attendance__override-field">
                            <span>{{ tr('Attendance groups', '考勤组') }}</span>
                            <input v-model="override.attendanceGroups" type="text" placeholder="单休办公,白班" />
                            <small v-if="attendanceGroupOptions.length" class="attendance__field-hint">{{ tr('Known groups', '已知分组') }}: {{ attendanceGroupOptions.join(', ') }}</small>
                          </label>
                          <label class="attendance__override-field"><span>{{ tr('Roles', '角色') }}</span><input v-model="override.roles" type="text" placeholder="司机,工段长" /></label>
                          <label class="attendance__override-field"><span>{{ tr('Role tags', '角色标签') }}</span><input v-model="override.roleTags" type="text" placeholder="车间,仓储" /></label>
                          <label class="attendance__override-field"><span>{{ tr('User IDs', '用户ID') }}</span><input v-model="override.userIds" type="text" placeholder="uuid1,uuid2" /></label>
                          <label class="attendance__override-field"><span>{{ tr('User names', '用户名') }}</span><input v-model="override.userNames" type="text" placeholder="张三,李四" /></label>
                          <label class="attendance__override-field"><span>{{ tr('Exclude user IDs', '排除用户ID') }}</span><input v-model="override.excludeUserIds" type="text" placeholder="uuid3" /></label>
                          <label class="attendance__override-field"><span>{{ tr('Exclude user names', '排除用户名') }}</span><input v-model="override.excludeUserNames" type="text" placeholder="王五" /></label>
                          <label class="attendance__override-field"><span>{{ tr('Day index start', '节假日序号起始') }}</span><input v-model.number="override.dayIndexStart" type="number" min="1" /></label>
                          <label class="attendance__override-field"><span>{{ tr('Day index end', '节假日序号结束') }}</span><input v-model.number="override.dayIndexEnd" type="number" min="1" /></label>
                          <label class="attendance__override-field"><span>{{ tr('Day index list', '节假日序号列表') }}</span><input v-model="override.dayIndexList" type="text" placeholder="1,2,3" /></label>
                        </div>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
    <button class="attendance__btn attendance__btn--primary" :disabled="settingsLoading" @click="saveSettings">
      {{ settingsLoading ? tr('Saving...', '保存中...') : tr('Save holiday settings', '保存节假日设置') }}
    </button>
  </div>

  <div class="attendance__admin-section">
    <div class="attendance__admin-section-header">
      <h4>{{ tr('Holiday Sync', '节假日同步') }}</h4>
      <div class="attendance__admin-actions">
        <button class="attendance__btn" :disabled="holidaySyncLoading" @click="syncHolidays">{{ holidaySyncLoading ? tr('Syncing...', '同步中...') : tr('Sync now', '立即同步') }}</button>
        <button class="attendance__btn" :disabled="holidaySyncLoading" @click="syncCurrentYear">{{ tr('Sync current year', '同步当年') }}</button>
        <button class="attendance__btn" :disabled="holidaySyncLoading" @click="syncNextYear">{{ tr('Sync next year', '同步下一年') }}</button>
      </div>
    </div>
    <div class="attendance__admin-grid">
      <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-base-url">
        <span>{{ tr('Holiday source URL', '节假日数据源地址') }}</span>
        <input id="attendance-holiday-sync-base-url" v-model="settingsForm.holidaySyncBaseUrl" name="holidaySyncBaseUrl" type="text" />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-years">
        <span>{{ tr('Years (comma separated)', '年份（逗号分隔）') }}</span>
        <input id="attendance-holiday-sync-years" v-model="settingsForm.holidaySyncYears" name="holidaySyncYears" type="text" placeholder="2025,2026" />
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-sync-auto">
        <span>{{ tr('Auto sync (daily)', '自动同步（每日）') }}</span>
        <input id="attendance-holiday-sync-auto" v-model="settingsForm.holidaySyncAutoEnabled" name="holidaySyncAutoEnabled" type="checkbox" />
      </label>
      <label class="attendance__field" for="attendance-holiday-sync-auto-run">
        <span>{{ tr('Auto sync time', '自动同步时间') }}</span>
        <input id="attendance-holiday-sync-auto-run" v-model="settingsForm.holidaySyncAutoRunAt" name="holidaySyncAutoRunAt" type="time" />
      </label>
      <label class="attendance__field" for="attendance-holiday-sync-auto-tz">
        <span>{{ tr('Auto sync timezone', '自动同步时区') }}</span>
        <select id="attendance-holiday-sync-auto-tz" v-model="settingsForm.holidaySyncAutoTimezone" name="holidaySyncAutoTimezone">
          <optgroup
            v-for="group in holidaySyncTimezoneOptionGroups"
            :key="group.id"
            :label="tr(group.labelEn, group.labelZh)"
          >
            <option v-for="timezone in group.options" :key="timezone.value" :value="timezone.value">
              {{ timezone.label }}
            </option>
          </optgroup>
        </select>
        <small class="attendance__field-hint">
          {{ tr('Current', '当前') }}: {{ holidaySyncTimezoneStatusLabel || '--' }}
        </small>
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-sync-index">
        <span>{{ tr('Append day index', '追加节假日序号') }}</span>
        <input id="attendance-holiday-sync-index" v-model="settingsForm.holidaySyncAddDayIndex" name="holidaySyncAddDayIndex" type="checkbox" />
      </label>
      <label class="attendance__field attendance__field--full" for="attendance-holiday-sync-index-holidays">
        <span>{{ tr('Index holidays', '需要编号的节假日') }}</span>
        <input id="attendance-holiday-sync-index-holidays" v-model="settingsForm.holidaySyncDayIndexHolidays" name="holidaySyncDayIndexHolidays" type="text" placeholder="春节,国庆" />
      </label>
      <label class="attendance__field" for="attendance-holiday-sync-index-max">
        <span>{{ tr('Max index days', '最大编号天数') }}</span>
        <input id="attendance-holiday-sync-index-max" v-model.number="settingsForm.holidaySyncDayIndexMaxDays" name="holidaySyncDayIndexMaxDays" type="number" min="1" />
      </label>
      <label class="attendance__field" for="attendance-holiday-sync-index-format">
        <span>{{ tr('Index format', '编号格式') }}</span>
        <select id="attendance-holiday-sync-index-format" v-model="settingsForm.holidaySyncDayIndexFormat" name="holidaySyncDayIndexFormat">
          <option value="name-1">name-1</option>
          <option value="name第1天">name第1天</option>
          <option value="name DAY1">name DAY1</option>
        </select>
      </label>
      <label class="attendance__field attendance__field--checkbox" for="attendance-holiday-sync-overwrite">
        <span>{{ tr('Overwrite existing', '覆盖已有数据') }}</span>
        <input id="attendance-holiday-sync-overwrite" v-model="settingsForm.holidaySyncOverwrite" name="holidaySyncOverwrite" type="checkbox" />
      </label>
    </div>
    <div class="attendance__admin-meta">
      <strong>{{ tr('Last sync', '最近同步') }}</strong>
      <span v-if="holidaySyncLastRun?.ranAt">
        {{ formatDateTime(holidaySyncLastRun.ranAt) }}
        · {{ holidaySyncLastRun.success ? tr('success', '成功') : tr('failed', '失败') }}
        · {{ holidaySyncLastRun.totalApplied ?? 0 }} {{ tr('applied', '已应用') }} / {{ holidaySyncLastRun.totalFetched ?? 0 }} {{ tr('fetched', '已获取') }}
        <span v-if="holidaySyncLastRun.years && holidaySyncLastRun.years.length"> · {{ holidaySyncLastRun.years.join(',') }}</span>
        <span v-if="holidaySyncLastRun.error"> · {{ holidaySyncLastRun.error }}</span>
      </span>
      <span v-else>--</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import { buildTimezoneOptionGroups, formatTimezoneStatusLabel } from './attendanceTimezones'

type Translate = (en: string, zh: string) => string
type MaybePromise<T> = T | Promise<T>

interface HolidayOverrideFormState {
  name: string
  match: 'contains' | 'regex' | 'equals'
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
  firstDayEnabled?: boolean
  firstDayBaseHours?: number
  overtimeAdds?: boolean
  overtimeSource?: 'approval' | 'clock' | 'both'
}

interface HolidaySyncLastRun {
  ranAt?: string | null
  success?: boolean | null
  years?: number[] | null
  totalFetched?: number | null
  totalApplied?: number | null
  error?: string | null
}

interface SettingsFormState {
  holidayFirstDayEnabled: boolean
  holidayFirstDayBaseHours: number
  holidayOvertimeAdds: boolean
  holidayOvertimeSource: 'approval' | 'clock' | 'both'
  holidayOverrides: HolidayOverrideFormState[]
  holidaySyncBaseUrl: string
  holidaySyncYears: string
  holidaySyncAddDayIndex: boolean
  holidaySyncDayIndexHolidays: string
  holidaySyncDayIndexMaxDays: number
  holidaySyncDayIndexFormat: 'name-1' | 'name第1天' | 'name DAY1'
  holidaySyncOverwrite: boolean
  holidaySyncAutoEnabled: boolean
  holidaySyncAutoRunAt: string
  holidaySyncAutoTimezone: string
}

interface HolidayRuleBindings {
  addHolidayOverride: () => MaybePromise<void>
  holidaySyncLastRun: Ref<HolidaySyncLastRun | null>
  holidaySyncLoading: Ref<boolean>
  removeHolidayOverride: (index: number) => MaybePromise<void>
  saveSettings: () => MaybePromise<void>
  settingsForm: SettingsFormState
  settingsLoading: Ref<boolean>
  syncHolidays: () => MaybePromise<void>
  syncHolidaysForYears: (years: number[]) => MaybePromise<void>
}

const props = defineProps<{
  attendanceGroupOptions: string[]
  config: HolidayRuleBindings
  formatDateTime: (value: string | null | undefined) => string
  tr: Translate
}>()

const tr = props.tr
const attendanceGroupOptions = props.attendanceGroupOptions
const formatDateTime = props.formatDateTime
const holidaySyncLastRun = props.config.holidaySyncLastRun
const holidaySyncLoading = props.config.holidaySyncLoading
const saveSettings = () => props.config.saveSettings()
const settingsForm = props.config.settingsForm
const holidaySyncTimezoneOptionGroups = computed(() => buildTimezoneOptionGroups(settingsForm.holidaySyncAutoTimezone))
const holidaySyncTimezoneStatusLabel = computed(() => formatTimezoneStatusLabel(settingsForm.holidaySyncAutoTimezone))
const settingsLoading = props.config.settingsLoading
const syncHolidays = () => props.config.syncHolidays()
const syncHolidaysForYears = (years: number[]) => props.config.syncHolidaysForYears(years)
const holidayOverridesExpanded = ref((settingsForm.holidayOverrides?.length ?? 0) > 0)

watch(() => settingsForm.holidayOverrides.length, (next, prev) => {
  if (next > prev) holidayOverridesExpanded.value = true
})

const holidayOverrideSummary = computed(() => {
  const count = settingsForm.holidayOverrides.length
  return count === 0 ? tr('No overrides configured', '暂无覆盖规则') : tr(`${count} override(s) configured`, `已配置 ${count} 条规则`)
})

const toggleHolidayOverrides = () => {
  holidayOverridesExpanded.value = !holidayOverridesExpanded.value
}

const addHolidayOverrideAndExpand = () => {
  holidayOverridesExpanded.value = true
  props.config.addHolidayOverride()
}

const removeHolidayOverride = (index: number) => props.config.removeHolidayOverride(index)
const currentYear = new Date().getFullYear()
const syncCurrentYear = () => syncHolidaysForYears([currentYear])
const syncNextYear = () => syncHolidaysForYears([currentYear + 1])
</script>

<style scoped>
.attendance__admin-section { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.attendance__admin-section-header, .attendance__admin-subsection-header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.attendance__admin-subsection-header--accordion { align-items: stretch; }
.attendance__admin-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.attendance__admin-actions, .attendance__override-filters { display: flex; gap: 8px; flex-wrap: wrap; }
.attendance__override-filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.attendance__admin-subsection, .attendance__field, .attendance__override-field, .attendance__accordion-copy, .attendance__admin-meta { display: flex; flex-direction: column; gap: 6px; }
.attendance__field--full { grid-column: 1 / -1; }
.attendance__field--checkbox { justify-content: flex-end; }
.attendance__field-hint { color: #777; font-size: 11px; }
.attendance__accordion { flex: 1; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 10px; border: 1px solid #d0d0d0; background: #fff; cursor: pointer; text-align: left; }
.attendance__accordion-copy small, .attendance__accordion-indicator { color: #666; font-size: 12px; }
.attendance__btn { padding: 8px 14px; border-radius: 6px; border: 1px solid #d0d0d0; background: #fff; cursor: pointer; }
.attendance__btn--primary { background: #1976d2; border-color: #1976d2; color: #fff; }
.attendance__btn--danger { border-color: #e53935; color: #e53935; }
.attendance__btn:disabled { opacity: 0.6; cursor: not-allowed; }
.attendance__table-wrapper { width: 100%; overflow-x: auto; }
.attendance__table { width: 100%; border-collapse: collapse; margin-top: 12px; }
.attendance__table-col--holiday-name, .attendance__table-cell--holiday-name { min-width: 280px; width: 32%; }
.attendance__table th, .attendance__table td { border-bottom: 1px solid #e0e0e0; padding: 8px; text-align: left; font-size: 13px; }
.attendance__table-row--meta td { background: #fafafa; }
.attendance__table-input { width: 100%; min-width: 0; box-sizing: border-box; }
.attendance__empty { color: #888; font-size: 13px; margin-top: 8px; }
.attendance__admin-meta { color: #555; font-size: 13px; }
</style>
