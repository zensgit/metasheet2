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
      <span
        v-for="item in linkItems"
        :key="item.id"
        class="meta-cell-renderer__link"
        :class="{ 'meta-cell-renderer__link--person': isPersonLink }"
      >{{ item.display }}</span>
    </template>

    <!-- attachment -->
    <template v-else-if="field.type === 'attachment'">
      <MetaAttachmentList :attachments="attachmentItems" variant="compact" empty-label="" />
    </template>

    <!-- lookup / rollup -->
    <template v-else>{{ displayValue }}</template>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MetaField, LinkedRecordSummary, MetaAttachment } from '../../types'
import MetaAttachmentList from '../MetaAttachmentList.vue'
import { isPersonField } from '../../utils/link-fields'
import { formatFieldDisplay } from '../../utils/field-display'

const props = defineProps<{
  field: MetaField
  value: unknown
  linkSummaries?: LinkedRecordSummary[]
  attachmentSummaries?: MetaAttachment[]
}>()

const displayValue = computed(() => {
  return formatFieldDisplay({
    field: props.field,
    value: props.value,
    linkSummaries: props.linkSummaries,
    attachmentSummaries: props.attachmentSummaries,
  })
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
  const fallbackLabel = formatFieldDisplay({
    field: props.field,
    value: props.value,
    linkSummaries: props.linkSummaries,
    attachmentSummaries: props.attachmentSummaries,
  })
  if (!linkIds.value.length) return []
  return [{ id: '__link_summary__', display: fallbackLabel }]
})
const isPersonLink = computed(() => isPersonField(props.field))

const attachmentIds = computed(() => {
  const v = props.value
  if (Array.isArray(v)) return v.map(String)
  if (v) return [String(v)]
  return []
})

const attachmentItems = computed<MetaAttachment[]>(() => {
  if (props.attachmentSummaries?.length) return props.attachmentSummaries
  if (!attachmentIds.value.length) return []
  return [{
    id: '__attachment_summary__',
    filename: formatFieldDisplay({
      field: props.field,
      value: props.value,
      linkSummaries: props.linkSummaries,
      attachmentSummaries: props.attachmentSummaries,
    }),
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: null,
  }]
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
.meta-cell-renderer__link--person {
  background: #eefbf3;
  color: #227447;
}
.meta-cell-renderer__date { color: #606266; }
.meta-cell-renderer--empty { color: #ccc; }
.meta-cell-renderer--positive { color: #67c23a; }
.meta-cell-renderer--negative { color: #f56c6c; }
</style>
