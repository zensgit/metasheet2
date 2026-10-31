<template>
  <div v-if="targets" class="attendance__request-meta" data-frozen-correction-targets>
    <span v-for="side in sides" :key="side.key">
      <template v-if="targets[side.key]">
        {{ side.key === 'checkIn' ? tr('Check-in', '上班') : tr('Check-out', '下班') }} ·
        {{ tr('Segment', '班段') }} {{ (targets[side.key]?.segmentIndex ?? 0) + 1 }} ·
        {{ describe(targets[side.key]) }}
      </template>
    </span>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { parseFrozenTargets, type Target } from './attendanceCorrectionTargets'
const props = defineProps<{ tr: (en: string, zh: string) => string; value: unknown }>()
const targets = computed(() => parseFrozenTargets(props.value))
const sides = [{ key: 'checkIn' }, { key: 'checkOut' }] as const
function describe(target: Target | null): string {
  if (!target) return ''
  return target.kind === 'insertion' ? props.tr('Verified missing punch', '已核实缺卡')
    : `${props.tr('Replaces frozen evidence', '替换已冻结打卡证据')}: ${target.evidenceRef}`
}
</script>
