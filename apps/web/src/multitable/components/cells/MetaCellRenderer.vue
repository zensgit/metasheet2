<template>
  <span class="meta-cell-renderer" :class="[`meta-cell-renderer--${field.type}`, conditionalClass]">
    <!-- string / formula -->
    <template v-if="field.type === 'string' || field.type === 'formula'">{{ displayValue }}</template>

    <!-- long text -->
    <template v-else-if="field.type === 'longText'">
      <span class="meta-cell-renderer__long-text">{{ displayValue }}</span>
    </template>

    <!-- date -->
    <template v-else-if="field.type === 'date'">
      <span class="meta-cell-renderer__date">{{ dateDisplay }}</span>
    </template>

    <!-- datetime -->
    <template v-else-if="field.type === 'dateTime'">
      <span class="meta-cell-renderer__date-time">{{ displayValue }}</span>
    </template>

    <!-- system fields -->
    <template v-else-if="isSystemField">
      <span class="meta-cell-renderer__system" :title="displayValue">{{ displayValue }}</span>
    </template>

    <!-- number -->
    <template v-else-if="field.type === 'number'">{{ displayValue }}</template>

    <!-- barcode -->
    <template v-else-if="field.type === 'barcode'">
      <code class="meta-cell-renderer__barcode">{{ displayValue }}</code>
    </template>

    <!-- qrcode: render-only QR image of the cell's string value -->
    <template v-else-if="field.type === 'qrcode'">
      <span v-if="qrSvg" class="meta-cell-renderer__qrcode" :title="displayValue" v-html="qrSvg" />
      <span v-else class="meta-cell-renderer__qrcode-empty">{{ displayValue }}</span>
    </template>

    <!-- location -->
    <template v-else-if="field.type === 'location'">
      <span class="meta-cell-renderer__location" :title="displayValue">{{ displayValue }}</span>
    </template>

    <!-- boolean -->
    <template v-else-if="field.type === 'boolean'">
      <span class="meta-cell-renderer__bool">{{ value ? '\u2611' : '\u2610' }}</span>
    </template>

    <!-- select / multiSelect -->
    <template v-else-if="field.type === 'select' || field.type === 'multiSelect'">
      <span
        v-for="(tag, i) in selectTags"
        :key="i"
        class="meta-cell-renderer__tag"
        :style="{ background: tag.color ?? '#e8eaed', color: tag.color ? '#fff' : '#333' }"
      >{{ tag.value }}</span>
    </template>

    <!-- person (dedicated type or user-link field): avatar chip + name -->
    <template v-else-if="isPersonLink">
      <span
        v-for="item in personItems"
        :key="item.id"
        class="meta-cell-renderer__person-chip"
        :title="item.display"
      >
        <span class="meta-cell-renderer__person-avatar" aria-hidden="true">{{ item.initial }}</span>
        <span class="meta-cell-renderer__person-name">{{ item.display }}</span>
      </span>
    </template>

    <!-- link -->
    <template v-else-if="field.type === 'link'">
      <span
        v-for="item in linkItems"
        :key="item.id"
        class="meta-cell-renderer__link"
      >{{ item.display }}</span>
    </template>

    <!-- attachment -->
    <template v-else-if="field.type === 'attachment'">
      <MetaAttachmentList :attachments="attachmentItems" variant="compact" empty-label="" />
    </template>

    <!-- percent: inline read-only progress gauge + numeric label -->
    <template v-else-if="field.type === 'percent'">
      <span
        v-if="percentGauge !== null"
        class="meta-cell-renderer__gauge"
        role="img"
        :aria-label="percentGaugeAria(displayValue, isZh)"
      >
        <span class="meta-cell-renderer__gauge-track" aria-hidden="true">
          <span class="meta-cell-renderer__gauge-fill" :style="{ width: `${percentGauge}%` }"></span>
        </span>
        <span class="meta-cell-renderer__gauge-label">{{ displayValue }}</span>
      </span>
      <span v-else class="meta-cell-renderer__numeric">{{ displayValue }}</span>
    </template>

    <!-- currency -->
    <template v-else-if="field.type === 'currency'">
      <span class="meta-cell-renderer__numeric">{{ displayValue }}</span>
    </template>

    <!-- rating: read-only filled/empty segment display -->
    <template v-else-if="field.type === 'rating'">
      <span
        v-if="ratingGauge"
        class="meta-cell-renderer__rating"
        role="img"
        :aria-label="ratingGaugeAria(ratingGauge.filled, ratingGauge.max, isZh)"
        :title="ratingTitle"
      >
        <span
          v-for="i in ratingGauge.max"
          :key="i"
          class="meta-cell-renderer__rating-segment"
          :class="{ 'meta-cell-renderer__rating-segment--filled': i <= ratingGauge.filled }"
          aria-hidden="true"
        >{{ i <= ratingGauge.filled ? '★' : '☆' }}</span>
      </span>
      <span v-else class="meta-cell-renderer__rating" :title="ratingTitle">{{ displayValue }}</span>
    </template>

    <!-- url -->
    <template v-else-if="field.type === 'url'">
      <a
        v-if="hasLinkValue"
        class="meta-cell-renderer__url"
        :href="String(value)"
        target="_blank"
        rel="noopener noreferrer"
        @click.stop
      >{{ value }}</a>
      <template v-else>{{ displayValue }}</template>
    </template>

    <!-- email -->
    <template v-else-if="field.type === 'email'">
      <a
        v-if="hasLinkValue"
        class="meta-cell-renderer__email"
        :href="`mailto:${value}`"
        @click.stop
      >{{ value }}</a>
      <template v-else>{{ displayValue }}</template>
    </template>

    <!-- phone -->
    <template v-else-if="field.type === 'phone'">
      <a
        v-if="hasLinkValue"
        class="meta-cell-renderer__phone"
        :href="`tel:${String(value).replace(/[^+\d]/g, '')}`"
        @click.stop
      >{{ value }}</a>
      <template v-else>{{ displayValue }}</template>
    </template>

    <!-- lookup / rollup -->
    <template v-else>{{ displayValue }}</template>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MetaAttachment, MetaField, LinkedRecordSummary } from '../../types'
