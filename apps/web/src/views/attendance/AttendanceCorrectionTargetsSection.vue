<template>
  <section class="correction-targets" data-correction-targets>
    <p v-if="loading">{{ tr('Loading correction targets…', '正在加载补卡目标…') }}</p>
    <p v-else-if="error" role="alert">
      {{ error === 'ATTENDANCE_CORRECTION_TARGET_STALE'
        ? tr('The target changed. Refresh and choose again.', '补卡目标已变化，请刷新后重新选择。')
        : tr('Correction targets are unavailable. Check the work date or contact an administrator.', '无法获取补卡目标，请检查工作日期或联系管理员。') }}
      <button type="button" @click="emit('refresh')">{{ tr('Refresh', '刷新') }}</button>
    </p>
    <template v-else-if="result?.posture === 'canonical'">
      <div v-for="side in sides" :key="side.key">
        <label v-if="requested[side.key]">
          {{ side.key === 'checkIn' ? tr('Check-in target', '上班补卡目标') : tr('Check-out target', '下班补卡目标') }}
          <select :value="chosen[side.key] ?? (options(side.direction).length === 1 ? options(side.direction)[0].index : '')" @change="choose(side.key, $event)">
            <option value="">{{ tr('Select a target (unique target is selected automatically)', '请选择目标（唯一目标自动选用）') }}</option>
            <option v-for="item in options(side.direction)" :key="item.index" :value="item.index">
              {{ label(item.candidate) }}
            </option>
          </select>
        </label>
      </div>
    </template>
  </section>
</template>
<script setup lang="ts">
import type { Candidate, Direction, Result } from './attendanceCorrectionTargets'
const props = defineProps<{
  tr: (en: string, zh: string) => string
  result: Result | null; loading: boolean; error: string
  chosen: { checkIn: number | null; checkOut: number | null }
  requested: { checkIn: boolean; checkOut: boolean }
}>()
const emit = defineEmits<{ refresh: []; select: [side: 'checkIn' | 'checkOut', index: number | null] }>()
const sides = [{ key: 'checkIn', direction: 'check_in' }, { key: 'checkOut', direction: 'check_out' }] as const
function options(direction: Direction): { candidate: Candidate; index: number }[] {
  return props.result?.posture === 'canonical'
    ? props.result.candidates.map((candidate, index) => ({ candidate, index })).filter(item => item.candidate.target.direction === direction) : []
}
function label(item: Candidate): string {
  const d = item.display
  const boundary = item.target.direction === 'check_in' ? props.tr('check-in', '上班') : props.tr('check-out', '下班')
  const original = item.target.kind === 'insertion' ? props.tr('verified missing punch', '已核实缺卡') : `${props.tr('original', '原打卡')}: ${d.originalOccurredAt}`
  const reference = item.target.kind === 'replacement'
    ? ' · ' + props.tr('Source', '来源') + ': ' + d.source + ' · ' + props.tr('Reference', '原记录标识') + ': ' + item.target.evidenceRef : ''
  return `${props.tr('Segment', '班段')} ${item.target.segmentIndex + 1} · ${boundary} · ${d.expectedStartAt} – ${d.expectedEndAt} (${d.timezone}) · ${original}${reference}`
}
function choose(side: 'checkIn' | 'checkOut', event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  emit('select', side, value === '' ? null : Number(value))
}
</script>
<style scoped>
.correction-targets { grid-column: 1 / -1; display: grid; gap: 8px; }
.correction-targets label { display: grid; gap: 6px; }
.correction-targets select { max-width: 100%; }
</style>
