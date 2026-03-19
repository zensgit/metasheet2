<template>
  <span class="meta-cell-renderer" :class="[`meta-cell-renderer--${field.type}`, conditionalClass]">
    <!-- string / formula -->
    <template v-if="field.type === 'string' || field.type === 'formula'">{{ displayValue }}</template>

    <!-- date -->
    <template v-else-if="field.type === 'date'">
      <span class="meta-cell-renderer__date">{{ dateDisplay }}</span>
    </template>

    <!-- number -->
    <template v-else-if="field.type === 'number'">{{ displayValue }}</template>

    <!-- boolean -->
    <template v-else-if="field.type === 'boolean'">
      <span class="meta-cell-renderer__bool">{{ value ? '\u2611' : '\u2610' }}</span>
    </template>

    <!-- select -->
    <template v-else-if="field.type === 'select'">
      <span
        v-for="(tag, i) in selectTags"
        :key="i"
        class="meta-cell-renderer__tag"
        :style="{ background: tag.color ?? '#e8eaed', color: tag.color ? '#fff' : '#333' }"
      >{{ tag.value }}</span>
    </template>

    <!-- link -->
    <template v-else-if="field.type === 'link'">
      <span v-for="item in linkItems" :key="item.id" class="meta-cell-renderer__link">{{ item.display }}</span>
    </template>

    <!-- attachment -->
    <template v-else-if="field.type === 'attachment'">
      <span v-if="!attachmentIds.length" class="meta-cell-renderer--empty"></span>
      <span v-for="attId in attachmentIds" :key="attId" class="meta-cell-renderer__attachment" :title="attId">
        <span class="meta-cell-renderer__attachment-icon">{{ mimeIcon(attId) }}</span>
        <span class="meta-cell-renderer__attachment-name">{{ attId }}</span>
      </span>
    </template>

    <!-- lookup / rollup -->
    <template v-else>{{ displayValue }}</template>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MetaField, LinkedRecordSummary } from '../../types'

const props = defineProps<{ field: MetaField; value: unknown; linkSummaries?: LinkedRecordSummary[] }>()

const displayValue = computed(() => {
  const v = props.value
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
})

const dateDisplay = computed(() => {
  const v = props.value
  if (v === null || v === undefined || v === '') return ''
  try {
    const d = new Date(String(v))
    if (isNaN(d.getTime())) return String(v)
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch { return String(v) }
})

const selectTags = computed(() => {
  const v = props.value
  const raw = Array.isArray(v) ? v : v ? [v] : []
  const optMap = new Map((props.field.options ?? []).map((o) => [o.value, o]))
  return raw.map((val) => {
    const opt = optMap.get(String(val))
    return { value: String(val), color: opt?.color }
  })
})

const linkIds = computed(() => {
  const v = props.value
  if (Array.isArray(v)) return v.map(String)
  if (v) return [String(v)]
  return []
})

const linkItems = computed(() => {
  if (props.linkSummaries?.length) {
    return props.linkSummaries.map((item) => ({
      id: item.id,
      display: item.display || item.id,
    }))
  }
  return linkIds.value.map((id) => ({ id, display: id }))
})

const attachmentIds = computed(() => {
  const v = props.value
  if (Array.isArray(v)) return v.map(String)
  if (v) return [String(v)]
  return []
})

function mimeIcon(_id: string): string {
  // Simple icon based on file extension heuristic
  return '\uD83D\uDCCE' // paperclip emoji
}

// Conditional formatting: subtle background hints
const conditionalClass = computed(() => {
  const v = props.value
  if (v === null || v === undefined || v === '') return 'meta-cell-renderer--empty'
  if (props.field.type === 'boolean') return v ? 'meta-cell-renderer--positive' : 'meta-cell-renderer--negative'
  if (props.field.type === 'number' && typeof v === 'number') {
    if (v > 0) return 'meta-cell-renderer--positive'
    if (v < 0) return 'meta-cell-renderer--negative'
  }
  return ''
})
</script>

<style scoped>
.meta-cell-renderer { font-size: 13px; line-height: 1.4; }
.meta-cell-renderer__bool { font-size: 16px; }
.meta-cell-renderer__tag {
  display: inline-block; padding: 1px 6px; border-radius: 3px;
  font-size: 11px; margin-right: 4px; white-space: nowrap;
}
.meta-cell-renderer__link {
  display: inline-block; padding: 1px 6px; background: #ecf5ff;
  color: #409eff; border-radius: 3px; font-size: 11px; margin-right: 4px;
}
.meta-cell-renderer__date { color: #606266; }
.meta-cell-renderer__attachment {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 1px 6px; background: #f0f4f8; border-radius: 3px;
  font-size: 11px; margin-right: 4px; white-space: nowrap;
  max-width: 120px; overflow: hidden; text-overflow: ellipsis;
}
.meta-cell-renderer__attachment-icon { font-size: 12px; }
.meta-cell-renderer__attachment-name { overflow: hidden; text-overflow: ellipsis; }
.meta-cell-renderer--empty { color: #ccc; }
.meta-cell-renderer--positive { color: #67c23a; }
.meta-cell-renderer--negative { color: #f56c6c; }
</style>