import MetaAttachmentList from '../MetaAttachmentList.vue'
import { useLocale } from '../../../composables/useLocale'
import { isPersonField } from '../../utils/link-fields'
import { formatFieldDisplay } from '../../utils/field-display'
import { isSystemFieldType } from '../../utils/system-fields'
import { resolveRatingFieldProperty } from '../../utils/field-config'
import { percentGaugeAria, ratingGaugeAria } from '../../utils/meta-core-labels'
import { qrSvgFromText } from '../../utils/qr-code'

const props = defineProps<{ field: MetaField; value: unknown; linkSummaries?: LinkedRecordSummary[]; attachmentSummaries?: MetaAttachment[] }>()
const { isZh } = useLocale()

const displayValue = computed(() => {
  return formatFieldDisplay({
    field: props.field,
    value: props.value,
    linkSummaries: props.linkSummaries,
    attachmentSummaries: props.attachmentSummaries,
    isZh: isZh.value,
  })
})
const isSystemField = computed(() => isSystemFieldType(props.field.type))

// Render-only QR: encode the cell's own string value into an inline SVG. On an
// over-capacity / unencodable value, fall back to null so the cell shows the
// plain text instead of breaking the grid.
const qrSvg = computed<string | null>(() => {
  if (props.field.type !== 'qrcode') return null
  const raw = props.value
  if (raw === null || raw === undefined || raw === '') return null
  try {
    return qrSvgFromText(String(raw), { size: 64, border: 2 })
  } catch {
    return null
  }
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
    isZh: isZh.value,
  })
  if (!linkIds.value.length) return []
  return [{ id: '__link_summary__', display: fallbackLabel }]
})
const isPersonLink = computed(() => isPersonField(props.field))

function personInitial(display: string): string {
  const trimmed = display.trim()
  if (!trimmed) return '?'
  return [...trimmed][0]!.toUpperCase()
}

const personItems = computed(() =>
  linkItems.value.map((item) => ({
    id: item.id,
    display: item.display,
    initial: personInitial(item.display),
  })),
)

// percentGauge: bar fill width 0..100 for the read-only progress gauge.
// Percent values are stored as the percent number itself (e.g. 65 → "65%"),
// so the fill clamps the value into [0, 100]. Returns null for non-numeric
// values so the template falls back to the plain numeric label.
const percentGauge = computed<number | null>(() => {
  if (props.field.type !== 'percent') return null
  const v = props.value
  if (v === null || v === undefined || v === '') return null
  const num = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(num)) return null
  return Math.max(0, Math.min(100, num))
})

