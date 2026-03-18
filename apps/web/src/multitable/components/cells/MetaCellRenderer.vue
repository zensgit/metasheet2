<template>
  <span class="meta-cell-renderer" :class="[`meta-cell-renderer--${field.type}`, conditionalClass]">
    <!-- string / formula -->
    <template v-if="field.type === 'string' || field.type === 'formula'">{{ displayValue }}</template>

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
      <span v-for="(id, i) in linkIds" :key="i" class="meta-cell-renderer__link">{{ id }}</span>
    </template>

    <!-- lookup / rollup -->
    <template v-else>{{ displayValue }}</template>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MetaField } from '../../types'

const props = defineProps<{ field: MetaField; value: unknown }>()

const displayValue = computed(() => {
  const v = props.value
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
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
.meta-cell-renderer--empty { color: #ccc; }
.meta-cell-renderer--positive { color: #67c23a; }
.meta-cell-renderer--negative { color: #f56c6c; }
</style>
