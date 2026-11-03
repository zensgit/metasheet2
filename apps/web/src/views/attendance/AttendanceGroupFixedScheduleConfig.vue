<template>
  <div data-attendance-group-fixed-schedule-config>
    <p class="attendance__field-hint" data-attendance-group-fixed-schedule-config-state>
      {{ stateLabel }}
      <template v-if="editor?.desired"> · {{ tr('Revision', '版本') }} {{ editor.desired.revision }}</template>
    </p>
    <p v-if="errorMessage" role="alert" data-attendance-group-fixed-schedule-config-error>{{ errorMessage }}</p>
    <p v-if="eligibilityHint" class="attendance__field-hint" data-attendance-group-fixed-schedule-eligibility>{{ eligibilityHint }}</p>
    <div class="attendance__admin-actions">
      <button type="button" class="attendance__btn" :disabled="busy" data-attendance-group-fixed-schedule-config-reload @click="$emit('reload')">
        {{ tr('Reload saved configuration', '重新加载已保存配置') }}
      </button>
      <button type="button" class="attendance__btn" :disabled="!saveAvailable" data-attendance-group-fixed-schedule-config-save @click="$emit('save')">
        {{ saving ? tr('Saving...', '保存中...') : tr('Save desired configuration', '保存期望配置') }}
      </button>
    </div>
    <p class="attendance__field-hint">{{ tr('Saving only records the desired shift and dates. Apply or rebuild writes assignments; existing frozen attendance context stays unchanged.', '保存仅记录期望班次与日期；应用或重建才写入排班，已有冻结考勤上下文保持不变。') }}</p>
    <label v-if="editor && (editor.drift.managedSets.length || managedKey)" class="attendance__field">
      <span>{{ tr('Existing managed schedule to clear', '待清除的已有管理排班') }}</span>
      <select :value="managedKey" :disabled="busy" data-attendance-group-fixed-schedule-managed-set @change="$emit('select-managed', ($event.target as HTMLSelectElement).value)">
        <option value="">{{ tr('Current saved shift and window', '当前已保存班次与窗口') }}</option>
        <option v-if="managedKey && !editor.drift.managedSets.some(set => managedKeyFor(set) === managedKey)" :value="managedKey" disabled>{{ tr('Selected managed set is no longer available; choose again', '所选管理排班已不可用，请重新选择') }}</option>
        <option v-for="(set, index) in editor.drift.managedSets" :key="managedKeyFor(set)" :value="managedKeyFor(set)" :disabled="!set.endDate">
          {{ tr('Existing set', '已有排班组') }} {{ index + 1 }} · {{ shiftLabelFor(set.shiftId) }} · {{ set.startDate }} – {{ set.endDate ?? tr('Unavailable window', '窗口不可用') }} · {{ set.rowCount }} {{ tr('rows', '条') }}
        </option>
      </select>
      <small v-if="editor.drift.managedSets.some(set => !set.endDate)">{{ tr('A legacy set without a finite end date cannot be cleared here. No date will be inferred.', '缺少有限结束日期的历史排班无法在此清除，不会推断日期。') }}</small>
      <small>{{ tr('Clear acts only on this exact shift and date window. It does not save your draft or clear other schedules.', '清除仅作用于所选班次与日期窗口，不保存草稿，也不清除其它排班。') }}</small>
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { FixedScheduleEditor, FixedScheduleManagedSet } from './useAttendanceGroupFixedSchedule'
const props = defineProps<{
  editor: FixedScheduleEditor | null
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  errorMessage: string
  eligibilityHint: string
  saveAvailable: boolean
  busy: boolean
  saving: boolean
  managedKey: string
  managedKeyFor: (set: FixedScheduleManagedSet) => string
  shiftLabelFor: (id: string) => string
}>()
defineEmits<{ reload: []; save: []; 'select-managed': [key: string] }>()
const { isZh } = useLocale()
const tr = (en: string, zh: string) => isZh.value ? zh : en
const stateLabel = computed(() => {
  if (props.loadState === 'loading') return tr('Loading saved configuration...', '正在加载已保存配置...')
  if (props.loadState !== 'ready' || !props.editor) return tr('Saved configuration unavailable', '已保存配置不可用')
  const labels = {
    not_configured: ['Not configured', '尚未配置'],
    configuration_changed: ['Configuration changed; existing managed rows need review', '配置已变化，请核对已有管理排班'],
    effective: ['Effective', '已生效'],
    pending_apply: ['Saved; pending apply', '已保存，待应用'],
  }
  const label = labels[props.editor.state]
  return tr(label[0]!, label[1]!)
})
</script>

<style scoped>
[data-attendance-group-fixed-schedule-config] {
  display: grid;
  gap: 8px;
  min-width: 0;
}
p { margin: 0; }
.attendance__field-hint, small {
  color: #777;
  font-size: 11px;
  overflow-wrap: anywhere;
}
[role='alert'] { color: #c0392b; font-size: 12px; }
.attendance__admin-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.attendance__btn {
  padding: 8px 14px;
  border-radius: var(--ms-radius-md, 6px);
  border: 1px solid var(--ms-border, #d0d0d0);
  background: var(--ms-bg-card, #fff);
  color: var(--ms-text-1, #333);
  cursor: pointer;
}
.attendance__btn:disabled { opacity: 0.6; cursor: not-allowed; }
.attendance__field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #555; }
select {
  padding: 6px 10px;
  border: 1px solid #d0d0d0;
  border-radius: 6px;
  min-width: 0;
  max-width: 100%;
}
</style>