// ratingGauge: filled-segment count and segment max for the read-only rating
// display. Returns null for non-numeric values so the template falls back to
// the plain star string.
const ratingGauge = computed<{ filled: number; max: number } | null>(() => {
  if (props.field.type !== 'rating') return null
  const v = props.value
  if (v === null || v === undefined || v === '') return null
  const num = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(num)) return null
  const { max } = resolveRatingFieldProperty(props.field.property)
  const filled = Math.max(0, Math.min(max, Math.round(num)))
  return { filled, max }
})

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
      isZh: isZh.value,
    }),
    mimeType: 'application/octet-stream',
    size: 0,
    url: '',
    thumbnailUrl: null,
    uploadedAt: '',
  }]
})

const ratingTitle = computed(() => {
  if (props.field.type !== 'rating') return ''
  const num = typeof props.value === 'number' ? props.value : Number(props.value)
  if (!Number.isFinite(num)) return ''
  return `${num}`
})

const hasLinkValue = computed(() => {
  const v = props.value
  return typeof v === 'string' && v.trim().length > 0
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
.meta-cell-renderer__long-text {
  display: inline-block;
  max-width: 100%;
  white-space: pre-wrap;
  word-break: break-word;
}
.meta-cell-renderer__tag {
  display: inline-block; padding: 1px 6px; border-radius: 3px;
  font-size: 11px; margin-right: 4px; white-space: nowrap;
}
.meta-cell-renderer__link {
  display: inline-block; padding: 1px 6px; background: #ecf5ff;
  color: #409eff; border-radius: 3px; font-size: 11px; margin-right: 4px;
}
.meta-cell-renderer__date { color: #606266; }
.meta-cell-renderer__date-time {
  color: #475569;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
}
.meta-cell-renderer__system {
  color: #64748b;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
}
.meta-cell-renderer--empty { color: #ccc; }
.meta-cell-renderer--positive { color: #67c23a; }
.meta-cell-renderer--negative { color: #f56c6c; }
.meta-cell-renderer__numeric {
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
}
.meta-cell-renderer__rating {
  color: #f5a623;
  letter-spacing: 1px;
}
.meta-cell-renderer__rating-segment { color: #d8dee9; }
.meta-cell-renderer__rating-segment--filled { color: #f5a623; }
.meta-cell-renderer__gauge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
.meta-cell-renderer__gauge-track {
  position: relative;
  flex: 1 1 auto;
  min-width: 36px;
  max-width: 96px;
  height: 6px;
  border-radius: 999px;
  background: #eceff4;
  overflow: hidden;
}
.meta-cell-renderer__gauge-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: #409eff;
  transition: width 0.15s ease;
}
.meta-cell-renderer__gauge-label {
  flex-shrink: 0;
  font-size: 12px;
  color: #475569;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
}
.meta-cell-renderer__person-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px 1px 2px;
  margin-right: 4px;
  background: #eefbf3;
  color: #227447;
  border-radius: 999px;
  font-size: 11px;
  max-width: 100%;
  min-width: 0;
}
.meta-cell-renderer__person-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #227447;
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  flex-shrink: 0;
}
.meta-cell-renderer__person-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.meta-cell-renderer__barcode {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  background: #f6f8fa;
  border: 1px solid #e5e7eb;
  border-radius: 4px;
  padding: 1px 5px;
  color: #334155;
}
.meta-cell-renderer__qrcode {
  display: inline-flex;
  align-items: center;
  line-height: 0;
}
.meta-cell-renderer__qrcode :deep(svg) {
  width: 32px;
  height: 32px;
}
.meta-cell-renderer__qrcode-empty {
  font-size: 12px;
  color: #64748b;
}
.meta-cell-renderer__location {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #0f766e;
}
.meta-cell-renderer__location::before {
  content: '\1F4CD';
  font-size: 12px;
}
.meta-cell-renderer__url,
.meta-cell-renderer__email,
.meta-cell-renderer__phone {
  color: #2563eb;
  text-decoration: underline;
}
.meta-cell-renderer__url:hover,
.meta-cell-renderer__email:hover,
.meta-cell-renderer__phone:hover {
  color: #1d4ed8;
}
</style>
