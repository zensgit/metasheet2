<template>
  <div class="range-toolbar" data-test="grid-range-toolbar">
    <label>{{ zh ? '填充方式' : 'Fill mode' }}
      <select :value="mode" :disabled="busy" data-test="range-mode" @change="changeMode">
        <option value="copy">{{ zh ? '复制' : 'Copy' }}</option>
        <option value="series">{{ zh ? '等差序列' : 'Series' }}</option>
      </select>
    </label>
    <button :disabled="busy || !selected" data-test="range-copy" @click="$emit('copy')">{{ zh ? '复制选区' : 'Copy range' }}</button>
    <button :disabled="busy || !selected" data-test="range-paste" @click="$emit('paste')">{{ zh ? '粘贴到选区' : 'Paste range' }}</button>
    <span>{{ zh ? '拖动或 Shift 选区，再拖右下角填充。最多 1,000 格；填充不支持撤销。' : 'Drag or Shift-select, then drag the corner to fill. Up to 1,000 cells; range writes cannot be undone here.' }}</span>
    <span v-if="busy" role="status">{{ zh ? '处理中…' : 'Working…' }}</span>
    <span v-else-if="status" role="status" data-test="range-status">{{ message }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { FillMode } from '../utils/grid-range-fill'
const props = defineProps<{ mode: FillMode; busy: boolean; selected: boolean; status: string; zh: boolean }>()
const emit = defineEmits<{ (e: 'update:mode', value: FillMode): void; (e: 'copy'): void; (e: 'paste'): void }>()
function changeMode(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (value === 'copy' || value === 'series') emit('update:mode', value)
}
const message = computed(() => {
  const pairs: Record<string, [string, string]> = {
    DONE: ['填充已保存（不支持选区撤销）。', 'Range saved (range undo is unavailable).'],
    COPIED: ['选区已复制。', 'Range copied.'],
    STALE: ['数据或视图已变化，请重新选择。', 'Data or view changed. Select the range again.'],
    RANGE_STALE: ['数据版本已变化，请刷新后重新选择。', 'Data changed. Refresh and select again.'],
    RANGE_REFRESH_REQUIRED: ['填充已保存，但显示刷新失败；请刷新核对，无需重复提交。', 'Range saved, but display refresh failed. Refresh to check; do not resubmit.'],
    READ_ONLY: ['选区含不可写单元格，未提交。', 'Range contains read-only cells; nothing submitted.'],
    RANGE_READ_ONLY: ['选区含不可写单元格，未提交。', 'Range contains read-only cells; nothing submitted.'],
    TOO_LARGE: ['单次最多填写 1,000 格。', 'Limit: 1,000 destination cells.'],
    INVALID_SERIES: ['仅支持数字或日期的等差序列。', 'Use constant-step numeric or date series.'],
    INCOMPATIBLE_TYPE: ['源与目标字段类型不匹配。', 'Source and destination field types differ.'],
    INVALID_VALUE: ['有值不符合目标字段规则，未提交。', 'A value is invalid for its destination; nothing submitted.'],
    INVALID_CLIPBOARD: ['剪贴板不是有效的矩形表格。', 'Clipboard is not a valid rectangular table.'],
    OUT_OF_BOUNDS: ['目标超出已加载的可见单元格。', 'Destination exceeds loaded visible cells.'],
    CLIPBOARD: ['无法访问剪贴板，请检查浏览器权限。', 'Clipboard unavailable. Check browser permissions.'],
  }
  const pair = pairs[props.status] ?? ['操作未确认成功，请刷新核对后再试。', 'Operation not confirmed. Refresh and check before retrying.']
  return pair[props.zh ? 0 : 1]
})
</script>

<style scoped>
.range-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; background: #f4f7ff; font-size: 12px; }
.range-toolbar label { display: flex; align-items: center; gap: 6px; }
.range-toolbar button, .range-toolbar select { border: 1px solid #b8c6e4; border-radius: 4px; padding: 4px 8px; background: white; }
.range-toolbar button:disabled { opacity: .5; }
</style>
