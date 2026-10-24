<template>
  <section aria-label="焊缝长度统计">
    <h3>焊缝长度统计</h3>
    <p role="status">{{ basis.label }}</p>
    <p>按全部焊缝的参与统计设置汇总，表格选择和图层隐藏不改变统计范围。三类长度独立计算。</p>
    <table>
      <thead><tr><th>范围</th><th>参与 / 全部</th><th>CAD 几何长度 mm</th><th>制造长度 mm</th><th>人工测量长度 mm</th></tr></thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key">
          <th>{{ row.label }}</th><td>{{ row.included_count }} / {{ row.weld_count }}</td>
          <td v-for="kind in kinds" :key="kind">{{ format(row[kind]) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { equal, isObject, type PlanPayload } from '../../services/welding/planRecovery'
import type { PlanRecord } from '../../services/welding/planClient'
import { measurementRows, summarizeWelds, type LengthMetric } from '../../services/welding/measurements'

const props = defineProps<{ payload: PlanPayload; measurement: unknown; savedPoint: PlanRecord | null }>()
const kinds = ['geometry', 'manufacturing', 'manual'] as const
const basis = computed(() => {
  const overlay = props.payload.overlay
  const ids = isObject(overlay) && Array.isArray(overlay.bindings) ? overlay.bindings.map(row => row.weld_id) : []
  const saved = props.savedPoint
  if (saved && equal(saved.payload, props.payload)) {
    const verified = measurementRows(saved.sources.geometry_measurement, props.payload.welds.map(weld => weld.weld_id), true)
    if (verified) return { rows: verified, label: `已保存核验 · 保存序号 ${saved.draft_seq} · 历史快照，非实时测量` }
  }
  const preview = measurementRows(props.measurement, ids)
  if (preview) return { rows: preview, label: '草稿几何预览 · 尚未作为保存核验结果' }
  return { rows: null, label: '当前几何量未知 · 请打开固定图纸；旧保存结果不代表当前草稿' }
})
const rows = computed(() => {
  const value = summarizeWelds(props.payload, basis.value.rows)
  return [{ key: 'total', label: '总计', ...value.totals }, ...value.groups.map(group => ({ ...group, key: `group:${group.group_name}`, label: group.group_name || '未分组' }))]
})
function format(metric: LengthMetric) {
  const value = metric.value_mm === null ? '不可用（合计溢出）' : metric.value_mm.toFixed(3)
  return `${value} · 已知 ${metric.known_count} / 缺失 ${metric.missing_count} · ${metric.complete ? '完整' : '不完整'}`
}
</script>
<style scoped>
table { border-collapse: collapse; width: 100%; } th, td { padding: 8px; border: 1px solid #d9e2ec; text-align: left; }
</style>
