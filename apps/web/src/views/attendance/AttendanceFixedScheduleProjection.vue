<template>
  <section class="attendance-fixed-schedule" :data-fser4-surface="surface" aria-live="polite">
    <header>
      <h4>{{ tr('Fixed-schedule effectiveness', '固定排班生效情况') }}</h4>
      <button type="button" :disabled="!enabled || model.status.value === 'loading' || !selectedGroupId" data-fser4-reload @click="model.load()">
        {{ tr('Refresh status', '刷新状态') }}
      </button>
    </header>
    <div v-if="!groupId" class="attendance-fixed-schedule__context">
      <label>
        <span>{{ tr('Attendance group', '考勤组') }}</span>
        <select v-model="selected" :disabled="!enabled || catalogLoading || choices.length === 0" data-fser4-group-select>
          <option value="">{{ tr('Select a group', '请选择考勤组') }}</option>
          <option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ choice.label }}</option>
        </select>
      </label>
      <button v-if="surface === 'report'" type="button" :disabled="!enabled || catalogLoading" data-fser4-load-groups @click="$emit('load-groups')">
        {{ catalogLoading ? tr('Loading groups...', '正在加载考勤组...') : tr('Load groups', '加载考勤组') }}
      </button>
    </div>
    <p v-if="surface === 'employee' || surface === 'self-trace'" class="attendance-fixed-schedule__hint">
      {{ tr('This shows your membership group’s current configuration, not the calculation attribution for a work date.', '此处显示本人所属组的当前配置，不代表某个工作日的计算归属。') }}
    </p>
    <p v-if="surface === 'self-trace' || surface === 'admin-trace'" class="attendance-fixed-schedule__hint">
      {{ tr('Current group configuration; this does not replace the historical decision snapshot or select a traced employee’s group.', '这是当前考勤组配置，不替代历史决策快照，也不据此推定所查员工的考勤组。') }}
    </p>
    <p v-if="model.status.value === 'loading'" data-fser4-loading>{{ tr('Loading status...', '正在读取状态...') }}</p>
    <p v-else-if="model.status.value !== 'ready' || !projection" data-fser4-unavailable>
      {{ tr('Fixed-schedule status is unavailable. Refresh or select an accessible group.', '固定排班状态不可用，请刷新或选择有权访问的考勤组。') }}
    </p>
    <div v-else class="attendance-fixed-schedule__data">
      <p :data-fser4-state="projection.state">{{ attendanceGroupFixedScheduleStateText(projection.state, tr) }}</p>
      <template v-if="surface !== 'report'">
        <p v-if="projection.desired" data-fser4-desired>
          {{ tr('Desired window', '期望日期范围') }}:
          {{ projection.desired.startDate }} — {{ projection.desired.endDate }}
          · {{ tr('Revision', '版本') }} {{ projection.desired.revision }}
        </p>
        <p v-if="selfData" :data-fser4-applicability="selfData.applicability">{{ applicabilityText }}</p>
        <ul data-fser4-reasons>
          <li v-for="reason in projection.reasonCodes" :key="reason">{{ reason }}</li>
        </ul>
      </template>
      <dl v-if="adminData && (surface === 'group' || surface === 'report')" data-fser4-coverage>
        <div><dt>{{ tr('Target members', '目标成员') }}</dt><dd>{{ adminData.coverage.targetMembers }}</dd></div>
        <div><dt>{{ tr('Matching members', '匹配成员') }}</dt><dd>{{ adminData.coverage.matchingMembers }}</dd></div>
        <div><dt>{{ tr('Missing members', '缺失成员') }}</dt><dd>{{ adminData.coverage.missingMembers }}</dd></div>
        <div><dt>{{ tr('Non-member targets', '非成员目标') }}</dt><dd>{{ adminData.coverage.nonMemberTargets }}</dd></div>
        <div><dt>{{ tr('Different-key rows', '不同排班集记录') }}</dt><dd>{{ adminData.coverage.differentKeyRows }}</dd></div>
      </dl>
      <div v-if="adminData && surface === 'group'" data-fser4-drift>
        <p>{{ tr('Unconfigured managed rows', '未配置的受管记录') }}: {{ adminData.drift.unconfiguredManagedRows }}</p>
        <p>{{ tr('Unpublished managed rows', '未发布的受管记录') }}: {{ adminData.drift.unpublishedManagedRows }}</p>
      </div>
      <div v-if="adminData && surface === 'admin-trace'" data-fser4-producer-comparison>
        <p>{{ tr('Server-returned managed sets', '服务端返回的受管排班集') }}: {{ adminData.drift.managedSets.length }}</p>
        <ul>
          <li v-for="(set, index) in adminData.drift.managedSets" :key="index">
            <code>{{ set.producerKey }}</code> · {{ set.startDate }} — {{ set.endDate ?? tr('Open end', '开放结束日期') }}
            · {{ tr('Rows', '记录数') }} {{ set.rowCount }}
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { attendanceGroupFixedScheduleStateText } from './attendanceGroupEffectivePolicyLabels'
import { useAttendanceFixedScheduleEffectiveness } from './useAttendanceFixedScheduleEffectiveness'

type Surface = 'group' | 'employee' | 'self-trace' | 'admin-trace' | 'report'
interface GroupChoice { id?: string | null; name?: string | null; code?: string | null }
const props = withDefaults(defineProps<{
  surface: Surface
  groupId?: string | null
  groups?: readonly GroupChoice[]
  contextKey?: string
  expectedOrgId?: string | null
  refreshKey?: string | number | null
  editorRevision?: number | null
  enabled?: boolean
  catalogLoading?: boolean
  autoLoadGroups?: boolean
}>(), { groupId: null, groups: () => [], contextKey: '', expectedOrgId: null, refreshKey: null, editorRevision: null, enabled: true, catalogLoading: false, autoLoadGroups: false })
const emit = defineEmits<{ (event: 'load-groups'): void }>()
const { isZh } = useLocale()
const tr = (en: string, zh: string) => isZh.value ? zh : en
const selected = ref('')
const validSurface = computed(() => ['group', 'employee', 'self-trace', 'admin-trace', 'report'].includes(props.surface))
const adminSurface = computed(() => props.surface === 'group' || props.surface === 'admin-trace' || props.surface === 'report')
const choices = computed(() => props.groups.filter((group): group is GroupChoice & { id: string } => typeof group.id === 'string' && group.id.length > 0)
  .map(group => ({ id: group.id, label: group.name || group.code || tr('Attendance group', '考勤组') })))
watch(() => JSON.stringify([props.groupId, choices.value.map(group => group.id)]), () => {
  if (!choices.value.some(group => group.id === selected.value)) selected.value = choices.value[0]?.id ?? ''
}, { immediate: true, flush: 'sync' })
const selectedGroupId = computed(() => props.groupId || selected.value)
const model = useAttendanceFixedScheduleEffectiveness({
  audience: () => adminSurface.value ? 'admin' : 'self',
  groupId: () => selectedGroupId.value,
  expectedOrgId: () => props.expectedOrgId,
  contextKey: () => JSON.stringify([props.surface, props.contextKey, props.refreshKey, props.editorRevision]),
  enabled: () => props.enabled && validSurface.value,
})
const projection = computed(() => {
  const value = model.data.value
  if (props.surface === 'group' && props.editorRevision !== null
    && (value?.desired?.revision ?? 0) !== props.editorRevision) return null
  return value
})
const selfData = computed(() => projection.value && 'applicability' in projection.value ? projection.value : null)
const adminData = computed(() => projection.value && 'coverage' in projection.value ? projection.value : null)
const applicabilityText = computed(() => {
  const value = selfData.value?.applicability
  if (value === 'matching') return tr('My assignment matches the desired configuration', '本人的排班与期望配置匹配')
  if (value === 'non_matching') return tr('My assignment does not match the desired configuration', '本人的排班与期望配置不匹配')
  if (value === 'not_configured') return tr('No desired configuration', '尚无期望配置')
  return tr('Unavailable', '不可用')
})
onMounted(() => {
  if (props.autoLoadGroups && props.enabled && adminSurface.value && !choices.value.length && !props.catalogLoading) emit('load-groups')
})
</script>

<style scoped>
.attendance-fixed-schedule { min-width: 0; max-width: 100%; margin: 12px 0; padding: 14px; border: 1px solid var(--el-border-color, #d8dee7); border-radius: 8px; overflow-wrap: anywhere; }
.attendance-fixed-schedule header, .attendance-fixed-schedule__context { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.attendance-fixed-schedule h4 { margin: 0; }
.attendance-fixed-schedule label { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; max-width: 100%; }
.attendance-fixed-schedule select { min-width: 0; max-width: 100%; }
.attendance-fixed-schedule button { white-space: normal; }
.attendance-fixed-schedule__hint { color: var(--el-text-color-secondary, #586174); font-size: 13px; }
.attendance-fixed-schedule dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.attendance-fixed-schedule dl div { min-width: 0; }
.attendance-fixed-schedule dd { margin: 4px 0 0; font-weight: 600; }
.attendance-fixed-schedule ul { padding-left: 20px; }
@media (max-width: 480px) {
  .attendance-fixed-schedule header { align-items: stretch; }
  .attendance-fixed-schedule__context label, .attendance-fixed-schedule select { width: 100%; }
}
</style>
